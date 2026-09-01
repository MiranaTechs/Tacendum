package com.miranatechnologies.tacendum.call

/**
 * Codec-list trimming — the Kotlin twin of
 * `app/modules/tacendum-call/ios/SdpTrimmer.swift`, ported line for line.
 *
 * A raw libwebrtc offer advertises every codec it supports — around 8 KB of
 * SDP for a call that will only ever use three of them. Trimming to
 * H.264 + VP8 + Opus + `telephone-event` brings a typical offer to ~3.5 KB,
 * which matters against the 30 000-character frame budget because the
 * offer travels inside a ratcheted envelope like any other message.
 *
 * **The four lines this must never touch** are `a=fingerprint`, `a=ice-ufrag`,
 * `a=ice-pwd` and `a=setup`. The fingerprint in particular is the entire E2EE
 * claim for media: it binds the DTLS-SRTP keys to an envelope the server
 * cannot read, so a server that could rewrite it could man-in-the-middle the
 * media while the messages stayed secure. This file is a pure string
 * transformation over m-lines and their attribute lines, and
 * `SdpTrimmerVectorTest` asserts those four survive byte-for-byte.
 *
 * Deliberately NOT a "parse into a model and re-serialize" design: a
 * round-trip through a model rewrites lines it merely means to preserve, and
 * "preserve byte-for-byte" is the requirement. Lines that are not being
 * removed are passed through untouched, as the exact strings they arrived as.
 *
 * **No Android import, on purpose.** Everything here is `kotlin.String`, so
 * the vector twin runs on the host JVM in a second (`testDebugUnitTest`,
 * on the host JVM) rather than inside an
 * instrumentation run that would in practice never happen per commit — the
 * same argument the Swift harness makes for the Swift side.
 *
 * TWO PORTING DIFFERENCES FROM SWIFT, both deliberate and both about
 * `split`. Swift's `String.split(separator:)` omits empty subsequences and
 * Kotlin's `String.split(String)` keeps them, so every split that Swift takes
 * for granted is filtered here; and Kotlin throws on mutating a `MutableSet`
 * that is being iterated where Swift was iterating a value-type copy, so the
 * repair-stream loop iterates a snapshot. Neither changes the output for any
 * input; both would change it if written naively, which is why they are named.
 */
object SdpTrimmer {
  /**
   * Codec names kept, lowercased. Everything else is dropped from the m-line.
   *
   * H.264 first for hardware encode/decode where the device provides one; VP8
   * as the software fallback. VP9 and AV1 are excluded on purpose — no
   * dependable hardware path on the device floor, and software encode costs
   * battery and heat. `telephone-event` is mandatory (DTMF); `red`/`ulpfec`
   * ride with Opus FEC.
   *
   * IDENTICAL TO THE SWIFT SET, and that identity is the point: the two
   * platforms negotiate against each other, and a codec kept on one side and
   * dropped on the other is a call that connects with no video.
   */
  val keptCodecs: Set<String> =
      setOf("h264", "vp8", "opus", "telephone-event", "red", "ulpfec", "rtx")

  /**
   * Lines that are copied through verbatim no matter what, because something
   * security-relevant depends on their exact bytes.
   */
  val untouchablePrefixes: List<String> =
      listOf("a=fingerprint:", "a=ice-ufrag:", "a=ice-pwd:", "a=setup:")

  fun trim(sdp: String): String {
    // Preserve the original line terminators. SDP is CRLF by spec and
    // libwebrtc emits CRLF; splitting on "\n" and rejoining with "\r\n" would
    // silently rewrite an LF-only SDP, which is a mutation of lines we
    // promised not to mutate.
    val usesCRLF = sdp.contains("\r\n")
    val separator = if (usesCRLF) "\r\n" else "\n"
    val lines = sdp.split(separator)

    // Pass 1: for each media section, decide which payload types survive.
    val keptPayloadsBySection = HashMap<Int, Set<String>>()
    var sectionIndex = -1
    val payloadNames = HashMap<Int, HashMap<String, String>>()
    /** `a=fmtp:<pt> apt=<base>` — which payload an rtx or red stream repairs. */
    val aptBySection = HashMap<Int, HashMap<String, String>>()

    for (line in lines) {
      if (line.startsWith("m=")) {
        sectionIndex += 1
        payloadNames[sectionIndex] = HashMap()
        aptBySection[sectionIndex] = HashMap()
      } else if (line.startsWith("a=fmtp:") && sectionIndex >= 0) {
        // a=fmtp:<pt> apt=<base>[;...]
        val body = line.substring("a=fmtp:".length)
        val space = body.indexOf(' ')
        if (space < 0) continue
        val pt = body.substring(0, space)
        for (param in body.substring(space + 1).split(";")) {
          val trimmed = param.trim()
          if (trimmed.startsWith("apt=")) {
            aptBySection[sectionIndex]?.put(pt, trimmed.substring("apt=".length))
          }
        }
      } else if (line.startsWith("a=rtpmap:") && sectionIndex >= 0) {
        // a=rtpmap:<pt> <name>/<clock>[/<channels>]
        val body = line.substring("a=rtpmap:".length)
        val space = body.indexOf(' ')
        if (space < 0) continue
        val pt = body.substring(0, space)
        val rest = body.substring(space + 1)
        val name = rest.split("/").firstOrNull { it.isNotEmpty() } ?: rest
        payloadNames[sectionIndex]?.put(pt, name.lowercase())
      }
    }

    sectionIndex = -1
    for (line in lines) {
      if (!line.startsWith("m=")) continue
      sectionIndex += 1
      val parts = line.split(" ").filter { it.isNotEmpty() }
      if (parts.size <= 3) continue
      val payloads = parts.drop(3)
      val names = payloadNames[sectionIndex] ?: HashMap()
      var kept =
          payloads.filter { pt ->
            val name = names[pt]
            // A payload type with no rtpmap is a static one (PCMU/PCMA and
            // friends). Keep it: dropping a payload we cannot identify risks
            // producing an m-line with nothing negotiable on it.
            if (name == null) true else keptCodecs.contains(name)
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
      val keptSet = HashSet(kept)
      val apt = aptBySection[sectionIndex] ?: HashMap()
      var changed = true
      while (changed) {
        changed = false
        // A SNAPSHOT, not the live set: Kotlin throws
        // ConcurrentModificationException on a set mutated while iterated,
        // where Swift was iterating a value-type copy. Same semantics, and
        // the only shape that has them here.
        for (pt in keptSet.toList()) {
          val base = apt[pt]
          if (base != null && !keptSet.contains(base)) {
            keptSet.remove(pt)
            changed = true
          }
        }
      }
      kept = kept.filter { keptSet.contains(it) }

      // Never empty an m-line. An m-line with no payload types is invalid SDP
      // and the peer will reject the whole offer — strictly worse than a
      // slightly larger one.
      if (kept.isEmpty()) kept = payloads
      keptPayloadsBySection[sectionIndex] = kept.toSet()
    }

    // Pass 2: rebuild, dropping only attribute lines bound to a removed PT.
    val out = ArrayList<String>(lines.size)
    sectionIndex = -1

    for (line in lines) {
      if (untouchablePrefixes.any { line.startsWith(it) }) {
        out.add(line)
        continue
      }

      if (line.startsWith("m=")) {
        sectionIndex += 1
        val parts = line.split(" ").filter { it.isNotEmpty() }
        val kept = keptPayloadsBySection[sectionIndex]
        if (parts.size <= 3 || kept == null) {
          out.add(line)
          continue
        }
        // Order is preserved — it is the codec preference the peer reads.
        val payloads = parts.drop(3).filter { kept.contains(it) }
        out.add((parts.take(3) + payloads).joinToString(" "))
        continue
      }

      if (sectionIndex >= 0) {
        val kept = keptPayloadsBySection[sectionIndex]
        val pt = payloadType(line)
        if (kept != null && pt != null && !kept.contains(pt)) continue
      }

      out.add(line)
    }

    return out.joinToString(separator)
  }

  /**
   * The payload type an attribute line is bound to, if it is bound to one.
   * Lines that name no payload type return null and are always preserved.
   */
  private fun payloadType(line: String): String? {
    for (prefix in listOf("a=rtpmap:", "a=fmtp:", "a=rtcp-fb:")) {
      if (!line.startsWith(prefix)) continue
      val body = line.substring(prefix.length)
      val token = body.takeWhile { it != ' ' }
      return if (token.isEmpty()) null else token
    }
    return null
  }
}
