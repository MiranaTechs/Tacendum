import {
  AgentTextEnvelope,
  ApprovalAnswerEnvelope,
  ApprovalRequestEnvelope,
  CallAnswerEnvelope,
  CallEndEnvelope,
  CallIceEnvelope,
  CallMediaEnvelope,
  CallOfferEnvelope,
  CallRestartEnvelope,
  CallRingingEnvelope,
  DeviceClassSchema,
  StreamEditEnvelope,
  Ulid,
  aiOrigin,
  claimsAiOrigin,
} from '@tacendum/shared';
// Room envelopes, canonical in @tacendum/shared for the
// same reason the call ones are: the app, the CLI and the tests share ONE
// schema. Imported by subpath so the package's main entry — which the server
// imports — stays byte-identical.
import {
  GROUP_MAX_MEMBERS,
  GroupConsentEnvelope,
  GroupDelEnvelope,
  GroupHistoryEnvelope,
  GroupMessageEnvelope,
  GroupNewEnvelope,
  GroupRosterEnvelope,
  GroupSettingsEnvelope,
} from '@tacendum/shared/group-envelope';
import { z } from 'zod';

/** How a structured body announces itself. Anything not starting with this
 * is ordinary text, by design (CLI compatibility). */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * What a message reads as when it arrived in a shape this build cannot parse.
 * Shown instead of raw JSON — a bubble full of `{"tcm":...}` is worse than
 * useless, and silently dropping the row would hide that anything was sent.
 */
export const UNSUPPORTED_TEXT = 'Unsupported message — update Tacendum';

/**
 * The `tcm` a body CLAIMS, read without requiring the whole body to parse —
 * a truncated or future-shaped frame still says what it was trying to be.
 * This is what makes forward compatibility possible: we can route on the
 * namespace before we can read the contents.
 */
/**
 * Digits, `-` and `_` are in the class because of what this regex GATES: a
 * kind it fails to recognise never reaches the namespace routing below, so a
 * `call.` or `x.` body wearing such a name would be rendered rather than
 * silenced. The reserved `x.` namespace exists precisely so a future kind is
 * INVISIBLE to builds that predate it, and restricting those names to
 * lowercase-and-dots is a trap that springs later and cannot be undone — the
 * first extension named `x.ack2` would be noisy on every already-shipped
 * build, and shipped builds are the ones that matter.
 *
 * Found by the CLI's three-client e2e gate on a real wire (an `x.e2e-probe`
 * carrier printed the unsupported line); the CLI carries the identical
 * pattern, and the two copies are duplicated rather than shared, which is
 * recorded as a smell rather than fixed here.
 */
const DECLARED_TCM = /^\{"tcm":"([a-z][a-z0-9._-]{0,31})"/;
function declaredTcm(body: string): string | null {
  return DECLARED_TCM.exec(body)?.[1] ?? null;
}

/**
 * The transport namespace. Everything under `call.` is signalling, never
 * conversation — and it is treated as transport WHETHER OR NOT this build can
 * parse it, so a peer on a newer version placing a call does not fill an older
 * peer's thread with unreadable rows. (An earlier draft specified an
 * "unsupported" row for these; a silent carrier is strictly better for the
 * `call.` namespace and identical for everything else.)
 */
const CALL_NAMESPACE = 'call.';

/**
 * A SECOND transport namespace, reserved now because reserving it later is a
 * shipped-app problem.
 *
 * The forward-compatibility path above — "Unsupported message, update
 * Tacendum" — is right for *conversational* kinds: a person should be told
 * their build is too old. It is wrong for **machine carrier** kinds, which
 * have no business appearing in a thread at all. An unknown one renders a
 * visible row on both clients, so any future non-conversational kind would
 * litter every older build's transcript at exactly the rate it is emitted.
 *
 * Nothing emits `x.*` today. The reservation exists so that whatever does —
 * application-level acknowledgements, structured handoffs — is invisible to
 * builds that predate it rather than noisy in them. Routed on the prefix
 * BEFORE parsing, exactly as `call.` is, which is what makes it work for a
 * shape this build has never seen.
 */
const RESERVED_CARRIER_NAMESPACE = 'x.';

/**
 * Ids per read receipt.
 *
 * A cap because this array arrives from the network and is used to look rows
 * up: without one, a peer could hand over an unbounded list and make the
 * receiving device do unbounded work for a carrier that changes nothing
 * visible. Opening a thread after a long absence marks far fewer than this,
 * and a batch that would exceed it is split rather than truncated.
 */
export const MAX_READ_IDS = 200;

/**
 * Structured message envelopes carried INSIDE the Signal-encrypted payload.
 * Plain text messages stay raw strings on the wire (CLI compatibility); a
 * structured message is a JSON object marked by the `tcm` sentinel key. The
 * server never sees any of this — it routes opaque ciphertext either way.
 */

/**
 * Text a peer supplies that this app will later store AS a message body and
 * re-parse. It must not itself be an envelope: a body beginning with the
 * sentinel is read as structure everywhere (thread filter, chat preview,
 * boot-time reconcile), so an accepted one would let a peer turn a message
 * into a carrier — vanishing from the thread with no tombstone and no Edited
 * marker — or into a forged photo or screenshot notice.
 *
 * Only the leading sentinel is refused, so ordinary prose that merely quotes
 * the format mid-sentence still sends.
 */
const bodyText = z
  .string()
  .min(1)
  .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
    message: 'text may not itself be an envelope',
  });

/** E2EE image pointer: blob id + AES-GCM key travel only inside the ratchet. */
export const ImageEnvelope = z.object({
  tcm: z.literal('image'),
  /** Server-minted attachment id (the blob-store read capability). */
  att: z.string().min(1),
  /** base64 32-byte AES-256-GCM key for the blob. */
  key: z.string().min(1),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type ImageEnvelope = z.infer<typeof ImageEnvelope>;

/**
 * Longest voice note the composer will record. Five minutes: past that a
 * voice note is a podcast, and the recipient deserves a warning the UI
 * cannot honestly give. Also bounds `dur` as a peer-supplied display input.
 */
export const VOICE_MAX_SECONDS = 300;

/**
 * E2EE voice-note pointer: blob id + AES-GCM key travel only inside the
 * ratchet, exactly like ImageEnvelope. The blob is AAC-LC in an MPEG-4
 * container — a client convention, not a wire field, because the GCM tag
 * authenticates the bytes and the decoder rejects what it cannot read.
 */
export const VoiceEnvelope = z.object({
  tcm: z.literal('voice'),
  /** Server-minted attachment id (the blob-store read capability). */
  att: z.string().min(1).max(200),
  /** base64 32-byte AES-256-GCM key for the blob. */
  key: z.string().min(1).max(100),
  /**
   * Duration in whole seconds, SENDER-CLAIMED and display-only: the bubble
   * shows it before the blob arrives and corrects to the decoded duration
   * after. Bounded because it is peer-supplied and it sizes a UI element —
   * and never trusted for playback limits, which use the decoded duration
   * (the defect: a peer can claim `dur: 1` and supply five
   * minutes of audio).
   */
  dur: z.number().int().min(1).max(VOICE_MAX_SECONDS),
});
export type VoiceEnvelope = z.infer<typeof VoiceEnvelope>;

/**
 * E2EE file pointer — the same blob discipline as a photo, plus the three
 * facts a list row needs without fetching. All three are SENDER-CONTROLLED
 * and bounded accordingly: `name` is display text (sanitised again at the
 * native seam before any disk write), `size` is a claim checked against the
 * decrypted bytes before preview, `mime` is a hint and never an executor.
 */
export const FileEnvelope = z.object({
  tcm: z.literal('file'),
  /** Server-minted attachment id (the blob-store read capability). Bounded
   * like every peer-controlled string: the id is 32 random bytes as
   * base64url (43 chars), so 200 is generous and still finite. */
  att: z.string().min(1).max(200),
  /** base64 32-byte AES-256-GCM key for the blob (44 chars with padding). */
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  mime: z.string().min(1).max(120),
});
export type FileEnvelope = z.infer<typeof FileEnvelope>;

/**
 * A place, once. Coordinates only — no map tile is ever fetched to render
 * this (a tile request tells a map server where your contact is), so the
 * bubble is a card and the map is Apple Maps, opened deliberately by a tap.
 */
export const LocationEnvelope = z.object({
  tcm: z.literal('loc'),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});
export type LocationEnvelope = z.infer<typeof LocationEnvelope>;

/** Tapback-style reaction to an earlier message (one per side per message). */
export const ReactionEnvelope = z.object({
  tcm: z.literal('react'),
  /** msgId of the message being reacted to. */
  ref: z.string().min(1),
  /** True when the target message was sent by the REACTOR themself. msgIds are
   * sender-chosen, so (msgId) alone is spoofable across directions — this bit
   * pins which side's message is meant (mirrors the messages (msgId,
   * direction) composite key). */
  ofs: z.boolean(),
  /** The emoji itself, or '' to retract the reaction. */
  emoji: z.string().max(16),
});
export type ReactionEnvelope = z.infer<typeof ReactionEnvelope>;

/**
 * Profile card: how a person chooses to appear to ONE peer. There is no
 * directory and no server-side profile — each side ships its own card through
 * the ratchet, so the server never learns a name, a face, or who knows whom.
 * The avatar rides the same encrypted blob path as photos (att + key).
 */
export const ProfileEnvelope = z.object({
  tcm: z.literal('profile'),
  /** Display name, '' to fall back to the userId. */
  n: z.string().max(40),
  /** About line, '' when unset. */
  a: z.string().max(140),
  /** Avatar blob id + key; both absent when the person has no photo. */
  att: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  /** Monotonic version (sender's clock ms) — a late card can't undo a newer one. */
  v: z.number().int().nonnegative(),
});
export type ProfileEnvelope = z.infer<typeof ProfileEnvelope>;

/**
 * Disappearing-message timer for this conversation. Either side may set it,
 * and the newest setting wins on both devices — a timer only one person
 * believed in would be worse than none.
 *
 * `s` is seconds, 0 meaning off. It is a shared setting rather than a
 * per-message flag because the guarantee is about the conversation: a person
 * deciding whether to say something needs to know what happens to it before
 * they type, not after.
 *
 * HONEST LIMIT: this is cooperative deletion between honest clients. It
 * removes messages from two devices; it cannot stop the other person
 * photographing the screen (which the app already discloses) or running a
 * modified build. Copy must never imply otherwise.
 */
export const TimerEnvelope = z.object({
  tcm: z.literal('timer'),
  /** Seconds, 0 = off. Capped at four weeks — beyond that "disappearing"
   * stops meaning anything a person can hold in their head. */
  s: z.number().int().nonnegative().max(28 * 24 * 60 * 60),
  /** Monotonic version (sender's clock ms); a late frame can't undo a newer
   * setting. Same rule as the profile card. */
  v: z.number().int().nonnegative(),
});
export type TimerEnvelope = z.infer<typeof TimerEnvelope>;

/**
 * Screenshot notice: the sender captured this conversation's screen. Carries
 * no fields — who took it is the ratchet sender, when is the frame timestamp.
 * Always sent, never configurable: disclosure that can be switched off is not
 * disclosure.
 */
export const ScreenshotEnvelope = z.object({
  tcm: z.literal('shot'),
});
export type ScreenshotEnvelope = z.infer<typeof ScreenshotEnvelope>;

/**
 * Shared Room Vault. The things two people keep re-asking each
 * other for — the door code, the Wi-Fi password, a case reference — carried
 * inside the ratchet like every other envelope. The server gains no route, no
 * table and no column: a vault item is an ordinary encrypted message that both
 * clients happen to index locally.
 *
 * TWO WRITERS, which is what makes this unlike the profile card. A card has one author, so plain newest-version-wins
 * converges. A vault item has two authors, and the first shipped answer — a
 * sender wall clock `v` bumped `max(now, current + 1)`, broken by a stored
 * writer id — was wrong in three separate ways, all of them silent:
 *
 *  1. a wall clock in the ordering makes a peer's clock a CORRECTNESS input,
 *     so it needs a future clamp, and a clamp is a drop, and on a one-way
 *     ratchet a drop is permanent. An honest restore-from-backup with a wrong
 *     date silenced an item forever, and stickily: `max(now, current + 1)`
 *     inherited the poisoned number into every later edit;
 *  2. `max(now, current + 1)` SATURATES on `current + 1` in the steady state,
 *     so the "ties are rare" premise was false, and (v, deleted, writerId) did
 *     not functionally determine (title, body) — two overlapping local saves
 *     emitted two different bodies under one identical key;
 *  3. the writer-id tiebreak is identity-biased: whichever account id sorts
 *     higher wins EVERY tie, forever, and the loser is never told.
 *
 * So the clock is gone from the ordering claim and each writer gets their OWN
 * counter (a two-entry version vector, which is exact at N=2 and costs two
 * small integers):
 *
 *  - `n` is the sender's own per-item counter. Only its own writer ever
 *    advances it and it is allocated by one atomic SQL statement, so within a
 *    writer's slot a tie is not rare — it is IMPOSSIBLE. That is what makes
 *    the merge a lattice join with no tiebreak at all;
 *  - `k` is the highest `n` the sender had already applied FROM THE RECIPIENT
 *    for this item. This is the field a clock cannot express: it says "I had
 *    seen your edit", which is causality rather than recency, and it is what
 *    lets both phones tell a supersession from a genuine concurrent edit.
 *
 * `writerId` is deliberately NOT on the wire: inbound it is `frame.from`,
 * outbound it is my own account id, so slot ownership is authenticated by the
 * ratchet and a peer cannot write into my slot with any payload they can
 * construct.
 *
 * `title` and `body` are absent on a `del`: there is nothing left to name, and
 * a tombstone that still carried the secret would be the opposite of a
 * deletion. A `set` without a title is refused where it is APPLIED, not here.
 * That asymmetry is deliberate and is the rule DIVERGENCE 1 was really about:
 * THE RECEIVER MUST BE STRICTLY MORE PERMISSIVE THAN THE SENDER. A frame this
 * build can compose must always be one this build can parse (encodeEnvelope
 * now enforces exactly that), while a frame a peer can send but this build has
 * no use for is dropped quietly rather than refused at the parser — a parser
 * refusal costs the whole message, and on a one-way ratchet that loss is
 * permanent.
 */

/** Longest title the composer may accept. Enforced on the SENDER (messaging's
 * saveVaultItem refuses above it, before anything is allocated or encrypted)
 * as well as here, because a cap only the receiver knows about is not a cap —
 * it is a way to send something the other phone will throw away. */
export const VAULT_TITLE_MAX = 80;
/** Longest value the composer may accept. Raised from 2048, which did not fit
 * the actual use case: a block of backup codes, a WireGuard config or an SSH
 * private key runs 1.7–3.4 KB and would have been composed happily and then
 * discarded by the receiver's parser. 8192 plus the title, the id and the
 * framing is ~8.5 KB of plaintext, whose ciphertext base64 is comfortably
 * inside MAX_PAYLOAD_B64_LENGTH (30,000). */
export const VAULT_BODY_MAX = 8192;
/**
 * How high a peer's `k` may be believed WHEN THIS PHONE HOLDS NO SLOT OF ITS
 * OWN to check it against — the one case where the exact clamp is unavailable
 * because the evidence was deleted. Believing it there is what repairs the counter regression that purge
 * causes (see db.reserveVaultSeq's `floor`); believing it WITHOUT A BOUND would
 * hand a hostile peer a new weapon, because `k` may legally be
 * MAX_SAFE_INTEGER and a floor that high makes my very next number unsendable —
 * the schema refuses `n` above MAX_SAFE_INTEGER — freezing that item against
 * its own owner. Loud rather than silent, but still a peer-triggered denial.
 *
 * A million writes to ONE item by ONE person is already far past anything a
 * human does, so honest play never meets this bound, and a liar who reaches for
 * it only moves my counter to a million and one, leaving ~9e15 numbers behind
 * it. It bounds a lie; it does not decide anything.
 *
 * Not a schema `.max()` on purpose: refusing the frame at the parser costs the
 * whole message, and this transport gives no second copy. The receiver stays
 * strictly more permissive than the sender.
 */
export const VAULT_ACK_TRUST_MAX = 1_000_000;
export const VaultEnvelope = z.object({
  tcm: z.literal('vault'),
  op: z.enum(['set', 'del']),
  /** ULID, minted by whichever side first created the item. Shape-checked
   * rather than `.min(1)`: this is half a primary key and it reaches a testID
   * and a render branch, so an unbounded peer-chosen string has no business
   * here. Crockford base32, which is what `nextMsgId` emits. */
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  /** What the item is called. Bounded like the profile card's fields rather
   * than left open: this is the one part of a vault item that gets DRAWN (the
   * announcement row shows the title and never the body), and an unbounded
   * peer-supplied string on screen is a layout weapon.
   *
   * Refuses a leading envelope sentinel for the same reason `bodyText` does:
   * a string beginning with it reads as structure everywhere in this app, and
   * a peer must not be able to put a forged-looking envelope on screen. */
  title: z
    .string()
    .min(1)
    .max(VAULT_TITLE_MAX)
    .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
      message: 'title may not itself be an envelope',
    })
    .optional(),
  /** The secret itself. Bounded because it rides one ratchet frame (the
   * server caps a payload at MAX_PAYLOAD_B64_LENGTH and an oversized send is
   * refused AFTER the ratchet has advanced), and because a row in a table full
   * of credentials should have a size a person can reason about. */
  body: z
    .string()
    .min(1)
    .max(VAULT_BODY_MAX)
    .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
      message: 'value may not itself be an envelope',
    })
    .optional(),
  /** THE SENDER'S OWN COUNTER FOR THIS ITEM, not a clock. Strictly increasing
   * per (peer, item, writer); gaps are legal and unobservable, which is what
   * lets a lost frame be repaired by the next write instead of stalling the
   * item forever. Only its own writer advances it, so a hostile `n` of 2^53
   * saturates the forger's OWN slot and can never reach the other one — the
   * "one crafted frame freezes this credential for both sides" failure that
   * motivated the old 24h clamp is structurally impossible here. */
  n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** The highest `n` this writer had APPLIED from the RECIPIENT for this item
   * when they composed; 0 = none. Never decides which slot to keep — it
   * decides only whether the two slots are causally ordered (one value) or
   * concurrent (a real disagreement). Clamped where it is applied to the
   * recipient's own counter, so a peer cannot claim to have seen a write that
   * never existed. */
  k: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type VaultEnvelope = z.infer<typeof VaultEnvelope>;

/**
 * Replacement text for a message the SENDER already sent. There is no `ofs`
 * authorship bit on purpose: you may only ever edit your own words, so the
 * receiver applies this to their 'in' row unconditionally and a crafted bit
 * has nothing to address. The original text is replaced outright — this
 * protocol keeps no revision history, and the UI marks the row edited so the
 * replacement is never silent.
 */
export const EditEnvelope = z.object({
  tcm: z.literal('edit'),
  /** msgId of the sender's own message being rewritten. */
  ref: z.string().min(1),
  /** The new text. Empty is refused: erasing a message is `del`, not an edit;
   * an envelope is refused because this string becomes a message body. */
  text: bodyText,
  /** The Art. 50 AI-origin marker (@tacendum/shared
   * ai-origin.ts holds the honesty limits). The CLI marks every edit final
   * it composes; a human's edit never carries it, and a malformed value
   * collapses to unmarked rather than costing the revision. */
  ai: aiOrigin,
});
export type EditEnvelope = z.infer<typeof EditEnvelope>;

/**
 * Retract a message on BOTH sides. Same authorship rule as `edit` — your own
 * message only, so no `ofs` bit. The row is tombstoned rather than removed:
 * a message that silently disappears is indistinguishable from one that never
 * arrived, and the person it was sent to is entitled to know it existed.
 */
export const DeleteEnvelope = z.object({
  tcm: z.literal('del'),
  ref: z.string().min(1),
});
export type DeleteEnvelope = z.infer<typeof DeleteEnvelope>;

/**
 * "I have read these." A carrier: it rewrites a status on the sender's rows
 * and is never a message itself.
 *
 * Peer-to-peer through the ratchet, not a server frame. `sent` and
 * `delivered` are the server's to observe — it routed the bytes — but whether
 * someone has LOOKED at a message is a fact about a person, and the server has
 * no business learning it. The cost is that a read receipt is an ordinary
 * encrypted message and behaves like one: it queues, it retries, and it is
 * refused to a blocked peer like every other outbound kind.
 *
 * `ids` is a batch because a thread is opened once and marks many messages at
 * a time; one envelope per message would be a burst of ciphertext that says
 * "they are reading" far more loudly than the receipt itself does.
 *
 * Only the RECIPIENT of a message may say it was read, so there is no `ofs`
 * bit here: the ids are necessarily the other side's, and an id that does not
 * match an outbound row is ignored rather than trusted.
 */
export const ReadEnvelope = z.object({
  tcm: z.literal('read'),
  /** msgIds of THEIR messages this device has displayed. */
  ids: z.array(z.string().min(1)).min(1).max(MAX_READ_IDS),
});
export type ReadEnvelope = z.infer<typeof ReadEnvelope>;

/**
 * Typing state — the first occupant of the reserved `x.` carrier namespace
 * (see RESERVED_CARRIER_NAMESPACE above: invisible to builds that predate
 * it, by prefix, before parsing). Carried ONLY inside relay-only `typing`
 * wire frames — never a message row, never a preview, never persisted on
 * either end. `room` scopes the signal to a room WITHOUT the server ever
 * learning room structure: the field rides inside the ciphertext.
 */
export const TypingEnvelope = z.object({
  tcm: z.literal('x.typing'),
  state: z.enum(['start', 'stop']),
  /** The room this typing applies to; absent for a 1:1. */
  room: z.string().min(1).optional(),
  /** The Art. 50 AI-origin marker: the agent lane marks its chatter
   * too. No consumer yet — retained so a future "AI is typing…" surface
   * reads a field that already flows rather than waiting a build. */
  ai: aiOrigin,
});
export type TypingEnvelope = z.infer<typeof TypingEnvelope>;

/**
 * A message that answers an earlier one. Unlike edit/del this is real
 * conversation — a row of its own — so it carries the same `ofs` anti-spoof
 * bit reactions use: msgIds are sender-chosen, so (msgId) alone cannot say
 * which side's message is meant.
 */
export const ReplyEnvelope = z.object({
  tcm: z.literal('reply'),
  /** msgId of the message being answered. */
  ref: z.string().min(1),
  /** True when the quoted message was sent by the REPLIER themself. */
  ofs: z.boolean(),
  text: bodyText,
});
export type ReplyEnvelope = z.infer<typeof ReplyEnvelope>;

/**
 * @-MENTIONS (the mentions contract). Names in this app are LOCAL —
 * `personName(id, displayName, localName)` ranks my name for someone above
 * the name they chose for themselves — so a mention must NEVER travel as
 * text. Sending the literal characters `@Ana` would do two wrong things at
 * once: render MY private name for that person on eleven other phones (a
 * privacy leak with no upside), and render the WRONG name on every phone
 * that knows them differently (a bug that looks like a typo). The wire
 * carries ids; every phone renders its OWN name, through an INJECTED
 * resolver (`renderMentionText` below) — injected, never imported, because
 * this module is pure and must not learn about the database (the
 * `composeRosterDigest` precedent: the hash is a parameter too).
 */

/**
 * U+FFFC OBJECT REPLACEMENT CHARACTER ('￼') — one per mention, standing in
 * the text exactly where a name will be drawn. The character IS the wire
 * format: the composer writes it, every renderer counts it.
 */
export const MENTION_MARK = '￼';

/**
 * ORDINAL, NOT OFFSETS, and this is deliberate. Signal carries (start,
 * length) ranges; those desynchronise from the string the moment anything
 * touches it — an edit, a trim, a different normalisation — and a desynced
 * range silently mentions the wrong person or slices a word in half. The
 * Nth mark is the Nth id: there is no arithmetic to get wrong, and the
 * failure mode when counts disagree is visible rather than subtly wrong.
 *
 * COMPOSE-STRICT, PARSE-PERMISSIVE (the house rule, and the single
 * most important fact about this kind — the asymmetry is easy to get
 * backwards). `encodeEnvelope` refuses a mark/id count mismatch: the
 * composer is trusted local code with a surface to report to. This schema
 * deliberately does NOT — on a one-way ratchet a refused parse means the
 * message is gone forever, and a mention is never worth losing the words
 * around it. The renderer survives every mismatch — more marks than ids,
 * more ids than marks, an id naming no one this phone knows — rendering
 * what it can and dropping what it cannot: never a throw, never raw JSON,
 * never a ULID.
 */
export const MentionEnvelope = z.object({
  tcm: z.literal('mention'),
  /** The words, with one MENTION_MARK standing where each name goes. */
  text: bodyText,
  /** Room member ids, in the SAME ORDER as the marks. Ids and nothing but
   * ids — a name field here would be the exact leak this kind exists to
   * prevent, and a test pins the key set shut. */
  who: z.array(Ulid).min(1).max(GROUP_MAX_MEMBERS),
});
export type MentionEnvelope = z.infer<typeof MentionEnvelope>;

/** How many names a mention's text claims. U+FFFC is a single UTF-16 code
 * unit, so splitting on it can never slice a surrogate pair. */
function mentionMarkCount(text: string): number {
  return text.split(MENTION_MARK).length - 1;
}

/**
 * DEVICE FAN-OUT WRAPPER — grp.msg's
 * one-to-one sibling for a GROUPED peer: every device leg of one send wraps
 * the same body under ONE shared message id `m`, minted once by the author
 * (the group-envelope shared-id dedupe shape). The shared id is what lets
 * read-state sync across the RECIPIENT's devices name a message every
 * device holds — wire msgIds are per-leg and de-duplicate only. Composed
 * ONLY toward peers known to be grouped (a grouped peer's devices are all
 * accounts-capable clients by construction — an old client cannot link),
 * so the pre-accounts wire stays byte-identical for everyone else (the design's
 * old-client skew, accepted and bounded).
 */
export const DeviceMessageEnvelope = z.object({
  tcm: z.literal('dev.msg'),
  /** The shared message id, minted once for all device legs. */
  m: Ulid,
  b: z
    .string()
    .min(1)
    /**
     * NO NESTING, the rule inherited whole: a dev.msg may wrap neither
     * a room wrapper nor another device wrapper — the unwrap is one switch,
     * not a recursion.
     */
    .refine(
      value =>
        !value.startsWith(`${ENVELOPE_SENTINEL}"grp.`) &&
        !value.startsWith(`${ENVELOPE_SENTINEL}"dev.`),
      { message: 'a device leg may not wrap another wrapper envelope' },
    ),
  /** The Art. 50 AI-origin marker, on the wrapper exactly as grp.msg
   * carries it (ai-origin.ts holds the honesty limits). */
  ai: aiOrigin,
});
export type DeviceMessageEnvelope = z.infer<typeof DeviceMessageEnvelope>;

/**
 * SIBLING SYNC — the typed sync envelopes
 * riding the pairwise sessions between OWN linked devices: sent
 * transcripts, read state, per-contact local names, peer rosters/certs,
 * and (for agent owners) the machine-peers roster. In the reserved `x.`
 * carrier namespace ON PURPOSE: every shipped build already silences `x.*`
 * by prefix, so a sync envelope reaching any older build renders nothing
 * instead of "Unsupported message". The payload `d` is deliberately opaque
 * at this level — sync.ts owns the per-kind schemas and stays
 * parse-permissive (a malformed payload costs the sync, never a row).
 */
export const AccountSyncEnvelope = z.object({
  tcm: z.literal('x.acct.sync'),
  k: z.enum(['transcript', 'read', 'name', 'roster', 'machines']),
  d: z.unknown(),
});
export type AccountSyncEnvelope = z.infer<typeof AccountSyncEnvelope>;

/**
 * THE SIGNED PEER-FACING ROSTER NOTICE — what "a signed unlink statement from a remaining device fans
 * out to peers in-band" is on the wire: the full mutation tuple plus the
 * acting member's op-framed identity signature, carried INSIDE the
 * ratchet. Peers verify it against the acting member's key they already
 * pinned (peerDevices.applyPeerMutationNotice) and drop the named device —
 * or, for `dissolve`, the whole sibling association (the peer-visible
 * half). `x.` namespace for the same silence-on-old-builds property as the
 * sync kind above.
 */
export const AccountRosterNoticeEnvelope = z.object({
  tcm: z.literal('x.acct.notice'),
  op: z.enum(['unlink', 'revoke', 'dissolve']),
  groupId: Ulid,
  offererUserId: Ulid,
  acceptorUserId: Ulid,
  subjectIdentityPubKey: z.string().min(1).max(128),
  // The shared schema, never the words spelled here (the slot-word invariant: slot
  // words have exactly one home).
  class: DeviceClassSchema,
  rosterEpoch: z.number().int().nonnegative(),
  offerNonce: z.string().min(1).max(128),
  expiresAt: z.number().int().nonnegative(),
  sig: z.string().min(1).max(256),
});
export type AccountRosterNoticeEnvelope = z.infer<typeof AccountRosterNoticeEnvelope>;

const Envelope = z.discriminatedUnion('tcm', [
  // Marked bare text, canonical in
  // @tacendum/shared. CONVERSATION, not a carrier: an agent's ordinary
  // reply wearing the Art. 50 wrapper — it renders as its words, previews
  // as its words, and bumps the thread exactly as bare text does. The CLI
  // is its only composer (attestation-gated there, because a build that
  // predates this union entry renders the unsupported line).
  AgentTextEnvelope,
  ImageEnvelope,
  VoiceEnvelope,
  FileEnvelope,
  LocationEnvelope,
  ReactionEnvelope,
  ProfileEnvelope,
  TimerEnvelope,
  ScreenshotEnvelope,
  // NOT a carrier (see isCarrierEnvelope): a vault change is announced on both
  // phones, so it keeps a row exactly as a timer change does.
  VaultEnvelope,
  EditEnvelope,
  DeleteEnvelope,
  ReadEnvelope,
  // A carrier by NAMESPACE (isCarrierEnvelope routes `x.` before parsing);
  // in the union so it is encodable and parseable, never renderable.
  TypingEnvelope,
  ReplyEnvelope,
  // NOT a carrier (see isCarrierEnvelope): a mention is words aimed AT
  // someone — conversation by definition, and the point of the feature is
  // that a row appears and gets noticed (the mentions contract).
  MentionEnvelope,
  // Call signalling. Defined canonically in
  // @tacendum/shared so the app, the CLI, and the tests share one schema.
  CallOfferEnvelope,
  CallAnswerEnvelope,
  CallIceEnvelope,
  CallEndEnvelope,
  CallRingingEnvelope,
  CallMediaEnvelope,
  CallRestartEnvelope,
  // Rooms. Six kinds. `grp.msg` wraps a body that is
  // EXACTLY what `messages.body` would hold in a 1:1, which is what lets
  // image, file, location, reply, edit, delete and reaction work in a room
  // with no duplicated handling — the receiver unwraps and runs this same
  // union again.
  GroupMessageEnvelope,
  GroupNewEnvelope,
  GroupRosterEnvelope,
  GroupDelEnvelope,
  GroupSettingsEnvelope,
  GroupHistoryEnvelope,
  // The member-consent announcement. A roster-style
  // event, NOT a carrier (isCarrierEnvelope leaves it visible like grp.roster)
  // and NOT a message — it renders as a system line telling the room one
  // member's sharing stance toward one agent. Sealed inside the room
  // ciphertext, the relay blind to it.
  GroupConsentEnvelope,
  // The approval pair, canonical in @tacendum/shared.
  // Carriers by NAMESPACE, like x.typing: isCarrierEnvelope routes the `x.`
  // prefix before parsing, so previewFor/displayText already yield '' with
  // NO branch here — never renderable, in the union so encodeEnvelope's
  // cannot-parse⇒cannot-encode invariant covers what this build composes.
  ApprovalRequestEnvelope,
  ApprovalAnswerEnvelope,
  // The stream-edit intermediate, canonical in
  // @tacendum/shared on the approval pair's exact terms: a carrier by
  // NAMESPACE (isCarrierEnvelope routes `x.` before parsing, so
  // previewFor/displayText already yield '' with NO branch here — never
  // renderable), in the union so the typing lane's x.edit arm can read it
  // through THIS parse and so encodeEnvelope's cannot-parse⇒cannot-encode
  // invariant covers it. Durable copies never apply: the 1:1 stored case
  // takes the x.* namespace floor, the room-wrapped case takes
  // applyContent's ignore-ack arm.
  StreamEditEnvelope,
  // Device fan-out: the grp.msg-shaped wrapper a
  // grouped peer's legs wear, and the two `x.`-namespace account carriers
  // (sibling sync; the signed peer-facing roster notice) — carriers by
  // NAMESPACE, in the union so this build can compose and parse them.
  DeviceMessageEnvelope,
  AccountSyncEnvelope,
  AccountRosterNoticeEnvelope,
]);
export type Envelope = z.infer<typeof Envelope>;

/**
 * A frame this build refused to compose. Thrown, not returned: every caller of
 * `encodeEnvelope` is trusted local code with a compose surface to report to,
 * and the alternative — returning something unparseable — is the defect this
 * class exists to make impossible.
 *
 * Matched by `name` rather than `instanceof`, for the same reason
 * BlockedPeerError documents: a jest module mock that omits the class would
 * turn the check itself into a TypeError thrown from inside a catch block.
 */
export class EnvelopeRefusedError extends Error {
  /** Which envelope kind was refused, when it could be read at all. */
  readonly tcm: string;
  /** Field paths that failed, e.g. `['body']`. Never the VALUES — an error
   * string is logged, rendered and sometimes copied, and this function is
   * handed door codes. */
  readonly fields: string[];
  constructor(tcm: string, fields: string[]) {
    super(
      `this version cannot send that ${tcm || 'message'}${
        fields.length ? ` (${fields.join(', ')})` : ''
      }`,
    );
    this.name = 'EnvelopeRefusedError';
    this.tcm = tcm;
    this.fields = fields;
  }
}

/**
 * THE SEND-SIDE SEAM. Validates against the SAME schema `parseEnvelope` reads,
 * then stringifies.
 *
 * This was a bare `JSON.stringify` with a typed parameter, which made every
 * constraint in every schema in this file RECEIVER-ONLY — the types say the
 * shape is right, and TypeScript cannot check `.max(2048)`. The failure that
 * exposed it: a 2100-character value (a pasted SSH key, a block of backup
 * codes) encoded fine, encrypted fine, and sent fine; the recipient's
 * `parseEnvelope` then returned null, the vault branch was skipped, and the
 * frame fell through to the generic path as "Unsupported message". The ack had
 * already purged the server's copy and the ratchet key was consumed, so
 * redelivery could not help and the item was gone permanently on both phones.
 * The tell was that the SENDER's own row read "Unsupported message" too,
 * because `previewFor` could not parse what this phone had just composed.
 *
 * So the invariant, which is worth stating as a rule rather than a fix:
 *
 *   AN ENVELOPE THIS BUILD CANNOT PARSE MUST NEVER BE ENCODABLE BY THIS BUILD.
 *
 * It throws rather than returning null so the refusal lands at COMPOSE time —
 * before encryption, before the ratchet advances, before an outbox row exists,
 * before an ack destroys the only other copy. Loud and local beats silent and
 * permanent. It protects every envelope kind in the union, not just the vault.
 *
 * (Call signalling is encoded by `encodeCallEnvelope` in @tacendum/shared and
 * does not come through here; giving that function the same treatment is a
 * separate change to a file another workstream owns.)
 */
export function encodeEnvelope(envelope: Envelope): string {
  const parsed = Envelope.safeParse(envelope);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map(i => i.path.join('.')).filter(Boolean)),
    ];
    throw new EnvelopeRefusedError(
      typeof (envelope as { tcm?: unknown })?.tcm === 'string'
        ? (envelope as { tcm: string }).tcm
        : '',
      fields,
    );
  }
  // THE COMPOSE-STRICT HALF OF THE MENTION ASYMMETRY (the mentions contract).
  // The count rule lives HERE and not in the schema, because the schema is
  // shared with `parseEnvelope` and the receive side must stay permissive: a
  // mismatch arriving off the wire must cost the mention, never the words
  // around it. At compose the calculus inverts — the refusal is loud, local
  // and free, before encryption, before the ratchet advances, before an ack
  // destroys the only other copy. Encodable remains a strict subset of
  // parseable, which is the invariant's permitted direction.
  if (parsed.data.tcm === 'mention') {
    if (mentionMarkCount(parsed.data.text) !== parsed.data.who.length) {
      throw new EnvelopeRefusedError('mention', ['text', 'who']);
    }
  }
  // `parsed.data`, not the argument: zod strips unknown keys, so what is
  // stringified is exactly what the receiver will reconstruct. Encoding the
  // raw argument would let a stray property ride the wire unchecked.
  return JSON.stringify(parsed.data);
}

/**
 * Strict parse: null for anything that isn't a well-formed envelope, so an
 * ordinary text that merely resembles JSON falls through to text rendering.
 * (A handcrafted text starting with {"tcm": is indistinguishable by design —
 * documented residual, same class as any in-band signaling.)
 */
export function parseEnvelope(body: string): Envelope | null {
  if (!body.startsWith(ENVELOPE_SENTINEL)) return null;
  try {
    const parsed = Envelope.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether a parsed envelope CLAIMS AI origin —
 * the `ai: true` field on the kinds the agent lane composes (`msg`, `edit`,
 * `x.edit`, `x.typing`, `x.approval`, and `grp.msg`'s wrapper). ONE reader,
 * used by the receive path to stamp the row's arrival record (`messages.ai`,
 * `outsider`'s pattern) — render then reads the COLUMN, never this, so a
 * body that merely LOOKS marked cannot badge a row that arrived unmarked.
 * Honest limits: sender-claimed, relay-invisible, not provable.
 */
export function aiOriginOf(envelope: Envelope | null): boolean {
  if (envelope === null) return false;
  // The cast is shape-only: kinds without the field read `undefined`, and
  // `claimsAiOrigin` answers strictly `=== true` (shared/ai-origin.ts).
  return claimsAiOrigin(envelope as { ai?: true | undefined });
}

/** True for envelopes that are transport, not conversation — never rendered
 * as a message row and never allowed to change a chat's preview line. */
export function isCarrierEnvelope(body: string): boolean {
  // Routed on the declared namespace, before parsing: call signalling stays
  // silent even when it is a shape this build has never seen. `x.` is
  // reserved on identical terms.
  const declared = declaredTcm(body);
  if (declared?.startsWith(CALL_NAMESPACE)) return true;
  if (declared?.startsWith(RESERVED_CARRIER_NAMESPACE)) return true;
  const envelope = parseEnvelope(body);
  // A room message INHERITS its wrapped body's classification. That is what
  // keeps a reaction sent into a room as invisible as one sent 1:1 — the
  // alternative is a thread full of rows for things that are not messages.
  // One level only: the schema refuses a `grp.*` inside a `grp.msg`, so this
  // cannot recurse further.
  if (envelope?.tcm === 'grp.msg') return isCarrierEnvelope(envelope.b);
  // A device leg inherits its wrapped body's classification for exactly
  // grp.msg's reason: a reaction fanned to three devices is as invisible as
  // one sent bare. One level only — the schema refuses
  // nested wrappers.
  if (envelope?.tcm === 'dev.msg') return isCarrierEnvelope(envelope.b);
  const tcm = envelope?.tcm;
  // The other four room kinds are deliberately NOT carriers. A membership
  // change is announced on every phone exactly as a timer change is; a room
  // deleted under you is a thing that happened to you. A counted
  // `grp.del` still renders nothing, but for a different reason — the room it
  // would announce into is gone — and that belongs to the apply path, not
  // here.
  // A reply is NOT here: it is a message like any other. Edits and deletions
  // are — they rewrite a row that already exists. A mention is NOT here
  // either, and deliberately: it is conversation aimed at someone, and the
  // whole point of the feature is that a row appears, bumps the preview,
  // and gets noticed (the mentions contract).
  return (
    tcm === 'react' ||
    tcm === 'profile' ||
    tcm === 'edit' ||
    tcm === 'del' ||
    // A read receipt rewrites a status on a row that already exists. It must
    // never become a row of its own, bump a preview, or raise an unread count
    // — being told someone read you is not a new message.
    tcm === 'read'
  );
}

/**
 * How a phone turns a mention's ids into ITS OWN names (the mentions
 * contract). INJECTED, never imported: envelope.ts is a pure module and must not
 * learn about the database — the `composeRosterDigest` precedent, where the
 * hash is a parameter for the same reason. Return null, undefined or '' for
 * an id this phone cannot name; the renderer drops that mention and keeps
 * the words.
 */
export type MentionNameResolver = (id: string) => string | null | undefined;

/** No resolver injected: nothing resolves, marks drop, words survive. */
const resolveNothing: MentionNameResolver = () => null;

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; id: string };

/**
 * THE ORDINAL MAPPING, stated once so no renderer re-implements it (two
 * copies of a switch arm drifting is a defect this codebase has shipped
 * before): the Nth MENTION_MARK is the Nth id. PARSE-PERMISSIVE by
 * construction — a mark beyond the ids is dropped (the words around it
 * survive), ids beyond the marks are ignored, and nothing here can throw.
 * The bubble renderer builds chips from these segments; `renderMentionText`
 * below flattens them for the one-line surfaces.
 */
export function mentionSegments(
  text: string,
  who: readonly string[],
): MentionSegment[] {
  const parts = text.split(MENTION_MARK);
  const segments: MentionSegment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      const id = who[i - 1];
      // A mark with no id renders as nothing: dropping it keeps the words,
      // and inventing a placeholder would draw bytes nobody wrote.
      if (id !== undefined) segments.push({ kind: 'mention', id });
    }
    if (part !== '') segments.push({ kind: 'text', text: part });
  });
  return segments;
}

/**
 * A mention's words with each mark replaced by `@<the name THIS phone
 * uses>`. What it may NEVER emit: a raw ULID (ids are not for
 * people) or a MENTION_MARK (a mark that survives rendering is structure
 * leaking as text). An id the resolver cannot name is dropped with its
 * words intact — and a resolver that echoes the id back IS "cannot name":
 * falling back to the id is exactly the violation the guard exists for.
 */
export function renderMentionText(
  text: string,
  who: readonly string[],
  resolveName: MentionNameResolver,
): string {
  let out = '';
  for (const segment of mentionSegments(text, who)) {
    if (segment.kind === 'text') {
      out += segment.text;
      continue;
    }
    const name = resolveName(segment.id);
    if (!name || name === segment.id) continue;
    // A local name is trusted display data, but a MENTION_MARK inside one
    // would read as structure to anything re-counting marks downstream, so
    // it is stripped rather than trusted.
    out += `@${name.split(MENTION_MARK).join('')}`;
  }
  return out;
}

/** The ids a body's preview would need NAMES for — the mention's `who`,
 * through one room wrapper, else empty. Exists for one caller shape: the
 * receive path is async and can prefetch names from the database; the
 * renderer is sync and cannot. Mirrors previewFor's own grp.msg unwrap —
 * it reads the same parsed shape, it does not re-decide anything. */
export function mentionWho(body: string): readonly string[] {
  const envelope = parseEnvelope(body);
  if (envelope?.tcm === 'mention') return envelope.who;
  if (envelope?.tcm === 'grp.msg' || envelope?.tcm === 'dev.msg') {
    const inner = parseEnvelope(envelope.b);
    if (inner?.tcm === 'mention') return inner.who;
  }
  return [];
}

/**
 * The words of a message, whatever shape its body has. A reply's body IS its
 * envelope, so anything that treats a body as text — the clipboard, the
 * VoiceOver label, the composer when rewriting — must come through here or it
 * hands the person raw JSON.
 */
export function displayText(
  body: string,
  resolveMentionName?: MentionNameResolver,
): string {
  const envelope = parseEnvelope(body);
  if (envelope?.tcm === 'reply') return envelope.text;
  // Marked bare text: the words ARE the message — the wrapper
  // exists only to carry the origin claim, which render derives from the
  // row's arrival record, never from here.
  if (envelope?.tcm === 'msg') return envelope.text;
  // A mention's words are its text with each mark resolved to the name THIS
  // phone uses — or dropped where it cannot be. The clipboard and the
  // VoiceOver label must never receive a ULID or a bare mark; without an
  // injected resolver the marks drop and the words stand alone.
  if (envelope?.tcm === 'mention') {
    return renderMentionText(
      envelope.text,
      envelope.who,
      resolveMentionName ?? resolveNothing,
    );
  }
  // A room message's words are the words of what it wraps — the clipboard,
  // the VoiceOver label and the edit composer must all reach through the
  // wrapper or they hand the person raw JSON.
  if (envelope?.tcm === 'grp.msg') {
    return displayText(envelope.b, resolveMentionName);
  }
  // A device leg's words are the words of what it wraps, on the same terms.
  if (envelope?.tcm === 'dev.msg') {
    return displayText(envelope.b, resolveMentionName);
  }
  if (envelope) return '';
  // Claims to be structure but this build cannot read it: silent if it is
  // transport, otherwise a plain notice — never the raw JSON.
  if (declaredTcm(body)) {
    return isCarrierEnvelope(body) ? '' : UNSUPPORTED_TEXT;
  }
  return body;
}

/**
 * The body a message should have once its author rewrites its words. A reply
 * keeps its quote — an edit changes what someone said, not what they were
 * answering — so only the text inside the envelope is replaced. Each side
 * applies this to ITS OWN copy, which is why the wire only ever carries the
 * new text.
 */
export function rewriteBody(currentBody: string, newText: string): string {
  const envelope = parseEnvelope(currentBody);
  if (envelope?.tcm === 'reply') {
    return encodeEnvelope({ ...envelope, text: newText });
  }
  // A marked `msg` keeps its wrapper: the agent's durable edit final
  // rewrites the WORDS of its anchor, and shedding the envelope here would
  // shed the Art. 50 claim with it — an agent correcting itself must not
  // lose its own disclosure.
  if (envelope?.tcm === 'msg') {
    return encodeEnvelope({ ...envelope, text: newText });
  }
  // A mention deliberately falls through to plain text. An edit's wire
  // carries only words — no `who` — so preserving the envelope would mean
  // composing a mark/id pairing the editor never saw, and any count drift
  // is exactly the mismatch this build refuses to encode. Editing a mention
  // downgrades it: the calmer words survive, the addressing does not.
  return newText;
}

/** Chat-list / notification preview line for a stored message body. */
export function previewFor(
  body: string,
  resolveMentionName?: MentionNameResolver,
): string {
  const envelope = parseEnvelope(body);
  if (envelope?.tcm === 'image') return 'Photo';
  if (envelope?.tcm === 'voice') return 'Voice message';
  if (envelope?.tcm === 'file') return 'Document';
  if (envelope?.tcm === 'loc') return 'Location';
  if (envelope?.tcm === 'shot') return 'Screenshot';
  // A timer change is an announced event, not a silent setting: it keeps a row
  // on BOTH sides (ChatThreadScreen renders it as a system line), so it needs a
  // preview line too. Without this it fell through to the `if (envelope)` blank
  // below, which is how an inbound timer used to erase a conversation's preview
  // — and, worse, how the outgoing failed-bubble's `previewFor(body) || body`
  // fallback printed the raw {"tcm":"timer"...} JSON on screen.
  // Direction-free wording on purpose: previewFor is handed a body and has no
  // idea which side sent it. The thread row, which does, says "You"/"They".
  if (envelope?.tcm === 'timer') {
    return envelope.s > 0
      ? 'Disappearing messages on'
      : 'Disappearing messages off';
  }
  // A vault change is announced like a timer change, so it needs a preview or
  // it blanks the conversation's line and — worse — falls through to the
  // failed-bubble's `previewFor(body) || body` fallback, which is how the
  // timer bug printed raw JSON on screen. That fallback is the reason this
  // case exists at all; it is not decoration.
  //
  // DELIBERATELY WITHOUT THE TITLE, unlike the thread row.
  // What this function returns is written to `chats.lastMessageText` and is
  // what a notification would show: two places that sit OUTSIDE the thread,
  // outlive the item, and are read without opening the Room. The title is a
  // label a person chose for a secret — "Divorce lawyer login" is itself the
  // disclosure — so it belongs on the row, where the vault is, and nowhere
  // else. The body never appears anywhere.
  //
  // Direction-free wording, like the timer's: previewFor is handed a body and
  // has no idea which side sent it.
  if (envelope?.tcm === 'vault') {
    return envelope.op === 'del' ? 'Removed from the vault' : 'Saved to the vault';
  }
  // A reply previews as its own words: what it answers is thread context, and
  // a chat row has one line to spend.
  if (envelope?.tcm === 'reply') return envelope.text;
  // Marked bare text previews as its words too — without this arm it
  // falls to the `if (envelope)` blank below, which is the exact
  // erased-preview / raw-JSON-fallback defect the timer and vault arms
  // record having shipped twice.
  if (envelope?.tcm === 'msg') return envelope.text;
  // A mention previews as its words with names resolved — this string
  // reaches the chat list and a lock screen, so it must NEVER carry a ULID
  // or a raw mark. The resolver is injected (the mentions contract); absent
  // one, marks drop and the words stand alone.
  //
  // And it must never be '': the failed-bubble path renders
  // `previewFor(row.body) || row.body`, which is how a blank preview has put
  // raw {"tcm": JSON on screen twice already. A mention that is ONLY marks —
  // "@Ana" and nothing else, unresolvable here — would be the third, so a
  // fixed constant is the floor beneath it.
  if (envelope?.tcm === 'mention') {
    const words = renderMentionText(
      envelope.text,
      envelope.who,
      resolveMentionName ?? resolveNothing,
    );
    return words.trim() === '' ? 'Mention' : words;
  }

  // Rooms. Every one of these needs a branch or it falls
  // through to the blank below — which is how an inbound timer once erased a
  // conversation's preview and, worse, how the failed-bubble's
  // `previewFor(body) || body` fallback printed raw {"tcm": JSON on screen.
  // That bug has now shipped twice; these five exist so it cannot ship a third
  // time.
  //
  // A room message previews as WHATEVER IT WRAPS, so a photo in a room reads
  // "Photo" exactly as it does in a 1:1. Recursing rather than special-casing
  // is what keeps the two paths from drifting. The resolver rides along, or
  // a mention in a room — the only place mentions are composed — would lose
  // its names at exactly the surface they were resolved for.
  if (envelope?.tcm === 'grp.msg') {
    return previewFor(envelope.b, resolveMentionName);
  }
  // A device leg previews as whatever it wraps, exactly like a room message
  // — same recursion, same no-drift argument.
  if (envelope?.tcm === 'dev.msg') {
    return previewFor(envelope.b, resolveMentionName);
  }
  // Deliberately WITHOUT the room name, on the vault's reasoning: what this
  // returns is written to `chats.lastMessageText` and is what a notification
  // would show — two places that sit outside the thread and are read without
  // opening it. In the chat list the room name is already the row's title, so
  // repeating it buys nothing and leaks it somewhere it need not be.
  if (envelope?.tcm === 'grp.new') return 'New room';
  // No names: who was added or removed is in the thread's own attributed row,
  // where the reader has already chosen to look.
  if (envelope?.tcm === 'grp.roster') return 'Members changed';
  // Neither the member (frame.from) nor the agent is named here, on grp.roster's
  // reasoning: this string lands in `chats.lastMessageText` and on a lock
  // screen, read without opening the thread — and WHO shares with WHICH agent
  // is exactly a fact kept inside the room. The attributed row in the
  // thread says it, where the reader has chosen to look. A fixed constant is
  // also the floor beneath the failed-bubble `previewFor(body) || body`
  // fallback, so a grp.consent body can never print its raw JSON.
  if (envelope?.tcm === 'grp.consent') return 'Sharing changed';
  if (envelope?.tcm === 'grp.del') return 'Room deleted';
  // Same wording as the 1:1 timer, and direction-free for the same reason:
  // previewFor is handed a body and has no idea which side sent it.
  if (envelope?.tcm === 'grp.set') {
    return envelope.s > 0 ? 'Disappearing messages on' : 'Disappearing messages off';
  }
  // No names and no count, on the reasoning `grp.roster` already records: this
  // string lands in `chats.lastMessageText` and on a lock screen, both read
  // without opening the thread. The attributed row inside the thread says who
  // shared how much with whom, where the reader has chosen to look.
  //
  // The TRANSCRIPT legs (`e` present) must never reach here: an entry's body
  // is a real past message, and previewing it would put words the newcomer
  // has not opened yet onto a lock screen, dated today. The receive path
  // stores an entry without touching the chat preview, and a test holds that.
  if (envelope?.tcm === 'grp.hist') return 'History shared';

  if (isCarrierEnvelope(body)) return '';
  // Parsed as a known kind we simply do not preview, or unreadable structure.
  if (envelope) return '';
  if (declaredTcm(body)) return UNSUPPORTED_TEXT;
  return body;
}
