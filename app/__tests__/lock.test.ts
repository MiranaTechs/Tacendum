/**
 * The lock program's verify: verdict table, palindrome/length rejection,
 * cooldown schedule + persistence, duress-session mutation no-ops.
 */
import * as lock from '../src/lock';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
  jest.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('validateCode', () => {
  test('rejects non-digits, too short, too long', () => {
    expect(lock.validateCode('12ab56')).not.toBeNull();
    expect(lock.validateCode('123')).not.toBeNull();
    expect(lock.validateCode('12345678901')).not.toBeNull();
  });

  test('rejects palindromes, including all-same-digit codes', () => {
    expect(lock.validateCode('123321')).not.toBeNull();
    expect(lock.validateCode('7777')).not.toBeNull();
    expect(lock.validateCode('1221')).not.toBeNull();
  });

  test('accepts a normal 6-digit code', () => {
    expect(lock.validateCode('123456')).toBeNull();
  });
});

describe('setup / status / disable', () => {
  test('setup enables the lock and stores the code in the Keychain only', async () => {
    await lock.setup('123456');
    expect((await lock.status()).enabled).toBe(true);
    expect(keychain.get('lock.passcode')).toBe('123456');
  });

  test('setup rejects an invalid code', async () => {
    await expect(lock.setup('1221')).rejects.toThrow();
    expect((await lock.status()).enabled).toBe(false);
  });

  test('disable clears every lock key', async () => {
    await lock.setup('123456');
    await lock.setAutolock(300);
    await lock.disable();
    expect((await lock.status()).enabled).toBe(false);
    for (const key of keychain.keys()) {
      expect(key.startsWith('lock.')).toBe(false);
    }
  });

  test('autolock defaults to immediately and persists a chosen value', async () => {
    await lock.setup('123456');
    expect((await lock.status()).autolockSec).toBe(0);
    await lock.setAutolock(60);
    expect((await lock.status()).autolockSec).toBe(60);
  });
});

describe('verify', () => {
  beforeEach(async () => {
    await lock.setup('123456');
  });

  test('the stored code unlocks real', async () => {
    expect(await lock.verify('123456')).toEqual({ verdict: 'real' });
  });

  test('the reversed code unlocks duress', async () => {
    expect(await lock.verify('654321')).toEqual({ verdict: 'duress' });
  });

  test('a wrong code fails with attempts remaining', async () => {
    expect(await lock.verify('999999')).toEqual({
      verdict: 'fail',
      attemptsLeft: 4,
    });
  });

  test('the fifth consecutive failure starts a 30 s cooldown', async () => {
    for (let i = 0; i < 4; i++) await lock.verify('999999');
    expect(await lock.verify('999999')).toEqual({
      verdict: 'cooldown',
      retryInMs: 30_000,
    });
  });

  test('during cooldown even the correct code is refused', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    const result = await lock.verify('123456');
    expect(result.verdict).toBe('cooldown');
  });

  test('after the cooldown expires the next failure doubles it', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    jest.advanceTimersByTime(30_001);
    expect(await lock.verify('999999')).toEqual({
      verdict: 'cooldown',
      retryInMs: 60_000,
    });
  });

  test('cooldown caps at 15 minutes', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(15 * 60_000 + 1);
      await lock.verify('999999');
    }
    jest.advanceTimersByTime(15 * 60_000 + 1);
    const result = await lock.verify('999999');
    expect(result).toEqual({ verdict: 'cooldown', retryInMs: 900_000 });
  });

  test('cooldown state lives in the Keychain, so a relaunch cannot reset it', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    // Everything a relaunch must remember is in the Keychain. (The one
    // module-level variable, the monotonic cooldown shadow,
    // only ever ADDS hold and is bound to the Keychain deadline it shadows —
    // losing it loses nothing a relaunch needs.)
    expect(keychain.get('lock.failCount')).toBe('5');
    expect(Number(keychain.get('lock.lockedUntil'))).toBeGreaterThan(
      Date.now(),
    );
  });

  test('a forward wall-clock jump does not end an in-process cooldown early', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    // The wall clock leaps a minute ahead while NO time passes — a network
    // time correction, a manual change — so `lockedUntil > Date.now()` is
    // false. The monotonic clock has not moved, and the cooldown holds.
    jest.setSystemTime(1_700_000_000_000 + 60_000);
    expect((await lock.verify('123456')).verdict).toBe('cooldown');
    expect(await lock.cooldownRemainingMs()).toBe(30_000);
    // Real time passes (both clocks, in lock-step): the cooldown ends on
    // schedule, and the correct code opens.
    jest.advanceTimersByTime(30_000);
    expect(await lock.cooldownRemainingMs()).toBe(0);
    expect((await lock.verify('123456')).verdict).toBe('real');
  });

  test('a backward wall-clock jump keeps the cooldown (fail closed)', async () => {
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    jest.setSystemTime(1_700_000_000_000 - 60_000);
    expect((await lock.verify('123456')).verdict).toBe('cooldown');
    expect(await lock.cooldownRemainingMs()).toBeGreaterThanOrEqual(30_000);
  });

  test('a real unlock resets the failure count', async () => {
    for (let i = 0; i < 4; i++) await lock.verify('999999');
    await lock.verify('123456');
    expect(await lock.verify('999999')).toEqual({
      verdict: 'fail',
      attemptsLeft: 4,
    });
  });

  test('a duress unlock resets the failure count identically (rule 16)', async () => {
    for (let i = 0; i < 4; i++) await lock.verify('999999');
    await lock.verify('654321');
    expect(await lock.verify('999999')).toEqual({
      verdict: 'fail',
      attemptsLeft: 4,
    });
  });
});

describe('cooldownRemainingMs', () => {
  test('reports the active cooldown without consuming an attempt', async () => {
    await lock.setup('123456');
    expect(await lock.cooldownRemainingMs()).toBe(0);
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    expect(await lock.cooldownRemainingMs()).toBe(30_000);
    jest.advanceTimersByTime(10_000);
    expect(await lock.cooldownRemainingMs()).toBe(20_000);
    jest.advanceTimersByTime(30_000);
    expect(await lock.cooldownRemainingMs()).toBe(0);
  });
});

describe('duress-session no-ops', () => {
  test('setup, change, autolock, and disable silently change nothing', async () => {
    await lock.setup('123456');
    session.setMode('duress');

    await lock.setup('987654');
    expect(keychain.get('lock.passcode')).toBe('123456');

    await lock.setAutolock(300);
    expect((await lock.status()).autolockSec).toBe(0);

    await lock.disable();
    expect((await lock.status()).enabled).toBe(true);

    session.setMode('real');
    expect(await lock.verify('123456')).toEqual({ verdict: 'real' });
  });
});
