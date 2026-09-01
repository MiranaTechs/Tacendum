package com.miranatechnologies.tacendum.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The anchor suite for attachment crypto: the attachment
 * blob's framing, its length assertions, its verify-before-release ordering,
 * and byte parity with the vectors the iOS app minted.
 *
 * It runs the REAL libsignal cipher on the host JVM — the libsignal-client jar
 * carries desktop natives — so these are not shape assertions over a mock.
 * That matters most for the parity cases: they are the only check that the
 * Kotlin framing produces the same bytes the shipped iOS build produced, and
 * they check the ENCRYPT direction byte-exactly because the fixture pins the
 * nonce inside its own blob.
 */
class BlobFramingTest {

  // --- framing ---------------------------------------------------------

  @Test
  fun `blob is nonce then ciphertext then tag with no version byte`() {
    for (size in listOf(0, 1, 15, 16, 17, 1024)) {
      val plaintext = ByteArray(size) { (it and 0xFF).toByte() }
      val sealed = BlobCipher.seal(plaintext)
      assertEquals(
          "a $size-byte plaintext must seal to nonce(12) + $size + tag(16) — a version byte " +
              "inside the blob is forbidden",
          BlobCipher.NONCE_BYTES + size + BlobCipher.TAG_BYTES,
          sealed.blob.size,
      )
      assertEquals(BlobCipher.KEY_BYTES, sealed.key.size)
      assertArrayEquals(plaintext, BlobCipher.open(sealed.key, sealed.blob))
    }
  }

  @Test
  fun `the empty plaintext seals to a legal 28-byte blob`() {
    // Load-bearing: the `empty` vector in blobvectors.json was minted by this
    // exact shape, and the Swift binding once CRASHED on it. A peer can send
    // one, so the decrypt side must survive it too.
    val sealed = BlobCipher.seal(ByteArray(0))
    assertEquals(BlobCipher.MIN_BLOB_BYTES, sealed.blob.size)
    assertEquals(0, BlobCipher.open(sealed.key, sealed.blob).size)
  }

  @Test
  fun `every seal mints a fresh key and a fresh nonce`() {
    // The parity vectors pin injected nonces and never exercise the minting
    // path; without this, a wrong-length or constant mint ships green.
    val plaintext = "the same bytes twice".toByteArray()
    val first = BlobCipher.seal(plaintext)
    val second = BlobCipher.seal(plaintext)
    assertFalse("two seals reused a key", first.key.contentEquals(second.key))
    assertFalse(
        "two seals reused a nonce",
        first.blob.copyOfRange(0, 12).contentEquals(second.blob.copyOfRange(0, 12)),
    )
    assertNotEquals(Fixtures.hex(first.blob), Fixtures.hex(second.blob))
  }

  // --- the length assertions -------------------------------------------

  @Test
  fun `lengths are asserted in code, not left to the binding`() {
    val shortOpenKey = ByteArray(31) { (it + 1).toByte() }
    val minimumBlob = ByteArray(28) { (it + 33).toByte() }
    assertCheck(BlobCipher.Check.KEY_LENGTH, shortOpenKey, minimumBlob) {
      BlobCipher.open(shortOpenKey, minimumBlob)
    }

    val shortSealKey = ByteArray(16) { (it + 65).toByte() }
    val validNonce = ByteArray(12) { (it + 97).toByte() }
    assertCheck(BlobCipher.Check.KEY_LENGTH, shortSealKey, validNonce) {
      BlobCipher.sealWithNonce(shortSealKey, validNonce, ByteArray(0))
    }

    val validKey = ByteArray(32) { (it + 129).toByte() }
    val longNonce = ByteArray(16) { (it + 161).toByte() }
    assertCheck(BlobCipher.Check.NONCE_LENGTH, validKey, longNonce) {
      BlobCipher.sealWithNonce(validKey, longNonce, ByteArray(0))
    }
    val emptyNonce = ByteArray(0)
    assertCheck(BlobCipher.Check.NONCE_LENGTH, validKey, emptyNonce) {
      BlobCipher.sealWithNonce(validKey, emptyNonce, ByteArray(0))
    }
    // 27 bytes cannot be nonce+tag: a torn blob is a length error, never an
    // authentication error, so the caller can tell truncation from tamper.
    val tornBlob = ByteArray(27) { (it + 193).toByte() }
    assertCheck(BlobCipher.Check.BLOB_LENGTH, validKey, tornBlob) {
      BlobCipher.open(validKey, tornBlob)
    }
  }

  @Test
  fun `a plaintext over the attachment cap is refused before any cipher runs`() {
    val overCap = ByteArray(BlobCipher.MAX_ATTACHMENT_BYTES)
    assertCheck(BlobCipher.Check.TOO_LARGE) { BlobCipher.seal(overCap) }
  }

  // --- verify-before-release -------------------------------------------

  @Test
  fun `a tampered ciphertext yields an authentication failure and no plaintext`() {
    val plaintext = "attachment bytes an agent would act on".toByteArray()
    val sealed = BlobCipher.seal(plaintext)
    // Flip a bit in the ciphertext body, in the tag, and in the nonce; each
    // must fail the tag check, and NONE may return bytes.
    for (index in listOf(BlobCipher.NONCE_BYTES, sealed.blob.size - 1, 0)) {
      val tampered = sealed.blob.copyOf()
      tampered[index] = (tampered[index].toInt() xor 0x01).toByte()
      assertCheck(
          BlobCipher.Check.AUTH,
          sealed.key,
          tampered.copyOfRange(0, BlobCipher.NONCE_BYTES),
          tampered.copyOfRange(BlobCipher.NONCE_BYTES, tampered.size - BlobCipher.TAG_BYTES),
          tampered.copyOfRange(tampered.size - BlobCipher.TAG_BYTES, tampered.size),
      ) {
        BlobCipher.open(sealed.key, tampered)
      }
    }
  }

  @Test
  fun `the wrong key authenticates nothing`() {
    val sealed = BlobCipher.seal("hello".toByteArray())
    val wrongKey = sealed.key.copyOf()
    wrongKey[0] = (wrongKey[0].toInt() xor 0xFF).toByte()
    assertCheck(
        BlobCipher.Check.AUTH,
        wrongKey,
        sealed.blob.copyOfRange(0, BlobCipher.NONCE_BYTES),
        sealed.blob.copyOfRange(BlobCipher.NONCE_BYTES, sealed.blob.size - BlobCipher.TAG_BYTES),
        sealed.blob.copyOfRange(sealed.blob.size - BlobCipher.TAG_BYTES, sealed.blob.size),
    ) {
      BlobCipher.open(wrongKey, sealed.blob)
    }
  }

  @Test
  fun `open copies the ciphertext instead of decrypting the caller's blob in place`() {
    // The binding decrypts IN PLACE. If `open` handed it a view of the
    // caller's array, a successful decrypt would leave the caller holding
    // PLAINTEXT where it put ciphertext, and a failed one would leave it
    // holding unauthenticated bytes. Both are the same defect.
    val sealed = BlobCipher.seal("in place would be a leak".toByteArray())
    val before = sealed.blob.copyOf()
    BlobCipher.open(sealed.key, sealed.blob)
    assertArrayEquals("open mutated the blob it was given", before, sealed.blob)

    val tampered = sealed.blob.copyOf()
    tampered[tampered.size - 1] = (tampered[tampered.size - 1].toInt() xor 0x01).toByte()
    val tamperedBefore = tampered.copyOf()
    assertCheck(
        BlobCipher.Check.AUTH,
        sealed.key,
        tampered.copyOfRange(0, BlobCipher.NONCE_BYTES),
        tampered.copyOfRange(BlobCipher.NONCE_BYTES, tampered.size - BlobCipher.TAG_BYTES),
        tampered.copyOfRange(tampered.size - BlobCipher.TAG_BYTES, tampered.size),
    ) {
      BlobCipher.open(sealed.key, tampered)
    }
    assertArrayEquals("a failed open mutated the blob", tamperedBefore, tampered)
  }

  // --- byte parity with the app-minted vectors -------------------------

  @Test
  fun `blob vectors round-trip byte-for-byte in both directions`() {
    val vectors = Fixtures.require("packages/shared/blobvectors.json")
    assertTrue(
        "blobvectors.json must be generated FROM THE APP SIDE — parity against vectors this " +
            "implementation produced proves nothing",
        vectors.getJSONObject("provenance").getBoolean("appSide"),
    )
    val cases = vectors.getJSONArray("cases")
    assertTrue("blobvectors.json has no cases", cases.length() >= 1)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val plaintext = Codec.unb64(c.getString("plaintextB64"))
      val key = Codec.unb64(c.getString("keyB64"))
      val blob = Codec.unb64(c.getString("blobB64"))

      // DECRYPT direction.
      assertArrayEquals("case $name decrypted to different bytes", plaintext, BlobCipher.open(key, blob))

      // ENCRYPT direction, byte-exactly: the fixture pins the nonce as the
      // first 12 blob bytes, so the whole framing — nonce placement, empty
      // AAD, tag position — is checked, not just the cipher.
      val nonce = blob.copyOfRange(0, BlobCipher.NONCE_BYTES)
      assertEquals(
          "case $name re-sealed to different bytes",
          Fixtures.hex(blob),
          Fixtures.hex(BlobCipher.sealWithNonce(key, nonce, plaintext)),
      )
    }
  }

  @Test
  fun `the negative vectors fail the check they name`() {
    val vectors = Fixtures.require("packages/shared/blobvectors.json")
    val negatives = vectors.getJSONArray("negatives")
    assertTrue("blobvectors.json has no negative cases", negatives.length() >= 1)
    for (i in 0 until negatives.length()) {
      val c = negatives.getJSONObject(i)
      val key = Codec.unb64(c.getString("keyB64"))
      val blob = Codec.unb64(c.getString("blobB64"))
      try {
        BlobCipher.open(key, blob)
        fail("negative case ${c.getString("name")} decrypted successfully")
      } catch (err: BlobCipher.BlobCipherException) {
        val expected = c.getString("expect")
        assertEquals(
            "negative case ${c.getString("name")} fired the wrong guard",
            expected,
            err.check.name.lowercase().replace('_', '-'),
        )
      }
    }
  }

  @Test
  fun `payload leak detection covers short common encodings deterministically`() {
    val payload =
        byteArrayOf(
            0xFB.toByte(),
            0xFF.toByte(),
            0xEF.toByte(),
            0x01,
            0x23,
            0x45,
            0x67,
            0x89.toByte(),
            0xAB.toByte(),
            0xCD.toByte(),
            0xEF.toByte(),
        )
    for (length in 8..11) {
      val leaked = payload.copyOf(length)
      val encodings =
          mapOf(
              "hex" to Fixtures.hex(leaked),
              "base64" to java.util.Base64.getEncoder().encodeToString(leaked),
              "unpadded base64" to
                  java.util.Base64.getEncoder().withoutPadding().encodeToString(leaked),
              "URL-safe base64" to java.util.Base64.getUrlEncoder().encodeToString(leaked),
              "unpadded URL-safe base64" to
                  java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(leaked),
          )
      for ((encoding, text) in encodings) {
        assertPayloadLeakRejected("attachment bytes: $text", payload, "$length-byte $encoding")
      }
    }
  }

  private fun assertCheck(
      expected: BlobCipher.Check,
      vararg payloads: ByteArray,
      body: () -> Unit,
  ) {
    try {
      body()
      fail("expected $expected, but the call succeeded")
    } catch (err: BlobCipher.BlobCipherException) {
      assertEquals(expected, err.check)
      // An error names lengths, never bytes. Decode payload-shaped
      // tokens before comparing them so short or URL-safe Base64 leaks cannot
      // hide behind padding or three-byte grouping boundaries.
      assertNoEncodedPayload(err.message.orEmpty(), payloads)
    }
  }

  private fun assertNoEncodedPayload(message: String, payloads: Array<out ByteArray>) {
    val minimumLeakBytes = 8
    val material = payloads.filter { it.size >= minimumLeakBytes }
    if (material.isEmpty()) return

    val messageBytes = message.toByteArray(Charsets.UTF_8)
    for (offset in 0..messageBytes.size - minimumLeakBytes) {
      val candidate = messageBytes.copyOfRange(offset, offset + minimumLeakBytes)
      assertFalse(
          "an error message carried actual payload bytes directly",
          material.any { it.containsBytes(candidate) },
      )
    }

    for (match in Regex("(?i)[0-9a-f]{16,}").findAll(message)) {
      val token = match.value
      for (offset in 0..token.length - 16) {
        val candidate = token.substring(offset, offset + 16).hexBytes()
        assertFalse(
            "an error message carried actual payload bytes as hex",
            material.any { it.containsBytes(candidate) },
        )
      }
    }

    for (match in Regex("[A-Za-z0-9+/_-]{11,}={0,2}").findAll(message)) {
      val token = match.value.trimEnd('=')
      for (encodedLength in listOf(11, 12)) {
        if (token.length < encodedLength) continue
        for (offset in 0..token.length - encodedLength) {
          val encoded = token.substring(offset, offset + encodedLength)
          for (decoder in listOf(java.util.Base64.getDecoder(), java.util.Base64.getUrlDecoder())) {
            val padded = encoded + "=".repeat((4 - encoded.length % 4) % 4)
            val candidate = runCatching { decoder.decode(padded) }.getOrNull() ?: continue
            if (candidate.size < minimumLeakBytes) continue
            assertFalse(
                "an error message carried actual payload bytes as base64",
                material.any { it.containsBytes(candidate) },
            )
          }
        }
      }
    }
  }

  private fun ByteArray.containsBytes(candidate: ByteArray): Boolean {
    if (candidate.isEmpty() || candidate.size > size) return false
    outer@ for (offset in 0..size - candidate.size) {
      for (i in candidate.indices) {
        if (this[offset + i] != candidate[i]) continue@outer
      }
      return true
    }
    return false
  }

  private fun String.hexBytes(): ByteArray =
      ByteArray(length / 2) { index -> substring(index * 2, index * 2 + 2).toInt(16).toByte() }

  private fun assertPayloadLeakRejected(message: String, payload: ByteArray, label: String) {
    var rejected = false
    try {
      assertNoEncodedPayload(message, arrayOf(payload))
    } catch (expected: AssertionError) {
      rejected = true
    }
    assertTrue("payload detector accepted a $label leak", rejected)
  }
}
