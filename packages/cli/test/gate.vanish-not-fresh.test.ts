import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GATE: a config OBSERVED to exist is never edited as
 * absent.
 *
 * `readConfigForEdit` lstats the target, then opens it O_NOFOLLOW. When the
 * open came back ENOENT — the file deleted in the gap — the function answered
 * `{ existing: null }`: the fresh-create state. But many editors save exactly
 * that way (delete, recreate; or rename-over), so the likeliest author of
 * that ENOENT is a concurrent editor mid-save. Downgrading it to "no file"
 * made the merge run from EMPTY, the rename clobber whatever the editor had
 * just re-saved — and, because a null `existing` is also the "nothing to
 * back up" signal, the one copy that would have survived was never written.
 * The user lost their config AND the backup, in one motion.
 *
 * The interception below is that editor, made deterministic: when the target
 * is opened, the file is deleted first (the real openSync then throws
 * ENOENT), and the editor's re-save lands before the run proceeds. The pin:
 * both callers of `readConfigForEdit` — `mcp install --write` and
 * `writeHostConfig` — REFUSE loudly, and the re-saved file survives
 * untouched. A genuinely absent file (the lstat itself says ENOENT) still
 * fresh-creates; that arm is the control.
 */
const ctl = vi.hoisted(() => ({
  onOpen: null as {
    match: string;
    before: (path: string) => void;
    after?: (path: string) => void;
  } | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && ctl.onOpen !== null && path === ctl.onOpen.match) {
      const armed = ctl.onOpen;
      ctl.onOpen = null;
      armed.before(path); // the concurrent editor's delete
      try {
        return (real.openSync as (...a: unknown[]) => number)(path, ...rest);
      } finally {
        // The editor's re-save lands before the caller can act on the ENOENT
        // — the exact interleaving where the old code overwrote it.
        armed.after?.(path);
      }
    }
    return (real.openSync as (...a: unknown[]) => number)(path, ...rest);
  }) as typeof real.openSync;
  return { ...real, openSync };
});

import { mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-vanish-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { readConfigForEdit, runMcpInstall } = await import('../src/mcp-install.js');
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
  ctl.onOpen = null;
});

describe('a file observed by the lstat that is gone at the open is a refusal, not an absence', () => {
  it('readConfigForEdit throws a CliError instead of answering { existing: null }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanish-unit-'));
    const target = join(dir, '.mcp.json');
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: '/bin/A', args: [] } } }));
    ctl.onOpen = { match: target, before: (p) => unlinkSync(p) };

    let thrown: unknown;
    try {
      const out = readConfigForEdit(target);
      // THE DEFECT, if we get here: an observed file reported as never there.
      expect.fail(
        `an observed-existing file was downgraded to absent: ${JSON.stringify(out)}`,
      );
    } catch (err) {
      if (err && typeof err === 'object' && 'matcherResult' in err) throw err;
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(String((thrown as Error).message)).toMatch(/disappeared while being read/);
    // NOT VACUOUS: the refusal names the file and says what to do.
    expect(String((thrown as Error).message)).toContain(target);
    expect(String((thrown as Error).message)).toMatch(/re-run/i);
  });

  it("mcp install --write cannot overwrite an editor's delete-and-resave with a merge from EMPTY", () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanish-mcp-'));
    const target = join(dir, '.mcp.json');
    const original = JSON.stringify({ mcpServers: { stripe: { command: '/s', args: ['v1'] } } });
    const resaved = JSON.stringify({ mcpServers: { stripe: { command: '/s', args: ['v2'] } } });
    writeFileSync(target, original);
    ctl.onOpen = {
      match: target,
      before: (p) => unlinkSync(p),
      after: (p) => writeFileSync(p, resaved),
    };

    expect(() => install(target)).toThrow(/disappeared while being read/);
    // The editor's re-save is INTACT — stripe survives; no tacendum-only file.
    expect(readFileSync(target, 'utf8')).toBe(resaved);
    // And no backup litter from a run that inspected nothing: the old code's
    // worst property was clobbering the file AND skipping the backup, so the
    // fixed code must do neither.
    expect(readdirSync(dir)).toEqual(['.mcp.json']);
  });

  it('writeHostConfig: the same refusal on the hook-config arm (shared reader, both callers pinned)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanish-host-'));
    const target = join(dir, 'settings.json');
    const original = JSON.stringify({ model: 'opus', hooks: { Stop: [] } });
    const resaved = JSON.stringify({ model: 'opus-next', hooks: { Stop: [] } });
    writeFileSync(target, original);
    ctl.onOpen = {
      match: target,
      before: (p) => unlinkSync(p),
      after: (p) => writeFileSync(p, resaved),
    };

    expect(() =>
      writeHostConfig('claude-code', 'ci', { entryPath: entry, targetPath: target }),
    ).toThrow(/disappeared while being read/);
    expect(readFileSync(target, 'utf8')).toBe(resaved);
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('CONTROL: a file the lstat itself never saw still fresh-creates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanish-ctrl-'));
    const target = join(dir, '.mcp.json');
    install(target); // no interception armed, no file — the legitimate create
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      mcpServers?: { tacendum?: unknown };
    };
    expect(parsed.mcpServers?.tacendum).toBeTruthy();
  });
});
