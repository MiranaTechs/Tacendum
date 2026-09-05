import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * THE SESSION KEY IS AN ARGV SLOT — an earlier review.
 *
 * `parseClaudeHook` took the host's `session_id`, truncated it to 128
 * characters, and passed it on; `route` carried it to `turnArgv`, which
 * spliced it in as `resume <key>` (codex) or `--resume <key>` (claude). No
 * shape check existed anywhere between the hook payload and execve. Both
 * parsers read a dash-leading value as an OPTION — proved on this machine with
 * bogus flags (attend.ts `turnArgv` records the exact commands and output) —
 * so a crafted session id injected flags into a turn attend launched, from the
 * one surface this feature exists to serve: an agent host's payload, which is
 * to say a prompt-injectable one. It is the injection the earlier argv fix closed for the
 * prompt, arriving through the key instead.
 *
 * What these tests pin, and each one FAILS if its fix is reverted:
 *   1. the shape rule at the hook boundary, and that rejecting a key still
 *      DELIVERS the notification (a hook that stops notifying is worse);
 *   2. the structural separator per host — `--` for clap, `=` for commander —
 *      because validation at one end is one deleted call from nothing;
 *   3. the router refusing to resolve a ledger key that fails the rule;
 *   4. a NUL that somehow reaches `spawn` becoming one honest failure instead
 *      of a loop that retakes a turn token every two seconds forever;
 *   5. `attend enable` refusing an unknown --host and an unusable --turns
 *      instead of silently becoming claude / a bricked budget;
 *   6. `attend --help` printing help, and a surplus positional being refused.
 *
 * Exit codes are asserted explicitly throughout: this CLI must never exit 2.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-sessargv-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://sessargv.test';
process.env.TACENDUM_WS = 'ws://sessargv.test';

const hooks = await import('../src/hooks.js');
const { hostSessionKey, parseClaudeHook, parseCursorHook, parseGeminiHook, runNotify, SESSION_KEY_MAX } =
  hooks;
const attend = await import('../src/attend.js');
const { attendOnce, cmdAttendEnable, loadAttendConfig, route, saveAttendConfig, turnArgv } = attend;
const { MessageLog } = await import('../src/msglog.js');
const { Reporter } = await import('../src/output.js');
const { saveProfile } = await import('../src/profile.js');
const { EXIT } = await import('../src/exit.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
/** A real claude session id shape: the transcript filename is the id. */
const UUID = '00fa0485-9029-4584-a105-006517edb27a';
const report = () => new Reporter({ json: true, plain: true });

/**
 * The hostile shapes, each one a different way into argv or into execve.
 * `-s` and `--sandbox` are named on purpose: they are the caps flags, i.e. the
 * control that makes the capability profile mean anything.
 */
const HOSTILE = [
  '--dangerously-skip-permissions',
  '-s',
  '--sandbox=danger-full-access',
  '-',
  '--',
  `--resume=${UUID}`,
  'ok\u0000nul',
  'line\nbreak',
  'has space',
  'semi;colon',
  'back`tick',
  'dollar$sign',
  '../../etc/passwd',
  'a'.repeat(SESSION_KEY_MAX + 1),
  '',
] as const;

let seq = 0;
const mid = (): string => `01HQXW00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string, opts: { ref?: string } = {}) {
  return {
    id: mid(), dir: 'in' as const, peer: OWNER, ts: Date.now(), tcm: '',
    text, read: false, ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

/** An outbound LEDGER row carrying whatever key we say — the shape a hook
 * wrote before the rule existed, or anything that can write the spool. */
function outRow(key: string, host = 'claude', ts = Date.now()): string {
  const id = mid();
  new MessageLog('bot').append({
    id, dir: 'out', peer: OWNER, ts, tcm: '', text: '', read: true,
    sess: { host, key, tag: 'repo' },
  });
  return id;
}

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: '01HQXW0000000000000000TEST',
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  saveAttendConfig('bot', {
    host: 'claude', bin: '/opt/agent', workdir: '/w',
    caps: ['--permission-mode', 'plan'],
    ownSession: '11111111-2222-4333-8444-555555555555', turnsPerHour: 10,
  });
});

// ---------------------------------------------------------------------------

describe('1. the shape rule at the hook boundary', () => {
  it('accepts what the four hosts emit', () => {
    // claude/gemini UUIDv4, codex UUIDv7, and a wider opaque id for cursor,
    // whose `conversation_id` the docs describe only as a "stable ID".
    for (const ok of [
      UUID,
      '019d0cf2-bcbb-7492-9b35-d4db2882ddd4',
      'conv-9',
      'conv_01HQXW00',
      'sess.2026-08-01.4',
      'A',
      'a'.repeat(SESSION_KEY_MAX),
    ]) {
      expect(hostSessionKey(ok), `${JSON.stringify(ok)} is a shape a host emits`).toBe(ok);
    }
  });

  it('refuses every shape that is not one — flags, NUL, control, space, path, over-length', () => {
    for (const bad of HOSTILE) {
      expect(hostSessionKey(bad), `${JSON.stringify(bad)} must not become a session key`)
        .toBeUndefined();
    }
    expect(hostSessionKey(undefined)).toBeUndefined();
  });

  it('does not TRUNCATE an over-long key — a shorter key names a different transcript', () => {
    const long = 'a'.repeat(SESSION_KEY_MAX + 1);
    // The old rule was `.slice(0, 128)`, which would answer with 128 a's.
    expect(hostSessionKey(long)).toBeUndefined();
  });

  it('claude, gemini and cursor all drop a flag-shaped id, and codex has none to drop', () => {
    const claude = parseClaudeHook(
      JSON.stringify({
        hook_event_name: 'Stop', cwd: '/w/repo', last_assistant_message: 'done',
        session_id: '--dangerously-skip-permissions',
      }),
    );
    expect(claude.action === 'send' && claude.event.session).toBeUndefined();
    // …and the BODY still arrived. A parser that threw here would be a hook
    // that stopped notifying over a metadata field.
    expect(claude.action === 'send' && claude.event.body).toBe('done');

    const gemini = parseGeminiHook(
      JSON.stringify({
        hook_event_name: 'AfterAgent', cwd: '/w/repo', prompt_response: 'done',
        session_id: '-s',
      }),
    );
    expect(gemini.action === 'send' && gemini.event.session).toBeUndefined();
    expect(gemini.action === 'send' && gemini.event.body).toBe('done');

    const cursor = parseCursorHook(
      JSON.stringify({
        hook_event_name: 'stop', conversation_id: '--sandbox=danger-full-access',
        workspace_roots: ['/w/repo'],
      }),
    );
    expect(cursor.action === 'send-cached' && cursor.event.session).toBeUndefined();
    // The CACHE key is the SHA-256 of the id, so an odd id still finds its
    // text — refusing it there would drop the operator's response to buy
    // nothing.
    expect(cursor.action === 'send-cached' && cursor.conversationId).toBe(
      '--sandbox=danger-full-access',
    );
  });

  it('a refused key still DELIVERS: the ledger row is written, just without a key', async () => {
    const sent: { msgId: string }[] = [];
    const code = await runNotify(['--hook', 'claude', '--account', 'bot'], report(), {
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: 'Stop', cwd: '/w/repo', last_assistant_message: 'build green',
          session_id: '--dangerously-skip-permissions',
        }),
      deliver: async (a) => (sent.push({ msgId: a.msgId }), { msgId: a.msgId, state: 'delivered' }),
    });
    expect(code, 'a malformed session id must never fail the hook').toBe(EXIT.OK);
    expect(sent, 'the notification still goes out').toHaveLength(1);
    const row = new MessageLog('bot').read({ dir: 'out' })[0];
    expect(row?.sess?.host).toBe('claude');
    expect(row?.sess?.tag).toBe('repo');
    expect(row?.sess?.key, 'the flag must not be recorded as a routable key').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('2. argv is structurally safe, whatever the key', () => {
  const codexCfg = () => ({
    ...loadAttendConfig('bot')!, host: 'codex' as const, caps: ['-s', 'read-only'],
  });

  it('codex: the key sits behind clap`s `--`, so it can only bind as a positional', () => {
    const argv = turnArgv(codexCfg(), { kind: 'session', host: 'codex', key: UUID });
    const at = argv.indexOf('resume');
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1], 'no separator: a dash-leading key parses as an OPTION').toBe('--');
    expect(argv[at + 2]).toBe(UUID);
    expect(argv[argv.length - 1]).toBe(UUID);
  });

  it('claude: the key rides INSIDE its flag (`--resume=<key>`), never as a free token', () => {
    const argv = turnArgv(loadAttendConfig('bot')!, { kind: 'session', host: 'claude', key: UUID });
    // commander has no `--` for an option VALUE, so `=` is the separator that
    // exists: everything after the first `=` is the value, never re-parsed.
    expect(argv).toContain(`--resume=${UUID}`);
    expect(argv, 'a bare `--resume` leaves the next token open to re-parsing')
      .not.toContain('--resume');
    expect(argv.indexOf(UUID), 'the key must never be its own argv entry').toBe(-1);
  });

  it('an unusable key yields NO target — a fresh session, never a flag, never a throw', () => {
    for (const bad of HOSTILE) {
      const cx = turnArgv({ ...codexCfg() }, { kind: 'session', host: 'codex', key: bad });
      expect(cx, `codex argv must not carry ${JSON.stringify(bad)}`).toEqual([
        'exec', '-s', 'read-only',
      ]);
      const cl = turnArgv(loadAttendConfig('bot')!, { kind: 'session', host: 'claude', key: bad });
      expect(cl, `claude argv must not carry ${JSON.stringify(bad)}`).toEqual([
        '-p', '--permission-mode', 'plan',
      ]);
      // `toEqual` on the WHOLE array is the strong form of "the hostile text
      // appears nowhere": a containment check would have to allowlist the caps
      // (which legitimately contain `-s`), and an assertion with an allowlist
      // is an assertion a future hostile value walks through.
    }
  });

  it('a config whose own session was tampered with also degrades to fresh', () => {
    const cfg = { ...loadAttendConfig('bot')!, ownSession: '--sandbox=danger-full-access' };
    expect(turnArgv(cfg, { kind: 'own' })).toEqual(['-p', '--permission-mode', 'plan']);
    expect(turnArgv({ ...cfg, ownSessionStarted: true }, { kind: 'own' })).toEqual([
      '-p', '--permission-mode', 'plan',
    ]);
    expect(turnArgv({ ...cfg, host: 'codex', caps: ['-s', 'read-only'], ownSessionStarted: true },
      { kind: 'own' })).toEqual(['exec', '-s', 'read-only']);
  });
});

// ---------------------------------------------------------------------------

describe('3. the router will not resolve a key that fails the rule', () => {
  it('a tampered ledger row answers ENDED instead of routing to it', () => {
    const ref = outRow('--dangerously-skip-permissions');
    new MessageLog('bot').append(inRow('yes', { ref }));
    const r = route('bot', new MessageLog('bot').read({ dir: 'in' }), Date.now(), 'claude');
    expect(r.kind, 'a malformed ledger key must not become a route').toBe('ended');
  });

  it('a tampered row is not LIVE either — bare text falls through to the own session', () => {
    outRow('--sandbox=danger-full-access', 'claude', Date.now() - 1000);
    expect(route('bot', [inRow('status?')], Date.now(), 'claude').kind).toBe('own');
  });

  it('a well-formed row beside a tampered one still routes, and to the right one', () => {
    outRow('has space', 'claude', Date.now() - 2000);
    outRow(UUID, 'claude', Date.now() - 1000);
    expect(route('bot', [inRow('status?')], Date.now(), 'claude')).toEqual({
      kind: 'session', host: 'claude', key: UUID,
    });
  });
});

// ---------------------------------------------------------------------------

describe('4. a NUL cannot reach spawn — and if it does, it costs ONE turn, not the hour', () => {
  it('validation makes it unreachable: a NUL key never lands in argv', () => {
    const ref = outRow('ok\u0000nul');
    new MessageLog('bot').append(inRow('go', { ref }));
    const r = route('bot', new MessageLog('bot').read({ dir: 'in' }), Date.now(), 'claude');
    expect(r.kind).toBe('ended');
    for (const entry of turnArgv(loadAttendConfig('bot')!, { kind: 'session', host: 'claude', key: 'ok\u0000nul' })) {
      expect(entry).not.toContain('\u0000');
    }
  });

  it('a NUL in the operator`s own caps becomes an honest reply, not a rejected pass', async () => {
    // caps is a VERBATIM operator array — no shape rule guards it, and it is
    // the one remaining way a NUL reaches execve. `spawn` throws
    // SYNCHRONOUSLY for it (no 'error' event), and the throw used to unwind
    // out of attendOnce AFTER the turn token was taken and BEFORE the cursor
    // advanced: attendLoop caught it as transient and the same batch retook a
    // token every two seconds until the hourly budget was gone.
    saveAttendConfig('bot', {
      ...loadAttendConfig('bot')!, bin: '/bin/echo', caps: ['ok\u0000nul'],
    });
    new MessageLog('bot').append(inRow('go'));
    const replies: string[] = [];
    const io = { sendReply: async (b: string) => void replies.push(b) };
    const first = await attendOnce('bot', io).catch(
      (e: Error) => `THREW OUT OF attendOnce: ${e.message}`,
    );
    expect(first, 'spawn threw past the cursor advance — the loop burns a token per pass')
      .toBe('failed');
    expect(replies[0]).toContain('missing or not runnable');
    // And the batch is answered ONCE: the cursor moved past it.
    const second = await attendOnce('bot', io).catch((e: Error) => `THREW: ${e.message}`);
    expect(second, 'the poisoned batch must not be retried forever').toBe('idle');
  });
});

// ---------------------------------------------------------------------------

describe('5. attend enable refuses what it used to coerce', () => {
  it('an unknown --host is a usage error naming the set, not a silent downgrade to claude', () => {
    // `gemini` LEFT THIS LIST 2026-09-04 (§3.8): it is a
    // driveable host now, so it is no longer an unknown value. Its own
    // refusal — no API key, no profile — is a different gate with a
    // different code, pinned in gate.gemini-driver.test.ts. `cursor` stays:
    // it notifies and cannot be spawned headless.
    for (const host of ['CODEX', 'codexx', 'cursor', '', 'Claude']) {
      let thrown: unknown;
      try {
        cmdAttendEnable('bot', { host, bin: '/opt/agent', workdir: '/w' }, report());
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `--host ${JSON.stringify(host)} must be refused`).toBeInstanceOf(Error);
      const err = thrown as { exitCode?: number; message?: string };
      expect(err.exitCode, 'usage errors are 9 — 2 blocks four agent hosts').toBe(EXIT.USAGE);
      expect(err.exitCode).not.toBe(2);
      expect(err.message).toContain('claude, codex, gemini');
      // Rule 4: the rejected VALUE is not echoed back into a hook log.
      if (host !== '') expect(err.message).not.toContain(host);
    }
  });

  it('the two real hosts are still accepted, and codex is not turned into claude', () => {
    // process.execPath: a real executable this machine demonstrably has —
    // enable now refuses a --bin that does not exist, so the fixture must be
    // one that does.
    cmdAttendEnable('bot', { host: 'codex', bin: process.execPath, workdir: '/w' }, report());
    expect(loadAttendConfig('bot')!.host).toBe('codex');
    cmdAttendEnable('bot', { host: 'claude', bin: process.execPath, workdir: '/w' }, report());
    expect(loadAttendConfig('bot')!.host).toBe('claude');
  });

  it('an unusable --turns is refused before it can brick the budget', () => {
    for (const turns of [Number.NaN, 0, -1, 2.5, Infinity, 1001]) {
      let thrown: unknown;
      try {
        // A real bin, so the refusal under test is the TURNS one — a fake
        // path here would make every case pass on the --bin check instead.
        cmdAttendEnable(
          'bot',
          { turnsPerHour: turns, bin: process.execPath, workdir: '/w' },
          report(),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `--turns ${String(turns)} must be refused`).toBeInstanceOf(Error);
      expect((thrown as { exitCode?: number; message?: string }).message).toContain('--turns');
      expect((thrown as { exitCode?: number }).exitCode).toBe(EXIT.USAGE);
    }
    cmdAttendEnable('bot', { turnsPerHour: 5, bin: process.execPath, workdir: '/w' }, report());
    expect(loadAttendConfig('bot')!.turnsPerHour).toBe(5);
  });

  it('a --bin that this machine cannot execute is refused NOW, not turns later', () => {
    // `attend enable bot --bin /zz/nope` used to exit 0 and persist. The
    // failure then surfaced inside a turn, as exit 127 reported to the
    // operator's phone as "the agent binary is missing or not runnable" —
    // with the operator no longer standing at the terminal that typed the
    // path. Enable is where the operator IS standing; refuse there.
    const before = JSON.stringify(loadAttendConfig('bot'));
    for (const bin of ['/zz/nope', '/tmp', 'relative/agent']) {
      let thrown: unknown;
      try {
        cmdAttendEnable('bot', { bin, workdir: '/w' }, report());
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `--bin ${JSON.stringify(bin)} must be refused`).toBeInstanceOf(Error);
      const err = thrown as { exitCode?: number; message?: string };
      // Usage: retrying identical arguments cannot help — and 9, never 2,
      // the code four agent hosts read as "block the agent".
      expect(err.exitCode).toBe(EXIT.USAGE);
      expect(err.exitCode).not.toBe(2);
      // Rule 4: the rejected value is not echoed back into a hook log.
      expect(err.message).not.toContain(bin);
    }
    // Nothing was saved: the durable config still says what it said before.
    expect(JSON.stringify(loadAttendConfig('bot'))).toBe(before);
  });
});

// ---------------------------------------------------------------------------

const CLI = join(process.cwd(), 'packages/cli/src/main.ts');

interface Run { code: number | null; stdout: string; stderr: string }

function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: {
        ...process.env,
        TACENDUM_HOME: home,
        TACENDUM_API: 'http://127.0.0.1:9',
        TACENDUM_WS: 'ws://127.0.0.1:9/ws',
        NODE_USE_SYSTEM_CA: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.kill('SIGKILL'), 20_000);
  });
}

describe('6. the attend command line itself', () => {
  it('`attend --help` PRINTS help and exits 0 — it used to exit 9', async () => {
    const run = await runCli(['attend', '--help']);
    expect(run.code, '--help is not a usage error').toBe(EXIT.OK);
    expect(run.stdout).toContain('tacendum attend enable|disable|run');
  }, 30_000);

  it('a surplus positional is refused, not silently dropped', async () => {
    const run = await runCli(['attend', 'enable', 'bot', 'turns', '5']);
    expect(run.code).toBe(EXIT.USAGE);
    expect(run.code).not.toBe(2);
    expect(run.stderr).toContain('usage:');
  }, 30_000);

  it('`--turns <non-number>` is refused at parse time, never written as null', async () => {
    for (const value of ['abc', '', '-1', '2.5']) {
      const run = await runCli(['attend', 'enable', 'bot', '--turns', value]);
      expect(run.code, `--turns ${JSON.stringify(value)} must be a usage error`).toBe(EXIT.USAGE);
      expect(run.code).not.toBe(2);
      // Rule 4: the value never comes back out.
      if (value !== '') expect(run.stderr).not.toContain(`${value}`);
    }
  }, 60_000);

  it('`--host <unknown>` is refused by the wired command too', async () => {
    const run = await runCli(['attend', 'enable', 'bot', '--host', 'CODEX']);
    expect(run.code).toBe(EXIT.USAGE);
    expect(run.code).not.toBe(2);
    expect(run.stderr).toContain('claude, codex');
  }, 30_000);

  it('an unknown subcommand is a usage error, and never exit 2', async () => {
    const run = await runCli(['attend', 'nonsense', 'bot']);
    expect(run.code).toBe(EXIT.USAGE);
    expect(run.code).not.toBe(2);
  }, 30_000);
});
