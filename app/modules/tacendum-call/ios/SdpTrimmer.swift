import Foundation

/**
 * Codec-list trimming.
 *
 * A raw libwebrtc offer advertises every codec it supports — around 8 KB of
 * SDP for a call that will only ever use three of them. Trimming to
 * H.264 + VP8 + Opus + `telephone-event` brings a typical offer to ~3.5 KB,
 * which matters against the 30 000-character frame budget because the
 * offer travels inside a ratcheted envelope like any other message.
 *
 * **The four lines this must never touch** are `a=fingerprint`, `a=ice-ufrag`,
 * `a=ice-pwd` and `a=setup`. The fingerprint in particular is the entire E2EE
 * claim for media: it binds the DTLS-SRTP keys to a envelope the server cannot
 * read, so a server that could rewrite it could man-in-the-middle the media
 * while the messages stayed secure. This file is a pure string
 * transformation over m-lines and their attribute lines, and `SdpTrimmerTests`
 * asserts those four survive byte-for-byte.
 *
 * Deliberately NOT a "parse into a model and re-serialize" design: a
 * round-trip through a model rewrites lines it merely means to preserve, and
 * "preserve byte-for-byte" is the requirement. Lines that are not being
 * removed are passed through untouched, as the exact strings they arrived as.
 */
enum SdpTrimmer {
  /// Codec names kept, lowercased. Everything else is dropped from the m-line.
  ///
  /// H.264 first for hardware encode/decode on every supported iPhone; VP8 as
  /// the software fallback. VP9 and AV1 are excluded on purpose — no hardware
  /// path on the device floor, and software encode costs battery and heat.
  /// `telephone-event` is mandatory (DTMF); `red`/`ulpfec` ride with Opus FEC.
  static let keptCodecs: Set<String> = [
    "h264", "vp8", "opus", "telephone-event", "red", "ulpfec", "rtx",
  ]

  /// Lines that are copied through verbatim no matter what, because something
  /// security-relevant depends on their exact bytes.
  static let untouchablePrefixes = [
    "a=fingerprint:", "a=ice-ufrag:", "a=ice-pwd:", "a=setup:",
  ]

  static func trim(_ sdp: String) -> String {
    // Preserve the original line terminators. SDP is CRLF by spec and
    // libwebrtc emits CRLF; splitting on "\n" and rejoining with "\r\n" would
    // silently rewrite an LF-only SDP, which is a mutation of lines we
    // promised not to mutate.
    let usesCRLF = sdp.contains("\r\n")
    let separator = usesCRLF ? "\r\n" : "\n"
    let lines = sdp.components(separatedBy: separator)

    // Pass 1: for each media section, decide which payload types survive.
    var keptPayloadsBySection: [Int: Set<String>] = [:]
    var sectionIndex = -1
    var payloadNames: [Int: [String: String]] = [:]
    /// `a=fmtp:<pt> apt=<base>` — which payload an rtx or red stream repairs.
    var aptBySection: [Int: [String: String]] = [:]

    for line in lines {
      if line.hasPrefix("m=") {
        sectionIndex += 1
        payloadNames[sectionIndex] = [:]
        aptBySection[sectionIndex] = [:]
      } else if line.hasPrefix("a=fmtp:"), sectionIndex >= 0 {
        // a=fmtp:<pt> apt=<base>[;...]
        let body = String(line.dropFirst("a=fmtp:".count))
        guard let space = body.firstIndex(of: " ") else { continue }
        let pt = String(body[body.startIndex..<space])
        for param in body[body.index(after: space)...].split(separator: ";") {
          let trimmed = param.trimmingCharacters(in: .whitespaces)
          if trimmed.hasPrefix("apt=") {
            aptBySection[sectionIndex]?[pt] = String(trimmed.dropFirst("apt=".count))
          }
        }
      } else if line.hasPrefix("a=rtpmap:"), sectionIndex >= 0 {
        // a=rtpmap:<pt> <name>/<clock>[/<channels>]
        let body = String(line.dropFirst("a=rtpmap:".count))
        guard let space = body.firstIndex(of: " ") else { continue }
        let pt = String(body[body.startIndex..<space])
        let rest = String(body[body.index(after: space)...])
        let name = rest.split(separator: "/").first.map(String.init) ?? rest
        payloadNames[sectionIndex]?[pt] = name.lowercased()
      }
    }

    sectionIndex = -1
    for line in lines where line.hasPrefix("m=") {
      sectionIndex += 1
      let parts = line.split(separator: " ").map(String.init)
      guard parts.count > 3 else { continue }
      let payloads = Array(parts.dropFirst(3))
      let names = payloadNames[sectionIndex] ?? [:]
      var kept = payloads.filter { pt in
        guard let name = names[pt] else {
          // A payload type with no rtpmap is a static one (PCMU/PCMA and
          // friends). Keep it: dropping a payload we cannot identify risks
          // producing an m-line with nothing negotiable on it.
          return true
        }
        return keptCodecs.contains(name)
      }
      // `rtx` and `red` are repair streams: each is bound by `a=fmtp:<pt>
      // apt=<base>` to the codec it repairs. Keeping one whose base was just
      // dropped leaves a payload type pointing at nothing — RFC 4588 §8.1
      // requires the apt reference to name a payload in the same m-line, so
      // this is malformed rather than merely untidy. A receiver is entitled to
      // reject the m-line, and libwebrtc has historically differed from other
      // stacks in how loudly it complains.
      //
      // Looped rather than filtered once, because dropping an rtx can orphan
      // a red that repaired it. Converges quickly and is bounded by the
      // payload count; the loop is for correctness, not for depth.
      var keptSet = Set(kept)
      let apt = aptBySection[sectionIndex] ?? [:]
      var changed = true
      while changed {
        changed = false
        for pt in keptSet {
          if let base = apt[pt], !keptSet.contains(base) {
            keptSet.remove(pt)
            changed = true
          }
        }
      }
      kept = kept.filter { keptSet.contains($0) }

      // Never empty an m-line. An m-line with no payload types is invalid SDP
      // and the peer will reject the whole offer — strictly worse than a
      // slightly larger one.
      if kept.isEmpty { kept = payloads }
      keptPayloadsBySection[sectionIndex] = Set(kept)
    }

    // Pass 2: rebuild, dropping only attribute lines bound to a removed PT.
    var out: [String] = []
    out.reserveCapacity(lines.count)
    sectionIndex = -1

    for line in lines {
      if untouchablePrefixes.contains(where: { line.hasPrefix($0) }) {
        out.append(line)
        continue
      }

      if line.hasPrefix("m=") {
        sectionIndex += 1
        let parts = line.split(separator: " ").map(String.init)
        guard parts.count > 3, let kept = keptPayloadsBySection[sectionIndex] else {
          out.append(line)
          continue
        }
        // Order is preserved — it is the codec preference the peer reads.
        let payloads = Array(parts.dropFirst(3)).filter { kept.contains($0) }
        out.append((Array(parts.prefix(3)) + payloads).joined(separator: " "))
        continue
      }

      if sectionIndex >= 0, let kept = keptPayloadsBySection[sectionIndex],
         let pt = payloadType(of: line), !kept.contains(pt) {
        continue
      }

      out.append(line)
    }

    return out.joined(separator: separator)
  }

  /// The payload type an attribute line is bound to, if it is bound to one.
  /// Lines that name no payload type return nil and are always preserved.
  private static func payloadType(of line: String) -> String? {
    for prefix in ["a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"] where line.hasPrefix(prefix) {
      let body = String(line.dropFirst(prefix.count))
      let token = body.prefix { $0 != " " }
      return token.isEmpty ? nil : String(token)
    }
    return nil
  }
}
