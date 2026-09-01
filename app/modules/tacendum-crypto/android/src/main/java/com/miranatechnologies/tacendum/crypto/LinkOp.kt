package com.miranatechnologies.tacendum.crypto

/**
 * The bytes a device-linking op signature covers:
 *
 * ```
 * "tacendum-link-v1" ‖ op ‖ groupId ‖ offererUlid ‖ acceptorUlid ‖
 * subjectIdentityPubKey ‖ class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt
 * ```
 *
 * — EVERY field after the domain uint16be-length-prefixed, because none of
 * them is fixed-width and two ULIDs sit adjacent: one field's end being
 * another's beginning is the oldest concatenation bug there is.
 *
 * THIS IS A HAND-COPY of a format whose authority is `linkOpSignedBytes()` in
 * `packages/shared/src/dto.ts`, exactly as [AuthChallenge] hand-copies
 * `authSignedBytes()`. Nothing at build time checks that the copies agree —
 * `packages/shared/linkvectors.json` pins known tuples to expected bytes, and
 * `LinkOpSignedBytesTest` runs this builder against every pinned case on the
 * host JVM. **Change these bytes and you change that suite's vectors in the
 * same commit**, or it goes on passing against its own stale copy and proves
 * nothing.
 *
 * Encodings, pinned (the dto.ts comment, kept in agreement): the op, ids,
 * class, and nonce are UTF-8; `subjectIdentityPubKey` is the RAW serialized
 * key bytes (base64-decoded by the caller — the key IS bytes; signing its
 * base64 spelling would make the signature depend on a transport encoding);
 * the two integers are ASCII decimal, formatted by the TypeScript facade
 * (`String(n)`) and appended verbatim here — exactly one place decides
 * integer formatting, and it is not this one. The digits guard below refuses
 * a float or exponent spelling rather than signing it.
 *
 * NO CRYPTOGRAPHY IN THIS FILE — it assembles a byte
 * string. The signature over it is libsignal's
 * `ECPrivateKey.calculateSignature`, the same primitive that signs the auth
 * challenge and the signed prekey. That separation is what makes the
 * construction host-testable without the JNI library.
 */
internal object LinkOp {
  /**
   * MUST equal `LINK_DOMAIN` in `packages/shared/src/dto.ts` and the Swift
   * `linkOpDomain`. Halves of one agreement: a mismatch compiles cleanly,
   * passes every unit test on both sides, and makes every ceremony signature
   * fail against the deployed server.
   */
  const val DOMAIN = "tacendum-link-v1"

  /** The five ops the domain frames. A sixth op
   * is a plan amendment, refused before anything is signed. */
  val OPS = setOf("offer", "accept", "unlink", "revoke", "dissolve")

  /** The upper bound the u16be length prefix can express. */
  const val MAX_FIELD_BYTES = 0xFFFF

  class BadInput(message: String) : RuntimeException(message)

  fun signedBytes(
      op: String,
      groupId: String,
      offererUserId: String,
      acceptorUserId: String,
      subjectIdentityPubKey: ByteArray,
      deviceClass: String,
      rosterEpoch: String,
      offerNonce: String,
      expiresAt: String,
  ): ByteArray {
    if (op !in OPS) {
      throw BadInput("unknown link op")
    }
    for (integer in listOf(rosterEpoch, expiresAt)) {
      if (integer.isEmpty() || !integer.all { it in '0'..'9' }) {
        throw BadInput("link-op integers must be ASCII decimal")
      }
    }
    val fields =
        listOf(
            op.toByteArray(Charsets.UTF_8),
            groupId.toByteArray(Charsets.UTF_8),
            offererUserId.toByteArray(Charsets.UTF_8),
            acceptorUserId.toByteArray(Charsets.UTF_8),
            subjectIdentityPubKey,
            deviceClass.toByteArray(Charsets.UTF_8),
            rosterEpoch.toByteArray(Charsets.UTF_8),
            offerNonce.toByteArray(Charsets.UTF_8),
            expiresAt.toByteArray(Charsets.UTF_8),
        )
    val domain = DOMAIN.toByteArray(Charsets.UTF_8)
    var total = domain.size
    for (field in fields) {
      if (field.isEmpty() || field.size > MAX_FIELD_BYTES) {
        // An empty field verifies against nothing anyone meant to say, and an
        // oversize one cannot be length-prefixed. Both are caller bugs.
        throw BadInput("link-op field empty or too long")
      }
      total += 2 + field.size
    }
    val message = ByteArray(total)
    var at = 0
    System.arraycopy(domain, 0, message, at, domain.size)
    at += domain.size
    for (field in fields) {
      message[at++] = ((field.size shr 8) and 0xFF).toByte()
      message[at++] = (field.size and 0xFF).toByte()
      System.arraycopy(field, 0, message, at, field.size)
      at += field.size
    }
    return message
  }
}
