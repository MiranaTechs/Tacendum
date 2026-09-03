import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmailIdentifier,
  MAX_VERIFIED_IDENTIFIERS_PER_CLASS,
  MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
  PHONE_E164_STRICT,
  PHONE_SEND_FLEET_BURST_PER_MINUTE,
  PHONE_SEND_FLEET_DAILY_CEILING,
  PHONE_SENDS_PER_RECIPIENT_PER_DAY,
  PhoneIdentifier,
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
} from '@tacendum/shared';
import {
  activePhoneClaimKeys,
  emailClaimKey,
  identifierClaimHash,
  phoneClaimKey,
} from '../src/opaque-ref.js';
import { LIMITS } from '../src/ratelimit.js';

/**
 * The STORE-BLIND half of the phone suite: the shared-subkey byte vector, the
 * identifier-class disjointness asserted through the wire schemas, the
 * Appendix A release pins, and the R-P7c strict-E.164 normalizer vectors.
 *
 * WHY IT LIVES IN ITS OWN FILE. accounts-phone.test.ts opens ListTables
 * against DynamoDB Local in beforeAll and pages a full Scan of two tables,
 * so moved it to vitest.config.ts's `heavy` project. CI runs only `--project
 * fast` and nothing runs `heavy`, so that move
 * silently took these pure-CPU pins off every PR — the drift detectors for
 * the shared-subkey construction and the normalizer stopped detecting drift
 * anywhere but a developer's machine.
 *
 * Nothing here touches a store, a clock, or a child process: classify by
 * what a file touches (the split's own rule), and this file touches
 * neither :8000 nor the network, so it belongs in `fast` and stays there. */

describe('the SHARED subkey construction — the sharing IS the pin (the shared-construction rule)', () => {
  it('reproduces the SAME derived-subkey bytes against the pinned phone vector, and a class-prefixed input, a distinct subkey, AND an undomain-separated HMAC each FAIL it', () => {
    const K = 'fixture-K_id-for-the-ACP1-phone-byte-vector';
    const number = '+15558675309';
    // The pin: the PHONE claim hash is the email construction's EXACT
    // output for the same input bytes — same K_id, same HMAC_IDENTIFIER
    // derived subkey, NO phone-specific domain string or subkey anywhere.
    const PINNED = '6ksgqZZlIKnIbUfaXMKEz1m6g7-a_dLMkNIthW507fw';
    expect(identifierClaimHash(K, number)).toBe(PINNED);

    // The wrong constructions the pin refuses, assembled by hand
    // (node:crypto in a test recomputing what the code must match — the
    // independent-recompute rule):
    // 1. A CLASS-PREFIXED input — a phone-specific message domain.
    const derived = createHmac('sha256', K).update('HMAC_IDENTIFIER').digest();
    const classPrefixed = createHmac('sha256', derived).update(`phone:${number}`).digest('base64url');
    expect(classPrefixed).toBe('7SYVzW1ZzjnKTOAMGUt2Epsp37ncYnOyFUBbaX4MK68');
    expect(classPrefixed).not.toBe(PINNED);
    // 2. A DISTINCT subkey — a phone-specific domain string.
    const distinctSub = createHmac('sha256', K).update('HMAC_IDENTIFIER_PHONE').digest();
    const distinctSubkey = createHmac('sha256', distinctSub).update(number).digest('base64url');
    expect(distinctSubkey).toBe('r2M3J3B6qqsO9xV9F2KxCESP_S2jxOs1mdqo27I6jOM');
    expect(distinctSubkey).not.toBe(PINNED);
    // 3. An undomain-separated HMAC(K_id, number).
    const direct = createHmac('sha256', K).update(number).digest('base64url');
    expect(direct).toBe('2-dZQULqn9IXDBGqeIslyCw-L9FifcUKgGguXXEzaew');
    expect(direct).not.toBe(PINNED);

    // The faithful reproduction: the same node:crypto hands rebuild the
    // module's answer, so the pin is a construction, not a magic string.
    expect(createHmac('sha256', derived).update(number).digest('base64url')).toBe(PINNED);

    // The CLASS separation lives in the key PREFIX, nowhere in the bytes:
    // the two claim keys for one input differ ONLY by prefix.
    const hash = identifierClaimHash(K, number);
    expect(phoneClaimKey(1, hash)).toBe(`phonehash#v1#${hash}`);
    expect(emailClaimKey(1, hash)).toBe(`emailhash#v1#${hash}`);
    expect(activePhoneClaimKeys([{ version: 1, key: K }], number)).toEqual([
      `phonehash#v1#${hash}`,
    ]);
  });

  it('the input-space disjointness the shared subkey RIDES is asserted THROUGH THE WIRE SCHEMAS that enforce it: every schema-admitted identifier normalizes into exactly one class, and the other schema refuses those bytes', () => {
    // The guarantee does NOT live in the normalizers (normalizeEmailIdentifier
    // is a bare trim+casefold and promises nothing about '@') — it lives in
    // the schemas' refinements: EmailIdentifier requires exactly one '@' and
    // no whitespace; PhoneIdentifier requires the normalized form match
    // strict E.164. So the drift detector must run the SCHEMAS, not
    // hand-picked strings against the normalizers.
    const phoneWire = [
      '+15550001111',
      '+1 (555) 000-1111',
      '+1.555.867.5309',
      '+44 7911 123456',
      '+861234567890',
    ];
    for (const raw of phoneWire) {
      const parsed = PhoneIdentifier.safeParse(raw);
      expect(parsed.success, raw).toBe(true);
      const normalized = normalizePhoneIdentifier(raw);
      expect(PHONE_E164_STRICT.test(normalized), raw).toBe(true);
      expect(normalized.includes('@'), raw).toBe(false);
      // The SAME normalized bytes are refused by the email schema — no
      // byte-string admitted here can ever reach an emailhash# derivation.
      expect(EmailIdentifier.safeParse(normalized).success, raw).toBe(false);
    }
    const emailWire = [
      'alice@example.com',
      'MIXED@Sub.Example.org',
      '15550001111@example.com',
      'a+15550001111@b.co',
    ];
    for (const raw of emailWire) {
      const parsed = EmailIdentifier.safeParse(raw);
      expect(parsed.success, raw).toBe(true);
      const normalized = normalizeEmailIdentifier(raw);
      expect(normalized.split('@').length, raw).toBe(2);
      expect(PHONE_E164_STRICT.test(normalized), raw).toBe(false);
      // ...and the phone schema refuses the normalized email bytes.
      expect(PhoneIdentifier.safeParse(normalized).success, raw).toBe(false);
    }
    // The former hand-picked sample ' MIXED@Sub.Example.org ' (leading and
    // trailing whitespace) was an input the WIRE REJECTS — EmailIdentifier's
    // refine fails on any whitespace — so it could never reach a normalizer
    // in production; pinned here as unreachable rather than sampled as if
    // it were the property.
    expect(EmailIdentifier.safeParse(' MIXED@Sub.Example.org ').success).toBe(false);
  });

  it('Appendix A phone pins, asserted verbatim as release values (never a test shadow)', () => {
    expect(PHONE_SENDS_PER_RECIPIENT_PER_DAY).toBe(3);
    expect(PHONE_SEND_FLEET_BURST_PER_MINUTE).toBe(5);
    expect(PHONE_SEND_FLEET_DAILY_CEILING).toBe(200);
    expect(LIMITS.phoneSendRecipient).toEqual({ capacity: 3, refillPerSec: 3 / 86400 });
    expect(LIMITS.phoneResend).toEqual({ capacity: 1, refillPerSec: 1 / 60 });
    expect(LIMITS.phoneSendFleetBurst).toEqual({ capacity: 5, refillPerSec: 5 / 60 });
    expect(LIMITS.phoneSendFleet).toEqual({ capacity: 200, refillPerSec: 200 / 86400 });
    // The slot-cap pins are CONSUMED, not decorative: the
    // four handler prechecks read MAX_VERIFIED_IDENTIFIERS_PER_CLASS and
    // the attach transaction's size() backstop reads
    // MAX_VERIFIED_IDENTIFIERS_PER_GROUP — the TestOnlyDataLayer-level cap case in
    // this suite drives the group pin through the real transaction.
    expect(MAX_VERIFIED_IDENTIFIERS_PER_CLASS).toBe(1);
    // 3 since the username class landed: the group cap auto-grows with
    // IDENTIFIER_KINDS — the username class holds the third slot, DARK
    // until its routes ship. Per-class enforcement above is what this
    // suite's cap cases actually drive; the group total is the backstop.
    expect(MAX_VERIFIED_IDENTIFIERS_PER_GROUP).toBe(3);
  });
});

describe('the R-P7c strict-E.164 normalizer — the fixture vectors ARE the drift detector', () => {
  it('strips human formatting and admits the pinned goods', () => {
    const goods: Array<[string, string]> = [
      ['+15550001111', '+15550001111'],
      ['+1 (555) 000-1111', '+15550001111'],
      ['+1.555.000.1111', '+15550001111'],
      ['+44 7911 123456', '+447911123456'],
      ['+861234567890', '+861234567890'],
    ];
    for (const [raw, want] of goods) {
      const normalized = normalizePhoneIdentifier(raw);
      expect(normalized, raw).toBe(want);
      expect(PHONE_E164_STRICT.test(normalized), raw).toBe(true);
    }
  });

  it('REFUSES — never repairs — extensions, alpha, 00-prefix, missing +, leading-zero country, >15 digits, and anything containing @', () => {
    const bads = [
      '+15550001111x23', // extension
      '+1555000111 ext 2', // extension, spelled
      '+1555ABCDEF', // letters (no vanity mapping, ever)
      '0015550001111', // 00 international prefix is not repaired to +
      '15550001111', // missing + — NO COUNTRY GUESSING
      '5550001111', // bare national number — no country guessing
      '+05550001111', // leading-zero country code
      '+1234567890123456', // 16 digits
      '+', // nothing
      '+1555@example', // '@' can never enter the phone class
    ];
    for (const raw of bads) {
      expect(PHONE_E164_STRICT.test(normalizePhoneIdentifier(raw)), raw).toBe(false);
    }
  });
});
