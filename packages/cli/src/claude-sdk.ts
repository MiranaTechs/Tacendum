import { createRequire } from 'node:module';
// TYPE-ONLY, the same no-runtime-cycle rule attend-drivers.ts states: this
// module is loaded BY attend-drivers.ts, and nothing here loads it back.
import type { ApprovalAsk, ApprovalDecision } from './attend.js';

/**
 * The claude `sdk` driver half — the
 * OPT-IN mode of the claude driver, in-process over the Claude Agent SDK.
 * The default `subprocess` mode is untouched and lives with the driver
 * (attend-drivers.ts); this file owns everything sdk-specific: the lazy
 * import, the auth gate, the caps translation, the `canUseTool` relay and
 * the error quarantine.
 *
 * TWO HARD CONSTRAINTS GOVERN THIS FILE, both deliberate and neither
 * negotiable here:
 *
 *  1. LICENCE: the SDK is Anthropic's proprietary
 *     package and this package is AGPL-3.0-only, so the SDK lives in
 *     `optionalDependencies` and is NEVER imported statically — the one
 *     `import()` below is lazy, inside the sdk-mode path, with a
 *     NON-LITERAL specifier so no bundler can ever inline the SDK's bytes
 *     into the published artifact (build.mjs externals only
 *     `pkg.dependencies`; a literal specifier here would be bundled and
 *     DISTRIBUTED, which is exactly what this constraint forbids). When the
 *     module is absent the mode REFUSES with the operator's own install
 *     step; absence must never break the default modes.
 *
 *  2. AUTH: the Agent SDK on subscription credentials is the
 *     one configuration Anthropic's terms forbid to a third-party product,
 *     so this mode REQUIRES an operator-supplied API key and fails CLOSED.
 *     The measured signal is `system/init.apiKeySource`; the spike observed
 *     `"none"` — a value OUTSIDE the SDK's own declared union — so the
 *     check is an allowlist of the values that name a key, never a
 *     blocklist of the ones known to mean subscription. `attend enable`
 *     refuses at configure time;
 *     this file refuses again at run time, because the credential that
 *     resolves under launchd is not the one that resolved at enable.
 */

export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * The one SDK version this file's shapes were verified against, on the
 * CODEX_APPSERVER_VERSION precedent: version skew is a PROVEN-LIVE silent
 * hazard on this exact pair (measured in the integration spike — SDK 0.3.228 types call
 * `updatedInput` optional while CLI 2.1.187 requires it, and the mismatch
 * shipped an approval that "succeeded" while the tool never ran). The live
 * gate (gate.claude-sdk.test.ts) compares the INSTALLED package against
 * this constant and refuses to vouch for a pair it has not run.
 */
export const CLAUDE_SDK_VERSION = '0.3.228';

/** The operator's own install step, quoted wherever the absent module is
 * refused — one spelling, so the refusal and `attend enable` can never name
 * two different commands. */
export const CLAUDE_SDK_INSTALL_STEP = `npm install ${CLAUDE_SDK_PACKAGE}@${CLAUDE_SDK_VERSION}`;

/**
 * The `apiKeySource` values that NAME AN OPERATOR-SUPPLIED KEY, from the
 * 0.3.228 declared union — which is `'user' | 'project' | 'org' |
 * 'temporary' | 'oauth'`. Two absences from this list are the whole point:
 *
 *  - `'oauth'` IS in the declared union and is deliberately NOT here: an
 *    OAuth credential is a subscription sign-in, the forbidden
 *    configuration itself, arriving with a type-approved spelling.
 *  - `'none'` is NOT in the declared union and was observed live on every
 *    subscription run — proof the field takes values its own
 *    type does not admit, and why membership in the DECLARED union can
 *    never be the test.
 *
 * Everything outside this list — `'none'`, `'oauth'`, `undefined`, a novel
 * string a future CLI invents — refuses. Fail closed on a capability
 * question.
 */
export const CLAUDE_SDK_KEY_SOURCES = ['user', 'project', 'org', 'temporary'] as const;

export function apiKeySourceIsOperatorKey(v: unknown): boolean {
  return typeof v === 'string' && (CLAUDE_SDK_KEY_SOURCES as readonly string[]).includes(v);
}

/** The SDK's declared PermissionMode union, verbatim from 0.3.228's
 * sdk.d.ts — the vocabulary `translateCapsForSdk` recognises. The const
 * array exists for `attend enable`'s parse and the translator both, the
 * same one-set rule APPROVAL_POLICIES records. (`bypassPermissions` is
 * recognised because the operator may state it, and NOT silently paired
 * with `allowDangerouslySkipPermissions`, which its help says it requires:
 * inventing a second flag the operator never typed would widen their
 * statement, so a profile stating it alone earns the SDK's own refusal.) */
export const SDK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;
export type SdkPermissionMode = (typeof SDK_PERMISSION_MODES)[number];

/**
 * CAPS → TYPED SDK OPTIONS, FAIL-CLOSED — `translateCapsForAppServer`'s
 * shape applied to this surface, for the same reason: `cfg.caps` is a
 * verbatim operator argv array and the SDK takes typed options, so the
 * translation recognises exactly the vocabulary the shipped profiles speak
 * — `--permission-mode <m>` with the SDK's own union (the claude default
 * profile IS `--permission-mode plan`) plus `--model <name>` (this driver's
 * spelling of the model-pin rule: the SDK's unset default was measured at
 * $0.21 for a hello-world, and `--model` is already meaningful in the same
 * slot under the subprocess driver) — and REFUSES the turn on anything
 * else, naming the position and never the value (`attend enable`'s echo
 * rule). Dropping an unrecognised cap would be capability escalation;
 * translating no mode at all passes NO member — the SDK's own default,
 * never an invented value.
 */
export function translateCapsForSdk(
  caps: string[],
): { ok: true; permissionMode?: SdkPermissionMode; model?: string } | { ok: false; at: number } {
  let permissionMode: SdkPermissionMode | undefined;
  let model: string | undefined;
  const modeOf = (word: string): SdkPermissionMode | undefined =>
    (SDK_PERMISSION_MODES as readonly string[]).includes(word)
      ? (word as SdkPermissionMode)
      : undefined;
  for (let i = 0; i < caps.length; i += 1) {
    const word = caps[i] as string;
    if (word === '--permission-mode') {
      const mode = caps[i + 1] !== undefined ? modeOf(caps[i + 1] as string) : undefined;
      if (mode === undefined) return { ok: false, at: i + 1 < caps.length ? i + 1 : i };
      permissionMode = mode; // last one wins, as the CLI's parser would
      i += 1;
      continue;
    }
    if (word.startsWith('--permission-mode=')) {
      const mode = modeOf(word.slice('--permission-mode='.length));
      if (mode === undefined) return { ok: false, at: i };
      permissionMode = mode;
      continue;
    }
    if (word === '--model') {
      const name = caps[i + 1];
      if (name === undefined || name === '' || name.startsWith('-')) {
        return { ok: false, at: i + 1 < caps.length ? i + 1 : i };
      }
      model = name;
      i += 1;
      continue;
    }
    if (word.startsWith('--model=')) {
      const name = word.slice('--model='.length);
      if (name === '' || name.startsWith('-')) return { ok: false, at: i };
      model = name;
      continue;
    }
    return { ok: false, at: i };
  }
  return {
    ok: true,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * THE FIXED SENTENCES — the stderr quarantine rewritten as a discipline.
 * In-process there is no child stderr to bound and discard,
 * so the quarantine cannot be structural the way `realSession` makes it;
 * it becomes a rule instead: a thrown SDK error maps to one of these
 * sentences (or to a bare code), NEVER to its message. `hostExplanation`
 * repeats stdout verbatim to a phone, and attend.ts records what trusting a
 * helpful diagnostic cost last time — a live API key delivered to the
 * operator's phone inside an error string. No SDK error text, no session
 * id, no path out of the SDK may ever reach `stdout` or any string the
 * funnel can see; the session id travels ONLY on the typed `sessionKey`
 * field, where the supervisor tags it (`sessionTag`, s-XXXX) before
 * anything operator-facing exists.
 */
export const CLAUDE_SDK_ABSENT_REFUSAL =
  `this account's sdk driver needs the Claude Agent SDK, which is not installed where ` +
  `this CLI runs. It is Anthropic's own package under Anthropic's own licence, so this ` +
  `AGPL package does not bundle or distribute it — installing it is your step, where ` +
  `the tacendum CLI is installed:\n  ${CLAUDE_SDK_INSTALL_STEP}\n` +
  `Or re-enable with the default subprocess driver. Nothing ran.`;

export const CLAUDE_SDK_SUBSCRIPTION_REFUSAL =
  `the sdk driver requires an operator-supplied Anthropic API key, and this start did ` +
  `not resolve one: the credential resolves to a subscription sign-in, or to a source ` +
  `this build does not recognise as a key (unknown refuses, on purpose — approvals ` +
  `work with claude only under API-key auth). The turn was refused at startup. Set ` +
  `ANTHROPIC_API_KEY where attend runs, or re-enable with the default subprocess driver.`;

/** What the model is told when the operator denies — or the TTL lapses on —
 * an ask. One sentence, ours, closed: a lapse and a deny read the same on
 * this wire because the wire admits no third word, and the supervisor's
 * journal is where the difference is recorded. */
export const CLAUDE_SDK_DENY_MESSAGE = 'The operator did not approve this action.';

/** The refusal an untranslatable profile earns — `capsRefusal`'s twin, and
 * the same channel argument: stdout with a non-zero code is the one
 * sanctioned path to the operator's phone for a failed turn. */
function sdkCapsRefusal(at: number, count: number): ClaudeSdkOutcome {
  return {
    stdout:
      `this account's capability profile holds an argument the sdk driver does not ` +
      `recognise (position ${at + 1} of ${count}; the value is not echoed here). sdk ` +
      `turns take typed options, not claude argv — re-state the caps as ` +
      `--permission-mode ${SDK_PERMISSION_MODES.join('|')} (optionally with ` +
      `--model <name>), or re-enable with the default subprocess driver. Nothing ran.`,
    code: 1,
  };
}

/** The lazy-import seam. Tests inject a loader; the driver's default is the
 * real installed module. `unknown` on purpose: the module is host input
 * until `queryFnOf` vouches for the one member this file calls. */
export type SdkImport = () => Promise<unknown>;

const importInstalledSdk: SdkImport = () => {
  // NON-LITERAL SPECIFIER, LOAD-BEARING (licence constraint): build.mjs bundles
  // this package with esbuild and marks only `pkg.dependencies` external, so
  // a literal `import('@anthropic-ai/…')` would be resolved at build time
  // and INLINED — the AGPL tarball distributing the proprietary SDK. A
  // specifier esbuild cannot see statically stays a runtime import in every
  // bundle. Do not "simplify" this into a literal.
  const specifier: string = CLAUDE_SDK_PACKAGE;
  return import(specifier) as Promise<unknown>;
};

/**
 * Presence check for `attend enable` — RESOLUTION ONLY, no execution: a
 * `require.resolve` walks node_modules and loads nothing, so configure time
 * still never runs SDK code (the lazy-import rule's spirit at the other
 * boundary). Sync because enable is sync.
 */
export function claudeSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve(CLAUDE_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * toolName → ApprovalAsk `kind`, MAPPED HONESTLY (the codex driver's kind
 * mapping is the precedent): `Bash` executes a command; the four writing
 * tools change files; everything else — reads, searches, web, subagents —
 * maps to NO kind, which the supervisor's ask loop reads fail-closed as
 * "not a command, not editable". Claiming `commandExecution` for a tool
 * whose input is not a command would let `edit:` compose a payload the
 * host would never run.
 */
export function sdkToolKind(toolName: string): NonNullable<ApprovalAsk['kind']> | undefined {
  if (toolName === 'Bash') return 'commandExecution';
  if (
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    return 'fileChange';
  }
  return undefined;
}

/**
 * The ask payload: the EXACT protocol fields, never model prose — the bytes
 * the supervisor journals, quotes verbatim to the phone (or refuses
 * one-tap, B-0 C10) and byte-compares at settlement. A Bash command is
 * quoted as itself; every other tool is its name plus its input, JSON as
 * the wire carried it. `undefined` when no honest payload can be assembled
 * — unshown is unapprovable, so the caller declines without asking.
 */
export function sdkApprovalPayload(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'Bash') {
    const command = input.command;
    return typeof command === 'string' && command !== '' ? command : undefined;
  }
  try {
    return `${toolName} ${JSON.stringify(input)}`;
  } catch {
    return undefined;
  }
}

/**
 * Our own result vocabulary for `canUseTool` — `updatedInput` REQUIRED on
 * allow, structurally, where the SDK's own type calls it optional. That
 * optionality is the measured landmine: on CLI
 * 2.1.187 an allow WITHOUT `updatedInput` fails the CLI's Zod schema, the
 * tool never runs, and the model carries on improvising — the approval
 * "succeeded" in the driver while nothing it approved happened. Making the
 * field required here means the compiler, not vigilance, keeps the incident
 * closed.
 */
type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** The one member this file calls on the loaded module, structurally: the
 * module is untrusted input until this returns a function. */
interface SdkQueryHandle extends AsyncIterable<unknown> {
  close?: () => void;
}
type SdkQueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => SdkQueryHandle;

function queryFnOf(mod: unknown): SdkQueryFn | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const q = (mod as { query?: unknown }).query;
  return typeof q === 'function' ? (q as SdkQueryFn) : undefined;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The last assistant message's text blocks, joined — the fallback reply
 * channel when a turn fails before `result/success` (the app-server
 * driver's `lastAgentMessage`, this dialect's spelling). */
function assistantTextOf(m: Record<string, unknown>): string {
  const content = asRecord(m.message)?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push(b.text);
  }
  return parts.join('\n');
}

export interface ClaudeSdkTurn {
  /** The operator's own claude binary (`cfg.bin`) — always passed as
   * `pathToClaudeCodeExecutable`, because the SDK's default resolution
   * fetches its own ~289 MB vendored CLI. */
  bin: string;
  workdir: string;
  prompt: string;
  /** The operator's capability profile, verbatim — translated fail-closed
   * by `translateCapsForSdk` before anything runs. */
  caps: string[];
  /** Resume this session (a routed ledger key, already shape-gated by the
   * driver); absent starts fresh and the id is captured off the init
   * frame. */
  resume?: string;
  /** The supervisor's ask funnel. Absent fails CLOSED: every permission
   * request is denied with the fixed sentence. */
  ask?: (a: ApprovalAsk) => Promise<ApprovalDecision>;
  /** Test seam over the lazy import; absent means the installed module. */
  importSdk?: SdkImport;
}

export interface ClaudeSdkOutcome {
  /** The model's channel — `result/success`'s text, else the last
   * assistant text. Never an SDK error message (the quarantine). */
  stdout: string;
  /** 0 iff the turn reported success. 127 before the init frame — the
   * "could not be launched" code, `runAppServerTurn`'s own convention. */
  code: number;
  /** The session id off the init/result frame — a FRAME field, never
   * stdout, so it can never transit the reply funnel raw. The driver gates
   * it through `hostSessionKey` exactly as a captured codex thread id is. */
  sessionKey?: string;
}

/**
 * ONE TURN, IN-PROCESS: translate caps → lazy-import the SDK →
 * stream one prompt → gate `system/init.apiKeySource` → relay approvals
 * through the supervisor's ask seam → return the result text. NO TIMERS,
 * `runAppServerTurn`'s own rule: the parked approval has the supervisor's
 * TTL clock over it, and a hung SDK hangs the pass the way a hung binary
 * always did rather than this file growing a second, private clock.
 */
export async function runClaudeSdkTurn(req: ClaudeSdkTurn): Promise<ClaudeSdkOutcome> {
  // Capability translation FIRST — a profile this driver cannot state
  // truthfully refuses before the SDK is even loaded, so the refusal costs
  // no import and can never race a live child.
  const caps = translateCapsForSdk(req.caps);
  if (!caps.ok) return sdkCapsRefusal(caps.at, req.caps.length);

  let queryFn: SdkQueryFn | undefined;
  try {
    queryFn = queryFnOf(await (req.importSdk ?? importInstalledSdk)());
  } catch {
    queryFn = undefined;
  }
  if (queryFn === undefined) {
    // The licence rule's refusal arm: the module is absent (or is not the
    // module this file knows how to drive — same answer, same remedy). A
    // TURN refusal, not a crash: the loop must answer the operator and move
    // on, exactly as capsRefusal does.
    return { stdout: CLAUDE_SDK_ABSENT_REFUSAL, code: 1 };
  }

  let sessionKey: string | undefined;
  // THE HANDSHAKE BIT: set only
  // when a recognisable `system/init` frame carried an operator-key
  // `apiKeySource`. Declared here because `canUseTool` must consult it —
  // the gate is not just "refuse a bad init" but "nothing runs until a good
  // init PROVED the credential": a drifted SDK/CLI pair that reshapes or
  // drops the init frame (the file's own PROVEN-LIVE hazard class) must not
  // slide a subscription-credentialed turn through on the strength of the
  // frames that remain.
  let initSeen = false;

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<SdkPermissionResult> => {
    // Fail closed three times over: an UNPROVEN handshake approves nothing
    // (the credential question is still open, so no tool may run and the
    // supervisor is not even asked), no ask funnel means no operator, and a
    // payload this file cannot assemble from the protocol fields is
    // unshown, so unapprovable (the codex relay's `decide` makes the last
    // two calls).
    if (!initSeen) {
      return { behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE };
    }
    const payload = sdkApprovalPayload(toolName, input);
    if (payload === undefined || req.ask === undefined) {
      return { behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE };
    }
    const kind = sdkToolKind(toolName);
    let decision: ApprovalDecision;
    try {
      decision = await req.ask({
        payload,
        ...(kind !== undefined ? { kind } : {}),
        ...(sessionKey !== undefined ? { sessionKey } : {}),
      });
    } catch {
      // A funnel that broke mid-ask approved nothing.
      decision = 'deny';
    }
    if (decision === 'approve') {
      // `updatedInput` IS the approval: CLI 2.1.187's Zod schema requires it, and an allow without
      // it made the tool silently not run while the model kept going. The
      // input goes back byte-identical — the operator approved these bytes
      // and no others.
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: CLAUDE_SDK_DENY_MESSAGE };
  };

  // Streaming input, not a string prompt: `canUseTool` rides the
  // bidirectional control protocol, which only exists in streaming-input
  // mode (spike's API-surface notes; the spike's own approval run used exactly
  // this shape).
  async function* promptOnce(): AsyncGenerator<unknown> {
    yield {
      type: 'user',
      message: { role: 'user', content: req.prompt },
      parent_tool_use_id: null,
      session_id: 'attend',
    };
  }

  const options: Record<string, unknown> = {
    cwd: req.workdir,
    pathToClaudeCodeExecutable: req.bin,
    // CONFIG ISOLATION, this surface's spelling (the axes as the SDK
    // declares them): `settingSources: []` — measured necessary in the
    // spike, where the bare CLI loaded the operator's global hooks and
    // plugins into the stream until it was passed — and `strictMcpConfig`
    // for the MCP axis. Applied on every turn here, not persisted in caps,
    // for CLAUDE_ISOLATION's exact reason: isolation is not a capability.
    settingSources: [],
    strictMcpConfig: true,
    ...(caps.permissionMode !== undefined ? { permissionMode: caps.permissionMode } : {}),
    ...(caps.model !== undefined ? { model: caps.model } : {}),
    ...(req.resume !== undefined ? { resume: req.resume } : {}),
    canUseTool,
  };

  let q: SdkQueryHandle;
  try {
    q = queryFn({ prompt: promptOnce(), options });
  } catch {
    // Nothing launched; 127 already means exactly that.
    return { stdout: '', code: 127 };
  }

  let lastAssistantText = '';
  let resultText: string | undefined;
  let code = 1; // a turn that never reported is not a turn that succeeded
  try {
    for await (const raw of q) {
      const m = asRecord(raw);
      if (m === undefined) continue;
      if (m.type === 'system' && m.subtype === 'init') {
        // THE RUN-TIME AUTH GATE. Checked on the frame, not
        // the environment: this is the credential the CLI actually
        // resolved, which is the only one the rule is about.
        if (!apiKeySourceIsOperatorKey(m.apiKeySource)) {
          return { stdout: CLAUDE_SDK_SUBSCRIPTION_REFUSAL, code: 1 };
        }
        initSeen = true;
        const sid = m.session_id;
        if (typeof sid === 'string' && sid !== '') sessionKey = sid;
        continue;
      }
      if (m.type === 'assistant') {
        const text = assistantTextOf(m);
        if (text !== '') lastAssistantText = text;
        continue;
      }
      if (m.type === 'result') {
        // NO INIT, NO SUCCESS (the gate's absence arm): a result frame on a
        // stream whose handshake was never proven is refused with the same
        // fixed sentence a failing handshake earns — a code-0 here would be
        // the forbidden configuration running to success whenever drift
        // reshapes the init frame. Nothing of the stream leaves: not the
        // result text, not a captured key.
        if (!initSeen) {
          return { stdout: CLAUDE_SDK_SUBSCRIPTION_REFUSAL, code: 1 };
        }
        const r = m.result;
        resultText = m.subtype === 'success' && typeof r === 'string' ? r : undefined;
        code = m.subtype === 'success' && m.is_error !== true ? 0 : 1;
        const sid = m.session_id;
        if (sessionKey === undefined && typeof sid === 'string' && sid !== '') sessionKey = sid;
        break;
      }
    }
  } catch {
    // THE QUARANTINE, applied: whatever the SDK threw, its message is not
    // read, not logged, not returned. The model's own last words (already
    // funnel-sanctioned) plus a code are the whole answer; before the init
    // frame the failure is indistinguishable from "could not be launched" —
    // and an UNPROVEN stream's assistant words stay quarantined with it,
    // because text produced on a credential the handshake never vouched for
    // has no sanctioned channel out.
    return {
      stdout: initSeen ? lastAssistantText : '',
      code: initSeen ? 1 : 127,
      ...(initSeen && sessionKey !== undefined ? { sessionKey } : {}),
    };
  } finally {
    try {
      q.close?.();
    } catch {
      /* a dead handle is already what close wanted */
    }
  }

  // The scan ends in an EXPLICIT recognised-key decision: a
  // stream that ran dry without a recognisable init frame refuses exactly as
  // a failing handshake does — absence and refusal are the same answer on a
  // fail-closed rail.
  if (!initSeen) {
    return { stdout: CLAUDE_SDK_SUBSCRIPTION_REFUSAL, code: 1 };
  }

  return {
    stdout: resultText ?? lastAssistantText,
    code,
    ...(sessionKey !== undefined ? { sessionKey } : {}),
  };
}
