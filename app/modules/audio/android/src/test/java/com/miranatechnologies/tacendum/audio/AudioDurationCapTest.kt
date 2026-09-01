package com.miranatechnologies.tacendum.audio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The audio pin suite.
 *
 * What it pins is the arithmetic that a device test cannot see fail: a
 * playback cap enforced one millisecond too generously, a duration that
 * rounds the wrong way at the tie, or a recording cap that converts to zero
 * milliseconds — which `MediaRecorder` reads as "no limit", turning the cap
 * into its opposite — all sound perfectly fine on an emulator. Each
 * expectation below is computed by hand from the iOS original
 * (app/modules/audio/ios/TacendumAudioImpl.swift), never from a second
 * reading of the code under test.
 */
class AudioDurationCapTest {

  // MARK: - the playback cap (iOS: `guard p.duration <= 300.5`)

  @Test
  fun `the cap is five minutes plus the container tolerance`() {
    assertEquals(300_500L, AudioPolicy.PLAYBACK_CAP_MS)
  }

  @Test
  fun `audio at or under the cap plays`() {
    assertFalse(AudioPolicy.exceedsPlaybackCap(0L))
    assertFalse(AudioPolicy.exceedsPlaybackCap(1_000L))
    assertFalse(AudioPolicy.exceedsPlaybackCap(300_000L))
    // The tolerance boundary itself is INCLUSIVE on iOS (`<=`).
    assertFalse(AudioPolicy.exceedsPlaybackCap(300_500L))
  }

  @Test
  fun `one millisecond past the cap is refused`() {
    assertTrue(AudioPolicy.exceedsPlaybackCap(300_501L))
  }

  @Test
  fun `a sender's half-hour of valid AAC is refused`() {
    // The attack the cap exists for: a good GCM tag proves the SENDER built
    // it, not that the length they claimed is the length they sent.
    assertTrue(AudioPolicy.exceedsPlaybackCap(30L * 60L * 1_000L))
  }

  // MARK: - the recorded duration (iOS: `max(1, Int(probe.duration.rounded()))`)

  @Test
  fun `a sub-second note is honestly one second`() {
    assertEquals(1, AudioPolicy.recordedSeconds(0L))
    assertEquals(1, AudioPolicy.recordedSeconds(1L))
    assertEquals(1, AudioPolicy.recordedSeconds(499L))
  }

  @Test
  fun `whole seconds round to nearest`() {
    assertEquals(1, AudioPolicy.recordedSeconds(1_000L))
    assertEquals(1, AudioPolicy.recordedSeconds(1_499L))
    assertEquals(2, AudioPolicy.recordedSeconds(1_500L))
    assertEquals(2, AudioPolicy.recordedSeconds(2_400L))
    assertEquals(300, AudioPolicy.recordedSeconds(300_000L))
  }

  @Test
  fun `the tie rounds away from zero, as Swift does`() {
    // Swift's `.rounded()` is ties-away-from-zero. Kotlin's own primitives
    // are not: `kotlin.math.round` is ties-to-even (2.5 -> 2.0) and
    // `roundToInt` is ties-toward-positive-infinity (-0.5 -> 0). A duration
    // the two platforms disagree about is a bubble that reads differently on
    // each phone for the same bytes.
    assertEquals(1.0, AudioPolicy.roundedAwayFromZero(0.5), 0.0)
    assertEquals(2.0, AudioPolicy.roundedAwayFromZero(1.5), 0.0)
    assertEquals(3.0, AudioPolicy.roundedAwayFromZero(2.5), 0.0)
    assertEquals(-1.0, AudioPolicy.roundedAwayFromZero(-0.5), 0.0)
    assertEquals(-3.0, AudioPolicy.roundedAwayFromZero(-2.5), 0.0)
    assertEquals(0.0, AudioPolicy.roundedAwayFromZero(0.0), 0.0)
    assertEquals(2.0, AudioPolicy.roundedAwayFromZero(2.4), 0.0)
  }

  // MARK: - the recording cap (iOS: `record(forDuration: maxSeconds)`)

  @Test
  fun `seconds become the milliseconds setMaxDuration wants`() {
    assertEquals(300_000, AudioPolicy.maxDurationMillis(300.0))
    assertEquals(1_000, AudioPolicy.maxDurationMillis(1.0))
    assertEquals(500, AudioPolicy.maxDurationMillis(0.5))
  }

  @Test
  fun `a cap that would round to zero becomes one millisecond, never none`() {
    // MediaRecorder treats 0 as "no maximum". A cap that rounds to zero would
    // therefore REMOVE the limit — the single worst failure this conversion
    // can have, and the reason it floors rather than truncates.
    assertEquals(1, AudioPolicy.maxDurationMillis(0.0001))
    assertTrue(AudioPolicy.maxDurationMillis(0.0001) > 0)
  }

  @Test
  fun `an absurd cap saturates instead of overflowing into a negative`() {
    // (Double -> Int) overflow in Kotlin saturates, but a NEGATIVE max
    // duration is what an unchecked (ms).toInt() on some paths would produce,
    // and MediaRecorder would reject the whole recorder rather than the cap.
    assertEquals(Int.MAX_VALUE, AudioPolicy.maxDurationMillis(1.0e12))
    assertTrue(AudioPolicy.maxDurationMillis(1.0e12) > 0)
  }

  // MARK: - metering (iOS: `(averagePower + 60) / 60`, clamped)

  @Test
  fun `digital silence is zero and never a NaN`() {
    val level = AudioPolicy.levelForAmplitude(0)
    assertEquals(0.0, level, 0.0)
    assertFalse(level.isNaN())
    assertEquals(0.0, AudioPolicy.levelForAmplitude(-1), 0.0)
  }

  @Test
  fun `full scale is one and the floor clamps at zero`() {
    assertEquals(1.0, AudioPolicy.levelForAmplitude(32_767), 1.0e-9)
    // Past full scale a codec can still report a larger peak; the clamp holds.
    assertEquals(1.0, AudioPolicy.levelForAmplitude(40_000), 1.0e-9)
    // −60 dBFS is amplitude 32767/1000 ~= 32.8; anything quieter clamps to 0.
    assertEquals(0.0, AudioPolicy.levelForAmplitude(32), 0.0)
    assertEquals(0.0, AudioPolicy.levelForAmplitude(1), 0.0)
  }

  @Test
  fun `half the dB range lands mid-scale`() {
    // −30 dBFS is amplitude 32767 * 10^(-30/20) ~= 1036, which the iOS
    // normalisation puts at exactly 0.5.
    assertEquals(0.5, AudioPolicy.levelForAmplitude(1_036), 0.001)
  }

  // MARK: - the call gate, mode half

  @Test
  fun `a normal audio mode is not a call`() {
    assertFalse(AudioPolicy.callActiveForMode(AudioManager.MODE_NORMAL))
  }

  @Test
  fun `every live mode reads as a call, the incoming ring included`() {
    // CXCallObserver reports a RINGING call as not-ended, so iOS refuses
    // there too; the mode gate has to agree or the two platforms disagree
    // about whether a voice note may start while the phone is ringing.
    assertTrue(AudioPolicy.callActiveForMode(AudioManager.MODE_RINGTONE))
    assertTrue(AudioPolicy.callActiveForMode(AudioManager.MODE_IN_CALL))
    assertTrue(AudioPolicy.callActiveForMode(AudioManager.MODE_IN_COMMUNICATION))
    // The API-31 modes, by value: call screening, call redirect,
    // communication redirect.
    assertTrue(AudioPolicy.callActiveForMode(4))
    assertTrue(AudioPolicy.callActiveForMode(5))
    assertTrue(AudioPolicy.callActiveForMode(6))
  }

  @Test
  fun `the sentinels are not calls`() {
    // MODE_INVALID (-2) and MODE_CURRENT (-1) are arguments, never states.
    assertFalse(AudioPolicy.callActiveForMode(-2))
    assertFalse(AudioPolicy.callActiveForMode(-1))
    assertFalse(AudioPolicy.callActiveForMode(99))
  }
}
