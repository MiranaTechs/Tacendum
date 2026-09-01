/**
 * The origin that reaches the native signer must already be normalised.
 *
 * The server verifies against `normalizeOrigin(its own origin)`, and the Swift
 * signer appends whatever string it is handed, verbatim. If an un-normalised
 * origin crosses the bridge, the phone signs a different payload than the
 * server checks and EVERY login fails with `invalid_signature` — an error that
 * points at the cryptography rather than at a trailing slash.
 *
 * Found by transcribing the Swift construction into a standalone harness and
 * running it against `packages/shared/authvectors.json`: every normalised input
 * matched byte for byte, and `https://API.Tacendum.com:443/v1/` did not. The
 * wrapper in `modules/tacendum-crypto/src/index.ts` now normalises; these tests
 * hold down the two halves of why that is enough — the transformation is real,
 * and the configured base it is applied to is the one the app actually dials.
 */
// Only the native spec is mocked. The WRAPPER is loaded with requireActual,
// because jest.setup.js mocks the whole `tacendum-crypto` package — which is
// the very module under test here, and mocking it would leave this asserting
// about the mock.
jest.mock('../modules/tacendum-crypto/src/NativeTacendumCrypto', () => ({
  __esModule: true,
  default: { signAuthChallenge: jest.fn(async () => 'sig') },
}));

import { API_BASE } from '../src/config';
import { authSignedBytes, normalizeOrigin } from '@tacendum/shared';

const CHALLENGE = 'Q0hBTExFTkdF';

test('normalisation actually changes the payload — the length prefix moves', () => {
  // If normalisation ever became a no-op, the tests below would pass while
  // proving nothing. A messy origin and its clean form must build identical
  // bytes, and the two raw strings must differ in length — so the payloads
  // would have differed in the length prefix before they differed in content,
  // which is exactly what that prefix is for.
  // No Buffer here: the app tsconfig has no node types (RN runtime has no
  // Buffer either), and none is needed — Uint8Arrays compare with toEqual,
  // and these origins are pure ASCII so .length IS the byte length.
  const clean = authSignedBytes('https://api.tacendum.com', CHALLENGE);
  const messy = authSignedBytes('HTTPS://API.Tacendum.com:443/v1/', CHALLENGE);
  expect(messy).toEqual(clean);

  expect('HTTPS://API.Tacendum.com:443/v1/'.length).not.toBe(
    'https://api.tacendum.com'.length,
  );
});

test('the app’s configured API base is already normalised', () => {
  // The bridge normalises, so this is belt and braces — but it is the check
  // that fires first and most legibly if someone adds a trailing slash or an
  // uppercase host to config. A CI failure here is cheap; discovering it as
  // "nobody can sign in" is not.
  expect(normalizeOrigin(API_BASE)).toBe(API_BASE);
});

test('origin forms that should collapse to one audience do', () => {
  const canonical = 'https://api.tacendum.com';
  for (const variant of [
    'https://api.tacendum.com/',
    'https://API.tacendum.com',
    'https://api.tacendum.com:443',
    'https://api.tacendum.com/v1/keys',
  ]) {
    expect(normalizeOrigin(variant)).toBe(canonical);
  }
});

test('a lookalike host is a different audience, not a normalisation quirk', () => {
  // The point of the whole change: an origin that merely resembles the real one
  // must not collapse into it, and a downgrade to http must not either.
  expect(normalizeOrigin('https://api.tacendum.com.evil.example')).not.toBe(
    'https://api.tacendum.com',
  );
  expect(normalizeOrigin('http://api.tacendum.com')).not.toBe('https://api.tacendum.com');
});

test('the wrapper normalises before the native signer sees it', async () => {
  // The claim in the commit that added the wrapper — "mutating it away fails the test" — was
  // FALSE when written: nothing exercised the wrapper, so deleting
  // normalizeOrigin from it broke no test and the protection held only
  // transitively through "API_BASE is already normalised". Gate review caught
  // it. This is the test that makes the claim true.
  const native = (
    jest.requireMock('../modules/tacendum-crypto/src/NativeTacendumCrypto') as {
      default: { signAuthChallenge: jest.Mock };
    }
  ).default;
  const wrapper = jest.requireActual('../modules/tacendum-crypto/src') as {
    signAuthChallenge: (c: string, o: string) => Promise<string>;
  };

  native.signAuthChallenge.mockClear();
  await wrapper.signAuthChallenge(CHALLENGE, 'HTTPS://API.Tacendum.com:443/v1/');

  expect(native.signAuthChallenge).toHaveBeenCalledWith(CHALLENGE, 'https://api.tacendum.com');
});
