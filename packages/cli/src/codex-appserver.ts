/**
 * The `codex app-server` JSON-RPC client — OUR OWN,
 * deliberately small, and written in THIS version's dialect. No npm SDK:
 * `@openai/codex-sdk` wraps `codex exec`, which has no
 * approval surface at all, and an off-the-shelf JSON-RPC 2.0 library would
 * reject or mis-emit the frames this server actually speaks.
 *
 * THE DIALECT, measured on codex-cli 0.144.0 — three quirks, each of which fails
 * SILENTLY if assumed away:
 *
 *  1. Framing is newline-delimited bare `{id,method,params}` JSON with NO
 *     `"jsonrpc":"2.0"` member — zero occurrences of the string `jsonrpc`
 *     in any capture, either direction. This client emits exactly the
 *     members the captures show and nothing else.
 *  2. Server→client REQUESTS (the approvals) use their OWN id counter,
 *     starting at 0, independent of ours. The two spaces overlap by
 *     construction, so a frame is classified by SHAPE — `method` present
 *     with an `id` is THEIR request; `id` without `method` is a response to
 *     OURS — never by id lookup alone. A client that keys one shared map on
 *     the id drops the first approval on the floor: the turn parks forever
 *     against a request nobody surfaced.
 *  3. `initialize` returns `{userAgent, codexHome, platformFamily,
 *     platformOs}` and NOTHING else — no capability list. Feature detection
 *     is therefore the version-pinned generated schema (the vendored types
 *     below), never the handshake.
 *
 * WHAT THIS FILE OWNS: the wire, one turn's lifecycle over it, and the
 * approval relay. Capability policy (which caps become which thread
 * settings, and when to refuse) is the DRIVER's (attend-drivers.ts); the
 * approval journal, the TTL clock, the verb set and the reply funnel are the
 * SUPERVISOR's (attend.ts) — this client only asks and awaits.
 *
 * RULE 4 RIDES THE WHOLE FILE: no frame, no server-supplied text and no
 * error message is ever logged, thrown onward, or copied into a result
 * field the supervisor would repeat. The one channel that reaches the
 * operator is the model's own agentMessage text, which the success path
 * already sends through the same funnel.
 */

// ---------------------------------------------------------------------------
// VENDORED PROTOCOL TYPES — keyed to codex-cli 0.144.0. Regenerate on every
// binary bump and re-run the live gate (gate.codex-appserver.test.ts pins the
// installed version to this constant, so a bump FAILS the suite until someone
// does):
//
//   codex app-server generate-ts -o <dir>
//
// The driver path is STABLE-ONLY, so the types below are copied from the STABLE generation.
// They are the fields this client constructs or reads, verbatim from the
// generated files named in each comment; fields we neither send nor read are
// omitted — the generated bundle is 2.4 MB across 89 files, and vendoring
// text nothing consumes is how a wrong copy hides.
// ---------------------------------------------------------------------------

/** The one version every type below is true of. The live gate compares the
 * installed `codex --version` against this and fails on mismatch — version
 * skew is proven-live and silent, so the canary must be
 * a test, not a comment. */
export const CODEX_APPSERVER_VERSION = '0.144.0';

/** v2/SandboxMode.ts, verbatim. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * v2/AskForApproval.ts — the STRING members, verbatim. The generated union is
 *
 *   "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean,
 *   rules: boolean, skill_approval: boolean, request_permissions: boolean,
 *   mcp_elicitations: boolean } } | "never"
 *
 * so three of its four members are words a config field can state and read
 * back verbatim, and the fourth is a structured object no flag can state
 * honestly — a CLI that invented a spelling for it would be vouching for a
 * shape the operator never typed. The surfaced set is therefore exactly the
 * strings; `granular` waits for a surface that can carry an object. The
 * const array exists because two callers must refuse an unlisted value at
 * their own boundary (`attend enable`'s parse, the driver's config check)
 * and a set spelled twice is a set that drifts.
 */
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** From v2/CommandExecutionApprovalDecision.ts / v2/FileChangeApprovalDecision.ts:
 * the two literal members this client ever sends. The full command enum,
 * verbatim from the 0.144.0 generation:
 *
 *   "accept" | "acceptForSession"
 *   | { "acceptWithExecpolicyAmendment": { execpolicy_amendment: Array<string> } }
 *   | { "applyNetworkPolicyAmendment": { network_policy_amendment: … } }
 *   | "decline" | "cancel"
 *
 * and the measured server accepts more than `availableDecisions` lists —
 * `decline` was accepted while unlisted (capture-deny). NOTE FOR THE `edit`
 * VERB (measured before it was built): `acceptWithExecpolicyAmendment`
 * is NOT "run this other command instead" — the amendment is an execpolicy
 * WIDENING ("allow similar commands without prompting", the request params'
 * own doc on `proposedExecpolicyAmendment`), applied on top of accepting the
 * command the server proposed. No decision in the enum substitutes a
 * different command, so an operator's edited command cannot ride any answer
 * frame; the supervisor's `edit:` verb DENIES instead and says so
 * (attend.ts's ask loop holds that sentence). A client that only ever
 * answers `accept` or `decline` cannot widen a grant by accident. */
export type ApprovalWireDecision = 'accept' | 'decline';

/** v2/FileUpdateChange.ts, verbatim: the DIFF lives here, on the
 * `item/started` fileChange item — never on the approval request params.
 * (`kind` is v2/PatchChangeKind.ts, a tagged union this client renders by
 * its `type` word alone.) */
export interface FileUpdateChange {
  path: string;
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
  diff: string;
}

/**
 * One duplex child, line-framed. This is the transport seam the driver's
 * `DriverIo.session` provides: `write` takes ONE frame's JSON text (no
 * trailing newline — the session appends it), `onLine` delivers one complete
 * line per call, `kill` must eventually produce `onExit` — the turn runner
 * resolves only after the child is provably gone, because a live codex
 * leaked past a test run hangs the suite and a live codex leaked past a
 * pass is a model-billed process nobody supervises.
 */
export interface SessionHandle {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** How the driver spawns one: same argv/cwd/env vocabulary as
 * `DriverIo.spawn`, minus the prompt — an app-server prompt rides a
 * `turn/start` frame, never stdin-close. */
export type SessionFactory = (
  argv: string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
) => SessionHandle;

/**
 * What ONE steer attempt provably did, measured on 0.144.0
 * (live capture):
 *
 *   delivered      the server answered `{turnId}` — the steered text rode in
 *                  as a userMessage item and the turn continues under it.
 *   not-delivered  the server answered an ERROR frame, or the client refused
 *                  to send at all (no live turn, an approval ask parked, the
 *                  turn already settled). The measured mismatch and
 *                  no-active-turn errors are both -32600 with ZERO items
 *                  injected, so an error frame is the server saying nothing
 *                  was delivered — and AS A HARD RULE every
 *                  unrecognised steer error takes this same arm, never a
 *                  throw: the row re-queues instead of wedging the pass.
 *   failed         no answer at all — the child died with the request in
 *                  flight. MAYBE-delivered: the supervisor must treat the
 *                  message as consumed and say so, never re-run it
 *                  (`readJournal`'s at-most-once argument, one hop out).
 *
 * The promise NEVER rejects: a rejection out of this call is a crash, and
 * the supervisor's journal-first discipline is what answers for crashes.
 */
export type SteerResult = 'delivered' | 'not-delivered' | 'failed';

/**
 * The live turn's steer surface, handed to the supervisor via
 * `AppServerTurnRequest.steering` once — and only once — a turn is ACTIVE
 * (the live turn id captured off `turn/start`'s result / `turn/started`).
 * `sessionKey` is the thread id the turn runs as, the same frame-borne value
 * `TurnResult.sessionKey` carries at turn end; the supervisor gates it
 * through `hostSessionKey` before anything trusts it, exactly as it gates
 * the captured key.
 */
export interface SteerableTurn {
  sessionKey?: string;
  steer(text: string): Promise<SteerResult>;
}

/** The argv under `cfg.bin`. `--strict-config` is the canary; the exec
 * path's `--ignore-user-config` belt cannot be here (app-server has neither that
 * flag nor `-s` — measured 2026-08-13 on 0.144.0's `--help`): the isolated
 * CODEX_HOME is the boundary, and strict-config makes a config.toml this
 * binary cannot fully parse a loud startup error instead of a silent
 * partial read. In the attend-owned home that file normally does not exist,
 * so the flag is inert until the day it matters. */
export const APP_SERVER_ARGV = ['app-server', '--strict-config'] as const;

export interface AppServerTurnRequest {
  session: SessionFactory;
  /** The attend-owned isolated home (the isolation rule; the driver derives
   * it). Step-0 measurement 2026-08-13: app-server resolves auth from
   * $CODEX_HOME itself — a fresh home answers `getAuthStatus` with
   * `authMethod: null`, the same home with `auth.json` answers `"chatgpt"`,
   * and `initialize` echoes the custom path back as `codexHome`. */
  codexHome: string;
  workdir: string;
  prompt: string;
  /** Typed thread settings — the caps translation's output. Absent means
   * ABSENT on the wire: codex's own default, never an invented value. */
  sandbox?: SandboxMode;
  model?: string;
  /** The operator-stated approval policy (the caps surface). Absent means
   * `untrusted` — the policy the whole approval round-trip was measured
   * under, kept as the default so no existing account's asking behaviour
   * changes by upgrading. Validation is the DRIVER's (fail closed, like an
   * unrecognised cap); this client states what it is handed. */
  approvalPolicy?: ApprovalPolicy;
  /** Resume this thread (a routed session key); absent starts fresh. */
  threadId?: string;
  /** The supervisor's ask funnel (attend.ts). Absent fails CLOSED:
   * every approval is answered `decline`. `kind` names which request family
   * asked — the supervisor's `edit:` verb is only honest for a command
   * (a diff cannot be edited from a phone) and must know which it holds.
   * `sessionKey` is the thread id the asking turn runs as, when the client
   * already knows one: the supervisor gates it (`hostSessionKey`) and puts
   * it on the card's ledger row, which is what lets a `respond:` answer
   * route back to the very thread that asked. */
  ask?: (a: {
    payload: string;
    kind: 'commandExecution' | 'fileChange';
    sessionKey?: string;
  }) => Promise<'approve' | 'deny'>;
  /**
   * The supervisor's steer intake. Called AT MOST ONCE, and only
   * when a turn is active — the live turn id in hand — because
   * `turn/steer`'s `expectedTurnId` is a real precondition (measured:
   * mismatch is -32600 with nothing delivered). The handed `steer` refuses
   * (`not-delivered`, nothing on the wire) whenever an approval ask is
   * outstanding — steer-during-park is UNMEASURED and therefore forbidden,
   * client-side as well as by the supervisor's predicate — or the turn is
   * no longer live. Absent means no steering: the turn runs exactly as
   * before, which is what every prior caller gets.
   */
  steering?: (turn: SteerableTurn) => void;
  /**
   * The supervisor's streaming intake. Called with the FULL
   * ACCUMULATED SNAPSHOT of the current agentMessage after each
   * `item/agentMessage/delta` frame (measured shape on 0.144.0:
   * `{threadId, turnId, itemId, delta}` — the captured transcripts
   * codex-capture-turn.jsonl:44) — frames this client used to drop on the
   * floor. A NEW agentMessage itemId RESETS the snapshot, so what this
   * callback last carried always tracks the item `lastAgentMessage` will be
   * set from: the LAST agentMessage is the final reply (the
   * `AppServerTurnOutcome.stdout` rule), and the commentary phases that
   * precede it each reset rather than concatenate.
   *
   * A SNAPSHOT, NEVER A DELTA, and no cadence of its own: this client hands
   * the supervisor the latest state and nothing else — WHEN anything leaves
   * for a phone, over WHAT channel and under WHOSE budget are the
   * supervisor's cadence loop's decisions (the same split `ask` and
   * `steering` keep). Rule 4 holds: the snapshot is the model's OWN channel
   * (agentMessage text — the same bytes `stdout` carries at turn end), the
   * one channel the supervisor's funnel already sanctions; no other frame
   * text rides this callback. Absent means today's behaviour exactly: the
   * deltas are dropped as they always were.
   */
  stream?: (snapshot: string) => void;
}

export interface AppServerTurnOutcome {
  /** The model's channel: the LAST completed agentMessage's text. Multiple
   * agentMessages precede it in a real turn (commentary phases — measured,
   * capture-approve carries two before the answer); the last is what the
   * notify hook itself calls `last-assistant-message`, so it is the same
   * answer the exec driver's stdout carried, from a frame instead. */
  stdout: string;
  /** 0 iff the turn COMPLETED. A decline is NOT an error path — measured:
   * `{decision:"decline"}` ends in `turn/completed` with status `completed`
   * and `error: null`, the model narrating the refusal (capture-deny). */
  code: number;
  /** `thread/start`'s `result.thread.id` — the own-session key, learned on
   * a FRAME. It never touches stdout, so it can never reach the reply
   * funnel or put a raw host session id on a phone. */
  threadId?: string;
}

/** A frame, before any shape is trusted. */
type Frame = Record<string, unknown>;

const asFrame = (v: unknown): Frame | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Frame) : undefined;

/** `result.thread.id`, defensively: a frame is host input, not a schema
 * guarantee, and the id becomes a ledger key — the caller re-applies
 * `hostSessionKey` before anything durable sees it. */
function readThreadId(result: unknown): string | undefined {
  const thread = asFrame(asFrame(result)?.thread);
  const id = thread?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** `result.turn.id` / `params.turn.id` — the LIVE turn id, `turn/steer`'s
 * `expectedTurnId` precondition. Same defensive read as `readThreadId`, and
 * the id never leaves this module: it rides steer frames only, never a
 * result field the supervisor could repeat. */
function readTurnId(container: unknown): string | undefined {
  const turn = asFrame(asFrame(container)?.turn);
  const id = turn?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Our own rejection for the request helper. It carries WHICH of our calls
 * failed and nothing the server said: an app-server error frame is host
 * output, and the incident record (attend.ts `hostExplanation`) is
 * about exactly the moment a helpful diagnostic gets repeated onward. The
 * quarantine matters doubly for `turn/steer` — the measured mismatch error
 * EMBEDS the raw live turn id in its message text, so the message is never
 * read, copied, or thrown onward.
 *
 * `answered` records the ONE bit the steer arm needs and the no-leak rule permits:
 * true means an error FRAME arrived (the server answered — for a steer,
 * provably undelivered, measured); false means the child died with the
 * request in flight (no answer — for a steer, MAYBE delivered). A boolean
 * about frame arrival carries no server text.
 */
class WireFailure extends Error {
  constructor(
    readonly during: string,
    readonly answered = false,
  ) {
    super(`app-server request failed during ${during}`);
  }
}

/**
 * ONE TURN, ONE CHILD: spawn → initialize → thread/start
 * or thread/resume → turn/start → drain notifications to `turn/completed` →
 * kill, and resolve only after the child's exit is observed. A cross-pass
 * daemon multiplexing threads is a design refused for attend itself
 * and buys nothing while the budget is one turn per pass.
 *
 * NO TIMERS, deliberately. The parked approval has the supervisor's TTL
 * clock over it, and everything else here matches the exec seam's
 * own behaviour — `realRunTurn` resolves at `close` with no deadline — so a
 * hung binary hangs the pass the same way it always did, rather than this
 * file growing a second, private clock the frozen-clock rule would then
 * have to police.
 */
export function runAppServerTurn(req: AppServerTurnRequest): Promise<AppServerTurnOutcome> {
  return new Promise(resolve => {
    let session: SessionHandle;
    try {
      session = req.session(
        [...APP_SERVER_ARGV],
        req.workdir,
        { CODEX_HOME: req.codexHome },
      );
    } catch {
      // Nothing launched. 127 is the code that already means exactly that
      // (realRunTurn's sync-throw arm makes the same call for the same
      // reason), and it buys the honest "nothing was executed" reply.
      resolve({ stdout: '', code: 127 });
      return;
    }

    let settled = false;
    let exited = false;
    let handshook = false;
    let afterExit: AppServerTurnOutcome | null = null;
    let threadId: string | undefined;
    let lastAgentMessage = '';
    /** The live turn id — captured off `turn/start`'s result and
     * `turn/started`, cleared at `turn/completed`. It exists to fill
     * `turn/steer`'s `expectedTurnId` and for nothing else. */
    let liveTurnId: string | undefined;
    /** Approval asks currently parked at the supervisor. While one is
     * outstanding a steer is refused unsent: steer-during-park is
     * UNMEASURED, so it is forbidden here as well as by the supervisor's
     * predicate — two guards because either alone is one refactor from
     * nothing. */
    let asksOutstanding = 0;
    let steerSurfaced = false;
    /** The streaming accumulator: the CURRENT agentMessage's text so
     * far, keyed by the itemId its deltas carry. A new itemId resets — see
     * `AppServerTurnRequest.stream` for why that reset is what keeps the
     * snapshot aligned with `lastAgentMessage`. */
    let streamItemId: string | undefined;
    let streamText = '';
    /**
     * THE PER-TURN ITEM MAP — what makes the fileChange join possible.
     * Measured on 0.144.0: `item/fileChange/requestApproval` params are 211
     * bytes and carry NO diff at all; the diff arrived earlier, on
     * `item/started`, inside the fileChange item's `changes` array, keyed by
     * the SAME `itemId` the approval names. A driver that renders the
     * approval params alone shows the operator an EMPTY change wearing real
     * approval buttons — worse than showing nothing, so a failed join
     * declines rather than asks (verbatim or nothing, B-0 C10).
     */
    const items = new Map<string, Frame>();

    // Frames carry EXACTLY the members the captures show — {id,method,params}
    // out, {id,result} back to their requests, {method}/{method,params} for
    // notifications. No `jsonrpc` member anywhere (dialect quirk 1). The
    // write is guarded because a child can die between a frame arriving and
    // this answer leaving; a dead pipe is the exit handler's news to break,
    // not a throw out of a notification callback.
    const send = (frame: Frame): void => {
      try {
        session.write(JSON.stringify(frame));
      } catch {
        /* the exit handler settles the turn */
      }
    };

    let nextId = 1;
    const pending = new Map<
      number,
      { during: string; resolve: (result: unknown) => void; reject: (e: WireFailure) => void }
    >();
    const request = (method: string, params: Frame): Promise<unknown> =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { during: method, resolve: res, reject: rej });
        send({ id, method, params });
      });

    /** Settle once, and only over a dead child (see `SessionHandle.kill`). */
    const finish = (out: AppServerTurnOutcome): void => {
      if (settled) return;
      settled = true;
      if (exited) {
        resolve(out);
        return;
      }
      afterExit = out;
      session.kill();
    };

    session.onExit(code => {
      exited = true;
      if (afterExit !== null) {
        resolve(afterExit);
        return;
      }
      if (!settled) {
        settled = true;
        // The child died UNDER a live turn. Before the handshake answered,
        // that is indistinguishable from "could not be launched" (ENOENT
        // surfaces here); after it, the child's own non-zero code is the
        // honest one, and a zero exit with the turn incomplete is still a
        // failure — a turn that never reported is not a turn that succeeded.
        resolve({
          stdout: lastAgentMessage,
          code: !handshook ? 127 : code === null || code === 0 ? 1 : code,
          ...(threadId !== undefined ? { threadId } : {}),
        });
      }
      // Reject anything still awaiting a response so the main flow cannot
      // hang on a request the dead child will never answer.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new WireFailure(p.during));
      }
    });

    /**
     * An approval, relayed. The payload is the EXACT protocol fields —
     * command and cwd, or the joined per-file diffs — never model prose:
     * the supervisor journals these bytes, quotes them verbatim to the
     * phone or refuses one-tap, and byte-compares them at settlement.
     * `ask` absent, or a payload this client cannot assemble from the
     * protocol fields, fails CLOSED as `decline`: unshown is unapprovable.
     */
    const decide = async (
      payload: string | undefined,
      kind: 'commandExecution' | 'fileChange',
    ): Promise<ApprovalWireDecision> => {
      if (payload === undefined || req.ask === undefined) return 'decline';
      asksOutstanding += 1;
      try {
        const d = await req.ask({
          payload,
          kind,
          ...(threadId !== undefined ? { sessionKey: threadId } : {}),
        });
        return d === 'approve' ? 'accept' : 'decline';
      } catch {
        // A funnel that broke mid-ask approved nothing. Declining keeps the
        // turn moving (the model narrates it) instead of parking it against
        // an answer that can never come.
        return 'decline';
      } finally {
        asksOutstanding -= 1;
      }
    };

    /**
     * ONE STEER, in the measured dialect: the probe's exact frame —
     * `{threadId, expectedTurnId, input:[{type:'text',text}]}`, no
     * `text_elements` member (the capture's steer input carries none) — and
     * the measured result vocabulary mapped onto `SteerResult` (the type
     * holds the table). Refusals here resolve `not-delivered` WITHOUT
     * touching the wire: nothing sent is provably nothing delivered.
     */
    const steer = async (text: string): Promise<SteerResult> => {
      if (
        settled ||
        threadId === undefined ||
        liveTurnId === undefined ||
        asksOutstanding > 0
      ) {
        return 'not-delivered';
      }
      try {
        await request('turn/steer', {
          threadId,
          expectedTurnId: liveTurnId,
          input: [{ type: 'text', text }],
        });
        return 'delivered';
      } catch (err) {
        // An error FRAME is the server refusing with nothing delivered
        // (measured for -32600; ruled for every other error — see
        // `SteerResult`). Its message embeds the raw live turn id and is
        // never read (the WireFailure quarantine). No frame at all is a
        // dead child: MAYBE delivered.
        return err instanceof WireFailure && err.answered ? 'not-delivered' : 'failed';
      }
    };

    /** Surface the steer call once the turn is live — at most once, and
     * never for a caller that did not ask for one. */
    const surfaceSteer = (): void => {
      if (steerSurfaced || req.steering === undefined || liveTurnId === undefined) return;
      steerSurfaced = true;
      req.steering({
        ...(threadId !== undefined ? { sessionKey: threadId } : {}),
        steer,
      });
    };

    const commandPayload = (params: Frame | undefined): string | undefined => {
      const command = params?.command;
      if (typeof command !== 'string' || command === '') return undefined;
      const cwd = params?.cwd;
      return typeof cwd === 'string' && cwd !== '' ? `${command}\ncwd: ${cwd}` : command;
    };

    /** The join (see the item map above): approval params → itemId →
     * the fileChange item `item/started` delivered → its `changes` diffs. */
    const fileChangePayload = (params: Frame | undefined): string | undefined => {
      const itemId = params?.itemId;
      if (typeof itemId !== 'string') return undefined;
      const item = items.get(itemId);
      const changes = item?.changes;
      if (item?.type !== 'fileChange' || !Array.isArray(changes) || changes.length === 0) {
        return undefined;
      }
      const parts: string[] = [];
      for (const c of changes) {
        const change = asFrame(c);
        const path = change?.path;
        const diff = change?.diff;
        if (typeof path !== 'string' || typeof diff !== 'string') return undefined;
        const kind = asFrame(change?.kind)?.type;
        parts.push(`--- ${path}${typeof kind === 'string' ? ` (${kind})` : ''}\n${diff}`);
      }
      return parts.join('\n');
    };

    const serveRequest = async (method: string, id: unknown, params: Frame | undefined) => {
      if (method === 'item/commandExecution/requestApproval') {
        send({ id, result: { decision: await decide(commandPayload(params), 'commandExecution') } });
        return;
      }
      if (method === 'item/fileChange/requestApproval') {
        send({ id, result: { decision: await decide(fileChangePayload(params), 'fileChange') } });
        return;
      }
      // The other server→client families, DECIDED per family against the
      // 0.144.0 generation rather than left as one undifferentiated refusal
      // (each of these keeps the fixed error for a measured
      // reason, not for lack of looking):
      //
      //  - `item/tool/requestUserInput`: its schema DOES admit free-text
      //    answers ({answers: {qid: {answers: string[]}}}), so it would map
      //    onto a respond-shaped ask — but every type in the family is
      //    doc-marked EXPERIMENTAL in the stable generation, this client
      //    initializes with `experimentalApi: false` ("Opt into receiving
      //    experimental API methods", InitializeCapabilities.ts), and its
      //    questions carry `isSecret: true` shapes whose answers must never
      //    ride a chat spool. Answering a method our own handshake opted out
      //    of would widen the surface the version pin vouches for.
      //  - `item/permissions/requestApproval`: the RESPONSE schema is
      //    {permissions: GrantedPermissionProfile, scope} — a GRANT, with no
      //    decline/cancel member anywhere (unlike both decision enums). A
      //    deny would have to be guessed as an empty grant, and a guessed
      //    deny under an approval funnel is the one direction this must
      //    never guess in; an approve-only mapping cannot honour the TTL or
      //    the over-cap refusal, so it must not ask at all. The fixed error
      //    grants nothing and the turn moves on — fail closed, measured.
      //
      // Refusing LOUDLY beats leaving any of them unanswered — an unanswered
      // server request is a turn parked forever with nothing on screen — and
      // the sentence is OURS, fixed, never an echo.
      send({ id, error: { code: -32601, message: 'method not supported by this client' } });
    };

    const onNotification = (method: string, params: Frame | undefined): void => {
      if (method === 'item/agentMessage/delta') {
        // Dropped, verbatim, when nobody asked (`req.stream` absent) — the
        // prior behaviour, kept as the default so no existing caller's
        // turn changes shape by upgrading. ONLY this method feeds the
        // snapshot: reasoning and tool chatter are not the reply, and a
        // delta family this build has not measured must not become one.
        if (req.stream === undefined || settled) return;
        const itemId = params?.itemId;
        const delta = params?.delta;
        if (typeof itemId !== 'string' || itemId === '' || typeof delta !== 'string') return;
        if (itemId !== streamItemId) {
          // A NEW agentMessage began (a commentary phase ended): the
          // snapshot RESETS so it always mirrors the item that will become
          // `lastAgentMessage` — never a concatenation of phases the final
          // reply does not contain.
          streamItemId = itemId;
          streamText = '';
        }
        streamText += delta;
        try {
          req.stream(streamText);
        } catch {
          // The supervisor's intake is chatter to this client: a throwing
          // callback must not kill the read loop mid-turn (the same
          // isolation `decide`'s catch gives the ask seam).
        }
        return;
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = asFrame(params?.item);
        const itemId = item?.id;
        if (item === undefined || typeof itemId !== 'string') return;
        items.set(itemId, item);
        if (method === 'item/completed' && item.type === 'agentMessage') {
          const text = item.text;
          if (typeof text === 'string') lastAgentMessage = text;
        }
        return;
      }
      if (method === 'turn/started') {
        // The live turn id's second source (the first is `turn/start`'s own
        // result — both measured in the probe capture); whichever lands
        // first surfaces the steer call.
        liveTurnId = readTurnId(params) ?? liveTurnId;
        surfaceSteer();
        return;
      }
      if (method === 'turn/completed') {
        // The turn is over: any later steer resolves `not-delivered`
        // unsent — the covered-by-turn-over end condition, client-side.
        liveTurnId = undefined;
        const status = asFrame(params?.turn)?.status;
        // `turn/completed` carrying an error (status failed/interrupted)
        // maps to a non-zero code; the error's TEXT stays in the frame —
        // stdout is the model's channel and stderr never leaves the process.
        finish({
          stdout: lastAgentMessage,
          code: status === 'completed' ? 0 : 1,
          ...(threadId !== undefined ? { threadId } : {}),
        });
      }
    };

    session.onLine(line => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // not a frame; nothing to act on and nothing to repeat
      }
      const frame = asFrame(parsed);
      if (frame === undefined) return;
      const { id, method } = frame;
      // THE ID-SPACE SPLIT (dialect quirk 2): shape decides, id never does.
      // `method` present with an `id` is a SERVER→CLIENT REQUEST in the
      // server's own id space (starts at 0, overlaps ours by construction);
      // an `id` without `method` is a response to one of OUR requests. Fold
      // these branches together — or reorder them to check the response map
      // first — and the very first approval is consumed as a stray response
      // and never surfaced: the turn parks forever.
      if (typeof method === 'string' && id !== undefined) {
        // Fire-and-forget on purpose: the read loop must keep draining while
        // an ask parks (the park is real — measured 20 s host-side, and the
        // supervisor's TTL can hold it for minutes). `decide` cannot throw,
        // so the only rejection left is a dead pipe, which `send` swallows.
        void serveRequest(method, id, asFrame(frame.params)).catch(() => {});
        return;
      }
      if (id !== undefined) {
        const p = typeof id === 'number' ? pending.get(id) : undefined;
        if (p === undefined) return;
        pending.delete(id as number);
        // `answered: true` — an error FRAME arrived. The steer arm reads
        // that one bit and nothing of the frame (the steer error's
        // message embeds the raw live turn id).
        if ('error' in frame) p.reject(new WireFailure(p.during, true));
        else p.resolve(frame.result);
        return;
      }
      if (typeof method === 'string') onNotification(method, asFrame(frame.params));
    });

    const settings: Frame = {
      cwd: req.workdir,
      /**
       * `untrusted` by default — codex's own "ask for anything not
       * known-safe" policy, and the one the approval round-trip was measured
       * under (the integration spike). It is what makes the opt-in driver the
       * flagship: an action beyond the sandbox parks the turn until the
       * OPERATOR answers from the phone, instead of failing inside it.
       * OPERATOR-TYPED: `attend enable --approval-policy` writes
       * the config field the driver validates and threads through here —
       * loosening how often codex asks is a capability statement, so it
       * follows the caps rules (stated explicitly, refused when
       * unrecognised, never a silent new default).
       */
      approvalPolicy: req.approvalPolicy ?? 'untrusted',
      ...(req.sandbox !== undefined ? { sandbox: req.sandbox } : {}),
      // The model pin, typed (ThreadStartParams.model) — the same
      // isolation-must-not-change-the-model-silently rule the exec driver
      // carries as `-c model=…`, on this surface's own field. Absent means
      // absent: codex's default is the behaviour the operator already had.
      ...(req.model !== undefined ? { model: req.model } : {}),
    };

    const main = async (): Promise<void> => {
      await request('initialize', {
        clientInfo: { name: 'tacendum-attend', title: 'Tacendum attend', version: '1' },
        // Stable-only, stated: the entire driver path is in the stable set
        // (the integration spike), and opting into experimental methods would widen
        // the surface this version pin vouches for.
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      handshook = true;
      send({ method: 'initialized' });
      const started =
        req.threadId !== undefined
          ? await request('thread/resume', { threadId: req.threadId, ...settings })
          : await request('thread/start', settings);
      threadId = readThreadId(started);
      if (threadId === undefined) throw new WireFailure('thread/start');
      // The result was once DISCARDED — it carries the live turn id
      // (`result.turn.id`, measured), which is `turn/steer`'s precondition.
      const turnStarted = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: req.prompt, text_elements: [] }],
      });
      liveTurnId = readTurnId(turnStarted) ?? liveTurnId;
      surfaceSteer();
      // From here the turn is notification-driven: items, approvals, then
      // `turn/completed` calls `finish`.
    };
    main().catch(() => {
      // A refused request. Before the handshake that is "could not be
      // launched" (127); after it, an ordinary failed turn. The error frame
      // itself is not consulted further — see WireFailure.
      finish({
        stdout: lastAgentMessage,
        code: handshook ? 1 : 127,
        ...(threadId !== undefined ? { threadId } : {}),
      });
    });
  });
}
