package com.miranatechnologies.tacendum.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The FCM wake router. Runs in EVERY build state: the router
 * lives in src/main precisely so a tree without google-services.json still
 * compiles, tests, and audits the logic the conditional service will call.
 *
 * The wire shape under test is the server's
 * (packages/server/src/push/fcm.ts, sendCallWake/sendMessageWake):
 * call = {kind, fromUser, to, ts}; message = {kind, fromUser, ts, msgId, msgType}.
 * `fromUser`, not `from` — `from` is an FCM RESERVED data key Google refuses
 * with 400 INVALID_ARGUMENT (measured against the live API);
 * both sides renamed the key in the same change.
 */
class PushWakeRouterTest {

  private fun mint(): String = "minted-cid"

  // --- call wake ---

  @Test
  fun callWakeRingsUnderAMintedCid() {
    val wake =
        PushWakeRouter.route(
            mapOf(
                "kind" to "call",
                "fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "to" to "01RECIPIENT0000000000000000",
                "ts" to "123",
            ),
            ::mint,
        )

    assertEquals(
        PushWake.CallRing(
            cid = "minted-cid",
            from = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            to = "01RECIPIENT0000000000000000",
        ),
        wake,
    )
  }

  @Test
  fun callWakeWithNoFromStillCarriesItsRecipient() {
    // iOS parity: PushKit's handler defaults an absent `from` to "" and the
    // placeholder says "Incoming call". An anonymous wake must not be a
    // dropped call.
    val wake =
        PushWakeRouter.route(
            mapOf("kind" to "call", "to" to "01RECIPIENT0000000000000000", "ts" to "123"),
            ::mint,
        )

    assertEquals(
        PushWake.CallRing(cid = "minted-cid", from = "", to = "01RECIPIENT0000000000000000"),
        wake,
    )
  }

  @Test
  fun callWakeWithoutARecipientIsIgnored() {
    val wake =
        PushWakeRouter.route(
            mapOf("kind" to "call", "fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            ::mint,
        )

    assertEquals(PushWake.Ignored, wake)
  }

  // --- message wake ---

  @Test
  fun messageWakeCarriesSenderAndBannerIdentity() {
    val wake =
        PushWakeRouter.route(
            mapOf(
                "kind" to "message",
                "fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "ts" to "123",
                "msgId" to "m-01HZX",
                "msgType" to "ciphertext",
            ),
            ::mint,
        )

    assertEquals(
        PushWake.Message(from = "01ARZ3NDEKTSV4RRFFQ69G5FAV", msgId = "m-01HZX"),
        wake,
    )
  }

  @Test
  fun messageWakeWithoutASenderIsIgnored() {
    // No sender means no blocked-gate subject and no attribution: the same
    // refusal notifyMessage makes, one seam earlier.
    val wake =
        PushWakeRouter.route(mapOf("kind" to "message", "msgId" to "m-01HZX"), ::mint)

    assertEquals(PushWake.Ignored, wake)
  }

  @Test
  fun messageWakeWithoutAMsgIdIsIgnored() {
    // msgId is the banner's identity — without it a redelivery would stack
    // banners instead of replacing its own.
    val wake =
        PushWakeRouter.route(
            mapOf("kind" to "message", "fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            ::mint,
        )

    assertEquals(PushWake.Ignored, wake)
  }

  // --- unknown ---

  @Test
  fun unknownKindIsIgnored() {
    assertEquals(
        PushWake.Ignored,
        PushWakeRouter.route(mapOf("kind" to "carrier-pigeon", "fromUser" to "x"), ::mint),
    )
  }

  @Test
  fun absentKindIsIgnored() {
    assertEquals(
        PushWake.Ignored,
        PushWakeRouter.route(mapOf("fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV"), ::mint),
    )
  }

  @Test
  fun emptyPayloadIsIgnored() {
    assertEquals(PushWake.Ignored, PushWakeRouter.route(emptyMap(), ::mint))
  }

  // --- the no-words rule, held as a structural fact ---

  @Test
  fun routedWakesCarryOnlyIds() {
    // A payload stuffed with content-shaped keys yields a wake that carries
    // NONE of them: the router reads kind/fromUser/msgId and everything else
    // ceases to exist. This is "the wake carries no words" as an assertion
    // rather than a comment.
    val hostile =
        mapOf(
            "kind" to "message",
            "fromUser" to "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "msgId" to "m-01HZX",
            "preview" to "the actual words of a message",
            "body" to "more words",
            "title" to "a name",
            "payload" to "AAAA",
        )

    val wake = PushWakeRouter.route(hostile, ::mint)

    assertTrue(wake is PushWake.Message)
    val message = wake as PushWake.Message
    assertEquals("01ARZ3NDEKTSV4RRFFQ69G5FAV", message.from)
    assertEquals("m-01HZX", message.msgId)
    // The sealed type HAS nowhere to put words — this test exists so the day
    // someone adds a field for them, a failing assertion asks why.
  }
}
