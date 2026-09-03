package com.miranatechnologies.tacendum.call

import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The full-screen-intent gate's semantic core, in the shape `TelecomGuardTest`
 * established — the decision with its platform edges injected, so a JVM suite
 * pins what no emulator run demonstrates.
 *
 * What is pinned, and why each pin matters:
 *
 *  - BELOW API 34 THE PLATFORM IS NEVER ASKED: `canUseFullScreenIntent()` does
 *    not exist there, so a reader that is consulted on 26–33 is a
 *    NoSuchMethodError on a device in someone's hand. The gate must answer
 *    "permitted" without touching the reader.
 *  - FROM API 34 THE PLATFORM'S ANSWER IS THE ANSWER, in both directions.
 *  - AN UNREADABLE PLATFORM READS AS PERMITTED: the ring is then posted
 *    exactly as it always was and the system decides. A broken read must
 *    never be able to ADD a Settings action to a ring that would have taken
 *    the lock screen on its own.
 *  - THE FALLBACK ACTION IS THE PLATFORM'S OWN SETTINGS PAGE: the literal is
 *    written out so it compiles on the minSdk-26 floor (the AudioPolicy
 *    idiom), and this pin is what keeps it equal to the SDK's constant.
 *
 * The WIRING — the third action appearing on the posted ring, the tap landing
 * on this app's full-screen-intent page — is device behavior
 * (`NotificationCompat.Builder` needs a real Context) and needs an Android 14+
 * device with the permission revoked: verified by hand on a device. */
class FullScreenIntentGateTest {

  @Test
  fun belowApi34ThePlatformIsNeverAsked() {
    var consulted = false
    val permitted =
        CallNotifications.fullScreenIntentPermitted(sdkInt = 33) {
          consulted = true
          false
        }
    assertTrue(permitted)
    assertFalse("below 34 there is no app-op to read", consulted)
  }

  @Test
  fun fromApi34ThePlatformsYesIsPermitted() {
    assertTrue(CallNotifications.fullScreenIntentPermitted(sdkInt = 34) { true })
  }

  @Test
  fun fromApi34ThePlatformsNoIsRefused() {
    assertFalse(CallNotifications.fullScreenIntentPermitted(sdkInt = 34) { false })
    assertFalse(CallNotifications.fullScreenIntentPermitted(sdkInt = 36) { false })
  }

  @Test
  fun anUnreadablePlatformReadsAsPermitted() {
    assertTrue(
        CallNotifications.fullScreenIntentPermitted(sdkInt = 35) {
          throw IllegalStateException("no notification service on this rig")
        }
    )
  }

  @Test
  fun theFallbackActionIsThePlatformsOwnSettingsPage() {
    assertEquals(
        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
        CallNotifications.ACTION_MANAGE_FULL_SCREEN_INTENT,
    )
  }
}
