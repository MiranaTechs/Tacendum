/**
 * @jest-environment ./jest.env.libsignal.js
 *
 * THE CROSS-LANGUAGE LINK-OP PROOF — the byte-compatibility this program's crypto rides
 * on, as a standing regression:
 *
 *   packages/shared/linkvectors-swift.json carries the offer AND accept
 *   tuples preimage-built by the Swift `signLinkOp` construction and SIGNED
 *   by the pinned LibSignalClient pod under the iOS simulator runtime
 *   (minted by scripts/mint-linkvectors.sh — a device-shaped run, never a
 *   Node re-derivation of itself). This suite verifies every Swift signature
 *   under the SERVER's Node libsignal verify — `verifyIdentitySignature`,
 *   the exact export the auth path and every link handler call — and
 *   proves a one-byte preimage mutation FAILS.
 *
 * Three languages, one byte-stream: the TS authority
 * (`linkOpSignedBytes`, packages/shared/src/dto.ts) must reproduce the
 * Swift-built preimage byte-for-byte, and the Swift preimage must equal the
 * TS-minted pin in linkvectors.json for the same tuple. Kotlin's copy is
 * held to the same pin by LinkOpSignedBytesTest on the host JVM. A drift in
 * ANY copy is a hex mismatch here, not a silent cross-client break found on
 * a device.
 */

import { linkOpSignedBytes, type LinkOp } from '@tacendum/shared';
// The server's OWN verify — not a local re-implementation and not bare
// libsignal: the point is that the bytes Swift signs are the bytes the
// deployed verifier checks, so the import reaches into the server package
// (identity-verify.ts, the leaf module auth-account.ts re-exports — one
// symbol, the same call devices-signed.ts makes).
import { verifyIdentitySignature } from '../../packages/server/src/handlers/identity-verify';

const tsVectors = require('../../packages/shared/linkvectors.json') as {
  domain: string;
  cases: SwiftCase[];
};
const swiftVectors = require('../../packages/shared/linkvectors-swift.json') as {
  domain: string;
  provenance: { iosSide: boolean; device: string; libSignalClientPod: string };
  cases: SwiftCase[];
};

interface SwiftCase {
  op: LinkOp;
  groupId: string;
  offererUserId: string;
  acceptorUserId: string;
  subjectIdentityPubKey: string;
  class: 'phone' | 'tablet' | 'desktop';
  rosterEpoch: number;
  offerNonce: string;
  expiresAt: number;
  signerIdentityKeyB64: string;
  preimageHex: string;
  signatureB64: string;
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('Swift-signed link-op fixtures verify under the server verify', () => {
  it('the fixtures are a device run of the pinned pod, offer AND accept', () => {
    expect(swiftVectors.domain).toBe('tacendum-link-v1');
    expect(swiftVectors.provenance.iosSide).toBe(true);
    expect(swiftVectors.provenance.device).toContain('simulator');
    expect(swiftVectors.cases.map(c => c.op).sort()).toEqual(['accept', 'offer']);
  });

  for (const op of ['offer', 'accept'] as const) {
    const c = () => swiftVectors.cases.find(v => v.op === op)!;

    it(`${op}: the TS builder reproduces the Swift-built preimage byte-for-byte`, () => {
      const swift = c();
      const pre = linkOpSignedBytes(swift.op, {
        groupId: swift.groupId,
        offererUserId: swift.offererUserId,
        acceptorUserId: swift.acceptorUserId,
        subjectIdentityPubKey: swift.subjectIdentityPubKey,
        class: swift.class,
        rosterEpoch: swift.rosterEpoch,
        offerNonce: swift.offerNonce,
        expiresAt: swift.expiresAt,
      });
      expect(hexFromBytes(pre)).toBe(swift.preimageHex);
      // ...and the same tuple's TS-minted pin agrees: three languages, one
      // byte-stream — the Swift mint refuses to emit on a mismatch, and this
      // assertion keeps the committed files from drifting apart afterwards.
      const pinned = tsVectors.cases.find(v => v.op === op)!;
      expect(swift.preimageHex).toBe(pinned.preimageHex);
    });

    it(`${op}: the Swift signature verifies under the server's Node libsignal verify`, () => {
      const swift = c();
      const pre = bytesFromHex(swift.preimageHex);
      expect(
        verifyIdentitySignature(swift.signerIdentityKeyB64, pre, swift.signatureB64),
      ).toBe(true);
    });

    it(`${op}: a one-byte preimage mutation FAILS the verify`, () => {
      const swift = c();
      const pre = bytesFromHex(swift.preimageHex);
      // The same coverage discipline the auth vector suite pins: a
      // length-prefix byte, an op-frame byte, a mid-preimage field byte, and
      // the last field byte — never only the fixed domain prefix.
      for (const pos of [16, 18, Math.floor(pre.length / 2), pre.length - 1]) {
        const mutated = Uint8Array.from(pre);
        mutated[pos]! ^= 0x01;
        expect(
          verifyIdentitySignature(swift.signerIdentityKeyB64, mutated, swift.signatureB64),
        ).toBe(false);
      }
    });

    it(`${op}: a truncated and an extended preimage FAIL the verify`, () => {
      const swift = c();
      const pre = bytesFromHex(swift.preimageHex);
      expect(
        verifyIdentitySignature(
          swift.signerIdentityKeyB64,
          pre.subarray(0, pre.length - 1),
          swift.signatureB64,
        ),
      ).toBe(false);
      expect(
        verifyIdentitySignature(
          swift.signerIdentityKeyB64,
          new Uint8Array([...pre, 0]),
          swift.signatureB64,
        ),
      ).toBe(false);
    });
  }
});

/**
 * THE EXTENSION: the CERTIFICATE
 * verification construction the client now runs — rebuild the preimage
 * from the stored tuple CONTEXT with the subject key supplied by the
 * VERIFIER (never by the certificate: GroupMemberCerts deliberately omits
 * it), then verify under the signer's key — driven against the genuine
 * Swift-signed fixtures under genuine libsignal. This is the byte-level
 * proof behind `verifyLinkOp`'s tuple assembly: the native verifier shares
 * the signer's preimage builder, and THIS is the same assembly reproduced
 * from certificate context, so the three constructions cannot drift.
 */
describe('the certificate-verification construction (context + supplied subject)', () => {
  for (const op of ['offer', 'accept'] as const) {
    const c = () => swiftVectors.cases.find(v => v.op === op)!;

    it(`${op}: the cert-context rebuild verifies with the TRUE subject key…`, () => {
      const swift = c();
      // What a peer stores (the cert context) and what it must supply (the
      // subject key it trusts for the certified party) — reassembled
      // exactly as peerDevices.certProvesCandidate does.
      const rebuilt = linkOpSignedBytes(swift.op, {
        groupId: swift.groupId,
        offererUserId: swift.offererUserId,
        acceptorUserId: swift.acceptorUserId,
        subjectIdentityPubKey: swift.subjectIdentityPubKey, // verifier-supplied
        class: swift.class,
        rosterEpoch: swift.rosterEpoch,
        offerNonce: swift.offerNonce,
        expiresAt: swift.expiresAt,
      });
      expect(
        verifyIdentitySignature(swift.signerIdentityKeyB64, rebuilt, swift.signatureB64),
      ).toBe(true);
    });

    it(`${op}: …and a SUBSTITUTED subject key fails — the certificate names WHICH key`, () => {
      const swift = c();
      // The signer's own key as the subject: a plausible-looking key that
      // is NOT the one the ceremony certified.
      const rebuilt = linkOpSignedBytes(swift.op, {
        groupId: swift.groupId,
        offererUserId: swift.offererUserId,
        acceptorUserId: swift.acceptorUserId,
        subjectIdentityPubKey: swift.signerIdentityKeyB64,
        class: swift.class,
        rosterEpoch: swift.rosterEpoch,
        offerNonce: swift.offerNonce,
        expiresAt: swift.expiresAt,
      });
      expect(
        verifyIdentitySignature(swift.signerIdentityKeyB64, rebuilt, swift.signatureB64),
      ).toBe(false);
    });

    it(`${op}: a wrong SIGNER key fails — server storage is availability, never authority`, () => {
      const swift = c();
      const other = swiftVectors.cases.find(v => v.op !== op)!;
      const pre = bytesFromHex(swift.preimageHex);
      expect(
        verifyIdentitySignature(other.signerIdentityKeyB64, pre, swift.signatureB64),
      ).toBe(false);
    });
  }
});
