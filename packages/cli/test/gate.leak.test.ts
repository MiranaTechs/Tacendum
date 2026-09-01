import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRecipient } from '../src/profile.js';
import { CliError, EXIT } from '../src/exit.js';

/**
 * The recipient-echo leak, reopened for a third time.
 *
 * `tacendum send ci "$SECRET"` with one missing argument shifts the secret
 * into the recipient position, and resolveRecipient's error reaches stderr
 * and --json, i.e. CI and Claude Code hook logs. Two successive fixes kept a
 * conditional echo behind a shape allowlist, and both leaked: "legal client
 * name" admits an AWS access key id verbatim, and the looks-shortened branch
 * printed any quoted sentence containing "..." in full.
 *
 * The fix under test deletes the echo outright, so the assertion here is
 * deliberately stronger than "does not contain this secret": the message must
 * be drawn from a FIXED set of constant strings that carry no dependence on
 * the input beyond which advice sentence applies. Any future "surely THIS
 * shape is safe to show" regression fails the fixed-set check even for a
 * secret this file never thought of.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-leak-'));
  process.env.TACENDUM_HOME = home;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function messageFor(peer: string): { msg: string; code: number } {
  try {
    resolveRecipient(peer);
  } catch (err) {
    const e = err as CliError;
    return { msg: e.message, code: e.exitCode };
  }
  throw new Error('expected resolveRecipient to refuse');
}

// Every string an unrecognised recipient is allowed to produce. Recomputing
// the expected text here (instead of importing it) would go vacuous if the
// source ever interpolated the peer back in — so these are literals.
const NOT_AN_ID =
  'cannot address that recipient: it is not a 26-character user id, and there is ' +
  'no local client of that name. Get the full id from the recipient\'s my-code ' +
  'screen in the app and pass it as the recipient.';
const SHORTENED =
  'that recipient looks like a SHORTENED id — it has to be pasted in full ' +
  '(26 characters). Get the full id from the recipient\'s my-code screen in the ' +
  'app and pass it as the recipient.';

describe('an unrecognised recipient is never echoed, whatever its shape', () => {
  // Each entry names the allowlist branch that used to leak it.
  const secrets: Array<[string, string]> = [
    // Address-shaped: passed the legal-client-name regex, printed verbatim.
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    // Address-shaped and short: base32-ish, could be an OTP seed.
    ['short base32 secret', 'JBSWY3DPEHPK3PXP'],
    // The looks-shortened branch: any "..." printed the WHOLE string.
    ['sentence with an ellipsis', 'top secret...hunter2'],
    ['unicode-ellipsis sentence', 'the launch code is…hunter2'],
    // Too long for a name, but earlier fixes special-cased length too.
    ['hex token', 'deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInNlY3JldCI6Imh1bnRlcjIifQ.c2lnbmF0dXJl',
    ],
    ['sk-live api key', 'sk-live-9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c'],
    ['spaced sentence', 'the wifi password is hunter2'],
  ];

  for (const [label, secret] of secrets) {
    it(`refuses a ${label} with a constant message`, () => {
      const { msg, code } = messageFor(secret);
      expect(code).toBe(EXIT.RECIPIENT);
      // The strong form: the message is one of the two constants, so it
      // cannot contain the secret — or anything else derived from it.
      expect([NOT_AN_ID, SHORTENED]).toContain(msg);
      // And the direct form, so a failure names the actual leak.
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain(secret.slice(0, 8));
      expect(msg).not.toContain('hunter2');
    });
  }

  it('does not even echo a plausible-but-unregistered client name', () => {
    // The previous fix defended this echo as "the useful case". It is the
    // exact regex that admitted the AWS key id above — the two are the SAME
    // string shape, so either both are shown or neither is. Neither is.
    const { msg } = messageFor('ci-bot');
    expect([NOT_AN_ID, SHORTENED]).toContain(msg);
    expect(msg).not.toContain('ci-bot');
  });

  it('keeps the shortened-id advice, without the echo', () => {
    const { msg } = messageFor('01K9RZ…');
    expect(msg).toBe(SHORTENED);
    expect(msg).not.toContain('01K9RZ');
  });
});

describe('the two real address forms still resolve (the refusal is not overbroad)', () => {
  it('a bare user id, with nothing on disk', () => {
    expect(resolveRecipient('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('an existing local client name', () => {
    mkdirSync(join(home, 'bob'), { recursive: true });
    writeFileSync(
      join(home, 'bob', 'profile.json'),
      JSON.stringify({
        name: 'bob',
        identityKey: '',
        userId: '01BOBBOBBOBBOBBOBBOBBOBBOB',
        authToken: 'x',
        registrationId: 1,
        deviceId: 1,
      }),
    );
    expect(resolveRecipient('bob')).toBe('01BOBBOBBOBBOBBOBBOBBOBBOB');
  });
});
