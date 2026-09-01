import { ServerFrame, type ClientFrame } from '@tacendum/shared';
import { WS_URL } from './config';

export type WsState = 'connecting' | 'open' | 'closed';

/**
 * What an auth check can conclude about a socket that would not stay up. The check itself lives in `reauth.ts` and is INJECTED:
 * this file must not learn about the Keychain, `signAuthChallenge` or the REST
 * client, and the caller must not have to know which host refused it.
 */
export type WsAuthOutcome =
  /**
   * Not an auth failure — back off as usual.
   *
   * `conclusive` says whether the check actually LEARNED that: true means the
   * server answered and the credential is live; absent means the check never
   * got an answer (no network, no bearer to ask with, a duress session that
   * must not ask). Only a conclusive blip spends this episode's one probe —
   * see `runAuthCheck`. Unknown defaults to inconclusive on purpose: refunding
   * a probe costs one request, and not refunding one costs the whole feature.
   */
  | { verdict: 'blip'; conclusive?: boolean }
  /** A fresh session exists; here is the token to dial with. */
  | { verdict: 'reauthed'; token: string }
  /** Terminal: this account no longer exists. Stop reconnecting. */
  | { verdict: 'gone' };

export type WsAuthCheck = () => Promise<WsAuthOutcome>;

/**
 * Mint a single-use ticket for ONE dial, or null if one
 * cannot be had right now.
 *
 * Injected for the same reason the auth check is: this file must not learn
 * about the Keychain or the REST client. Null is not an error — a duress
 * session mints nothing, and an offline phone cannot — it means "dial the old
 * way or not at all", and the caller decides which.
 */
export type WsTicketMint = () => Promise<string | null>;

/** The local adapter's "your token is dead" close (`local/ws.ts`: the upgrade
 * completes, `$connect` authenticates, then `socket.close(4001,
 * 'unauthorized')`). AWS never sends it — there the authorizer denies before
 * the upgrade and RN reports 1006 — which is why `onclose` below needs both
 * this code AND the never-opened case to cover the two hosts. */
const UNAUTHORIZED_CLOSE = 4001;

/**
 * How long a socket must stay up before it counts as proof of a live
 * credential. Authorization is bound once, at `$connect`, and that is one
 * store lookup — single-digit milliseconds. A connection that survived this
 * long was authenticated, so the NEXT refusal deserves a fresh probe; a
 * connection that opened and died inside it (the local adapter's 4001 arrives
 * milliseconds after open) proves nothing and must not buy one.
 */
const HEALTHY_MS = 5_000;

/**
 * How long one dial may take before it is written off as stalled.
 *
 * Generous on purpose: this is not a latency budget, it is a liveness floor.
 * A healthy dial is a mint and an upgrade — tens of milliseconds on a local
 * rig, a few seconds on a bad cell connection — so twenty seconds cannot
 * abort anything that was going to succeed, and it bounds the one failure
 * mode that has no other exit (see `armDialWatchdog`).
 */
const DIAL_TIMEOUT_MS = 20_000;

/**
 * One attempt to get a socket up: from `connect` to whichever of `onopen`,
 * `onclose` or the watchdog arrives first.
 *
 * It exists so the deadline has an OWNER. The client used to hold a single
 * `dialing` flag and a single watchdog handle, and on the device that let one
 * dial's ending cancel a different dial's deadline — leaving a stalled socket
 * with nothing watching it and the client with nothing armed.
 */
interface Dial {
  /** Ended, by any route. Guards the watchdog against a dial already over. */
  done: boolean;
  /** The transport this dial produced, once it has one. */
  socket: WebSocket | null;
  /** This dial's deadline, cancelled by this dial and nothing else. */
  wake: WsWake | null;
}

/** A reconnect that has been armed and not yet fired. `cancel` is idempotent:
 * `suspend`, `stop` and `adoptToken` all call it, sometimes over each other. */
export interface WsWake {
  cancel(): void;
}

/**
 * Who arms the delay before the next dial — the ONE seam this file has onto
 * the platform's idea of time.
 *
 * It exists because of a measured defect, not a preference. React Native's
 * Android timer module is driven by a Choreographer frame callback that
 * `onHostPause` removes, so `setTimeout` is DEFERRED — not cancelled, not
 * fired late, simply parked — for as long as the Activity is paused. Measured
 * on the emulator with the foreground service running the whole
 * time: a self-rescheduling 5-second chain fired 0 times in 100 seconds
 * backgrounded, then 3 times within 12 seconds of the app being foregrounded.
 *
 * Every reconnect in this class is scheduled through here, so on Android that
 * meant a socket which DROPPED while the app was away could not dial again
 * until the person opened the app — which is precisely what
 * `MessagingForegroundService` exists to prevent. The
 * socket surviving backgrounding was never the problem; RE-dialling was.
 *
 * The default is `setTimeout` and stays that way on iOS and in every test:
 * there the app closes its socket on backgrounding on purpose, so a timer
 * that sleeps with the process is correct. `app/src/background.ts` installs
 * an Android implementation backed by the foreground service's own thread,
 * which no Choreographer touches.
 */
export interface WsWakeScheduler {
  schedule(delayMs: number, fire: () => void): WsWake;
}

const TIMEOUT_SCHEDULER: WsWakeScheduler = {
  schedule(delayMs, fire) {
    const handle = setTimeout(fire, delayMs);
    return {
      cancel: () => clearTimeout(handle),
    };
  },
};

let wakeScheduler: WsWakeScheduler = TIMEOUT_SCHEDULER;

/**
 * Install the scheduler every later reconnect is armed through, or `null` to
 * go back to `setTimeout`.
 *
 * Module-level rather than a constructor argument because the installer
 * (background.ts) and the owner (messaging.ts) are different files with no
 * reference to each other, and because it is read at ARM time: a session that
 * dialled before the native module published itself picks the new scheduler up
 * on its very next backoff, with nothing to re-wire.
 */
export function setWsWakeScheduler(next: WsWakeScheduler | null): void {
  wakeScheduler = next ?? TIMEOUT_SCHEDULER;
}

/**
 * WS client with silent reconnect + exponential backoff. Frames are
 * zod-validated; malformed server frames are ignored. RN provides WebSocket.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private backoffMs = 1000;
  private reconnectTimer: WsWake | null = null;
  /**
   * The dial that is currently outstanding, or null when none is.
   *
   * A RECORD RATHER THAN A FLAG, and the difference is the whole repair. The
   * first version of this was a boolean plus one watchdog handle on the client,
   * and it wedged on the device: a dial that ended — an old socket's `onclose`
   * arriving late — cleared the watchdog belonging to a DIFFERENT dial that was
   * still outstanding, and that dial then stalled with nothing watching it.
   * Measured: the server logged the upgrade, the app never saw
   * `onopen`, and the client sat at `closed` with no timer for five minutes.
   * A deadline that someone else can cancel is not a deadline, so each dial now
   * owns its own and only it can spend it.
   */
  private dial: Dial | null = null;
  private closedByUser = false;
  /** Injected by messaging.start() as start()'s second argument (see below). */
  private authCheck: WsAuthCheck | null = null;
  /** See WsTicketMint. Installed and cleared with authCheck, same lifetime. */
  private mintTicket: WsTicketMint | null = null;
  /** One probe per failure episode, never one per retry — otherwise the
   * disambiguation becomes its own hammer against `/v1/me`. */
  private probed = false;
  /**
   * One MINT per failure episode, for the reason `api.ts` retries a 401 exactly
   * once: a fresh token that is refused too is server truth, not a stale
   * credential. Without this, a server that issues tokens its own authorizer
   * rejects — replication lag, deployment skew, clock drift — is answered with
   * an unbounded loop of probe + challenge + auth + dial at zero delay, each
   * mint revoking the one before it. Cleared only by a connection that lasts.
   */
  private minted = false;
  /**
   * Bumped by `stop()`. An auth check that was already in flight belongs to the
   * session that started it: `closedByUser` alone cannot express that, because
   * `start()` clears it, so a relock-then-unlock inside one slow probe would let
   * the old check's verdict land on the new session — connecting it, latching
   * `unauthorized` on it, or (if the old fetch hangs) leaving `authPending` set
   * so the fresh session never dials at all and just reads "Offline".
   */
  private epoch = 0;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  /** A check is deciding. Reconnects are suppressed until it answers: re-auth
   * THEN reconnect, never a dial that races the mint. */
  private authPending = false;
  /** Terminal (`gone`). The one state in which this client stops trying. */
  private unauthorized = false;
  /** When the live socket opened, or null if it never did — the input to the
   * "was this a refused upgrade?" question. */
  private openedAt: number | null = null;

  private frameHandlers = new Set<(frame: ServerFrame) => void>();
  private stateHandlers = new Set<(state: WsState) => void>();

  /**
   * `authCheck` rides on start() rather than a setter of its own
   * because stop() clears it along with the
   * frame and state handlers — the same teardown rule, for the same reason: a
   * check closed over a previous session's token must not outlive that
   * session. Passing it here makes "re-installed on every start" structural
   * instead of a convention someone has to remember.
   */
  start(token: string, authCheck?: WsAuthCheck, mintTicket?: WsTicketMint): void {
    this.token = token;
    this.authCheck = authCheck ?? null;
    this.mintTicket = mintTicket ?? null;
    this.closedByUser = false;
    // A fresh start is a fresh credential (App.tsx re-authenticated, or a
    // different workspace opened): neither the terminal latch nor the
    // one-probe budget from the previous session may carry into it.
    this.unauthorized = false;
    this.probed = false;
    this.minted = false;
    // A dial belonging to the session that just ended must not hold the
    // one-dial latch shut against this one. `suspend`/`stop` release it, and
    // every start() in the app follows one of them — but a latch whose
    // correctness depends on the caller's history is a latch that will
    // eventually be held by a session that no longer exists, and the symptom
    // would be a socket that never dials again with nothing to point at.
    this.releaseDial();
    this.connect();
  }

  private armHealthy(): void {
    this.clearHealthy();
    this.healthyTimer = setTimeout(() => {
      this.healthyTimer = null;
      this.backoffMs = 1000;
    }, HEALTHY_MS);
  }

  private clearHealthy(): void {
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }
  }

  private connect(): void {
    if (!this.token || this.closedByUser) return;
    // Two suppressions the original guard did not need: a socket that has been
    // told the account is gone must never dial again, and a dial during a
    // pending check would present the token the check is in the middle of
    // replacing (`POST /v1/auth` revokes prior sessions the instant it
    // succeeds, so that dial is dead before it is answered).
    if (this.unauthorized || this.authPending) return;
    /*
     * ONE DIAL AT A TIME — by SUPERSEDING the outstanding one, never by
     * refusing to dial. Both halves of that sentence were paid for on the
     * device (`LEG: background-redial`).
     *
     * The overlap is real. This method is synchronous but the dial it starts is
     * not, so two callers a few milliseconds apart each minted a ticket and
     * each opened a socket: the server log shows two `ws_ticket_issued` four
     * milliseconds apart against ONE `ws_connect_auth`, and a run of
     * `ws_connect_incumbent_spared` after it. Tickets are single-use, so the
     * loser of that race holds a dial that cannot succeed.
     *
     * And REFUSING was worse than the overlap. The first attempt at this made
     * an outstanding dial turn `connect()` into a no-op — which meant a caller
     * that had just revoked the queued reconnect (`adoptToken` does exactly
     * that) left the client with no dial and no timer. Measured: the socket sat
     * `closed` with nothing armed until the app was foregrounded, which is the
     * very failure this whole change exists to remove, reintroduced by its own
     * repair. `connect()` must always end in a dial. Anything that can answer
     * "no" to a reconnect request is a wedge waiting for the right interleaving.
     */
    this.releaseDial();
    const dial: Dial = { done: false, socket: null, wake: null };
    this.dial = dial;
    this.emitState('connecting');
    // Its own deadline, armed with it and spendable only by it. See `Dial`.
    dial.wake = wakeScheduler.schedule(DIAL_TIMEOUT_MS, () => this.failDial(dial));

    /*
     * A ticket per dial, never a cached one. The bearer used
     * to go in this URL, and a URL is written down by every proxy and access
     * log it passes; a ticket that has already been spent by `$connect` is
     * worthless in one. Reusing a ticket across reconnects would recreate
     * exactly the long-lived credential this removes.
     *
     * The mint is asynchronous and this method is not, so the dial moves into
     * the continuation and `epoch` decides whether it may still happen: a
     * stop() during the mint — a relock, a sign-out — must not be followed by a
     * socket appearing a moment later.
     */
    const epoch = this.epoch;
    void (async () => {
      let query = `token=${encodeURIComponent(this.token ?? '')}`;
      if (this.mintTicket) {
        let ticket: string | null;
        try {
          ticket = await this.mintTicket();
        } catch {
          /*
           * A MINT FAILURE IS A FAILED DIAL, not a quiet downgrade.
           *
           * This used to be `.catch(() => null)`, which fell through to the
           * bearer-in-the-URL path on any error at all — so anyone who could
           * make the mint fail (a 5xx, a 429, a blocked request) got the very
           * defect this change removes, on demand, while the socket host
           * stayed up. The mint distinguishes the one benign case itself and
           * returns null for it; anything reaching here is a real failure and
           * the right answer is to back off and try the whole dial again.
           */
          this.endDial(dial);
          if (epoch === this.epoch) this.scheduleReconnect();
          return;
        }
        if (ticket) query = `ticket=${encodeURIComponent(ticket)}`;
      }
      if (dial.done || epoch !== this.epoch || this.closedByUser || this.unauthorized) {
        // A dead end that used to leave `connecting` on the screen forever:
        // whoever moved the epoch owns the teardown, but the dial itself has
        // to be released or the guard above would refuse every dial after it.
        //
        // `dial.done` is the one that cost a device run. This mint is a
        // `fetch`, and a `fetch` can answer LONG after the dial that asked for
        // it was written off — the watchdog fires at 20 s, and OkHttp will
        // happily retry a request onto a fresh connection when the far end
        // comes back and answer a minute later. Opening a socket then produces
        // a transport with NO OWNER: no deadline armed for it, `endDial` a
        // no-op, `this.socket` quietly stolen from the dial the client is
        // actually holding — and on the server it authenticates and claims the
        // account's routing row, after which every honest re-dial is refused
        // against it. Measured: one such late mint, and the adapter
        // logged `ws_connect_incumbent_spared` for every dial that followed.
        //
        // This is NOT `connect()` learning to answer "no" — that shape was
        // tried and backed out for stranding the client. Every `connect()` call
        // still ends in a dial; this is a dial that has ALREADY ended declining
        // to open a second one behind the back of whatever replaced it, and
        // whoever ended it either dialled again or queued a reconnect.
        this.endDial(dial);
        return;
      }
      this.openSocket(`${WS_URL}?${query}`, dial);
    })();
  }

  /**
   * LET GO OF A TRANSPORT — and make sure it actually goes.
   *
   * `socket.close()` is not a close on this platform, and the difference was
   * the difference between a bad minute and a permanent one. React Native's
   * polyfill marks the object CLOSING and calls `WebSocketModule.close(id)`,
   * which looks the id up in `webSocketConnections` — a map written in OkHttp's
   * `onOpen` and nowhere else — finds nothing for a socket whose upgrade is
   * still in flight, and returns having done nothing at all. OkHttp finishes
   * the upgrade a moment later. The connection is then live at both ends, this
   * client's handlers are off it, and the polyfill's own guard (`close()`
   * returns early when readyState is CLOSING) means nobody can ever ask for it
   * again.
   *
   * Measured on Pixel_7_API_35: six sockets closed one line after
   * construction left SIX live connections standing, counted in the device's
   * own /proc/net/tcp6 and in the far end's log, while the app believed it held
   * none.
   *
   * THAT IS A DELIVERY DEFECT, NOT A LEAK. The server routes an account to ONE
   * connection and spares an incumbent that still takes bytes
   * (`ws_connect_incumbent_spared`), so an orphan holds the routing row: every
   * honest re-dial after it is refused, and every message for the account is
   * posted into a socket whose frames reach no handler and are never acked.
   * Measured in the same run — after one stalled dial was written off, the
   * adapter logged `incumbent_spared` for every single re-dial that followed,
   * for as long as the process lived.
   *
   * So the one handler NOT detached here is `onopen`, and its only job is to
   * close the socket for real: the polyfill sets readyState back to OPEN before
   * it dispatches that event, so the second `close()` passes the guard and
   * finds the entry the native map now has. Verified on the device — three
   * sockets closed while connecting, all three hung up within milliseconds of
   * their upgrade completing.
   */
  private discardSocket(socket: WebSocket): void {
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.onopen = () => {
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // A transport that will not close is one this client cannot help.
      }
    };
    try {
      socket.close();
    } catch {
      // See above — the `onopen` armed a line up is the second attempt anyway.
    }
    if (this.socket === socket) this.socket = null;
  }

  /**
   * The outstanding dial is over, and so is whatever transport this client was
   * holding: end the dial, and let both transports go through `discardSocket`.
   *
   * ONE METHOD FOR TWO CALLERS, and the day they were two methods is the day a
   * socket got left standing. `connect()` calls it because a newer dial is
   * replacing the old one; `start`, `suspend` and `stop` call it because the
   * session is over. The INTENT differs and the work does not — "let go of the
   * transport" is the same work either way — and the version that skipped the
   * transport on the teardown path let `start()` orphan the dial the last
   * session had in flight.
   *
   * Quietly, in both cases: no `closed` emitted and no reconnect queued. A
   * supersede is followed by the dial that IS the reconnect, and a teardown is
   * a decision that there should be no socket.
   */
  private releaseDial(): void {
    const dial = this.dial;
    if (dial !== null) {
      const socket = dial.socket;
      this.endDial(dial);
      if (socket) this.discardSocket(socket);
    }
    // A transport with no outstanding dial behind it — an open socket a fresh
    // `start()` is about to replace. `discardSocket` is idempotent, so the
    // common case where this is the same object costs nothing.
    const held = this.socket;
    if (held) this.discardSocket(held);
  }

  /**
   * A dial is over, however it ended: opened, closed, refused, superseded, or
   * written off. Idempotent, and it never touches the transport — the caller
   * knows what state the socket is in and this does not.
   *
   * `this.dial` is only cleared when the dial ENDING is the outstanding one. A
   * late finish from a superseded dial must not unlatch a newer one.
   */
  private endDial(dial: Dial): void {
    dial.done = true;
    const wake = dial.wake;
    dial.wake = null;
    wake?.cancel();
    if (this.dial === dial) this.dial = null;
  }

  /**
   * THE DIAL WATCHDOG — the answer to "what if the dial neither opens nor
   * closes?", which the device proved is not a hypothetical.
   *
   * Measured (`LEG: background-redial`): with the app backgrounded
   * and the adapter restarted under it, the server logged the upgrade and the
   * app never saw `onopen` — it sat at `closed`/`connecting` with nothing armed
   * until somebody opened the app. Nothing in this class could have rescued it:
   * `onopen` and `onclose` are the only two things that schedule anything, so a
   * dial that produces neither schedules nothing at all.
   *
   * So a dial gets a deadline, and when it expires the dial is written off
   * exactly as a refusal would be — socket detached and closed, `closed`
   * reported, back to the queue — and the backoff carries on doing its job.
   * Armed through the same scheduler the reconnects use, because a watchdog
   * that is itself asleep while the Activity is paused would watch nothing on
   * the one platform this was built for.
   */
  private failDial(dial: Dial): void {
    if (dial.done) return;
    const wasCurrent = this.dial === dial;
    const socket = dial.socket;
    this.endDial(dial);
    // Detached before close, the same rule `stop()` states: this socket's late
    // events describe a dial that has already been written off, and a stray
    // `onclose` would schedule a second reconnect on top of ours. THIS is the
    // path that made `discardSocket` necessary — a written-off dial is by
    // definition one whose upgrade had not completed, which is exactly the case
    // React Native's `close()` cannot honour.
    if (socket) this.discardSocket(socket);
    // A dial the client had already moved past is simply dropped: the transport
    // it left behind is closed above, and announcing `closed` or queueing a
    // reconnect on behalf of a superseded dial would fight whatever replaced it.
    if (!wasCurrent) return;
    this.openedAt = null;
    this.clearHealthy();
    this.emitState('closed');
    // Through the ordinary queue, with the ordinary backoff: a dial that hung
    // is evidence about the network, not about the credential, so it earns no
    // probe and no shortcut.
    this.scheduleReconnect();
  }

  private openSocket(url: string, dial: Dial): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    dial.socket = socket;

    socket.onopen = () => {
      // The dial succeeded, so its deadline is spent. Before anything else:
      // `armHealthy` arms a timer of its own and the two must not be confused.
      this.endDial(dial);
      this.openedAt = Date.now();
      // The backoff is NOT reset here, and that is the fix for a hot loop this
      // class can otherwise be driven into: on the local adapter the upgrade
      // COMPLETES and `close(4001)` follows milliseconds later, so resetting on
      // open meant a revoked token retried every single second forever. Only a
      // connection that LASTS is evidence of health, so the reset waits out
      // HEALTHY_MS — the same threshold `onclose` uses to decide whether a
      // refusal deserves a fresh probe.
      this.armHealthy();
      this.emitState('open');
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // ignore malformed frames
      }
      const frame = ServerFrame.safeParse(parsed);
      if (!frame.success) return;
      for (const handler of this.frameHandlers) handler(frame.data);
    };
    socket.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
    socket.onclose = (event?: { code?: number }) => {
      // A close ends the dial whether it ever opened or not: a refused upgrade
      // is a finished dial, and the branches below are what decide what to do
      // about it.
      this.endDial(dial);
      this.socket = null;
      const openedAt = this.openedAt;
      this.openedAt = null;
      this.clearHealthy();
      this.emitState('closed');

      // A connection that LASTED was authenticated (see HEALTHY_MS), so the
      // refusal that ends the next one is a new episode and earns its own
      // probe. Without this, one probe would be all a process ever gets, and a
      // session that expires after hours of uptime would strand exactly as it
      // did before this code existed.
      if (openedAt !== null && Date.now() - openedAt >= HEALTHY_MS) {
        this.probed = false;
        // And the mint budget with it: a session that worked for hours and then
        // expired is a new episode, not a continuation of the one that made the
        // last token.
        this.minted = false;
        // ...and the backoff, which `armHealthy` normally resets five seconds
        // after this same connection opened. On every platform where the timer
        // ran, this line is a no-op that re-states what already happened; on
        // Android backgrounded it is the only reset there is, because
        // `armHealthy` is a `setTimeout` and the Activity was paused when it
        // came due. Without it, a socket that held for hours in a pocket and
        // then dropped would re-dial at whatever ceiling the LAST outage had
        // climbed to — up to the 30s cap — rather than at the base delay a
        // connection that lasted has earned. Same condition, same evidence:
        // the connection lasted, so it was healthy.
        this.backoffMs = 1000;
      }

      // The two hosts refuse differently and RN flattens both into `onclose`:
      //  - AWS: the authorizer denies, the upgrade is refused with 403, RN
      //    reports code 1006 and a reason string — so `onopen` never ran.
      //  - Local adapter: the upgrade completes, then close(4001). `onopen`
      //    DID run, and it reset the backoff — which is how a revoked token
      //    used to produce a one-second hot reconnect loop that burned the
      //    whole outbox's `attempts` budget in about ten seconds.
      // Neither signal is trustworthy enough to act on alone, so both route to
      // the same cheap authenticated question rather than to a guess.
      const code = typeof event?.code === 'number' ? event.code : undefined;
      const refused = code === UNAUTHORIZED_CLOSE || openedAt === null;
      if (refused && this.authCheck && !this.probed && !this.closedByUser) {
        this.probed = true;
        // No scheduleReconnect here: reconnecting is the check's decision to
        // make.
        void this.runAuthCheck();
        return;
      }
      this.scheduleReconnect();
    };
  }

  /**
   * Ask the injected check what happened, then act on it — the ONLY place a
   * reconnect is allowed to jump the backoff queue.
   *
   * Order is the whole point: `POST /v1/auth` revokes every prior session, so
   * a new token means the old socket's credential is already dead. Re-auth
   * first, install the token, THEN dial. Never mint while intending to keep a
   * socket alive.
   */
  private async runAuthCheck(): Promise<void> {
    const epoch = this.epoch;
    this.authPending = true;
    let outcome: WsAuthOutcome;
    try {
      outcome = (await this.withDeadline(this.authCheck?.())) ?? { verdict: 'blip' };
    } catch {
      // A check that throws is not evidence of anything; back off as usual.
      outcome = { verdict: 'blip' };
    }
    // A stop() happened while we were deciding, and possibly a start() after
    // it. This verdict describes a session that no longer exists — applying any
    // part of it to the current one, including clearing its `authPending`, is
    // how a fresh unlock ends up stuck on "Offline" behind a dead probe.
    if (epoch !== this.epoch) return;
    this.authPending = false;
    // stop() may have run while we were deciding (a relock, a sign-out). Its
    // teardown detaches everything; this must not resurrect a socket behind it.
    if (this.closedByUser) return;

    if (outcome.verdict === 'gone') {
      // Terminal. Nothing schedules a reconnect from here — the account is
      // gone and the app surfaces that state (reauth.ts `onAccountGone`)
      // rather than showing "Offline" over an account that no longer exists.
      this.unauthorized = true;
      return;
    }
    if (outcome.verdict === 'reauthed') {
      this.token = outcome.token;
      if (this.minted) {
        // A token was already minted for THIS episode and the socket was
        // refused again anyway. `api.ts` calls the same shape "a server-side
        // truth, not a token problem" and stops after one retry; the socket has
        // to stop too, or a server issuing credentials its own authorizer
        // rejects gets an unbounded mint loop at zero delay. Keep the new token
        // — it is still the best one we have — and go to the back of the queue.
        this.scheduleReconnect();
        return;
      }
      this.minted = true;
      // The fresh token earns one probe of its own: if THIS one is refused,
      // that is server truth and not a stale credential.
      this.probed = false;
      // A refusal is not congestion. The new session deserves the base delay,
      // not whatever ceiling the dead one had climbed to.
      this.backoffMs = 1000;
      this.connect();
      return;
    }
    if (!outcome.conclusive) {
      // The check never reached the server, so it learned nothing about this
      // credential — and a probe that learned nothing must not cost the episode
      // its one probe. Without this refund a spell of genuine offline spends the
      // budget on a question nobody answered, and the token expiry that arrives
      // afterwards gets no probe at all: the socket backs off blindly and the
      // app strands on day 31 exactly as it did before this file existed.
      this.probed = false;
    }
    this.scheduleReconnect();
  }

  /**
   * THE PROBE'S DEADLINE — the last of the three ways this client could stop
   * dialling for good, and the one that actually stranded it on the device.
   *
   * `authPending` suppresses BOTH `connect` and `scheduleReconnect`, on purpose:
   * a dial launched while the credential is being replaced is dead on arrival.
   * But it is cleared in exactly one place, after the check answers — so a check
   * that never answers latches the client silently and permanently. There is no
   * backoff behind it and no state change to see; the socket simply never dials
   * again.
   *
   * Measured on the emulator, and it is not a rare interleaving: a
   * refused dial coming out of Doze runs the probe, the probe's request does not
   * settle, and from that moment the server log contains not one further ticket
   * from this app — through five and a half minutes with the foreground service
   * healthy and the pause policy reporting not-idle. `fetch` in React Native has
   * no timeout of its own, so "does not settle" is the normal shape of a request
   * issued into a network that is coming back.
   *
   * A check that did not answer LEARNED NOTHING, which is precisely the
   * inconclusive blip the outcome type already has a case for: the probe is
   * refunded and the socket goes back to the queue. The deadline rides the same
   * scheduler as everything else here, because a timeout that sleeps while the
   * Activity is paused would be no timeout at all on the one platform this is
   * for.
   */
  private withDeadline(
    work: Promise<WsAuthOutcome> | undefined,
  ): Promise<WsAuthOutcome | undefined> {
    if (!work) return Promise.resolve(undefined);
    return new Promise<WsAuthOutcome | undefined>(resolve => {
      let settled = false;
      const finish = (value: WsAuthOutcome | undefined): void => {
        if (settled) return;
        settled = true;
        wake.cancel();
        resolve(value);
      };
      const wake = wakeScheduler.schedule(DIAL_TIMEOUT_MS, () => {
        if (settled) return;
        settled = true;
        // Inconclusive by omission. `runAuthCheck` refunds the probe for an
        // inconclusive verdict, so the credential expiry that arrives later
        // still gets a real question asked about it.
        resolve({ verdict: 'blip' });
      });
      work.then(finish, () => finish({ verdict: 'blip' }));
    });
  }

  /**
   * Adopt a bearer that was renewed somewhere else — a REST call healed its own
   * 401 and this socket is still holding the token
   * `POST /v1/auth` revoked in the process.
   *
   * Nothing here is theoretical. The live socket keeps working, because
   * authorization is bound once at `$connect`, so nothing looks wrong until it
   * drops — and then every dial presents a dead token. The probe cannot rescue
   * it: the check asks about the CURRENT bearer, is told 200, and correctly
   * reports a blip while this socket goes on dialling the revoked one. A loop
   * that ends when the app restarts, and never otherwise.
   */
  adoptToken(token: string): void {
    if (this.closedByUser || this.unauthorized) return;
    // A check of ours is mid-flight and will install whatever it decides. This
    // matters more than it looks: a mint the SOCKET drove also fires the token
    // subscription, so without this guard the renewal loops straight back in
    // here and hands back the probe budget and the backoff that `runAuthCheck`
    // is in the middle of spending — restoring the unbounded mint loop through
    // the back door. `adoptToken` is for renewals that happened somewhere else.
    if (this.authPending) return;
    if (this.token === token) return;
    this.token = token;
    // A credential this socket has never presented earns its own probe, and the
    // base delay: whatever ceiling the dead token's backoff climbed to was
    // measuring a problem that no longer exists.
    this.probed = false;
    this.backoffMs = 1000;
    // A live (or dialling) socket is left alone: its authorization was bound at
    // `$connect` and still holds, so tearing it down would be churn for its own
    // sake, and a dial in flight will heal through the probe if it is refused.
    if (this.socket) return;
    this.cancelReconnect();
    this.connect();
  }

  private cancelReconnect(): void {
    const wake = this.reconnectTimer;
    this.reconnectTimer = null;
    wake?.cancel();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    // Same two suppressions as connect(), stated here as well because a timer
    // armed now would fire after the decision that forbids it.
    if (this.unauthorized || this.authPending) return;
    // Through the scheduler, never `setTimeout` directly — see WsWakeScheduler
    // for the measurement that made this a seam. It is read HERE rather than
    // captured once, so the Android implementation installed after the first
    // dial governs every backoff that follows it.
    this.reconnectTimer = wakeScheduler.schedule(this.backoffMs, () => {
      this.reconnectTimer = null;
      this.connect();
    });
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Returns false when the socket is not open (caller keeps the message pending). */
  send(frame: ClientFrame): boolean {
    if (!this.isOpen || !this.socket) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  onFrame(handler: (frame: ServerFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onState(handler: (state: WsState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private emitState(state: WsState): void {
    for (const handler of this.stateHandlers) handler(state);
  }

  /** Full teardown. The OS delivers socket events asynchronously, so the
   * callbacks are detached BEFORE close() — a late close event must reach
   * nothing (it used to chain notify → db and re-open a closed database).
   * Handlers are cleared too: start() re-registers fresh ones, and stacking
   * across relock/unlock cycles double-processed every frame. */
  /**
   * Close the transport and stop reconnecting — WITHOUT tearing out the
   * frame/state handlers or the auth check.
   *
   * This exists because `pause()` used `stop()`, and stop() clears the
   * handler sets. `resume()` then re-dialled with `start()`, which installs
   * nothing — handlers are registered separately, once, by messaging's own
   * start. The result was a socket that CONNECTED and was completely deaf:
   * the server saw a live connection, delivered into it, sent no push, and
   // the app ignored every frame and acked nothing. One background/foreground
   * cycle reproduced the exact incident the pause was built to fix, worse.
   *
   * Suspend is the teardown for "same session, later": transport state dies,
   * session wiring survives. `stop()` remains the teardown for "session
   * over": relock and workspace switches, where handlers closing over the
   * old session are precisely what must not survive.
   */
  suspend(): void {
    this.closedByUser = true;
    this.epoch++;
    this.authPending = false;
    this.clearHealthy();
    // A dial in flight belongs to the session ending here; its watchdog would
    // otherwise fire into the next one and emit a `closed` nobody asked for.
    this.releaseDial();
    // THE DOZE POLICY'S HALF OF THE ANDROID SCHEDULER CONTRACT. `pauseForIdle`
    // routes here, so a wake armed by the service is cancelled by the same call
    // that takes the socket down — the fix restores re-dialling only where the
    // policy says the socket may be up, and nothing survives this to dial into
    // a device the platform has put to sleep.
    this.cancelReconnect();
    // `releaseDial` above already let go of everything this client held — the
    // dial's transport and any socket standing without one — through
    // `discardSocket`, which is the only close this platform actually honours
    // for a socket that has not finished its upgrade.
    this.openedAt = null;
  }

  stop(): void {
    this.closedByUser = true;
    // Any auth check in flight belongs to the session ending here. Bumping the
    // epoch is what makes its verdict inapplicable to whatever starts next, and
    // clearing `authPending` is what stops a hung probe from suppressing the
    // next session's very first dial.
    this.epoch++;
    this.authPending = false;
    this.clearHealthy();
    this.releaseDial();
    this.cancelReconnect();
    // See `suspend`: the transport teardown lives in `releaseDial` now, so both
    // exits close a half-open socket the one way React Native honours.
    this.frameHandlers.clear();
    this.stateHandlers.clear();
    // Cleared with the handlers, and for the same reason: it closes over the
    // stopped session's token. start() installs a fresh one.
    this.authCheck = null;
    this.mintTicket = null;
    this.openedAt = null;
  }
}
