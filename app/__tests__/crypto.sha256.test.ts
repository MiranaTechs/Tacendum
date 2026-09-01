/**
 * The platform digest, and the one property that actually matters about it:
 * **CryptoKit and `node:crypto` must produce identical bytes.**
 *
 * The roster digest is computed independently
 * by every sender and compared by every receiver. Two implementations that
 * disagree do not produce a subtle bug — they produce *"You and Ben disagree
 * about who is in this room"* on honest traffic, permanently, which trains the
 * person to ignore the one signal that detects a real equivocation attack.
 * That is why this method exists at all, and why it is pinned to standard
 * vectors rather than to whatever the two bindings happen to agree on today.
 *
 * The design sanctions this primitive **solely** for `rd`.
 */

import { sha256 } from '../modules/tacendum-crypto/src/index';

/** The FIPS 180-4 vectors. Any conforming SHA-256 hits these exactly. */
const VECTORS: ReadonlyArray<{ name: string; input: string; hex: string }> = [
  {
    name: 'the empty input (zero bytes is a valid message, not an error)',
    input: '',
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    name: '"abc"',
    input: 'abc',
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    name: 'the 448-bit multi-block vector',
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
];

const hex = (bytes: Uint8Array): string =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * ASCII by hand rather than `TextEncoder`: the app's tsconfig carries no DOM
 * or node lib, and every vector here is ASCII by construction.
 */
const utf8 = (s: string): Uint8Array =>
  Uint8Array.from([...s].map(c => c.charCodeAt(0)));

describe('sha256 — the platform digest behind the roster digest', () => {
  test.each(VECTORS)('matches the published vector for $name', async ({ input, hex: want }) => {
    expect(hex(await sha256(utf8(input)))).toBe(want);
  });

  test('returns the full 32-byte digest — truncation belongs to rosterDigest, not here', async () => {
    // `rd` is the first 8 bytes, but that cut is made in @tacendum/shared so
    // the CLI shares one copy of it. A bridge that truncated would silently
    // give the two clients different digests.
    expect((await sha256(utf8('anything'))).length).toBe(32);
  });

  test('hashes the BYTES, not their base64 transport encoding', async () => {
    // The bridge carries base64 because a TurboModule cannot pass raw bytes.
    // If either side hashed the transport string instead of decoding it first,
    // every vector above would still be self-consistent within one binding and
    // wrong across the two. This pins the decode explicitly.
    const bytes = new Uint8Array([0x61, 0x62, 0x63]); // 'abc'
    const asBase64Text = utf8('YWJj'); // what 'abc' looks like on the wire
    const digestOfBytes = hex(await sha256(bytes));
    const digestOfTransport = hex(await sha256(asBase64Text));
    expect(digestOfBytes).toBe(VECTORS[1]!.hex);
    expect(digestOfTransport).not.toBe(digestOfBytes);
  });

  test('a byte that is not valid UTF-8 still hashes — this takes bytes, not text', async () => {
    // Member ids are ASCII today, but the preimage is a byte string by
    // definition and a digest that only accepted text would be a trap for
    // whatever hashes a non-ULID one day.
    const raw = new Uint8Array([0x00, 0xff, 0x80, 0xfe]);
    // node:crypto over the same four bytes; the device proves CryptoKit agrees.
    // `update` takes a Uint8Array directly — no Buffer, which the app's
    // tsconfig has no types for.
    const viaNode = require('crypto').createHash('sha256').update(raw).digest('hex') as string;
    expect(hex(await sha256(raw))).toBe(viaNode);
  });

  test('is deterministic across calls', async () => {
    const a = hex(await sha256(utf8('kitchen')));
    const b = hex(await sha256(utf8('kitchen')));
    expect(a).toBe(b);
  });
});
