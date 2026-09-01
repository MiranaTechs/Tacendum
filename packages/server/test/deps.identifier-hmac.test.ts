import { describe, expect, it } from 'vitest';
import { readIdentifierHmacKeys } from '../src/aws/deps.js';

/**
 * The K_id key-set loader's fail-closed contract: the walk is EITHER every configured active version OR
 * nothing — never a silently narrowed one-version walk while a configured
 * rotation window's retiring secret is still fetching. A narrowed walk would
 * read every unmigrated claim as a miss for that invocation, against the
 * unconditional all-versions walk release pins (and against the
 * uniform-timing surface, whose work per admitted request must not vary by
 * container warm-up state).
 *
 * Loader seams are injected (the makeUserRefSaltLoader contract: undefined =
 * fetch in flight or failed); no Secrets Manager client is ever constructed
 * here.
 */

const resolved =
  (value: string) =>
  (_arn: string): string | undefined =>
    value;
const inFlight = (_arn: string): string | undefined => undefined;

describe('readIdentifierHmacKeys (all versions or nothing)', () => {
  it('returns undefined without the primary env', () => {
    expect(readIdentifierHmacKeys({}, resolved('k1'), resolved('k0'))).toBeUndefined();
  });

  it('returns undefined while the primary fetch is in flight', () => {
    expect(
      readIdentifierHmacKeys(
        { IDENTIFIER_HMAC_KEY_ARN: 'arn:a', IDENTIFIER_HMAC_KEY_VERSION: '2' },
        inFlight,
        resolved('k0'),
      ),
    ).toBeUndefined();
  });

  it('serves the one-version set when no retiring pair is configured', () => {
    expect(
      readIdentifierHmacKeys(
        { IDENTIFIER_HMAC_KEY_ARN: 'arn:a', IDENTIFIER_HMAC_KEY_VERSION: '2' },
        resolved('k2'),
        inFlight,
      ),
    ).toEqual({ keys: [{ version: 2, key: 'k2' }] });
  });

  it('FAILS CLOSED — undefined, never primary-only — while a configured retiring secret is unresolved (the cold-start one-version walk, closed)', () => {
    expect(
      readIdentifierHmacKeys(
        {
          IDENTIFIER_HMAC_KEY_ARN: 'arn:a',
          IDENTIFIER_HMAC_KEY_VERSION: '2',
          IDENTIFIER_HMAC_KEY_PREV_ARN: 'arn:prev',
          IDENTIFIER_HMAC_KEY_PREV_VERSION: '1',
        },
        resolved('k2'),
        inFlight,
      ),
    ).toBeUndefined();
  });

  it('serves the two-version walk, newest first, once both secrets resolve', () => {
    expect(
      readIdentifierHmacKeys(
        {
          IDENTIFIER_HMAC_KEY_ARN: 'arn:a',
          IDENTIFIER_HMAC_KEY_VERSION: '2',
          IDENTIFIER_HMAC_KEY_PREV_ARN: 'arn:prev',
          IDENTIFIER_HMAC_KEY_PREV_VERSION: '1',
        },
        resolved('k2'),
        resolved('k1'),
      ),
    ).toEqual({
      keys: [
        { version: 2, key: 'k2' },
        { version: 1, key: 'k1' },
      ],
    });
  });

  it('drops a MISCONFIGURED retiring version (≥ primary) as documented — keys[0] stays the newest attach writes under', () => {
    // A static deploy mistake, not a transient fetch: the documented drop
    // keeps the primary-newest invariant rather than downing the lane on a
    // pair that could never legally join the walk.
    expect(
      readIdentifierHmacKeys(
        {
          IDENTIFIER_HMAC_KEY_ARN: 'arn:a',
          IDENTIFIER_HMAC_KEY_VERSION: '2',
          IDENTIFIER_HMAC_KEY_PREV_ARN: 'arn:prev',
          IDENTIFIER_HMAC_KEY_PREV_VERSION: '2',
        },
        resolved('k2'),
        resolved('k1'),
      ),
    ).toEqual({ keys: [{ version: 2, key: 'k2' }] });
  });
});
