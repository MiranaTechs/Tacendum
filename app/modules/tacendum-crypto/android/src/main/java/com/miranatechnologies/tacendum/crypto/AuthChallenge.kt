package com.miranatechnologies.tacendum.crypto

/**
 * The bytes an account challenge is signed over:
 *
 * ```
 * "tacendum-auth-v2" ‖ uint16be(originBytes.size) ‖ originBytes ‖ RAW challenge
 * ```
 *
 * — the RAW DECODED challenge, not the base64 text of it. Signing the base64
 * string instead is the easiest possible mistake here and would fail only
 * against the deployed server, so it is spelled out rather than left to the
 * reader.
 *
 * THIS IS THE FIFTH HAND-COPY of a format whose authority is
 * `authSignedBytes()` in `packages/shared/src/dto.ts`. Nothing at build time
 * checks that five copies agree, which is exactly how the origin came to be
 * missing from one of them. `packages/shared/authvectors.json` pins known
 * inputs to expected bytes, and a host-JVM harness runs
 * [signedBytes] against it — the Kotlin sibling of
 * the Swift transcription check. **Change these bytes and you change
 * that harness in the same commit**, or it goes on passing against its own
 * stale copy and proves nothing.
 *
 * THE ORIGIN IS THE AUDIENCE. Without it a signature is valid at any verifier,
 * so a hostile endpoint could relay a real challenge, collect the signature,
 * and redeem it at the real server as this account. It arrives already
 * normalized from TypeScript (`normalizeOrigin`, the facade) and is appended
 * verbatim: exactly one place decides which server an install talks to, and
 * this is not it.
 *
 * NO CRYPTOGRAPHY IN THIS FILE — it assembles a byte
 * string. The signature over it is libsignal's `ECPrivateKey.calculateSignature`,
 * the same primitive that signs the signed prekey. That separation is what
 * makes the construction host-testable without the JNI library.
 */
internal object AuthChallenge {
  /**
   * MUST equal `AUTH_CHALLENGE_DOMAIN` in `packages/shared/src/dto.ts` and the
   * Swift `authChallengeDomain`. These are the halves of one agreement, and a
   * mismatch compiles cleanly, passes every unit test on both sides, and makes
   * it impossible for anyone to sign in.
   */
  const val DOMAIN = "tacendum-auth-v2"

  /** The upper bound the u16be length prefix can express. */
  const val MAX_ORIGIN_BYTES = 0xFFFF

  class BadInput(message: String) : RuntimeException(message)

  fun signedBytes(challenge: ByteArray, apiOrigin: String): ByteArray {
    if (challenge.isEmpty()) {
      throw BadInput("challenge must not be empty")
    }
    val originBytes = apiOrigin.toByteArray(Charsets.UTF_8)
    if (originBytes.isEmpty() || originBytes.size > MAX_ORIGIN_BYTES) {
      // An empty audience verifies against nothing and would silently restore
      // the relay this length-prefixed field exists to close.
      throw BadInput("apiOrigin must be a non-empty origin")
    }
    val domain = DOMAIN.toByteArray(Charsets.UTF_8)
    val message = ByteArray(domain.size + 2 + originBytes.size + challenge.size)
    var at = 0
    System.arraycopy(domain, 0, message, at, domain.size)
    at += domain.size
    message[at++] = ((originBytes.size shr 8) and 0xFF).toByte()
    message[at++] = (originBytes.size and 0xFF).toByte()
    System.arraycopy(originBytes, 0, message, at, originBytes.size)
    at += originBytes.size
    System.arraycopy(challenge, 0, message, at, challenge.size)
    return message
  }
}
