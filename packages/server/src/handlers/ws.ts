import { ulid } from 'ulid';
import {
  AckFrame,
  ClientFrame,
  type AccountsNoticeFrame,
  type MsgFrame,
  type ReceiptFrame,
  type SendFrame,
  type ServerFrame,
  type TypingFrame,
  type TypingMsgFrame,
  type WsTicketRole,
} from '@tacendum/shared';
import type { Deps } from './http.js';
import {
  QueuedQuotaExceededError,
  QueueGroupReachRevokedError,
  QueueParticipantTombstonedError,
  type ConnectionRecord,
  type DataLayer,
  type GroupQuotaContext,
  type GroupReachPin,
  type UserRecord,
} from '../db/data.js';
import type { SessionGuard } from './session-guard.js';
import { LIMITS } from '../ratelimit.js';
import { ACTIVITY_TOUCH_TIMEOUT_MS, touchHumanActivity } from '../activity.js';

/**
 * Lambda-shaped WebSocket events (invariant). Mirrors API Gateway's
 * WebSocket event shape closely enough that the Lambda entry is a thin
 * mapping. `senderUserId` corresponds to the authorizer principal that API GW
 * would attach in requestContext; the local adapter fills it from its own
 * connectionId -> userId map.
 */
export interface WsConnectEvent {
  routeKey: '$connect';
  connectionId: string;
  queryStringParameters?: Record<string, string | undefined>;
  /**
   * Set when the TRANSPORT has already authenticated this connect, which on AWS
   * is always: API Gateway runs the Lambda authorizer before the integration
   * and attaches its principal as `requestContext.authorizer.userId`.
   *
   * It exists because a single-use credential cannot be spent twice. The
   * authorizer consumes the ticket to make its decision; if $connect then
   * re-ran authentication it would look up a ticket that its own authorizer had
   * already deleted and refuse the connection it had just authorized. Every
   * ticket would authorize exactly zero connections — the change inverted
   * rather than merely broken.
   *
   * Absent on the local adapter, which has no separate authorizer stage and so
   * authenticates inline, here, exactly once.
   */
  authorizedUserId?: string;
  /**
   * The ticket's role, carried across from the authorizer alongside
   * `authorizedUserId` and for the same reason: the authorizer SPENT the
   * ticket, so this route cannot read the row that held it.
   *
   * Absent means 'listen'. That covers the local adapter (which authenticates
   * inline and fills the role from `consumeWsTicket` itself) and a connection
   * authorized by a previous deploy's authorizer, and it fails toward a
   * listener that still receives rather than one that silently stops.
   */
  authorizedRole?: WsTicketRole;
  /**
   * The digest of the session that opened this socket carried across
   * from the authorizer alongside `authorizedUserId` for the same reason: the
   * authorizer SPENT the ticket, so this route cannot read the row that held
   * it. Written onto the connection row so revocation can bind socket→session.
   * Absent on the local adapter (which fills it inline from `consumeWsTicket`).
   * On a session-enforcing host a connect that resolves NO digest is refused
   * outright — an unbindable socket would be one no revocation can reach.
   */
  authorizedSessionDigest?: string;
}

export interface WsDisconnectEvent {
  routeKey: '$disconnect';
  connectionId: string;
  senderUserId: string;
}

export interface WsMessageEvent {
  routeKey: '$default';
  connectionId: string;
  senderUserId: string;
  body: string;
  /**
   * The digest of the session that opened this socket which the
   * `$default` recheck matches against a possibly-revoked session. On AWS it
   * is the `sessionDigest` API Gateway cached in the authorizer context for
   * the connection's life — no per-frame DB read to obtain it; the local
   * adapter fills it from its own connect-time map. A frame WITHOUT one is
   * refused and its socket torn down on a session-enforcing host — digestless
   * fails closed (see wsDefaultHandler).
   */
  sessionDigest?: string;
}

export interface WsResult {
  statusCode: number;
  /** Set by $connect so the host can bind the socket to a user. */
  userId?: string;
  /**
   * The digest of the session that opened this socket set by $connect so
   * a host WITHOUT an authorizer context can remember it and attach it to the
   * socket's later $default frames. The AWS host ignores this — it re-reads the
   * digest from the cached authorizer context per frame; the local adapter uses
   * it, because it authenticates inline and has no such context.
   */
  sessionDigest?: string;
}

/**
 * Transport-side message push — the local adapter implements it over `ws`
 * sockets; in AWS it becomes ApiGatewayManagementApi.postToConnection.
 * Resolves false when the connection is gone (stale row).
 */
export interface WsSender {
  post(connectionId: string, frame: ServerFrame): Promise<boolean>;
}

export interface WsDeps extends Deps {
  db: DataLayer;
  sender: WsSender;
  /**
   * Transport-side scheduling of the post-$connect queue drain. API Gateway
   * does not establish the connection until the $connect integration completes,
   * so posting frames from inside $connect would 410 on every reconnect. The
   * AWS adapter therefore async-invokes a drain Lambda that waits for the
   * handshake and then runs `drainQueuedMessages`; the local adapter's socket
   * is already live, so it awaits `drainQueuedMessages` inline.
   *
   * Deliberately called BEFORE the connection row is touched. This is the one
   * call on the connect path that can stall in SDK retries, and while it sat
   * between the row write and $connect returning, the row was visible to
   * every other $connect for seconds while API Gateway still could not
   * deliver to the socket it named — a reconnect that probed in that window
   * got Gone from a healthy connection and displaced it. The drain worker
   * never needs the row: it polls the management API for the handshake and
   * posts to the connectionId it was handed (ws-drain.lambda.ts).
   *
   * THE INVARIANT EVERY HOST OWES, and the reason the name is `scheduleDrain`
   * rather than `drain`: the drain's QUEUE SNAPSHOT must be taken at or after
   * the instant this connection becomes visible to the send path — i.e. after
   * `acquireConnectionRow` below has committed the row. This call site is
   * BEFORE that instant, so a host that DRAINS here instead of SCHEDULING
   * loses every message enqueued between the snapshot and the row write:
   * `handleSend` reads no connection row, so it queues and answers 'sent',
   * and the drain has already walked past the queue's tail with nothing left
   * to re-run it. Only the two paths together cover the queue, and they only
   * cover it if they overlap.
   *
   * AWS satisfies this for free — the async invoke returns immediately and the
   * drain Lambda waits for the handshake, which API Gateway does not complete
   * until $connect returns. The local adapter satisfies it by PARKING the
   * drain and running it after the connect answers 200 (local/ws.ts). An
   * implementation that runs it inline here does not satisfy it, whatever the
   * host's handshake looks like.
   */
  // `sessionDigest` rides along so the drain can validate the socket's
  // bound session before delivering, re-validate on each self-scheduled
  // continuation (S2b/#5), and re-validate on the in-slice cadence. A drain
  // with no digest is refused by the AWS drain Lambda (digestless fails
  // closed); on an enforcing host the connect is refused before this runs.
  scheduleDrain(userId: string, connectionId: string, sessionDigest?: string): Promise<void>;
  /**
   * Transport-side scheduling of a VoIP wake. Same shape and same reason as
   * `scheduleDrain`: the AWS adapter async-invokes a push Lambda so the
   * message path never waits on Apple, while the local adapter runs it inline
   * because nothing there can freeze mid-flight. One implementation
   * (`deliverPushWake`), two schedulers.
   */
  schedulePush(
    recipientId: string,
    senderUserId: string,
    kind?: 'call' | 'message',
    message?: { msgId: string; msgType: string; payload: string; ts: number },
    verify?: { msgId: string; ackGraceMs: number },
    /** The per-schedule ring claim (see `wakeRecipient`). Optional on the
     * type, always supplied by the one caller — absence is what an event
     * minted before this landed looks like to the worker. */
    wakeId?: string,
  ): Promise<void>;
  /**
   * The per-frame session guard. BOTH shipped hosts set it
   * (aws/ws.lambda.ts and local/ws.ts, unconditionally); when it is present
   * the handlers enforce sessions fail-CLOSED — a frame, dial, delivery or
   * drain with no session digest is refused rather than waved through.
   * Optional ONLY as a unit-test seam: a harness that is not exercising
   * session enforcement may omit it and gets the unbound-ticket behaviour. See
   * `session-guard.ts` for the exposure bound and why a positive verdict is
   * never cached.
   */
  sessionGuard?: SessionGuard;
}

/** Message queue TTL: undelivered ciphertext expires after 30 days. */
export const MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How old a connection row must be before a failed post may reap it. In the
 * AWS host the row becomes visible while API Gateway is still establishing
 * the socket ($connect finishes, then the handshake completes), and a post in
 * that window fails exactly like a dead socket — deleting the row then would
 * blackhole a healthy connection (sends would queue but never post, and no
 * drain re-runs without another $connect). Sized well past the drain worker's
 * ~4.7 s probe budget plus async-invoke latency; younger rows are left for
 * the next reconnect to overwrite.
 */
export const CONNECTION_REAP_GRACE_MS = 30_000;

/**
 * How long the ring probe waits for the recipient's ACK before concluding that
 * the socket which took the bytes is not attached to a running process
 * (push-worker.ts, `verify`).
 *
 * THREE seconds, and the asymmetry is the whole argument. Too LONG costs only
 * ring latency for a callee who today receives nothing at all while the caller
 * stares at "Calling…" for its full 45-60 s timers — three seconds against
 * that is invisible. Too SHORT fires a redundant VoIP push at a peer whose ack
 * was merely slow (a cold $default invocation is most of a second by itself),
 * and the cost of THAT is a CallKit report nothing will ever dismiss: a
 * 75-second ghost ring. One side of the trade is latency nobody can see; the
 * other is a phantom full-screen call. Err long.
 */
export const URGENT_ACK_GRACE_MS = 3_000;

/**
 * How many read-probe-claim passes $connect makes before it stops trying to
 * own the row.
 *
 * Each pass is a WHOLE fresh decision — re-read the row, re-probe whoever
 * holds it, re-claim — never a retry of a verdict already formed. The bound
 * exists only so a pathologically contended account cannot spin: a refused
 * claim means some other $connect wrote the row microseconds ago, so the next
 * pass reads a fresh row and terminates on evidence. Three passes is far past
 * any interleaving two dialling clients can produce; the give-up path is the
 * same row-less proceed the live-incumbent path takes.
 *
 * NOT a timeout, and deliberately not expressed as one: nothing here waits,
 * and no branch below infers a connection's state from elapsed time. That
 * inference is what this file used to do (a 2 s settle followed by a second
 * probe, read as "still Gone, therefore dead rather than still establishing")
 * and it cannot be made sound at any duration — a $connect whose row write
 * applies but whose SDK response is delayed keeps API Gateway from
 * establishing the socket for as long as the delay lasts, so the settle is
 * out-waitable by construction and the connection it was protecting is
 * displaced anyway, believing it succeeded.
 */
const CLAIM_ATTEMPTS = 3;

/**
 * Who is dialling this socket — by single-use ticket, and by NOTHING else
 * *
 * The ticket is minted over HTTPS, lives sixty seconds, and is spent by a
 * conditional delete inside `consumeWsTicket`, so the value that ends up in a
 * proxy log is already worthless.
 *
 * The transitional `?token=` branch that used to follow the ticket check is
 * DELETED, and must never come back: it accepted the 30-day bearer from the
 * one place proxies, access logs and crash reporters write down — the exact
 * defect the ticket exists to remove. It lived for the one deploy the
 * migration needed; no released client exists (v1.0 has not shipped) and both
 * clients dial ticket-first, so a dial presenting `?token=` is now refused
 * exactly like a dial presenting nothing.
 */
async function authenticateConnect(
  event: WsConnectEvent,
  deps: WsDeps,
): Promise<{ userId: string; role: WsTicketRole; sessionDigest?: string } | undefined> {
  // Already authenticated upstream (AWS: the API Gateway authorizer, which also
  // spent the ticket). Re-authenticating here would consume it a second time
  // and fail. The session digest rides across in the context alongside the
  // principal for the same reason: the authorizer spent the ticket, so
  // this route cannot re-read it.
  if (event.authorizedUserId) {
    return {
      userId: event.authorizedUserId,
      role: event.authorizedRole ?? 'listen',
      ...(event.authorizedSessionDigest !== undefined
        ? { sessionDigest: event.authorizedSessionDigest }
        : {}),
    };
  }

  // An absent or empty ticket is a refusal — there is no other scheme to fall
  // through to. `?token=<anything>` lands here too, and lands as what it now
  // is: a dial with no credential this route accepts.
  const ticket = event.queryStringParameters?.ticket;
  if (!ticket) return undefined;
  const spent = await deps.db.consumeWsTicket(ticket, Math.floor(deps.now() / 1000));
  // The SCHEME, never the credential — the log rule is about the value, and which
  // door was used is not the value. Kept after the token branch's removal so
  // the connect metric stays continuous, and because a `token` line ever
  // reappearing here is the alarm that the deleted path has come back. It
  // also keeps the e2e gates honest: without it the ticket path could
  // silently stop working with every gate still green — which is exactly
  // what happened once already.
  if (spent) deps.log('ws_connect_auth', { scheme: 'ticket', role: spent.role });
  return spent;
}

/**
 * Is the socket the connection row points at still taking bytes?
 *
 * Posting is the only liveness signal the transport exposes, and $connect MAY
 * post here: the "never post from $connect" rule (ws.lambda.ts) is about the
 * CONNECTING socket, which API Gateway has not established yet — the incumbent
 * is an established connection, the same kind every $default posts to, and the
 * one Lambda serving all three routes already holds the ManageConnections
 * grant $default needs.
 *
 * The probe must be a frame every shipped client discards. Of the three
 * ServerFrame types: an error frame ABORTS a concurrent send from this same
 * account (the CLI's `waitFor` reads any error in its window as the answer to
 * its send), a msg frame would fabricate a message, and a receipt whose msgId
 * nothing is waiting on takes the replayed-receipt path both clients already
 * tolerate — the CLI matches receipts by msgId, the app's outbox lookup misses
 * and moves on. A fresh ULID cannot collide with a real in-flight send, and it
 * parses as a legal frame instead of tripping client-side schema validation.
 *
 * Tri-state on purpose: `post` resolving false is the only evidence of death
 * (the transport maps GoneException to false); a thrown fault is evidence of
 * nothing.
 */
type IncumbentLiveness = 'live' | 'gone' | 'unknown';

async function probeIncumbent(connectionId: string, deps: WsDeps): Promise<IncumbentLiveness> {
  try {
    return (await deps.sender.post(connectionId, { type: 'receipt', msgId: ulid(), state: 'sent' }))
      ? 'live'
      : 'gone';
  } catch {
    // A throttle, a 5xx or a misconfigured management endpoint says nothing
    // about the incumbent. This used to read as "dead", which converted a
    // control-plane blip into a displacement: the live listener lost its row,
    // its connectionId then existed nowhere the handlers could reach, and
    // every message queued toward the 30-day TTL. And while the management
    // plane is genuinely broken, nobody can be posted to no matter who holds
    // the row — so displacing on a fault gains nothing even in the case the
    // old behavior was meant to serve. A probe fault still never fails the
    // $connect it rides on: the caller spares and proceeds.
    return 'unknown';
  }
}

/**
 * What this $connect ended up holding:
 *  - 'owned'       — the row names THIS connection. The only outcome that
 *                    routes live inbound traffic to this socket.
 *  - 'live'        — another connection holds it and answered a probe. The
 *                    account is reachable; this socket is not.
 *  - 'probe_error' — another connection holds it and the transport would not
 *                    say whether it is alive. Nothing is displaced on
 *                    ignorance.
 *  - 'contended'   — the row was rewritten under this connect on every pass.
 *  - 'displaced'   — the claim SUCCEEDED and a later consistent re-read found
 *                    the row already naming somebody else. See the re-read in
 *                    `wsConnectHandler` for the interleaving that produces it.
 */
type RowOutcome = 'owned' | 'live' | 'probe_error' | 'contended' | 'displaced';

/**
 * Decide who owns the user's single connection row, and write it when that is
 * this connection.
 *
 * CONSTRAINT: an incumbent is displaced only on EVIDENCE that it is not
 * taking bytes (a post that came back Gone), and this connection settles for
 * being row-less only on EVIDENCE that the row's holder is taking them (a
 * post that came back OK). Nothing here may infer either fact from elapsed
 * time, and nothing here may treat a refused claim as evidence about whoever
 * won it.
 *
 * ONLY LISTENERS REACH THIS FUNCTION. A one-shot `send` declares role 'send' on
 * its ticket and returns before the caller gets here, which is what dissolved
 * the failure that originally shaped this loop: a one-shot and a long-lived
 * `listen` dialling together with no row present, the one-shot's conditional
 * Put landing first, and the listener being told 200 on the argument that "the
 * winner's row was written by its own $connect moments ago, so delivery routes
 * to a socket as fresh as this one". A refused claim says only that the row
 * changed, never that the new holder will keep it — and that winner sent its
 * frame and disconnected, deleting the only row the account had. Both parties
 * that remain here are long-lived and redial, which is what makes standing down
 * a survivable outcome rather than a silent outage.
 *
 * Going back around after a refused claim still earns its keep: by the time
 * this connect re-reads, an incumbent that was leaving is usually already gone
 * and the claim succeeds.
 *
 * A refused claim is also how the store answers a Put whose response was lost
 * and whose retry then failed its own `attribute_not_exists` condition — the
 * row is OURS and the caller has been told "no". Only the re-read can tell
 * the two apart, and it does: the next pass sees its own connectionId and
 * claims it (a no-op CAS that just refreshes connectedAt).
 */
async function acquireConnectionRow(
  userId: string,
  connectionId: string,
  deps: WsDeps,
  sessionDigest: string | undefined,
): Promise<RowOutcome> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const incumbent = await deps.db.getConnection(userId);
    // Set when THIS pass decided to displace the incumbent on session
    // identity instead of a probe verdict; logged only if the claim below
    // actually lands, so the live event counts displacements, not intents.
    let sameSessionTakeover = false;
    if (incumbent !== undefined && incumbent.connectionId !== connectionId) {
      // A DIGESTLESS incumbent is not probed and never spared on an enforcing
      // host: every legitimately-written row carries its session digest, so a
      // row without one is a socket no revocation can match — and a live
      // probe answer from it would let that unrevocable socket hold the
      // account's routing row and 503 every legitimate reconnect, forever.
      // Fall through to the claim: the CAS below displaces exactly the row
      // that was read, so a racing legitimate writer still wins.
      if (deps.sessionGuard === undefined || incumbent.sessionDigest !== undefined) {
        // SAME-SESSION TAKEOVER: when the row's
        // holder was opened by the SAME session now dialling, skip the probe
        // and fall through to the claim — the newer socket of the same device
        // displaces its own ghost atomically. The probe is this case's blind
        // spot, not its safeguard: a suspended phone's half-open socket still
        // ACKs at the kernel while the app above it is frozen, so the probe
        // reads 'live', the redial is 503-refused, the client backs off and
        // redials — and each redial's probe RESETS API Gateway's 10-minute
        // idle timer on the ghost. The retry loop is the ghost's keepalive,
        // worst case to the 2 h hard cap, with the account unroutable the
        // whole way. One session is one device holding one socket at a time,
        // so a second dial from that session is itself the evidence the first
        // socket is not serving it. IDENTITY evidence, never elapsed time —
        // the CONSTRAINT above stands and no clock is read. Both digests must
        // be PRESENT and equal: a digestless dial or a digestless incumbent
        // takes the probe path (or the digestless displacement) unchanged,
        // and cross-session contention — two devices, two sessions — still
        // probes and still spares a live incumbent. Nor is the DIALLING
        // socket taken on faith: its digest reaches here only through the
        // ticket's own chain — bound at the HTTPS mint from the presented
        // bearer, re-verified against the live session when the single-use
        // ticket was SPENT (consumeWsTicket / the authorizer), and validated
        // once more by the post-ownership revalidation arm before this handler
        // answers 200. The active call elided here is the INCUMBENT's, and
        // on this path the incumbent's digest IS the dialler's — the same
        // session those three checks just authenticated. What identity
        // equality does hand a bearer THIEF is eviction of the victim's live
        // socket — but a stolen bearer is a stolen session, which already
        // reads the whole queued backlog on any connect (the unconditional
        // drain above) and mints tickets at will; the remedy is revocation
        // which every arm here enforces, not a probe that also kept the
        // victim's own phone locked out. The displaced ghost gets
        // exactly what every other CAS displacement gives the loser: its row
        // is replaced by the conditional Put and nothing posts to or closes
        // its socket — with nothing left probing it, API Gateway's own idle
        // timer finally reaps it, and its eventual $disconnect's conditional
        // delete cannot touch the row it no longer holds.
        sameSessionTakeover =
          sessionDigest !== undefined && incumbent.sessionDigest === sessionDigest;
        // VALIDATE THE INCUMBENT'S OWN SESSION before sparing it as live
        //. A revoked incumbent is deaf and mute to real traffic —
        // its $default frames are refused and live delivery to it is withheld —
        // but its raw transport can still ACK a probe post, so probing FIRST
        // would read a dead-but-open socket as 'live', spare it, and 503 every
        // legitimate reconnect: the revoked row would deny the real user their
        // socket until the attacker's socket finally closed. When the guard says
        // the incumbent's session is gone, skip the probe entirely and fall
        // through to the claim, whose CAS displaces exactly the row that was
        // read. Strongly consistent (the guard never caches a positive), so a
        // revoke seconds old is observed here. Only reachable with a digest in
        // hand — a digestless incumbent never enters this block (the outer
        // condition is false for it) and is displaced without a probe already.
        const incumbentRevoked =
          !sameSessionTakeover &&
          deps.sessionGuard !== undefined &&
          incumbent.sessionDigest !== undefined &&
          !(await deps.sessionGuard.active(incumbent.sessionDigest, deps.now()));
        if (!sameSessionTakeover && !incumbentRevoked) {
          // Probe before displacing. The write used to be an unconditional Put,
          // and any second dial from an account with a live `listen` was enough
          // to unroute the listener for good: the newcomer's $connect overwrote
          // the listener's row, and once a row is displaced the old connectionId
          // exists nowhere the handlers can reach. Liveness therefore has to be
          // decided here, before the write.
          const liveness = await probeIncumbent(incumbent.connectionId, deps);
          // The incumbent just took bytes: sparing it keeps the account
          // routable, and this socket does not need the row to send, ack or
          // receive its own drain (all of those post to the event's own
          // connectionId).
          if (liveness === 'live') return 'live';
          // A fault is not a verdict. Reading it as "dead" turned a management-
          // plane throttle into a displacement — the live listener lost its row,
          // its connectionId existed nowhere afterwards, and the account went
          // silent for 30 days. Ignorance therefore leaves the row where it is.
          if (liveness === 'unknown') return 'probe_error';
          // 'gone' falls through to the claim: whatever the reason a socket
          // refuses bytes — crashed, or not yet established — it is not
          // carrying this account's traffic, and the claim below is a
          // compare-and-swap against the exact row that was probed, so a
          // verdict that went stale mid-probe loses instead of overwriting the
          // winner.
        }
      }
    }
    if (
      await deps.db.claimConnection(
        {
          userId,
          connectionId,
          connectedAt: deps.now(),
          // Bind the row to the session that opened it so revocation can
          // find and tear down this exact socket. Omitted for a legacy dial
          // that carries no digest — that socket is not session-revocable.
          ...(sessionDigest !== undefined ? { sessionDigest } : {}),
        },
        incumbent?.connectionId,
      )
    ) {
      // Field-free: the event is routing metadata, and everything a
      // responder needs — that ghosts are being displaced instead of spared —
      // is the count. Logged on the LANDED claim only, never on the intent: a
      // takeover pass whose CAS lost re-reads a fresh row next pass. What the
      // count MEANS, precisely: same-session redials that would have been
      // probed (and spared) under the old rule and instead
      // claimed the row. It is not proof a row was physically overwritten —
      // the ghost's own $disconnect can land between the read and this CAS,
      // which then succeeds on the ABSENT row. Distinguishing the two would
      // cost ReturnValues plumbing through the store's arbitration primitive
      // to sharpen a diagnostic that answers the same operational question
      // either way (is the takeover path taking?), so the coarser count
      // stands, documented.
      if (sameSessionTakeover) deps.log('ws_connect_same_session_takeover');
      return 'owned';
    }
  }
  return 'contended';
}

/**
 * The refusal a row-less LISTENER gets, and the whole promotion path for one.
 *
 * CONSTRAINT: a live listening socket must never be left row-less. Nothing can
 * reach a row-less connectionId afterwards — it is deliberately stored nowhere
 * — so if such a socket is allowed to establish, the only repair is the client
 * noticing, and a healthy socket gives a client nothing to notice. Refusing the
 * handshake is what turns "you are connected and will silently receive nothing,
 * possibly forever" into "you are not connected, try again", which every client
 * already knows how to act on.
 *
 * BOTH clients redial it, which is why the refusal is back after being deleted:
 *  - app/src/ws.ts — a non-200 from $connect refuses the upgrade, RN reports
 *    1006 with `openedAt === null`, `refused` is true, it spends one auth check,
 *    gets verdict 'blip' and goes to `scheduleReconnect` with exponential
 *    backoff. `connect()` mints a FRESH ticket per dial, so the redial is a new
 *    single-use credential and a whole new arbitration.
 *  - packages/cli/src/wsclient.ts — redials a bounded number of times on this
 *    status (and on the local host's 1013 close, which is how the local adapter
 *    reports it), each with a fresh ticket. It used to classify a 503 as
 *    EXIT.NETWORK and exit, which is what the deleted-comment claim "No client
 *    performs it" was generalised from — after checking that one client and not
 *    the app.
 *
 * The 503 is never sent to a 'send' role: a one-shot needs no row, so there is
 * nothing for it to be refused over.
 */
const CONNECT_REFUSED_STATUS = 503;

/**
 * $connect — authenticate the `?ticket=` (transitionally `?token=`), hand the
 * queue drain to the transport's scheduler, then, for a LISTENING dial only,
 * arbitrate the single connection row.
 *
 * A 'send' dial stops after the drain. It never reads the row, never probes the
 * holder, never claims, and is never refused — and because it never claims, its
 * $disconnect cannot delete anybody's row either: `deleteConnection` is
 * conditional on the row still naming the exact connectionId being torn down,
 * and a connection that never wrote the row can never satisfy that condition.
 * That is the whole of findings A and B's shared root cause removed rather than
 * arbitrated: the competitor that used to win the row and immediately leave was
 * always the one that did not want it.
 */
export async function wsConnectHandler(event: WsConnectEvent, deps: WsDeps): Promise<WsResult> {
  const auth = await authenticateConnect(event, deps);
  if (!auth) return { statusCode: 401 };
  const { userId, role, sessionDigest } = auth;

  // DIGESTLESS DIALS FAIL CLOSED on a session-enforcing host. v1.0 has not
  // shipped: every ticket binds its minting session, so a dial with no digest
  // is not a legacy client to protect — it would open a socket that session
  // revocation can never match, drain, or refuse. Covers both branches above:
  // a digestless ticket row AND a stale-deploy authorizer context. The AWS
  // authorizer independently denies digestless tickets before this runs
  // (ws-authorizer.lambda.ts); this is the shared backstop.
  if (deps.sessionGuard !== undefined && sessionDigest === undefined) {
    deps.log('ws_connect_refused_digestless');
    return { statusCode: 401 };
  }

  // Drained BEFORE the row is touched, and for EVERY connect including a
  // send-role one: `tacendum send --drain` and `tacendum sync` consume their
  // queue over exactly such a connection, and the drain posts to the DIALLING
  // connectionId, never to whatever the row names — which is why a role that
  // owns no row still receives everything it came for. Replaying to a second
  // live socket is the idempotent case clients already dedupe (only an ack
  // deletes a queued row).
  //
  // Ordering: scheduling is the one call here that can stall in SDK retries,
  // and it must not sit between the row write and $connect returning — see the
  // scheduleDrain contract. A scheduling failure therefore just propagates: no
  // row has been written yet, so there is nothing to clean up, and the client
  // retries the connect instead of sitting on an undrained queue.
  await deps.scheduleDrain(userId, event.connectionId, sessionDigest);

  if (role === 'send') {
    return { statusCode: 200, userId, ...(sessionDigest !== undefined ? { sessionDigest } : {}) };
  }

  let outcome = await acquireConnectionRow(userId, event.connectionId, deps, sessionDigest);

  if (outcome === 'owned') {
    // THE OWNERSHIP RE-READ, and the only recovery an establishing owner can
    // have from inside its own handler.
    //
    // CONSTRAINT: this connect may not answer 200 while the row names somebody
    // else. The interleaving: this $connect claims the row and, before it
    // returns, a second listener reads that row, probes it, and gets Gone —
    // because API Gateway has not finished establishing THIS socket yet and a
    // post to a connection whose $connect is still running fails exactly like a
    // post to a dead one. It then compare-and-swaps the row away. Without this
    // read, this handler returns 'owned' and exits, the socket establishes a
    // moment later, and it is a healthy listener that nothing points at: every
    // message for the account queues to the 30-day TTL the instant the winner
    // leaves.
    //
    // Strongly consistent (DataLayer.getConnection), which is the reason that
    // read had to stop being the one eventually-consistent read in the file —
    // the write it must observe is microseconds old by construction.
    //
    // A refusal, not another pass round the claim loop: the displacer is itself
    // an establishing socket, so re-probing it would get Gone and we would
    // displace it straight back, forever. Standing down and letting the client
    // redial on its own backoff is the only termination.
    const held = await deps.db.getConnection(userId);
    if (held?.connectionId !== event.connectionId) outcome = 'displaced';
  }

  if (outcome !== 'owned') {
    // The reason is routing metadata — never frame content. One key
    // for every row-less outcome, so "why are listeners not taking the row" is
    // one grep, not five.
    deps.log('ws_connect_incumbent_spared', { reason: outcome });
    return { statusCode: CONNECT_REFUSED_STATUS };
  }

  // REVALIDATE the connecting session AFTER ownership and before
  // reporting success. `deps.scheduleDrain` ran above, between
  // authenticateConnect and here, and a revoke can commit inside that window:
  // the session-revoke path reads the connection row, finds none yet (this
  // $connect had not claimed it), tears nothing down, and returns — and this
  // handler then owns the row for a socket whose session is already gone. That
  // dead-but-owned row is the denial: a fresh legitimate listener reads it,
  // and even with the incumbent-digest check above a revoke landing AFTER that
  // check still needs this arm to catch it at the source. Tear the row just
  // claimed back down and refuse with 401 (re-authenticate — a plain redial
  // would present the same revoked credential), leaving nothing to deny the
  // real user. Strongly consistent; the guard never caches a positive.
  // Digestless dials never reach here (refused above); the AWS host runs this
  // identically over its authorizer-supplied digest.
  if (deps.sessionGuard !== undefined && sessionDigest !== undefined) {
    if (!(await deps.sessionGuard.active(sessionDigest, deps.now()))) {
      await deps.db.deleteConnection(userId, event.connectionId);
      try {
        await deps.disconnectSocket?.(event.connectionId);
      } catch {
        deps.log('ws_disconnect_on_revoke_failed');
      }
      deps.log('ws_connect_refused_session_revoked');
      return { statusCode: 401 };
    }
  }

  // KNOWN RESIDUAL, and the honest bound on one row per account: the re-read
  // above closes the window that ends when this handler returns, and nothing in
  // this file can close the one that runs from there until API Gateway finishes
  // the handshake. A displacement committed inside THAT window still leaves an
  // established socket row-less with no promotion path. Closing it needs a check
  // at the moment the socket becomes postable, which exists exactly once in the
  // system — the drain worker polls for precisely that moment (ws-drain.lambda.ts)
  // — or a connections table that can hold more than one live connection per
  // account. Neither is in this file. Until then the repair paths are the
  // send-path reap plus its push wake (which redials the app), the queue —
  // drained to every future $connect — and the next dial.

  // Activity touch (grafana lane) runs AFTER the residual above is reasoned
  // about and before the socket is reported established: a failure here must
  // never fail the connect, which is why it is caught and logged, not thrown.
  const signal = AbortSignal.timeout(ACTIVITY_TOUCH_TIMEOUT_MS);
  try {
    const user = await deps.db.getUserById(userId, signal);
    await touchHumanActivity(user, deps, signal);
  } catch {
    deps.log('activity_touch_failed');
  }

  return { statusCode: 200, userId, ...(sessionDigest !== undefined ? { sessionDigest } : {}) };
}

/**
 * The drain's per-invocation budget (S2b). The queue's size is
 * attacker-controlled, so an invocation must bound what it POSTS, not only
 * what it holds: without this the drain Lambda pumped until its host killed it
 * at the timeout — no clean stop, no record of where it got to.
 *
 * `deadlineMs` is a wall-clock epoch; nothing is posted at or past it. The
 * FIRST live message of an invocation always posts, so every budgeted
 * invocation makes forward progress by construction — the item/byte bounds
 * bind from the second message on.
 *
 * `maxScanned` bounds EXAMINED rows, not posted ones. A run of
 * TTL-expired rows is skipped without a post, so `maxItems`/`maxBytes`/
 * `deadlineMs`-against-posts left an attacker-shaped expired run able to
 * consume the whole invocation while the cursor (last POSTED msgId) never
 * advanced — the next attempt restarted before the run and never reached the
 * live tail behind it. The scanned budget and the per-row deadline check give
 * a large expired run a clean, resumable stop.
 */
export interface DrainBudget {
  /** Max message frames posted this invocation. */
  maxItems: number;
  /** Max payload bytes posted this invocation. */
  maxBytes: number;
  /** Epoch ms after which no further message is posted OR examined — enforced
   * on EVERY row, so scanning an expired run cannot outlast it. */
  deadlineMs?: number;
  /** Max rows EXAMINED (posted or skipped) this invocation. Absent = no scan
   * cap (the deadline still binds). Bounds the per-invocation read cost of a
   * long expired run and forces a resumable stop even with zero posts. */
  maxScanned?: number;
}

/**
 * One invocation's worth of drain (S2b sizing, against the Lambda's 30 s
 * timeout): 2000 frames at the ~10 ms/post the management API costs is ~20 s,
 * inside the timeout with the ~5 s handshake probe budget spent first; 16 MiB
 * is half an established pair's full byte cap, so even a maximal legitimate
 * backlog (5000 items / 32 MiB) completes within three invocations — each
 * reconnect one invocation, each prefix acked and gone before the next.
 */
export const DRAIN_SLICE_BUDGET: DrainBudget = {
  maxItems: 2000,
  maxBytes: 16 * 1024 * 1024,
  // Comfortably above maxItems (so the all-live common case still cuts on
  // items), but a hard ceiling on how many rows one invocation may WALK — the
  // bound that stops an expired run from burning an invocation on a host with
  // no deadline clock (the local adapter) and caps the read cost on one with.
  maxScanned: 20_000,
};

export type DrainResult =
  | { outcome: 'complete'; postedItems: number; postedBytes: number }
  /** The socket died mid-drain; the caller may treat the connection row as
   * stale. The rest of the queue waits for reconnect, exactly as before. */
  | { outcome: 'socket_gone'; postedItems: number; postedBytes: number }
  /** The socket's bound session is gone or expired — observed at slice entry
   * or by the in-slice cadence recheck. The socket is no longer authorized to
   * RECEIVE: the caller must stop feeding it (and should tear it down). The
   * queue is untouched and waits for a re-authenticated login. */
  | { outcome: 'session_revoked'; postedItems: number; postedBytes: number }
  /** The budget ran out with queue remaining. `cursor` is the last FULLY
   * EXAMINED msgId (the last posted one when the item/byte budget bound; the
   * last examined one — posted or expired-and-skipped — when the deadline or
   * scanned-row budget bound). Pass it back as `afterMsgId` to resume strictly
   * after it. Resuming from the last EXAMINED key rather than the last posted
   * one is what lets a slice that posted nothing (a run of expired rows) still
   * advance past that run instead of restarting before it. Across
   * invocations the cursor needs no storage — the delivered prefix is acked by
   * the client, rows are deleted, and the next invocation's first page IS the
   * continuation. */
  | {
      outcome: 'budget_exhausted';
      /** ABSENT only when a spent budget bound before ANY row of a FRESH drain
       * was examined: the slice claims no progress and the whole
       * queue is the successor's slice. On a resumed slice the cursor is always
       * present — at minimum the unchanged resume point. */
      cursor?: string;
      postedItems: number;
      postedBytes: number;
    };

/**
 * How long a drain slice may run between session rechecks. A slice can post
 * 2000 frames over ~20 s, and its head check alone left a socket revoked
 * mid-slice RECEIVING until the slice ended. Re-reading the session every
 * 5 s bounds that exposure at ~5 s plus one in-flight post, for at most one
 * strongly consistent read per 5 s of active draining — the guard itself
 * never caches a positive (session-guard.ts), so each recheck observes a
 * revoke that has committed. This is the ONE cadenced check in the
 * revocation story and therefore its worst-case bound; everything else
 * ($default frames, live delivery) re-reads per action.
 */
export const DRAIN_SESSION_RECHECK_MS = 5_000;

/**
 * Replay queued messages for `userId` to `connectionId` in msgId
 * (chronological) order, from `afterMsgId` (exclusive) when resuming, under
 * `budget` when given. Queued rows are NOT deleted on drain; only a client
 * ack deletes them so re-drains are idempotent and clients dedupe
 * by msgId. The single drain implementation, shared by the local adapter
 * (inline after $connect, sliced to completion) and the AWS drain Lambda
 * (async, once the handshake completes, one budgeted slice per invocation).
 * The drain itself never deletes message or connection rows.
 *
 * `session` is the socket's bound session: when present, the slice
 * validates it at entry and re-validates every `DRAIN_SESSION_RECHECK_MS`
 * while posting, so a socket revoked mid-slice stops RECEIVING within ~5 s
 * instead of at the slice's end. Both hosts pass it for every digest-bearing
 * socket; a digestless socket never gets this far (its dial is refused).
 */
export async function drainQueuedMessages(
  userId: string,
  connectionId: string,
  deps: Pick<WsDeps, 'db' | 'sender' | 'now'>,
  budget?: DrainBudget,
  afterMsgId?: string,
  session?: { guard: SessionGuard; digest: string },
): Promise<DrainResult> {
  const nowSec = Math.floor(deps.now() / 1000);
  let postedItems = 0;
  let postedBytes = 0;
  let lastPosted: string | undefined;
  // the LAST FULLY EXAMINED key, distinct from `lastPosted`. A run
  // of TTL-expired rows advances this without posting, so a slice cut short
  // inside such a run resumes PAST it instead of restarting from the last post
  // (or, on a fresh invocation, from the queue head — re-posting any live
  // prefix and never reaching the live tail behind the run). `scanned` is the
  // count of rows examined this slice, bounded by `budget.maxScanned`.
  let lastExamined: string | undefined;
  let scanned = 0;
  // Entry check: a slice must not open by feeding a revoked socket — each
  // local slice iteration and each Lambda continuation re-enters here, so
  // this is also what re-validates every continuation.
  let lastSessionCheckMs = deps.now();
  if (session !== undefined && !(await session.guard.active(session.digest, deps.now()))) {
    return { outcome: 'session_revoked', postedItems, postedBytes };
  }
  // the deadline and the scanned-row budget bind BEFORE every
  // page fetch and BEFORE every row, INCLUDING the first of each. The check
  // used to be disabled until one row had been examined ("a budgeted
  // invocation always makes forward progress"), which bound the ITEM budget
  // but not the CLOCK: a slice entered with a spent deadline still ran its
  // first query and posted its first live row unconditionally. A slice with
  // no time must do NEITHER — it returns the budget it found itself over,
  // with the cursor exactly where the slice began (`afterMsgId`, possibly
  // undefined) when nothing was examined, claiming no progress. Forward
  // progress is the CALLER's contract now: the AWS host hands an unchanged
  // slice to a fresh invocation whose clock is full (and bounces a spent
  // clock before even fetching, ws-drain.lambda.ts), and the local host's
  // slice loop stops on an unmoved cursor — its budget carries no deadline
  // and its scan cap cannot bind before the first row, so an unmoved cursor
  // there still never means dropped work.
  const budgetBound = (): boolean =>
    budget !== undefined &&
    ((budget.deadlineMs !== undefined && deps.now() >= budget.deadlineMs) ||
      (budget.maxScanned !== undefined && scanned >= budget.maxScanned));
  const boundResult = (): DrainResult => {
    const cursor = lastExamined ?? afterMsgId;
    return {
      outcome: 'budget_exhausted',
      ...(cursor !== undefined ? { cursor } : {}),
      postedItems,
      postedBytes,
    };
  };
  if (budgetBound()) return boundResult(); // before the FIRST fetch
  // One page at a time, posted before the next page is fetched. The queue's
  // size is attacker-controlled, so the drain must never hold more than a page:
  // materialising the whole list first meant a flooded queue killed the drain
  // DURING the list, nothing was ever posted or acked, and every reconnect
  // died the same way — a permanent black hole behind 'sent' receipts. A
  // streamed drain that dies mid-queue has already delivered a prefix clients
  // ack, so each reconnect resumes from a smaller queue: forward progress.
  for await (const page of deps.db.listQueuedMessages(userId, afterMsgId)) {
    // DynamoDB TTL deletion is eventual (it can lag well past expiry), so rows
    // at or past expiresAt may still come back from the query. Filter on the
    // clock, per page: expired ciphertext is never replayed. The rows
    // themselves are left for TTL to reap — the drain still deletes nothing.
    for (const m of page) {
      // The DEADLINE and the SCANNED-ROW budget bind on EVERY row, expired or
      // not, the first included. When this binds
      // the cursor is the last EXAMINED key (which may be an expired, unposted
      // row) — or the slice's own starting point when nothing was — so a
      // zero-post slice still resumes exactly right.
      if (budgetBound()) return boundResult();
      lastExamined = m.msgId;
      scanned += 1;
      if (m.expiresAt <= nowSec) continue;
      // The in-slice cadence recheck (see DRAIN_SESSION_RECHECK_MS): a
      // revoke landing mid-slice stops the feed here, before the next post.
      if (
        session !== undefined &&
        deps.now() - lastSessionCheckMs >= DRAIN_SESSION_RECHECK_MS
      ) {
        lastSessionCheckMs = deps.now();
        if (!(await session.guard.active(session.digest, deps.now()))) {
          return { outcome: 'session_revoked', postedItems, postedBytes };
        }
      }
      const size = Buffer.byteLength(m.payload, 'utf8');
      // The item/byte budget binds POSTED work (the deadline moved to the
      // per-row check above so it also binds examined-but-skipped rows). The
      // first live message always posts, so a budgeted invocation makes
      // forward progress even at maxItems 1.
      if (budget !== undefined && postedItems > 0 && lastPosted !== undefined) {
        const overItems = postedItems + 1 > budget.maxItems;
        const overBytes = postedBytes + size > budget.maxBytes;
        if (overItems || overBytes) {
          return { outcome: 'budget_exhausted', cursor: lastPosted, postedItems, postedBytes };
        }
      }
      // A server-minted accounts notice drains as its
      // own frame type — never as a `msg` a client would feed to libsignal.
      // Clients cannot enqueue one (SendFrame.msgType cannot spell it), so
      // this branch serves only rows the ceremony/roster code wrote.
      const frame: MsgFrame | AccountsNoticeFrame =
        m.type === 'accounts'
          ? { type: 'accounts', from: m.senderId, msgId: m.msgId, payload: m.payload, ts: m.ts }
          : {
              type: 'msg',
              from: m.senderId,
              msgId: m.msgId,
              msgType: m.type,
              payload: m.payload,
              ts: m.ts,
            };
      const posted = await deps.sender.post(connectionId, frame);
      if (!posted) return { outcome: 'socket_gone', postedItems, postedBytes };
      postedItems += 1;
      postedBytes += size;
      lastPosted = m.msgId;
    }
    // Before the NEXT page fetch: a deadline that expired while
    // this page was being posted must not buy one more query.
    if (budgetBound()) return boundResult();
  }
  return { outcome: 'complete', postedItems, postedBytes };
}

/**
 * $disconnect — remove the connection row (guarded against stale overwrite).
 *
 * THE GUARD IS ALSO WHAT MAKES A 'send' TEARDOWN HARMLESS, and it needs no role
 * of its own to do it. `deleteConnection` is conditional on the row still
 * naming this exact connectionId; a send-role connection never claimed the row,
 * so no row can ever name it, so this delete is a no-op for one by
 * construction. The alternative — plumbing the role through to $disconnect —
 * would put the safety of the teardown behind a value the disconnect event does
 * not carry (the ticket was spent at $connect and is long gone), which is
 * strictly worse than a condition the store evaluates.
 */
export async function wsDisconnectHandler(
  event: WsDisconnectEvent,
  deps: WsDeps,
): Promise<WsResult> {
  await deps.db.deleteConnection(event.senderUserId, event.connectionId);
  return { statusCode: 200 };
}

/** $default — dispatch a validated client frame (send | ack). */
export async function wsDefaultHandler(event: WsMessageEvent, deps: WsDeps): Promise<WsResult> {
  // THE SESSION RECHECK before anything is parsed or routed.
  // A stolen socket outlives sign-out otherwise: sign-out deletes the session
  // row and best-effort disconnects the socket, but the disconnect can be
  // in-flight, throttled, lose the race to a frame already sent, or not exist
  // on a host with no management channel. So the socket's OWN frames are held
  // to the session that opened it — once that session is gone, this refuses.
  // Per frame, deliberately: `sessionGuard.active` never caches a positive
  // verdict (the 60 s cache it once had WAS the revocation window — a revoked
  // socket kept sending until it expired), so the frame after a revoke
  // commits is the first frame refused. Negatives are cached, so a refused
  // socket that keeps spraying costs no further reads. The exposure bound and
  // the read arithmetic live in session-guard.ts. The digest is the one API
  // Gateway cached in the authorizer context, so obtaining it is free.
  // A frame with NO digest fails CLOSED: connects refuse digestless dials, so
  // such a frame can only come from a socket predating that rule (or a stale
  // authorizer cache) — a socket the session machinery cannot revoke. Refuse
  // it and tear it down exactly like a revoked one.
  if (deps.sessionGuard !== undefined && event.sessionDigest === undefined) {
    await postError(event, deps, 'session_unbound', 'this socket is not bound to a session; sign in again');
    await deps.db.deleteConnection(event.senderUserId, event.connectionId);
    try {
      await deps.disconnectSocket?.(event.connectionId);
    } catch {
      deps.log('ws_disconnect_on_revoke_failed');
    }
    deps.log('ws_frame_refused_digestless');
    return { statusCode: 401 };
  }
  if (event.sessionDigest !== undefined && deps.sessionGuard !== undefined) {
    const active = await deps.sessionGuard.active(event.sessionDigest, deps.now());
    if (!active) {
      // A specific, clean refusal the sender can act on — sign in again — and
      // deliberately NOT the account-enumeration-safe generic: the caller owns
      // this session, so telling it its own session was revoked leaks nothing.
      await postError(event, deps, 'session_revoked', 'this session has been revoked; sign in again');
      // Belt to the proactive revoke's braces: drop the routing row (conditional
      // on this connectionId, so a reconnect's fresh row survives) and hang the
      // socket up, so a host that never got the proactive disconnect still stops
      // this socket the first time it speaks.
      await deps.db.deleteConnection(event.senderUserId, event.connectionId);
      try {
        await deps.disconnectSocket?.(event.connectionId);
      } catch {
        deps.log('ws_disconnect_on_revoke_failed');
      }
      deps.log('ws_frame_refused_session_revoked');
      return { statusCode: 401 };
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    await postError(event, deps, 'invalid_frame', 'frame must be valid JSON');
    return { statusCode: 400 };
  }

  const parsed = ClientFrame.safeParse(raw);
  if (!parsed.success) {
    // Zod issues never include the payload value, only paths/messages.
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    await postError(event, deps, 'invalid_frame', detail);
    return { statusCode: 400 };
  }

  switch (parsed.data.type) {
    case 'send':
      return handleSend(parsed.data, event, deps);
    case 'ack':
      return handleAck(parsed.data, event, deps);
    case 'typing':
      return handleTyping(parsed.data, event, deps);
  }
}

/**
 * Resolve the group-aware quota collapse for one send (see GroupQuotaContext in data.ts for the full contract). Undefined —
 * meaning every quota and wake key below stays per-ULID, byte-identical to
 * the shipped behavior — in every one of these cases:
 *
 * - neither party carries a `groupId` (the whole pre-accounts population:
 * ZERO added reads on the solo↔solo hot path — the flag is not even
 * consulted, because with no group there is nothing it could change);
 * - the `feature#accounts` flag is OFF or DELETED: the
 * kill switch restores the shipped per-ULID keys even for accounts
 * already grouped — checked FIRST among the reads, before any group row;
 * - a `groupId` that resolves to no group row (a dissolution race): that
 * side is treated as solo, failing toward the stricter per-ULID pricing.
 *
 * Cost when it does resolve: one flag read + at most two group-row GetItems,
 * paid only by grouped senders/recipients with the feature enabled.
 */
async function resolveGroupSendContext(
  sender: UserRecord,
  recipient: UserRecord,
  deps: WsDeps,
): Promise<GroupQuotaContext | undefined> {
  if (sender.groupId === undefined && recipient.groupId === undefined) return undefined;
  if (!(await deps.db.isAccountsFeatureEnabled())) return undefined;
  const senderGroup =
    sender.groupId !== undefined ? await deps.db.getAccountGroup(sender.groupId) : undefined;
  const recipientGroup =
    recipient.groupId !== undefined
      ? await deps.db.getAccountGroup(recipient.groupId)
      : undefined;
  if (senderGroup === undefined && recipientGroup === undefined) return undefined;
  const senderMembers = senderGroup
    ? [...new Set([sender.userId, ...senderGroup.members.map((m) => m.userId)])]
    : [sender.userId];
  const recipientKeys = recipientGroup
    ? [
        ...new Set([
          recipientGroup.groupId,
          recipient.userId,
          ...recipientGroup.members.map((m) => m.userId),
        ]),
      ]
    : [recipient.userId];
  return {
    senderScope: senderGroup ? senderGroup.groupId : sender.userId,
    senderMembers,
    recipientKeys,
    // The recipient's member QUEUE PARTITIONS (never the groupId, which is a
    // ledger scope key): what the -gate admission walk sums across.
    recipientMembers: recipientGroup
      ? [...new Set([recipient.userId, ...recipientGroup.members.map((m) => m.userId)])]
      : [recipient.userId],
    recipientRosterSize: recipientGroup ? Math.max(1, recipientGroup.members.length) : 1,
  };
}

/**
 * Hand a time-critical frame to the push scheduler. Deliberately does almost
 * nothing: the bound below is the only thing that must happen with the
 * SENDER's identity in hand, and everything expensive — the token read, the
 * APNs round trip, the prune — belongs off this path entirely.
 *
 * Nothing here can fail the send. A scheduling failure means the call does not
 * ring early; the ciphertext is already durably queued either way.
 */
async function wakeRecipient(
  recipientId: string,
  senderUserId: string,
  deps: WsDeps,
  kind: 'call' | 'message' = 'call',
  message?: { msgId: string; msgType: string; payload: string; ts: number },
  verify?: { msgId: string; ackGraceMs: number },
  /** The group collapse for this send (resolved once in handleSend):
   * collapses the MESSAGE wake buckets and widens the correspondence read.
   * Absent = per-ULID keys exactly as shipped. */
  groupCtx?: GroupQuotaContext,
): Promise<void> {
  // Keyed by the SENDER: the bound must stop one hostile caller ring-bombing a
  // victim without silencing everyone else who wants to reach the same person.
  // It stays here, not in the worker, because this is where the sender is
  // known and where the limiter's per-container state actually lives.
  //
  // SEPARATE buckets for calls and messages. They shared one when message
  // notifications first landed, and the failure was exactly what the sizes
  // predict: ten quick texts drained the call bound, and the same sender's
  // next CALL was silently suppressed — a ring-bomb limit, built for a
  // hostile caller, silencing a friendly one because they had just been
  // texting.
  //
  // AND SEPARATE BUCKETS FOR VERIFY PROBES, for the same class
  // of failure one layer deeper. A `verify` wake — the frame was DELIVERED
  // into a socket that took the bytes — is a PROBE, not a ring: the worker
  // waits out the ack grace and most probes are silenced by the recipient's
  // own ack (push-worker.ts), never reaching APNs. Charging probes to the
  // ring buckets meant healthy, ANSWERED, acked calls drained them
  // (call.offer and call.end are both urgent, so one answered call spends
  // two tokens), and a later GENUINE ring — a different stranger, an
  // offline recipient — was refused. Denial-of-RING, reintroduced by the
  // accounting of the fix built to prevent a missed ring.
  //
  // THE INVARIANT, enforced here: a wake that does not result in a ring
  // must not consume the budget genuine rings depend on. Probes draw their
  // OWN buckets (`pushprobe`, `pushprobe-unknown` below), sized exactly like
  // the ring buckets they shadow (LIMITS.pushVerify pins the pairing) — a
  // delivered urgent frame is attacker-triggerable over a live socket, so
  // the probe path must stay bounded (each probe is a worker invocation
  // sleeping the grace plus a strongly consistent row read), it just must
  // not be bounded by the ring budget.
  //
  // Deliberately NOT debit-in-the-worker (charge only the probes that
  // survive): the push worker's role holds no rate-bucket grant by design —
  // the stack pins "the drain worker, push worker, and authorizer never
  // rate-limit" — so that shape passes every unit test and AccessDenies in
  // production, failing CLOSED into the exact missed ring this path exists
  // to prevent. And NOT refund-on-suppression: a refunded probe is a free
  // probe, which un-bounds the amplification channel above. Residuals of
  // the split are stated on LIMITS.pushVerify / pushVerifyUnknown.
  const probing = kind !== 'message' && verify !== undefined;
  const bucket = kind === 'message' ? 'pushmsg' : probing ? 'pushprobe' : 'pushcall';
  const limit =
    kind === 'message' ? LIMITS.pushMessage : probing ? LIMITS.pushVerify : LIMITS.pushSend;
  // The MESSAGE wake bucket keys on the sender's GROUP where one exists
  //: three linked senders share
  // ONE `pushmsg` budget, never three — linking must not multiply the wake
  // allowance aimed at a recipient. The CALL/ring buckets deliberately stay
  // per-ULID: their per-sender bound is the ring-bomb ceiling, and
  // names only the message-wake collapse. With the flag OFF (groupCtx is
  // never resolved) every key is per-ULID, exactly as shipped.
  const senderWakeKey =
    kind === 'message' ? groupCtx?.senderScope ?? senderUserId : senderUserId;
  if ((await deps.rateLimit.take(`${bucket}:${senderWakeKey}`, limit)) > 0) {
    deps.log(probing ? 'push_suppressed_probe_rate_limited' : 'push_suppressed_rate_limited', {
      kind,
    });
    return;
  }
  // THE RIGHT TO RING IS GATED ON RELATIONSHIP, NOT ONLY ON RATE (S3). The
  // per-sender bound above stops one hostile caller — and accounts are free
  // to mint, so a Sybil fleet was N fresh full budgets aimed at one phone:
  // CallKit rang on arbitrary attacker ciphertext, before anything could
  // decrypt it, as many times as the attacker cared to register.
  //
  // Deliberately NOT the blanket recipient-keyed call bucket this file's
  // LIMITS already weighed and rejected (see pushSend): that is a
  // denial-of-RING primitive — exhaust the victim's bucket and real calls
  // stop arriving. Instead the shared budget below is drawn ONLY by callers
  // the recipient has never written to: a caller with reverse correspondence
  // (any frame from the recipient within the trailing message-TTL window —
  // replies, read receipts, profile syncs all count) rings at the per-sender
  // rate alone and can never be crowded out by a fleet.
  //
  // The signal is the quota ledger the queue already maintains
  // (hasQueuedCorrespondence) — no new social graph is stored to answer it.
  // Taken AFTER the sender's own bucket, so a caller its own budget refused
  // never drains the shared one (the pushmsg-pair ordering rule, applied to
  // rings). Residuals, stated: a fleet can exhaust the stranger budget and
  // suppress OTHER strangers' first rings (the offer still queues, drains and
  // shows on next open — the client-side teardown fix is the
  // complement for rings that do fire); and a group call leg to a co-member
  // the recipient has never written to draws this same budget.
  if (kind !== 'message') {
    // Group-aware since (the stranger-ring relationship signal
    // collapses to the group): the recipient's reply to ANY of the sender's
    // linked devices, billed under ANY of the recipient's scope keys, keeps
    // this caller established — linking a device never demotes a real
    // correspondent back to the stranger ring budget. Without group context
    // (solo↔solo, or flag OFF) this is the identical single-key read.
    const nowSec = Math.floor(deps.now() / 1000);
    const established = groupCtx
      ? await deps.db.hasQueuedCorrespondenceAny(
          groupCtx.recipientKeys,
          groupCtx.senderMembers,
          nowSec,
        )
      : await deps.db.hasQueuedCorrespondence(recipientId, senderUserId, nowSec);
    // The verify-probe split again (see `probing` above): a stranger fleet
    // whose delivered calls are all ACKED — a healthy victim answering —
    // must drain only PROBE budget, or answered calls consume the one
    // shared allowance a genuine stranger's first ring to the later-offline
    // victim depends on.
    if (
      !established &&
      (await deps.rateLimit.take(
        probing ? `pushprobe-unknown:${recipientId}` : `pushcall-unknown:${recipientId}`,
        probing ? LIMITS.pushVerifyUnknown : LIMITS.pushCallUnknown,
      )) > 0
    ) {
      deps.log(
        probing ? 'push_suppressed_probe_unknown_sender' : 'push_suppressed_unknown_sender',
        { kind },
      );
      return;
    }
  }
  // The (sender, recipient) PAIR bucket — each sender's fair share of the
  // recipient ceiling below. The
  // shared recipient bucket alone handed any one crew member a
  // denial-of-notification primitive: drain the 10/min shared bucket, then
  // eat each refill token on a 30/min sender allowance, and every OTHER
  // agent's wakes are suppressed while their messages sit queued. Taken
  // BEFORE the recipient bucket, deliberately: a pair-limited sender must be
  // refused out of ITS OWN budget, never out of the shared one — taking the
  // shared token first would let the monopolist keep draining the ceiling it
  // is being refused for. Sized (4 burst, 4/min — see LIMITS) so no single
  // sender can consume the whole 10/min ceiling. Suppresses the WAKE only;
  // the ciphertext is already durably queued and still delivers.
  // The pair key's SENDER side collapses to the group: three
  // linked senders share one fair-share draw on this recipient's ceiling.
  // The RECIPIENT side stays the device ULID — like `pushmsg-rcpt` below, it
  // protects one physical device's attention, per-device by design.
  if (
    kind === 'message' &&
    (await deps.rateLimit.take(
      `pushmsg-pair:${senderWakeKey}:${recipientId}`,
      LIMITS.pushMessagePair,
    )) > 0
  ) {
    deps.log('push_suppressed_pair_rate_limited');
    return;
  }
  // ALSO keyed by the RECIPIENT, for message wakes. The sender
  // bucket above answers "is this one sender flooding?" and still must — but a
  // crew is N senders, each legitimate, each holding an independent full
  // budget, all aimed at ONE phone: at the crew cap that is ~240 banners a
  // minute, a flood assembled entirely out of within-budget senders, which no
  // per-sender bound can see. Client pacing cannot substitute — a looping or
  // compromised worker ignores it — so the ceiling lives here. Taken LAST,
  // after both sender-side buckets, so a sender either of its own buckets
  // already refused cannot drain the victim's shared budget. Recipient-keyed
  // only: it learns no graph and needs no Query. Calls are exempt —
  // integrations cannot send `urgent`, so a crew cannot assemble a
  // distributed ring-bomb, and the per-sender call bound stays the whole
  // story there. Suppresses the WAKE only: the ciphertext was durably
  // enqueued before any wake decision and still delivers.
  // DELIBERATELY per-ULID under the group collapse: each group member IS its own physical device with its own queue,
  // this bucket protects that one device's attention, and collapsing it
  // would let two siblings' legitimate traffic starve the third's wakes.
  // The aggregate across a 3-device recipient is the cost of three real
  // phones, never an abuse-budget multiplication — no SENDER-side budget
  // multiplies (the sender buckets above collapsed instead). Per-device by
  // design, stated rather than discovered.
  if (
    kind === 'message' &&
    (await deps.rateLimit.take(`pushmsg-rcpt:${recipientId}`, LIMITS.pushMessageRecipient)) > 0
  ) {
    deps.log('push_suppressed_recipient_rate_limited');
    return;
  }
  // ONE SCHEDULING DECISION, ONE RING CLAIM. Minted here — after every gate
  // above has passed, immediately before the hand-off — because "here" is the
  // only place that corresponds to a decision to ring. Lambda's async queue is
  // at-least-once and the push function carries the default retry count, so
  // the worker can see these bytes more than once; without an id it cannot
  // tell that from two genuine wakes, and a duplicate VoIP push is a second
  // native ring the device has no way to absorb.
  //
  // A FRESH ULID, never anything derived from the frame. The obvious key —
  // `msgId` — is client-chosen, and the branches above refuse to gate the
  // ring on the queued row's existence precisely because a legitimate offer
  // resend reuses it; keying the dedup on it would reintroduce that silence
  // through the back door. Per-schedule means every trip through this
  // function rings, and every delivery of one trip rings once.
  //
  // PINNED IN push.wakeid.mint.test.ts, on BOTH wake branches and both
  // hosts, because this rule was stated in three files and enforced in none:
  // `w-${message?.msgId ?? verify?.msgId ?? recipientId}` here left every
  // server test green while silencing the resent offer.
  const wakeId = ulid();
  try {
    await deps.schedulePush(recipientId, senderUserId, kind, message, verify, wakeId);
  } catch {
    // Scheduling failed (throttled invoke, misconfiguration). Never surfaces
    // to the sender — see the doc comment.
    deps.log('push_schedule_failed');
  }
}

/**
 * Do these two user rows belong to the same crew ?
 *
 * BOTH operands must be present, non-empty strings before equality means
 * anything: `undefined === undefined` is `true` in JS, so an unguarded
 * comparison would silently make every crewless integration in the system one
 * mutual crew — a cross-tenant leak, and exactly the retroactive widening of
 * already-deployed rows that exists to prevent. One helper,
 * called at both enforcement sites (the send predicate and the inbox
 * predicate), so the guard cannot drift between them.
 */
function sameCrew(a: Pick<UserRecord, 'crewId'>, b: Pick<UserRecord, 'crewId'>): boolean {
  return (
    typeof a.crewId === 'string' &&
    a.crewId.length > 0 &&
    typeof b.crewId === 'string' &&
    b.crewId.length > 0 &&
    a.crewId === b.crewId
  );
}

/**
 * Has this HUMAN consented to exchanging frames with this INTEGRATION
 * (the .2 widening)?
 *
 * ONE helper for all four enforcement sites — the send arm (integration ->
 * consented human), the inbox arm (that human's frames -> the integration)
 * and BOTH typing branches — the sameCrew discipline, so the arms cannot
 * drift and typing can never reach a recipient a durable send could not.
 * The edge is DIRECTED (human -> integration) and written only by the
 * authenticated human over the consent route; both arms check the SAME
 * direction, which is what makes one deletion kill both.
 *
 * FAIL-CLOSED on every operand, in the sameCrew tradition: the human side
 * must be human-class (accountClass absent — an integration-written edge is
 * inert, so no injectable node can widen its own reach by consenting to a
 * sibling), the integration side must be integration-class AND bound to an
 * owner (an unbound integration accepts and reaches NOBODY, edges or not —
 * the standing rule), and the edge itself must exist under a STRONGLY
 * consistent read (revocation = delete the edge; the NEXT send is refused).
 *
 * THE EDGE READ COMES FIRST, unconditionally, before any class check
 * short-circuits (the no-avoidable-timing-tells): every refusal that
 * reaches this helper costs the same point read, so refusal timing does not
 * newly distinguish recipient classes. The owner's crew-revoke tombstone
 * needs no clause here and still wins: revoke deletes the agent's user row,
 * so a revoked agent fails `unknown_sender` / `unknown_recipient` before
 * any arm consults an edge — pinned in consent.ws.test.ts.
 *
 * EXPORTED FOR ONE REASON: the integration-class guard
 * is redundant at all four current call sites — each has already
 * established the integration operand's class in its enclosing condition —
 * which is precisely why it exists (a FIFTH site added later must fail
 * closed) and precisely why no handler-driven test can turn its deletion
 * red. The direct-call test in consent.ws.test.ts is what makes the test
 * file's mutation-honesty claim true; no production code imports this.
 */
export async function consentAdmits(
  human: Pick<UserRecord, 'userId' | 'accountClass'>,
  integration: Pick<UserRecord, 'userId' | 'accountClass' | 'ownerUserId'>,
  deps: Pick<WsDeps, 'db'>,
): Promise<boolean> {
  const edge = await deps.db.hasConsentEdge(human.userId, integration.userId);
  return (
    edge &&
    human.accountClass === undefined &&
    integration.accountClass === 'integration' &&
    typeof integration.ownerUserId === 'string' &&
    integration.ownerUserId.length > 0
  );
}

/**
 * Does the integration's OWNER clause admit this counterparty ? "Owner" resolves to the owner's device GROUP at
 * predicate-evaluation time: an agent bound to any member ULID reaches — and
 * is reachable — every member of the owner's current group. The BIND
 * itself stays write-once to a single ULID (`ownerUserId` never
 * migrates); only this read-time resolution widens.
 *
 * FAIL-CLOSED on every operand, the consentAdmits tradition: the integration
 * side must be integration-class AND bound (an unbound integration reaches
 * nobody); the exact-ULID match — today's entire predicate — answers first,
 * with no read and no flag, so the solo case stays byte- and time-identical
 * to shipped (a tombstoned counterparty refuses even there — the record is
 * the enforcement); the widened case requires the counterparty to be a live
 * HUMAN-class row (group members are human by construction — the link
 * conditions — and the class guard here is the belt), the
 * `feature#accounts` flag ON (reach WIDENING is a group-aware capability
 * grant, so the kill switch restores the shipped per-ULID predicate exactly;
 * the binding-fate enforcement is elsewhere
 * and not flag-gated), the OWNER row resolving live and grouped under a
 * STRONGLY CONSISTENT read, and BOTH ULIDs present in the authoritative
 * roster row (strongly consistent) — the roster alone decides membership,
 * so an unlink or revoke kills group reach on the next frame, exactly as
 * consent-edge deletion does, and a stale counterparty row can neither
 * grant nor falsely refuse it.
 *
 * Priced like every widening before it (the .1 rule): the flag read plus
 * up to two extra GetItems run only on integration-involved frames whose
 * exact-owner compare already failed and whose counterparty is a live
 * human, after the sender's own quota was spent (the counterparty-groupId
 * pre-gate was retired because it rode an
 * eventually consistent row and could falsely refuse a fresh sibling; the
 * owner read is strong and short-circuits the ungrouped case instead);
 * every refusal outcome keeps its previous bytes (the freeze — the wire
 * must not teach that grouping exists).
 *
 * EXPORTED FOR ONE REASON (the consentAdmits precedent): every call site has
 * established the integration operand's class in its enclosing condition, so
 * no handler-driven test can turn the class guards' deletion red — the
 * direct-call test in accounts-agent-reach.test.ts is what keeps the
 * fail-closed shape honest.
 *
 * TWO AMENDMENTS: (a) the OWNER read is
 * STRONGLY CONSISTENT and the counterparty's membership is decided by the
 * AUTHORITATIVE roster row alone — the caller-passed counterparty row rides
 * the default eventually consistent read, and gating on ITS groupId could
 * falsely refuse a freshly linked sibling for the replication-lag window
 * (fail-closed, but a lie about the roster; the roster is the authority in
 * BOTH directions now). (b) the widened admission returns its BASIS —
 * `widened: { groupId, ownerUserId, memberUserId }` — so handleSend can pin
 * the very membership that authorized the send inside the enqueue
 * transaction (GroupReachPin, data.ts): the check here remains a precheck,
 * and an amicable unlink committing between it and the enqueue leaves both
 * user rows live, which the tombstone conditions alone cannot catch.
 */
export interface OwnerGroupAdmission {
  admitted: boolean;
  /** Present iff admission rode the WIDENED clause (never the exact-owner
   * match): the roster facts the delivery transaction must re-bind. */
  widened?: { groupId: string; ownerUserId: string; memberUserId: string };
}

export async function ownerGroupAdmission(
  integration: Pick<UserRecord, 'accountClass' | 'ownerUserId'>,
  counterparty: Pick<UserRecord, 'userId' | 'accountClass' | 'groupId' | 'tombstoned'>,
  deps: Pick<WsDeps, 'db'>,
): Promise<OwnerGroupAdmission> {
  if (integration.accountClass !== 'integration') return { admitted: false };
  if (typeof integration.ownerUserId !== 'string' || integration.ownerUserId.length === 0) {
    return { admitted: false };
  }
  // A tombstoned counterparty never admits — checked BEFORE the exact-owner
  // arm too: the send path refuses a tombstoned
  // recipient earlier, but typing reaches this helper with rows the handler
  // has not tombstone-gated, and the record is the enforcement.
  if (counterparty.tombstoned === true) return { admitted: false };
  if (counterparty.userId === integration.ownerUserId) return { admitted: true };
  if (counterparty.accountClass !== undefined) return { admitted: false };
  if (!(await deps.db.isAccountsFeatureEnabled())) return { admitted: false };
  const owner = await deps.db.getUserById(integration.ownerUserId, undefined, {
    consistent: true,
  });
  if (!owner || owner.tombstoned === true || owner.groupId === undefined) {
    return { admitted: false };
  }
  const group = await deps.db.getAccountGroup(owner.groupId);
  if (!group) return { admitted: false };
  const memberIds = new Set(group.members.map((m) => m.userId));
  if (!memberIds.has(integration.ownerUserId) || !memberIds.has(counterparty.userId)) {
    return { admitted: false };
  }
  return {
    admitted: true,
    widened: {
      groupId: owner.groupId,
      ownerUserId: integration.ownerUserId,
      memberUserId: counterparty.userId,
    },
  };
}

export async function ownerGroupAdmits(
  integration: Pick<UserRecord, 'accountClass' | 'ownerUserId'>,
  counterparty: Pick<UserRecord, 'userId' | 'accountClass' | 'groupId' | 'tombstoned'>,
  deps: Pick<WsDeps, 'db'>,
): Promise<boolean> {
  return (await ownerGroupAdmission(integration, counterparty, deps)).admitted;
}

/**
 * May this connection row still RECEIVE live posts?
 *
 * True on a host with no session guard (a unit harness — both shipped hosts
 * wire one). On an enforcing host: the row must carry a session digest AND
 * that session must still be live, freshly read (the guard never caches a
 * positive). A digestless row fails CLOSED — connects refuse digestless
 * dials, so such a row is a socket the session machinery cannot revoke, and
 * delivering to it would be delivery no sign-out can ever stop. One helper
 * for BOTH reads on the send path (the routing row and the post-failure
 * re-read), so the two cannot drift.
 */
async function sessionAuthorizesDelivery(conn: ConnectionRecord, deps: WsDeps): Promise<boolean> {
  if (deps.sessionGuard === undefined) return true;
  if (conn.sessionDigest === undefined) return false;
  return deps.sessionGuard.active(conn.sessionDigest, deps.now());
}

/**
 * send — durable-first routing: enqueue, then attempt live delivery.
 * Receipt back to the sender: `delivered` when the frame reached a live
 * socket, `sent` when it is queued for later. The queued row is deleted only
 * by the recipient's ack, so a crash between delivery and ack re-delivers on
 * reconnect (client dedupes by msgId).
 */
async function handleSend(frame: SendFrame, event: WsMessageEvent, deps: WsDeps): Promise<WsResult> {
  // Per-sender flood control. Payload/msgId never enter the log.
  const retry = await deps.rateLimit.take(`wssend:${event.senderUserId}`, LIMITS.wsSend);
  if (retry > 0) {
    await postError(event, deps, 'rate_limited', 'too many messages; slow down');
    return { statusCode: 429 };
  }

  // Integration-class enforcement. One GetItem on the
  // sender row per send — accepted cost a human row (or a sender with
  // no row at all) takes none of these branches and behaves exactly as before.
  const sender = await deps.db.getUserById(event.senderUserId);
  if (!sender || sender.tombstoned === true) {
    // The authorizer's verdict outlives the account: a revoke or self-delete
    // mid-socket leaves a live connection whose user row is gone. The
    // optional-chain that read "no row" as "unrestricted human" was the hole
    //: a deleted account must fail closed, not open.
    // A ROW tombstoned by revoke-lost/stolen is
    // the same refusal in the same bytes: the record is the enforcement, so
    // a stolen device whose teardown crashed is still unable to ACT the
    // moment the roster transaction commits — and the refusal deliberately
    // does not distinguish "revoked" from "deleted" to the holder of the
    // stolen device.
    await postError(event, deps, 'unknown_sender', 'account no longer exists');
    return { statusCode: 403 };
  }
  if (sender.accountClass === 'integration') {
    // An integration speaks to its owner and — to fellow
    // members of the crew that owner deliberately adopted it into (the
    // recipient predicate below, after the recipient row is read). Enforced
    // HERE, server-side, because this check is what makes mass minting
    // pointless, spam to strangers impossible, and prompt-injection exfil a
    // message to the victim's own phone or the victim's own crew — places the
    // attacker cannot read.
    if (!sender.ownerUserId) {
      await postError(event, deps, 'integration_unbound', 'pair with an owner before sending');
      return { statusCode: 403 };
    }
    if (frame.urgent === true) {
      // The urgent bit is the VoIP-wake (ring) capability. A notifier never
      // rings; refusing loudly beats silently stripping the bit, because a
      // client that believes it can ring should learn so at develop time,
      // not at incident time.
      await postError(
        event,
        deps,
        'integration_urgent_forbidden',
        'integrations cannot send urgent frames',
      );
      return { statusCode: 403 };
    }
    // The class quota, tighter than the human flood floor above (which was
    // already taken — an integration burns both buckets by design). Taken
    // BEFORE the recipient read below: the read makes
    // "does this ULID exist" an answerable question (404 vs 403), and taking
    // the quota first prices that oracle — a rate-limited integration gets
    // 429 here and cannot use free sends to probe for accounts.
    const retryInt = await deps.rateLimit.take(`intsend:${event.senderUserId}`, LIMITS.integrationSend);
    if (retryInt > 0) {
      await postError(event, deps, 'rate_limited', 'integration send quota exceeded; slow down');
      return { statusCode: 429 };
    }
  }

  // The recipient READ now precedes the integration recipient check (hoisted): the crew comparison needs the recipient ROW, not just the
  // ULID in `frame.to`. DELIBERATE error-code change, recorded in: an integration sending to a nonexistent ULID now gets 404
  // `unknown_recipient` where it used to get 403
  // `integration_recipient_forbidden`; the intsend quota above is taken first,
  // so each probe of the existence oracle costs a token.
  const recipient = await deps.db.getUserById(frame.to);
  if (!recipient) {
    await postError(event, deps, 'unknown_recipient', 'no such user');
    return { statusCode: 404 };
  }
  if (recipient.tombstoned === true) {
    // A send to a revoked-with-tombstone ULID refuses AT ENQUEUE
    //the row is dead, and queueing to it
    // would hand a stolen device a mailbox its teardown may not have closed
    // yet. DELIBERATELY DISTINCT from unknown_recipient — a peer holding
    // only the dead ULID re-resolves the surviving roster through the
    // forwarding hint and re-targets the distinction discloses the
    // same fact already disclosed to any ULID-holder. NOT flag-gated:
    // a tombstoned row exists only because a revoke committed, and a kill
    // switch must never resurrect a stolen device's mailbox — enforcement
    // is not a group-aware disclosure surface. Priced
    // exactly like the 404 above: the wsSend quota was taken first.
    await postError(event, deps, 'recipient_revoked', 'this device was revoked by its account');
    return { statusCode: 403 };
  }
  // When the admission below rides the WIDENED owner-group clause, its basis
  // is pinned into the enqueue transaction: the
  // roster read is a precheck, and an amicable unlink committing between it
  // and the enqueue leaves both user rows live — only the group row's own
  // membership set can refuse that race at commit.
  let groupReachPin: GroupReachPin | undefined;
  if (
    sender.accountClass === 'integration' &&
    frame.to !== sender.ownerUserId &&
    !(recipient.accountClass === 'integration' && sameCrew(sender, recipient))
  ) {
    const admission = await ownerGroupAdmission(sender, recipient, deps);
    if (admission.widened !== undefined) {
      groupReachPin = { ...admission.widened, arm: 'send' };
    } else if (!admission.admitted && !(await consentAdmits(recipient, sender, deps))) {
      // The send predicate (widened by /
      // 2, and by at): an integration reaches its
      // owner — since resolved to the owner's device GROUP at predicate
      // time (`ownerGroupAdmission`; the bind itself never migrates) —
      // an INTEGRATION in the same crew, or a HUMAN who wrote a consent edge
      // to it. Never anyone else. The refusal is BYTE-IDENTICAL to the
      // pre-widening one, code and detail both (the error-code freeze): the
      // wire must not teach that a consent mechanism exists, so the sentence
      // below deliberately still names only the owner and the crew.
      await postError(
        event,
        deps,
        'integration_recipient_forbidden',
        'integrations may only message their owner or their crew',
      );
      return { statusCode: 403 };
    }
  }
  if (
    recipient.accountClass === 'integration' &&
    event.senderUserId !== recipient.ownerUserId &&
    !sameCrew(sender, recipient)
  ) {
    const admission = await ownerGroupAdmission(recipient, sender, deps);
    if (admission.widened !== undefined) {
      groupReachPin = { ...admission.widened, arm: 'inbox' };
    } else if (!admission.admitted && !(await consentAdmits(sender, recipient, deps))) {
    // Integrations are notify-only, and their inbox accepts frames from the
    // OWNER — read receipts and profile cards the owner's app sends
    // routinely, and since from ANY member of the owner's device group
    // (`ownerGroupAdmits`, the IDENTICAL helper as the send arm, so one
    // unlink kills both directions) — since
    // from fellow CREW members (the sender row already in hand), and since
    // from a HUMAN whose consent edge to this
    // integration exists — the IDENTICAL edge
    // and helper as the send arm, so one deletion kills both directions.
    // Anyone else being able to fill a bot's queue would make every bot
    // credential a dead-drop read capability. An unbound
    // integration (no ownerUserId yet) still accepts from nobody (the
    // helper's ownerUserId guard fails closed), and a crewless one from
    // nobody but its owner and its consented humans. freezes this
    // refusal's bytes too: code and detail are the pre-widening sentence.
      await postError(
        event,
        deps,
        'integration_inbox_restricted',
        'only the owner or a fellow crew member may message an integration',
      );
      return { statusCode: 403 };
    }
  }

  // Does this send count as USER-AUTHORED correspondence ? Only such a
  // frame may mint the reverse-correspondence signal that exempts a future
  // caller from the ring budget and the stranger queue cap. The server cannot
  // read the ciphertext, but the two carrier bits it CAN read classify it:
  // - `urgent === true` → call signalling (offer/end). Deliberately NOT
  // establishing: the server cannot tell a user's deliberate offer from
  // the call.end/busy the victim's OWN device auto-emits when an attacker
  // rings mid-call, and that involuntary carrier was the mint. Erring
  // toward non-establishment is safe (stricter rate-limiting), never a
  // ring exemption the user did not choose.
  // - `notify === false` → a carrier envelope (read receipt, reaction, edit,
  // deletion, profile-card sync, screenshot notice — frames.ts). Automatic
  // by definition; must not establish.
  // - otherwise → an ordinary user-authored message. Establishes.
  // The frame still queues and counts for the quota either way; this decides
  // ONLY whether it confers a relationship.
  const establishesCorrespondence = frame.urgent !== true && frame.notify !== false;
  // The group collapse for THIS send resolved ONCE
  // with the two rows already in hand and threaded through the enqueue (pair
  // quota + stranger classification) and every wake decision below.
  // Undefined — per-ULID everything, byte-identical to shipped — for
  // solo↔solo sends, and for everyone while `feature#accounts` is OFF or
  // deleted (the kill switch restores per-ULID quota keys).
  const groupCtx = await resolveGroupSendContext(sender, recipient, deps);
  const nowMs = deps.now();
  // Did THIS send store a new row? A duplicate msgId resolves
  // as success (idempotent retry — the sender must never see an error, and
  // never learn from the response that the id was already present) but
  // inserted:false, and every wake decision below is gated on it: an enqueue
  // that stored NOTHING must not spend a push budget. Without the gate, a
  // replayed msgId was a free token drain — three senders replaying one id
  // each burned the victim's shared notification (and stranger-ring) buckets
  // at will, suppressing real senders' wakes without ever adding a message,
  // because duplicates never hit the queue caps that bound genuine inserts.
  let inserted = true;
  try {
    ({ inserted } = await deps.db.enqueueMessage(
      {
        recipientId: frame.to,
        msgId: frame.msgId,
        senderId: event.senderUserId,
        type: frame.msgType,
        payload: frame.payload,
        ts: nowMs,
        expiresAt: Math.floor(nowMs / 1000) + MESSAGE_TTL_SECONDS,
      },
      {
        establishesCorrespondence,
        ...(groupCtx ? { groupCtx } : {}),
        ...(groupReachPin ? { groupReachPin } : {}),
      },
    ));
  } catch (err) {
    // this sender already has too much queued for this recipient. Refuse
    // the NEW frame; nothing already queued is touched.
    // The wording is the SENDER's own backlog and names neither the recipient's
    // existence (a nonexistent recipient 404'd above, before this point) nor
    // its online state — a queue-full message that said "this user isn't
    // reading" would be the enumeration oracle refusals are shaped to
    // deny. Same 429 the flood limiter uses, for the same "slow down" meaning.
    if (err instanceof QueuedQuotaExceededError) {
      await postError(
        event,
        deps,
        'send_quota_exceeded',
        'too many undelivered messages are queued; wait for them to be delivered',
      );
      return { statusCode: 429 };
    }
    // The commit-time tombstone condition refused: a revoke
    // committed between the prechecks above and the
    // enqueue transaction. Answer the SAME bytes the prechecks answer for
    // the same fact — the race must not mint a third refusal shape.
    if (err instanceof QueueParticipantTombstonedError) {
      if (err.side === 'sender') {
        await postError(event, deps, 'unknown_sender', 'account no longer exists');
        return { statusCode: 403 };
      }
      await postError(event, deps, 'recipient_revoked', 'this device was revoked by its account');
      return { statusCode: 403 };
    }
    // The group-reach pin refused at commit: an
    // unlink/revoke serialized between the admission read and the enqueue.
    // Answer the ARM's own FROZEN previous bytes — the race must not
    // mint a third refusal shape, and the wire must not learn that grouping
    // exists.
    if (err instanceof QueueGroupReachRevokedError) {
      if (err.arm === 'send') {
        await postError(
          event,
          deps,
          'integration_recipient_forbidden',
          'integrations may only message their owner or their crew',
        );
        return { statusCode: 403 };
      }
      await postError(
        event,
        deps,
        'integration_inbox_restricted',
        'only the owner or a fellow crew member may message an integration',
      );
      return { statusCode: 403 };
    }
    throw err;
  }

  let delivered = false;
  let conn = await deps.db.getConnection(frame.to);
  // #4 — enforcement must cover RECEIVING, not just the recipient's own frames.
  // The $default recheck stops a revoked socket from SENDING, but a passive
  // socket that only receives kept getting live posts until the proactive
  // revoke deleted its row — and that delete can be in-flight, throttled, or
  // unwired. So validate the recipient socket's bound session HERE too: if the
  // session that opened it is gone or expired, the socket is no longer
  // authorized to receive. Treat it as offline (the ciphertext is already
  // queued and will wake / drain to a re-authenticated login), tear the stale
  // row down, and hang the socket up. One strongly consistent read per live
  // delivery — the guard never caches a positive, so the delivery AFTER a
  // revoke commits is the first one withheld (session-guard.ts states the
  // bound and the cost). A row with NO digest fails CLOSED for the same
  // reason digestless frames do: no session can ever revoke it.
  if (conn !== undefined && !(await sessionAuthorizesDelivery(conn, deps))) {
    // Conditional on THIS connectionId, so a fresh reconnect's row survives.
    await deps.db.deleteConnection(frame.to, conn.connectionId);
    try {
      await deps.disconnectSocket?.(conn.connectionId);
    } catch {
      deps.log('ws_disconnect_on_revoke_failed');
    }
    deps.log('ws_live_delivery_refused_session_revoked');
    conn = undefined;
  }
  // The BANNER wake below requires `inserted`: a duplicate's
  // first enqueue already made its wake decision and charged for it; the
  // replay announces nothing new, so it must not spend the recipient's shared
  // message-notification ceiling. The rare honest loss (a crash between the
  // first enqueue's commit and its wake) costs only the banner: the
  // ciphertext is durably queued and delivers on the next connect either way.
  // The URGENT/CALL wake is deliberately NOT gated — see the comment on that
  // branch.
  if (!conn && inserted && frame.urgent !== true && frame.notify !== false) {
    // Nobody is listening and this is an ordinary message. Before message
    // notifications existed the queue simply waited for the next connect,
    // which meant the app told you nothing until you opened it — the whole
    // reason a messenger feels broken.
    //
    // The push carries the CIPHERTEXT the server just stored. It cannot read
    // it, and the visible body it ships is the generic fallback; how much a
    // notification actually reveals is decided on the device.
    //
    // `notify !== false` is the client saying this frame is TRANSPORT, not
    // conversation — a read receipt, a reaction, an edit, a profile sync.
    // Those rewrite a row that already exists and never become a message on
    // arrival, so a banner for one announces mail that does not exist. The
    // worst case turns "somebody read your message" into "you have a new
    // message" for the person who sent it. The server cannot tell on its own:
    // the distinction is inside the ciphertext and the frames are otherwise
    // identical. Compared with `!==`, not truthiness, so absence means notify
    // and an older client keeps today's behaviour.
    //
    // The ciphertext is queued either way — this suppresses the BANNER, never
    // the delivery.
    //
    // Deliberately NOT sent when a socket is live: the message is about to be
    // delivered over it, and a banner for a conversation already on screen is
    // noise.
    await wakeRecipient(
      frame.to,
      event.senderUserId,
      deps,
      'message',
      { msgId: frame.msgId, msgType: frame.msgType, payload: frame.payload, ts: nowMs },
      undefined,
      groupCtx,
    );
  }
  if (!conn && frame.urgent === true) {
    // Nobody is listening and the sender says this is time-critical — the one
    // case where a push is justified. Fire it BEFORE the
    // delivery attempt below is even considered, because there is no live
    // socket to attempt. Bounded per SENDER so one caller cannot ring-bomb a
    // victim and best-effort: a push that fails is never the sender's
    // problem, because the caller's UI already degrades to "they may be
    // offline" on its own timer.
    // Deliberately NOT gated on `inserted`, unlike the banner branch above.
    // Suppressing this push when the (recipientId,msgId) row already exists
    // is a denial-of-RING primitive — a legitimate retry of a call offer
    // (client resend after a dropped ack, a crash between enqueue and wake)
    // would silently never ring the callee's phone, and denial-of-RING is on
    // this project's explicitly REJECTED remedies list. The anti-abuse
    // control on this path is the per-SENDER bound inside
    // wakeRecipient, not duplicate suppression. If the two adjacent branches
    // look inconsistent, that is because a banner is deferrable and a ring is
    // not — do not "fix" this back into the gate.
    await wakeRecipient(frame.to, event.senderUserId, deps, 'call', undefined, undefined, groupCtx);
  }
  if (conn) {
    const msg: MsgFrame = {
      type: 'msg',
      from: event.senderUserId,
      msgId: frame.msgId,
      msgType: frame.msgType,
      payload: frame.payload,
      ts: nowMs,
    };
    delivered = await deps.sender.post(conn.connectionId, msg);
    if (delivered && frame.urgent === true) {
      // THE FROZEN-CALLEE HOLE (hardware testing). `post()`
      // resolving true means API Gateway took the bytes for a connection it
      // still believes is open — which is exactly what a half-open TCP into a
      // SUSPENDED iOS process looks like. A callee that kept a live conn row
      // through a call (the app pauses messaging only once the call machine is
      // idle, and skips the pause entirely behind the lock route) and then
      // froze when CallKit released the call leaves that row behind: an
      // immediate redial's offer was "delivered" into a socket nobody was
      // reading, no push was ever sent, the callee never rang, and the caller
      // sat in "Calling…" until its own 45-60 s timers.
      //
      // So the wake can no longer be skipped on the ROW's existence — but it
      // must not fire unconditionally either: `call.end` is urgent on EVERY
      // announced end (shared/call-machine.ts), so an unconditional wake here
      // VoIP-pushes the peer who just heard the hangup over a perfectly
      // healthy socket, and nothing arrives afterwards to dismiss the
      // placeholder that push must report — a 75-second ghost ring, per
      // hangup, both directions. The wake is therefore conditional on the
      // recipient's own ACK — the only liveness proof this system has: the
      // worker waits out the grace, re-reads the queued row (acks delete it),
      // and rings only if it survived. Fails toward RINGING.
      await wakeRecipient(
        frame.to,
        event.senderUserId,
        deps,
        'call',
        undefined,
        { msgId: frame.msgId, ackGraceMs: URGENT_ACK_GRACE_MS },
        groupCtx,
      );
    }
    if (!delivered) {
      if (conn.connectedAt <= nowMs - CONNECTION_REAP_GRACE_MS) {
        // The recipient's socket is gone but $disconnect never fired for it.
        // Conditional on the exact connectionId we posted to: a reconnect
        // racing this send keeps its newer row. Rows younger than the grace
        // window are spared — the recipient may still be mid-handshake (see
        // CONNECTION_REAP_GRACE_MS). The sender-side deletes below need no
        // grace: an inbound frame proves the sender's own socket established.
        await deps.db.deleteConnection(frame.to, conn.connectionId);
      }
      // A connection row that would not take the bytes was never a
      // connection: make the SAME wake decision the no-connection branch
      // above made, or a phone whose socket died without a $disconnect gets
      // neither the delivery nor the banner.
      //
      // Re-read first. The recipient may have RECONNECTED between the read
      // above and the failed post — the failure proves the OLD socket is
      // dead, not that nobody is listening — and the fresh connection's own
      // $connect drain delivers the queued frame. Waking here would banner a
      // message the person is about to watch arrive.
      let fresh = await deps.db.getConnection(frame.to);
      // The fresh row is held to the SAME session gate as the first read —
      // its $connect validated its session moments ago, but "moments ago" is
      // exactly the in-flight overlap the guard bounds, and a digestless
      // fresh row fails closed like any other. Without this, the retry post
      // was the one delivery path with no session check at all.
      if (
        fresh &&
        fresh.connectionId !== conn.connectionId &&
        !(await sessionAuthorizesDelivery(fresh, deps))
      ) {
        await deps.db.deleteConnection(frame.to, fresh.connectionId);
        try {
          await deps.disconnectSocket?.(fresh.connectionId);
        } catch {
          deps.log('ws_disconnect_on_revoke_failed');
        }
        deps.log('ws_live_delivery_refused_session_revoked');
        fresh = undefined;
      }
      if (fresh && fresh.connectionId !== conn.connectionId) {
        // A newer socket owns delivery now — but do not TRUST it with this
        // frame, hand it over. The newer row's $connect drain read the queue
        // at some instant, and DynamoDB's eventual consistency means this
        // frame's queued row may not have been visible to that read yet:
        // suppressing on the row's existence alone can silence the ONLY wake
        // an urgent call offer gets. Posting is definitive either way — it
        // lands (delivered), or the newer socket is dead too and the wake
        // decision below proceeds exactly as if no one were listening.
        delivered = await deps.sender.post(fresh.connectionId, msg);
        // Same gate split as the no-connection branches above:
        // a replayed msgId aimed at a recipient with a dead-but-unreaped
        // connection row lands in THIS branch, not the no-connection one, so
        // the BANNER wake gates on `inserted` here too — a duplicate's failed
        // post must not charge the shared notification ceiling through a
        // different door. The URGENT/CALL wake is deliberately NOT gated:
        // suppressing it would be denial-of-RING (a retried call offer would
        // silently never ring), and its anti-abuse control is the per-SENDER
        // bound inside wakeRecipient.
        if (delivered) {
          if (frame.urgent === true) {
            // Same probe as the first-post path: a NEWER row taking the bytes
            // proves no more about the process behind it than the older one
            // did.
            await wakeRecipient(
              frame.to,
              event.senderUserId,
              deps,
              'call',
              undefined,
              { msgId: frame.msgId, ackGraceMs: URGENT_ACK_GRACE_MS },
              groupCtx,
            );
          }
        } else if (frame.urgent === true) {
          await wakeRecipient(
            frame.to,
            event.senderUserId,
            deps,
            'call',
            undefined,
            undefined,
            groupCtx,
          );
        } else if (inserted && frame.notify !== false) {
          await wakeRecipient(
            frame.to,
            event.senderUserId,
            deps,
            'message',
            { msgId: frame.msgId, msgType: frame.msgType, payload: frame.payload, ts: nowMs },
            undefined,
            groupCtx,
          );
        }
      } else if (frame.urgent === true) {
        // RING, not banner: not gated on `inserted` — see the gate-split
        // comment above (denial-of-RING; per-sender bound is the control).
        await wakeRecipient(frame.to, event.senderUserId, deps, 'call', undefined, undefined, groupCtx);
      } else if (inserted && frame.notify !== false) {
        await wakeRecipient(
          frame.to,
          event.senderUserId,
          deps,
          'message',
          { msgId: frame.msgId, msgType: frame.msgType, payload: frame.payload, ts: nowMs },
          undefined,
          groupCtx,
        );
      }
    }
  }

  const receipt: ReceiptFrame = {
    type: 'receipt',
    msgId: frame.msgId,
    state: delivered ? 'delivered' : 'sent',
  };
  const receiptPosted = await deps.sender.post(event.connectionId, receipt);
  if (!receiptPosted) {
    // The sender's own socket died before the receipt landed: clear its stale
    // row (conditional; a newer reconnect row survives).
    await deps.db.deleteConnection(event.senderUserId, event.connectionId);
  }
  return { statusCode: 200 };
}

/** ack — the recipient confirms processing; delete the queued row. */
async function handleAck(frame: AckFrame, event: WsMessageEvent, deps: WsDeps): Promise<WsResult> {
  await deps.db.deleteQueuedMessage(event.senderUserId, frame.msgId);
  return { statusCode: 200 };
}

/**
 * typing — relay-only by design.
 *
 * The contract, stated as what this handler must NEVER do:
 * - never enqueueMessage: no durable row, no quota ledger, no 30-day TTL;
 * - never wakeRecipient: a typing signal is not worth a radio;
 * - never post a receipt, and never vary the result by recipient state.
 * A `send` reveals connection state too, but at the price of a
 * persisted, quota-charged, recipient-visible message; a typing frame
 * is silent and free, so echoing delivery would be a stealth presence
 * oracle. Every fall-through below returns the SAME success value.
 * - never mint correspondence: typing is automatic, not user-authored
 * (the classification `establishesCorrespondence` encodes for
 * carriers applies with more force here).
 *
 * Strangers are dropped: with no established correspondence in EITHER
 * direction, this would be a free, traceless probe/harassment channel.
 * Either direction, because the first reply in a conversation the other
 * side opened should still show typing.
 *
 * Integration senders relay toward exactly the recipients the send
 * predicate lets them message — their owner, a same-crew integration, or
 * a human whose consent edge admits them — and
 * draw the uniform drop toward anyone else, which is what EVERY integration
 * typing frame drew .1. Symmetrically, a human's typing toward an
 * integration is held to the inbox predicate (see the branch comment for
 * why the correspondence ledger stopped being a sufficient proxy the day
 * edges became deletable).
 */
async function handleTyping(
  frame: TypingFrame,
  event: WsMessageEvent,
  deps: WsDeps,
): Promise<WsResult> {
  // Per-sender flood control on typing's OWN bucket (never wsSend's — typing
  // must not be able to starve real messages, nor be starved by them).
  const retry = await deps.rateLimit.take(`typing:${event.senderUserId}`, LIMITS.typing);
  if (retry > 0) {
    await postError(event, deps, 'rate_limited', 'too many typing frames; slow down');
    return { statusCode: 429 };
  }

  const uniform: WsResult = { statusCode: 200 };

  // A deleted account gets the uniform drop, not an error: any distinct
  // refusal on this free, silent path is an oracle. A TOMBSTONED sender row
  // drops the same way: the tombstone written by a
  // revoke transaction IS the enforcement across the teardown crash window —
  // handleSend refuses it as `unknown_sender`, and typing must not remain
  // the one live channel a revoked device (or a revoked device's agent)
  // keeps until session cleanup lands. Uniform 200 either way.
  const sender = await deps.db.getUserById(event.senderUserId);
  if (sender === undefined || sender.tombstoned === true) return uniform;

  if (sender.accountClass === 'integration') {
    // By design: an integration's typing frame
    // relays iff the recipient is its owner or a same-crew integration — the
    // send predicate from handleSend, same shape, same `sameCrew` helper,
    // so typing can never reach a recipient a durable send could not.
    // Everyone else — stranger, unbound, cross-crew, nonexistent — draws the
    // SAME uniform drop every integration typing frame drew .1, so
    // the response teaches nothing new. The recipient-row read is NEW on
    // this path (the human branch below never takes it) and is priced the
    // way handleSend prices its recipient read: the sender's bucket — here
    // `typing:`, taken at the top — is spent before the read, so each probe
    // costs a token; and unlike handleSend's 404/403 split, every outcome
    // here is the same 200, so the read answers nothing about who exists.
    // The correspondence-ledger gate below stays the HUMAN stranger
    // defence: for integrations the owner/crew bind is the stricter,
    // deliberately-established relationship, exactly as it is on the send
    // path, which also asks no ledger question.
    const recipient = await deps.db.getUserById(frame.to);
    if (recipient === undefined) {
      // The edge read is UNCONDITIONAL on this branch even though no
      // recipient exists to admit: every
      // frame here already involves an integration — the sender — and the
      // branch's uniformity claim is that its refusal outcomes are
      // indistinguishable. Short-circuiting the read for a nonexistent
      // target made "no such account" one strongly consistent GetItem
      // cheaper than "exists but refused" — exactly the avoidable timing
      // tell consentAdmits' read-first rule exists to close. The result is
      // discarded; the cost is what buys the parity, and it is paid only on
      // integration-sender typing, never on the human↔human hot path.
      await deps.db.hasConsentEdge(frame.to, event.senderUserId);
      return uniform;
    }
    // A tombstoned recipient row is a COMMITTED revoke: the durable send
    // path refuses it at enqueue (`recipient_revoked` — a fact already
    // discloses to any ULID-holder), so typing must never still relay to the
    // revoked device's socket across the teardown crash window (the
    // exact-owner arm otherwise bypasses every
    // tombstone gate on this path). Same uniform 200.
    if (recipient.tombstoned === true) return uniform;
    if (
      frame.to !== sender.ownerUserId &&
      !(recipient.accountClass === 'integration' && sameCrew(sender, recipient)) &&
      !(await ownerGroupAdmits(sender, recipient, deps)) &&
      !(await consentAdmits(recipient, sender, deps))
    ) {
      // 2: the consent clause widens typing on the IDENTICAL helper the
      // send arm uses — and the owner-group clause
      // widens it on ITS identical helper too —
      // preserving the invariant that
      // typing can never reach a recipient a durable send could not — in
      // BOTH directions of change: an edge (or a roster membership) admits
      // both, its deletion (or the unlink/revoke) refuses both on the next
      // frame (hasConsentEdge and the roster read are strongly
      // consistent). The consent read is priced exactly as the recipient
      // read was .1: the sender's typing bucket is spent first, and
      // every outcome is the same uniform 200.
      return uniform;
    }
  } else {
    const nowSec = Math.floor(deps.now() / 1000);
    const established =
      (await deps.db.hasQueuedCorrespondence(event.senderUserId, frame.to, nowSec)) ||
      (await deps.db.hasQueuedCorrespondence(frame.to, event.senderUserId, nowSec));
    if (!established) return uniform;
    // 2 — an integration RECIPIENT holds a human's typing to the same
    // inbox predicate the durable send meets (owner / same crew / consent,
    // the identical clause and helper as handleSend's inbox arm). The
    // correspondence ledger alone was sufficient before consent edges
    // existed — no ledger toward a non-owner, non-crew integration could
    // ever be minted, because the durable sends that mint one were all
    // refused — but a REVOCABLE edge breaks that derivation: the ledger
    // outlives a deleted edge by up to the message TTL (~30 days), and
    // typing riding it would keep reaching an inbox a durable send can no
    // longer reach — exactly the pinned invariant. The recipient read
    // is NEW on this branch and priced the same way the integration
    // branch's was: the typing bucket is spent first, and every
    // outcome stays the same uniform 200. Human->human typing pays the one
    // extra GetItem and behaves byte-identically.
    // WHY THAT GetItem CANNOT BE SCOPED AWAY (two
    // constraints reconciled). The CONSENT read (hasConsentEdge, inside
    // consentAdmits) is already scoped to frames where an integration is
    // involved: on this branch it runs only for an integration-class
    // recipient, and on the integration-sender branch every frame involves
    // one by construction. What runs on every established human↔human
    // frame is the recipient CLASS read — the minimum fact that decides
    // whether the inbox predicate applies at all. Scoping IT needs a
    // cheaper signal that itself distinguishes recipients (a refusal path
    // this uniform branch must not have) or a second copy of the class bit
    // denormalized onto another row (authorization state that can rot
    // apart from its source — the sameCrew guard exists because exactly
    // such drift bites). One point read per established typing frame,
    // identical for every recipient, is the honest price; the alternative
    // buys ~25% of the branch's reads back by minting either an oracle or
    // a shadow class table.
    const recipient = await deps.db.getUserById(frame.to);
    if (recipient === undefined) return uniform;
    // The tombstone gate, on this branch too: a correspondence
    // ledger outlives a revoke by up to the message TTL, and typing riding
    // it would keep reaching a revoked device's socket the durable path
    // already refuses at enqueue.
    if (recipient.tombstoned === true) return uniform;
    if (
      recipient.accountClass === 'integration' &&
      event.senderUserId !== recipient.ownerUserId &&
      !sameCrew(sender, recipient) &&
      !(await ownerGroupAdmits(recipient, sender, deps)) &&
      !(await consentAdmits(sender, recipient, deps))
    ) {
      return uniform;
    }
  }

  const conn = await deps.db.getConnection(frame.to);
  if (conn === undefined) return uniform;
  if (!(await sessionAuthorizesDelivery(conn, deps))) {
    // Same enforcement as the send path: a revoked session's socket
    // is torn down, never delivered to. The response stays uniform.
    await deps.db.deleteConnection(frame.to, conn.connectionId);
    try {
      await deps.disconnectSocket?.(conn.connectionId);
    } catch {
      deps.log('ws_disconnect_on_revoke_failed');
    }
    deps.log('ws_live_delivery_refused_session_revoked');
    return uniform;
  }

  const relay: TypingMsgFrame = {
    type: 'typing',
    from: event.senderUserId,
    msgType: frame.msgType,
    payload: frame.payload,
    ts: deps.now(),
  };
  // A failed post is a stale row some real send will reap. Typing spends
  // nothing on cleanup, wakes nothing, and drops on the floor.
  await deps.sender.post(conn.connectionId, relay);
  return uniform;
}

async function postError(
  event: Pick<WsMessageEvent, 'connectionId' | 'senderUserId'>,
  deps: WsDeps,
  code: string,
  detail: string,
): Promise<void> {
  const posted = await deps.sender.post(event.connectionId, { type: 'error', code, detail });
  if (!posted) {
    // The caller's socket is already gone: clear its stale row (conditional;
    // a newer reconnect row survives).
    await deps.db.deleteConnection(event.senderUserId, event.connectionId);
  }
}
