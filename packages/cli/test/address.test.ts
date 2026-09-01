import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-address-'));
process.env.TACENDUM_HOME = home;

const { isUserId, resolveRecipient } = await import('../src/profile.js');
const { EXIT } = await import('../src/exit.js');

const APP_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function stubProfile(name: string, userId: string): void {
  mkdirSync(join(home, name), { recursive: true });
  writeFileSync(
    join(home, name, 'profile.json'),
    JSON.stringify({ name, identityKey: '', userId, authToken: 'x', registrationId: 1, deviceId: 1 }),
  );
}

/**
 * The point of the feature is that an integration is handed a
 * 26-character code out of the app and has nothing local about the person it
 * is notifying.
 */
describe('recipient addressing', () => {
  it('accepts a bare user id with nothing on disk about the recipient', () => {
    expect(isUserId(APP_ID)).toBe(true);
    expect(resolveRecipient(APP_ID)).toBe(APP_ID);
  });

  it('still resolves a local client name', () => {
    stubProfile('bob', '01BOBBOBBOBBOBBOBBOBBOBBOB');
    expect(resolveRecipient('bob')).toBe('01BOBBOBBOBBOBBOBBOBBOBBOB');
  });

  it('rejects the ULID alphabet holes and the wrong length', () => {
    // Crockford base32 drops I, L, O and U — in BOTH cases.
    expect(isUserId('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    expect(isUserId('01arz3ndektsv4rrffq69g5fai')).toBe(false);
    expect(isUserId(APP_ID.slice(0, 25))).toBe(false);
    expect(isUserId(`${APP_ID}X`)).toBe(false);
  });

  it('accepts a lower-cased id — Crockford base32 is case-insensitive', () => {
    // This assertion used to be `toBe(false)`, on the reasoning that case was
    // the one thing separating the id space from the client-name space. It
    // cost a real user a confusing error: an id that has been
    // through a URL, a linkifier or an agent that tidies text arrives
    // lower-cased, fell out of the id space, and was reported as "no local
    // client of that name" — for an id they had copied correctly. Widening
    // the id side is the safe direction: the id path reads nothing off this
    // disk, while the name path reads the peer's whole profile.
    expect(isUserId('01arz3ndektsv4rrffq69g5fav')).toBe(true);
  });

  it('does not tell a caller to register an account named after the recipient', () => {
    // The old failure: a ULID passes the client-name regex, so `send ci-bot
    // 01ARZ...` reported `no profile for "01ARZ..." — run: cli register
    // 01ARZ...`, which is advice that mints a SECOND ACCOUNT.
    const err = (() => {
      try {
        resolveRecipient('nobody-here');
        return null;
      } catch (e) {
        return e as Error & { exitCode?: number };
      }
    })();
    expect(err?.exitCode).toBe(EXIT.RECIPIENT);
    expect(err?.message).toContain('not a 26-character user id');
  });

  it('reports an unaddressable string as a recipient problem, not a crash', () => {
    const err = (() => {
      try {
        resolveRecipient('not a legal name!');
        return null;
      } catch (e) {
        return e as Error & { exitCode?: number };
      }
    })();
    expect(err?.exitCode).toBe(EXIT.RECIPIENT);
  });
});
