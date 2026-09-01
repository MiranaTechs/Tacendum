import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_GROUP_MAX_MEMBERS,
  DEVICE_CLASSES,
  DeviceClassSchema,
  DiscoveryLookupResponse,
  IDENTIFIER_KINDS,
  LINK_DOMAIN,
  LINK_OPS,
  MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
  PrekeyBundle,
  linkOpSignedBytes,
  normalizeEmailIdentifier,
} from '../src/dto.js';

/**
 * The shared account-grouping constants and DTO shapes.
 *
 * These are fixture pins, not behavior tests: every value here is a release
 * constant that must not drift, and a drift is a design amendment, not a
 * tune. The email normalization fixtures pin the exact normalization in
 * shared code, fixture-tested.
 */

describe('link domain constant (Appendix A)', () => {
  it('is exactly tacendum-link-v1 — the preimage domain every link-op signature rides', () => {
    expect(LINK_DOMAIN).toBe('tacendum-link-v1');
  });

  it('frames exactly the five pinned ops, in their pinned spelling', () => {
    expect(LINK_OPS).toEqual(['offer', 'accept', 'unlink', 'revoke', 'dissolve']);
  });
});

describe('linkOpSignedBytes guards', () => {
  const tuple = {
    groupId: '01HQGGGG0000000000000000G0',
    offererUserId: '01HQAAAA00000000000000000A',
    acceptorUserId: '01HQBBBB00000000000000000B',
    subjectIdentityPubKey: 'BQAB',
    class: 'phone' as const,
    rosterEpoch: 0,
    offerNonce: '01HQNNNN00000000000000000N',
    expiresAt: 1_756_000_600,
  };

  it('refuses an op outside the pinned five, as Swift and Kotlin do', () => {
    expect(() => linkOpSignedBytes('transfer' as never, tuple)).toThrow('unknown link op');
  });

  it('refuses an EMPTY field — an empty field verifies against nothing anyone meant to say', () => {
    expect(() => linkOpSignedBytes('offer', { ...tuple, offerNonce: '' })).toThrow(
      'link-op field must be non-empty',
    );
    expect(() => linkOpSignedBytes('offer', { ...tuple, subjectIdentityPubKey: '' })).toThrow(
      'link-op field must be non-empty',
    );
  });

  it('refuses a non-integer or negative integer — ASCII decimal is the pinned encoding', () => {
    expect(() => linkOpSignedBytes('offer', { ...tuple, rosterEpoch: 1.5 })).toThrow(
      'nonnegative integers',
    );
    expect(() => linkOpSignedBytes('offer', { ...tuple, expiresAt: -1 })).toThrow(
      'nonnegative integers',
    );
  });

  it('still builds the well-formed preimage (the guards refuse nothing legal)', () => {
    const bytes = linkOpSignedBytes('offer', tuple);
    expect(bytes.length).toBeGreaterThan(LINK_DOMAIN.length);
  });
});

describe('device classes', () => {
  it('is exactly {phone, tablet, desktop} — one slot each, an account concept, not a UI concept', () => {
    expect(DEVICE_CLASSES).toEqual(['phone', 'tablet', 'desktop']);
  });

  it('the SCHEMA accepts desktop — the slot is schema-reserved; occupancy is refused at the link transaction, not here', () => {
    expect(DeviceClassSchema.parse('desktop')).toBe('desktop');
    expect(DeviceClassSchema.parse('phone')).toBe('phone');
    expect(DeviceClassSchema.parse('tablet')).toBe('tablet');
  });

  it('rejects anything outside the taxonomy — a fourth class is a plan amendment', () => {
    expect(() => DeviceClassSchema.parse('watch')).toThrow();
    expect(() => DeviceClassSchema.parse('Phone')).toThrow();
    expect(() => DeviceClassSchema.parse('')).toThrow();
  });

  it('caps the group at 3 members — one per class', () => {
    expect(ACCOUNT_GROUP_MAX_MEMBERS).toBe(3);
    expect(ACCOUNT_GROUP_MAX_MEMBERS).toBe(DEVICE_CLASSES.length);
  });
});

describe('identifier constants (per-CLASS slots; three classes)', () => {
  it('three identifier classes — email, phone, username — with exactly ONE slot per class', () => {
    expect(IDENTIFIER_KINDS).toEqual(['email', 'phone', 'username']);
    // The per-group cap auto-grows with the kinds list:
    // 3 with username, still a GetItem walk, still one slot per class.
    expect(MAX_VERIFIED_IDENTIFIERS_PER_GROUP).toBe(3);
  });
});

describe('normalizeEmailIdentifier (§11 assumption 5: case-fold + trim, pinned here)', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeEmailIdentifier('  alice@example.com  ')).toBe('alice@example.com');
    expect(normalizeEmailIdentifier('\talice@example.com\n')).toBe('alice@example.com');
  });

  it('case-folds', () => {
    expect(normalizeEmailIdentifier('Alice@Example.COM')).toBe('alice@example.com');
  });

  it('is idempotent — normalizing a normalized identifier is a no-op', () => {
    const once = normalizeEmailIdentifier(' Bob.Smith+tag@Example.org ');
    expect(normalizeEmailIdentifier(once)).toBe(once);
  });

  it('byte fixtures: the exact outputs future HMAC claim keys will be derived from', () => {
    // Pinned vectors. If any of these change, every emailhash# claim row ever
    // written under the old normalization stops resolving — that is why they
    // are fixtures and not examples.
    const vectors: Array<[string, string]> = [
      ['alice@example.com', 'alice@example.com'],
      [' ALICE@EXAMPLE.COM ', 'alice@example.com'],
      ['MiXeD.CaSe+Tag@SUB.Example.Org', 'mixed.case+tag@sub.example.org'],
      ['Étienne@Example.com', 'étienne@example.com'],
    ];
    for (const [raw, want] of vectors) {
      expect(normalizeEmailIdentifier(raw)).toBe(want);
    }
  });
});

describe('PrekeyBundle roster fields', () => {
  const base = {
    userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    registrationId: 42,
    identityKey: 'AAAA',
    signedPrekey: { keyId: 1, pub: 'AAAA', sig: 'AAAA' },
    kyberPrekey: { keyId: 2, pub: 'AAAA', sig: 'AAAA' },
  };

  it('a pre-accounts bundle still parses — the fields are ADDITIVE, old servers and old clients stay valid', () => {
    const parsed = PrekeyBundle.parse(base);
    expect(parsed.rosterVersion).toBeUndefined();
    expect(parsed.siblings).toBeUndefined();
  });

  /** A cert set carrying its full signed-tuple context: every Appendix A preimage field except the subject identity
   * keys, which a verifier supplies from its own pins. */
  const fullCerts = {
    offerSig: 'c2ln',
    acceptSig: 'c2ln',
    groupId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    offererUserId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    acceptorUserId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
    class: 'tablet',
    rosterEpoch: 0,
    offerNonce: 'nonce-1',
    expiresAt: 1_750_000_000,
  };

  it('a grouped bundle carries rosterVersion + siblings (device ULIDs, classes, link certificates — §2.5)', () => {
    const parsed = PrekeyBundle.parse({
      ...base,
      rosterVersion: 3,
      siblings: [
        {
          userId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
          class: 'tablet',
          certs: fullCerts,
        },
      ],
    });
    expect(parsed.rosterVersion).toBe(3);
    expect(parsed.siblings?.[0]?.class).toBe('tablet');
    expect(parsed.siblings?.[0]?.certs.offerSig).toBe('c2ln');
    expect(parsed.siblings?.[0]?.certs.rosterEpoch).toBe(0);
    expect(parsed.siblings?.[0]?.certs.offerNonce).toBe('nonce-1');
  });

  it('a certificate WITHOUT its signed-tuple context is refused — a signature nobody can re-derive the preimage for is not a certificate', () => {
    expect(() =>
      PrekeyBundle.parse({
        ...base,
        rosterVersion: 1,
        siblings: [
          {
            userId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
            class: 'tablet',
            certs: { offerSig: 'c2ln', acceptSig: 'c2ln' },
          },
        ],
      }),
    ).toThrow();
  });

  it('the certs deliberately have NO subjectIdentityPubKey field — the verifier must bind its OWN pinned keys, never a served copy', () => {
    expect(() =>
      PrekeyBundle.parse({
        ...base,
        rosterVersion: 1,
        siblings: [
          {
            userId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
            class: 'tablet',
            certs: { ...fullCerts, subjectIdentityPubKey: 'AAAA' },
          },
        ],
      }),
    ).not.toThrow();
    // zod strips the unknown key rather than storing it: the parsed shape
    // carries no server-supplied subject key for a lazy verifier to trust.
    const parsed = PrekeyBundle.parse({
      ...base,
      rosterVersion: 1,
      siblings: [
        {
          userId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
          class: 'tablet',
          certs: { ...fullCerts, subjectIdentityPubKey: 'AAAA' },
        },
      ],
    });
    expect(
      (parsed.siblings?.[0]?.certs as Record<string, unknown>).subjectIdentityPubKey,
    ).toBeUndefined();
  });

  it('a sibling with a class outside the taxonomy is refused', () => {
    expect(() =>
      PrekeyBundle.parse({
        ...base,
        rosterVersion: 1,
        siblings: [
          {
            userId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
            class: 'watch',
            certs: fullCerts,
          },
        ],
      }),
    ).toThrow();
  });
});

describe('DiscoveryLookupMember.class is OPTIONAL at build 19 (strip the per-member class disclosure)', () => {
  const ULID_A = '01BX5ZZKBKACTAV9WEVGEMMVRA';
  const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRB';

  it("the still-sending server parses: the deployed constant literal 'phone' on every member (build-18 wire, unchanged)", () => {
    const parsed = DiscoveryLookupResponse.parse({
      members: [
        { userId: ULID_A, class: 'phone' },
        { userId: ULID_B, class: 'phone' },
      ],
      rosterVersion: 3,
    });
    expect(parsed.members[0]?.class).toBe('phone');
  });

  it('the FUTURE field-dropping server parses too: members with no class at all', () => {
    const parsed = DiscoveryLookupResponse.parse({
      members: [{ userId: ULID_A }, { userId: ULID_B }],
      rosterVersion: 3,
    });
    expect(parsed.members[0]?.class).toBeUndefined();
    expect(parsed.members).toHaveLength(2);
  });

  it('a class outside the taxonomy is still refused — optional widened presence, never the enum', () => {
    expect(() =>
      DiscoveryLookupResponse.parse({
        members: [{ userId: ULID_A, class: 'watch' }],
        rosterVersion: 0,
      }),
    ).toThrow();
  });
});
