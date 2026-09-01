/**
 * The vault's pure half: the mask, the refusal wording, and the pasteboard
 * expiry. Kept apart from the screen test for the reason blocking.test.ts is —
 * a copy deck and a rule about a credential should be provable without
 * rendering anything.
 *
 * The two properties here that are security properties rather than taste:
 *
 *  1. THE MASK IS A FIXED WIDTH. One bullet per character is the obvious
 *     implementation and it publishes the length of every credential in the
 *     Room to anyone who glances at the screen — which is the exact audience
 *     the masking exists for. A four-digit door code and a 3,000-character
 *     SSH key have to look identical.
 *  2. A REFUSAL NEVER CARRIES THE VALUE. `VaultItemRefusedError` is careful
 *     about this (it holds `field`, `reason` and `limit` and nothing else)
 *     and it would be undone by a deck that helpfully quoted what was typed.
 */
import { Clipboard } from 'react-native';
import { VAULT_BODY_MAX, VAULT_TITLE_MAX } from '../src/envelope';
import {
  PASTEBOARD_TTL_MS,
  cancelPasteboardExpiry,
  copyWithExpiry,
} from '../src/pasteboard';
import {
  MASKED_VALUE,
  VAULT,
  VAULT_CONSEQUENCE,
  VAULT_LIMITS,
  vaultRefusal,
  vaultStatusTone,
} from '../src/vault';

describe('the mask', () => {
  test('is the same width whatever it is hiding', () => {
    // A PIN, a passphrase, and something the size of a WireGuard config.
    for (const secret of ['1234', 'correct horse battery staple', 'k'.repeat(4096)]) {
      expect(MASKED_VALUE.length).toBe(8);
      // The claim in full: nothing about the mask is a function of the secret.
      expect(MASKED_VALUE).not.toContain(secret);
      expect(MASKED_VALUE.length).not.toBe(secret.length);
    }
  });

  test('the spoken stand-in says there is a value, not what it is', () => {
    expect(VAULT.hidden).toBe('Value hidden');
    // Whatever it grows into, it can never interpolate anything.
    expect(typeof VAULT.hidden).toBe('string');
  });
});

describe('a refusal names the field it came from', () => {
  test('every field and reason has its own sentence, and they are distinct', () => {
    const seen = new Set<string>();
    for (const field of ['title', 'body'] as const) {
      for (const reason of ['empty', 'too-long', 'envelope'] as const) {
        const limit = field === 'title' ? VAULT_TITLE_MAX : VAULT_BODY_MAX;
        const message = vaultRefusal(field, reason, limit);
        expect(message.length).toBeGreaterThan(0);
        // Six distinct sentences: a shared one would tell somebody staring at
        // two boxes nothing about which of them to fix.
        expect(seen.has(message)).toBe(false);
        seen.add(message);
      }
    }
    expect(seen.size).toBe(6);
  });

  test('a length refusal states the limit it broke', () => {
    expect(vaultRefusal('title', 'too-long', VAULT_TITLE_MAX)).toContain('80');
    expect(vaultRefusal('body', 'too-long', VAULT_BODY_MAX)).toContain('8192');
  });

  test('a refusal never repeats the value — it is a credential', () => {
    // The error type carries a limit and never the string, deliberately; this
    // is the half of that promise the deck is responsible for keeping.
    const secret = 'hunter2-the-actual-door-code';
    for (const field of ['title', 'body'] as const) {
      for (const reason of ['empty', 'too-long', 'envelope'] as const) {
        expect(vaultRefusal(field, reason, 80)).not.toContain(secret);
      }
    }
    // `vaultRefusal` has no parameter that could carry one.
    expect(vaultRefusal.length).toBe(3);
  });
});

describe('what the section says about itself', () => {
  test('the count reads as a count, and empty invites rather than apologises', () => {
    expect(VAULT.status(0)).toBe('Nothing here yet');
    expect(VAULT.status(1)).toBe('1 item');
    expect(VAULT.status(4)).toBe('4 items');
    // The empty state names the thing the feature is for, in the words people
    // use for it, and offers the first step.
    expect(VAULT.invite).toContain('Wi-Fi password');
    expect(VAULT.addFirst).toBe('Add the first item');
    for (const sorry of ['No items', 'is empty', 'Sorry', 'nothing to show']) {
      expect(VAULT.invite).not.toContain(sorry);
    }
  });

  test('the retention increase is on the screen, not implied', () => {
    const open = VAULT_CONSEQUENCE.join(' ');
    const behind = VAULT_LIMITS.join(' ');

    // The retention INCREASE, and the pasteboard, are consequences: they stay
    // in the open, above the controls.
    expect(open).toContain('kept until one of you removes it');
    expect(open).toContain('disappear on a timer');
    expect(open).toContain('pasteboard');
    // "every app on this iPhone" — the noun rides the device token
    // (jest's default Platform is iOS-phone), naming the device it really is.
    expect(open).toContain('every app on this iPhone');

    // The rest is "what this is", behind the affordance.
    expect(behind).toContain('not a stronger lock');
    expect(behind).toContain('not a password manager');
    expect(behind).toContain('there is no recovery key');
    expect(behind).toContain('either of you can keep');
    expect(behind).toContain('photograph the screen');
    // V3's answer to the fourth deferred decision: the announcement row keeps
    // the envelope, so the vault says so rather than quietly blanking it.
    expect(behind).toContain('still carries the value inside it');

    // Nothing here oversells.
    for (const line of [...VAULT_CONSEQUENCE, ...VAULT_LIMITS]) {
      expect(line).not.toMatch(/\bsecure\b/i);
      expect(line).not.toMatch(/\bmilitary\b/i);
      expect(line).not.toMatch(/\bunbreakable\b/i);
    }
  });

  test('the tone never reaches for red — a saved item is not an alarm', () => {
    for (const count of [0, 1, 9]) {
      const tone = vaultStatusTone(count);
      expect(tone.rule).not.toMatch(/danger/);
      expect(tone.ink).not.toMatch(/danger/);
    }
    expect(vaultStatusTone(0)).toEqual({ rule: 'lineStrong', ink: 'inkMuted' });
    expect(vaultStatusTone(2)).toEqual({
      rule: 'warningMark',
      ink: 'warningInk',
    });
  });
});

describe('the pasteboard expiry', () => {
  const SECRET = 'the-actual-wifi-password';
  let setString: jest.SpyInstance;
  let getString: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    setString = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    getString = jest
      .spyOn(Clipboard, 'getString')
      .mockResolvedValue(SECRET) as jest.SpyInstance;
    // `spyOn` over an already-spied method hands back the existing mock with
    // its call log intact, so the counts below have to start from a clean one.
    setString.mockClear();
    getString.mockClear();
  });

  afterEach(() => {
    cancelPasteboardExpiry();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('the value goes on, and comes back off a minute later', async () => {
    copyWithExpiry(SECRET);
    expect(setString).toHaveBeenCalledWith(SECRET);

    // Still there a second before the deadline: the point is to be pasteable.
    jest.advanceTimersByTime(PASTEBOARD_TTL_MS - 1000);
    await Promise.resolve();
    expect(setString).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(setString).toHaveBeenLastCalledWith('');
  });

  test('it does not wipe something the person copied since', async () => {
    copyWithExpiry(SECRET);
    // They went to another app and copied an address while they were there.
    getString.mockResolvedValue('221B Baker Street');

    jest.advanceTimersByTime(PASTEBOARD_TTL_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one call — the original copy. Nothing was cleared.
    expect(setString).toHaveBeenCalledTimes(1);
    expect(setString).toHaveBeenLastCalledWith(SECRET);
  });

  test('a read it is not allowed to make clears nothing', async () => {
    copyWithExpiry(SECRET);
    // iOS 16+ can refuse a cross-app pasteboard read. Failing closed on
    // somebody else's clipboard is the right side to fail on.
    getString.mockRejectedValue(new Error('paste refused'));

    jest.advanceTimersByTime(PASTEBOARD_TTL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(setString).toHaveBeenCalledTimes(1);
  });

  test('a copy made while the read is in flight is not wiped by it', async () => {
    // The read-back crosses the bridge, so it takes time, and the answer it
    // brings back describes the pasteboard as it was when it was asked. Copy
    // something in that window and a naive implementation clears the NEW value
    // on the strength of the OLD answer — the exact failure the read-back
    // exists to prevent, arriving through its own window.
    copyWithExpiry(SECRET);
    jest.advanceTimersByTime(PASTEBOARD_TTL_MS); // the read is now in flight
    copyWithExpiry('221B Baker Street'); // …and this owns the pasteboard now

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(setString).toHaveBeenLastCalledWith('221B Baker Street');
  });

  test('a second copy replaces the first one’s timer rather than stacking', async () => {
    copyWithExpiry('first');
    jest.advanceTimersByTime(PASTEBOARD_TTL_MS / 2);
    copyWithExpiry(SECRET);

    // The first timer would have fired here if it were still armed, and it
    // would have cleared the SECOND value out from under the person.
    jest.advanceTimersByTime(PASTEBOARD_TTL_MS / 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(setString).toHaveBeenLastCalledWith(SECRET);

    jest.advanceTimersByTime(PASTEBOARD_TTL_MS / 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(setString).toHaveBeenLastCalledWith('');
  });
});
