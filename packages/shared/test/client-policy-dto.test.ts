/**
 * The wire shape of `GET /v1/client-policy`.
 *
 * The client `.parse()`s this response strictly and there is no OTA path, so
 * the shape has exactly one required field per platform and every other field
 * tolerates absence. The asymmetry is the whole point: a server that stopped
 * emitting `latestBuild` must not brick an installed build, while a server
 * that stopped emitting `minBuild` must be read as "no answer" rather than as
 * a gate of zero: the client fails OPEN on a parse failure, and a policy it
 * cannot read is not a policy.
 */
import { describe, expect, it } from 'vitest';
import { ClientPolicyResponse } from '../src/dto.js';

const minimal = { ios: { minBuild: 0 }, android: { minBuild: 0 } };

describe('ClientPolicyResponse', () => {
  it('parses a response carrying nothing but the two minBuilds', () => {
    expect(ClientPolicyResponse.parse(minimal)).toEqual(minimal);
  });

  it('parses a full response field for field', () => {
    const full = {
      ios: { minBuild: 25, latestBuild: 27, url: 'https://apps.apple.com/app/id123' },
      android: { minBuild: 24, latestBuild: 27, url: 'https://play.google.com/store/apps/details?id=x' },
      message: 'A security fix shipped in build 25.',
    };
    expect(ClientPolicyResponse.parse(full)).toEqual(full);
  });

  it('REFUSES a platform with no minBuild', () => {
    // Not tolerated, deliberately: absence would parse as a policy the client
    // then has to guess the floor of.
    expect(ClientPolicyResponse.safeParse({ ios: {}, android: { minBuild: 0 } }).success).toBe(false);
  });

  it('REFUSES a response missing a platform entirely', () => {
    expect(ClientPolicyResponse.safeParse({ ios: { minBuild: 1 } }).success).toBe(false);
  });

  it('REFUSES a non-integer, negative, or string minBuild', () => {
    for (const minBuild of [1.5, -1, '25']) {
      expect(
        ClientPolicyResponse.safeParse({ ios: { minBuild }, android: { minBuild: 0 } }).success,
        String(minBuild),
      ).toBe(false);
    }
  });

  it('REFUSES a url that is not a url, and one past 200 characters', () => {
    expect(
      ClientPolicyResponse.safeParse({ ios: { minBuild: 0, url: 'not a url' }, android: { minBuild: 0 } })
        .success,
    ).toBe(false);
    // The client hands this to `Linking.openURL`, so a scheme the OS routes
    // anywhere but a browser is refused at the schema. A bare url check
    // accepts both of these.
    for (const url of ['javascript:alert(1)', 'ftp://example.test/app']) {
      expect(
        ClientPolicyResponse.safeParse({ ios: { minBuild: 0, url }, android: { minBuild: 0 } }).success,
        url,
      ).toBe(false);
    }
    const long = `https://example.test/${'a'.repeat(200)}`;
    expect(
      ClientPolicyResponse.safeParse({ ios: { minBuild: 0, url: long }, android: { minBuild: 0 } }).success,
    ).toBe(false);
  });

  it('REFUSES a message of 201 characters and accepts one of 200', () => {
    expect(ClientPolicyResponse.safeParse({ ...minimal, message: 'm'.repeat(201) }).success).toBe(false);
    expect(ClientPolicyResponse.safeParse({ ...minimal, message: 'm'.repeat(200) }).success).toBe(true);
  });
});
