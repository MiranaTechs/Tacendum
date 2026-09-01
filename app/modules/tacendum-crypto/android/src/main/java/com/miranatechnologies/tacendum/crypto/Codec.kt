package com.miranatechnologies.tacendum.crypto

import java.util.Base64

/**
 * Base64 on the wire, in one place.
 *
 * The bridge carries binary as base64 strings and structured values as JSON
 * (`NativeTacendumCrypto.ts`), so every byte array that crosses it passes
 * through here. Standard alphabet with padding — the same encoding Swift's
 * `base64EncodedString()` produces, which is what makes the vectors, the
 * server DTOs and the CLI agree.
 *
 * `java.util.Base64` is API 26 and this module's minSdk is 26, so it is
 * available on device and on the host JVM alike — which matters, because the
 * host suites decode the same fixtures the app does.
 *
 * No cryptography here: an encoding is not a cipher.
 */
internal object Codec {
  private val ENCODER: Base64.Encoder = Base64.getEncoder()
  private val DECODER: Base64.Decoder = Base64.getDecoder()

  fun b64(bytes: ByteArray): String = ENCODER.encodeToString(bytes)

  /** Throws [IllegalArgumentException] on anything that is not base64 — the
   * callers turn that into a `crypto_error`, never a default value. */
  fun unb64(text: String): ByteArray = DECODER.decode(text)
}
