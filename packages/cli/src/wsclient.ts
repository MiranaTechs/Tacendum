import WebSocket from 'ws';
import { ServerFrame, type ClientFrame, type WsTicketRole } from '@tacendum/shared';
import type { Credential } from './api.js';
import { WS_URL } from './config.js';
import { CliError, EXIT, type ExitCode } from './exit.js';
import { apiWsTicket } from './api.js';

/**
 * How a server error frame becomes an exit code.
 *
 * These frames were previously a stderr NOTE while the send went on waiting
 * for a receipt that the server had already decided never to send — so every
 * terminal refusal cost the full ten-second timeout and then exited TIMEOUT,
 * the one code this CLI's own table documents as "the server took the frame
 * and said nothing", i.e. the one a wrapper is invited to retry. An
 * integration addressing the wrong recipient would retry forever, burning
 * both rate buckets and advancing its ratchet for messages nobody receives.
 */
export function exitCodeForServerError(code: string): ExitCode {
  switch (code) {
    // The account is gone (deleted or revoked mid-socket). A human must
    // register or re-pair; nothing about retrying helps.
    case 'unknown_sender':
      return EXIT.AUTH;
    case 'unknown_recipient':
      return EXIT.RECIPIENT;
    case 'rate_limited':
      return EXIT.RATELIMIT;
    // The integration class refusals: permanent for these arguments.
    case 'integration_unbound':
    case 'integration_recipient_forbidden':
    case 'integration_urgent_forbidden':
    case 'integration_inbox_restricted':
      return EXIT.REFUSED;
    // 'invalid_frame' and anything a newer server invents: unclassified
    // rather than mislabelled. ERROR never claims a remedy this CLI cannot
    // name, which is the property the table exists to keep.
    default:
      return EXIT.ERROR;
  }
}

/**
 * The error codes the switch above classifies — and therefore the ONLY
 * `frame.code` values that may ever be echoed into an error message. Keep in
 * sync with `exitCodeForServerError`.
 */
const CLASSIFIED_SERVER_ERROR_CODES = new Set([
  'unknown_sender',
  'unknown_recipient',
  'rate_limited',
  'integration_unbound',
  'integration_recipient_forbidden',
  'integration_urgent_forbidden',
  'integration_inbox_restricted',
  'invalid_frame',
]);

/**
 * The human-readable line for a server error frame, WITHOUT the server's
 * words in it. `frame.code` and `frame.detail` are plain
 * `z.string()`s the server chooses; the old treatment — strip control bytes,
 * truncate — does not redact a credential, an account name or a message body
 * that a hostile or merely buggy server reflects back, and this string
 * reaches stderr and the `--json` error object. A code is echoed only when it
 * string-matches a literal in this build's own table, at which point the
 * bytes shown are ours and the server has merely selected among them.
 * `detail` is never echoed; the exit code and slug carry the classification a
 * machine caller branches on.
 */
function describeServerError(code: string): string {
  return CLASSIFIED_SERVER_ERROR_CODES.has(code)
    ? `server refused: ${code}`
    : 'server refused with an error code this build does not classify ' +
        '(not echoed: the value is server-chosen)';
}

/**
 * The two ways a rejected credential reaches us, which are NOT the same event.
 *
 *  - Local adapter (`src/local/ws.ts`): the HTTP upgrade COMPLETES, then
 *    `$connect` authenticates, then `socket.close(4001, 'unauthorized')`. So
 *    the client sees `open` first and a 4001 close a few milliseconds later.
 *  - AWS: the authorizer returns Deny, API Gateway refuses the upgrade with
 *    403, and `ws` emits `error` with "Unexpected server response: 403" —
 *    before any open, and with no 4001 anywhere.
 *
 * WHAT WAS REJECTED IS THE TICKET, NOT THE BEARER. The
 * URL carries a single-use ticket, and by the time either signal above fires
 * the mint has already SUCCEEDED with the bearer — the observed sequence on a
 * revocation between mint and $connect is one good mint, then a handshake
 * 401, then exactly one `reauth()`. Renewal is still the right remedy: a
 * ticket refused milliseconds after it was minted means the session behind it
 * went bad on that boundary, and a renewed session is the only thing that
 * changes the next dial's outcome.
 *
 * Different event, different order, different message. Normalizing them is the
 * whole reason this lives in one function: it is the only point where both
 * signals are visible, and a caller that tried to do it would have to know
 * which host it was talking to.
 */
function isUnauthorizedHandshake(err: unknown): boolean {
  return err instanceof CliError && err.exitCode === EXIT.AUTH;
}

/**
 * The server refused this dial and asked for another one — 503 from `$connect`.
 *
 * It means the account's single routing row is held by another live connection,
 * or the transport could not say whether it is, so THIS socket would have been
 * open and silently unroutable. The remedy is a fresh dial, which is a fresh
 * arbitration; the server cannot promote a row-less socket afterwards, because
 * its connectionId is deliberately stored nowhere.
 *
 * BOTH HOSTS, because they refuse differently and the difference is not the
 * client's business:
 *  - AWS: a non-200 from $connect refuses the upgrade and `ws` reports
 *    "Unexpected server response: 503" as a handshake `error`.
 *  - Local adapter: the upgrade has already completed when $connect runs, so
 *    the refusal arrives as a close — 1013, RFC 6455's "Try Again Later".
 *
 * AND NOT ONLY $connect: a 503 from the ticket mint itself arrives as a
 * CliError whose `status` is also 503, so `isRefusedHandshake` matches it and
 * the redial loop retries the MINT under the same bounded budget — three
 * requests total against the default delays, each pass minting fresh. That is
 * intended: an unavailable mint is the same "try a fresh dial shortly" fact
 * as an unavailable $connect.
 *
 * Distinguished from EXIT.NETWORK by `status`, not by the exit code, precisely
 * because a caller that gives up must still report NETWORK: the redial budget
 * is exhausted and the socket is genuinely unusable.
 */
const CONNECT_REFUSED_STATUS = 503;

function isRefusedHandshake(err: unknown): boolean {
  return err instanceof CliError && err.status === CONNECT_REFUSED_STATUS;
}

/**
 * The HTTP status a refused upgrade carried, when there was one.
 *
 * `ws` reports a non-101 handshake answer with exactly one message shape —
 * `abortHandshake`'s "Unexpected server response: <status>" — and this parses
 * that shape and nothing else, so a status is extracted only from an answer
 * the server actually gave, never from a transport error that happens to
 * contain three digits ("connect ECONNREFUSED 127.0.0.1:503" names a port).
 *
 * Carried on the rejection's `status` field for EVERY answered upgrade, not
 * only the 503 the redial loop matches: `doctor` classifies on it, because
 * any status here means the socket host spoke — the network delivered the
 * dial and brought back an answer — and that is the reachability fact its
 * probe exists to report. Before this, only 503 was propagated and only for
 * the redial's benefit, so doctor was left string-matching nothing and
 * calling every answered refusal "unreachable".
 */
function upgradeStatus(message: string): number | undefined {
  const match = /^Unexpected server response: (\d{3})$/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The redial budget for a refused handshake, and the pauses between attempts.
 *
 * BOUNDED, and short. The refusal is not congestion and not an error the server
 * will grow out of on its own: it means somebody else holds the row. One or two
 * further dials cover the cases that do resolve — a management-plane blip, an
 * incumbent that was in the act of leaving, two dials that raced — and anything
 * beyond that is a `listen` that is genuinely not going to get the row, which
 * must fail loudly rather than spin. `listen` is run from cron and from Claude
 * Code hooks; an unbounded retry there is a process that never exits and never
 * says why.
 *
 * The pauses exist because a redial with no gap re-reads the same row
 * microseconds later and learns nothing. They are the CLIENT's backoff, not a
 * server-side inference: nothing on either side concludes anything from how
 * long they were.
 */
const REFUSAL_REDIAL_DELAYS_MS = [250, 750];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long after `open` to keep watching for a 4001 close before declaring the
 * socket usable.
 *
 * This exists because of the local adapter's ordering above, and the failure it
 * fixes was diagnosed the hard way: a revoked session produced NO auth error at
 * all. The dial resolved on `open`, the send went out into a socket the server
 * was already closing, and the command failed ten seconds later with "timed out
 * waiting for server frame" — a TIMEOUT where the truth was UNAUTHORIZED, so
 * the one remedy that would have worked (re-auth) was never reached.
 *
 * $connect is one authenticated store lookup on loopback, single digit
 * milliseconds; this is two orders of magnitude of headroom. It is applied ONLY
 * when a renewable credential was supplied, so the calls path — which passes a
 * plain string and is owned by another workstream — keeps its exact timing.
 *
 * IT IS STILL A HEURISTIC, and `waitFor` below is the backstop: a 4001 that
 * arrives after this window has expired does not renew anything, but it now
 * fails the pending wait immediately with EXIT.AUTH and an accurate message
 * instead of sitting for ten seconds and reporting a timeout. Not reachable on
 * AWS at all — there the authorizer denies before the upgrade, so the refusal
 * is a handshake error and the retry above catches it.
 */
const AUTH_SETTLE_MS = 300;

/** Minimal WS client: connect with the bearer token, frame (de)serialization. */
export class WsClient {
  private socket!: WebSocket;
  private handlers: ((frame: ServerFrame) => void)[] = [];

  /**
   * Dial once. Rejects with a CliError already classified — AUTH or NETWORK
   * for the handshake itself, EXIT.ERROR for an unusable endpoint or for the
   * ticket-mint 404 refusal below (`status` 404), and whatever code the
   * mint's own failure carried otherwise — so `connect` decides on the code
   * and the `status` field rather than on a substring.
   */
  private async dial(token: string, settleMs: number, role: WsTicketRole): Promise<void> {
    /*
     * The endpoint is validated BEFORE any credential exists to append to it
     *. `ws` rejects an unusable URL by THROWING a
     * SyntaxError whose message contains the whole URL — which by
     * construction time carries the ticket, or under the opt-in below the
     * 30-day bearer — so a typo'd TACENDUM_WS printed the credential to
     * stderr and into the `--json` error object. Checked here, the dial fails
     * while the URL is still credential-free, and before a single-use ticket
     * has been spent on it. The message is fixed prose on purpose: the
     * configured value is exactly the thing this error must not echo.
     */
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(WS_URL);
    } catch {
      endpoint = undefined;
    }
    if (
      endpoint === undefined ||
      (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
      endpoint.host === ''
    ) {
      throw new CliError(
        EXIT.ERROR,
        'the configured WebSocket endpoint is not a usable ws:// or wss:// ' +
          'URL, so no connection was attempted. Fix TACENDUM_WS (or the ' +
          'TACENDUM_ENV selection); the configured value is not echoed here ' +
          'because dial URLs carry credentials and error text gets logged.',
      );
    }
    /*
     * A single-use ticket per dial. The bearer used to go in
     * this URL; a URL is written into proxy and access logs, and that value is
     * good for thirty days on every authenticated route. A spent ticket in a
     * log is worth nothing.
     *
     * Minted here rather than by the caller so every dial gets its own —
     * including the retry below, which is a second dial and must not replay the
     * first ticket.
     *
     * THE DOWNGRADE IS NARROW ON PURPOSE. Falling back to the bearer whenever
     * the mint failed for any reason would hand an attacker the old defect on
     * demand: block or break this one request — a 500, a 429, a dropped
     * connection to the HTTP host — and the client puts a thirty-day credential
     * back in a URL, while the socket endpoint stays reachable. So the ONLY
     * failure that MAY downgrade is 404 — the endpoint is absent, which an old
     * server and a misrouting proxy both produce. Everything else propagates
     * and the dial fails; the caller retries.
     *
     * AND IT IS NO LONGER SILENT. Two consecutive review gates flagged the
     * automatic fallback: a client that quietly puts a month-long credential in
     * a logged URL whenever the route is missing is a security downgrade nobody
     * sees until a log leaks — and "route missing" is one misrouted proxy away,
     * not only an old server. An operator running a pre-ticket server would
     * rather be told than silently exposed. So a 404 now REFUSES with an error
     * that names both remedies, unless the operator has set
     * TACENDUM_ALLOW_TOKEN_IN_URL=1 — an explicit acknowledgement that their
     * bearer will appear in intermediary logs — and even then, one stderr line
     * per dial says the downgrade is happening (never the credential itself).
     *
     * Why not delete the fallback outright: the rollout plans a
     * transition window (server first, then clients, then remove the token
     * path), and this CLI can meet servers deployed before the route shipped.
     * Removal without the escape hatch turns "upgrade soon" into "cannot
     * connect at all today". The var, the fallback and this comment all go
     * together when the transition ends.
     *
     * Read at dial time, not at import: a long-lived `listen` should honour
     * what the environment said when the process started its dial, and tests
     * can exercise both branches without reloading the module.
     */
    let query: string;
    try {
      query = `ticket=${encodeURIComponent(await apiWsTicket(token, role))}`;
    } catch (err) {
      if (!(err instanceof CliError) || err.status !== 404) throw err;
      if (process.env.TACENDUM_ALLOW_TOKEN_IN_URL !== '1') {
        // EXIT.ERROR: no classified code in exit.ts names this outcome (the
        // server is up, our credentials were never judged, and retrying the
        // same dial cannot help), and appending a new code to that published
        // contract is not this change's to make — the message carries the
        // remedy instead. `status` keeps the 404 so a machine caller can still
        // tell "the endpoint 404'd" from the mint's own transport failures.
        // The message contains no credential — and it says what was OBSERVED
        // (a 404) rather than what it means: a proxy or application 404
        // reaches this branch exactly like a server that predates the route.
        throw new CliError(
          EXIT.ERROR,
          'the ticket mint (POST /v1/ws-ticket) returned HTTP 404 — either this ' +
            'server predates the route, or a proxy in front of it is ' +
            'misrouting the path. Without a ticket, dialling the socket ' +
            'directly would put your 30-day session token in the WebSocket ' +
            'URL, where proxy and access logs record it. Check the server and ' +
            'proxy deployment, or set TACENDUM_ALLOW_TOKEN_IN_URL=1 to ' +
            'connect anyway and accept that exposure.',
          undefined,
          undefined,
          404,
        );
      }
      // Stderr, not stdout: stdout belongs to --json consumers and the MCP
      // transport (same rule as config.ts's startup line). No credential here.
      process.stderr.write(
        'tacendum: the ws-ticket endpoint returned 404; dialling with the ' +
          'session token in the URL because TACENDUM_ALLOW_TOKEN_IN_URL=1\n',
      );
      query = `token=${encodeURIComponent(token)}`;
    }
    // Belt to the validation's braces above: nothing thrown by this
    // constructor may propagate, because `ws` composes throw messages from
    // the URL and the URL now carries the credential. The class is wider than
    // one malformed-URL SyntaxError — ANY throw that quotes the URL is the
    // same leak — so whatever the cause, the replacement is fixed prose.
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${WS_URL}?${query}`);
    } catch {
      throw new CliError(
        EXIT.ERROR,
        'could not construct the WebSocket connection: the dial URL was ' +
          'rejected before any connection was attempted. Check TACENDUM_WS; ' +
          'the URL is not echoed here because it carries a credential.',
      );
    }

    // WIRED BEFORE THE HANDSHAKE SETTLES, not after `connect()` returns.
    // `ws` does not buffer: a 'message' emitted with no listener attached is
    // gone. The server drains the whole queue inside $connect, so those frames
    // land in the first milliseconds after open — and while the settle window
    // above was running, every one of them was being dropped. The symptom was
    // that a queued message vanished: unacked, so it redelivered forever, and
    // `listen` looked like it had simply not received anything.
    //
    // A socket that is about to be closed 4001 never receives a drain (auth
    // failed, so no connection row was ever written), so there is nothing for
    // this handler to mistakenly process on a doomed dial.
    socket.on('message', (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = ServerFrame.safeParse(json);
      if (!parsed.success) return; // ignore malformed server frames
      for (const handler of this.handlers) handler(parsed.data);
    });

    // A PERMANENT absorber for post-handshake 'error' events.
    //
    // `ws` inherits EventEmitter's rule that an 'error' with no listener is
    // rethrown, and that throw happens outside `main()`'s rejection handler —
    // so it exits with a stack trace, no C5 exit code and no `--json` error
    // object. The handshake listeners below are DEREGISTERED on success (they
    // have to be, or the settle timer's `close` handler would reject a promise
    // that already resolved), which left a connected socket with zero 'error'
    // listeners. A protocol-level fault on a live socket (a bad frame, RSV1
    // set) is rare but is exactly the case that gets a crash instead of an
    // error message. Attached here, never removed, so the window does not
    // exist. The failed-dial path already parks its own for the same reason.
    socket.on('error', () => {});

    // Published before the handshake settles, for the same reason. A drained
    // frame arriving inside the settle window is handled immediately, and the
    // handler ACKS — so `send()` has to have a socket to write to by then.
    // Assigning it afterwards cost a `TypeError: Cannot read properties of
    // undefined (reading 'send')` that surfaced only as "frame processing
    // error", leaving the message unacked and the queue apparently stuck.
    // A failed dial simply leaves a closed socket here until the retry
    // replaces it; nothing writes in between.
    this.socket = socket;

    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (): void => {
          if (timer) clearTimeout(timer);
          socket.off('open', onOpen);
          socket.off('error', onError);
          socket.off('close', onClose);
        };
        const onError = (err: Error): void => {
          stop();
          // Strictly parsed, not substring-matched. The loose matches this
          // replaces (`/\b(401|403)\b/`, `/\b503\b/`) read any three digits
          // in the message as a status — including a PORT: "connect
          // ECONNREFUSED 127.0.0.1:503" matched, so a dead host listening
          // nowhere became "the incumbent holds the row", got the redial
          // budget spent on it, and would now read as reachable to doctor.
          // `upgradeStatus` accepts only the one shape `ws` uses for an
          // answered upgrade, so a status here means the server spoke.
          const status = upgradeStatus(err.message);
          if (status === 401 || status === 403) {
            reject(
              new CliError(
                EXIT.AUTH,
                `websocket handshake failed: ${err.message}`,
                undefined,
                undefined,
                status,
              ),
            );
            return;
          }
          // 503 — see CONNECT_REFUSED_STATUS. Still EXIT.NETWORK, so a caller
          // that runs out of redials reports the truthful outcome; `status` is
          // what `connect` below reads to decide there is another dial worth
          // making — and what `doctor` reads to tell an ANSWERED refusal from
          // a network that dropped the dial, which is why every parsed status
          // rides along, not only 503.
          reject(
            new CliError(
              EXIT.NETWORK,
              `websocket handshake failed: ${err.message}`,
              undefined,
              undefined,
              status,
            ),
          );
        };
        const onClose = (code: number): void => {
          stop();
          if (code === 4001) {
            reject(new CliError(EXIT.AUTH, `connection closed during handshake (code ${code})`));
            return;
          }
          // 1013 is how the local adapter delivers the same 503: it has already
          // completed the upgrade by the time $connect answers, so a close code
          // is the only channel it has left.
          reject(
            new CliError(
              EXIT.NETWORK,
              `connection closed during handshake (code ${code})`,
              undefined,
              undefined,
              code === 1013 ? CONNECT_REFUSED_STATUS : undefined,
            ),
          );
        };
        const onOpen = (): void => {
          if (settleMs <= 0) {
            stop();
            resolve();
            return;
          }
          timer = setTimeout(() => {
            stop();
            resolve();
          }, settleMs);
        };
        socket.on('open', onOpen);
        socket.on('error', onError);
        socket.on('close', onClose);
      });
    } catch (err) {
      // The dead socket may still emit — and an 'error' with no listener is an
      // unhandled throw that kills the process. Park a no-op before dropping it.
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.close();
      throw err;
    }
  }

  /**
   * Connect, renewing the credential once if the handshake was refused (C3).
   *
   * A string credential dials exactly once and never renews — that is the
   * pre-C3 behaviour, kept verbatim for `call-session.ts`, which another
   * workstream owns.
   *
   * Note the shape of the failure this fixes: the bearer is judged when the
   * dial mints its ticket (and the ticket at $connect), never again for the
   * life of the socket, so a 30-day expiry does not drop a live socket
   * mid-call. It kills the NEXT connect. Day 31 looks like "every listen and
   * every send refuses to start", all at once, on every machine.
   */
  async connect(token: Credential, role: WsTicketRole = 'listen'): Promise<void> {
    const auth = typeof token === 'object' ? token : undefined;
    const bearer = typeof token === 'string' ? token : token.token();
    const settleMs = auth ? AUTH_SETTLE_MS : 0;

    // A refused dial (`status` 503 — whether $connect refused the handshake
    // or the ticket mint itself answered 503; both carry the status) is
    // retried before anything else looks at the error,
    // and each pass calls `dial` again — which MINTS A FRESH TICKET, because a
    // ticket is single-use and replaying a spent one is a 401, i.e. a redial
    // that converts a transient refusal into a permanent-looking auth failure.
    // Bounded by REFUSAL_REDIAL_DELAYS_MS; on exhaustion the last error is
    // rethrown as the EXIT.NETWORK it already is.
    for (let refusals = 0; ; refusals++) {
      try {
        await this.dial(bearer, settleMs, role);
        return;
      } catch (err) {
        const delay = REFUSAL_REDIAL_DELAYS_MS[refusals];
        if (isRefusedHandshake(err) && delay !== undefined) {
          await sleep(delay);
          continue;
        }
        if (!auth || !isUnauthorizedHandshake(err)) throw err;
        // Exactly once, for the same reason api.ts retries exactly once — and
        // only if the token we dialled with is still the current one, so a
        // renewal another request already completed is adopted rather than
        // duplicated (see the note in api.ts; a second mint revokes the first).
        const current = auth.token();
        await this.dial(current !== bearer ? current : await auth.reauth(), settleMs, role);
        return;
      }
    }
  }

  /**
   * One dial, exactly — no redial budget, no renewal. This is `doctor`'s
   * probe. `connect()`'s refusal redial is an ARBITRATION: each pass is
   * another attempt to win the account's single routing row, which is the
   * right behaviour for a `listen` that intends to hold the socket and the
   * wrong one for a probe — against a healthy incumbent the probe loses all
   * three dials by design, spends the sleeps in between, and on production
   * that exceeded doctor's own 5s deadline, so the time spent LOSING was
   * reported as "unreachable". One dial answers the only question a probe
   * asks: did the socket host answer, and with what. The rejection arrives
   * classified — `exitCode`, plus `status` whenever the server answered the
   * upgrade with an HTTP status — for the caller to read as fields.
   */
  async dialOnce(token: string, role: WsTicketRole = 'listen'): Promise<void> {
    await this.dial(token, 0, role);
  }

  onFrame(handler: (frame: ServerFrame) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Whether a dialled socket is currently OPEN — the readiness fact, read
   * from the transport itself rather than inferred from whether `connect()`
   * once resolved. call-session.ts gates every ratchet advance on this: a
   * `send()` on a closed socket is silently dropped — `ws` reports
   * `sendAfterClose` only through the per-send callback, and `send()` below
   * passes none, so NOTHING is emitted anywhere, not even an 'error' event —
   * so a caller that has already paid a ratchet advance
   * for the frame must be able to ask FIRST. True during the settle window
   * (the socket is open; frames already flow both ways there) and false
   * before any dial, after a close, and while the transport is closing.
   */
  isOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Wait for the first frame matching pred (checks future frames only).
   *
   * A CLOSE ENDS THE WAIT IMMEDIATELY, with the close code's own
   * classification. The settle window in `dial` is 300 ms, and it is a
   * heuristic: the local adapter authenticates inside `$connect`, so a slow
   * `$connect` can deliver its `close(4001)` after `connect()` has already
   * resolved. `ws` then drops the outgoing frame silently (`sendAfterClose`
   * with no callback emits nothing), and without this handler the command sat
   * here for ten seconds and reported "timed out waiting for server frame" —
   * which is the very misdiagnosis the settle window was added to remove, just
   * moved a few hundred milliseconds later. TIMEOUT means "the server took the
   * frame and said nothing"; a socket the server closed is a different fact
   * and deserves its own code.
   */
  waitFor(pred: (f: ServerFrame) => boolean, timeoutMs = 10_000): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      const finish = (): void => {
        clearTimeout(timer);
        socket.off('close', onClose);
      };
      const onClose = (code: number): void => {
        finish();
        reject(
          new CliError(
            code === 4001 ? EXIT.AUTH : EXIT.NETWORK,
            code === 4001
              ? 'the server closed the connection as unauthorized before replying — ' +
                'the session was revoked or expired after the handshake settled'
              : `connection closed (code ${code}) before the server replied`,
          ),
        );
      };
      const timer = setTimeout(
        () => {
          finish();
          reject(
            // TIMEOUT, not ERROR: "the server took the frame and said nothing"
            // is the one failure a caller can sensibly retry, and telling it
            // apart from a refusal is the point of the code table (C5).
            new CliError(EXIT.TIMEOUT, 'timed out waiting for server frame'),
          );
        },
        timeoutMs,
      );
      socket.on('close', onClose);
      this.onFrame((frame) => {
        if (pred(frame)) {
          finish();
          resolve(frame);
          return;
        }
        // AN ERROR FRAME ENDS THE WAIT, for the same reason a close does: the
        // server has answered, and the answer was no. Correlating it to this
        // send needs no msgId (ErrorFrame carries none) because the CLI sends
        // one frame per connection and waits for it — anything else arriving
        // in that window is about this send. The message echoes NOTHING the
        // server chose — control-byte stripping and truncation (the old
        // treatment) do not redact a credential or an account name a server
        // reflects back, and this string reaches stderr and the --json error
        // object. See describeServerError.
        if (frame.type === 'error') {
          finish();
          reject(
            new CliError(exitCodeForServerError(frame.code), describeServerError(frame.code)),
          );
        }
      });
    });
  }

  onClose(handler: (code: number) => void): void {
    this.socket.on('close', handler);
  }

  close(): void {
    this.socket?.close();
  }
}
