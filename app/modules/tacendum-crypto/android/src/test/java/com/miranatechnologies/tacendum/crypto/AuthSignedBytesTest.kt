package com.miranatechnologies.tacendum.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The Kotlin signer-transcription check — the sibling of
 * the Swift one, and for the same reason: the auth
 * signed-bytes format is now a FIFTH hand-copy (shared TypeScript, the server,
 * the CLI, Swift, Kotlin), nothing at build time checks that they agree, and
 * the last time nobody checked, the origin was missing from one of them.
 *
 * Only the MESSAGE is reproduced here. The signature itself is libsignal's and
 * needs no checking; what has never been executed, and what a mismatch would
 * break silently for every device, is these bytes.
 */
class AuthSignedBytesTest {

  @Test
  fun `the domain constant matches the vectors`() {
    val vectors = Fixtures.require("packages/shared/authvectors.json")
    assertEquals(
        "the Kotlin domain and the shared domain are the two halves of one agreement",
        vectors.getString("domain"),
        AuthChallenge.DOMAIN,
    )
  }

  @Test
  fun `every vector's normalized origin produces the pinned bytes`() {
    val vectors = Fixtures.require("packages/shared/authvectors.json")
    val cases = vectors.getJSONArray("cases")
    assertTrue("authvectors.json has no cases", cases.length() >= 1)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val challenge = Codec.unb64(c.getString("challengeB64"))
      val expected = c.getString("signedBytesHex")

      // NORMALIZED input is the contract: TypeScript normalizes the origin
      // once, in the facade, and the native side appends it verbatim.
      assertEquals(
          "case ${c.getString("origin")} signs different bytes than the shared builder",
          expected,
          Fixtures.hex(AuthChallenge.signedBytes(challenge, c.getString("normalizedOrigin"))),
      )
    }
  }

  @Test
  fun `an un-normalized origin signs DIFFERENT bytes`() {
    // The gap the Swift harness prints as "GAP": if this ever stops being
    // true for a case whose raw and normalized origins differ, normalization
    // has silently become a no-op somewhere and the audience is not pinned.
    val vectors = Fixtures.require("packages/shared/authvectors.json")
    val cases = vectors.getJSONArray("cases")
    var compared = 0
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val raw = c.getString("origin")
      val normalized = c.getString("normalizedOrigin")
      if (raw == normalized) continue
      compared++
      val challenge = Codec.unb64(c.getString("challengeB64"))
      assertNotEquals(
          "case $raw signs the same bytes normalized or not — normalization is doing nothing",
          Fixtures.hex(AuthChallenge.signedBytes(challenge, normalized)),
          Fixtures.hex(AuthChallenge.signedBytes(challenge, raw)),
      )
    }
    assertTrue("no vector exercises the un-normalized path any more", compared >= 1)
  }

  @Test
  fun `the length prefix is two bytes big-endian over the origin`() {
    val challenge = byteArrayOf(1, 2, 3)
    val origin = "https://api.tacendum.com"
    val bytes = AuthChallenge.signedBytes(challenge, origin)
    val domain = AuthChallenge.DOMAIN.toByteArray(Charsets.UTF_8)
    val originBytes = origin.toByteArray(Charsets.UTF_8)
    assertEquals(domain.size + 2 + originBytes.size + challenge.size, bytes.size)
    assertEquals(
        (originBytes.size shr 8) and 0xFF,
        bytes[domain.size].toInt() and 0xFF,
    )
    assertEquals(originBytes.size and 0xFF, bytes[domain.size + 1].toInt() and 0xFF)
  }

  @Test
  fun `the RAW challenge is signed, never its base64 text`() {
    // The easiest possible mistake here, and one that fails only against the
    // deployed server.
    val challenge = byteArrayOf(0, 1, 2, 3)
    val bytes = AuthChallenge.signedBytes(challenge, "https://api.tacendum.com")
    val tail = bytes.copyOfRange(bytes.size - challenge.size, bytes.size)
    assertEquals(Fixtures.hex(challenge), Fixtures.hex(tail))
  }

  @Test
  fun `an empty challenge and an empty origin are refused`() {
    for (body in
        listOf<() -> Unit>(
            { AuthChallenge.signedBytes(ByteArray(0), "https://api.tacendum.com") },
            { AuthChallenge.signedBytes(byteArrayOf(1), "") },
        )) {
      try {
        body()
        fail("expected a refusal")
      } catch (expected: AuthChallenge.BadInput) {
        // An empty audience verifies against nothing, which is exactly the
        // relay the length-prefixed origin exists to close.
      }
    }
  }
}
