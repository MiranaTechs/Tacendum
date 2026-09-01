import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTurnSecretsLoader, readTurnConfig } from '../src/aws/deps.js';

/**
 * The relay secrets reach the Lambda as ARNs and are fetched from Secrets
 * Manager at runtime (a `{{resolve:...}}` dynamic reference
 * left the plaintext on the function configuration). These tests pin the
 * three properties the fetch must hold:
 *
 * 1. CACHED — one fetch per secret per container, however many requests
 * read it. A Secrets Manager call per request is both slow and a cost.
 * 2. DEGRADED, never fatal — while the fetch is in flight, and after a
 * failure, `turn` is null and /v1/turn-credentials answers
 * turn_unavailable (calls go direct, posture). A secrets
 * outage must not take down the HTTP function.
 * 3. LOUD and retried — a failure is logged as an error and is NOT cached,
 * so the next request tries again instead of poisoning the container.
 */

// The mock stands in for Secrets Manager in the makeAwsDeps test below; the
// loader tests inject their own fetch and never reach it.
vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    send(cmd: GetSecretValueCommand): Promise<{ SecretString: string }> {
      return Promise.resolve({ SecretString: `value-of:${cmd.input.SecretId}` });
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient };
});

const AUTH_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:CoturnAuthSecret-test';
const SALT_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:CoturnUserSalt-test';
const URLS = 'turn:relay.test:3478?transport=udp,turns:relay.test:443?transport=tcp';

const ENV = {
  TURN_URLS: URLS,
  TURN_AUTH_SECRET_ARN: AUTH_ARN,
  TURN_USER_SALT_ARN: SALT_ARN,
};

const RESOLVED = {
  urls: ['turn:relay.test:3478?transport=udp', 'turns:relay.test:443?transport=tcp'],
  authSecret: `value-of:${AUTH_ARN}`,
  userSalt: `value-of:${SALT_ARN}`,
};

/** Let the in-flight fetch (a microtask chain) land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** log.error writes one JSON line to console.error; capture it quietly. */
function captureErrors(): { mock: { calls: unknown[][] } } {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function logged(spy: { mock: { calls: unknown[][] } }, event: string): boolean {
  return spy.mock.calls.some(call => String(call[0]).includes(event));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('readTurnConfig', () => {
  it('is null with no TURN_URLS — and no fetch is even attempted', () => {
    const fetchSecret = vi.fn<(arn: string) => Promise<string>>();
    expect(readTurnConfig({}, makeTurnSecretsLoader(fetchSecret))).toBeNull();
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it('degrades to null and logs when the ARNs are missing, rather than throw', () => {
    // Throwing here would fail the shared deps build and take messaging down
    // with it — a misconfigured relay must cost the relay, nothing else.
    const errors = captureErrors();
    const fetchSecret = vi.fn<(arn: string) => Promise<string>>();
    expect(readTurnConfig({ TURN_URLS: URLS }, makeTurnSecretsLoader(fetchSecret))).toBeNull();
    expect(fetchSecret).not.toHaveBeenCalled();
    expect(logged(errors, 'turn_config_incomplete')).toBe(true);
  });

  it('answers null while the fetch is in flight, the full config once it lands', async () => {
    const fetchSecret = vi.fn((arn: string) => Promise.resolve(`value-of:${arn}`));
    const load = makeTurnSecretsLoader(fetchSecret);
    expect(readTurnConfig(ENV, load)).toBeNull();
    await settle();
    expect(readTurnConfig(ENV, load)).toEqual(RESOLVED);
  });

  it('fetches each secret exactly once, however many requests read it', async () => {
    const fetchSecret = vi.fn((arn: string) => Promise.resolve(`value-of:${arn}`));
    const load = makeTurnSecretsLoader(fetchSecret);
    readTurnConfig(ENV, load);
    // A concurrent read during the cold-start fetch must share it, not race.
    readTurnConfig(ENV, load);
    await settle();
    for (let i = 0; i < 5; i += 1) expect(readTurnConfig(ENV, load)).toEqual(RESOLVED);
    expect(fetchSecret).toHaveBeenCalledTimes(2); // one per ARN, ever
  });

  it('a failed fetch degrades to null, logs loudly, and the next request retries', async () => {
    const errors = captureErrors();
    let failing = true;
    const fetchSecret = vi.fn((arn: string) =>
      failing ? Promise.reject(new Error('secretsmanager unreachable')) : Promise.resolve(`value-of:${arn}`),
    );
    const load = makeTurnSecretsLoader(fetchSecret);

    expect(readTurnConfig(ENV, load)).toBeNull(); // starts the fetch that will fail
    await settle();
    expect(logged(errors, 'turn_secret_fetch_failed')).toBe(true);

    failing = false; // Secrets Manager recovers
    expect(readTurnConfig(ENV, load)).toBeNull(); // kicks the retry; still in flight
    await settle();
    expect(readTurnConfig(ENV, load)).toEqual(RESOLVED); // the failure was not cached
    expect(fetchSecret).toHaveBeenCalledTimes(4); // two per attempt: fail once, retry once
  });
});

describe('makeAwsDeps', () => {
  it('reads turn through a live getter, so the config appears once the fetch lands', async () => {
    // The regression pinned here: `turn: readTurnConfig()` evaluated while
    // building the deps object would snapshot the pre-fetch null for the
    // container's lifetime, and no relayed call would ever get credentials.
    vi.stubEnv('API_ORIGIN', 'http://localhost:8080');
    vi.stubEnv('TURN_URLS', URLS);
    vi.stubEnv('TURN_AUTH_SECRET_ARN', AUTH_ARN);
    vi.stubEnv('TURN_USER_SALT_ARN', SALT_ARN);
    const { makeAwsDeps } = await import('../src/aws/deps.js');
    const deps = makeAwsDeps();
    expect(deps.turn).toBeNull(); // the build primed the fetch; not landed yet
    await settle();
    expect(deps.turn).toEqual(RESOLVED); // same object, later read: config
  });
});
