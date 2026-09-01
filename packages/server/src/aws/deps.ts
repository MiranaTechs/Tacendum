import { randomBytes, randomInt } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ulid } from 'ulid';
import { makeDataLayer, type LedgerReconcileRequest } from '../db/data.js';
import { makeDocClient } from '../db/client.js';
import { makeS3Attachments, makeS3Client, readS3Config } from '../storage.js';
import { log } from '../log.js';
import { makeDdbRateLimiter } from '../ratelimit-ddb.js';
import type { Deps, IdentifierHmacState, TurnConfig } from '../handlers/http.js';
import { makeApnsPushSender, readApnsCredentials } from '../push/sender.js';
import { makeSesEmailSender, readSesConfig } from '../email/ses.js';
import { makeEumSmsSender, readSmsConfig } from '../sms/eum.js';
import { makeFcmPushSender, readFcmCredentials } from '../push/fcm-sender.js';
import { makePlatformPushSender } from '../push/route.js';
import type { PushWakeEvent } from '../handlers/push-worker.js';
import { disconnectorFor } from './gateway.js';
import { normalizeOrigin } from '@tacendum/shared';

/**
 * The proactive socket-disconnect capability for the HTTP/Auth functions.
 *
 * These functions front a DIFFERENT API than the WebSocket one, so tearing a
 * live socket down on revoke needs the WS API's management endpoint (its apiId
 * and stage) AND an `execute-api:ManageConnections` (DELETE) grant on it —
 * both of which live in infra, another lane, which the PUBLIC source release
 * does not include. That is why the absence must be LOUD here, in code a
 * reviewer can read:
 *
 * - `WS_DISCONNECT_REQUIRED=1` — set by infra on exactly the two functions
 * that owe this capability (HttpFn and AuthFn) — turns a missing endpoint
 * into a REFUSAL TO RUN: an error log naming the absent variables and a
 * throw, which fails the cold start of a production deployment that lost
 * its wiring, instead of a silent downgrade nobody notices. The flag is
 * deliberately a separate env entry from the pair it guards, so one lost
 * refactor cannot delete both the wiring and the alarm about it.
 * - Without the flag (local dev, unit tests, Lambdas that never revoke),
 * an absent endpoint stays a quiet, legitimate degrade: undefined here,
 * and revocation enforces through the row delete + the per-frame session
 * guard (whose worst case is stated in session-guard.ts). Even then a
 * revocation that actually needed the hang-up logs
 * `ws_disconnector_unwired` at first use (session-revoke.ts).
 *
 * The moment the env pair is present the proactive hang-up activates with no
 * code change. Exported for the tests that pin all three behaviours.
 */
export function readWsDisconnector(
  env: NodeJS.ProcessEnv = process.env,
): ((connectionId: string) => Promise<void>) | undefined {
  const domain = env.WS_API_DOMAIN;
  const stage = env.WS_API_STAGE;
  if (domain && stage) return disconnectorFor(domain, stage);
  const missing = [...(domain ? [] : ['WS_API_DOMAIN']), ...(stage ? [] : ['WS_API_STAGE'])].join(
    ',',
  );
  if (env.WS_DISCONNECT_REQUIRED === '1') {
    log.error('ws_disconnector_unwired', { missing });
    throw new Error(
      `WS_DISCONNECT_REQUIRED=1 but ${missing} is not set: refusing to run a production ` +
        'configuration without the proactive session-revocation disconnect (see SECURITY.md)',
    );
  }
  return undefined;
}

/**
 * This function's own API origin, from configuration.
 *
 * It is inside the bytes clients sign, so it must never come from the request:
 * `Host` and `X-Forwarded-Host` are attacker-controlled, and letting the caller
 * name the audience it is checked against is the hole this closes.
 *
 * Fails closed and loudly. A missing origin would otherwise become an empty
 * audience that verifies nothing — and a total auth outage is the SAFE failure
 * here, loud and immediate, rather than an auth path that quietly accepts
 * signatures minted for somebody else.
 */
function readApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.API_ORIGIN;
  if (!raw) throw new Error('API_ORIGIN is not set; refusing to verify auth signatures');
  return normalizeOrigin(raw);
}


type TurnSecrets = Pick<TurnConfig, 'authSecret' | 'userSalt'>;

/**
 * Fetches the two coturn secrets and caches the RESULT for the container's
 * lifetime, so a cold start pays two Secrets Manager calls and every warm
 * invocation pays none. The loader is deliberately SYNCHRONOUS at the call
 * site: `Deps.turn` is a plain value the handler reads, so while the fetch is
 * still in flight it answers "no secrets yet" and the endpoint degrades to
 * `turn_unavailable` — the same honest state as having no relay at all
 * never a failed request.
 *
 * A failed fetch is logged loudly and NOT cached — same posture as
 * storage.ts's private-key loader: the in-flight marker is cleared on
 * rejection so the next request retries instead of poisoning the container,
 * while concurrent first calls share one fetch instead of racing.
 */
export function makeTurnSecretsLoader(
  // Injectable for tests; production lazily builds the Secrets Manager client.
  fetchSecret?: (arn: string) => Promise<string>,
): (authSecretArn: string, userSaltArn: string) => TurnSecrets | undefined {
  let fetchImpl = fetchSecret;
  let secrets: TurnSecrets | undefined;
  let inFlight: Promise<void> | undefined;
  return (authSecretArn, userSaltArn) => {
    if (secrets || inFlight) return secrets;
    if (!fetchImpl) {
      const sm = new SecretsManagerClient({});
      fetchImpl = (arn) =>
        sm.send(new GetSecretValueCommand({ SecretId: arn })).then((res) => {
          // The ARN is configuration, not a secret; naming it here is what
          // makes the failure findable.
          if (!res.SecretString) throw new Error(`secret ${arn} holds no string value`);
          return res.SecretString;
        });
    }
    inFlight = Promise.all([fetchImpl(authSecretArn), fetchImpl(userSaltArn)]).then(
      ([authSecret, userSalt]) => {
        secrets = { authSecret, userSalt };
      },
    );
    inFlight.catch((err: unknown) => {
      // Loud on purpose: with the secrets silently absent, only RELAYED calls
      // fail — behind symmetric NAT, exactly the calls that needed the relay —
      // and that presents as a flaky network, not a config error.
      log.error('turn_secret_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      inFlight = undefined;
    });
    return secrets;
  };
}

/** Module scope, like `cachedDeps`: the fetched secrets must outlive a single
 * invocation, or every /v1/turn-credentials request would pay two Secrets
 * Manager round-trips. */
const loadTurnSecrets = makeTurnSecretsLoader();

/**
 * TURN configuration. Absent by default: the relay is a
 * separate stack an operator opts into, and until it exists the credential
 * endpoint must answer `turn_unavailable` rather than mint credentials for a
 * relay that is not there.
 *
 * The environment carries the secret ARNs — TURN_AUTH_SECRET_ARN and
 * TURN_USER_SALT_ARN — never the values: a `{{resolve:...}}`
 * dynamic reference is substituted at DEPLOY time, which left the plaintext
 * HMAC secret sitting on the function configuration, readable by anyone
 * holding lambda:GetFunctionConfiguration. The values are fetched at runtime
 * instead, like the attachment signing key. The local adapter
 * (local/http.ts) still reads plaintext TURN_AUTH_SECRET / TURN_USER_SALT —
 * a dev machine has no Secrets Manager.
 */
export function readTurnConfig(
  env: NodeJS.ProcessEnv = process.env,
  loadSecrets: (authSecretArn: string, userSaltArn: string) => TurnSecrets | undefined =
    loadTurnSecrets,
): Deps['turn'] {
  const urls = env.TURN_URLS?.split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (!urls || urls.length === 0) return null;
  const authSecretArn = env.TURN_AUTH_SECRET_ARN;
  const userSaltArn = env.TURN_USER_SALT_ARN;
  if (!authSecretArn || !userSaltArn) {
    // Degrade, do NOT throw. This runs while building the shared deps object,
    // so throwing would fail the cold start of the WebSocket adapter and take
    // down MESSAGING — turning a misconfigured relay into a total outage. The
    // honest degraded state is the same one as having no relay at all: calls
    // go direct and /v1/turn-credentials answers turn_unavailable.
    log.error('turn_config_incomplete');
    return null;
  }
  // Undefined while the fetch is in flight, and after a failure (which the
  // loader will retry on the next read): degrade exactly as above.
  const secrets = loadSecrets(authSecretArn, userSaltArn);
  if (!secrets) return null;
  return { urls, authSecret: secrets.authSecret, userSalt: secrets.userSalt };
}

/**
 * The user-ref salt ALONE (opaque-ref.ts): the WebSocket
 * adapter must key activity rows with it but deliberately never holds the
 * coturn auth secret or mints credentials, so the salt has its own loader
 * keyed on TURN_USER_SALT_ARN — the same secret the TURN loader reads,
 * cached independently (on the HTTP function this costs one extra
 * GetSecretValue per container lifetime; the WebSocket function pays only
 * this one). Same posture as the TURN loader: a synchronous read that
 * answers "no value yet" while the fetch is in flight, and a failure is
 * loud, uncached, and retried on the next read. While absent, log refs read
 * `unavailable` and activity writes are skipped with a counter — never the
 * raw id (opaque-ref.ts).
 */
export interface SecretLoader {
  (arn: string): string | undefined;
  /**
   * The fetch the last read started (or found in flight) and that has not
   * landed yet — for a consumer that would rather WAIT for the value than
   * refuse on "no value yet" (the identifier lane, handlers/identifiers.ts
   * `hmacKeys`: the first identifier request a fresh container served used
   * to pay the kick-off read itself and be refused by it — build 23, first
   * "Claim this name" 403, second 200). Undefined once the value is cached
   * and after a failed fetch (which the next read restarts).
   */
  pending(): Promise<void> | undefined;
}

export function makeUserRefSaltLoader(
  // Injectable for tests; production lazily builds the Secrets Manager client.
  fetchSecret?: (arn: string) => Promise<string>,
  // The event a fetch failure logs under. Defaulted to the coturn-salt name
  // this loader was born for; K_id passes its OWN name so an operator chasing
  // a dead identifier lane greps the right event rather than the TURN salt
  // (the two secrets share this machinery, not this event).
  failEvent = 'user_ref_salt_fetch_failed',
): SecretLoader {
  let fetchImpl = fetchSecret;
  let salt: string | undefined;
  let inFlight: Promise<void> | undefined;
  const read = (arn: string): string | undefined => {
    if (salt !== undefined || inFlight) return salt;
    if (!fetchImpl) {
      const sm = new SecretsManagerClient({});
      fetchImpl = (secretArn) =>
        sm.send(new GetSecretValueCommand({ SecretId: secretArn })).then((res) => {
          if (!res.SecretString) throw new Error(`secret ${secretArn} holds no string value`);
          return res.SecretString;
        });
    }
    inFlight = fetchImpl(arn).then((value) => {
      salt = value;
    });
    inFlight.catch((err: unknown) => {
      log.error(failEvent, {
        error: err instanceof Error ? err.message : String(err),
      });
      inFlight = undefined;
    });
    return salt;
  };
  return Object.assign(read, {
    pending: () => (salt === undefined ? inFlight : undefined),
  });
}

/** Module scope, like `loadTurnSecrets`: the fetched salt must outlive a
 * single invocation. */
const loadUserRefSalt = makeUserRefSaltLoader();

export function readUserRefSalt(
  env: NodeJS.ProcessEnv = process.env,
  loadSalt: (arn: string) => string | undefined = loadUserRefSalt,
): string | undefined {
  const arn = env.TURN_USER_SALT_ARN;
  // Absent by default, degrade silently at THIS layer: the consumers
  // (opaque-ref.ts, activity.ts) each say loudly what absence costs them.
  if (!arn) return undefined;
  return loadSalt(arn);
}

/** Module scope: K_id rides its OWN loader instance
 * of the same salt-loader machinery — a separate secret, deliberately never
 * the coturn salt (opaque-ref.ts states why the ref spaces must not share a
 * root), fetched at runtime by ARN and cached per container. A fetch failure
 * logs under the identifier lane's own event, never the TURN salt's. */
const loadIdentifierHmacKey = makeUserRefSaltLoader(
  undefined,
  'identifier_hmac_key_fetch_failed',
);
/** The PREVIOUS-version K_id during a rotation window — its own loader
 * instance because it is a DIFFERENT secret ARN (each loader caches exactly
 * one secret). Absent env ⇒ never fetched, and the walk stays one version. */
const loadIdentifierHmacKeyPrev = makeUserRefSaltLoader(
  undefined,
  'identifier_hmac_key_fetch_failed',
);

/**
 * The active K_id set for `Deps.identifierHmac`, NEWEST first (the rotation
 * window: ≤2 versions). v1 wires ONE version — `IDENTIFIER_HMAC_KEY_ARN` +
 * `IDENTIFIER_HMAC_KEY_VERSION` (default 1). A rotation is a DEPLOY-TIME env
 * change, never a value overwrite: set `IDENTIFIER_HMAC_KEY_PREV_ARN` +
 * `IDENTIFIER_HMAC_KEY_PREV_VERSION` to the retiring pair and bump the primary
 * to the new secret/version, so resolution walks BOTH (opaque-ref's
 * `activeEmailClaimKeys`) and any successful resolution opportunistically
 * re-writes the row forward (handlers/identifiers.ts). When the previous pair
 * is withdrawn, only rows that never resolved during the window are invalidated
 * the honest dormant-row cost discloses. The primary must ALWAYS be the
 * newest version (a prev whose version ≥ primary is a misconfiguration and is
 * dropped, keeping the invariant `keys[0]` = newest that attach writes under).
 * Absent env, or a configured secret's fetch FAILED: undefined, and every
 * identifier route refuses with the collapsed error — fail closed, never a
 * raw fallback. EITHER configured secret's cold-start fetch still in flight:
 * `{ pending }`, the fetch itself, which the identifier lane AWAITS and then
 * re-reads (handlers/identifiers.ts `hmacKeys`) — never a silently NARROWED
 * walk: serving the primary alone while a
 * well-formed retiring pair's fetch is in flight would hand that invocation
 * a ONE-version walk mid-window, reading every unmigrated claim as a miss —
 * against the unconditional all-versions walk release pins. Refusing on
 * the in-flight answer was an earlier defect: `makeAwsDeps` prewarms every
 * other secret at construction, and the first identifier-lane request a
 * fresh container served paid the kick-off read itself and answered the
 * frozen 403 while the SAME bytes a moment later answered 200.
 */
type KeyLoader = ((arn: string) => string | undefined) & Partial<Pick<SecretLoader, 'pending'>>;

/** The read answered "no value yet": the fetch it started (or found in
 * flight), for the lane to await — or undefined when there is nothing to
 * wait for (a loader without the seam, or a fetch that failed: closed). */
function awaitingKey(loader: KeyLoader): IdentifierHmacState | undefined {
  const pending = loader.pending?.();
  return pending ? { pending } : undefined;
}

export function readIdentifierHmacKeys(
  env: NodeJS.ProcessEnv = process.env,
  loadKey: KeyLoader = loadIdentifierHmacKey,
  loadPrevKey: KeyLoader = loadIdentifierHmacKeyPrev,
): IdentifierHmacState | undefined {
  const arn = env.IDENTIFIER_HMAC_KEY_ARN;
  if (!arn) return undefined;
  const key = loadKey(arn);
  if (key === undefined) return awaitingKey(loadKey);
  const version = Number(env.IDENTIFIER_HMAC_KEY_VERSION ?? '1');
  if (!Number.isInteger(version) || version < 1) return undefined;
  const keys: Array<{ version: number; key: string }> = [{ version, key }];
  // The optional retiring pair. Both env vars present, a well-formed version
  // STRICTLY BELOW the primary's, and the secret resolved: only then does the
  // walk become two-wide. Anything else leaves it one-wide (fail closed on the
  // prev leg — an unreadable retiring secret never widens the walk).
  const prevArn = env.IDENTIFIER_HMAC_KEY_PREV_ARN;
  const prevVersionRaw = env.IDENTIFIER_HMAC_KEY_PREV_VERSION;
  if (prevArn && prevVersionRaw !== undefined) {
    const prevVersion = Number(prevVersionRaw);
    if (Number.isInteger(prevVersion) && prevVersion >= 1 && prevVersion < version) {
      const prevKey = loadPrevKey(prevArn);
      // FAIL CLOSED ON THE WHOLE SET while a configured rotation window's
      // retiring secret is unresolved: the same
      // posture as the primary's own cold start — the lane awaits the fetch
      // in flight and refuses collapsed on a failed one, and a persistently
      // unreadable retiring secret keeps it down LOUDLY
      // (identifier_hmac_key_fetch_failed) rather than quietly narrowing the
      // claim walk to one version for the invocation.
      if (prevKey === undefined) return awaitingKey(loadPrevKey);
      keys.push({ version: prevVersion, key: prevKey });
    }
  }
  return { keys };
}

/**
 * AWS Lambda dependency factory. Identical wiring to the local
 * `makeDeps` (src/local/http.ts) except real AWS endpoints — the same pure
 * handlers run behind it, unchanged.
 *
 * NO SNS CLIENT and no `sns:Publish` anywhere in this process
 * The only thing that ever published was the SMS
 * verification code, and accounts are proved by signature now. If an SNS
 * import reappears here, the phone number has come back with it.
 *
 * The rate limiter is DynamoDB-backed so limits
 * hold across the whole Lambda fleet rather than per warm container. API
 * Gateway stage/route throttling remains as the outer, cheaper ceiling.
 */

/** One client, cached across warm invocations, for the durable reconcile
 * handoff below AND the AuthFn accounts-notice push handoff
 * (makeAuthNoticePushSender) — the same reason ws.lambda.ts caches its own. */
const reconcileLambda = new LambdaClient({});

/**
 * The DURABLE quota-repair handoff: an async
 * (Event) invoke of the reconcile worker, AWAITED by the data layer BEFORE
 * its refusal returns. The Event invoke returns as soon as Lambda has queued
 * the work in ITS durable queue — which survives this container freezing the
 * instant the 429 goes out; the floating promise it replaces did not.
 *
 * Failure posture: LOUD, then rethrown — and the data layer catches it, so
 * the sender still gets its 429, never a 500; the rethrow only clears the
 * container-local debounce so the next refusal retries the handoff.
 * `ledger_reconcile_unwired` means a deployment lost the env wiring on the
 * one function that enqueues (the WebSocket adapter) — the drifted ledger
 * then stays drifted (over-refusal, the pre-existing residual), which is why
 * the absence must be loud on every refusal rather than a silent downgrade.
 * Error class / variable name only, never an id.
 */
export function makeReconcileScheduler(
  env: NodeJS.ProcessEnv = process.env,
  send: (cmd: InvokeCommand) => Promise<unknown> = (cmd) => reconcileLambda.send(cmd),
): (req: LedgerReconcileRequest) => Promise<void> {
  return async (req) => {
    const functionName = env.RECONCILE_FUNCTION_NAME;
    if (!functionName) {
      log.error('ledger_reconcile_unwired', { missing: 'RECONCILE_FUNCTION_NAME' });
      throw new Error('RECONCILE_FUNCTION_NAME is not set');
    }
    try {
      await send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(req)),
        }),
      );
    } catch (err) {
      log.error('ledger_reconcile_schedule_failed', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      throw err;
    }
  };
}

/** Reused across warm invocations. */
let cachedDeps: Deps | undefined;

export function makeAwsDeps(): Deps {
  if (cachedDeps) return cachedDeps;
  const doc = makeDocClient();
  // The durable scheduleReconcile hook rides every AWS-host data layer; only
  // the WebSocket adapter (the sole enqueue path) is given the env target,
  // and only a refusal ever calls it.
  const db = makeDataLayer(doc, undefined, { scheduleReconcile: makeReconcileScheduler() });
  const wsDisconnect = readWsDisconnector();
  // The CDK stack sets S3_ENDPOINT='' + the generated bucket name on every
  // function that builds these deps; readS3Config fails fast if the bucket
  // env contract drifts (same posture as the table-name guard).
  const s3Config = readS3Config();
  // Start the relay-secret, push-key, salt and K_id fetches NOW rather than
  // on the first request that needs them, so each cache is usually warm
  // before anyone places a call or claims a name. The results are
  // deliberately discarded — the live getters below re-read them — and on a
  // function not given TURN_URLS, APNS_AUTH_KEY_SECRET_ARN,
  // FCM_SERVICE_ACCOUNT_SECRET_ARN or IDENTIFIER_HMAC_KEY_ARN each is a
  // no-op. K_id joined this list with the first-tap fix: left off it, the
  // first identifier-lane request a fresh container served paid the kick-off
  // read itself (and, until `hmacKeys` learned to await it, was refused by it).
  readTurnConfig();
  readApnsCredentials();
  readFcmCredentials();
  readUserRefSalt();
  readIdentifierHmacKeys();
  cachedDeps = {
    db,
    now: () => Date.now(),
    newUserId: () => ulid(),
    newAuthToken: () => randomBytes(32).toString('base64url'),
    // Standard base64, not base64url — see the note in local/http.ts.
    newChallenge: () => randomBytes(32).toString('base64'),
    apiOrigin: readApiOrigin(),
    rateLimit: makeDdbRateLimiter(doc),
    log: (event, fields) => log.info(event, fields),
    newAttachmentId: () => randomBytes(32).toString('base64url'),
    // 6-digit email code: the platform CSPRNG's
    // randomInt — an id-shaped secret, not key material.
    newEmailCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    newReportId: () => ulid(),
    attachments: makeS3Attachments(makeS3Client(s3Config), s3Config.bucket),
    // The relay AND push secrets are both fetched from Secrets Manager AFTER
    // this object is built (a dynamic reference left each
    // value in plaintext on its function's configuration), so both must be
    // read through live getters: a plain `turn: readTurnConfig` here would
    // freeze the pre-fetch null for the container's lifetime and no relayed
    // call would ever get credentials, and a snapshotted
    // `credentials: readApnsCredentials` would freeze the push sender
    // unconfigured the same way. BOTH degrade honestly when absent: no relay
    // means calls run direct-only and /v1/turn-credentials answers
    // turn_unavailable; no APNs key means an urgent frame is queued like any
    // other and the call does not ring early. Neither may fail a send.
    get turn() {
      return readTurnConfig();
    },
    // Same live-getter reasoning as `turn` directly above: the salt is
    // fetched after this object is built, so a snapshot here would freeze
    // the pre-fetch undefined for the container's lifetime. The WebSocket
    // adapter spreads this object per invocation, which re-reads the getter
    // each time.
    get userRefSalt() {
      return readUserRefSalt();
    },
    // K_id — same live-getter reasoning as `turn`
    // and `userRefSalt`: the Secrets Manager fetch completes after this
    // object is built, and a snapshot would freeze the identifier routes
    // refusing for the container's lifetime. Absent env = undefined forever
    // = the routes fail closed with the collapsed error.
    get identifierHmac() {
      return readIdentifierHmacKeys();
    },
    // SES through the seam: configuration, not a secret —
    // the FROM address and configuration-set name ride plain env; only the
    // HTTP function's role holds ses:SendEmail, scoped in infra. Absent env
    // = no sender = the code-request routes refuse (fail closed).
    ...(() => {
      const ses = readSesConfig();
      return ses ? { email: makeSesEmailSender(ses) } : {};
    })(),
    // EUM SMS through the seam: same posture —
    // the origination identity and Protect configuration id are
    // configuration, not secrets; only the HTTP function's role holds
    // sms-voice:SendTextMessage, scoped in infra to the one origination
    // identity + the one Protect configuration. Absent env = no sender =
    // the phone routes refuse (fail closed) — which is exactly the state
    // until sender registration lands a number.
    ...(() => {
      const sms = readSmsConfig();
      return sms ? { sms: makeEumSmsSender(sms) } : {};
    })(),
    // One PushSender upstream, two lanes beneath it: the row's platform
    // discriminator picks APNs or FCM (push/route.ts), and each lane reads
    // its own credentials through a live getter for the same
    // snapshot-would-freeze-null reason `turn` documents above.
    push: makePlatformPushSender({
      apns: makeApnsPushSender({
        get credentials() {
          return readApnsCredentials();
        },
        log: (event, fields) => log.info(event, fields),
      }),
      fcm: makeFcmPushSender({
        get credentials() {
          return readFcmCredentials();
        },
        log: (event, fields) => log.info(event, fields),
      }),
    }),
    // Proactive socket teardown on revoke when infra has wired the WS
    // management endpoint; undefined (a no-op at the call site) otherwise.
    ...(wsDisconnect !== undefined ? { disconnectSocket: wsDisconnect } : {}),
  };
  return cachedDeps;
}

/**
 * The AuthFn accounts-notice push seam (it replaces a structural
 * no-op: every ceremony/roster notice wake was structurally
 * dead on the deployed auth Lambda while the recipient's shared banner
 * budget was still being spent).
 *
 * THE PATTERN, BY REFERENCE ONLY. AuthFn never holds APNs or FCM
 * credentials and never talks to Apple or Google: the push WORKER (PushFn)
 * is the one identity in the fleet that reads those secrets — by ARN, at
 * runtime, cached per container — and this seam merely async-invokes it with
 * a `PushWakeEvent`, exactly the hand-off ws.lambda.ts's `pushSchedulerFor`
 * makes for ordinary message wakes. No secret value is fetched, embedded, or
 * even nameable here; the only new capability is `lambda:InvokeFunction` on
 * PushFn, negotiated in the open in the deployment's security tests.
 *
 * Shape notes, each deliberate:
 * - `wake` stays 'failed': no AuthFn route rings a call, and handing the
 * VoIP lane to a second identity would widen "the set of identities that
 * can ring a phone" for nothing.
 * - `notify` receives the token row `deliverAccountsNotice` already read
 * (the PushSender contract); the worker re-reads it — one redundant
 * GetItem, priced, in exchange for reusing the worker's token-prune and
 * platform-routing logic instead of duplicating it here.
 * - a fresh `wakeId` per call: one scheduling decision, one redelivery
 * claim (the ws.ts mint rule) — Lambda's async queue is at-least-once,
 * and a duplicated accounts banner is exactly what the claim suppresses.
 * - missing PUSH_FUNCTION_NAME degrades to 'failed' with a LOUD log, never
 * a throw: the notice's durable enqueue has already committed, and
 * deliverAccountsNotice treats every wake failure as lost loudness,
 * never lost correctness.
 */
export function makeAuthNoticePushSender(
  env: NodeJS.ProcessEnv = process.env,
  send: (cmd: InvokeCommand) => Promise<unknown> = (cmd) => reconcileLambda.send(cmd),
): Deps['push'] {
  return {
    wake: async () => 'failed' as const,
    notify: async (token, message) => {
      const functionName = env.PUSH_FUNCTION_NAME;
      if (!functionName) {
        log.error('accounts_notice_push_unwired', { missing: 'PUSH_FUNCTION_NAME' });
        return 'failed';
      }
      const payload: PushWakeEvent = {
        recipientId: token.userId,
        senderUserId: message.from,
        kind: 'message',
        message: {
          msgId: message.msgId,
          msgType: message.msgType,
          payload: message.payload,
          ts: message.ts,
        },
        wakeId: ulid(),
      };
      try {
        // Awaited: the Event invoke returns as soon as Lambda queues the
        // work, and the execution environment can freeze right after our
        // response otherwise (the ws.lambda.ts rule).
        await send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify(payload)),
          }),
        );
        return 'sent';
      } catch (err) {
        // Error class only — never bodies or ids.
        log.error('accounts_notice_push_schedule_failed', {
          error: err instanceof Error ? err.name : 'unknown',
        });
        return 'failed';
      }
    },
  };
}

/** Reused across warm invocations of the auth function. */
let cachedAuthDeps: Deps | undefined;

/**
 * Dependencies for the AUTH function only.
 *
 * Deliberately not `makeAwsDeps`. That factory calls `readS3Config`, which
 * fails fast when the attachment bucket variables are absent — and AuthFn is
 * not given them, because it has no business touching blobs. Calling it there
 * would turn a missing-but-irrelevant env var into a cold-start crash on the
 * one endpoint a user needs before they have an account at all.
 *
 * The unreachable capabilities throw rather than silently no-op: if a future
 * handler is routed here and reaches for attachments or reports, it should
 * fail loudly in the first test rather than quietly return nothing in
 * production. Push stopped being one of them when the signed device routes
 * landed: their notices wake recipients through the push
 * worker, by reference — see makeAuthNoticePushSender.
 */
export function makeAuthDeps(): Deps {
  if (cachedAuthDeps) return cachedAuthDeps;
  const unavailable = (what: string): never => {
    throw new Error(`${what} is not available in the auth function`);
  };
  const doc = makeDocClient();
  const wsDisconnect = readWsDisconnector();
  cachedAuthDeps = {
    // The reconcile hook rides this data layer too (dark-deploy lane): the
    // accounts-notice enqueue (deliverAccountsNotice → enqueueMessage) is a
    // real quota-billed send, and a refusal on it schedules the same durable
    // ledger heal the WebSocket adapter hands off — without the hook, the
    // hookless fallback would run an in-process messages Query this role
    // deliberately does not hold, failing as a silent AccessDenied. The
    // hook's absence-of-env failure mode is loud and swallowed upstream
    // (makeReconcileScheduler / scheduleLedgerReconcile), so a lost env var
    // costs a drifted-high ledger, never a 500.
    db: makeDataLayer(doc, undefined, { scheduleReconcile: makeReconcileScheduler() }),
    now: () => Date.now(),
    newUserId: () => ulid(),
    newAuthToken: () => randomBytes(32).toString('base64url'),
    // Standard base64, not base64url — see the note in local/http.ts.
    newChallenge: () => randomBytes(32).toString('base64'),
    apiOrigin: readApiOrigin(),
    rateLimit: makeDdbRateLimiter(doc),
    log: (event, fields) => log.info(event, fields),
    newAttachmentId: () => unavailable('attachments'),
    // AuthFn hosts recovery COMPLETION only (route placement): it never
    // mints a code, never sends an email, never computes an identifier HMAC
    // (the claim keys it needs ride the recovery row) — so none of the three
    // capabilities exists here, and reaching for one fails loudly.
    newEmailCode: () => unavailable('email codes'),
    // AuthFn never serves /v1/reports; the route lives on the HTTP function.
    newReportId: () => unavailable('reports'),
    attachments: {
      uploadUrl: async () => unavailable('attachments'),
      downloadUrl: async () => unavailable('attachments'),
    },
    // Calls are the HTTP/WS functions' business; the TURN block stays null.
    turn: null,
    // Push is REAL here since the signed device routes landed: ceremony and roster notices must wake the recipient, and the
    // hard-wired no-op this replaces spent the recipient's shared banner
    // budget on a wake that could never leave the function.
    // Credentials stay on PushFn — see makeAuthNoticePushSender.
    push: makeAuthNoticePushSender(),
    // A superseding sign-in revokes prior sessions and, their sockets.
    // Same infra-gated wiring as the HTTP function; undefined (no-op) until the
    // WS management endpoint is granted, with the recheck enforcing meanwhile.
    ...(wsDisconnect !== undefined ? { disconnectSocket: wsDisconnect } : {}),
  };
  return cachedAuthDeps;
}
