/**
 * The lock core under an ANDROID Platform, against the D9 secret store's real
 * contract (AD-2, 2026-09-03).
 *
 * `app/src/lock.ts` carries no Platform branch — the passcode core is shared
 * JS that runs unmodified on both stores — so what needed coverage was never
 * a second code path. It was the STORE. Every existing lock test runs against
 * the global jest.setup mock, a plain Map that can neither be absent-as-empty
 * nor fail, and the Android backing store
 * (`app/modules/tacendum-crypto/android/.../crypto/SecretStore.kt`, D9) has
 * two shapes that Map cannot express and that nothing in JS pinned:
 *
 *   - an absent key answers the empty string across the bridge, which the
 *     facade maps to null (`tacendum-crypto/src/index.ts` getSecret); and
 *   - a key that is PRESENT but cannot be decrypted THROWS. It must never
 *     read as absent, because "absent" is how the lock spells "off".
 *
 * So the store below is the mock, the Platform is Android, and the assertions
 * are the parity claim: identical verdicts, identical cooldown persistence,
 * identical duress no-ops. The Android parity row for the lock carried no
 * automated evidence before this file existed.
 *
 * Rule 4: no passcode reaches an error or a log here, including the
 * simulated store failures, which carry the same opaque text the native
 * stores throw.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

/**
 * Module-scoped so it SURVIVES `jest.resetModules()` — that is the whole
 * mechanism of the relaunch test below: the JS module registry is thrown away
 * (taking the in-process cooldown shadow with it) while the Keystore-backed
 * store persists, which is exactly what a relaunch does on a device.
 * `mock`-prefixed because jest hoists the factory above this declaration.
 */
const mockStore = new Map<string, string>();
/** Keys the store will refuse to read / delete, modelling SecretStore.kt's
 * two throwing paths (a present-but-undecryptable file; a failed unlink). */
const mockUnreadable = new Set<string>();
const mockUndeletable = new Set<string>();
/**
 * Write attempts, module-scoped for the same reason as `mockStore`: the
 * jest.fn()s in the factory do NOT survive `jest.resetModules()` (jest-runtime
 * clears `_mockRegistry`/`_moduleMockRegistry`, so `jest.requireMock` inside a
 * test hands back a FRESH set of spies, not the ones the top-level
 * `import * as lock` closed over) — a `not.toHaveBeenCalled()` on them is
 * unfalsifiable in this file. This ledger is the store's own, so it records
 * what the store was actually asked to do. Rule 4: the verb only, never the
 * key and never the value.
 */
const mockWrites: string[] = [];

jest.mock('tacendum-crypto', () => ({
  __esModule: true,
  getSecret: jest.fn(async (key: string) => {
    if (mockUnreadable.has(key)) {
      // SecretStore.kt: a present-but-unreadable secret throws. Reading it as
      // absent would answer "no lock" for a lock that exists.
      throw new Error('secret read failed');
    }
    // The native half answers '' for an absent key; the facade's own mapping
    // (tacendum-crypto/src/index.ts getSecret, `value === '' ? null : value`)
    // is reproduced here rather than assumed away.
    const native = mockStore.get(key) ?? '';
    return native === '' ? null : native;
  }),
  setSecret: jest.fn(async (key: string, value: string) => {
    mockWrites.push('set');
    mockStore.set(key, value);
  }),
  deleteSecret: jest.fn(async (key: string) => {
    mockWrites.push('delete');
    if (mockUndeletable.has(key)) throw new Error('secret delete failed');
    mockStore.delete(key);
  }),
}));

import { Platform } from 'react-native';
import * as lock from '../src/lock';
import { session } from '../src/session';

type LockModule = typeof import('../src/lock');

/**
 * A relaunch: the module registry dies, the Keystore does not. Everything the
 * lock keeps in module scope — the monotonic cooldown shadow above all — goes
 * with it, so whatever still holds afterwards held because it was in the
 * store. A fresh registry also means a fresh `session`, which starts in
 * 'real' by construction, exactly as a launched process does.
 */
function relaunch(): LockModule {
  jest.resetModules();
  return jest.requireActual<LockModule>('../src/lock');
}

beforeEach(() => {
  mockStore.clear();
  mockUnreadable.clear();
  mockUndeletable.clear();
  mockWrites.length = 0;
  session.setMode('real');
  jest.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
});

test('the suite really is running under an Android Platform', () => {
  // Guards the rest of the file against a preset change silently returning it
  // to the iOS-shaped default, which is how an Android suite goes vacuous.
  expect(Platform.OS).toBe('android');
});

describe('the D9 absent-key shape', () => {
  test("an absent key arrives as '' and reads as off, not as a corrupt value", async () => {
    // Nothing was ever written: every read goes down the ''-to-null path.
    expect(await lock.status()).toEqual({ enabled: false, autolockSec: 0 });
    expect(await lock.cooldownRemainingMs()).toBe(0);
    expect(mockStore.size).toBe(0);
  });

  test("an autolock of '' does not become NaN seconds", async () => {
    await lock.setup('123456');
    // `Number(null ?? '0')` is 0; `Number('')` is also 0, but only one of
    // those is what the bridge actually sends. Pin the answer, not the route.
    expect((await lock.status()).autolockSec).toBe(0);
    await lock.setAutolock(300);
    expect((await lock.status()).autolockSec).toBe(300);
  });
});

describe('the D9 unreadable-key shape (fail closed)', () => {
  test('status PROPAGATES an unreadable lock flag instead of answering "off"', async () => {
    await lock.setup('123456');
    mockUnreadable.add('lock.enabled');
    // App.tsx's boot arm and its foreground arm both branch on this status.
    // Answering `{enabled:false}` for a store that cannot be read would open
    // the real workspace on a device whose lock is intact — the A10 finding.
    await expect(lock.status()).rejects.toThrow();
  });

  test('verify PROPAGATES an unreadable passcode rather than opening real', async () => {
    await lock.setup('123456');
    mockUnreadable.add('lock.passcode');
    // The never-brick-the-user branch answers `{verdict:'real'}` when the code
    // is ABSENT. An unreadable code is not an absent one, and the store's
    // throw is what keeps those two apart.
    await expect(lock.verify('000000')).rejects.toThrow();
  });

  test('an unreadable cooldown deadline refuses the attempt rather than granting it', async () => {
    await lock.setup('123456');
    mockUnreadable.add('lock.lockedUntil');
    await expect(lock.verify('123456')).rejects.toThrow();
    await expect(lock.cooldownRemainingMs()).rejects.toThrow();
  });
});

describe('cooldown persistence across a relaunch', () => {
  test('the deadline is in the store, so a relaunch resumes it and still refuses the CORRECT code', async () => {
    await lock.setup('123456');
    for (let i = 0; i < 5; i++) await lock.verify('999999');
    expect(await lock.cooldownRemainingMs()).toBe(30_000);

    // 10 s of the 30 s elapse, then the process dies and comes back.
    jest.advanceTimersByTime(10_000);
    const relaunched = relaunch();

    // Nothing in memory survived; `lock.lockedUntil` in the store is the only
    // reason the hold continues. This is the round trip AND-LCK-001 names.
    expect(await relaunched.cooldownRemainingMs()).toBe(20_000);
    expect((await relaunched.verify('123456')).verdict).toBe('cooldown');

    // And it ends on schedule rather than being extended by the relaunch.
    jest.advanceTimersByTime(20_000);
    expect(await relaunched.cooldownRemainingMs()).toBe(0);
    expect(await relaunched.verify('123456')).toEqual({ verdict: 'real' });
  });

  test('the failure count survives too, so a relaunch cannot buy fresh attempts', async () => {
    await lock.setup('123456');
    for (let i = 0; i < 4; i++) await lock.verify('999999');

    const relaunched = relaunch();
    // Five, not ten: the fifth failure overall starts the cooldown.
    expect((await relaunched.verify('999999')).verdict).toBe('cooldown');
  });

  test('the lock itself survives a relaunch — no Android heal wipes it (D10)', async () => {
    await lock.setup('123456');
    const relaunched = relaunch();
    expect((await relaunched.status()).enabled).toBe(true);
    expect(await relaunched.verify('123456')).toEqual({ verdict: 'real' });
    expect(await relaunched.verify('654321')).toEqual({ verdict: 'duress' });
  });
});

describe('duress-session no-ops on Android (rule 16 / §5.1)', () => {
  test('setup, autolock and disable write NOTHING, and the writes are never even attempted', async () => {
    await lock.setup('123456');
    await lock.setAutolock(60);
    session.setMode('duress');
    // The store's own ledger, not the factory's jest.fn()s: see `mockWrites`.
    mockWrites.length = 0;

    await expect(lock.setup('987654')).resolves.toBeUndefined();
    await expect(lock.setAutolock(300)).resolves.toBeUndefined();
    await expect(lock.disable()).resolves.toBeUndefined();

    // Every one of them RESOLVES — a coerced change must appear to work — and
    // not one of them touched the store.
    expect(mockWrites).toEqual([]);
    expect(mockStore.get('lock.passcode')).toBe('123456');
    expect(mockStore.get('lock.enabled')).toBe('1');
    expect(mockStore.get('lock.autolockSec')).toBe('60');
  });

  test('and the real lock is intact after the coerced session, across a relaunch', async () => {
    await lock.setup('123456');
    session.setMode('duress');
    await lock.setup('987654');
    await lock.disable();

    const relaunched = relaunch();
    expect((await relaunched.status()).enabled).toBe(true);
    expect(await relaunched.verify('123456')).toEqual({ verdict: 'real' });
    expect(await relaunched.verify('654321')).toEqual({ verdict: 'duress' });
    expect((await relaunched.verify('987654')).verdict).toBe('fail');
  });
});

describe('clearAll against a store that refuses a delete (AD-1, on Android)', () => {
  test('a refused passcode delete still leaves the lock OFF', async () => {
    await lock.setup('123456');
    // SecretStore.kt throws `secret delete failed` on a failed unlink; the
    // half-state that used to follow — `lock.enabled` over no code — is
    // answered `{verdict:'real'}` for any input at all.
    mockUndeletable.add('lock.passcode');

    await expect(lock.disable()).resolves.toBeUndefined();
    expect(mockStore.has('lock.enabled')).toBe(false);

    const relaunched = relaunch();
    expect((await relaunched.status()).enabled).toBe(false);
  });

  test('a refused lock.enabled delete leaves the lock fully working', async () => {
    await lock.setup('123456');
    mockUndeletable.add('lock.enabled');

    await expect(lock.disable()).rejects.toThrow();

    const relaunched = relaunch();
    expect((await relaunched.status()).enabled).toBe(true);
    expect(await relaunched.verify('123456')).toEqual({ verdict: 'real' });
    expect(await relaunched.verify('654321')).toEqual({ verdict: 'duress' });
  });
});
