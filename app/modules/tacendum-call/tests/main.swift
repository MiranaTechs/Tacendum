import Foundation

/**
 * Tests for the SDP trimmer.
 *
 * Plain Swift with no XCTest and no WebRTC import, so `SdpTrimmer` can be
 * compiled and exercised by a plain swiftc run in about a second —
 * no Xcode project, no simulator, no device. The alternative was an XCTest
 * target that only runs inside a full iOS build, which in practice means the
 * one assertion that guards the media E2EE claim would run rarely.
 *
 * It lives OUTSIDE `ios/` on purpose: the podspec globs `ios/**/*.swift`, so a
 * test file in there would be compiled into the shipping app binary. It is
 * `main.swift` because Swift permits top-level code in that file and nowhere
 * else.
 *
 * The headline assertion is the last one: the four security-relevant lines
 * come out byte-for-byte identical. Everything else is about not producing
 * SDP the peer will reject.
 */

var failures = 0
var passes = 0

func check(_ condition: Bool, _ what: String) {
  if condition {
    passes += 1
    print("  ✓ \(what)")
  } else {
    failures += 1
    print("  ✗ \(what)")
  }
}

func section(_ title: String) {
  print("")
  print("== \(title)")
}

/// A libwebrtc-shaped offer: BUNDLE, unified-plan, the full codec zoo that
/// makes trimming worth doing, and the four lines that must survive it.
let FINGERPRINT = "a=fingerprint:sha-256 D2:1E:C8:9A:44:0B:7F:31:6C:55:A0:E7:12:9D:3B:88:F4:20:6A:CD:19:75:E3:82:B1:4C:07:9F:56:AA:31:E0"
let ICE_UFRAG = "a=ice-ufrag:F7gK"
let ICE_PWD = "a=ice-pwd:x9Nq2LmPvR4tZ7wB1cD3eF5g"
let SETUP = "a=setup:actpass"

let offer = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=msid-semantic: WMS stream",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  ICE_UFRAG,
  ICE_PWD,
  "a=ice-options:trickle",
  FINGERPRINT,
  SETUP,
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
  ICE_UFRAG,
  ICE_PWD,
  FINGERPRINT,
  SETUP,
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
].joined(separator: "\r\n")

let trimmed = SdpTrimmer.trim(offer)
let trimmedLines = trimmed.components(separatedBy: "\r\n")

section("the four security-relevant lines survive byte-for-byte")
// THE assertion. `a=fingerprint` binds the DTLS-SRTP keys to an envelope the
// server cannot read; if anything here could rewrite it, a server could
// man-in-the-middle the media while the messages stayed secure.
for (label, line) in [
  ("fingerprint", FINGERPRINT),
  ("ice-ufrag", ICE_UFRAG),
  ("ice-pwd", ICE_PWD),
  ("setup", SETUP),
] {
  let before = offer.components(separatedBy: "\r\n").filter { $0 == line }.count
  let after = trimmedLines.filter { $0 == line }.count
  check(after == before && before > 0,
        "\(label) present \(before)× before and \(after)× after, byte-identical")
}

section("it actually removes something")
check(trimmed.count < offer.count, "output is smaller (\(offer.count) → \(trimmed.count) bytes)")
check(!trimmed.contains("VP9/90000"), "VP9 dropped — no hardware path on the device floor")
check(!trimmed.contains("AV1/90000"), "AV1 dropped")
check(!trimmed.contains("G722/8000"), "G722 dropped")

section("it keeps what a call needs")
check(trimmed.contains("H264/90000"), "H.264 kept (hardware encode/decode)")
check(trimmed.contains("VP8/90000"), "VP8 kept (software fallback)")
check(trimmed.contains("opus/48000/2"), "Opus kept")
check(trimmed.contains("telephone-event/48000"), "telephone-event kept (mandatory)")

section("the result is still valid SDP")
let mLines = trimmedLines.filter { $0.hasPrefix("m=") }
check(mLines.count == 2, "both media sections survive")
for m in mLines {
  let payloads = m.split(separator: " ").dropFirst(3)
  check(!payloads.isEmpty, "m-line has payload types: \(m.prefix(24))…")
}

// An attribute bound to a removed payload type must go with it; one left
// behind is a dangling reference the peer may reject.
for line in trimmedLines {
  for prefix in ["a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"] where line.hasPrefix(prefix) {
    let pt = String(line.dropFirst(prefix.count).prefix { $0 != " " })
    // Which section is this in? Find the nearest preceding m-line.
    guard let idx = trimmedLines.firstIndex(of: line) else { continue }
    let m = trimmedLines[..<idx].last { $0.hasPrefix("m=") }
    guard let mline = m else { continue }
    let declared = Set(mline.split(separator: " ").dropFirst(3).map(String.init))
    if !declared.contains(pt) {
      check(false, "orphaned attribute for removed payload \(pt): \(line.prefix(30))…")
    }
  }
}
check(true, "no attribute lines left pointing at a removed payload type")

section("ordering is preserved — it IS the codec preference")
if let video = mLines.first(where: { $0.hasPrefix("m=video") }) {
  let payloads = video.split(separator: " ").dropFirst(3).map(String.init)
  let h264 = payloads.firstIndex(of: "100")
  let vp8 = payloads.firstIndex(of: "96")
  check(h264 != nil && vp8 != nil, "both video codecs present")
  // The offer listed VP8 (96) before H.264 (100); trimming must not reorder,
  // because reordering silently changes which codec the peer picks.
  if let h = h264, let v = vp8 { check(v < h, "original order kept (VP8 was listed first)") }
}

section("repair streams never outlive what they repair (RFC 4588 §8.1)")
// H.264 (100) and its rtx (101) survive; H.265 (102) is dropped, so ITS rtx
// (103) must go too. An `apt=` naming a payload that is no longer in the
// m-line is malformed, not merely untidy, and a receiver may reject the whole
// m-line for it.
let withRtx = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 100 101 102 103",
  "a=rtpmap:100 H264/90000",
  "a=rtpmap:101 rtx/90000",
  "a=fmtp:101 apt=100",
  "a=rtpmap:102 H265/90000",
  "a=rtpmap:103 rtx/90000",
  "a=fmtp:103 apt=102",
].joined(separator: "\r\n")
let trimmedRtx = SdpTrimmer.trim(withRtx)
let rtxMLine = trimmedRtx.components(separatedBy: "\r\n").first { $0.hasPrefix("m=video") } ?? ""
let rtxPayloads = rtxMLine.split(separator: " ").dropFirst(3).map(String.init)
check(rtxPayloads.contains("100"), "H.264 kept")
check(rtxPayloads.contains("101"), "the rtx that repairs H.264 is kept with it")
check(!rtxPayloads.contains("102"), "H.265 dropped")
check(!rtxPayloads.contains("103"), "the orphaned rtx is dropped, not left dangling")
check(
  !trimmedRtx.contains("apt=102"),
  "no apt= survives pointing at a payload that is gone"
)

section("edge cases")
check(SdpTrimmer.trim("") == "", "empty input is returned unchanged")
let noMedia = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0"
check(SdpTrimmer.trim(noMedia) == noMedia, "an SDP with no m-line is untouched")
// LF-only input must not be silently rewritten to CRLF: that would mutate
// every line, including the four that must not change.
let lfOnly = "v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2"
check(!SdpTrimmer.trim(lfOnly).contains("\r\n"), "LF-only line endings are preserved")


section("the fingerprint fault injector breaks ONLY the fingerprint")
// The design claims the server cannot MITM the media. Half of that is proven above —
// the trimmer leaves `a=fingerprint` byte-for-byte intact. The other half is
// that a WRONG fingerprint is actually rejected, which needs a build that
// injects one. These assertions cover the injector; the handshake failure
// itself needs two peers and is a device test.
let clean = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=ice-ufrag:F7gI",
  "a=ice-pwd:x9cml/YzichV2+XlhiMu8g",
  "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89",
  "a=setup:actpass",
].joined(separator: "\r\n")
let faulted = FingerprintFault.corrupt(clean)

let cleanLines = clean.components(separatedBy: "\r\n")
let faultLines = faulted.components(separatedBy: "\r\n")
check(cleanLines.count == faultLines.count, "no lines added or removed")

let differing = zip(cleanLines, faultLines).filter { $0 != $1 }
check(differing.count == 1, "exactly one line changed")
check(differing.first?.0.hasPrefix("a=fingerprint:") == true, "and it is the fingerprint line")

// The structure has to survive, or the peer rejects the SDP at PARSE time and
// the test passes for the wrong reason — it would prove the parser works, not
// that DTLS verifies the fingerprint.
if let changed = faultLines.first(where: { $0.hasPrefix("a=fingerprint:") }) {
  check(changed.hasPrefix("a=fingerprint:sha-256 "), "algorithm and prefix preserved")
  check(changed.count == "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89".count,
        "same length — one digit swapped, not a rewrite")
  check(changed != "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89",
        "the hash actually changed")
  let colons = changed.filter { $0 == ":" }.count
  check(colons == "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89".filter { $0 == ":" }.count,
        "octet grouping intact")
}

// ice-ufrag/ice-pwd/setup must be untouched: corrupting those would fail the
// call for a DIFFERENT reason and the test would claim a DTLS result it never
// obtained.
for prefix in ["a=ice-ufrag:", "a=ice-pwd:", "a=setup:"] {
  let before = cleanLines.first { $0.hasPrefix(prefix) }
  let after = faultLines.first { $0.hasPrefix(prefix) }
  check(before == after, "\(prefix) untouched, so a failure can only be the fingerprint")
}

// Deterministic: a flaky corruption would make a failed device run impossible
// to reproduce.
check(FingerprintFault.corrupt(clean) == faulted, "corruption is deterministic")

// LF-only must work too — the injector runs on real libwebrtc output, and the
// trimmer above is careful about exactly this.
let lf = "v=0\na=fingerprint:sha-256 AB:CD\n"
check(!FingerprintFault.corrupt(lf).contains("\r\n"), "LF-only input stays LF-only")

section("native calls stay bound to one account")
let missingOwner = AccountCallOwner(initialOwner: "")
check(missingOwner.lease(for: "new-account") == nil,
      "an upgraded install fails closed until JS adopts its account")
check(missingOwner.currentLease() == nil,
      "direct call/media work is denied without an owner")

let accountOwner = AccountCallOwner(initialOwner: "old-account")
let oldLease = accountOwner.lease(for: "old-account")
check(oldLease != nil, "the exact push recipient is accepted")
check(accountOwner.lease(for: "new-account") == nil,
      "a push for another account is rejected")
check(accountOwner.lease(for: "") == nil,
      "a push without a recipient is rejected")

check(accountOwner.beginChange(to: "old-account") == nil,
      "adopting the same account is idempotent")
if let oldLease {
  check(accountOwner.isCurrent(oldLease),
        "same-account adoption keeps already-authorized work current")
}

let clear = accountOwner.beginChange(to: "")
check(clear != nil && accountOwner.currentOwner.isEmpty,
      "clearing denies calls before native teardown begins")
if let oldLease {
  check(!accountOwner.isCurrent(oldLease),
        "clearing invalidates asynchronous work captured by the old account")
}
if let clear { accountOwner.finishChange(clear) }
check(accountOwner.currentLease() == nil,
      "cleared ownership stays denied")

let adoptNew = accountOwner.beginChange(to: "new-account")
check(adoptNew != nil && accountOwner.currentLease() == nil,
      "rotation has a denied interval while old calls are cleared")
if let adoptNew { accountOwner.finishChange(adoptNew) }
check(accountOwner.currentOwner == "new-account",
      "the new account is adopted only after teardown")
check(accountOwner.lease(for: "old-account") == nil,
      "an old-account push cannot ring after rotation")
let newLease = accountOwner.lease(for: "new-account")
check(newLease != nil, "the new account recipient is accepted")
if let oldLease {
  check(!accountOwner.isCurrent(oldLease),
        "an old asynchronous callback cannot bind to the new account")
}
if let newLease {
  check(accountOwner.isCurrent(newLease),
        "new-account work remains current")
}

let interrupted = AccountCallOwner(initialOwner: "old-account")
let staleAdoption = interrupted.beginChange(to: "new-account")
let clearingRetry = interrupted.beginChange(to: "")
if let staleAdoption { interrupted.finishChange(staleAdoption) }
check(interrupted.currentOwner.isEmpty,
      "a clear superseding an interrupted rotation prevents late adoption")
check(clearingRetry != nil,
      "an interrupted durable-clear can be retried while ownership is empty")
if let clearingRetry { interrupted.finishChange(clearingRetry) }
check(interrupted.currentLease() == nil,
      "the clearing retry completes in the denied state")

section("the iOS owner marker is durable and fail closed")
let ownerTestRoot = FileManager.default.temporaryDirectory
  .appendingPathComponent("tacendum-owner-\(UUID().uuidString)", isDirectory: true)
let ownerTestFile = ownerTestRoot.appendingPathComponent("owner")
let ownerStore = AccountCallOwnerStore(fileURL: ownerTestFile)
check(ownerStore.read().isEmpty, "a missing marker reads as no owner")
do {
  try ownerStore.write("old-account")
  check(AccountCallOwnerStore(fileURL: ownerTestFile).read() == "old-account",
        "a new store instance reads the fsynced owner")
  check(try URL(fileURLWithPath: ownerTestRoot.path)
    .resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true,
        "native ownership cannot be backed up without its protocol identity")
  var restoredDirectory = ownerTestRoot
  var backupValues = URLResourceValues()
  backupValues.isExcludedFromBackup = false
  try restoredDirectory.setResourceValues(backupValues)
  try ownerStore.write("")
  check(try URL(fileURLWithPath: ownerTestRoot.path)
    .resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true,
        "each owner write reasserts backup exclusion")
  check(AccountCallOwnerStore(fileURL: ownerTestFile).read().isEmpty,
        "the durable empty marker survives a new store instance")
  try ownerStore.write("new-account")
  check(AccountCallOwnerStore(fileURL: ownerTestFile).read() == "new-account",
        "a replacement account persists only as the new owner")
} catch {
  check(false, "atomic owner writes complete without error")
}
try? Data([0xff, 0xfe]).write(to: ownerTestFile, options: .atomic)
check(AccountCallOwnerStore(fileURL: ownerTestFile).read().isEmpty,
      "malformed persisted bytes fail closed")
try? FileManager.default.removeItem(at: ownerTestRoot)

let blockedParent = FileManager.default.temporaryDirectory
  .appendingPathComponent("tacendum-owner-blocked-\(UUID().uuidString)")
try? Data("not a directory".utf8).write(to: blockedParent)
var refusedBrokenStore = false
do {
  try AccountCallOwnerStore(
    fileURL: blockedParent.appendingPathComponent("owner")
  ).write("account")
} catch {
  refusedBrokenStore = true
}
check(refusedBrokenStore, "an owner marker that cannot persist reports failure")
try? FileManager.default.removeItem(at: blockedParent)

print("")
print("== result: \(passes) passed, \(failures) failed")
if failures > 0 {
  print("SDP TRIM VERIFICATION FAILED")
  exit(1)
}
print("SDP TRIM VERIFIED — the four security lines are byte-identical")
