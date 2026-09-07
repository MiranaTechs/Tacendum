import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { PrekeyBundle } from '@tacendum/shared';
import { clientDir } from './config.js';
import { loadProfile, type Profile } from './profile.js';
import { FileStores } from './stores.js';
import { MessageLog } from './msglog.js';
import {
  maySpool,
  prefixLines,
  renderBody,
  sanitizeServerField,
  type RenderedBody,
} from './render.js';
import { groupBodyRenderer, mentionNames } from './room-render.js';
import { isBlocked } from './blocked.js';
import { withFileLockAsync } from './lock.js';
import {
  assertAllDispositionsHandled,
  classifyDecryptFailure,
  describeLocalFailure,
  describeUndecryptable,
  localErrno,
  probeStorePersistence,
  pruneUndelivered,
  purgeRatchetDuplicate,
  quarantineUndelivered,
  type StorePersistenceProbe,
} from './inbound.js';
import {
  decryptEnvelope,
  encryptText,
  establishSession,
  hasSession,
  isIdentityChange,
} from './messaging.js';
import { apiGetPrekeyBundle } from './api.js';
import { MAX_BODY_BYTES } from './send.js';
import { applyOwnerNotifyPreference, composeNotifyPreferenceAck } from './ai-notify-preference.js';
import { CliError, EXIT } from './exit.js';
import { AuthSession } from './session.js';
import { WsClient } from './wsclient.js';
import { CallRunner, fixtureCandidate, type CallLogRow } from './call.js';
import { GroupCallRunner, type ReceiptKind } from './group-call.js';

/**
 * One CLI participant, connected and call-aware.
 *
 * Both `cli call` and `cli listen --calls` run this: a caller has to keep
 * listening (it must receive the answer, the ICE, and — for the glare check —
 * a competing offer that crossed its own in flight), and a listener has to be
 * able to send (ringing, answer, ICE). Splitting them into a sender and a
 * receiver would have made the glare case untestable, which is exactly the
 * case worth testing.
 */

const ulid = monotonicFactory();

/** Where terminal call rows land. A pinned check asserts this file gains no row
 * for a tampered offer, so nothing else may write it. */
export function callLogPath(name: string): string {
  return join(clientDir(name), 'calls.jsonl');
}

export function readCallLog(name: string): CallLogRow[] {
  const path = callLogPath(name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as CallLogRow);
}

export interface SessionOptions {
  /** Accept an incoming call as soon as it rings. */
  autoAnswer?: boolean | undefined;
  /** Decline an incoming call as soon as it rings. */
  autoDecline?: boolean | undefined;
  /** Marker embedded in outgoing SDP, for the plaintext-leak scan. */
  canary?: string | undefined;
  /** Backdates outgoing offers so a stale invite can be tested in seconds. */
  expOffsetMs?: number | undefined;
  /**
   * Drive the small-group session layer.
   *
   * OFF is not a degraded mode — it is the 1:1-only client, byte-for-byte the
   * one that shipped before `call.ginvite` existed, and the pinned requirement
   * ("a client running with the 1:1-only parser… prints nothing, rings
   * nothing, crashes never") is asserted against exactly this flag being
   * absent. `parseGroupCallEnvelope` is not merely skipped in that mode: it is
   * never reached, because the runner that calls it is never constructed.
   */
  group?: boolean | undefined;
}

export class CallSession {
  readonly profile: Profile;
  private readonly stores: FileStores;
  /**
   * The renewable credential. This was `profile.authToken` — a fixed
   * string, which the Credential union defines as "never renew" — so on day 31
   * every `call` and `listen --calls` died at the ws-ticket mint or the
   * handshake while plain `send` and `listen` renewed transparently. ONE
   * object for both the socket dial and the prekey fetch, so their 401s join
   * the same single-flight mint instead of racing into two (every successful
   * auth revokes the previous session — see session.ts constraint 1).
   */
  private readonly auth: AuthSession;
  private readonly ws = new WsClient();
  readonly runner: CallRunner;
  /** Serializes frame handling: concurrent decrypts race the file-backed
   * libsignal stores, exactly as the message listener already documents. */
  private queue = Promise.resolve();
  /** Ordinary chat that arrives while calls are being listened for is a
   * MESSAGE, and must reach the same durable spool `listen` writes to
   *. */
  private readonly log: MessageLog;
  /** Same witness the plain listener uses: a store write failing inside a
   * libsignal decrypt is wrapped beyond type recognition, and without this
   * the tamper branch acks valid frames away over a full disk. */
  private readonly probe: StorePersistenceProbe;
  /**
   * The small-group session layer, or undefined for a 1:1-only client.
   *
   * It shares this class's socket, ratchet, auth and serialization — a
   * separate process per session would prove nothing about the property that
   * matters (call signalling never becomes a message row), and the glare case
   * needs one client that both sends and receives, exactly as the 1:1 gate
   * documents.
   */
  readonly group: GroupCallRunner | undefined;

  /**
   * Settled with the ws close code the first time the connected socket dies
   *.
   *
   * A promise the COMMAND awaits, deliberately NOT a `process.exit` in the
   * close handler (the shape `cmdListen` uses in main.ts). The exit must not
   * happen here because every bounded caller — the timed `listen --calls`,
   * `call`, the e2e gates and the in-process tests — legitimately outlives a
   * close and asserts on session state afterwards; an exit taken this deep
   * would end those processes mid-assertion. The one caller whose contract is
   * "die so the supervisor's restart is the reconnect" (`--seconds 0`) awaits
   * `waitForSocketClose` and turns the code into an exit at the command
   * layer, where that decision belongs.
   */
  private settleSocketClosed!: (code: number) => void;
  private readonly socketClosed = new Promise<number>(resolve => {
    this.settleSocketClosed = resolve;
  });

  constructor(
    readonly name: string,
    private readonly options: SessionOptions = {},
  ) {
    this.profile = loadProfile(name);
    this.stores = new FileStores(name);
    this.probe = probeStorePersistence(this.stores);
    this.auth = new AuthSession(name, this.stores);
    this.log = new MessageLog(name);
    // Retention runs here too. An installation that only ever schedules
    // `listen --calls` appended plaintext and never aged it, so the documented
    // 30-day ceiling held only if some unrelated command happened to run.
    this.log.applyRetention();
    // …and the quarantine ages out on the same cadence as the spool it stands
    // in for.
    pruneUndelivered(name);
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });

    this.runner = new CallRunner(
      {
        send: (peerId, body, urgent) => this.sendEncrypted(peerId, body, urgent),
        writeLog: row => {
          appendFileSync(callLogPath(name), `${JSON.stringify(row)}\n`, { mode: 0o600 });
        },
        now: () => Date.now(),
      },
      name,
    );
    this.runner.canary = options.canary;
    this.runner.expOffsetMs = options.expOffsetMs ?? 0;

    this.group = options.group
      ? new GroupCallRunner(
          {
            send: (peerId, body, urgent) => this.sendEncrypted(peerId, body, urgent),
            sendAcked: (peerId, body, urgent, onMsgId) =>
              this.sendAcked(peerId, body, urgent, onMsgId),
            writeLog: row => {
              appendFileSync(callLogPath(name), `${JSON.stringify(row)}\n`, { mode: 0o600 });
            },
            now: () => Date.now(),
          },
          this.profile.userId,
          name,
          {
            canary: options.canary,
            expOffsetMs: options.expOffsetMs,
            autoAnswer: options.autoAnswer,
            autoDecline: options.autoDecline,
            // The account's ordinary 1:1 runner stays reachable underneath the
            // session, so chat still renders and a plain call still works
            // around one rather than disappearing into the session layer. It
            // is also the other input: a live call on THIS runner is what
            // makes the device busy to an incoming ginvite (group-call.ts,
            // `oneToOneBusy`), the mirror of a live session refusing a stray
            // 1:1 offer.
            fallback: this.runner,
          },
        )
      : undefined;
  }

  /**
   * ONE in-process holder of the ratchet lock, and it is a correctness fix,
   * not a tidiness one.
   *
   * `withFileLockAsync` waits for a contended lock with `sleepSync(25)`
   * (lock.ts) — a SYNCHRONOUS busy-wait, because the lock is a cross-PROCESS
   * device and a process that is waiting for one has nothing else to do. In
   * this class that assumption is false: there are two independent async
   * chains, `queue` (inbound decrypt) and `sendChain` (outbound encrypt), and
   * both take the same lock. When they overlap, the second one blocks the
   * event loop inside `acquire`, so the first — whose release is waiting on an
   * `await` that only the event loop can deliver — can never release. The
   * process wedges for the full LOCK_WAIT_MS and then fails with "another
   * tacendum process is using this account", naming a process that is itself.
   *
   * Reproduced by review: a starter fanning three ginvites out while
   * three peers answer lost its third dial to a ten-second self-deadlock, the
   * session never formed, and the client exited 1. The 1:1 paths can hit the
   * same window — an ICE flush overlapping an inbound answer — and it is a
   * hazard there for the same reason; a group fan-out just makes it likely
   * instead of rare.
   *
   * The fix is one queue in front of the lock, so in-process contention is
   * resolved by ordering rather than by blocking. The file lock is still
   * taken, so the cross-process guarantee it exists for is unchanged; what
   * changes is that this process can no longer be its own contender.
   */
  private ratchetChain: Promise<unknown> = Promise.resolve();

  private withRatchet<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ratchetChain.then(() =>
      withFileLockAsync(this.stores.ratchetLockPath(), fn),
    );
    // Survive a failure, or one error wedges every later ratchet operation for
    // the life of the process — the same rule `sendChain` follows.
    this.ratchetChain = next.catch(() => undefined);
    return next;
  }

  async connect(): Promise<void> {
    this.ws.onFrame(frame => {
      // OUTSIDE the inbound queue, and that is the whole point: a roster delta
      // is most often fanned out from INSIDE `onMessage` (an inbound gjoin is
      // what provokes one), so a receipt queued behind that same handler could
      // not land until the handler that is waiting for it had already
      // finished. Every such delta would burn its full timeout and be scored
      // unacked. A receipt decrypts nothing and touches no store, so it needs
      // none of the serialization the queue exists to provide.
      if (frame.type === 'receipt') {
        const slot = this.pendingReceipts.get(frame.msgId);
        if (slot) {
          // THE KIND IS KEPT, not just the fact. `'sent'` and `'delivered'`
          // are different facts about different things — a queue and a socket
          // — and folding them into one boolean is what let a fan-out's
          // acceptance count be read as a delivery (group-call.ts,
          // `ReceiptKind`).
          slot.kind = frame.state;
          slot.acked = true;
          slot.wake?.();
        }
        return;
      }
      this.queue = this.queue
        .then(async () => {
          if (frame.type === 'error') {
            // Server-chosen strings on their way to a terminal — stripped and
            // bounded with the SAME limits inbound.ts uses for this same frame
            // (64 for the code, 200 for the detail): both are plain
            // `z.string()` in packages/shared, so raw interpolation hands the
            // server ESC bytes and unbounded length on our stderr.
            console.error(
              `server error: ${sanitizeServerField(frame.code, 64)}: ` +
                `${sanitizeServerField(frame.detail, 200)}`,
            );
            return;
          }
          if (frame.type !== 'msg') return;
          if (this.stores.hasSeen(frame.msgId)) {
            this.ws.send({ type: 'ack', msgId: frame.msgId });
            return;
          }
          await this.onMessage(frame);
        })
        .catch(err => {
          console.error(
            `!! frame processing error: ${err instanceof Error ? err.name : 'unknown'}`,
          );
        });
    });
    await this.ws.connect(this.auth);
    // AND THE SOCKET'S DEATH IS A SETTLEMENT, registered the moment there is
    // a socket to register it on (`WsClient.onClose` binds to the CURRENT
    // socket, and `connect()` redials, so this has to come after it — the
    // same ordering `main.ts`'s listener uses). `onClose` is an EventEmitter
    // `on`, so this is additive and no existing close handler is displaced.
    // See `settleReceiptsOnClose` for what it is for.
    this.ws.onClose(() => this.settleReceiptsOnClose());
    // The close is also a FACT the unbounded listener waits on:
    // registered under the same ordering rule as the settlement above, and
    // just as additive — EventEmitter `on`, nothing displaced.
    this.ws.onClose(code => this.settleSocketClosed(code));
  }

  /**
   * Resolves with the ws close code once the socket `connect()` dialled has
   * closed — see `socketClosed` for why this surfaces the close to the caller
   * instead of exiting. Pending forever on a session that never connected: a
   * caller with no socket has none to lose.
   */
  waitForSocketClose(): Promise<number> {
    return this.socketClosed;
  }

  /**
   * Settle every receipt waiter this socket can no longer answer.
   *
   * `sendAcked` had exactly two settlements: the receipt wake, and a timer
   * that is deliberately `unref`'d because a pending receipt must never be
   * the reason a finished CLI keeps running. Neither one fires for a socket
   * that dies AFTER the send and BEFORE its receipt — so the promise stayed
   * pending with no referenced handle behind it, and Node is entitled to exit
   * 0 with `main()` still unresolved. That skips the `finally` the group
   * command relies on: the state persist, the release tombstone, the close.
   * The frame's fate is unknown, the process leaves no record, and the next
   * `gcall` reads a dump that never caught up.
   *
   * A CLOSE IS NOT A RECEIPT: each waiter is settled with the slot's CURRENT
   * kind, which is `null` unless the server had already answered. The one
   * thing this must not do is erase a fact — a slot that IS acked keeps its
   * kind and is left for `sendAcked` to read, because the receipt genuinely
   * arrived and the close afterwards says nothing about it.
   *
   * A slot with no waiter attached yet is DELETED rather than woken: the
   * arming happens inside `sendEncrypted`, before the write, and `sendAcked`
   * only attaches after the send chain resolves, so a close can land in
   * between. `sendAcked` reads an absent slot as `null` — which is the same
   * honest answer — and the delete is also what stops the map growing on a
   * socket that is never coming back.
   */
  private settleReceiptsOnClose(): void {
    for (const [msgId, slot] of this.pendingReceipts) {
      if (slot.acked) continue;
      if (slot.wake) slot.wake();
      else this.pendingReceipts.delete(msgId);
    }
  }

  private async onMessage(frame: {
    msgId: string;
    from: string;
    msgType: 'prekey' | 'ciphertext';
    payload: string;
    ts?: number;
  }): Promise<void> {
    let body: string;
    // The address as it is SHOWN — declared for the WHOLE method, because the
    // success-path chat prints below are just as operator-facing as the
    // failure lines. The raw value still
    // goes to `decryptEnvelope`, which needs the byte-exact ProtocolAddress,
    // and to the spool/quarantine rows, which are data, not terminal output —
    // exactly the split inbound.ts makes. A server-supplied field printed raw
    // can forge its own terminal line (render.ts, sanitizeServerField).
    const shownFrom = sanitizeServerField(frame.from);
    // Per-decrypt evidence, like the plain listener: a stale failure from an
    // earlier frame or a concurrent encrypt on this process's send chain must
    // not reclassify a genuinely tampered frame as local.
    this.probe.arm();
    try {
      // Cross-process ratchet lock: `listen --calls` and a
      // hook-driven `send` share these session files. Through `withRatchet`,
      // because this process's OWN send chain is the other contender and a
      // synchronous wait against ourselves is a deadlock (see there).
      body = await this.withRatchet(() =>
        decryptEnvelope(this.stores, this.profile.userId, frame.from, frame.msgType, frame.payload),
      );
    } catch (err) {
      // ONE classifier for both inbound paths (inbound.ts). This path used to
      // decide for itself — `isIdentityChange`, then `CliError || probe`, then
      // "must be tamper" — and the "must be tamper" tail is what swallowed
      // DuplicatedMessage while `listen` handled it correctly. Nothing here
      // may re-derive a disposition.
      //
      // AND A DISPOSITION IS NOT ONLY A REPORT. The old text here said this
      // branch "only chooses how to report one", and that sentence is what
      // licensed the divergence below: every disposition carries an ACTION
      // (record, ack, purge, quarantine) which must match what inbound.ts does
      // for the SAME disposition, or the two listeners leave the client in
      // different states after identical bytes. `assertAllDispositionsHandled`
      // cannot catch that — it proves each disposition is branched on, never
      // that the branches agree.
      const disposition = classifyDecryptFailure(err, this.probe);
      if (disposition === 'identity-change') {
        // CONSTRAINT: every path that classifies 'identity-change' RECORDS it
        // before warning, and the warning names the command that clears it.
        // `tacendum trust` is destructive, so cmdTrust (main.ts) refuses to run
        // unless `stores.hasIdentityChange(peer)` — the record IS the operator's
        // only route back.
        //
        // The concrete failure this prevents: a bot deployment runs only
        // `tacendum listen bot --calls --auto-answer` (the reason this class
        // exists). alice reinstalls with a new identity key and sends; libsignal
        // raises UntrustedIdentity; this branch printed "withheld" and returned,
        // recording nothing. Withholding the row is right, but `tacendum trust
        // bot alice` then exits USAGE with "no identity change is pending on
        // this client": the pin is never cleared, every subsequent message from
        // alice fails here too, and at the server's 30-day TTL the entire
        // conversation is dropped. Printing the command matters for the same
        // reason — an operator who is never told `tacendum trust` exists cannot
        // guess that running plain `tacendum listen bot` once is the escape.
        //
        // Same order as inbound.ts (record, then warn) on purpose: if the record
        // write fails, the throw reaches the frame-queue catch and NO warning
        // naming `trust` is printed, because a warning that names a command
        // certain to be refused is worse than the raw error.
        this.stores.markIdentityChange(frame.from);
        console.error(
          `!! SAFETY NUMBER CHANGED from=${shownFrom} — message withheld. ` +
            `Verify out of band, then: tacendum trust ${this.name} <their-name>`,
        );
        return;
      }
      // A LOCAL failure is not tamper — the same two shapes inbound.ts names:
      // the ratchet lock refused (CliError, before any ciphertext was read),
      // or a store write failed inside the decrypt, which libsignal wraps in
      // a code-Generic LibSignalErrorBase that only the probe can tell apart
      // from poison. This branch was MISSING here: the mirrored listener had
      // it, so `listen` left the frame queued while `listen --calls` acked
      // the server's only copy away. No ack, no markSeen — it redelivers.
      if (disposition === 'local-failure') {
        // ONE shared description function with the plain listener
        // (`describeLocalFailure`): never `err.message`, whose text — for the
        // store shape, libsignal's wrapper — embeds the failing file path,
        // and the path embeds the account name.
        console.error(
          `!! could not process msgId=${frame.msgId}: ` +
            `${describeLocalFailure(err, this.probe)} — left on the server, will retry`,
        );
        return;
      }
      // THE RATCHET ALREADY CONSUMED THIS CIPHERTEXT, and this branch did not
      // exist here. Kill `listen --calls` after the decrypt durably advanced
      // the ratchet but before the spool append, let the server redeliver the
      // unacked row, and libsignal raises DuplicatedMessage: it fell into the
      // tamper tail below, which acked the row away as "message rejected" —
      // a valid message, lost in a crash window, reported to the operator as
      // an attacker's poison. Same purge, same alarm, same code as `listen`.
      // Nothing rings and no call-log row is written, for the same reason as
      // the tamper branch: there is no plaintext, so there is no call.
      if (disposition === 'ratchet-duplicate') {
        purgeRatchetDuplicate({
          msgId: frame.msgId,
          shownFrom,
          stores: this.stores,
          ws: this.ws,
          log: this.log,
          note: text => console.error(text),
        });
        return;
      }
      if (disposition !== 'undecryptable') assertAllDispositionsHandled(disposition);
      // Tamper or corruption. Ack to purge the poison frame, report loudly,
      // and — the part that check is about — ring nothing and write no
      // call-log row. A call that never decrypted is not a missed call; it is
      // not a call at all, and recording one would put a stranger's cid in a
      // user's history on nothing but an attacker's say-so.
      this.stores.markSeen(frame.msgId);
      this.ws.send({ type: 'ack', msgId: frame.msgId });
      console.error(
        `!! DECRYPT FAILED msgId=${frame.msgId} from=${shownFrom}: ` +
          `${describeUndecryptable(err)} — rejected`,
      );
      return;
    }

    // The server's receipt time is the one clock both ends share, and the
    // reducer uses it to decide whether an invite is too old to ring.
    const serverTs = frame.ts ?? Date.now();
    // ONE entry point per client, chosen at construction. The group runner
    // routes a session envelope to the session reducer, a leg's frame to that
    // leg, and everything else back to `this.runner` — so a group client is a
    // strict superset of a 1:1 one, and a 1:1 client never reaches the group
    // parser at all (SessionOptions.group).
    const wasCall = this.group
      ? await this.group.onBody(frame.from, body, serverTs)
      : await this.runner.onBody(frame.from, body, serverTs);

    // THE ACK MOVED BELOW THIS LINE. It used to fire
    // before anything knew whether the frame was a call, and an ordinary chat
    // arriving during `listen --calls` was printed once and then acked —
    // deleting the server's only copy of a message this process never wrote
    // anywhere. It was absent from `inbox` and from every MCP read, and the
    // ratchet had advanced so it could not be recovered by reconnecting.
    // Call signalling is transport and has nothing to persist; a message does,
    // and it is persisted first, exactly as inbound.ts orders it.
    // NOT `if (!wasCall)`, and the reason is worth keeping even though the
    // runner has since been fixed. `onBody` used to answer TRUE for an
    // envelope it could not parse — which was every NON-call envelope, because
    // parseCallEnvelope validates against the call union and returns null for
    // the rest — so a reply, a photo, a reaction or a vault item was reported
    // as handled, acked, and dropped without even being printed: worse than
    // the behaviour the namespace rule was written to fix. An earlier review moved the runner
    // onto the same namespace rule (`CallRunner.onBody` now answers by prefix,
    // before parsing), so the two agree today. This line does not depend on
    // that agreement: the question that actually matters is whether the body
    // is call TRANSPORT, and `renderBody` answers exactly that, by namespace,
    // before parsing — the same rule the app and plain `listen` use. Deriving
    // it here rather than trusting `wasCall` is what makes the persist-and-
    // print decision independent of how the call layer happens to route.
    // The SAME room renderer the plain listener injects (render.ts's seam):
    // two inbound paths disagreeing about what a room body looks like is the
    // divergence class this file's own history keeps recording.
    const rendered = renderBody(
      body,
      groupBodyRenderer(this.name, this.profile.userId, frame.from),
      mentionNames(this.name, this.profile.userId),
    );
    const isCallTransport = rendered.carrier && rendered.tcm.startsWith('call.');
    // The SAME block gate the plain listener applies: a blocked
    // sender's traffic — 1:1 and room alike, both keyed on frame.from — is
    // decrypted and acked byte-identically, persists nothing and displays
    // nothing. Room state above still applied; see inbound.ts for why the
    // fold must never be forked by a local block list.
    const blocked = isBlocked(this.name, frame.from);

    // `listen --calls` owns the account's queue while it runs, so an owner
    // preference arriving here cannot be left for attachInbound: this path is
    // about to mark the frame seen and purge the relay copy. Apply the same
    // authenticated owner rule before that ack. A fresh frame carrying the
    // same q can then re-ack a lost application response without rebinding it.
    let notifyPreferenceAck: string | undefined;
    if (!blocked) {
      try {
        const applied = applyOwnerNotifyPreference(
          this.name,
          frame.from,
          this.profile.ownerUserId,
          body,
        );
        if (applied !== null) {
          notifyPreferenceAck = composeNotifyPreferenceAck(applied);
        }
      } catch {
        console.error(
          '!! notification preference could not be saved — request not applied; retry from phone',
        );
      }
    }
    // The SAME spool rule the plain listener uses — plain text and replies
    // only. Persisting every non-call body wrote profile cards and reactions
    // into the plaintext spool that ordinary `listen` deliberately keeps out.
    if (maySpool(rendered) && !blocked) {
      try {
        this.log.append({
          id: frame.msgId,
          dir: 'in',
          peer: frame.from,
          // `serverTs` already resolved the optional above — the shared clock
          // both ends agree on, falling back to ours only when the server
          // sent none.
          ts: serverTs,
          tcm: rendered.tcm,
          text: rendered.text,
          read: false,
          ...(rendered.ref ? { ref: rendered.ref } : {}),
          ...(rendered.ofs ? { ofs: rendered.ofs } : {}),
        });
      } catch (err) {
        // PRESERVE, THEN FAIL CLOSED, like the message listener: the ratchet
        // already advanced, so redelivery is a duplicate that gets purged as
        // poison — the quarantine, not the queue, is what makes this message
        // recoverable. No ack, no markSeen; see inbound.ts for the argument.
        const preserved = quarantineUndelivered(this.name, {
          id: frame.msgId,
          dir: 'in',
          peer: frame.from,
          ...(rendered.ref ? { ref: rendered.ref } : {}),
          ...(rendered.ofs ? { ofs: rendered.ofs } : {}),
          ts: serverTs,
          tcm: rendered.tcm,
          text: rendered.text,
          read: false,
        });
        // `localErrno`, never `err.message` — the mirror of inbound.ts's
        // spool-failure note, and the same reason: an fs error's message
        // quotes the spool path, which carries the account name. The
        // `preserved` custody pointer below travels deliberately.
        console.error(
          `!! message log write failed (${localErrno(err)}) — ` +
            `NOT acking msgId=${frame.msgId}` +
            (preserved !== null
              ? `; plaintext preserved at ${preserved}`
              : `; the undelivered quarantine ALSO failed — the line below is the LAST copy`),
        );
        // Prefixed per line like the two prints in `render`: this is the LAST
        // copy of the plaintext, which makes it the site where a peer most
        // wants a forged line and the site where dropping content is least
        // affordable. `prefixLines` costs nothing on a single-line body.
        if (rendered.text !== '') console.log(prefixLines(`[${shownFrom}] `, rendered.text));
        return;
      }
    }

    this.stores.markSeen(frame.msgId);
    this.ws.send({ type: 'ack', msgId: frame.msgId });

    // This application ack is transport, never conversation: it bypasses the
    // spool and rings nothing. `sendAcked` uses this session's live socket,
    // serial send chain and ratchet owner, then waits a bounded five seconds
    // for the server to accept it. The preference is already durable, so a
    // failed response is retried by a fresh owner request with the same q.
    if (notifyPreferenceAck !== undefined) {
      let receipt: ReceiptKind | null = null;
      try {
        receipt = await this.sendAcked(frame.from, notifyPreferenceAck, false);
      } catch {
        // The fixed diagnostic below owns every post-apply failure shape.
      }
      if (receipt === null) {
        console.error(
          '!! notification preference applied; acknowledgement could not be sent — retry from phone',
        );
      }
    }

    if (wasCall) {
      // A SESSION is answered once, by a person — not once per leg — so a
      // group client's auto-answer lives at the session and this per-call one
      // must not also fire: it would answer the starter's leg behind the
      // session's back, which is exactly the camera-before-consent
      // class.
      if (this.group) {
        // owned by GroupCallRunner.maybeAutoRespond
      } else if (this.options.autoAnswer && this.runner.stateName === 'incoming_ringing') {
        await this.runner.accept();
      } else if (this.options.autoDecline && this.runner.stateName === 'incoming_ringing') {
        await this.runner.decline();
      }
      // A non-call envelope the call machine reported as handled has still
      // been persisted above; print it too, so `listen --calls` shows what
      // plain `listen` would.
      if (!isCallTransport) this.render(frame.from, shownFrom, rendered);
      return;
    }
    this.render(frame.from, shownFrom, rendered);
  }

  /**
   * The operator-facing half of a DELIVERED envelope — one that reached the
   * message log — and the one place this class prints one of those.
   *
   * NOT the only line this class puts on stdout, and the difference is worth
   * stating because the previous wording ("the ONE place this class prints
   * one") read as the stronger claim and was cited as one. The quarantine
   * fallback in the frame handler above prints a body too, and it is
   * deliberately not routed through here: it fires when the log append FAILED,
   * so the envelope was never delivered, nothing is acked, and the line being
   * printed is the last copy of that plaintext. Two prints, two different
   * facts. Anything that must hold for every body this class shows — the
   * per-line prefixing, in particular — has to be applied at BOTH, and is.
   *
   * CARRIERS GO TO STDERR. render.ts's rule is that a carrier is a state
   * change and "never on stdout", and `attachInbound` obeys it — a reaction
   * arrives there as a stderr note tagged with its kind. This class printed
   * every non-empty body to stdout with no tag, so the same reaction reached a
   * `listen --calls` consumer as `[peer] reaction x`, indistinguishable from
   * the peer typing that sentence. Anything parsing stdout as conversation
   * read profile cards, edits and read receipts as lines of chat. Two paths disagreeing about what counts as a message on the operator
   * surface is the same divergence class as its siblings above.
   *
   * HUMAN-SHAPED UNDER `--json` TOO, unlike `attachInbound`'s mirror of these
   * same lines, which emits a record. That divergence is REAL and is recorded
   * as an exemption where the `--json` contract is stated (the docblock on
   * `HELP` in main.ts, which lists all four stdout sites): this class has no
   * Reporter, and giving it one would fix half the mode at best —
   * `CallRunner.emit` and `GroupCallRunner.emit` print beside these lines and
   * would still be human, leaving a mixed stream that a JSON reader rejects
   * just as surely.
   */
  private render(rawFrom: string, shownFrom: string, rendered: RenderedBody): void {
    // Blocking: a blocked sender's line dies here, after the ack — nothing
    // about this account's observable behaviour tells them so. Ahead of the
    // profile record below: a blocked peer's display name is a peer mutation
    // this account refused. Same gate, same placement as inbound.ts.
    if (isBlocked(this.name, rawFrom)) return;
    // A profile card is the one fact `contacts` cannot get from a wire
    // address, and this path ACKS it — which destroys the server's only copy
    // and leaves the ratchet refusing redelivery. Recorded before it is
    // printed, and recorded here rather than at the two call sites above for
    // the reason this whole round is about.
    if (rendered.tcm === 'profile' && rendered.peerName) {
      try {
        this.stores.setPeerName(rawFrom, rendered.peerName);
      } catch {
        // A name is a nicety; losing one write costs nothing durable.
      }
    }
    if (rendered.text === '') return;
    // BOTH streams, and every line of both: a peer's newline used to end this
    // program's prefix and start a line the peer wrote entirely — see
    // `prefixLines`. stderr is not the safer one of the pair; the carrier line
    // interpolates the same peer-chosen text (a reaction's emoji, a profile
    // card's name), and a gate or a log shipper reads both streams.
    if (rendered.carrier) {
      console.error(prefixLines(`[${shownFrom}] (${rendered.tcm}) `, rendered.text));
      return;
    }
    console.log(prefixLines(`[${shownFrom}] `, rendered.text));
  }

  /**
   * Encrypt and send, establishing the ratchet session on first contact.
   *
   * DELIBERATELY NOT FOLDED INTO send.ts's `sendEncrypted`, which owns the
   * connect-before-ratchet rule for every notification sender and is where a
   * reader should look before "fixing" this site into a regression
   * (gate.send-owner.test.ts names this exemption). Folding would change the
   * transport: send.ts dials a fresh one-shot 'send'-role socket per delivery
   * and blocks on a server receipt, while call signalling must ride THIS
   * already-open socket (the answer and ICE come back on it), never waits
   * for receipts, and carries the `urgent` bit.
   *
   * THE INVARIANT IS ENFORCED, NOT ASSUMED. An earlier version of this
   * comment claimed connect-before-ratchet "holds by construction" because
   * both commands await `connect()` before the runner acts. An external
   * review disproved that by execution: `connect()` resolving is a fact about
   * the PAST, and a socket that closed afterwards (1006) let `placeCall`
   * fetch a bundle, burn the peer's one-time prekey, advance the local
   * ratchet, resolve, and log CALL sent while ZERO frames left the machine —
   * `ws` drops a `send()` on a closed socket silently, and the peer never
   * received the prekey message the whole session rides on. The runner is
   * also publicly reachable before `connect()` is ever called. So the rule
   * send.ts owns — a dead transport must cost zero ratchet advances — is
   * held HERE by an explicit gate: `assertSocketOpen()` before any ratchet
   * work (the bundle fetch counts: it consumes one of the peer's one-time
   * prekeys), re-asked under the lock (the fetch awaited the network), and
   * asked once more after the encrypt so a close that landed mid-encrypt
   * fails the send LOUDLY instead of reporting success for a frame that was
   * never sent. Residual, stated honestly: a close can land between that
   * last check and the write, or during the encrypt itself — the one
   * in-flight advance is then lost, exactly as send.ts can lose the advance
   * it made between `connect()` and its receipt wait. What cannot happen,
   * on any entry path, is the treadmill: every send that BEGINS against a
   * dead socket fails at the gate having advanced nothing, so a refused or
   * collapsed transport, retried forever, still costs zero advances.
   *
   * SERIALIZED, and that is not defensive tidiness — it is required. Every
   * encrypt advances the Double Ratchet and writes the new session state back
   * to a file-backed store. Two overlapping encrypts read the same state, both
   * produce the same message counter, and the second one the peer sees is
   * rejected as `DuplicatedMessage: message with old counter 2 / 1`.
   *
   * Observed exactly that: ICE batching fires a full envelope immediately and
   * the remainder a moment later, so the two sends overlapped, the peer got
   * ten candidates and threw away the other two, and the loss looked like a
   * batching bug rather than a ratchet one. The listen loop already documents
   * the same hazard on the RECEIVE side; it is symmetric, and the send side
   * had no such guard.
   */
  private sendChain: Promise<unknown> = Promise.resolve();

  /**
   * The gate the docblock above describes: refuse before the ratchet (or the
   * prekey fetch) pays anything for a frame the transport cannot carry. The
   * message is fixed text — no peer id, no account name (fixed-surface rules) —
   * and NETWORK is the honest code: the socket is gone, and reconnecting is
   * the remedy.
   */
  private assertSocketOpen(): void {
    if (!this.ws.isOpen()) {
      throw new CliError(
        EXIT.NETWORK,
        'call socket is not open — refusing to touch the ratchet for a frame that cannot be sent',
      );
    }
  }

  /**
   * Sends whose server receipt somebody is waiting for, by msgId.
   *
   * ARMED BEFORE THE SOCKET WRITE, never after — see `sendEncrypted`. A slot
   * created on the way back from `sendEncrypted` would be racing the server's
   * answer, and the loser is silent: the receipt arrives, finds no slot, is
   * dropped, and the send is scored a failure it did not have. The slot
   * therefore records the ack whether or not a waiter has attached yet, and
   * `wake` is filled in afterwards by whoever waits.
   *
   * There is no bookkeeping of receipts nobody asked for: an untracked send
   * arms nothing, so this map is empty for every 1:1 leg frame.
   */
  private readonly pendingReceipts = new Map<
    string,
    { acked: boolean; kind: ReceiptKind | null; wake: (() => void) | null }
  >();

  /**
   * How long a tracked transport frame waits for the server to say it took it.
   *
   * The receipt is posted the moment the server has QUEUED the ciphertext
   * (`handlers/ws.ts`, `state: 'sent' | 'delivered'`), so this is a round trip
   * to the API and back, not a wait on the recipient's device — an offline
   * peer acks as fast as a live one. Five seconds is therefore a broken-socket
   * budget, not a delivery one, and a timeout is scored as a FAILED send
   * because that is the honest reading: we do not know that the frame arrived.
   */
  private static readonly DELTA_RECEIPT_TIMEOUT_MS = 5_000;

  /**
   * Send, and report whether the SERVER acknowledged taking it.
   *
   * The group session's roster fan-out and the owner preference application
   * ack are the two callers. `sendEncrypted` alone returns once ciphertext has
   * been written to an open socket, which proves only that the frame was
   * attempted. The receipt is the protocol fact that the server accepted it.
   *
   * A refusal is not a receipt: the server answers a rejected send with an
   * `error` frame and returns before the receipt, so a rate-limited or
   * unroutable delta times out here and is counted as the failure it is.
   *
   * AND IT REPORTS WHICH ACK IT GOT. `null` is no receipt inside the budget;
   * `'sent'` is the server holding the frame for a recipient who is not on a
   * socket; `'delivered'` is the server having written it to one that is.
   * This used to be a `boolean`, and the collapse mattered: the group fan-out
   * publishes the count, and a reader — a gate check, in fact — took a full
   * house to mean the frame had reached the participants rather than the
   * server. A claim
   * cannot be narrowed to what an ack proves if the ack's own kind has been
   * thrown away before the claim is made.
   *
   * 1:1 SEND SEMANTICS ARE UNTOUCHED. Every leg frame — offer, answer, ICE,
   * end — still rides `sendEncrypted` unchanged and still waits for nothing,
   * which is the property that docblock exists to protect: call signalling
   * must not block on receipts, and the answer coming back on this socket is
   * what proves the offer landed.
   */
  private async sendAcked(
    peerId: string,
    body: string,
    urgent: boolean,
    /**
     * Called with the transport id the moment it exists, BEFORE the receipt is
     * waited on — the same fact `CallSession`'s 1:1 sends report through `CALL
     * sent … msgid=` (call.ts), for the same consumer. The group gate's leak
     * section binds its scan to "every msgId this section's sender printed",
     * and a roster delta that reached the queue anonymously is a stored payload
     * the scan can silently omit (an earlier review).
     *
     * A SINK RATHER THAN A RETURN VALUE, deliberately: `sendAcked`'s contract
     * is the receipt KIND, and widening it would have every caller and every
     * rig unpack a record to read the thing they already read. Optional, so
     * the settlement suites that drive this method directly are untouched.
     */
    onMsgId?: (msgId: string) => void,
  ): Promise<ReceiptKind | null> {
    let msgId: string;
    try {
      msgId = await this.sendEncrypted(peerId, body, urgent, true);
    } catch {
      // A transport fact. The error object is never inspected — it can embed
      // peer- or server-supplied text (group-call.ts's rule at the fan-out).
      return null;
    }
    // AFTER the send resolved and before anything is awaited: the id names a
    // frame that has been written to an open socket, which is exactly what the
    // 1:1 line claims too. A throwing sink must not cost the delta its receipt.
    try {
      onMsgId?.(msgId);
    } catch {
      // Reporting is never load-bearing for a send.
    }
    const slot = this.pendingReceipts.get(msgId);
    // Armed by the send itself; absent because it was never written, or
    // because the socket closed in the window between the arm and here and
    // `settleReceiptsOnClose` swept it. Both are "no receipt", which is what
    // `null` says.
    if (slot === undefined) return null;
    if (slot.acked) {
      // The receipt beat us back. This is the race the slot exists for.
      this.pendingReceipts.delete(msgId);
      return slot.kind;
    }
    return new Promise<ReceiptKind | null>(resolve => {
      const settle = (kind: ReceiptKind | null): void => {
        clearTimeout(timer);
        this.pendingReceipts.delete(msgId);
        resolve(kind);
      };
      const timer = setTimeout(() => settle(null), CallSession.DELTA_RECEIPT_TIMEOUT_MS);
      // A pending receipt must never be the reason a finished CLI keeps
      // running; the timeout is a bound, not a task.
      timer.unref?.();
      slot.wake = () => settle(slot.kind);
    });
  }

  private sendEncrypted(
    peerId: string,
    body: string,
    urgent: boolean,
    /** Arm `pendingReceipts` for this send's msgId — `sendAcked` only. */
    trackReceipt = false,
  ): Promise<string> {
    const next = this.sendChain.then(async () => {
      // the recorded residual, closed: this is the one `encryptText`
      // caller outside send.ts, held to the same law by the same constant.
      // Refused FIRST — before the socket gate, before the bundle fetch (a
      // one-time prekey, burned server-side), before `establishSession`
      // writes a record, and above all before `encryptText` durably advances
      // the sender chain for a frame the server drops at its own cap: on a
      // one-way ratchet that loss is permanent. Real signalling never
      // approaches the cap, so an over-cap body here is a caller bug — USAGE,
      // send.ts's classification exactly — and the refusal must not depend on
      // transport state, which is why it precedes even `assertSocketOpen`.
      // The sizes ride in the error; the body never does.
      const bodyBytes = Buffer.byteLength(body, 'utf8');
      if (bodyBytes > MAX_BODY_BYTES) {
        throw new CliError(
          EXIT.USAGE,
          `call frame is too large to send (${bodyBytes} bytes; the cap is ${MAX_BODY_BYTES} bytes)`,
        );
      }
      // BEFORE the session peek and the bundle fetch: the fetch consumes one
      // of the peer's finite one-time prekeys server-side, so a dead socket
      // must stop the send before even that (send.ts's setup story: burning
      // prekeys against a transport that never delivers).
      this.assertSocketOpen();
      // The bundle FETCH stays outside the lock — it is network I/O, and the
      // lock is never held across the network (stores.ts). The bundle is
      // only a read; nothing is mutated until inside the lock below.
      let bundle: PrekeyBundle | null = null;
      if (!(await hasSession(this.stores, peerId))) {
        bundle = await apiGetPrekeyBundle(this.auth, peerId);
      }
      const { msgType, payload } = await this.withRatchet(
        async () => {
          // Re-asked with the lock held: the fetch above and the lock wait
          // both awaited, and a close in either window would otherwise let
          // the establish/encrypt below advance a ratchet no frame can ride.
          this.assertSocketOpen();
          // The bootstrap is a session-store WRITE and takes the lock like
          // every other ratchet mutation (main.ts cmdSend got this
          // earlier; this path did not). Unlocked, its save could land
          // after a concurrent locked decrypt's and overwrite that chain
          // advance — after which the peer's valid frames fail to decrypt
          // and the generic catch above acks them away as poison.
          // Re-checked UNDER the lock: between the unlocked peek and here,
          // this very session may have been established by an inbound prekey
          // frame on this process's own queue (or by another process), and
          // re-running processPreKeyBundle over it would fork the ratchet
          // the lock just protected. The stale bundle merely cost one
          // one-time prekey fetch.
          if (bundle !== null && !(await hasSession(this.stores, peerId))) {
            try {
              await establishSession(this.stores, this.profile.userId, bundle);
            } catch (err) {
              // The OUTBOUND half of the identity-change rule. `establishSession`
              // now does the recording — it is the site that raises, so no call
              // site can forget — but a calls-only daemon still has to SAY what
              // happened. Without this the operator sees a bare libsignal error
              // and never learns that `tacendum trust` is the escape, which is
              // the same dead end the inbound branch above was fixed for.
              //
              // Conditional on the RECORD, not on the error's type, because the
              // two can disagree: `establishSession` wraps its record write in
              // a bare try/catch (messaging.ts) and rethrows the safety error
              // either way, so `isIdentityChange(err)` alone cannot prove the
              // record landed. cmdTrust (main.ts) refuses unless
              // `stores.hasIdentityChange(peer)` — asking that exact predicate
              // here is what makes this the same rule as the inbound branch
              // above (record, then warn): when the record is missing, the raw
              // error propagates and NO line names `trust`, because a warning
              // that names a command certain to be refused is worse than the
              // raw error. `hasIdentityChange` cannot itself throw — a corrupt
              // or unreadable marker file reads as empty (stores.ts), which
              // fails toward silence, the same direction as a failed record.
              if (isIdentityChange(err) && this.stores.hasIdentityChange(peerId)) {
                console.error(
                  `!! SAFETY NUMBER CHANGED for ${sanitizeServerField(peerId)} — refusing to send. ` +
                    `Verify out of band, then: tacendum trust ${this.name} <their-name>`,
                );
              }
              throw err;
            }
          }
          return encryptText(this.stores, this.profile.userId, peerId, body);
        },
      );
      // The advance has now happened. If the socket died during the encrypt,
      // `ws.send` below would be dropped SILENTLY (sendAfterClose is an
      // 'error' event the permanent absorber swallows) and this method would
      // return a msgId for a frame that never existed on the wire — the exact
      // false success the gate reproduced. The in-flight advance is already
      // lost either way; what this check decides is whether the caller is
      // told the truth.
      this.assertSocketOpen();
      const msgId = ulid();
      // Armed BEFORE the write, for the reason `pendingReceipts` states: the
      // server's receipt can be on the socket in the very next turn.
      if (trackReceipt) this.pendingReceipts.set(msgId, { acked: false, kind: null, wake: null });
      try {
        // notify:false on EVERY frame this method sends, because every frame is
        // non-conversational transport: call signalling or the exact owner
        // preference application ack. Ordinary messages never come through
        // here (send.ts owns those). It is the CLI mirror of
        // the app's one derivation: isCarrierEnvelope treats all `call.*` as
        // carrier, so app/src/messaging.ts stamps notify:false on every call
        // frame at its send choke point. The server reads this bit to decide
        // correspondence — `urgent !== true && notify !== false`
        // (packages/server/src/handlers/ws.ts) — and without it the reducer's
        // AUTOMATIC responses (call.ringing on any inbound offer, call.end
        // r=busy when a second offer lands mid-call) were non-urgent frames
        // with no notify bit, which the server read as user-authored
        // correspondence a stranger could induce with no victim action —
        // minting the very ring-budget / stranger-queue exemption those limits
        // exist to withhold (an earlier review, NEW HIGH 4). It also spares an offline
        // recipient a "new message" banner for call transport: an urgent offer
        // still rings (the urgent branch is independent of notify), the rest go
        // quiet, exactly as on the app.
        this.ws.send({ type: 'send', to: peerId, msgId, msgType, payload, urgent, notify: false });
      } catch (err) {
        // Nothing was written, so nothing will ever be receipted for this id.
        // Left behind, the slot would be a leak on a socket that throws.
        this.pendingReceipts.delete(msgId);
        throw err;
      }
      return msgId;
    });
    // The chain must survive a failed send, or one error wedges every
    // subsequent envelope for the life of the process.
    this.sendChain = next.catch(() => undefined);
    return next;
  }

  /** Trickle `count` fixture candidates through the batcher. */
  async trickle(count: number): Promise<void> {
    for (let i = 0; i < count; i++) this.runner.queueIce(fixtureCandidate(i));
    await this.runner.flushIce();
  }

  /**
   * Announce a departure before the socket goes, when one is owed.
   *
   * A process that simply exits is a crash, and the whole content is that a
   * starter's exit must be an ANNOUNCED out — the frame is what ends the call
   * for everyone else. Awaited by the command, before `close()`, so the
   * gleave and the per-leg ends are on the wire while the socket is still
   * open. A client with no live session owes nothing and this is a no-op.
   */
  async leaveGroup(): Promise<void> {
    if (this.group?.live) await this.group.leave().catch(() => undefined);
  }

  /**
   * Add a member to the live session (the late join).
   *
   * A sibling of `leaveGroup` and a flag for the same reason (`runTimed`'s
   * docblock): a session lives inside ONE connected process, so a separate
   * `tacendum add` process could only address a session it is not in. Only
   * the starter may grow a roster and only outside the ringing phase — both
   * are `groupSessionReducer`'s verdicts, asked and obeyed, which is why
   * there is no check for either here. A client holding no session at all
   * owes nothing and this is a no-op.
   */
  async addToGroup(peerId: string): Promise<void> {
    if (this.group?.live) await this.group.addParticipant(peerId);
  }

  close(): void {
    this.group?.dispose();
    this.runner.dispose();
    this.ws.close();
    // AND HERE TOO, not only from the close handler. `ws.close()` STARTS a
    // closing handshake — the 'close' event arrives later, and on the exit
    // path of a foreground command it may not arrive at all, because the
    // caller's `finally` is the last thing before the process ends. A waiter
    // stranded here is the same defect as one stranded by a 1006, arriving
    // through the teardown this class itself performed.
    this.settleReceiptsOnClose();
  }
}
