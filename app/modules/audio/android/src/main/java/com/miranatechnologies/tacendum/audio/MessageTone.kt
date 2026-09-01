package com.miranatechnologies.tacendum.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The message-arrival chime, synthesized — a VERBATIM port of the iOS
 * `messageToneWav` (TacendumAudioImpl.swift), exactly as [RingbackTone] ports
 * `ringbackWav`.
 *
 * The ringback's figure — a pure fifth, the second note the quieter answer —
 * played an octave higher and in a third of the time: D5 (587.33 Hz) for
 * 85 ms, then A5 (880 Hz) for 110 ms, 120 ms after it, under raised-cosine
 * edges so nothing clicks; 340 ms of buffer in all, peaking near −20 dBFS.
 * Short enough to be a tap on the shoulder rather than an announcement, and
 * drawn with the same one ink as the ring so the two read as one voice. The
 * repo ships no audio asset, so there is no binary blob to license alongside
 * the AGPL Corresponding Source and no provenance to account for.
 *
 * Same container divergence as the ringback, and only that: iOS wraps the
 * samples in a WAV header for AudioServices; `AudioTrack` consumes raw PCM
 * frames, so the sample array IS the payload. Every number that shapes the
 * waveform is the iOS value, and the per-sample rounding goes through
 * [AudioPolicy.roundedAwayFromZero] for the same reason RingbackTone's does.
 */
internal object MessageTone {

  /** Hz. The iOS `rate`. */
  const val SAMPLE_RATE = RingbackTone.SAMPLE_RATE

  /** The buffer, in seconds. The iOS `seconds: 0.34`. */
  const val BUFFER_SECONDS = 0.34

  /** Mono, so one sample is one frame. `Int(Double(rate) * seconds)` on iOS. */
  val FRAME_COUNT: Int = (SAMPLE_RATE.toDouble() * BUFFER_SECONDS).toInt()

  /** How long the track needs before it may be released, with headroom. */
  const val DURATION_MS = 340L

  /** Built once, on first use, and never mutated afterwards. */
  val pcm: ShortArray by lazy(LazyThreadSafetyMode.SYNCHRONIZED) { synthesize() }

  private fun synthesize(): ShortArray {
    val samples = ShortArray(FRAME_COUNT)
    pulse(samples, freq = 587.33, start = 0.0, dur = 0.085, attack = 0.008, release = 0.035, amp = 0.10)
    pulse(samples, freq = 880.0, start = 0.12, dur = 0.11, attack = 0.008, release = 0.05, amp = 0.08)
    return samples
  }

  /**
   * The iOS `synthesizeWav` inner loop, line for line, with the pulse's own
   * envelope times where the ringback's are fixed.
   */
  private fun pulse(
      samples: ShortArray,
      freq: Double,
      start: Double,
      dur: Double,
      attack: Double,
      release: Double,
      amp: Double,
  ) {
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
