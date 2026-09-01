import { z } from 'zod';

/**
 * WebSocket wire frames. Validated with zod on both ends.
 * Payloads are base64 ciphertext only — the server never sees plaintext.
 */

/** ULID: 26 chars of Crockford base32. Sortable; used for msgId ordering. */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID');

/** Envelope type: `prekey` = PreKeySignalMessage (X3DH), `ciphertext` = SignalMessage. */
export const MsgType = z.enum(['prekey', 'ciphertext']);
export type MsgType = z.infer<typeof MsgType>;

/**
 * Payload ceiling sized for API Gateway's WebSocket transport:
 * frames cap at 32 KB, and clients don't control fragmentation, so the whole
 * JSON envelope must fit one 32768-byte frame. 30 000 base64 chars (22 500
 * ciphertext bytes) leaves ~2.7 KB for the envelope's other fields.
 */
export const MAX_PAYLOAD_B64_LENGTH = 30_000;

const Payload = z
  .string()
  .max(MAX_PAYLOAD_B64_LENGTH, 'payload too large')
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'payload must be base64');

// --- client -> server ---

export const SendFrame = z.object({
  type: z.literal('send'),
  /**
   * The recipient's userId — always a 26-char ULID from every legitimate
   * sender (the app and CLI both address peers by userId; the server mints
   * every userId with `ulid()`). This field was `z.string().min(1)`:
   * unbounded, so a client could push ~30 KB of arbitrary plaintext through
   * the relay inside a frame the server would only refuse after parsing.
   * A length cap closed that channel at the
   * schema; `Ulid` is the recorded endpoint, landed once the
   * test fixtures stopped minting prose ids. Exact shape, not just length:
   * a 26-char non-ULID string now refuses at parse. The refusal only moved
   * EARLIER — a malformed `to` used to draw the priced 404
   * `unknown_recipient` after the quota spend; a well-formed but unknown
   * ULID still does, so the existence oracle stays priced exactly as
   * before (quota before recipient read, handleSend).
   */
  to: Ulid,
  msgId: Ulid,
  msgType: MsgType,
  payload: Payload,
  /**
   * "This ciphertext is time-critical" — the one bit the server needs to
   * decide whether to wake a sleeping phone. The server
   * cannot see inside the payload, so without it a call could never ring a
   * locked device.
   *
   * **The tradeoff, stated plainly:** this leaks to the server that a given
   * frame is probably a call invite or a hangup. The alternatives are worse —
   * pushing on *every* message reveals full conversation timing to APNs and
   * costs battery, and pushing on none means calls simply do not ring. Signal
   * ships the same bit for the same reason. Clients set it only for
   * `call.offer` and `call.end`.
   *
   * Optional so every existing client remains valid unchanged.
   */
  urgent: z.boolean().optional(),
  /**
   * "Do not raise a notification for this one."
   *
   * Set by the client on CARRIER envelopes — read receipts, reactions, edits,
   * deletions, profile-card syncs, screenshot notices. Every one of those
   * rewrites a row that already exists and never becomes a message on arrival,
   * so a banner announcing it is not merely noise: it says somebody wrote to
   * you when nobody did. The worst case is a read receipt, which turns
   * "somebody read your message" into "you have a new message" on the phone of
   * the person who sent it.
   *
   * The server cannot work this out for itself. The distinction lives inside
   * the ciphertext, and the frames are otherwise identical — same `msgType`,
   * same queue, same everything.
   *
   * **The tradeoff, stated plainly**, in the same terms as `urgent` above.
   * This tells the server that a frame is transport rather than conversation,
   * which makes a read receipt inferable: a small frame going back to someone
   * moments after they wrote to you is a receipt, and now it is labelled as
   * one rather than merely looking like one. The server could already guess
   * that from timing and direction; this makes the guess certain. What it does
   * NOT reveal is which kind of carrier — a reaction, an edit and a receipt
   * are indistinguishable under this bit.
   *
   * The alternative was accepting the banners, and it does not improve later:
   * a notification-service extension can rewrite a notification, it cannot
   * suppress one. So the choice was this bit or that noise, permanently.
   *
   * Optional, and ABSENCE MEANS NOTIFY, so an older client that never sends it
   * keeps today's behaviour rather than silently going quiet.
   */
  notify: z.boolean().optional(),
});
export type SendFrame = z.infer<typeof SendFrame>;

export const AckFrame = z.object({
  type: z.literal('ack'),
  msgId: Ulid,
});
export type AckFrame = z.infer<typeof AckFrame>;

/**
 * "This person is composing toward you, right now" — relay-only typing state.
 *
 * The one frame the server relays WITHOUT storing: no queue row, no push
 * wake, no receipt, no correspondence. That is the requirement, not an
 * optimization — typing state is finer-grained metadata than `notify` leaks
 * (someone is at the keyboard, in one conversation, at second resolution),
 * so the only acceptable transport is one that is droppable, opt-out-able
 * (Settings), and never durable. The payload is ordinary Signal ciphertext;
 * the state (start/stop, which room) lives inside it.
 *
 * **The tradeoff, stated plainly:** the server learns that a typing-class
 * frame flowed sender→recipient at that instant, because the frame type is
 * readable even though the state is sealed. The alternatives are worse:
 * riding `send` would persist per-keystroke rows for 30 days, charge the
 * pair quota, and turn the delivery receipt into a free presence oracle;
 * omitting the frame type means no typing indicator at all. What the server
 * does NOT learn: start vs stop, 1:1 vs room, and — because the response is
 * identical either way — whether the recipient was there to receive it.
 *
 * No msgId (nothing is ever acked or retried), no urgent, no notify. A NEW
 * frame type, so every existing client is untouched: old clients never emit
 * it, and old receivers drop the relayed form at the ServerFrame union
 * (safeParse fails; both the app and the CLI ignore unparseable frames).
 */
export const TypingFrame = z.object({
  type: z.literal('typing'),
  /** Same shape as SendFrame.to, landed the same day. */
  to: Ulid,
  msgType: MsgType,
  payload: Payload,
});
export type TypingFrame = z.infer<typeof TypingFrame>;

export const ClientFrame = z.discriminatedUnion('type', [SendFrame, AckFrame, TypingFrame]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// --- server -> client ---

export const MsgFrame = z.object({
  type: z.literal('msg'),
  from: z.string(),
  msgId: Ulid,
  msgType: MsgType,
  payload: z.string(),
  ts: z.number(),
});
export type MsgFrame = z.infer<typeof MsgFrame>;

/** The relayed form of TypingFrame. `payload` is a plain string on this
 * direction, matching MsgFrame's deliberate asymmetry. `ts` is the server
 * relay time — receivers use it for nothing but display bookkeeping. */
export const TypingMsgFrame = z.object({
  type: z.literal('typing'),
  from: z.string(),
  msgType: MsgType,
  payload: z.string(),
  ts: z.number(),
});
export type TypingMsgFrame = z.infer<typeof TypingMsgFrame>;

/**
 * A server-minted accounts notice draining from the durable queue:
 * a pending link offer to the acceptor, or a
 * link/unlink/revoke event to a group member. `payload` is base64 of an
 * `AccountsNotice` JSON (dto.ts) — server-visible facts (ULIDs, classes,
 * epoch, ceremony signatures), never message content.
 *
 * A NEW server frame type, the TypingFrame precedent: old clients never
 * receive one unless a ceremony deliberately names them, and an old receiver
 * drops it at the ServerFrame union (safeParse fails; both the app and the
 * CLI ignore unparseable frames — the un-acked row is redelivered per drain
 * until its TTL, a bounded nuisance only reachable behind the default-OFF
 * `feature#accounts` flag). CLIENTS CANNOT MINT ONE: `SendFrame.msgType`
 * stays the two-value `MsgType` enum, so the only writer of an
 * 'accounts'-typed queue row is the server's own ceremony/roster code.
 */
export const AccountsNoticeFrame = z.object({
  type: z.literal('accounts'),
  /** The ceremony/mutation participant the notice is about — a real user, so
   * the queue's quota ledger keys stay well-formed. */
  from: z.string(),
  msgId: Ulid,
  payload: z.string(),
  ts: z.number(),
});
export type AccountsNoticeFrame = z.infer<typeof AccountsNoticeFrame>;

export const ReceiptFrame = z.object({
  type: z.literal('receipt'),
  msgId: Ulid,
  state: z.enum(['sent', 'delivered']),
});
export type ReceiptFrame = z.infer<typeof ReceiptFrame>;

export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: z.string(),
  detail: z.string(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

export const ServerFrame = z.discriminatedUnion('type', [
  MsgFrame,
  TypingMsgFrame,
  AccountsNoticeFrame,
  ReceiptFrame,
  ErrorFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
