import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GATE: the config BACKUP path.
 *
 * Defect 3 — target swap. The write path used to resolve the target PATH over and
 * over: lstat, then readFileSync(path), then copyFileSync(path, backup) —
 * so anything landing between two resolutions (a concurrent writer, a
 * planted symlink) made the backup describe a file the merge never
 * inspected, and copyFileSync would happily follow a symlink and copy some
 * OTHER file's content into the backup. The fix opens the target once
 * (O_NOFOLLOW, after an lstat refusal), takes content AND mode from that
 * one fd, and writes the backup FROM THOSE BYTES — the path is never read
 * a second time.
 *
 * The interception below is the concurrent attacker, made deterministic:
 * the first string-path read of the target swaps the file underneath the
 * run. On the fixed code the pre-merge read goes through the fd (numbers
 * pass the string check untouched), so an armed swap can no longer land
 * between read and backup at all.
 *
 * Defect 4 — accumulation. A host config holds OTHER servers' credentials, and a
 * timestamped `.bak.<stamp>` per changed run multiplied the on-disk copies
 * of secrets we do not own, at the source's own (commonly world-readable)
 * mode. Now: ONE rolling `.bak`, 0600 (or tighter, if the original was),
 * and a no-op run leaves nothing new.
 *
 * The same file also proves the post-write verification guard fires
 * on a DELIBERATELY broken write: bytes corrupted after the rename must
 * turn into a loud refusal naming the backup, never a success report.
 */
const ctl = vi.hoisted(() => ({
  onStringRead: null as { match: string; fn: (path: string) => void } | null,
  copySrcs: [] as string[],
  onRenameTo: null as { match: string; fn: () => void } | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const out = (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    if (typeof path === 'string' && ctl.onStringRead !== null && path === ctl.onStringRead.match) {
      const armed = ctl.onStringRead;
      ctl.onStringRead = null;
      armed.fn(path);
    }
    return out;
  }) as typeof real.readFileSync;
  const copyFileSync = ((src: unknown, dest: unknown, mode?: unknown) => {
    ctl.copySrcs.push(String(src));
    return (real.copyFileSync as (...a: unknown[]) => unknown)(src, dest, mode);
  }) as typeof real.copyFileSync;
  const renameSync = ((from: unknown, to: unknown) => {
    (real.renameSync as (...a: unknown[]) => unknown)(from, to);
    if (ctl.onRenameTo !== null && String(to) === ctl.onRenameTo.match) {
      const armed = ctl.onRenameTo;
      ctl.onRenameTo = null;
      armed.fn();
    }
  }) as typeof real.renameSync;
  return { ...real, readFileSync, copyFileSync, renameSync };
});

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-cfgbak-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { runMcpInstall } = await import('../src/mcp-install.js');
const { writeHostConfig } = await import('../src/hostconfig.js');
const { CliError } = await import('../src/exit.js');

saveProfile({
  name: 'installer',
  identityKey: 'IK==',
  userId: '01AGENTAGENTAGENTAGENTAGEN',
  authToken: 'tok',
  registrationId: 1,
  deviceId: 1,
});
const entry = join(home, 'main.js');
writeFileSync(entry, '#!/usr/bin/env node\n');

const install = (target: string) =>
  runMcpInstall(
    { host: 'claude-code', account: 'installer', write: true },
    { entryPath: entry, targetPath: target },
  );

beforeEach(() => {
  ctl.onStringRead = null;
  ctl.onRenameTo = null;
  ctl.copySrcs.length = 0;
});

describe('defect 3: the backup describes the file the merge inspected — nothing else', () => {
  it('a content swap racing the run cannot divert the backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-swap-'));
    const target = join(dir, '.mcp.json');
    const inspected = JSON.stringify({ mcpServers: { other: { command: '/bin/A', args: [] } } });
    writeFileSync(target, inspected);
    ctl.onStringRead = {
      match: target,
      fn: () => writeFileSync(target, '{"swapped-in-after-a-read":true}'),
    };
    install(target);
    // The backup holds the bytes the merge was computed FROM — never
    // whatever a racer managed to land at the path afterwards.
    expect(readFileSync(join(dir, '.mcp.json.bak'), 'utf8')).toBe(inspected);
    // And the primitive that used to re-read the path is gone from the run:
    expect(ctl.copySrcs).not.toContain(target);
  });

  it('a symlink planted mid-run cannot pull another file into the backup (disclosure)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-link-'));
    const victim = join(dir, 'victim.json');
    writeFileSync(victim, '{"apiKey":"VICTIM-SECRET"}');
    const target = join(dir, '.mcp.json');
    const inspected = JSON.stringify({ mcpServers: { other: { command: '/bin/A', args: [] } } });
    writeFileSync(target, inspected);
    ctl.onStringRead = {
      match: target,
      fn: () => {
        unlinkSync(target);
        symlinkSync(victim, target);
      },
    };
    install(target);
    const backup = readFileSync(join(dir, '.mcp.json.bak'), 'utf8');
    expect(backup).toBe(inspected);
    expect(backup).not.toContain('VICTIM-SECRET');
    expect(readFileSync(victim, 'utf8')).toBe('{"apiKey":"VICTIM-SECRET"}'); // untouched
  });

  it('writeHostConfig: same property on the hook-config path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-host-'));
    const target = join(dir, 'settings.json');
    const inspected = JSON.stringify({ model: 'opus' });
    writeFileSync(target, inspected);
    ctl.onStringRead = {
      match: target,
      fn: () => writeFileSync(target, '{"swapped":true}'),
    };
    const out = writeHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: target });
    expect(out.backup).toBe(`${target}.bak`);
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe(inspected);
    expect(ctl.copySrcs).not.toContain(target);
  });

  it('writeHostConfig refuses a symlinked target outright, like mcp install always has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-hostlink-'));
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, '{"model":"opus"}');
    const target = join(dir, 'settings.json');
    symlinkSync(outside, target);
    expect(() => writeHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: target })).toThrow(
      /symbolic link/,
    );
    expect(readFileSync(outside, 'utf8')).toBe('{"model":"opus"}'); // untouched
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toHaveLength(0);
  });
});

describe("defect 4: one rolling 0600 backup — never an accumulating archive of other servers' secrets", () => {
  it('three changed runs leave exactly ONE .bak, mode 0600, and a no-op run adds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-roll-'));
    const target = join(dir, '.mcp.json');
    // A planted, WORLD-READABLE stale backup must be replaced, not reused.
    writeFileSync(`${target}.bak`, 'stale', { mode: 0o644 });
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { stripe: { command: '/s', env: { KEY: 'sk_live_OTHERS' } } } }),
    );
    install(target);
    // The operator's editor rewrites the file between runs (same meaning,
    // different bytes), so every install run is a changed run.
    writeFileSync(target, JSON.stringify(JSON.parse(readFileSync(target, 'utf8'))));
    install(target);
    writeFileSync(target, JSON.stringify(JSON.parse(readFileSync(target, 'utf8'))));
    install(target);

    expect(readdirSync(dir).sort()).toEqual(['.mcp.json', '.mcp.json.bak']);
    expect(statSync(join(dir, '.mcp.json.bak')).mode & 0o777).toBe(0o600);

    // A no-op run must leave NO new file and not touch the backup.
    const bakBytes = readFileSync(`${target}.bak`, 'utf8');
    install(target);
    expect(readdirSync(dir).sort()).toEqual(['.mcp.json', '.mcp.json.bak']);
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe(bakBytes);
  });

  it('the backup inherits a TIGHTER original mode instead of loosening to 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-mode-'));
    const target = join(dir, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }), { mode: 0o400 });
    writeHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: target });
    expect(statSync(`${target}.bak`).mode & 0o777).toBe(0o400);
    expect(statSync(target).mode & 0o777).toBe(0o400); // and the target keeps its own
  });

  it('writeHostConfig: rolling name, 0600, no accumulation across changed runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-hostroll-'));
    const target = join(dir, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }));
    const first = writeHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: target });
    expect(first.backup).toBe(`${target}.bak`);
    const second = writeHostConfig('claude-code', 'ci2', { entryPath: entry, targetPath: target });
    expect(second.backup).toBe(`${target}.bak`);
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toEqual(['settings.json.bak']);
    expect(statSync(`${target}.bak`).mode & 0o777).toBe(0o600);
    // The rolling backup holds the LATEST pre-merge bytes (the ci run's output).
    expect(readFileSync(`${target}.bak`, 'utf8')).toContain('--account ci');
  });
});

describe('the post-write verification guard fires on a deliberately broken write', () => {
  it('bytes corrupted after the rename (CRLF duplicate table) refuse loudly and name the backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-guard1-'));
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'model = "o4"\n');
    ctl.onRenameTo = {
      match: target,
      fn: () =>
        writeFileSync(
          target,
          '[mcp_servers.tacendum]\r\ncommand = "/a"\r\n[mcp_servers.tacendum]\r\ncommand = "/b"\r\n',
        ),
    };
    let thrown: unknown;
    try {
      runMcpInstall(
        { host: 'codex', account: 'installer', write: true },
        { entryPath: entry, targetPath: target },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(String((thrown as Error).message)).toMatch(/failed verification/);
    expect(String((thrown as Error).message)).toContain(`${target}.bak`);
  });

  it('bytes corrupted into an unterminated string ALSO refuse — invalid TOML cannot pass as success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfgbak-guard2-'));
    const target = join(dir, 'config.toml');
    writeFileSync(target, 'model = "o4"\n');
    ctl.onRenameTo = {
      match: target,
      fn: () => writeFileSync(target, 'x = """\n[mcp_servers.tacendum]\ncommand = "/a"\n'),
    };
    expect(() =>
      runMcpInstall(
        { host: 'codex', account: 'installer', write: true },
        { entryPath: entry, targetPath: target },
      ),
    ).toThrow(/failed verification/);
  });
});
