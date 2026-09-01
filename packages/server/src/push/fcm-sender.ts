import { readFileSync } from 'node:fs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PushOutcome, PushSender } from '../handlers/http.js';
import { log } from '../log.js';
import { makeFcmClient, type FcmClient, type FcmCredentials } from './fcm.js';

/**
 * The FCM lane of the push channel — the Android mirror of
 * sender.ts, kept deliberately parallel: the same no-op-when-unconfigured
 * posture, the same live-getter credential read, the same
 * report-token_invalid-upward contract (owning data is the handler's job,
 * not the transport's), and the same Secrets Manager discipline for the key
 * (a value resolved at deploy time sits in plaintext on the
 * function configuration, so the environment carries an ARN and the key is
 * fetched at runtime).
 *
 * One asymmetry, and it is the platform's: BOTH lanes here send to the ONE
 * FCM token. The dual-token split sender.ts routes on is an Apple
 * fact with no Google analogue.
 */

export interface FcmPushSenderOptions {
  /** Read on EVERY send, so the deps factory can supply a live getter — the
   * runtime fetch lands after the sender is built, and a snapshot taken at
   * build time would freeze null for the container's lifetime. */
  credentials: FcmCredentials | null;
  /** Structured log; never receives the key, the device token, or a payload. */
  log(event: string, fields?: Record<string, string | number | boolean>): void;
}

/**
 * A sender that is a no-op when unconfigured — missing credentials mean
 * Android devices are woken by nothing but their own socket, which is
 * exactly the previous behaviour. Throwing would turn a
 * missing key into failed MESSAGE delivery.
 */
export function makeFcmPushSender(options: FcmPushSenderOptions): PushSender {
  let client: FcmClient | null = null;
  let warned = false;

  function clientFor(credentials: FcmCredentials): FcmClient {
    // One project, one client — the analogue of sender.ts's per-env map,
    // collapsed because FCM has no host split to key on.
    if (!client) client = makeFcmClient({ credentials });
    return client;
  }

  return {
    async wake(token, fromUserId): Promise<PushOutcome> {
      if (!token.fcmToken) {
        // Its own event, same reason as push_skipped_no_voip_token: "the row
        // has no token" and "Google said no" are different repairs.
        options.log('push_skipped_no_fcm_token');
        return 'no_token';
      }
      const { credentials } = options;
      if (!credentials) {
        // Once per execution environment, not once per call.
        if (!warned) {
          warned = true;
          options.log('fcm_unconfigured');
        }
        return 'failed';
      }
      try {
        const result = await clientFor(credentials).sendCallWake(token.fcmToken, {
          from: fromUserId,
          ts: Date.now(),
        });
        if (result.outcome !== 'sent') {
          // Status and Google's code, never a token: the one diagnostic FCM
          // offers, same as apns_refused.
          options.log('fcm_refused', {
            kind: 'call',
            status: result.status ?? 0,
            reason: result.reason ?? '',
          });
        }
        return result.outcome;
      } catch {
        // Transport died. The offer is durably queued; the call just does
        // not ring early.
        return 'failed';
      }
    },

    async notify(token, message): Promise<PushOutcome> {
      if (!token.fcmToken) {
        options.log('push_skipped_no_fcm_token');
        return 'no_token';
      }
      const { credentials } = options;
      if (!credentials) {
        if (!warned) {
          warned = true;
          options.log('fcm_unconfigured');
        }
        return 'failed';
      }
      try {
        // THE CIPHERTEXT STOPS HERE. `message.payload` is deliberately not
        // destructured: the FCM message-wake carries routing facts only, and
        // the client's own payload type has no field to smuggle it through
        // (FcmMessageWakePayload, push/fcm.ts — the why lives there).
        const result = await clientFor(credentials).sendMessageWake(
          token.fcmToken,
          {
            from: message.from,
            ts: message.ts,
            msgId: message.msgId,
            msgType: message.msgType,
          },
        );
        if (result.outcome !== 'sent') {
          options.log('fcm_refused', {
            kind: 'message',
            status: result.status ?? 0,
            reason: result.reason ?? '',
          });
        }
        return result.outcome;
      } catch {
        return 'failed';
      }
    },
  };
}

/**
 * Everything the fetched secret must contain, or null — the secret's value
 * is the service-account JSON key file exactly as Google issued it, stored
 * verbatim so an operator pastes a download rather than hand-assembling
 * fields. Deliberately tolerant, same as parseApnsSecret: a placeholder, a
 * half-populated value or non-JSON reads as "unconfigured", never as a crash
 * on the message path.
 */
export function parseFcmServiceAccount(raw: string): FcmCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { project_id, client_email, private_key, token_uri } = (parsed ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof project_id !== 'string' || !project_id) return null;
  if (typeof client_email !== 'string' || !client_email) return null;
  if (typeof private_key !== 'string' || !private_key.includes('PRIVATE KEY')) return null;
  return {
    projectId: project_id,
    clientEmail: client_email,
    privateKeyPem: private_key,
    // Every real key file names it; tolerate an absent field with the value
    // every real one holds rather than reading the whole key as unusable.
    tokenUri:
      typeof token_uri === 'string' && token_uri
        ? token_uri
        : 'https://oauth2.googleapis.com/token',
  };
}

/**
 * Fetches the FCM service-account key and caches the RESULT for the
 * container's lifetime — the same loader shape, posture and failure grammar
 * as makeApnsCredentialsLoader (sender.ts), because the two keys have the
 * same lifecycle: one Secrets Manager call per cold start, null while the
 * fetch is in flight (the push degrades, never the invocation), a FAILED
 * fetch logged loudly and retried on the next send, a SUCCESSFUL fetch of an
 * unusable value cached as null because refetching cannot repair a stored
 * value.
 */
export function makeFcmCredentialsLoader(
  fetchSecret?: (arn: string) => Promise<string>,
): FcmCredentialsLoader {
  let fetchImpl = fetchSecret;
  let credentials: FcmCredentials | null | undefined;
  let inFlight: Promise<void> | undefined;
  const get: (secretArn: string) => FcmCredentials | null | undefined = (secretArn) => {
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
      credentials = parseFcmServiceAccount(secretString);
      if (!credentials) {
        // The quiet failure, named apart from the fetch failure below
        // because the remedies are opposite: this one needs a human to store
        // a real key file and recycle the fleet; that one retries by itself.
        log.error('fcm_secret_unusable', { secretArn });
      }
    });
    inFlight.catch((err: unknown) => {
      // Loud on purpose: with the key silently absent, Android wakes simply
      // do not happen, which presents as "they may be offline".
      log.error('fcm_secret_fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      inFlight = undefined;
    });
    return credentials;
  };
  return Object.assign(get, {
    // Await the in-flight fetch, if any — the push worker's cold-start wait,
    // for the identical reason sender.ts documents on its `settled`: the
    // worker's traffic is sparse, so the cold container is the COMMON case,
    // and "no key yet" there drops the one push this wake will ever get.
    settled: (): Promise<void> =>
      inFlight ? inFlight.then(() => undefined, () => undefined) : Promise.resolve(),
  });
}

/** Callable — `load(arn)` — with `settled()` alongside, mirroring
 * ApnsCredentialsLoader. */
export type FcmCredentialsLoader = ((
  secretArn: string,
) => FcmCredentials | null | undefined) & { settled(): Promise<void> };

/** Module scope, like the APNs loader: the fetched key must outlive a single
 * invocation. */
const loadFcmCredentials = makeFcmCredentialsLoader();

/** The module loader's `settled()`, for the push worker's await. */
export function fcmCredentialsSettled(): Promise<void> {
  return loadFcmCredentials.settled();
}

/**
 * Build credentials from the secret ARN the stack injects
 * (FCM_SERVICE_ACCOUNT_SECRET_ARN), or null when the key has not been
 * provisioned — or has not finished fetching, or was fetched and found
 * unusable. All three degrade identically: the FCM lane reports `failed`,
 * the Android device wakes on its own socket instead, and the message path
 * never crashes over it.
 */
export function readFcmCredentials(
  env: NodeJS.ProcessEnv = process.env,
  loadCredentials: (secretArn: string) => FcmCredentials | null | undefined =
    loadFcmCredentials,
): FcmCredentials | null {
  const secretArn = env.FCM_SERVICE_ACCOUNT_SECRET_ARN;
  if (!secretArn) return null;
  return loadCredentials(secretArn) ?? null;
}

/**
 * The LOCAL transport of the same key: a file path named by
 * FCM_SERVICE_ACCOUNT_KEY_PATH, because a dev machine has no Secrets Manager
 * — the exact split the TURN config documents (local/http.ts reads secret
 * VALUES, aws/deps.ts reads ARNs). Only the transport differs; the parsed
 * shape and the sender consuming it are the same.
 *
 * Unset returns null (the local FCM lane then runs its greppable stub).
 * Set-but-unusable THROWS, mirroring readLocalTurnConfig's posture: a
 * half-configured lane is worse than none, because every Android wake would
 * try it and fail instead of saying at boot that the path is wrong.
 */
export function readFcmCredentialsFromPath(
  env: NodeJS.ProcessEnv = process.env,
): FcmCredentials | null {
  const keyPath = env.FCM_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) return null;
  let raw: string;
  try {
    raw = readFileSync(keyPath, 'utf8');
  } catch (err) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT_KEY_PATH is set but unreadable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const credentials = parseFcmServiceAccount(raw);
  if (!credentials) {
    // The path, never the contents: the file that failed to parse is a
    // private key.
    throw new Error(
      'FCM_SERVICE_ACCOUNT_KEY_PATH names a file that is not a service-account key',
    );
  }
  return credentials;
}
