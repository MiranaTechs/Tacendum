/**
 * verify:blob — cross-client byte parity for the attachment-blob cipher
 *, BOTH directions, against
 * `packages/shared/blobvectors.json` — vectors generated FROM THE APP SIDE
 * (the fixture suite in packages/shared/test/blobvectors.test.ts pins that
 * provenance; regenerating from the CLI side turns it red).
 *
 * Plus the three MEASURED footguns, each of which the parity
 * vectors are structurally blind to:
 *   - a short auth tag verifying (C1: authTagLength must be on both sides),
 *   - a wrong-length nonce silently accepted (C2),
 *   - tampered plaintext escaping before final() (C3: single-function decrypt).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOB_KEY_BYTES,
  BLOB_MIN_BYTES,
  BLOB_NONCE_BYTES,
  BLOB_TAG_BYTES,
  BlobCipherError,
  decryptBlob,
  encryptBlob,
  probeCipherTagLength,
  probeDecipherRejectsShortTag,
  sealForParityVectors,
} from '../src/attachments.js';

interface BlobCase {
  name: string;
  plaintextB64: string;
  keyB64: string;
  blobB64: string;
}
interface BlobNegative {
  name: string;
  keyB64: string;
  blobB64: string;
  expect: 'auth' | 'blob-length' | 'key-length';
}
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../shared/blobvectors.json', import.meta.url)),
    'utf8',
  ),
) as {
  provenance: { appSide: boolean };
  cases: BlobCase[];
  negatives: BlobNegative[];
};

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

describe('verify:blob — refusal to certify', () => {
  it('certifies parity ONLY against app-side vectors', () => {
    // The shared fixture suite pins the full provenance record; this pin is
    // local so THIS file's green can never outlive the claim it rests on.
    expect(fixture.provenance.appSide).toBe(true);
  });
});

describe('verify:blob — decrypt direction (app wrote, CLI reads)', () => {
  for (const c of fixture.cases) {
    it(`${c.name}: the CLI decrypts the app's blob to the app's plaintext`, () => {
      const out = decryptBlob(b64(c.keyB64), b64(c.blobB64));
      expect(Buffer.from(out).equals(Buffer.from(c.plaintextB64, 'base64'))).toBe(true);
    });
  }
});

describe('verify:blob — encrypt direction (CLI writes what the app wrote)', () => {
  for (const c of fixture.cases) {
    it(`${c.name}: with the fixture's key and pinned nonce, the CLI reproduces the blob byte for byte`, () => {
      const blob = Buffer.from(c.blobB64, 'base64');
      const sealed = sealForParityVectors(
        b64(c.keyB64),
        new Uint8Array(blob.subarray(0, BLOB_NONCE_BYTES)),
        new Uint8Array(Buffer.from(c.plaintextB64, 'base64')),
      );
      expect(Buffer.from(sealed).equals(blob)).toBe(true);
    });
  }
});

describe('verify:blob — negatives, each asserting WHICH check fired', () => {
  for (const n of fixture.negatives) {
    it(`${n.name}: rejected by the '${n.expect}' check and no other`, () => {
      let thrown: unknown;
      try {
        decryptBlob(b64(n.keyB64), b64(n.blobB64));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BlobCipherError);
      expect((thrown as BlobCipherError).check).toBe(n.expect);
    });
  }
});

describe('footgun 1 (C1): authTagLength:16 is live on both constructions', () => {
  it('the decipher REJECTS an 8-byte tag (without authTagLength it verifies — a 2^-32 forgery)', () => {
    expect(probeDecipherRejectsShortTag(8)).toBe(true);
  });
  it('the decipher REJECTS a 4-byte tag', () => {
    expect(probeDecipherRejectsShortTag(4)).toBe(true);
  });
  it('the decipher accepts the one legal length, 16', () => {
    expect(probeDecipherRejectsShortTag(BLOB_TAG_BYTES)).toBe(false);
  });
  it('the cipher produces exactly a 16-byte tag', () => {
    expect(probeCipherTagLength()).toBe(BLOB_TAG_BYTES);
  });
});

describe('footgun 2 (C2): key/nonce lengths are asserted in code, not only in vectors', () => {
  const key = new Uint8Array(BLOB_KEY_BYTES);
  const pt = new Uint8Array([1, 2, 3]);

  it('a 16-byte nonce throws (node silently accepts wrong-length IVs without this)', () => {
    let thrown: unknown;
    try {
      sealForParityVectors(key, new Uint8Array(16), pt);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BlobCipherError);
    expect((thrown as BlobCipherError).check).toBe('nonce-length');
  });

  it('an 8-byte nonce throws', () => {
    let thrown: unknown;
    try {
      sealForParityVectors(key, new Uint8Array(8), pt);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as BlobCipherError).check).toBe('nonce-length');
  });

  it('a 31-byte key throws on the encrypt path too', () => {
    let thrown: unknown;
    try {
      sealForParityVectors(new Uint8Array(31), new Uint8Array(BLOB_NONCE_BYTES), pt);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as BlobCipherError).check).toBe('key-length');
  });

  it('the error names lengths and carries no bytes', () => {
    try {
      sealForParityVectors(key, new Uint8Array(16), pt);
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('12');
      expect(msg).toContain('16');
      // No hex, no base64 of key material — the message is fixed prose plus
      // two decimal lengths.
      expect(msg).toMatch(/^attachment nonce must be 12 bytes; got 16$/);
    }
  });
});

describe('footgun 3 (C3): tampered ciphertext yields NOTHING', () => {
  it('a tampered ciphertext byte -> auth error, and no plaintext fragment escapes anywhere', () => {
    const plaintext = new Uint8Array(Buffer.from('hello attachment, this must never leak', 'utf8'));
    const { key, blob } = encryptBlob(plaintext);
    const tampered = Buffer.from(blob);
    // Flip a CIPHERTEXT byte (not the tag): this is exactly the measured
    // case where update() returned readable tampered plaintext before
    // final() threw. decryptBlob's single-function shape means the update()
    // output cannot escape; the only observable is the error.
    tampered[BLOB_NONCE_BYTES] = (tampered[BLOB_NONCE_BYTES] ?? 0) ^ 0x01;
    let thrown: unknown;
    let escaped: Uint8Array | undefined;
    try {
      escaped = decryptBlob(key, new Uint8Array(tampered));
    } catch (err) {
      thrown = err;
    }
    expect(escaped).toBeUndefined();
    expect(thrown).toBeInstanceOf(BlobCipherError);
    expect((thrown as BlobCipherError).check).toBe('auth');
    // Zero plaintext escape, asserted on the one channel a throw carries:
    // the message is fixed prose with no interpolation at all.
    expect((thrown as Error).message).toBe('attachment blob failed authentication');
    expect((thrown as Error).message).not.toContain('hello');
  });

  it('a flipped tag bit on the CLI\'s own output -> auth error too', () => {
    const { key, blob } = encryptBlob(new Uint8Array([9, 9, 9]));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x80;
    expect(() => decryptBlob(key, new Uint8Array(tampered))).toThrowError(BlobCipherError);
  });
});

describe('encryptBlob — the real path (mint, seal, verify)', () => {
  it('round-trips, with fresh key and nonce per call', () => {
    const pt = new Uint8Array(Buffer.from('two calls, two keys', 'utf8'));
    const a = encryptBlob(pt);
    const b = encryptBlob(pt);
    expect(Buffer.from(decryptBlob(a.key, a.blob)).equals(Buffer.from(pt))).toBe(true);
    expect(Buffer.from(decryptBlob(b.key, b.blob)).equals(Buffer.from(pt))).toBe(true);
    expect(Buffer.from(a.key).equals(Buffer.from(b.key))).toBe(false);
    expect(
      Buffer.from(a.blob.subarray(0, BLOB_NONCE_BYTES)).equals(
        Buffer.from(b.blob.subarray(0, BLOB_NONCE_BYTES)),
      ),
    ).toBe(false);
  });

  it('an empty plaintext seals to the legal 28-byte blob and decrypts back (the APP once crashed on this — see blobvectors.json)', () => {
    const { key, blob } = encryptBlob(new Uint8Array(0));
    expect(blob.length).toBe(BLOB_MIN_BYTES);
    expect(decryptBlob(key, blob).length).toBe(0);
  });

  it('refuses a plaintext whose base64 ciphertext would exceed MAX_ATTACHMENT_BYTES, naming lengths', () => {
    // 8 MB of zeros: raw blob 8 MB + 28, base64 ~10.67 MB > the 10 MB cap.
    let thrown: unknown;
    try {
      encryptBlob(new Uint8Array(8 * 1024 * 1024));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BlobCipherError);
    expect((thrown as BlobCipherError).check).toBe('too-large');
    expect((thrown as Error).message).toMatch(/^attachment of \d+ bytes/);
  });
});
