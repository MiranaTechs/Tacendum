/**
 * The six `grp.*` wire envelopes, defined ONCE here so the
 * app, the CLI and the tests share one copy — the precedent `app/src/envelope.ts`
 * already records for call signalling: *"Defined canonically in @tacendum/shared
 * so the app, the CLI, and the tests share one schema."* Group chat was the
 * outlier until §4.1 moved it.
 *
 * These ride inside a body that is already encrypted, and every byte is paid
 * for N−1 times, so the keys stay short.
 *
 * Governing rule: the simplified membership model, plus the history-share
 * decision which added `grp.hist` as the sixth kind. There is no epoch, no
 * term, no ownership transfer and no freeze. Anything outside that model in the
 * plan is superseded history.
 *
 * Purity: zod plus `./group-fold.js`. No `db`, no `react-native`, no node
 * builtins — this file is imported by Hermes and by Node alike.
 */

import { z } from 'zod';
import { aiOrigin } from './ai-origin.js';
import {
  GROUP_MAX_MEMBERS,
  RosterClass,
  Ulid,
  base64Unpadded,
  rosterDigestPreimage,
} from './group-fold.js';

export { GROUP_MAX_MEMBERS };

/**
 * The sentinel a body must not begin with. Duplicated from
 * `app/src/envelope.ts:14` deliberately: that file cannot be imported here
 * (it pulls in the app), and the string is part of the wire format rather
 * than of either module. If it ever changes, it changes in both.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * The body of a room message, EXACTLY as `messages.body` would hold it in a
 * 1:1 chat — plain text, or a nested envelope JSON. That is what lets image,
 * file, location, reply, edit, delete and reaction work in rooms with zero
 * duplication: the receiver unwraps `g`, then runs the existing
 * `parseEnvelope(b)` through the SAME switch (§5.2).
 *
 * 20 000 rather than the frame's 30 000 base64 characters (`frames.ts`): the
 * frame budget is base64 of the *ciphertext*, so the plaintext ceiling has to
 * leave room for the envelope around it, the ratchet header, and base64's own
 * 4/3 expansion (§5.6).
 */
export const MAX_GROUP_BODY = 20_000;

/**
 * A room name, bounded like any other peer-supplied display string and
 * refused if it starts with the envelope sentinel — the same rule
 * `bodyText` carries (`app/src/envelope.ts:74`), for the same reason: a
 * display string that is itself an envelope is a forgery primitive.
 */
const groupName = z
  .string()
  .min(1)
  .max(80)
  .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
    message: 'a room name may not itself be an envelope',
  });

/**
 * The room's disappearing timer, in seconds. `0` is **off**, and it does not
 * compete in the room-wide minimum (§10.3) — the fold excludes it, because
 * `min(0, 30)` would let any member switching their own timer off stop
 * messages disappearing for everyone, which is exactly what §10.3's copy
 * promises cannot happen.
 */
const TIMER_MAX_SECONDS = 60 * 60 * 24 * 7;

/** Standard base64, RFC 4648 §4 — the `+/` alphabet, never the URL-safe `-_`. */
const BASE64_STANDARD = /^[A-Za-z0-9+/]+$/;

/** 8 bytes of digest is 11 base64 characters unpadded (and 12 padded). */
export const RD_LENGTH = 11;

/**
 * THE ROSTER DIGEST, composed strictly and parsed permissively.
 *
 * This asymmetry is not fussiness; it is forced by a real constraint.
 * `encodeEnvelope` and `parseEnvelope` deliberately share ONE schema
 * (`app/src/envelope.ts` — *"Validates against the SAME schema parseEnvelope
 * reads"*), which is what makes every bound in this file bind the sender too.
 * A plain `z.string().length(11)` would therefore make a peer's malformed
 * digest **refuse the whole message at the parser** — and §5.5's rule is that
 * the receiver is always strictly more permissive than the sender, *because a
 * parser refusal costs the whole message and on a one-way ratchet that loss is
 * permanent*.
 *
 * So on the wire `rd` is optional and loosely bounded, and `.catch()` turns
 * anything malformed into "no digest" rather than into a lost message. The
 * digest is worth losing; the message is not. A missing or unusable digest
 * suppresses the equivocation banner for that one message and nothing more —
 * the next message from the same sender carries another one (§6.2a: the
 * window is one message).
 *
 * Strictness lives in `RosterDigest` and is applied by `assertComposableRd`
 * on the send path (G4). Two rejected alternatives, recorded so they are not
 * re-litigated: a second parallel *union* would double every schema and make
 * the two drift; and `superRefine` cannot distinguish compose from parse when
 * one schema serves both.
 */
export const RosterDigest = z
  .string()
  .length(RD_LENGTH)
  .regex(BASE64_STANDARD, 'must be standard unpadded base64 (RFC 4648 §4)');

/** The receive-side shape: present-and-valid, or treated as absent. */
const WireRosterDigest = RosterDigest.optional().catch(undefined);

/**
 * Refuse to COMPOSE a message whose digest is malformed. The send path calls
 * this before `encodeEnvelope`; the parser never does. A bad digest of our own
 * making is a bug in this build and should be loud, whereas a bad digest of a
 * peer's making is their problem and must never cost the message.
 */
export function assertComposableRd(rd: string): string {
  const parsed = RosterDigest.safeParse(rd);
  if (!parsed.success) {
    throw new Error(`refusing to compose a group message with a malformed rd: ${rd}`);
  }
  return parsed.data;
}

/**
 * A room message. `m` is the group-message id, minted ONCE by the author for
 * all N legs — that is what makes a reaction or an edit mean the same thing on
 * every phone (§5.3). The wire msgId orders nothing and de-duplicates only
 * (§3.2), which is what let it become pure randomness.
 */
export const GroupMessageEnvelope = z.object({
  tcm: z.literal('grp.msg'),
  /** Room id: a ULID minted by the creator. NEVER in `SendFrame.to` (rule 15). */
  g: Ulid,
  m: Ulid,
  rd: WireRosterDigest,
  /**
   * Per-author counter scoped to the room. The thread orders group rows by
   * `(ts, authorId, sq)`. Optional so a build predating it still parses —
   * absent sorts as 0, which is the order those rows already have.
   */
  sq: z.number().int().nonnegative().optional(),
  b: z
    .string()
    .min(1)
    .max(MAX_GROUP_BODY)
    /**
     * NO NESTING (§5.2). A `grp.*` inside a `grp.msg` would let a sender
     * launder authorship through a second wrapper — and the unwrap is one
     * switch, not a recursion, so a nested one would be ignored at apply
     * anyway. Refused at the schema so it cannot be composed either.
     */
    .refine(value => !value.startsWith(`${ENVELOPE_SENTINEL}"grp.`), {
      message: 'a room message may not wrap another room envelope',
    }),
  /**
   * The Art. 50 AI-origin marker. ON THE WRAPPER, always: a
   * marked wrapper is invisible to every pre-marker build (unknown keys
   * strip) where a new inner kind would render "Unsupported message" on
   * every stranger's phone — the exact population the AI-origin marker exists for.
   * AND, per the amendment, ALSO inside `b` whenever `b` is itself an
   * envelope (reply/mention/msg — strip-mode parsers, zero compat cost), so
   * the claim survives a grp.hist history relay of the bare `b` bytes; bare
   * text stays bare, having no field to carry it. Set by the CLI's agent
   * lane on agent-authored room replies; the app's human composer never
   * sets it, and a malformed value collapses to unmarked rather than
   * costing the message.
   */
  ai: aiOrigin,
});

/**
 * The invite, carrying the opening roster.
 *
 * The payload lists members, but the WRITER is authenticated by the ratchet,
 * so an inviter can only ever assert their own view. The `frame.from` of the
 * `grp.new` a device ACCEPTS is that room's owner **forever** — written to
 * `groups.ownerId` at accept, never carried in a payload field, never changed
 * by any later write. A later joiner cannot verify that claim at join and does
 * not have to: it is their trust anchor, checked against every subsequent
 * message's `rd` (§6.2a says honestly what that is worth).
 */
export const GroupNewEnvelope = z.object({
  tcm: z.literal('grp.new'),
  g: Ulid,
  nm: groupName,
  /**
   * Members INCLUDING the creator. Bounded here as well as in the composer,
   * because a peer's roster snapshot is a peer-supplied array that will be
   * iterated. The cap is imported from `group-fold`, never re-minted — two
   * definitions of it is the defect §4.1 exists to prevent.
   */
  ms: z.array(Ulid).min(1).max(GROUP_MAX_MEMBERS),
  n: z.number().int().min(1),
  /**
   * INTEGRATION-CLASSED members (the consent
   * bootstrap fix): the subset of `ms` the OWNER's own records name as
   * machines, so an invitee's device can offer the consent choice before
   * the agent ever speaks. A PARALLEL list rather than per-entry objects,
   * deliberately: `ms` is an array of bare ULIDs on every shipped build, and
   * reshaping its entries would refuse the whole invite at every old parser —
   * a new optional key strips silently instead (the additive-field compat
   * precedent). `.catch(undefined)` collapses anything malformed to "no
   * claims" rather than costing the invite (§5.5); the apply intersects with
   * `ms`, so this field classifies and never invites. Informational and
   * raise-only: nothing here admits, excludes, or gates delivery.
   */
  ic: z.array(Ulid).max(GROUP_MAX_MEMBERS).optional().catch(undefined),
});

/**
 * ONE membership slot write. Not a carrier: like a timer change it leaves an
 * announced row on every phone.
 *
 * An AUTHORITY write when `frame.from` is the room's owner; a SOVEREIGN self
 * write when `frame.from` equals `m`. Anything else provably cannot count —
 * the owner is a constant, so the verdict is stable the moment the write
 * arrives — and renders as a declined, attributed row storing no slot. There
 * is no pending state: nothing is ever "not yet decidable".
 */
export const GroupRosterEnvelope = z.object({
  tcm: z.literal('grp.roster'),
  g: Ulid,
  m: Ulid,
  s: z.enum(['in', 'out']),
  n: z.number().int().min(1),
  /**
   * The member's class, per the OWNER's records (see
   * `ic` on grp.new; one field, same laws). Set by the owner's composer on an
   * add whose member their records name a machine; ignored by the fold unless
   * the write rides the authority lane, so nobody else's claim ever counts.
   * Strip-mode parsers on old builds drop it silently; a malformed value
   * collapses to absent rather than costing the write (§5.5).
   */
  c: RosterClass.optional().catch(undefined),
});

/**
 * Delete for everyone. Counted on one stable fact — `frame.from` is the room's
 * owner — enforced at apply time, never at the parser (§5.5).
 *
 * Deliberately NOT gated on the owner's own membership: a purge cannot be
 * re-evaluated when a late-arriving self-`out` would retroactively gate it, so
 * any such gate is order-dependent. The price, said in copy rather than
 * engineered around, is that an owner who left can still delete the room.
 */
export const GroupDelEnvelope = z.object({
  tcm: z.literal('grp.del'),
  g: Ulid,
  n: z.number().int().min(1),
});

/**
 * The room's disappearing-message setting. Per-writer, merged by MINIMUM over
 * the values that actually constrain — `0` is off and does not compete
 * (§10.3).
 */
export const GroupSettingsEnvelope = z.object({
  tcm: z.literal('grp.set'),
  g: Ulid,
  s: z.number().int().min(0).max(TIMER_MAX_SECONDS),
  n: z.number().int().min(1),
});

/**
 * The member-consent announcement: a member telling the room, group-visibly and roster-style,
 * their OWN consent state toward ONE agent — the load-bearing "Bob isn't
 * sharing with Claude" and its consented counterpart: a member the
 * agent cannot hear is a fact every author deserves to know before typing.
 *
 * THE SUBJECT IS NEVER ON THE WIRE. Like `grp.roster`'s sovereign self lane,
 * the member this row is about is the AUTHENTICATED sender (`frame.from`,
 * rule 16), derived at render time — there is no writer/who field to forge,
 * so a peer can only ever announce their OWN stance. That is what makes this
 * a member's statement about themselves rather than an accusation about
 * someone else.
 *
 * NO ENUMERATION is a SHAPE property of this schema, not a promise
 * elsewhere: it carries exactly ONE room (`g`), ONE agent (`a`), ONE state
 * (`s`). There is deliberately no array, no second agent, no other-room id,
 * no member list — so the sealed event reveals one member's stance in one
 * room toward one agent and nothing more, and the relay (which never parses
 * `grp.*`) sees only ciphertext. The consent EDGE it mirrors is written by a
 * separate authenticated POST /v1/consent; nothing here, and nothing on any
 * client, ever asks the server who consented to what.
 *
 * `a` names an agent that is already a room co-member (rosters are shared
 * client-side), so naming it discloses nothing the room did not already see
 * — it is the write's content, exactly as `grp.roster`'s `m` is.
 */
export const GroupConsentEnvelope = z.object({
  tcm: z.literal('grp.consent'),
  g: Ulid,
  /** The one agent this member is deciding about — a room co-member. Bare
   * ULID, never a URL or scheme (the standing QR guardrail). */
  a: Ulid,
  /** `share` = this member wrote the consent edge and the agent may hear them;
   * `hold` = they did not, and the agent's frames never reach them (refusal
   * gates DELIVERY, not display). Two states only — undecided is the
   * absence of any announcement, exactly as it is the absence of a row. */
  s: z.enum(['share', 'hold']),
  /** The membership counter, ordering this event among the room's rows on
   * the `n`/`sq` lane every other `grp.*` announcement rides. */
  n: z.number().int().min(1),
});

/**
 * The most entries one share may carry. A bound, not a target: the owner
 * picks a smaller extent in the UI, and this is the ceiling that keeps a
 * mis-typed number from turning into a several-thousand-leg send.
 */
export const MAX_HISTORY_SHARE = 200;

/**
 * History shared with a newcomer.
 *
 * ONE kind doing two jobs, told apart by whether `e` is present:
 *
 *  - `e` ABSENT  — the announcement, fanned to every current member, the
 *    newcomer included. This is rule 3 of the decision: the authors cannot
 *    consent, because their words were already sent, but they can be TOLD.
 *    A silent retroactive disclosure is the thing this design refuses
 *    everywhere else, so the announcement is not optional and not suppressible.
 *  - `e` PRESENT — one historical message, addressed to the newcomer alone.
 *    One envelope per message, never a batch: each entry was already a legal
 *    body, so nothing needs chunking or reassembly, and a failed entry is one
 *    visible failed leg in the ledger rather than a silently truncated
 *    transcript.
 *
 * WHAT `e.a` IS WORTH, said plainly because the code cannot enforce it:
 * the transcript rides the owner→newcomer ratchet, so the ratchet
 * authenticates THE RELAYER and says nothing whatever about who originally
 * wrote the words. There is no group key to sign against — that is the
 * fan-out design, not an oversight — so `e.a` is the relayer's CLAIM, and a
 * dishonest owner can fabricate an entire conversation. The receiver stores
 * it as such (`messages.sharedBy`), the reader is told, and no code path may
 * treat a relayed row as authenticated.
 */
export const GroupHistoryEnvelope = z.object({
  tcm: z.literal('grp.hist'),
  g: Ulid,
  /** Announcement lane, shared with the other membership writes. */
  n: z.number().int().min(1),
  /** WHO the share is for. Named in the announcement so the room learns who
   * received its history, not merely that someone did. */
  to: Ulid,
  /** How many entries the relayer intends to send. The announcement states
   * the extent, so a member reading the row knows the size of what moved. */
  c: z.number().int().min(1).max(MAX_HISTORY_SHARE),
  e: z
    .object({
      /** The ORIGINAL group message id, so a first-hand copy the newcomer
       * later receives collides with this row rather than duplicating it. */
      m: Ulid,
      /** The CLAIMED author. Unauthenticated by construction — see above. */
      a: Ulid,
      t: z.number().int().nonnegative(),
      /** The original expiry, carried so the timer survives the relay. The
       * receiver re-checks it against ITS OWN clock: the relayer's clock is
       * not the receiver's, and a share must never resurrect a message the
       * timer already took. */
      x: z.number().int().nonnegative().optional(),
      b: z
        .string()
        .min(1)
        .max(MAX_GROUP_BODY)
        /**
         * NO NESTING, for the reason `grp.msg` refuses it (§5.2) and one
         * sharper: a relayed body is ALREADY an unauthenticated claim, so a
         * `grp.*` smuggled inside one would let a relayer launder a
         * membership or delete write through a second wrapper while wearing
         * a third party's name. Refused at the schema, so it cannot be
         * composed either.
         */
        .refine(value => !value.startsWith(`${ENVELOPE_SENTINEL}"grp.`), {
          message: 'a shared history entry may not wrap another room envelope',
        }),
    })
    .optional(),
});

export type GroupMessageEnvelope = z.infer<typeof GroupMessageEnvelope>;
export type GroupNewEnvelope = z.infer<typeof GroupNewEnvelope>;
export type GroupRosterEnvelope = z.infer<typeof GroupRosterEnvelope>;
export type GroupDelEnvelope = z.infer<typeof GroupDelEnvelope>;
export type GroupSettingsEnvelope = z.infer<typeof GroupSettingsEnvelope>;
export type GroupHistoryEnvelope = z.infer<typeof GroupHistoryEnvelope>;
export type GroupConsentEnvelope = z.infer<typeof GroupConsentEnvelope>;

/**
 * The kinds, in one place so a switch that forgets one can be caught by a
 * test rather than by a peer. `grp.consent`
 * is the seventh — a roster-style announcement, not a message, sharing the
 * membership lane the other announcements ride.
 */
export const GROUP_TCMS = [
  'grp.msg',
  'grp.new',
  'grp.roster',
  'grp.del',
  'grp.set',
  'grp.hist',
  'grp.consent',
] as const;

export type GroupTcm = (typeof GROUP_TCMS)[number];

export function isGroupTcm(value: string): value is GroupTcm {
  return (GROUP_TCMS as readonly string[]).includes(value);
}

/**
 * Compose the roster digest for a fold, given an INJECTED asynchronous hash.
 *
 * `packages/shared` has no SHA-256 and must not grow one: hashing belongs
 * to the platform. The one shipped binding today is
 * `CryptoKit.SHA256` through the app's `tacendum-crypto` TurboModule — the
 * CLI does not compute roster digests yet, and when it does, Node's
 * `crypto.createHash('sha256')` is the intended binding (an earlier version
 * of this comment stated that CLI binding as existing code, which it is not).
 * The TurboModule's digest is asynchronous, and both callers (compose, and
 * the receive comparison) are already in async context, which is why the pure
 * fold exposes `rosterDigestPreimage` separately: the hashing happens outside
 * it, so the fold stays synchronous and pure.
 *
 * `group-fold.ts` also exports a synchronous `rosterDigest` for callers that
 * already hold a sync hash — the tests, and any future binding that offers
 * one. The preimage construction is shared by both, which is the part that
 * must never be written twice.
 */
export async function composeRosterDigest(
  ownerId: string,
  members: readonly string[],
  sha256: (preimage: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const digest = await sha256(rosterDigestPreimage(ownerId, members));
  if (digest.length < 8) {
    // Loud here rather than as a permanent banner between two honest clients.
    throw new Error(`injected sha256 returned ${digest.length} bytes; need at least 8`);
  }
  return assertComposableRd(base64Unpadded(digest.subarray(0, 8)));
}

