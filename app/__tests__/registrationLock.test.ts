import {
  InvalidPin,
  LockDeriveFailed,
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  buildLock,
  deriveVerifier,
  newSalt,
  pinProblem,
  pinProblemCopy,
} from '../src/registrationLock';

/**
 * PIN derivation. The property that matters throughout: the PIN itself never
 * leaves this device — only a verifier derived from it.
 *
 * The set/clear cases that used to live at the bottom of this file are gone
 * with the routes they drove (cost table row 1).
 * What is left is the half reserved for encrypted backups (a future feature),
 * which touches the network not at all — hence no api mock any more.
 */

const crypto = jest.requireMock('tacendum-crypto') as {
  pinVerifier: jest.Mock;
  __keychain: Map<string, string>;
};

beforeEach(() => {
  crypto.__keychain.clear();
  crypto.pinVerifier.mockClear();
});

describe('pinProblem', () => {
  it('accepts an ordinary PIN', () => {
    expect(pinProblem('4817')).toBeNull();
    expect(pinProblem('90210')).toBeNull();
  });

  it('refuses anything that is not digits — the pad cannot re-enter it', () => {
    expect(pinProblem('12a4')).toBe('nondigit');
    expect(pinProblem('1 34')).toBe('nondigit');
  });

  it('enforces the length bounds', () => {
    expect(pinProblem('1'.repeat(MIN_PIN_LENGTH - 1))).toBe('short');
    expect(pinProblem('1928374655'.slice(0, MAX_PIN_LENGTH) + '5')).toBe('long');
  });

  it('refuses the PINs an attacker tries first', () => {
    expect(pinProblem('0000')).toBe('trivial');
    expect(pinProblem('1111')).toBe('trivial');
    expect(pinProblem('1234')).toBe('trivial');
    expect(pinProblem('4321')).toBe('trivial');
    expect(pinProblem('456789')).toBe('trivial');
  });

  it('every problem has copy that says what to do', () => {
    for (const p of ['nondigit', 'short', 'long', 'trivial'] as const) {
      const copy = pinProblemCopy(p);
      expect(copy.length).toBeGreaterThan(10);
      expect(copy).not.toMatch(/error|invalid|failed/i);
    }
  });
});

describe('deriving the verifier', () => {
  it('mints a 32-byte salt as valid base64', async () => {
    const salt = await newSalt();
    // 32 bytes -> 44 base64 chars with one '=' of padding.
    expect(salt).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('sends the derived verifier, never the PIN', async () => {
    const { salt, verifier } = await buildLock('4817');
    expect(crypto.pinVerifier).toHaveBeenCalledWith('4817', salt);
    expect(verifier).not.toContain('4817');
  });

  it('a different salt gives a different verifier for the same PIN', async () => {
    const a = await deriveVerifier('4817', 'c2FsdC1vbmU=');
    const b = await deriveVerifier('4817', 'c2FsdC10d28=');
    expect(a).not.toBe(b);
  });

  it('refuses to derive from a PIN this app would not let you set', async () => {
    // Otherwise a caller could set a lock the UI could never reproduce.
    await expect(deriveVerifier('1234', 'c2FsdA==')).rejects.toBeInstanceOf(InvalidPin);
    expect(crypto.pinVerifier).not.toHaveBeenCalled();
  });

  it('a native failure surfaces as LockDeriveFailed, not a raw native error', async () => {
    crypto.pinVerifier.mockRejectedValueOnce(new Error('bad salt'));
    await expect(deriveVerifier('4817', 'c2FsdA==')).rejects.toBeInstanceOf(
      LockDeriveFailed,
    );
  });
});

describe('nothing here reaches the network', () => {
  it('derives without a session, a token, or a route to call', async () => {
    // The point of keeping this module: a backup key has to be derivable on a
    // device that cannot reach anything. Nothing below is
    // set up — no auth token in the Keychain, no api mock in this file — and
    // it still works, which is the property, not a convenience.
    expect(crypto.__keychain.size).toBe(0);
    const { salt, verifier } = await buildLock('4817');
    expect(verifier.length).toBeGreaterThan(0);
    expect(await deriveVerifier('4817', salt)).toBe(verifier);
  });
});
