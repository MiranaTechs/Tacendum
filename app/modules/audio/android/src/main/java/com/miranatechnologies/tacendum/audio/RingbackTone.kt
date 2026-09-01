package com.miranatechnologies.tacendum.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * One cycle of the ringback, synthesized — a VERBATIM port of the iOS
 * sample loop (TacendumAudioImpl.swift, `ringbackWav`).
 *
 * The repo ships no audio asset, so there is no binary blob to license
 * alongside the AGPL Corresponding Source and no provenance to account for.
 * 24 kHz mono 16-bit PCM, built once.
 *
 * The sound is the app's visual language translated — one ink, no ornament.
 * Two pure sine pulses: G4 (392 Hz), then D5 (587.33 Hz), a perfect fifth up,
 * the second quieter like an answer from further away. Each lasts 220 ms
 * under a raised-cosine attack (25 ms) and release (90 ms) so nothing clicks,
 * peaking near −19 dBFS — quiet on purpose; then rest to the end of a
 * 4-second cycle. The long silence is what makes it read as patient rather
 * than urgent, and the pure tones are what keep it from being a jingle — no
 * melody, no timbre movement, no percussion. The burst-then-silence cadence
 * itself is the one convention every phone network shares, so it still reads
 * instantly as "their phone is ringing".
 *
 * ONE DIVERGENCE FROM THE ORIGINAL, IN THE CONTAINER AND NOT THE SOUND: iOS
 * wraps these samples in a 44-byte WAV header because `AVAudioPlayer(data:)`
 * needs a container to parse. `AudioTrack` consumes raw PCM frames, so the
 * header is dropped and the sample array IS the payload. Every number that
 * shapes the waveform — rate, cycle length, both frequencies, both
 * amplitudes, the offsets, the envelope times, and the away-from-zero
 * rounding of each sample — is the iOS value, and `RingbackToneTest` pins
 * them against hand-computed expectations rather than against a
 * re-implementation of this file.
 */
internal object RingbackTone {

  /** Hz. The iOS `rate`. */
  const val SAMPLE_RATE = 24_000

  /** The cycle the loop repeats, in seconds. The iOS `rate * 4` buffer. */
  const val CYCLE_SECONDS = 4

  /** Mono, so one sample is one frame — what `setLoopPoints` counts. */
  const val FRAME_COUNT = SAMPLE_RATE * CYCLE_SECONDS

  /**
   * Built once, on first use, and never mutated afterwards — the callers
   * only ever hand it to `AudioTrack.write`.
   */
  val pcm: ShortArray by lazy(LazyThreadSafetyMode.SYNCHRONIZED) { synthesize() }

  private fun synthesize(): ShortArray {
    val samples = ShortArray(FRAME_COUNT)
    pulse(samples, freq = 392.0, start = 0.0, amp = 0.11)
    pulse(samples, freq = 587.33, start = 0.36, amp = 0.085)
    return samples
  }

  /**
   * The iOS `pulse(_:at:amp:)`, line for line. `Int(x)` truncates in Swift
   * and `.toInt()` truncates in Kotlin, so both the write offset and the
   * pulse length land on the same samples; the per-sample rounding is
   * Swift's `.rounded()`, which is why it goes through
   * [AudioPolicy.roundedAwayFromZero] rather than a Kotlin primitive.
   */
  private fun pulse(samples: ShortArray, freq: Double, start: Double, amp: Double) {
    val dur = 0.22
    val attack = 0.025
    val release = 0.09
    val base = (start * SAMPLE_RATE.toDouble()).toInt()
    val length = (dur * SAMPLE_RATE.toDouble()).toInt()
    for (i in 0 until length) {
      val t = i.toDouble() / SAMPLE_RATE.toDouble()
      val env =
          when {
            t < attack -> 0.5 - 0.5 * cos(PI * t / attack)
            t > dur - release -> 0.5 - 0.5 * cos(PI * (dur - t) / release)
            else -> 1.0
          }
      samples[base + i] =
          AudioPolicy.roundedAwayFromZero(amp * env * sin(2 * PI * freq * t) * 32_767.0).toInt()
              .toShort()
    }
  }
}
