package com.miranatechnologies.tacendum.call

import android.annotation.SuppressLint
import android.content.Context
import android.os.PowerManager

/**
 * BLANK THE SCREEN AGAINST THE FACE, re-derived for Android.
 *
 * Telecom manages the proximity sensor for the SYSTEM dialer's in-call UI. A
 * self-managed connection shows its own screen and gets nothing: the ongoing
 * call kept the display awake and touch-live against a cheek, End and Mute
 * along its bottom edge. `PROXIMITY_SCREEN_OFF_WAKE_LOCK` is the one lever a
 * self-managed call has — while it is held, the platform turns the display off
 * when the sensor covers and back on when it clears — and `WAKE_LOCK` in the
 * module manifest is its permission.
 *
 * DERIVED, never set by whoever starts or ends a call: `refresh` is handed the
 * three facts and holds the lock exactly while all three are true —
 *  - the audio unit is running (`CallAudioGate.isActive()`: the call is up);
 *  - the route is the EARPIECE. Speaker, a wired headset or Bluetooth mean the
 *    phone is not at the face, and blanking then would blank a screen the
 *    person is looking at;
 *  - no live connection carries video (`CallPeerConnection.hasLocalVideo`). A
 *    video call is looked at whatever the camera is doing.
 * Every path that changes one of the three recomputes the whole (the
 * activation site, the deactivation beside it, the route callback, and the
 * negotiation that births a video track), so the last call to leave always
 * releases the lock — the same argument the iOS idle timer makes.
 *
 * Held WITHOUT a timeout on purpose: the timeout the lint rule wants would put
 * a hard ceiling on how long an earpiece call can be, and `release` is reached
 * from every terminal path plus the module's own teardown. A device without
 * the sensor (`isWakeLockLevelSupported` false) simply never holds it, which
 * is the pre-fix behaviour and correct there. */
internal object ProximityGuard {

  private val lock = Any()
  private var context: Context? = null
  private var wakeLock: PowerManager.WakeLock? = null

  fun attach(appContext: Context) {
    context = appContext.applicationContext
  }

  @SuppressLint("WakelockTimeout")
  fun refresh(active: Boolean, earpiece: Boolean, video: Boolean) {
    val wanted = active && earpiece && !video
    synchronized(lock) {
      val held = wakeLock?.isHeld == true
      if (wanted == held) return
      if (!wanted) {
        releaseLocked()
        return
      }
      val lockToHold = wakeLock ?: acquireable() ?: return
      wakeLock = lockToHold
      try {
        lockToHold.acquire()
      } catch (refused: RuntimeException) {
        // A SecurityException (the permission stripped by a build) or a
        // platform refusal. The call is unaffected; only the blanking is.
        wakeLock = null
      }
    }
  }

  fun release() {
    synchronized(lock) { releaseLocked() }
  }

  private fun releaseLocked() {
    val held = wakeLock ?: return
    if (held.isHeld) {
      try {
        held.release()
      } catch (alreadyReleased: RuntimeException) {
        // Released under us — nothing left to hold.
      }
    }
  }

  private fun acquireable(): PowerManager.WakeLock? {
    val power = context?.getSystemService(PowerManager::class.java) ?: return null
    if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return null
    return power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, TAG)
  }

  /** The `pkg:name` shape the platform's own dialer tags its lock with. */
  private const val TAG = "tacendum:call-proximity"
}
