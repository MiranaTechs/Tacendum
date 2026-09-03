import { describe, expect, it, vi } from 'vitest';

/**
 * The two Secrets Manager clients the loaders build lazily used to take the
 * SDK's default request handler — no connection or request timeout of their
 * own — so a hung Secrets Manager connection on a cold container turned the
 * first identifier-lane request (which AWAITS the K_id fetch,
 * handlers/identifiers.ts `hmacKeys`) into a 5xx after the FULL Lambda
 * timeout. Both clients now carry the pinned
 * `SECRETS_MANAGER_REQUEST_TIMEOUTS`; the constructor input is what this
 * suite captures, through the same module mock turn.secrets.test.ts uses, so
 * no real client is ever built. */

const constructed: unknown[] = [];

vi.mock('@aws-sdk/client-secrets-manager', () => {
  class GetSecretValueCommand {
    constructor(readonly input: { SecretId: string }) {}
  }
  class SecretsManagerClient {
    constructor(config: unknown) {
      constructed.push(config);
    }
    send(cmd: GetSecretValueCommand): Promise<{ SecretString: string }> {
      return Promise.resolve({ SecretString: `value-of:${cmd.input.SecretId}` });
    }
  }
  return { GetSecretValueCommand, SecretsManagerClient };
});

describe('the Secrets Manager clients carry their own timeouts', () => {
  it('the TURN-secrets loader and the salt/K_id loader both construct the client with the pinned connection and request timeouts', async () => {
    const { makeTurnSecretsLoader, makeUserRefSaltLoader, SECRETS_MANAGER_REQUEST_TIMEOUTS } =
      await import('../src/aws/deps.js');
    // The bound must be well under the identifier lane's own wait
    // (IDENTIFIER_KEY_WAIT_MS) and under every function's Lambda timeout, and
    // it must not be zero (an SDK zero means "no timeout").
    expect(SECRETS_MANAGER_REQUEST_TIMEOUTS.connectionTimeout).toBeGreaterThan(0);
    expect(SECRETS_MANAGER_REQUEST_TIMEOUTS.requestTimeout).toBeGreaterThan(0);
    expect(SECRETS_MANAGER_REQUEST_TIMEOUTS.requestTimeout).toBeLessThanOrEqual(5_000);

    constructed.length = 0;
    // No injected fetch: the production path, which builds the client.
    makeTurnSecretsLoader()('arn:auth', 'arn:salt');
    makeUserRefSaltLoader()('arn:kid');
    expect(constructed).toHaveLength(2);
    for (const config of constructed) {
      expect(config).toEqual({ requestHandler: SECRETS_MANAGER_REQUEST_TIMEOUTS });
    }
  });
});
