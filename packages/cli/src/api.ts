import {
  AuthChallengeResponse,
  AuthResponse,
  CreateAttachmentResponse,
  GetAttachmentResponse,
  MAX_ATTACHMENT_BYTES,
  PrekeyBundle,
  type UploadKeysRequest,
  WsTicketResponse,
  type WsTicketRole,
} from '@tacendum/shared';
import { API_BASE } from './config.js';
import { isHeaderSafeToken } from './profile.js';
import { CliError, EXIT, type ExitCode } from './exit.js';
import { guardCredential, sanitizeServerField } from './render.js';

/** Thin REST client for the server endpoints. Validates responses with zod. */

/**
 * A renewable credential.
 *
 * Declared HERE, not in `session.ts`, so the dependency runs one way: the
 * implementation imports the transport, never the reverse. `request()` is the
 * only place in the package that can see an HTTP status, which makes it the
 * only place that can notice a 401 — so it is where the retry belongs, and
 * every authed route inherits it without knowing the word.
 */
export interface TokenProvider {
  /** The token to present right now. */
  token(): string;
  /** Mint a fresh one. Single-flight: concurrent callers share one round trip. */
  reauth(): Promise<string>;
}

/** Either a fixed token (no renewal — the calling code's choice) or a renewable one. */
export type Credential = string | TokenProvider;

/**
 * How an HTTP status maps onto an exit code.
 *
 * 401 only reaches here after the retry below has already failed, so by the
 * time it is classified it genuinely means "these credentials are dead".
 * 409 is `account_conflict` — an account mid-deletion — and is TERMINAL: it
 * must never be retried, because retrying is how a cron job spends a week
 * hammering an account that no longer exists.
 */
function exitCodeForStatus(status: number, path: string): ExitCode {
  if (status === 401 || status === 403 || status === 409) return EXIT.AUTH;
  if (status === 404 && path.startsWith('/v1/keys/')) return EXIT.RECIPIENT;
  // 429 is NOT unclassified. It is the exact failure a fleet produces on the
  // day its sessions expire together — a sign-in costs two requests against a
  // 30/min per-IP bucket — and calling it "error" tells the operator their
  // credentials are dead when what they need to do is wait.
  if (status === 429) return EXIT.RATELIMIT;
  if (status >= 500) return EXIT.NETWORK;
  return EXIT.ERROR;
}

/**
 * How long ONE attempt at an HTTP round trip may take before it is abandoned.
 *
 * `fetch` has no default timeout. Nothing here noticed that until a group-call
 * gate run hung: a request that never answers is an await that never settles,
 * and this one is not awaited in isolation — `call-session.ts` reaches it from
 * inside `sendEncrypted`, which holds `sendChain` while it runs. So a single
 * stalled request does not cost one message. It wedges EVERY later send in the
 * process, permanently and in complete silence: no line, no error, no exit —
 * the leg closes that never announce, the roster delta that never fans out,
 * the `listen --calls` daemon that is up and answering nothing. A stalled
 * request must cost ten seconds and an error, not the session.
 *
 * TIMEOUT, not NETWORK, is the honest code (the mapping table): the request went
 * out but did not complete inside its budget, which is the one failure a
 * caller can sensibly retry — as distinct from a refused connection, which
 * retrying will not fix.
 *
 * PER ATTEMPT, deliberately. The 401 retry below loops back and arms a fresh
 * budget, so a renewal costs its own ten seconds rather than inheriting what
 * the first attempt already spent.
 *
 * WHAT IT BOUNDS, stated exactly: connect, TLS, send, response headers AND the
 * complete response body whenever this module will consume it. `request()`
 * buffers that body before it clears the timer or returns, so every caller
 * receives an in-memory Response and cannot be wedged by a server that sends
 * headers and then stops producing bytes. The first renewable 401 is decided
 * from its status alone; its unused body is aborted before renewal instead.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How much of a server-influenced error message may travel inside one of ours.
 *
 * Every string this module puts in a `CliError` ends up on one line — `error:
 * <message>` from the top-level catch, or one `message` field under `--json` —
 * so anything the server had a hand in is a FIELD in the render.ts sense and
 * gets `sanitizeServerField`. 200 rather than the 64-character default because
 * these are the messages an operator debugs from: `getaddrinfo ENOTFOUND` plus
 * a hostname is already past 64 and is still entirely useful text.
 */
const SERVER_MESSAGE_MAX = 200;

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: Credential } = {},
): Promise<Response> {
  // A plain string stays exactly as it was: present it, never renew it. That
  // is a deliberate fixed-credential option rather than an accidental gap;
  // callers choose whether this transport may renew by which union member
  // they pass.
  const auth = typeof opts.token === 'object' ? opts.token : undefined;
  let bearer = typeof opts.token === 'string' ? opts.token : auth?.token();
  // ANY CREDENTIAL THIS FUNCTION IS ABOUT TO PRESENT IS REGISTERED FIRST.
  //
  // `loadProfile` and `checkedSessionToken` cover the two ways a token
  // ordinarily comes to exist here, and this line covers the third: a caller
  // that got one from somewhere neither of them knows about. It is one branch
  // and an idempotent set insert, on the function that is by construction the
  // last thing between a credential and the wire — which makes it the cheapest
  // place in the package to be complete rather than nearly complete. See
  // render.ts, THE CREDENTIAL CHOKEPOINT.
  guardCredential(bearer);

  // ONE retry, not a loop. A second 401 after a freshly signed challenge is a
  // real failure — revoked, deleted, or clock skew — and looping on it turns a
  // dead integration into a self-inflicted DoS on our own auth route.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    // An AbortController driven by our own `setTimeout`, rather than
    // `AbortSignal.timeout`: the budget is then made of the same timer
    // primitive everything else in this package uses, so it is observable to a
    // test that controls the clock. `AbortSignal.timeout`'s timer is internal
    // to the runtime and answers to nobody.
    const controller = new AbortController();
    // Read in the catch to tell OUR abort from any other. The signal's own
    // reason cannot: a caller-supplied abort and this one arrive identically.
    let timedOut = false;
    const budget = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    // The in-flight socket is what holds the process open while a request is
    // outstanding; this timer should not be a second reason to stay alive.
    budget.unref?.();
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
      // `fetch` settles at HEADERS, not at the end of the body. Drain every
      // body this module will consume while this attempt's controller is still
      // armed, then rebuild the status, status text and headers around an
      // in-memory body — every Response field this private helper's callers
      // use. Their later `json()` cannot wait on the network, and terminal
      // error-detail bodies inherit the same bound. A first renewable 401
      // needs only its status; preserving that prompt retry is the one
      // deliberate no-drain case.
      if (!(res.status === 401 && auth && attempt === 0)) {
        const body = await res.arrayBuffer();
        res = new Response(body.byteLength === 0 ? null : body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    } catch (err) {
      if (timedOut) {
        // Our own prose and our own numbers — an abort's message is the
        // runtime's, and this string reaches stderr and the `--json` error
        // object like every other one.
        throw new CliError(
          EXIT.TIMEOUT,
          `${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      // fetch rejects only for transport faults (DNS, refused, TLS). Naming it
      // NETWORK rather than ERROR is what lets a CI step decide to retry.
      //
      // THE MESSAGE IS A FIELD, not prose, and it is not always the runtime's
      // own words. `fetch` also rejects before the socket when a header it was
      // handed is invalid, and `Headers.append` builds that rejection by
      // QUOTING THE HEADER VALUE BACK — so a bearer token arrives here inside
      // an error message, with whatever bytes it carried. That is a single
      // line of `${method} ${path} failed: …` on stderr, so it gets the field
      // sanitizer: breaks flattened, controls stripped.
      //
      // SANITIZING IS NOT ENOUGH, AND THAT WAS THE DEFECT. The sanitizer is a
      // rule about SHAPE — one field, one line, no control bytes — and a
      // credential does not stop being a credential because its newline
      // became a space. A profile written by an older build held
      // `LEGACY_SECRET\nTAIL`; Node refused the header, quoted it, and this
      // line printed `Headers.append: "Bearer LEGACY_SECRET TAIL" is an
      // invalid header value.` to stderr and into the `--json` error object —
      // that is, into CI logs and Claude Code hook logs — and called it
      // `network`, exit 4, which invites the retry loop that reproduces it on
      // every run. Reproduced end to end through the real binary
      // (test/gate.stored-token-leak.test.ts).
      //
      // AN ERROR MAY NEVER REPRODUCE A CREDENTIAL. Both arms below exist to
      // hold that even where this one is bypassed:
      //
      //  - a header rejection is not a transport fault at all. Nothing was
      //    sent, retrying sends nothing again, and the honest verdict is AUTH:
      //    the credential in hand is unusable and a human must replace it. The
      //    refusal is entirely OUR prose, so there is nothing to leak.
      //  - anything else whose message names the bearer is still classified
      //    NETWORK — that part of the diagnosis was right — and the credential
      //    is now removed from the message instead of the message being
      //    withheld whole. `sanitizeServerField` does that (render.ts, THE
      //    CREDENTIAL CHOKEPOINT), which is why the second arm no longer
      //    exists as an arm: the belt it implemented answered only HERE, and
      //    the leaks that were actually found were on the ordinary, entirely
      //    unexceptional response path a dozen lines below.
      if (rejectedOurHeader(err)) {
        throw new CliError(
          EXIT.AUTH,
          `${method} ${path} was not attempted: the credential this client holds cannot be ` +
            `presented as an HTTP header, so no request was sent. Re-register this account to ` +
            `replace it. The value is not echoed here, and an error is never a place to put one.`,
        );
      }
      const foreign = sanitizeServerField(
        err instanceof Error ? err.message : 'network error',
        SERVER_MESSAGE_MAX,
      );
      throw new CliError(EXIT.NETWORK, `${method} ${path} failed: ${foreign}`);
    } finally {
      clearTimeout(budget);
    }

    if (res.ok) return res;

    if (res.status === 401 && auth && attempt === 0) {
      // Renewal does not use the refusal body. Abort it now so a server that
      // keeps writing after its 401 headers cannot retain this attempt while
      // the independently-budgeted challenge/auth round trips begin.
      controller.abort();
      // Renew only if the token WE PRESENTED is still the current one.
      //
      // Two requests that 401 in the same tick share one mint through
      // `AuthSession`'s single-flight. Two that 401 a few hundred milliseconds
      // apart did not: by the time the second called `reauth()`, the first had
      // already written the new token to disk AND to the in-memory field, so
      // `mint()`'s disk-adoption guard saw no difference and signed a second
      // challenge — which, since every successful auth revokes the previous
      // session, killed the token the first request had just started using.
      // Comparing against the bearer that actually failed is the check that
      // covers the staggered case as well as the simultaneous one.
      const current = auth.token();
      bearer = current !== bearer ? current : await auth.reauth();
      // A renewal is a new credential in this process; the chokepoint has to
      // hear about it too, or the one token most likely to appear in a live
      // error is the one it does not know.
      guardCredential(bearer);
      continue;
    }

    let detail = `${res.status}`;
    let code: string | undefined;
    try {
      const err = (await res.json()) as { error?: { code?: string; detail?: string } };
      if (err.error) {
        code = err.error.code;
        // `code` and `detail` are SERVER fields headed for stderr and --json
        // through every caller's error path, so they cross the server-field
        // sanitizer HERE, where they enter our error. The `code` PROPERTY on the
        // CliError stays exact for callers that match on it — matching an
        // attacker-mangled code just fails closed.
        //
        // A `detail` IS ALSO WHERE A SERVER PUTS THIS CLIENT'S OWN BEARER
        // BACK, which is not hypothetical: an upstream that logs the
        // authorization header into its 500 body is an ordinary
        // misconfiguration, and this line then printed the live token to
        // stderr and into the `--json` error object. It is kept — the server's
        // sentence is often the whole diagnosis, and the status and code alone
        // would not have told anyone what happened — but it is kept REDACTED,
        // which `sanitizeServerField` now does for every registered credential
        // (render.ts, THE CREDENTIAL CHOKEPOINT).
        detail = `${res.status} ${sanitizeServerField(err.error.code ?? '', 32)}: ${sanitizeServerField(err.error.detail ?? '', 160)}`;
      }
    } catch {
      // non-JSON error body; status alone will do — and `code` stays undefined,
      // so a caller matching on it fails closed rather than on a coincidence.
    }
    // The server says how long to wait; discarding it leaves the caller to
    // guess, and the guess that costs nothing to make is "immediately".
    //
    // PARSED, NOT ECHOED, and that is the general instinct rather than a
    // special case for this header: `retry-after` has a GRAMMAR, this client
    // uses it as a number of seconds, and a field with a grammar should be
    // read and re-printed in our own words instead of forwarded as free text.
    // Echoing it put eight characters of whatever the server chose on stderr —
    // eight characters is a run this program now treats as a disclosure when
    // it is a credential's — for no diagnostic gain whatever, since a value
    // that is not a count of seconds is a value this client cannot act on.
    // Silence is the honest rendering of "the server said something here that
    // does not answer the question".
    const retryAfter = res.headers.get('retry-after')?.trim();
    if (retryAfter !== undefined && /^\d{1,6}$/.test(retryAfter)) {
      detail += ` (retry after ${Number(retryAfter)}s)`;
    }
    throw new CliError(
      exitCodeForStatus(res.status, path),
      `${method} ${path} failed: ${detail}`,
      undefined,
      code,
      res.status,
    );
  }
}

/**
 * A 2xx body, decoded — and a refusal that quotes NOTHING when it is not JSON.
 *
 * `res.json()` was called directly at each of the four success-path parses
 * below, outside any `try`. V8's `SyntaxError` for a body that is not JSON
 * QUOTES THE SERVER'S OWN BYTES: a 200 whose body is `x\nerror: forged` raises
 * `Unexpected token 'x', "x\nerror: forged" is not valid JSON`, which reaches
 * the top-level catch in main.ts, where `sanitizeForTerminal` deliberately
 * keeps LF — and `error: forged` lands at column zero on stderr, in a program
 * whose own failures are `error: `. That is not a hypothetical shape either:
 * a captive portal or a misconfigured proxy answering 200 with an HTML page is
 * the ordinary way this happens, and a hostile one is the interesting way.
 *
 * So the body is decoded HERE, once, for every route: the diagnosis names the
 * route, the status and the content-type — enough to recognise a proxy in one
 * read — and never a byte of the body. `ERROR` rather than `NETWORK`: the
 * request completed and something answered it, and calling that a transport
 * fault would tell a CI step to retry a proxy that will answer identically.
 */
async function requestJson(
  method: string,
  path: string,
  opts: { body?: unknown; token?: Credential } = {},
): Promise<unknown> {
  const res = await request(method, path, opts);
  try {
    return await res.json();
  } catch {
    throw new CliError(
      EXIT.ERROR,
      `${method} ${path} answered ${res.status} with a body that is not JSON ` +
        `(content-type: ${sanitizeServerField(res.headers.get('content-type') ?? 'none', 64)})`,
    );
  }
}

/**
 * Ask for a nonce to sign. Unauthenticated by
 * necessity — proving who you are is the point of the next call — and safe to
 * be so: a challenge is a nonce, not a credential, and it is worthless without
 * the identity private key. Issuing one replaces any pending challenge for the
 * same key, so this is also how a client recovers from a challenge it dropped.
 */
export async function apiAuthChallenge(identityKey: string): Promise<AuthChallengeResponse> {
  return AuthChallengeResponse.parse(
    await requestJson('POST', '/v1/auth/challenge', { body: { identityKey } }),
  );
}

/**
 * How the transport recognises a rejection it caused by handing Node a header
 * it could not accept — as opposed to the DNS/refused/TLS faults the same
 * catch exists for.
 *
 * `fetch` raises this BEFORE a socket exists, and `Headers.append` builds the
 * message by QUOTING THE VALUE BACK. So this predicate is the difference
 * between an error that may be shown and one that may not, and between a
 * NETWORK verdict a cron wrapper will retry forever and the truth, which is
 * that the credential in hand cannot be presented at all.
 *
 * `TypeError` alone would be far too wide — `fetch failed` is a TypeError too
 * — so the class and the wording must both agree.
 */
const HEADER_REJECTION = /invalid header value|headers\.append|for header/i;

function rejectedOurHeader(err: unknown): boolean {
  return err instanceof TypeError && HEADER_REJECTION.test(err.message);
}

function checkedSessionToken(token: string): string {
  // THE MINT IS THE OTHER PLACE A CREDENTIAL ENTERS THIS PROCESS (the first is
  // `loadProfile`), and it is registered BEFORE the shape check for the same
  // reason profile.ts registers before its own: the refusal path is where a
  // malformed value gets quoted. See render.ts, THE CREDENTIAL CHOKEPOINT.
  guardCredential(token);
  if (!isHeaderSafeToken(token)) {
    throw new CliError(
      EXIT.ERROR,
      'the server answered POST /v1/auth with a session token this client cannot present: ' +
        'a bearer credential must be 1-1024 visible ASCII characters, with no spaces and no ' +
        'line breaks',
    );
  }
  return token;
}

/**
 * Present the signed challenge and get a session. Creates the account on first
 * use and resolves it on every later one — the server decides which from the
 * `idkey#` claim row, so the client cannot tell the two apart and does not
 * need to. Replaces `POST /v1/register` + `POST /v1/verify` entirely.
 */
export async function apiAuth(
  identityKey: string,
  challenge: string,
  signature: string,
  accountClass?: 'integration',
): Promise<AuthResponse> {
  const parsed = AuthResponse.parse(
    await requestJson('POST', '/v1/auth', {
      // The class is set AT BIRTH and never again: the
      // server reads it only when it creates the account, so a later sign-in
      // cannot promote a human account to an integration or demote one. Sending
      // it on every auth is therefore harmless and sending it late is useless —
      // which is exactly the property that makes "this account is restricted to
      // its owner" something a stolen credential cannot undo.
      body: { identityKey, challenge, signature, ...(accountClass ? { accountClass } : {}) },
    }),
  );
  // The zod schema says "a string"; `checkedSessionToken` says "a string this
  // client can present". Every mint site reaches the server through here —
  // `cmdRegister`, `runSetup` and `AuthSession.mint` all call this function —
  // so this is the single boundary the token crosses.
  return { ...parsed, authToken: checkedSessionToken(parsed.authToken) };
}

/**
 * Bind this integration to its owner — `POST /v1/integrations/bind`.
 *
 * Called by the INTEGRATION, not by the owner, and the asymmetry is the design
 * (see `handlers/integrations.ts`): only the integration knows when the human
 * has handed over their id. It is WRITE-ONCE, because an integration that could
 * re-point itself at a new owner would turn a stolen CI credential into a
 * redirection primitive — the attacker would simply bind to themselves.
 *
 * After this, the server refuses any frame from this account addressed anywhere
 * but the owner. That refusal is the entire reason an agent may be handed a
 * send capability at all.
 */
export async function apiIntegrationBind(token: Credential, owner: string): Promise<void> {
  await request('POST', '/v1/integrations/bind', { body: { owner }, token });
}

/**
 * Adopt a paired integration into the caller's crew — `POST /v1/crew/adopt`.
 *
 * Called by the OWNER, and the asymmetry with `apiIntegrationBind` above is
 * the design (handlers/crew.ts): bind is the integration's call because only
 * it knows when the human handed over their id; adoption is an ADMISSION
 * decision, and the parent of an integration is a language model — an
 * injectable node can never be an admission authority, however prompted.
 *
 * 204 covers both "adopted" and "already adopted"; the server deliberately
 * does not distinguish, and neither does the CLI. Refusals arrive as coded
 * CliErrors for the command to translate; `crew_contended` is the one
 * RETRYABLE outcome (a concurrent adopt moved the crew's scope row) and the
 * server sends `retry-after: 1` with it.
 */
export async function apiCrewAdopt(token: Credential, member: string): Promise<void> {
  await request('POST', '/v1/crew/adopt', { body: { member }, token });
}

/**
 * Write the directed consent edge (caller -> agent). The server answers a UNIFORM 204 for any well-formed ULID — a 204
 * proves the request was accepted, never that the id names an agent, that an
 * edge was stored (over-cap is silently lossy by design), or anything else
 * about the target. The CLI's output must not claim more.
 */
export async function apiConsentWrite(token: Credential, agent: string): Promise<void> {
  await request('POST', '/v1/consent', { body: { agent }, token });
}

/** Delete the edge — revocation IS deletion, the next send is refused.
 * Same uniform 204 whether or not an edge existed. */
export async function apiConsentDelete(token: Credential, agent: string): Promise<void> {
  await request('DELETE', `/v1/consent/${agent}`, { token });
}

/**
 * Mint a single-use ticket for one WebSocket dial.
 *
 * The bearer stays in the Authorization header here; only the ticket goes in
 * the socket URL, because a URL is recorded by everything that forwards it and
 * the bearer is good for thirty days on every authenticated route.
 */
export async function apiWsTicket(token: Credential, role: WsTicketRole = 'listen'): Promise<string> {
  // The ROLE is declared at mint time, on this authenticated HTTPS request, and
  // the server stores it on the ticket row — so `$connect` reads it from its
  // own state rather than from the socket URL. A one-shot (`send`, `sync`) asks
  // for 'send' and is then kept out of the competition for the account's single
  // routing row entirely: it never claims it, so it can never take it from a
  // live `listen` and delete it again on the way out.
  return WsTicketResponse.parse(await requestJson('POST', '/v1/ws-ticket', { body: { role }, token }))
    .ticket;
}

export async function apiUploadKeys(token: Credential, keys: UploadKeysRequest): Promise<void> {
  await request('PUT', '/v1/keys', { body: keys, token });
}

/**
 * Mint an attachment slot: the server answers with a presigned PUT for
 * exactly `contentLength` bytes (dto.ts caps it at MAX_ATTACHMENT_BYTES, and
 * S3 enforces the signed header). Rate-limited 10/min per account — which is
 * why the ONLY caller on the message path is `composeAttachment` (send.ts):
 * one blob, one upload, N envelopes — never a per-recipient upload loop.
 */
export async function apiCreateAttachment(
  token: Credential,
  contentLength: number,
): Promise<CreateAttachmentResponse> {
  return CreateAttachmentResponse.parse(
    await requestJson('POST', '/v1/attachments', { body: { contentLength }, token }),
  );
}

/** Trade an attachment id (the read capability) for a time-limited GET URL. */
export async function apiGetAttachmentUrl(
  token: Credential,
  attachmentId: string,
): Promise<GetAttachmentResponse> {
  return GetAttachmentResponse.parse(
    await requestJson('GET', `/v1/attachments/${encodeURIComponent(attachmentId)}`, { token }),
  );
}

/**
 * How long a presigned-URL blob transfer may take. Wider than
 * REQUEST_TIMEOUT_MS because the payload is up to 10 MB of base64 where the
 * API routes carry a few KB of JSON.
 */
const BLOB_TIMEOUT_MS = 120_000;

function blobAbort(): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const budget = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BLOB_TIMEOUT_MS);
  budget.unref?.();
  return { signal: controller.signal, done: () => clearTimeout(budget), timedOut: () => timedOut };
}

/**
 * Blob transfer against presigned URLs (NOT the API origin — no bearer; the
 * URL itself is the credential, exactly the app's shape in app/src/api.ts).
 * The object content is the base64 TEXT of the encrypted blob: the RN client can only carry strings losslessly, and parity
 * with what the app wrote is the entire point.
 */
export async function uploadBlob(uploadUrl: string, blobB64: string): Promise<void> {
  const t = blobAbort();
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: blobB64,
      signal: t.signal,
    });
    if (!res.ok) {
      throw new CliError(EXIT.ERROR, `attachment upload was refused (${res.status})`);
    }
  } catch (err) {
    if (t.timedOut()) {
      throw new CliError(EXIT.NETWORK, `attachment upload timed out after ${BLOB_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    t.done();
  }
}

/** GET the blob's base64 text. Bounded: a body over the attachment cap is
 * refused without being retained. */
export async function downloadBlob(downloadUrl: string): Promise<string> {
  const t = blobAbort();
  try {
    const res = await fetch(downloadUrl, { signal: t.signal });
    if (!res.ok) {
      throw new CliError(EXIT.ERROR, `attachment download was refused (${res.status})`);
    }
    const body = await res.text();
    if (body.length > MAX_ATTACHMENT_BYTES) {
      throw new CliError(
        EXIT.ERROR,
        `attachment download is ${body.length} bytes, over the ${MAX_ATTACHMENT_BYTES} cap — refusing it`,
      );
    }
    return body;
  } catch (err) {
    if (t.timedOut()) {
      throw new CliError(EXIT.NETWORK, `attachment download timed out after ${BLOB_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    t.done();
  }
}

export async function apiGetPrekeyBundle(
  token: Credential,
  userId: string,
): Promise<PrekeyBundle> {
  try {
    return PrekeyBundle.parse(
      await requestJson('GET', `/v1/keys/${encodeURIComponent(userId)}`, { token }),
    );
  } catch (err) {
    // A 404 here is the single most likely thing a new user hits, and the raw
    // form — `GET /v1/keys/01K9… failed: 404 not_found: no key bundle for this
    // user` — reads as an internal fault rather than the one thing it means:
    // that id is not an account. Reported from a real session,
    // where it followed a correctly-formatted but non-existent id.
    if (err instanceof CliError && err.exitCode === EXIT.RECIPIENT) {
      throw new CliError(
        EXIT.RECIPIENT,
        `no account with id ${userId} — nobody by that id has registered, or ` +
          `they have never uploaded keys. Check the id on the recipient's ` +
          `my-code screen in the app.`,
        err.slug,
        err.code,
        err.status,
      );
    }
    throw err;
  }
}
