import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_CHALLENGE_DOMAIN, LINK_DOMAIN, authSignedBytes } from '../src/dto.js';
import {
  KIT_CHALLENGE_BYTES,
  KIT_CHALLENGE_TTL_SECONDS,
  KIT_DISENROLL_DOMAIN,
  KIT_ENROLL_DOMAIN,
  KIT_REBIND_ATTEMPT_LIMIT,
  KIT_REBIND_ATTEMPT_WINDOW_SECONDS,
  KIT_REBIND_DOMAIN,
  KIT_SALT_BYTES,
  KIT_SECRET_BYTES,
  KIT_VERIFIER_BYTES,
  KIT_ZERO_MATERIAL_B64,
  KitDisenrollRequest,
  KitEnrollRequest,
  RebindChallengeResponse,
  RebindRequest,
  kitDisenrollSignedBytes,
  kitEnrollSignedBytes,
  kitRebindSignedBytes,
} from '../src/recovery.js';

/**
 * BYTE PINS for the recovery kit's two signed preimages.
 *
 * These are hex literals, not values recomputed from the same builder the test
 * is checking — a test that rebuilds the preimage its own way proves only that
 * the code is self-consistent, and a refactor that moved a field would pass it.
 * The tuple below is the one the cross-platform vector file will carry, on
 * the `authvectors.json` / `linkvectors.json` precedent: the Swift and Kotlin
 * signers cannot run here, so a pinned hex string is the only thing that can
 * catch them drifting from this file.
 */
const ORIGIN = 'https://api.tacendum.com';
/** 32 bytes, 0x00..0x1f. */
const CHALLENGE_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
/** 32 bytes, 0x20..0x3f. */
const SALT_B64 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
/** 32 bytes, 0x40..0x5f. */
const VERIFIER_B64 = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=';
/** A canonical 33-byte identity key, the width libsignal emits. */
const IDENTITY_KEY_B64 = 'BXKr9O1H7wKzL1a1M0lPq8kD7Yt1YQ7QzS4nq0nEo5cX';
const IDENTITY_KEY_HEX = '0572abf4ed47ef02b32f56b533494fabc903ed8b75610ed0cd2e27ab49c4a39717';

const ENROLL_HEX =
  '746163656e64756d2d6b69742d656e726f6c6c2d7631' +
  '0018' +
  '68747470733a2f2f6170692e746163656e64756d2e636f6d' +
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' +
  '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f';

const REBIND_HEX =
  '746163656e64756d2d6b69742d726562696e642d7631' +
  '0018' +
  '68747470733a2f2f6170692e746163656e64756d2e636f6d' +
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
  // uint16be(33) ‖ the identity key being bound.
  '0021' +
  IDENTITY_KEY_HEX;

const DISENROLL_HEX =
  // Its OWN tag, not the enrol tag over zeros.
  '746163656e64756d2d6b69742d646973656e726f6c6c2d7631' +
  '0018' +
  '68747470733a2f2f6170692e746163656e64756d2e636f6d' +
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A canonical-base64 32-byte value that is NOT one of the pinned ones. The
 * 43rd character must come from the class whose unused low bits are zero, or
 * it is a second spelling rather than a different value. */
const OTHER_32_B64 = `${'B'.repeat(42)}A=`;

describe('kit signed bytes — known answers', () => {
  it('kitEnrollSignedBytes matches the pinned preimage byte for byte', () => {
    expect(hex(kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, VERIFIER_B64))).toBe(
      ENROLL_HEX,
    );
  });

  it('kitRebindSignedBytes matches the pinned preimage byte for byte', () => {
    expect(hex(kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, IDENTITY_KEY_B64))).toBe(REBIND_HEX);
  });

  it('the rebind preimage COMMITS to the identity key being bound', () => {
    // Without this the proof covered nothing but the nonce,
    // so a party that could modify a rebind in flight could keep the victim's
    // key, signature and verifier and swap the prekeys underneath them.
    const other = 'BSwlHy6EhOQnAyPMr4Nm3vFqUzKZbXdWtGiRcJaLoP0e';
    expect(other).not.toBe(IDENTITY_KEY_B64);
    expect(hex(kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, other))).not.toBe(REBIND_HEX);
    // The key is LENGTH-PREFIXED, so a longer key cannot be read as a shorter
    // key followed by trailing bytes: uint16be(33) sits immediately after the
    // fixed-width challenge.
    const at = KIT_REBIND_DOMAIN.length + 2 + ORIGIN.length + KIT_CHALLENGE_BYTES;
    const bytes = kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, IDENTITY_KEY_B64);
    expect(bytes[at]).toBe(0x00);
    expect(bytes[at + 1]).toBe(33);
    expect(bytes).toHaveLength(at + 2 + 33);
  });

  it('an empty or unencodable identity key throws rather than signing nothing', () => {
    expect(() => kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, '')).toThrow(
      /identityKey must be length-prefixable/,
    );
  });

  it('the disenrol preimage carries its OWN domain tag', () => {
    expect(hex(kitDisenrollSignedBytes(ORIGIN, CHALLENGE_B64))).toBe(DISENROLL_HEX);
  });

  it('A DISENROL SIGNATURE IS NOT AN ENROLMENT SIGNATURE FOR ANY MATERIAL', () => {
    // THE DEFECT THIS TAG CLOSED. The draft spelled disenrolment as the
    // ENROL preimage over zeroed material, which made the two byte-identical
    // for an all-zero verifier — and both verbs draw nonces from ONE `echal#`
    // namespace, so one unspent nonce plus one signature was redeemable at
    // EITHER route. A separate tag makes the collision impossible rather than
    // improbable: no salt/verifier pair, zeroed or otherwise, can reproduce
    // the disenrol bytes.
    const disenrol = hex(kitDisenrollSignedBytes(ORIGIN, CHALLENGE_B64));
    for (const salt of [SALT_B64, KIT_ZERO_MATERIAL_B64, OTHER_32_B64]) {
      for (const verifier of [VERIFIER_B64, KIT_ZERO_MATERIAL_B64, OTHER_32_B64]) {
        expect(hex(kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, salt, verifier))).not.toBe(disenrol);
      }
    }
    // Structurally, not just for these tuples: the tags differ from byte 13
    // onwards, so no enrol preimage can share the disenrol one's first bytes.
    expect(KIT_DISENROLL_DOMAIN).not.toBe(KIT_ENROLL_DOMAIN);
    expect(hex(kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, VERIFIER_B64))).not.toContain(
      hex(kitDisenrollSignedBytes(ORIGIN, CHALLENGE_B64)),
    );
  });

  it('the wire shapes REFUSE zeroed kit material outright', () => {
    // The belt to the domain tag's braces, and the claim the source comment
    // used to make without any code behind it. A verifier of 32 zero bytes is
    // a value everybody knows; enrolling one would hand the account to anyone
    // holding the public ULID.
    expect(
      KitEnrollRequest.safeParse({
        challenge: CHALLENGE_B64,
        salt: KIT_ZERO_MATERIAL_B64,
        verifier: VERIFIER_B64,
        signature: 'c2ln',
      }).success,
    ).toBe(false);
    expect(
      KitEnrollRequest.safeParse({
        challenge: CHALLENGE_B64,
        salt: SALT_B64,
        verifier: KIT_ZERO_MATERIAL_B64,
        signature: 'c2ln',
      }).success,
    ).toBe(false);
  });
});

describe('kit signed bytes — domain separation', () => {
  it('the three tags are different strings and none is the shipped identifier-recovery verb', () => {
    expect(KIT_ENROLL_DOMAIN).toBe('tacendum-kit-enroll-v1');
    expect(KIT_DISENROLL_DOMAIN).toBe('tacendum-kit-disenroll-v1');
    expect(KIT_REBIND_DOMAIN).toBe('tacendum-kit-rebind-v1');
    expect(new Set([KIT_ENROLL_DOMAIN, KIT_DISENROLL_DOMAIN, KIT_REBIND_DOMAIN]).size).toBe(3);
  });

  it('NO DOMAIN TAG IN THIS PACKAGE IS A PREFIX OF ANOTHER', () => {
    // THE PROPERTY THAT MAKES AN UNPREFIXED DOMAIN SAFE, checked rather than
    // inspected. Every preimage here is `domain ‖ uint16be(len(origin)) ‖ …`
    // with the domain itself carrying NO length, so separation holds only
    // while no tag is a proper prefix of another. Today that is an accident
    // of the strings (16 bytes for the two shipped tags, 22 and 25 for the
    // kit ones); a future 'tacendum-kit-rebind-v2-cli' would collide with
    // 'tacendum-kit-rebind-v2' plus a shifted length prefix, and nothing but
    // this test would notice.
    const tags = [
      AUTH_CHALLENGE_DOMAIN,
      LINK_DOMAIN,
      KIT_ENROLL_DOMAIN,
      KIT_DISENROLL_DOMAIN,
      KIT_REBIND_DOMAIN,
    ];
    expect(new Set(tags).size).toBe(tags.length);
    for (const a of tags) {
      for (const b of tags) {
        if (a === b) continue;
        expect(a.startsWith(b), `${a} starts with ${b} — the tags are not separated`).toBe(false);
      }
    }
  });

  it('no kit preimage collides with a SHIPPED auth signature over the same nonce', () => {
    // The stronger property the file claims: one identity key signs auth
    // challenges, link ops, enrolments, disenrolments and rebinds, and no
    // signature may be replayable as another. Only the two kit tags were
    // compared before; the shipped signers were not.
    const auth = hex(authSignedBytes(ORIGIN, CHALLENGE_B64));
    const kitPreimages = [
      hex(kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, VERIFIER_B64)),
      hex(kitDisenrollSignedBytes(ORIGIN, CHALLENGE_B64)),
      hex(kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, IDENTITY_KEY_B64)),
    ];
    for (const preimage of kitPreimages) {
      expect(preimage).not.toBe(auth);
      expect(preimage.startsWith(auth)).toBe(false);
      expect(auth.startsWith(preimage)).toBe(false);
    }
  });

  it('the same origin and challenge produce different bytes under the two tags', () => {
    // Domain separation is the point: one identity key signs auth challenges,
    // link ops, enrolments and rebinds, and no signature may be replayable as
    // another. The two preimages share every byte after the tag's length.
    const enroll = kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, VERIFIER_B64);
    const rebind = kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, IDENTITY_KEY_B64);
    expect(hex(enroll)).not.toBe(hex(rebind));
    // The rebind preimage is not a PREFIX of the enrol one, which is what a
    // SHARED tag plus a truncated payload would have produced — that shape is
    // the replay this separation exists to stop. (The two tags share their
    // first twelve characters, "tacendum-kit", so a naive prefix comparison
    // over the first few bytes proves nothing and is deliberately not made.)
    expect(hex(enroll).startsWith(hex(rebind))).toBe(false);
    expect(hex(rebind).startsWith(hex(enroll))).toBe(false);
  });
});

describe('kit signed bytes — the origin is length-prefixed and normalized', () => {
  it('folds case, drops the default port and the path', () => {
    const folded = kitRebindSignedBytes('https://API.Tacendum.com:443/v1/', CHALLENGE_B64, IDENTITY_KEY_B64);
    expect(hex(folded)).toBe(REBIND_HEX);
  });

  it('a different audience produces different bytes', () => {
    expect(hex(kitRebindSignedBytes('https://evil.example', CHALLENGE_B64, IDENTITY_KEY_B64))).not.toBe(REBIND_HEX);
  });

  it('the length prefix is present and correct', () => {
    // Two bytes, big-endian, immediately after the tag: 24 characters of
    // origin is 0x0018. Without it, one field's end is another's beginning.
    const bytes = kitRebindSignedBytes(ORIGIN, CHALLENGE_B64, IDENTITY_KEY_B64);
    const at = KIT_REBIND_DOMAIN.length;
    expect(bytes[at]).toBe(0x00);
    expect(bytes[at + 1]).toBe(0x18);
    expect(bytes[at + 1]).toBe('https://api.tacendum.com'.length);
  });

  it('an oversized origin throws rather than truncating', () => {
    const huge = `https://${'a'.repeat(70000)}.example`;
    expect(() => kitRebindSignedBytes(huge, CHALLENGE_B64, IDENTITY_KEY_B64)).toThrow(/length-prefix/);
  });

  it('an unparseable origin throws rather than defaulting to an empty audience', () => {
    expect(() => kitRebindSignedBytes('not-a-url', CHALLENGE_B64, IDENTITY_KEY_B64)).toThrow();
  });
});

describe('kit signed bytes — the fixed-width premise fails closed', () => {
  // Three unprefixed fields are only unambiguous while all three are exactly
  // 32 bytes. If a short one were accepted, its bytes would be read as the
  // next field's — the concatenation bug the length prefixes exist to stop.
  const SHORT_B64 = 'AAECAwQFBgcICQoLDA0ODw=='; // 16 bytes
  const LONG_B64 = 'A'.repeat(64); // 48 bytes

  it('a short challenge throws', () => {
    expect(() => kitEnrollSignedBytes(ORIGIN, SHORT_B64, SALT_B64, VERIFIER_B64)).toThrow(
      /challenge must be exactly 32 bytes/,
    );
    expect(() => kitRebindSignedBytes(ORIGIN, SHORT_B64, IDENTITY_KEY_B64)).toThrow(
      /challenge must be exactly 32 bytes/,
    );
  });

  it('a short salt throws', () => {
    expect(() => kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SHORT_B64, VERIFIER_B64)).toThrow(
      /salt must be exactly 32 bytes/,
    );
  });

  it('a short verifier throws', () => {
    expect(() => kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, SHORT_B64)).toThrow(
      /verifier must be exactly 32 bytes/,
    );
  });

  it('an over-long field throws too', () => {
    expect(() => kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, SALT_B64, LONG_B64)).toThrow(
      /verifier must be exactly 32 bytes/,
    );
  });

  it('a field outside the base64 alphabet throws rather than dropping a byte', () => {
    expect(() => kitRebindSignedBytes(ORIGIN, '!!!!', IDENTITY_KEY_B64)).toThrow();
  });

  it('swapping salt and verifier changes the bytes', () => {
    // The unprefixed concatenation must still be order-sensitive.
    expect(hex(kitEnrollSignedBytes(ORIGIN, CHALLENGE_B64, VERIFIER_B64, SALT_B64))).not.toBe(
      ENROLL_HEX,
    );
  });
});

describe('kit constants', () => {
  it('are the numbers §2 names', () => {
    expect(KIT_SECRET_BYTES).toBe(20); // 160 bits
    expect(KIT_SALT_BYTES).toBe(32);
    expect(KIT_VERIFIER_BYTES).toBe(32);
    expect(KIT_CHALLENGE_BYTES).toBe(32);
    expect(KIT_CHALLENGE_TTL_SECONDS).toBe(120);
    expect(KIT_REBIND_ATTEMPT_LIMIT).toBe(10);
    expect(KIT_REBIND_ATTEMPT_WINDOW_SECONDS).toBe(86400);
  });

  it('the zero-material constant really is 32 zero bytes of canonical base64', () => {
    expect(KIT_ZERO_MATERIAL_B64).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(KIT_ZERO_MATERIAL_B64).toHaveLength(44);
  });
});

describe('kit wire shapes', () => {
  const goodEnroll = {
    challenge: CHALLENGE_B64,
    salt: SALT_B64,
    verifier: VERIFIER_B64,
    signature: 'c2lnbmF0dXJl',
  };

  it('accepts a well-formed enrolment', () => {
    expect(KitEnrollRequest.parse(goodEnroll)).toEqual(goodEnroll);
  });

  it('rejects a salt or verifier that is not exactly 32 canonical bytes', () => {
    expect(KitEnrollRequest.safeParse({ ...goodEnroll, salt: 'AAAA' }).success).toBe(false);
    expect(KitEnrollRequest.safeParse({ ...goodEnroll, verifier: 'AAAA' }).success).toBe(false);
    // Non-canonical: 32 bytes' worth of characters with the unused trailing
    // bits set. `Base64Of32Bytes` refuses the second spelling of the same
    // bytes for the same reason `CanonicalBase64` does — these values are
    // compared as raw strings.
    expect(
      KitEnrollRequest.safeParse({ ...goodEnroll, salt: `${'A'.repeat(43)}=`.replace(/A=$/, 'B=') })
        .success,
    ).toBe(false);
  });

  it('REQUESTS demand an exact-width challenge so a short nonce is a 400, not a 500', () => {
    // The builders THROW on a challenge that is not exactly 32 bytes, and a
    // loose request schema would turn that into an unhandled throw inside the
    // handler. `KitChallengeB64` moves the refusal to the door.
    const short = 'AAECAwQFBgcICQoLDA0ODw==';
    expect(KitEnrollRequest.safeParse({ ...goodEnroll, challenge: short }).success).toBe(false);
    expect(KitDisenrollRequest.safeParse({ challenge: short, signature: 'c2ln' }).success).toBe(
      false,
    );
    expect(RebindRequest.safeParse({ ...goodRebind, challenge: short }).success).toBe(false);
    // The RESPONSE shapes stay loose for forward compatibility.
    expect(RebindChallengeResponse.safeParse({ challenge: short, salt: SALT_B64 }).success).toBe(
      true,
    );
  });

  it('rejects a missing signature', () => {
    const { signature: _omitted, ...withoutSignature } = goodEnroll;
    expect(KitEnrollRequest.safeParse(withoutSignature).success).toBe(false);
  });

  it('a disenrolment carries a challenge and a signature and nothing else it needs', () => {
    expect(
      KitDisenrollRequest.safeParse({ challenge: CHALLENGE_B64, signature: 'c2ln' }).success,
    ).toBe(true);
    expect(KitDisenrollRequest.safeParse({ challenge: CHALLENGE_B64 }).success).toBe(false);
  });

  const goodRebind = {
    userId: '01J1F6ZQ8XKQ9V2M3N4P5R6S7T',
    challenge: CHALLENGE_B64,
    verifier: VERIFIER_B64,
    identityKey: 'BXKr9O1H7wKzL1a1M0lPq8kD7Yt1YQ7QzS4nq0nEo5cX',
    signature: 'c2lnbmF0dXJl',
    registrationId: 1234,
    signedPrekey: { keyId: 1, pub: 'B'.repeat(44), sig: `${'C'.repeat(86)}==` },
    kyberPrekey: { keyId: 1, pub: 'D'.repeat(2092), sig: `${'C'.repeat(86)}==` },
  };

  it('rejects a non-canonical base64 identity key exactly as the auth DTOs do', () => {
    // The key becomes a DynamoDB partition key and is compared by raw string
    // equality, so two spellings of one key is an unrecoverable lockout with a
    // 4xx nobody can diagnose. A real 33-byte key encodes to 44 characters
    // with no padding at all, which is the shape accepted here.
    expect(RebindRequest.safeParse(goodRebind).success).toBe(true);
    expect(goodRebind.identityKey).toHaveLength(44);

    // Padded spellings whose unused trailing bits are SET are the second
    // spelling of the same bytes, and they are the ones that must be refused.
    for (const nonCanonical of [`${'A'.repeat(43)}B=`, `${'A'.repeat(42)}BB==`]) {
      expect(
        RebindRequest.safeParse({ ...goodRebind, identityKey: nonCanonical }).success,
        `${nonCanonical.slice(-4)} is a non-canonical spelling and must be refused`,
      ).toBe(false);
    }
    expect(RebindRequest.safeParse({ ...goodRebind, identityKey: 'not base64!' }).success).toBe(
      false,
    );
    // Unbounded keys are refused too: this value becomes part of a DynamoDB
    // partition key with a 2 KiB limit.
    expect(
      RebindRequest.safeParse({ ...goodRebind, identityKey: 'A'.repeat(400) }).success,
    ).toBe(false);
  });

  it('rejects a userId that is not a ULID', () => {
    expect(RebindRequest.safeParse({ ...goodRebind, userId: 'nope' }).success).toBe(false);
  });

  it('a rebind challenge response admits a decoy salt of exactly the real width', () => {
    // The decoy salt must be indistinguishable from a real one on the wire,
    // so the schema must accept both and must not accept a short one.
    expect(
      RebindChallengeResponse.safeParse({ challenge: CHALLENGE_B64, salt: SALT_B64 }).success,
    ).toBe(true);
    expect(
      RebindChallengeResponse.safeParse({ challenge: CHALLENGE_B64, salt: OTHER_32_B64 }).success,
    ).toBe(true);
    expect(
      RebindChallengeResponse.safeParse({ challenge: CHALLENGE_B64, salt: 'AAAA' }).success,
    ).toBe(false);
    // `expiresAt` is optional on the wire (MSG-W1): a client that predates it
    // must keep parsing.
    expect(
      RebindChallengeResponse.safeParse({
        challenge: CHALLENGE_B64,
        salt: SALT_B64,
        expiresAt: 1_800_000_000,
      }).success,
    ).toBe(true);
  });
});

describe('the namespace stays off the shipped identifier-recovery verb', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'recovery.ts'), 'utf8');

  it('declares no bare RECOVERY_ constant and no Recovery* DTO', () => {
    // The one thing's coexistence note forbids is conflating the
    // two recovery verbs. `RECOVERY_DELAY_SECONDS`, `RecoveryCompleteRequest`
    // and friends already belong to the shipped identifier-recovery verb; a
    // name reappearing here would put two different meanings on one symbol in
    // one barrel.
    const declarations = source.matchAll(
      /export\s+(?:const|function|type|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    );
    const names = [...declarations].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(name, `${name} collides with the shipped recovery namespace`).not.toMatch(
        /^(RECOVERY_|Recovery)/,
      );
      expect(name, `${name} carries no Kit/Rebind prefix`).toMatch(
        /^(KIT_|REBIND_|Kit|Rebind|kit|rebind)/,
      );
    }
  });

  it('the domain tags are not the draft names, which were never minted', () => {
    // Quoted, so the prose above that RECORDS the rename does not trip this.
    expect(source).not.toContain("'tacendum-recovery-enroll-v1'");
    expect(source).not.toContain("'tacendum-recovery-v1'");
  });
});
