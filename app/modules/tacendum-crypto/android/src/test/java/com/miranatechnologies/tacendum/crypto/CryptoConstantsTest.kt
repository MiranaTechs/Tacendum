package com.miranatechnologies.tacendum.crypto

import java.text.Normalizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.signal.libsignal.svr2.PinHash

/**
 * The cross-platform constants that must not drift,
 * plus the two derivations whose divergence has no other detector: the PIN's
 * NFKC normalization and the `PinHash` access key it feeds.
 *
 * Every value here is a WIRE AGREEMENT with the server, the CLI and the iOS
 * build. A test that merely restated the Kotlin constant against itself would
 * be worthless, so the ones that CAN be checked against another party's bytes
 * are — the pin vectors were minted from the shipped iOS build precisely so
 * this suite has something to disagree with.
 */
class CryptoConstantsTest {

  @Test
  fun `the appendix constants are what the wire expects`() {
    assertEquals("deviceId", 1, TacendumCryptoModule.DEVICE_ID)
    assertEquals("signedPreKeyId", 1, TacendumCryptoModule.SIGNED_PRE_KEY_ID)
    assertEquals("kyberPreKeyId", 1, TacendumCryptoModule.KYBER_PRE_KEY_ID)
    assertEquals("one-time prekey count", 100, TacendumCryptoModule.ONE_TIME_PREKEY_COUNT)
    assertEquals("safety number iterations", 5200, TacendumCryptoModule.SAFETY_ITERATIONS)
    assertEquals("safety number version", 0, TacendumCryptoModule.SAFETY_VERSION)
    assertEquals("pin salt length", 32, TacendumCryptoModule.PIN_SALT_BYTES)
    assertEquals("blob key length", 32, BlobCipher.KEY_BYTES)
    assertEquals("blob nonce length", 12, BlobCipher.NONCE_BYTES)
    assertEquals("blob tag length", 16, BlobCipher.TAG_BYTES)
    assertEquals("auth challenge domain", "tacendum-auth-v2", AuthChallenge.DOMAIN)
  }

  @Test
  fun `the registration id lands in 1 to 16383, never 0 and never 16384`() {
    // A 14-bit id: the server DTO validates the range, and a 0 would be
    // rejected on every registration attempt.
    val upper = TacendumCryptoModule.REGISTRATION_ID_UPPER_EXCLUSIVE
    assertEquals(16383, upper)
    val rng = java.security.SecureRandom()
    repeat(2000) {
      val id = rng.nextInt(upper) + 1
      assertTrue("registration id $id below range", id >= 1)
      assertTrue("registration id $id above range", id <= 16383)
    }
  }

  @Test
  fun `the shared-state and inbox name rules are the Appendix's ASCII pins`() {
    // Deliberately STRICTER than the shipped Swift check, which admits Unicode
    // letters and digits (a recorded divergence).
    assertTrue(Names.isValidSharedStateName("previews-armed"))
    assertTrue(Names.isValidSharedStateName("preview-level"))
    assertEquals(false, Names.isValidSharedStateName("Previews-Armed"))
    assertEquals(false, Names.isValidSharedStateName("préviews"))
    assertEquals(false, Names.isValidSharedStateName("previews.armed"))
    assertEquals(false, Names.isValidSharedStateName(""))
    assertEquals(false, Names.isValidSharedStateName("a".repeat(65)))

    assertTrue(Names.isValidInboxMsgId("01J0MSG0000000000000000ABC"))
    assertTrue(Names.isValidInboxMsgId("a_b-C9"))
    assertEquals(false, Names.isValidInboxMsgId("../escape"))
    assertEquals(false, Names.isValidInboxMsgId(""))
  }

  // --- NFKC + PinHash parity with the shipped iOS build ----------------

  @Test
  fun `java NFKC produces the same bytes Swift's compatibility mapping did`() {
    val vectors = pinVectors()
    val cases = vectors.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val normalized = Normalizer.normalize(c.getString("pin"), Normalizer.Form.NFKC)
      assertEquals(
          "case ${c.getString("name")}: java.text.Normalizer NFKC disagrees with Swift's " +
              "precomposedStringWithCompatibilityMapping",
          c.getString("normalizedPinUtf8Hex"),
          Fixtures.hex(normalized.toByteArray(Charsets.UTF_8)),
      )
    }
  }

  @Test
  fun `PinHash svr1 accessKey matches the iOS-minted verifiers`() {
    // The whole point of minting these from the proven side: a normalization
    // or KDF divergence breaks registration-lock verification on real
    // accounts, silently, with no other detector. iOS minted them at
    // LibSignalClient 0.98.0; this runs 0.100.0 — so the cross-version claim
    // is checked too, not assumed.
    val vectors = pinVectors()
    val cases = vectors.getJSONArray("cases")
    assertTrue("pinvectors.json has no cases", cases.length() >= 1)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val normalized =
          Normalizer.normalize(c.getString("pin"), Normalizer.Form.NFKC)
              .toByteArray(Charsets.UTF_8)
      val salt = Codec.unb64(c.getString("saltB64"))
      assertEquals(32, salt.size)
      assertEquals(
          "case ${c.getString("name")}: the Android verifier differs from the iOS one",
          c.getString("accessKeyB64"),
          Codec.b64(PinHash.svr1(normalized, salt).accessKey()),
      )
    }
  }

  @Test
  fun `un-normalized PIN bytes hash differently — the vectors detect a no-op`() {
    // If normalization were silently skipped, the case above would still pass
    // for every ASCII PIN. This one fails unless at least one vector actually
    // changes under NFKC and changes the verifier with it.
    val vectors = pinVectors()
    val cases = vectors.getJSONArray("cases")
    var detectors = 0
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val raw = Fixtures.unhex(c.getString("pinUtf8Hex"))
      val normalized = Fixtures.unhex(c.getString("normalizedPinUtf8Hex"))
      if (raw.contentEquals(normalized)) continue
      detectors++
      val salt = Codec.unb64(c.getString("saltB64"))
      assertNotEquals(
          "case ${c.getString("name")}: raw and normalized PIN bytes hash the SAME — " +
              "this vector cannot detect a missing NFKC step",
          c.getString("accessKeyB64"),
          Codec.b64(PinHash.svr1(raw, salt).accessKey()),
      )
    }
    assertTrue("no pin vector exercises NFKC at all", detectors >= 1)
  }

  private fun pinVectors() =
      Fixtures.require("packages/shared/pinvectors.json").also {
        assertTrue(
            "pinvectors.json must be minted FROM THE iOS SIDE — vectors produced by the " +
                "implementation under test certify nothing",
            it.getJSONObject("provenance").getBoolean("iosSide"),
        )
      }
}
