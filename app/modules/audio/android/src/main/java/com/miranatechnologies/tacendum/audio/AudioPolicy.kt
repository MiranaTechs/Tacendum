package com.miranatechnologies.tacendum.audio

import android.media.AudioManager
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * The arithmetic and the gate predicates of the audio module, extracted from
 * the platform objects that carry them.
 *
 * Every number in here is a PORT, not a re-derivation: the playback cap, the
 * duration rounding, the metering floor and the call-gate verdict all have an
 * iOS original (app/modules/audio/ios/TacendumAudioImpl.swift), and the
 * original's semantics — including its rounding mode — are what this file
 * reproduces. It holds no state and touches no `MediaRecorder`,
 * `MediaPlayer` or `AudioTrack`, which is precisely why the host-JVM suite
 * can execute it: `AudioDurationCapTest` runs these functions for real, on a
 * plain JVM, with no emulator and no Robolectric.
 *
 * The only Android symbols named here are `AudioManager`'s mode CONSTANTS.
 * They are `static final int` compile-time constants, so kotlinc inlines
 * their values and no stub method is ever invoked — the unit test executes
 * the same comparisons the device does.
 */
internal object AudioPolicy {

  /**
   * The playback cap, in milliseconds, enforced on what the DECODER says
   * rather than on what the sender claimed.
   *
   * 300 s is `VOICE_MAX_SECONDS` in envelope.ts; the extra 500 ms is the
   * container-rounding tolerance the iOS original spells `p.duration <= 300.5`
   * (TacendumAudioImpl.swift, startPlayback). A peer can claim one second and
   * supply a valid half-hour of AAC under a good GCM tag, so the refusal has
   * to happen before a single sample plays.
   */
  const val PLAYBACK_CAP_MS: Long = 300_500L

  /** The iOS comparison, in the units `MediaPlayer.getDuration()` reports. */
  fun exceedsPlaybackCap(durationMs: Long): Boolean = durationMs > PLAYBACK_CAP_MS

  /**
   * Swift's `Double.rounded()` — ties away from zero.
   *
   * Neither Kotlin rounding primitive matches it: `kotlin.math.round` is
   * `Math.rint` (ties to even) and `roundToInt` is `Math.round` (ties toward
   * positive infinity, so −0.5 becomes 0 where Swift gives −1). A verbatim
   * port of a synthesized waveform and of a duration that JS shows the person
   * is not the place to inherit a different rounding mode by accident, so the
   * mode is written out rather than borrowed.
   */
  fun roundedAwayFromZero(value: Double): Double =
      if (value < 0.0) -floor(-value + 0.5) else floor(value + 0.5)

  /**
   * The whole-second duration that rides in `onRecordingFinished` /
   * `stopRecording`.
   *
   * iOS: `max(1, Int(probe.duration.rounded()))`. The envelope's `dur` is
   * 1..300 and a sub-second note is honestly "1 second" at that granularity,
   * so the floor of 1 is a wire contract, not a nicety.
   */
  fun recordedSeconds(durationMs: Long): Int =
      max(1.0, roundedAwayFromZero(durationMs / 1000.0)).toInt()

  /**
   * `MediaRecorder.setMaxDuration` takes milliseconds as an `Int`; the JS
   * spec passes seconds as a `Double`. The cap is the recorder's own job on
   * both platforms (iOS `record(forDuration:)`), so this conversion is the
   * whole enforcement and it must never round DOWN to zero — a 0 ms cap means
   * "no limit" to `MediaRecorder`, which would turn the cap into its
   * opposite.
   */
  fun maxDurationMillis(maxSeconds: Double): Int {
    val ms = roundedAwayFromZero(maxSeconds * 1000.0)
    if (ms >= Int.MAX_VALUE.toDouble()) return Int.MAX_VALUE
    return max(1.0, ms).toInt()
  }

  /**
   * The recording level indicator, 0..1.
   *
   * iOS reads `averagePower(forChannel: 0)` — already dBFS — and normalises
   * against a −60 dB floor so quiet-room speech uses the range instead of
   * hugging the bottom. `MediaRecorder.getMaxAmplitude()` reports a LINEAR
   * 16-bit peak instead, so the dB conversion that iOS gets for free happens
   * here; the −60 floor and the 0..1 clamp are then identical.
   *
   * Amplitude 0 is digital silence — log10(0) is −infinity — and is answered
   * as 0.0 rather than allowed to propagate a NaN into a UI bar.
   */
  fun levelForAmplitude(amplitude: Int): Double {
    if (amplitude <= 0) return 0.0
    val db = 20.0 * log10(min(amplitude, 32_767).toDouble() / 32_767.0)
    return max(0.0, min(1.0, (db + 60.0) / 60.0))
  }

  /**
   * The cellular half of the call gate: `AudioManager.getMode()`.
   *
   * iOS asks `CXCallObserver` — authoritative, and it sees cellular calls.
   * Android's authoritative equivalent (`TelecomManager.isInCall`) costs
   * `READ_PHONE_STATE`, a permission this app does not ask for, so the design
   * buys the gate with the audio mode instead and a recorded divergence notes
   * the price: an OEM that routes a cellular call without moving the mode is
   * missed here. `CallBeacon` carries the OTHER half — our own Telecom calls,
   * which this predicate cannot be trusted to see either, because a
   * self-managed connection's mode is set by whatever audio stack the call
   * module runs.
   *
   * Any mode that is not NORMAL means somebody is on a call — including
   * RINGTONE, which is the incoming ring: `CXCallObserver` reports a ringing
   * call as not-ended, so refusing there is parity, not extra caution.
   * MODE_INVALID/MODE_CURRENT are sentinels, never live states, and read as
   * "no call" — the same answer an empty `CXCallObserver.calls` gives.
   */
  fun callActiveForMode(mode: Int): Boolean =
      when (mode) {
        AudioManager.MODE_RINGTONE,
        AudioManager.MODE_IN_CALL,
        AudioManager.MODE_IN_COMMUNICATION,
        MODE_CALL_SCREENING,
        MODE_CALL_REDIRECT,
        MODE_COMMUNICATION_REDIRECT -> true
        else -> false
      }

  // The API-31 modes, written as literals rather than named constants so the
  // predicate compiles and executes on the minSdk-26 floor: the fields do not
  // exist in the API-26 surface, but the VALUES a 31+ device reports do reach
  // this comparison, and a call the gate cannot name is still a call.
  private const val MODE_CALL_SCREENING = 4
  private const val MODE_CALL_REDIRECT = 5
  private const val MODE_COMMUNICATION_REDIRECT = 6
}
