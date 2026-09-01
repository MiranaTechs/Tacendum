package com.miranatechnologies.tacendum.call

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The token store's semantic core.
 *
 * What is pinned, and why each pin matters:
 *
 *  - PERSIST-THEN-NOTIFY ordering: the listener path ends in a `getVoipToken`
 *    read, so a token must be readable before the event announcing it.
 *  - The listener is a SLOT: an install replaces, an uninstall silences, and
 *    a rotation with nobody listening still persists — that persistence IS
 *    the delivery for a process whose JS is dead.
 *  - Absence is `''`, never null and never an error — the convention the
 *    whole protocol uses, and what pre-FCM builds return forever.
 *  - Garbage is refused at the boundary: empty and oversize tokens are not
 *    rotations and must not replace a working registration.
 */
class PushTokenStoreTest {

  private class FakePersistence : PushTokenStore.Persistence {
    var stored: String = ""
    var writes = 0

    override fun read(): String = stored

    override fun write(value: String): Boolean {
      stored = value
      writes += 1
      return true
    }
  }

  private lateinit var persistence: FakePersistence

  @Before
  fun fresh() {
    PushTokenStore.resetForTest()
    persistence = FakePersistence()
  }

  @After
  fun tidy() {
    PushTokenStore.resetForTest()
  }

  @Test
  fun absenceReadsAsEmptyString() {
    assertEquals("", PushTokenStore.current(persistence))
  }

  @Test
  fun adoptPersistsBeforeNotifying() {
    var readAtNotify: String? = null
    PushTokenStore.install { readAtNotify = persistence.stored }

    PushTokenStore.adopt(persistence, "fcm-token-alpha:APA91b_example")

    // The listener observed the PERSISTED value — the ordering the module's
    // event emission depends on.
    assertEquals("fcm-token-alpha:APA91b_example", readAtNotify)
    assertEquals("fcm-token-alpha:APA91b_example", PushTokenStore.current(persistence))
  }

  @Test
  fun oneAdoptFeedsTheOneListenerOnce() {
    var calls = 0
    PushTokenStore.install { calls += 1 }

    PushTokenStore.adopt(persistence, "fcm-token-beta")

    assertEquals(1, calls)
  }

  @Test
  fun adoptWithNoListenerStillPersists() {
    PushTokenStore.adopt(persistence, "fcm-token-while-js-is-dead")

    // The next boot's registration reads exactly this — persistence IS the
    // delivery when JavaScript is not running.
    assertEquals("fcm-token-while-js-is-dead", PushTokenStore.current(persistence))
  }

  @Test
  fun installReplacesTheSlot() {
    var first = 0
    var second = 0
    PushTokenStore.install { first += 1 }
    PushTokenStore.install { second += 1 }

    PushTokenStore.adopt(persistence, "fcm-token-gamma")

    // A slot, not a set: a dead module's listener must not survive its
    // replacement (IdleObserver's reasoning, restated as an assertion).
    assertEquals(0, first)
    assertEquals(1, second)
  }

  @Test
  fun uninstallSilencesWithoutForgetting() {
    var calls = 0
    PushTokenStore.install { calls += 1 }
    PushTokenStore.install(null)

    PushTokenStore.adopt(persistence, "fcm-token-delta")

    assertEquals(0, calls)
    assertEquals("fcm-token-delta", PushTokenStore.current(persistence))
  }

  @Test
  fun rotationReplacesTheStoredToken() {
    PushTokenStore.adopt(persistence, "fcm-token-old")
    PushTokenStore.adopt(persistence, "fcm-token-new")

    assertEquals("fcm-token-new", PushTokenStore.current(persistence))
    assertEquals(2, persistence.writes)
  }

  @Test
  fun emptyTokenIsRefused() {
    PushTokenStore.adopt(persistence, "fcm-token-real")
    var calls = 0
    PushTokenStore.install { calls += 1 }

    PushTokenStore.adopt(persistence, "")
    PushTokenStore.adopt(persistence, "   ")

    // Neither the store nor the listener saw the garbage; the working
    // registration survives.
    assertEquals(0, calls)
    assertEquals("fcm-token-real", PushTokenStore.current(persistence))
  }

  @Test
  fun oversizeTokenIsRefused() {
    val oversize = "x".repeat(PushTokenStore.MAX_TOKEN_LENGTH + 1)

    PushTokenStore.adopt(persistence, oversize)

    assertEquals("", PushTokenStore.current(persistence))
  }

  @Test
  fun boundaryLengthTokenIsAccepted() {
    val exact = "y".repeat(PushTokenStore.MAX_TOKEN_LENGTH)

    PushTokenStore.adopt(persistence, exact)

    assertEquals(exact, PushTokenStore.current(persistence))
  }

  @Test
  fun surroundingWhitespaceIsTrimmedNotStored() {
    PushTokenStore.adopt(persistence, "  fcm-token-epsilon\n")

    assertEquals("fcm-token-epsilon", PushTokenStore.current(persistence))
    assertTrue(persistence.stored == "fcm-token-epsilon")
  }
}
