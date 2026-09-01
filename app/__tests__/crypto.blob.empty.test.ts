/**
 * Source contract for the empty-attachment-blob crash fix.
 *
 * The legal 28-byte blob — nonce(12) ‖ tag(16), ZERO ciphertext bytes — is a
 * blob `blobEncrypt` can mint, and until this fix `blobDecrypt` crashed the
 * process on it (EXC_BREAKPOINT): libsignal's
 * `Aes256GcmEncryptedData(concatenated:)` slices the ciphertext as
 * `dropFirst(12).dropLast(16)` — a zero-length Data SLICE with a non-zero
 * startIndex — and `decrypt(key:)` hands that slice to
 * `Data.withUnsafeMutableBytes`, which traps on exactly that shape. A
 * crash-on-receive: any peer could down the recipient with a 28-byte
 * attachment.
 *
 * The jest mock for the TurboModule is a stub, so the BEHAVIORAL proof (the
 * empty blob round-trips to zero bytes; a tampered empty blob throws instead
 * of crashing) can only run where the Swift actually executes: the simulator
 * leg of the device verify. What jest CAN hold is the source
 * contract — the guard exists, it materializes non-slice Data, and it did not
 * smuggle in any cryptography while doing so (the cipher call
 * must remain libsignal's own `decrypt(key:)`, tag verification included).
 * Same posture as podfile.pins.test.ts: pin in jest what only a device can
 * prove, so deleting the fix — or "simplifying" it back into the trap — fails
 * on every commit, not on the rare device run.
 */
// `require`, not `import` — the app tsconfig carries no @types/node (matches
// podfile.pins.test.ts and version.test.ts). `export {}` keeps these names
// file-scoped so they cannot collide with the identical declarations there.
export {};

const { readFileSync } = require('fs') as {
  readFileSync: (p: string, enc: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const { Buffer } = require('buffer') as {
  Buffer: { from(s: string, enc: string): { length: number } };
};

const IMPL = join(
  __dirname,
  '..',
  'modules',
  'tacendum-crypto',
  'ios',
  'TacendumCryptoImpl.swift',
);
const VECTORS = join(
  __dirname,
  '..',
  '..',
  'packages',
  'shared',
  'blobvectors.json',
);

/**
 * The body of `func <name>(...)` in `source`, by brace counting from the
 * function's opening brace. Throws (fails the test) when the function is
 * missing — a guard on a function jest cannot find is no guard.
 */
function funcBody(source: string, name: string): string {
  const head = source.indexOf(`func ${name}(`);
  if (head === -1) throw new Error(`func ${name} not found`);
  const open = source.indexOf('{', head);
  if (open === -1) throw new Error(`func ${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`func ${name} body never closes`);
}

describe('empty-attachment-blob crash fix (TacendumCryptoImpl.swift)', () => {
  const swift = readFileSync(IMPL, 'utf8');
  const decryptBody = funcBody(swift, 'blobDecrypt');
  const encryptBody = funcBody(swift, 'blobEncrypt');

  it('found real function bodies (the extractor is not vacuous)', () => {
    // Guards the guard: an extractor matching an empty or wrong region would
    // let every assertion below pass or fail for the wrong reason.
    expect(decryptBody.length).toBeGreaterThan(200);
    expect(encryptBody.length).toBeGreaterThan(100);
    expect(decryptBody).toContain('blobDecrypt key is not a base64 32-byte key');
    expect(encryptBody).toContain('blobEncrypt payload is not base64');
  });

  describe('blobDecrypt', () => {
    it('guards the empty-ciphertext case before the cipher call', () => {
      expect(decryptBody).toContain('ciphertext.isEmpty');
    });

    it('rebuilds the sealed struct from freshly materialized NON-SLICE Data', () => {
      // The crash shape is a zero-length Data slice with non-zero startIndex.
      // The guard must copy each part into a fresh Data — `Data(_:)` copies —
      // and use a fresh empty Data for the ciphertext, the exact shape the
      // encrypt path is device-proven to survive.
      expect(decryptBody).toContain('nonce: Data(sealed.nonce)');
      expect(decryptBody).toContain('ciphertext: Data()');
      expect(decryptBody).toContain('authenticationTag: Data(sealed.authenticationTag)');
    });

    it('still hands the cipher work to libsignal and nothing else (rule 1)', () => {
      // The fix is Data handling, not crypto. Decryption AND tag verification
      // must remain inside libsignal's own high-level call — re-orchestrating
      // them (streaming API, manual verifyTag) or importing another provider
      // here would be new crypto at the exact boundary rule 1 forbids it.
      expect(decryptBody).toContain('sealed.decrypt(key: key)');
      expect(decryptBody).not.toContain('Aes256GcmDecryption(');
      expect(decryptBody).not.toContain('verifyTag');
      expect(decryptBody).not.toContain('CryptoKit');
      expect(decryptBody).not.toContain('CommonCrypto');
    });

    it('does no slicing of its own — slices are the trap, not the fix', () => {
      for (const sliceOp of ['.dropFirst(', '.dropLast(', '.prefix(', '.suffix(']) {
        expect(decryptBody).not.toContain(sliceOp);
      }
    });
  });

  describe('blobEncrypt (the symmetric path, verified and pinned)', () => {
    it('feeds libsignal a fresh non-slice Data — the shape that made empty ENCRYPT safe', () => {
      // Empty plaintext never crashed here, and the reason is load-bearing:
      // Data(base64Encoded:) mints a fresh non-slice Data. Pinned so a
      // refactor that starts slicing the plaintext cannot land silently.
      expect(encryptBody).toContain('Data(base64Encoded: plaintextB64)');
      expect(encryptBody).toContain('Aes256GcmEncryptedData.encrypt(plaintext, key: key)');
      for (const sliceOp of ['.dropFirst(', '.dropLast(', '.prefix(', '.suffix(']) {
        expect(encryptBody).not.toContain(sliceOp);
      }
    });
  });

  describe('the fixtures and the device leg that prove the behavior', () => {
    it('blobvectors.json still carries the legal empty case (28-byte blob)', () => {
      const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
        cases: { name: string; plaintextB64: string; keyB64: string; blobB64: string }[];
      };
      const empty = vectors.cases.find((c) => c.name === 'empty');
      expect(empty).toBeDefined();
      expect(empty!.plaintextB64).toBe('');
      // nonce(12) + tag(16), zero ciphertext bytes — the exact wire shape
      // that crashed, kept as the fixture the simulator leg drives.
      expect(Buffer.from(empty!.blobB64, 'base64').length).toBe(12 + 16);
      expect(Buffer.from(empty!.keyB64, 'base64').length).toBe(32);
    });
  });
});
