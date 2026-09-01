import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * CODEX CONFIG ISOLATION IS A STANDING GATE.
 *
 * An un-isolated codex turn inherits the operator's entire global `~/.codex`:
 * every MCP server, plugin hook, skill, AGENTS.md and the approved-prefix
 * allowlist. the integration spike measured the cost — 18,139 input tokens for a turn
 * whose answer was "pong" — and the same inheritance makes the operator's
 * unrelated MCP servers REACHABLE from a turn the phone triggered, which is
 * an exposure, not just a bill. One flag cannot close it: AGENTS.md, skills
 * and the allowlist all load with NO config.toml present, so
 * `--ignore-user-config` alone is not isolation. The ruling is an
 * attend-owned CODEX_HOME under the account's state dir (with the flag kept
 * as belt-over-boundary), signed into once at `attend enable`.
 *
 * What these tests pin, and each FAILS if its half is reverted:
 *   1. a codex turn NEVER spawns without CODEX_HOME in its spawn env —
 *      proven through the real pass (attendOnce), fresh-own and routed
 *      forms alike, with the home existing 0700 AT SPAWN TIME;
 *   2. `--ignore-user-config` sits in exec-option space — argv[1], directly
 *      after `exec` — and therefore always precedes the `resume` subcommand:
 *      clap parses everything after the subcommand name against `resume`'s
 *      grammar and exits 2 (the incident record on `turnArgv`), so a
 *      misplaced flag kills every routed turn with a usage error;
 *   3. the model pin (`-c model=…`) rides the same exec-option space, and
 *      ONLY when enable captured one — isolation must not change the model
 *      silently, and the pin must not break the routed form;
 *   4. a claude-configured attend spawns with NO env override at all —
 *      host isolation must not bleed across the driver seam.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-codex-iso-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://codex-iso.test';
process.env.TACENDUM_WS = 'ws://codex-iso.test';

const { attendOnce, saveAttendConfig } = await import('../src/attend.js');
const { codexHomeDir, driverFor } = await import('../src/attend-drivers.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo } from '../src/attend-drivers.js';

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
/** A codex thread id, UUIDv7 — the shape the integration spike captured live. */
const THREAD = '019d0cf2-bcbb-7492-9b35-d4db2882ddd4';
const OWN_SESSION = '11111111-2222-4333-8444-555555555555';
const CODEX_HOME = join(home, 'state', 'bot', 'codex-home');

let seq = 0;
const mid = (): string => `01HQXW00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string, opts: { ref?: string } = {}) {
  return {
    id: mid(), dir: 'in' as const, peer: OWNER, ts: Date.now(), tcm: '',
    text, read: false, ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

function outRow(key: string, host = 'codex', ts = Date.now()): string {
  const id = mid();
  new MessageLog('bot').append({
    id, dir: 'out', peer: OWNER, ts, tcm: '', text: '', read: true,
    sess: { host, key, tag: 'repo' },
  });
  return id;
}

interface Spawn {
  argv: string[];
  cwd: string;
  prompt: string;
  env: Readonly<Record<string, string>> | undefined;
  /** The isolated home's permission bits, taken INSIDE the spawn — "created
   * on demand" means it must exist before the child would read it, not
   * merely after the pass finished. Undefined when no override was passed. */
  modeAtSpawn: number | undefined;
}

const harness = () => {
  const replies: string[] = [];
  const spawns: Spawn[] = [];
  return {
    replies, spawns,
    io: {
      sendReply: async (b: string) => void replies.push(b),
      runTurn: async (
        argv: string[], cwd: string, prompt: string, env?: Readonly<Record<string, string>>,
      ) => {
        const codexHome = env?.CODEX_HOME;
        spawns.push({
          argv, cwd, prompt, env,
          modeAtSpawn: codexHome === undefined ? undefined : statSync(codexHome).mode & 0o777,
        });
        return { stdout: 'ok', code: 0 };
      },
    },
  };
};

const codexBase = (): AttendConfig => ({
  host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
  ownSession: OWN_SESSION, turnsPerHour: 10,
});

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  // The state dir goes too, codex-home included: every test therefore also
  // proves the driver re-creates the home ON DEMAND, not only at enable.
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: '01HQXW0000000000000000TEST',
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  saveAttendConfig('bot', codexBase());
});

// ---------------------------------------------------------------------------

describe('1. no codex spawn without CODEX_HOME — through the real pass', () => {
  it('the fresh-own form spawns under the attend-owned home, existing 0700 at spawn time', async () => {
    new MessageLog('bot').append(inRow('hello'));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.spawns).toHaveLength(1);
    const s = h.spawns[0]!;
    expect(s.env?.CODEX_HOME, 'a codex turn must never spawn without CODEX_HOME').toBe(CODEX_HOME);
    expect(
      codexHomeDir('bot'),
      "enable's sign-in instruction and the driver must name the SAME directory",
    ).toBe(CODEX_HOME);
    expect(s.modeAtSpawn, 'the home holds auth.json, a live OAuth token — owner-only').toBe(0o700);
  });

  it('the routed resume form too — and --ignore-user-config precedes `resume`', async () => {
    const ref = outRow(THREAD);
    new MessageLog('bot').append(inRow('carry on', { ref }));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.spawns).toHaveLength(1);
    const s = h.spawns[0]!;
    expect(s.env?.CODEX_HOME).toBe(CODEX_HOME);
    expect(s.modeAtSpawn).toBe(0o700);
    expect(s.argv[0]).toBe('exec');
    expect(s.argv[1], 'exec-option space — structurally before any subcommand').toBe(
      '--ignore-user-config',
    );
    const at = s.argv.indexOf('resume');
    expect(at, 'the resume subcommand vanished from the routed argv').toBeGreaterThan(1);
    // The tail survives intact behind clap's `--` — isolation must not cost
    // the session-argv structure its separator.
    expect(s.argv[at + 1]).toBe('--');
    expect(s.argv[at + 2]).toBe(THREAD);
  });
});

// ---------------------------------------------------------------------------

describe('2. ordering holds for whatever the operator put in caps', () => {
  const spawnsOf = () => {
    const calls: { argv: string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
    const io: DriverIo = {
      spawn: async (argv, _cwd, _prompt, env) => {
        calls.push({ argv, env });
        return { stdout: 'ok', stderr: '', code: 0 };
      },
    };
    return { calls, io };
  };

  it('--ignore-user-config is argv[1] even when a caps VALUE spells `resume`', async () => {
    // A word-search for `resume` would misfire on the second config here and
    // plant the flag after the subcommand — exit 2 on every routed turn. The
    // structural rule (directly after `exec`) cannot.
    for (const caps of [
      ['-m', 'gpt-5-codex', '-c', 'foo.bar=1'],
      ['--profile', 'resume'],
    ]) {
      const s = spawnsOf();
      await driverFor('codex').runTurn(
        {
          cfg: { ...codexBase(), caps },
          route: { kind: 'session', host: 'codex', key: THREAD },
          prompt: 'p', account: 'bot',
        },
        s.io,
      );
      const argv = s.calls[0]!.argv;
      expect(argv[0], 'caps must not displace `exec` from argv[0]').toBe('exec');
      expect(argv[1], `--ignore-user-config must hold argv[1] for caps ${JSON.stringify(caps)}`)
        .toBe('--ignore-user-config');
      expect(argv.slice(2), 'caps and the resume tail keep their proven order').toEqual([
        ...caps, 'resume', '--', THREAD,
      ]);
      expect(s.calls[0]!.env?.CODEX_HOME, 'the driver-level path is isolated too').toBe(CODEX_HOME);
    }
  });

  it('the model pin rides exec-option space, and only when enable captured one', async () => {
    const pinned = spawnsOf();
    await driverFor('codex').runTurn(
      {
        cfg: { ...codexBase(), codexModel: 'gpt-5-codex' },
        route: { kind: 'session', host: 'codex', key: THREAD },
        prompt: 'p', account: 'bot',
      },
      pinned.io,
    );
    expect(pinned.calls[0]!.argv).toEqual([
      'exec', '--ignore-user-config', '-c', 'model=gpt-5-codex', '-s', 'read-only',
      'resume', '--', THREAD,
    ]);

    const unpinned = spawnsOf();
    await driverFor('codex').runTurn(
      { cfg: codexBase(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      unpinned.io,
    );
    expect(
      unpinned.calls[0]!.argv.join(' '),
      'no captured model means NOTHING is passed — an invented value is a model nobody chose',
    ).not.toContain('model=');
  });
});

// ---------------------------------------------------------------------------

describe('3. isolation does not bleed across the driver seam', () => {
  it('a claude-configured attend spawns with NO env override at all', async () => {
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w',
      caps: ['--permission-mode', 'plan'], ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('hello'));
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.spawns).toHaveLength(1);
    expect(
      h.spawns[0]!.env,
      "claude's isolation is argv flags; an env override on its spawn would be " +
        "codex's mechanism leaking across the driver seam",
    ).toBeUndefined();
  });
});
