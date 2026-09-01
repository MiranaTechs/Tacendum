import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The claude `sdk` mode, proven
 * without the SDK: every test here scripts the lazy-import seam
 * (`DriverIo.sdkImport` / `ClaudeSdkTurn.importSdk`), so the suite is
 * byte-for-byte the same whether the optional dependency is installed or
 * not — which is itself the licence ruling's acceptance condition. The
 * LIVE pair (real SDK, real key, real allow/deny) is
 * gate.claude-sdk.test.ts's job.
 *
 * What is pinned here, each against the ruling that demands it:
 *  - the absent-module refusal names the operator's own install step and is
 *    a TURN refusal, never a crash (licence ruling);
 *  - `apiKeySource` fails CLOSED — 'none', a missing field, 'oauth' and a
 *    novel string all refuse; only the four key-naming members proceed
 *   , at enable AND at init;
 *  - an allow carries `updatedInput` byte-identical;
 *  - deny, lapse and a thrown SDK error all resolve to FIXED sentences —
 *    no SDK text ever reaches stdout (the quarantine as a discipline);
 *  - caps translate fail-closed (translateCapsForAppServer's shape);
 *  - the subprocess default is untouched by every one of the above.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-claude-sdk-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://claude-sdk.test';
process.env.TACENDUM_WS = 'ws://claude-sdk.test';

const {
  CLAUDE_SDK_ABSENT_REFUSAL,
  CLAUDE_SDK_DENY_MESSAGE,
  CLAUDE_SDK_INSTALL_STEP,
  CLAUDE_SDK_SUBSCRIPTION_REFUSAL,
  CLAUDE_SDK_VERSION,
  apiKeySourceIsOperatorKey,
  sdkApprovalPayload,
  sdkToolKind,
  translateCapsForSdk,
} = await import('../src/claude-sdk.js');
const { driverFor } = await import('../src/attend-drivers.js');
const attend = await import('../src/attend.js');
const { cmdAttendEnable, loadAttendConfig } = attend;
const { hostSessionKey } = await import('../src/hooks.js');
const { Reporter } = await import('../src/output.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { saveProfile } = await import('../src/profile.js');
import type { AttendConfig, ApprovalAsk, ApprovalDecision } from '../src/attend.js';
import type { DriverIo } from '../src/attend-drivers.js';

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SID = 'dddddddd-1111-4111-8111-999999999999';
const ROUTED = 'aaaaaaaa-2222-4222-8222-333333333333';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

const sdkCfg = (over: Partial<AttendConfig> = {}): AttendConfig => ({
  host: 'claude',
  bin: '/opt/agent',
  workdir: '/w',
  caps: ['--permission-mode', 'default'],
  claudeDriver: 'sdk',
  ownSession: OWN_SESSION,
  turnsPerHour: 10,
  ...over,
});

type Msg = Record<string, unknown>;
type CanUse = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>;

const INIT = (over: Msg = {}): Msg => ({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'user',
  session_id: SID,
  ...over,
});
const ASSISTANT = (text: string): Msg => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const RESULT = (text: string): Msg => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  session_id: SID,
});

/** A scripted SDK module: `run` yields the message stream and may drive the
 * captured `canUseTool` mid-stream, exactly as the real CLI does. */
function fakeSdk(
  run: (opts: Record<string, unknown>) => AsyncGenerator<unknown>,
): {
  importSdk: () => Promise<unknown>;
  options: () => Record<string, unknown>;
  closes: () => number;
} {
  const seen: Record<string, unknown>[] = [];
  let closed = 0;
  const mod = {
    query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      seen.push(args.options);
      return Object.assign(run(args.options), {
        close: () => {
          closed += 1;
        },
      });
    },
  };
  return {
    importSdk: () => Promise.resolve(mod),
    options: () => {
      expect(seen.length, 'query() must have been called exactly once').toBe(1);
      return seen[0] as Record<string, unknown>;
    },
    closes: () => closed,
  };
}

/** The io every sdk-path test hands the driver: the SPAWN seam must never
 * fire (the sdk mode is in-process by definition), and the import seam is
 * the test's script. */
const sdkIo = (importSdk: () => Promise<unknown>): DriverIo => ({
  spawn: async () => {
    throw new Error('the sdk mode must never use the spawn seam');
  },
  sdkImport: importSdk,
});

// ---------------------------------------------------------------------------

describe('translateCapsForSdk — fail-closed, the app-server translation’s shape', () => {
  it('recognises the shipped vocabulary, flag and inline forms, last one winning', () => {
    expect(translateCapsForSdk(['--permission-mode', 'plan'])).toEqual({
      ok: true,
      permissionMode: 'plan',
    });
    expect(translateCapsForSdk(['--permission-mode=default'])).toEqual({
      ok: true,
      permissionMode: 'default',
    });
    expect(
      translateCapsForSdk(['--permission-mode', 'plan', '--permission-mode', 'default']),
    ).toEqual({ ok: true, permissionMode: 'default' });
    expect(translateCapsForSdk(['--model', 'haiku'])).toEqual({ ok: true, model: 'haiku' });
    expect(
      translateCapsForSdk(['--permission-mode', 'default', '--model=haiku']),
    ).toEqual({ ok: true, permissionMode: 'default', model: 'haiku' });
    expect(translateCapsForSdk([])).toEqual({ ok: true });
  });

  it('refuses an unrecognised cap, a bad mode, and a dangling value, naming the position', () => {
    expect(translateCapsForSdk(['--frobnicate'])).toEqual({ ok: false, at: 0 });
    expect(translateCapsForSdk(['--permission-mode', 'sudo'])).toEqual({ ok: false, at: 1 });
    expect(translateCapsForSdk(['--permission-mode'])).toEqual({ ok: false, at: 0 });
    expect(translateCapsForSdk(['--model', '--oops'])).toEqual({ ok: false, at: 1 });
    expect(translateCapsForSdk(['--model='])).toEqual({ ok: false, at: 0 });
    // Positional refusal, not a scan: a value slot may hold anything.
    expect(translateCapsForSdk(['--permission-mode', 'plan', '-s', 'read-only'])).toEqual({
      ok: false,
      at: 2,
    });
  });

  it('an untranslatable profile refuses the TURN before the SDK is even loaded', async () => {
    let imported = 0;
    const res = await driverFor('claude').runTurn(
      {
        cfg: sdkCfg({ caps: ['--frobnicate', 'secret-value'] }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      sdkIo(() => {
        imported += 1;
        return Promise.reject(new Error('must not be reached'));
      }),
    );
    expect(imported, 'the refusal must cost no import').toBe(0);
    expect(res.code).toBe(1);
    expect(res.refusal).toBeNull();
    expect(res.stdout).toContain('position 1 of 2');
    expect(res.stdout, 'the value is never echoed (enable’s rule)').not.toContain(
      'secret-value',
    );
    expect(res.stdout).toContain('subprocess');
  });
});

// ---------------------------------------------------------------------------

describe('the absent module — the licence ruling’s refusal arm', () => {
  it('an import failure is a clean turn refusal naming the operator’s own install step', async () => {
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(() =>
        Promise.reject(new Error('Cannot find module SECRET-PATH-/Users/nobody/private')),
      ),
    );
    expect(res.code).toBe(1);
    expect(res.refusal).toBeNull();
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe(CLAUDE_SDK_ABSENT_REFUSAL);
    expect(res.stdout).toContain(CLAUDE_SDK_INSTALL_STEP);
    expect(res.stdout).toContain(`@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}`);
    // The quarantine holds here too: the loader's error text names paths.
    expect(res.stdout).not.toContain('SECRET-PATH');
  });

  it('a module without a query function earns the same refusal — not a crash', async () => {
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(() => Promise.resolve({ somethingElse: true })),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toBe(CLAUDE_SDK_ABSENT_REFUSAL);
  });
});

// ---------------------------------------------------------------------------

describe('the run-time auth gate — system/init.apiKeySource, fail closed (the recorded rulings)', () => {
  it('the allowlist is the four key-naming members and nothing else', () => {
    for (const yes of ['user', 'project', 'org', 'temporary']) {
      expect(apiKeySourceIsOperatorKey(yes), yes).toBe(true);
    }
    // 'none' is the measured subscription signal (outside the declared
    // union); 'oauth' is IN the declared union and is still a subscription
    // sign-in; the rest are the tolerate-unknown-fail-closed cases.
    for (const no of ['none', 'oauth', '', 'USER', 'api-key', undefined, null, 42]) {
      expect(apiKeySourceIsOperatorKey(no), String(no)).toBe(false);
    }
  });

  for (const [label, initMsg] of [
    ['"none" (the measured subscription value)', INIT({ apiKeySource: 'none' })],
    ['an init frame with NO apiKeySource field', (() => {
      const m = INIT();
      delete m.apiKeySource;
      return m;
    })()],
    ['"oauth" (declared in the union, still not a key)', INIT({ apiKeySource: 'oauth' })],
    ['a novel string no build has seen', INIT({ apiKeySource: 'shiny-new-source-2027' })],
  ] as const) {
    it(`refuses at init on ${label}, with the fixed sentence and a stopped query`, async () => {
      const sdk = fakeSdk(async function* () {
        yield initMsg;
        yield RESULT('the model must never get this far');
      });
      const res = await driverFor('claude').runTurn(
        { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
        sdkIo(sdk.importSdk),
      );
      expect(res.code).toBe(1);
      expect(res.stdout).toBe(CLAUDE_SDK_SUBSCRIPTION_REFUSAL);
      expect(res.stdout).not.toContain('the model must never get this far');
      expect(sdk.closes(), 'the refused query must be closed').toBeGreaterThanOrEqual(1);
    });
  }

  it('a stream with NO recognisable init frame refuses — never a code-0 success (absence fails CLOSED)', async () => {
    // The drift class the file itself calls PROVEN-LIVE: a skewed SDK/CLI
    // pair reshapes the init frame, so nothing this build recognises as
    // system/init ever arrives — the handshake is never proven, and a
    // subscription-credentialed turn must not run to success on the strength
    // of frames that carry no credential answer at all.
    const sdk = fakeSdk(async function* () {
      yield { type: 'system', subtype: 'boot', apiKeySource: 'none' };
      yield ASSISTANT('working…');
      yield RESULT('done: shipped');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toBe(CLAUDE_SDK_SUBSCRIPTION_REFUSAL);
    expect(res.stdout).not.toContain('done: shipped');
    expect(res.sessionKey, 'no key is captured off an unproven stream').toBeUndefined();
    expect(sdk.closes()).toBeGreaterThanOrEqual(1);
  });

  it('a stream that ENDS with no init and no result refuses with the same fixed sentence', async () => {
    const sdk = fakeSdk(async function* () {
      yield ASSISTANT('and nothing else');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toBe(CLAUDE_SDK_SUBSCRIPTION_REFUSAL);
  });

  it('canUseTool DENIES until an operator-key init is seen — approvals never relay on an unproven handshake', async () => {
    const results: Awaited<ReturnType<CanUse>>[] = [];
    let asked = 0;
    const sdk = fakeSdk(async function* (opts) {
      const canUseTool = opts.canUseTool as CanUse;
      // The CLI asks BEFORE any recognisable init frame — exactly the order
      // a drifted pair can produce. The relay must refuse on its own.
      results.push(await canUseTool('Bash', { command: 'rm -rf /tmp/x' }));
      yield INIT();
      yield RESULT('after');
    });
    const res = await driverFor('claude').runTurn(
      {
        cfg: sdkCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ask: async () => {
          asked += 1;
          return 'approve';
        },
      },
      sdkIo(sdk.importSdk),
    );
    expect(results[0]?.behavior).toBe('deny');
    expect(results[0]?.message).toBe(CLAUDE_SDK_DENY_MESSAGE);
    expect(asked, 'the supervisor is never even asked pre-init').toBe(0);
    // After the init proved a key, the turn itself proceeded normally.
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('after');
  });

  it('a real key source proceeds: the turn completes and the reply is the result text', async () => {
    const sdk = fakeSdk(async function* () {
      yield INIT({ apiKeySource: 'user' });
      yield ASSISTANT('thinking aloud');
      yield RESULT('done: shipped');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('done: shipped');
    // the discipline on this surface: the session id is a typed field,
    // gated, and never in the reply channel.
    expect(res.sessionKey).toBe(SID);
    expect(hostSessionKey(res.sessionKey)).toBe(SID);
    expect(res.stdout).not.toContain(SID);
  });
});

// ---------------------------------------------------------------------------

describe('canUseTool through the supervisor’s ask seam', () => {
  const runWithAsk = async (
    ask: ((a: ApprovalAsk) => Promise<ApprovalDecision>) | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    const results: Awaited<ReturnType<CanUse>>[] = [];
    const sdk = fakeSdk(async function* (opts) {
      yield INIT();
      const canUseTool = opts.canUseTool as CanUse;
      results.push(await canUseTool(toolName, input));
      yield RESULT('after the ask');
    });
    const res = await driverFor('claude').runTurn(
      {
        cfg: sdkCfg(),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
        ...(ask !== undefined ? { ask } : {}),
      },
      sdkIo(sdk.importSdk),
    );
    expect(results.length).toBe(1);
    return { res, result: results[0] as Awaited<ReturnType<CanUse>> };
  };

  it('approve ⇒ {behavior:allow, updatedInput} with the input BYTE-IDENTICAL (the measured landmine)', async () => {
    const input = { command: 'touch approved.txt', description: 'touch' };
    const asks: ApprovalAsk[] = [];
    const { res, result } = await runWithAsk(
      async a => {
        asks.push(a);
        return 'approve';
      },
      'Bash',
      input,
    );
    expect(result.behavior).toBe('allow');
    // the integration spike an earlier finding: CLI 2.1.187's Zod schema REQUIRES updatedInput
    // on allow — without it the approval "succeeds" while the tool silently
    // never runs. Byte-identical means the very object, not a copy the
    // driver might have edited: the operator approved these bytes.
    expect(result.updatedInput).toBe(input);
    expect(JSON.stringify(result.updatedInput)).toBe(JSON.stringify(input));
    // The ask crossed the seam with the honest kind, the exact payload and
    // the session the turn runs as.
    expect(asks.length).toBe(1);
    expect(asks[0]!.payload).toBe('touch approved.txt');
    expect(asks[0]!.kind).toBe('commandExecution');
    expect(asks[0]!.sessionKey).toBe(SID);
    expect(res.code).toBe(0);
  });

  it('deny ⇒ the ONE fixed sentence, never anything else', async () => {
    const { result } = await runWithAsk(async () => 'deny', 'Bash', { command: 'rm -rf /' });
    expect(result).toEqual({ behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE });
  });

  it('a lapse decided on a MOVING clock resolves to the same fixed sentence and the turn completes', async () => {
    // The frozen-clock ruling: the TTL lapse is the supervisor resolving
    // 'deny' at a real later instant, so this test waits on real time — a
    // pinned now() beside advancing timers is how two release-blocking
    // defects shipped under a green suite.
    const before = Date.now();
    const { res, result } = await runWithAsk(
      () => new Promise(resolve => setTimeout(() => resolve('deny'), 30)),
      'Bash',
      { command: 'touch lapsed.txt' },
    );
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
    expect(result).toEqual({ behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE });
    expect(res.code, 'a deny is not an error path — the turn keeps going').toBe(0);
    expect(res.stdout).toBe('after the ask');
  });

  it('no ask funnel ⇒ deny, fixed sentence (absent fails closed)', async () => {
    const { result } = await runWithAsk(undefined, 'Bash', { command: 'touch x' });
    expect(result).toEqual({ behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE });
  });

  it('a THROWING ask funnel ⇒ deny, fixed sentence — never the error’s text', async () => {
    const { result } = await runWithAsk(
      async () => {
        throw new Error('funnel exploded with SECRET-in-message');
      },
      'Bash',
      { command: 'touch x' },
    );
    expect(result).toEqual({ behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE });
  });

  it('a payload that cannot be assembled honestly is denied WITHOUT asking (unshown is unapprovable)', async () => {
    let asked = 0;
    const { result } = await runWithAsk(
      async () => {
        asked += 1;
        return 'approve';
      },
      'Bash',
      {}, // a Bash request with no command string — nothing to quote
    );
    expect(asked).toBe(0);
    expect(result).toEqual({ behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE });
  });

  it('kinds map honestly: Bash is a command, the writers are file changes, the rest are neither', () => {
    expect(sdkToolKind('Bash')).toBe('commandExecution');
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(sdkToolKind(t), t).toBe('fileChange');
    }
    for (const t of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite']) {
      expect(sdkToolKind(t), t).toBeUndefined();
    }
  });

  it('payloads are the exact protocol fields: the Bash command verbatim, other tools as name + JSON input', () => {
    expect(sdkApprovalPayload('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(sdkApprovalPayload('Bash', {})).toBeUndefined();
    expect(sdkApprovalPayload('Write', { file_path: '/w/x.txt', content: 'hi' })).toBe(
      'Write {"file_path":"/w/x.txt","content":"hi"}',
    );
  });
});

// ---------------------------------------------------------------------------

describe('the quarantine as a discipline — no SDK error text ever reaches stdout', () => {
  it('a thrown mid-turn error yields the model’s own last words and a code, nothing of the error', async () => {
    const sdk = fakeSdk(async function* () {
      yield INIT();
      yield ASSISTANT('halfway there');
      throw new Error('ANTHROPIC_API_KEY=sk-ant-SECRET at /Users/nobody/secrets.ts:42');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(1);
    expect(res.stdout, 'stdout is the MODEL’s channel').toBe('halfway there');
    expect(res.stdout).not.toContain('sk-ant');
    expect(res.stdout).not.toContain('secrets.ts');
    expect(res.stderr).toBe('');
  });

  it('a failure BEFORE the init frame reads as could-not-be-launched (127), empty-handed', async () => {
    const sdk = fakeSdk(async function* () {
      throw new Error('spawn ENOENT /opt/agent');
      yield INIT(); // unreachable; keeps the generator shape
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(127);
    expect(res.stdout).toBe('');
  });

  it('assistant text on an UNPROVEN stream never leaves: a pre-init throw is empty-handed even after assistant frames', async () => {
    // Under drift, assistant frames can precede any recognisable init; the
    // credential is unproven for all of them, so none of that text may reach
    // the reply channel — the same fail-closed rail as the result-frame gate.
    const sdk = fakeSdk(async function* () {
      yield ASSISTANT('spoken before any handshake');
      throw new Error('and then it died');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(127);
    expect(res.stdout).toBe('');
  });

  it('a stream that ends without a result is a failed turn, not a silent success', async () => {
    const sdk = fakeSdk(async function* () {
      yield INIT();
      yield ASSISTANT('and then the child died');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('and then the child died');
  });
});

// ---------------------------------------------------------------------------

describe('the driver split — subprocess untouched, sdk routed, unknown refused', () => {
  it('claudeDriver "sdk" never touches the spawn seam and passes the profile through typed', async () => {
    const sdk = fakeSdk(async function* () {
      yield INIT();
      yield RESULT('ok');
    });
    await driverFor('claude').runTurn(
      {
        cfg: sdkCfg({ caps: ['--permission-mode', 'plan', '--model', 'haiku'] }),
        route: { kind: 'session', host: 'claude', key: ROUTED },
        prompt: 'the prompt',
        account: 'bot',
      },
      sdkIo(sdk.importSdk),
    );
    const opts = sdk.options();
    expect(opts.cwd).toBe('/w');
    expect(opts.pathToClaudeCodeExecutable).toBe('/opt/agent');
    expect(opts.permissionMode).toBe('plan');
    expect(opts.model).toBe('haiku');
    expect(opts.resume, 'a routed session resumes').toBe(ROUTED);
    // The isolation axes, this surface's spelling.
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
  });

  it('an own route starts FRESH — no resume member — and the captured id rides the typed field', async () => {
    const sdk = fakeSdk(async function* () {
      yield INIT();
      yield RESULT('ok');
    });
    const res = await driverFor('claude').runTurn(
      { cfg: sdkCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      sdkIo(sdk.importSdk),
    );
    expect('resume' in sdk.options()).toBe(false);
    expect(res.sessionKey).toBe(SID);
  });

  it('an unrecognised claudeDriver refuses the turn without echoing the value', async () => {
    const res = await driverFor('claude').runTurn(
      {
        cfg: sdkCfg({ claudeDriver: 'daemon' as AttendConfig['claudeDriver'] }),
        route: { kind: 'own' },
        prompt: 'p',
        account: 'bot',
      },
      sdkIo(() => Promise.reject(new Error('must not import'))),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Known drivers: subprocess, sdk');
    expect(res.stdout).not.toContain('daemon');
  });

  it('claudeDriver absent stays the subprocess path, byte-for-byte', async () => {
    const calls: string[][] = [];
    const io: DriverIo = {
      spawn: async argv => {
        calls.push(argv);
        return { stdout: 'done', stderr: '', code: 0 };
      },
      sdkImport: () => Promise.reject(new Error('the subprocess path must not import the SDK')),
    };
    const cfg = sdkCfg({ caps: ['--permission-mode', 'plan'] });
    delete cfg.claudeDriver;
    const res = await driverFor('claude').runTurn(
      { cfg, route: { kind: 'own' }, prompt: 'p', account: 'bot' },
      io,
    );
    expect(res.stdout).toBe('done');
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      '-p',
      `--session-id=${OWN_SESSION}`,
      '--permission-mode',
      'plan',
      '--safe-mode',
      '--strict-mcp-config',
      '--setting-sources=',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('attend enable — the configure-time half of the two refusals', () => {
  const capture = () => {
    const out: { record: Record<string, unknown>; human: string }[] = [];
    const report = new Reporter({ json: true, plain: true });
    report.emit = (record: Record<string, unknown>, human: string) => {
      out.push({ record, human });
    };
    return { report, out };
  };
  const sdkOpts = { host: 'claude', driver: 'sdk', bin: process.execPath, workdir: '/w' };
  const okIo = { sdkPresent: () => true, env: { ANTHROPIC_API_KEY: 'sk-test-key' } };

  beforeEach(() => {
    rmSync(join(home, 'bot'), { recursive: true, force: true });
    rmSync(join(home, 'state'), { recursive: true, force: true });
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
  });

  it('writes claudeDriver "sdk" when the module and a key are both present, and says the honest sentence', () => {
    const { report, out } = capture();
    cmdAttendEnable('bot', sdkOpts, report, okIo);
    const cfg = loadAttendConfig('bot');
    expect(cfg?.claudeDriver).toBe('sdk');
    expect(cfg?.codexDriver).toBeUndefined();
    expect(out.length).toBe(1);
    expect(out[0]!.record.driver).toBe('sdk');
    const human = out[0]!.human;
    expect(human).toContain('sdk driver');
    expect(human).toContain('operator-supplied API key');
    // the recorded rulings product sentence, un-rounded.
    expect(human).toContain(
      'Approvals work with codex on any sign-in, and with claude only when you supply an API key',
    );
  });

  it('REFUSES when the SDK module is absent, naming the operator’s own install step; nothing is saved', () => {
    const { report } = capture();
    expect(() =>
      cmdAttendEnable('bot', sdkOpts, report, { ...okIo, sdkPresent: () => false }),
    ).toThrowError(CLAUDE_SDK_INSTALL_STEP.slice(0, 20));
    expect(loadAttendConfig('bot')).toBeNull();
  });

  it('REFUSES when no ANTHROPIC_API_KEY is set — the subscription refusal at configure time; nothing is saved', () => {
    const { report } = capture();
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      expect(() => cmdAttendEnable('bot', sdkOpts, report, { ...okIo, env })).toThrowError(
        /operator-supplied Anthropic API key/,
      );
    }
    expect(loadAttendConfig('bot')).toBeNull();
  });

  it('each host owns its driver vocabulary — the other host’s words are usage errors', () => {
    const { report } = capture();
    for (const [host, driver] of [
      ['codex', 'sdk'],
      ['codex', 'subprocess'],
      ['claude', 'exec'],
      ['claude', 'app-server'],
      ['claude', 'daemon'],
    ] as const) {
      let code: number | undefined;
      try {
        cmdAttendEnable('bot', { host, driver, bin: process.execPath, workdir: '/w' }, report, okIo);
      } catch (e) {
        code = e instanceof CliError ? e.exitCode : -1;
      }
      expect(code, `${host} --driver ${driver}`).toBe(EXIT.USAGE);
    }
    expect(loadAttendConfig('bot')).toBeNull();
  });

  it('"subprocess" may be stated explicitly, needs no key, and is read back', () => {
    const { report, out } = capture();
    cmdAttendEnable(
      'bot',
      { host: 'claude', driver: 'subprocess', bin: process.execPath, workdir: '/w' },
      report,
      { sdkPresent: () => false, env: {} }, // neither requirement applies
    );
    expect(loadAttendConfig('bot')?.claudeDriver).toBe('subprocess');
    expect(out[0]!.human).toContain('subprocess driver');
  });

  it('--approvals now binds to the claude sdk profile too, and still refuses everything surface-less', () => {
    const { report } = capture();
    cmdAttendEnable('bot', { ...sdkOpts, approvalsMinAppBuild: 7 }, report, okIo);
    expect(loadAttendConfig('bot')?.approvalsMinAppBuild).toBe(7);
    for (const opts of [
      { host: 'claude', approvalsMinAppBuild: 7 }, // subprocess: no surface
      { host: 'claude', driver: 'subprocess', approvalsMinAppBuild: 7 },
      { host: 'codex', approvalsMinAppBuild: 7 }, // exec: no surface
    ]) {
      expect(() =>
        cmdAttendEnable('bot', { ...opts, bin: process.execPath, workdir: '/w' }, report, okIo),
      ).toThrowError(/approval surface/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the forbidden phrase', () => {
  it('appears in no shipped source touched by this phase', async () => {
    const { readFileSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    // Assembled from parts so this file cannot match itself.
    const forbidden = ['runs on your existing', 'subscription'].join(' ');
    const srcDir = j(__dirname, '..', 'src');
    for (const f of ['claude-sdk.ts', 'attend.ts', 'attend-drivers.ts', 'main.ts']) {
      expect(
        readFileSync(j(srcDir, f), 'utf8').toLowerCase().includes(forbidden),
        `${f} must never claim the forbidden sentence`,
      ).toBe(false);
    }
  });
});
