import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo, SessionFactory, SessionHandle } from '../src/attend-drivers.js';

/**
 * The driver seam: each host's half of a turn,
 * exercised through `runTurn` alone. The supervisor's rails — cursor,
 * journal, turn lock, hourly bucket, reply funnel — are attend.test.ts's
 * property and appear nowhere here. What these tests pin is that a driver
 * spawns the right command, recovers only when its own host proved no model
 * was called, and never reads another host's refusals.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-drivers-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://attend-drivers.test';
process.env.TACENDUM_WS = 'ws://attend-drivers.test';

const { classifyRefusal, driverFor } = await import('../src/attend-drivers.js');

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

/**
 * The isolation shapes, QUOTED — the same rule as the refusal
 * sentences below: a driver that stops sending any one of these must
 * visibly disagree with a spelled-out expectation, not quietly agree with
 * whatever the code now sends. `--setting-sources=` is one token, inline
 * `=` form (commander's separator); the codex home is the attend-owned dir
 * under this account's state directory.
 */
const CLAUDE_ISOLATION = ['--safe-mode', '--strict-mcp-config', '--setting-sources='] as const;
const CODEX_HOME = join(home, 'state', 'bot', 'codex-home');

/**
 * THE HOST'S OWN WORDS, verbatim — the same quoted strings attend.test.ts
 * carries, for the same reason: a test that no longer matches the host must
 * visibly disagree with a quoted sentence, not quietly agree with whatever
 * the code happens to look for.
 */
const REFUSAL = {
  inUse: (id: string) => `Error: Session ID ${id} is already in use.\n`,
  noConversation: (id: string) => `No conversation found with session ID: ${id}\n`,
  live: (id: string) =>
    `Error: Session ${id} is currently running as a background agent (background). ` +
    'Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.\n',
};

const claudeCfg = (over: Partial<AttendConfig> = {}): AttendConfig => ({
  host: 'claude',
  bin: '/opt/agent',
  workdir: '/w',
  caps: ['--permission-mode', 'plan'],
  ownSession: OWN_SESSION,
  turnsPerHour: 10,
  ...over,
});
const codexCfg = (over: Partial<AttendConfig> = {}): AttendConfig => ({
  host: 'codex',
  bin: '/opt/codex',
  workdir: '/w',
  caps: ['-s', 'read-only'],
  ownSession: OWN_SESSION,
  turnsPerHour: 10,
  ...over,
});

type Answer = { stdout: string; stderr: string; code: number };
const ok: Answer = { stdout: 'done: shipped', stderr: '', code: 0 };

/** A spawn seam whose answers are scripted in sequence, recording every
 * call: the recovery tests are about what the SECOND spawn is, and the
 * codex tests are about there never being one. `env` is recorded too —
 * codex isolation rides it, and claude's must NOT. */
const seam = (...answers: Answer[]) => {
  const calls: {
    argv: string[];
    cwd: string;
    prompt: string;
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  let i = 0;
  const io: DriverIo = {
    spawn: async (argv, cwd, prompt, env) => {
      calls.push({ argv, cwd, prompt, env });
      const a = answers[Math.min(i, answers.length - 1)] as Answer;
      i += 1;
      return a;
    },
  };
  return { calls, io };
};

describe('driverFor', () => {
  it('hands each host its own driver, and the driver knows its name', () => {
    expect(driverFor('claude').host).toBe('claude');
    expect(driverFor('codex').host).toBe('codex');
  });
});

describe('the claude driver', () => {
  it('argv per route: a routed session resumes; own-fresh creates; own-started resumes', async () => {
    const a = seam(ok);
    await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      a.io,
    );
    expect(a.calls[0]!.argv).toEqual([
      '-p',
      `--resume=${SESSION_A}`,
      '--permission-mode',
      'plan',
      ...CLAUDE_ISOLATION,
    ]);
    expect(a.calls[0]!.cwd, 'the turn runs in the configured workdir').toBe('/w');
    expect(a.calls[0]!.prompt, 'the prompt rides the spawn seam, never argv').toBe('p');

    const b = seam(ok);
    await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      b.io,
    );
    expect(b.calls[0]!.argv).toEqual([
      '-p',
      `--session-id=${OWN_SESSION}`,
      '--permission-mode',
      'plan',
      ...CLAUDE_ISOLATION,
    ]);

    const c = seam(ok);
    await driverFor('claude').runTurn(
      {
        cfg: claudeCfg({ ownSessionStarted: true }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      c.io,
    );
    expect(c.calls[0]!.argv).toEqual([
      '-p',
      `--resume=${OWN_SESSION}`,
      '--permission-mode',
      'plan',
      ...CLAUDE_ISOLATION,
    ]);
  });

  it('a LIVE routed session recovers by forking BESIDE it — the same command plus --fork-session', async () => {
    const s = seam(
      { stdout: '', stderr: REFUSAL.live(SESSION_A), code: 1 },
      { ...ok, stdout: 'beside it: fine' },
    );
    const res = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(s.calls).toHaveLength(2);
    // The same command plus --fork-session — with the isolation tail riding
    // BOTH spawns, because it is applied at the spawn funnel, not per site.
    expect(s.calls[0]!.argv).toEqual([
      '-p',
      `--resume=${SESSION_A}`,
      '--permission-mode',
      'plan',
      ...CLAUDE_ISOLATION,
    ]);
    expect(s.calls[1]!.argv).toEqual([
      '-p',
      `--resume=${SESSION_A}`,
      '--permission-mode',
      'plan',
      '--fork-session',
      ...CLAUDE_ISOLATION,
    ]);
    expect(res.code).toBe(0);
    expect(res.refusal, 'a recovered turn reports no refusal').toBeNull();
    expect(res.stdout).toBe('beside it: fine');
  });

  it('a create the host says ALREADY EXISTS recovers by resuming, and reports the transcript present', async () => {
    const s = seam(
      { stdout: '', stderr: REFUSAL.inUse(OWN_SESSION), code: 1 },
      { ...ok, stdout: 'resumed instead' },
    );
    const res = await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      s.io,
    );
    expect(s.calls[0]!.argv.slice(0, 2)).toEqual(['-p', `--session-id=${OWN_SESSION}`]);
    expect(s.calls[1]!.argv.slice(0, 2)).toEqual(['-p', `--resume=${OWN_SESSION}`]);
    expect(res.refusal).toBeNull();
    expect(res.ownExists, 'the host said the transcript is present').toBe(true);
  });

  it('a resume the host says has NO CONVERSATION recovers by re-creating — the OWN session only', async () => {
    const s = seam(
      { stdout: '', stderr: REFUSAL.noConversation(OWN_SESSION), code: 1 },
      { ...ok, stdout: 'created instead' },
    );
    const res = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg({ ownSessionStarted: true }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(s.calls[0]!.argv.slice(0, 2)).toEqual(['-p', `--resume=${OWN_SESSION}`]);
    expect(s.calls[1]!.argv.slice(0, 2)).toEqual(['-p', `--session-id=${OWN_SESSION}`]);
    expect(
      res.ownExists,
      'the recovery spawn reached the host, which writes at session start',
    ).toBe(true);
  });

  it("a ROUTED session that answers no-conversation is not attend's to re-create: one spawn", async () => {
    const s = seam({ stdout: '', stderr: REFUSAL.noConversation(SESSION_A), code: 1 });
    const res = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(
      s.calls,
      "the operator's session is gone from the host's store; a fresh transcript under its id " +
        'would answer them in a room that only looks like the one they replied to',
    ).toHaveLength(1);
    expect(res.refusal).toBe('no-conversation');
    expect(res.ownExists, 'a routed turn teaches nothing about the OWN transcript').toBeUndefined();
  });

  it('a recovery that would reissue the command that just failed is refused — one spawn', async () => {
    // A CREATE answered "no conversation": the recovery arm re-derives the
    // own-session form with ownStarted=false, which is the argv that just
    // ran. The sameArgv guard must stop the second spawn — the same refusal
    // twice is not a recovery.
    const s = seam({ stdout: '', stderr: REFUSAL.noConversation(OWN_SESSION), code: 1 });
    const res = await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      s.io,
    );
    expect(s.calls).toHaveLength(1);
    expect(res.refusal).toBe('no-conversation');
  });

  it('a refusal sentence from a turn that SUCCEEDED is an agent talking, not a host refusing', async () => {
    const s = seam({ stdout: 'quoting the host at you', stderr: REFUSAL.live(SESSION_A), code: 0 });
    const res = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(res.refusal, 'only a FAILED turn can be a refusal').toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  it("observeOwn's truth table: what one spawn taught about the own transcript", async () => {
    // A successful own turn: the transcript exists.
    const a = seam(ok);
    const ra = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg({ ownSessionStarted: true }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      a.io,
    );
    expect(ra.ownExists).toBe(true);

    // A FAILED own turn that is no refusal still says the transcript exists:
    // claude writes it at SESSION START, so a create that got past the
    // existence check left it on disk whatever happened after (the wedge).
    const b = seam({ stdout: '', stderr: 'Error: overloaded_error\n', code: 1 });
    const rb = await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      b.io,
    );
    expect(rb.ownExists).toBe(true);

    // 127 teaches NOTHING: nothing ran, so nothing was observed.
    const c = seam({ stdout: '', stderr: '', code: 127 });
    const rc = await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      c.io,
    );
    expect(rc.ownExists, 'code 127 must not overwrite what the flag records').toBeUndefined();

    // A resume refused "no conversation" whose create recovery then dies at
    // spawn (127): the last thing the HOST said stands — absent.
    const d = seam(
      { stdout: '', stderr: REFUSAL.noConversation(OWN_SESSION), code: 1 },
      { stdout: '', stderr: '', code: 127 },
    );
    const rd = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg({ ownSessionStarted: true }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      d.io,
    );
    expect(rd.ownExists, 'the flag records what was OBSERVED, not what was hoped').toBe(false);

    // A routed turn observes nothing about the own transcript.
    const e = seam(ok);
    const re = await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      e.io,
    );
    expect(re.ownExists).toBeUndefined();
  });

  /**
   * CONFIG ISOLATION IS PER SPAWN, NOT PER TURN. Three flags because
   * isolation is three measured axes on claude 2.1.187 — settings, MCP
   * config, and CLAUDE.md/skills/plugins — and losing any one of them
   * reopens the operator's global config to a phone-triggered turn. Applied
   * at the driver's spawn funnel so the RECOVERY spawn cannot miss it.
   */
  it('every claude spawn is isolated — recovery included — and --bare never appears', async () => {
    const s = seam(
      { stdout: '', stderr: REFUSAL.live(SESSION_A), code: 1 },
      { ...ok, stdout: 'beside it: fine' },
    );
    await driverFor('claude').runTurn(
      {
        cfg: claudeCfg(),
        route: { kind: 'session', host: 'claude', key: SESSION_A },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(s.calls).toHaveLength(2);
    for (const call of s.calls) {
      for (const flag of CLAUDE_ISOLATION) {
        expect(call.argv, `${flag} must ride every claude spawn`).toContain(flag);
      }
      // The INLINE form only: a split `--setting-sources ''` pair is a
      // different argv, and a bare `--setting-sources` token would leave the
      // next token open to re-parsing (turnArgv's commander separator rule).
      expect(call.argv).not.toContain('--setting-sources');
      // --bare looks interchangeable with --safe-mode and is not: its help
      // says auth becomes strictly ANTHROPIC_API_KEY/apiKeyHelper, which
      // breaks the subscription-safe subprocess mode (the recorded rulings).
      expect(call.argv, '--bare breaks subscription auth — forbidden').not.toContain('--bare');
      expect(
        call.env,
        "claude's isolation is argv flags; no environment override rides its spawns",
      ).toBeUndefined();
    }
  });
});

describe('the ask seam', () => {
  /**
   * The seam is OPTIONAL AT BOTH ENDS, and this is the measured fact the
   * approval spine is built on: neither SPAWN-SEAM driver can produce an
   * approval, so a supervisor offering `ask` to either must change nothing —
   * no call, no shape change, the same turn as before. The spine is proven
   * against a fake approving driver in gate.approval-spine.test.ts; what is
   * pinned here is that offering the callback to the spawn-seam drivers is
   * inert. (The opt-in app-server driver is the one that CAN ask — its own
   * describe below.)
   */
  it('neither shipped driver ever asks — the callback is offered and never called', async () => {
    let asked = 0;
    const ask = async (): Promise<'deny'> => {
      asked += 1;
      return 'deny';
    };

    const c = seam(ok);
    const claude = await driverFor('claude').runTurn(
      { cfg: claudeCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot', ask },
      c.io,
    );
    expect(claude.code).toBe(0);
    expect(c.calls).toHaveLength(1);

    const x = seam(ok);
    const codex = await driverFor('codex').runTurn(
      {
        cfg: codexCfg(),
        route: { kind: 'session', host: 'codex', key: 'K1' },
        prompt: 'p',
        account: 'bot',
        ask,
      },
      x.io,
    );
    expect(codex.code).toBe(0);
    expect(x.calls).toHaveLength(1);

    expect(asked, 'the shipped drivers cannot produce an approval — the whole finding').toBe(0);
  });
});

describe('the codex driver', () => {
  it('argv: exec with caps first, and `resume -- <key>` only when a key is routed', async () => {
    const a = seam(ok);
    await driverFor('codex').runTurn(
      {
        cfg: codexCfg(),
        route: { kind: 'session', host: 'codex', key: 'K1' },
        prompt: 'p',
        account: 'bot',
      },
      a.io,
    );
    expect(a.calls[0]!.argv).toEqual([
      'exec',
      '--ignore-user-config',
      '-s',
      'read-only',
      'resume',
      '--',
      'K1',
    ]);

    const b = seam(ok);
    await driverFor('codex').runTurn(
      { cfg: codexCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      b.io,
    );
    expect(b.calls[0]!.argv).toEqual(['exec', '--ignore-user-config', '-s', 'read-only']);
    expect(b.calls[0]!.cwd).toBe('/w');
    expect(b.calls[0]!.prompt).toBe('p');
  });

  /**
   * THE ISOLATED HOME (the config-isolation ruling): every codex spawn runs under
   * an attend-owned CODEX_HOME beneath this account's state dir — the ONLY
   * mechanism that covers AGENTS.md, skills and the approved-prefix
   * allowlist, all of which load with no config.toml present. 0700 because
   * the home will hold auth.json, a live OAuth token.
   */
  it('codex spawns carry the attend-owned CODEX_HOME, created 0700 on demand', async () => {
    const s = seam(ok);
    await driverFor('codex').runTurn(
      { cfg: codexCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      s.io,
    );
    expect(s.calls[0]!.env).toEqual({ CODEX_HOME });
    expect(statSync(CODEX_HOME).mode & 0o777, 'a live OAuth token lives here — owner-only').toBe(
      0o700,
    );
  });

  it('-c model=… rides the exec-options slot ONLY when enable captured a pin', async () => {
    // Pinned: the flag pair sits in exec-option space, BEFORE the `resume`
    // subcommand — after it, clap parses against resume's grammar (exit 2).
    const pinned = seam(ok);
    await driverFor('codex').runTurn(
      {
        cfg: codexCfg({ codexModel: 'gpt-5-codex' }),
        route: { kind: 'session', host: 'codex', key: 'K1' },
        prompt: 'p',
        account: 'bot',
      },
      pinned.io,
    );
    expect(pinned.calls[0]!.argv).toEqual([
      'exec',
      '--ignore-user-config',
      '-c',
      'model=gpt-5-codex',
      '-s',
      'read-only',
      'resume',
      '--',
      'K1',
    ]);
    // Unpinned: NOTHING is passed — codex's built-in default is the
    // behaviour an operator with no config.toml model already had, and an
    // invented value would be a model nobody chose.
    const unpinned = seam(ok);
    await driverFor('codex').runTurn(
      { cfg: codexCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      unpinned.io,
    );
    expect(unpinned.calls[0]!.argv.join(' ')).not.toContain('model=');
  });

  it('one spawn is the whole turn — a failure buys codex no recovery and no observation', async () => {
    const s = seam({ stdout: '', stderr: "error: unexpected argument '-s' found\n", code: 2 });
    const res = await driverFor('codex').runTurn(
      {
        cfg: codexCfg(),
        route: { kind: 'session', host: 'codex', key: 'K1' },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(s.calls, 'codex has no recovery: a second spawn must not exist').toHaveLength(1);
    expect(res.code).toBe(2);
    expect(res.refusal).toBeNull();
    expect(res.ownExists, 'codex makes no own-session observation').toBeUndefined();
  });

  /**
   * THE CROSS-HOST BLEED. Before the driver
   * split, `classifyRefusal(turn.stderr)` ran on CODEX stderr too: a codex
   * failure whose stderr happened to contain claude's "No conversation found
   * with session ID" was classified as claude's refusal, and the operator got
   * claude's sentence — "that session is gone from this machine." — for a
   * codex failure it does not describe. Fixed by construction (codex's driver
   * has no refusal table), and pinned here because a bug fixed by
   * construction reappears the moment someone adds a refusal table to the
   * wrong driver.
   */
  it("claude's refusal sentence in CODEX stderr is no refusal at all", async () => {
    const s = seam({ stdout: '', stderr: REFUSAL.noConversation(SESSION_A), code: 1 });
    const res = await driverFor('codex').runTurn(
      {
        cfg: codexCfg(),
        route: { kind: 'session', host: 'codex', key: 'K1' },
        prompt: 'p',
        account: 'bot',
      },
      s.io,
    );
    expect(res.refusal, "claude's refusal table must not classify codex stderr").toBeNull();
    expect(s.calls, 'and the sentence must not buy a recovery spawn either').toHaveLength(1);
    // Non-vacuous by construction: the same stderr IS a refusal to claude's
    // own classifier — the bleed was real, and this pair of assertions fails
    // the day the classifier is wired back into shared code or a refusal
    // table lands on the wrong driver.
    expect(classifyRefusal(REFUSAL.noConversation(SESSION_A))).toBe('no-conversation');
  });
});

/**
 * ---------------------------------------------------------------------------
 * THE CODEX APP-SERVER DRIVER — the opt-in duplex half, against a
 * FAKED session driving the REAL client. The fake speaks the measured
 * 0.153.4 dialect: bare `{id,method,params}` frames, server→client requests
 * in their OWN id space starting at 0, `initialize` answering no capability
 * list, the fileChange approval params carrying NO diff. Frame shapes are
 * lifted from the captured transcripts, not invented.
 * ---------------------------------------------------------------------------
 */

type Frame = Record<string, unknown>;

const THREAD_ID = '019ff798-8ce6-7cd2-8de5-3877ffb1f6fe';
const TURN_ID = '019ff798-8df9-7b21-b739-199e35176da2';

interface FakeApproval {
  kind: 'command' | 'fileChange' | 'request';
  /** The SERVER's request id — its own counter, 0 first (measured). A test
   * may force a value that collides with a client id: the split must hold. */
  id?: number;
  command?: string;
  cwd?: string;
  itemId?: string;
  /** false: the approval names an itemId no item/started ever delivered —
   * the failed-join case. */
  emitItem?: boolean;
  diff?: string;
  path?: string;
  /** kind 'request': an arbitrary server→client request (the OTHER
   * families — requestUserInput, permissions), staged verbatim so the
   * pinned per-family decision can be asserted on the wire. */
  method?: string;
  params?: Frame;
}

/**
 * A scripted app-server. It answers the handshake, hands out a thread,
 * accepts one turn, stages the configured approvals (each parking until the
 * client's decision frame arrives — the measured pause), then completes the
 * turn. Everything the client writes is recorded, raw and parsed, so tests
 * assert the WIRE, not the client's self-report.
 */
const appServer = (
  opts: {
    threadId?: string;
    reply?: string;
    approvals?: FakeApproval[];
    turnStatus?: 'completed' | 'failed';
    turnError?: string;
  } = {},
) => {
  const threadId = opts.threadId ?? THREAD_ID;
  const rawLines: string[] = [];
  const wrote: Frame[] = [];
  /** Frames the client sent as ANSWERS to server→client requests. */
  const decisions: Frame[] = [];
  const spawned: {
    argv: string[];
    cwd: string;
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  let lineCb: ((line: string) => void) | undefined;
  let exitCb: ((code: number | null) => void) | undefined;
  const emit = (obj: Frame): void => queueMicrotask(() => lineCb?.(JSON.stringify(obj)));

  let served = 0;
  const serveNext = (): void => {
    const a = opts.approvals?.[served];
    if (a === undefined) {
      if (opts.reply !== undefined) {
        emit({
          method: 'item/completed',
          params: {
            item: {
              type: 'agentMessage',
              id: 'msg_1',
              text: opts.reply,
              phase: 'commentary',
              memoryCitation: null,
            },
            threadId,
            turnId: TURN_ID,
            completedAtMs: 2,
          },
        });
      }
      emit({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: TURN_ID,
            items: [],
            itemsView: 'notLoaded',
            status: opts.turnStatus ?? 'completed',
            error:
              opts.turnError === undefined
                ? null
                : { message: opts.turnError, codexErrorInfo: null, additionalDetails: null },
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        },
      });
      return;
    }
    if (a.kind === 'request') {
      emit({
        method: a.method ?? 'item/tool/requestUserInput',
        id: a.id ?? 0,
        params: a.params ?? {},
      });
      return;
    }
    if (a.kind === 'fileChange') {
      const itemId = a.itemId ?? 'fc_1';
      if (a.emitItem !== false) {
        emit({
          method: 'item/started',
          params: {
            item: {
              type: 'fileChange',
              id: itemId,
              status: 'inProgress',
              changes: [
                {
                  path: a.path ?? 'src/app.ts',
                  kind: { type: 'update', move_path: null },
                  diff: a.diff ?? '@@ -1 +1 @@\n-old line\n+new line',
                },
              ],
            },
            threadId,
            turnId: TURN_ID,
            startedAtMs: 1,
          },
        });
      }
      // The measured shape: 211 bytes, NO diff — threadId/turnId/itemId/
      // startedAtMs/reason and nothing that could be rendered alone.
      emit({
        method: 'item/fileChange/requestApproval',
        id: a.id ?? 0,
        params: {
          kind: 'fileChange',
          threadId,
          turnId: TURN_ID,
          itemId,
          startedAtMs: 1,
          reason: null,
          grantRoot: null,
        },
      });
      return;
    }
    emit({
      method: 'item/commandExecution/requestApproval',
      id: a.id ?? 0,
      params: {
        kind: 'command',
        threadId,
        turnId: TURN_ID,
        itemId: 'exec-1',
        startedAtMs: 1,
        environmentId: 'local',
        command: a.command ?? "/bin/zsh -lc 'touch approved.txt'",
        cwd: a.cwd ?? '/w',
        commandActions: [{ type: 'unknown', command: 'touch approved.txt' }],
        proposedExecpolicyAmendment: ['touch', 'approved.txt'],
        availableDecisions: ['accept', 'cancel'],
      },
    });
  };

  const handle = (f: Frame): void => {
    const { id, method } = f;
    if (typeof method === 'string' && id !== undefined) {
      if (method === 'initialize') {
        // The measured response, whole: NO capability list (dialect quirk 3).
        emit({
          id,
          result: {
            userAgent: 'codex/0.153.4',
            codexHome: '/isolated',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        });
      } else if (method === 'thread/start') {
        emit({ id, result: { thread: { id: threadId } } });
      } else if (method === 'thread/resume') {
        emit({ id, result: { thread: { id: (f.params as Frame).threadId } } });
      } else if (method === 'turn/start') {
        emit({ id, result: { turn: { id: TURN_ID, status: 'inProgress' } } });
        emit({ method: 'turn/started', params: { threadId, turn: { id: TURN_ID } } });
        serveNext();
      }
      return;
    }
    if (id !== undefined) {
      // The client answering OUR request — the other id space.
      decisions.push(f);
      emit({ method: 'serverRequest/resolved', params: { threadId, requestId: id } });
      served += 1;
      serveNext();
    }
  };

  const session: SessionHandle = {
    write(line) {
      rawLines.push(line);
      const f = JSON.parse(line) as Frame;
      wrote.push(f);
      queueMicrotask(() => handle(f));
    },
    onLine(cb) {
      lineCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    kill() {
      queueMicrotask(() => exitCb?.(0));
    },
  };
  const factory: SessionFactory = (argv, cwd, env) => {
    spawned.push({ argv, cwd, env });
    return session;
  };
  return { factory, spawned, rawLines, wrote, decisions };
};

/** DriverIo for app-server tests: the duplex seam plus a spawn that counts —
 * the opt-in split is exactly "which seam ran". */
const appServerIo = (factory: SessionFactory) => {
  const spawns: string[][] = [];
  const io: DriverIo = {
    spawn: async (argv) => {
      spawns.push(argv);
      return { stdout: 'exec ran', stderr: '', code: 0 };
    },
    session: factory,
  };
  return { io, spawns };
};

const appCfg = (over: Partial<AttendConfig> = {}): AttendConfig =>
  codexCfg({ codexDriver: 'app-server', ...over });

describe('the codex app-server driver', () => {
  it('existing configs keep the exec driver — the duplex seam is opt-in, never a default', async () => {
    const s = appServer();
    const { io, spawns } = appServerIo(s.factory);
    const res = await driverFor('codex').runTurn(
      { cfg: codexCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      io,
    );
    expect(spawns, 'no codexDriver field means the exec path, unchanged').toHaveLength(1);
    expect(s.spawned, 'the session seam must not run for an un-opted account').toHaveLength(0);
    expect(res.stdout).toBe('exec ran');
  });

  it('a codexDriver value this build does not recognise refuses the turn — neither driver is guessed', async () => {
    const s = appServer();
    const { io, spawns } = appServerIo(s.factory);
    const res = await driverFor('codex').runTurn(
      {
        // A config written by a future build (or a typo): the union does not
        // admit it, which is exactly the situation under test.
        cfg: { ...codexCfg(), codexDriver: 'daemon' as unknown as 'exec' },
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      io,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('codexDriver');
    expect(res.stdout, 'the unrecognised value is never echoed').not.toContain('daemon');
    expect(spawns).toHaveLength(0);
    expect(s.spawned).toHaveLength(0);
  });

  it('one turn, this dialect: handshake, typed settings, reply from item/completed(agentMessage)', async () => {
    const s = appServer({ reply: 'done: shipped' });
    const { io, spawns } = appServerIo(s.factory);
    const res = await driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'hello there', account: 'bot' },
      io,
    );
    expect(spawns, 'the spawn seam must not run for an app-server turn').toHaveLength(0);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.argv).toEqual(['app-server', '--strict-config']);
    expect(s.spawned[0]!.cwd).toBe('/w');
    expect(s.spawned[0]!.env, 'the isolated home rides the session spawn too').toEqual({
      CODEX_HOME,
    });
    expect(statSync(CODEX_HOME).mode & 0o777).toBe(0o700);

    // THE WIRE, not the client's self-report. Bare frames: no jsonrpc member
    // anywhere (measured: zero occurrences in any capture), one line each.
    for (const line of s.rawLines) expect(line).not.toContain('\n');
    for (const f of s.wrote)
      expect(Object.keys(f), 'no jsonrpc member — the 0.153.4 dialect').not.toContain('jsonrpc');

    const methods = s.wrote.map((f) => f.method);
    expect(methods.slice(0, 2), 'initialize, then the initialized notification').toEqual([
      'initialize',
      'initialized',
    ]);
    const start = s.wrote.find((f) => f.method === 'thread/start');
    expect(start, 'an own route starts a fresh thread').toBeDefined();
    const params = start!.params as Frame;
    expect(params.cwd).toBe('/w');
    expect(params.sandbox, "caps ['-s','read-only'] became a TYPED thread setting").toBe(
      'read-only',
    );
    expect(params.approvalPolicy).toBe('untrusted');
    expect(
      params.approvalsReviewer,
      'the current stable dialect names the user as the approval reviewer explicitly',
    ).toBe('user');
    expect(
      Object.keys(params),
      'no model pin captured means NO model member — never invented',
    ).not.toContain('model');
    const turnStart = s.wrote.find((f) => f.method === 'turn/start');
    expect((turnStart!.params as Frame).threadId).toBe(THREAD_ID);
    expect((turnStart!.params as Frame).input).toEqual([
      { type: 'text', text: 'hello there', text_elements: [] },
    ]);

    // The reply is the completed agentMessage's text — same supervisor
    // channel as ever, new source (the step 8).
    expect(res.stdout).toBe('done: shipped');
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.refusal).toBeNull();
    // The own-session key, learned on a FRAME.
    expect(res.sessionKey).toBe(THREAD_ID);
  });

  it('the model pin rides thread settings only when enable captured one', async () => {
    const s = appServer({ reply: 'ok' });
    await driverFor('codex').runTurn(
      {
        cfg: appCfg({ codexModel: 'gpt-5-codex' }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      appServerIo(s.factory).io,
    );
    expect((s.wrote.find((f) => f.method === 'thread/start')!.params as Frame).model).toBe(
      'gpt-5-codex',
    );
  });

  it('a routed session resumes via thread/resume, and the resumed id is the session key', async () => {
    const s = appServer({ reply: 'resumed fine' });
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'session', host: 'codex', key: THREAD_ID },
        prompt: 'p',
        account: 'bot',
      },
      appServerIo(s.factory).io,
    );
    expect(
      s.wrote.some((f) => f.method === 'thread/start'),
      'a routed turn must not mint a fresh thread',
    ).toBe(false);
    const resume = s.wrote.find((f) => f.method === 'thread/resume');
    expect((resume!.params as Frame).threadId).toBe(THREAD_ID);
    expect((resume!.params as Frame).sandbox, 'the typed settings ride the resume too').toBe(
      'read-only',
    );
    expect(res.code).toBe(0);
    expect(res.sessionKey).toBe(THREAD_ID);
  });

  it('a commandExecution approval asks with the EXACT protocol payload and answers accept on the wire', async () => {
    const s = appServer({
      reply: 'created it',
      approvals: [{ kind: 'command', command: "/bin/zsh -lc 'touch approved.txt'", cwd: '/w' }],
    });
    const payloads: string[] = [];
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async (a) => {
          payloads.push(a.payload);
          return 'approve';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(payloads).toHaveLength(1);
    // Protocol fields, verbatim — the command bytes and the cwd, never prose.
    expect(payloads[0]).toContain("/bin/zsh -lc 'touch approved.txt'");
    expect(payloads[0]).toContain('cwd: /w');
    expect(s.decisions).toHaveLength(1);
    // The answer frame, whole: the SERVER's id (its own space), a result,
    // and nothing else — no method, no jsonrpc.
    expect(s.decisions[0]).toEqual({ id: 0, result: { decision: 'accept' } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('created it');
  });

  it('a deny becomes decline, and a decline is NOT an error path (measured: the turn completes)', async () => {
    const s = appServer({
      reply: 'declined, so I did not run it',
      approvals: [{ kind: 'command' }],
    });
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => 'deny',
      },
      appServerIo(s.factory).io,
    );
    expect(s.decisions[0]).toEqual({ id: 0, result: { decision: 'decline' } });
    expect(res.code, 'the model narrates a denial; the turn still completes').toBe(0);
    expect(res.stdout).toBe('declined, so I did not run it');
  });

  it('a fileChange approval JOINS the diff by itemId — the 211-byte params carry none', async () => {
    const s = appServer({
      reply: 'edited',
      approvals: [
        {
          kind: 'fileChange',
          itemId: 'fc_9',
          path: 'src/send.ts',
          diff: '@@ -10 +10 @@\n-cap = 0\n+cap = 16384',
        },
      ],
    });
    const payloads: string[] = [];
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async (a) => {
          payloads.push(a.payload);
          return 'approve';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(payloads).toHaveLength(1);
    // The joined diff — from item/started, keyed by the approval's itemId. A
    // driver that rendered the approval params alone would show NEITHER line.
    expect(payloads[0]).toContain('+cap = 16384');
    expect(payloads[0]).toContain('src/send.ts');
    expect(s.decisions[0]).toEqual({ id: 0, result: { decision: 'accept' } });
    expect(res.code).toBe(0);
  });

  it('a fileChange approval whose item never arrived is DECLINED unasked — an empty change under approval buttons is worse than nothing', async () => {
    const s = appServer({
      reply: 'nothing applied',
      approvals: [{ kind: 'fileChange', emitItem: false }],
    });
    let asked = 0;
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => {
          asked += 1;
          return 'approve';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(
      asked,
      'unshown is unapprovable — the operator is never asked to approve bytes nobody can render',
    ).toBe(0);
    expect(s.decisions[0]).toEqual({ id: 0, result: { decision: 'decline' } });
    expect(res.code, 'fail-closed, not fail-broken: the turn completes').toBe(0);
  });

  it('server→client requests live in their OWN id space — a server id colliding with a client id still surfaces the approval', async () => {
    // The server's counter starts at 0; ours starts at 1. Force the overlap:
    // the server asks with id 1, an id our client has ALREADY used for
    // initialize. A client keying one shared map on the id reads this frame
    // as a stray response and drops it — the first approval never surfaces
    // and the turn parks forever (this test then times out: that hang IS the
    // collision).
    const s = appServer({ reply: 'ok', approvals: [{ kind: 'command', id: 1 }] });
    let asked = 0;
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => {
          asked += 1;
          return 'approve';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(asked).toBe(1);
    expect(s.decisions[0], "the answer rides the SERVER's id, untranslated").toEqual({
      id: 1,
      result: { decision: 'accept' },
    });
    expect(res.code).toBe(0);
  });

  it('an unrecognised cap REFUSES the turn before anything spawns — never dropped', async () => {
    for (const caps of [
      ['-s', 'read-only', '--profile', 'x'], // an exec cap app-server cannot state
      ['-s', 'read-write'], // a sandbox word codex does not have
      ['--ignore-user-config'], // exec's belt — gone on this surface
    ]) {
      const s = appServer({ reply: 'ok' });
      let asked = 0;
      const res = await driverFor('codex').runTurn(
        {
          cfg: appCfg({ caps }),
          route: { kind: 'own' },
          prompt: 'p',
          account: 'bot',
          ask: async () => {
            asked += 1;
            return 'approve';
          },
        },
        appServerIo(s.factory).io,
      );
      expect(res.code, `caps ${JSON.stringify(caps)} must refuse`).toBe(1);
      expect(res.stdout).toContain('does not recognise');
      expect(res.stdout, 'the cap VALUE is named by position, never echoed').not.toContain(
        '--profile',
      );
      expect(res.stdout).not.toContain('read-write');
      expect(s.spawned, 'the refusal must cost no process').toHaveLength(0);
      expect(asked).toBe(0);
      expect(res.refusal).toBeNull();
    }
  });

  it('the --sandbox spellings translate; the LAST sandbox wins, as clap would rule', async () => {
    const s = appServer({ reply: 'ok' });
    await driverFor('codex').runTurn(
      {
        cfg: appCfg({ caps: ['--sandbox', 'read-only', '--sandbox=workspace-write'] }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      appServerIo(s.factory).io,
    );
    expect((s.wrote.find((f) => f.method === 'thread/start')!.params as Frame).sandbox).toBe(
      'workspace-write',
    );
  });

  it('a turn/completed carrying an error maps to a non-zero code, and the error text reaches nobody', async () => {
    const s = appServer({
      reply: 'partial words',
      turnStatus: 'failed',
      turnError: 'stream error: ANTHROPIC_API_KEY=sk-ant-x',
    });
    const res = await driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      appServerIo(s.factory).io,
    );
    expect(res.code).toBe(1);
    // Rule 4: the host's error text is a frame, and it stays one. The
    // model's own words (stdout channel) survive; the diagnostic does not.
    expect(res.stdout).not.toContain('sk-ant');
    expect(res.stderr).toBe('');
  });

  it('a supervisor without the duplex seam gets the honest 127 — nothing ran, nothing hangs', async () => {
    const res = await driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      { spawn: async () => ({ stdout: '', stderr: '', code: 0 }) },
    );
    expect(res.code).toBe(127);
    expect(res.stdout).toBe('');
  });

  it('the ask names its family and the thread key — edit needs the first, respond routes home by the second', async () => {
    const s = appServer({
      reply: 'ok',
      approvals: [{ kind: 'command' }, { kind: 'fileChange', itemId: 'fc_1' }],
    });
    const asks: { kind?: string; sessionKey?: string }[] = [];
    await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async (a) => {
          asks.push({
            ...(a.kind !== undefined ? { kind: a.kind } : {}),
            ...(a.sessionKey !== undefined ? { sessionKey: a.sessionKey } : {}),
          });
          return 'deny';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(asks).toEqual([
      { kind: 'commandExecution', sessionKey: THREAD_ID },
      { kind: 'fileChange', sessionKey: THREAD_ID },
    ]);
  });

  it('the operator-stated approval policy rides the typed settings — and only when stated', async () => {
    const s = appServer({ reply: 'ok' });
    await driverFor('codex').runTurn(
      {
        cfg: appCfg({ codexApprovalPolicy: 'on-request' }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      appServerIo(s.factory).io,
    );
    expect((s.wrote.find((f) => f.method === 'thread/start')!.params as Frame).approvalPolicy).toBe(
      'on-request',
    );
    // Absent stays the measured default — the dialect test above already
    // pins `untrusted` for a config with no policy field.
  });

  it('an unrecognised approval policy refuses the turn before anything spawns — the caps rule, verbatim', async () => {
    const s = appServer({ reply: 'ok' });
    const res = await driverFor('codex').runTurn(
      {
        // A config hand-edited past the enable-time check: the second line
        // of defence is the driver's.
        cfg: appCfg({ codexApprovalPolicy: 'always' as unknown as 'untrusted' }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      appServerIo(s.factory).io,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('codexApprovalPolicy');
    expect(res.stdout, 'the unrecognised value is never echoed').not.toContain('always');
    expect(s.spawned, 'the refusal must cost no process').toHaveLength(0);
  });

  it('the OTHER request families keep the fixed error, per the measured schema — and the turn still completes', async () => {
    // requestUserInput: its schema admits text answers, but the family is
    // EXPERIMENTAL and this client initializes with experimentalApi: false;
    // permissions: its response is a GRANT with no decline member, so a deny
    // would be a guess. Both decisions live as comments on `serveRequest`.
    const s = appServer({
      reply: 'moved on without them',
      approvals: [
        {
          kind: 'request',
          method: 'item/tool/requestUserInput',
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: 'q_1',
            questions: [
              {
                id: 'q1',
                header: 'h',
                question: 'which env?',
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
            autoResolutionMs: null,
          },
        },
        {
          kind: 'request',
          method: 'item/permissions/requestApproval',
          id: 1,
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: 'perm_1',
            environmentId: null,
            startedAtMs: 1,
            cwd: '/w',
            reason: 'needs network',
            permissions: { network: { enabled: true }, fileSystem: null },
          },
        },
      ],
    });
    let asked = 0;
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => {
          asked += 1;
          return 'approve';
        },
      },
      appServerIo(s.factory).io,
    );
    expect(asked, 'neither family may reach the ask seam').toBe(0);
    expect(s.decisions).toEqual([
      { id: 0, error: { code: -32601, message: 'method not supported by this client' } },
      { id: 1, error: { code: -32601, message: 'method not supported by this client' } },
    ]);
    expect(res.code, 'the refused families do not wedge the turn').toBe(0);
    expect(res.stdout).toBe('moved on without them');
  });
});
