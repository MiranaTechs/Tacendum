import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE GEMINI HOST IS A STANDING GATE — §3.8,
 * rulings R9/R21/R25.
 *
 * THE BINARY IS NOT INSTALLED ON THE MACHINE THIS WAS BUILT ON
 * (`command -v gemini` returned nothing, 2026-09-04), and this file is what
 * takes that fact seriously rather than working around it. The driver is
 * written against the DOCUMENTED gemini-cli v0.58.0 interface; every claim it
 * makes about the host's behaviour is a read, not an observation; and every
 * claim about OUR OWN behaviour — argv shape, isolation env, exit-code
 * classification, credential foreclosure, the session-flag inference — is
 * proved here, twice: at the driver seam with a scripted `spawn`, and through
 * the real pass against a FAKE BINARY that records the argv, the environment
 * and the prompt it was actually handed by execve.
 *
 * What each part pins, and what breaks if its half is reverted:
 *
 *   1. the argv table (§3.8) — one target token, ever; the inline `=`
 *      separator; NO `-p` and no prompt in argv; and `--resume=` /
 *      `--session-id=` NEVER emitted empty, because gemini reads an empty
 *      `--resume=` as RESUME_LATEST and would silently attach the turn to
 *      whatever session the operator last ran in that directory;
 *   2. the isolation env — every gemini spawn carries GEMINI_CLI_HOME under
 *      the account's state dir, existing 0700 AT SPAWN TIME, plus the two
 *      constants; and no other host's spawn grows a GEMINI_ variable;
 *   3. the exit-code classifier — BY CODE, never by stderr text; only 42
 *      recovers, only on the own route, only when a target was tried, and
 *      the recovery spawn carries no target;
 *   4. R25's own-session inference — a 42 on the `--resume` form CLEARS the
 *      flag so the next turn CREATES; a 42 on the `--session-id` form SETS
 *      it so the next turn RESUMES; a 127 writes nothing. Delete the
 *      inference and the pass observes the same failing form twice, forever,
 *      at two spawns a turn;
 *   5. the terms gate, both halves — enable refuses with no API key and
 *      nothing is saved; the driver refuses BEFORE the spawn; and neither
 *      refusal, nor the enable read-back, contains any run of the key;
 *   6. `roomCapsFloor`'s gemini arm — `--approval-mode plan`, never
 *      `--permission-mode`, with `yolo`/`auto_edit` replaced and the model
 *      words carried;
 *   7. `classifyRefusal` still claude-only: a gemini turn whose stderr quotes
 *      one of claude's three sentences classifies nothing and re-spawns
 *      nothing.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gemini-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://gemini.test';
process.env.TACENDUM_WS = 'ws://gemini.test';

/**
 * A fake API key, set on THIS process because the driver's default credential
 * read is `process.env` — which is what a supervised turn actually resolves.
 * Every refusal case that needs the key ABSENT injects `io.env` instead of
 * mutating this, so no test here depends on unsetting a shared variable.
 *
 * The value is nonsense with no English in it, so a match in captured output
 * cannot be a coincidence — the `gate.credential-echo` discipline: a leak
 * that arrives cut in half is still a leak, so the assertions scan for every
 * 8-character window.
 */
const FAKE_KEY = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5o';
process.env.GEMINI_API_KEY = FAKE_KEY;

const {
  attendOnce,
  cmdAttendEnable,
  cmdAttendStatus,
  loadAttendConfig,
  roomCapsFloor,
  saveAttendConfig,
  turnArgv,
} = await import('../src/attend.js');
const {
  classifyGeminiExit,
  classifyRefusal,
  driverFor,
  geminiCredentialPresent,
  geminiExitSentence,
  geminiHomeDir,
} = await import('../src/attend-drivers.js');
const { operatorGeminiModel } = await import('../src/hostconfig.js');
const { MessageLog } = await import('../src/msglog.js');
const { Reporter } = await import('../src/output.js');
const { saveProfile } = await import('../src/profile.js');
const { EXIT } = await import('../src/exit.js');
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo, TurnRequest } from '../src/attend-drivers.js';

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
/** gemini session ids are UUIDs, like claude's — `attend enable` mints the
 * own one with `randomUUID`, so this is the shape the argv carries. */
const OWN = '11111111-2222-4333-8444-555555555555';
const ROUTED = '99999999-8888-4777-8666-555555555555';
const GEMINI_HOME = join(home, 'state', 'bot', 'gemini-home');

let seq = 0;
const mid = (): string => `01HQXW00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const inRow = (text: string) => ({
  id: mid(),
  dir: 'in' as const,
  peer: OWNER,
  ts: Date.now(),
  tcm: '',
  text,
  read: false,
});

const base = (over: Partial<AttendConfig> = {}): AttendConfig => ({
  host: 'gemini',
  bin: '/opt/gemini',
  workdir: '/w',
  caps: ['--approval-mode', 'plan'],
  ownSession: OWN,
  turnsPerHour: 10,
  ...over,
});

interface Spawn {
  argv: string[];
  cwd: string;
  prompt: string;
  env: Readonly<Record<string, string>> | undefined;
  /** Taken INSIDE the spawn: "created on demand" means the home must exist
   * before the child would read it, not merely after the pass finished. */
  modeAtSpawn: number | undefined;
}

/** A driver-level harness: scripted exit codes, one entry per spawn. */
const seam = (codes: number[], out: string[] = [], err: string[] = []) => {
  const spawns: Spawn[] = [];
  const io: DriverIo = {
    spawn: async (argv, cwd, prompt, env) => {
      const geminiHome = env?.GEMINI_CLI_HOME;
      spawns.push({
        argv,
        cwd,
        prompt,
        env,
        modeAtSpawn: geminiHome === undefined ? undefined : statSync(geminiHome).mode & 0o777,
      });
      const i = spawns.length - 1;
      return { stdout: out[i] ?? '', stderr: err[i] ?? '', code: codes[i] ?? codes.at(-1) ?? 0 };
    },
  };
  return { spawns, io };
};

const run = (
  cfg: AttendConfig,
  route: TurnRequest['route'],
  io: DriverIo,
): ReturnType<ReturnType<typeof driverFor>['runTurn']> =>
  driverFor('gemini').runTurn({ cfg, route, prompt: 'the prompt', account: 'bot' }, io);

const report = () => new Reporter({ json: false, plain: true });

/** Capture everything the Reporter writes to stdout for one call. */
function captureStdout(fn: () => void): string {
  let text = '';
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => ((text += String(chunk)), true));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return text;
}

/** Every 8-character window of the fake key. A leak cut in half is a leak. */
function containsKeyFragment(text: string): boolean {
  for (let i = 0; i + 8 <= FAKE_KEY.length; i += 1) {
    if (text.includes(FAKE_KEY.slice(i, i + 8))) return true;
  }
  return false;
}

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  // The state dir goes too, gemini-home included: every test therefore also
  // proves the driver re-creates the home ON DEMAND, not only at enable.
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  saveProfile({
    name: 'bot',
    identityKey: 'AAAA',
    userId: '01HQXW0000000000000000TEST',
    deviceId: 1,
    authToken: 'tok',
    registrationId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });
  saveAttendConfig('bot', base());
});

// ---------------------------------------------------------------------------

describe('1. the argv table (§3.8)', () => {
  it('own-not-started CREATES at a pinned id; own-started RESUMES; a routed key resumes', () => {
    expect(turnArgv(base(), { kind: 'own' })).toEqual([
      `--session-id=${OWN}`,
      '--approval-mode',
      'plan',
    ]);
    expect(turnArgv(base({ ownSessionStarted: true }), { kind: 'own' })).toEqual([
      `--resume=${OWN}`,
      '--approval-mode',
      'plan',
    ]);
    expect(turnArgv(base(), { kind: 'session', host: 'gemini', key: ROUTED })).toEqual([
      `--resume=${ROUTED}`,
      '--approval-mode',
      'plan',
    ]);
  });

  it('an unusable key yields NO TARGET — a fresh session, never a bare interpolation', () => {
    // `hostSessionKey`'s third defence, on gemini's branch: a flag-shaped or
    // empty own session cannot become a target, and a routed key that fails
    // the shape rule must never CREATE under the machine's own transcript.
    for (const bad of ['--zzz-not-a-real-flag', '', 'has space', 'a/b']) {
      expect(
        turnArgv(base({ ownSession: bad, ownSessionStarted: true }), { kind: 'own' }),
        `own session ${JSON.stringify(bad)} must not reach argv`,
      ).toEqual(['--approval-mode', 'plan']);
      expect(
        turnArgv(base(), { kind: 'session', host: 'gemini', key: bad }),
        `routed key ${JSON.stringify(bad)} must not CREATE`,
      ).toEqual(['--approval-mode', 'plan']);
    }
  });

  it('never emits an EMPTY --resume= or --session-id=, on any route', () => {
    // gemini coerces `--resume=` to RESUME_LATEST: an empty value attaches
    // the turn to the operator's most recent session in that directory —
    // a different conversation, with nothing said about it.
    const cfgs = [
      base({ ownSession: '' }),
      base({ ownSession: '', ownSessionStarted: true }),
      base({ ownSession: OWN }),
      base({ ownSession: OWN, ownSessionStarted: true }),
    ];
    const routes: TurnRequest['route'][] = [
      { kind: 'own' },
      { kind: 'session', host: 'gemini', key: ROUTED },
      { kind: 'session', host: 'gemini', key: '' },
    ];
    for (const cfg of cfgs) {
      for (const route of routes) {
        for (const word of turnArgv(cfg, route)) {
          expect(word, 'an empty target value is RESUME_LATEST, not a session').not.toBe(
            '--resume=',
          );
          expect(word).not.toBe('--session-id=');
        }
      }
    }
  });

  it('exactly ONE target token, ever — the three flags are mutually exclusive at yargs', () => {
    const routes: TurnRequest['route'][] = [
      { kind: 'own' },
      { kind: 'session', host: 'gemini', key: ROUTED },
    ];
    for (const started of [false, true]) {
      for (const route of routes) {
        const argv = turnArgv(base({ ownSessionStarted: started }), route);
        const targets = argv.filter(
          w =>
            w.startsWith('--resume') || w.startsWith('--session-id') || w.startsWith('--session-file'),
        );
        expect(targets.length, `two target tokens is a usage error: ${argv.join(' ')}`).toBeLessThan(
          2,
        );
      }
    }
  });

  it('no -p, and the prompt is never in argv — it rides stdin', async () => {
    const s = seam([0], ['answered']);
    await run(base(), { kind: 'own' }, s.io);
    expect(s.spawns[0]!.argv).not.toContain('-p');
    expect(s.spawns[0]!.argv.join(' ')).not.toContain('the prompt');
    expect(s.spawns[0]!.prompt, 'the prompt rides stdin, as on every other host').toBe(
      'the prompt',
    );
  });

  it('the captured model pin rides `-m`, and stays out when the caps already choose one', async () => {
    const pinned = seam([0], ['answered']);
    await run(base({ geminiModel: 'gemini-3-pro' }), { kind: 'own' }, pinned.io);
    expect(pinned.spawns[0]!.argv).toEqual([
      `--session-id=${OWN}`,
      '-m',
      'gemini-3-pro',
      '--approval-mode',
      'plan',
    ]);

    // The operator's own caps are the later, more explicit statement — and
    // emitting both would leave WHICH ONE WINS to a yargs behaviour nobody
    // here has measured.
    const both = seam([0], ['answered']);
    await run(
      base({ geminiModel: 'gemini-3-pro', caps: ['-m', 'gemini-3-flash'] }),
      { kind: 'own' },
      both.io,
    );
    expect(both.spawns[0]!.argv.filter(w => w === '-m')).toHaveLength(1);
    expect(both.spawns[0]!.argv).toEqual([`--session-id=${OWN}`, '-m', 'gemini-3-flash']);

    // A hand-edited attend.json is the reachable way an unusable name gets
    // here, and an unusable value must yield NO FLAG — `turnArgv`'s third
    // defence, applied to the pin.
    for (const bad of ['--yolo', '-m', 'has space', 'x'.repeat(65), '']) {
      const hand = seam([0], ['answered']);
      await run(base({ geminiModel: bad }), { kind: 'own' }, hand.io);
      expect(
        hand.spawns[0]!.argv,
        `a model pin of ${JSON.stringify(bad)} must not reach argv`,
      ).toEqual([`--session-id=${OWN}`, '--approval-mode', 'plan']);
    }

    const unpinned = seam([0], ['answered']);
    await run(base(), { kind: 'own' }, unpinned.io);
    expect(
      unpinned.spawns[0]!.argv,
      'no captured model means nothing is passed — an invented value is a model nobody chose',
    ).toEqual([`--session-id=${OWN}`, '--approval-mode', 'plan']);
  });
});

// ---------------------------------------------------------------------------

describe('2. the isolation environment', () => {
  it('every spawn carries GEMINI_CLI_HOME under stateDir, 0700 at spawn time, plus the constants', async () => {
    const s = seam([0], ['answered']);
    await run(base(), { kind: 'own' }, s.io);
    const env = s.spawns[0]!.env;
    expect(env?.GEMINI_CLI_HOME, 'a gemini turn must never spawn without its own home').toBe(
      GEMINI_HOME,
    );
    expect(
      geminiHomeDir('bot'),
      "enable's copy and the driver's spawn must name the SAME directory",
    ).toBe(GEMINI_HOME);
    expect(s.spawns[0]!.modeAtSpawn).toBe(0o700);
    expect(env?.GEMINI_CLI_TRUST_WORKSPACE, 'folder trust hard-fails (exit 55) otherwise').toBe(
      'true',
    );
    expect(env?.GEMINI_TELEMETRY_ENABLED).toBe('false');
    // The credential is INHERITED, never restated in the delta: the driver
    // reads presence and never a value (rule 4).
    expect(Object.keys(env ?? {})).toEqual([
      'GEMINI_CLI_HOME',
      'GEMINI_CLI_TRUST_WORKSPACE',
      'GEMINI_TELEMETRY_ENABLED',
    ]);
  });

  it('the RECOVERY spawn is isolated too — argv built anywhere becomes a command once', async () => {
    const s = seam([42, 0], ['', 'answered']);
    await run(base({ ownSessionStarted: true }), { kind: 'own' }, s.io);
    expect(s.spawns).toHaveLength(2);
    for (const sp of s.spawns) expect(sp.env?.GEMINI_CLI_HOME).toBe(GEMINI_HOME);
  });

  it('no other host grows a GEMINI_ variable — isolation does not bleed across the seam', async () => {
    saveAttendConfig('bot', {
      host: 'claude',
      bin: '/opt/agent',
      workdir: '/w',
      caps: ['--permission-mode', 'plan'],
      ownSession: OWN,
      turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('hello'));
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const replies: string[] = [];
    expect(
      await attendOnce('bot', {
        sendReply: async (b: string) => void replies.push(b),
        runTurn: async (_a, _c, _p, env) => (envs.push(env), { stdout: 'ok', code: 0 }),
      }),
    ).toBe('answered');
    expect(envs[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('3. the exit-code classifier — by CODE, never by stderr text', () => {
  it('classifies the documented v0.58.0 table', () => {
    expect(
      [0, 41, 42, 44, 52, 53, 54, 55, 130, 127, 1, 2, 99].map(classifyGeminiExit),
    ).toEqual([
      'ok',
      'auth',
      'input',
      'sandbox',
      'unnamed',
      'turn-limit',
      'tool',
      'untrusted',
      'cancelled',
      'launch',
      'other',
      'other',
      'other',
    ]);
  });

  it('ONLY 42 re-spawns, and only on the own route, and only when a target was tried', async () => {
    for (const code of [0, 41, 44, 52, 53, 54, 55, 130, 127, 1]) {
      const s = seam([code, 0]);
      await run(base({ ownSessionStarted: true }), { kind: 'own' }, s.io);
      expect(s.spawns, `exit ${code} must not buy a second spawn`).toHaveLength(1);
    }
    // 42 on a ROUTED session is the operator's session, gone from the host's
    // store: inventing a fresh transcript under it would answer them in a
    // room that only looks like the one they replied to.
    const routed = seam([42, 0]);
    await run(base(), { kind: 'session', host: 'gemini', key: ROUTED }, routed.io);
    expect(routed.spawns).toHaveLength(1);
    // 42 with NO target tried: re-spawning the identical command is not a
    // recovery.
    const noTarget = seam([42, 0]);
    await run(base({ ownSession: '--zzz', ownSessionStarted: true }), { kind: 'own' }, noTarget.io);
    expect(noTarget.spawns).toHaveLength(1);
  });

  it('the one recovery re-spawns with NO target at all', async () => {
    const s = seam([42, 0], ['', 'answered']);
    const out = await run(base({ ownSessionStarted: true }), { kind: 'own' }, s.io);
    expect(s.spawns).toHaveLength(2);
    expect(s.spawns[0]!.argv[0]).toBe(`--resume=${OWN}`);
    expect(s.spawns[1]!.argv, 'the recovery runs fresh and unpinned').toEqual([
      '--approval-mode',
      'plan',
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('answered');
  });

  it('our own sentence rides stdout when the host said nothing, and never over its words', async () => {
    const silent = seam([55]);
    const refused = await run(base(), { kind: 'own' }, silent.io);
    expect(refused.code).toBe(55);
    expect(refused.stdout).toBe(geminiExitSentence('untrusted'));
    expect(refused.stdout, 'the sentence names the variable the operator can act on').toContain(
      'GEMINI_CLI_TRUST_WORKSPACE',
    );

    const spoke = seam([54], ['the model wrote this']);
    const kept = await run(base(), { kind: 'own' }, spoke.io);
    expect(kept.stdout, "a turn that printed its own words keeps them").toBe(
      'the model wrote this',
    );

    // 127 gets NOTHING added: `attendPass`'s own arm has the better sentence.
    const missing = seam([127]);
    expect((await run(base(), { kind: 'own' }, missing.io)).stdout).toBe('');
    // …and neither does a code with no name: `exit N` is the honest report.
    const unnamed = seam([52]);
    expect((await run(base(), { kind: 'own' }, unnamed.io)).stdout).toBe('');
  });

  it('the input sentence claims a retry ONLY on the path that ran one', async () => {
    // Own route, a target tried, the recovery also 42s: the retry happened,
    // so the sentence may say so.
    const own = seam([42, 42]);
    const retried = await run(base({ ownSessionStarted: true }), { kind: 'own' }, own.io);
    expect(own.spawns).toHaveLength(2);
    expect(retried.stdout).toContain('refused the session input it was given');
    expect(retried.stdout).toContain('Starting a fresh one also failed');

    // A ROUTED 42 re-spawns nothing — the likeliest gemini failure in the
    // field (a reply-to-continue whose key lives in the operator's own
    // ~/.gemini store, which the isolated home does not hold). The sentence
    // must not describe an attempt attend never made.
    const routed = seam([42]);
    const out = await run(base(), { kind: 'session', host: 'gemini', key: ROUTED }, routed.io);
    expect(routed.spawns).toHaveLength(1);
    expect(out.stdout).toContain('refused the session input it was given');
    expect(out.stdout, 'no retry ran, so none may be claimed').not.toContain('fresh one');

    // Own route, key unusable, so NO target was emitted: same rule.
    const none = seam([42]);
    const bare = await run(
      base({ ownSession: '--zzz', ownSessionStarted: true }),
      { kind: 'own' },
      none.io,
    );
    expect(none.spawns).toHaveLength(1);
    expect(bare.stdout).not.toContain('fresh one');
  });

  it('an operator caps word spelled like a target buys NO second spawn', async () => {
    // `attend enable` validates caps for empty elements and NUL bytes only,
    // so a profile beginning `--resume=…` is reachable. Deriving the form
    // from the argv would make the driver believe a target was tried: a 42
    // then costs a second, byte-identical spawn every turn, and writes
    // `ownSessionStarted` from a caps word.
    const s2 = seam([42, 0]);
    const out = await run(
      base({ ownSession: '--zzz', ownSessionStarted: true, caps: [`--resume=${ROUTED}`] }),
      { kind: 'own' },
      s2.io,
    );
    expect(s2.spawns, 'no target was emitted, so nothing may be recovered').toHaveLength(1);
    expect(s2.spawns[0]!.argv).toEqual([`--resume=${ROUTED}`]);
    expect(out.ownExists, 'the own flag must never be written from a caps word').toBeUndefined();
  });

  it('the auth sentence names the variable and no value; every sentence is credential-free', async () => {
    const s = seam([41]);
    const out = await run(base(), { kind: 'own' }, s.io);
    expect(out.stdout).toContain('GEMINI_API_KEY');
    expect(containsKeyFragment(out.stdout), 'rule 4: no run of the credential').toBe(false);
    expect(out.refusal, 'gemini has no refusal table — that is the point').toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('4. R25 — the own-session flag converges (an INFERENCE, stated as one)', () => {
  /** One pass with a scripted code per spawn; returns the argv of each spawn. */
  const pass = async (codes: number[]): Promise<string[][]> => {
    new MessageLog('bot').append(inRow('go'));
    const argvs: string[][] = [];
    let i = 0;
    await attendOnce('bot', {
      sendReply: async () => {},
      runTurn: async (argv: string[]) => {
        argvs.push(argv);
        const code = codes[i] ?? codes.at(-1) ?? 0;
        i += 1;
        return { stdout: code === 0 ? 'answered' : '', code };
      },
    });
    return argvs;
  };

  it('42 on the CREATE form sets the flag; 42 on the RESUME form clears it; the pin converges', async () => {
    // Turn 1: the create form. 42 there means "session id already in use"
    // (§3.8 M4), so the transcript exists — the next turn must RESUME.
    const first = await pass([42, 0]);
    expect(first[0]![0]).toBe(`--session-id=${OWN}`);
    expect(first[1], 'the recovery is fresh and unpinned').toEqual(['--approval-mode', 'plan']);
    expect(
      loadAttendConfig('bot')?.ownSessionStarted,
      'a create that reached the host wrote a transcript',
    ).toBe(true);

    // Turn 2: the resume form, and 42 here means the key is GONE (gemini
    // prunes its session store) — so the flag must CLEAR.
    const second = await pass([42, 0]);
    expect(second[0]![0], 'the flag must have changed the FORM').toBe(`--resume=${OWN}`);
    expect(loadAttendConfig('bot')?.ownSessionStarted).toBe(false);

    // Turn 3: back to the create form. Without the inference this would be
    // the same failing resume, forever, at two spawns a turn.
    const third = await pass([0]);
    expect(third[0]![0]).toBe(`--session-id=${OWN}`);
    expect(third, 'a turn that succeeds spawns once').toHaveLength(1);
    expect(loadAttendConfig('bot')?.ownSessionStarted).toBe(true);
  });

  it('127 writes NOTHING — a missing binary teaches nothing about the host store', async () => {
    saveAttendConfig('bot', base({ ownSessionStarted: true }));
    await pass([127]);
    expect(
      loadAttendConfig('bot')?.ownSessionStarted,
      'never write the flag from a spawn that never ran',
    ).toBe(true);

    saveAttendConfig('bot', base());
    await pass([127]);
    expect(loadAttendConfig('bot')?.ownSessionStarted).toBeUndefined();
  });

  it('a ROUTED turn never touches the own flag', async () => {
    const s = seam([42, 0]);
    const out = await run(
      base({ ownSessionStarted: true }),
      { kind: 'session', host: 'gemini', key: ROUTED },
      s.io,
    );
    expect(out.ownExists, 'the routed transcript is not the own transcript').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('5. the terms gate — both halves fail closed, neither echoes a credential', () => {
  it('the driver refuses BEFORE the spawn when the resolved child env carries no key', async () => {
    const s = seam([0], ['answered']);
    const out = await run(base(), { kind: 'own' }, { ...s.io, env: { PATH: '/usr/bin' } });
    expect(s.spawns, 'the foreclosure is pre-spawn: nothing may run').toHaveLength(0);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('GEMINI_API_KEY');
    expect(out.stdout).toContain('API key');
    expect(containsKeyFragment(out.stdout)).toBe(false);
    expect(out.ownExists).toBeUndefined();
  });

  it('presence is presence: an empty or blank value is not a credential', () => {
    expect(geminiCredentialPresent({})).toBe(false);
    expect(geminiCredentialPresent({ GEMINI_API_KEY: '' })).toBe(false);
    expect(geminiCredentialPresent({ GEMINI_API_KEY: '   ' })).toBe(false);
    expect(geminiCredentialPresent({ GEMINI_API_KEY: FAKE_KEY })).toBe(true);
    // §3.8 M7 is owed, so no other shape is accepted yet: refusing too much
    // is recoverable, accepting an unverified shape is not.
    expect(geminiCredentialPresent({ GOOGLE_API_KEY: FAKE_KEY })).toBe(false);
  });

  it('`attend enable --host gemini` refuses with no key, and saves nothing', () => {
    rmSync(join(home, 'state'), { recursive: true, force: true });
    let thrown: unknown;
    const printed = captureStdout(() => {
      try {
        cmdAttendEnable(
          'bot',
          { host: 'gemini', bin: process.execPath, workdir: home },
          report(),
          { env: { PATH: '/usr/bin' } },
        );
      } catch (err) {
        thrown = err;
      }
    });
    const err = thrown as { exitCode?: number; message?: string };
    expect(thrown).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.exitCode).not.toBe(2);
    expect(err.message).toContain('GEMINI_API_KEY');
    expect(err.message).toContain('Nothing was saved.');
    expect(
      loadAttendConfig('bot')?.bin,
      'a refused enable writes no config — the profile on disk is untouched',
    ).toBe('/opt/gemini');
    expect(printed).toBe('');
  });

  it('…and accepts with one, writing the plan floor and the unmeasured-host notice', () => {
    rmSync(join(home, 'state'), { recursive: true, force: true });
    const printed = captureStdout(() => {
      cmdAttendEnable('bot', { host: 'gemini', bin: process.execPath, workdir: home }, report(), {
        env: { GEMINI_API_KEY: FAKE_KEY },
      });
    });
    const cfg = loadAttendConfig('bot');
    expect(cfg?.host).toBe('gemini');
    expect(cfg?.caps).toEqual(['--approval-mode', 'plan']);
    expect(cfg?.bin).toBe(process.execPath);
    expect(cfg?.claudeDriver, 'no other host’s driver field may appear').toBeUndefined();
    expect(cfg?.codexDriver).toBeUndefined();
    // R21: the notice fires, names the measurement list, and cannot be
    // silenced by a flag.
    expect(printed).toContain('UNMEASURED');
    expect(printed).toContain('proved against a fake binary');
    expect(printed).toContain('API key');
    expect(printed).toContain('GEMINI_CLI_TRUST_WORKSPACE');
    expect(printed).toContain(GEMINI_HOME);
    // The two shared paragraphs, spoken here as on every other host.
    expect(printed).toContain('AI agent');
    // R21, sentence by sentence: the read-back may state what ATTEND does,
    // never the outcome of a measurement nobody ran. Three claims were
    // written in the indicative and are now tied to their owed rows.
    expect(printed, 'the isolation outcome is M5/M6, not a fact').not.toContain(
      'do not ride a phone-triggered turn',
    );
    expect(printed).not.toContain('A cached Google-account sign-in is not used');
    expect(printed).not.toContain('which is what stops every turn failing folder trust');
    expect(printed, 'the isolation intent names its owed rows').toContain('(M5, M6)');
    expect(printed, 'the foreclosure names M8').toContain('(M8)');
    expect(printed, 'folder trust names M9').toContain('(M9)');
    // Rule 4, the assertion the plan asks for by name.
    expect(containsKeyFragment(printed), 'no run of the key may reach the read-back').toBe(false);
  });

  it('`attend status` says the two things that decide whether every turn refuses', () => {
    saveAttendConfig('bot', base());
    const printed = captureStdout(() => cmdAttendStatus('bot', report()));
    expect(printed).toContain('API key only');
    expect(printed).toContain('GEMINI_API_KEY');
    expect(printed).toContain('UNMEASURED');
    expect(printed).toContain('proved against a fake binary');
    expect(containsKeyFragment(printed)).toBe(false);
  });

  it('`--driver` is refused for gemini — it has one driver, and no field to land in', () => {
    let thrown: unknown;
    try {
      cmdAttendEnable(
        'bot',
        { host: 'gemini', driver: 'sdk', bin: process.execPath, workdir: home },
        report(),
        { env: { GEMINI_API_KEY: FAKE_KEY } },
      );
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { exitCode?: number }).exitCode).toBe(EXIT.USAGE);
  });
});

// ---------------------------------------------------------------------------

describe('6. the room capability floor', () => {
  it('gemini gets --approval-mode plan and NEVER --permission-mode', () => {
    expect(roomCapsFloor('gemini')).toEqual(['--approval-mode', 'plan']);
    expect(roomCapsFloor('gemini').join(' ')).not.toContain('--permission-mode');
    // A flag the binary does not have is a usage error the operator reads as
    // the host's fault, on every room turn.
    expect(roomCapsFloor('claude')).toEqual(['--permission-mode', 'plan']);
    expect(roomCapsFloor('codex')).toEqual(['-s', 'read-only']);
  });

  it('a loosened operator profile is REPLACED; the model words carry through', () => {
    expect(roomCapsFloor('gemini', ['--approval-mode', 'yolo'])).toEqual([
      '--approval-mode',
      'plan',
    ]);
    expect(roomCapsFloor('gemini', ['--approval-mode', 'auto_edit'])).toEqual([
      '--approval-mode',
      'plan',
    ]);
    expect(roomCapsFloor('gemini', ['--approval-mode', 'yolo', '-m', 'gemini-3-pro'])).toEqual([
      '--approval-mode',
      'plan',
      '-m',
      'gemini-3-pro',
    ]);
    expect(roomCapsFloor('gemini', ['--model=gemini-3-pro'])).toEqual([
      '--approval-mode',
      'plan',
      '--model=gemini-3-pro',
    ]);
    // A flag-shaped or missing value is not a model name.
    expect(roomCapsFloor('gemini', ['-m', '--yolo'])).toEqual(['--approval-mode', 'plan']);
    expect(roomCapsFloor('gemini', ['-m'])).toEqual(['--approval-mode', 'plan']);
  });
});

// ---------------------------------------------------------------------------

describe('7. classifyRefusal is still claude-only', () => {
  it('the regression pin: claude’s three sentences classify, and gemini reuses none of them', async () => {
    expect(classifyRefusal('Error: Session ID abc is already in use')).toBe('session-exists');
    expect(classifyRefusal('No conversation found with session ID: abc')).toBe('no-conversation');
    expect(classifyRefusal('is currently running as a background agent')).toBe('live-session');

    // A gemini turn whose stderr QUOTES one of them classifies nothing and
    // re-spawns nothing: reusing claude's table on another host's stderr is
    // the exact bug that pin exists to prevent.
    const s = seam([1], [''], ['No conversation found with session ID: abc']);
    const out = await run(base({ ownSessionStarted: true }), { kind: 'own' }, s.io);
    expect(out.refusal).toBeNull();
    expect(s.spawns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('8. operatorGeminiModel — JSON, guarded, every failure reads as unpinned', () => {
  const read = (text: string) => operatorGeminiModel({ readFile: () => text });

  it('reads model.name, and treats every other shape as unpinned', () => {
    expect(read(JSON.stringify({ model: { name: 'gemini-3-pro' } }))).toBe('gemini-3-pro');
    expect(read('{ not json')).toBeUndefined();
    expect(read('[]')).toBeUndefined();
    expect(read(JSON.stringify({ model: 'gemini-3-pro' }))).toBeUndefined();
    expect(read(JSON.stringify({ model: { name: 42 } }))).toBeUndefined();
    expect(read(JSON.stringify({ mcpServers: {} }))).toBeUndefined();
    // The value lands in an argv element: a space, a control byte or an
    // over-long name is not a model name this can state.
    expect(read(JSON.stringify({ model: { name: 'a b' } }))).toBeUndefined();
    expect(read(JSON.stringify({ model: { name: 'a b' } }))).toBeUndefined();
    expect(read(JSON.stringify({ model: { name: 'x'.repeat(65) } }))).toBeUndefined();
    // FLAG-SHAPED, refused at CAPTURE — `geminiModelPin` would drop it at
    // emit time anyway, and a captured-but-dropped pin makes the enable
    // read-back report `geminiModelPinned: true` for a pin no turn uses.
    expect(read(JSON.stringify({ model: { name: '--yolo' } }))).toBeUndefined();
    expect(read(JSON.stringify({ model: { name: '-m' } }))).toBeUndefined();
  });

  it('an unreadable settings file is unpinned, never a throw', () => {
    expect(
      operatorGeminiModel({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('9. the fake binary — the argv, the env and the prompt that reach execve', () => {
  /**
   * A REAL SPAWN, through `attendOnce` with no `runTurn` seam, against a
   * shell script standing in for the absent binary. It records what execve
   * handed it — argv, the isolation variables, whether a credential was
   * PRESENT (never its value), and the prompt off stdin — and exits with a
   * code the test chooses. This is what makes "the driver is written against
   * a documented interface" a claim with a witness behind it.
   */
  const fakeDir = mkdtempSync(join(tmpdir(), 'tacendum-fakegemini-'));
  const binPath = join(fakeDir, 'gemini');
  const outPath = join(fakeDir, 'calls.txt');
  const codesPath = join(fakeDir, 'codes.txt');
  const countPath = join(fakeDir, 'count.txt');

  const install = (codes: number[]): void => {
    writeFileSync(codesPath, `${codes.join('\n')}\n`);
    rmSync(outPath, { force: true });
    rmSync(countPath, { force: true });
    writeFileSync(
      binPath,
      [
        '#!/bin/sh',
        `n=$(cat "${countPath}" 2>/dev/null || echo 0)`,
        'n=$((n+1))',
        `echo "$n" > "${countPath}"`,
        '{',
        '  echo "CALL"',
        '  for a in "$@"; do echo "ARG=$a"; done',
        '  echo "HOME=$GEMINI_CLI_HOME"',
        '  echo "TRUST=$GEMINI_CLI_TRUST_WORKSPACE"',
        '  echo "TELEMETRY=$GEMINI_TELEMETRY_ENABLED"',
        // PRESENCE only — the value never reaches a file (rule 4).
        '  if [ -n "$GEMINI_API_KEY" ]; then echo "KEY=present"; else echo "KEY=absent"; fi',
        '  echo "STDIN=$(cat)"',
        `} >> "${outPath}"`,
        `code=$(sed -n "\${n}p" "${codesPath}")`,
        '[ -n "$code" ] || code=0',
        '[ "$code" = "0" ] && echo "the answer"',
        'exit "$code"',
      ].join('\n'),
    );
    chmodSync(binPath, 0o755);
  };

  it('a successful turn: one spawn, the create form, the isolated env, the prompt on stdin', async () => {
    install([0]);
    saveAttendConfig('bot', base({ bin: binPath, workdir: fakeDir }));
    new MessageLog('bot').append(inRow('what is the status'));
    const replies: string[] = [];
    expect(await attendOnce('bot', { sendReply: async (b: string) => void replies.push(b) })).toBe(
      'answered',
    );
    const recorded = readFileSync(outPath, 'utf8');
    expect(recorded.match(/^CALL$/gm) ?? [], 'one turn, one spawn').toHaveLength(1);
    expect(recorded).toContain(`ARG=--session-id=${OWN}`);
    expect(recorded).toContain('ARG=--approval-mode');
    expect(recorded).not.toContain('ARG=-p');
    expect(recorded).toContain(`HOME=${GEMINI_HOME}`);
    expect(recorded).toContain('TRUST=true');
    expect(recorded).toContain('TELEMETRY=false');
    expect(recorded, 'the key is INHERITED by the child, never restated').toContain('KEY=present');
    expect(recorded, 'the prompt reached stdin, not argv').toContain('what is the status');
    expect(replies[0]).toContain('the answer');
    expect(statSync(GEMINI_HOME).mode & 0o777).toBe(0o700);
  });

  it('a 42 costs two spawns and one turn, and the second carries no target', async () => {
    install([42, 42]);
    saveAttendConfig('bot', base({ bin: binPath, workdir: fakeDir, ownSessionStarted: true }));
    new MessageLog('bot').append(inRow('go'));
    const replies: string[] = [];
    expect(await attendOnce('bot', { sendReply: async (b: string) => void replies.push(b) })).toBe(
      'failed',
    );
    const calls = readFileSync(outPath, 'utf8').split('CALL\n').slice(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`ARG=--resume=${OWN}`);
    expect(calls[1]).not.toContain('ARG=--resume');
    expect(calls[1]).not.toContain('ARG=--session-id');
    // The operator hears our sentence, with the host's own code.
    expect(replies[0]).toContain('exit 42');
    expect(replies[0]).toContain(geminiExitSentence('input'));
    expect(containsKeyFragment(replies.join('\n'))).toBe(false);
  });

  it('a 41 is refused without a retry, and the reply names the key variable, not a value', async () => {
    install([41, 0]);
    saveAttendConfig('bot', base({ bin: binPath, workdir: fakeDir }));
    new MessageLog('bot').append(inRow('go'));
    const replies: string[] = [];
    expect(await attendOnce('bot', { sendReply: async (b: string) => void replies.push(b) })).toBe(
      'failed',
    );
    expect(readFileSync(outPath, 'utf8').match(/^CALL$/gm) ?? []).toHaveLength(1);
    expect(replies[0]).toContain('exit 41');
    expect(replies[0]).toContain('GEMINI_API_KEY');
    expect(containsKeyFragment(replies.join('\n'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('10. the seam shape — gemini is a spawn-seam driver and surfaces nothing else', () => {
  it('never invokes ask, steering or stream', async () => {
    let asked = 0;
    let steered = 0;
    let streamed = 0;
    const io: DriverIo = { spawn: async () => ({ stdout: 'done', stderr: '', code: 0 }) };
    const res = await driverFor('gemini').runTurn(
      {
        cfg: base(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => {
          asked += 1;
          return 'deny' as const;
        },
        steering: () => {
          steered += 1;
        },
        stream: () => {
          streamed += 1;
        },
      },
      io,
    );
    expect([asked, steered, streamed], 'no approval, steer or stream channel exists here').toEqual([
      0, 0, 0,
    ]);
    expect(res.code).toBe(0);
    expect(res.refusal).toBeNull();
  });
});
