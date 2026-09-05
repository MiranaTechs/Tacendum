import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVAL_POLICIES,
  runAppServerTurn,
  type ApprovalPolicy,
  type SandboxMode,
  type SessionFactory,
  type SteerableTurn,
} from './codex-appserver.js';
import { stateDir } from './config.js';
import { hostSessionKey } from './hooks.js';
import { runClaudeSdkTurn, type SdkImport } from './claude-sdk.js';

// Re-exported so attend.ts can type its `AttendIo.session` seam off the one
// definition the client owns, the same way `turnArgv` is re-exported below.
export type { SessionHandle, SessionFactory } from './codex-appserver.js';
// The steer vocabulary rides the same route: the CLIENT owns what a
// steer attempt can provably do — the measured result table lives on the
// type — and the supervisor speaks it through this one re-export.
export type { SteerResult, SteerableTurn } from './codex-appserver.js';
// The vendored approval-policy vocabulary rides through here for the same
// reason: `attend enable` validates the flag against the ONE set the client
// vouches for, and a set imported from two places is a set that drifts.
export { APPROVAL_POLICIES } from './codex-appserver.js';
export type { ApprovalPolicy } from './codex-appserver.js';
// TYPE-ONLY, so there is no runtime cycle: attend.ts loads this module for
// `driverFor` (and re-exports `turnArgv`); nothing here loads attend.ts back.
import type {
  ApprovalAsk,
  ApprovalDecision,
  AttendConfig,
  AttendHost,
  HostRefusal,
  Route,
} from './attend.js';

/**
 * The HOST DRIVERS — the host-specific half of an attend turn, behind one
 * interface.
 *
 * THE SEAM IS AT THE TURN, NOT THE ARGV. `codex app-server` — the surface
 * OpenAI has publicly committed to — is a long-lived JSON-RPC child with no
 * argv per turn at all, and its approvals arrive as server→client requests
 * DURING a turn, so a `driver.argv()` seam would have to be rebuilt the
 * moment it lands. The driver owns everything from "here is a route and a
 * prompt" to "here is the final text and what the host said about its own
 * store"; the supervisor (attend.ts) owns everything else. Its rails — the
 * trigger predicate, the cursor, the journal, the turn lock, the hourly
 * budget, the single reply funnel, the stderr quarantine — are incident
 * records, not scaffolding, and none of them move here.
 */

/** A turn, as the supervisor knows it. */
export interface TurnRequest {
  cfg: AttendConfig;
  route: Route;
  /** Rides stdin, never argv (attend.ts's argv-injection defence). */
  prompt: string;
  /**
   * The account this turn runs FOR — the anchor for per-account isolation
   * state (the codex driver's `CODEX_HOME` lives under `stateDir(account)`).
   * On the REQUEST, not on `AttendConfig`, and not read from a global: the
   * config is a durable file that already lives under the account's own
   * directory, so persisting the account name INTO it would be a second copy
   * of a fact the path is authoritative for — one rename or restore away
   * from the two disagreeing. The supervisor knows which account's pass it
   * is running; it says so per turn.
   */
  account: string;
  /**
   * Ask the OPERATOR to approve one action mid-turn.
   *
   * The driver only ASKS AND AWAITS: the prompt composition, the approval
   * journal and its write order, the TTL clock, the verb set and the answer
   * channel are all the SUPERVISOR's (attend.ts builds this closure), because
   * the send path, the reply funnel and the turn lock it parks under are. A
   * resolved 'deny' is a decision like any other — a driver must relay it to
   * its host and carry on, never treat it as an error path.
   *
   * OPTIONAL AT BOTH ENDS, deliberately: neither shipped driver can produce
   * an approval today — that measured fact is why the spine ships first,
   * proven against a fake approving driver — so no existing driver or fake
   * changes shape. And it is a single ask-per-action callback, NOT an event
   * emitter: deltas the supervisor has no quota to send are an invitation
   * this seam deliberately declines.
   */
  ask?: (a: ApprovalAsk) => Promise<ApprovalDecision>;
  /**
   * The supervisor's steer intake. ONLY the app-server driver ever
   * surfaces a steer through it, because only that surface has a channel to
   * a RUNNING turn — measured on the other two: `claude -p` closes stdin at
   * spawn, `--resume` of a live session is refused, and `--fork-session`
   * lands in a copy; `codex exec` is the same spawn shape. The supervisor
   * therefore attaches this member only for an app-server profile, and the
   * spawn-seam drivers never receive it (the seam-shape gate pins both
   * halves). A driver that cannot steer simply never calls it: rows that
   * arrive mid-turn queue by cursor exactly as before, and the NEXT pass's
   * prompt marks them (`MID_TURN_MARKER`, attend.ts).
   */
  steering?: (turn: SteerableTurn) => void;
  /**
   * The supervisor's streaming intake — the latest FULL
   * SNAPSHOT of the reply-in-progress, straight from the client's delta
   * accumulator (codex-appserver.ts `AppServerTurnRequest.stream` holds the
   * reset rule and the rule-4 argument). ONLY the app-server driver can
   * produce one, for `steering`'s exact reason: only that surface has a
   * channel to a RUNNING turn — claude's subprocess and sdk modes and
   * `codex exec` all hand back one settled result. The supervisor attaches
   * this member only when its OWN gates passed (the `--stream` attestation,
   * a 1:1 route, a fresh trigger — attend.ts owns all of them), so a driver
   * never decides whether streaming is on; it only relays what its host
   * said. Absent means exactly today: the deltas are dropped at the client.
   */
  stream?: (snapshot: string) => void;
}

/** What one turn produced, in the supervisor's vocabulary. */
export interface TurnResult {
  /** The MODEL's channel. The supervisor funnels this; nothing else. */
  stdout: string;
  /** Kept for classification only — NEVER repeated to the operator. */
  stderr: string;
  code: number;
  /** A recognised STARTUP refusal, after any recovery attempt. */
  refusal: HostRefusal;
  /**
   * What this turn taught us about the own transcript, or undefined if it
   * taught us nothing. Only the driver knows how its host answers that.
   */
  ownExists?: boolean;
  /**
   * The host session this turn actually RAN AS, when the driver learned one
   * on a protocol frame (the app-server driver captures `thread/start`'s
   * `result.thread.id`). A frame, never stdout:
   * it reaches the supervisor through this typed field, so it can never
   * transit the reply funnel and never puts a raw host session id on a
   * phone. The supervisor writes it (gated through `hostSessionKey`, tagged
   * by `sessionTag`) onto the reply's ledger row, which is what makes the
   * NEXT bare message resume the same thread. Absent from both spawn-seam
   * drivers: exec-driven codex still cannot learn its thread id without
   * `--json` polluting the reply channel, and claude's own session is
   * pinned at enable time.
   */
  sessionKey?: string;
}

/** How a driver reaches the world. The spawn seam stays the supervisor's. */
export interface DriverIo {
  spawn: (
    argv: string[],
    cwd: string,
    prompt: string,
    /**
     * Environment the child needs OVER the inherited one — the driver names
     * only what must differ (codex's `CODEX_HOME`); merging it onto the
     * process environment is the seam's job (`realRunTurn`), because a child
     * handed ONLY the delta would lose PATH and HOME and fail in a way that
     * looks like the host's fault. Omitted means "inherit unchanged", which
     * keeps the seam split intact: the driver decides WHAT to spawn, the
     * supervisor's spawner decides HOW.
     */
    env?: Readonly<Record<string, string>>,
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  /**
   * The DUPLEX seam — a long-lived line-framed child, for hosts
   * whose turn is a conversation rather than a spawn. `spawn` above cannot
   * host one and MUST NOT be stretched to: `realRunTurn` closes the child's
   * stdin the moment it spawns and resolves only at `close`, so a JSON-RPC
   * child behind it would deadlock by construction — and every existing
   * test fakes `spawn` in that shape. A separate optional member leaves all
   * of them untouched. No prompt parameter: an app-server prompt rides a
   * `turn/start` frame, never stdin-close. And no event emitter — the
   * refusal ("deltas the supervisor has no quota to send are an
   * invitation") held until streaming NAMED the quota: the delta seam now
   * exists as `TurnRequest.stream`, a snapshot relay whose emission rides
   * the typing lane's budget under the supervisor's one cadence loop —
   * the driver still reads its own frames and hands back one TurnResult.
   */
  session?: SessionFactory;
  /**
   * The claude sdk mode's loader seam. IN `DriverIo` because the SDK
   * module is part of "how a driver reaches the world", exactly like the
   * spawn and duplex seams: tests inject a fake loader here the way they
   * fake `spawn`, and the licence rule's absent-module refusal becomes a
   * scripted `Promise.reject` instead of a hostage node_modules. Absent
   * means the real installed module (claude-sdk.ts owns the lazy import and
   * its non-literal-specifier rule).
   */
  sdkImport?: SdkImport;
  /**
   * THE RESOLVED PARENT ENVIRONMENT, for the one driver that must READ it
   * before it spawns (`geminiDriver`'s run-time credential foreclosure,
   * §3.8). Every other driver only ever WRITES an env delta
   * through `spawn` above, so none of them needs this and none of them
   * takes it.
   *
   * A seam rather than a bare `process.env` read for `sdkImport`'s exact
   * reason: the gate it feeds is a REFUSAL, and a refusal proved only by
   * mutating the test process's own environment is a test that leaks into
   * every file vitest runs in the same worker. Absent means `process.env`,
   * which is what a supervised turn actually resolves.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface HostDriver {
  readonly host: AttendHost;
  /**
   * One turn, including any startup-refusal recovery. A driver may spawn
   * at most TWICE and only when the first spawn proved no model was called —
   * the pass holds exactly one turn token either way.
   */
  runTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult>;
}

/**
 * The per-host argv.
 *
 * THE HOSTS PUT CAPS ON OPPOSITE SIDES OF THE TARGET. That is not a
 * stylistic drift to be tidied into one shape — it is the difference
 * between the argument parsers, and flattening it breaks codex:
 *
 *   codex   [exec, ...caps, ...target]   target = `resume <id>` — a SUBCOMMAND
 *   claude  [-p,   ...target, ...caps]   target = `--resume <id>` — a FLAG
 *   gemini  [      ...target, ...caps]   target = `--resume=<id>` — a FLAG,
 *                                        and NO `-p`: headless is detected
 *                                        from non-TTY stdio (§3.8)
 *
 * `codex exec` is a clap command with subcommands, so every host-level
 * option — `-s/--sandbox`, `-m`, `-c`, `--profile` — belongs to `exec` and
 * must PRECEDE `resume`; everything after the subcommand name is parsed
 * against `resume`'s grammar, which has no `-s`. Caps last gives
 * `codex exec resume <id> -s read-only`, which codex-cli 0.144 rejects with
 * `error: unexpected argument '-s' found` (exit 2) — every routed turn
 * dying on a usage error while the fresh-own-session form (`exec ...caps`,
 * no subcommand) stays perfectly valid. That asymmetry is why the bug hid
 * behind green tests until the operator hit it live.
 * claude is commander: options permute, so `--resume` before or after the
 * caps both reach the session lookup, and the target rides as flags.
 *
 * The caps array is whatever the operator passed to `attend enable --caps`,
 * so this cannot be a special case on `-s` — the SHAPE is the fix.
 *
 * THE PROMPT IS NOT HERE — it rides STDIN (both hosts read it there:
 * `claude -p`, `codex exec`, and `codex exec resume` too, no `-` needed),
 * because argv is the wrong place twice over: a message beginning with `--`
 * would parse as a FLAG to the agent binary, and `ps` shows argv to
 * every user on the box.
 *
 * THE SESSION KEY, HOWEVER, DOES RIDE ARGV (`resume <key>`, `--resume
 * <key>`, `--session-id <key>`), and that is a deliberate, FORCED exception
 * to the argv rule, recorded here so it is never mistaken for an oversight:
 * neither host CLI has a stdin channel for a session id, so the choice is
 * argv or no session continuity at all. What it exposes to a local `ps`
 * reader is an OPAQUE HOST-ISSUED IDENTIFIER — a UUID naming a transcript
 * on this same machine, which anyone who can read that `ps` line can
 * already read off disk. What it does NOT expose is content: no message
 * text, no peer id, no token, no key material. The exception stops at the
 * session id; nothing else agent-supplied may follow it into argv.
 *
 * AND BECAUSE IT DOES RIDE ARGV, THE KEY IS SEPARATED FROM THE FLAGS —
 * structurally, per host, not by trusting the shape check `hostSessionKey`
 * applies at the hook boundary. Both defences exist because either alone is
 * one bad merge from nothing: validation is a call site somebody can delete,
 * and a separator is a token somebody can reorder.
 *
 *   codex   `--`. It is clap's own answer, quoted back by codex when it
 *           refuses a dash-leading positional ("tip: to pass … as a value,
 *           use '-- …'"), and verified here on codex-cli 0.144.0 (2026-08-01,
 *           with bogus flags so nothing could take effect):
 *
 *             $ codex exec -s read-only resume "--zzz-not-a-real-flag" --help
 *             error: unexpected argument '--zzz-not-a-real-flag' found
 *
 *             $ codex exec -s read-only resume -- --zzz-not-a-real-flag \
 *                   --zzz-prompt-slot --zzz-third-positional
 *             error: unexpected argument '--zzz-third-positional' found
 *             Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
 *
 *           The second run stops complaining about the FIRST token and starts
 *           complaining about the THIRD — i.e. `--zzz-not-a-real-flag` bound
 *           as SESSION_ID and `--zzz-prompt-slot` as PROMPT, both as
 *           positionals, and only the surplus one was rejected. (Three
 *           positionals on purpose: it makes clap fail at PARSE time, so the
 *           probe can never start a turn.)
 *
 *   claude  `--resume=<key>`, the INLINE form. commander has no `--` for an
 *           option's VALUE — `--resume -- <key>` would take `--` itself as
 *           the value — so the separator that exists is `=`: everything after
 *           the first `=` is the value and is never re-parsed as a flag.
 *           Verified on claude 2.1.187 (2026-08-01):
 *
 *             $ claude -p --resume --zzz-not-a-real-flag
 *             error: unknown option '--zzz-not-a-real-flag'
 *
 *             $ claude -p --resume=--zzz-not-a-real-flag
 *             Error: --resume requires a valid session ID or session title …
 *             Provided value "--zzz-not-a-real-flag" is not a UUID …
 *
 *           The second reaches claude's OWN session lookup with the text
 *           intact as a value; the first never got past the parser. Same for
 *           `--session-id=`, which answers "Invalid session ID. Must be a
 *           valid UUID." — claude enforces the shape rule from its side too.
 *
 * IT STILL BRANCHES ON `cfg.host`, NOT ON `r.host`, AND THAT IS NOW A
 * GUARANTEE RATHER THAN AN OVERSIGHT. `routeIn` only ever emits
 * `kind: 'session'` when the ledger row's host equals the host attend is
 * configured to drive, and returns `kind: 'unroutable'` otherwise, so for
 * every route that reaches here `r.host === cfg.host` and reading either is
 * the same read. `cfg.host` is the one that stays correct if the invariant is
 * ever broken: it is the host whose BINARY `cfg.bin` actually points at, so a
 * mismatch produces claude's argv for claude's binary — wrong session, honest
 * failure — where `r.host` would produce codex's argv for claude's binary,
 * which is a usage error the operator sees as "the turn failed (exit N)".
 *
 * ONE FUNCTION FOR EVERY HOST, ON PURPOSE, even though each driver below
 * only ever takes its own branch: the caps asymmetry above is a single
 * incident record ABOUT THE SET of shapes, the key-derivation fallbacks are
 * the same third defence for all of them, and the session-argv gate proves
 * every shape through this one signature.
 */
/**
 * THE GEMINI TARGET TOKEN, DERIVED ONCE FROM THE ROUTE — never re-read off a
 * built argv (R25). `turnArgv`'s gemini branch and `geminiDriver` both call
 * this, so the FORM the driver reasons about is the form attend actually
 * emitted. Reading it back off argv[0] instead let an operator caps profile
 * beginning `--resume=…` — which `attend enable` has no rule against — make
 * the driver believe a target was tried, buying a second byte-identical
 * spawn on every 42 and writing `ownSessionStarted` from a caps word.
 *
 * The empty-value guards are `turnArgv`'s, kept here with them: gemini reads
 * an empty `--resume=` as RESUME_LATEST.
 */
function geminiTarget(
  cfg: AttendConfig,
  r: Route,
  over: { ownStarted?: boolean } = {},
): { form: GeminiTargetForm; argv: string[] } {
  const ownStarted = over.ownStarted ?? cfg.ownSessionStarted === true;
  const key =
    r.kind === 'session' ? hostSessionKey(r.key)
    : ownStarted ? hostSessionKey(cfg.ownSession)
    : undefined;
  const create = r.kind === 'session' ? undefined : hostSessionKey(cfg.ownSession);
  if (key !== undefined && key !== '') return { form: 'resume', argv: [`--resume=${key}`] };
  if (create !== undefined && create !== '') {
    return { form: 'create', argv: [`--session-id=${create}`] };
  }
  return { form: 'none', argv: [] };
}

export function turnArgv(
  cfg: AttendConfig,
  r: Route,
  /**
   * Forces the own-session form instead of trusting the persisted flag. The
   * recovery path needs this: when the host has just told us the flag is
   * wrong, re-deriving the argv from that same flag would spawn the identical
   * command and get the identical refusal.
   */
  over: { ownStarted?: boolean } = {},
): string[] {
  const ownStarted = over.ownStarted ?? cfg.ownSessionStarted === true;
  // The third defence, and the one that makes a NUL unreachable at `spawn`:
  // an unusable key yields NO TARGET, so the turn runs in a FRESH session.
  // Never a throw (the loop would retake a token every pass and eat the hour)
  // and never a bare interpolation. `route` already refuses to resolve a
  // malformed ledger key and `attend enable` mints `ownSession` with
  // randomUUID, so neither fallback below is reachable today — which is the
  // point of writing it down rather than asserting it.
  const key =
    r.kind === 'session' ? hostSessionKey(r.key)
    : ownStarted ? hostSessionKey(cfg.ownSession)
    : undefined;
  // Codex own-session continuity is the DRIVER's story — see `codexDriver`.
  if (cfg.host === 'codex') {
    return ['exec', ...cfg.caps, ...(key !== undefined ? ['resume', '--', key] : [])];
  }
  // Only the own route may CREATE a session; a routed key that failed the
  // shape rule must not silently hijack the machine's own transcript.
  const create = r.kind === 'session' ? undefined : hostSessionKey(cfg.ownSession);
  /**
   * GEMINI — claude's SHAPE (target as flags, caps after), gemini's own
   * flag names, and ONE EXTRA GUARD claude does not need
   * (§3.8). Documented against gemini-cli v0.58.0; the binary is NOT
   * installed on this machine (`command -v gemini` empty, 2026-09-04), so
   * M1/M2 in §3.8's measurement table — does yargs accept the inline
   * `--resume=<v>` / `--session-id=<v>` form — are OWED, not run. Nothing
   * here claims otherwise.
   *
   *   own, not started   `--session-id=<own>`   pin at creation
   *   own, started       `--resume=<own>`       continue the same transcript
   *   session (routed)   `--resume=<key>`
   *   own, key unusable  no target              a fresh, unpinned session
   *
   * NO `-p`, and no prompt in argv: gemini auto-detects headless on
   * non-TTY stdio, so the prompt rides stdin under `turnArgv`'s standing
   * argv-injection rule. EXACTLY ONE TARGET TOKEN, ever — `--resume`,
   * `--session-id` and `--session-file` are mutually exclusive at the
   * yargs layer, and two of them is a usage error before any model call.
   * The target is argv[0] BY CONSTRUCTION here, which is what lets
   * `geminiDriver` splice its model pin in after it. The driver does NOT
   * read the form back off this argv: it calls `geminiTarget` with the same
   * inputs, so an operator caps word spelled `--resume=…` can never be
   * mistaken for a target attend actually emitted.
   *
   * NO `--output-format` TOKEN IS EMITTED, and that is deliberate: `text` is
   * the documented headless default for v0.58.0, and an argv token a given
   * install's yargs does not know would fail EVERY turn — so this file's
   * reasoning about a frameless text channel rides that DEFAULT and not a
   * flag we set. Whether v0.58.0 accepts `--output-format text`, and whether
   * text is in fact the headless default, is §3.8 M12 — owed.
   *
   * THE EMPTY-VALUE GUARD IS THE EXTRA ONE. gemini coerces an empty
   * `--resume=` to RESUME_LATEST and would attach the turn to whatever
   * session the operator most recently ran in this project directory — a
   * different conversation, silently. `hostSessionKey` already refuses an
   * empty string, so both `!== ''` tests below are belt-over-boundary; they
   * are written anyway because the failure they prevent is invisible, and
   * `--session-id` gets the same guard rather than only one of the two:
   * guarding one of a pair is how the other one gets forgotten.
   */
  if (cfg.host === 'gemini') {
    return [...geminiTarget(cfg, r, over).argv, ...cfg.caps];
  }
  const target =
    key !== undefined ? [`--resume=${key}`]
    : create !== undefined ? [`--session-id=${create}`]
    : [];
  return ['-p', ...target, ...cfg.caps];
}

/**
 * THE THREE STARTUP REFUSALS, verbatim from the host — not guessed.
 *
 * Read out of the shipped binary (claude 2.1.187, `strings`) and then two of
 * the three RUN against a throwaway session to confirm channel and code:
 *
 *  1. `Error: Session ID <uuid> is already in use.`
 *     — `-p --session-id <uuid>` where `<uuid>.jsonl` already exists. The
 *       guard is a bare `statSync`, so this is file existence, nothing more.
 *       stderr, empty stdout, exit 1. RUN 2026-08-01, exit 1 observed.
 *  2. `No conversation found with session ID: <uuid>`
 *     — `-p --resume <uuid>` where the transcript does not exist.
 *       stderr, empty stdout, exit 1. RUN 2026-08-01, exit 1 observed.
 *  3. `Error: Session <uuid> is currently running as a background agent
 *      (<kind>). Use \`claude agents\` to find and attach to it, or add
 *      --fork-session to branch off a copy.`
 *     — `-p --resume <uuid>` where that session is live. Read from the
 *       binary's headless branch, which does
 *       `process.stderr.write(...)` then exits 1; not run, because
 *       reproducing it needs a SECOND live session and the probe budget was
 *       one. This is the refusal the `--fork-session` fallback was written
 *       for, and the string is why it may now fire for that alone.
 *
 * WHAT MAKES THEM SPECIAL, and the whole reason the fallback is narrowed to
 * them: all three happen BEFORE the model is called. Re-spawning after one
 * costs nothing but a process. Re-spawning after a turn that actually ran —
 * which is what "retry on any non-zero exit" did — bills the operator twice
 * and runs a genuinely broken turn a second time.
 *
 * MATCHED ON STDERR ONLY. stdout is the MODEL's channel, and an agent that
 * printed one of these sentences and exited non-zero would otherwise buy
 * itself a second spawn out of attend's budget — a small lever, but a lever
 * handed to the wrong side of the trust boundary. All three refusals leave
 * stdout empty, so nothing is lost by refusing to look there.
 */
const HOST_REFUSALS: ReadonlyArray<{ kind: Exclude<HostRefusal, null>; re: RegExp }> = [
  { kind: 'session-exists', re: /Session ID \S+ is already in use/ },
  { kind: 'no-conversation', re: /No conversation found with session ID/ },
  { kind: 'live-session', re: /is currently running as a background agent/ },
];

/**
 * CLAUDE's classifier, for claude's stderr alone. It used to run on every
 * host's stderr from shared code, so a codex failure whose stderr happened to
 * quote one of the sentences above would have been classified as claude's
 * refusal and answered with claude's sentence — a failure mode fixed here by
 * construction (`codexDriver` has no refusal table) and pinned by a
 * regression test, because a bug fixed by construction reappears the moment
 * someone adds a refusal table to the wrong driver.
 */
export function classifyRefusal(stderr: string): HostRefusal {
  for (const r of HOST_REFUSALS) if (r.re.test(stderr)) return r.kind;
  return null;
}

/**
 * CLAUDE'S PER-TURN CONFIG ISOLATION. Three flags
 * because isolation is THREE separate axes, measured on claude 2.1.187:
 * `--setting-sources`
 * alone is necessary and NOT sufficient — the bare CLI kept loading the
 * operator's global hooks and plugins into the stream until it was passed,
 * but MCP config is a second axis (`--strict-mcp-config`) and
 * CLAUDE.md/skills/plugins/agents are a third (`--safe-mode`, whose help
 * says it disables customizations while "Auth, model selection, built-in
 * tools, and permissions work normally" — the sentence that makes it safe
 * for the subscription-safe `subprocess` mode). `--setting-sources=` is the
 * inline `=` form: commander has no `--` for an option's value, so `=` is
 * the separator that exists — the same rule `--resume=` in `turnArgv`
 * records, and the empty value after it means "load from no source".
 *
 * `--bare` is FORBIDDEN here, not merely unused. It looks interchangeable
 * with `--safe-mode` and is not: its help says auth becomes strictly
 * `ANTHROPIC_API_KEY`/`apiKeyHelper`, which breaks the subscription-safe
 * `subprocess` mode outright — every install
 * running under the operator's own login would start failing auth on the
 * flag swap, and nothing in the reply would say why.
 *
 * IN THE DRIVER, NOT IN `cfg.caps`, and the placement is load-bearing:
 * `caps` is persisted into attend.json at enable time and no later command
 * rewrites it, so a changed caps DEFAULT would reach only accounts enabled
 * after the change and leave every existing install leaking. Caps are the
 * CAPABILITY profile — the operator's control over what a turn may do;
 * isolation is not a capability, so it is applied to every spawn here,
 * where every install picks it up on upgrade.
 */
const CLAUDE_ISOLATION = ['--safe-mode', '--strict-mcp-config', '--setting-sources='] as const;

/**
 * The sdk turn — the OPT-IN half of the claude driver.
 * In-process over the Agent SDK, approvals through the SAME ask seam the
 * app-server driver rides; claude-sdk.ts owns everything sdk-specific (the
 * lazy import and its licence rule, the caps translation, the
 * `system/init.apiKeySource` auth gate, the canUseTool relay and the error
 * quarantine) — this function owns only the route policy and the frame→
 * supervisor plumbing, mirroring `codexAppServerTurn`.
 */
async function claudeSdkTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult> {
  const { cfg, route } = req;
  // The routed key is gated AGAIN on the way out (`turnArgv`'s
  // third-defence rule, kept even though this key rides a typed option
  // rather than an argv): a key that fails the shape rule resolves to NO
  // resume, a fresh thread and an honest transcript — never a throw, never
  // a bare interpolation.
  const key = route.kind === 'session' ? hostSessionKey(route.key) : undefined;
  const out = await runClaudeSdkTurn({
    bin: cfg.bin,
    workdir: cfg.workdir,
    prompt: req.prompt,
    caps: cfg.caps,
    ...(key !== undefined ? { resume: key } : {}),
    ...(req.ask !== undefined ? { ask: req.ask } : {}),
    ...(io.sdkImport !== undefined ? { importSdk: io.sdkImport } : {}),
  });
  // The captured session id becomes `sessionKey` only through the same gate
  // a ledger key crosses (the app-server driver's rule verbatim): a frame
  // is host input, and this value is about to be written where the router
  // will trust it.
  const own = out.sessionKey !== undefined ? hostSessionKey(out.sessionKey) : undefined;
  return {
    stdout: out.stdout,
    stderr: '',
    code: out.code,
    refusal: null,
    ...(own !== undefined ? { sessionKey: own } : {}),
  };
}

/**
 * claude — TWO modes behind one driver, split by the per-account
 * `cfg.claudeDriver` opt-in exactly as codex splits on `cfg.codexDriver`:
 * the DEFAULT `subprocess` path below (headless `-p`, the operator's own
 * login, `--permission-mode plan`-class caps, NO approvals — subscription-
 * safe by the two-mode rule's own argument, and UNTOUCHED by the sdk mode), and
 * the opt-in `sdk` path (`claudeSdkTurn` above), which requires an
 * operator-supplied API key and refuses subscription credentials at both
 * enable and run time. The subprocess half is the only driver with a
 * refusal table and a recovery: all three HOST_REFUSALS are sentences out
 * of claude's own binary, and both recovery arms below were bought by
 * incidents on this host.
 */
const claudeDriver: HostDriver = {
  host: 'claude',
  async runTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult> {
    const { cfg, route } = req;
    /**
     * THE MODE CHOICE IS OPT-IN PER ACCOUNT and it fails closed — the
     * `codexDriver` dispatch's rule verbatim: absent or
     * 'subprocess' keeps today's spawn path, no existing account migrates
     * by upgrading a binary, and a value this build does not recognise
     * REFUSES the turn rather than guessing either way.
     */
    const choice: string = cfg.claudeDriver ?? 'subprocess';
    if (choice === 'sdk') return claudeSdkTurn(req, io);
    if (choice !== 'subprocess') {
      return {
        stdout:
          `attend.json names a claudeDriver this build does not recognise (the value is ` +
          `not echoed here). Known drivers: subprocess, sdk. Nothing ran.`,
        stderr: '',
        code: 1,
        refusal: null,
      };
    }
    // Isolation rides the ONE spawn funnel, so a recovery spawn cannot miss
    // it: argv built anywhere in this function is isolated at the moment it
    // becomes a command, not at each site that builds one.
    const spawnTurn = (argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
      io.spawn([...argv, ...CLAUDE_ISOLATION], cfg.workdir, req.prompt);

    /**
     * THE ONE RECOVERY, and only for a refusal that means the host did NOTHING.
     *
     * This replaced "retry with --fork-session on any non-zero exit", which
     * bought two full agent runs with one turn token and re-ran genuinely
     * broken turns — including any turn that had already spent real model
     * budget before failing. Each arm below is a startup refusal (see
     * `HOST_REFUSALS`): no model was called, so the second spawn is free, and
     * the pass still holds exactly ONE token because `takeTurnToken` was taken
     * by the supervisor and is not taken again.
     *
     * Only OUR OWN session may be re-created. A routed session that answers
     * "no conversation" is the operator's session, gone from the host's store;
     * inventing a fresh transcript under its id would answer them in a room
     * that only looks like the one they replied to. That one gets the honest
     * failure reply instead.
     */
    const recoveryArgv = (refusal: HostRefusal, tried: string[]): string[] | null => {
      if (refusal === null) return null;
      if (refusal === 'live-session') {
        // The routed session is LIVE right now, so a headless resume refuses.
        // The promise was fork semantics: answer BESIDE the live
        // session, never pretend to join it. Found by the operator replying to
        // a notification from a session that was still open.
        return [...tried, '--fork-session'];
      }
      if (route.kind !== 'own') return null;
      return turnArgv(cfg, route, { ownStarted: refusal === 'session-exists' });
    };

    /**
     * What the pass LEARNED about the own transcript — the thing
     * `ownSessionStarted` is supposed to record.
     *
     *  - "no conversation" is the host saying the transcript is absent: false.
     *  - "already in use" is the host saying it is present: true.
     *  - anything else, from a `--session-id` spawn that reached the host, is
     *    also true, because claude writes the transcript at SESSION START and
     *    the run got past the existence check — proven above, and the reason
     *    this is not conditioned on the turn succeeding.
     *  - 127 means nothing ran, so nothing was learned.
     *
     * The one case this over-reports is a create that died in argument
     * validation AFTER the existence check: the flag goes true with no
     * transcript. That is the CHEAP direction on purpose — the next bare
     * message resumes, hears "no conversation", recovers by creating and puts
     * the flag back. The opposite bias (only ever set it on proof) never
     * converges and pays a doomed spawn on every single message forever.
     */
    let ownExists: boolean | undefined;
    const observeOwn = (code: number, refusal: HostRefusal): void => {
      if (route.kind !== 'own' || code === 127) return;
      ownExists = refusal !== 'no-conversation';
    };

    let argv = turnArgv(cfg, route);
    let turn = await spawnTurn(argv);
    // Only a FAILED turn can be a refusal. A successful turn that happens to
    // quote one of these sentences is an agent talking, not a host refusing.
    let refusal = turn.code === 0 ? null : classifyRefusal(turn.stderr);
    observeOwn(turn.code, refusal);

    // Element-wise, not a joined string: a separator that can appear inside an
    // argv element would make two different commands compare equal. The guard
    // exists because a recovery that reproduces the command that just failed is
    // not a recovery — it is the same refusal, twice.
    const sameArgv = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    const next = recoveryArgv(refusal, argv);
    if (next !== null && !sameArgv(next, argv)) {
      argv = next;
      turn = await spawnTurn(argv);
      refusal = turn.code === 0 ? null : classifyRefusal(turn.stderr);
      observeOwn(turn.code, refusal);
    }

    return {
      stdout: turn.stdout,
      stderr: turn.stderr,
      code: turn.code,
      refusal,
      ...(ownExists === undefined ? {} : { ownExists }),
    };
  },
};

/**
 * CAPS → TYPED THREAD SETTINGS, FAIL-CLOSED. Measured 2026-08-13 on 0.144.0: `codex app-server --help`
 * has NO `-s/--sandbox` and NO `--ignore-user-config`, so `cfg.caps` — a
 * verbatim operator argv array that the design calls *the* capability control —
 * has no argv to ride on this surface and must become `thread/start`
 * settings. The translation recognises exactly the vocabulary the shipped
 * profile speaks — `-s`/`--sandbox` with one of codex's three sandbox words
 * — and REFUSES the turn on anything else, naming the position and never
 * the value (`attend enable`'s echo rule: any later argument can shift into
 * a caps slot, so the allowed set is the whole diagnosis). Dropping an
 * unrecognised cap instead would be capability ESCALATION: a translator
 * that quietly loses `read-only` hands the turn whatever the thread default
 * is, and the operator's control becomes decoration. No sandbox cap at all
 * translates to no `sandbox` member — codex's own default, the same
 * behaviour capless `exec` had — because inventing a value nobody chose is
 * the model-pin trap wearing a sandbox hat.
 */
export function translateCapsForAppServer(
  caps: string[],
): { ok: true; sandbox?: SandboxMode } | { ok: false; at: number } {
  const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  let sandbox: SandboxMode | undefined;
  for (let i = 0; i < caps.length; i += 1) {
    const word = caps[i] as string;
    if (word === '-s' || word === '--sandbox') {
      const mode = caps[i + 1];
      if (mode === undefined || !(MODES as readonly string[]).includes(mode)) {
        return { ok: false, at: i + 1 < caps.length ? i + 1 : i };
      }
      sandbox = mode as SandboxMode; // last one wins, as clap would
      i += 1;
      continue;
    }
    if (word.startsWith('--sandbox=')) {
      const mode = word.slice('--sandbox='.length);
      if (!(MODES as readonly string[]).includes(mode)) return { ok: false, at: i };
      sandbox = mode as SandboxMode;
      continue;
    }
    return { ok: false, at: i };
  }
  return { ok: true, ...(sandbox !== undefined ? { sandbox } : {}) };
}

/**
 * The refusal an untranslatable profile earns — an HONEST reply, not a
 * dropped flag (see `translateCapsForAppServer`). It rides `stdout` with a
 * non-zero code because that is the one sanctioned path to the operator's
 * phone for a failed turn (`hostExplanation` repeats stdout; stderr never
 * leaves the process), and the sentence is ours, closed, value-free.
 */
function capsRefusal(at: number, count: number): TurnResult {
  return {
    stdout:
      `this account's capability profile holds an argument the app-server driver does not ` +
      `recognise (position ${at + 1} of ${count}; the value is not echoed here). app-server ` +
      `turns take typed settings, not exec argv — re-state the caps as ` +
      `-s read-only|workspace-write|danger-full-access, or remove "codexDriver" from ` +
      `attend.json to stay on the exec driver. Nothing ran.`,
    stderr: '',
    code: 1,
    refusal: null,
  };
}

/**
 * The app-server turn — the OPT-IN half of the codex driver. One
 * child per turn: spawn → initialize → thread/start|resume → turn/start →
 * drain to turn/completed → down (codex-appserver.ts owns the wire; this
 * function owns the policy that feeds it). The reply text is
 * `item/completed(agentMessage)` — same channel as ever for the supervisor,
 * new source — and the approvals become `req.ask(...)` calls whose journal,
 * TTL and verb set are all the supervisor's.
 */
async function codexAppServerTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult> {
  const { cfg, route } = req;
  // Capability translation FIRST: a profile this driver cannot state truthfully
  // must refuse before anything spawns, so the refusal costs no process and
  // can never race a live thread.
  const caps = translateCapsForAppServer(cfg.caps);
  if (!caps.ok) return capsRefusal(caps.at, cfg.caps.length);
  // The approval policy is a capability statement and follows the caps
  // rules exactly: a value outside the vendored vocabulary REFUSES
  // the turn — never dropped, never coerced to the default it would widen
  // or narrow silently. `attend enable` validates the same set at write
  // time; this is the second line of defence for a hand-edited attend.json,
  // and the value is not echoed (enable's own echo rule).
  const policy: string | undefined = cfg.codexApprovalPolicy;
  if (policy !== undefined && !(APPROVAL_POLICIES as readonly string[]).includes(policy)) {
    return {
      stdout:
        `attend.json names a codexApprovalPolicy this build does not recognise (the value ` +
        `is not echoed here). Known policies: ${APPROVAL_POLICIES.join(', ')}. Re-state it ` +
        `with: tacendum attend enable --approval-policy <value>. Nothing ran.`,
      stderr: '',
      code: 1,
      refusal: null,
    };
  }
  if (io.session === undefined) {
    // No duplex seam was provided. Nothing can launch, and 127 is the code
    // that already means exactly that (the mkdir arm below documents why a
    // throw would be the wrong shape).
    return { stdout: '', stderr: '', code: 127, refusal: null };
  }
  // The SAME isolated home as the exec path, same rule, same 0700
  // on demand — the auth measurement is step 0's: app-server resolves
  // auth.json from $CODEX_HOME itself, so the one-time `codex login` that
  // `attend enable` asks for covers this driver too.
  const codexHome = codexHomeDir(req.account);
  try {
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  } catch {
    return { stdout: '', stderr: '', code: 127, refusal: null };
  }
  // The routed key is gated AGAIN on the way out (`turnArgv`'s third-defence
  // rule, kept even though this key rides a frame rather than an argv): a
  // key that fails the shape rule resolves to NO resume, a fresh thread and
  // an honest transcript — never a throw, never a bare interpolation.
  const key = route.kind === 'session' ? hostSessionKey(route.key) : undefined;
  const out = await runAppServerTurn({
    session: io.session,
    codexHome,
    workdir: cfg.workdir,
    prompt: req.prompt,
    ...(caps.sandbox !== undefined ? { sandbox: caps.sandbox } : {}),
    ...(cfg.codexModel !== undefined ? { model: cfg.codexModel } : {}),
    ...(policy !== undefined ? { approvalPolicy: policy as ApprovalPolicy } : {}),
    ...(key !== undefined ? { threadId: key } : {}),
    ...(req.ask !== undefined ? { ask: req.ask } : {}),
    // The steer intake, straight through: the client decides WHEN a
    // turn is steerable; the supervisor decides WHAT may steer it. This
    // driver adds no policy of its own in between.
    ...(req.steering !== undefined ? { steering: req.steering } : {}),
    // The streaming intake, the same split: the client accumulates
    // what its host said; the supervisor decides what any phone ever sees.
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
  });
  // The captured thread id becomes `sessionKey` only through the same gate a
  // ledger key crosses: a frame is host input, and this value is about to be
  // written where the router will trust it.
  const own = out.threadId !== undefined ? hostSessionKey(out.threadId) : undefined;
  return {
    stdout: out.stdout,
    stderr: '',
    code: out.code,
    refusal: null,
    ...(own !== undefined ? { sessionKey: own } : {}),
  };
}

/**
 * codex — TWO halves behind one driver, split by the per-account
 * `cfg.codexDriver` opt-in: the DEFAULT `exec` path below (ONE spawn under
 * an ISOLATED `CODEX_HOME` — the comment inside `runTurn` carries
 * the reasoning; no refusal table, no recovery, no own-session observation),
 * and the opt-in app-server path (`codexAppServerTurn` above). HOST_REFUSALS
 * is three sentences read out of CLAUDE's binary — codex's startup refusals
 * have never been measured, and an unmeasured table would be a guessed one,
 * so neither half classifies anything (the cross-host bleed the split
 * closes; attend-drivers.test.ts pins it).
 *
 * OWN-SESSION CONTINUITY IS NOW SPLIT, AND THE SPLIT IS ABOUT WHO FIRES
 * THE NOTIFY HOOK, NOT ABOUT THE HOST. codex cannot pin a session id at
 * CREATION the way `claude --session-id` can, so `turnArgv` emits no target
 * for an own route; codex continuity is the ledger learning a `thread-id`
 * AFTER a turn and the router resuming it on the next message.
 *
 * MEASURED 2026-08-12: codex-cli 0.144.0 emits a stable
 * `thread_id` on `thread.started` in `exec --json`, `exec resume <id>`
 * works, and the notify hook's own payload carries `thread-id` and `turn-id`
 * in `argv[1]` — so the ledger can learn a codex key exactly as it learns
 * claude's.
 *
 * HOOK-FIRED turns ARE captured now: `parseCodexHook` reads the
 * payload's `thread-id` into the hooks ledger, so the operator's own editor
 * sessions — which run in their real home, where config.toml's `notify`
 * still fires — are routable, and a bare message resumes the one live
 * thread. ATTEND-SPAWNED turns split by DRIVER now:
 *
 *  - the app-server path CAPTURES its own session — `thread/start`'s
 *    `result.thread.id` arrives on a frame, rides `TurnResult.sessionKey`
 *    to the supervisor, and lands on the reply's ledger row, so the next
 *    bare message resumes the same thread. The continuity gap is CLOSED for opted-in
 *    accounts, and closed without the leak that blocked it: a frame never
 *    transits the reply funnel, so no raw session id can reach a phone.
 *  - the EXEC path still cannot: it returns raw stdout straight into the
 *    reply funnel, so passing `--json` to read the thread id itself would
 *    hand the operator's phone truncated JSONL carrying a raw host session
 *    id — the exact leak `sessionTag` exists to prevent — and the isolated
 *    CODEX_HOME carries no `notify` key (the KNOWN RETIREMENT in
 *    `runTurn`). Every exec-driven attend-spawned own turn starts a fresh
 *    transcript.
 */
const codexDriver: HostDriver = {
  host: 'codex',
  async runTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult> {
    const { cfg, route } = req;
    /**
     * THE DRIVER CHOICE IS OPT-IN PER ACCOUNT and it fails closed: absent or 'exec' keeps today's exec
     * path — no existing account migrates by upgrading a binary — and only
     * an explicit `"codexDriver": "app-server"` in attend.json selects the
     * duplex driver. A value this build does not recognise REFUSES the turn
     * rather than guessing either way: a config naming a driver we cannot
     * honour is a capability statement we cannot check, and silently
     * running exec under it is the downgrade `caps` exists to prevent.
     */
    const choice: string = cfg.codexDriver ?? 'exec';
    if (choice === 'app-server') return codexAppServerTurn(req, io);
    if (choice !== 'exec') {
      return {
        stdout:
          `attend.json names a codexDriver this build does not recognise (the value is not ` +
          `echoed here). Known drivers: exec, app-server. Nothing ran.`,
        stderr: '',
        code: 1,
        refusal: null,
      };
    }
    /**
     * CODEX'S CONFIG ISOLATION IS `CODEX_HOME`, AND IT IS A HARD CONSTRAINT, not a
     * style choice. One flag
     * cannot do it: `$CODEX_HOME/AGENTS.md`, `$CODEX_HOME/skills/` and the
     * approved-prefix allowlist all load with NO config.toml present, so
     * `--ignore-user-config` alone would have been described in a commit
     * body as isolation while not being it — the measured cost of the bleed
     * is 18,139 input tokens for a turn whose answer was "pong", plus every MCP server in the operator's global `~/.codex`
     * reachable from a turn the phone triggered.
     *
     * The isolated home needs its own ONE-TIME `codex login` (a fresh
     * CODEX_HOME reads "Not logged in" — measured), which `attend enable`
     * asks the operator to run. Symlinking the operator's auth.json was
     * REJECTED: if codex refreshes the token write-temp-then-rename, the
     * rename replaces the symlink with a regular file and the two copies
     * silently diverge — a failure that is silent, delayed and
     * misdiagnosable, the worst shape available for saving one sign-in.
     *
     * 0700 and created on demand (not only at enable): this directory will
     * hold auth.json — a live OAuth token — and a config written before
     * this build, or a wiped state dir, must not leave turns spawning
     * against a home that does not exist.
     */
    const codexHome = codexHomeDir(req.account);
    try {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    } catch {
      // Nothing ran. 127 is the code that already means "this could not be
      // launched" and gets the honest no-execution reply; throwing instead
      // would surface as "a turn was interrupted — it may have partly run",
      // which is false, and would cost the journal dance for a turn that
      // provably never started.
      return { stdout: '', stderr: '', code: 127, refusal: null };
    }
    /**
     * `--ignore-user-config` is belt-over-boundary on top of CODEX_HOME
     * (the isolation rule names both), and it is inserted DIRECTLY AFTER `exec` —
     * argv[0], guaranteed by `turnArgv` — never appended: `codex exec` is a
     * clap command with subcommands, so everything after the `resume`
     * subcommand name is parsed against `resume`'s grammar (the incident
     * record on `turnArgv` has the exit-2 transcript). Position 1 is
     * exec-option space whatever the operator put in caps; searching for
     * the word `resume` instead would misfire on a caps VALUE that happens
     * to spell it.
     *
     * THE MODEL IS PINNED SO ISOLATION CANNOT CHANGE IT SILENTLY. `model`,
     * `model_reasoning_effort` and `service_tier` are config.toml keys, so
     * an isolated home drops all three and replies would come from codex's
     * built-in default at a different price and quality with nothing in the
     * reply saying so — the same trap the claude spike measured from the
     * other side ($0.21 for a hello-world with `model` unset). `attend
     * enable` captures the operator's config.toml `model` into
     * `cfg.codexModel` (attend.ts has the read); when absent, nothing is
     * passed and codex's default is the behaviour the operator already had.
     * Effort and tier follow the model's own defaults — recorded here, not
     * silently dropped.
     *
     * KNOWN RETIREMENT, deliberate (the plan's Ordering rule): `notify` is
     * a config.toml key too, so isolating config stops attend's OWN codex
     * spawns from firing the operator's notify hook — which is exactly the
     * mechanism the bonus path used to give attend-spawned turns
     * own-session continuity via the hooks ledger. That bonus is retired
     * for attend-spawned turns until driver-side capture lands;
     * hook-fired turns from the operator's own editor sessions are
     * untouched (they run in the operator's real home). The visible upside:
     * the operator stops getting the DOUBLE phone message (hook "agent
     * finished" + attend's reply) for every attend turn.
     */
    const [execWord, ...rest] = turnArgv(cfg, route);
    const argv = [
      execWord as string,
      '--ignore-user-config',
      ...(cfg.codexModel !== undefined ? ['-c', `model=${cfg.codexModel}`] : []),
      ...rest,
    ];
    const turn = await io.spawn(argv, cfg.workdir, req.prompt, { CODEX_HOME: codexHome });
    return { stdout: turn.stdout, stderr: turn.stderr, code: turn.code, refusal: null };
  },
};

/**
 * The attend-owned codex home for an account — ONE derivation, exported so
 * `attend enable`'s sign-in instruction and the driver's spawn provably name
 * the same directory. Under `stateDir` (never `clientDir`): it will hold a
 * live OAuth token, which is exactly the kind of thing the state/keys
 * compartment split exists to keep out of "the key directory" backups.
 */
export function codexHomeDir(account: string): string {
  return join(stateDir(account), 'codex-home');
}

/**
 * The attend-owned gemini home for an account — `codexHomeDir`'s shape and
 * its reasoning verbatim: ONE derivation, exported so `attend enable`'s copy
 * and the driver's spawn provably name the same directory, and under
 * `stateDir` because a CLI home is exactly the kind of thing the state/keys
 * compartment split keeps out of "the key directory".
 */
export function geminiHomeDir(account: string): string {
  return join(stateDir(account), 'gemini-home');
}

/**
 * GEMINI'S ENVIRONMENT ISOLATION (§3.8) — a DRIVER-SIDE
 * CONSTANT, not caps, for `CLAUDE_ISOLATION`'s recorded reason: caps are
 * persisted into attend.json at enable time and no later command rewrites
 * them, so a capability set that must move with the code cannot live there.
 *
 *   GEMINI_CLI_HOME             per account, 0700, created on demand — the
 *                               `CODEX_HOME` analogue (added per spawn below,
 *                               since it is the one value that varies)
 *   GEMINI_CLI_TRUST_WORKSPACE  folder trust hard-fails (exit 55) every turn
 *                               under a fresh isolated home. Setting it is a
 *                               CAPABILITY DECISION — it also re-enables
 *                               non-default approval modes — so it is named
 *                               in the enable copy rather than smuggled in
 *   GEMINI_TELEMETRY_ENABLED    off
 *
 * The credential is NOT here: `GEMINI_API_KEY` (or, once §3.8 M7 names them,
 * the Vertex triple) is INHERITED from the environment attend itself runs
 * under. It is never stored in attend.json, never printed, never put in an
 * error (rule 4), and nothing in this module reads its value — only whether
 * one is present.
 *
 * THE HONEST SCOPE OF THE ISOLATION CLAIM: this moves USER-LEVEL config
 * only. The project's own `.gemini/` directory, a project `GEMINI.md` and
 * the `.env` walk from cwd still load — gemini v0.58.0 has no `--safe-mode`
 * / `--setting-sources=` equivalent to close them. A narrower claim stated
 * plainly beats a wider one stated hopefully (`CLAUDE_ISOLATION`'s rule).
 * What `GEMINI_CLI_HOME` actually moves is §3.8 M5, and whether it moves the
 * OAuth cache is M8: both are OWED, not measured — the binary is absent
 * here.
 */
const GEMINI_ISOLATION = {
  GEMINI_CLI_TRUST_WORKSPACE: 'true',
  GEMINI_TELEMETRY_ENABLED: 'false',
} as const;

/**
 * THE CREDENTIAL SHAPES THIS BUILD ACCEPTS FOR GEMINI, in ONE place because
 * two gates read it: `attend enable --host gemini` (fail closed, before
 * anything is saved) and `geminiDriver` (fail closed, before anything is
 * spawned).
 *
 * WHY AT ALL. Google's Gemini CLI FAQ forbids third-party software
 * piggybacking on Gemini CLI's OAuth authentication and names the remedy.
 * The two FRAGMENTS below are what the scope audit read on 2026-09-03 —
 * quoted as fragments, deliberately not paraphrased and deliberately not
 * presented as whole sentences, because a paraphrased terms quotation is an
 * overclaim about somebody else's licence:
 *
 *   "third-party software, tools, or services to … piggyback on Gemini
 *    CLI's OAuth authentication"
 *
 *   "the supported and secure method is to use a Vertex AI or Google AI
 *    Studio API key."
 *
 * A builder who re-reads the FAQ replaces these with the verbatim sentences
 * AND records the URL and the read date; until then they stay fragments.
 *
 * ONLY `GEMINI_API_KEY` FOR NOW. §3.8 M7 — the Vertex env-var triple's exact
 * names — is owed, and accepting a credential shape nobody verified is the
 * one direction that cannot be walked back: refusing too much costs the
 * operator a re-run, accepting too much configures a host we cannot say we
 * gated.
 */
const GEMINI_CREDENTIAL_VARS = ['GEMINI_API_KEY'] as const;

/** Present and non-empty — presence ONLY. Nothing anywhere reads the value. */
export function geminiCredentialPresent(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return GEMINI_CREDENTIAL_VARS.some(v => {
    const value = env[v];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/** The names, for copy that must tell the operator what to set. Never a value. */
export const GEMINI_CREDENTIAL_NAMES: readonly string[] = GEMINI_CREDENTIAL_VARS;

/**
 * WHAT A GEMINI EXIT CODE MEANS — BY CODE, NEVER BY STDERR TEXT
 * (§3.8). gemini's refusal sentences are expected to be
 * buffered away by gemini's default text output (§3.8 M3 asks whether stderr is
 * populated at all), and guessing a host's sentences is exactly how the
 * wrong driver got the wrong refusal table once already — which is why
 * `classifyRefusal` above is claude-only by construction, is NOT reused
 * here, and has a regression test pinning that.
 *
 * Codes are gemini-cli v0.58.0's documented set, read 2026-09-03; none of
 * them has been OBSERVED on this machine, where the binary is absent.
 *
 *   0    ok
 *   41   auth — refuse, do not retry
 *   42   input/session error, NO MODEL CALLED. Ambiguous by itself:
 *        "session not found" and "session id already in use" share it,
 *        which is why R25 disambiguates by argv FORM and not by code
 *   44   sandbox
 *   52   documented, unnamed here — the generic sentence
 *   53   turn limit
 *   54   tool execution
 *   55   untrusted workspace
 *   130  cancelled
 *   127  the binary could not be launched — `attendPass`'s own 127 arm
 *        answers it, so nothing is added here
 */
export type GeminiExit =
  | 'ok'
  | 'auth'
  | 'input'
  | 'sandbox'
  | 'unnamed'
  | 'turn-limit'
  | 'tool'
  | 'untrusted'
  | 'cancelled'
  | 'launch'
  | 'other';

export function classifyGeminiExit(code: number): GeminiExit {
  switch (code) {
    case 0:
      return 'ok';
    case 41:
      return 'auth';
    case 42:
      return 'input';
    case 44:
      return 'sandbox';
    case 52:
      return 'unnamed';
    case 53:
      return 'turn-limit';
    case 54:
      return 'tool';
    case 55:
      return 'untrusted';
    case 130:
      return 'cancelled';
    case 127:
      return 'launch';
    default:
      return 'other';
  }
}

/**
 * OUR OWN sentence for a classified failure — a closed set written here,
 * never the host's text (`hostExplanation`'s rule: stderr never leaves this
 * process, because a failing host writes its environment into it).
 *
 * It rides `stdout` with the host's own non-zero code, on `capsRefusal`'s
 * precedent: that is the one sanctioned path to the operator's phone for a
 * failed turn. And ONLY when the host said nothing itself — a turn that
 * printed its own words keeps them.
 *
 * '' means "add nothing": `ok`, the generic `other`/`unnamed` arms (which
 * `attendPass` already reports as `exit N`), and `launch`, whose 127 arm
 * has a better sentence than this one could write.
 */
export function geminiExitSentence(kind: GeminiExit): string {
  switch (kind) {
    case 'auth':
      return (
        'gemini refused the credentials it resolved. This host runs on an API key only: ' +
        `set ${GEMINI_CREDENTIAL_NAMES.join(' or ')} in the environment attend runs under ` +
        '(no value is printed or stored here). Nothing ran.'
      );
    case 'input':
      // ONLY what always happened. The recovery re-spawn runs on ONE path
      // (own route, a target actually tried), so `geminiDriver` appends the
      // second clause itself — a routed 42, or an own turn whose key was
      // unusable, must not be told about an attempt attend never made.
      return 'gemini refused the session input it was given.';
    case 'sandbox':
      return "gemini's sandbox did not start. Nothing ran.";
    case 'turn-limit':
      return 'gemini stopped at its own turn limit before finishing.';
    case 'tool':
      return 'a tool gemini ran failed, so the turn ended early.';
    case 'untrusted':
      return (
        'gemini refused this workspace as untrusted. attend sets ' +
        'GEMINI_CLI_TRUST_WORKSPACE for its own isolated home; a turn that still ' +
        'refuses is being told otherwise by the environment it runs under.'
      );
    case 'cancelled':
      return 'the gemini turn was cancelled before it finished.';
    default:
      return '';
  }
}

/**
 * The RUN-TIME half of the terms gate, and the word matters: this
 * FORECLOSES a cached sign-in, it does not DETECT one. gemini's default
 * text output has no frame channel, so there is no `apiKeySource` analogue to read
 * the way the claude sdk driver reads one — the driver cannot observe which
 * credential gemini resolved. What it can do is (a) point `GEMINI_CLI_HOME`
 * at a home that contains no `oauth_creds.json`, and (b) refuse to spawn at
 * all when the resolved child environment carries no credential we accept.
 * Whether (a) is structural or merely advisory is §3.8 M8 — owed.
 */
const GEMINI_NO_CREDENTIAL_REFUSAL =
  'this account is configured for the gemini host, which attend runs on an ' +
  `operator-supplied API key only: ${GEMINI_CREDENTIAL_NAMES.join(' or ')} is not set in ` +
  'the environment attend runs under (no value is read or printed here). Google\'s ' +
  'Gemini CLI FAQ names an API key as the supported method for third-party tools, so ' +
  'attend does not fall back to a cached sign-in. Set the key where the supervised unit ' +
  'can see it and re-run. Nothing ran.';

/** Which target form a turn took — see `geminiTarget`, which derives it from
 * the route rather than from any argv a caller could have edited. */
type GeminiTargetForm = 'resume' | 'create' | 'none';

/**
 * A model name this build is willing to put in an argv element: printable
 * ASCII, bounded, not flag-shaped. `operatorGeminiModel` applies the same
 * rule at CAPTURE time, so this is `turnArgv`'s third defence wearing a model
 * pin — attend.json is a durable file a hand edit can reach, and an unusable
 * value must yield NO FLAG (gemini's own default, the behaviour the operator
 * already had) rather than a word the host parser reads as something else.
 */
function geminiModelPin(name: string | undefined): string[] {
  if (name === undefined || name.startsWith('-')) return [];
  return /^[\x21-\x7e]{1,64}$/.test(name) ? ['-m', name] : [];
}

/** Do the operator's own caps already choose the model? Then the captured
 * pin stays out of the argv entirely — one `-m` in the command, deterministic,
 * with no assumption about which of two yargs would keep. */
function capsPinAModel(caps: readonly string[]): boolean {
  return caps.some(
    (w, i) =>
      ((w === '-m' || w === '--model') && caps[i + 1] !== undefined) ||
      w.startsWith('--model=') ||
      w.startsWith('-m='),
  );
}

/**
 * gemini — the SPAWN-SEAM driver (§3.8). It mirrors
 * `codexDriver`'s exec arm and nothing else: one spawn, prompt on stdin, no
 * `ask`, no steer, no stream, no approvals, NO REFUSAL TABLE, and
 * `TurnResult.sessionKey` deliberately absent — nothing on gemini's
 * default text output can capture a session id, and claiming one would
 * route a later reply into a spawn that fails.
 *
 * SHIPPED UNMEASURED, AND SAID SO EVERYWHERE. The gemini binary is not
 * installed on this machine (2026-09-04), so this driver is written against
 * the documented v0.58.0 interface and proved with a fake binary
 * (test/gate.gemini-driver.test.ts). §3.8's measurement table M1..M11 is
 * owed, `attend enable --host gemini` prints the unmeasured-host notice
 * until it is filled, and no line here claims a measurement that was not
 * run.
 */
const geminiDriver: HostDriver = {
  host: 'gemini',
  async runTurn(req: TurnRequest, io: DriverIo): Promise<TurnResult> {
    const { cfg, route } = req;
    // THE FORECLOSURE, BEFORE THE SPAWN (see `GEMINI_NO_CREDENTIAL_REFUSAL`).
    // Presence only, on the resolved child environment — the parent's, since
    // the delta below adds no credential.
    if (!geminiCredentialPresent(io.env ?? process.env)) {
      return { stdout: GEMINI_NO_CREDENTIAL_REFUSAL, stderr: '', code: 1, refusal: null };
    }
    const home = geminiHomeDir(req.account);
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      // `codexDriver`'s arm verbatim: nothing ran, and 127 is the code that
      // already means "this could not be launched".
      return { stdout: '', stderr: '', code: 127, refusal: null };
    }
    const childEnv = { GEMINI_CLI_HOME: home, ...GEMINI_ISOLATION };
    const spawnTurn = (
      argv: string[],
    ): Promise<{ stdout: string; stderr: string; code: number }> =>
      io.spawn(argv, cfg.workdir, req.prompt, childEnv);

    // The model pin, captured from the operator's own `~/.gemini/settings.json`
    // at enable time (`operatorGeminiModel`), for `codexModel`'s reason: an
    // isolated home would otherwise change the model SILENTLY. Skipped when
    // the operator's caps already name one — theirs is the later statement
    // and the more explicit.
    const pin = capsPinAModel(cfg.caps) ? [] : geminiModelPin(cfg.geminiModel);
    const routed = turnArgv(cfg, route);
    // The FORM comes from the route, not from `routed[0]`: `cfg.caps` is
    // operator-supplied and nothing refuses a caps word spelled like a
    // target (see `geminiTarget`).
    const { form } = geminiTarget(cfg, route);
    // The target keeps argv[0] (see `geminiTargetForm`); the pin sits in
    // option space ahead of the operator's caps.
    const argv =
      form === 'none'
        ? [...pin, ...routed]
        : [routed[0] as string, ...pin, ...routed.slice(1)];

    /**
     * WHAT THE PASS LEARNED ABOUT THE OWN TRANSCRIPT — AN INFERENCE, NOT AN
     * OBSERVATION (R25, and the comment says so on purpose).
     *
     * claude's `observeOwn` reads "session not found" and "already in use"
     * apart from STDERR TEXT. gemini has no such channel here — §3.8 M3
     * expects stderr to be buffered away — and exit 42 conflates the two.
     * So the discriminator is the argv FORM this turn took, plus the code:
     *
     *   42 on the `--resume=<own>` form   the key is GONE (a gemini session
     *                                     store prunes at 30 days): false, so
     *                                     the next turn creates
     *   any other code on that form       the transcript answered: true
     *   any code but 127 on the create
     *   form                              true — 42 there means "id already
     *                                     in use" (M4), and any create that
     *                                     reached the host wrote a transcript.
     *                                     claude's cheap direction: over-report
     *                                     a create, and one failing resume
     *                                     corrects it
     *   127                               nothing ran; nothing is written
     *   the no-target form                nothing about the OWN key was tried,
     *                                     so nothing is learned
     *
     * Without this, BOTH routes loop forever at two spawns per turn with a
     * session pin that quietly does nothing — the aged-out resume that never
     * clears the flag, and the create that never sets it. M3/M4 are the
     * measurements that would replace the inference with a reading.
     */
    let ownExists: boolean | undefined;
    const observeOwn = (at: GeminiTargetForm, code: number): void => {
      if (route.kind !== 'own' || code === 127) return;
      if (at === 'resume') ownExists = code !== 42;
      else if (at === 'create') ownExists = true;
    };

    let turn = await spawnTurn(argv);
    observeOwn(form, turn.code);
    let kind = classifyGeminiExit(turn.code);
    /**
     * THE ONE RECOVERY, and only for the code that means the host did
     * NOTHING (`recoveryArgv`'s economics: a startup refusal costs a
     * process, not a turn). Own route only — a routed session that answers
     * "no such session" is the OPERATOR's session, and inventing a fresh
     * transcript under it would answer them in a room that only looks like
     * the one they replied to. And only when a target was actually tried:
     * re-spawning the identical no-target command is not a recovery.
     *
     * The re-spawn carries NO target, so it teaches nothing about the own
     * key — `observeOwn` is deliberately not called again, and the first
     * spawn's inference is what the supervisor persists.
     */
    let recovered = false;
    if (kind === 'input' && route.kind === 'own' && form !== 'none') {
      turn = await spawnTurn([...pin, ...cfg.caps]);
      kind = classifyGeminiExit(turn.code);
      recovered = true;
    }
    const said = turn.stdout.trim() === '' ? geminiExitSentence(kind) : '';
    // The recovery clause is added by the ONE path that ran a recovery, so
    // no other 42 claims an attempt that never happened.
    const sentence =
      recovered && kind === 'input' && said !== '' ?
        `${said} Starting a fresh one also failed.`
      : said;
    return {
      stdout: sentence === '' ? turn.stdout : sentence,
      stderr: turn.stderr,
      code: turn.code,
      refusal: null,
      ...(ownExists === undefined ? {} : { ownExists }),
    };
  },
};

const DRIVERS: Readonly<Record<AttendHost, HostDriver>> = {
  claude: claudeDriver,
  codex: codexDriver,
  gemini: geminiDriver,
};

/** The one lookup. `cfg.host` is refused at `attend enable` unless it names
 * a member of ATTEND_HOSTS, so this is total — an unknown host cannot reach
 * a saved config. */
export function driverFor(host: AttendHost): HostDriver {
  return DRIVERS[host];
}
