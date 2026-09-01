package com.miranatechnologies.tacendum.call

/**
 * A deliberately corrupted `a=fingerprint`
 * — the Kotlin twin of `ios/FingerprintFault.swift`.
 *
 * The design claims the server cannot man-in-the-middle the media: the DTLS-SRTP
 * keys are bound by the fingerprint, the fingerprint travels inside the
 * ratcheted envelope, and swapping it means forging a Double Ratchet message
 * first. `SdpTrimmer` is tested to leave that line byte-for-byte intact, and
 * no code path logs it.
 *
 * None of that demonstrates the other half: that a WRONG fingerprint is
 * actually rejected. It should be — DTLS verifies the peer certificate
 * against it — but "should be" is exactly the kind of claim that turns out to
 * rest on a setting nobody checked. A peer connection built with certificate
 * verification accidentally disabled would connect happily to an attacker and
 * every other test in this repository would still pass.
 *
 * So this exists to break it on purpose. `TacendumCallModule.enableFingerprintFault`
 * turns it on; the next offer or answer goes out with one hex digit of the
 * fingerprint flipped, and the call MUST fail to connect and end
 * `failed_media` rather than establishing media.
 *
 * ---
 *
 * **WHAT IS DIFFERENT FROM iOS, STATED RATHER THAN GLOSSED.** The Swift file
 * is wrapped in `#if DEBUG`, so a Release binary contains zero symbols for it
 * — checked with `nm`, not assumed — and only the inert JS-callable setter
 * survives. Kotlin has no preprocessor, and this module's Release build runs
 * with `minifyEnabled false` (as the app's build.gradle pins),
 * so this class IS present in a Release APK. The property that survives the
 * port is the weaker, honest one:
 *
 *   * the switch is DISCONNECTED, not absent — `useFingerprintFault` is only
 *     ever consulted behind `BuildConfig.DEBUG` in `CallPeerConnection`, so a
 *     Release build carries a flag nothing reads and a corrupter nothing
 *     calls;
 *   * `TacendumCallModule.enableFingerprintFault` does not even write the flag
 *     outside DEBUG — it resolves, as the iOS Release setter does, and stores
 *     nothing. The JS-callable method has to exist in both configurations
 *     (codegen generates the TurboModule surface from the TypeScript spec, and
 *     that has no conditional compilation); what it does is what changes.
 *
 * That difference is recorded here rather than in a comment claiming parity
 * this file does not have. Anyone tightening it later wants R8 with a keep
 * rule inverted for this class, which is a packaging decision, not a call-module
 * one.
 */
object FingerprintFault {
  /**
   * Flip one hex digit of the fingerprint hash, leaving everything else —
   * including the line's structure and the algorithm name — untouched.
   *
   * One digit rather than a wholesale replacement, and structure preserved
   * on purpose: the test must fail at DTLS verification, not at SDP parsing.
   * A malformed line would be rejected earlier and for the wrong reason,
   * which would look like a pass and prove nothing.
   */
  fun corrupt(sdp: String): String {
    val usesCRLF = sdp.contains("\r\n")
    val separator = if (usesCRLF) "\r\n" else "\n"
    val lines = sdp.split(separator)

    val out =
        lines.map { line ->
          if (!line.startsWith("a=fingerprint:")) return@map line
          // a=fingerprint:<algorithm> <AA:BB:CC:...>
          val space = line.lastIndexOf(' ')
          if (space < 0) return@map line
          val head = line.substring(0, space + 1)
          val hash = line.substring(space + 1)

          // Flip the FIRST hex digit to something else. Deterministic, so a
          // failure is reproducible rather than a different corruption each run.
          val first = hash.firstOrNull() ?: return@map line
          if (!isHexDigit(first)) return@map line
          val replacement = if (first == '0') '1' else '0'
          head + replacement + hash.substring(1)
        }

    return out.joinToString(separator)
  }

  /**
   * Swift's `Character.isHexDigit` spelled out. Kotlin's `Char.isDigit()`
   * accepts every Unicode decimal digit, which a fingerprint never contains
   * but which would make this predicate say yes to a character the ASCII
   * check below would rightly refuse; the explicit ranges keep the two ports
   * agreeing on exactly which lines they will touch.
   */
  private fun isHexDigit(c: Char): Boolean =
      c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
}
