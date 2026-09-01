#if DEBUG

  import Foundation

  /**
   * A deliberately corrupted `a=fingerprint`.
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
   * So this exists to break it on purpose. `TacendumCallImpl.enableFingerprintFault`
   * turns it on; the next offer or answer goes out with one hex byte of the
   * fingerprint flipped, and the call MUST fail to connect and end
   * `failed_media` rather than establishing media.
   *
   * `#if DEBUG` wraps the whole file, like `SyntheticVideoCapturer`: a Release
   * binary must not contain a function whose only purpose is to break the
   * property the product is sold on.
   *
   * **What actually survives into Release, checked with `nm` rather than
   * assumed.** This enum, `corrupt(_:)` and `CallPeerConnection.faulted(_:)`
   * are all absent — zero symbols. What remains is `enableFingerprintFault`
   * itself: an inert setter that writes a flag nothing reads. It cannot be
   * removed, because codegen generates the TurboModule protocol from the
   * TypeScript spec and that has no conditional compilation — the method must
   * exist for the class to conform. `enableSyntheticVideo` has had exactly the
   * same shape throughout.
   *
   * So a Release build exposes a JS-callable `enableFingerprintFault(true)`
   * that does nothing at all, and the machinery to act on it does not exist in
   * the binary. That is the property worth stating: not "the switch is gone",
   * which would be false, but "the switch is disconnected".
   */
  enum FingerprintFault {
    /**
     * Flip one hex digit of the fingerprint hash, leaving everything else —
     * including the line's structure and the algorithm name — untouched.
     *
     * One digit rather than a wholesale replacement, and structure preserved
     * on purpose: the test must fail at DTLS verification, not at SDP parsing.
     * A malformed line would be rejected earlier and for the wrong reason,
     * which would look like a pass and prove nothing.
     */
    static func corrupt(_ sdp: String) -> String {
      let usesCRLF = sdp.contains("\r\n")
      let separator = usesCRLF ? "\r\n" : "\n"
      let lines = sdp.components(separatedBy: separator)

      let out = lines.map { line -> String in
        guard line.hasPrefix("a=fingerprint:") else { return line }
        // a=fingerprint:<algorithm> <AA:BB:CC:...>
        guard let space = line.lastIndex(of: " ") else { return line }
        let head = String(line[line.startIndex...space])
        let hash = String(line[line.index(after: space)...])

        // Flip the FIRST hex digit to something else. Deterministic, so a
        // failure is reproducible rather than a different corruption each run.
        guard let first = hash.first, first.isHexDigit else { return line }
        let replacement: Character = first == "0" ? "1" : "0"
        return head + String(replacement) + String(hash.dropFirst())
      }

      return out.joined(separator: separator)
    }
  }

#endif
