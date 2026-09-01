import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmailIdentifier,
  PHONE_E164_STRICT,
  PhoneIdentifier,
  UsernameIdentifier,
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
  normalizeUsernameIdentifier,
  usernameSkeleton,
} from '@tacendum/shared';
import {
  activeUsernameClaimKeys,
  emailClaimKey,
  identifierClaimHash,
  nameskelClaimKey,
  phoneClaimKey,
  usernameClaimKey,
} from '../src/opaque-ref.js';
import {
  NAMESKEL_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  attachClassPrefixForClaimKey,
  cooldownKeyFromClaimKey,
  cooldownShadowKeyForClaimKey,
  identifierClassForClaimKey,
} from '../src/db/data.js';

/**
 * the username claim-key surface — DARK: no
 * route computes or dispatches any of these keys yet. Pure CPU, no DDB.
 *
 * The shape is accounts-phone.test.ts's fixture block, extended to the
 * THIRD class: the sharing of the derived-subkey construction IS the pin, and the
 * three-way input-space disjointness it rides is asserted through the wire
 * schemas that enforce it, never assumed.
 */

describe('the SHARED derived-subkey construction, third class (the sharing IS the pin)', () => {
  it('reproduces the SAME derived-subkey bytes against the pinned username vector, and a class-prefixed input, a distinct subkey, AND an undomain-separated HMAC each FAIL it', () => {
    const K = 'fixture-K_id-for-the-UH1-username-byte-vector';
    const name = 'vector_alice';
    // The pin: the USERNAME claim hash is the email/phone construction's
    // EXACT output for the same input bytes — same K_id, same
    // HMAC_IDENTIFIER derived subkey, NO username-specific domain string or
    // subkey anywhere. Byte-pinned as a committed literal, not recomputed.
    const PINNED = 'HfgHRyztrNzXU3dCruht9NsQTgJHUiJmR9-R5JVDdRs';
    expect(identifierClaimHash(K, name)).toBe(PINNED);

    // The wrong constructions the pin refuses, assembled by hand (node:crypto
    // in a test recomputing what the code must match — posture, the block's exact shape):
    // 1. A CLASS-PREFIXED input — a username-specific message domain.
    const derived = createHmac('sha256', K).update('HMAC_IDENTIFIER').digest();
    const classPrefixed = createHmac('sha256', derived).update(`username:${name}`).digest('base64url');
    expect(classPrefixed).toBe('i2UwHt4MQrjxnUExPki0MvSBs0ifOO1Gtecb_07s3-4');
    expect(classPrefixed).not.toBe(PINNED);
    // 2. A DISTINCT subkey — a username-specific domain string (the fourth
    // named server HMAC refuses to mint).
    const distinctSub = createHmac('sha256', K).update('HMAC_IDENTIFIER_USERNAME').digest();
    const distinctSubkey = createHmac('sha256', distinctSub).update(name).digest('base64url');
    expect(distinctSubkey).toBe('1Hmi3x2yuBQiJJAPRre2iPSQgW8FjNSQaeK7TOI1DI4');
    expect(distinctSubkey).not.toBe(PINNED);
    // 3. An undomain-separated HMAC(K_id, name).
    const direct = createHmac('sha256', K).update(name).digest('base64url');
    expect(direct).toBe('gtV96HsfCl8q_ZudeTUfwGEyHV3G4DmZx6E_cWFNBr8');
    expect(direct).not.toBe(PINNED);

    // The faithful reproduction: the same node:crypto hands rebuild the
    // module's answer, so the pin is a construction, not a magic string.
    expect(createHmac('sha256', derived).update(name).digest('base64url')).toBe(PINNED);

    // The CLASS separation lives in the key PREFIX, nowhere in the bytes:
    // the four claim keys for one input differ ONLY by prefix — the skeleton
    // row included (its input space is a subset of the username charset;
    // its row class lives at the nameskel# prefix).
    const hash = identifierClaimHash(K, name);
    expect(usernameClaimKey(1, hash)).toBe(`usernamehash#v1#${hash}`);
    expect(nameskelClaimKey(1, hash)).toBe(`nameskel#v1#${hash}`);
    expect(phoneClaimKey(1, hash)).toBe(`phonehash#v1#${hash}`);
    expect(emailClaimKey(1, hash)).toBe(`emailhash#v1#${hash}`);
    expect(activeUsernameClaimKeys([{ version: 1, key: K }], name)).toEqual([
      `usernamehash#v1#${hash}`,
    ]);
  });

  it('the resolution walk is newest-first, ≤2 keys inside a rotation window (the opaque-ref generalized walk, reused verbatim)', () => {
    const keys = [
      { version: 1, key: 'old-key' },
      { version: 2, key: 'new-key' },
    ];
    const walked = activeUsernameClaimKeys(keys, 'alice');
    expect(walked).toEqual([
      `usernamehash#v2#${identifierClaimHash('new-key', 'alice')}`,
      `usernamehash#v1#${identifierClaimHash('old-key', 'alice')}`,
    ]);
  });

  it('the THREE-WAY input-space disjointness the shared subkey rides, asserted THROUGH THE WIRE SCHEMAS that enforce it: every admitted identifier normalizes into exactly one class, and the other two schemas refuse those bytes', () => {
    // extending the two-way argument to three: a normalized email
    // always contains exactly one '@'; a normalized phone matches strict
    // E.164 (never '@', always begins '+'); a normalized username matches
    // ^[a-z][a-z0-9_]{2,31}$ (never '@', begins [a-z], never '+'). No byte
    // string inhabits two classes, so no cross-class collision or confusion
    // is constructible under one subkey.
    const usernameWire = ['alice', ' Alice ', 'ALICE_99', 'a15550001111', 'x_2_z'];
    for (const raw of usernameWire) {
      expect(UsernameIdentifier.safeParse(raw).success, raw).toBe(true);
      const normalized = normalizeUsernameIdentifier(raw);
      expect(normalized.includes('@'), raw).toBe(false);
      expect(normalized.startsWith('+'), raw).toBe(false);
      // The SAME normalized bytes are refused by BOTH other schemas — no
      // byte-string admitted here can ever reach an emailhash# or
      // phonehash# derivation.
      expect(EmailIdentifier.safeParse(normalized).success, raw).toBe(false);
      expect(PhoneIdentifier.safeParse(normalized).success, raw).toBe(false);
      // The skeleton stays inside the username charset minus '_' — the
      // nameskel# input space is a SUBSET, disjointness undisturbed.
      const skeleton = usernameSkeleton(normalized);
      expect(/^[a-z0-9]+$/.test(skeleton), raw).toBe(true);
      expect(EmailIdentifier.safeParse(skeleton).success, raw).toBe(false);
      expect(PhoneIdentifier.safeParse(skeleton).success, raw).toBe(false);
    }
    const phoneWire = ['+15550001111', '+1 (555) 000-1111', '+44 7911 123456'];
    for (const raw of phoneWire) {
      const normalized = normalizePhoneIdentifier(raw);
      expect(PHONE_E164_STRICT.test(normalized), raw).toBe(true);
      expect(UsernameIdentifier.safeParse(normalized).success, raw).toBe(false);
    }
    const emailWire = ['alice@example.com', 'MIXED@Sub.Example.org', 'a+15550001111@b.co'];
    for (const raw of emailWire) {
      const normalized = normalizeEmailIdentifier(raw);
      expect(normalized.split('@').length, raw).toBe(2);
      expect(UsernameIdentifier.safeParse(normalized).success, raw).toBe(false);
    }
  });
});

describe('the data.ts prefix dispatch learns the third class (a username ref reaching an untaught site 500s — every site is taught, unit-pinned)', () => {
  it('the prefix constants are pinned beside the email/phone spellings', () => {
    expect(USERNAME_CLAIM_KEY_PREFIX).toBe('usernamehash#');
    expect(NAMESKEL_CLAIM_KEY_PREFIX).toBe('nameskel#');
  });

  it('identifierClassForClaimKey: both new prefixes read as the username class — the skeleton row is the username class second claim row, never a class of its own', () => {
    expect(identifierClassForClaimKey('usernamehash#v1#abc')).toBe('username');
    expect(identifierClassForClaimKey('nameskel#v1#abc')).toBe('username');
    // The landed classes are untouched…
    expect(identifierClassForClaimKey('emailhash#v1#abc')).toBe('email');
    expect(identifierClassForClaimKey('phonehash#v1#abc')).toBe('phone');
    // …and a genuinely unknown prefix still meets the generic throw, whose
    // meaning this teaching preserves: it fires ONLY for unknown classes.
    expect(() => identifierClassForClaimKey('badgehash#v1#abc')).toThrow(
      'outside the named identifier classes',
    );
  });

  it('cooldownKeyFromClaimKey: the username class is KNOWN and deliberately shadowless — the recovery-excluded refusal, distinct from the unknown-class throw', () => {
    //a handle possesses nothing, so no recovery ever completes off a
    // username claim and no usernamecool# row class exists. The taught site
    // refuses BY NAME rather than misreporting a known class as unknown.
    expect(() => cooldownKeyFromClaimKey('usernamehash#v1#abc')).toThrow(
      'recovery-excluded',
    );
    expect(() => cooldownKeyFromClaimKey('nameskel#v1#abc')).toThrow('recovery-excluded');
    // The landed classes are untouched…
    expect(cooldownKeyFromClaimKey('emailhash#v1#abc')).toBe('emailcool#v1#abc');
    expect(cooldownKeyFromClaimKey('phonehash#v1#abc')).toBe('phonecool#v1#abc');
    // …and a genuinely unknown prefix still meets the generic throw.
    expect(() => cooldownKeyFromClaimKey('badgehash#v1#abc')).toThrow(
      'outside the named identifier classes',
    );
  });

  it('cooldownShadowKeyForClaimKey: the completion walk FILTERS the shadowless class (null), never throws on it — a handle on the group must not brick an email/phone-proved recovery', () => {
    // The cross-class walk maps EVERY ref the group
    // holds, so the by-name throw above, reached from the completion
    // transaction, would 500 every recovery for anyone holding a username.
    // The walk's mapping answers null for the class instead.
    expect(cooldownShadowKeyForClaimKey('usernamehash#v1#abc')).toBeNull();
    expect(cooldownShadowKeyForClaimKey('nameskel#v1#abc')).toBeNull();
    // The landed classes map exactly as the throwing form does…
    expect(cooldownShadowKeyForClaimKey('emailhash#v1#abc')).toBe('emailcool#v1#abc');
    expect(cooldownShadowKeyForClaimKey('phonehash#v1#abc')).toBe('phonecool#v1#abc');
    // …and a genuinely unknown prefix is STILL a programming error, not a
    // filtered no-op: null is the answer for a known shadowless class only.
    expect(() => cooldownShadowKeyForClaimKey('badgehash#v1#abc')).toThrow(
      'outside the named identifier classes',
    );
  });

  it('attachClassPrefixForClaimKey: the per-class slot dispatch is EXHAUSTIVE — a username key throws by name, never reads as email', () => {
    // The attach transaction's identifier_cap/stale classification used a
    // two-way ternary (phone, else email); with the class read three-valued
    // a username key would have been silently classified as EMAIL. Now the
    // dispatch names every class and refuses the one that never attaches
    // through the possession-proof lane.
    expect(attachClassPrefixForClaimKey('phonehash#v1#abc')).toBe('phonehash#');
    expect(attachClassPrefixForClaimKey('emailhash#v1#abc')).toBe('emailhash#');
    expect(() => attachClassPrefixForClaimKey('usernamehash#v1#abc')).toThrow(
      'username claims never attach',
    );
    expect(() => attachClassPrefixForClaimKey('nameskel#v1#abc')).toThrow(
      'username claims never attach',
    );
    expect(() => attachClassPrefixForClaimKey('badgehash#v1#abc')).toThrow(
      'outside the named identifier classes',
    );
  });
});
