import { pinVerifier, randomBytes } from 'tacendum-crypto';

/**
 * PIN derivation: turn a PIN a person can remember into a verifier, without
 * the PIN itself ever leaving this device.
 *
 * WHAT THIS USED TO BE, and why only half of it survives. This was the client
 * half of registration lock — a PIN that
 * stopped an SMS code alone from taking over the account. There is no SMS code
 * to defend against any more (the identity keypair
 * IS the account, and taking it over means stealing a private key out of the
 * Keychain), so the parts that talked to `/v1/registration-lock`, and the
 * device-side flag, the lapse date and the attempts copy that only ever
 * described that server behaviour, are gone with it.
 *
 * WHAT STAYS, deliberately (cost table row 1): the
 * Argon2 derivation and the PIN policy around it. Losing this device now loses
 * the identity, which makes encrypted backups (a reserved future feature) load-bearing
 * rather than optional — and a backup needs exactly this: a slow hash from a
 * memorable PIN to a key. Kept rather than deleted-and-rewritten because it is
 * shipped, tested code, and because the slowness below is the whole security
 * argument and is easy to lose in a rewrite.
 *
 * Policy lives here and stays free of react-native imports so it is testable
 * with the native module mocked — the same split as `safety.ts` and `qr.ts`.
 */

/** Salt length libsignal's PinHash requires, in bytes. */
export const SALT_BYTES = 32;

/**
 * Four is the floor because that is what a person will actually set and
 * remember, and the online attempt cap — not the digit count — is what stops
 * guessing. Ten is a ceiling on typing, not on security.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 10;

export class InvalidPin extends Error {}
export class LockDeriveFailed extends Error {}

/**
 * Why a PIN was refused, or null when it is fine. Digits only: the field is
 * numeric on iOS, and silently accepting a letter someone typed on a hardware
 * keyboard would produce a PIN they cannot re-enter on the number pad.
 */
export type PinProblem = 'short' | 'long' | 'nondigit' | 'trivial';

export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d*$/.test(pin)) return 'nondigit';
  if (pin.length < MIN_PIN_LENGTH) return 'short';
  if (pin.length > MAX_PIN_LENGTH) return 'long';
  // A PIN that is one repeated digit, or a straight run, is the first thing
  // anyone guesses and costs the same to type as one that is not.
  if (/^(\d)\1*$/.test(pin)) return 'trivial';
  const ascending = pin.split('').every((d, i, all) => i === 0 || +d === +all[i - 1]! + 1);
  const descending = pin.split('').every((d, i, all) => i === 0 || +d === +all[i - 1]! - 1);
  if (ascending || descending) return 'trivial';
  return null;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without depending on a global: Hermes has btoa, but this module is
 * unit-tested outside the RN runtime and a polyfill gap would only show up on
 * the one path that matters. 32 bytes divides evenly, so no padding branch. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]!;
    out += b === undefined ? '=' : B64_ALPHABET[(n >> 6) & 63]!;
    out += c === undefined ? '=' : B64_ALPHABET[n & 63]!;
  }
  return out;
}

/** What to tell someone whose PIN was refused, in the house voice. */
export function pinProblemCopy(problem: PinProblem): string {
  switch (problem) {
    case 'nondigit':
      return 'An Account PIN is digits only.';
    case 'short':
      return `Use at least ${MIN_PIN_LENGTH} digits.`;
    case 'long':
      return `Use at most ${MAX_PIN_LENGTH} digits.`;
    case 'trivial':
      return 'That PIN is one of the first anyone would try. Pick another.';
  }
}

/** A fresh 32-byte salt, base64. One per lock, minted on this device. */
export async function newSalt(): Promise<string> {
  return toBase64(await randomBytes(SALT_BYTES));
}

/**
 * Derive the verifier the server compares against. Throws InvalidPin for a
 * PIN this app would not have let you set, and LockDeriveFailed when the
 * native hash itself fails — the two need different copy: one is "pick
 * another PIN", the other is "something went wrong".
 */
export async function deriveVerifier(pin: string, saltB64: string): Promise<string> {
  if (pinProblem(pin) !== null) throw new InvalidPin(pinProblem(pin) ?? 'invalid');
  try {
    return await pinVerifier(pin, saltB64);
  } catch {
    // The reason is never surfaced: it can only be a bad salt or a native
    // failure, and neither is actionable by the person holding the phone.
    throw new LockDeriveFailed('derive');
  }
}

/** Everything needed to set a lock: a new salt and the verifier under it. */
export async function buildLock(pin: string): Promise<{ salt: string; verifier: string }> {
  const salt = await newSalt();
  return { salt, verifier: await deriveVerifier(pin, salt) };
}

/*
 * There is deliberately nothing below this line any more. `hasRegistrationLock`
 * and the `reglock.set` Keychain flag went with the routes that were the only
 * thing able to set them: a flag nothing can turn on is a function that always
 * answers "no", which is worse than no function at all. Whatever #13 needs to
 * remember about a backup PIN it will store under its own key, with its own
 * meaning.
 */
