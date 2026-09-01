import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { clientDir, stateDir } from './config.js';
import { CliError, EXIT } from './exit.js';
import { HOOK_CHAT_CAP, HOOK_HOSTS, capChatHead, hostSessionKey, plainForChat, sessionTag } from './hooks.js';
import { MessageLog, REDACT_AFTER_MS, RETAIN_MS, type MessageRecord } from './msglog.js';
import { type Reporter } from './output.js';
import { loadProfile, readProfile } from './profile.js';
import { writeFileAtomic, FileStores } from './stores.js';
import { tryFileLockAsync, withFileLock, withFileLockAsync } from './lock.js';
import { AuthSession } from './session.js';
import { MAX_BODY_BYTES, sendEncrypted, sendEncryptedAll } from './send.js';
import { encryptText, hasSession } from './messaging.js';
import { WsClient } from './wsclient.js';
import {
  ApprovalRequestEnvelope,
  MAX_APPROVAL_PAYLOAD_BYTES,
  composeStreamEdit,
} from '@tacendum/shared';
import { enqueueNotification } from './hooks.js';
import { AI_DISCLOSURE_SENTENCE, markAgentBody, markerShapeOk } from './ai-origin.js';
import { cmdService, listAccounts, statusOf, type ServiceIo } from './service.js';
import {
  APPROVAL_POLICIES,
  codexHomeDir,
  driverFor,
  type ApprovalPolicy,
  type DriverIo,
  type SessionFactory,
  type SessionHandle,
  type SteerableTurn,
} from './attend-drivers.js';
import { parseKeyPath, scanTomlStructure, splitTomlLines } from './toml-keys.js';
import { CLAUDE_SDK_INSTALL_STEP, claudeSdkInstalled } from './claude-sdk.js';
import { readMcpAskStepOver } from './mcp-ask.js';
import { sendRoomMessage, roomRefAuthor } from './room-commands.js';
import { FileGroupStore } from './rooms.js';
import {
  foldRoster,
  ownerOnlyPolicy,
  verdictFor,
  type GroupFold,
} from '@tacendum/shared/group-fold';

/**
 * `tacendum attend` — the machine answers (spec:
 * the design spec).
 *
 * A separate supervised process reading the spool as a durable trigger
 * queue. NOT a mode of `listen`: a hung agent turn must never stall message
 * intake, an attend crash must not cost delivery its 60-second restart
 * throttle, and a sibling `sync` consuming a frame must not silently eat a
 * trigger — the spool row exists either way, and the CURSOR, not the
 * transport, decides what has been answered (the same argument service.ts
 * makes against drain-inside-notify).
 *
 * THE TRIGGER PREDICATE IS THE SECURITY BOUNDARY, so it is one function
 * with one shape: inbound, conversational, FROM THE OWNER. Crew-mates never
 * execute — "every peer is an injection surface, and authenticated
 * transport makes a malicious instruction more credible, not less"
 * (CREW-RESEARCH) — and carriers, calls and vault items cannot even reach
 * the spool (render.ts maySpool). Attend is OFF unless `attend enable`
 * wrote a config, and the config's capability arguments — not a wrapper,
 * not a phrase — are the load-bearing control.
 *
 * The CURSOR is attend's own file, never `markRead`: marking read starts
 * the 24-hour body-purge clock and falsifies the operator's unread view —
 * the exact reason MCP reads with peek. The JOURNAL bounds a crash to at most
 * one INTERRUPTED turn, which the next pass answers rather than re-runs: an
 * agent turn has effects, so repeating one is a second execution, not a retry
 * (see `readJournal`). And the whole pass runs under the account's TURN LOCK,
 * because the thing that must not happen twice is the turn, not the counting
 * of it (see `turnLockPath`).
 */

export interface AttendConfig {
  /** Which adapter drives the turn. */
  host: 'claude' | 'codex';
  /** ABSOLUTE agent binary path, resolved at enable time — the launchd PATH
   * has never seen nvm or Herd (mcp-install.ts records the lesson). */
  bin: string;
  /** Where turns run when no route says otherwise. Never a guessed repo. */
  workdir: string;
  /** Capability arguments, verbatim onto the agent argv — the control. */
  caps: string[];
  /**
   * The model codex turns pin via `-c model=…`, captured from the OPERATOR's
   * own `~/.codex/config.toml` at enable time (`operatorCodexModel`). Exists
   * because config isolation would otherwise change the model
   * SILENTLY: `model` is a config.toml key, so an isolated `CODEX_HOME`
   * drops it and every reply would come from codex's built-in default at a
   * different price and quality with nothing in the reply saying so. Absent
   * when the operator's config pins no model (or none the reader can parse
   * with confidence): codex's default is then the behaviour they already
   * had. Never set for claude-host configs.
   */
  codexModel?: string;
  /**
   * WHICH codex driver runs the turn — OPT-IN, PER ACCOUNT, and absent
   * means the exec driver exactly as before. `"app-server"` selects the duplex JSON-RPC driver
   * (attend-drivers.ts `codexAppServerTurn`): approvals from the phone, a
   * captured own-session key, reply text from frames.
   *
   * A CONFIG FIELD RATHER THAN A FLAG OR A DEFAULT, deliberately. app-server
   * has no `-s/--sandbox` (measured on 0.144.0), so switching drivers
   * changes what `caps` — the operator's capability control — even MEANS;
   * that is precisely the change that must never ride a binary upgrade
   * silently, which rules out a new default. And `caps` itself has no CLI
   * surface today (`attend enable` writes the profile once; nothing
   * re-states it), so the honest opt-in is the same act that states every
   * other durable profile fact: an explicit line in attend.json, written by
   * the operator, readable back verbatim. An unrecognised value here
   * REFUSES the turn (the driver's check) — a driver name this build cannot
   * honour must not quietly become either of the ones it can.
   */
  codexDriver?: 'exec' | 'app-server';
  /**
   * WHICH claude mode runs the turn — OPT-IN, PER ACCOUNT, absent means the
   * `subprocess` driver exactly as before. `"sdk"` selects the in-process Agent SDK mode:
   * approvals from the phone through the same ask seam the codex app-server
   * driver rides — and it REQUIRES an operator-supplied API key. attend
   * refuses to configure it without one (`attend enable`) and refuses to
   * RUN it when the resolved credential is a subscription sign-in or
   * anything else not recognised as a key (`system/init.apiKeySource`,
   * fail closed — claude-sdk.ts holds the measured argument). The honest
   * product sentence this field carries: approvals work with codex on any
   * sign-in, and with claude only when the operator supplies an API key.
   * The same config-field-not-flag reasoning as `codexDriver`: switching
   * drivers changes what `caps` even means (the sdk driver translates
   * them to typed options, fail-closed), so it must never ride an upgrade
   * silently, and an unrecognised value here REFUSES the turn.
   */
  claudeDriver?: 'subprocess' | 'sdk';
  /**
   * codex app-server only: how often codex ASKS before acting — the typed
   * `approvalPolicy` thread setting, operator-stated (the caps surface).
   * Absent means `untrusted`, the policy the approval round-trip was
   * measured under and the default from the first app-server commit, so no
   * account changes behaviour by upgrading. The vocabulary is the vendored
   * schema's string members verbatim (`APPROVAL_POLICIES`,
   * codex-appserver.ts — untrusted | on-request | never); a value outside it
   * refuses the turn, the same fail-closed rule every other capability
   * field here follows. Never set for claude or for the exec driver: exec
   * has no approval surface at all, so a policy there would be a promise
   * nothing keeps.
   */
  codexApprovalPolicy?: ApprovalPolicy;
  /**
   * The approval-card ATTESTATION: the minimum app build the
   * OPERATOR states their phone runs, written by `attend enable --approvals`.
   * Present and ≥ 1, an ask leaves as the `x.approval` envelope the app's
   * card renders; absent — the default, and permanent for accounts that
   * never state it — an ask stays the plain-text prompt.
   *
   * AN ATTESTATION, NOT A CONFIGURATION. There is no capability negotiation
   * anywhere on this wire, so the CLI cannot learn what the phone can
   * render; the only honest gate is the operator's own claim, made once,
   * about their own device. The number is validated for SHAPE only (a
   * positive integer — the app's CURRENT_PROJECT_VERSION build number) and
   * never verified: a wrong claim costs exactly what enable's copy warns —
   * the card is silently dropped by the app's generic `x.*` drop branch
   * and the TTL deny is the only signal. Fail closed on anything
   * malformed: a field a hand edit mangled reads as un-attested, which is
   * the path every phone can render.
   */
  approvalsMinAppBuild?: number;
  /**
   * The live-streaming ATTESTATION — `approvalsMinAppBuild`'s exact
   * sibling, written by `attend enable --stream <min-app-build>`. Present
   * and ≥ 1, a codex app-server 1:1 turn STREAMS: the first chunk mints one
   * durable anchor, intermediates ride as sealed `x.edit` chatter on the
   * typing lane, and turn end sends the durable `{tcm:'edit'}` final.
   * Absent — the default, and PERMANENT for accounts that never state it —
   * every turn keeps today's single-reply shape, byte-identical, forever.
   *
   * An attestation, not a configuration, for the whole argument: no
   * capability negotiation exists on this wire, so the only honest gate is
   * the operator's own claim about their own device. Shape-checked only
   * (a positive integer — the app's build number), never verified; a wrong
   * claim costs what enable's copy warns — a build older than the durable
   * edit freezes the anchor at its opening words until the final `edit`
   * lands on a build that renders it. Fail closed on anything malformed: a
   * mangled field reads as un-attested, the path every build renders.
   */
  streamMinAppBuild?: number;
  /**
   * The AI-marker ATTESTATION — the third sibling, written by
   * `attend enable --marker <min-app-build>`. Present and ≥ 1, BARE TEXT the
   * agent lane sends wraps into the marked `msg` envelope; absent — the default, and permanent
   * for accounts that never state it — bare text leaves byte-identical to
   * today, while envelope bodies carry the marker regardless (a KNOWN kind
   * with an unknown field is invisible to every shipped parser — a measured
   * compatibility fact). Unlike its siblings it binds to EVERY profile:
   * every host's replies are bare text. Shape-checked only, never verified;
   * a wrong claim costs what enable's copy warns — marked text renders
   * "Unsupported message" on a build older than the msg parser. Read by the
   * hook and MCP lanes too (`markerAttested`, ai-origin.ts): one statement
   * about one device, not one per sender.
   */
  markerMinAppBuild?: number;
  /**
   * The TRIGGER FLAG: the rooms — by
   * gid — whose NON-OWNER structured @mentions may start a turn. Written by
   * `attend triggers <account> <gid> on|off` (a dedicated subcommand, not an
   * enable flag: the set changes as rooms come and go, and enable's whole-
   * profile rewrite is the wrong grammar for a mutable per-room list).
   * DEFAULT OFF — absent, empty, or malformed all read as "no room": a
   * non-owner mention in an unflagged room is room text attend never acts
   * on, exactly the `peer === owner` posture unchanged. Fail closed on
   * every malformed shape (`roomTriggerGids` is the one reader).
   *
   * What flipping a room ON means, stated at the field because this is a
   * capability grant an operator will read back months later: a CURRENT
   * MEMBER's structured @mention of this account may start a turn that
   * SPENDS THE OWNER's turnsPerHour budget. Membership is the ruled operand
   * and is re-checked
   * against the room's roster fold at trigger time — a removed member, a
   * never-member, and a consented stranger who merely knows the gid are all
   * inert. The grant is PROSPECTIVE (`roomTriggerArmedAt` below): mentions
   * banked while the room was OFF never fire on a flip. The turn runs at
   * the room capability floor regardless of `caps` (plan/read-only,
   * `roomCapsFloor`, model pin carried) and carries NO approval capability
   * (no ask funnel, `codexApprovalPolicy` forced 'never' — the floor is
   * terminal); rooms still queue and never steer; replies still fan through
   * the room machinery only. Reply-to-continue stays OWNER-only in flagged
   * rooms — the ruled sentence admits exactly the co-member @mention,
   * nothing wider.
   *
   * RE-RUNNING `attend enable` DROPS THIS LIST (its header rule: enable
   * rewrites the whole profile), which is the fail-closed direction — a
   * profile re-statement can silently turn triggers OFF, never ON.
   */
  roomTriggers?: string[];
  /**
   * WHEN each room was flipped ON (gid → epoch ms), written by the same
   * `attend triggers` command in the same act as `roomTriggers` and read by
   * the same one reader (`roomTriggerArm`). The grant is PROSPECTIVE, never
   * retroactive: a co-member mention that
   * arrived while the room was OFF is room text forever — a row older than
   * this stamp never admits, so flipping ON cannot fire a backlog banked
   * against a room the sender knew was closed. Fail closed both ways: a gid
   * in `roomTriggers` with no finite stamp here reads as OFF (a hand edit
   * cannot arm a room without dating the arming), and re-running `on` for an
   * already-open room keeps the ORIGINAL stamp (idempotence must not
   * re-date the grant). Enable's whole-profile rewrite drops this with its
   * sibling.
   */
  roomTriggerArmedAt?: Record<string, number>;
  /** Attend's own pinned session key for bare messages, minted at enable. */
  ownSession: string;
  /**
   * True once the own session's TRANSCRIPT EXISTS in the host's store.
   *
   * NOT "the first own turn succeeded". That was the original premise and it
   * is wrong, measured against the installed claude 2.1.187 on 2026-08-01:
   *
   *  - `claude -p --session-id <uuid>` writes
   *    `~/.claude/projects/<slug>/<uuid>.jsonl` at SESSION START, not at
   *    turn end. On the probe run the file's birth time equalled its first
   *    record's stamp (20:52:50.252Z) while the assistant's answer only
   *    landed at 20:52:52.078Z — the transcript exists ~1.8s before the turn
   *    is decided, so a turn that then fails FOR ANY REASON still leaves it.
   *  - the guard that reads it is a bare `statSync` on that path, so a second
   *    `--session-id <same uuid>` is refused on FILE EXISTENCE alone:
   *    stderr `Error: Session ID <uuid> is already in use.`, stdout empty,
   *    exit 1.
   *  - the other direction is symmetric: `-p --resume <never-created>` gives
   *    stderr `No conversation found with session ID: <uuid>`, stdout empty,
   *    exit 1.
   *
   * Flipping this only on the success path therefore WEDGED the own session
   * permanently: one failed first turn — a bad prompt, a dropped network, a
   * laptop lid — left the transcript on disk with the flag false, and every
   * later bare message re-ran the create form against a session that now
   * existed. So the flag records what a spawn OBSERVED about the host's
   * store (`observeOwn`, claude's driver in attend-drivers.ts), and BOTH
   * refusals above are recovered from inside the same pass
   * (`recoveryArgv`, same place): the flag is an optimisation that saves a
   * spawn, never a correctness dependency. A wrong value costs one extra
   * startup refusal, which costs no model call and no budget token.
   */
  ownSessionStarted?: boolean;
  /** Turns allowed per rolling hour; beyond it attend answers honestly
   * instead of spawning. */
  turnsPerHour: number;
}

export interface AttendIo {
  /**
   * Turn spawner seam. The PROMPT is a separate parameter because it rides
   * stdin, never argv. Returns the agent's final text, its diagnostics and
   * its exit code.
   *
   * STDERR IS PART OF THE RETURN because that is where the host puts the
   * only lines attend can act on: every session refusal claude emits writes
   * to stderr with an EMPTY stdout (measured, see `HOST_REFUSALS` in
   * attend-drivers.ts). This
   * seam used to drop stderr on the floor, which is why the code that reads
   * it had to be written before the code that acts on it. Optional so a
   * caller that has nothing to report may omit it.
   */
  runTurn?: (
    argv: string[],
    cwd: string,
    prompt: string,
    /** Environment OVER the inherited one, when the driver's host needs its
     * own (codex's `CODEX_HOME`). Optional at both ends so every existing
     * fake keeps its shape; the real spawner merges it (`realRunTurn`). */
    env?: Readonly<Record<string, string>>,
  ) => Promise<{ stdout: string; stderr?: string; code: number }>;
  /**
   * The duplex seam — `runTurn`'s sibling for hosts whose turn is a
   * line-framed conversation (`codex app-server`). Kept SEPARATE from
   * `runTurn` because that seam's meaning cannot stretch: `realRunTurn`
   * closes the child's stdin at spawn and resolves only at `close`, so it
   * can never host JSON-RPC, and every existing fake relies on exactly that
   * shape. Optional at both ends: the real pass always provides one (bound
   * to `cfg.bin` in `attendPass`), and a test that fakes only `runTurn`
   * keeps working because the spawn-seam drivers never touch this.
   */
  session?: SessionFactory;
  /**
   * Reply seam — the real one is the send path under role 'send'
   * (`realSendReply`). Returns the WIRE msgId when it knows one, because the
   * approval funnel records that id as the reply-ref the phone's answer will
   * carry — a seam that swallows the id produces an approval that can only
   * expire, which is honest but useless. `void` stays in the return type so
   * every pre-approval fake keeps its shape; `sess` is the session the reply
   * speaks FOR, threaded so the real transport can write the outbound ledger
   * row that makes the reply routable (see `realSendReply`). `opts` is a
   * later widening and OPTIONAL AT BOTH ENDS, so every two-parameter fake
   * stays assignable: `notify: false` marks a CARRIER (send.ts
   * `OutboundMessage.notify` — the durable stream-final `{tcm:'edit'}` must
   * not ring a phone its anchor already rang); omitted means notify
   * normally, which is every pre-stream send unchanged.
   */
  sendReply?: (
    body: string,
    sess?: OutSess,
    opts?: { notify?: boolean },
  ) => Promise<string | void>;
  /**
   * The ROOM reply seam — `sendReply`'s sibling for a turn the
   * room predicate routed. The real one (`realSendRoomReply`) goes through
   * room-commands' fan-out machinery ONLY — fold verdict, sq, one `m` for
   * all legs, rd digest, mintLegs/sendEncryptedFanout — and then writes the
   * `${selfUserId}.${m}` outbound ledger row reply-to-continue joins on.
   * Kept separate from `sendReply` on the spawn/duplex seam's exact
   * argument: that seam's meaning cannot stretch (it is 1:1 to the owner,
   * and the approval funnel stands on that), and every existing fake keeps
   * its shape.
   */
  sendRoomReply?: (gid: string, body: string) => Promise<RoomReplyOutcome>;
  /**
   * The typing-chatter seam — one channel minted per 1:1
   * turn, sent to on the pass's own poll cadence, closed when the turn ends.
   * The real one (`realTypingChannel`) holds one 'send'-role socket for the
   * turn: that role never competes for the account's routing row (dto.ts
   * `WsTicketRole`), so it can never displace the listener nor starve a
   * concurrent approval-card dial. FIRE-AND-FORGET BY CONTRACT: a send that
   * cannot go is silently dropped, and nothing about it may fail, delay or
   * retry the turn (the phone's 15 s expiry answers for every lost frame).
   * Tests that hold a turn open across a poll tick should fake this; the
   * real channel's first gate — no ratchet session with the owner, the state
   * every test fixture is in — already keeps a missing fake off the network.
   */
  typing?: (to: string) => TypingChannel;
  now?: () => number;
  /**
   * The park cadence seam. A pass waiting on an approval answer polls the
   * spool and the TTL clock, then sleeps this long; the seam exists because
   * the frozen-clock rule forbids pinning `now()` beside advancing timers —
   * a TTL test advances a FAKE clock inside its fake sleep, so time moves the
   * way it moves in production, only faster. Absent means a real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** A `dir:'out'` ledger row's session half — msglog's own shape, named so the
 * reply seam and `realSendReply` provably speak the same one. */
export type OutSess = NonNullable<MessageRecord['sess']>;

/**
 * What one turn's typing chatter travels through (`AttendIo.typing`). `send`
 * NEVER rejects in the real implementation — every refusal is swallowed to
 * silence inside it (chatter must not fail the turn, and nothing
 * about a failure reaches the phone or carries payload) — but the loop still
 * catches, so a fake that throws proves the isolation. `close` is sync and
 * idempotent: the loop's finally calls it on every exit, crash included.
 */
export interface TypingChannel {
  send(state: 'start' | 'stop'): Promise<void>;
  /**
   * One sealed `x.edit` intermediate over the SAME 'send'-role socket, the
   * same relay-only `typing` wire frame and the same silent-drop contract as
   * `send` (the ciphertext is what makes an edit indistinguishable
   * from a typing refresh, which is why the server diff is EMPTY). `body`
   * is the composed StreamEditEnvelope JSON — `composeStreamEdit`'s output,
   * already funneled and bounded upstream. OPTIONAL so every pre-stream
   * fake keeps its shape: a channel without the member simply streams no
   * intermediates, and the durable anchor + final still carry the reply.
   */
  edit?(body: string): Promise<void>;
  close(): void;
}

/**
 * What one room reply fan-out reported back to the pass — counts
 * of members by name so the partial-failure sentence can count honestly,
 * plus the two refusal shapes the fold can answer with. `refused` set means
 * NOTHING left this machine: the turn's answer is owed to the owner 1:1.
 */
export interface RoomReplyOutcome {
  /** The message ref `m` all legs shared; absent when refused. */
  m?: string;
  delivered: string[];
  skipped: string[];
  failed: string[];
  /** The fold said no: not (or no longer) a member, or no such room here. */
  refused?: 'not-in-room' | 'no-room';
}

/**
 * Attend's own id minter — wire msgIds for `realSendReply` and the approval
 * journal's row/request ids. The SAME minter shape the hook path uses for its
 * notification msgIds (hooks.ts holds its own `monotonicFactory()`), and the
 * CSPRNG entropy allowance already covers; no new crypto call site. The
 * single-use `requestId` this mints is THE approval binding: never reused,
 * never re-bound to a second payload (see the journal below).
 */
const ulid = monotonicFactory();

const configPath = (account: string): string => join(clientDir(account), 'attend.json');
const cursorPath = (account: string): string => join(stateDir(account), 'attend-cursor.json');
const journalPath = (account: string): string => join(stateDir(account), 'attend-journal.json');
const bucketPath = (account: string): string => join(stateDir(account), 'attend-bucket.json');
const approvalsPath = (account: string): string =>
  join(stateDir(account), 'attend-approvals.json');
const roomSessionsPath = (account: string): string =>
  join(stateDir(account), 'attend-room-sessions.json');

/**
 * Session identity for room turns, per host, v1:
 *
 *   claude            a pinned per-room session — the ownSession analog,
 *                     keyed by gid: `key` is minted here (randomUUID, so it
 *                     passes `hostSessionKey` like the own session does) and
 *                     `started` records what a spawn OBSERVED about the
 *                     host's store, exactly as `ownSessionStarted` does and
 *                     for exactly its reasons (the wedge that flag's comment
 *                     documents).
 *   codex app-server  the CAPTURED thread key: `key` is `TurnResult
 *                     .sessionKey` off the first room turn's frame, stored
 *                     here so later room turns resume the thread; `started`
 *                     is meaningless (presence of the key IS the resume).
 *   codex exec        fresh per turn — never in this file, exactly as an
 *                     exec own turn stores nothing.
 *
 * The file is state (0600 under `stateDir`), never config: losing it costs
 * continuity — the next room turn starts a fresh transcript — never
 * correctness, the same trade `ownSessionStarted` makes.
 */
interface RoomSessionFile {
  [gid: string]: { key?: string; started?: boolean };
}

function loadRoomSessions(account: string): RoomSessionFile {
  const raw = loadJson<RoomSessionFile>(roomSessionsPath(account));
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function saveRoomSession(
  account: string,
  gid: string,
  entry: { key?: string; started?: boolean },
): void {
  const all = loadRoomSessions(account);
  writeFileAtomic(roomSessionsPath(account), JSON.stringify({ ...all, [gid]: entry }), {
    mode: 0o600,
  });
}

export function loadAttendConfig(account: string): AttendConfig | null {
  try {
    const raw = readFileSync(configPath(account), 'utf8');
    if (raw.trim() === '') return null; // disabled
    return JSON.parse(raw) as AttendConfig;
  } catch {
    return null;
  }
}

export function saveAttendConfig(account: string, cfg: AttendConfig): void {
  writeFileAtomic(configPath(account), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** A bare room gid — the same ULID alphabet a message ref is made of. */
const GID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The one reader of the grant, shared by the predicate below, the
 * pendingRows filter, `attend status` and the `attend triggers`
 * subcommand's read-back — one implementation, so what the commands SHOW is
 * provably what the predicate READS. A room is ON iff BOTH halves the
 * writer stamps are present and well-formed: its gid in `roomTriggers` AND
 * a finite positive `roomTriggerArmedAt` stamp — the stamp is what makes
 * the grant prospective (rows older than it never admit). Fail closed on
 * every malformed shape: a hand-edited non-array, a non-string member, a
 * non-ULID string, a missing or non-finite stamp all simply vanish from the
 * map, and a vanished gid means OFF — the direction every attestation field
 * in this file already fails.
 */
export function roomTriggerArm(
  cfg: Pick<AttendConfig, 'roomTriggers' | 'roomTriggerArmedAt'> | null,
): ReadonlyMap<string, number> {
  const raw = cfg?.roomTriggers;
  const stamps = cfg?.roomTriggerArmedAt;
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const gid of raw) {
    if (typeof gid !== 'string' || !GID_RE.test(gid)) continue;
    const at =
      stamps !== null &&
      typeof stamps === 'object' &&
      !Array.isArray(stamps) &&
      typeof (stamps as Record<string, unknown>)[gid] === 'number'
        ? ((stamps as Record<string, number>)[gid] as number)
        : undefined;
    if (at === undefined || !Number.isFinite(at) || at <= 0) continue;
    out.set(gid, at);
  }
  return out;
}

/** The gid set view of the same grant — `roomTriggerArm`'s keys, kept as a
 * named reader because the read-back surfaces list rooms, not stamps. */
export function roomTriggerGids(
  cfg: Pick<AttendConfig, 'roomTriggers' | 'roomTriggerArmedAt'> | null,
): ReadonlySet<string> {
  return new Set(roomTriggerArm(cfg).keys());
}

/**
 * The arm's whole operand set: the armed
 * map above plus a MEMBERSHIP oracle over the CURRENT roster fold. The
 * ruled sentence is "room MEMBERS may trigger my agent" — membership is an
 * operand of the grant, not a rendering nicety — and it is re-checked at
 * TRIGGER time against the fold as it stands, never carried frozen on the
 * spooled row: a verdict stamped at spool time rots the moment the roster
 * moves (a member removed between spool and trigger would still fire), and
 * the only membership that matters is the one at the moment the owner's
 * budget is about to be spent. Absent (a caller that cannot answer the
 * question) fails closed: no non-owner row admits.
 */
export interface RoomTriggerGate {
  /** gid → epoch ms the owner flipped it ON; a row older than its room's
   * stamp never admits (the grant is prospective). */
  armedAt: ReadonlyMap<string, number>;
  /** Is `peer` IN `gid`'s roster fold RIGHT NOW? Unloadable room, unreadable
   * store, unanchored gid all answer false (fail closed). */
  memberOf(gid: string, peer: string): boolean;
}

/**
 * The one predicate. A row triggers iff ALL of these hold.
 *
 * THE `peer === ownerUserId` CLAUSE IS THE SECURITY BOUNDARY AND HAS
 * EXACTLY ONE RULED EXCEPTION. For every 1:1 shape and for
 * reply-to-continue it does not move — a crew-mate's or co-member's reply is spooled, rendered, and never
 * executed: "every peer is an injection surface, and authenticated
 * transport makes a malicious instruction more credible, not less". The
 * exception: a NON-owner `grp.msg` row may trigger iff it is a STRUCTURED
 * @mention of this account AND its room's gid is in the owner's
 * `roomTriggers` grant (default OFF, `rooms` below — fail closed when
 * absent) AND the row POSTDATES the flip (the grant is prospective: a
 * mention banked while the room was OFF is room text forever) AND the
 * author is IN that room's CURRENT roster fold (the ruled sentence is
 * "room MEMBERS may trigger" — a never-member, a removed member, and a
 * stranger who merely holds a consent edge are all inert, however their
 * row is shaped; the consent remediation). The turn it starts still
 * spends the OWNER's budget, still runs at the room capability floor,
 * still queues-never-steers.
 *
 * Agent-to-agent chaining stays REFUSED in effect
 * without a class clause this client could not honestly write — a peer's
 * account class is unknowable here (machine.ts records why): no agent lane
 * composes a structured mention (no CLI mention-compose — a deliberate rule), so a
 * turn triggered by a co-member's mention cannot cascade into another, and
 * the hourly budget backstops whatever a modified client tries.
 *
 * ROOM ROWS: an OWNER-authored `grp.msg` row is admitted iff the
 * STRUCTURED mention envelope named this account (`men`, ruled: rendered
 * text never triggers — a plain-text "@name" is chatter) OR its reply ref is
 * the compound message-ref key of something THIS attend said in a room
 * (`${selfUserId}.…` — reply-to-continue). Whether that ref RESOLVES — a
 * ledger row exists, in the SAME grp — is the router's question, so an aged-
 * out or cross-room ref earns the honest no-turn answer (router rule 4)
 * instead of silence. `selfUserId` absent fails closed: no room row admits.
 */
export function triggers(
  row: MessageRecord,
  ownerUserId: string,
  selfUserId?: string,
  rooms?: RoomTriggerGate,
): boolean {
  const base = row.dir === 'in' && row.red !== true && row.text !== '';
  if (!base) return false;
  if (row.peer === ownerUserId) {
    if (row.tcm === '' || row.tcm === 'reply') return true;
    if (row.tcm !== 'grp.msg' || row.grp === undefined) return false;
    if (row.men === true) return true;
    // Reply-to-continue: the reply's message ref names something THIS attend said
    // in a room (`${selfUserId}.…`). `roomRefAuthor` is the SHARED parser the
    // sender audience (roomContentRecipients) reads too, so the two ends admit
    // and address exactly the same replies — no drift.
    const refAuthor = row.ref === undefined ? null : roomRefAuthor(row.ref);
    return refAuthor !== null && selfUserId !== undefined && refAuthor === selfUserId;
  }
  // The arm — the ONLY non-owner admission, every operand fail-closed:
  // a room row (never any 1:1 shape), a structured mention (never bare
  // text, never reply-to-continue — the ruled sentence admits exactly the
  // co-member @mention), in a room the owner explicitly flipped ON, sent
  // AFTER the flip (the arming stamp — a grant is prospective, never a
  // retro-fire of banked backlog), by an author the room's CURRENT fold
  // says is IN (the "room MEMBERS" operand, re-checked at trigger time so
  // a roster change between spool and trigger is honoured).
  if (
    row.tcm !== 'grp.msg' ||
    row.grp === undefined ||
    row.men !== true ||
    rooms === undefined
  ) {
    return false;
  }
  const armed = rooms.armedAt.get(row.grp);
  return (
    armed !== undefined &&
    Number.isFinite(row.ts) &&
    row.ts >= armed &&
    rooms.memberOf(row.grp, row.peer)
  );
}

interface Cursor {
  /** msgId of the last row a FINISHED batch covered. */
  lastId?: string;
  /** Its append timestamp — the recovery key if the row ages out. */
  lastTs?: number;
}

function loadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Rows after the cursor, in append order. */
export function pendingRows(account: string, ownerUserId: string): MessageRecord[] {
  const cursor = loadJson<Cursor>(cursorPath(account)) ?? {};
  const rows = new MessageLog(account).read({ dir: 'in' }).reverse(); // append order
  let start = 0;
  if (cursor.lastId) {
    const at = rows.findIndex(r => r.id === cursor.lastId);
    if (at >= 0) start = at + 1;
    else if (cursor.lastTs) start = rows.findIndex(r => r.ts > (cursor.lastTs as number));
    if (start < 0) start = rows.length;
  }
  // `readProfile`, never `loadProfile`: this reader serves `attendState` too,
  // and a profile that will not read must degrade (room rows fail closed —
  // no self, no room admission), never throw out of a status command.
  const profile = readProfile(account);
  const selfUserId =
    profile.kind === 'ok' && typeof profile.profile.userId === 'string'
      ? profile.profile.userId
      : undefined;
  // The grant, read HERE — the one spool reader — so every consumer
  // (the pass, the steer poller, settleTurn, attendState) applies the same
  // predicate and none can drift wider than the others. An unreadable or
  // absent config yields the empty map: every room OFF, today's behaviour.
  // Built ONCE per sweep (the gate memoizes each flagged room's fold).
  const gate = roomTriggerGate(account, loadAttendConfig(account));
  return rows.slice(start).filter(r => triggers(r, ownerUserId, selfUserId, gate));
}

/**
 * Build the gate `triggers()` takes: the armed map off the config plus a
 * membership oracle over the CURRENT roster fold, memoized per gid so a
 * spool sweep folds each flagged room once. Membership is answered by the
 * SAME fold both rendering clients run (`foldRoster`/`verdictFor`,
 * @tacendum/shared/group-fold — the one implementation of the roster
 * rules), against the room file as it stands NOW: verdicts are never
 * carried on spooled rows, where they would rot the moment the roster
 * moves. Every failure answers false — an unanchored gid, an unreadable
 * room file, a fold that throws — because a membership question this
 * client cannot answer must not admit a turn (fail closed).
 */
export function roomTriggerGate(
  account: string,
  cfg: Pick<AttendConfig, 'roomTriggers' | 'roomTriggerArmedAt'> | null,
): RoomTriggerGate {
  const armedAt = roomTriggerArm(cfg);
  const folds = new Map<string, GroupFold | null>();
  return {
    armedAt,
    memberOf(gid, peer) {
      let fold = folds.get(gid);
      if (fold === undefined) {
        try {
          const store = FileGroupStore.load(account, gid);
          const roomOwner = store.getOwner();
          fold =
            roomOwner === undefined
              ? null
              : foldRoster(roomOwner, store.listSlots(), ownerOnlyPolicy);
        } catch {
          fold = null;
        }
        folds.set(gid, fold);
      }
      return fold !== null && verdictFor(fold, peer) === 'in';
    },
  };
}

/**
 * THE ROUTER. Given the batch and the ledger, decide the turn:
 *  1. a reply ref that resolves -> that session;
 *  2. no ref, exactly one live session key in the recent ledger -> it;
 *  3. no ref, several -> ask back, listing tags — one line, no turn;
 *  4. a ref that resolves to NOTHING (aged out, never recorded) -> honest
 *     answer, no guess; but a ref that resolves to a REAL local row attend
 *     cannot continue — a sessionless out row — is a conversation the owner
 *     is still having, so it falls back to a fresh own turn carrying the
 *     reply behind a context line (`Route.kind 'carry'`);
 *  5. a ref that resolves to a session on a host THIS attend cannot drive ->
 *     say so, run nothing (see `Route.host` below).
 * "Live" is approximated by the ledger's recency window: sessions the
 * machine spoke FOR in the last two hours. The ledger is the one place
 * msgId -> session is decided; the router never parses tags out of text.
 */
export const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

export type Route =
  | { kind: 'session'; host: string; key: string }
  | { kind: 'own' }
  | { kind: 'ask'; tags: string[] }
  | { kind: 'ended' }
  | { kind: 'unroutable'; host: string; tag: string }
  /** THE REPLY-CONTINUATION FALLBACK: the
   * ref resolved to a real LOCAL out row that attend cannot continue — no
   * `sess` at all, the shape every MCP notify/ask row, hook-without-session
   * row, codex-exec answer and room-turn side message is born with. The
   * dead-end excuse taught the operator nothing; a reply is a request, so
   * it runs a FRESH own-route turn carrying the reply as the prompt behind
   * one context line quoting the referenced row's own text (`refText`,
   * straight off the ledger row — never re-fetched; today it is '' by the
   * out-writers' shared plaintext-minimization rule, and the line says so
   * honestly). NOT for a sess-BEARING row whose key fails the gate — a
   * tampered credential is not a conversation (gate.session-argv's pin) —
   * and not for room rows, whose arm keeps its own refusals. */
  | { kind: 'carry'; refId: string; refText: string }
  /** A room-triggered turn. The identity is the ROOM, never a
   * ledger session key: session continuity for rooms lives in the per-room
   * session store, keyed by this gid. */
  | { kind: 'room'; gid: string };

/**
 * A LEDGER ROW IS NOT A CREDENTIAL. Its `sess.key` came from an agent host's
 * hook payload, and the file it lives in is an ordinary jsonl on this disk.
 * `hostSessionKey` is the same gate the parsers apply on the way in, applied
 * again on the way OUT, because a row written by an older build, restored from
 * a backup, or edited by anything that can write the spool has never met that
 * gate. A row whose key fails it simply does not resolve — the router then
 * answers honestly, which is exactly what it exists for. Nothing here throws:
 * an unroutable ref is a conversation, not a fault.
 *
 * Two independent reasons a row can fail to resolve, and they are NOT the same
 * refusal: a key of the wrong SHAPE is a row we will not put in an argv at all
 * (below), and a key belonging to another HOST is a row we could put in an
 * argv and must not (next comment). The first is silent — a malformed key is
 * not a session the operator can be told about, because we will not echo it.
 * The second names the host, because the operator can act on that.
 *
 * WHY A ROUTED SESSION'S HOST IS A REFUSAL AND NOT AN INSTRUCTION.
 *
 * `Route.host` comes off the ledger row, and a ledger row's `sess.host` is
 * whatever hook fired it — `HOOK_HOSTS` is `claude | codex | gemini | cursor`,
 * four hosts, set verbatim at hooks.ts's ledger write. Attend drives TWO of
 * them, and it had no consumer for this field at all: `turnArgv` branched on
 * `cfg.host` alone, so a cursor session was routable while attend was
 * configured for claude and the turn that came out was
 *
 *     claude -p --resume cursor-conv-9f2b --permission-mode plan
 *
 * — claude's binary, claude's grammar, and a session id claude never issued.
 * The best case there is "No conversation found"; the worse case is a host
 * that quietly opens a FRESH session, so the operator's reply lands in a
 * transcript that has none of the context they were replying to, answered as
 * if it did.
 *
 * The alternative — honour the row's host — was considered and refused. It
 * cannot be done honestly at this layer: `cfg.bin` is ONE absolute path
 * resolved at enable time (`which claude`), so attend has no binary for the
 * other two hosts; it has no argv shape for them either (the codex/claude
 * asymmetry documented on `turnArgv` is already two shapes for two parsers,
 * and gemini and cursor are two more unknowns); and cursor's `sess.key` is a
 * conversation_id, not a resumable headless session at all (msglog's `sess`
 * comment). Guessing any of that produces a spawn that either fails with a
 * usage error or succeeds against the wrong transcript, and the second is
 * worse than the first because it looks like an answer.
 *
 * So: route to a session only when its host is the one attend is configured to
 * drive, and otherwise say which host it belongs to. Matching on host rather
 * than on "is it drivable in principle" is deliberate — a codex session key is
 * as meaningless to claude as a cursor one is, so `cfg.host` is the test even
 * when both sides are hosts attend knows.
 */
function routeIn(
  ledger: MessageRecord[],
  batch: MessageRecord[],
  now: number,
  host: string,
): Route {
  // ROOM ROWS FIRST: a room row's identity is its room — the
  // routeKey `room:<gid>` is what keeps the leading-run batching per room
  // and what makes a room row unequal to every running 1:1 key at the steer
  // poller. A mention routes straight to its room; a reply-to-continue must
  // ALSO resolve — a room ledger row this attend wrote, in the SAME grp —
  // or it takes the honest `ended` answer (router rule 4: an unresolvable
  // ref is a conversation, not a guess; the cross-room case lands here too,
  // because continuing room B's session from room A is the confusion the
  // grp clause exists to kill).
  const roomRow = batch.find(r => r.grp !== undefined);
  if (roomRow?.grp !== undefined) {
    if (roomRow.men === true) return { kind: 'room', gid: roomRow.grp };
    const hit =
      roomRow.ref === undefined
        ? undefined
        : ledger.find(r => r.id === roomRow.ref && r.grp !== undefined);
    if (hit !== undefined && hit.grp === roomRow.grp) return { kind: 'room', gid: roomRow.grp };
    return { kind: 'ended' };
  }
  const resolvable = (row: MessageRecord): string | undefined =>
    hostSessionKey(row.sess?.key);
  const refs = batch.map(r => r.ref).filter((r): r is string => Boolean(r));
  if (refs.length > 0) {
    // The LAST ref wins — the operator's most recent aim.
    const target = refs[refs.length - 1] as string;
    // Shape first, then host. A row whose key fails `hostSessionKey` is not a
    // session we can name back to the operator either — `unroutable` echoes a
    // TAG derived from the key, and deriving a tag from a value we have just
    // judged malformed is the same mistake one indirection further out.
    const hit = ledger.find(r => r.id === target);
    const key = hit === undefined ? undefined : resolvable(hit);
    if (hit !== undefined && key !== undefined) {
      const on = hit.sess?.host ?? '';
      if (on !== host) return { kind: 'unroutable', host: on, tag: sessionTag(key) };
      return { kind: 'session', host: on, key };
    }
    // The row EXISTS but cannot be continued. Three shapes, two answers:
    //  - no sess at all -> the carry fallback (`Route.kind 'carry'` holds the
    //    argument): the reply becomes a fresh own turn with the referenced
    //    row's own text as context;
    //  - a sess whose key failed the gate -> `ended`, silently (the rule
    //    above: a tampered credential is not a conversation, and quoting a
    //    row that carries one hands its author a prompt surface);
    //  - a room row (`grp`) -> `ended`, because a 1:1 reply must not carry
    //    room context into a private transcript — the room arm at the top of
    //    this function owns every legitimate room continuation.
    if (hit !== undefined && hit.sess === undefined && hit.grp === undefined) {
      return { kind: 'carry', refId: hit.id, refText: hit.text };
    }
    return { kind: 'ended' };
  }
  // Sessions attend CANNOT drive are filtered out before they are counted, not
  // after. Counted, a single live cursor session routed a bare message to it
  // — and a second one turned every bare message into an ask-back
  // naming sessions the operator cannot usefully pick. Filtered, they simply
  // do not participate, and a bare message falls through to the own session —
  // which is the documented default and always drivable.
  const live = new Map<string, { host: string; key: string }>();
  for (const row of ledger) {
    const key = resolvable(row);
    if (row.sess === undefined || key === undefined) continue;
    if (row.sess.host === host && now - row.ts <= LIVE_WINDOW_MS && !live.has(key)) {
      live.set(key, { host: row.sess.host, key });
    }
  }
  if (live.size === 1) {
    const only = [...live.values()][0] as { host: string; key: string };
    return { kind: 'session', host: only.host, key: only.key };
  }
  if (live.size > 1) return { kind: 'ask', tags: [...live.keys()].map(sessionTag) };
  return { kind: 'own' };
}

export function route(
  account: string,
  batch: MessageRecord[],
  now: number,
  host: string,
): Route {
  return routeIn(new MessageLog(account).read({ dir: 'out' }), batch, now, host);
}

/**
 * The identity a batch is GROUPED by — two rows share a turn iff they share
 * this string. It exists because "the route" was a property of the whole
 * batch and had to become a property of each row; see `attendOnce`.
 */
function routeKey(r: Route): string {
  switch (r.kind) {
    case 'session':
      return `session:${r.host}:${r.key}`;
    case 'unroutable':
      return `unroutable:${r.host}:${r.tag}`;
    case 'ask':
      return `ask:${r.tags.join(',')}`;
    case 'own':
      return 'own';
    case 'ended':
      return 'ended';
    case 'carry':
      // Keyed by the REFERENCED row, not collapsed into 'own': two replies to
      // the same dead message share one turn (and its one context line), and
      // replies to different dead messages never merge — the routed-session
      // grouping rule, applied to the fallback.
      return `carry:${r.refId}`;
    case 'room':
      // Per room, never merged with any 1:1 key: this inequality
      // is also half of "rooms QUEUE, never steer" — a room row can never
      // equal a running session/own key at the steer poller.
      return `room:${r.gid}`;
  }
}

/**
 * The host named in a refusal, clamped to the set the hook layer validates.
 *
 * `sess.host` reaches the ledger through `parseHookHost`, so today it is one
 * of four fixed words — but this string is about to be interpolated into a
 * message sent to the operator's phone, and "the writer validates it" is the
 * assumption that makes an echo a channel the day some other path writes a
 * ledger row. Anything unrecognised becomes "another host", which loses the
 * operator nothing: the tag in the same sentence is what identifies the
 * session, and the remedy is the same either way.
 */
function namedHost(host: string): string {
  return (HOOK_HOSTS as readonly string[]).includes(host) ? host : 'another host';
}

/**
 * The per-host argv, the startup-refusal table and its classifier, and the
 * recovery/observation logic all live with the DRIVERS now
 * (attend-drivers.ts) — host property, behind one `HostDriver` seam, so a
 * codex failure can never again be classified by claude's refusal table.
 * `turnArgv` is re-exported because it is the surface the session-argv gate
 * proves both hosts' shapes through; the supervisor itself never builds an
 * argv again.
 */
export { turnArgv } from './attend-drivers.js';

/**
 * A recognised STARTUP refusal, or null. The three measured sentences, their
 * provenance record and the classifier are claude's driver's
 * (attend-drivers.ts `HOST_REFUSALS`); the type stays here because
 * `hostExplanation` speaks it.
 */
export type HostRefusal = 'session-exists' | 'no-conversation' | 'live-session' | null;

/** Any UUID-shaped token, to be swapped for its session tag before a host
 * diagnostic is repeated to the operator. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * WHAT THE HOST ITSELF SAID, ready to be repeated back.
 *
 * The failure reply used to be `The turn failed (exit N)` and nothing else,
 * which hands the operator a number and keeps the sentence that would have
 * told them what to do. Every line worth having is right there in the child's
 * output; it just had to survive to the reply.
 *
 * stdout first, stderr second: when a turn ran and then failed, its own words
 * are on stdout. When it never started, stdout is empty and the diagnostic is
 * on stderr. Taking the first non-empty of the two gets both cases without
 * guessing which failure this was.
 *
 * RAW SESSION IDS ARE REDACTED TO THEIR TAG. Two of the three refusals quote
 * the session UUID, and hooks.ts:504 already holds this line for exactly the
 * same text — the tag is what the operator sees on every notification, so it
 * is also the more useful of the two to read. The caller still funnels the
 * result through `plainForChat`/`capChatHead` like every other reply; nothing
 * here is a second, private path to the operator's phone.
 */
export function hostExplanation(
  stdout: string,
  stderr: string,
  refusal: HostRefusal,
): string {
  // STDERR IS NEVER REPEATED BACK. It was, for one revision, and the reason it
  // is not is measurable: a failing host writes its environment into stderr.
  // A probe of that revision delivered
  //
  //     The turn failed (exit 1): Error: request failed
  //     ANTHROPIC_API_KEY=sk-ant-…  at /Users/…/secrets.ts:42
  //
  // to the operator's phone — a live key and an absolute path out of a private
  // tree, sent because the sentence beside them was useful. Rule 4 does not
  // bend for a helpful diagnostic, and "helpful" is exactly how a secret gets
  // published.
  //
  // What survives instead is (a) stdout, the MODEL's channel, which the
  // success path already sends to the same phone through the same funnel, so
  // it adds no surface; and (b) for a recognised startup refusal, OUR OWN
  // sentence for it — a closed set written here, never the host's text. The
  // operator still learns what to do; the host's stderr never leaves this
  // process.
  if (stdout.trim() !== '') return stdout.trim().replace(UUID_RE, m => sessionTag(m));
  if (refusal === 'no-conversation') return 'that session is gone from this machine.';
  if (refusal === 'session-exists') return 'that session is already open.';
  if (refusal === 'live-session') return 'that session is running right now.';
  return '';
}

interface Bucket {
  windowStart: number;
  turns: number;
}

/**
 * THE UNIT OF EXCLUSION IS THE TURN, AND ITS SCOPE IS THE ACCOUNT.
 *
 * `takeTurnToken` below locks the COUNTER, which was the wrong noun. Two
 * passes — the supervised unit plus a hand-run `attend run` during setup, or
 * two units after a botched install — each took a legitimately distinct token
 * from a correctly serialized budget, and then both walked into the same
 * pending rows, because nothing downstream of the counter was serialized at
 * all. The cursor advances only at the END of a pass, so until the first pass
 * finishes, `pendingRows` returns the same batch to everybody: the operator
 * gets two answers to one message and the agent executes it twice. A budget
 * that counts turns correctly while the turns duplicate each other is a
 * counter, not an exclusion.
 *
 * THE ACCOUNT is the scope because it is exactly the set of state a pass
 * mutates: the cursor, the journal, the bucket and the ledger are all
 * `<state>/<account>/` files, and two accounts share none of them — they have
 * different owners, different agent configs and different spools, so
 * serializing them against each other would be a stall with nothing behind it.
 * Narrower than the account does not work either: the cursor is a single
 * watermark over one append-ordered spool, so two passes on one account cannot
 * partition it without one of them advancing past rows the other still owns.
 *
 * THE SECOND PASS DECLINES, QUIETLY. It returns `busy` and sends nothing: the
 * pass that holds the lock is already answering these rows, so a second reply
 * would be the duplicate this lock exists to prevent, and an error would put a
 * supervised loop into a restart cycle over its own healthy sibling. It is
 * also why the wait is a second rather than `LOCK_WAIT_MS` — a turn can run
 * for minutes, and queueing behind one to do work that will already be done is
 * strictly worse than standing down and looking again on the next poll.
 */
const turnLockPath = (account: string): string => join(stateDir(account), 'attend-turn.lock');

/**
 * Long enough to clear the lock's doorway protocol (25ms polls), short enough
 * that declining is instant on the human scale. Not sized to outlast a turn:
 * outlasting a turn is what this caller must NOT do.
 */
const TURN_LOCK_WAIT_MS = 1_000;

/**
 * The hourly turn budget, taken UNDER A LOCK: read-modify-write on a shared
 * counter is the oldest race there is, and two attend passes (a supervised
 * unit plus a hand-run loop during setup, say) would each read N, each write
 * N+1, and the ceiling the operator set would quietly become no ceiling.
 * The gate's last living act before its filter killed it was a repro of
 * exactly this with twelve concurrent readers. v1 runs one loop, so this
 * was theoretical — a budget that is only correct when nobody races it is
 * not a budget.
 *
 * KEPT even though the turn lock above now serializes every pass that reaches
 * it: this is the only guard on `takeTurnToken` called directly (the gate's
 * eight-process repro does exactly that), the two locks nest in one order
 * everywhere — turn, then bucket — so they cannot deadlock against each other,
 * and a budget that depends on a caller holding some other lock first is a
 * budget with an unwritten precondition.
 */
export function takeTurnToken(account: string, cfg: AttendConfig, now: number): boolean {
  return withFileLock(join(stateDir(account), 'attend-bucket.lock'), () => {
    const b = loadJson<Bucket>(bucketPath(account)) ?? { windowStart: now, turns: 0 };
    const fresh = now - b.windowStart >= 60 * 60 * 1000 ? { windowStart: now, turns: 0 } : b;
    if (fresh.turns >= cfg.turnsPerHour) return false;
    fresh.turns += 1;
    writeFileAtomic(bucketPath(account), JSON.stringify(fresh), { mode: 0o600 });
    return true;
  });
}

/**
 * The refund for a PROVABLY undelivered steer, and for nothing else. The token is taken BEFORE `turn/steer` leaves — the brake binds
 * before the side effect, like every write order in this file — so the one
 * honest correction is the case where the server itself answered that
 * nothing was delivered (the measured -32600 error frame; by the same
 * rule, any error frame). A crash in the gap leaves the token spent: a
 * budget that over-counts by one is a brake erring in its own direction. The
 * freshness check mirrors `takeTurnToken`'s so a refund can never reach into
 * a window the charge was not made in; same lock, same nesting (turn, then
 * bucket).
 */
function refundSteerToken(account: string, now: number): void {
  withFileLock(join(stateDir(account), 'attend-bucket.lock'), () => {
    const b = loadJson<Bucket>(bucketPath(account));
    if (b === null || !Number.isFinite(b.windowStart) || !Number.isFinite(b.turns)) return;
    if (now - b.windowStart >= 60 * 60 * 1000 || b.turns <= 0) return;
    writeFileAtomic(bucketPath(account), JSON.stringify({ ...b, turns: b.turns - 1 }), {
      mode: 0o600,
    });
  });
}

/**
 * How much of the child's stderr is kept. The HEAD, because every refusal
 * this file acts on is printed at startup, and because `capChatHead` keeps
 * the head too — so what survives the bound is what would survive the funnel
 * anyway. The bound exists at all so a chatty host cannot grow attend's
 * heap one warning at a time across a long turn.
 */
const STDERR_KEEP = 16 * 1024;

async function realRunTurn(
  bin: string,
  argv: string[],
  cwd: string,
  prompt: string,
  env?: Readonly<Record<string, string>>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    let child;
    try {
      // The driver names only the DELTA (codex's CODEX_HOME); it is merged
      // over the inherited environment here because node's `spawn` treats
      // `env` as the WHOLE environment — handing the child only the delta
      // would strip PATH and HOME and fail in a way that reads as the
      // host's fault. No env means inherit unchanged, which is what every
      // pre-isolation spawn did.
      child = spawn(bin, argv, {
        cwd,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // `spawn` THROWS SYNCHRONOUSLY — it does not emit 'error' — for an argv
      // or cwd it cannot hand to execve; a NUL byte anywhere in one is the
      // reachable case, and `caps` is a verbatim operator array that no shape
      // rule guards. Left to escape, the throw rejects this promise, unwinds
      // out of `attendOnce` AFTER the turn token was taken and BEFORE the
      // cursor advanced, and lands in `attendLoop`'s transient catch — so the
      // same poisoned batch retook a token every pass and spent the whole
      // hourly budget in under a minute, silently. Reported as 127, the code
      // that already means "this binary could not be launched": the operator
      // gets the honest reply, the cursor advances, and the batch is answered
      // once instead of forever.
      resolve({ stdout: '', stderr: '', code: 127 });
      return;
    }
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += String(d)));
    // Kept, not discarded: this is the channel the host answers a bad session
    // argument on, and dropping it was why the only actionable line the
    // operator could have been given never left the process.
    child.stderr.on('data', d => {
      if (err.length < STDERR_KEEP) err += String(d).slice(0, STDERR_KEEP - err.length);
    });
    child.on('error', () => resolve({ stdout: '', stderr: '', code: 127 }));
    child.on('close', code => resolve({ stdout: out, stderr: err, code: code ?? 1 }));
  });
}

/**
 * The REAL duplex session (`AttendIo.session`'s default): one line-framed
 * child for the app-server driver. Exported for the live gate
 * (gate.codex-appserver.test.ts), which drives the real binary through the
 * real client through exactly this seam.
 *
 * STDERR IS DRAINED AND DISCARDED — the quarantine, structural again. The
 * exec seam keeps a bounded head because claude's startup refusals live
 * there; the app-server driver classifies nothing from stderr (codex has no
 * measured refusal table), so nothing is kept, and what is never stored can
 * never be repeated to a phone (the incident `hostExplanation` records).
 * Frames arrive on stdout; stderr here is rust log noise and MCP worker
 * chatter (measured in every capture).
 *
 * `kill` is stdin-EOF plus SIGTERM, then the 'close' event reports the exit
 * — the spike harness shut its child down exactly this way and the exit was
 * observed every run. SIGKILL was considered and not chosen: codex appends
 * its rollout JSONL as the turn runs, and the graceful path lets it flush,
 * which is what `thread/resume` continuity reads later.
 */
export function realSession(
  bin: string,
  argv: string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): SessionHandle {
  let onLine: ((line: string) => void) | undefined;
  let onExit: ((code: number | null) => void) | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, argv, {
      cwd,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // The same sync-throw arm as `realRunTurn`, the same 127 meaning:
    // nothing launched. The exit is reported on a microtask so the caller
    // has registered its handler by the time the news lands.
    return {
      write: () => {},
      onLine: () => {},
      onExit: cb => queueMicrotask(() => cb(127)),
      kill: () => {},
    };
  }
  child.stdin?.on('error', () => {});
  let buf = '';
  child.stdout?.on('data', d => {
    buf += String(d);
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line !== '') onLine?.(line);
    }
  });
  child.stderr?.resume(); // drained, never stored — see the header
  child.on('error', () => onExit?.(127));
  child.on('close', code => onExit?.(code));
  return {
    write: line => {
      child.stdin?.write(line + '\n');
    },
    onLine: cb => {
      onLine = cb;
    },
    onExit: cb => {
      onExit = cb;
    },
    kill: () => {
      try {
        child.stdin?.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

/** What one pass did. */
export type AttendOutcome =
  | 'idle'
  | 'answered'
  | 'asked'
  | 'ended'
  | 'throttled'
  | 'failed'
  /** Another pass holds this account's turn lock; this one stood down. */
  | 'busy'
  /** A journalled turn never reported back. Not re-run — see `readJournal`. */
  | 'interrupted'
  /** The routed session belongs to a host attend cannot drive. */
  | 'unroutable'
  /** A consumed approval-answer row stepped over — a parked pass already
   * acted on it, the way a spent journal is dropped. Nothing sent. */
  | 'stepped'
  /** A reply named an approval that is settled or lapsed: answered honestly,
   * no turn, no token — a late answer is a conversation, not a rebind. */
  | 'approval-stale'
  /** The head row answers a LIVE MCP-parked ask (`tacendum mcp --ask-owner`,
   * mcp-ask.ts): the parked tool call is its consumer, so no turn, nothing
   * sent, and the cursor holds until the park claims the row (it becomes a
   * stepped-over covered row) or the ask's deadline frees it. */
  | 'mcp-parked';

/** What was handed to a turn that had not finished when the journal was
 * last written — the LIVE-TURN view of the journal file. */
interface Journal {
  upTo: string;
  startedAt?: number;
}

/**
 * The journal FILE, whole. The live-turn half (`upTo`/`startedAt`)
 * keeps `readJournal`'s at-most-once contract below; steering adds two id lists
 * that must SURVIVE the turn they were written under, because the rows they
 * name sit PAST the cursor (they arrived mid-turn) and the cursor is never
 * touched mid-turn:
 *
 *   steered  rows a mid-turn steer CONSUMED — each id written BEFORE its
 *            `turn/steer` left the process, so a crash in the gap reads as
 *            maybe-delivered and the row is never re-run (the interrupted
 *            sentence names it instead). A `{turnId}` result keeps the id
 *            (consumed); the measured -32600 error is PROVABLY undelivered
 *            and un-journals it, so the row queues and re-presents exactly
 *            once. Later passes step over a journalled id exactly as they
 *            step over an approval-spent row.
 *   midTurn  rows that ARRIVED while a turn ran and were not steered —
 *            queued by cursor as ever, and the next pass's prompt marks
 *            them (`MID_TURN_MARKER`) so the agent knows the words predate
 *            its turn.
 *
 * Both lists are pruned to the still-pending set whenever the file is
 * rewritten: an id behind the cursor is spent, the same collapse a spent
 * `upTo` gets.
 */
interface JournalFile {
  upTo?: string;
  startedAt?: number;
  steered?: string[];
  midTurn?: string[];
  /**
   * A room reply's PARTIAL FAN-OUT DEBT: legs that failed, written
   * BEFORE the owner's 1:1 notice leaves and cleared after it lands, so a
   * crash in the gap still tells the owner on the next pass — never
   * silence, and NEVER a retry loop (a refused leg burned its tokens by
   * design; only the owner can decide a resend). AT-LEAST-once, honestly: a
   * crash after the notice but before the clear repeats the sentence on
   * restart, the cheap direction (the settle comment holds the argument).
   * Raw ids are fine HERE (0600 state, the steered list's own rule);
   * anything operator-facing derives `sessionTag` from the gid.
   */
  roomDebt?: { gid: string; failed: string[]; skipped: number; at: number };
  /**
   * The STREAMING TURN'S DURABLE ANCHOR — the wire msgId of the one
   * banner the turn's first chunk minted, journalled BEFORE any `x.edit`
   * intermediate leaves the process (the crash-direction rule: an anchor
   * nobody journalled freezes at its opening words with only the honest
   * interrupted NEW message to follow; an anchor on the journal gets the
   * interrupted sentence AS ITS FINAL EDIT — never a stuck bubble). Cleared
   * when the turn's durable final lands, and retired by every settle path
   * like the live-turn half. Raw msgId is fine HERE (0600 state, the
   * steered list's own rule); it is never printed anywhere.
   */
  streamAnchor?: string;
}

/**
 * THE JOURNAL IS NOW READ, AND WHAT IT SAYS IS "DO NOT RE-RUN THIS".
 *
 * It was written before every spawn and read by nothing — dead bytes under a
 * header claiming "the cursor advances only after the journal records the
 * batch as finished", which no code did. The behaviour that actually shipped:
 * attend journals the batch, spawns, and is killed mid-turn (a laptop lid, a
 * `launchctl kickstart -k`, an OOM); on restart the cursor still points BEFORE
 * those rows, so `pendingRows` hands them back and the agent runs them again.
 *
 * The old comment called that safe — "idempotent by msgId". It is not. msgId
 * idempotency is a property of MESSAGE DELIVERY, and what is being repeated
 * here is an AGENT TURN: a process that writes files, runs commands and pushes
 * branches. Re-running one is not a retry, it is a second execution of
 * something that may have half-finished, and attend's whole risk surface is
 * that turns have effects.
 *
 * So an interrupted turn is answered, not repeated: at-most-once for
 * execution, always-once for the reply. The operator is told the turn was
 * interrupted and can re-send if they want it re-run — which is a decision
 * only they can make, because only they know whether the half that ran was the
 * dangerous half.
 *
 * ORDERING: the cursor advances BEFORE the journal is cleared. The other order
 * loses — clear-then-advance leaves a window where a crash re-presents the
 * batch with no journal to explain it, which is the bug this fixes. This order
 * only risks a journal that outlives its rows, and a journal whose `upTo` is
 * already behind the cursor is recognised as spent and dropped silently.
 */
function readJournal(account: string): Journal | null {
  const j = loadJson<JournalFile>(journalPath(account));
  return typeof j?.upTo === 'string' && j.upTo !== ''
    ? { upTo: j.upTo, ...(typeof j.startedAt === 'number' ? { startedAt: j.startedAt } : {}) }
    : null;
}

/** The loose read every steer-journal consumer shares: a file that does not load is
 * an empty journal, and each list is an array or it is nothing. */
function readJournalFile(account: string): JournalFile {
  const j = loadJson<JournalFile>(journalPath(account));
  if (j === null || typeof j !== 'object') return {};
  const debt = j.roomDebt;
  const debtOk =
    debt !== undefined &&
    typeof debt === 'object' &&
    typeof debt.gid === 'string' &&
    Array.isArray(debt.failed);
  return {
    ...(typeof j.upTo === 'string' && j.upTo !== '' ? { upTo: j.upTo } : {}),
    ...(typeof j.startedAt === 'number' ? { startedAt: j.startedAt } : {}),
    ...(Array.isArray(j.steered)
      ? { steered: j.steered.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(Array.isArray(j.midTurn)
      ? { midTurn: j.midTurn.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof j.streamAnchor === 'string' && j.streamAnchor !== ''
      ? { streamAnchor: j.streamAnchor }
      : {}),
    ...(debtOk
      ? {
          roomDebt: {
            gid: debt.gid,
            failed: debt.failed.filter((v): v is string => typeof v === 'string'),
            skipped: typeof debt.skipped === 'number' ? debt.skipped : 0,
            at: typeof debt.at === 'number' ? debt.at : 0,
          },
        }
      : {}),
  };
}

/** Write the whole file, or remove it when nothing meaningful remains — a
 * journal that says nothing must not exist to be misread. */
function writeJournalFile(account: string, f: JournalFile): void {
  const empty =
    f.upTo === undefined &&
    (f.steered?.length ?? 0) === 0 &&
    (f.midTurn?.length ?? 0) === 0 &&
    f.roomDebt === undefined &&
    f.streamAnchor === undefined;
  if (empty) {
    try {
      rmSync(journalPath(account), { force: true });
    } catch {
      // Inert if it survives: every reader prunes ids behind the cursor and
      // drops a spent upTo, so a stuck file costs comparisons, not truth.
    }
    return;
  }
  writeFileAtomic(
    journalPath(account),
    JSON.stringify({
      ...(f.upTo !== undefined ? { upTo: f.upTo } : {}),
      ...(f.startedAt !== undefined ? { startedAt: f.startedAt } : {}),
      ...((f.steered?.length ?? 0) > 0 ? { steered: f.steered } : {}),
      ...((f.midTurn?.length ?? 0) > 0 ? { midTurn: f.midTurn } : {}),
      ...(f.roomDebt !== undefined ? { roomDebt: f.roomDebt } : {}),
      ...(f.streamAnchor !== undefined ? { streamAnchor: f.streamAnchor } : {}),
    }),
    { mode: 0o600 },
  );
}

/**
 * JOURNAL-FIRST: the steered row id lands on disk BEFORE the
 * `turn/steer` frame leaves the process. The write order is the whole crash
 * contract — a death in the gap reads as maybe-delivered, which the
 * interrupted sentence reports and no pass ever re-runs. Preserves every
 * other field: the live turn's `upTo` is exactly what makes the restart
 * find this list.
 */
function noteSteered(account: string, id: string): void {
  const f = readJournalFile(account);
  const steered = f.steered ?? [];
  if (!steered.includes(id)) steered.push(id);
  writeJournalFile(account, { ...f, steered });
}

/** The -32600 arm: PROVABLY undelivered (measured — zero items injected), so
 * the id comes back off the journal and the row queues, re-presenting
 * exactly once as the ordinary message it still is. */
function unnoteSteered(account: string, id: string): void {
  const f = readJournalFile(account);
  writeJournalFile(account, { ...f, steered: (f.steered ?? []).filter(v => v !== id) });
}

/**
 * Retire the live-turn half and prune both id lists to the rows that are
 * STILL PENDING (`keep`) — the one write shape every journal-settling path
 * shares, so none of them can invent a second retention rule. `add` merges
 * ids learned this pass (delivered steers; fresh mid-turn arrivals) before
 * the prune, because a list intersected before it is merged loses the very
 * ids the pass just learned.
 */
function settleJournal(
  account: string,
  keep: ReadonlySet<string>,
  add: { steered?: string[]; midTurn?: string[] } = {},
): void {
  const f = readJournalFile(account);
  const steered = [...new Set([...(f.steered ?? []), ...(add.steered ?? [])])].filter(id =>
    keep.has(id),
  );
  const midTurn = [...new Set([...(f.midTurn ?? []), ...(add.midTurn ?? [])])].filter(id =>
    keep.has(id),
  );
  // The room-fanout debt survives the retirement untouched: it is settled by
  // ITS OWN once-only notice (the debt sweep at pass start), never by the
  // cursor — the ids it names are member ids, not spool rows.
  writeJournalFile(account, {
    steered,
    midTurn,
    ...(f.roomDebt !== undefined ? { roomDebt: f.roomDebt } : {}),
  });
}

/**
 * ---------------------------------------------------------------------------
 * THE APPROVAL SPINE — one approval, plain text, answered
 * by an ordinary reply, proven against a fake approving driver because
 * neither shipped driver can produce one. What blocked approvals was never
 * the drivers; it was that attend could not RECEIVE an answer: carriers never
 * spool, the log accepts only conversational kinds, attend's own sends wrote
 * no routable ledger row, and the pass that parks holds the turn lock. The
 * spine closes the receive path; the drivers plug in behind it.
 * ---------------------------------------------------------------------------
 */

/** What a driver hands the supervisor when its host wants one action
 * approved. The PAYLOAD is the exact bytes the host will execute — quoted to
 * the operator verbatim or not at all (see `composeApprovalPrompt`). */
export interface ApprovalAsk {
  payload: string;
  /** Proposed TTL; the supervisor clamps it — the TTL clock is the
   * supervisor's, like the funnel and the journal. */
  ttlMs?: number;
  /** Which request family is asking. `edit:` is only honest for a command —
   * a diff cannot be edited from a phone — so the loop must know which it
   * holds; absent (an older driver, the spine's fakes) fails closed: not a
   * command, not editable. */
  kind?: 'commandExecution' | 'fileChange';
  /** The host session the asking turn runs as, when the DRIVER already knows
   * one mid-turn (the app-server thread id — `turnSess` cannot know it, the
   * key arrives on a frame after the route was decided). Gated through
   * `hostSessionKey` before anything trusts it; it rides the card's ledger
   * row, which is what lets a `respond:` answer route back to the very
   * thread that asked instead of to `ended`. */
  sessionKey?: string;
}

/**
 * What a driver can be TOLD, whole — and it is still two words. `edit:` and
 * `respond:` exist as OPERATOR verbs now (the ask loop parses them),
 * but both resolve to `deny` at this seam, because that is all the measured
 * protocol admits: codex's decision enum has no "run this other command
 * instead" member (the vendored-type note in codex-appserver.ts carries the
 * measurement), and no decision carries text. The verbs' extra meaning is
 * the SUPERVISOR's — a superseded journal row, a steering message on the
 * spool — never a wider grant. FAIL CLOSED: anything that is not exactly a
 * known verb is never read as approval.
 */
export type ApprovalDecision = 'approve' | 'deny';

/**
 * TTL bounds, in milliseconds, all on the CLI's clock — the CLI executes, so
 * the CLI's clock decides (nothing on the wire is a clock; the phone's
 * countdown, if one ever ships, is display only).
 *
 * The FLOOR is a wake-cap fact, not taste: pushMessagePair is 4/min per pair,
 * so an approval whose TTL is shorter than a queued push's delay cannot
 * honestly be answered from a phone. The CEILING is an hour — past that the
 * host's turn is very likely gone and the card is a lie (the ceiling is a
 * bet on unmeasured park behaviour, and says so). The
 * DEFAULT sits well inside both: long enough for a push, a pocket and a
 * human, short enough that a wedged host is answered within the hour.
 * MANDATORY from this commit: with no capability negotiation anywhere, a
 * parked turn with no TTL is a wedged agent with nothing on screen.
 */
export const APPROVAL_TTL_MIN_MS = 30_000;
export const APPROVAL_TTL_MAX_MS = 3_600_000;
export const APPROVAL_TTL_DEFAULT_MS = 10 * 60_000;

/** The poll cadence a parked pass waits on — the loop's own 2 s, reused so
 * the park is never a second, faster reader of the same spool. Exported for
 * the typing-cadence arithmetic test, which asserts the CONSTANTS' relation
 * (the frozen-clock rule forbids proving it on wall time). */
export const ATTEND_POLL_MS = 2_000;

/**
 * Typing chatter, the CLI half: while a 1:1
 * turn runs, attend says so the way a composing human does — the app's
 * `x.typing` frame, minted through the CLI's own ratchet and sent as the
 * relay-only `typing` wire frame the server never stores.
 *
 * THE RECEIVER'S CONTRACT (app/src/typing.ts, read 2026-08-14, mirrored
 * below because the app package is not importable from here): the phone
 * expires an indicator on its own at TYPING_EXPIRY_MS = 15 000 ms, so a
 * lost `stop` — a crashed CLI, a dropped frame — needs no repair from this
 * side; refresh-under-expiry is the only invariant a sender owes.
 *
 * THE CADENCE MATH, all constants, provable without a clock:
 *  - refresh threshold 7 500 ms ≈ half the app's 15 000 ms expiry;
 *  - the loop ticks every ATTEND_POLL_MS, so the WORST refresh gap is
 *    ATTEND_TYPING_REFRESH_MS + ATTEND_POLL_MS = 9 500 ms < 15 000 ms —
 *    a live turn's indicator never flickers;
 *  - the server's bucket (`LIMITS.typing`, packages/server/src/ratelimit.ts:
 *    15 burst, 3/s sustained, keyed typing:<sender>) sees at most one frame
 *    per 7 500 ms ≈ 0.134/s — 22× under sustained refill — plus one `stop`
 *    at turn end against a 15-token burst. Typing frames spend NOTHING
 *    else server-side: handleTyping draws neither wsSend nor the
 *    integration `intsend` bucket, and on this side they spend no attend
 *    turn token and touch no approval machinery — chatter below the brake.
 */
export const ATTEND_TYPING_REFRESH_MS = 7_500;
/** The app's receiver-side expiry, mirrored verbatim from
 * app/src/typing.ts `TYPING_EXPIRY_MS` for the arithmetic test above. */
export const APP_TYPING_EXPIRY_MS = 15_000;

/**
 * Stream-edit emission, riding the SAME cadence loop and the same
 * typing-lane budget as the refreshes above — the RATE DECISION
 * is that `integrationSend` STANDS at 30/min and the delta channel is the
 * sealed `x.*` namespace over the relay-only typing lane, so the cadence
 * pins at ONE intermediate per ATTEND_POLL_MS (0.5/s) plus typing refreshes
 * (0.134/s) against the server's 3/s sustained (`LIMITS.typing`) — 4.7x
 * headroom, proven as a constants-only arithmetic test in
 * attend.typing.test.ts (the frozen-clock rule forbids proving it on wall
 * time). Each streamed turn spends exactly TWO integrationSend tokens — the
 * anchor and the durable final — versus one today.
 *
 * THE CAP is the ratchet-burn bound: sealed frames nobody witnessed (an
 * owner offline for a whole turn) become skipped keys their ratchet must
 * absorb, and the worst unwitnessed turn — the cap's edits plus the typing
 * refreshes sharing its span — must stay a small fraction of libsignal's
 * 25 000 forward-jump ceiling (~1.5%; the arithmetic test holds the
 * relation). Past the cap, INTERMEDIATES fall silent — never the durable
 * final, and typing continues: the reply still lands whole.
 */
export const STREAM_EDITS_PER_TURN_MAX = 300;
/**
 * The freshness gate: a turn streams only when the row that
 * triggered it is younger than this — a drained BACKLOG (attend down an
 * hour, ten queued messages) is nobody watching a bubble grow, and
 * streaming it would spend the typing lane and the ratchet on an audience
 * of zero. Ten minutes, the plan's number.
 */
export const STREAM_FRESH_MS = 600_000;

/**
 * One approval, from mint to settlement.
 *
 * THE BINDING IS STRUCTURAL, AND THE HASH IS REFUSED (a deliberate
 * rule — do not revisit without new facts): `requestId` is a
 * single-use CSPRNG id, this record is append-once per field — `payload` is
 * written at mint and NEVER rewritten — and what executes is what is stored
 * under the id, never anything re-read from the host afterwards. That, not a
 * digest, is what makes "an approval applied to a different command"
 * impossible; a digest computed and checked by the same process would sit in
 * the same file a mutation bug would corrupt, and item 6's own rationale
 * ("a digest mismatch is disclosure to a human, never an authorization
 * decision") forbids the one read an approval hash exists for.
 *
 * RULE 4: `payload` lives HERE (0600, under `stateDir` — the same
 * compartment as the spool's plaintext) and on the operator's phone inside
 * the card, and NOWHERE else: never a log line, never an error, never
 * `attend status`. Counts and ages only, everywhere else.
 */
interface ApprovalRow {
  /** This record's own id. */
  id: string;
  /** THE binding: single-use, CSPRNG-minted, burned on lapse. Never reused,
   * never re-bound to a second payload. */
  requestId: string;
  host: string;
  /** The host session the asking turn ran as, where one exists. The raw key
   * is journal-only (this file is the same compartment as the ledger's
   * `sess.key`); anything operator-facing derives `sessionTag` from it. */
  sessionKey?: string;
  /** The exact bytes the host will execute. Written once; purged to `bytes`
   * by retention after settlement, exactly as the spool redacts. */
  payload: string;
  /** UTF-8 size of a purged payload — the retention residue, like msglog's. */
  bytes?: number;
  askedAt: number;
  ttlMs: number;
  /**
   * The write order IS the crash contract — each boundary chosen so a crash
   * lies in the safe direction (`readJournal`'s at-most-once argument, one
   * level down):
   *   asking     written BEFORE the request leaves the process — a crash
   *              between send and journal would leave a card on a phone that
   *              nothing can answer;
   *   pending    after the send: `msgId` is the row the phone will reply-ref;
   *   answering  decision recorded BEFORE it reaches the host — the host call
   *              is the side-effecting one;
   *   done       the host acknowledged (the turn that carried the ask
   *              reported back);
   *   lapsed     restart found the row in-flight. Measurement showed a crash
   *              parks NOTHING host-side, so the pending callback is dead by
   *              definition: the id is burned, the operator is told once, and
   *              a late answer naming it is answered honestly and NEVER
   *              re-bound;
   *   superseded an `edit:` displaced it. The wire saw a plain
   *              decline — the measured decision enum admits no substitute
   *              command (codex-appserver.ts) — but the journal names what
   *              actually happened, because a state that read `done` would
   *              claim the operator ANSWERED the request they in fact
   *              replaced. The id is burned exactly as a lapse burns one: a
   *              late answer naming it approves nothing, ever.
   */
  state: 'asking' | 'pending' | 'answering' | 'done' | 'lapsed' | 'superseded';
  /**
   * WHICH FORM the ask left in: `card` is the `x.approval`
   * envelope behind the attested floor, `text` the plain prompt.
   * Recorded so the TTL and lapse sentences can say the right thing — a
   * card that never rendered (an older build than attested) has the TTL
   * deny as its ONLY signal, and that sentence must name the possibility.
   * Absent (a prior row) reads as `text`, the form those rows left in.
   */
  form?: 'text' | 'card';
  /** The wire id of the sent prompt — what the phone's reply will `ref`. */
  msgId?: string;
  decision?: ApprovalDecision;
  /** How the decision arrived: an operator reply, the TTL clock, the
   * over-cap refusal (which denies because it cannot render), an `edit:`
   * (deny + supersede), or a `respond:` (deny + the text runs as the next
   * turn's prompt — the row it names gets a second life as an ordinary
   * message, see `approvalKey`). */
  via?: 'reply' | 'ttl' | 'overcap' | 'edit' | 'respond';
  decidedAt?: number;
  /** The spool row (msgId) whose reply DECIDED this approval. */
  answerId?: string;
  /** Spool rows consumed WITHOUT deciding — unrecognised verbs. Recorded so
   * a later pass steps over them instead of answering them twice. */
  spent?: string[];
  /** The one honest re-ask was sent; further unrecognised verbs are consumed
   * silently rather than becoming a nag loop. */
  reAsked?: boolean;
  settledAt?: number;
}

interface ApprovalFile {
  /**
   * How often the over-cap refusal fired — C11's ongoing measurement. The
   * scoping's payload distribution says most real approvals fit the chat cap;
   * this counter is the cheapest place to find out whether that stays true,
   * and it decides whether attachments land back on the critical path.
   */
  overCapRefusals: number;
  rows: ApprovalRow[];
}

function loadApprovals(account: string): ApprovalFile {
  const raw = loadJson<ApprovalFile>(approvalsPath(account));
  // A file that does not load is an empty journal, not an error — the same
  // collapse `loadAttendConfig` makes, safe here for the same reason: every
  // in-flight row it forgets is answered by the lapse rule the next pass
  // applies, which is the honest outcome for state nobody can read.
  if (raw === null || !Array.isArray(raw.rows)) return { overCapRefusals: 0, rows: [] };
  return {
    overCapRefusals: typeof raw.overCapRefusals === 'number' ? raw.overCapRefusals : 0,
    rows: raw.rows,
  };
}

function saveApprovals(account: string, file: ApprovalFile): void {
  writeFileAtomic(approvalsPath(account), JSON.stringify(file), { mode: 0o600 });
}

/**
 * Read-modify-write, SYNCHRONOUS between read and write, which is what makes
 * concurrent asks inside one pass safe: interleaving happens only at await
 * points, and there are none in here. Cross-process safety is the account
 * turn lock — every writer of this file already holds it (the pass), so the
 * journal never needs a lock of its own. A mutation that changed nothing
 * writes nothing: the sweep runs at the top of EVERY pass, and an idle loop
 * that rewrites an unchanged journal twice a second is churn wearing a
 * durability hat (and would mint the file on accounts that never saw an
 * approval).
 */
function mutateApprovals<T>(account: string, fn: (file: ApprovalFile) => T): T {
  const file = loadApprovals(account);
  const before = JSON.stringify(file);
  const out = fn(file);
  const after = JSON.stringify(file);
  if (after !== before) saveApprovals(account, file);
  return out;
}

function patchApprovalRow(account: string, id: string, patch: Partial<ApprovalRow>): void {
  mutateApprovals(account, file => {
    const at = file.rows.findIndex(r => r.id === id);
    if (at >= 0) file.rows[at] = { ...(file.rows[at] as ApprovalRow), ...patch };
  });
}

/**
 * THE RESTART RULE, and it is the honest one. Any row still in flight when a
 * pass starts belongs to a pass that DIED — the turn lock proves it: a live
 * parked pass holds the lock for the whole park, so a pass that acquired it
 * and finds `asking`/`pending`/`answering` rows is looking at a crash. Measurement
 * showed a crash parks nothing host-side (the model improvises and the
 * host self-exits), so the pending callback is dead by definition: the row
 * becomes `lapsed`, the `requestId` is burned with it, and a late answer
 * naming a burned id is answered honestly and never re-bound. Single-use ids
 * are what make replay impossible without a digest.
 *
 * Retention rides the same sweep, on msglog's own constants rather than a
 * second policy: a settled payload survives at most REDACT_AFTER_MS past
 * settlement (purged to its byte count), and the record itself ages out at
 * RETAIN_MS — a journal of command lines must not outlive the spool whose
 * compartment it shares.
 */
function sweepApprovals(account: string, now: number): { lapsed: number; lapsedCards: number } {
  return mutateApprovals(account, file => {
    let lapsed = 0;
    let lapsedCards = 0;
    for (let i = 0; i < file.rows.length; i += 1) {
      const row = file.rows[i] as ApprovalRow;
      if (row.state === 'asking' || row.state === 'pending' || row.state === 'answering') {
        file.rows[i] = { ...row, state: 'lapsed', settledAt: now };
        lapsed += 1;
        if (row.form === 'card') lapsedCards += 1;
      }
    }
    file.rows = file.rows.filter(r => now - (r.settledAt ?? r.askedAt) < RETAIN_MS);
    for (let i = 0; i < file.rows.length; i += 1) {
      const row = file.rows[i] as ApprovalRow;
      if (
        row.payload !== '' &&
        row.settledAt !== undefined &&
        now - row.settledAt >= REDACT_AFTER_MS
      ) {
        file.rows[i] = { ...row, payload: '', bytes: Buffer.byteLength(row.payload, 'utf8') };
      }
    }
    return { lapsed, lapsedCards };
  });
}

/**
 * The one-tap prompt, composed by ATTEND — never by the model — with the
 * payload quoted VERBATIM. The test for "may this be one-tapped" is byte
 * identity through the chat funnel AT ITS 280 DEFAULT (deliberately NOT the
 * `ATTEND_REPLY_CAP` prose budget — replies widened later, and an
 * authorization surface does not widen because prose did): the composed
 * prompt must come out of `plainForChat` + `capChatHead` exactly as it went
 * in. That covers the 280-char cap AND the harder case the cap alone misses — a payload the chat
 * degrader would ALTER (a leading `#`, a fenced block, inline backticks),
 * which on a phone is a different command wearing the real one's approval
 * buttons. Refusing is the rule B-0 C10 set: never summarise, never
 * truncate, never paraphrase — an over-cap payload gets an honest refusal
 * that names the size, and the refusal counter is C11's measurement.
 */
function composeApprovalPrompt(payload: string, ttlMs: number, note?: string): string | null {
  // The NOTE is attend's own head-of-card sentence: a running
  // count when one turn asks more than once, and the hedged may-not-have-rung
  // line when the wake budget was likely spent. It shares the payload's byte
  // budget on purpose — a note that rode outside the cap would be a second
  // message and a second wake, which is the very scarcity it reports on.
  const head = note === undefined ? 'Approval needed' : `Approval needed (${note})`;
  const composed = `${head} — reply approve or deny (expires in ${fmtAge(ttlMs)}):\n${payload}`;
  return capChatHead(plainForChat(composed)) === composed ? composed : null;
}

/**
 * The CARD form of the same ask: the `x.approval` envelope, composed
 * ONLY behind the operator's attested floor (`AttendConfig.approvalsMinAppBuild`)
 * and validated through the SAME shared schema the app's card parses before it
 * may leave — room-commands' encode invariant, followed: an envelope this build
 * cannot parse cannot be composed by it. The card renders everything the plain
 * prompt said — the payload verbatim in `p`, the verbs in `a`, the deadline in
 * `x` — which is why an attested ask sends the envelope INSTEAD of the text,
 * never both: two messages per ask would spend the wake budget twice and, once
 * the app renders cards, put two answer targets for one authorization on one
 * screen, only one of which the journal's `msgId` can bind.
 *
 * WHY THE TWO FORMS HAVE TWO CAPS, AND WHICH APPLIES WHEN. The TEXT form is
 * bounded by byte-identity through the 280-char chat funnel
 * (`composeApprovalPrompt` — the ask cap, unmoved by the reply lift): what
 * the phone shows is a chat message, so a
 * payload the chat rendering would clip or ALTER cannot be one-tapped. The
 * CARD form has no such degrader — the app renders `p` verbatim, monospace,
 * untransformed — so its bound is the schema's `MAX_APPROVAL_PAYLOAD_BYTES`
 * plus the frame the envelope must actually ride: the whole encoded body is
 * held to `MAX_BODY_BYTES` HERE, before the journal row exists, because
 * the send guard would otherwise refuse it after the ratchet question was
 * already asked. The funnel cap therefore applies to `text` asks, the
 * schema/frame cap to `card` asks; an ask over ITS form's cap gets the same
 * instant deny (`via: 'overcap'`, counted — C11's measurement) either way.
 *
 * Null means "cannot be sent verbatim": in practice an out-of-bounds `p` (the
 * schema's floor of one or its cap) or an encoded body past the frame —
 * every other member is minted or clamped upstream (`q` by our own ULID
 * factory, `x` by the TTL clamp, `s` by `sessionTag`). The running count `n`
 * is worth losing, never the ask: past the schema's 64 it is omitted, the
 * same trade the schema's `k.catch` makes.
 */
function composeApprovalCard(args: {
  requestId: string;
  payload: string;
  ttlMs: number;
  kind?: ApprovalAsk['kind'];
  sessionTag?: string;
  seq: number;
}): string | null {
  const envelope = {
    tcm: 'x.approval' as const,
    q: args.requestId,
    // The wire's request families, from the seam's: the app renders the fixed
    // label; an absent kind (the spine's fakes, an older driver) is `other`.
    k:
      args.kind === 'commandExecution'
        ? ('exec' as const)
        : args.kind === 'fileChange'
          ? ('file' as const)
          : ('other' as const),
    p: args.payload,
    // Seconds on the wire, FLOORED: the phone's countdown is display only,
    // and rounding down is the direction that can never outlive the real
    // deadline on the CLI's clock.
    x: Math.floor(args.ttlMs / 1000),
    ...(args.sessionTag === undefined ? {} : { s: args.sessionTag }),
    // The admissible verbs, declared: exactly what the parked pass consumes
    // (the pair). the `edit:`/`respond:` resolve to deny at the seam
    // and join this array only when a driver can honour them (the schema's
    // own rule on `a`).
    a: ['approve', 'deny'],
    ...(args.seq > 1 && args.seq <= 64 ? { n: args.seq } : {}),
  };
  const parsed = ApprovalRequestEnvelope.safeParse(envelope);
  if (!parsed.success) return null;
  // MARKED BEFORE THE CAP CHECK (the consent remediation's F10): the send
  // wrapper's funnel adds `"ai":true` to every envelope body UNGATED —
  // attested or not — so a guard on the pre-marker bytes was a guard on
  // bytes that never reach the wire. A card composed inside a stale cap
  // then blew `assertBodyWithinCap` INSIDE sendEncrypted, past the graceful
  // `via:'overcap'` deny, with the ratchet question already asked. Marking
  // here is idempotent (the funnel re-marks byte-identically), so the guard
  // and the wire now judge the same bytes.
  const body = markAgentBody(JSON.stringify(parsed.data), false);
  return Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES ? body : null;
}

/**
 * One pass: gather pending rows, run at most ONE turn, reply, advance the
 * cursor. The daemon loop calls this repeatedly; tests call it directly.
 * Returns what happened, for the loop's pacing and the tests' assertions.
 *
 * The whole pass runs under the account's turn lock — see `turnLockPath` for
 * why the lock has to wrap this and not just the counter inside it.
 */
export async function attendOnce(account: string, io: AttendIo = {}): Promise<AttendOutcome> {
  const cfg = loadAttendConfig(account);
  if (!cfg) {
    throw new CliError(
      EXIT.ERROR,
      'attend is not enabled for this account — tacendum attend enable comes first',
      undefined,
      TERMINAL_NOT_ENABLED,
    );
  }
  const profile = loadProfile(account);
  const owner = profile.ownerUserId;
  if (!owner) {
    throw new CliError(
      EXIT.ERROR,
      'attend requires a PAIRED integration — pair it to your phone first',
      undefined,
      TERMINAL_NOT_PAIRED,
    );
  }
  const now = io.now?.() ?? Date.now();

  const got = await tryFileLockAsync(
    turnLockPath(account),
    () => attendPass(account, cfg, owner, now, io),
    TURN_LOCK_WAIT_MS,
  );
  return got.held ? got.value : 'busy';
}

/**
 * THE REPLY CAP: what one attend reply may
 * spend, in UTF-16 code units. A host turn's ANSWER is the product of this
 * loop, and the 280 it used to share with notify pushes kept a push
 * notification's worth of it — chat-honest prose needed room. 2,000 is a
 * long chat message, not a document: BULK output (logs, diffs, files) waits
 * for attachments (B-0), so the cap is a reading budget still, just sized
 * for an answer instead of a headline.
 *
 * Split DELIBERATELY from `HOOK_CHAT_CAP`, never a replacement for it. The
 * rule is explicit: the 280 cap remains for NOTIFY pushes, so hooks
 * and the notify tool keep the default; and the approval ask funnel
 * (`composeApprovalPrompt`) stays on the 280 default too — its
 * verbatim-or-refuse identity check bounds a one-tap authorization surface,
 * which is a different contract from prose and does not widen because prose
 * did.
 *
 * BYTE MATH, so the frame ceiling stays provably clear at the new size:
 * `capChatHead` output at this cap is ≤ 2,000 UTF-16 units (untruncated
 * text is ≤ cap by the early return; every truncation path cuts at
 * `cap - 2` and appends a one- or two-unit marker), and one UTF-16 unit
 * costs at most 3 UTF-8 bytes — BMP U+0800..U+FFFF encode 3 bytes/unit,
 * astral pairs 4 bytes per TWO units (2/unit), and a lone surrogate
 * serialises as U+FFFD (3 bytes). Worst case is therefore 2,000 × 3 =
 * 6,000 bytes. The reply body crosses `sendEncrypted`, which REFUSES (not
 * truncates) past `MAX_BODY_BYTES` = 16,384 on the raw body — and that
 * constant's own contract already budgets the envelope's framing and
 * base64 expansion on top of it — so the funnel's worst case clears the
 * guard with a 10,384-byte margin and can never turn attend's reply path
 * into a refusal.
 */
export const ATTEND_REPLY_CAP = 2000;

/**
 * The mid-turn marker: one supervisor-composed line prefixed to a
 * row's text in the NEXT pass's prompt when the row arrived while the
 * previous turn was still running — the queue saying so instead of letting
 * stale words read as fresh ones. Hosts that can steer deliver such rows
 * mid-turn instead (codex app-server); this line is for the rows that
 * queued — every claude and codex-exec mid-turn arrival, and an app-server
 * arrival the steer predicate refused.
 *
 * BYTE-STABLE THROUGH THE FUNNEL, by construction and pinned by test: no
 * markdown the chat degrader would rewrite, no link shape, no leading list
 * or heading mark, and far under every cap — so wherever this line travels
 * (a prompt an agent may quote back, a reply the funnel then carries) it
 * arrives as exactly these bytes or not at all.
 */
export const MID_TURN_MARKER = '[arrived while the previous turn was running]';

/**
 * The carry context line (the reply-continuation fallback, `Route.kind
 * 'carry'`): ONE supervisor-composed line prefixed to the prompt of a fresh
 * turn that answers a reply whose conversation could not be continued — a
 * sessionless ledger row, or a routed session the host refused at startup.
 * The quoted head is the referenced row's OWN text off the local ledger,
 * through the same funnel every chat head crosses (markdown degraded, 280
 * head-kept), then collapsed to one physical line so the marker stays a
 * marker. Every shipped out-writer stores `text: ''` on purpose ("the row is
 * routing, not truth"), so the no-text form is the common case and says
 * honestly that the words are not on this machine.
 *
 * RULE 4: this line rides INSIDE the prompt to the host, and nowhere else —
 * never a log line, never an audit field, never an error message.
 */
function carryContextLine(refText: string): string {
  const head = capChatHead(plainForChat(refText).replace(/\s+/g, ' ').trim());
  return head === ''
    ? '[replying to an earlier message from this agent; its text was not kept]'
    : `[replying to: "${head}"]`;
}

/**
 * THE SAME-PROCESS SEAL QUEUE (the e2e stream gate's release blocker,
 * scripts/e2e-stream.sh a8): every sealed emission a pass performs for one
 * account — typing refreshes, stream edits, the epilogue stop, and every
 * durable send — is chained through ONE in-process FIFO tail, so no two
 * same-process customers ever reach the ratchet FILE lock concurrently.
 *
 * WHY THE FILE LOCK CANNOT DO THIS JOB ITSELF, and is deliberately untouched:
 * its contended wait is SYNCHRONOUS by design (`Atomics.wait`, 25 ms polls,
 * 10 s budget — lock.ts holds the argument: an async wait would let a second
 * command in the same process interleave with a sync critical section, the
 * thing being prevented). But attend's seals are AWAITED work under the lock
 * (`encryptText` behind `withFileLockAsync`), so a second same-process
 * customer arriving mid-seal froze the event loop the holder needed to
 * finish: same-process contention always burned the whole 10-second budget,
 * then threw, and the emit's catch marked the chatter channel dead for the
 * turn. On the wire: every streamed turn longer than the 7.5 s typing
 * refresh lost its edits after ~2 — `typingTick` and `streamTick` fire
 * DETACHED emits on the same cadence tick — and attend froze 10 s mid-turn,
 * stalling frame processing, approvals and steers with it. The shadow
 * predates streaming: a detached typing refresh could stall an in-flight durable
 * send (an approval card, a reply) the same way.
 *
 * ONE queue per ACCOUNT, at module scope, because a detached chatter emit
 * may still be settling when its pass returns — the next pass's sends must
 * queue behind the straggler, not race it. The map never shrinks; it holds
 * one already-settled tail per account name this process ever attended,
 * which is bounded and inert.
 *
 * FIRE-AND-FORGET SURVIVES: the stored tail swallows every outcome, so a
 * queued chatter emit that fails still just dies silently for the turn
 * (never fails the turn, never leaks) and never poisons the queue; the caller's own handle keeps
 * the rejection, so awaited customers — the anchor, the cards, the replies —
 * observe their failures exactly as before. ORDERING falls out of the FIFO
 * and is pinned by test (attend.seal-contention.test.ts): anchor before the
 * first edit, edits in seq order, the durable final after the last
 * intermediate.
 *
 * EVERY sealed emission in this file MUST ride this queue — a new call site
 * that seals outside it reopens the freeze. The room fan-out stays direct on
 * purpose: a room turn mints no typing channel and arms no stream, so a room
 * pass has no detached emission of its OWN for its sends to collide with.
 *
 * CROSS-PASS, that exception is safe for three reasons TOGETHER, and it
 * needs all three (the drain leg is pinned by
 * attend.seal-contention.test.ts):
 *  (1) a pass DRAINS the queue before it returns — every 1:1 turn-end path
 *      awaits a durable send THROUGH this FIFO, so any straggling detached
 *      emit has sealed before the pass's last send resolves;
 *  (2) the cadence loop's epilogue `close()`s the typing channel, so an
 *      emit that somehow outlived the drain finds a dead channel and seals
 *      nothing;
 *  (3) the one unwind that skips the drain — a pass CRASHING between a
 *      detached emit and its turn-end send — leaves a straggler whose seal
 *      completes in milliseconds, while the next pass (the earliest
 *      possible room fan-out) is a poll cadence ≥ 2 s away.
 * Remove any leg — a turn-end path that stops awaiting its send, an
 * epilogue that stops closing, a sub-second pass cadence — and the room
 * fan-out must join the queue like everything else.
 */
const sealQueues = new Map<string, Promise<void>>();
function enqueueSealed<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const tail = sealQueues.get(account) ?? Promise.resolve();
  // The stored tail never rejects (swallowed below), so `then(fn)` runs fn
  // unconditionally, strictly after every earlier customer settled.
  const run = tail.then(fn);
  sealQueues.set(
    account,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** The pass itself. Called only with the account's turn lock held. */
async function attendPass(
  account: string,
  cfg: AttendConfig,
  owner: string,
  now: number,
  io: AttendIo,
): Promise<AttendOutcome> {
  // The reply funnel — the same exfil-bandwidth throttle every hook body
  // crosses, at the reply budget (`ATTEND_REPLY_CAP`) instead of the
  // notify one. Applied to EVERYTHING attend sends, including its own excuses
  // and, now, the host's own diagnostics: there is ONE way out of this
  // function to the operator's phone, and it goes through here. `sess` rides
  // it so the transport can write the ledger row that makes a reply routable.
  //
  // EVERY SEND'S INSTANT IS RECORDED, because the wake budget
  // is per-pair and finite: the server rings the phone at most 4 times a
  // minute for this pair (pushMessagePair), so the 5th send in a minute
  // delivers silently. Attend cannot READ that server-side counter — and it
  // cannot see the pair's other senders (hook notifications, a sibling
  // listener) or its own previous pass — so what this array supports is a
  // HEDGE, never a claim: an ask composed after 4+ of our own sends inside
  // 60 s carries "may not have rung", which is true whether or not the
  // server actually suppressed the wake. The under-count is the honest
  // direction; an over-claim would train the operator to distrust the note.
  const sentAt: number[] = [];
  const rawSend =
    io.sendReply ??
    ((body: string, sess?: OutSess, opts?: { notify?: boolean }) =>
      realSendReply(account, body, sess, opts));
  // THE ART. 50 MARKER, applied at the ONE way
  // out: every durable body this pass sends — replies, excuses, edit
  // finals, approval cards — crosses `markAgentBody` here, BEFORE the seam,
  // so a fake transport observes exactly what the wire would carry and the
  // coverage pin (gate.ai-origin.test.ts) can hold "no compose path
  // escapes" against this line. Envelope bodies gain `ai:true` ungated;
  // bare text wraps into the `msg` kind only under the operator's
  // attestation (the same fail-closed shape rule the stream arm uses).
  const markerArmed = markerShapeOk(cfg.markerMinAppBuild);
  const send = async (
    body: string,
    sess?: OutSess,
    opts?: { notify?: boolean },
  ): Promise<string | void> => {
    sentAt.push(io.now?.() ?? Date.now());
    const marked = markAgentBody(body, markerArmed);
    // Through the seal queue: a durable send must never reach the ratchet
    // file lock while a same-process detached chatter emit holds it — and
    // the queue is also what puts the durable final strictly after the last
    // queued intermediate (see `enqueueSealed`).
    return enqueueSealed(account, () => rawSend(marked, sess, opts));
  };
  const funnel = (text: string): string => capChatHead(plainForChat(text), ATTEND_REPLY_CAP);
  const reply = async (text: string, sess?: OutSess): Promise<void> => {
    await send(funnel(text), sess);
  };

  // THE LAPSE SWEEP RUNS FIRST, before the batch is even read: a card may be
  // sitting on a phone with no message pending here, and the operator is owed
  // the sentence exactly once — the mark below is what makes the once true,
  // because a later pass finds nothing in flight and says nothing.
  const swept = sweepApprovals(account, now);
  if (swept.lapsed > 0) {
    // The noun follows the journal's `form`: a lapsed CARD is a
    // card on a phone that will only grey out at its local deadline, and the
    // sentence naming it should name the thing the operator is looking at.
    // Mixed or plural stays the plain word — the remedy is identical.
    const noun = swept.lapsed === 1 && swept.lapsedCards === 1 ? 'approval card' : 'approval';
    await reply(
      swept.lapsed === 1
        ? `An ${noun} lapsed while attend was restarting — nothing was approved and the ` +
            'turn did not continue. Ask again if you still want it.'
        : `${swept.lapsed} approvals lapsed while attend was restarting — nothing was ` +
            'approved and the turns did not continue. Ask again if you still want them.',
    );
  }

  // THE ROOM-FANOUT DEBT, told AT LEAST once and never silently dropped
  // (the rule is never-silence, never a leg retry): the debt is
  // written BEFORE the notice leaves and cleared AFTER — this shared settle
  // is the one implementation, so a crash between fan-out and notice
  // re-presents the debt here, at the next pass. Clear-after-send is the
  // deliberate half of that: a crash between the notice and the clear
  // repeats one advisory sentence on restart, and that duplicate is the
  // CHEAP direction — the other order risks a debt the owner never hears
  // of, which is the silence this exists to kill. NEVER a retry of the
  // legs themselves: a refused leg burned its tokens by design, and only
  // the owner can decide a resend. Rule 4: the room reaches the phone as
  // its `sessionTag`, never the raw gid.
  const settleRoomDebt = async (debt: NonNullable<JournalFile['roomDebt']>): Promise<void> => {
    const missed = debt.failed.length + debt.skipped;
    await reply(
      `A reply I posted in a room (${sessionTag(debt.gid)}) did not reach ${missed} ` +
        `member${missed === 1 ? '' : 's'}. It was not re-sent — post it in the room again ` +
        'if you want everyone to see it.',
    );
    const f = readJournalFile(account);
    delete f.roomDebt;
    writeJournalFile(account, f);
  };
  const owedDebt = readJournalFile(account).roomDebt;
  if (owedDebt !== undefined) await settleRoomDebt(owedDebt);

  const batch = pendingRows(account, owner);
  const batchIds = new Set(batch.map(r => r.id));
  if (batch.length === 0) {
    // A journal with nothing left to cover is spent: its rows — the turn's
    // own AND any steered/mid-turn ids — are already behind the cursor, so
    // the turn it named did finish and nothing it lists is still owed.
    const spentFile = readJournalFile(account);
    if (
      spentFile.upTo !== undefined ||
      (spentFile.steered?.length ?? 0) > 0 ||
      (spentFile.midTurn?.length ?? 0) > 0
    ) {
      settleJournal(account, new Set());
    }
    return 'idle';
  }

  const advanceTo = (row: MessageRecord): void => {
    writeFileAtomic(
      cursorPath(account),
      JSON.stringify({ lastId: row.id, lastTs: row.ts } satisfies Cursor),
      { mode: 0o600 },
    );
  };

  // AN INTERRUPTED TURN IS ANSWERED, NEVER REPEATED. If the journal names a
  // row that is still pending, a previous pass spawned for it and never
  // reported back; those rows are stepped over with an honest reply rather
  // than handed to a second execution. See `readJournal`.
  const journal = readJournal(account);
  if (journal) {
    const at = batch.findIndex(r => r.id === journal.upTo);
    if (at >= 0) {
      // THE MAYBE-DELIVERED STEER: an id journalled before its
      // `turn/steer` left, with the turn now provably dead in between. The
      // sentence names it — the operator's own mid-turn reply, never its
      // text — and the id STAYS journalled, so later passes step
      // over the row instead of handing a maybe-delivered message to a
      // second delivery.
      const crashFile = readJournalFile(account);
      const maybeDelivered = (crashFile.steered ?? []).filter(id => batchIds.has(id)).length;
      const interruptedSentence =
        'A turn was interrupted before it reported back — it may have partly run. ' +
        (maybeDelivered === 0
          ? ''
          : maybeDelivered === 1
            ? 'A reply you sent while it ran may or may not have reached it. '
            : `${maybeDelivered} replies you sent while it ran may or may not have reached it. `) +
        'Nothing was re-run. Send it again if you want it retried.';
      // THE CRASHED STREAMING TURN'S DEBT: a journalled anchor is a
      // bubble on a phone frozen mid-sentence, and the restart owes it the
      // durable final the dead pass never sent — the interrupted sentence
      // AS that final edit, so the bubble tells the truth instead of
      // holding half a thought forever. notify:false, the final edit's own
      // rule: the anchor already rang, and the news lands in the bubble the
      // operator is looking at. Any refusal falls back to today's plain
      // reply — the sentence is owed either way, never twice (the edit and
      // the fallback are one try/catch, one sentence out).
      const crashAnchor = crashFile.streamAnchor;
      if (crashAnchor !== undefined) {
        try {
          await send(
            JSON.stringify({ tcm: 'edit', ref: crashAnchor, text: funnel(interruptedSentence) }),
            undefined,
            { notify: false },
          );
        } catch {
          await reply(interruptedSentence);
        }
      } else {
        await reply(interruptedSentence);
      }
      advanceTo(batch[at] as MessageRecord);
      // EVERY ROW LEFT PENDING PAST THE DEAD TURN IS MARKED: the
      // crashed pass never reached settleTurn, so its mid-turn arrivals were
      // never recorded — delivered unmarked, pre-crash words would read as
      // fresh ones, the exact dishonesty the marker exists for. The crashed
      // pass's batch boundary died with it, so a genuine mid-turn arrival
      // cannot be told apart from a row that was already queued beyond the
      // group; BOTH sat unanswered while the turn ran, and over-marking is
      // the cheap direction (observeOwn's own rule) where a missed marker is
      // the violation. Consumed rows are excluded exactly as
      // settleTurn excludes them: journalled steered ids are stepped over by
      // their own rule, and approval-consumed rows are re-presented with
      // the exact prompt bytes, which a marker would alter.
      const consumedByCrash = new Set(readJournalFile(account).steered ?? []);
      for (const r of loadApprovals(account).rows) {
        if (r.answerId !== undefined) consumedByCrash.add(r.answerId);
        for (const s of r.spent ?? []) consumedByCrash.add(s);
      }
      const rest = batch.slice(at + 1);
      settleJournal(account, new Set(rest.map(r => r.id)), {
        midTurn: rest.filter(r => !consumedByCrash.has(r.id)).map(r => r.id),
      });
      return 'interrupted';
    }
    // Spent: the turn's own rows are behind the cursor. Steered/mid-turn ids
    // that still cover PENDING rows survive the retirement — this is the
    // crash window between the cursor advance and the journal settle, and
    // dropping them here would re-run a consumed row.
    settleJournal(account, batchIds);
  }

  // AN ANSWER IS NEVER A PROMPT. A reply whose `ref` names an approval's
  // card is the answer channel, not a message for the agent — treated as a
  // prompt, "approve" starts a turn whose instruction is the word approve,
  // which is the exact confusion the ref exists to prevent. Rows below are
  // classified before routing ever sees them, in two shapes:
  //
  //   spent — a parked pass already acted on this row (it decided an
  //           approval, or was consumed as an unrecognised verb and
  //           re-asked). THE CURSOR HAZARD'S SECOND HALF: the cursor is one
  //           watermark, so the pass that consumed this row could not advance
  //           past it without skipping every ordinary message between the
  //           watermark and it. The row is therefore left pending and stepped
  //           over HERE, on a later pass, once its approval is settled — the
  //           same treatment a spent journal gets. Nothing is sent: the
  //           answer was already honoured.
  //   late  — an unconsumed answer to an approval that is already settled or
  //           lapsed. Answered honestly, and NEVER re-bound: the requestId
  //           was single-use, and a lapse burned it.
  //
  // Only settled rows (`done`/`lapsed`/`superseded`) are special-cased. A
  // `pending` row with no parked pass alive cannot exist — the sweep above
  // just lapsed any — so an answer falling through to ordinary routing is the
  // visible failure shape if that invariant ever breaks, not a silent consume.
  const approvals = loadApprovals(account);
  const settledRefOf = (row: MessageRecord): ApprovalRow | undefined =>
    row.ref === undefined
      ? undefined
      : approvals.rows.find(
          a =>
            a.msgId !== undefined &&
            a.msgId === row.ref &&
            (a.state === 'done' || a.state === 'lapsed' || a.state === 'superseded'),
        );
  /**
   * A `respond:` decider's SECOND LIFE. The row denied its approval
   * inside the park (that consumption is `answerId`), but its text after the
   * verb is guidance the operator addressed to the turn — and the measured
   * wire has no channel for it (no decision carries text; `turn/steer` needs
   * an `expectedTurnId` precondition and is future work). So the text is delivered
   * the one honest way that exists: as an ORDINARY operator message on the
   * next pass — this returns the guidance so the pass routes and runs the
   * row like any other prompt instead of stepping over it as spent. The
   * `ref` it carries is the card's msgId, whose ledger row `send` wrote with
   * the asking session on it, so the guidance resumes the very thread that
   * asked. Null means "not a respond decider": ordinary classification.
   */
  const respondTextOf = (row: MessageRecord): string | null => {
    if (row.ref === undefined) return null;
    const a = approvals.rows.find(
      x => x.msgId === row.ref && x.answerId === row.id && x.via === 'respond',
    );
    if (a === undefined) return null;
    const m = /^respond\s*:\s*(\S[\s\S]*)$/i.exec(row.text.trim());
    return m === null ? null : (m[1] as string);
  };
  const approvalKey = (row: MessageRecord): string | null => {
    const a = settledRefOf(row);
    if (a === undefined) return null;
    // The respond decider is NOT spent — it has a prompt still to deliver.
    if (respondTextOf(row) !== null) return null;
    const consumed = a.answerId === row.id || (a.spent?.includes(row.id) ?? false);
    return consumed ? 'approval-spent' : `approval-late:${a.id}`;
  };

  // A STEERED ROW IS SPENT: a delivered (or maybe-delivered) steer
  // already handed its text to the turn that ran, so it is stepped over on
  // exactly the approval-spent pattern — silently, cursor past it, nothing
  // sent, never a second delivery. The set is read AFTER the journal
  // settlement above, so a spent list cannot shadow a live one.
  const steeredSpent = new Set(readJournalFile(account).steered ?? []);
  // AN MCP-PARKED ASK'S ANSWER IS NOT A PROMPT (mcp-ask.ts). Read FRESH
  // under this pass — cross-process file coordination with `tacendum mcp
  // --ask-owner`, whose park is the consumer the approval rules have in the
  // parked pass. Two shapes, mirroring the approval split exactly:
  //   pending  a row whose `ref` names a LIVE parked ask — not a trigger,
  //            not consumed, and the cursor never advances past it while it
  //            is unclaimed (the rule; the claim or the ask's deadline
  //            is what changes its classification);
  //   claimed  a row the park already consumed as its answer — stepped over
  //            exactly as approval-spent rows are, restarts included.
  // A missing or corrupt journal is the EMPTY answer: an MCP crash must not
  // wedge attend, so fail-open to prior behaviour is the contract, bounded
  // by the ask deadlines the journal itself carries.
  const mcpAsks = readMcpAskStepOver(account, now);
  const consumedKey = (row: MessageRecord): string | null =>
    steeredSpent.has(row.id)
      ? 'steered-spent'
      : mcpAsks.claimedIds.has(row.id)
        ? 'mcp-ask-spent'
        : row.ref !== undefined && mcpAsks.pendingRefs.has(row.ref)
          ? 'mcp-ask-pending'
          : approvalKey(row);

  const headConsumedKey = consumedKey(batch[0] as MessageRecord);
  if (headConsumedKey !== null) {
    if (headConsumedKey === 'mcp-ask-pending') {
      // The parked MCP tool call owns this row. Nothing is sent, no turn
      // runs, and the cursor does NOT move — never past an unclaimed row.
      return 'mcp-parked';
    }
    let runEnd = 1;
    while (
      runEnd < batch.length &&
      consumedKey(batch[runEnd] as MessageRecord) === headConsumedKey
    ) {
      runEnd += 1;
    }
    const lastOfRun = batch[runEnd - 1] as MessageRecord;
    if (
      headConsumedKey === 'approval-spent' ||
      headConsumedKey === 'steered-spent' ||
      headConsumedKey === 'mcp-ask-spent'
    ) {
      advanceTo(lastOfRun);
      // The stepped-over steered ids are now behind the cursor: spent, and
      // pruned so the file cannot grow a history (the retention rule the
      // approval journal already follows).
      if (headConsumedKey === 'steered-spent') {
        settleJournal(account, new Set(batch.slice(runEnd).map(r => r.id)));
      }
      return 'stepped';
    }
    const a = settledRefOf(batch[0] as MessageRecord) as ApprovalRow;
    // Each settled shape gets ITS OWN sentence, because "already answered" is
    // false for two of them: a TTL denial was answered by a clock, not a
    // person — the operator holding a stale card is exactly who needs told
    // the deadline beat them — and a superseded request was
    // REPLACED, so nothing they say to its burned id can approve anything.
    await reply(
      a.state === 'lapsed'
        ? 'That approval lapsed before this answer arrived — nothing was approved and no ' +
            'turn ran. Ask again if you still want it.'
        : a.state === 'superseded'
          ? 'That request was superseded by your edit — nothing was approved under it, and ' +
              'this reply changed nothing.'
          : a.via === 'ttl'
            ? 'That approval expired before this answer arrived — it was denied and nothing ' +
                'ran. Ask again if you still want it.'
            : 'That approval was already answered — this reply changed nothing.',
    );
    advanceTo(lastOfRun);
    return 'approval-stale';
  }

  // ONE ROUTE PER PASS, AND IT IS THE LEADING RUN OF THE BATCH.
  //
  // The route used to be computed for the batch as a whole, with "the last ref
  // wins". So a batch holding a reply to session A and a reply to session B
  // was joined into one prompt with '\n\n' and sent, entire, to B: A's message
  // was never answered by A's session, and B's session was handed a question
  // asked of somebody else as though it were context. Two conversations
  // silently merged, and neither operator-visible.
  //
  // The route is therefore a property of each ROW, and rows travel together
  // only while they agree on it. The group is the leading RUN rather than every
  // row sharing the winning route, because the cursor is a single watermark
  // over an append-ordered spool: advancing it past a non-contiguous selection
  // would skip the rows left in the gap. The remainder is not dropped — the
  // cursor still points before it, so the next pass picks it up, one turn and
  // one token each, which is the budget accounted honestly rather than N turns'
  // worth of work billed as one.
  const ledger = new MessageLog(account).read({ dir: 'out' });
  const routes = batch.map(row => routeIn(ledger, [row], now, cfg.host));
  const head = routes[0] as Route;
  // The run key is the consumed classification where one applies — approval
  // answers AND steered rows both — so a batch of prompts never swallows a
  // settled answer row or a steer-consumed row sitting behind it: the run
  // stops there and a later pass gives that row its own treatment above.
  const keys = batch.map((row, i) => consumedKey(row) ?? routeKey(routes[i] as Route));
  const key = keys[0] as string;
  let end = 1;
  while (end < keys.length && keys[end] === key) end += 1;
  const group = batch.slice(0, end);
  const last = group[group.length - 1] as MessageRecord;

  if (head.kind === 'ask') {
    await reply(
      `Several sessions are live: ${head.tags.join(', ')}. Reply to a message from the one you mean.`,
    );
    advanceTo(last);
    return 'asked';
  }
  if (head.kind === 'ended') {
    await reply(
      'That session ended and its record is gone. Reply to a newer message, or send a bare text for the lead.',
    );
    advanceTo(last);
    return 'ended';
  }
  if (head.kind === 'unroutable') {
    // A REPLY, NOT SILENCE: the operator aimed this at a specific session and
    // is owed the reason nothing happened, including which host it is on, so
    // the remedy ("answer it from that editor") is actionable rather than a
    // guess. No turn is spawned and no token is spent — nothing ran.
    await reply(
      `That session (${head.tag}) belongs to ${namedHost(head.host)}; attend drives ` +
        `${cfg.host} and cannot resume it. Answer it there, or send a bare text for the lead.`,
    );
    advanceTo(last);
    return 'unroutable';
  }

  if (!takeTurnToken(account, cfg, now)) {
    await reply('Attend is at its hourly turn limit. It resumes within the hour.');
    advanceTo(last);
    return 'throttled';
  }

  // A respond decider's prompt is the text AFTER its verb: the operator
  // addressed the guidance to the turn, not the word `respond:` — delivering
  // the verb would hand the model our own protocol wearing prompt clothes.
  // A row the journal recorded as a MID-TURN arrival is prefixed
  // with the one-line marker: on the hosts that cannot steer this is the
  // queue saying so, and it is exactly the "and say so" half of the honest
  // sentence the enable copy states.
  const midTurnMarked = new Set(readJournalFile(account).midTurn ?? []);
  const joined = group
    .map(b => {
      const body = respondTextOf(b) ?? b.text;
      return midTurnMarked.has(b.id) ? `${MID_TURN_MARKER}\n${body}` : body;
    })
    .join('\n\n');
  // A carry turn's prompt is the owner's words behind ONE context line
  // quoting the row they replied to (`carryContextLine` holds the rules) —
  // composed here and handed to the host, never logged.
  const prompt = head.kind === 'carry' ? `${carryContextLine(head.refText)}\n${joined}` : joined;
  // The spawn seam stays the SUPERVISOR's: `AttendIo.runTurn` keeps its
  // meaning (HOW to spawn a child) and the driver is handed it as
  // `DriverIo.spawn` (WHAT to spawn) — kept separate on purpose, because
  // every existing test fakes the spawn without knowing which host it fakes
  // for, and that is what lets the suite prove a driver change preserved
  // behaviour.
  const run =
    io.runTurn ??
    ((a: string[], cwd: string, p: string, env?: Readonly<Record<string, string>>) =>
      realRunTurn(cfg.bin, a, cwd, p, env));
  const spawn: DriverIo['spawn'] = async (a, cwd, p, env) => {
    const res = await run(a, cwd, p, env);
    return { stdout: res.stdout, stderr: res.stderr ?? '', code: res.code };
  };
  // The duplex seam rides beside the spawn seam, same split: the driver
  // decides WHAT runs, this pass decides HOW (the real child under
  // `cfg.bin`, or whatever a test injected).
  const session: SessionFactory =
    io.session ?? ((a, cwd, env) => realSession(cfg.bin, a, cwd, env));

  /**
   * SESSION IDENTITY FOR A ROOM TURN, resolved BEFORE the ask
   * funnel so approval cards from a room turn speak for the room's own
   * transcript, per host, v1 (`RoomSessionFile` holds the table):
   *
   *   claude   the pinned per-room session — the ownSession ANALOG run
   *            through the own-session machinery itself: the driver gets a
   *            per-turn cfg whose `ownSession`/`ownSessionStarted` are the
   *            ROOM's pin, and `route {kind:'own'}`, so the create/resume
   *            forms, the startup-refusal recovery and the `observeOwn`
   *            learning all apply verbatim — one implementation, not a
   *            second one that drifts. What the spawn observes is then
   *            written to the ROOM's entry, never the config (below).
   *   codex app-server  the captured thread key when one is stored (resume
   *            via the session route the driver already honours), else a
   *            fresh thread whose key is captured off the frame and stored.
   *   codex exec        fresh per turn — route `own`, exactly as an exec
   *            own turn runs today; nothing stored.
   *
   * The per-turn cfg override changes NOTHING durable: `saveAttendConfig`
   * is guarded off the room path (the observation write below), and every
   * other field rides unchanged — same bin, same caps, same workdir.
   */
  let driverCfg = cfg;
  // A carry turn IS an own turn to the driver — same argv forms, same
  // startup-refusal recovery, same session observation; the carry identity
  // exists for grouping (`routeKey`) and the context line, both supervisor
  // property. The driver never learns the kind existed.
  let driverRoute: Route = head.kind === 'carry' ? { kind: 'own' } : head;
  let roomSessKey: string | undefined;
  if (head.kind === 'room') {
    // The pinned arm matches the SUBPROCESS driver by name, never by "not
    // sdk": an unrecognised claudeDriver (a hand-edited attend.json —
    // exactly the state cmdAttendStatus prints guidance for) REFUSES at the
    // driver dispatch, and a session key minted-and-stored here for a turn
    // that then refuses would be a phantom — after the operator repairs the
    // config to `sdk`, every room turn would resume a key no host ever
    // issued, fail, and never clear it. Validate the driver BEFORE any key
    // exists; the unrecognised value falls through to the fresh-route arm,
    // where the refusing turn stores nothing.
    if (cfg.host === 'claude' && (cfg.claudeDriver ?? 'subprocess') === 'subprocess') {
      const cur = loadRoomSessions(account)[head.gid] ?? {};
      const existing = cur.key !== undefined ? hostSessionKey(cur.key) : undefined;
      const key = existing ?? randomUUID();
      if (existing === undefined) saveRoomSession(account, head.gid, { key });
      driverCfg = {
        ...cfg,
        ownSession: key,
        ownSessionStarted: existing !== undefined && cur.started === true,
      };
      driverRoute = { kind: 'own' };
      roomSessKey = key;
    } else if (cfg.claudeDriver === 'sdk' || cfg.codexDriver === 'app-server') {
      // The CAPTURE-SHAPED arm, shared by the two drivers that learn their
      // session on a frame: the claude sdk
      // driver cannot pin a session id at creation any more than codex
      // can — `resume` is the SDK's only declared session control — so a
      // room's first turn runs fresh, its id is captured off the init
      // frame, and the stored key is resumed from then on.
      const cur = loadRoomSessions(account)[head.gid];
      const stored = cur?.key !== undefined ? hostSessionKey(cur.key) : undefined;
      if (stored !== undefined) {
        driverRoute = { kind: 'session', host: cfg.host, key: stored };
        roomSessKey = stored;
      } else {
        driverRoute = { kind: 'own' };
      }
    } else {
      driverRoute = { kind: 'own' }; // codex exec: fresh per turn
    }
    // THE CAPABILITY FLOOR: EVERY
    // room-triggered turn runs at plan/read-only REGARDLESS of the caps the
    // owner granted their 1:1 turns — non-owner-visible output must never
    // meet write capability, and with room triggers a non-owner can now be the author
    // of the words that become the prompt. One clause, after every room
    // session arm, so no driver — subprocess, sdk, exec, app-server — can
    // reach a room spawn carrying the operator's permission words: the
    // floor REPLACES every capability flag, never merges (a floor flag
    // appended beside a permissive operator flag is whichever one the
    // host's parser prefers), while NEUTRAL settings — the model pin, the
    // one caps word that decides which model answers, not what a turn may
    // do — carry through. The operator's caps stay
    // untouched for 1:1 turns (asserted red-first in
    // gate.room-trigger-d3.test.ts); the codexModel field rides unaffected.
    //
    // AND THE APPROVAL LANE IS FLOORED WITH IT (same remediation): the
    // rule is "non-owner-visible output never meets write
    // capability", and an approval card is exactly the lane that lets a
    // turn out of its sandbox — under a trigger grant the words that solicit the card
    // can be a non-owner's, and one owner tap would hand their escalation
    // through a card that cannot carry enough context to judge it. So a
    // room turn carries NO approval capability at all: `codexApprovalPolicy`
    // is forced to 'never' (the app-server host never asks; an out-of-
    // sandbox action fails inside the read-only turn instead of parking),
    // and the `ask` funnel is withheld at the spawn below (`runDriverTurn`'s
    // room guard — the claude sdk `canUseTool` relay fails CLOSED without
    // it, denying without asking; the subprocess and exec drivers have no
    // approval surface to begin with). The floor is terminal, per driver.
    driverCfg = {
      ...driverCfg,
      caps: roomCapsFloor(cfg.host, cfg.caps),
      codexApprovalPolicy: 'never',
    };
  }

  // The session this turn SPEAKS FOR, threaded to the reply transport (the
  // outbound ledger row that makes a reply routable) and to the approval
  // journal. A codex EXEC own turn carries none: its transcript is fresh
  // every time (the driver comment on `codexDriver` explains why capture
  // cannot ride stdout), and a key nothing can resume would route the
  // operator's reply into a spawn that fails — no key routes it to the
  // carry fallback instead: a fresh turn behind the context line, which is
  // exactly what "fresh per turn" means to the operator's ongoing
  // conversation. An APP-SERVER own turn learns its key
  // mid-turn on a frame (`TurnResult.sessionKey`); `saidSess` below picks
  // that up for every reply sent AFTER the turn, which is the earliest a
  // ledger row could carry it.
  //
  // A ROOM turn carries NONE, DELIBERATELY — realSendRoomReply's no-sess
  // rule applied to the room turn's 1:1 SIDE messages (excuses, 'Turn
  // finished, no output.', refused-post notices, approval cards): room
  // continuity lives ONLY in the per-room session store, keyed by gid, and
  // the room's pinned/captured key on any 1:1 out row would be resolved by
  // routeIn's ref arm (an ordinary reply to the excuse) or counted by its
  // 2-hour live window (a bare message) — a 1:1 conversation quietly
  // RESUMING the multi-member room transcript, in either direction: the
  // room's context answered privately, or private words becoming context
  // the next room turn fans out. With no sess, a reply to a room turn's 1:1
  // excuse takes the carry fallback — a fresh OWN 1:1 turn behind the
  // context line, which continues the private conversation and still never
  // touches the room transcript (the leak this rule closes stays closed) —
  // and a bare message keeps the documented own-session default.
  const turnSess: OutSess | undefined =
    head.kind === 'session'
      ? { host: head.host, key: head.key, tag: sessionTag(head.key) }
      : head.kind === 'room'
        ? undefined
        : cfg.host === 'claude' && cfg.claudeDriver !== 'sdk'
          ? { host: cfg.host, key: cfg.ownSession, tag: sessionTag(cfg.ownSession) }
          : // An sdk own turn is a codex-app-server own turn here: it
            // cannot pin `ownSession` at creation, so it runs fresh and its
            // real id arrives on a frame — claiming `ownSession` up front
            // would write a ledger row for a transcript that never exists.
            // `saidSess` picks the captured key up after the turn instead.
            undefined;

  /**
   * THE ASK FUNNEL — the supervisor's, whole: the driver only asks
   * and awaits. The prompt is composed here, the journal and its write order
   * are here, the TTL clock is here, and the answer arrives through the same
   * spool every message does. The parked pass HOLDS the turn lock for the
   * whole park — that is what lets the restart sweep read any in-flight row
   * as a crash — and polls on the loop's own cadence while it waits.
   *
   * THE CURSOR IS NEVER TOUCHED IN HERE. An answer row the park consumes may
   * sit PAST ordinary messages that arrived while the turn ran; the cursor is
   * one watermark, so advancing it to the answer would silently skip them.
   * Consumption is recorded on the JOURNAL ROW (`answerId`/`spent`), and the
   * consumed row is stepped over by a later pass once its approval settles —
   * the classification at the top of this function is the other half.
   */
  const tick = (): number => io.now?.() ?? Date.now();
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)));
  const askedRows: string[] = [];
  let turnOver = false;
  const askInner = async (a: ApprovalAsk): Promise<ApprovalDecision> => {
    const askedAt = tick();
    const ttlMs = Math.min(
      APPROVAL_TTL_MAX_MS,
      Math.max(APPROVAL_TTL_MIN_MS, a.ttlMs ?? APPROVAL_TTL_DEFAULT_MS),
    );
    const rowId = ulid();
    const requestId = ulid();
    askedRows.push(rowId);
    // What the CARD and its replies speak for: the routed session when one
    // exists, else the key the DRIVER already knows mid-turn (the app-server
    // thread id — `turnSess` cannot carry it, the id arrives on a frame
    // after the route was decided). Gated through `hostSessionKey` exactly
    // as a captured key is at turn end, and for the same reason: it came off
    // a host frame and is about to be written where the router will trust
    // it. Without this, a first-contact own turn's card writes a sessionless
    // ledger row and a `respond:` to it can only route `ended`.
    //
    // NEVER FOR A ROOM TURN: the driver's mid-turn key there IS the room
    // thread, and the card is a 1:1 side message — `turnSess`'s room rule
    // holds for this arm too, or the leak it closes re-opens through the
    // approval surface. The ANSWER path loses nothing: approve/deny/edit:/
    // respond: all ride the ref to the card's wire msgId (the approval
    // journal's own join), never the row's sess.
    const askKey =
      head.kind !== 'room' && a.sessionKey !== undefined
        ? hostSessionKey(a.sessionKey)
        : undefined;
    const askSess: OutSess | undefined =
      turnSess ??
      (askKey !== undefined ? { host: cfg.host, key: askKey, tag: sessionTag(askKey) } : undefined);
    // THE ATTESTATION GATE, and it FAILS CLOSED. The `x.approval`
    // envelope leaves this process only when the operator attested — at
    // `attend enable --approvals` — that their phone renders it; without the
    // attestation the plain-text prompt is the only emission, forever
    // (it is not transitional — an account that never attests never changes).
    // The shape check here is deliberately the whole gate: a malformed field
    // (a hand edit, a torn write) reads as un-attested, because the text
    // path is the one every shipped build can answer.
    const attested =
      Number.isInteger(cfg.approvalsMinAppBuild) && (cfg.approvalsMinAppBuild as number) >= 1;
    const form: 'card' | 'text' = attested ? 'card' : 'text';
    const minted: ApprovalRow = {
      id: rowId,
      requestId,
      host: cfg.host,
      ...(askSess?.key !== undefined ? { sessionKey: askSess.key } : {}),
      payload: a.payload,
      askedAt,
      ttlMs,
      state: 'asking',
      form,
    };
    // The head-of-card note: a running count from the second
    // ask of one turn on — with one watermark cursor and one turn per pass
    // there is never more than ONE pending approval, but one turn may ask
    // N times in quick succession, and the count is what keeps the fourth
    // card from reading like a re-send of the first — plus the hedged
    // wake-budget line (`sentAt` above holds the honesty argument). The CARD
    // form carries the count as the envelope's `n`; the hedge has no wire
    // field and is dropped there — an under-claim, the honest direction, and
    // the card is durable in the thread where a missed ring matters least.
    const seq = askedRows.length;
    const noteParts: string[] = [];
    if (seq > 1) noteParts.push(`approval ${seq} of this turn`);
    if (sentAt.filter(t => askedAt - t < 60_000).length >= 4) {
      noteParts.push('your phone may not have rung — several messages within a minute');
    }
    const body =
      form === 'card'
        ? composeApprovalCard({
            requestId,
            payload: a.payload,
            ttlMs,
            ...(a.kind !== undefined ? { kind: a.kind } : {}),
            ...(askSess?.tag !== undefined ? { sessionTag: askSess.tag } : {}),
            seq,
          })
        : composeApprovalPrompt(
            a.payload,
            ttlMs,
            noteParts.length > 0 ? noteParts.join('; ') : undefined,
          );
    if (body === null) {
      // THE OVER-CAP REFUSAL (B-0 C10): unshown is unapprovable — a payload
      // the form would clip or alter cannot be one-tapped, because the
      // operator would be approving bytes they never saw. Denied, said why,
      // size named (the SIZE, never the bytes, in this sentence),
      // and counted — the counter is C11's ongoing measurement. Each form
      // names ITS cap (`composeApprovalCard` holds the two-cap argument):
      // the text funnel's 280 chars, the card schema's 16 KiB.
      mutateApprovals(account, file => {
        file.overCapRefusals += 1;
        file.rows.push(minted);
      });
      patchApprovalRow(account, rowId, {
        decision: 'deny',
        via: 'overcap',
        decidedAt: tick(),
        state: 'answering',
      });
      await reply(
        form === 'card'
          ? `The agent asked for approval of a ${Buffer.byteLength(a.payload, 'utf8')}-byte ` +
              `action, which does not fit the ${MAX_APPROVAL_PAYLOAD_BYTES}-byte approval ` +
              'card verbatim — and it is never summarised or truncated here, so it was ' +
              'denied and nothing ran. Approve it from the machine if you want it.'
          : `The agent asked for approval of a ${a.payload.length}-character command, which ` +
              `does not fit the ${HOOK_CHAT_CAP}-character chat message verbatim — and it is ` +
              'never summarised or truncated here, so it was denied and nothing ran. ' +
              'Approve it from the machine if you want it.',
        askSess,
      );
      return 'deny';
    }

    // Write 1, BEFORE the request leaves the process: a crash between send
    // and journal would leave a card on a phone that nothing can answer.
    // BOTH forms leave through `send` — the raw seam, never the funnel: the
    // text form already proved byte-identity through it at compose, and the
    // envelope is wire bytes the funnel would mangle. In production that seam
    // is `realSendReply`, which is what lands the wire msgId in the journal
    // below — the reply-ref target the card's buttons answer — and writes
    // the outbound ledger row TO THE OWNER, 1:1: an approval is never
    // composed into a room (a pinned rule; the fan-out path is
    // room-commands', and nothing here can reach it).
    mutateApprovals(account, file => {
      file.rows.push(minted);
    });
    const sentId = await send(body, askSess);
    const msgId = typeof sentId === 'string' ? sentId : undefined;
    // Write 2, after the send: the msgId is the row the phone will reply-ref.
    // A seam that returned none leaves the row answerable only by its TTL —
    // stated on `AttendIo.sendReply`, and honest: an unaddressable card
    // expires rather than guessing which reply meant it.
    patchApprovalRow(account, rowId, {
      ...(msgId !== undefined ? { msgId } : {}),
      state: 'pending',
    });

    for (;;) {
      // Re-read our own row first: the post-turn settlement (an ask the
      // driver abandoned) or a concurrent close may have ended it from
      // outside, and a closed row decides deny with no further writes.
      const live = loadApprovals(account).rows.find(r => r.id === rowId);
      if (
        live === undefined ||
        live.state === 'lapsed' ||
        live.state === 'done' ||
        live.state === 'superseded'
      ) {
        return 'deny';
      }
      const nowT = tick();
      if (nowT - askedAt >= ttlMs) {
        // Write 3 (the TTL arm): recorded before the host hears the deny.
        patchApprovalRow(account, rowId, {
          decision: 'deny',
          via: 'ttl',
          decidedAt: nowT,
          state: 'answering',
        });
        // The CARD form's expiry names the one failure the attestation copy
        // warned about, because this sentence is its ONLY signal: an app
        // build older than attested drops the card silently (the generic
        // `x.*` drop), so the operator saw nothing and is owed the diagnosis
        // and the way back, here, in the plain text every build renders.
        await reply(
          form === 'card'
            ? `No answer within ${fmtAge(ttlMs)} — that approval card expired and was ` +
                'denied; nothing ran. If no card ever appeared, this phone runs an older ' +
                'app build than attested at enable — re-run attend enable without ' +
                '--approvals for plain-text approvals. Ask again if you still want it.'
            : `No answer within ${fmtAge(ttlMs)} — that approval expired and was denied. ` +
                'Nothing ran. Ask again if you still want it.',
          askSess,
        );
        return 'deny';
      }
      if (msgId !== undefined) {
        const answers = pendingRows(account, owner).filter(r => r.ref === msgId);
        const spentNow = [...(live.spent ?? [])];
        let reAsked = live.reAsked === true;
        for (const r of answers) {
          if (live.answerId === r.id || spentNow.includes(r.id)) continue;
          const raw = r.text.trim();
          // Exact, case-insensitive, WHOLE-message match. "approve it" is not
          // approve: a verb loosened here is an approval granted by fuzzy
          // matching, which is the one direction this must never guess in.
          const verb = raw.toLowerCase();
          if (verb === 'approve' || verb === 'deny') {
            // Write 3: the decision is journalled BEFORE it reaches the host
            // — the host call is the side-effecting one, so a crash in the
            // gap reads as "decided, not delivered", which the lapse rule
            // then reports rather than re-runs.
            patchApprovalRow(account, rowId, {
              decision: verb,
              via: 'reply',
              decidedAt: tick(),
              answerId: r.id,
              state: 'answering',
            });
            return verb;
          }
          /**
           * `edit: <command>` — and what it does is bounded by a
           * MEASUREMENT, not by the plan's hope. The 0.144.0 decision enum
           * admits accept / acceptForSession / decline / cancel and two
           * POLICY amendments; `acceptWithExecpolicyAmendment` widens what
           * may run unprompted later, it does not substitute a command (the
           * vendored-type note in codex-appserver.ts quotes the schema's own
           * doc). So an edited command cannot honestly ride any answer
           * frame, and running it ourselves would bypass the sandbox and
           * the whole approval model. What CAN be done honestly: the
           * original request is SUPERSEDED — denied on the wire, its
           * single-use id burned, its journal state naming what happened —
           * and the operator is told, in one sentence, that the edited
           * bytes were NOT run and how to run them (as an ordinary
           * message, where the agent proposes and a FRESH approval binds
           * fresh bytes). Only a command admits even that much; a diff
           * cannot be edited from a phone at all.
           */
          const edited = /^edit\s*:\s*(\S[\s\S]*)$/i.exec(raw);
          if (edited !== null && a.kind === 'commandExecution') {
            patchApprovalRow(account, rowId, {
              decision: 'deny',
              via: 'edit',
              decidedAt: tick(),
              answerId: r.id,
              state: 'answering',
            });
            await reply(
              'That request was superseded and denied. The edited command was NOT run: the ' +
                'agent can only accept or decline the command it proposed, and attend never ' +
                'runs commands itself. Send it as an ordinary message if you want the agent ' +
                'to run it.',
              askSess,
            );
            return 'deny';
          }
          /**
           * `respond: <text>` — deny WITH guidance, on the one honest
           * channel that exists. The measured wire has no text on any
           * decision, and `turn/steer` needs an `expectedTurnId`
           * precondition (the work), so the text cannot reach the PARKED
           * turn. It reaches the NEXT one instead: the decision here is a
           * plain deny, and this very spool row — via `respondTextOf` — is
           * re-presented on the next pass as an ordinary operator message,
           * routed by its own `ref` to the session that asked. Nothing is
           * copied anywhere: the text lives where the operator put it.
           */
          if (/^respond\s*:\s*(\S[\s\S]*)$/i.test(raw)) {
            patchApprovalRow(account, rowId, {
              decision: 'deny',
              via: 'respond',
              decidedAt: tick(),
              answerId: r.id,
              state: 'answering',
            });
            return 'deny';
          }
          // Anything else — a bare `edit:`/`respond:`, an `edit:` aimed at a
          // diff, junk — gets ONE honest corrective sentence and consumes
          // nothing of the approval; the row itself is consumed into `spent`
          // so a later pass steps over it instead of answering it twice.
          spentNow.push(r.id);
          patchApprovalRow(account, rowId, { spent: [...spentNow], reAsked: true });
          if (!reAsked) {
            reAsked = true;
            await reply(
              edited !== null
                ? 'Only a command execution can be edited from here, and this approval is ' +
                    'not one — a diff cannot be edited from a phone. Reply approve or deny; ' +
                    'the request is unchanged.'
                : 'Reply approve or deny — or edit: <command> to supersede a command, or ' +
                    'respond: <text> to deny with guidance. The request is unchanged.',
              askSess,
            );
          }
        }
      }
      if (turnOver) {
        // The driver returned without awaiting its own ask. The callback is
        // dead — same fact as a crash, same honest answer: the row lapses,
        // and this floating loop ends instead of polling forever.
        patchApprovalRow(account, rowId, { state: 'lapsed', settledAt: tick() });
        return 'deny';
      }
      await sleep(ATTEND_POLL_MS);
    }
  };
  /**
   * The in-flight count the typing cadence reads: a PARKED
   * turn is the model waiting on the HUMAN, and "typing…" over an approval
   * card would claim the opposite exactly when the operator must act — so no
   * refresh leaves while an ask is in flight, the phone's own expiry retires
   * the indicator within 15 s of the park, and the next cadence tick after
   * the decision re-lights it. A counter, not a journal read: it counts THIS
   * turn's asks only, and costs the loop no file I/O.
   */
  let asksInFlight = 0;
  const ask = async (a: ApprovalAsk): Promise<ApprovalDecision> => {
    asksInFlight += 1;
    try {
      return await askInner(a);
    } finally {
      asksInFlight -= 1;
    }
  };

  /**
   * -------------------------------------------------------------------------
   * THE STEER POLLER — the ask park's sibling: same clock seams
   * (`io.sleep`/`io.now` — moving-clock testable, per the frozen-clock
   * rule), same spool reader (`pendingRows`), same cadence, and covered by
   * the SAME `turnOver` end condition, so no loop outlives the turn. It
   * starts only when a driver surfaces a live turn's steer call — which only
   * the codex app-server driver can — and it is DEFAULT-ON for those
   * accounts.
   *
   * THE PREDICATE, all of, and the order is cheapest-refusal-first:
   *   - triggers(row)                    — `pendingRows` applies the one
   *                                        predicate already;
   *   - not a row this turn already owns — the group is being answered, a
   *                                        journalled steered id was consumed;
   *   - not an approval answer           — ref ≠ any approval row's msgId,
   *                                        any state: the answer channel is
   *                                        never a prompt, so it is
   *                                        never a steer either;
   *   - no approval in flight            — steer-during-park is UNMEASURED
   *                                        and therefore forbidden, not
   *                                        solved;
   *   - routeKey(row) equals the running turn's — the routed key, or the
   *                                        thread the driver reported the
   *                                        turn runs as (gated through
   *                                        `hostSessionKey` like every
   *                                        frame-borne key);
   *   - a turn token available           — one per delivered steer
   *                                       . Broke ⇒ the row QUEUES —
   *                                        never a silent drop; the next
   *                                        pass answers it under its own
   *                                        token.
   *
   * THE CURSOR IS NEVER TOUCHED IN HERE — consumption is recorded
   * on the journal's `steered` list, journal-FIRST, and later passes step
   * the consumed row over exactly as they step approval-spent rows.
   *
   * `live.steer` never rejects (the client's contract); a rejection here is
   * therefore a CRASH and is left to unwind — the journalled id is exactly
   * what answers for it, the same way a dying `sendReply` answers to the
   * approval journal's boundary 1↔2.
   */
  const groupIds = new Set(group.map(r => r.id));
  const steeredNow: string[] = [];
  let steerUnconfirmed = 0;
  let steerStarted = false;
  // Widened initializer (`as`): the only assignment is inside the `steering`
  // closure, which TS's flow analysis cannot see from the loop's read.
  let steerLive = null as SteerableTurn | null;
  const runningKeys = new Set<string>([routeKey(head)]);
  // What the LIVE turn speaks for, learned mid-turn: the thread
  // key the driver surfaces on the steer call, held as the OutSess the
  // streamed ANCHOR's ledger row needs. Captured at the exact instant — and
  // through the exact `hostSessionKey` gate — that `runningKeys` learns the
  // key, because the two must agree: the anchor row's sess is what routes a
  // reply to the streaming bubble to `session:<key>` ∈ runningKeys (steered
  // mid-turn, the natural gesture) and to the thread itself ever after
  // (resumed like any answered turn, not the carry fallback). Never set for
  // a ROOM turn — a room turn attaches no steer surface at all (`steerable`
  // below), which is the same wall that keeps the room thread key out of
  // the 1:1 out ledger everywhere else.
  let liveSess: OutSess | undefined;
  const steering = (live: SteerableTurn): void => {
    if (steerStarted) return;
    steerStarted = true;
    const liveKey = live.sessionKey !== undefined ? hostSessionKey(live.sessionKey) : undefined;
    if (liveKey !== undefined) {
      runningKeys.add(routeKey({ kind: 'session', host: cfg.host, key: liveKey }));
      liveSess = { host: cfg.host, key: liveKey, tag: sessionTag(liveKey) };
    }
    // The scan itself runs in the pass's ONE cadence loop below (typing joined
    // the loop rather than starting a sibling): attaching here only
    // hands it the live handle it polls for.
    steerLive = live;
  };

  /**
   * TYPING CHATTER FOR THE TURN — 1:1 ONLY, DEFAULT-ON.
   *
   * ROOM TURNS EMIT NONE, v1, PINNED (the test is the other half): a room
   * "typing" would be one sealed leg per member per refresh — a fan-out of
   * chatter spending the typing bucket N-wide every 7.5 s for the length of
   * a turn — and the server would drop most of it anyway: an
   * integration's typing frame relays iff the recipient is its OWNER or a
   * same-crew integration (handleTyping's crew-scoped predicate), so every
   * human room member but the owner draws the uniform drop. When room typing
   * is worth having it arrives as its own decision, not as a fan-out this
   * comment failed to forbid.
   *
   * DEFAULT-ON for 1:1 turns, no flag — the steering lane's exact
   * argument: it widens no capability (the server already relays an
   * integration's typing to its owner; this only says honestly when a turn
   * is running), and the operator-visible surface is one indicator the app
   * already renders. The channel is minted lazily here and NOTHING dials
   * until the first emission — an instant turn never opens a socket.
   */
  let typingChannel = null as TypingChannel | null;
  if (head.kind !== 'room') {
    try {
      typingChannel =
        io.typing !== undefined ? io.typing(owner) : realTypingChannel(account, owner);
    } catch {
      /* chatter — a channel that cannot even mint never fails the turn */
    }
  }
  let lastTypingAt = -Infinity;
  let typingBusy = false;
  let typingStarted = false;
  const typingTick = (t: number): void => {
    if (typingChannel === null || typingBusy) return;
    if (asksInFlight > 0) return; // parked = waiting on the human, not typing
    if (t - lastTypingAt < ATTEND_TYPING_REFRESH_MS) return;
    lastTypingAt = t;
    typingBusy = true;
    typingStarted = true;
    const chan = typingChannel;
    // DETACHED, busy-guarded, swallowed (never fail, never leak): the emission — worst
    // case a full dial — must never hold the cadence loop off a steer scan,
    // never surface a failure, and never delay the turn. And QUEUED
    // (`enqueueSealed`): detached is how this emission used to reach the
    // ratchet file lock beside streamTick's edit on the same tick and freeze
    // the pass for the lock's whole contended budget. The busy flag still
    // bounds the float to ONE settling promise (queue wait included), and
    // the loop's finally below is what closes the channel whichever way it
    // ends.
    void enqueueSealed(account, () => chan.send('start'))
      .catch(() => {
        /* chatter; the phone's expiry answers for it */
      })
      .finally(() => {
        typingBusy = false;
      });
  };

  /**
   * STREAMED REPLY EMISSION — the pass's ONE cadence loop
   * gains a third tenant beside typing and the steer scan; no sibling loop
   * (the two-loops-on-one-fake-clock trap the loop's own header records).
   *
   * THE ARMING PREDICATE, all of, decided ONCE at turn start:
   *   attested        `streamMinAppBuild` present and ≥ 1 — the exact
   *                   posture: malformed reads as un-attested, and an
   *                   account that never attests keeps today's single-reply
   *                   shape byte-identical, forever;
   *   codex app-server  the only surface that can produce a snapshot (v1 —
   *                   claude cannot stream, `codex exec` cannot stream);
   *   1:1             rooms deferred BY NAME: a room stream would be
   *                   a fan-out of chatter the typing pin already forbids;
   *   fresh           the triggering row is younger than STREAM_FRESH_MS —
   *                   a drained backlog streams nothing (nobody is watching
   *                   the bubble).
   *
   * THE LIFECYCLE the ticks below implement: first non-empty FUNNELED
   * snapshot → the durable ANCHOR through the ordinary reply seam (it
   * rings once — the reply's only banner), its msgId journalled BEFORE any
   * `x.edit` leaves (the crash-direction rule on `JournalFile.streamAnchor`)
   * → intermediates as `composeStreamEdit(anchor, seq++, snapshot)` through
   * the typing channel's `edit` member, only-if-changed, suppressed while
   * an ask is in flight (a parked turn is the model waiting on the HUMAN),
   * capped at STREAM_EDITS_PER_TURN_MAX (then intermediates fall silent —
   * typing continues, the final is never capped) → the turn-end paths owe
   * the anchor its durable final (`finalizeStream`).
   *
   * EVERY SNAPSHOT CROSSES THE SAME FUNNEL AS THE FINAL, before anything
   * else sees it: an intermediate can never say what the final could not —
   * the funnel is the exfil-bandwidth throttle, and a streaming lane that
   * bypassed it would be a second, wider path to the phone.
   */
  const streamArmed =
    Number.isInteger(cfg.streamMinAppBuild) &&
    (cfg.streamMinAppBuild as number) >= 1 &&
    cfg.host === 'codex' &&
    cfg.codexDriver === 'app-server' &&
    head.kind !== 'room' &&
    now - last.ts < STREAM_FRESH_MS;
  /** The latest accumulated snapshot, straight off the driver's callback —
   * a variable write and nothing else, so the client's read loop is never
   * held off a frame by this side's I/O. */
  let streamSnapshot = '';
  const onStreamSnapshot = (snapshot: string): void => {
    streamSnapshot = snapshot;
  };
  let streamAnchorId: string | undefined;
  /** How many durable sends this pass had made when the anchor landed — the
   * anchor's own included. `sentAt` records every send's instant already, so
   * its length is the pass's send ordinal: any send after the anchor means
   * the anchor is no longer the last thing this turn put in the
   * conversation (see `finalizeStream`). */
  let streamSendsAtAnchor = 0;
  let streamSeq = 0;
  let streamEditsSent = 0;
  let streamLastSent = '';
  let streamEditBusy = false;
  let streamDead = false;
  const streamTick = async (): Promise<void> => {
    if (!streamArmed || streamDead) return;
    if (asksInFlight > 0) return; // parked = waiting on the human; suppressed
    const snap = streamSnapshot;
    if (snap === '') return;
    const text = funnel(snap);
    if (text === '') return;
    if (streamAnchorId === undefined) {
      // THE ANCHOR'S SESSION: the routed key when the route knew
      // one up front, else the live thread key `steering` surfaced. The
      // anchor is the only bubble the operator can SEE mid-turn, so its row
      // is the reply surface — sessionless, a reply to it routed
      // carry:<anchorId> ∉ runningKeys (queued mid-stream while a bare text
      // steered) and regressed to the carry fallback forever after (the
      // sess-bearing row belonged to the invisible final-edit carrier msgId
      // nothing ever refs). NEITHER KEY YET ⇒ WAIT A TICK, never a
      // sessionless mint: on the measured wire the key precedes the first
      // snapshot (thread capture precedes `turn/start` structurally, and
      // `turn/started` surfaces the steer before the first delta in read
      // order), so this arm only covers the unparsed-turn-id gap where
      // surfaceSteer waits for `turn/start`'s own result — the snapshot
      // keeps accumulating and the next tick mints with the key aboard. A
      // driver that never surfaces a key streams nothing at all, which is
      // today's single-reply shape, honestly degraded.
      const anchorSess = turnSess ?? liveSess;
      if (anchorSess === undefined) return;
      // THE ANCHOR — durable, through the ordinary reply seam, AWAITED (the
      // one deliberate await in this loop): `loopDone` must not resolve
      // with the mint in flight, or the turn-end paths would race a
      // half-born anchor. The journal write lands before `streamAnchorId`
      // does, and edits flow only once the id is set — journalled-before-
      // emission by construction, not by convention.
      // Captured BEFORE the mint's own send: an ask that fires during the
      // await below pushes its instant onto `sentAt` mid-flight, and the
      // FIFO puts its row after the anchor's — so the ordinal must count it
      // as post-anchor, which `sendsBeforeAnchor + 1` does and a read after
      // the await would not.
      const sendsBeforeAnchor = sentAt.length;
      try {
        const sentId = await send(text, anchorSess);
        if (typeof sentId !== 'string') {
          // A seam that swallows the id (stated on `AttendIo.sendReply`)
          // leaves nothing an edit could reference: the turn falls back to
          // today's single-reply shape, silently.
          streamDead = true;
          return;
        }
        writeJournalFile(account, { ...readJournalFile(account), streamAnchor: sentId });
        streamAnchorId = sentId;
        streamSendsAtAnchor = sendsBeforeAnchor + 1;
        streamLastSent = text;
      } catch {
        // The anchor could not go. Streaming stands down for the turn;
        // the turn-end reply owns the answer exactly as it does today.
        streamDead = true;
      }
      return;
    }
    if (text === streamLastSent) return; // only-if-changed
    if (streamEditsSent >= STREAM_EDITS_PER_TURN_MAX) return; // cap: silence, not failure
    if (streamEditBusy) return;
    const chan = typingChannel;
    if (chan === null || chan.edit === undefined) return;
    const emitEdit = chan.edit;
    const seq = streamSeq + 1;
    let frame: string;
    try {
      // `ai: true` — an x.edit is only ever agent-authored, and the strict
      // composer is its marker's one compose site (the send wrapper
      // never sees these frames, they ride the typing channel).
      frame = composeStreamEdit({ ref: streamAnchorId, seq, text, ai: true });
    } catch {
      // A snapshot the envelope refuses (a leading sentinel, an overgrown
      // body) skips its frame; the durable final still carries whatever
      // the funnel passes — the cap costs the overlay, never the reply.
      return;
    }
    streamSeq = seq;
    streamEditsSent += 1;
    streamLastSent = text;
    streamEditBusy = true;
    // DETACHED, busy-guarded, swallowed — typingTick's exact posture
    // (never fail, never leak): fire-and-forget chatter, errors silenced for the turn,
    // and the app's later-seq-wins overlay heals every lost frame. QUEUED
    // like every sealed emission (`enqueueSealed`): the seq was taken above,
    // so the FIFO carries edits to the lock in seq order, behind the anchor
    // and ahead of the durable final.
    void enqueueSealed(account, () => emitEdit.call(chan, frame))
      .catch(() => {
        /* chatter; the durable final heals */
      })
      .finally(() => {
        streamEditBusy = false;
      });
  };

  /**
   * THE DURABLE FINAL: when this turn minted an anchor, its ONE
   * turn-end reply lands as the shipped `{tcm:'edit'}` ON that anchor —
   * `notify: false`, because the anchor already rang and the final is the
   * same bubble finishing its sentence (it also heals offline phones,
   * missed relays and old-enough builds, being durable where the
   * intermediates were chatter). Returns true when the final rode the
   * edit; false hands the caller today's exact reply path — the fallback
   * the design owes: never a stuck bubble, and never two finals (the
   * anchor id is consumed before the first byte moves).
   *
   * AND ONLY WHILE THE ANCHOR IS STILL THE TURN'S LAST WORD (device demo,
   * build 9). The live run surfaced the failure shape: anchor minted →
   * approval ask sent BELOW it → owner approves → the final landed as an
   * edit to the anchor ABOVE the ask, so the thread's tail showed nothing
   * new and the owner read "no response". When any durable send followed
   * the anchor within this turn — today that is exactly the approval ask
   * and its refusal/expiry sentences, but the predicate is the general one
   * (the pass's send ordinal moved past the anchor's) — the final goes out
   * as a NEW ordinary reply instead: the caller's own fallback path,
   * byte-identical to the no-anchor shape. The anchor simply keeps its
   * durable text — its opening snapshot, which reads honestly as the first
   * message of the turn once the overlay fades — and its journal entry is
   * cleared HERE, before the fallback sends, so a crash in the gap costs a
   * plain interrupted reply, never a restart-sweep edit painted over an
   * anchor whose turn already answered below it.
   */
  const finalizeStream = async (text: string, sess?: OutSess): Promise<boolean> => {
    if (streamAnchorId === undefined) return false;
    const anchor = streamAnchorId;
    streamAnchorId = undefined;
    if (sentAt.length > streamSendsAtAnchor) {
      // Interleaved: the anchor is no longer the last row this turn put in
      // the conversation. Retire its journal debt and hand the caller the
      // plain-reply path — the final must land at the thread's tail.
      const stale = readJournalFile(account);
      delete stale.streamAnchor;
      writeJournalFile(account, stale);
      return false;
    }
    // The shipped EditEnvelope's own refusals, applied at compose: empty
    // text is `del`'s job, and a leading sentinel would smuggle a carrier
    // into a rendered body — either falls back to the plain reply.
    if (text === '' || text.startsWith('{"tcm":')) return false;
    try {
      await send(JSON.stringify({ tcm: 'edit', ref: anchor, text }), sess, { notify: false });
    } catch {
      return false;
    }
    // The anchor is answered: clear the journal NOW, before the cursor
    // moves, so a crash in the gap costs at worst today's plain interrupted
    // message — never a second final edit over a good one. THE RESIDUAL
    // WINDOW, named honestly: between `send` resolving above
    // and this write landing there is a sub-millisecond gap where the final
    // is delivered but the anchor is still journalled. A crash INSIDE it
    // makes the restart sweep send the interrupted sentence as a SECOND
    // edit onto the same anchor, and later-wins paints it over the good
    // final. Accepted: the outcome is an honest-but-worse sentence on a
    // delivered answer — never a lost reply, never a re-run — and closing
    // the window would take the send and this journal write being one
    // atomic step across a process boundary that offers none.
    const cleared = readJournalFile(account);
    delete cleared.streamAnchor;
    writeJournalFile(account, cleared);
    return true;
  };

  /**
   * THE PASS'S ONE CADENCE LOOP — the steer poller and the typing
   * cadence sharing a single `io.sleep` loop, deliberately: two
   * sibling loops on one fake clock would advance a test's time twice as
   * fast as production's, and two on a real clock are two poll tails at turn
   * end. Same clock seams (`io.sleep`/`io.now` — moving-clock testable, per
   * the frozen-clock rule), same spool reader (`pendingRows`), and covered
   * by the SAME `turnOver` end condition, so no loop outlives the turn —
   * `runTurn`'s finally sets the bound even when the turn THROWS, which the
   * old attach-time loop start left uncovered.
   *
   * The STEER half runs only after a driver surfaces a live turn's steer
   * call — which only the codex app-server driver can — and it is DEFAULT-ON
   * for those accounts.
   *
   * THE PREDICATE, all of, and the order is cheapest-refusal-first:
   *   - triggers(row)                    — `pendingRows` applies the one
   *                                        predicate already;
   *   - not a row this turn already owns — the group is being answered, a
   *                                        journalled steered id was consumed;
   *   - not an approval answer           — ref ≠ any approval row's msgId,
   *                                        any state: the answer channel is
   *                                        never a prompt, so it is
   *                                        never a steer either;
   *   - no approval in flight            — steer-during-park is UNMEASURED
   *                                        and therefore forbidden, not
   *                                        solved;
   *   - routeKey(row) equals the running turn's — the routed key, or the
   *                                        thread the driver reported the
   *                                        turn runs as (gated through
   *                                        `hostSessionKey` like every
   *                                        frame-borne key);
   *   - a turn token available           — one per delivered steer
   *                                       . Broke ⇒ the row QUEUES —
   *                                        never a silent drop; the next
   *                                        pass answers it under its own
   *                                        token.
   *
   * THE CURSOR IS NEVER TOUCHED IN HERE — consumption is recorded
   * on the journal's `steered` list, journal-FIRST, and later passes step
   * the consumed row over exactly as they step approval-spent rows.
   *
   * `live.steer` never rejects (the client's contract); a rejection here is
   * therefore a CRASH and is left to unwind — the journalled id is exactly
   * what answers for it, the same way a dying `sendReply` answers to the
   * approval journal's boundary 1↔2.
   */
  // Widened like `steerLive` above: assigned only inside the sleep closure.
  let wakePoll = null as (() => void) | null;
  const pollSleep: (ms: number) => Promise<void> =
    io.sleep ??
    ((ms: number) =>
      new Promise<void>(res => {
        // The loop's OWN real sleep, cancellable so turn end never trails a
        // poll tail — the shared `sleep` above stays plain on purpose: the
        // ask park must keep genuinely waiting, and an injected fake keeps
        // its exact call pattern (it resolves on its own; `wakePoll` stays
        // null and the turnOver check after the await is the whole bound).
        const t = setTimeout(() => {
          wakePoll = null;
          res();
        }, ms);
        wakePoll = () => {
          clearTimeout(t);
          wakePoll = null;
          res();
        };
      }));
  const loopDone = (async (): Promise<void> => {
    try {
      for (;;) {
        if (turnOver) return;
        await pollSleep(ATTEND_POLL_MS);
        if (turnOver) return;
        typingTick(tick());
        // The stream tenant — the awaited anchor mint and the
        // detached edit emission both live on this same tick; see the
        // block above the loop for why there is no sibling loop.
        await streamTick();
        const live = steerLive;
        if (live === null) continue;
        const approvals = loadApprovals(account).rows;
        if (
          approvals.some(
            r => r.state === 'asking' || r.state === 'pending' || r.state === 'answering',
          )
        ) {
          continue;
        }
        const answerRefs = new Set(
          approvals.map(r => r.msgId).filter((m): m is string => typeof m === 'string'),
        );
        const consumed = new Set(readJournalFile(account).steered ?? []);
        const ledgerNow = new MessageLog(account).read({ dir: 'out' });
        for (const row of pendingRows(account, owner)) {
          if (turnOver) return;
          if (groupIds.has(row.id) || consumed.has(row.id)) continue;
          // ROOMS QUEUE, NEVER STEER — pinned here EXPLICITLY,
          // not left to the routeKey inequality alone, and this is the
          // ROW-side half: no room row may steer the running 1:1 turn. The
          // TURN-side half lives on `steerable` below — a ROOM turn attaches
          // no steer surface at all, so this scan never even arms during
          // one (which is what keeps an owner 1:1 DM out of a room turn;
          // the grp pin alone could not, because a DM has no grp). A
          // mid-turn room row takes the MID_TURN_MARKER path like every
          // other queued arrival.
          if (row.grp !== undefined) continue;
          if (row.ref !== undefined && answerRefs.has(row.ref)) continue;
          if (!runningKeys.has(routeKey(routeIn(ledgerNow, [row], tick(), cfg.host)))) continue;
          if (!takeTurnToken(account, cfg, tick())) continue; // broke ⇒ queue
          // JOURNAL FIRST: the id is on disk before turn/steer leaves.
          noteSteered(account, row.id);
          consumed.add(row.id);
          const got = await live.steer(row.text);
          if (got === 'not-delivered') {
            // Provably undelivered (the server's own error frame, or never
            // sent): un-journal so the row re-presents exactly once, and
            // hand the token back — the bucket bills delivered steers only.
            unnoteSteered(account, row.id);
            consumed.delete(row.id);
            refundSteerToken(account, tick());
            continue;
          }
          // Delivered — or unconfirmed (`failed`: the child died with the
          // frame in flight). Both are CONSUMED: a maybe-delivered message
          // re-run is a second delivery, the one direction this never
          // guesses in. Unconfirmed additionally buys the operator one
          // honest sentence at turn end.
          steeredNow.push(row.id);
          if (got === 'failed') steerUnconfirmed += 1;
        }
      }
    } finally {
      // The typing epilogue, on EVERY exit — turnOver, a steer crash
      // unwinding, a scan throw. `stop` leaves only when a start ever did
      // and no emission is mid-flight (closing under a live dial is worse
      // than the ≤15 s of indicator the app's expiry retires anyway); the
      // real channel's stop is local crypto plus one sync frame, so the
      // await here is milliseconds — its seal-queue turn behind a straggling
      // edit included — never a network wait.
      if (typingChannel !== null) {
        const chan = typingChannel;
        if (typingStarted && !typingBusy) {
          try {
            await enqueueSealed(account, () => chan.send('stop'));
          } catch {
            /* the app's expiry covers a lost stop */
          }
        }
        typingChannel.close();
      }
    }
  })();
  // A rejection out of the loop is a CRASH (the steer contract says the
  // call never rejects), and it unwinds the pass at the `await` below —
  // journal-first is what answers for it. The no-op handler here only
  // keeps an early rejection from escalating to an unhandled-rejection
  // process kill while the turn is still running; the awaited original
  // still rethrows.
  void loopDone.catch(() => {});
  // The capability is attached ONLY where the wire supports it — the codex
  // app-server profile. The spawn-seam drivers never receive the member at
  // all (the seam shape): claude and codex-exec have no channel to a
  // running turn, so a steer surface there would be a promise nothing keeps.
  //
  // AND NEVER FOR A ROOM TURN. Steering is a 1:1-only surface in v1,
  // and the poller's row-side pin (`row.grp`) is only half
  // of that: a ROOM turn resumes the room's stored thread, the client
  // surfaces that thread key on the steer call, and `runningKeys` would
  // then hold it — so any grp-less owner DM that resolves to it (a reply
  // ref through a sess-bearing ledger row, or the live window) would ride
  // `turn/steer` INTO the room turn: private 1:1 words shaping — and
  // quotable in — an answer that fans to every room member, with the DM
  // journal-consumed and never answered 1:1. A room turn therefore attaches
  // NO steer surface at all; its mid-turn arrivals take the MID_TURN_MARKER
  // queue like every claude and codex-exec arrival.
  const steerable =
    cfg.host === 'codex' && cfg.codexDriver === 'app-server' && head.kind !== 'room';

  // JOURNAL BEFORE SPAWN: if this pass dies inside the turn, the next one
  // finds this row still pending and answers it rather than re-executing.
  // The id lists ride along untouched — mid-turn markers for rows this
  // group does not cover, steered ids a previous turn consumed — because an
  // overwrite here would orphan the rows they still answer for.
  const priorJournal = readJournalFile(account);
  // A NEW turn must not inherit a dead turn's anchor: every settle path
  // already retires `streamAnchor`, so this delete is the belt — an anchor
  // that somehow survived would aim this turn's crash edit at a bubble a
  // different turn owns.
  delete priorJournal.streamAnchor;
  writeJournalFile(account, { ...priorJournal, upTo: last.id, startedAt: now });

  // THE TURN IS THE DRIVER'S — argv shape, refusal classification and any
  // startup-refusal recovery are host property (attend-drivers.ts). The pass
  // holds exactly ONE turn token, taken above; a driver may spawn at most
  // TWICE and only when the first spawn proved no model was called.
  const runDriverTurn = (): ReturnType<ReturnType<typeof driverFor>['runTurn']> =>
    driverFor(cfg.host).runTurn(
      {
        cfg: driverCfg,
        route: driverRoute,
        prompt,
        account,
        // NEVER FOR A ROOM TURN (the consent remediation): the ask
        // funnel is the approval capability, and a room turn carries none —
        // the same `head.kind !== 'room'` guard `steerable` and the ask-key
        // arm already apply. Without the funnel the claude sdk `canUseTool`
        // relay denies without asking (its documented fail-closed shape) and
        // the app-server driver's ask seam declines — beside the forced
        // `codexApprovalPolicy: 'never'` above, which keeps the host from
        // soliciting at all. No card is minted, nothing parks: the floor is
        // terminal, and the owner is never asked to escalate a turn whose
        // words a non-owner may have authored.
        ...(head.kind !== 'room' ? { ask } : {}),
        ...(steerable ? { steering } : {}),
        // Attached ONLY when every stream gate passed (the arming predicate
        // above) — an unarmed turn's driver never learns the seam exists,
        // which is what keeps the un-attested path byte-identical.
        ...(streamArmed ? { stream: onStreamSnapshot } : {}),
      },
      { spawn, session },
    );
  let turn!: Awaited<ReturnType<typeof runDriverTurn>>;
  try {
    turn = await runDriverTurn();
  } finally {
    // THE TURN-OVER BOUND, unconditional: a turn that THROWS must end the
    // cadence loop exactly as a turn that returns does — before this
    // finally, a rejecting app-server turn left the attached poller
    // spinning for the life of the process. On the throw path the loop
    // self-terminates at its next turnOver check (`wakePoll` cuts a real
    // sleep short; its finally closes the typing channel) while the
    // original error unwinds the pass — the journal's interrupted arm
    // answers for the turn either way.
    turnOver = true;
    wakePoll?.();
  }
  // The loop is covered by the turnOver end condition — awaited here so
  // nothing outlives the turn, the same discipline the floating ask loop's
  // lapse arm enforces from its side; a steer crash parked in it rethrows
  // out of this await and unwinds the pass.
  await loopDone;

  /**
   * THE REPLY-CONTINUATION FALLBACK, turn-time half (the route-time half is
   * `Route.kind 'carry'`). A ROUTED session the host refused at STARTUP —
   * `no-conversation` (the operator's session, gone from the host's store;
   * the driver rightly refuses to re-create someone else's transcript) or
   * `live-session` that survived the driver's own --fork-session recovery —
   * used to end in the dead-end failure reply. Both refusals are in
   * `HOST_REFUSALS`' measured set: they happen BEFORE any model is called,
   * so the fallback spawn is free and rides the ONE token this pass already
   * holds, exactly the argument the driver's recovery makes. The re-run is a
   * fresh OWN turn whose prompt is the same group behind the carry context
   * line quoting the ledger row the reply referenced (prompt only).
   *
   * Refusals are CLAUDE-SUBPROCESS property (the only driver with a refusal
   * table), so this block re-enters a driver whose ask/steer surfaces are
   * inert — nothing here can re-open the ask funnel the settle below already
   * accounts for. A turn that RAN and failed (`refusal === null`) keeps the
   * honest failure reply: its budget is spent and a re-run would execute an
   * agent turn twice. The typing-indicator cadence ended with the first
   * spawn's turnOver and is not restarted — cosmetic, and bounded by the
   * fallback being a startup-refusal path.
   */
  // ONLY FOR A REPLY. A session route also arises from a BARE text and the
  // 2-hour live window (router rule 2) — no ref, nothing replied to — and a
  // "[replying to …]" line there would be the supervisor putting words in
  // the owner's mouth. The bare shape keeps the honest failure reply; the
  // context is the FIRST ref-bearing row's referent, the earliest message
  // this group answers.
  const carriedRefId = group.map(r => r.ref).find((r): r is string => r !== undefined);
  let fellBack = false;
  if (
    head.kind === 'session' &&
    turn.code !== 0 &&
    (turn.refusal === 'no-conversation' || turn.refusal === 'live-session') &&
    carriedRefId !== undefined
  ) {
    const refRow = ledger.find(r => r.id === carriedRefId);
    const fallbackPrompt = `${carryContextLine(refRow?.text ?? '')}\n${joined}`;
    turn = await driverFor(cfg.host).runTurn(
      { cfg, route: { kind: 'own' }, prompt: fallbackPrompt, account, ask },
      { spawn, session },
    );
    fellBack = true;
  }

  // What the replies below SPEAK FOR. `turnSess` when the route knew a
  // session up front; otherwise the key the driver captured mid-turn
  // (an app-server own turn's `thread/start` id), gated through
  // `hostSessionKey` exactly as a ledger row is on the way OUT, because
  // this value came off a host frame and is about to be written where the
  // router will trust it. With the row carrying it, a reply to this answer
  // routes to the thread instead of `ended`, and the next bare message
  // resumes it — the continuity, driver-side at last.
  const capturedKey = turn.sessionKey !== undefined ? hostSessionKey(turn.sessionKey) : undefined;
  // A ROOM turn's captured thread key (codex app-server or claude sdk,
  // first turn in this room) becomes the room's stored continuity — the
  // "captured thread key" half of the session table, which the
  // capture-shaped room arm joined. Gated through `hostSessionKey` above,
  // exactly as every frame-borne key is.
  if (
    head.kind === 'room' &&
    ((cfg.host === 'codex' && cfg.codexDriver === 'app-server') ||
      (cfg.host === 'claude' && cfg.claudeDriver === 'sdk')) &&
    capturedKey !== undefined &&
    roomSessKey === undefined
  ) {
    saveRoomSession(account, head.gid, { key: capturedKey });
  }
  // A ROOM turn's captured key goes to the room STORE above and nowhere
  // else — `turnSess`'s room rule again: a room turn's 1:1 side messages
  // are sessionless, so the room thread key never enters the 1:1 out
  // ledger through this arm either.
  // A FALLBACK answer must not speak for the dead routed key: a reply to it
  // would route straight back into the refusal (another token per round),
  // and the row would claim a transcript the answer never came from. It
  // speaks for the OWN session the fallback actually ran — the same row an
  // own turn writes — so the conversation continues where the words now are.
  const saidSess: OutSess | undefined = fellBack
    ? { host: cfg.host, key: cfg.ownSession, tag: sessionTag(cfg.ownSession) }
    : (turnSess ??
      (head.kind !== 'room' && capturedKey !== undefined
        ? { host: cfg.host, key: capturedKey, tag: sessionTag(capturedKey) }
        : undefined));

  // Write 4: the host acknowledged — the turn that carried the ask reported
  // back, whatever its exit code says about the turn itself. A row still
  // short of a decision here was abandoned by the driver mid-ask and lapses,
  // the restart rule applied without the restart.
  if (askedRows.length > 0) {
    const doneAt = tick();
    mutateApprovals(account, file => {
      for (let i = 0; i < file.rows.length; i += 1) {
        const row = file.rows[i] as ApprovalRow;
        if (!askedRows.includes(row.id)) continue;
        if (row.state === 'answering') {
          // An edit's terminal state NAMES the displacement: the wire saw a
          // decline (all it admits), but `done` would claim the request was
          // answered when it was replaced — and the late-answer sentences
          // above tell those two stories differently on purpose.
          file.rows[i] = {
            ...row,
            state: row.via === 'edit' ? 'superseded' : 'done',
            settledAt: doneAt,
          };
        } else if (row.state === 'asking' || row.state === 'pending') {
          file.rows[i] = { ...row, state: 'lapsed', settledAt: doneAt };
        }
      }
    });
  }

  // Written on EVERY path, success or failure, before the reply: a fact the
  // host just told us about its own store does not become less true because
  // the turn that discovered it went on to fail. A ROOM turn's observation
  // is about the ROOM's pinned session (the driver ran the own form under a
  // per-turn cfg override), so it lands on the room's entry and MUST NOT
  // touch the config — writing it there would wedge the real own session on
  // the next bare message.
  if (head.kind === 'room') {
    if (cfg.host === 'claude' && roomSessKey !== undefined && turn.ownExists !== undefined) {
      saveRoomSession(account, head.gid, { key: roomSessKey, started: turn.ownExists });
    }
  } else if (turn.ownExists !== undefined && turn.ownExists !== (cfg.ownSessionStarted === true)) {
    saveAttendConfig(account, { ...cfg, ownSessionStarted: turn.ownExists });
  }

  /**
   * What the pass leaves in the journal, called AFTER the
   * cursor advance on every turn-end path: the live-turn half retires,
   * delivered-steer ids still pending stay to be stepped over, and rows
   * that ARRIVED while this turn ran — present now, absent from the
   * pass-start batch, not consumed by a steer — are recorded so the next
   * pass's prompt can mark them. The advance-then-settle order is the same
   * one the prior clear kept: a crash between the two leaves a spent
   * `upTo` beside live id lists, and the spent-journal branch above retains
   * exactly those.
   */
  const settleTurn = (): void => {
    const after = pendingRows(account, owner);
    const consumed = new Set(steeredNow);
    // A row the approval journal consumed — a decider, a spent verb — was
    // ACTED ON mid-turn, not queued: the park answered it. It is stepped
    // over or re-presented by ITS OWN rules (a respond decider's second
    // life keeps the exact prompt bytes), so it is never a marker row.
    for (const r of loadApprovals(account).rows) {
      if (r.answerId !== undefined) consumed.add(r.answerId);
      for (const s of r.spent ?? []) consumed.add(s);
    }
    const arrived = after.filter(r => !batchIds.has(r.id) && !consumed.has(r.id)).map(r => r.id);
    settleJournal(account, new Set(after.map(r => r.id)), {
      steered: steeredNow,
      midTurn: arrived,
    });
  };
  // The UNCONFIRMED steer's one honest sentence: a maybe-delivered reply is
  // consumed (never re-run — a second delivery is the risk), so the operator
  // must be told the delivery is unconfirmed, or the consumption would be a
  // silent drop wearing at-most-once clothes.
  const unconfirmedClause =
    steerUnconfirmed === 0
      ? ''
      : steerUnconfirmed === 1
        ? ' A reply you sent while the turn ran may not have reached it; it was not re-run — ' +
          'send it again if you still want it.'
        : ` ${steerUnconfirmed} replies you sent while the turn ran may not have reached it; ` +
          'they were not re-run — send them again if you still want them.';

  const said = hostExplanation(turn.stdout, turn.stderr, turn.refusal);
  // EVERY turn-end path below owes a minted anchor its durable final
  // (`finalizeStream`): failure sentences included, because a bubble frozen
  // mid-sentence over a turn that died is exactly the stuck bubble the
  // final exists to prevent. A false return is today's reply path,
  // byte-identical — which is also the whole path whenever no anchor exists.
  if (turn.code === 127) {
    const failText =
      (said === ''
        ? 'The agent binary is missing or not runnable on this machine. Nothing was executed.'
        : `The agent binary is missing or not runnable on this machine: ${said}`) +
      unconfirmedClause;
    if (!(await finalizeStream(funnel(failText), saidSess))) await reply(failText, saidSess);
    advanceTo(last);
    settleTurn();
    return 'failed';
  }
  if (turn.code !== 0) {
    const failText =
      (said === ''
        ? `The turn failed (exit ${turn.code}) and said nothing.`
        : `The turn failed (exit ${turn.code}): ${said}`) + unconfirmedClause;
    if (!(await finalizeStream(funnel(failText), saidSess))) await reply(failText, saidSess);
    advanceTo(last);
    settleTurn();
    return 'failed';
  }
  // The funnel FIRST, then the emptiness test. Testing `stdout` instead sent
  // an empty message whenever the funnel reduced the output to nothing — a
  // page of rules and fences degrades to '' — and recorded it as answered.
  // The funnel applies to the ROOM path too: `ATTEND_REPLY_CAP` is
  // the reply budget wherever the reply lands, and 2,000 sits far under the
  // 20,000-char MAX_GROUP_BODY, so the fan-out's own bound can never refuse
  // what the funnel passed.
  const body = funnel(turn.stdout);
  if (head.kind === 'room' && body !== '') {
    // THE ANSWER GOES INTO THE ROOM — the one thing the room path carries.
    // Everything else attend says (excuses, failures, this partial-failure
    // notice) stays 1:1 to the owner: machinery noise is not conversation,
    // and the owner is the only party who can act on any of it.
    const roomSend =
      io.sendRoomReply ?? ((g: string, b: string) => realSendRoomReply(account, g, b));
    const sent = await roomSend(head.gid, body);
    if (sent.refused !== undefined) {
      await reply(
        'The answer could not be posted: this account is not in that room any more ' +
          '(or the room is gone from this machine). Nothing reached the room.',
        saidSess,
      );
    } else if (sent.failed.length > 0 || sent.skipped.length > 0) {
      // Debt-first, then the notice, through the ONE settle implementation —
      // a crash between the two re-presents the debt at the next pass's
      // sweep, so the owner is never silently unpaid. At-least-once (the
      // settle comment holds the crash-window argument); never a retry loop.
      const debt = {
        gid: head.gid,
        failed: sent.failed,
        skipped: sent.skipped.length,
        at: tick(),
      };
      writeJournalFile(account, { ...readJournalFile(account), roomDebt: debt });
      await settleRoomDebt(debt);
    }
  } else if (body === '') {
    // An anchor with nothing behind it (the funnel emptied the last
    // agentMessage) still gets the honest final: the same sentence today's
    // path sends, in the bubble instead of beside it.
    const noneText = 'Turn finished, no output.';
    if (!(await finalizeStream(funnel(noneText), saidSess))) await reply(noneText, saidSess);
  } else {
    if (!(await finalizeStream(body, saidSess))) await send(body, saidSess);
  }
  if (unconfirmedClause !== '') await reply(unconfirmedClause.trim(), saidSess);
  advanceTo(last);
  settleTurn();
  return 'answered';
}

/**
 * The two conditions a supervised answerer may legitimately die of, marked on
 * the error itself rather than left to be recognised by its prose.
 *
 * `CliError.code` exists for exactly this — "carried as a field because the
 * alternative was reading it back out of the formatted message with
 * includes(), which is a match against prose". The distinction matters more
 * here than anywhere: what the loop must NOT treat as terminal is also a
 * `CliError` with `EXIT.ERROR` (every lock refusal is), so the class and the
 * exit code separate nothing.
 */
const TERMINAL_NOT_ENABLED = 'attend_not_enabled';
const TERMINAL_NOT_PAIRED = 'attend_not_paired';

/**
 * Is this the loop's own death, or somebody else's bad afternoon?
 *
 * THE DEFAULT IS "TRANSIENT", AND THE INVERSION IS THE FIX. The loop used to
 * rethrow every `CliError`, on the reading that config and pairing errors are
 * terminal — which they are, but they are not the only `CliError` that reaches
 * here. Every lock refusal in this package is one: `is held` from the ratchet
 * lock inside the reply path, from the spool's `messages.lock`, from the
 * bucket. So the supervised answerer killed itself over a sibling `send`
 * holding the ratchet for a few hundred milliseconds, which is the precise
 * opposite of what supervision is for — and launchd then restarted it into the
 * same contention, at the throttle floor, with nothing in the log but a lock
 * path. Contention is the most ordinary thing that happens to a daemon sharing
 * an account directory; it is the shape the product documents.
 *
 * Enumerating the terminal cases and treating everything else as retryable is
 * the safe direction of the two: a mis-classified transient error costs one
 * wasted 2-second poll, while a mis-classified terminal one costs the operator
 * an answerer that is silently not running.
 */
function isTerminal(err: unknown): boolean {
  return (
    err instanceof CliError &&
    (err.code === TERMINAL_NOT_ENABLED || err.code === TERMINAL_NOT_PAIRED)
  );
}

/** The daemon loop `tacendum attend <account>` runs under its unit: poll the
 * spool, answer, sleep. fs-event acceleration can join later; a 2-second
 * poll against a local jsonl is imperceptible and has no missed-event
 * mode to debug at 2am. */
export async function attendLoop(account: string, report: Reporter, io: AttendIo = {}): Promise<never> {
  report.status('attending…');
  for (;;) {
    try {
      await attendOnce(account, io);
    } catch (err) {
      // Only attend's own config/pairing refusals end the loop. Everything
      // else — lock contention above all — is the next pass's problem, and
      // the cursor guarantees nothing is skipped in the meantime.
      if (isTerminal(err)) throw err;
    }
    await new Promise(res => setTimeout(res, 2000));
  }
}

export function attendEnabled(account: string): boolean {
  return existsSync(configPath(account));
}

/**
 * The REAL reply transport: the one send sequence, role 'send', msgId minted
 * per reply, and on failure the notify queue — whose claim-by-rename retry
 * machinery already exists — keeps it.
 *
 * IT NOW WRITES THE OUTBOUND LEDGER ROW IT NEVER WROTE. The hook
 * path records msgId -> session at delivery (`ledgerOutRow`, hooks.ts), which
 * is the only reason a phone's long-press reply resolves to anything; attend
 * replied through here with NO row, so a reply to anything attend said routed
 * to `kind:'ended'` — and an approval answered by reply-ref is exactly such a
 * reply. The row below is the hook writer's shape FOLLOWED, not re-designed:
 * `read: true` from birth (the operator "read" their own notification on the
 * phone; a machine-polluted unread count teaches people to ignore it),
 * `text: ''` (the body already exists on the phone; a third plaintext copy
 * that outlives both buys routing nothing), `sess` when the reply speaks for
 * a session. Best-effort like the hook's: a failed row costs a route, never
 * a delivery.
 *
 * The msgId is minted HERE, before the send, because both failure shapes need
 * it: on delivery it keys the ledger row, and on failure it rides the queue
 * entry with `sess` so the flusher's own `ledgerOutRow` writes the IDENTICAL
 * row when the retry lands — one implementation of the retry path, the
 * hook's, reused rather than mirrored.
 */
/**
 * The REAL typing channel — the byte-compatible sibling of
 * the app's `sendTypingState` (app/src/messaging.ts), built from the same
 * parts the CLI already sends `x.*` envelopes with: the envelope is the
 * app's exact 1:1 wire form `{"tcm":"x.typing","state":…}` (`room` ABSENT —
 * app/src/envelope.ts `TypingEnvelope` is the parsing contract; a two-field
 * literal needs no schema pass, and the bytes are pinned by test), sealed by
 * `encryptText` under the ratchet lock exactly as `sendEncryptedAll` seals a
 * card, then framed as the relay-only `typing` ClientFrame — never `send`:
 * no msgId, no receipt wait, no queue row, no outbox. The ~35-byte envelope
 * sits five hundred times under `MAX_BODY_BYTES`, so the cap guard —
 * which this path deliberately bypasses along with the rest of the durable
 * send machinery — loses nothing it was protecting.
 *
 * ONE 'send'-role socket per turn, dialled lazily at the first emission and
 * reused: that role never claims the account's routing row (dto.ts), so it
 * cannot displace the listener or contend with a concurrent approval-card
 * dial — and one dial per turn keeps the `wsticket` budget (30/min, shared
 * with every real send) essentially untouched, where per-emission dials
 * would spend a quarter of it for the length of a turn.
 *
 * THE GATES, in order, every one a silent drop (the app's discipline):
 *   dead → no ratchet session (typing NEVER bootstraps X3DH — the session
 *   always exists in production, because the owner's own sealed message is
 *   what triggered the turn) → dial → seal → send. ANY refusal marks the
 *   channel dead for the REST OF THE TURN: chatter that just refused will
 *   refuse again in 7.5 s, the phone's expiry has already retired the
 *   indicator, and the next turn's channel starts fresh. Nothing is logged,
 *   counted, retried or surfaced — and a frame sent into a
 *   socket that died mid-turn is `ws.send`'s documented silent drop, which
 *   is this posture already.
 */
function realTypingChannel(account: string, to: string): TypingChannel {
  const stores = new FileStores(account);
  const auth = new AuthSession(account, stores);
  let ws: WsClient | null = null;
  let state: 'idle' | 'dialing' | 'open' | 'dead' = 'idle';
  /**
   * ONE emission path for both members: the gates, the dial, the liveness
   * check, the seal and the frame are implemented exactly once, so the
   * stream `edit` member cannot drift from the typing contract it rides on —
   * same socket, same relay-only `typing` frame (the ciphertext is what
   * makes an `x.edit` indistinguishable from an `x.typing` refresh; the
   * empty-server-diff decision stands on that), same silent-drop-then-dead
   * failure posture.
   */
  const emit = async (body: string): Promise<void> => {
    if (state === 'dead' || state === 'dialing') return;
    try {
      if (!(await hasSession(stores, to))) return; // never bootstrap X3DH for chatter
      if (ws === null) {
        state = 'dialing';
        const sock = new WsClient();
        await sock.connect(auth, 'send');
        if ((state as string) === 'dead') {
          // close() ran while the dial was in flight: the turn is over,
          // the socket is unwanted, and closing it here is the handover
          // close() deferred to this path.
          sock.close();
          return;
        }
        ws = sock;
        state = 'open';
      }
      // CONNECT-BEFORE-RATCHET, ENFORCED (send.ts owns the rule; this is
      // the call-session.ts-shaped exemption, and gate.send-owner.test.ts
      // holds this file to it): the dial above precedes any ratchet work,
      // and on the REUSE path this liveness gate refuses before the chain
      // advances for a frame `ws.send` would silently drop into a dead
      // socket — a turn's worth of refreshes into a died-mid-turn socket
      // would otherwise be a pile of skipped keys the owner's ratchet has
      // to absorb for frames nobody could receive. The throw lands in the
      // catch below: dead, silent, zero advances (proven by the
      // dead-transport tests in attend.typing.test.ts).
      if (!ws.isOpen()) {
        throw new Error('typing socket closed — refusing to advance the ratchet');
      }
      const sealed = await withFileLockAsync(stores.ratchetLockPath(), () =>
        encryptText(stores, auth.userId, to, body),
      );
      ws.send({ type: 'typing', to, msgType: sealed.msgType, payload: sealed.payload });
    } catch {
      state = 'dead';
      try {
        ws?.close();
      } catch {
        /* already down */
      }
      ws = null;
    }
  };
  return {
    // `ai: true` rides the chatter too: typing is agent-authored
    // like everything else this channel seals, the field is invisible to
    // every shipped build (TypingEnvelope strips unknown keys), and a lane
    // exempted from the marker would be the one compose path the coverage
    // pin swears does not exist.
    send: (s: 'start' | 'stop') => emit(JSON.stringify({ tcm: 'x.typing', state: s, ai: true })),
    // The stream intermediate: the caller hands composed
    // StreamEditEnvelope bytes (`composeStreamEdit` refused anything
    // malformed at the source); this side adds nothing and checks nothing —
    // the emission contract is the seal and the frame, shared above.
    edit: (body: string) => emit(body),
    close(): void {
      if (state === 'dialing') {
        state = 'dead'; // the in-flight dial's own path closes the socket
        return;
      }
      state = 'dead';
      try {
        ws?.close();
      } catch {
        /* already down */
      }
      ws = null;
    },
  };
}

export async function realSendReply(
  account: string,
  body: string,
  sess?: OutSess,
  /** `notify: false` marks a CARRIER frame (send.ts
   * `OutboundMessage.notify`) — the durable stream-final `{tcm:'edit'}`
   * must not ring a phone its anchor already rang. Omitted means notify
   * normally: every pre-stream caller is unchanged. */
  opts: { notify?: boolean } = {},
): Promise<string> {
  const profile = loadProfile(account);
  const owner = profile.ownerUserId as string;
  const stores = new FileStores(account);
  const auth = new AuthSession(account, stores);
  const msgId = ulid();
  try {
    // TWO CALLS, NOT ONE COLLAPSED ONE, and the split is load-bearing: the
    // default path stays `sendEncrypted` — the exact call every pre-stream
    // reply made, which is also the seam the spine gate's fixture spies on
    // (gate.approval-spine.test.ts mocks that one export; folding the
    // default into the multi-message form silently walked every card and
    // reply past the own gate). Only the notify:false CARRIER — the
    // durable stream final, unreachable without the attestation —
    // rides `sendEncryptedAll`, because only the multi-message form carries
    // the per-message notify bit.
    if (opts.notify === false) {
      await sendEncryptedAll({
        stores,
        auth,
        to: owner,
        messages: [{ body, msgId, notify: false }],
      });
    } else {
      await sendEncrypted({ stores, auth, to: owner, body, msgId });
    }
  } catch {
    // The queue keeps it — including a notify:false final edit, whose late
    // durable delivery still heals the anchor (better rung-late than a
    // bubble stuck mid-sentence).
    enqueueNotification(account, owner, body, msgId, sess);
    return msgId;
  }
  try {
    new MessageLog(account).append({
      id: msgId,
      dir: 'out',
      peer: owner,
      ts: Date.now(),
      tcm: '',
      text: '',
      read: true,
      ...(sess ? { sess } : {}),
    });
  } catch {
    // Routing degrades; delivery already happened. The router's
    // ended-session answer covers the miss (the hook writer's own rule).
  }
  return msgId;
}

/**
 * The REAL room reply transport: room-commands' fan-out machinery
 * ONLY — the fold verdict gate, the per-author sq, ONE `m` for all legs, the
 * rd digest, mintLegs' CSPRNG wire ids and `sendEncryptedFanout` — a second
 * compose path here would be the two-implementations divergence §4.1 forbids.
 * On success it writes the outbound ledger row reply-to-continue joins on:
 * id `${selfUserId}.${m}` — the compound row key every member's phone derives
 * for this message, and exactly the ref the owner's long-press reply will
 * carry back — with `grp` for the SAME-grp clause. NO `sess` on the row,
 * deliberately: room continuity lives in the per-room session store keyed by
 * gid, and a session key here would let a 1:1 reply quietly resume a room
 * transcript through the ledger path (`hostSessionKey` gating unchanged —
 * a room row simply never enters that gate).
 */
export async function realSendRoomReply(
  account: string,
  gid: string,
  body: string,
): Promise<RoomReplyOutcome> {
  let sent;
  try {
    // `ai: true` — the Art. 50 marker on the grp.msg WRAPPER and, when the
    // body is itself an envelope, INSIDE it too. This is the room
    // lane's one marking site: bare funneled text stays bare, so every
    // pre-marker member still renders the words.
    sent = await sendRoomMessage(account, gid, body, undefined, undefined, { ai: true });
  } catch (err) {
    // The fold's refusal and the no-such-room refusal are conversations the
    // pass answers honestly 1:1 — never faults. Anything else (a lock, the
    // network) is a genuine failure and unwinds like one: the journal's
    // interrupted arm answers for the turn.
    if (err instanceof CliError && err.exitCode === EXIT.REFUSED) {
      return { delivered: [], skipped: [], failed: [], refused: 'not-in-room' };
    }
    if (err instanceof CliError && err.exitCode === EXIT.USAGE) {
      return { delivered: [], skipped: [], failed: [], refused: 'no-room' };
    }
    throw err;
  }
  try {
    const profile = loadProfile(account);
    new MessageLog(account).append({
      id: `${profile.userId}.${sent.m}`,
      dir: 'out',
      peer: profile.ownerUserId as string,
      ts: Date.now(),
      tcm: 'grp.msg',
      text: '',
      read: true,
      grp: gid,
    });
  } catch {
    // Routing degrades; delivery already happened (realSendReply's rule).
    // A reply-to-continue then resolves the honest `ended` answer.
  }
  return { m: sent.m, delivered: sent.delivered, skipped: sent.skipped, failed: sent.failed };
}

/** The hosts attend can drive. Not the same set as hooks.ts's HOOK_HOSTS:
 * gemini and cursor notify but have no headless resume this can spawn. */
export const ATTEND_HOSTS = ['claude', 'codex'] as const;
export type AttendHost = (typeof ATTEND_HOSTS)[number];

/** Ceiling on `--turns`. Not a policy about cost — a bound that keeps the
 * number a number: the budget is the ONE brake on a loop that spawns agents,
 * and `--turns 1e9` is a brake that does not exist. */
export const ATTEND_MAX_TURNS_PER_HOUR = 1000;

export const ATTEND_DEFAULT_TURNS_PER_HOUR = 10;

/**
 * The `model` the OPERATOR's own `~/.codex/config.toml` pins, or undefined.
 *
 * Read once, at enable time, so the isolated `CODEX_HOME` does not
 * change the operator's model silently — see `AttendConfig.codexModel` for
 * the trap this closes. The lexical machinery is toml-keys.ts's, the same
 * discipline `mergeCodexNotify` uses on the same file and for the same
 * reasons: key identity by PARSED path (a quoted `"model"` is the same key),
 * structural lines only (a `model =` inside a multiline string is prose),
 * and the top-level region only (a `model` under `[profiles.x]` is a
 * different key; profiles are a second indirection this deliberately does
 * not follow — an operator running profiles can pass `-m` through `--caps`).
 *
 * EVERY failure reads as "unpinned", including a value this cannot parse
 * with confidence (escapes, multi-line, non-string). Both failure shapes
 * change the model, but they are not symmetric: unpinned falls back to
 * codex's own supported default, while a mis-decoded name would ask codex
 * for a model that does not exist and fail EVERY turn until someone
 * re-enables — guessing is the one option with no good outcome.
 */
function operatorCodexModel(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return undefined; // no config file: codex's default IS current behaviour
  }
  const split = splitTomlLines(raw);
  if (split === null) return undefined; // mixed line endings: not a file to guess at
  const { lines } = split;
  const scan = scanTomlStructure(lines);
  if (scan.malformedAt !== null) return undefined; // the mergers refuse these too
  for (let i = 0; i < lines.length; i += 1) {
    if (!(scan.structural[i] ?? false)) continue; // value content — never a key
    const line = lines[i] ?? '';
    let j = 0;
    while (line[j] === ' ' || line[j] === '\t') j += 1;
    if (j >= line.length || line[j] === '#') continue;
    if (line[j] === '[') break; // the first top-level header ends where a bare `model` can live
    const parsed = parseKeyPath(line, j);
    if (parsed === null || line[parsed.end] !== '=') continue;
    if (parsed.path.length !== 1 || parsed.path[0] !== 'model') continue;
    const value = line.slice(parsed.end + 1).trim();
    // A single-line TOML string, escape-free (model names need none), with
    // an optional trailing comment. Anything else is a value this reader
    // cannot confidently reproduce — unpinned, per the header.
    const str = /^"([^"\\]*)"(?:\s*#.*)?$/.exec(value) ?? /^'([^']*)'(?:\s*#.*)?$/.exec(value);
    if (str === null) return undefined;
    const model = str[1] as string;
    // Printable ASCII, bounded — the shape every codex model name has. The
    // value lands in an argv element (`-c model=…`), so this is also the
    // guard that keeps a NUL or control byte out of execve.
    return /^[\x21-\x7e]{1,64}$/.test(model) ? model : undefined;
  }
  return undefined;
}

/**
 * THE ROOM CAPABILITY FLOOR: the
 * caps EVERY room-triggered turn runs under, whatever the operator granted
 * their 1:1 turns. Per host, because caps are host argv/settings:
 *
 *   codex   `-s read-only`          (exec argv; app-server translates it to
 *                                    the typed read-only sandbox)
 *   claude  `--permission-mode plan` (subprocess argv; the sdk driver
 *                                    translates it to the typed option)
 *
 * These happen to be `attend enable`'s DEFAULT profiles, and that is a
 * coincidence, not a coupling: the default is the operator's starting
 * point, free to loosen; the floor is a ruled ceiling on what non-owner-
 * visible output may meet, and it must not follow a loosened default. A
 * fresh array per call, so no caller can mutate the floor for the next.
 *
 * THE FLOOR REPLACES CAPABILITY, NOT NEUTRAL SETTINGS. `caps` carries two kinds of word: what a turn MAY DO
 * (permission modes, sandboxes — the floor's business, replaced wholesale)
 * and WHICH MODEL answers (`--model`/`-m` — the pin `attend enable`'s own
 * copy tells claude-sdk operators to put HERE, and the supported `-m` route
 * for codex exec profiles). Wiping the model words re-opened the exact trap
 * both drivers document — the unpinned SDK turn billing the host's most
 * expensive default to the operator's own API key, and room replies
 * answering from a different model than 1:1 replies with nothing saying so.
 * So the operator's model words CARRY THROUGH, by whitelist: only a flag
 * whose whole meaning is model selection is carried; every word the
 * whitelist does not recognise is REPLACED by the floor (the fail-closed
 * direction — an unrecognised word could be a permission grant, and a floor
 * that guesses is not a floor). App-server profiles are unaffected: their
 * model pin rides `cfg.codexModel`, and a `-m` in caps already refuses
 * every app-server turn at translation, room or not.
 */
export function roomCapsFloor(
  host: AttendConfig['host'],
  operatorCaps: readonly string[] = [],
): string[] {
  const floor = host === 'codex' ? ['-s', 'read-only'] : ['--permission-mode', 'plan'];
  const modelFlags = host === 'codex' ? ['-m', '--model'] : ['--model'];
  const carried: string[] = [];
  for (let i = 0; i < operatorCaps.length; i += 1) {
    const word = operatorCaps[i] as string;
    if (modelFlags.includes(word)) {
      const name = operatorCaps[i + 1];
      // The value gate is translateCapsForSdk's own: a missing, empty or
      // flag-shaped value is not a model name, and carrying it would hand
      // the host parser a word the whitelist never inspected.
      if (name !== undefined && name !== '' && !name.startsWith('-')) {
        carried.push(word, name);
        i += 1;
      }
      continue;
    }
    if (word.startsWith('--model=')) {
      const name = word.slice('--model='.length);
      if (name !== '' && !name.startsWith('-')) carried.push(word);
      continue;
    }
  }
  return [...floor, ...carried];
}

/**
 * The `--caps` value, parsed: ONE quoted string, split on whitespace. The
 * shape is what the house parser supports and nothing more: `parseArgs`
 * value flags consume exactly the NEXT argv entry, and a repeated flag
 * silently overwrites its predecessor in the flags Map — so a variadic
 * `--caps a b c` (the trailing words would parse as positionals and be
 * refused as surplus) and a repeatable `--caps` (last one would win with
 * nothing said) are both shapes this CLI cannot state honestly. One string,
 * quoted once, whitespace-split, mirrors the argv the operator would have
 * typed against the agent binary itself. The STATED limit: an element that
 * needs a literal space cannot ride this flag — attend.json is the
 * authority and can state it directly. Empty is refused rather than read as
 * "no caps": an accidental `--caps ""` that erased the capability profile
 * would be a silent WIDENING (no `-s read-only`, no plan mode), and
 * enable's standing rule is refuse rather than coerce.
 */
export function parseCapsFlag(raw: string): string[] {
  const caps = raw.split(/\s+/).filter(w => w !== '');
  if (caps.length === 0) {
    throw new CliError(
      EXIT.USAGE,
      '--caps needs at least one argument — one quoted, space-delimited string, e.g. ' +
        '--caps "-s workspace-write"',
    );
  }
  return caps;
}

/**
 * THE 5.1.2(i) DISCLOSURE READ-BACK (docs/AI-DISCLOSURE.md §4's onboarding
 * row) — ONE paragraph for BOTH host branches, on `markerReadBack`'s pattern
 * and for its reason: two verbatim copies of the same sentence are one edit
 * away from disagreeing, and this is the sentence the doc forbids varying.
 *
 * WHY HERE. `attend enable` is the deliberate act that arms the answerer, so
 * it is the last moment before the first reply can reach an AI at which the
 * data-flow can be disclosed in time — "permission first" is a placement
 * claim, and a disclosure printed after the first turn is not one. Spoken
 * unconditionally: no flag, no driver and no host changes where the operator's
 * words go, so nothing here may be gated on one.
 *
 * The plain "AI agent" clause is §4's other half (Art. 50's interaction
 * disclosure) and is this function's own words; the sentence itself is quoted
 * from the constant and must never be re-typed, re-wrapped or interpolated
 * into. Trailing space: each read-back paragraph carries its own separator,
 * the surrounding copy's convention.
 */
function disclosureReadBack(): string {
  return (
    `This account answers as an AI agent on this machine. ` +
    `${AI_DISCLOSURE_SENTENCE} `
  );
}

/**
 * The AI-marker read-back, ONE paragraph for BOTH host branches —
 * it used to live twice, verbatim, asserted by neither, and the two copies
 * were one edit away from disagreeing about the same flag (the remediation's
 * F11). With `--marker`: what was claimed, that it is a claim, and the one
 * teaching sentence — what an older build shows and the way back. WITHOUT
 * the flag the paragraph still speaks, because the envelope arm marks
 * UNGATED (ai-origin.ts holds the compatibility argument) and a read-back
 * that only disclosed marking when the flag was passed left the operator
 * believing nothing is marked. Trailing space: each read-back paragraph
 * carries its own separator, the surrounding copy's convention.
 */
function markerReadBack(markerMinAppBuild: number | undefined): string {
  // The no-flag wording deliberately names no FORM the operator did not ask
  // for: attend.test.ts pins that enable never mentions approval cards
  // unasked (plain text is the default, not a mode), so the disclosure
  // speaks of structured replies generically.
  return markerMinAppBuild === undefined
    ? `Structured replies (edit finals, approval asks) carry the AI-origin ` +
        `marker inside the encryption regardless — current app builds simply ignore ` +
        `it; bare-text replies stay unmarked until you attest your phone's app build ` +
        `with --marker. `
    : `Replies will carry the AI-origin marker inside the encryption — your ` +
        `ATTESTATION that the phone runs app build ${markerMinAppBuild} or ` +
        `newer, which attend cannot check. On an older build a marked reply ` +
        `renders "Unsupported message — update Tacendum"; if replies show that, ` +
        `re-run enable without --marker. `;
}

/**
 * `attend enable <account>` — the opt-in (off by
 * default is the rule; this is the deliberate act). Resolves the agent
 * binary ABSOLUTELY here, where the operator's PATH still exists; the unit
 * runs where PATH never met nvm. The default capability profile is claude's
 * plan mode — read-only turns until the operator widens it on purpose.
 *
 * RE-RUNNING ENABLE ON AN ALREADY-ENABLED ACCOUNT REWRITES THE WHOLE
 * PROFILE. That has been the behaviour since the first commit
 * (`saveAttendConfig` overwrites; nothing here reads the old file), and
 * it stays deliberately rather than adding an update grammar:
 * the rule is that existing accounts keep the exec driver "until
 * the operator re-states their profile", and re-running enable IS the
 * re-statement — one deliberate act that writes every durable fact at once,
 * so a profile can never be half-old. The known cost is stated, not hidden:
 * `ownSession` is minted fresh each run, so the previous own transcript
 * stops being attend's own (a reply routed to it via the ledger still
 * resumes it; only the bare-message default moves).
 *
 * EVERY OPTION IS REFUSED RATHER THAN COERCED, because this command writes a
 * config a supervised daemon then obeys for months, and both coercions it used
 * to perform were silent and wrong:
 *
 *   - `--host CODEX` (or any typo) was not 'codex', so it became CLAUDE — the
 *     operator asked for one agent and got the other, with the other's
 *     capability profile, and nothing said so;
 *   - `--turns abc` became `Number('abc')` = NaN, `JSON.stringify` wrote that
 *     to attend.json as `null`, and `0 >= null` is `0 >= 0` — TRUE. So the
 *     command exited 0, reported success, and BRICKED attend: every message
 *     from then on answered "Attend is at its hourly turn limit", forever,
 *     with the config looking fine to anyone who did not know NaN's round
 *     trip. `--turns 0` and `--turns ""` brick it the same way in one step.
 *
 * main.ts refuses both at parse time now; this is the second line of defence,
 * for every other caller of a function that writes a durable config file.
 */
export function cmdAttendEnable(
  account: string,
  opts: {
    host?: string;
    bin?: string;
    workdir?: string;
    caps?: string[];
    driver?: string;
    approvalPolicy?: string;
    approvalsMinAppBuild?: number;
    streamMinAppBuild?: number;
    markerMinAppBuild?: number;
    turnsPerHour?: number;
  },
  report: Reporter,
  // PARTIALLY WIRED: `sdkPresent` and `env` feed the sdk mode's
  // configure-time refusals (so a test can script an absent module or an
  // empty shell without holding node_modules or process.env hostage).
  // `exec` remains an UNWIRED seam, as before: the `--bin` check reaches
  // for `statSync`/`accessSync` and `resolve` shells out through
  // `execFileSync` directly, so an injected `exec` is silently ignored —
  // kept so the signature still matches its sibling `cmdAttendService`, and
  // so wiring it later is a change to this function rather than to everyone
  // who calls it.
  io: ServiceIo & {
    exec?: (file: string, args: string[]) => string;
    /** Test seam over `claudeSdkInstalled` (a node_modules resolution). */
    sdkPresent?: () => boolean;
    /** Test seam over `process.env` for the API-key presence check. */
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): void {
  const profile = loadProfile(account);
  if (!profile.ownerUserId) {
    throw new CliError(EXIT.ERROR, 'attend requires a PAIRED integration — pair it to your phone first');
  }
  // The VALUE is not echoed (and hooks.ts `requireHost` makes the same
  // call for the same reason): a misconfigured line can shift any later
  // argument into this slot, and the allowed set is the whole diagnosis.
  // EXIT.USAGE is 9 — never 2, the code Claude Code, Cursor and Gemini all
  // read as "block the agent" (exit.ts holds that table).
  if (opts.host !== undefined && !(ATTEND_HOSTS as readonly string[]).includes(opts.host)) {
    throw new CliError(EXIT.USAGE, `--host takes one of: ${ATTEND_HOSTS.join(', ')}`);
  }
  const host = (opts.host ?? 'claude') as AttendConfig['host'];
  for (const [flag, value] of [['--bin', opts.bin], ['--workdir', opts.workdir]] as const) {
    if (value !== undefined && value.trim() === '') {
      throw new CliError(EXIT.USAGE, `${flag} needs a non-empty value`);
    }
  }
  // `--driver` answers PER HOST — each host names its own pair,
  // and a value from the other host's vocabulary is refused with the right
  // set (the value itself is not echoed; the allowed set is the diagnosis):
  //   codex   exec (default) | app-server
  //   claude  subprocess (default) | sdk
  if (opts.driver !== undefined) {
    if (host === 'codex' && opts.driver !== 'exec' && opts.driver !== 'app-server') {
      throw new CliError(EXIT.USAGE, '--driver for codex takes one of: exec, app-server');
    }
    if (host === 'claude' && opts.driver !== 'subprocess' && opts.driver !== 'sdk') {
      throw new CliError(EXIT.USAGE, '--driver for claude takes one of: subprocess, sdk');
    }
  }
  const claudeSdk = host === 'claude' && opts.driver === 'sdk';
  /**
   * THE SDK MODE'S TWO CONFIGURE-TIME REFUSALS (deliberate —
   * a developer should learn at configure time, not at incident time; both
   * are re-checked at run time, because neither fact here survives to
   * launchd unchanged):
   *
   *  1. The SDK must be installed. It is an OPTIONAL dependency by licence
   *     constraint — this AGPL package never distributes Anthropic's SDK — so an
   *     install that skipped optionals leaves the mode refusing, and the
   *     refusal names the operator's own step.
   *  2. An operator-supplied API key must exist. The Agent SDK on
   *     subscription credentials is the configuration Anthropic's terms
   *     forbid to a third-party product, so enabling the sdk
   *     driver with no key in sight would configure a mode whose every turn
   *     refuses. The check here is presence in THIS shell's environment; the
   *     turn-time gate (`system/init.apiKeySource`, fail closed) is the one
   *     that judges the credential the CLI actually resolves.
   */
  if (claudeSdk) {
    if (!(io.sdkPresent ?? claudeSdkInstalled)()) {
      throw new CliError(
        EXIT.ERROR,
        'the sdk driver needs the Claude Agent SDK, which is not installed where this ' +
          'CLI runs — it ships under its own licence, so this package does not bundle ' +
          `it. Install it yourself, where the tacendum CLI is installed:\n` +
          `  ${CLAUDE_SDK_INSTALL_STEP}\n` +
          'then re-run this command. Nothing was saved.',
      );
    }
    const key = (io.env ?? process.env).ANTHROPIC_API_KEY;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new CliError(
        EXIT.ERROR,
        'the sdk driver requires an operator-supplied Anthropic API key, and ' +
          'ANTHROPIC_API_KEY is not set in this shell. A subscription sign-in is not ' +
          'accepted for this mode — approvals work with claude only under API-key ' +
          'auth. Export the key and re-run, or enable the default subprocess driver ' +
          'instead. Nothing was saved.',
      );
    }
  }
  // `--approval-policy` binds to the app-server driver's typed thread
  // settings and to nothing else — exec has NO approval surface, so a policy
  // stated for it would be a promise nothing keeps. Requiring `--driver
  // app-server` ON THE SAME LINE is deliberate: enable rewrites the whole
  // profile (the header's re-statement rule), so there is no prior field for
  // this flag to lean on. The value set is the vendored schema's, verbatim
  // (`APPROVAL_POLICIES`, codex-appserver.ts); the rejected value is not
  // echoed (the allowed set is the whole diagnosis).
  if (opts.approvalPolicy !== undefined) {
    if (host !== 'codex' || opts.driver !== 'app-server') {
      throw new CliError(
        EXIT.USAGE,
        '--approval-policy applies only to the codex app-server driver — state ' +
          '--host codex --driver app-server on the same line',
      );
    }
    if (!(APPROVAL_POLICIES as readonly string[]).includes(opts.approvalPolicy)) {
      throw new CliError(
        EXIT.USAGE,
        `--approval-policy takes one of: ${APPROVAL_POLICIES.join(', ')}`,
      );
    }
  }
  // `--approvals` — the card ATTESTATION — binds to a profile that
  // can ASK, on `--approval-policy`'s exact reasoning: exec and subprocess
  // claude have no approval surface, so an attestation written there would
  // be a claim nothing reads. The sdk driver loosened it exactly as its comment
  // promised: the claude sdk driver asks through the same seam, so it may
  // attest too. The NUMBER is validated for shape only — the CLI cannot see
  // the phone, which is the entire reason this is an attestation and not a
  // handshake — and the rejected value is not echoed (the bound is
  // the diagnosis).
  if (opts.approvalsMinAppBuild !== undefined) {
    if (!(host === 'codex' && opts.driver === 'app-server') && !claudeSdk) {
      throw new CliError(
        EXIT.USAGE,
        '--approvals applies only to a profile with an approval surface — state ' +
          '--host codex --driver app-server, or --host claude --driver sdk, on the ' +
          'same line',
      );
    }
    if (!Number.isInteger(opts.approvalsMinAppBuild) || opts.approvalsMinAppBuild < 1) {
      throw new CliError(
        EXIT.USAGE,
        "--approvals expects your phone's app build number — a positive whole number " +
          '(the About screen shows it)',
      );
    }
  }
  // `--stream` — the live-streaming ATTESTATION (`--approvals`'
  // exact sibling) — binds to the one profile that can produce a snapshot:
  // v1 is codex app-server 1:1 ONLY (claude cannot stream on either driver
  // and `codex exec` hands back one settled result), so a floor stated
  // anywhere else would be a claim nothing reads. Same shape rule, same
  // no-echo rule, same reasoning throughout.
  if (opts.streamMinAppBuild !== undefined) {
    if (host !== 'codex' || opts.driver !== 'app-server') {
      throw new CliError(
        EXIT.USAGE,
        '--stream applies only to the codex app-server driver — state ' +
          '--host codex --driver app-server on the same line',
      );
    }
    if (!Number.isInteger(opts.streamMinAppBuild) || opts.streamMinAppBuild < 1) {
      throw new CliError(
        EXIT.USAGE,
        "--stream expects your phone's app build number — a positive whole number " +
          '(the About screen shows it)',
      );
    }
  }
  // `--marker` — the AI-marker ATTESTATION (`--stream`'s sibling with
  // ONE deliberate difference: no host/driver clause, because every profile
  // sends bare-text replies and the Art. 50 marker binds to all of them).
  // Same shape rule, same no-echo rule, same fail-closed read.
  if (opts.markerMinAppBuild !== undefined) {
    if (!Number.isInteger(opts.markerMinAppBuild) || opts.markerMinAppBuild < 1) {
      throw new CliError(
        EXIT.USAGE,
        "--marker expects your phone's app build number — a positive whole number " +
          '(the About screen shows it)',
      );
    }
  }
  // Second line of defence behind `parseCapsFlag` (this function's standing
  // rule: it writes a durable config other callers can reach without
  // main.ts). Caps land verbatim in an execve argv or a typed thread
  // setting, so the one byte that must be stopped HERE is NUL — `spawn`
  // throws on it and the loop would report exit 127 turns later; empty
  // elements and an empty array are the silent-widening shapes the parser
  // already refuses.
  if (
    opts.caps !== undefined &&
    (opts.caps.length === 0 || opts.caps.some(c => c === '' || c.includes('\u0000')))
  ) {
    throw new CliError(
      EXIT.USAGE,
      '--caps needs at least one non-empty argument, with no NUL bytes',
    );
  }
  // `--bin` must name something this machine can actually execute, judged NOW,
  // while the operator is standing at the terminal that typed it. A path that
  // does not exist used to be accepted, exit 0, and persist — and the failure
  // surfaced turns later, inside attend's loop, as exit 127 reported to the
  // operator's phone as "the agent binary is missing or not runnable". The
  // config field is documented as an ABSOLUTE path (the launchd unit has
  // neither the operator's PATH nor their cwd, and spawn resolves a relative
  // bin against the workdir, not against wherever enable ran) — so a relative
  // path is refused rather than checked against the wrong base, and refusal
  // rather than resolution is this function's standing rule. The rejected
  // value is not echoed, same as every refusal above; EXIT.USAGE is
  // 9, never 2.
  if (opts.bin !== undefined) {
    if (!isAbsolute(opts.bin)) {
      throw new CliError(
        EXIT.USAGE,
        '--bin must be an absolute path — the supervised unit runs without your PATH or cwd, ' +
          'so a relative path would be resolved against the workdir at turn time, not here',
      );
    }
    let runnable = false;
    try {
      runnable = statSync(opts.bin).isFile();
      if (runnable) accessSync(opts.bin, fsConstants.X_OK);
    } catch {
      runnable = false;
    }
    if (!runnable) {
      throw new CliError(
        EXIT.USAGE,
        '--bin does not name an executable file on this machine — nothing was saved. ' +
          'Enabling it anyway would fail turns later, inside the loop, as an exit-127 ' +
          'report to your phone (the path is not echoed here; check what you passed)',
      );
    }
  }
  const turnsPerHour = opts.turnsPerHour ?? ATTEND_DEFAULT_TURNS_PER_HOUR;
  if (
    !Number.isInteger(turnsPerHour) ||
    turnsPerHour < 1 ||
    turnsPerHour > ATTEND_MAX_TURNS_PER_HOUR
  ) {
    // The bound is echoed; the rejected value is not (`--turns
    // "$SECRET"` from a misconfigured variable is the shape args.ts already
    // learned this from).
    throw new CliError(
      EXIT.USAGE,
      `--turns expects a whole number from 1 to ${ATTEND_MAX_TURNS_PER_HOUR}`,
    );
  }
  const resolve = (name: string): string => {
    try {
      return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
    } catch {
      throw new CliError(EXIT.ERROR, `the ${name} binary is not on PATH — install it or pass --bin`);
    }
  };
  // Captured BEFORE the config is written, so the file never says "enabled"
  // while the model question is still open (see `operatorCodexModel`).
  const codexModel = host === 'codex' ? operatorCodexModel() : undefined;
  const cfg: AttendConfig = {
    host,
    bin: opts.bin ?? resolve(host === 'codex' ? 'codex' : 'claude'),
    workdir: opts.workdir ?? process.cwd(),
    caps: opts.caps ?? (host === 'codex' ? ['-s', 'read-only'] : ['--permission-mode', 'plan']),
    ...(codexModel === undefined ? {} : { codexModel }),
    // Written only when STATED, all of them: absent has a meaning of its
    // own (the exec/subprocess driver; the untrusted default) and a field
    // this command invented would turn the operator's silence into a claim
    // they made. `--driver` lands on the field its host reads — the other
    // host's field stays absent, so a later `--host` change cannot inherit
    // a driver word it never validated.
    ...(opts.driver === undefined
      ? {}
      : host === 'codex'
        ? { codexDriver: opts.driver as 'exec' | 'app-server' }
        : { claudeDriver: opts.driver as 'subprocess' | 'sdk' }),
    ...(opts.approvalPolicy === undefined
      ? {}
      : { codexApprovalPolicy: opts.approvalPolicy as ApprovalPolicy }),
    ...(opts.approvalsMinAppBuild === undefined
      ? {}
      : { approvalsMinAppBuild: opts.approvalsMinAppBuild }),
    ...(opts.streamMinAppBuild === undefined
      ? {}
      : { streamMinAppBuild: opts.streamMinAppBuild }),
    ...(opts.markerMinAppBuild === undefined
      ? {}
      : { markerMinAppBuild: opts.markerMinAppBuild }),
    // A UUID, so it passes `hostSessionKey` the same way a host's own id does
    // — the own session is not a special case in the argv rules.
    ownSession: randomUUID(),
    turnsPerHour,
  };
  saveAttendConfig(account, cfg);
  // The profile word must stay TRUE of the file just written: "read-only
  // profile"/"plan-profile" describe the defaults, and an operator who just
  // stated their own caps must not read a sentence claiming otherwise.
  const profileWord =
    opts.caps !== undefined
      ? 'operator-stated caps'
      : host === 'codex'
        ? 'read-only profile'
        : 'plan-profile';
  if (host === 'codex') {
    // THE SIGN-IN ASK, STATED PLAINLY. Codex turns
    // run under an attend-owned CODEX_HOME so the operator's global config,
    // AGENTS.md, skills and MCP servers never ride a phone-triggered turn —
    // and that fresh home is signed OUT until the operator logs it in. The
    // login is NOT run here: it is interactive, and it is the operator's
    // account to grant. Printing the path is fine (enable already prints the
    // account and workdir); printing anything out of the auth file would not
    // be, and nothing here reads it.
    const codexHome = codexHomeDir(account);
    try {
      // Best-effort convenience so the login command below works verbatim;
      // the driver re-creates it on demand (0700 — it will hold auth.json,
      // a live OAuth token) so a failure here costs nothing but this shortcut.
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    } catch {
      /* the driver creates it on demand */
    }
    report.emit(
      {
        ok: true,
        action: 'attend-enabled',
        account,
        host,
        workdir: cfg.workdir,
        codexHome,
        // The driver and policy the file now states, resolved to what a turn
        // will DO (absent means exec / untrusted) — the same read-back-
        // verbatim contract caps have, on the two fields that decide whether
        // approvals exist at all.
        driver: cfg.codexDriver ?? 'exec',
        ...(cfg.codexDriver === 'app-server'
          ? { approvalPolicy: cfg.codexApprovalPolicy ?? 'untrusted' }
          : {}),
        ...(cfg.approvalsMinAppBuild === undefined
          ? {}
          : { approvalsMinAppBuild: cfg.approvalsMinAppBuild }),
        ...(cfg.streamMinAppBuild === undefined
          ? {}
          : { streamMinAppBuild: cfg.streamMinAppBuild }),
        ...(cfg.markerMinAppBuild === undefined
          ? {}
          : { markerMinAppBuild: cfg.markerMinAppBuild }),
      },
      `${account}: attend is configured (codex, ${profileWord}, ${cfg.codexDriver ?? 'exec'} ` +
        `driver). ` +
        // THE STEERING SENTENCE — the honest one, stated where the
        // behaviour is decided and never as "steers everywhere": app-server
        // accounts steer by DEFAULT (by design: it widens no capability
        // — same content, same caps and sandbox, delivered earlier), and the
        // copy says so plainly instead of silently; every other profile
        // queues and says so at the next turn (`MID_TURN_MARKER`).
        (cfg.codexDriver === 'app-server'
          ? `Replies sent while a turn runs STEER it: the agent reads them mid-turn, and ` +
            `the reply you get answers your latest message — the partial answer it ` +
            `interrupted is dropped. On claude and the codex exec driver, mid-turn ` +
            `replies arrive at the next turn instead, marked as such. `
          : `Replies sent while a turn runs arrive at the NEXT turn, marked as having ` +
            `arrived mid-turn — only the app-server driver steers a running turn. `) +
        // THE ATTESTATION, READ BACK: what was claimed, that it is a
        // claim, and the one teaching sentence — the silent-drop consequence
        // and its only signal. Absent the flag, approvals are not mentioned:
        // plain text is the standing default, not a mode.
        (cfg.approvalsMinAppBuild === undefined
          ? ''
          : `Approvals will arrive as in-chat cards — your ATTESTATION that the phone ` +
            `runs app build ${cfg.approvalsMinAppBuild} or newer, which attend cannot ` +
            `check. On an older build the card is silently dropped and the expiry deny ` +
            `is the only signal; if cards never appear, re-run enable without ` +
            `--approvals. `) +
        // The streaming attestation, read back on the --approvals pattern:
        // what was claimed, that it is a claim, and the one teaching
        // sentence — the failure an older build shows and the way back.
        (cfg.streamMinAppBuild === undefined
          ? ''
          : `Replies will STREAM into one live-updating message — your ATTESTATION ` +
            `that the phone runs app build ${cfg.streamMinAppBuild} or newer, which ` +
            `attend cannot check. On an older build the live updates are silently ` +
            `dropped and a reply can freeze at its opening words until the final ` +
            `edit lands; if replies freeze mid-sentence, re-run enable without ` +
            `--stream. `) +
        // The 5.1.2(i) disclosure — the ONE shared paragraph (see
        // `disclosureReadBack`), spoken unconditionally on both hosts.
        disclosureReadBack() +
        // The AI-marker read-back — the ONE shared paragraph (see
        // `markerReadBack`), spoken with or without the flag.
        markerReadBack(cfg.markerMinAppBuild) +
        `Codex turns run under an ` +
        `isolated CODEX_HOME, so your personal codex config, skills and MCP servers never ride ` +
        `a phone-triggered turn — and that home needs its own ONE-TIME sign-in:\n` +
        `  CODEX_HOME=${codexHome} codex login\n` +
        `Until you run it, turns fail with an auth error. Then supervise it with: ` +
        `tacendum attend service install ${account}`,
    );
    return;
  }
  const claudeDriverWord = cfg.claudeDriver ?? 'subprocess';
  report.emit(
    {
      ok: true,
      action: 'attend-enabled',
      account,
      host,
      workdir: cfg.workdir,
      // The driver the file now states, resolved to what a turn will DO
      // (absent means subprocess) — the codex emit's read-back-verbatim
      // contract, on the field that decides whether approvals exist at all.
      driver: claudeDriverWord,
      ...(cfg.approvalsMinAppBuild === undefined
        ? {}
        : { approvalsMinAppBuild: cfg.approvalsMinAppBuild }),
      ...(cfg.markerMinAppBuild === undefined
        ? {}
        : { markerMinAppBuild: cfg.markerMinAppBuild }),
    },
    `${account}: attend is configured (${host}, ${profileWord}, ${claudeDriverWord} ` +
      `driver). ` +
      // THE TWO-MODE SENTENCES, stated where the behaviour is
      // decided. The sdk copy carries the honest product sentence VERBATIM —
      // it is a sentence marketing will want to round off, and it
      // must not be — plus the two facts the operator pays for: whose key
      // every turn bills, and the model-pin trap the spike measured ($0.21
      // hello-world on the SDK's unset default).
      (claudeDriverWord === 'sdk'
        ? `Turns run the Claude Agent SDK in-process; actions the stated permission ` +
          `mode does not already allow park as approvals on your phone. This driver ` +
          `runs ONLY on an operator-supplied API key: every turn bills the ` +
          `ANTHROPIC_API_KEY that attend's environment resolves, and a start that ` +
          `resolves a subscription sign-in — or anything not recognisable as a key — ` +
          `is refused at every turn. Approvals work with codex on any sign-in, and ` +
          `with claude only when you supply an API key. Left unstated, the SDK picks ` +
          `its own (most expensive) default model — pin one in caps, e.g. ` +
          `--caps "--permission-mode default --model <name>". ` +
          (cfg.approvalsMinAppBuild === undefined
            ? ''
            : `Approvals will arrive as in-chat cards — your ATTESTATION that the ` +
              `phone runs app build ${cfg.approvalsMinAppBuild} or newer, which ` +
              `attend cannot check. On an older build the card is silently dropped ` +
              `and the expiry deny is the only signal; if cards never appear, re-run ` +
              `enable without --approvals. `)
        : '') +
      // The 5.1.2(i) disclosure — the ONE shared paragraph (see
      // `disclosureReadBack`): the data flow is the same on either host, so
      // the claude branch speaks the same words.
      disclosureReadBack() +
      // The AI-marker read-back — the ONE shared paragraph (see
      // `markerReadBack`): the marker binds to every profile, so the claude
      // branch speaks it too, with or without the flag.
      markerReadBack(cfg.markerMinAppBuild) +
      // The queue half of the honest sentence: claude has no channel to
      // a running turn (measured — `-p` closes stdin at spawn), so mid-turn
      // replies queue and the next turn's prompt says so.
      `Replies sent while a ` +
      `turn runs arrive at the next turn, marked as having arrived mid-turn. Supervise ` +
      `it with: tacendum attend service install ${account}`,
  );
}

/**
 * `attend service install|uninstall|status <account>` — the supervised unit
 * for the answerer, on the same machinery as the listener's. Install refuses
 * an account attend is not enabled for: a unit whose program exits
 * immediately is a crash-loop pinned at the throttle floor, and launchd will
 * not tell the operator why.
 */
export function cmdAttendService(
  sub: string,
  account: string | null,
  report: Reporter,
  io: ServiceIo = {},
): void {
  if (sub === 'install' && account !== null && !loadAttendConfig(account)) {
    throw new CliError(
      EXIT.ERROR,
      `attend is not enabled for ${account} — run: tacendum attend enable ${account}`,
    );
  }
  cmdService(sub, account, report, io, 'attend');
}

export function cmdAttendDisable(account: string, report: Reporter): void {
  try {
    writeFileAtomic(configPath(account), '', { mode: 0o600 });
  } catch (err) {
    // The empty file IS the disable: `loadAttendConfig` reads '' as null,
    // and null is `attendOnce`'s ONLY enablement gate — so a write that did
    // not land leaves the supervised `attend run` SPAWNING AGENT TURNS on
    // owner messages while this command claims otherwise. This catch used
    // to swallow every failure on the theory that "nothing to remove is
    // disabled enough" — true only when no config LOADS afterwards (the
    // never-enabled account whose directory refuses the write). So ask that
    // exact predicate instead of assuming it:
    // a config that still loads is an agent still armed, and EROFS, ENOSPC,
    // EACCES and EIO all reach here — atomic-write's temp file lives in the
    // same directory. `attend status` and doctor's attend check read this
    // same file now and would each contradict a false "disabled" — but only
    // when somebody runs them, so this refusal is still the one contradiction
    // the operator gets IN BAND, at the moment they believe they disabled it.
    if (loadAttendConfig(account) !== null) {
      // The errno only — a raw fs message embeds the config path, and the
      // path embeds the account's home (stores.ts's shape check).
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const errno =
        typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unclassified';
      throw new CliError(
        EXIT.ERROR,
        `attend is still ENABLED for ${account} — the disable could not be written ` +
          `(${errno}). The supervised agent keeps answering until this lands: fix the ` +
          `store (permissions, disk space) and re-run, or stop the unit first: ` +
          `tacendum attend service uninstall ${account}`,
      );
    }
    // No config loads: there was nothing to disable, and the failed write
    // changed nothing. Disabled enough, for real.
  }
  report.emit(
    { ok: true, action: 'attend-disabled', account },
    `${account}: attend is disabled — messages queue for reading, nothing executes`,
  );
}

/**
 * `tacendum attend triggers <account> [<room-gid> on|off]` — the owner's
 * per-room trigger grant: with a gid and a
 * verb it flips whether that room's CO-MEMBER structured @mentions may
 * start a turn; bare, it reads the grant list back. `AttendConfig
 * .roomTriggers` holds the field's full contract (default OFF, fail-closed
 * reads, the enable-rewrite reset); this command is its ONLY writer.
 *
 * A READ-MODIFY-WRITE of attend.json rather than an enable flag,
 * deliberately: enable's whole-profile-rewrite grammar is one act stating
 * every durable fact at once, and a per-room grant is a MUTABLE LIST that
 * changes as rooms come and go — restating bin/caps/workdir to flip one
 * room would guarantee stale restatements. Every other field rides through
 * untouched. Refuses when attend is not enabled: a grant written into a
 * config nothing loads would arm itself silently at the next enable.
 *
 * Both emissions restate the two costs the grant carries — the owner's
 * budget and the capability floor — because this is the one moment the
 * operator is provably reading.
 */
export function cmdAttendTriggers(
  account: string,
  gid: string | null,
  verb: string | null,
  report: Reporter,
): void {
  const cfg = loadAttendConfig(account);
  if (cfg === null) {
    throw new CliError(
      EXIT.ERROR,
      'attend is not enabled for this account — tacendum attend enable comes first',
    );
  }
  if (gid === null) {
    // The read-back, through the SAME reader the predicate uses
    // (roomTriggerGids), so what this prints is what triggers() consults.
    const open = [...roomTriggerGids(cfg)].sort();
    report.emit(
      { ok: true, action: 'attend-triggers', account, rooms: open },
      open.length === 0
        ? `${account}: no room lets co-members trigger this agent (the default — ` +
            `owner mentions only)`
        : `${account}: co-member @mentions may trigger in ${open.length} room` +
            `${open.length === 1 ? '' : 's'}:\n  ${open.join('\n  ')}\n` +
            `Each such turn spends YOUR hourly budget and runs read-only (plan) ` +
            `regardless of your caps.`,
    );
    return;
  }
  // The gid is validated for SHAPE only (a room id, 26 chars of Crockford
  // base32) and never for MEMBERSHIP: rooms are client-side state this
  // command must not depend on holding, and a gid for a room this machine
  // has not accepted yet simply never matches a spooled row. The rejected
  // value is not echoed.
  if (!GID_RE.test(gid)) {
    throw new CliError(
      EXIT.USAGE,
      'that is not a room id — a gid is 26 characters of Crockford base32 ' +
        '(tacendum room list <account> prints them)',
    );
  }
  if (verb !== 'on' && verb !== 'off') {
    throw new CliError(EXIT.USAGE, 'usage: tacendum attend triggers <account> <room-gid> on|off');
  }
  const open = new Set(roomTriggerGids(cfg));
  if (verb === 'on') open.add(gid);
  else open.delete(gid);
  // The arming stamps ride the same write (one act, both halves): ON dates
  // the grant NOW unless the room already holds a stamp — an idempotent
  // re-`on` must not re-date what it did not change — and OFF drops the
  // stamp with the gid. Stamps for gids the set no longer holds are swept,
  // so the two fields cannot drift apart under this, their only writer.
  const stamps: Record<string, number> = {};
  const prior = roomTriggerArm(cfg);
  for (const g of open) {
    const at = prior.get(g);
    stamps[g] = at !== undefined ? at : Date.now();
  }
  const next: AttendConfig = { ...cfg };
  if (open.size === 0) {
    delete next.roomTriggers;
    delete next.roomTriggerArmedAt;
  } else {
    next.roomTriggers = [...open].sort();
    next.roomTriggerArmedAt = stamps;
  }
  saveAttendConfig(account, next);
  report.emit(
    { ok: true, action: 'attend-triggers', account, gid, state: verb },
    verb === 'on'
      ? `${account}: room ${gid} — co-member @mentions may now trigger a turn. Only ` +
          `CURRENT members of that room count, and only mentions sent from now on — ` +
          `nothing that arrived while the room was off can fire. Each turn spends YOUR ` +
          `hourly budget (${cfg.turnsPerHour}/h), runs read-only (plan) regardless of ` +
          `your caps, and can never ask you to approve an escalation. Re-running ` +
          `attend enable resets every room to off.`
      : `${account}: room ${gid} — co-member @mentions no longer trigger (owner ` +
          `mentions only, the default)`,
  );
}

/**
 * ---------------------------------------------------------------------------
 * `tacendum attend status [<account>]` — ONE PURE READER.
 * ---------------------------------------------------------------------------
 */

/** The unit half of a status line — `statusOf`'s answer, verbatim. */
export interface AttendUnitState {
  installed: boolean;
  running: boolean;
}

/**
 * What an observer can say about one account's attend, without touching it.
 *
 * THREE NON-ENABLED STATES, NOT TWO, and the third is the point. Today
 * `loadAttendConfig` swallows every error and answers null, so to every
 * runtime caller a CORRUPT attend.json is indistinguishable from the empty
 * file `cmdAttendDisable` writes — an account whose config was mangled by a
 * bad merge or a torn restore reads as "disabled on purpose", and nothing
 * anywhere says otherwise. For `attendOnce` that collapse is safe (both mean
 * "run nothing"); for a REPORT it is a lie, so the reader distinguishes:
 *
 *   - `absent`      — no attend.json: never enabled, the ordinary state;
 *   - `disabled`    — present and empty: what `attend disable` writes;
 *   - `unparseable` — present, non-empty, and does not load: nothing chose
 *                     this, and re-enabling (or disabling cleanly) is due.
 */
export type AttendState =
  | { state: 'absent' }
  | { state: 'disabled' }
  | { state: 'unparseable' }
  | {
      state: 'enabled';
      host: AttendConfig['host'];
      /** The capability arguments, verbatim — the operator's control over
       * what a turn may do, and therefore the point of the command. */
      caps: string[];
      turnsPerHour: number;
      /** Turns spent in the CURRENT window — see the freshness rule below. */
      turnsUsed: number;
      /** Does `cfg.bin` still name a file this machine can run? The same
       * test `attend enable` made, re-asked — an nvm bump moves the path
       * after enable, and without this the operator learns at turn time, as
       * an exit-127 report to their phone. */
      binRunnable: boolean;
      workdirIsDirectory: boolean;
      /** attendOnce refuses to run unpaired; a config without a pairing is
       * an answerer that will never answer. */
      paired: boolean;
      /** `sessionTag(cfg.ownSession)` — never the raw UUID. */
      ownSessionTag: string;
      ownSessionStarted: boolean;
      /** Whether enable captured a `model` pin — the fact, never the
       * name; an unpinned codex config answers from codex's own default. */
      codexModelPinned: boolean;
      /**
       * codex only: has the isolated CODEX_HOME been SIGNED IN?
       *
       * The probe is `auth.json`, not the directory, and the difference is
       * the whole value of the field. `attend enable` best-effort creates
       * the home so its printed `CODEX_HOME=… codex login` works verbatim,
       * and the driver creates it on demand — so a directory test
       * answers "yes" from the moment enable ran and can never report the
       * one state an operator needs to be told about: enabled, configured,
       * and every turn about to fail with an auth error because the sign-in
       * was never done. `auth.json` is what `codex login` writes and what
       * `codex login status` reads; its absence is the signal.
       *
       * Existence only — the file is an OAuth token and nothing here opens
       * it, names its contents, or prints its path's contents.
       */
      codexSignedIn?: boolean;
      /** Counts and ages only — never row text, never ids. Absent
       * when unpaired: the trigger predicate needs the owner to apply. */
      pendingCount?: number;
      oldestPendingAgeMs?: number;
      /** Age of the cursor's last advance (`lastTs`) — never `lastId`. */
      cursorAgeMs?: number;
      /** Age of a journalled turn that has not reported back (`startedAt`)
       * — never `upTo`. Absent when no live journal exists. */
      journalAgeMs?: number;
      /**
       * THE APPROVAL JOURNAL, as counts and ages only (the journal's own rule
       * decided this shape at the journal itself — `ApprovalRow.payload`
       * lives in the 0600 file and on the phone's card, and NOWHERE else,
       * so what a report may carry is row counts, the over-cap counter and
       * one age; never a payload, a request id, or a msgId).
       */
      approvalsPending: number;
      approvalsSettled: number;
      /** Oldest in-flight row's age. Absent when nothing is in flight. */
      oldestPendingApprovalAgeMs?: number;
      /** C11's ongoing measurement — how often the verbatim-or-nothing rule
       * refused a one-tap. It decides whether attachments come back onto
       * the critical path, so it must be readable without opening files. */
      approvalOverCapRefusals: number;
      /**
       * WHICH FORM an ask leaves in: `card` behind an attested
       * floor, `text` otherwise — the operator's claim read back, exactly as
       * caps are. Doctor stays out of it on purpose: an attestation is the
       * operator's statement about their own phone, and there is nothing on
       * this machine a check could check.
       */
      approvalsForm: 'text' | 'card';
      /** The attested floor itself, present only when `approvalsForm` is
       * `card` — the number the operator stated, verbatim. */
      approvalsMinAppBuild?: number;
      /**
       * Rows still AWAITING AN ANSWER (`asking`/`pending`) past their own
       * TTL plus one poll of grace — a state the running system cannot
       * produce: a parked pass TTL-denies at the deadline, and a pass that
       * died is swept to `lapsed` by the NEXT pass's restart rule. So any
       * count here means no pass has run since the deadline — the answerer
       * is not running — and doctor reads it as a FAIL. (`answering` rows
       * are excluded on purpose: the decision landed and the turn that must
       * acknowledge it may legitimately run long past the ask's TTL.)
       */
      approvalsPendingPastTtl: number;
      /**
       * The room-trigger grant, read through the predicate's OWN reader
       * (`roomTriggerGids`) so status provably shows what `triggers()`
       * consults — the ONE capability that lets somebody other than the
       * owner start a turn on the owner's budget, and therefore a durable
       * fact this pure reader must state. Sorted gids; empty is
       * the default (owner mentions only). Gids are room identifiers, not
       * message ids — the same value `attend triggers` and `room list`
       * already print, so log hygiene is untouched.
       */
      roomTriggerRooms: string[];
      /** The marker attestation (`attend enable --marker`), read with
       * the send path's own shape gate (`markerShapeOk`) — the operator's
       * claim about their phone, verbatim; absent means bare text leaves
       * unmarked, the permanent default for accounts that never state it. */
      markerMinAppBuild?: number;
      /** codex only: WHICH driver runs the turn — the configured word,
       * verbatim (caps' own read-back rule), `exec` when absent. */
      codexDriver?: string;
      /** codex app-server only: how often codex asks before acting — the
       * configured word, `untrusted` when absent (the measured default). */
      codexApprovalPolicy?: string;
      /** claude only: WHICH driver runs the turn — the configured word,
       * verbatim (caps' own read-back rule), `subprocess` when absent. */
      claudeDriver?: string;
      unit: AttendUnitState;
    };

export interface AttendStateIo {
  now?: () => number;
  /** Threaded to `statusOf` (service.ts) so a test never touches the real
   * launchctl/systemctl. `statusOf` is a read of the manager, nothing more. */
  service?: ServiceIo;
}

/**
 * The reader. NO LOCK, NO `markRead`, NO `takeTurnToken` — doctor's standing
 * rule is observe-never-repair, and it binds harder here than there: this is
 * the command an operator runs when attend looks wedged, and a probe that
 * contended for the turn lock, spent a budget token, or advanced anything
 * would change the very state it was asked about. Everything below is a
 * `readFileSync`, a `statSync`, or `statusOf`'s manager query.
 * `gate.attend-status-truth.test.ts` pins the byte-identity of every state
 * file across a run of this command.
 */
export function attendState(account: string, io: AttendStateIo = {}): AttendState {
  // The three-way classification reads the file ITSELF rather than calling
  // `loadAttendConfig`, whose null deliberately collapses the states this
  // report exists to keep apart.
  let raw: string;
  try {
    raw = readFileSync(configPath(account), 'utf8');
  } catch {
    // A file that exists and cannot be read is not "never enabled" — it is a
    // config in a state nobody chose, same bucket as one that will not parse.
    return existsSync(configPath(account)) ? { state: 'unparseable' } : { state: 'absent' };
  }
  if (raw.trim() === '') return { state: 'disabled' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unparseable' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unparseable' };
  }
  // A host this build has no driver for is a config attend cannot LOAD in any
  // sense that matters — `driverFor` has no row for it — and it is also the
  // one field below that gets interpolated into report lines, so refusing it
  // here is both the honest classification and what makes every downstream
  // print of `host` safe by construction (enable validates the same set).
  if (!(ATTEND_HOSTS as readonly string[]).includes((parsed as { host?: string }).host as string)) {
    return { state: 'unparseable' };
  }
  const cfg = parsed as AttendConfig;
  const now = io.now?.() ?? Date.now();

  // THE BUCKET IS READ WITH `takeTurnToken`'S OWN FRESHNESS RULE
  // (`now - windowStart >= 3_600_000 → 0 used`), reproduced here because a
  // raw read of the file reports a FULL budget for a window that closed an
  // hour ago — which is exactly the "attend is bricked, it says hourly limit
  // forever" symptom an operator runs this command to diagnose. The file's
  // count is only true of the window it was written in; an expired window
  // means the next pass starts from zero, and the report must say what the
  // next pass will do, not what the last one saw.
  const bucket = loadJson<Bucket>(bucketPath(account));
  const turnsUsed =
    bucket !== null &&
    Number.isFinite(bucket.windowStart) &&
    Number.isFinite(bucket.turns) &&
    now - bucket.windowStart < 60 * 60 * 1000
      ? bucket.turns
      : 0;

  // The same runnability test `attend enable --bin` makes, re-asked now: the
  // path was true when it was saved, and an nvm or Herd upgrade moves it.
  let binRunnable = false;
  try {
    binRunnable = statSync(cfg.bin).isFile();
    if (binRunnable) accessSync(cfg.bin, fsConstants.X_OK);
  } catch {
    binRunnable = false;
  }
  let workdirIsDirectory = false;
  try {
    workdirIsDirectory = statSync(cfg.workdir).isDirectory();
  } catch {
    workdirIsDirectory = false;
  }

  // `readProfile`, never `loadProfile`: a reader must report on a profile
  // that will not read, not die of it (doctor.ts records the doctrine).
  const profile = readProfile(account);
  const owner =
    profile.kind === 'ok' && typeof profile.profile.ownerUserId === 'string'
      ? profile.profile.ownerUserId
      : '';
  const paired = owner !== '';

  // Counts and AGES only. `pendingRows` returns whole records — `.length`
  // and `.ts` are all that may leave this function; `row.text` is message
  // content and the cursor's `lastId` / the journal's `upTo` are message ids
  // The predicate needs the owner, so an unpaired account has no
  // pending count to report rather than a zero that reads as "all answered".
  let pendingCount: number | undefined;
  let oldestPendingAgeMs: number | undefined;
  if (paired) {
    const rows = pendingRows(account, owner);
    pendingCount = rows.length;
    const oldest = rows[0];
    if (oldest !== undefined && Number.isFinite(oldest.ts)) {
      oldestPendingAgeMs = Math.max(0, now - oldest.ts);
    }
  }
  const cursor = loadJson<Cursor>(cursorPath(account));
  const cursorAgeMs =
    cursor !== null && typeof cursor.lastTs === 'number' && Number.isFinite(cursor.lastTs)
      ? Math.max(0, now - cursor.lastTs)
      : undefined;
  const journal = readJournal(account);
  const journalAgeMs =
    journal !== null && typeof journal.startedAt === 'number' && Number.isFinite(journal.startedAt)
      ? Math.max(0, now - journal.startedAt)
      : undefined;

  // The approval journal, read through its own loader (`loadApprovals` — a
  // pure read; the file-not-there collapse is the same one every caller
  // gets) and reduced to counts and ages HERE, so no caller downstream ever
  // holds a row object it could leak a payload from.
  const approvalFile = loadApprovals(account);
  const inflight = approvalFile.rows.filter(
    r => r.state === 'asking' || r.state === 'pending' || r.state === 'answering',
  );
  let oldestPendingApprovalAgeMs: number | undefined;
  for (const r of inflight) {
    if (!Number.isFinite(r.askedAt)) continue;
    const age = Math.max(0, now - r.askedAt);
    if (oldestPendingApprovalAgeMs === undefined || age > oldestPendingApprovalAgeMs) {
      oldestPendingApprovalAgeMs = age;
    }
  }
  // The grace is the park's own cadence, doubled: a live parked pass checks
  // the deadline every ATTEND_POLL_MS and patches to `answering` as its
  // first act, so a row still unanswered two polls past its TTL is not a
  // scheduling artefact — it is a pass that is not running (the field's
  // comment on `AttendState` carries the full argument).
  const approvalsPendingPastTtl = approvalFile.rows.filter(
    r =>
      (r.state === 'asking' || r.state === 'pending') &&
      Number.isFinite(r.askedAt) &&
      Number.isFinite(r.ttlMs) &&
      now - r.askedAt > r.ttlMs + 2 * ATTEND_POLL_MS,
  ).length;

  const codex = cfg.host === 'codex';
  const codexDriver = typeof cfg.codexDriver === 'string' ? cfg.codexDriver : 'exec';
  // The SAME shape test the ask funnel's attestation gate applies (fail
  // closed: malformed reads as un-attested), so status can never claim a
  // form the next ask will not take.
  const attestedBuild =
    typeof cfg.approvalsMinAppBuild === 'number' &&
    Number.isInteger(cfg.approvalsMinAppBuild) &&
    cfg.approvalsMinAppBuild >= 1
      ? cfg.approvalsMinAppBuild
      : undefined;
  // `statusOf` answers with the unit PATH too; only the two booleans travel —
  // the path embeds the account name inside a home the operator may have put
  // anywhere, and no consumer of this state needs it.
  const unitStatus = statusOf(account, io.service ?? {}, 'attend');
  return {
    state: 'enabled',
    host: cfg.host,
    caps: Array.isArray(cfg.caps) ? cfg.caps.filter((c): c is string => typeof c === 'string') : [],
    turnsPerHour: typeof cfg.turnsPerHour === 'number' ? cfg.turnsPerHour : 0,
    turnsUsed,
    binRunnable,
    workdirIsDirectory,
    paired,
    ownSessionTag: typeof cfg.ownSession === 'string' ? sessionTag(cfg.ownSession) : '',
    ownSessionStarted: cfg.ownSessionStarted === true,
    codexModelPinned: typeof cfg.codexModel === 'string' && cfg.codexModel !== '',
    // `codexHomeDir` is imported, not re-derived: one derivation of that path
    // exists (attend-drivers.ts), and enable's sign-in instruction and the
    // driver's spawn already stand on it being the only one.
    // `auth.json` — the sign-in, not the directory. See `codexSignedIn`.
    ...(codex ? { codexSignedIn: existsSync(join(codexHomeDir(account), 'auth.json')) } : {}),
    ...(pendingCount === undefined ? {} : { pendingCount }),
    ...(oldestPendingAgeMs === undefined ? {} : { oldestPendingAgeMs }),
    ...(cursorAgeMs === undefined ? {} : { cursorAgeMs }),
    ...(journalAgeMs === undefined ? {} : { journalAgeMs }),
    approvalsPending: inflight.length,
    approvalsSettled: approvalFile.rows.length - inflight.length,
    ...(oldestPendingApprovalAgeMs === undefined ? {} : { oldestPendingApprovalAgeMs }),
    approvalOverCapRefusals: approvalFile.overCapRefusals,
    approvalsForm: attestedBuild === undefined ? 'text' : 'card',
    ...(attestedBuild === undefined ? {} : { approvalsMinAppBuild: attestedBuild }),
    approvalsPendingPastTtl,
    // The grant through the predicate's own reader, and the marker
    // attestation through the send path's own shape gate — both read-backs,
    // never re-derivations (see the fields' comments).
    roomTriggerRooms: [...roomTriggerGids(cfg)].sort(),
    ...(markerShapeOk(cfg.markerMinAppBuild)
      ? { markerMinAppBuild: cfg.markerMinAppBuild as number }
      : {}),
    ...(codex ? { codexDriver } : {}),
    ...(codex && codexDriver === 'app-server'
      ? {
          codexApprovalPolicy:
            typeof cfg.codexApprovalPolicy === 'string' ? cfg.codexApprovalPolicy : 'untrusted',
        }
      : {}),
    ...(cfg.host === 'claude'
      ? { claudeDriver: typeof cfg.claudeDriver === 'string' ? cfg.claudeDriver : 'subprocess' }
      : {}),
    unit: { installed: unitStatus.installed, running: unitStatus.running },
  };
}

/** A round human age — status lines compare "34s" against "2h", and
 * millisecond precision on a 2-second poll loop is noise wearing digits. */
function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

/** The one-line rendering shared by the bare sweep and the per-account
 * summary head, so the two can never describe one state two ways. */
function attendStateLine(account: string, s: AttendState): string {
  switch (s.state) {
    case 'absent':
      return `${account}: attend not enabled`;
    case 'disabled':
      return `${account}: attend disabled — messages queue for reading, nothing executes`;
    case 'unparseable':
      return (
        `${account}: attend.json exists and DOES NOT LOAD — attend treats it as disabled ` +
        `and answers nothing. Nobody chose this state: re-enable (tacendum attend enable ` +
        `${account}) or disable cleanly (tacendum attend disable ${account})`
      );
    case 'enabled': {
      const unit = !s.unit.installed
        ? 'unit not installed'
        : s.unit.running
          ? 'unit running'
          : 'unit installed, NOT running';
      const pending =
        s.pendingCount === undefined
          ? 'UNPAIRED'
          : `${s.pendingCount} pending${
              s.oldestPendingAgeMs === undefined ? '' : ` (oldest ${fmtAge(s.oldestPendingAgeMs)})`
            }`;
      return (
        `${account}: attend enabled (${s.host}) — ${unit}, ` +
        `${s.turnsUsed} of ${s.turnsPerHour} turns used this hour, ${pending}`
      );
    }
  }
}

/**
 * `tacendum attend status [<account>]`. Bare answers for EVERY account, one
 * line each — `cmdService`'s precedent: status is a question, and a question
 * deserves the whole answer. A named account gets the full report.
 *
 * WHAT THIS PRINTS, AND WHAT IT NEVER MAY:
 *   - counts and AGES for the spool, cursor and journal — never `row.text`
 *     (message content), never `lastId`/`upTo` (message ids);
 *   - `sessionTag(ownSession)`, never the raw session UUID;
 *   - `caps`, verbatim — the capability array IS the operator's control over
 *     what a turn may do, and reading it back is the point of the command;
 *   - for codex, the isolated CODEX_HOME path in the sign-in remedy — the
 *     same path `attend enable` already prints, and nothing from inside it.
 */
export function cmdAttendStatus(
  account: string | null,
  report: Reporter,
  io: AttendStateIo = {},
): void {
  if (account === null) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      report.emit(
        { ok: true, action: 'attend-status', accounts: [] },
        'no accounts registered here — tacendum register <name> comes first',
      );
      return;
    }
    for (const name of accounts) {
      const s = attendState(name, io);
      report.line({ ok: true, action: 'attend-status', account: name, ...s }, attendStateLine(name, s));
    }
    return;
  }

  // The read-only positional path: the caller (main.ts) hands the account
  // over WITHOUT `requireAccount`, because that helper runs the once-per-
  // command credential migration — a keychain write — and a status command
  // must observe only (`attend service status` makes the same choice).
  // `loadProfile` here is the ordinary refusal for a name this machine does
  // not have; it reads and validates, and repairs nothing.
  loadProfile(account);
  const s = attendState(account, io);
  const lines: string[] = [attendStateLine(account, s)];
  if (s.state === 'absent') {
    lines.push(`  enable with: tacendum attend enable ${account}`);
  }
  if (s.state === 'enabled') {
    if (!s.unit.installed) {
      lines.push(`  supervise it with: tacendum attend service install ${account}`);
    }
    if (!s.paired) {
      lines.push(
        '  UNPAIRED — attend refuses to run without an owner binding: ' +
          `tacendum pair ${account} <owner-id>`,
      );
    }
    if (!s.binRunnable) {
      lines.push(
        '  the agent binary is NOT RUNNABLE any more (an upgrade moved it, usually) — ' +
          `every turn would fail exit-127; re-run: tacendum attend enable ${account} --bin <path>`,
      );
    }
    if (!s.workdirIsDirectory) {
      lines.push(
        '  the workdir is NOT A DIRECTORY — turns cannot run there; ' +
          `re-run: tacendum attend enable ${account} --workdir <dir>`,
      );
    }
    lines.push(
      `  cursor: ${s.cursorAgeMs === undefined ? 'never advanced' : `advanced ${fmtAge(s.cursorAgeMs)} ago`}`,
    );
    if (s.journalAgeMs !== undefined) {
      lines.push(
        `  journal: a turn started ${fmtAge(s.journalAgeMs)} ago has not reported back — ` +
          'the next pass answers it honestly rather than re-running it',
      );
    }
    // Counts and ages only, per the header's rule — the approval journal's
    // payloads live in the 0600 file and on the phone, nowhere else. The
    // FORM leads the line: `card (app build ≥ N)` is the operator's
    // attestation read back — a claim, like caps, not a checked fact — and
    // `text` is the standing default every build renders.
    lines.push(
      `  approvals: ${
        s.approvalsForm === 'card' ? `card (app build ≥ ${s.approvalsMinAppBuild})` : 'text'
      } — ${s.approvalsPending} pending${
        s.oldestPendingApprovalAgeMs === undefined
          ? ''
          : ` (oldest ${fmtAge(s.oldestPendingApprovalAgeMs)})`
      }, ${s.approvalsSettled} settled, ${s.approvalOverCapRefusals} over-cap ` +
        `refusal${s.approvalOverCapRefusals === 1 ? '' : 's'}`,
    );
    if (s.approvalsPendingPastTtl > 0) {
      lines.push(
        `  STALE: ${s.approvalsPendingPastTtl} approval${
          s.approvalsPendingPastTtl === 1 ? ' is' : 's are'
        } still pending past their own deadline — a running pass would have expired ` +
          `${s.approvalsPendingPastTtl === 1 ? 'it' : 'them'}, so the answerer is not ` +
          `running; check the unit: tacendum attend service status ${account}`,
      );
    }
    lines.push(
      `  own session: ${s.ownSessionTag}${s.ownSessionStarted ? '' : ' (no transcript yet)'}`,
    );
    lines.push(`  caps: ${s.caps.join(' ')}`);
    // The grant, on the audit surface (the consent remediation): an operator
    // reading status must see that non-owners hold trigger authority, and
    // over WHICH rooms — the one grant that spends their budget on someone
    // else's words must not need a second command to discover.
    lines.push(
      s.roomTriggerRooms.length === 0
        ? '  room triggers: off (owner mentions only — the default)'
        : `  room triggers: ON in ${s.roomTriggerRooms.length} room` +
            `${s.roomTriggerRooms.length === 1 ? '' : 's'} — current members' @mentions ` +
            `spend YOUR budget at the read-only floor:\n    ${s.roomTriggerRooms.join('\n    ')}`,
    );
    // The marker attestation, read back like its approval sibling: a claim
    // about the operator's phone, stated verbatim or stated absent.
    lines.push(
      s.markerMinAppBuild === undefined
        ? '  AI marker: bare text unmarked (no --marker attestation; envelope bodies carry it regardless)'
        : `  AI marker: attested (app build ≥ ${s.markerMinAppBuild}) — bare text leaves marked`,
    );
    if (s.host === 'codex') {
      // The driver and, where approvals exist, the policy — read back
      // verbatim like caps, because together they ARE the approval surface:
      // exec has none, app-server asks as often as the policy says.
      const driver = s.codexDriver ?? 'exec';
      lines.push(
        `  driver: ${driver}${
          driver === 'app-server'
            ? ` (approval policy: ${s.codexApprovalPolicy ?? 'untrusted'})`
            : ''
        }`,
      );
      if (driver !== 'exec' && driver !== 'app-server') {
        lines.push(
          '  the configured codexDriver is NOT one this build recognises — every turn ' +
            `refuses until attend.json names exec or app-server; re-run: tacendum attend ` +
            `enable ${account} --host codex --driver <exec|app-server>`,
        );
      }
      lines.push(`  model: ${s.codexModelPinned ? 'pinned at enable time' : "codex's own default"}`);
      if (s.codexSignedIn !== true) {
        lines.push(
          '  CODEX_HOME: NOT SIGNED IN — every turn fails with an auth error until it is. ' +
            `Run once: CODEX_HOME=${codexHomeDir(account)} codex login`,
        );
      }
    }
    if (s.host === 'claude') {
      // The driver, read back verbatim like caps (the codex block's rule):
      // it decides whether approvals exist at all, and for sdk it decides
      // whose key every turn bills.
      const driver = s.claudeDriver ?? 'subprocess';
      lines.push(`  driver: ${driver}`);
      if (driver !== 'subprocess' && driver !== 'sdk') {
        lines.push(
          '  the configured claudeDriver is NOT one this build recognises — every turn ' +
            `refuses until attend.json names subprocess or sdk; re-run: tacendum attend ` +
            `enable ${account} --host claude --driver <subprocess|sdk>`,
        );
      }
      if (driver === 'sdk') {
        lines.push(
          '  sdk driver: requires an operator-supplied API key (ANTHROPIC_API_KEY where ' +
            'attend runs) — a start that resolves a subscription sign-in refuses the turn',
        );
      }
    }
  }
  report.emit({ ok: true, action: 'attend-status', account, ...s }, lines.join('\n'));
}
