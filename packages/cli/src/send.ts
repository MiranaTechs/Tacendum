import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { MsgType, ServerFrame } from '@tacendum/shared';
import { randomMsgId } from '@tacendum/shared/msgid';
import { apiCreateAttachment, apiGetPrekeyBundle, uploadBlob, type Credential } from './api.js';
import { BlobCipherError, encryptBlob } from './attachments.js';
import { bytesToB64 } from './bytes.js';
import { CliError, EXIT, slugOf } from './exit.js';
import { attachInbound, type Inbound } from './inbound.js';
import { withFileLockAsync } from './lock.js';
import {
  encryptText,
  establishSession,
  hasSession,
  isIdentityChange,
} from './messaging.js';
import { MessageLog } from './msglog.js';
import type { Reporter } from './output.js';
import { resolveRecipient } from './profile.js';
import { sanitizeForTerminal } from './render.js';
import { AuthSession } from './session.js';
import { FileStores } from './stores.js';
import { WsClient } from './wsclient.js';

/**
 * THE send path — resolve, bootstrap-if-absent, encrypt, transport, receipt —
 * extracted to the one function every sender calls.
 *
 * WHY ONE FUNCTION. This sequence used to exist verbatim in four places
 * (`cmdSend` here, `deliverNotification` in hooks.ts, `sendNotification` in
 * run.ts, and setup.ts's `sendPairingMessages`), and the repo's most-repeated
 * defect class is a rule implemented at N call sites that then diverge. It
 * happened to this exact rule: the encrypt-before-connect order was found
 * account-bricking and fixed in hooks.ts — and remained, identically wrong,
 * in two of the other copies; the setup copy ran the session BOOTSTRAP before
 * the dial, so every refused socket burned one of the owner's one-time
 * prekeys. So the ORDER now has one owner, and a caller can only get it by
 * calling this. `sendEncrypted` is the one-message entry; `sendEncryptedAll`
 * below is the SAME sequence for several messages on ONE socket (setup's
 * card-then-hello), and the single-message call is literally a one-element
 * call of it — there is exactly one implementation of the order in this
 * package, and gate.send-owner.test.ts holds the caller set closed.
 *
 * THE ORDER IS THE INVARIANT: THE SOCKET CONNECTS BEFORE ANYTHING TOUCHES THE
 * RATCHET. Encrypting first looked harmless and was the account-bricking
 * shape: every `encryptText` durably advances the sender chain whether or not
 * a frame ever leaves the machine, libsignal (0.98.0) caps the receiver's
 * forward jump at 25,000 messages, and `hasSession` prevents automatic
 * rebootstrap — so a refused WebSocket, retried enough times (a hook fires
 * every agent turn, a cron line every night, for months), put the chain
 * permanently past what the phone will accept. Connect-first makes a failed
 * transport cost ZERO ratchet advances: every advance has a live socket to
 * leave on. A retry after a lost receipt re-encrypts under the SAME msgId
 * when the caller supplies one, which the server's (recipient, msgId) row
 * overwrite and both receivers' seen-stores collapse to one message.
 *
 * The remaining sequence rules, each with one owner here:
 *  - the socket's role is 'send': one frame and one receipt, both posted to
 *    this connectionId — a sender must never take the account's routing row
 *    from a live `listen` (whose disconnect would then delete the row and
 *    strand every message toward the 30-day TTL);
 *  - session bootstrap and encrypt happen under ONE ratchet-lock acquisition:
 *    a concurrent `listen` may be creating this very session from an inbound
 *    prekey message, and an unlocked bootstrap clobbers it into permanent
 *    decrypt failure. One acquisition, not two, halves the worst-case
 *    synchronous lock wait (the one budget no caller's deadline can preempt —
 *    acquisition blocks the event loop, lock.ts);
 *  - `hasSession` is RE-ASKED under the lock: the answer taken outside it may
 *    have changed by the time the lock is held.
 *
 * What legitimately differs between callers stays OUT of this function and
 * comes in through `SendEvents`: wording and status lines, inbound-frame
 * policy (cmdSend may drain; notify must not attach at all), receipt budget,
 * and what an identity change is called. An identity-change error is thrown
 * RAW from here — `establishSession` has already recorded the pending change
 * at the raise site (messaging.ts), so callers own only the words.
 */

/**
 * THE WIRE-ID MINTER IS `randomMsgId`, NEVER A MONOTONIC ULID. This module minted `monotonicFactory()` ULIDs until
 * G9: for a single-recipient send that was a plan item rather than a live
 * leak (one id per process correlates nothing), but the same default now
 * serves `sendEncryptedFanout` below, where N consecutive base-32 integers
 * under one senderId hand the server an exact, durable, 30-day join key over
 * room membership — the metadata defect the wire-msgid rule exists to keep dead.
 * One minter for every wire id, so a future caller cannot pick the wrong
 * one. The CSPRNG binding is `node:crypto`'s `randomBytes`, exactly as
 * `@tacendum/shared/msgid` documents for the CLI; local ids (queue file
 * names, call cids) are not wire msgIds and keep their own minters.
 */
const mintWireMsgId = (): Promise<string> => randomMsgId(randomBytes);

/** What `apiGetPrekeyBundle` hands back — named for the one event that uses it. */
export type FetchedPrekeyBundle = Awaited<ReturnType<typeof apiGetPrekeyBundle>>;

/**
 * Plaintext ceiling for anything this module will encrypt — 16 KB.
 *
 * The wire cap is a 30 000-character base64 payload (`MAX_PAYLOAD_B64_LENGTH`,
 * frames.ts), i.e. ~22.5 KB of ciphertext, and an oversized send is refused
 * BY THE SERVER — after `encryptText` has already durably advanced the sender
 * chain. On a one-way ratchet that loss is permanent and the peer's next
 * decrypt can fail, so "just let it fail" is not an option anywhere on this
 * path. 16 KB keeps the whole envelope — plaintext, `composeBody`'s framing,
 * base64 expansion, prekey-message overhead — comfortably inside the wire cap.
 *
 * ONE constant, two enforcement shapes, deliberately:
 *  - `composeBody` (the `tacendum send` command) TRUNCATES, keeping the tail:
 *    piping a build log is that path's documented use case and the tail is
 *    the reason the build failed — a product decision for that path only, and
 *    its output is budgeted to fit this cap so it always passes the guard.
 *  - every shared entry point (`sendEncryptedAll`, `sendEncrypted`,
 *    `sendEncryptedFanout`) REFUSES via `assertBodyWithinCap`: a programmatic
 *    caller (attend replies, room fan-out, the notify queue, any future
 *    carrier) handing this module an over-cap body has a bug, and the honest
 *    answer is a refusal it can see — silent truncation would hide the bug,
 *    a silent send would strand the ratchet.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Refuse an over-cap body BEFORE anything advances: before the dial, before
 * the prekey-bundle fetch (which consumes one of the peer's one-time prekeys
 * server-side), before `establishSession` writes a session record, and above
 * all before `encryptText` durably advances the sender chain for a frame the
 * server will never accept. The sizes ride in the error; the body never does
 *.
 */
function assertBodyWithinCap(body: string): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new CliError(
      EXIT.USAGE,
      `the message is too large to send (${bytes} bytes; the cap is ${MAX_BODY_BYTES} bytes)`,
    );
  }
}

/**
 * The seams where callers legitimately differ. Every member is optional and
 * decides NOTHING about the send sequence — a caller that passes none gets
 * the identical wire behaviour, silently.
 */
export interface SendEvents {
  /**
   * The socket, constructed but NOT yet dialled — the one moment a caller may
   * attach its inbound policy (`attachInbound` must see every frame, so it
   * must be wired before the handshake settles; wsclient.ts). `notify`
   * deliberately attaches nothing: a hook must exit inside its deadline, and
   * an unconsumed frame is simply redelivered to the next `listen`/`sync`.
   */
  onSocket?: (ws: WsClient) => void;
  /** About to dial. */
  connecting?: () => void;
  /** No session with the recipient existed; a prekey bundle is being fetched. */
  fetchingBundle?: () => void;
  /** The fetched bundle, before bootstrap — cmdSend's low-prekey note. */
  bundleFetched?: (bundle: FetchedPrekeyBundle) => void;
  /** Holding the ratchet lock, about to encrypt. */
  encrypting?: () => void;
  /** The frame is on the wire; waiting for the server's receipt. */
  awaitingReceipt?: () => void;
  /**
   * Receipt in hand, socket still open — where cmdSend and run let their
   * inbound handler finish its acks before the close loses them.
   */
  beforeClose?: () => Promise<void> | void;
}

export interface SendOutcome {
  /** The wire id the frame carried. */
  msgId: string;
  msgType: MsgType;
  /** The frame `waitFor` matched — a 'receipt' by construction of the predicate. */
  receipt: ServerFrame;
}

/** One message on the shared connection (`sendEncryptedAll`). */
export interface OutboundMessage {
  body: string;
  /** The wire id. Callers that retry (notify's queue) mint once and pass it
   * on every attempt so the server row and receiver dedupe collapse them;
   * omitted, a fresh `randomMsgId` is minted (see `mintWireMsgId`). */
  msgId?: string;
  /** The frame's notify bit. `false` marks a CARRIER — setup's profile card
   * renames a chat rather than saying anything, and the bit's contract is
   * that carriers must not banner the peer's phone. Omitted, the field is
   * absent from the frame and the server notifies normally. */
  notify?: boolean;
}

/**
 * The send sequence for `messages` (in order, at least one) to `to`, all on
 * ONE 'send'-role socket, connect-first (see the module header for why that
 * clause is load-bearing). Exists as the multi-message form because setup's
 * pairing flow sends a profile card and then a hello: two `sendEncrypted`
 * calls would be two dials — two single-use tickets minted, two handshakes —
 * for what is one delivery, and setup keeping its own loop instead was the
 * last divergent copy of this sequence.
 *
 * Each message is encrypted under its own ratchet-lock acquisition, AFTER
 * the previous one's receipt arrived: an advance never outruns the socket's
 * evidence that frames are leaving, and the lock is never held across a
 * network wait. The session bootstrap (if any) shares the FIRST acquisition,
 * as the module header requires.
 *
 * Throws untranslated: transport failures as WsClient's CliErrors, an
 * identity change as the raw libsignal error (test with `isIdentityChange`).
 * A mid-sequence failure means every earlier message WAS delivered (its
 * receipt was in hand) and the failing one was never put on the wire. The
 * socket is closed on every path.
 */
export async function sendEncryptedAll(args: {
  stores: FileStores;
  auth: AuthSession;
  to: string;
  messages: OutboundMessage[];
  /** Bound on each receipt wait; omitted, `waitFor`'s flat 10 s. */
  receiptTimeoutMs?: number;
  events?: SendEvents;
}): Promise<SendOutcome[]> {
  const { stores, auth, to, messages } = args;
  const events = args.events ?? {};
  if (messages.length === 0) {
    // A caller bug; the text is fixed, nothing user-supplied rides in it.
    throw new Error('sendEncryptedAll: at least one message is required');
  }
  // The WHOLE batch is checked before the socket even exists: a refused batch
  // costs zero dials, zero prekey fetches, zero ratchet advances — and never
  // a partial delivery whose first k messages went out before the oversized
  // one refused (see assertBodyWithinCap).
  for (const message of messages) assertBodyWithinCap(message.body);

  const ws = new WsClient();
  events.onSocket?.(ws);
  events.connecting?.();
  // CONNECT BEFORE ANY RATCHET WORK — the invariant this module exists to
  // hold in exactly one place. A refused socket must cost zero advances,
  // and the session bootstrap below counts: `establishSession` consumes one
  // of the peer's one-time prekeys and writes a session `hasSession` will
  // then answer for, so a pre-connect bootstrap burns prekeys against a
  // peer the socket never reached (setup's own copy did exactly that).
  await ws.connect(auth, 'send');
  try {
    const bundle = (await hasSession(stores, to))
      ? null
      : await (async () => {
          events.fetchingBundle?.();
          const fetched = await apiGetPrekeyBundle(auth, to);
          events.bundleFetched?.(fetched);
          return fetched;
        })();
    const outcomes: SendOutcome[] = [];
    for (const message of messages) {
      // ONE lock acquisition for bootstrap + encrypt; hasSession re-asked
      // under it (see the module header for both). On the second and later
      // messages the re-ask finds the session the first acquisition wrote,
      // so the bootstrap runs at most once per call.
      const { msgType, payload } = await withFileLockAsync(stores.ratchetLockPath(), async () => {
        if (bundle !== null && !(await hasSession(stores, to))) {
          await establishSession(stores, auth.userId, bundle);
        }
        events.encrypting?.();
        return encryptText(stores, auth.userId, to, message.body);
      });
      const msgId = message.msgId ?? (await mintWireMsgId());
      ws.send({
        type: 'send',
        to,
        msgId,
        msgType,
        payload,
        ...(message.notify === false ? { notify: false } : {}),
      });
      events.awaitingReceipt?.();
      const receipt = await ws.waitFor(
        (f) => f.type === 'receipt' && f.msgId === msgId,
        args.receiptTimeoutMs,
      );
      outcomes.push({ msgId, msgType, receipt });
    }
    await events.beforeClose?.();
    return outcomes;
  } finally {
    ws.close();
  }
}

/**
 * Encrypt `body` to `to` and deliver it over one 'send'-role socket — the
 * one-message form every notification sender calls. A literal one-element
 * `sendEncryptedAll` call: the sequence is implemented exactly once, above.
 */
export async function sendEncrypted(args: {
  stores: FileStores;
  auth: AuthSession;
  to: string;
  body: string;
  /** See `OutboundMessage.msgId`. */
  msgId?: string;
  /** Bound on the receipt wait; omitted, `waitFor`'s flat 10 s. */
  receiptTimeoutMs?: number;
  events?: SendEvents;
}): Promise<SendOutcome> {
  const outcomes = await sendEncryptedAll({
    stores: args.stores,
    auth: args.auth,
    to: args.to,
    messages: [{ body: args.body, ...(args.msgId !== undefined ? { msgId: args.msgId } : {}) }],
    ...(args.receiptTimeoutMs !== undefined ? { receiptTimeoutMs: args.receiptTimeoutMs } : {}),
    ...(args.events !== undefined ? { events: args.events } : {}),
  });
  const outcome = outcomes[0];
  if (outcome === undefined) {
    // Unreachable: one message in, one outcome out — the guard exists for
    // noUncheckedIndexedAccess, not for a real path.
    throw new Error('sendEncrypted: no outcome for the one message sent');
  }
  return outcome;
}

/** One leg of a room fan-out: one recipient, one body, one pre-minted wire id. */
export interface FanoutLeg {
  to: string;
  body: string;
  /** Minted by the caller from `randomMsgId` — REQUIRED rather than
   * defaulted, because the caller sorts legs by these ids to randomise the
   * recipient order, which it can only do with the ids in hand. */
  msgId: string;
  /** See `OutboundMessage.notify`. */
  notify?: boolean;
}

export interface FanoutLegOutcome {
  to: string;
  msgId: string;
  state: 'delivered' | 'identity-changed' | 'failed';
  /** For a failed leg: the CliError SLUG (`network`, `recipient`, …), never
   * the message — an error string can carry payload and this record reaches
   * `--json` output, i.e. hook and CI logs. */
  reason?: string;
}

/**
 * A room fan-out: N ordinary pairwise sends on ONE 'send'-role socket
 *. Lives in this module because the
 * send sequence has one owner (see the module header): connect FIRST, then
 * per leg one ratchet-lock acquisition for bootstrap-if-absent + encrypt,
 * the frame, the receipt. A refused socket still costs ZERO ratchet
 * advances, for all N legs at once.
 *
 * PER-LEG FAILURE IS A SETTLED OUTCOME, NEVER AN ABORT — the one deliberate
 * departure from `sendEncryptedAll`, and it is the fan-out's defining
 * contract (app parity: `fanOut`'s ledger): by the time leg k fails,
 * legs 1..k-1 are DELIVERED, and throwing away the rest would silently
 * diverge this client's roster view from the members who did hear from it.
 * So: an identity change marks the pending record (the same belt `cmdSend`
 * wears) and skips THAT member only — the room does not pause — and
 * any other failure settles as a `failed` outcome carrying its slug. The
 * caller owns the words and the exit code.
 *
 * The caller passes legs ALREADY shuffled (sorted by their `randomMsgId`
 * wire ids — pure CSPRNG, so a uniform order for free, the app's own trick)
 * and already gated: members with a PENDING identity change never reach
 * here (gate 3 runs at the room layer, where the roster lives).
 */
export async function sendEncryptedFanout(args: {
  stores: FileStores;
  auth: AuthSession;
  legs: FanoutLeg[];
  /** Bound on each receipt wait; omitted, `waitFor`'s flat 10 s. */
  receiptTimeoutMs?: number;
  events?: SendEvents;
  /** Called as each leg settles — progress reporting, nothing else. */
  onLeg?: (outcome: FanoutLegOutcome) => void;
}): Promise<FanoutLegOutcome[]> {
  const { stores, auth, legs } = args;
  const events = args.events ?? {};
  if (legs.length === 0) return [];

  const ws = new WsClient();
  events.onSocket?.(ws);
  events.connecting?.();
  // CONNECT BEFORE ANY RATCHET WORK — the module invariant, held here for
  // every leg at once: nothing below advances a chain until this resolves.
  await ws.connect(auth, 'send');
  try {
    const outcomes: FanoutLegOutcome[] = [];
    const settle = (outcome: FanoutLegOutcome): void => {
      outcomes.push(outcome);
      args.onLeg?.(outcome);
    };
    for (const leg of legs) {
      try {
        // An over-cap body settles as THIS leg's failure (the fan-out
        // contract above), and it is checked before the bundle fetch so a
        // refused leg consumes no prekey and advances nothing.
        assertBodyWithinCap(leg.body);
        const bundle = (await hasSession(stores, leg.to))
          ? null
          : await (async () => {
              events.fetchingBundle?.();
              const fetched = await apiGetPrekeyBundle(auth, leg.to);
              events.bundleFetched?.(fetched);
              return fetched;
            })();
        // ONE lock acquisition for bootstrap + encrypt, hasSession re-asked
        // under it — sendEncryptedAll's exact clause, for the same reasons.
        const { msgType, payload } = await withFileLockAsync(
          stores.ratchetLockPath(),
          async () => {
            if (bundle !== null && !(await hasSession(stores, leg.to))) {
              await establishSession(stores, auth.userId, bundle);
            }
            events.encrypting?.();
            return encryptText(stores, auth.userId, leg.to, leg.body);
          },
        );
        ws.send({
          type: 'send',
          to: leg.to,
          msgId: leg.msgId,
          msgType,
          payload,
          ...(leg.notify === false ? { notify: false } : {}),
        });
        events.awaitingReceipt?.();
        await ws.waitFor(
          (f) => f.type === 'receipt' && f.msgId === leg.msgId,
          args.receiptTimeoutMs,
        );
        settle({ to: leg.to, msgId: leg.msgId, state: 'delivered' });
      } catch (err) {
        if (isIdentityChange(err)) {
          // The identity-change skip's mid-compose twin: record it so `tacendum trust`
          // has something to accept, skip THIS member, keep going.
          stores.markIdentityChange(leg.to);
          settle({ to: leg.to, msgId: leg.msgId, state: 'identity-changed' });
          continue;
        }
        settle({
          to: leg.to,
          msgId: leg.msgId,
          state: 'failed',
          reason: slugOf(err),
        });
      }
    }
    await events.beforeClose?.();
    return outcomes;
  } finally {
    ws.close();
  }
}

/**
 * Compose the plaintext a `send` will carry.
 *
 * `make build || tacendum send --title "build failed"` is the premise of the
 * whole product, and it needs two things a proof client never had: a body read
 * from a pipe, and a one-line summary in front of it.
 *
 * The title is joined with a newline rather than encoded in a new envelope
 * kind. That is deliberate: a `notify` envelope would be a protocol change, it
 * would need matching app-side parsing shipped in the same release, and until
 * then every phone would render the notification as "Unsupported message".
 * Two lines of text works on every build that already exists.
 */
function composeBody(
  text: string | undefined,
  title: string | undefined,
  report: Reporter,
): string {
  let body = text;
  if (body === undefined) {
    if (process.stdin.isTTY) {
      throw new CliError(
        EXIT.USAGE,
        'nothing to send: pass the text as an argument, or pipe it on stdin',
      );
    }
    // fd 0 read whole, not line-buffered: the body is one message, and a
    // partial read would send half a stack trace.
    //
    // THE TTY GUARD ABOVE IS LOAD-BEARING, and this branch must never be
    // reached from anything but the `send` command as typed in a shell. Any
    // future embedding that OWNS stdin — the MCP server speaks JSON-RPC over
    // exactly this fd — must pass the body explicitly, because an omitted
    // body here consumes ALL of fd 0 and would swallow the transport whole
    //.
    body = readFileSync(0, 'utf8');
  }

  // A pipe almost always ends in a newline that nobody meant to send.
  body = body.replace(/\n+$/, '');

  const titleLine = title === undefined ? undefined : sanitizeForTerminal(title).slice(0, 200);

  // TRUNCATE, keeping the TAIL: `make build || tacendum send` exists to carry
  // the reason a build failed, and that is the last thing a compiler printed.
  //
  // The COMPOSED result — title line, truncation marker and all — must fit
  // MAX_BODY_BYTES: the shared send path refuses over-cap bodies before the
  // ratchet moves (assertBodyWithinCap), so this path budgets its own framing
  // inside the cap rather than riding above it and getting refused.
  const budget =
    MAX_BODY_BYTES - (titleLine === undefined ? 0 : Buffer.byteLength(titleLine, 'utf8') + 1);
  if (Buffer.byteLength(body, 'utf8') > budget) {
    const bytes = Buffer.from(body, 'utf8');
    const markerFor = (n: number): string => `[…${n} earlier byte(s) omitted]\n`;
    // The marker is budgeted at its widest possible rendering (the digit
    // count of the whole body); a final marker with fewer digits just lands
    // a few bytes under the cap.
    let start =
      bytes.length -
      Math.max(0, budget - Buffer.byteLength(markerFor(bytes.length), 'utf8'));
    // Land the cut on a UTF-8 boundary: continuation bytes at the front
    // would decode to U+FFFD and re-encode LARGER than the bytes they
    // replace, which could put the composed result back over the cap.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    const kept = bytes.subarray(start).toString('utf8');
    report.note(`note: body truncated — ${start} leading byte(s) omitted`);
    body = `${markerFor(start)}${kept}`;
  }

  if (titleLine !== undefined) {
    body = body ? `${titleLine}\n${body}` : titleLine;
  }

  if (!body) {
    throw new CliError(EXIT.USAGE, 'nothing to send: the body is empty');
  }
  return body;
}

/**
 * COMPOSE-ONCE-UPLOAD-ONCE (the app's rule at messaging.ts:2472, inherited
 * verbatim): encrypt the file under ONE fresh key, upload it ONCE, and return
 * the ONE envelope string every recipient gets — the single peer of a 1:1 or
 * all N legs of a room fan-out, each carrying the same `att` id and the same
 * key inside its own ratchet. This function being the ONLY caller of
 * `apiCreateAttachment` + `uploadBlob` on the message path is what keeps the
 * 10/min attachmentCreate budget's per-recipient-upload trap structurally
 * unwritable (a per-recipient loop 429s at the 11th
 * member).
 *
 * The envelope is app/src/envelope.ts's FileEnvelope, field for field:
 * `{ tcm:'file', att, key, name, size, mime }` — the receiver side of that
 * schema is already shipped in every app build.
 */
export async function composeAttachment(auth: Credential, filePath: string): Promise<string> {
  let data: Buffer;
  try {
    data = readFileSync(filePath);
  } catch {
    // errno text can embed the resolved path twice; one clean line instead.
    throw new CliError(EXIT.USAGE, `cannot read attachment file: ${filePath}`);
  }
  if (data.length === 0) {
    // A zero-byte blob is legal on the wire (28 bytes sealed) but the APP
    // CRASHES decrypting it — libsignal Swift's Aes256GcmDecryption traps on
    // empty ciphertext (measured 2026-08-14 generating blobvectors.json, two
    // .ips reports). Refusing here is cheaper than crashing every recipient.
    throw new CliError(EXIT.USAGE, 'refusing to send an empty file as an attachment');
  }
  const name = basename(filePath);
  if (name.length === 0 || name.length > 200) {
    throw new CliError(
      EXIT.USAGE,
      `attachment filename must be 1-200 characters; got ${name.length}`,
    );
  }
  let sealed: { key: Uint8Array; blob: Uint8Array };
  try {
    // encryptBlob mints the key+nonce, seals, and VERIFIES by decrypting its
    // own output before anything may be uploaded (C4).
    sealed = encryptBlob(data);
  } catch (err) {
    if (err instanceof BlobCipherError && err.check === 'too-large') {
      throw new CliError(EXIT.USAGE, err.message);
    }
    throw err;
  }
  const blobB64 = bytesToB64(sealed.blob);
  // Blob first, envelope second (the app's crash-window rationale): a crash
  // between the two leaks only an orphaned unreadable ciphertext blob.
  const { attachmentId, uploadUrl } = await apiCreateAttachment(auth, blobB64.length);
  await uploadBlob(uploadUrl, blobB64);
  return JSON.stringify({
    tcm: 'file',
    att: attachmentId,
    key: bytesToB64(sealed.key),
    name,
    size: data.length,
    mime: 'application/octet-stream',
  });
}

export interface SendOptions {
  title?: string | undefined;
  /** Path of a file to send as an encrypted attachment (FileEnvelope). */
  attach?: string | undefined;
  /** Consume this account's own inbox on the way past (C4). */
  drain: boolean;
}

/**
 * The interactive `tacendum send`. Lives here rather than in main.ts so it is
 * importable — main.ts executes `main()` at module load, which made every
 * command defined there untestable in-process, and an untestable copy of the
 * send sequence is exactly how the order defect survived two rounds. The wire
 * sequence is `sendEncrypted`'s; what is cmdSend's own is the Reporter
 * wording, the `--drain` inbound policy, and the identity-change refusal.
 */
export async function cmdSend(
  fromName: string,
  toName: string,
  text: string | undefined,
  opts: SendOptions,
  report: Reporter,
): Promise<void> {
  const stores = new FileStores(fromName);
  // ONE credential object for both transports, so C3's single-flight covers
  // the prekey fetch and the socket dial together (see session.ts).
  const auth = new AuthSession(fromName, stores);
  const peerUserId = resolveRecipient(toName);
  let body: string;
  if (opts.attach !== undefined) {
    // A FileEnvelope has no caption field, so text alongside --attach would
    // be silently dropped — refuse instead (the unquoted-body precedent).
    if (text !== undefined && text !== '') {
      throw new CliError(
        EXIT.USAGE,
        '--attach sends the file as the whole message — send the text as its own message',
      );
    }
    if (opts.title !== undefined) {
      throw new CliError(EXIT.USAGE, '--title does not combine with --attach');
    }
    report.status('encrypting + uploading attachment…');
    body = await composeAttachment(auth, opts.attach);
  } else {
    body = composeBody(text, opts.title, report);
  }

  let inbound: Inbound | undefined;
  let outcome: SendOutcome;
  try {
    outcome = await sendEncrypted({
      stores,
      auth,
      to: peerUserId,
      body,
      events: {
        onSocket: (ws) => {
          inbound = attachInbound({
            name: fromName,
            userId: auth.userId,
            stores,
            ws,
            report,
            // `--drain` consumes, so what it consumes must be durable (M3) —
            // the send path is otherwise untouched by the log.
            log: new MessageLog(fromName),
            consume: opts.drain,
          });
        },
        connecting: () => report.status('connecting…'),
        fetchingBundle: () =>
          report.status(`no session with ${toName}; fetching prekey bundle (X3DH/PQXDH)`),
        bundleFetched: (bundle) => {
          if (bundle.lowPrekeyCount) {
            report.note(`note: ${toName} is low on one-time prekeys`);
          }
        },
        encrypting: () => report.status('encrypting…'),
        awaitingReceipt: () => report.status('waiting for receipt…'),
        // Let whatever the drain already started finish its acks before the
        // socket goes; an ack posted after close is simply lost and the row
        // redelivers.
        beforeClose: () => inbound?.settled() ?? Promise.resolve(),
      },
    });
  } catch (err) {
    if (isIdentityChange(err)) {
      // Block-and-warn: the peer's key changed. Do not send.
      // Recorded so `tacendum trust` has something to accept — see cmdTrust.
      // (`establishSession` records at the raise site too; this call is the
      // idempotent belt to that suspender and keeps cmdSend's contract
      // independent of it.)
      stores.markIdentityChange(peerUserId);
      throw new CliError(
        EXIT.SAFETY,
        `SAFETY NUMBER CHANGED for ${toName} — refusing to send. Verify it out of band ` +
          `(tacendum safety ${fromName} ${toName}); to accept, run: tacendum trust ${fromName} ${toName}`,
      );
    }
    throw err;
  }

  inbound?.report();
  const { msgId, msgType, receipt } = outcome;
  if (receipt.type === 'receipt') {
    report.emit(
      {
        ok: true,
        msgId,
        to: peerUserId,
        state: receipt.state,
        msgType,
        bytes: Buffer.byteLength(body, 'utf8'),
        ...(inbound?.consumed ? { drained: inbound.consumed } : {}),
      },
      `${msgId} ${receipt.state} (${msgType})`,
    );
  }
}
