import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import {
  applyGroupDel,
  applyGroupNew,
  applyRosterWrite,
  foldRoster,
  localDeleteRoom,
  ownerOnlyPolicy,
  verdictFor,
  type RosterSlot,
} from '@tacendum/shared/group-fold';
import {
  GROUP_MAX_MEMBERS,
  GroupDelEnvelope,
  GroupMessageEnvelope,
  GroupNewEnvelope,
  GroupRosterEnvelope,
  MAX_GROUP_BODY,
  composeRosterDigest,
} from '@tacendum/shared/group-envelope';
import { randomMsgId } from '@tacendum/shared/msgid';
import { markAgentBody } from './ai-origin.js';
import { flagBool, flagString, parseArgs, type ParsedArgs } from './args.js';
import { writeFileAtomic } from './atomic-write.js';
import { stateDir } from './config.js';
import { CliError, EXIT, type ExitCode } from './exit.js';
import { maybeMigrateCredential } from './keychain.js';
import { MessageLog, roomAiAuthorIds } from './msglog.js';
import type { Reporter } from './output.js';
import { isUserId, loadProfile, resolveRecipient, tryLoadProfile } from './profile.js';
import { sanitizeForTerminal, sanitizeServerField } from './render.js';
import { FileGroupStore, listRooms } from './rooms.js';
import {
  composeAttachment,
  sendEncryptedFanout,
  type FanoutLeg,
  type FanoutLegOutcome,
} from './send.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';

/**
 * The CLI's room surface: create, list, show,
 * add, remove, leave, accept, decline, delete [--everyone], send.
 *
 * THE ONE RULE THAT OUTRANKS EVERYTHING IN THIS FILE: there is exactly one
 * implementation of the roster rules and it is `@tacendum/shared/group-fold`.
 * Nothing here decides who may add, remove, delete, or whether a write
 * counts — every such question is put to `applyGroupNew` / `applyRosterWrite`
 * / `applyGroupDel` / `foldRoster` and the ANSWER is presented. An `if` about
 * authority appearing in this file is the two-implementations divergence the design
 * forbids. What this file does own: transport (legs through
 * `sendEncryptedFanout`), presentation (Reporter, exit codes), and the two
 * composer-side BOUNDS the schema assigns to every composer (the member cap, the
 * body ceiling) — bounds on what this client will mint, not rules about who
 * may act.
 *
 * ORDER PER TRANSITION, the app's `fanOutMembership` contract exactly:
 * gates → compose (validate through the shared schema — an envelope this
 * build cannot parse must never reach the apply or the wire) → APPLY through
 * the shared layer → persist (write-once, rooms.ts's guarantee) → send. A
 * declined or stale apply sends NOTHING and persists nothing — the
 * announce-only-when-applied rule — and once the apply has persisted there
 * is no abort: a leg that fails afterwards settles as a reported outcome,
 * never a rollback, because this client's roster HAS changed and silently
 * unwinding the send would fork it from everyone who was told.
 *
 * WIRE IDS: every leg's msgId comes from `randomMsgId` over `node:crypto`'s
 * CSPRNG — N monotonic ULIDs under one sender is an exact,
 * durable, 30-day membership join key in the server's queue, which is the
 * single leak this feature could reintroduce. Legs are sorted by those ids
 * before transmission: pure CSPRNG, so a uniform recipient shuffle for free
 * (the app's own trick). Inner ids (`g`, `m`) ride only inside
 * ciphertext and stay ordinary ULIDs, exactly as in the app.
 */

/** Room ids and inner message ids ride inside ciphertext; monotonic is fine
 * there (the app mints them with `nextMsgId` for the same reason). NEVER used
 * for a wire msgId — that is `randomMsgId`'s job. */
const innerUlid = monotonicFactory();

/** The CLI's CSPRNG binding for `randomMsgId` — `node:crypto`, exactly as
 * `@tacendum/shared/msgid` documents. */
const csprng = (byteCount: number): Uint8Array => randomBytes(byteCount);

/** The CLI's SHA-256 binding for the `rd` digest — `node:crypto`, the
 * binding `group-envelope.ts` names as intended for this client. Async
 * because the shared seam is (the app's TurboModule digest is). */
const sha256 = async (preimage: Uint8Array): Promise<Uint8Array> =>
  createHash('sha256').update(preimage).digest();

/** Injectable transport, so the surface is testable in-process without a
 * server — the same seam philosophy as `SendEvents`. Production is always
 * `sendEncryptedFanout`; `main.ts` passes nothing. */
export type RoomDelivery = typeof sendEncryptedFanout;

// --- shared plumbing --------------------------------------------------------

/**
 * Room ids are accepted case-insensitively, like user ids (Crockford base32
 * defines lower case as equivalent on decode), and normalised to the one
 * spelling the store uses. THE VALUE IS NEVER ECHOED on the refusal path —
 * a misconfigured variable puts a secret in any argv slot, and this error
 * reaches stderr and --json, i.e. hook and CI logs (the same lesson
 * as `pair`'s owner-id refusal).
 */
const ROOM_ID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

function requireRoomId(raw: string): string {
  if (!ROOM_ID_RE.test(raw)) {
    throw new CliError(
      EXIT.USAGE,
      'that is not a room id — a room id is 26 characters of Crockford base32, ' +
        'from `tacendum room list`',
    );
  }
  return raw.toUpperCase();
}

function requirePositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError(EXIT.USAGE, `usage: ${usage}`);
  return value;
}

/**
 * THIS MACHINE'S account is positional 0 on every room subcommand, exactly
 * as it is on `send <from> …`, `contacts <name>` and every other command
 * (one TACENDUM_HOME can hold several accounts, so it cannot be inferred).
 * Mirrors main.ts's `requireAccount`, credential hook included: every
 * command that names its local account gets the once-per-command keychain
 * migration by resolving the name through here — a rule duplicated per call
 * site is this repo's most-repeated defect class, so the room surface takes
 * it whole rather than partially.
 */
function requireAccount(args: ParsedArgs, index: number, usage: string, report: Reporter): string {
  const name = requirePositional(args, index, usage);
  const outcome = maybeMigrateCredential(name);
  if (outcome !== null) report.note(`credential: ${outcome.detail} (${outcome.backend})`);
  return name;
}

/** A room this client actually holds — an anchored store. The anchor is the
 * `frame.from` of the accepted `grp.new`; no anchor means no room. */
function loadRoom(account: string, groupId: string): FileGroupStore {
  const store = FileGroupStore.load(account, groupId);
  if (store.getOwner() === undefined) {
    throw new CliError(
      EXIT.USAGE,
      'no such room on this client — see: tacendum room list',
    );
  }
  return store;
}

/**
 * The next seq for MY writer lane, derived from the store rather than kept in
 * a counter: my own writes are the only writes in my lane, each is stored at
 * its winner-per-key slot, so 1 + max(my stored seqs) is always fresh — and a
 * REDO after a partial send failure gets a fresh, higher seq, which applies
 * and fans again (the app states exactly this redo semantic). Content-only,
 * no wall clock.
 */
function nextWriterSeq(store: FileGroupStore, selfId: string): number {
  let max = 0;
  for (const slot of store.listSlots()) {
    if (slot.writerId === selfId && slot.seq > max) max = slot.seq;
  }
  const settings = store.getSettingsSlot(selfId);
  if (settings !== undefined && settings.seq > max) max = settings.seq;
  return max + 1;
}

/**
 * The per-(author, room) counter behind `grp.msg`'s `sq` (receivers
 * order group rows by `(ts, authorId, sq)`). The room file cannot carry it —
 * `rooms.ts` is the slot store, complete as committed — so it lives in a
 * sidecar beside the room file. The stem contains a dot, so `listRooms`'
 * ULID filter can never mistake it for a room. Allocated BEFORE compose,
 * like the app's `reserveGroupSeq`: a crash burns a number and monotonicity
 * survives, which is the property the ordering needs.
 */
function msgSeqPath(account: string, groupId: string): string {
  return join(stateDir(account), 'rooms', `${groupId}.msgseq.json`);
}

function nextMsgSq(account: string, groupId: string): number {
  const path = msgSeqPath(account, groupId);
  let last = 0;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { last?: unknown };
    if (typeof raw.last === 'number' && Number.isInteger(raw.last) && raw.last > 0) {
      last = raw.last;
    }
  } catch {
    // Absent or unreadable both mean "nothing sent yet" — sq restarts at 1,
    // which can only under-order, never mis-attribute.
  }
  const next = last + 1;
  mkdirSync(join(stateDir(account), 'rooms'), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify({ last: next })}\n`);
  return next;
}

/** Validate through the SAME shared schema the receiver parses, then encode —
 * the encode invariant: an envelope this build cannot parse cannot be
 * composed by it. */
function encodeGroup(
  schema: { parse: (value: unknown) => unknown },
  envelope: unknown,
): string {
  return JSON.stringify(schema.parse(envelope));
}

/** One planned leg: recipient, body, and a rule-19 wire id — sorted by those
 * ids, which are pure CSPRNG, so the recipient order is uniformly shuffled
 * for free. */
async function mintLegs(
  recipients: readonly string[],
  bodyFor: (memberId: string) => string,
): Promise<FanoutLeg[]> {
  const legs: FanoutLeg[] = [];
  for (const to of recipients) {
    legs.push({ to, body: bodyFor(to), msgId: await randomMsgId(csprng) });
  }
  legs.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));
  return legs;
}

/**
 * The identity-change skip: a member with a
 * PENDING safety-number change is skipped loudly — that one leg, never the
 * room — and the remedy is named. Run BEFORE any ratchet work.
 */
function splitSendable(
  stores: FileStores,
  recipients: readonly string[],
): { sendable: string[]; skipped: string[] } {
  const sendable: string[] = [];
  const skipped: string[] = [];
  for (const memberId of recipients) {
    (stores.hasIdentityChange(memberId) ? skipped : sendable).push(memberId);
  }
  return { sendable, skipped };
}

interface FanoutReport {
  delivered: string[];
  /** Identity-change skips — pre-flight and mid-send together. */
  skipped: string[];
  failed: string[];
}

function summarize(
  outcomes: readonly FanoutLegOutcome[],
  preSkipped: readonly string[],
): FanoutReport {
  return {
    delivered: outcomes.filter(o => o.state === 'delivered').map(o => o.to),
    skipped: [
      ...preSkipped,
      ...outcomes.filter(o => o.state === 'identity-changed').map(o => o.to),
    ],
    failed: outcomes.filter(o => o.state === 'failed').map(o => o.to),
  };
}

/**
 * The exit code a fan-out earns. Every leg delivered: OK. Any hard failure:
 * ERROR — the LOCAL transition stood (the human line says so), but a script
 * must learn the room was not fully told; a redo re-applies at a fresh seq
 * and fans again. Only identity skips: SAFETY, the code whose remedy is an
 * out-of-band verification, exactly as a refused 1:1 send reports it.
 */
function fanoutExit(outcome: FanoutReport): ExitCode {
  if (outcome.failed.length > 0) return EXIT.ERROR;
  if (outcome.skipped.length > 0) return EXIT.SAFETY;
  return EXIT.OK;
}

async function deliverLegs(
  account: string,
  stores: FileStores,
  legs: FanoutLeg[],
  report: Reporter,
  deliver: RoomDelivery,
): Promise<FanoutLegOutcome[]> {
  if (legs.length === 0) return [];
  const auth = new AuthSession(account, stores);
  return deliver({
    stores,
    auth,
    legs,
    events: {
      connecting: () => report.status('connecting…'),
      encrypting: () => report.status('sending…'),
    },
  });
}

function noteSkipped(report: Reporter, skipped: readonly string[], account: string): void {
  for (const memberId of skipped) {
    report.note(
      `!! ${memberId} has a pending safety-number change — their leg was skipped. ` +
        `Verify out of band, then: tacendum trust ${account} ${memberId}`,
    );
  }
}

// --- the commands -----------------------------------------------------------

async function cmdRoomCreate(
  account: string,
  name: string,
  memberArgs: readonly string[],
  report: Reporter,
  deliver: RoomDelivery,
): Promise<ExitCode> {
  const profile = loadProfile(account);
  const selfId = profile.userId;
  const members = [...new Set(memberArgs.map(resolveRecipient))].filter(
    id => id !== selfId,
  );
  if (members.length === 0) {
    throw new CliError(
      EXIT.USAGE,
      'a room needs at least one member besides you',
    );
  }
  // The composer-side half of the bound (the schema is the other half):
  // this bounds what THIS client will mint, +1 for the creator in `ms`.
  if (members.length + 1 > GROUP_MAX_MEMBERS) {
    throw new CliError(
      EXIT.USAGE,
      `a room holds at most ${GROUP_MAX_MEMBERS} people including you`,
    );
  }

  const groupId = innerUlid();
  const roster = [selfId, ...members];
  // The class claims: what THIS creator's own records
  // name as integrations, riding the grp.new so every invitee's device can
  // offer the consent choice before the agent ever speaks. Owner-only by
  // construction — the creator IS the room's owner.
  const integrations = [...localIntegrationIds(account, roster, memberArgs)].sort();
  const seq = 1; // a fresh store; nextWriterSeq of nothing is 1 by definition
  // Compose FIRST, through the shared schema — a name the wire refuses must
  // fail here, with nothing anchored and nothing sent.
  let body: string;
  try {
    body = encodeGroup(GroupNewEnvelope, {
      tcm: 'grp.new',
      g: groupId,
      nm: name.trim(),
      ms: roster,
      n: seq,
      ...(integrations.length > 0 ? { ic: integrations } : {}),
    });
  } catch {
    // The zod message is not surfaced: it can echo the rejected value, and a
    // mistyped variable puts anything at all in the name slot.
    throw new CliError(
      EXIT.USAGE,
      'that room name will not work — 1 to 80 characters',
    );
  }

  // The apply: the creator's own grp.new through the SAME path a receiving
  // phone runs (applyGroupNew anchors, clamps the sender in, folds the seed
  // slots). No creation special case exists anywhere, deliberately.
  const store = FileGroupStore.load(account, groupId);
  applyGroupNew(
    store,
    selfId,
    {
      writerId: selfId,
      members: roster,
      seq,
      ...(integrations.length > 0 ? { integrations } : {}),
    },
    ownerOnlyPolicy,
  );
  store.setName(name.trim());
  store.persist();

  const stores = new FileStores(account);
  const { sendable, skipped } = splitSendable(stores, members);
  report.status('inviting…');
  const outcomes = await deliverLegs(
    account,
    stores,
    await mintLegs(sendable, () => body),
    report,
    deliver,
  );
  const result = summarize(outcomes, skipped);
  noteSkipped(report, skipped, account);
  report.emit(
    {
      ok: result.failed.length === 0,
      groupId,
      name: name.trim(),
      members: roster,
      invited: result.delivered,
      skipped: result.skipped,
      failed: result.failed,
    },
    `created ${groupId} "${sanitizeForTerminal(name.trim())}" — ` +
      `invited ${result.delivered.length} of ${members.length} member(s)`,
  );
  if (result.failed.length > 0) {
    report.note(
      'the room exists on this client; members whose invitation failed will not ' +
        'see it — re-run the add for each once the problem is fixed',
    );
  }
  return fanoutExit(result);
}

function cmdRoomList(account: string, report: Reporter): void {
  // the usual "no profile" refusal, before any store I/O
  const selfId = loadProfile(account).userId;
  const rooms = listRooms(account).filter(r => r.present);
  for (const room of rooms) {
    const store = FileGroupStore.load(account, room.groupId);
    const ownerId = store.getOwner() as string; // listRooms filtered on it
    const fold = foldRoster(ownerId, store.listSlots(), ownerOnlyPolicy);
    const name = room.name === null ? null : sanitizeServerField(room.name, 80);
    if (report.json) {
      report.line(
        {
          groupId: room.groupId,
          name,
          ownerId,
          members: fold.members.length,
          you: verdictFor(fold, selfId),
        },
        '',
      );
      continue;
    }
    report.line(
      {},
      `${room.groupId}  ${name !== null ? `"${name}"` : '(unnamed)'}  ` +
        `${fold.members.length} member(s)` +
        (ownerId === selfId ? '  (yours)' : '') +
        (verdictFor(fold, selfId) === 'out' ? '  (you are out)' : ''),
    );
  }
  if (rooms.length === 0) {
    report.note('no rooms on this client — create one: tacendum room create <name> <member>...');
  }
}

function cmdRoomShow(account: string, groupId: string, report: Reporter): void {
  const selfId = loadProfile(account).userId;
  const store = loadRoom(account, groupId);
  const ownerId = store.getOwner() as string;
  const fold = foldRoster(ownerId, store.listSlots(), ownerOnlyPolicy);
  const name =
    store.getName() === null
      ? null
      : sanitizeServerField(store.getName() as string, 80);
  // Whether this client has ANSWERED the invitation is exactly whether its
  // own sovereign lane holds a row — accept and decline each write one, so
  // the durable evidence is the slot itself, not a second flag.
  const answered = store.getSlot(selfId, selfId) !== undefined;

  if (report.json) {
    report.emit(
      {
        groupId,
        name,
        ownerId,
        present: store.isPresent(),
        you: verdictFor(fold, selfId),
        answered,
        members: fold.members,
        // The fold's class record: members the OWNER's
        // authoritative roster write named integrations. Informational —
        // scripts read it the way the roster line below shows it.
        agents: fold.members.filter(id => fold.classes[id] === 'integration'),
      },
      '',
    );
    return;
  }
  // The stored profile-card names, exactly as `contacts` annotates the same
  // ids: the id stays primary (it is the copy-pasteable `room add/remove`
  // argument), the name is the optional suffix that says who anyone is
  // without a hand cross-reference. A store that cannot be read annotates
  // nobody — a name is a nicety, never a requirement.
  let peerNames: Record<string, string>;
  try {
    peerNames = new FileStores(account).loadPeerNames();
  } catch {
    peerNames = {};
  }
  const nameTag = (id: string): string => {
    const stored = peerNames[id];
    if (stored === undefined) return '';
    const clean = sanitizeServerField(stored, 80);
    return clean === '' ? '' : `  "${clean}"`;
  };
  report.line({}, `room ${groupId}  ${name !== null ? `"${name}"` : '(unnamed)'}`);
  report.line(
    {},
    `owner ${ownerId}${nameTag(ownerId)}${ownerId === selfId ? ' (you)' : ''}`,
  );
  report.line(
    {},
    `you ${verdictFor(fold, selfId)}` +
      (!answered && ownerId !== selfId ? ' — invitation unanswered (room accept|decline)' : ''),
  );
  report.line({}, `members (${fold.members.length}):`);
  for (const memberId of fold.members) {
    report.line(
      {},
      `  ${memberId}${nameTag(memberId)}` +
        (memberId === ownerId ? '  (owner)' : '') +
        (memberId === selfId ? '  (you)' : '') +
        // The class, said on the roster line (the
        // anonymous-row defect): the owner's authoritative write named this
        // member a machine. Attribution, never verification — it says WHAT
        // this member is, not whether any key matched.
        (fold.classes[memberId] === 'integration' ? '  (AI agent — added by the owner)' : ''),
    );
  }
  if (!store.isPresent()) {
    report.note('deleted from this client — it returns if it stays alive and you are still in it');
  }
}

/**
 * One roster transition — add, remove, leave, accept and decline are all THIS
 * function with different `(memberId, state)` bindings, exactly as the plan
 * says they must be (~1585: accept/decline are transitions in the shared
 * apply layer; the subcommands are a second front-end onto the identical
 * code). The classification — sovereign, authority, declined — happens
 * inside `applyRosterWrite` and nowhere else.
 */
async function roomRosterTransition(
  account: string,
  groupId: string,
  memberId: string,
  state: 'in' | 'out',
  opts: { action: string; hideAfter?: boolean; rawMember?: string },
  report: Reporter,
  deliver: RoomDelivery,
): Promise<ExitCode> {
  const selfId = loadProfile(account).userId;
  const store = loadRoom(account, groupId);
  const ownerId = store.getOwner() as string;
  // THE CLASS CLAIM, owner-only: an OWNER's add of a
  // member their own records name an integration carries `c: 'integration'`,
  // so the invitee-side devices can offer the consent choice before the
  // agent ever speaks. A non-owner write NEVER carries it — their lane never
  // counts anyway, and the class is the owner's statement or nobody's.
  // A member the records cannot name simply gets no field: absent is safe.
  const memberClassed =
    state === 'in' &&
    selfId === ownerId &&
    localIntegrationIds(
      account,
      [memberId],
      opts.rawMember !== undefined ? [opts.rawMember] : [],
    ).has(memberId);

  // Snapshots BEFORE the apply: recipients are the folded members as they
  // stood, UNITED with the written-about member (a Remove fans to
  // the removed member too, so it is never a silent omission; the same union
  // is what lets a re-added leaver see the invitation back).
  const slotsBefore = [...store.listSlots()];
  const foldBefore = foldRoster(ownerId, slotsBefore, ownerOnlyPolicy);
  const recipients = new Set(foldBefore.members);
  recipients.add(memberId);
  recipients.delete(selfId);

  // The composer-side member cap: bounds what this client will MINT —
  // an add that would take the folded roster past the ceiling is refused
  // before anything is applied or sent. Not an authority rule: whether the
  // write would COUNT stays the apply layer's alone.
  if (
    state === 'in' &&
    verdictFor(foldBefore, memberId) !== 'in' &&
    foldBefore.members.length >= GROUP_MAX_MEMBERS
  ) {
    throw new CliError(
      EXIT.USAGE,
      `this room is full — it holds at most ${GROUP_MAX_MEMBERS} people`,
    );
  }

  const seq = nextWriterSeq(store, selfId);
  const write: RosterSlot = {
    memberId,
    writerId: selfId,
    seq,
    state,
    ...(memberClassed ? { class: 'integration' as const } : {}),
  };

  // THE BRAND-NEW-MEMBER SEAM: an added member whom
  // NO stored slot has ever named (neither lane, never a writer) has no
  // anchor, and the fold drops an authority write that has no room — "heals on
  // the owner's next write", which for an Add never comes. Their leg
  // therefore carries the room itself: a `grp.new` roster snapshot at the
  // same `n`. A re-added leaver HAS slots and keeps the bare roster write
  // (rejoin semantics — only their own `in` readmits them).
  const inviteTarget =
    state === 'in' &&
    !slotsBefore.some(s => s.memberId === memberId || s.writerId === memberId)
      ? memberId
      : null;
  const roomName = store.getName();
  if (inviteTarget !== null && roomName === null) {
    // A grp.new needs the room's name and this client has none — refused
    // BEFORE the apply, so a write that cannot be fanned whole never forks
    // this client's roster from everyone else's.
    throw new CliError(
      EXIT.ERROR,
      'this room has no name on this client, so an invitation cannot be composed',
    );
  }

  // Compose before apply (the encode invariant): both bodies validate
  // through the shared schemas or nothing happens at all.
  const rosterBody = encodeGroup(GroupRosterEnvelope, {
    tcm: 'grp.roster',
    g: groupId,
    m: memberId,
    s: state,
    n: seq,
    ...(memberClassed ? { c: 'integration' as const } : {}),
  });
  // The invite snapshot's class claims: the fold's EXISTING classes (an
  // earlier classed add must reach the newcomer too) plus the member being
  // added, when known. Owner-only like `c` — a non-owner cannot compose an
  // invite whose write would count, and `memberClassed` is already gated.
  const inviteMs =
    inviteTarget !== null
      ? [...new Set([ownerId, ...foldBefore.members, inviteTarget])]
      : [];
  const inviteIc =
    inviteTarget !== null && selfId === ownerId
      ? inviteMs
          .filter(
            id =>
              foldBefore.classes[id] === 'integration' ||
              (memberClassed && id === inviteTarget),
          )
          .sort()
      : [];
  const inviteBody =
    inviteTarget !== null
      ? encodeGroup(GroupNewEnvelope, {
          tcm: 'grp.new',
          g: groupId,
          nm: roomName as string,
          ms: inviteMs,
          n: seq,
          ...(inviteIc.length > 0 ? { ic: inviteIc } : {}),
        })
      : null;

  // THE APPLY — the one place the write is judged. Sovereign self writes
  // count under any policy; authority is the owner's alone; anything else is
  // provably dead the moment it arrives and stores nothing.
  const applied = applyRosterWrite(store, selfId, write, ownerOnlyPolicy);
  if (applied.outcome === 'declined') {
    // Nothing stored, nothing persisted, nothing sent — a declined write is
    // not room traffic, it is a claim that provably never counts. REFUSED,
    // the code that means "permanent; retrying cannot help".
    throw new CliError(
      EXIT.REFUSED,
      "declined: the room's owner decides who is in it — nothing changed and nothing was sent",
    );
  }
  if (applied.outcome === 'stale') {
    // A replay of a write the store already holds. Announce nothing, send
    // nothing (announce-only-when-applied); succeeding quietly is honest
    // because the state asked for is the state that stands.
    report.emit(
      { ok: true, groupId, action: opts.action, member: memberId, changed: false },
      'nothing to change',
    );
    return EXIT.OK;
  }
  if (applied.outcome !== 'applied') {
    // unknown-room / self-preanchor cannot follow loadRoom's anchor check;
    // reaching this line is a bug in this file, not a user condition.
    throw new CliError(EXIT.ERROR, `room state error (${applied.outcome})`);
  }

  if (opts.hideAfter === true) {
    // Decline's second half: the invitation leaves this client's surface.
    // The sovereign `out` above is what makes it final; this
    // only hides the conversation, exactly as a local delete does.
    localDeleteRoom(store);
  }
  store.persist();

  const stores = new FileStores(account);
  const { sendable, skipped } = splitSendable(stores, [...recipients]);
  const outcomes = await deliverLegs(
    account,
    stores,
    await mintLegs(sendable, to => (to === inviteTarget ? (inviteBody as string) : rosterBody)),
    report,
    deliver,
  );
  const result = summarize(outcomes, skipped);
  noteSkipped(report, skipped, account);
  report.emit(
    {
      ok: result.failed.length === 0,
      groupId,
      action: opts.action,
      member: memberId,
      changed: true,
      delivered: result.delivered,
      skipped: result.skipped,
      failed: result.failed,
    },
    `${opts.action}: applied on this client — told ${result.delivered.length} of ${recipients.size} member(s)`,
  );
  if (result.failed.length > 0) {
    report.note(
      'the change stands on this client but some members were not told — ' +
        'redoing the command re-applies it at a fresh seq and sends again',
    );
  }
  return fanoutExit(result);
}

async function cmdRoomDelete(
  account: string,
  groupId: string,
  everyone: boolean,
  report: Reporter,
  deliver: RoomDelivery,
): Promise<ExitCode> {
  const selfId = loadProfile(account).userId;
  const store = loadRoom(account, groupId);

  if (!everyone) {
    // Delete — local: presence goes, the anchor and slots stay, so
    // traffic recreates the room iff this client's own fold still says it is
    // a member. Nobody else learns.
    localDeleteRoom(store);
    store.persist();
    report.emit(
      { ok: true, groupId, action: 'deleted-local' },
      'deleted from this client — the room returns if it stays alive elsewhere and you are still in it',
    );
    return EXIT.OK;
  }

  const ownerId = store.getOwner() as string;
  // Recipients snapshotted BEFORE the apply — the purge clears the store,
  // after which there is nothing to read (the app reads its slots once,
  // before the apply, for exactly this reason).
  const foldBefore = foldRoster(ownerId, store.listSlots(), ownerOnlyPolicy);
  const recipients = foldBefore.members.filter(id => id !== selfId);
  const seq = nextWriterSeq(store, selfId);
  const body = encodeGroup(GroupDelEnvelope, { tcm: 'grp.del', g: groupId, n: seq });

  // The classifier — ONE comparison, made by the shared layer, never here.
  const result = applyGroupDel(store, { writerId: selfId, seq });
  if (result === 'declined') {
    // Takes effect nowhere, stores nothing, and this client must not emit
    // one (the send-side defence: every phone would decline it, so the
    // honest failure is here, before the wire).
    throw new CliError(
      EXIT.REFUSED,
      "declined: only the room's owner can delete it for everyone — nothing changed and nothing was sent",
    );
  }
  if (result !== 'purged') {
    throw new CliError(EXIT.ERROR, `room state error (${result})`);
  }
  store.persist(); // a purged store persists as NO file (rooms.ts)
  rmSync(msgSeqPath(account, groupId), { force: true }); // the sidecar goes with it

  const stores = new FileStores(account);
  const { sendable, skipped } = splitSendable(stores, recipients);
  const outcomes = await deliverLegs(
    account,
    stores,
    await mintLegs(sendable, () => body),
    report,
    deliver,
  );
  const summary = summarize(outcomes, skipped);
  noteSkipped(report, skipped, account);
  report.emit(
    {
      ok: summary.failed.length === 0,
      groupId,
      action: 'deleted-everyone',
      delivered: summary.delivered,
      skipped: summary.skipped,
      failed: summary.failed,
    },
    `deleted for everyone — told ${summary.delivered.length} of ${recipients.length} member(s). ` +
      'People keep anything they already saved, and a device offline longer than a month keeps its copy.',
  );
  if (summary.failed.length > 0) {
    report.note(
      'the room is gone from this client either way; a member who was not told ' +
        'keeps their copy until the delete reaches them',
    );
  }
  return fanoutExit(summary);
}

/**
 * What one room message fan-out did, in the sender's own vocabulary — the
 * shape `cmdRoomSend` reports and attend's room reply consumes.
 */
export interface RoomSendOutcome {
  /** The inner group-message id, minted ONCE for all legs — the `m`
   * half of the `${authorId}.${m}` row key every member's phone will hold,
   * and therefore the ref a reply-to-continue comes back carrying. */
  m: string;
  /** Per-leg wire outcomes, exactly as the transport reported them. */
  outcomes: FanoutLegOutcome[];
  delivered: string[];
  /** Identity-change skips — pre-flight and mid-send together. */
  skipped: string[];
  /** The pre-flight half of `skipped` alone — what `noteSkipped`'s
   * verify-out-of-band remedy has always been scoped to. */
  preSkipped: string[];
  failed: string[];
  /** How many members (excluding the sender) the fan-out addressed. */
  recipients: number;
  /** The folded roster size INCLUDING the sender — the --json `members`. */
  members: number;
}

/**
 * ONE room message, composed and fanned through the SAME machinery
 * `room send` uses — exported for attend's room reply, which is
 * ruled to reach a room through this path ONLY: the fold verdict gate (the
 * integration must have accepted the room — the fold's word, never an `===`
 * minted elsewhere), the per-author `sq`, one `m` for all legs, the `rd`
 * digest over this client's own folded roster, `mintLegs`'s rule-19 wire
 * ids, and `sendEncryptedFanout`. A second compose path in attend.ts would
 * be the forbidden two-implementations divergence.
 *
 * Refusals keep `cmdRoomSend`'s exact codes: no such room / empty / over
 * `MAX_GROUP_BODY` are USAGE, the fold's "not in" is REFUSED — the caller
 * decides what sentence its surface owes.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * The ids a `grp.msg` body @mentions, or none.
 * `body` is the UNWRAPPED inner (`b`) — bare text names nobody; a structured
 * `{tcm:'mention', text, who}` (possibly carrying the `ai` marker, which
 * is irrelevant to who) names its `who[]`. The CLI mirror of the app's
 * `mentionWho`, without importing the app. Total: a malformed body names
 * nobody, so every agent is treated as unmentioned (fail-closed on exclusion).
 */
export function mentionWhoOf(body: string): string[] {
  if (!body.startsWith(ENVELOPE_SENTINEL)) return [];
  try {
    const env = JSON.parse(body) as { tcm?: unknown; who?: unknown };
    if (env.tcm === 'mention' && Array.isArray(env.who)) {
      return env.who.filter((id): id is string => typeof id === 'string');
    }
  } catch {
    /* sentinel-shaped but not JSON — bare words name nobody */
  }
  return [];
}

/**
 * the agent set, upgraded by the fold's roster classes:
 * marker-record ∨ fold-class. The marker half is the members THIS client has
 * heard author an AI-marked `grp.msg` in `gid` (msglog `ai`, written by
 * inbound.ts from the wrapper marker — `roomAiAuthorIds`, the one reader).
 * The class half is the room store's OWN fold: members the room owner's
 * authoritative roster write classed `'integration'` — so exclusion no
 * longer waits for the agent to have spoken. Humans are never here: class
 * comes only from the owner's authority slot (a human cannot be class-marked
 * by any third party). A malicious OWNER falsely marking a human costs that
 * human — in that owner's room alone — the non-mention content plus the
 * unmentioned-target lifecycle carriers, and a spoofable consent stance
 * line: sender defaults and render facts, never a refusal, and the mislabel
 * shows on every roster surface. Fail-OPEN to the empty set on any read
 * error (no spool, no room file ⇒ no known agents ⇒ nothing pruned): a
 * failure must never widen exclusion into dropping a leg the message was
 * owed.
 */
export function roomAgentAuthorIds(account: string, gid: string): Set<string> {
  // ONE implementation, two dispositions of the SAME read: the strict reader
  // below reports a class read it could not complete, and this fail-OPEN
  // pruning caller answers it with the marker half — byte-identical to the
  // behaviour this function had before the strict variant existed.
  return roomAgentAuthorIdsStrict(account, gid) ?? roomAiAuthorIds(account, gid);
}

/**
 * The SAME union as `roomAgentAuthorIds`, with the one difference that makes
 * a fail-CLOSED caller possible: a class read this client could not complete
 * answers `null` instead of being swallowed into `∅`.
 *
 * The distinction is not cosmetic. `roomAgentAuthorIds` fails OPEN because
 * its caller is the send path's PRUNING, where a read failure must never
 * widen exclusion into dropping a leg a message was owed. `attend.ts`'s
 * class clause is the opposite trade: a read it cannot
 * complete must not admit a turn it cannot prove was authored by a human, so
 * it fails CLOSED to "agent" — and it can only do that if the failure is
 * VISIBLE. Folding both into `try { … } catch { … }` here is what made that
 * documented direction unreachable in the first place.
 *
 * `null` means exactly "the room's own record could not be read": the store
 * would not load, has no owner, or the roster would not fold. The marker
 * half (`roomAiAuthorIds`) keeps its own documented fail-open to ∅ — it is a
 * spool scan, not the authority — so a marker-only answer is a successful
 * read, not a blind one.
 */
export function roomAgentAuthorIdsStrict(account: string, gid: string): Set<string> | null {
  try {
    const store = FileGroupStore.load(account, gid);
    const owner = store.getOwner();
    if (owner === undefined) return null;
    const fold = foldRoster(owner, store.listSlots(), ownerOnlyPolicy);
    const ids = roomAiAuthorIds(account, gid);
    for (const [memberId, cls] of Object.entries(fold.classes)) {
      if (cls === 'integration') ids.add(memberId);
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * What THIS account's own records say about which of `ids` are integrations
 * — the CLI mirror of the app's `machine_peers` read at
 * its composers. Two honest sources and NOTHING else — the CLI never guesses
 * a class and never asks the server (machine.ts's rule binds here too):
 *
 *  1. the ADOPT record (`FileStores.loadMachinePeers`) — the server's own
 *     204s on `crew adopt`, remembered by the owner who called it;
 *  2. a SAME-HOME profile named on the command line whose `accountClass` is
 *     'integration' — `pair` runs on the integration account, so its profile
 *     carries the class the server fixed at registration; naming it by local
 *     name already reads that whole profile (resolveRecipient's documented
 *     name path), so the class ride costs nothing new.
 *
 * A member neither source names simply gets no field — absent is safe, the
 * class being raise-only informational.
 */
function localIntegrationIds(
  account: string,
  ids: readonly string[],
  rawArgs: readonly string[] = [],
): Set<string> {
  const wanted = new Set(ids);
  const known = new Set<string>();
  try {
    for (const peerId of Object.keys(new FileStores(account).loadMachinePeers())) {
      if (wanted.has(peerId)) known.add(peerId);
    }
  } catch {
    /* no record ⇒ source 1 teaches nothing */
  }
  for (const raw of rawArgs) {
    if (isUserId(raw)) continue; // a bare id reads nothing off this disk
    try {
      const profile = tryLoadProfile(raw);
      if (
        profile !== null &&
        profile.accountClass === 'integration' &&
        wanted.has(profile.userId)
      ) {
        known.add(profile.userId);
      }
    } catch {
      /* an unreadable profile teaches nothing */
    }
  }
  return known;
}

/**
 * A room content ref `${authorId}.${m}` — exactly two Crockford ULIDs on
 * a dot. The ONE room-ref shape the trigger (attend.triggers owner branch) and
 * this sender audience BOTH read; `roomRefAuthor` is the only reader, so
 * "reply targets a row the agent authored" cannot drift between the two.
 */
export const ROOM_REF_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.[0-9A-HJKMNP-TV-Z]{26}$/;

/** The AUTHOR component of a room content ref, or null if `ref` is not that
 * exact shape. Shared by attend's trigger and roomContentRecipients so the
 * reply-to-continue predicate is identical on both ends (no second parser). */
export function roomRefAuthor(ref: string): string | null {
  const m = ROOM_REF_RE.exec(ref);
  return m === null ? null : m[1]!;
}

/** The `{tcm, ref}` routing head of a room inner body, or null for bare text /
 * a non-envelope. Sentinel-gated like mentionWhoOf, and total. */
function roomInnerRoute(body: string): { tcm: string; ref?: string } | null {
  if (!body.startsWith(ENVELOPE_SENTINEL)) return null;
  try {
    const env = JSON.parse(body) as { tcm?: unknown; ref?: unknown };
    if (typeof env.tcm !== 'string') return null;
    return { tcm: env.tcm, ...(typeof env.ref === 'string' ? { ref: env.ref } : {}) };
  } catch {
    return null;
  }
}

/** Whether a row with this compound id is still in `account`'s spool. Fail-CLOSED
 * to not-found on a read error, so the del safe-default (include a harmless
 * tombstone) applies rather than a silent drop. */
function roomTargetFound(account: string, ref: string): boolean {
  try {
    for (const r of new MessageLog(account).read()) if (r.id === ref) return true;
  } catch {
    /* no readable spool ⇒ treat as not found */
  }
  return false;
}

/**
 * Lifecycle carriers, the CLI mirror of the
 * app's `keepLifecycleAgents`. An agent keeps its leg iff it already RECEIVED
 * the target, read off what the CLI actually holds:
 *   - REACT owned-by: a content ref is `${authorId}.${m}`, so its author-component
 *     IS the target's author — a reaction to an agent's OWN row reaches it.
 * The other "received" path — the target MENTIONED the agent — is NOT
 * reconstructable CLI-side: the msglog keeps `men` (mentions-SELF) and the
 * RENDERED body, never a received message's foreign `who[]`. So we fail closed
 * on the mention question (the honest-ceiling residual) and consult the
 * spool only for the found/not-found asymmetry the rule draws:
 *   - del   : a tombstone carries NO body → INCLUDE when the target is NO
 *             longer held (harmless no-op); EXCLUDE while still held, since the
 *             CLI's own row — the only del it can send — named no agent.
 *   - edit  : carries a NEW body → EXCLUDE always (never leak to an unmentioned
 *             agent; the mention keep is unreconstructable).
 *   - react : keep only the OWNED-BY agent above; EXCLUDE the rest.
 * This never drops a leg the CLI owes: the CLI composes neither a mention nor a
 * lifecycle carrier into a room, so no co-member agent is ever owed one here.
 */
function keepLifecycleAgents(
  account: string,
  kind: 'edit' | 'del' | 'react',
  ref: string,
  agents: ReadonlySet<string>,
  keep: Set<string>,
): void {
  if (kind === 'react') {
    const author = roomRefAuthor(ref);
    if (author !== null && agents.has(author)) keep.add(author);
  }
  if (kind === 'del' && !roomTargetFound(account, ref)) {
    for (const a of agents) keep.add(a); // harmless tombstone for an aged-out target
  }
}

/**
 * The agents a room CONTENT frame is ADDRESSED TO or OWNED BY, the CLI mirror of the app's `roomAddressedAgents`. An agent
 * keeps its leg iff the body @MENTIONS it, OR (reply) its content ref names a row
 * the agent AUTHORED — reply-to-continue, via the SHARED `roomRefAuthor` the
 * trigger uses — OR (edit/del/react) it already received the target.
 */
function roomAddressedAgents(
  account: string,
  body: string,
  agents: ReadonlySet<string>,
): Set<string> {
  const keep = new Set<string>();
  for (const id of mentionWhoOf(body)) if (agents.has(id)) keep.add(id);
  const route = roomInnerRoute(body);
  if (route === null) return keep; // bare text @mentions nobody
  if (route.tcm === 'reply') {
    const author = route.ref === undefined ? null : roomRefAuthor(route.ref);
    if (author !== null && agents.has(author)) keep.add(author);
    return keep;
  }
  if (
    (route.tcm === 'edit' || route.tcm === 'del' || route.tcm === 'react') &&
    route.ref !== undefined
  ) {
    keepLifecycleAgents(account, route.tcm, route.ref, agents, keep);
  }
  return keep;
}

/**
 * The agent-leg rule, as broadened to "addressed-or-owned":
 * the recipients of a room CONTENT (`grp.msg`) message, with every AGENT member
 * this frame does not ADDRESS or OWN removed — it neither @mentions, nor
 * replies-to-continue, nor carries a lifecycle for a target the agent received.
 * A HUMAN leg (no id in `agents`) is never touched. A pruned agent is simply
 * absent — it never reaches `mintLegs` and renders no failed leg (the
 * refused-leg surface is a different thing: there a leg is ATTEMPTED and the
 * server refuses). `body` is the final wire inner (the grp.msg `b`).
 */
export function roomContentRecipients(
  account: string,
  recipients: readonly string[],
  body: string,
  agents: ReadonlySet<string>,
  /**
   * ROUNDS R1's sibling widening (§3.6): agent ids whose leg is
   * KEPT even though this frame neither addresses nor owns them. Empty by
   * default, so every caller that does not ask for it gets today's pruning
   * byte for byte.
   *
   * A UNION AT THE CALLER, never a clause inside `roomAddressedAgents`: the
   * addressed-or-owned predicate is a product-wide rule and the
   * app runs its mirror, so widening it here would put a second, CLI-only
   * meaning into a shared rule. The set is computed by `crewMateAgentIds`,
   * from the room OWNER's roster classes and nothing a sender claimed
   * (R15), and it is empty for every room that is not this owner's crew
   * (R26). Human legs are untouched in either direction — this filter only
   * ever removes ids in `agents`, so `keep` can only ever fail to remove
   * one.
   */
  keep: ReadonlySet<string> = new Set<string>(),
): string[] {
  if (agents.size === 0) return [...recipients];
  const addressed = roomAddressedAgents(account, body, agents);
  return recipients.filter(id => !(agents.has(id) && !addressed.has(id) && !keep.has(id)));
}

/**
 * ROUNDS' SIBLING AUDIENCE (§3.6): the crew-mate
 * agents whose legs a rounds answer keeps — the agent members the ROOM
 * OWNER's roster classes as integrations, in a room owned by THIS account's
 * own owner whose only human member is that owner.
 *
 * Two fail-closed reads and no server call. Every failure answers ∅, which is
 * today's behaviour and the safe one.
 *
 *  - THE OWNER MUST BE OURS (R15). says agents ride only in
 *    rooms their own owner created, and says one crew per owner,
 *    so a room whose owner is this agent's `ownerUserId` is by the ruled
 *    admission model a room of that owner's crew. Any other room — a room
 *    someone else owns — keeps today's pruning entire.
 *  - THE CLASS COMES FROM THE FOLD, NEVER THE MARKER (R15). `roomAgentAuthorIds`
 *    is the union of the fold classes and the `ai` marker half; the marker
 *    half is a SENDER'S OWN CLAIM, fine for PRUNING (a false marker costs the
 *    liar their own legs) and wrong for WIDENING, where it would let any
 *    member manufacture a sibling and receive traffic the owner never
 *    authorized. So this reads `fold.classes` alone.
 *  - CREW-ONLY, AND THIS IS A CONSENT BOUNDARY, NOT A NICETY (R26). If the
 *    fold holds any human member other than the owner, the answer is ∅. A
 *    non-owner human co-member H is admitted to agent A by the D3 arm under
 *    H's own PER-AGENT consent edge (per agent); H's words
 *    then sit in A's turn prompt, and A's answer may restate them. Widening
 *    that answer to sibling agent B would deliver H's words to an agent H
 *    granted no edge to. Failing closed is one extra condition on a roster
 *    this function has already loaded, and it is what makes the amendment's
 *    "no human is affected" sentence true as written. The residual is
 *    stated rather than assumed away: rounds is UNAVAILABLE in a room with a
 *    second human — the switch stays on and the widening simply does not
 *    apply.
 *  - SELF IS NEVER A SIBLING: an agent does not need its own answer.
 */
export function crewMateAgentIds(account: string, gid: string): Set<string> {
  const empty = new Set<string>();
  try {
    const profile = loadProfile(account);
    const store = FileGroupStore.load(account, gid);
    const owner = store.getOwner();
    if (owner === undefined) return empty;
    if (owner !== profile.ownerUserId) return empty;
    const fold = foldRoster(owner, store.listSlots(), ownerOnlyPolicy);
    const mates = new Set<string>();
    for (const memberId of fold.members) {
      if (fold.classes[memberId] === 'integration') {
        if (memberId !== profile.userId) mates.add(memberId);
        continue;
      }
      // A member the owner's roster does not class as an integration is a
      // human. The owner themself is the one such member rounds allows.
      if (memberId !== owner) return empty;
    }
    return mates;
  } catch {
    /* no profile, no room file, a fold that throws — today's behaviour */
  }
  return empty;
}

export async function sendRoomMessage(
  account: string,
  groupId: string,
  text: string,
  deliver: RoomDelivery = sendEncryptedFanout,
  status: (word: string) => void = () => {},
  /** `ai` — the Art. 50 origin marker (as amended). Set ONLY by the agent lane (attend's `realSendRoomReply`):
   * agent-authored means composed by the agent, and an operator typing
   * `room send` at an integration's keyboard is a person. The claim rides
   * the grp.msg WRAPPER always — and, per the amendment, ALSO inside `b`
   * whenever `b` is itself an envelope (strip-mode parsers, zero compat
   * cost), so it survives a grp.hist relay of the bare `b` bytes. Bare
   * text stays bare: it has no field to carry the claim, and wrapping it
   * would freeze "Unsupported message" onto every pre-marker member's
   * phone (group-envelope.ts holds the whole argument). */
  /** `siblings` — ROUNDS R1's widening (§3.6), set ONLY by
   * attend's `realSendRoomReply` and only for a room the owner turned rounds
   * ON. True keeps the legs of the crew-mate agents `crewMateAgentIds`
   * returns, in addition to the agents this frame already addresses or owns;
   * every other caller, and every room that read answers ∅, fans out exactly
   * as it did before. It never touches a human leg in either direction. */
  opts: { attach?: string | undefined; ai?: boolean; siblings?: boolean } = {},
): Promise<RoomSendOutcome> {
  const selfId = loadProfile(account).userId;
  const store = loadRoom(account, groupId);
  const ownerId = store.getOwner() as string;
  const fold = foldRoster(ownerId, store.listSlots(), ownerOnlyPolicy);

  // The FOLD's verdict, not a rule of this file's: a sender the fold says is
  // out has left (or was removed), and every member's phone will discard
  // their traffic — an exit code is more honest than a send that
  // silently lands nowhere.
  if (verdictFor(fold, selfId) !== 'in') {
    throw new CliError(
      EXIT.REFUSED,
      'you are not in this room — its members discard a non-member\'s messages',
    );
  }
  const stores = new FileStores(account);
  let inner = text;
  if (opts.attach !== undefined) {
    if (text.length !== 0) {
      throw new CliError(
        EXIT.USAGE,
        '--attach sends the file as the whole message — send the text as its own message',
      );
    }
    // COMPOSE ONCE, UPLOAD ONCE, then hand the ONE envelope to mintLegs so
    // every member's leg carries the same {att, key} pair — the fold verdict
    // above gates BEFORE the blob exists (a blob in the shared store is a
    // beacon), and this is the only composeAttachment call in the fan-out,
    // by construction: a per-member loop would 429 at the 11th member.
    status('uploading…');
    inner = await composeAttachment(new AuthSession(account, stores), opts.attach);
  }
  // THE INNER HALF OF THE MARKER: on the agent
  // lane, an envelope-shaped body gains `ai: true` INSIDE as well — the
  // funnel's envelope arm, which leaves bare text untouched (`wrapText`
  // false: wrapping is the owner-attested 1:1 posture, never a room's).
  // BEFORE the caps below, so the guards judge the final wire bytes.
  if (opts.ai === true) inner = markAgentBody(inner, false);
  if (inner.length === 0) {
    throw new CliError(EXIT.USAGE, 'nothing to send: the message is empty');
  }
  if (inner.length > MAX_GROUP_BODY) {
    throw new CliError(
      EXIT.USAGE,
      `the message is too long for a room (over ${MAX_GROUP_BODY} characters)`,
    );
  }

  // Allocations, in the app's order: the per-author sq, the group-message id
  // minted ONCE for all legs (it is what makes a future reaction or
  // edit mean the same thing on every phone), and the rd digest over this
  // client's OWN folded roster state (every sender computes it
  // independently; a receiver whose fold disagrees sees the banner).
  const sq = nextMsgSq(account, groupId);
  const m = innerUlid();
  const rd = await composeRosterDigest(ownerId, fold.members, sha256);
  const body = encodeGroup(GroupMessageEnvelope, {
    tcm: 'grp.msg',
    g: groupId,
    m,
    rd,
    sq,
    b: inner,
    ...(opts.ai === true ? { ai: true as const } : {}),
  });

  // Broadened to addressed-or-owned:
  // the CONTENT audience. An AGENT member this frame does not ADDRESS or OWN
  // (no @mention, no reply-to-continue, no lifecycle for a target it received)
  // is dropped BEFORE the leg mint, so it is never a recipient of this sealed
  // copy — a clean non-send, not a failed leg. An agent's own reply
  // (realSendRoomReply, bare `inner`) therefore reaches the humans and any
  // addressed agent, never OTHER unaddressed agents. `inner` is the final wire
  // body (marked or bare). Human legs are untouched.
  const audience = roomContentRecipients(
    account,
    fold.members.filter(id => id !== selfId),
    inner,
    roomAgentAuthorIds(account, groupId),
    // ROUNDS R1: the sibling widening, read from the OWNER's roster classes
    // (never the `ai` marker) and empty unless this is the owner's own
    // crew room with no second human in it (R15/R26 — `crewMateAgentIds`).
    opts.siblings === true ? crewMateAgentIds(account, groupId) : undefined,
  );
  const { sendable, skipped } = splitSendable(stores, audience);
  const legs = await mintLegs(sendable, () => body);
  let outcomes: FanoutLegOutcome[] = [];
  if (legs.length > 0) {
    status('connecting…');
    const auth = new AuthSession(account, stores);
    outcomes = await deliver({
      stores,
      auth,
      legs,
      events: { connecting: () => status('connecting…'), encrypting: () => status('sending…') },
    });
  }
  const summary = summarize(outcomes, skipped);
  return {
    m,
    outcomes,
    delivered: summary.delivered,
    skipped: summary.skipped,
    preSkipped: skipped,
    failed: summary.failed,
    // The denominator is the CONTENT audience — who this copy was actually
    // addressed to — so "delivered to N of M" is honest after the rule drops an
    // unmentioned agent (which was never a recipient, not a failed leg).
    recipients: audience.length,
    members: fold.members.length,
  };
}

async function cmdRoomSend(
  account: string,
  groupId: string,
  text: string,
  report: Reporter,
  deliver: RoomDelivery,
  attach?: string,
): Promise<ExitCode> {
  const sent = await sendRoomMessage(
    account,
    groupId,
    text,
    deliver,
    word => report.status(word),
    { attach },
  );
  const { m, outcomes } = sent;
  const summary = { delivered: sent.delivered, skipped: sent.skipped, failed: sent.failed };
  noteSkipped(report, sent.preSkipped, account);
  report.emit(
    {
      ok: summary.failed.length === 0,
      groupId,
      m,
      members: sent.members,
      // PER-LEG WIRE-ID VISIBILITY, and it is a definition-of-done item, not
      // decoration: "no two wire msgIds in any fan-out share
      // more than 6 leading characters" must be assertable IN THE E2E RUN,
      // over the real wire — and the only party that ever sees all of one
      // fan-out's wire ids together is the sender. This is the check that
      // catches a minter quietly swapped back to monotonic ULIDs.
      legs: outcomes.map(o => ({
        to: o.to,
        msgId: o.msgId,
        state: o.state,
        ...(o.reason !== undefined ? { reason: o.reason } : {}),
      })),
      delivered: summary.delivered,
      skipped: summary.skipped,
      failed: summary.failed,
    },
    `${m} delivered to ${summary.delivered.length} of ${sent.recipients} member(s)`,
  );
  return fanoutExit(summary);
}

// --- dispatch ---------------------------------------------------------------

const ROOM_USAGE = `usage:
  tacendum room create <account> <roomName> <memberId>...   make a room and invite its members
  tacendum room list <account>                              rooms this client holds
  tacendum room show <account> <groupId>                    one room's roster, as this client folds it
  tacendum room add <account> <groupId> <memberId>          owner only — counted by every member's own fold
  tacendum room remove <account> <groupId> <memberId>       owner only — the removed member is told too
  tacendum room leave <account> <groupId>                   your own sovereign out; final for you
  tacendum room accept <account> <groupId>                  answer an invitation: join
  tacendum room decline <account> <groupId>                 answer an invitation: your out, final
  tacendum room delete <account> <groupId> [--everyone]     local by default; --everyone is owner-only, best-effort
  tacendum room send <account> <groupId> "<text>"           one encrypted copy per member, over the pairwise ratchet
  tacendum room send <account> <groupId> --attach <file>    one blob uploaded once; every member's leg carries its key

<account> is this machine's local account name, exactly as in \`tacendum send <from> …\`.
<memberId> is a local client name or a bare 26-character user id.`;

/**
 * `tacendum room <sub> <account> …` — wired in main.ts beside the other
 * commands. Parsing follows the house idiom exactly: the local account is
 * positional 0 as it is everywhere else, parseArgs per subcommand with the
 * flags that subcommand takes and no others, --help short-circuits, usage
 * errors are EXIT.USAGE with the usage text.
 */
export async function cmdRoom(
  argv: string[],
  report: Reporter,
  deliver: RoomDelivery = sendEncryptedFanout,
): Promise<ExitCode> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(ROOM_USAGE);
    return EXIT.OK;
  }

  switch (sub) {
    case 'create': {
      const args = parseArgs(rest);
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = 'tacendum room create <account> <roomName> <memberId>...';
      const account = requireAccount(args, 0, usage, report);
      const name = requirePositional(args, 1, usage);
      const members = args.positionals.slice(2);
      if (members.length === 0) {
        throw new CliError(EXIT.USAGE, `usage: ${usage}`);
      }
      return cmdRoomCreate(account, name, members, report, deliver);
    }
    case 'list': {
      const args = parseArgs(rest);
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      cmdRoomList(requireAccount(args, 0, 'tacendum room list <account>', report), report);
      return EXIT.OK;
    }
    case 'show': {
      const args = parseArgs(rest);
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = 'tacendum room show <account> <groupId>';
      const account = requireAccount(args, 0, usage, report);
      cmdRoomShow(account, requireRoomId(requirePositional(args, 1, usage)), report);
      return EXIT.OK;
    }
    case 'add':
    case 'remove': {
      const args = parseArgs(rest);
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = `tacendum room ${sub} <account> <groupId> <memberId>`;
      const account = requireAccount(args, 0, usage, report);
      // The raw argument rides along: a member named by
      // LOCAL NAME already has its whole profile read by resolveRecipient,
      // and the class on that profile is one of the two honest sources
      // localIntegrationIds consults.
      const rawMember = requirePositional(args, 2, usage);
      return roomRosterTransition(
        account,
        requireRoomId(requirePositional(args, 1, usage)),
        resolveRecipient(rawMember),
        sub === 'add' ? 'in' : 'out',
        { action: sub, rawMember },
        report,
        deliver,
      );
    }
    case 'leave':
    case 'accept':
    case 'decline': {
      const args = parseArgs(rest);
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = `tacendum room ${sub} <account> <groupId>`;
      const account = requireAccount(args, 0, usage, report);
      const selfId = loadProfile(account).userId;
      // accept = my own sovereign `in` (a join, and what a rejoin
      // requires); leave and decline = my own sovereign `out` — decline also
      // hides the conversation. Three bindings of ONE transition.
      return roomRosterTransition(
        account,
        requireRoomId(requirePositional(args, 1, usage)),
        selfId,
        sub === 'accept' ? 'in' : 'out',
        { action: sub, ...(sub === 'decline' ? { hideAfter: true } : {}) },
        report,
        deliver,
      );
    }
    case 'delete': {
      const args = parseArgs(rest, { boolean: ['--everyone'] });
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = 'tacendum room delete <account> <groupId> [--everyone]';
      const account = requireAccount(args, 0, usage, report);
      return cmdRoomDelete(
        account,
        requireRoomId(requirePositional(args, 1, usage)),
        flagBool(args, '--everyone'),
        report,
        deliver,
      );
    }
    case 'send': {
      const args = parseArgs(rest, { value: ['--attach'] });
      if (flagBool(args, '--help')) return console.log(ROOM_USAGE), EXIT.OK;
      const usage = 'tacendum room send <account> <groupId> "<text>" | --attach <file>';
      const account = requireAccount(args, 0, usage, report);
      const rawId = requirePositional(args, 1, usage);
      const attach = flagString(args, '--attach');
      // With --attach the file IS the message, so the body positional is
      // forbidden rather than optional (sendRoomMessage refuses the combo).
      const text = attach !== undefined ? (args.positionals[2] ?? '') : requirePositional(args, 2, usage);
      if (args.positionals.length > 3) {
        // The same trap `send` closes: an unquoted body splits into words and
        // all but the first would be silently dropped. The extra words are
        // never echoed.
        throw new CliError(
          EXIT.USAGE,
          `room send takes one body argument, got ${args.positionals.length - 2} — ` +
            'quote the body, or put -- before a body that starts with a dash',
        );
      }
      return cmdRoomSend(account, requireRoomId(rawId), text, report, deliver, attach);
    }
    default:
      if (!report.json) process.stderr.write(`${ROOM_USAGE}\n`);
      throw new CliError(
        EXIT.USAGE,
        `unknown room subcommand "${sanitizeServerField(sub, 32)}" — run: tacendum room --help`,
      );
  }
}
