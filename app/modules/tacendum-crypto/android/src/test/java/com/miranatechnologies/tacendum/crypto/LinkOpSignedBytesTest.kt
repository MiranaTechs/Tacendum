package com.miranatechnologies.tacendum.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The Kotlin link-op preimage against `packages/shared/linkvectors.json` —
 * the [AuthSignedBytesTest] discipline applied to the `tacendum-link-v1`
 * op-framed construction, for Android
 * parity: `linkOpSignedBytes()` in packages/shared/src/dto.ts is the
 * authority, [LinkOp] hand-copies it, and nothing at build time checks that
 * the copies agree. Only the MESSAGE is reproduced here; the signature is
 * libsignal's and is proved cross-language by the Swift device-run fixtures
 * (`linkvectors-swift.json`, app/__tests__/link-vectors.test.ts).
 */
class LinkOpSignedBytesTest {

  @Test
  fun `the domain constant matches the vectors`() {
    val vectors = Fixtures.require("packages/shared/linkvectors.json")
    assertEquals(
        "the Kotlin domain and the shared domain are the two halves of one agreement",
        vectors.getString("domain"),
        LinkOp.DOMAIN,
    )
  }

  @Test
  fun `every pinned case reproduces its preimage byte-for-byte, all five ops`() {
    val vectors = Fixtures.require("packages/shared/linkvectors.json")
    val cases = vectors.getJSONArray("cases")
    assertTrue("linkvectors.json has no cases", cases.length() >= 5)
    val seenOps = mutableSetOf<String>()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      seenOps.add(c.getString("op"))
      assertEquals(
          "case ${c.getString("op")} builds different bytes than the shared builder",
          c.getString("preimageHex"),
          Fixtures.hex(
              LinkOp.signedBytes(
                  c.getString("op"),
                  c.getString("groupId"),
                  c.getString("offererUserId"),
                  c.getString("acceptorUserId"),
                  Codec.unb64(c.getString("subjectIdentityPubKey")),
                  c.getString("class"),
                  c.getInt("rosterEpoch").toString(),
                  c.getString("offerNonce"),
                  c.getLong("expiresAt").toString(),
              )),
      )
    }
    assertEquals(
        "the five pinned ops are all exercised",
        LinkOp.OPS,
        seenOps,
    )
  }

  @Test
  fun `the op frame separates ops - one tuple never yields two byte-streams`() {
    val vectors = Fixtures.require("packages/shared/linkvectors.json")
    val c = vectors.getJSONArray("cases").getJSONObject(0)
    fun build(op: String) =
        Fixtures.hex(
            LinkOp.signedBytes(
                op,
                c.getString("groupId"),
                c.getString("offererUserId"),
                c.getString("acceptorUserId"),
                Codec.unb64(c.getString("subjectIdentityPubKey")),
                c.getString("class"),
                c.getInt("rosterEpoch").toString(),
                c.getString("offerNonce"),
                c.getLong("expiresAt").toString(),
            ))
    assertNotEquals("offer and accept must never share bytes", build("offer"), build("accept"))
    assertNotEquals("unlink and revoke must never share bytes", build("unlink"), build("revoke"))
  }

  @Test
  fun `the subject key is raw bytes, never its base64 spelling`() {
    val vectors = Fixtures.require("packages/shared/linkvectors.json")
    val c = vectors.getJSONArray("cases").getJSONObject(0)
    val keyB64 = c.getString("subjectIdentityPubKey")
    val withRaw =
        LinkOp.signedBytes(
            c.getString("op"),
            c.getString("groupId"),
            c.getString("offererUserId"),
            c.getString("acceptorUserId"),
            Codec.unb64(keyB64),
            c.getString("class"),
            c.getInt("rosterEpoch").toString(),
            c.getString("offerNonce"),
            c.getLong("expiresAt").toString(),
        )
    val withSpelling =
        LinkOp.signedBytes(
            c.getString("op"),
            c.getString("groupId"),
            c.getString("offererUserId"),
            c.getString("acceptorUserId"),
            keyB64.toByteArray(Charsets.UTF_8),
            c.getString("class"),
            c.getInt("rosterEpoch").toString(),
            c.getString("offerNonce"),
            c.getLong("expiresAt").toString(),
        )
    assertEquals(c.getString("preimageHex"), Fixtures.hex(withRaw))
    assertNotEquals(
        "signing the base64 spelling must diverge — the easiest possible mistake here",
        Fixtures.hex(withRaw),
        Fixtures.hex(withSpelling),
    )
  }

  @Test
  fun `unknown ops, empty fields, and non-decimal integers are refused`() {
    val subject = byteArrayOf(5, 1, 2, 3)
    for (body in
        listOf<() -> Unit>(
            { LinkOp.signedBytes("adopt", "G", "A", "B", subject, "phone", "0", "N", "1") },
            { LinkOp.signedBytes("offer", "", "A", "B", subject, "phone", "0", "N", "1") },
            { LinkOp.signedBytes("offer", "G", "A", "B", ByteArray(0), "phone", "0", "N", "1") },
            { LinkOp.signedBytes("offer", "G", "A", "B", subject, "phone", "1.5", "N", "1") },
            { LinkOp.signedBytes("offer", "G", "A", "B", subject, "phone", "0", "N", "1e3") },
        )) {
      try {
        body()
        fail("expected a refusal")
      } catch (expected: LinkOp.BadInput) {
        // Refused before anything is signed — a sixth op is a plan amendment,
        // an empty field verifies against nothing anyone meant to say, and
        // an exponent spelling is a formatting decision only TS may make.
      }
    }
  }
}
