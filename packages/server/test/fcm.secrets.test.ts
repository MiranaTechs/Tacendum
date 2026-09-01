import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushTokenRecord } from '../src/db/data.js';
import {
  fcmCredentialsSettled,
  makeFcmCredentialsLoader,
  readFcmCredentials,
  readFcmCredentialsFromPath,
} from '../src/push/fcm-sender.js';

/**
 * The FCM service-account key reaches the Lambda as an ARN and is fetched
 * from Secrets Manager at runtime — the identical posture, loader shape and
 * three pinned properties as push.secrets.test.ts holds for the APNs key
 * (and turn.secrets.test.ts for the relay): CACHED (one fetch per
 * container), DEGRADED never fatal (null in flight and after failure — an
 * Android wake is skipped, the invocation never fails), LOUD and retried on
 * a failed fetch — while a fetched-but-unusable value is cached as
 * unconfigured, because refetching cannot repair a stored value.
 *
 * The secret's VALUE is the service-account JSON key file verbatim, so an
 * operator pastes Google's download rather than hand-assembling fields.
 */

const HOISTED = vi.hoisted(() => {
  // Contains the marker parseFcmServiceAccount's PEM check looks for; never
  // a real key. Nothing in these tests ever signs with it.
  const keyFile = {
    type: 'service_account',
    project_id: 'tacendum-test',
    client_email: 'push@tacendum-test.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  return {
    keyFile,
    sendCallWake: vi.fn().mockResolvedValue({ outcome: 'sent' }),
  };
});

vi.mock('../src/push/fcm.js', () => ({
  makeFcmClient: () => ({
    sendCallWake: HOISTED.sendCallWake,
  }),
}));

// Stands in for Secrets Manager in the makeAwsDeps test below; the loader
// tests inject their own fetch and never reach it.
vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    send(_cmd: GetSecretValueCommand): Promise<{ SecretString: string }> {
      return Promise.resolve({ SecretString: JSON.stringify(HOISTED.keyFile) });
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient };
});

const ARN =
  'arn:aws:secretsmanager:us-east-1:000000000000:secret:FcmServiceAccountSecret-test';
const KEY_JSON = JSON.stringify(HOISTED.keyFile);
const PARSED = {
  projectId: 'tacendum-test',
  clientEmail: 'push@tacendum-test.iam.gserviceaccount.com',
  privateKeyPem: HOISTED.keyFile.private_key,
  tokenUri: 'https://oauth2.googleapis.com/token',
};

const ENV = { FCM_SERVICE_ACCOUNT_SECRET_ARN: ARN };

/** Let the in-flight fetch (a microtask chain) land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function captureErrors(): { mock: { calls: unknown[][] } } {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

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

describe('readFcmCredentials', () => {
  it('is null with no FCM_SERVICE_ACCOUNT_SECRET_ARN — and no fetch is even attempted', () => {
    const fetchSecret = vi.fn<(arn: string) => Promise<string>>();
    expect(readFcmCredentials({}, makeFcmCredentialsLoader(fetchSecret))).toBeNull();
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it('answers null while the fetch is in flight, the parsed credentials once they land', async () => {
    const fetchSecret = vi.fn(() => Promise.resolve(KEY_JSON));
    const load = makeFcmCredentialsLoader(fetchSecret);
    expect(readFcmCredentials(ENV, load)).toBeNull();
    await settle();
    expect(readFcmCredentials(ENV, load)).toEqual(PARSED);
  });

  it('fetches the secret exactly once, however many sends read it', async () => {
    const fetchSecret = vi.fn(() => Promise.resolve(KEY_JSON));
    const load = makeFcmCredentialsLoader(fetchSecret);
    readFcmCredentials(ENV, load);
    readFcmCredentials(ENV, load); // concurrent cold-start reads share it
    await settle();
    for (let i = 0; i < 5; i += 1) expect(readFcmCredentials(ENV, load)).toEqual(PARSED);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch degrades to null, logs loudly, and the next send retries', async () => {
    const errors = captureErrors();
    let failing = true;
    const fetchSecret = vi.fn(() =>
      failing
        ? Promise.reject(new Error('secretsmanager unreachable'))
        : Promise.resolve(KEY_JSON),
    );
    const load = makeFcmCredentialsLoader(fetchSecret);

    expect(readFcmCredentials(ENV, load)).toBeNull();
    await settle();
    expect(logged(errors, 'fcm_secret_fetch_failed')).toBe(true);

    failing = false;
    expect(readFcmCredentials(ENV, load)).toBeNull(); // kicks the retry
    await settle();
    expect(readFcmCredentials(ENV, load)).toEqual(PARSED);
    expect(fetchSecret).toHaveBeenCalledTimes(2);
  });

  it('a fetched placeholder reads as unconfigured — cached, not retried', async () => {
    const errors = captureErrors();
    const placeholder = JSON.stringify({
      ...HOISTED.keyFile,
      private_key: 'not-a-pem-at-all',
    });
    const fetchSecret = vi.fn(() => Promise.resolve(placeholder));
    const load = makeFcmCredentialsLoader(fetchSecret);
    readFcmCredentials(ENV, load);
    await settle();
    expect(readFcmCredentials(ENV, load)).toBeNull();
    expect(readFcmCredentials(ENV, load)).toBeNull();
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(logged(errors, 'fcm_secret_unusable')).toBe(true);
  });

  it('a half-populated or non-JSON secret reads as unconfigured, never a crash', async () => {
    const errors = captureErrors();
    for (const broken of [
      JSON.stringify({ ...HOISTED.keyFile, project_id: '' }),
      JSON.stringify({ project_id: 'tacendum-test' }),
      'not json at all',
    ]) {
      const load = makeFcmCredentialsLoader(() => Promise.resolve(broken));
      readFcmCredentials(ENV, load);
      await settle();
      expect(readFcmCredentials(ENV, load), broken).toBeNull();
    }
    expect(errors.mock.calls.length).toBeGreaterThan(0);
  });

  it('defaults a missing token_uri to Google\'s, rather than rejecting the key', async () => {
    const { token_uri: _tokenUri, ...withoutUri } = HOISTED.keyFile;
    const load = makeFcmCredentialsLoader(() =>
      Promise.resolve(JSON.stringify(withoutUri)),
    );
    readFcmCredentials(ENV, load);
    await settle();
    expect(readFcmCredentials(ENV, load)?.tokenUri).toBe(
      'https://oauth2.googleapis.com/token',
    );
  });
});

describe('readFcmCredentialsFromPath (the local transport of the same key)', () => {
  it('is null when FCM_SERVICE_ACCOUNT_KEY_PATH is unset — the local stub lane', () => {
    expect(readFcmCredentialsFromPath({})).toBeNull();
  });

  it('THROWS on a set-but-unreadable path — half-configured is worse than none', () => {
    expect(() =>
      readFcmCredentialsFromPath({
        FCM_SERVICE_ACCOUNT_KEY_PATH: '/nonexistent/fcm-key.json',
      }),
    ).toThrow(/FCM_SERVICE_ACCOUNT_KEY_PATH/);
  });
});

describe('makeAwsDeps', () => {
  it('routes an android row to the FCM lane through a live credential getter', async () => {
    // The same regression push.secrets.test.ts pins for APNs, on this lane:
    // a snapshot taken while building the deps object would freeze the
    // pre-fetch null for the container's lifetime — plus the routing fact
    // that an android row reaches FCM at all through the real wiring.
    const info = captureInfo();
    vi.stubEnv('API_ORIGIN', 'http://localhost:8080');
    vi.stubEnv('FCM_SERVICE_ACCOUNT_SECRET_ARN', ARN);
    HOISTED.sendCallWake.mockResolvedValue({ outcome: 'sent' });
    const { makeAwsDeps } = await import('../src/aws/deps.js');
    const deps = makeAwsDeps();

    const token: PushTokenRecord = {
      userId: 'user-recipient',
      platform: 'android',
      fcmToken: `device-instance-id:APA91b${'x'.repeat(120)}`,
      bundleId: 'com.miranatechnologies.tacendum',
      updatedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000,
    };

    // The build primed the fetch; not landed yet — degrades as unconfigured.
    await expect(deps.push.wake(token, 'user-caller')).resolves.toBe('failed');
    expect(logged(info, 'fcm_unconfigured')).toBe(true);

    await fcmCredentialsSettled();

    const outcome = await deps.push.wake(token, 'user-caller');
    expect(HOISTED.sendCallWake).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('sent');
  });
});
