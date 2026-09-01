/**
 * Fixture integrity for `packages/shared/blobvectors.json`.
 *
 * This file checks the FIXTURE — shape, provenance, and the byte facts that
 * need no cipher (lengths, framing arithmetic, nonce/key freshness). It
 * performs NO cryptography: packages/shared has none and must not grow any
 * (group-fold.ts's standing comment). The cipher half of the suite lives in
 * `packages/cli/test/attachments.test.ts`, next to the one file permitted to
 * hold the cipher.
 *
 * THE REFUSAL PIN: parity certification is only meaningful against vectors
 * the APP generated — vectors minted from the implementation under test
 * ratify a wrong format twice. `provenance.appSide`
 * is asserted here, so regenerating the fixture from the CLI side turns the
 * gate red instead of quietly weakening it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BlobCase {
  name: string;
  plaintextB64: string;
  keyB64: string;
  blobB64: string;
  appRoundTrip: boolean;
  appRoundTripNote?: string;
}
interface BlobNegative {
  name: string;
  keyB64: string;
  blobB64: string;
  expect: string;
  detail: string;
}
interface BlobFixture {
  note: string;
  provenance: { appSide: boolean; generator: string; libSignalClientPod: string };
  cases: BlobCase[];
  negatives: BlobNegative[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../blobvectors.json', import.meta.url)), 'utf8'),
) as BlobFixture;

const NONCE = 12;
const TAG = 16;
const MIN = NONCE + TAG;

/** Every case the design names: empty, 1 B, 15/16/17 B, >=64 KB,
 * embedded NULs, high-bit bytes. A fixture missing one proves less than the
 * gate claims, so absence is a failure, not a smaller suite. */
const REQUIRED_CASES = [
  'empty',
  'one-byte',
  'fifteen-bytes',
  'sixteen-bytes',
  'seventeen-bytes',
  'embedded-nuls',
  'high-bit-bytes',
  'large-64KiB',
];
const REQUIRED_NEGATIVES: Record<string, string> = {
  'flipped-tag-bit': 'auth',
  'blob-27-bytes': 'blob-length',
  'key-31-bytes': 'key-length',
};

describe('blobvectors.json — provenance', () => {
  it('was generated from the APP side, or parity cannot be certified', () => {
    // If this fails, DO NOT weaken it: regenerate the fixture by driving the
    // app's own blobEncrypt. Vectors
    // from node:crypto would make verify:blob a tautology.
    expect(fixture.provenance.appSide).toBe(true);
    expect(fixture.provenance.generator).toContain('TacendumDev.crypto.blobEncrypt');
  });

  it('records the app-side libsignal it was generated against', () => {
    expect(fixture.provenance.libSignalClientPod).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('blobvectors.json — case inventory', () => {
  it('carries every required case, exactly once', () => {
    const names = fixture.cases.map((c) => c.name);
    expect([...names].sort()).toEqual([...REQUIRED_CASES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries the three named negatives, each declaring WHICH check must fire', () => {
    expect(Object.fromEntries(fixture.negatives.map((n) => [n.name, n.expect]))).toEqual(
      REQUIRED_NEGATIVES,
    );
  });
});

describe('blobvectors.json — byte facts (no cipher involved)', () => {
  it('every blob is nonce(12) + ciphertext + tag(16): length = plaintext + 28, key = 32', () => {
    for (const c of fixture.cases) {
      const pt = Buffer.from(c.plaintextB64, 'base64');
      const blob = Buffer.from(c.blobB64, 'base64');
      const key = Buffer.from(c.keyB64, 'base64');
      expect(blob.length, c.name).toBe(pt.length + MIN);
      expect(key.length, c.name).toBe(32);
    }
  });

  it('the empty case is the legal 28-byte blob', () => {
    const empty = fixture.cases.find((c) => c.name === 'empty');
    expect(Buffer.from(empty!.blobB64, 'base64').length).toBe(MIN);
    expect(Buffer.from(empty!.plaintextB64, 'base64').length).toBe(0);
  });

  it('the large case is >= 64 KiB of plaintext', () => {
    const large = fixture.cases.find((c) => c.name === 'large-64KiB');
    expect(Buffer.from(large!.plaintextB64, 'base64').length).toBeGreaterThanOrEqual(65536);
  });

  it('embedded-nuls has NULs, high-bit-bytes has bytes >= 0x80', () => {
    const nuls = Buffer.from(
      fixture.cases.find((c) => c.name === 'embedded-nuls')!.plaintextB64,
      'base64',
    );
    expect(nuls.includes(0)).toBe(true);
    const high = Buffer.from(
      fixture.cases.find((c) => c.name === 'high-bit-bytes')!.plaintextB64,
      'base64',
    );
    expect([...high].some((b) => b >= 0x80)).toBe(true);
  });

  it('fresh key and fresh nonce per blob — nothing repeats across cases', () => {
    const nonces = fixture.cases.map((c) =>
      Buffer.from(c.blobB64, 'base64').subarray(0, NONCE).toString('hex'),
    );
    const keys = fixture.cases.map((c) => c.keyB64);
    expect(new Set(nonces).size).toBe(fixture.cases.length);
    expect(new Set(keys).size).toBe(fixture.cases.length);
  });

  it('every case was round-tripped through the app', () => {
    // No exceptions: the app's empty-ciphertext crash (pod 0.98.0's slice
    // handling) was fixed and the empty case's round-trip device-proven.
    // A case claiming otherwise means the fixture regressed to a pre-fix era.
    for (const c of fixture.cases) {
      expect(c.appRoundTrip, c.name).toBe(true);
    }
  });

  it('the negatives really are one-bit / one-byte derivations of app-produced bytes', () => {
    const donor = fixture.cases.find((c) => c.name === 'seventeen-bytes')!;
    const donorBlob = Buffer.from(donor.blobB64, 'base64');
    const flipped = Buffer.from(
      fixture.negatives.find((n) => n.name === 'flipped-tag-bit')!.blobB64,
      'base64',
    );
    expect(flipped.length).toBe(donorBlob.length);
    const diffs: number[] = [];
    for (let i = 0; i < donorBlob.length; i++) {
      if (donorBlob[i] !== flipped[i]) diffs.push(i);
    }
    expect(diffs).toHaveLength(1);
    // The flip is inside the 16-byte tag, and by exactly one bit.
    expect(diffs[0]!).toBeGreaterThanOrEqual(donorBlob.length - TAG);
    const xor = (donorBlob[diffs[0]!] ?? 0) ^ (flipped[diffs[0]!] ?? 0);
    expect(xor === 1 || (xor & (xor - 1)) === 0).toBe(true);

    const short = Buffer.from(
      fixture.negatives.find((n) => n.name === 'blob-27-bytes')!.blobB64,
      'base64',
    );
    expect(short.length).toBe(MIN - 1);

    const shortKey = Buffer.from(
      fixture.negatives.find((n) => n.name === 'key-31-bytes')!.keyB64,
      'base64',
    );
    expect(shortKey.length).toBe(31);
  });
});
