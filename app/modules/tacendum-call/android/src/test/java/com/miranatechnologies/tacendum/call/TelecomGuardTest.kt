package com.miranatechnologies.tacendum.call

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The telecom guard's semantic core.
 *
 * What is pinned, and why each pin matters:
 *
 *  - FAIL-CLOSED ON SILENCE: before any register() verdict exists, calls are
 *    refused — the ruled fail direction. A future caller that forgets to record
 *    can only make calls refuse loudly, never ring a device that cannot
 *    carry one.
 *  - LATEST-WINS, in both directions: a refusal heals on the next successful
 *    registration (register() runs on every module construction and every
 *    call-wake), and a success closes on the next refusal.
 *  - THE SEAM IS DEBUG-ONLY, DISCONNECTED NOT MERELY UNSET: a Release build
 *    never consults the settings reader at all — the harness's refusal
 *    switch cannot exist for a build in someone's hand.
 *  - AN UNREADABLE SEAM IS AN ABSENT SEAM: a reader that throws reads as
 *    "not forced". The seam exists to synthesize refusals on a rig where the
 *    real class is unreachable (google_apis images
 *    cannot shed Telecom); a broken settings read must never be able to
 *    refuse calls for real.
 *
 * The guard's WIRING — reportFresh/reportOutgoingCall answering the refusal
 * verdict, the wake still emitting voipPush, messaging untouched — is device
 * behavior (`TelecomCenter` needs a main looper) and is carried by
 * A telecom-guard leg of the device verification, on the emulator,
 * through the seam this suite pins.
 */
class TelecomGuardTest {

  @Before
  fun fresh() {
    TelecomGuard.resetForTest()
  }

  @After
  fun tidy() {
    TelecomGuard.resetForTest()
  }

  @Test
  fun failsClosedBeforeAnyVerdict() {
    assertNull(TelecomGuard.telecomAvailable())
    assertFalse(TelecomGuard.callsPermitted())
  }

  @Test
  fun aSuccessfulRegistrationPermitsCalls() {
    TelecomGuard.recordVerdict(true)
    assertEquals(true, TelecomGuard.telecomAvailable())
    assertTrue(TelecomGuard.callsPermitted())
  }

  @Test
  fun aRefusedRegistrationRefusesCalls() {
    TelecomGuard.recordVerdict(false)
    assertEquals(false, TelecomGuard.telecomAvailable())
    assertFalse(TelecomGuard.callsPermitted())
  }

  @Test
  fun aRefusalHealsOnTheNextSuccessfulRegistration() {
    TelecomGuard.recordVerdict(false)
    TelecomGuard.recordVerdict(true)
    assertTrue(TelecomGuard.callsPermitted())
  }

  @Test
  fun aSuccessClosesOnTheNextRefusal() {
    TelecomGuard.recordVerdict(true)
    TelecomGuard.recordVerdict(false)
    assertFalse(TelecomGuard.callsPermitted())
  }

  @Test
  fun theSeamIsDisconnectedOutsideDebugBuilds() {
    var consulted = false
    val forced =
        TelecomGuard.refusalForced(debugBuild = false) {
          consulted = true
          true
        }
    assertFalse(forced)
    assertFalse("a Release build must not even read the seam", consulted)
  }

  @Test
  fun theSeamForcesARefusalInDebugBuilds() {
    assertTrue(TelecomGuard.refusalForced(debugBuild = true) { true })
  }

  @Test
  fun anUnsetSeamForcesNothing() {
    assertFalse(TelecomGuard.refusalForced(debugBuild = true) { false })
  }

  @Test
  fun anUnreadableSeamReadsAsAbsent() {
    assertFalse(
        TelecomGuard.refusalForced(debugBuild = true) {
          throw IllegalStateException("no settings provider on this rig")
        }
    )
  }
}
