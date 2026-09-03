import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PushOutcome, PushSender } from '../handlers/http.js';
import { log } from '../log.js';
import { makeApnsClient, type ApnsClient, type ApnsCredentials } from './apns.js';

/**
 * The real VoIP push channel: one HTTP/2 client per APNs
 * environment, cached in module scope so a warm Lambda does not rebuild the
 * session per call.
 *
 * **Where the credentials come from.** The environment carries the secret's
 * ARN — APNS_AUTH_KEY_SECRET_ARN — never the values: a
 * `{{resolve:...}}` dynamic reference is substituted at DEPLOY time, which
 * left the .p8 PRIVATE KEY sitting in plaintext on the function
 * configuration, readable by anyone holding lambda:GetFunctionConfiguration.
 * The key is fetched from Secrets Manager at runtime instead — one fetch, not
 * four: keyId, teamId, bundleId and privateKeyP8 are JSON keys of a single
 * secret — and cached for the container's lifetime, exactly as the TURN
 * secrets are (aws/deps.ts). The cache is also why **rotating the key still
 * requires a deploy with ApnsKeyRevision bumped**: the bump recycles the
 * fleet, and the recycle is what drops the cached key.
 *
 * The transport is given the token ROW rather than a userId, so it needs no
 * database access and cannot read anyone else's token. It reports
 * `token_invalid` upward instead of deleting the row: owning data is the
 * handler's job, not the transport's.
 */

export interface ApnsPushSenderOptions {
  /**
   * Read on EVERY send, so the deps factory can supply a live getter: the
   * runtime fetch lands after the sender is built, and a snapshot taken at
   * build time would freeze null for the container's lifetime. Null when the
   * key has not been provisioned — or has not finished fetching.
   */
  credentials: ApnsCredentials | null;
  /** Structured log; never receives the key, the device token, or a call id. */
  log(event: string, fields?: Record<string, string | number | boolean>): void;
}

/**
 * A sender that is a no-op when unconfigured.
 *
 * Missing credentials are NOT an error: an unconfigured push channel means
 * calls do not ring early, which the caller's UI already handles.
 * Throwing would turn a missing key into failed MESSAGE delivery, which is a
 * far worse outcome than a call that rings late.
 */
export function makeApnsPushSender(options: ApnsPushSenderOptions): PushSender {
  const clients = new Map<'sandbox' | 'production', ApnsClient>();
  let warned = false;

  function clientFor(
    env: 'sandbox' | 'production',
    credentials: ApnsCredentials,
  ): ApnsClient {
    const existing = clients.get(env);
    if (existing) return existing;
    // One key serves both hosts only if it was created "Sandbox &
    // Production". An environment-scoped key simply fails against the other
    // host, which surfaces here as an ordinary failed push.
    // The client's log is this sender's: `apns_alert_payload_trimmed` (an
    // alert over Apple's 4 KB cap shipped without its ciphertext) rides the
    // same payload-free channel as `apns_refused`.
    const client = makeApnsClient({ credentials, env, log: options.log });
    clients.set(env, client);
    return client;
  }

  return {
    /**
     * A message notification.
     *
     * Separate from `wake` because almost nothing is shared: a different
     * token, a different push type, a different topic, and a payload carrying
     * the ciphertext so the device can render a preview without asking the
     * server for anything.
     *
     * No alert token means no notification and no error. A build that predates
     * this registers only a VoIP token, and a person who declined the
     * permission prompt has no alert token at all — in both cases the message
     * still arrives over the socket, which is exactly the previous behaviour.
     */
    async notify(token, message): Promise<PushOutcome> {
      if (!token.alertToken) {
        // Its own event, distinct from an APNs refusal: a bare "failed" leaves
        // no way to tell "the row has no alert token" from "Apple said no" —
        // two completely different repairs.
        options.log('push_skipped_no_alert_token');
        return 'no_token';
      }
      if (!token.env) {
        // An iOS row always names its APNs host; a row without one is an
        // Android row that should have been routed to the FCM lane
        // (push/route.ts) — a wiring defect, not a user state. Loud, and
        // `failed` rather than a throw: the message is queued either way.
        options.log('apns_row_missing_env');
        return 'failed';
      }
      const { credentials } = options;
      if (!credentials) {
        if (!warned) {
          warned = true;
          options.log('apns_unconfigured');
        }
        return 'failed';
      }
      try {
        const result = await clientFor(token.env, credentials).sendAlert(
          token.alertToken,
          message,
        );
        if (result.outcome !== 'sent') {
          // Status and Apple's reason string, never a token: the one
          // diagnostic APNs offers, and the difference between an actionable
          // log line and a shrug.
          options.log('apns_refused', {
            kind: 'alert',
            status: result.status ?? 0,
            reason: result.reason ?? '',
          });
        }
        return result.outcome;
      } catch {
        return 'failed';
      }
    },

    async wake(token, fromUserId): Promise<PushOutcome> {
      // Mirror of `notify`'s alert-token check: a row may legitimately hold
      // one token and not the other, and a call to a device with no VoIP
      // token simply does not ring early.
      if (!token.voipToken) {
        options.log('push_skipped_no_voip_token');
        return 'no_token';
      }
      if (!token.env) {
        // Same guard as `notify`, for the same reason: only the platform
        // router should ever decide which network a row belongs to.
        options.log('apns_row_missing_env');
        return 'failed';
      }
      const { credentials } = options;
      if (!credentials) {
        // Once per execution environment, not once per call: a call-rate log
        // line for a known-absent config is noise, not signal.
        if (!warned) {
          warned = true;
          options.log('apns_unconfigured');
        }
        return 'failed';
      }
      try {
        const result = await clientFor(token.env, credentials).sendVoip(
          token.voipToken,
          { from: fromUserId, ts: Date.now() },
        );
        if (result.outcome !== 'sent') {
          options.log('apns_refused', {
            kind: 'voip',
            status: result.status ?? 0,
            reason: result.reason ?? '',
          });
        }
        return result.outcome;
      } catch {
        // Transport died. The message is already durably queued; the call
        // just does not ring early.
        return 'failed';
      }
    },
  };
}

/**
 * Everything the fetched secret must contain, or null. Deliberately tolerant
 * — the same posture the four plaintext env vars had: the CDK stack ships a
 * generated placeholder before an operator populates the secret, and a
 * half-populated or non-JSON value must read as "unconfigured", not as a
 * crash on the message path. A value that is not a PEM key would only fail
 * later, at the first push, in a place with far less context than here.
 */
function parseApnsSecret(secretString: string): ApnsCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return null;
  }
  const { keyId, teamId, bundleId, privateKeyP8 } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof keyId !== 'string' || !keyId) return null;
  if (typeof teamId !== 'string' || !teamId) return null;
  if (typeof bundleId !== 'string' || !bundleId) return null;
  if (typeof privateKeyP8 !== 'string' || !privateKeyP8.includes('PRIVATE KEY')) return null;
  return { keyId, teamId, bundleId, privateKeyP8 };
}

/**
 * Fetches the APNs signing key and caches the RESULT for the container's
 * lifetime, so a cold start pays one Secrets Manager call and every warm
 * invocation pays none. The loader is deliberately SYNCHRONOUS at the call
 * site: the sender reads credentials as a plain value, so while the fetch is
 * still in flight it answers "no key yet" and the push degrades to `failed`
 * the same honest state as having no key at all never a failed
 * invocation.
 *
 * A FAILED fetch is logged loudly and NOT cached — same posture as the TURN
 * loader in aws/deps.ts: the in-flight marker is cleared on rejection so the
 * next send retries instead of poisoning the container, while concurrent
 * first sends share one fetch instead of racing. A SUCCESSFUL fetch of an
 * unusable value (the generated placeholder, a half-populated secret) IS
 * cached, as null: retrying cannot fix the stored value, and once an operator
 * repairs it the ApnsKeyRevision bump recycles the fleet anyway.
 */
export function makeApnsCredentialsLoader(
  // Injectable for tests; production lazily builds the Secrets Manager client.
  fetchSecret?: (arn: string) => Promise<string>,
): ApnsCredentialsLoader {
  let fetchImpl = fetchSecret;
  let credentials: ApnsCredentials | null | undefined;
  let inFlight: Promise<void> | undefined;
  const get: (secretArn: string) => ApnsCredentials | null | undefined = (secretArn) => {
    if (credentials !== undefined || inFlight) return credentials;
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
    inFlight = fetchImpl(secretArn).then((secretString) => {
      credentials = parseApnsSecret(secretString);
      if (!credentials) {
        // The OTHER failure, and the quiet one. A fetch that succeeds and
        // returns something unusable — the generated placeholder, a
        // half-populated secret, non-JSON — is cached as null on purpose,
        // because retrying cannot repair a stored value. But caching it
        // without a word means nothing fails loudly: pushes simply stop, and the only
        // symptom is that calls to a locked phone do not ring.
        // Distinguished from the fetch failure below by name, because the
        // remedies are opposite: that one retries by itself, this one needs a
        // human to write a real key and redeploy with the revision bumped.
        log.error('apns_secret_unusable', { secretArn });
      }
    });
    inFlight.catch((err: unknown) => {
      // Loud on purpose: with the key silently absent, pushes just fail and a
      // call to a locked phone does not ring early — which presents as "they
      // may be offline", not as the config or outage problem it is.
      log.error('apns_secret_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      inFlight = undefined;
    });
    return credentials;
  };
  return Object.assign(get, {
    // Await the in-flight fetch, if any. The lazy answer-now shape above is
    // right for the HTTP path, but the PUSH WORKER is an async Lambda with
    // nobody waiting on it — and its traffic is sparse, so the cold container
    // is the COMMON case, and "no key yet" there does not mean a call that
    // rings late: it means the one push this wake will ever get is dropped.
    // The worker awaits this between constructing deps (which kicks the
    // fetch) and delivering. Never rejects: a failed fetch was already logged
    // loudly by the loader, and the push then degrades exactly as before.
    settled: (): Promise<void> =>
      inFlight ? inFlight.then(() => undefined, () => undefined) : Promise.resolve(),
  });
}

/** The loader is callable — `load(arn)` — with a `settled()` alongside so an
 * async caller can wait out the cold-start fetch instead of dropping work. */
export type ApnsCredentialsLoader = ((
  secretArn: string,
) => ApnsCredentials | null | undefined) & { settled(): Promise<void> };

/** Module scope, like the sender's HTTP/2 client cache: the fetched key must
 * outlive a single invocation, or every wake would pay a Secrets Manager
 * round-trip. */
const loadApnsCredentials = makeApnsCredentialsLoader();

/** The module loader's `settled()`, for the push worker's await. */
export function apnsCredentialsSettled(): Promise<void> {
  return loadApnsCredentials.settled();
}

/**
 * Build credentials from the secret ARN the stack injects
 * (APNS_AUTH_KEY_SECRET_ARN), or null when the key has not been provisioned
 * or has not finished fetching, or was fetched and found unusable. All
 * three degrade identically: the sender reports `failed`, the call rings
 * late and the message path never crashes over it.
 */
export function readApnsCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loadCredentials: (secretArn: string) => ApnsCredentials | null | undefined =
    loadApnsCredentials,
): ApnsCredentials | null {
  const secretArn = env.APNS_AUTH_KEY_SECRET_ARN;
  if (!secretArn) return null;
  return loadCredentials(secretArn) ?? null;
}
