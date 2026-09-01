import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushTokenRecord } from '../src/db/data.js';
import {
  apnsCredentialsSettled,
  makeApnsCredentialsLoader,
  readApnsCredentials,
} from '../src/push/sender.js';

/**
 * The APNs signing key reaches the Lambda as an ARN and is fetched from
 * Secrets Manager at runtime (a `{{resolve:...}}` dynamic
 * reference left the .p8 PRIVATE KEY in plaintext on the function
 * configuration). One ARN and one fetch, not four: keyId, teamId, bundleId
 * and privateKeyP8 are JSON keys of a single secret. These tests pin the
 * three properties the fetch must hold, the same three turn.secrets.test.ts
 * pins for the relay:
 *
 * 1. CACHED — one fetch per container, however many sends read it. A
 * Secrets Manager call per push is both slow and a cost.
 * 2. DEGRADED, never fatal — while the fetch is in flight, and after a
 * failure, credentials are null and a push reports `failed`: the call
 * rings late, exactly as if no key were provisioned. A secrets
 * outage must not fail the worker's invocation.
 * 3. LOUD and retried — a FAILED fetch is logged as an error and is NOT
 * cached, so the next send tries again instead of poisoning the
 * container. A fetched-but-unusable value (the generated placeholder)
 * IS cached as unconfigured: retrying cannot fix the stored value.
 */

const HOISTED = vi.hoisted(() => {
  // Contains the marker readApnsCredentials's PEM check looks for; never a
  // real key. parseApnsSecret is what needs to accept it — nothing in these
  // tests ever signs with it.
  const privateKeyP8 = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';
  return {
    creds: {
      keyId: 'ABCD123456',
      teamId: 'TEAM123456',
      bundleId: 'com.miranatechnologies.tacendum',
      privateKeyP8,
    },
    sendVoip: vi.fn().mockResolvedValue({ outcome: 'sent' }),
  };
});

vi.mock('../src/push/apns.js', () => ({
  makeApnsClient: () => ({
    sendVoip: HOISTED.sendVoip,
  }),
}));

// The mock stands in for Secrets Manager in the makeAwsDeps test below; the
// loader tests inject their own fetch and never reach it.
vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    send(_cmd: GetSecretValueCommand): Promise<{ SecretString: string }> {
      return Promise.resolve({ SecretString: JSON.stringify(HOISTED.creds) });
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient };
});

const ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:ApnsAuthKeySecret-test';
const CREDS = HOISTED.creds;
const SECRET_JSON = JSON.stringify(CREDS);

const ENV = { APNS_AUTH_KEY_SECRET_ARN: ARN };

/** Let the in-flight fetch (a microtask chain) land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** log.error writes one JSON line to console.error; capture it quietly. */
function captureErrors(): { mock: { calls: unknown[][] } } {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Deps.log routes through log.info, one JSON line to console.log. */
function captureInfo(): { mock: { calls: unknown[][] } } {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function logged(spy: { mock: { calls: unknown[][] } }, event: string): boolean {
  return spy.mock.calls.some(call => String(call[0]).includes(event));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('readApnsCredentials', () => {
  it('is null with no APNS_AUTH_KEY_SECRET_ARN — and no fetch is even attempted', () => {
    // Every function except the push worker runs like this, permanently: the
    // deps factory is shared, and only PushFn is given the ARN (or the grant
    // that makes fetching it possible).
    const fetchSecret = vi.fn<(arn: string) => Promise<string>>();
    expect(readApnsCredentials({}, makeApnsCredentialsLoader(fetchSecret))).toBeNull();
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it('answers null while the fetch is in flight, the full credentials once they land', async () => {
    const fetchSecret = vi.fn(() => Promise.resolve(SECRET_JSON));
    const load = makeApnsCredentialsLoader(fetchSecret);
    expect(readApnsCredentials(ENV, load)).toBeNull();
    await settle();
    expect(readApnsCredentials(ENV, load)).toEqual(CREDS);
  });

  it('fetches the secret exactly once, however many sends read it', async () => {
    const fetchSecret = vi.fn(() => Promise.resolve(SECRET_JSON));
    const load = makeApnsCredentialsLoader(fetchSecret);
    readApnsCredentials(ENV, load);
    // A concurrent read during the cold-start fetch must share it, not race.
    readApnsCredentials(ENV, load);
    await settle();
    for (let i = 0; i < 5; i += 1) expect(readApnsCredentials(ENV, load)).toEqual(CREDS);
    expect(fetchSecret).toHaveBeenCalledTimes(1); // one secret, one fetch, ever
  });

  it('a failed fetch degrades to null, logs loudly, and the next send retries', async () => {
    const errors = captureErrors();
    let failing = true;
    const fetchSecret = vi.fn(() =>
      failing ? Promise.reject(new Error('secretsmanager unreachable')) : Promise.resolve(SECRET_JSON),
    );
    const load = makeApnsCredentialsLoader(fetchSecret);

    expect(readApnsCredentials(ENV, load)).toBeNull(); // starts the fetch that will fail
    await settle();
    expect(logged(errors, 'apns_secret_fetch_failed')).toBe(true);

    failing = false; // Secrets Manager recovers
    expect(readApnsCredentials(ENV, load)).toBeNull(); // kicks the retry; still in flight
    await settle();
    expect(readApnsCredentials(ENV, load)).toEqual(CREDS); // the failure was not cached
    expect(fetchSecret).toHaveBeenCalledTimes(2); // fail once, retry once
  });

  it('a fetched placeholder reads as unconfigured — cached, not retried', async () => {
    // The CDK stack ships a generated placeholder until an operator writes
    // the real key. Refetching cannot change what is
    // stored, and after the operator repairs it the ApnsKeyRevision bump
    // recycles the fleet anyway — so this caches, where a FAILURE does not.
    const placeholder = JSON.stringify({ ...CREDS, privateKeyP8: 'not-a-pem-at-all' });
    const fetchSecret = vi.fn(() => Promise.resolve(placeholder));
    const load = makeApnsCredentialsLoader(fetchSecret);
    readApnsCredentials(ENV, load);
    await settle();
    expect(readApnsCredentials(ENV, load)).toBeNull();
    expect(readApnsCredentials(ENV, load)).toBeNull();
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  it('a half-populated or non-JSON secret reads as unconfigured, never a crash', async () => {
    // Same tolerance the four plaintext env vars had: a broken secret costs
    // push, and only push — it must never take the worker down with it.
    for (const broken of [
      JSON.stringify({ ...CREDS, teamId: '' }),
      JSON.stringify({ keyId: CREDS.keyId }),
      'not json at all',
    ]) {
      const load = makeApnsCredentialsLoader(() => Promise.resolve(broken));
      readApnsCredentials(ENV, load);
      await settle();
      expect(readApnsCredentials(ENV, load), broken).toBeNull();
    }
  });
});

describe('makeAwsDeps', () => {
  it('the push sender reads credentials through a live getter, so the key appears once the fetch lands', async () => {
    // The regression pinned here: `credentials: readApnsCredentials()`
    // evaluated while building the deps object would snapshot the pre-fetch
    // null for the container's lifetime, and no push would ever be sent.
    const info = captureInfo();
    vi.stubEnv('API_ORIGIN', 'http://localhost:8080');
    vi.stubEnv('APNS_AUTH_KEY_SECRET_ARN', ARN);
    HOISTED.sendVoip.mockResolvedValue({ outcome: 'sent' });
    const { makeAwsDeps } = await import('../src/aws/deps.js');
    const deps = makeAwsDeps();

    // A row with the relevant token lets this test isolate credentials:
    // missing tokens are now a distinct `no_token` outcome checked before
    // credentials, and are covered directly in push-sender.test.ts.
    const token: PushTokenRecord = {
      userId: 'user-recipient',
      voipToken: 'a'.repeat(64),
      env: 'sandbox',
      bundleId: CREDS.bundleId,
      updatedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000,
    };

    // The build primed the fetch; not landed yet — degrades as unconfigured.
    await expect(deps.push.wake(token, 'user-caller')).resolves.toBe('failed');
    expect(logged(info, 'apns_unconfigured')).toBe(true);

    await apnsCredentialsSettled();

    // Same sender, later send: the credentials are there and the transport is
    // reached. The APNs boundary is mocked so this test never touches the
    // network.
    const outcome = await deps.push.wake(token, 'user-caller');
    expect(HOISTED.sendVoip).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('sent');
  });
});
