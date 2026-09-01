package com.miranatechnologies.tacendum.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SDP trimmer's vector twin
 * — the Kotlin sibling of `app/modules/tacendum-call/tests/main.swift`,
 * assertion for assertion, over the SAME libwebrtc-shaped offer.
 *
 * The headline assertion is the first one: the four security-relevant lines
 * come out byte-for-byte identical. `a=fingerprint` binds the DTLS-SRTP keys
 * to an envelope the server cannot read; if anything in this
 * transformation could rewrite it, a server could man-in-the-middle the media
 * while the messages stayed secure. Everything else here is about not
 * producing SDP the peer will reject.
 *
 * Runs on the HOST JVM, in about a second — the same argument
 * the Swift twin makes: an instrumentation
 * test needs a device and therefore, in practice, never runs, and the one
 * assertion guarding the media E2EE claim is the last one that should be rare.
 */
class SdpTrimmerVectorTest {

  private val fingerprint =
      "a=fingerprint:sha-256 D2:1E:C8:9A:44:0B:7F:31:6C:55:A0:E7:12:9D:3B:88:" +
          "F4:20:6A:CD:19:75:E3:82:B1:4C:07:9F:56:AA:31:E0"
  private val iceUfrag = "a=ice-ufrag:F7gK"
  private val icePwd = "a=ice-pwd:x9Nq2LmPvR4tZ7wB1cD3eF5g"
  private val setup = "a=setup:actpass"

  /** The same offer the Swift harness uses: BUNDLE, unified-plan, full zoo. */
  private val offer =
      listOf(
              "v=0",
              "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
              "s=-",
              "t=0 0",
              "a=group:BUNDLE 0 1",
              "a=msid-semantic: WMS stream",
              "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
              "c=IN IP4 0.0.0.0",
              "a=rtcp:9 IN IP4 0.0.0.0",
              iceUfrag,
              icePwd,
              "a=ice-options:trickle",
              fingerprint,
              setup,
              "a=mid:0",
              "a=sendrecv",
              "a=rtcp-mux",
              "a=rtpmap:111 opus/48000/2",
              "a=rtcp-fb:111 transport-cc",
              "a=fmtp:111 minptime=10;useinbandfec=1",
              "a=rtpmap:63 red/48000/2",
              "a=fmtp:63 111/111",
              "a=rtpmap:9 G722/8000",
              "a=rtpmap:0 PCMU/8000",
              "a=rtpmap:8 PCMA/8000",
              "a=rtpmap:13 CN/8000",
              "a=rtpmap:110 telephone-event/48000",
              "a=rtpmap:126 telephone-event/8000",
              "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 35 36 119 120",
              "c=IN IP4 0.0.0.0",
              iceUfrag,
              icePwd,
              fingerprint,
              setup,
              "a=mid:1",
              "a=sendrecv",
              "a=rtcp-mux",
              "a=rtpmap:96 VP8/90000",
              "a=rtcp-fb:96 goog-remb",
              "a=rtcp-fb:96 nack",
              "a=fmtp:96 x-google-start-bitrate=800",
              "a=rtpmap:97 rtx/90000",
              "a=fmtp:97 apt=96",
              "a=rtpmap:98 VP9/90000",
              "a=fmtp:98 profile-id=0",
              "a=rtpmap:99 rtx/90000",
              "a=fmtp:99 apt=98",
              "a=rtpmap:100 H264/90000",
              "a=rtcp-fb:100 nack",
              "a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
              "a=rtpmap:101 rtx/90000",
              "a=fmtp:101 apt=100",
              "a=rtpmap:35 AV1/90000",
              "a=fmtp:35 level-idx=5;profile=0;tier=0",
              "a=rtpmap:36 rtx/90000",
              "a=fmtp:36 apt=35",
              "a=rtpmap:119 ulpfec/90000",
              "a=rtpmap:120 rtx/90000",
          )
          .joinToString("\r\n")

  private val trimmed = SdpTrimmer.trim(offer)
  private val trimmedLines = trimmed.split("\r\n")

  @Test
  fun theFourSecurityLinesSurviveByteForByte() {
    // THE assertion. Anything that could rewrite `a=fingerprint` could
    // let a server man-in-the-middle the media while the messages stayed
    // secure — so the count AND the bytes are compared, not merely presence:
    // a transformation that dropped one of the two copies would still contain
    // the string.
    for ((label, line) in
        listOf(
            "fingerprint" to fingerprint,
            "ice-ufrag" to iceUfrag,
            "ice-pwd" to icePwd,
            "setup" to setup,
        )) {
      val before = offer.split("\r\n").count { it == line }
      val after = trimmedLines.count { it == line }
      assertTrue("$label must appear at least once in the input", before > 0)
      assertEquals("$label must survive byte-identical", before, after)
    }
  }

  @Test
  fun itActuallyRemovesSomething() {
    assertTrue("output is smaller", trimmed.length < offer.length)
    assertFalse("VP9 dropped — no dependable hardware path", trimmed.contains("VP9/90000"))
    assertFalse("AV1 dropped", trimmed.contains("AV1/90000"))
    assertFalse("G722 dropped", trimmed.contains("G722/8000"))
  }

  @Test
  fun itKeepsWhatACallNeeds() {
    assertTrue("H.264 kept", trimmed.contains("H264/90000"))
    assertTrue("VP8 kept", trimmed.contains("VP8/90000"))
    assertTrue("Opus kept", trimmed.contains("opus/48000/2"))
    assertTrue("telephone-event kept (mandatory)", trimmed.contains("telephone-event/48000"))
  }

  @Test
  fun theResultIsStillValidSdp() {
    val mLines = trimmedLines.filter { it.startsWith("m=") }
    assertEquals("both media sections survive", 2, mLines.size)
    for (m in mLines) {
      val payloads = m.split(" ").drop(3)
      assertTrue("m-line has payload types: $m", payloads.isNotEmpty())
    }
  }

  @Test
  fun noAttributeOutlivesItsPayloadType() {
    // An attribute bound to a removed payload type must go with it; one left
    // behind is a dangling reference the peer may reject.
    var currentDeclared = emptySet<String>()
    for (line in trimmedLines) {
      if (line.startsWith("m=")) {
        currentDeclared = line.split(" ").drop(3).toSet()
        continue
      }
      for (prefix in listOf("a=rtpmap:", "a=fmtp:", "a=rtcp-fb:")) {
        if (!line.startsWith(prefix)) continue
        val pt = line.substring(prefix.length).takeWhile { it != ' ' }
        assertTrue("orphaned attribute for removed payload: $line", currentDeclared.contains(pt))
      }
    }
  }

  @Test
  fun orderingIsPreservedBecauseItIsTheCodecPreference() {
    val video = trimmedLines.first { it.startsWith("m=video") }
    val payloads = video.split(" ").drop(3)
    val h264 = payloads.indexOf("100")
    val vp8 = payloads.indexOf("96")
    assertTrue("both video codecs present", h264 >= 0 && vp8 >= 0)
    // The offer listed VP8 (96) before H.264 (100); trimming must not reorder,
    // because reordering silently changes which codec the peer picks.
    assertTrue("original order kept (VP8 was listed first)", vp8 < h264)
  }

  @Test
  fun repairStreamsNeverOutliveWhatTheyRepair() {
    // RFC 4588 §8.1: an `apt=` naming a payload that is no longer in the
    // m-line is malformed, not merely untidy, and a receiver may reject the
    // whole m-line for it.
    val withRtx =
        listOf(
                "v=0",
                "m=video 9 UDP/TLS/RTP/SAVPF 100 101 102 103",
                "a=rtpmap:100 H264/90000",
                "a=rtpmap:101 rtx/90000",
                "a=fmtp:101 apt=100",
                "a=rtpmap:102 H265/90000",
                "a=rtpmap:103 rtx/90000",
                "a=fmtp:103 apt=102",
            )
            .joinToString("\r\n")
    val out = SdpTrimmer.trim(withRtx)
    val mLine = out.split("\r\n").first { it.startsWith("m=video") }
    val payloads = mLine.split(" ").drop(3)
    assertTrue("H.264 kept", payloads.contains("100"))
    assertTrue("the rtx that repairs H.264 is kept with it", payloads.contains("101"))
    assertFalse("H.265 dropped", payloads.contains("102"))
    assertFalse("the orphaned rtx is dropped, not left dangling", payloads.contains("103"))
    assertFalse("no apt= survives pointing at a payload that is gone", out.contains("apt=102"))
  }

  @Test
  fun edgeCases() {
    assertEquals("empty input is returned unchanged", "", SdpTrimmer.trim(""))
    val noMedia = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0"
    assertEquals("an SDP with no m-line is untouched", noMedia, SdpTrimmer.trim(noMedia))
    // LF-only input must not be silently rewritten to CRLF: that would mutate
    // every line, including the four that must not change.
    val lfOnly = "v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2"
    assertFalse("LF-only line endings are preserved", SdpTrimmer.trim(lfOnly).contains("\r\n"))
  }

  @Test
  fun anMLineIsNeverEmptied() {
    // Every payload unrecognised: dropping them all would produce invalid SDP
    // the peer rejects outright, which is strictly worse than a large offer.
    val exotic =
        listOf(
                "v=0",
                "m=video 9 UDP/TLS/RTP/SAVPF 98 99",
                "a=rtpmap:98 VP9/90000",
                "a=rtpmap:99 AV1/90000",
            )
            .joinToString("\r\n")
    val out = SdpTrimmer.trim(exotic)
    val payloads = out.split("\r\n").first { it.startsWith("m=video") }.split(" ").drop(3)
    assertEquals("both payloads restored rather than an empty m-line", listOf("98", "99"), payloads)
  }

  // MARK: - the fault injector

  private val clean =
      listOf(
              "v=0",
              "m=audio 9 UDP/TLS/RTP/SAVPF 111",
              "a=rtpmap:111 opus/48000/2",
              "a=ice-ufrag:F7gI",
              "a=ice-pwd:x9cml/YzichV2+XlhiMu8g",
              "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89",
              "a=setup:actpass",
          )
          .joinToString("\r\n")

  @Test
  fun theFaultInjectorBreaksOnlyTheFingerprint() {
    // The design claims the server cannot MITM the media. Half of that is proven
    // above — the trimmer leaves `a=fingerprint` byte-for-byte intact. The
    // other half is that a WRONG fingerprint is actually REJECTED, which needs
    // a build that injects one. These assertions cover the injector; the
    // handshake failure itself needs two peers and is device-matrix work.
    val faulted = FingerprintFault.corrupt(clean)
    val cleanLines = clean.split("\r\n")
    val faultLines = faulted.split("\r\n")
    assertEquals("no lines added or removed", cleanLines.size, faultLines.size)

    val differing = cleanLines.zip(faultLines).filter { it.first != it.second }
    assertEquals("exactly one line changed", 1, differing.size)
    assertTrue("and it is the fingerprint line", differing[0].first.startsWith("a=fingerprint:"))

    // The structure has to survive, or the peer rejects the SDP at PARSE time
    // and the test passes for the wrong reason — it would prove the parser
    // works, not that DTLS verifies the fingerprint.
    val changed = faultLines.first { it.startsWith("a=fingerprint:") }
    val original = "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89"
    assertTrue("algorithm and prefix preserved", changed.startsWith("a=fingerprint:sha-256 "))
    assertEquals("same length — one digit swapped, not a rewrite", original.length, changed.length)
    assertNotEquals("the hash actually changed", original, changed)
    assertEquals(
        "octet grouping intact",
        original.count { it == ':' },
        changed.count { it == ':' },
    )
  }

  @Test
  fun theFaultInjectorLeavesTheOtherSecurityLinesAlone() {
    // Corrupting ice-ufrag/ice-pwd/setup would fail the call for a DIFFERENT
    // reason and the device test would claim a DTLS result it never obtained.
    val faulted = FingerprintFault.corrupt(clean)
    val cleanLines = clean.split("\r\n")
    val faultLines = faulted.split("\r\n")
    for (prefix in listOf("a=ice-ufrag:", "a=ice-pwd:", "a=setup:")) {
      assertEquals(
          "$prefix untouched, so a failure can only be the fingerprint",
          cleanLines.first { it.startsWith(prefix) },
          faultLines.first { it.startsWith(prefix) },
      )
    }
  }

  @Test
  fun theFaultInjectorIsDeterministicAndEndingPreserving() {
    // A flaky corruption would make a failed device run impossible to
    // reproduce.
    assertEquals(
        "corruption is deterministic",
        FingerprintFault.corrupt(clean),
        FingerprintFault.corrupt(clean),
    )
    val lf = "v=0\na=fingerprint:sha-256 AB:CD\n"
    assertFalse("LF-only input stays LF-only", FingerprintFault.corrupt(lf).contains("\r\n"))
  }

  @Test
  fun trimmingAFaultedOfferStillLeavesTheFaultedLineAlone() {
    // The order in the shipped path is trim-then-fault, but a future caller
    // that reverses them must not have the trimmer quietly repair the fault:
    // the untouchable-prefix rule is what guarantees that, and this is the
    // assertion that would notice if it stopped being true.
    val faulted = FingerprintFault.corrupt(offer)
    val out = SdpTrimmer.trim(faulted)
    val faultedFingerprints = faulted.split("\r\n").filter { it.startsWith("a=fingerprint:") }
    val outFingerprints = out.split("\r\n").filter { it.startsWith("a=fingerprint:") }
    assertEquals("every faulted fingerprint survives the trim", faultedFingerprints, outFingerprints)
    assertFalse("and the honest one is gone", out.contains(fingerprint))
  }
}
