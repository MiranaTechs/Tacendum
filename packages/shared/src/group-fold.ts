import { z } from 'zod';

/**
 * The membership fold for rooms.
 *
 * Every phone holds a bag of authenticated roster writes and must turn it into
 * the same answer to two questions — who is in this room, and who runs it —
 * with no server, no clock, and no reference to arrival order. This module is
 * that computation, whole: the content-only total order, the two lanes, the
 * verdict, the `grp.del` classifier, the `rd` digest preimage, the apply
 * policy, and the one storage bound. Today only the tests consume it:
 * `packages/shared` exports `"."` alone and `index.ts` does not re-export
 * this module — deliberately: this layer's definition of done is additions
 * only, and the wiring decision belongs to the first change with a real
 * consumer. When that lands, the app and the CLI must import THIS module
 * unchanged (§4.1) — one implementation, because two implementations of the
 * digest canonicalisation produce a permanent banner on honest traffic.
 *
 * Deliberately pure: no `db`, no `react-native`, no
 * `messaging`, no node builtin, no other shared module — zod and nothing
 * else. Storage reaches it through the injected `GroupSlotStore` seam, so one
 * fold serves SQLite on the phone and files in the CLI. Hashing reaches it
 * through an injected SHA-256 (`Sha256`), because this package has no crypto
 * and must not grow one — the platform provides it (CryptoKit on iOS via the
 * `tacendum-crypto` TurboModule, and `node:crypto` in the test suites that
 * pin byte-equality between the two), exactly as the
 * CSPRNG behind `randomMsgId` is injected rather than owned.
 *
 * This once said "`node:crypto` in the CLI". There is no SHA-256
 * anywhere under `packages/cli/src` — verify with
 * `/usr/bin/grep -rn "createHash\|sha256" packages/cli/src` — so that named a
 * binding that does not exist. The seam is deliberately open for a CLI
 * implementation; describing the intent as though it had shipped is how rule
 * 1's own item 6 came to cite the same phantom.
 *
 * The model, in three rules (§6.2), after three rounds of subtraction:
 *
 *   1. A member's own lane is SOVEREIGN. Their winning `out` is absolute;
 *      nobody — the owner included — can drag anyone back into a room they
 *      left. An owner "re-adding" someone who left is an invitation, never a
 *      return.
 *   2. The authority lane is the OWNER's, and only the owner's. The owner is
 *      the `frame.from` of the `grp.new` this device accepted — a constant
 *      for the room's life — so every write is classifiable the instant it
 *      arrives and nothing is ever "not yet decidable".
 *   3. The verdict: a member is in iff their own lane does not say `out` AND
 *      the owner's lane says `in`. Your own `in` cancels only your own
 *      earlier `out`; it never admits you.
 *
 * There is no epoch, no term, no ownership chain, no seal, no snapshot
 * compaction, no freeze predicate, and no pending/held write anywhere in this
 * file, and none may return: each was deleted with the machinery that needed
 * it (the simplified membership model governs). A test asserting any of them
 * is how they come back.
 */

// --- ids, slots, and the content-only total order ---------------------------

/**
 * ULID shape, duplicated from `frames.ts` on purpose: importing the wire
 * module would drag the transport layer into the fold, and the purity suite
 * pins this file to "nothing but zod and its own constants". One regex, one line;
 * the cross-client vectors pin the alphabet.
 */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID');

export const RosterState = z.enum(['in', 'out']);
export type RosterState = z.infer<typeof RosterState>;

/**
 * The member CLASS a roster write may carry (the consent bootstrap fix).
 * `'integration'` = the writer's own records say
 * this member is a machine; ABSENT = unknown/human, the only safe default.
 *
 * Written by the room OWNER alone (their roster write is the one lane that
 * counts, so it is also the one lane that classifies — see `GroupFold.classes`)
 * and RAISE-ONLY INFORMATIONAL: it exists so a second human's device can
 * offer the consent choice BEFORE the agent ever speaks, and it must NEVER
 * admit anyone, gate delivery, or move a verdict. `.catch(undefined)` is
 * §5.5's rule in one combinator — a malformed class costs itself, never the
 * slot (the rd/ai precedent).
 */
export const RosterClass = z.literal('integration');
export type RosterClass = z.infer<typeof RosterClass>;

/**
 * One membership slot — both the write as it arrives (already authenticated:
 * `writerId` is `frame.from`, NEVER a payload field — sender-authenticated, so
 * a payload cannot claim someone else's lane) and the winner as a store holds
 * it. They are the same shape because a winning write is stored verbatim.
 *
 * Deliberately NOT here: `updatedAt`. §6.6 gives the persisted row a
 * display-only clock; keeping it out of this type is what makes "nothing
 * orders by it" structural rather than aspirational.
 */
export const RosterSlot = z.object({
  memberId: Ulid,
  writerId: Ulid,
  seq: z.number().int().min(1),
  state: RosterState,
  /** The write's class claim, stored verbatim with its slot. Whether it MEANS
   * anything is the fold's call (owner lane only) — a stray class on a
   * sovereign slot is inert, exactly as a stray lane cannot move a verdict. */
  class: RosterClass.optional().catch(undefined),
});
export type RosterSlot = z.infer<typeof RosterSlot>;

/**
 * The content-only total order on one lane's writes: `seq`, then `out` beats
 * `in`. True if `a` strictly beats `b`.
 *
 * The tiebreak exists because `seq`'s atomic allocation makes a tie impossible
 * for an HONEST writer only — an equivocating writer can sign `(seq 42, in)`
 * for one person and `(seq 42, out)` for another, and two devices that
 * eventually hold both halves must resolve them identically with no reference
 * to arrival order (§6.2 rule 1's tiebreak, kept verbatim through
 * every re-specification). `out`-last is the fail-safe direction: when a
 * writer says two things at once, the reading that stops traffic wins.
 * No wall clock appears here or anywhere in this module (rule 17).
 */
export function rosterBeats(
  a: Pick<RosterSlot, 'seq' | 'state'>,
  b: Pick<RosterSlot, 'seq' | 'state'>,
): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.state === 'out' && b.state === 'in';
}

// --- the apply policy -------------------------------------------------------

/**
 * The apply-policy parameter (§6.3, §10.3): one predicate over the
 * authenticated writer, consulted by the roster fold/apply AND the settings
 * apply — deciding it here, before an inbound path hard-codes it, is the
 * entire point: adding it later forks that path instead of
 * extending it.
 *
 * It gates AUTHORITY only. A member's own roster slot is sovereign and is
 * never subject to any policy (§6.2 rule 1) — under a future "nobody" policy
 * (a fixed-roster room class) every roster write about someone else declines,
 * yet anyone may still leave, always.
 */
export type GroupApplyPolicy = (writerId: string, ownerId: string) => boolean;

/**
 * `grp.roster`'s production value (§6.3): the writer is the room's owner.
 * This is real authorisation, not a gate — every honest phone applies the
 * same predicate to the same authenticated inputs and reaches the same
 * roster, which needs no server because it is a computation.
 */
export const ownerOnlyPolicy: GroupApplyPolicy = (writerId, ownerId) => writerId === ownerId;

/**
 * `grp.set`'s production value (§10.3): every member's
 * timer lever counts. The timer stays sovereign where the roster became
 * owner-governed, because a timer is enforced by each phone on its own
 * copies — an owner-only timer would bind precisely the phones that obey and
 * nobody else, while taking a real safety control away from members. The two
 * envelope kinds exercising BOTH policy values is what keeps this seam
 * honest rather than ceremonial.
 */
export const unconditionalPolicy: GroupApplyPolicy = () => true;

// --- the slot store seam ----------------------------------------------------

/**
 * Storage, as the fold is allowed to see it: winner per
 * `(memberId, writerId)` — §6.6's PRIMARY KEY — plus the room's anchor and
 * its conversation-row presence. SQLite on the phone and files in the CLI
 * each implement this once; the fold and the apply path never learn which.
 *
 * The anchor and presence ride the same seam as the slots because the two
 * delete acts differ exactly in which of these they touch (§6.4): a local
 * delete removes presence and KEEPS the anchor and slots (the room's state
 * outlives its content, `deleteChat`'s precedent); a counted `grp.del`
 * purges all of it. Split the seam and the two acts fork per platform.
 *
 * Implementations may carry more (the `groups.name`, `updatedAt` display
 * clocks); the fold must never need it.
 */
export interface GroupSlotStore {
  /**
   * `groups.ownerId` — the `frame.from` of the accepted `grp.new`, written
   * once at accept, never updated by any later write (§6.6). `undefined`
   * means this phone holds no such room.
   */
  getOwner(): string | undefined;
  setOwner(ownerId: string): void;

  getSlot(memberId: string, writerId: string): RosterSlot | undefined;
  putSlot(slot: RosterSlot): void;
  deleteSlot(memberId: string, writerId: string): void;
  listSlots(): readonly RosterSlot[];

  /** Winner per writer for `grp.set` (§6.6's `group_settings`). */
  getSettingsSlot(writerId: string): SettingsSlot | undefined;
  putSettingsSlot(slot: SettingsSlot): void;
  listSettingsSlots(): readonly SettingsSlot[];

  /**
   * Whether the room's conversation exists on this phone — the `chats` row
   * on the phone, the room file in the CLI. False after a local delete;
   * the anchor and slots stay, so traffic can recreate it (§6.4).
   */
  isPresent(): boolean;
  setPresent(present: boolean): void;

  /**
   * `grp.del`'s FULL purge (§6.4): the anchor, every roster slot, every
   * settings slot, and presence. After this the phone does not hold the
   * room; later traffic for its groupId is discarded quietly upstream.
   */
  clear(): void;
}

// --- the fold ---------------------------------------------------------------

export interface GroupFold {
  ownerId: string;
  /**
   * Verdict per id any stored slot mentions, plus the owner. An id absent
   * here is `out` — membership without an owner claim is impossible (§6.2
   * rule 3), so use `verdictFor`, which encodes that default.
   */
  verdicts: Readonly<Record<string, RosterState>>;
  /** The folded `in` set, ascending by code unit — §5.1's digest order. */
  members: readonly string[];
  /**
   * Member class per id, read from the AUTHORITY lane's winner ALONE: the
   * owner's roster write is the one lane that counts, so it
   * is the one lane that classifies — a class on any other writer's slot is
   * ignored here, which is what makes "a human can't be class-marked by a
   * third party" structural (only the owner writes the lane; a malicious
   * owner's false mark is bounded to their own room — its full cost, stated
   * honestly, is the corrected malicious-owner bound: sender
   * defaults over content/typing/lifecycle carriers plus a consent-line
   * spoof surface, never a refusal, always badged on the roster). Absent =
   * unknown/human. RAISE-ONLY INFORMATIONAL: nothing in
   * this record may ever admit, exclude from membership, or gate delivery by
   * itself — consent stays edge-gated server-side.
   */
  classes: Readonly<Record<string, RosterClass>>;
}

/**
 * The fold (§6.2): a pure function of the owner constant and the received
 * set. Order-independent provably rather than aspirationally — every lane
 * winner is a `max` under `rosterBeats` (associative, commutative,
 * idempotent) and the verdict reads only the winners.
 *
 * One consequence of §6.6's flat `(memberId, writerId)` key is encoded here
 * and deserves its comment, because a naive reading of §6.2 would delete it:
 * the OWNER's sovereign self row and their `grp.new` authority claim share
 * one physical row — `(owner, owner)` — so that row must count in BOTH
 * lanes. Counting it as authority (its writer passes the production policy)
 * is what keeps two required facts true at once: the creator folds IN
 * on every phone from the `grp.new` alone, and an
 * owner who left can always unilaterally rejoin — their own `in` wins the
 * merged row and their standing claim readmits them (§6.2 rule 2's
 * rejoin-equivalence, the reason no seal exists).
 *
 * The policy is consulted here as well as at apply time ("both folds") —
 * so a stray lane a buggy store held anyway can never move a
 * verdict under the production policy. Under a policy that passes several
 * writers, authority candidates merge across writers under the same content
 * order; in production exactly one writer passes, so the order is per-writer
 * exactly as §6.2 states.
 */
export function foldRoster(
  ownerId: string,
  slots: Iterable<RosterSlot>,
  policy: GroupApplyPolicy = ownerOnlyPolicy,
): GroupFold {
  const self = new Map<string, RosterSlot>();
  const authority = new Map<string, RosterSlot>();
  const universe = new Set<string>([ownerId]);
  const keep = (lane: Map<string, RosterSlot>, slot: RosterSlot) => {
    const cur = lane.get(slot.memberId);
    if (cur === undefined || rosterBeats(slot, cur)) lane.set(slot.memberId, slot);
  };
  for (const slot of slots) {
    universe.add(slot.memberId);
    if (slot.writerId === slot.memberId) keep(self, slot);
    if (policy(slot.writerId, ownerId)) keep(authority, slot);
  }

  const verdicts: Record<string, RosterState> = {};
  for (const memberId of universe) {
    const own = self.get(memberId);
    if (own !== undefined && own.state === 'out') {
      // Rule 1, absolute: nobody — owner included — undoes a member's out.
      verdicts[memberId] = 'out';
      continue;
    }
    // Rule 3: in iff the authority lane says in. A lone self `in` admits
    // nobody; it only cancels that member's own earlier `out`.
    verdicts[memberId] = authority.get(memberId)?.state === 'in' ? 'in' : 'out';
  }

  // Class from the AUTHORITY winner alone (see GroupFold.classes): the lane
  // that admits is the lane that classifies, and the WINNER's class is the
  // class — a losing slot's mark is as dead as its state.
  const classes: Record<string, RosterClass> = {};
  for (const [memberId, slot] of authority) {
    if (slot.class !== undefined) classes[memberId] = slot.class;
  }

  const members = [...universe].filter(id => verdicts[id] === 'in').sort();
  return { ownerId, verdicts, members, classes };
}

/** The verdict for any id, with the only correct default: out (§6.2 rule 3). */
export function verdictFor(fold: GroupFold, memberId: string): RosterState {
  return fold.verdicts[memberId] ?? 'out';
}

// --- the rd digest preimage (§5.1, §6.2a) -----------------------------------

/**
 * The injected hash. Must return the full SHA-256 (or at least its first 8
 * bytes); this module truncates. Injected for the same reason the CSPRNG
 * behind `randomMsgId` is: `packages/shared` owns no crypto
 * — CryptoKit provides it on iOS; `node:crypto` provides it in the test
 * suites. No CLI implementation exists yet (see the header note).
 */
export type Sha256 = (preimage: Uint8Array) => Uint8Array;

/**
 * The `rd` preimage, byte-exact per §5.1 because this is exactly the detail
 * two implementations get differently: the owner's ULID, then the folded
 * member ULIDs ascending by code unit, ALL joined with U+001F, encoded
 * UTF-8. Ownership lives INSIDE the preimage rather than in a second digest
 * (§6.2a): a room forged on a false owner claim can have a member list that
 * agrees while the authority does not, and a members-only digest is blind to
 * exactly that.
 *
 * Members are sorted here even though `foldRoster` already sorts — sorting is
 * idempotent, and a caller who assembled the list by hand must not be able
 * to produce a permanent banner on honest traffic.
 */
export function rosterDigestPreimage(ownerId: string, members: readonly string[]): Uint8Array {
  // The digest defends its own injectivity: an id CONTAINING the separator
  // is rejected loudly, because without this check preimage(['A\u001fB'])
  // would be byte-identical to preimage(['A','B']) and the anti-equivocation
  // alarm would be unambiguous only by grace of ULID validation two layers
  // away. Separator-freedom is exactly the property that makes a
  // join-encoding injective, so it is the one property enforced HERE; any
  // OTHER malformed id still just changes the digest (a mismatch, the
  // visible outcome) rather than throwing mid-fold.
  for (const id of [ownerId, ...members]) {
    if (id.includes('\u001f')) {
      throw new Error(
        'rosterDigestPreimage: an id contains the U+001F separator - the digest would be ambiguous',
      );
    }
  }
  const joined = [ownerId, ...[...members].sort()].join('\u001f');
  return utf8Bytes(joined);
}

/**
 * The digest itself: SHA-256 of the preimage, first 8 bytes, base64 WITHOUT
 * padding — exactly 11 characters. 8 bytes is 11 unpadded and 12 padded;
 * §5.1 says which, because "12" without saying which would make every
 * cross-client message either fail validation or mismatch.
 */
export function rosterDigest(
  ownerId: string,
  members: readonly string[],
  sha256: Sha256,
): string {
  const digest = sha256(rosterDigestPreimage(ownerId, members));
  if (digest.length < 8) {
    // A mis-injected hash must fail loudly here, not surface as a permanent
    // equivocation banner between two honest clients.
    throw new Error(`injected sha256 returned ${digest.length} bytes; need at least 8`);
  }
  return base64Unpadded(digest.subarray(0, 8));
}

/**
 * UTF-8 by hand rather than via `TextEncoder`: the encoder is a platform
 * global this module refuses to assume (older Hermes lacks it), and §5.1's
 * encoding is specified to the byte — owning those bytes is this function's
 * whole job. Inputs are ULIDs (ASCII) in production; the general encoding
 * exists so a malformed id changes the digest instead of throwing mid-fold.
 */
function utf8Bytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const cp = value.codePointAt(i)!;
    if (cp > 0xffff) i++; // consumed a surrogate pair
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** RFC 4648 §4 (`+/`), unpadded — §5.1's choice, stated there. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Exported so `group-envelope.ts`'s asynchronous digest path shares THIS
 * encoder rather than carrying a second one.
 *
 * A second copy is not a style problem here. The digest exists to reveal
 * equivocation, and two encoders that disagree by one character produce
 * *"you and Ben disagree about who is in this room"* on honest traffic,
 * permanently — the alarm-fatigue generator §4.1 names. It was in fact written
 * twice and a mutation swapping one copy to the URL-safe alphabet survived the
 * whole suite, because the fixture in play happened to contain no `+` or `/`.
 * One implementation, and a vector that exercises both characters.
 */
export function base64Unpadded(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64[a >> 2]!;
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64[c & 0x3f]!;
  }
  return out;
}

// --- the apply path ---------------------------------------------------------

/**
 * The one bound the store still needs (§6.4): honest owners cannot exceed
 * the wire's member cap, so the only unbounded dimension is a hostile owner
 * MINTING member ids. Bound what you keep, never what you accept.
 */
export const GROUP_OWNER_LANE_CAP = 64;

/**
 * The room cap (§5.1, G0 decision 4). §4's layout assigns this constant to
 * `group-envelope.ts`; that module does not exist until G2, and this one may
 * import nothing but zod, so it is defined here first — G2 must import THIS
 * definition into the envelope schema rather than minting a second 12.
 */
export const GROUP_MAX_MEMBERS = 12;

/** The accepted `grp.new`: `writerId` is `frame.from` (rule 16), `seq` its `n`. */
export const GroupNewWrite = z.object({
  writerId: Ulid,
  /**
   * The payload's `ms`. Bounded here as well as at the wire (§5.1), because
   * a peer-supplied array that will be iterated gets bounded where it is
   * iterated: without this, a 5 000-member forgery drives 5 000 slot writes
   * before `capOwnerLane` trims what persists.
   */
  members: z.array(Ulid).min(1).max(GROUP_MAX_MEMBERS),
  seq: z.number().int().min(1),
  /**
   * The payload's `ic`: the subset of `ms` the writer's
   * own records name as integrations. Classifies seed slots, NEVER invites —
   * an id here that is not in `ms` (after the sender clamp) stamps nothing.
   * Bounded like `members`, for the same iterated-peer-array reason.
   */
  integrations: z.array(Ulid).max(GROUP_MAX_MEMBERS).optional(),
});
export type GroupNewWrite = z.infer<typeof GroupNewWrite>;

/**
 * A `grp.del`. `seq` is carried for the announced row; the classifier never
 * orders on it — a purge is not a slot and cannot be out-run by seq.
 */
export const GroupDelWrite = z.object({
  writerId: Ulid,
  seq: z.number().int().min(1),
});
export type GroupDelWrite = z.infer<typeof GroupDelWrite>;

export type GroupNewResult =
  /** Anchored the room: this phone now holds it, presence on. */
  | { outcome: 'accepted'; evicted: readonly RosterSlot[] }
  /**
   * A second `grp.new` from the SAME writer as the stored anchor, and at
   * least one of its seed slots won its lane row. The anchor row itself
   * never changes (§6.6); only the seeds folded, as the ordinary owner-lane
   * writes they are.
   */
  | { outcome: 'merged'; evicted: readonly RosterSlot[]; recreated: boolean }
  /**
   * Changed nothing: an exact replay from the anchor's writer whose seeds
   * all lost, or a `grp.new` from a DIFFERENT writer — a forged-anchor
   * attempt, never re-anchored (§6.6: written once), the §6.2a late-joiner
   * residual, surfaced by `rd` on first honest contact.
   */
  | { outcome: 'ignored' };

/**
 * Accept a `grp.new`. Anchors the room — `frame.from` becomes the owner,
 * forever — and converts the payload roster into owner-lane `in` slots
 * (§5.1): the invite IS just authority writes, so the fold needs no special
 * creation case.
 *
 * The sender is clamped into `ms` (receiver-permissive, §5.5): the creator
 * folding OUT on every other phone is exactly the defect this clamp closes,
 * and it closes it against a hostile composer too.
 *
 * Duplicate `grp.new` for one room resolves by CONTENT, not arrival, where
 * that is soundly possible — per writer:
 *
 *   - SAME writer as the stored anchor (an equivocating or buggy composer,
 *     §6.2a): the anchor row is untouched and the seeds run through the
 *     ordinary winner-per-key lane logic, so `{A,[A,B],seq 1}` and
 *     `{A,[A,C],seq 2}` fold to {A,B,C} under both arrival orders instead
 *     of first-arrival-wins — and an exact replay's seeds all lose to the
 *     rows they duplicated, changing nothing.
 *   - DIFFERENT writer: ignored whole, deliberately arrival-ordered. The
 *     anchor is written once and never updated (§6.6) because any writer
 *     may name any groupId, so "deterministic" anchor selection would let a
 *     low-sorting forger STEAL an existing room's anchor. First-accept is
 *     the trust root §6.2a already names (the late-joiner residual), and
 *     `rd` discloses the split on first honest contact.
 *
 * A room re-anchoring AFTER a counted `grp.del` cleared it is a documented
 * order-dependent edge (§6.4): the stillborn room this deliberately permits
 * is cheaper than the tombstone store that would prevent it.
 *
 * `selfId` is this phone's own id and `policy` the ROSTER policy, both used
 * only by the merge path's recreation rule (§6.4: counted traffic recreates
 * a hidden room iff this phone's own fold says it is still a member).
 */
export function applyGroupNew(
  store: GroupSlotStore,
  selfId: string,
  write: GroupNewWrite,
  policy: GroupApplyPolicy = ownerOnlyPolicy,
): GroupNewResult {
  if (write.members.length > GROUP_MAX_MEMBERS) {
    // Bound where iterated (§6.4's principle). The wire enforces this too
    // (§5.1); a caller reaching here unbounded skipped validation, and loud
    // beats a 5 000-write quiet absorption.
    throw new Error(
      `applyGroupNew: ${write.members.length} members exceeds GROUP_MAX_MEMBERS (${GROUP_MAX_MEMBERS})`,
    );
  }
  const anchored = store.getOwner();
  if (anchored !== undefined && anchored !== write.writerId) return { outcome: 'ignored' };
  const accepting = anchored === undefined;
  if (accepting) store.setOwner(write.writerId);
  const members = new Set(write.members);
  members.add(write.writerId); // the clamp
  // The writer's class claims: stamped onto the seed
  // slots below, so an invitee's very first fold already knows which members
  // the owner's records call machines. Intersection with `members` is
  // structural — the loop iterates members, so a stray `ic` id invites nobody.
  const integrations = new Set(write.integrations ?? []);
  let changed = false;
  for (const memberId of members) {
    const slot: RosterSlot = {
      memberId,
      writerId: write.writerId,
      seq: write.seq,
      state: 'in',
      ...(integrations.has(memberId) ? { class: 'integration' as const } : {}),
    };
    const cur = store.getSlot(memberId, write.writerId);
    if (cur === undefined || rosterBeats(slot, cur)) {
      store.putSlot(slot);
      changed = true;
    }
  }
  const evicted = capOwnerLane(store, write.writerId);
  if (accepting) {
    store.setPresent(true); // the invitation exists as a conversation
    return { outcome: 'accepted', evicted };
  }
  if (!changed && evicted.length === 0) return { outcome: 'ignored' };
  // A duplicate that moved a row is counted room traffic, so a hidden room
  // recreates by the ordinary rule (own fold says in), never unconditionally
  // — the accept path's setPresent is for the invitation, and this is not one.
  return { outcome: 'merged', evicted, recreated: maybeRecreate(store, selfId, policy) };
}

export type RosterApplyResult =
  /**
   * No anchor and not a self write: a claim about someone else for a room
   * this phone does not hold. Discard quietly — see the pre-anchor note on
   * `applyRosterWrite` for why this write, unlike a self write, is not
   * storable.
   */
  | { outcome: 'unknown-room' }
  /**
   * Provably dead the moment it arrived (§6.2): the owner is a constant, so
   * no future input can ever make this count. Stores NOTHING — the one
   * non-counted class "bound what you keep" does not oblige you to keep —
   * and renders as a declined, attributed row, never silently.
   */
  | { outcome: 'declined' }
  | { outcome: 'applied'; lane: 'self' | 'authority'; evicted: readonly RosterSlot[]; recreated: boolean }
  /** Lost to the stored winner (a replay); nothing changed, nothing re-announces. */
  | { outcome: 'stale'; lane: 'self' | 'authority'; recreated: boolean }
  /**
   * A member's own write for a room whose anchor this phone does not (yet)
   * hold: stored in its ordinary slot, quietly — there is no room surface to
   * announce into, so nothing renders and nothing re-announces. If the
   * anchor never arrives the row is one orphan; if it arrives, the fold
   * reads the row exactly as if it had come second.
   */
  | { outcome: 'self-preanchor' };

/**
 * Apply one authenticated `grp.roster` write through the store. `selfId` is
 * this phone's own id, needed because counted room traffic recreates a
 * locally-deleted room iff this phone's own fold still says it is a member
 * (§6.4). Classification is checked in rule order:
 *
 *   self FIRST — sovereignty is never subject to the policy (§6.2 rule 1),
 *   so even a "nobody" policy cannot stop anyone leaving;
 *   then the policy — `ownerOnlyPolicy` in production (§6.3);
 *   else declined.
 *
 * A declined write does not touch the store and does not recreate the room:
 * it is not room traffic that counts, it is a claim that provably never
 * will.
 *
 * THE PRE-ANCHOR RULE (§6.5). Wire
 * msgIds are random (§3.2) and the server drains an offline queue in wire-id
 * order, so a phone offline at room creation routinely receives roster
 * writes BEFORE the room's `grp.new`; cross-sender ordering does not exist
 * either. "No anchor" therefore conflates two states — room deleted (benign)
 * and anchor not yet arrived (not benign) — and the two writer classes split
 * on exactly that line:
 *
 *   - A SELF write (`writerId === memberId`) is classifiable without the
 *     owner — §6.2 rule 1 gates sovereignty on nothing — so it is STORED.
 *     Dropping it would lose a departure forever: §6.5's healing is the
 *     owner restating truth, and the owner cannot restate someone else's
 *     sovereign `out`. This is NOT the deleted pending/held category: the
 *     write is fully classified on arrival, lands at its ordinary
 *     winner-per-key slot, is never reconsidered, and is bounded at one row
 *     per authenticated sender per room. A stray row for a room that never
 *     anchors is inert — `foldRoster` re-applies the policy and rule 3, so
 *     no orphan slot can admit anyone.
 *   - An AUTHORITY write cannot even be classified: with no anchor there is
 *     no owner to compare against, so storing it would store the
 *     not-yet-decidable — the exact held-write apparatus, with its caps and
 *     eviction rows, that the Simplified block deleted. It is dropped
 *     (`unknown-room`), and that loss SELF-HEALS: the owner's next write
 *     about that member restates the truth whole in the one lane that
 *     counts (§6.5), and the interim divergence is loud via `rd` in both
 *     directions, never silent.
 */
export function applyRosterWrite(
  store: GroupSlotStore,
  selfId: string,
  write: RosterSlot,
  policy: GroupApplyPolicy = ownerOnlyPolicy,
): RosterApplyResult {
  const ownerId = store.getOwner();
  if (ownerId === undefined) {
    if (write.writerId !== write.memberId) return { outcome: 'unknown-room' };
    const cur = store.getSlot(write.memberId, write.writerId);
    if (cur === undefined || rosterBeats(write, cur)) store.putSlot(write);
    return { outcome: 'self-preanchor' };
  }

  const lane: 'self' | 'authority' | 'declined' =
    write.writerId === write.memberId
      ? 'self'
      : policy(write.writerId, ownerId)
        ? 'authority'
        : 'declined';
  if (lane === 'declined') return { outcome: 'declined' };

  const cur = store.getSlot(write.memberId, write.writerId);
  if (cur !== undefined && !rosterBeats(write, cur)) {
    return { outcome: 'stale', lane, recreated: maybeRecreate(store, selfId, policy) };
  }
  store.putSlot(write);
  // Only the owner's authority lane can mint member ids, so only it is
  // capped (§6.4). A self write replaces its own key and can never grow the
  // owner lane.
  const evicted =
    lane === 'authority' && write.writerId === ownerId ? capOwnerLane(store, ownerId) : [];
  return { outcome: 'applied', lane, evicted, recreated: maybeRecreate(store, selfId, policy) };
}

export type GroupDelResult = 'purged' | 'declined' | 'unknown-room';

/**
 * Classify and apply a `grp.del` (§6.4): ONE comparison — `frame.from` is
 * the room's owner — enforced here at apply time, never at the parser
 * (§5.5).
 *
 * Deliberately NOT policy-parameterised and NOT gated on the owner's own
 * membership: a purge cannot be re-evaluated when a late-arriving self-`out`
 * would retroactively gate it, so any such gate is order-dependent. The
 * price, said in copy, is that an owner who left can still delete the room.
 *
 * A `grp.del` for a room this phone does not hold does NOTHING — no
 * tombstone, deliberately: a tombstone store (its table, its DB_TABLES
 * entry, its decoy texture, its sign-out wipe) is machinery serving one race
 * whose worst case is a stillborn room the user deletes by hand.
 *
 * KNOWN LIMIT — no anti-replay. This classifier is memoryless by the same
 * no-tombstone decision, so a REPLAYED genuine `grp.del` purges a room that
 * was re-anchored under the same groupId after the original purge. `seq`
 * cannot gate it: the store keeps no anchor seq (§6.6 has no column for
 * one), and a purge that could be out-run by seq would be order-dependent
 * in the counted path (the comment above). The intended backstop is
 * transport-level de-duplication of wire msgIds on the receive path — which
 * does NOT exist yet; the transport layer must either provide it or re-confront this line.
 * Until then the exposure is: an owner who deletes, re-creates a room under
 * the SAME id (which honest composers never do — room ids are minted fresh)
 * and whose old delete is replayed, loses the re-anchored room locally.
 */
export function applyGroupDel(store: GroupSlotStore, write: GroupDelWrite): GroupDelResult {
  const ownerId = store.getOwner();
  if (ownerId === undefined) return 'unknown-room';
  if (write.writerId !== ownerId) {
    // Takes effect nowhere, stores nothing, renders as a declined,
    // attributed row — never silently (§10.1's founding argument).
    return 'declined';
  }
  store.clear();
  return 'purged';
}

export type RoomTrafficResult = 'recreated' | 'noop' | 'unknown-room';

/**
 * Counted inbound traffic for an anchored room (`grp.msg`, and any counted
 * write) recreates a locally-deleted room — `deleteChat`'s precedent, §6.4 —
 * iff this phone's OWN fold still says it is a member. A member who left and
 * deleted is out by their own slot, so straggler traffic recreates nothing.
 */
export function noteRoomTraffic(
  store: GroupSlotStore,
  selfId: string,
  policy: GroupApplyPolicy = ownerOnlyPolicy,
): RoomTrafficResult {
  if (store.getOwner() === undefined) return 'unknown-room';
  return maybeRecreate(store, selfId, policy) ? 'recreated' : 'noop';
}

/**
 * Delete — local (§6.4). The room's STATE survives its CONTENT: presence
 * goes (with it, the caller's `deleteGroup` cascade purges messages,
 * attachments, outbox rows, drafts and the `chats` row — and leaves
 * `blocked_peers` untouched), while the anchor and every slot stay, exactly
 * as a peer's session outlives `deleteChat`. That survival is why the next
 * inbound traffic can recreate the room with its roster current — and why a
 * member who also LEFT stays gone: recreation consults the fold, and their
 * own `out` folds them out. Local, and nobody else learns.
 */
export function localDeleteRoom(store: GroupSlotStore): void {
  store.setPresent(false);
}

function maybeRecreate(store: GroupSlotStore, selfId: string, policy: GroupApplyPolicy): boolean {
  if (store.isPresent()) return false;
  const ownerId = store.getOwner();
  if (ownerId === undefined) return false;
  if (verdictFor(foldRoster(ownerId, store.listSlots(), policy), selfId) !== 'in') return false;
  store.setPresent(true);
  return true;
}

/**
 * The owner-lane cap (§6.4): keep the LOWEST `memberId`s — content-keyed, so
 * the kept set is identical under every arrival order; an arrival-keyed
 * eviction (LRU, insertion order) would silently diverge phones. Members'
 * own sovereign rows are exempt and never evicted, because evicting an own
 * `out` would resurrect someone against §6.2 rule 1 — under §6.6's flat key
 * that exemption covers the owner's own `(owner, owner)` row, which is
 * sovereign and authority at once. Every eviction is returned so the caller
 * can leave a visible row: a tripped cap means a hostile owner, and it must
 * be seen, not absorbed.
 */
function capOwnerLane(store: GroupSlotStore, ownerId: string): RosterSlot[] {
  const lane = store.listSlots().filter(slot => slot.writerId === ownerId);
  if (lane.length <= GROUP_OWNER_LANE_CAP) return [];
  const sorted = [...lane].sort((a, b) =>
    a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
  );
  const evicted: RosterSlot[] = [];
  let count = lane.length;
  for (let i = sorted.length - 1; i >= 0 && count > GROUP_OWNER_LANE_CAP; i--) {
    const slot = sorted[i]!;
    if (slot.memberId === ownerId) continue; // sovereign, never evicted
    store.deleteSlot(slot.memberId, slot.writerId);
    evicted.push(slot);
    count--;
  }
  return evicted;
}

// --- grp.set: the timer slots (§10.3) ---------------------------------------

/**
 * One writer's timer slot. `disappearSec` 0 means "no timer from me" — see
 * `effectiveDisappearSec` for why 0 must mean no CONSTRAINT rather than a
 * vote for forever. The wire bound (`TIMER_MAX_SECONDS`) is the envelope's
 * to enforce (§5.1); this module orders, it does not police the wire.
 */
export const SettingsSlot = z.object({
  writerId: Ulid,
  seq: z.number().int().min(1),
  disappearSec: z.number().int().min(0),
});
export type SettingsSlot = z.infer<typeof SettingsSlot>;

/**
 * Same content-only order, with §10.3's same-seq tie-break: a CONSTRAINING
 * value beats `0`, and between two constraining values the LOWER wins — the
 * fail-safe direction: when a writer equivocates, the
 * shorter retention wins.
 *
 * `0` is ranked LAST, not lowest, and the reason is the whole rule: `0` is
 * not a shorter timer, it is the absence of one (`effectiveDisappearSec`),
 * so the naive reading of "lower wins" would make an equivocating writer's
 * `(seq 5, 0)` / `(seq 5, 30)` pair resolve toward OFF — fail-open, in the
 * one place this order exists to fail closed. Still a strict total order on
 * distinct values (0 loses to every constraint, constraints order by value),
 * so the per-writer winner stays a commutative, arrival-order-free `max`.
 */
export function settingsBeats(
  a: Pick<SettingsSlot, 'seq' | 'disappearSec'>,
  b: Pick<SettingsSlot, 'seq' | 'disappearSec'>,
): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  if (a.disappearSec === b.disappearSec) return false;
  if (a.disappearSec === 0) return false; // "off" never beats a constraint
  if (b.disappearSec === 0) return true; // a constraint always beats "off"
  return a.disappearSec < b.disappearSec;
}

/**
 * No 'unknown-room' here, deliberately: every `grp.set` slot is its writer's
 * own, so the no-anchor case is always the storable 'self-preanchor' one —
 * a dead union member would invite a caller to handle a state that cannot
 * occur.
 */
export type SettingsApplyResult = 'applied' | 'stale' | 'declined' | 'self-preanchor';

/**
 * Apply one authenticated `grp.set` write. The SAME policy parameter as the
 * roster (§6.3 — "consults the parameter it was already required to take"),
 * with the other production value: `unconditionalPolicy`, because the timer
 * stays every member's own safety lever (§10.3). A policy that declines it
 * (a future room class) renders the change as a declined, attributed row and
 * never applies it — the same declined-not-silent shape as the roster.
 * §10.3's announce-only-when-applied rule keys off the 'applied' outcome
 * alone — 'stale' and 'self-preanchor' announce nothing, which is what
 * stops a replayed old envelope becoming an announcement stream.
 *
 * PRE-ANCHOR, a `grp.set` stores like a roster SELF write and for the same
 * reason (see `applyRosterWrite`): every settings slot is the writer's own —
 * nobody writes anyone else's timer — and a dropped slot is one this writer
 * alone could restate, while its loss fails OPEN (fewer constraints, longer
 * retention). The policy cannot be consulted without an owner, so the slot
 * is stored unconsulted and `effectiveDisappearSec` re-applies the policy at
 * fold time — a stored slot a future owner-only policy rejects is inert,
 * exactly as a stray roster lane cannot move a verdict. Bounded at one row
 * per authenticated sender per room; quiet, because there is no room surface
 * to announce into.
 */
export function applySettingsWrite(
  store: GroupSlotStore,
  write: SettingsSlot,
  policy: GroupApplyPolicy = unconditionalPolicy,
): SettingsApplyResult {
  const ownerId = store.getOwner();
  if (ownerId === undefined) {
    const cur = store.getSettingsSlot(write.writerId);
    if (cur === undefined || settingsBeats(write, cur)) store.putSettingsSlot(write);
    return 'self-preanchor';
  }
  if (!policy(write.writerId, ownerId)) return 'declined';
  const cur = store.getSettingsSlot(write.writerId);
  if (cur !== undefined && !settingsBeats(write, cur)) return 'stale';
  store.putSettingsSlot(write);
  return 'applied';
}

/**
 * The effective timer (§10.3): the MINIMUM across the timer slots of writers
 * the fold says are IN — a lattice join: monotone, no tiebreak, no clock, no
 * identity bias, and the safe direction, since any member can shorten and
 * nobody can lengthen someone else's copy.
 *
 * Two consequences, both deliberate:
 *
 *   - The minimum ranges over the folded `in` set, so a departing griefer
 *     cannot leave a 30-second timer pinned on a room they are no longer in
 *     (§10.3) — and if the owner re-admits them, their slot counts again.
 *   - A slot of 0 ("off") is EXCLUDED from the minimum. 0 is not a shorter
 *     timer, it is the absence of one; if it competed, any member switching
 *     their timer off would drag everyone's to "never disappear" — which is
 *     lengthening other people's copies, the exact thing §10.3's copy
 *     promises cannot happen. Turning your own slot to 0 removes only your
 *     own constraint.
 *
 * Returns 0 — no timer — when no in-member holds a positive slot.
 */
export function effectiveDisappearSec(
  slots: Iterable<SettingsSlot>,
  fold: GroupFold,
  policy: GroupApplyPolicy = unconditionalPolicy,
): number {
  // Reduce to a winner per writer even if a caller hands raw history; a
  // store already holding winners passes through unchanged.
  const winners = new Map<string, SettingsSlot>();
  for (const slot of slots) {
    const cur = winners.get(slot.writerId);
    if (cur === undefined || settingsBeats(slot, cur)) winners.set(slot.writerId, slot);
  }
  let min = 0;
  for (const slot of winners.values()) {
    if (!policy(slot.writerId, fold.ownerId)) continue;
    if (verdictFor(fold, slot.writerId) !== 'in') continue;
    if (slot.disappearSec <= 0) continue;
    if (min === 0 || slot.disappearSec < min) min = slot.disappearSec;
  }
  return min;
}
