package com.miranatechnologies.tacendum.audio

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ringback is a VERBATIM port of the iOS sample loop, and "verbatim" is a
 * claim only if something can falsify it.
 *
 * A wrong ringback does not crash and does not fail a device test — it just
 * sounds slightly different from the iPhone's, which nobody would notice and
 * nobody could file. So the waveform is pinned here by its own numbers:
 * buffer length, the two pulse windows, the silence between and after them,
 * the peak of each pulse (which encodes both amplitudes), the zero-valued
 * ends of the raised-cosine envelope, and two individual samples computed
 * from the Swift formula rather than from this repo's Kotlin.
 */
class RingbackToneTest {

  // The iOS constants, restated here so a drifting port disagrees with the
  // TEST rather than agreeing with itself.
  private val rate = 24_000
  private val cycleSeconds = 4
  private val pulseOneStart = 0
  private val pulseOneLength = 5_280 // Int(0.22 * 24000)
  private val pulseTwoStart = 8_640 // Int(0.36 * 24000)
  private val pulseTwoLength = 5_280

  @Test
  fun `the cycle is four seconds of 24 kHz mono`() {
    assertEquals(24_000, RingbackTone.SAMPLE_RATE)
    assertEquals(4, RingbackTone.CYCLE_SECONDS)
    assertEquals(rate * cycleSeconds, RingbackTone.FRAME_COUNT)
    assertEquals(rate * cycleSeconds, RingbackTone.pcm.size)
  }

  @Test
  fun `the long silence that makes it patient rather than urgent`() {
    val pcm = RingbackTone.pcm
    // Between the two pulses...
    for (i in (pulseOneStart + pulseOneLength) until pulseTwoStart) {
      assertEquals("sample $i between the pulses", 0, pcm[i].toInt())
    }
    // ...and the rest of the four-second cycle, which is most of it.
    for (i in (pulseTwoStart + pulseTwoLength) until pcm.size) {
      assertEquals("sample $i in the tail silence", 0, pcm[i].toInt())
    }
  }

  @Test
  fun `each pulse opens and closes at silence, so nothing clicks`() {
    val pcm = RingbackTone.pcm
    // The raised-cosine attack starts at env 0, and the release ends there.
    assertEquals(0, pcm[pulseOneStart].toInt())
    assertEquals(0, pcm[pulseOneStart + pulseOneLength - 1].toInt())
    assertEquals(0, pcm[pulseTwoStart].toInt())
    assertEquals(0, pcm[pulseTwoStart + pulseTwoLength - 1].toInt())
  }

  @Test
  fun `the first pulse peaks at amplitude 0 point 11 of full scale`() {
    // 0.11 * 32767 = 3604.37, so the loudest sample a rounded sine can reach
    // is 3604; the plateau is ~2500 samples long at 392 Hz, which is many
    // cycles, so it gets within a couple of counts of the ceiling.
    val peak = peakBetween(pulseOneStart, pulseOneStart + pulseOneLength)
    assertTrue("first pulse peak was $peak", peak in 3_598..3_604)
  }

  @Test
  fun `the second pulse is the quieter answer from further away`() {
    // 0.085 * 32767 = 2785.2.
    val peak = peakBetween(pulseTwoStart, pulseTwoStart + pulseTwoLength)
    assertTrue("second pulse peak was $peak", peak in 2_779..2_785)
    assertTrue(
        "the answer must be quieter than the call",
        peak < peakBetween(pulseOneStart, pulseOneStart + pulseOneLength),
    )
  }

  @Test
  fun `G4 then a perfect fifth up to D5, sample by sample`() {
    val pcm = RingbackTone.pcm

    // Index 1200 of the first pulse: t = 0.05 s, inside the env == 1 plateau
    // (attack 0.025 .. dur-release 0.13), so the value is the bare sine.
    // 0.11 * sin(2π * 392 * 0.05) * 32767, ties away from zero.
    val expectedOne = 0.11 * sin(2 * PI * 392.0 * 0.05) * 32_767.0
    assertEquals(
        "G4 at t = 0.05 s",
        awayFromZero(expectedOne),
        pcm[pulseOneStart + 1_200].toInt().toDouble(),
        1.0,
    )

    // Index 1200 of the second pulse: same t within the pulse, D5's frequency
    // and the quieter amplitude.
    val expectedTwo = 0.085 * sin(2 * PI * 587.33 * 0.05) * 32_767.0
    assertEquals(
        "D5 at t = 0.05 s into the second pulse",
        awayFromZero(expectedTwo),
        pcm[pulseTwoStart + 1_200].toInt().toDouble(),
        1.0,
    )
  }

  @Test
  fun `the attack rises rather than jumping`() {
    val pcm = RingbackTone.pcm
    // 25 ms of attack is 600 samples; the envelope over the first cycle of
    // the tone is still tiny, so early peaks must stay far below the plateau.
    val earlyPeak = peakBetween(pulseOneStart, pulseOneStart + 120) // first 5 ms
    val platePeak = peakBetween(pulseOneStart + 1_000, pulseOneStart + 2_000)
    assertTrue("early peak $earlyPeak vs plateau $platePeak", earlyPeak < platePeak / 4)
  }

  @Test
  fun `the buffer is rebuilt identically on every read`() {
    // `pcm` is a lazily built array handed straight to AudioTrack; a caller
    // that mutated it would silently change every later ring.
    val first = RingbackTone.pcm
    val second = RingbackTone.pcm
    assertTrue(first.contentEquals(second))
  }

  private fun peakBetween(fromInclusive: Int, toExclusive: Int): Int {
    var peak = 0
    for (i in fromInclusive until toExclusive) {
      val magnitude = abs(RingbackTone.pcm[i].toInt())
      if (magnitude > peak) peak = magnitude
    }
    return peak
  }

  /** Swift's `.rounded()`, written out so the expectation owes nothing to the code under test. */
  private fun awayFromZero(value: Double): Double =
      if (value < 0.0) -kotlin.math.floor(-value + 0.5) else kotlin.math.floor(value + 0.5)
}
