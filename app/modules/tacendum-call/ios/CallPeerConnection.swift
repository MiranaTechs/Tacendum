import Foundation
import WebRTC

/**
 * One call's peer connection.
 *
 * Everything about media lives here and nothing about the call *protocol*
 * does: this object does not know what a `cid` means to the rest of the
 * system, when to ring, or when to give up. It creates offers, applies
 * answers, gathers candidates and reports state. The reducer decides; this
 * executes — which is why the protocol is testable on a laptop.
 *
 * **The DTLS role is negotiated normally** (`a=setup:actpass` → `active`) and
 * nothing here customises it. Deviating from standard DTLS-SRTP negotiation is
 * exactly the "novel cryptography" this codebase forbids, and the
 * fingerprint that the negotiation produces is the value the whole media E2EE
 * claim rests on.
 */
final class CallPeerConnection: NSObject {
  let cid: String
  private let connection: RTCPeerConnection
  private let factory: RTCPeerConnectionFactory
  private let events: CallEventSink

  private var audioTrack: RTCAudioTrack?
  private var videoTrack: RTCVideoTrack?
  private var videoSource: RTCVideoSource?
  private var capturer: RTCVideoCapturer?
  private var usingSyntheticVideo = false
  /// Fault injector: send a deliberately wrong `a=fingerprint`. DEBUG only.
  private var faultFingerprint = false

  /// Candidates that arrived before the remote description was applied.
  /// libwebrtc rejects them outright in that window, and dropping them costs
  /// exactly the connectivity path they described.
  private var pendingRemoteCandidates: [RTCIceCandidate] = []
  private var remoteDescriptionSet = false
  /// Local tracks are added exactly once per peer connection. See
  /// `addLocalMedia` for what a second pass cost.
  private var localMediaAdded = false
  /**
   * THIS CONNECTION IS OVER.
   *
   * `TacendumCallImpl`'s tombstone closes the race in which `closeCall`
   * arrives BEFORE the `Task` has installed the connection. It says nothing
   * about the far more ordinary one that comes after: `makeCall` installs and
   * unlocks, `closeCall` removes the entry and closes it, and the same Task
   * then walks on into `createOffer`/`createAnswer` — adding local media to a
   * closed connection, which takes the microphone and (with video) starts an
   * `AVCaptureSession` on a call that no longer exists anywhere. The
   * dictionary no longer holds it, so nothing above the bridge can close it a
   * second time.
   *
   * One flag, under `stateLock` like every other cross-Task field here, read
   * at each point where this object is about to acquire hardware or advance
   * the negotiation. The check is not "did somebody ask nicely" — a closed
   * peer connection cannot produce a usable offer anyway; what the flag buys
   * is that it never reaches `factory.audioTrack` to find out.
   */
  private var closed = false
  /// Previous cumulative counters, so quality is measured per interval rather
  /// than over the call's lifetime. Guarded by `stateLock` like the rest.
  private var lastPacketsLost = 0.0
  private var lastPacketsReceived = 0.0

  /// Guards the three fields above.
  ///
  /// Every public method here is `async` and is invoked from an unstructured
  /// `Task` in `TacendumCallImpl`, so two of them genuinely run at once on
  /// different threads — a `call.ice` batch arriving while the answer is being
  /// applied is the ordinary case, not a rare one. `pendingRemoteCandidates`
  /// is a Swift `Array`: concurrent `append` and reassign is not a lost
  /// candidate, it is a torn buffer.
  ///
  /// The lock is held only across the decisions, never across an `await` —
  /// `connection.add` happens after it is released, so a slow libwebrtc call
  /// cannot block the next batch, and a non-recursive lock cannot deadlock on
  /// a suspension point.
  private let stateLock = NSLock()

  init(
    cid: String,
    factory: RTCPeerConnectionFactory,
    config: RTCConfiguration,
    events: CallEventSink
  ) throws {
    self.cid = cid
    self.factory = factory
    self.events = events

    // No data channel and no legacy constraints. `DtlsSrtpKeyAgreement` is
    // required: without it libwebrtc would fall back to SDES, which puts the
    // media keys IN the SDP as plaintext. Inside our envelope that is still
    // ratcheted, but it discards the property that even a future compromise
    // of the signalling channel cannot retroactively decrypt the media.
    let constraints = RTCMediaConstraints(
      mandatoryConstraints: nil,
      optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue]
    )
    guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: nil)
    else { throw CallError.peerConnectionFailed }
    self.connection = pc
    super.init()
    pc.delegate = self
  }

  // MARK: - media

  /// Add the local tracks. Audio always; video only when the call opened with
  /// it, because adding a video transceiver we never use still negotiates a
  /// second m-line and costs setup time.
  ///
  /// **Idempotent, and that is load-bearing.** `createOffer` guards with
  /// `if !iceRestart`, but `createAnswer` did not, and `TacendumCallImpl`
  /// deliberately REUSES an existing peer connection when an ICE restart
  /// arrives so the credentials continue. So answering a restart ran this a
  /// second time: two more `connection.add(...)` calls, and `audioTrack`,
  /// `videoTrack`, `videoSource` and `capturer` all rebound to the new
  /// objects.
  ///
  /// The old tracks stayed on the connection and stayed enabled — and because
  /// a restart offer carries the same mids, the remote description stays
  /// associated with the ORIGINAL transceivers, so the old tracks are the ones
  /// still transmitting while the new ones never send at all. Every control
  /// then pointed at the wrong object: `setAudioEnabled` muted a track that
  /// was not on the air, so the user tapped Mute, the UI and the lock screen
  /// both showed muted, and the microphone kept transmitting for the rest of
  /// the call. `close()` likewise stopped only the newest capturer, leaving an
  /// `AVCaptureSession` running with the camera on.
  ///
  /// Guarding at the source rather than at the two call sites: this is a
  /// property of the peer connection (its local media is added once), and the
  /// next caller should not have to know that.
  func addLocalMedia(withVideo: Bool) {
    // Test-and-set under the lock: `createOffer` and `createAnswer` both reach
    // here from separate Tasks, so an unguarded read-then-write is the same
    // double-add this guard exists to stop.
    //
    // The closed test rides in the SAME critical section as that set, and that
    // is the correctness argument rather than an optimisation: a `close()`
    // landing between a separate check and this assignment would be overwritten
    // by the very state change it was racing, and the microphone would open
    // behind it.
    stateLock.lock()
    let alreadyAdded = localMediaAdded || closed
    localMediaAdded = true
    stateLock.unlock()
    guard !alreadyAdded else { return }

    // CREATE OUTSIDE THE LOCK, INSTALL UNDER IT OR DESTROY.
    //
    // The test-and-set above closes the window before this line and nothing
    // after it. Building a video source, a track and an `AVCaptureSession`
    // takes real time — device enumeration, format selection, a capture
    // session start — and the old shape did that work with the lock released
    // and assigned `self.capturer` only at the end. A `close()` arriving in
    // that gap raised `closed`, looked at a `capturer` that was still nil,
    // stopped nothing, closed the connection and returned. `close()` is
    // idempotent, so nothing ever came back for the capturer this method then
    // installed: a camera still running, and its indicator still lit, on a
    // call the app believes is over. That is the exact failure the `closed`
    // flag was added against, arriving one step later than the flag looks.
    //
    // So the objects are built into LOCALS, and the lock is retaken to decide
    // their fate atomically with the flag that condemns them. Everything the
    // capture pipeline owns is either installed where `close()` can see it or
    // torn down here; there is no third outcome and no window between them.
    let audioSource = factory.audioSource(with: nil)
    let audio = factory.audioTrack(with: audioSource, trackId: "a0")

    var newSource: RTCVideoSource?
    var newTrack: RTCVideoTrack?
    var newCapturer: RTCVideoCapturer?
    if withVideo {
      let source = factory.videoSource()
      newSource = source
      newTrack = factory.videoTrack(with: source, trackId: "v0")
      // STARTED before the re-check, deliberately. The alternative — install
      // first, start after — moves the same hole one line down: `close()`
      // would stop a capturer that has not begun, and the start would run
      // behind it. A capturer that is running by the time the lock is taken is
      // one this method can always account for.
      newCapturer = makeCapturer(source: source)
    }

    stateLock.lock()
    let closedInGap = closed
    if !closedInGap {
      audioTrack = audio
      videoSource = newSource
      videoTrack = newTrack
      capturer = newCapturer
    }
    stateLock.unlock()

    guard !closedInGap else {
      // The call died while this was being built. Nothing was installed, so
      // nothing here is reachable from `close()` — which means this is the only
      // place that can end it.
      Self.stopCapturer(newCapturer)
      audio.isEnabled = false
      newTrack?.isEnabled = false
      return
    }

    connection.add(audio, streamIds: ["s0"])
    guard let track = newTrack else { return }
    connection.add(track, streamIds: ["s0"])
    // Published so a preview can render it. Without this the local PiP has
    // nothing to show and the person cannot tell whether their camera is
    // pointed at them, which is the first thing anyone checks. AFTER the
    // install, so it can never outlive the `clear(cid:)` in `close()`.
    VideoTrackRegistry.shared.set(track, cid: cid, role: .local)
    applyVideoEncodingPreferences()
  }

  /// Build and START a capturer WITHOUT installing it: the caller decides,
  /// under `stateLock`, whether it becomes `self.capturer` or is stopped.
  private func makeCapturer(source: RTCVideoSource) -> RTCVideoCapturer? {
    #if DEBUG
      if usingSyntheticVideo {
        // The Simulator has no camera, so without this the whole media
        // pipeline — capture, encode, DTLS-SRTP, decode, render — is only
        // testable on two physical phones.
        let synthetic = SyntheticVideoCapturer(delegate: source)
        synthetic.startCapture()
        return synthetic
      }
    #endif
    let camera = RTCCameraVideoCapturer(delegate: source)
    startCamera(camera, position: .front)
    return camera
  }

  /// The ONE way a capturer is stopped. `close()` and the abandoned-install
  /// path above must not be able to drift apart about what "stopped" means —
  /// a synthetic capturer the teardown forgot is a hardware camera on the next
  /// build that makes it real.
  private static func stopCapturer(_ capturer: RTCVideoCapturer?) {
    if let camera = capturer as? RTCCameraVideoCapturer {
      camera.stopCapture()
    }
    #if DEBUG
      (capturer as? SyntheticVideoCapturer)?.stopCapture()
    #endif
  }

  private func startCamera(_ camera: RTCCameraVideoCapturer, position: AVCaptureDevice.Position) {
    guard
      let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == position })
    else { return }
    // 1280×720 @ 30. `degradationPreference` handles the rest; picking
    // a lower capture format here would put a ceiling the adaptation cannot
    // lift when conditions improve.
    let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
    let target = formats.min { lhs, rhs in
      let l = CMVideoFormatDescriptionGetDimensions(lhs.formatDescription)
      let r = CMVideoFormatDescriptionGetDimensions(rhs.formatDescription)
      return abs(Int(l.width) - 1280) < abs(Int(r.width) - 1280)
    }
    guard let format = target,
          let fps = format.videoSupportedFrameRateRanges.map({ $0.maxFrameRate }).max()
    else { return }
    camera.startCapture(with: device, format: format, fps: Int(min(fps, 30)))
  }

  private func applyVideoEncodingPreferences() {
    guard let sender = connection.senders.first(where: { $0.track?.kind == "video" }) else { return }
    let params = sender.parameters
    // `balanced` drops resolution and frame rate together. `maintainFramerate`
    // looks markedly worse on a talking head, which is what these calls are.
    params.degradationPreference = NSNumber(value: RTCDegradationPreference.balanced.rawValue)
    for encoding in params.encodings {
      // A ceiling, not a target: congestion control still starts low and
      // ramps. 4.5 Mbps is sized for 720p30 H.264 with headroom for motion
      // and low light — the two places 1.5 Mbps visibly softened — and sits
      // well under the relay's per-session bound (max-bps is 2,000,000
      // BYTES/s ≈ 16 Mbit/s each way), so a relayed call is never clipped
      // by its own encoder cap.
      encoding.maxBitrateBps = NSNumber(value: 4_500_000)
      encoding.minBitrateBps = NSNumber(value: 150_000)
    }
    sender.parameters = params
  }

  /**
   * Cap the encoder under thermal or battery pressure.
   *
   * `scaleResolutionDownBy` rather than restarting capture at a lower format:
   * a `stopCapture`/`startCapture` cycle drops roughly a second of video and
   * would happen every time the phone crossed a thermal boundary, which is
   * exactly when it is already struggling. Scaling is applied by the encoder
   * on frames it already has.
   *
   * The scale is derived from the CAPTURE size, so
   * the cap means what it says regardless of what the negotiated resolution
   * settled at. Passing a cap at or above the capture size restores the
   * default, which is what a phone that has cooled down needs.
   */
  func applyVideoCap(maxLongEdge: Int, maxFps: Int) {
    guard let sender = connection.senders.first(where: { $0.track?.kind == "video" }) else { return }
    let params = sender.parameters
    let captureLongEdge = 1280.0
    let scale = maxLongEdge <= 0 ? 1.0 : max(1.0, captureLongEdge / Double(maxLongEdge))
    for encoding in params.encodings {
      // nil, not 1.0, when uncapped: libwebrtc treats an explicit 1.0 as a
      // pinned request and stops adapting resolution downward on its own,
      // which would disable the network-driven degradation the design relies on.
      encoding.scaleResolutionDownBy = scale > 1.0 ? NSNumber(value: scale) : nil
      encoding.maxFramerate = maxFps > 0 ? NSNumber(value: maxFps) : nil
      // Bitrate follows resolution; leaving the full cap against 640×360
      // would spend the saved pixels back on an unnecessarily high bitrate
      // and heat the radio instead of the encoder. The uncapped value must
      // match `applyVideoEncodingPreferences`, or lifting a cap would
      // "restore" the call to a different ceiling than it started with.
      encoding.maxBitrateBps = NSNumber(value: scale > 1.0 ? 600_000 : 4_500_000)
    }
    sender.parameters = params
  }

  /// Enable or disable the local audio track, and SAY WHETHER IT HAPPENED.
  ///
  /// `audioTrack` is nil until `addLocalMedia` has run, and a connection torn
  /// down by a failure has none either — so "mute" against one of those
  /// silenced nothing and reported nothing, which for a microphone is the
  /// worst shape a failure can take: the UI, the lock screen and the dynamic
  /// island all say muted while the track transmits. The verdict is what
  /// `GroupCallCoordinator`'s all-or-close-the-leg acts on: a leg that cannot
  /// be silenced is CLOSED rather than left open behind a muted button.
  ///
  /// @discardableResult because the shipped 1:1 callers have nothing to do
  /// with the answer — one call, one track, and the machine tears the whole
  /// call down when its media dies.
  @discardableResult
  func setAudioEnabled(_ on: Bool) -> Bool {
    guard let track = audioTrack else { return false }
    track.isEnabled = on
    return true
  }

  // / Whether this connection took the camera — a local video track exists.
  // / What the proximity rule reads: a call negotiated with video is / one
  // the person is looking at, whatever the camera is doing right now.
  var hasLocalVideo: Bool { videoTrack != nil }

  /// The camera's half of the same contract. A video track that cannot be
  /// stopped is a camera the person believes is off.
  @discardableResult
  func setVideoEnabled(_ on: Bool) -> Bool {
    guard let track = videoTrack else { return false }
    track.isEnabled = on
    return true
  }

  func switchCamera() {
    guard let camera = capturer as? RTCCameraVideoCapturer else { return }
    let current = camera.captureSession.inputs
      .compactMap { ($0 as? AVCaptureDeviceInput)?.device.position }
      .first ?? .front
    camera.stopCapture { [weak self] in
      guard let self = self else { return }
      self.startCamera(camera, position: current == .front ? .back : .front)
      // Re-announce so an attached preview re-reads its mirroring: a back
      // camera preview must NOT be mirrored, and a stale hint leaves the
      // person looking at a reversed image of the room.
      if let track = self.videoTrack {
        VideoTrackRegistry.shared.set(track, cid: self.cid, role: .local)
      }
    }
  }

  #if DEBUG
    func useSyntheticVideo(_ on: Bool) { usingSyntheticVideo = on }
    func useFingerprintFault(_ on: Bool) { faultFingerprint = on }

    /// Applied AFTER `SdpTrimmer.trim` and after `setLocalDescription`, so the
    /// description libwebrtc holds is the honest one and only the SDP that
    /// LEAVES this device carries the wrong fingerprint. That is what the
    /// server would be able to do, and therefore what the no-MITM claim is about.
    private func faulted(_ sdp: String) -> String {
      faultFingerprint ? FingerprintFault.corrupt(sdp) : sdp
    }
  #endif

  // MARK: - negotiation

  /// Whether `close()` has run. Every suspension point in this file's
  /// negotiation methods is a place `closeCall` can land, so each one is
  /// followed by a look at this.
  var isClosed: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return closed
  }

  func createOffer(withVideo: Bool, iceRestart: Bool = false) async throws -> String {
    // ABANDONED, not merely unsuccessful. The Task that reaches here was
    // started before `closeCall` arrived, and the call it is negotiating for
    // is over; the throw travels back as an ordinary `offer_failed` rejection,
    // which the reducer already treats as a call that could not be placed.
    if isClosed { throw CallError.closed }
    if !iceRestart { addLocalMedia(withVideo: withVideo) }
    var mandatory: [String: String] = [:]
    if iceRestart { mandatory["IceRestart"] = kRTCMediaConstraintsValueTrue }
    let constraints = RTCMediaConstraints(
      mandatoryConstraints: mandatory.isEmpty ? nil : mandatory,
      optionalConstraints: nil
    )
    let offer = try await connection.offer(for: constraints)
    if isClosed { throw CallError.closed }
    // Trim BEFORE setting the local description, so the description libwebrtc
    // holds is the one the peer received. Setting the untrimmed one and
    // sending the trimmed one would make the two ends disagree about what was
    // negotiated.
    let trimmed = RTCSessionDescription(type: .offer, sdp: SdpTrimmer.trim(offer.sdp))
    try await connection.setLocalDescription(trimmed)
    if isClosed { throw CallError.closed }
    #if DEBUG
      return faulted(trimmed.sdp)
    #else
      return trimmed.sdp
    #endif
  }

  func createAnswer(remoteOfferSdp: String, withVideo: Bool) async throws -> String {
    if isClosed { throw CallError.closed }
    addLocalMedia(withVideo: withVideo)
    try await connection.setRemoteDescription(
      RTCSessionDescription(type: .offer, sdp: remoteOfferSdp)
    )
    if isClosed { throw CallError.closed }
    // Sets the flag as part of taking the buffer; see takePendingCandidates.
    try await drainPendingCandidates()
    if isClosed { throw CallError.closed }

    let answer = try await connection.answer(for: RTCMediaConstraints(
      mandatoryConstraints: nil, optionalConstraints: nil
    ))
    if isClosed { throw CallError.closed }
    let trimmed = RTCSessionDescription(type: .answer, sdp: SdpTrimmer.trim(answer.sdp))
    try await connection.setLocalDescription(trimmed)
    if isClosed { throw CallError.closed }
    #if DEBUG
      return faulted(trimmed.sdp)
    #else
      return trimmed.sdp
    #endif
  }

  func setRemoteAnswer(_ sdp: String) async throws {
    try await connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp))
    // Sets the flag as part of taking the buffer; see takePendingCandidates.
    try await drainPendingCandidates()
  }

  func applyRemoteOffer(_ sdp: String) async throws {
    try await connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp))
    // Sets the flag as part of taking the buffer; see takePendingCandidates.
    try await drainPendingCandidates()
  }

  func addRemoteCandidates(_ candidates: [(sdp: String, mid: String?, index: Int32)]) async throws {
    var ready: [RTCIceCandidate] = []
    stateLock.lock()
    for c in candidates {
      let candidate = RTCIceCandidate(sdp: c.sdp, sdpMLineIndex: c.index, sdpMid: c.mid)
      if remoteDescriptionSet {
        ready.append(candidate)
      } else {
        // Buffered rather than dropped: candidates routinely arrive before
        // the answer is applied, and each one is a path the call might need.
        pendingRemoteCandidates.append(candidate)
      }
    }
    stateLock.unlock()
    for candidate in ready { try await connection.add(candidate) }
  }

  /// Mark the remote description applied and take the buffer, as ONE step.
  ///
  /// Split from the drain below so the flag flip and the hand-off cannot be
  /// interleaved: setting the flag first and emptying the buffer second left
  /// a window in which a concurrent `addRemoteCandidates` saw
  /// `remoteDescriptionSet == true`, added its candidates directly, and the
  /// drain then re-added the ones already queued.
  private func takePendingCandidates() -> [RTCIceCandidate] {
    stateLock.lock()
    defer { stateLock.unlock() }
    remoteDescriptionSet = true
    let queued = pendingRemoteCandidates
    pendingRemoteCandidates = []
    return queued
  }

  private func drainPendingCandidates() async throws {
    for candidate in takePendingCandidates() { try await connection.add(candidate) }
  }

  /**
   * A measured 1–3 level for the local quality indicator, or -1
   * when this interval has no received packets to measure.
   *
   * Reduced to a single integer HERE rather than in JS, and that is the point:
   * `statsJson` below is already stripped of candidate addresses, but the
   * safest version of "getStats never leaves the device" is one where no stats
   * payload crosses the bridge at all. An `Int` cannot leak an IP.
   *
   * Measured over the LAST interval, not the call's lifetime. Cumulative loss
   * would mean a call that was bad for ten seconds and has been fine since
   * still shows one bar, which is a claim about the present that is false.
   */
  func sampleQuality() async -> Int {
    let report = await connection.statistics()
    var lost = 0.0
    var received = 0.0
    var jitter = 0.0
    for (_, stat) in report.statistics where stat.type == "inbound-rtp" {
      lost += (stat.values["packetsLost"] as? NSNumber)?.doubleValue ?? 0
      received += (stat.values["packetsReceived"] as? NSNumber)?.doubleValue ?? 0
      jitter = max(jitter, (stat.values["jitter"] as? NSNumber)?.doubleValue ?? 0)
    }

    stateLock.lock()
    let deltaLost = max(0, lost - lastPacketsLost)
    let deltaReceived = max(0, received - lastPacketsReceived)
    lastPacketsLost = lost
    lastPacketsReceived = received
    stateLock.unlock()

    // Nothing arrived in this window — the usual reason is that the call has
    // only just connected. Absence of packets proves neither good nor poor.
    let total = deltaLost + deltaReceived
    guard total > 0 else { return -1 }

    let loss = deltaLost / total
    // Jitter is seconds. 100 ms is where a conversation starts to break up;
    // 50 ms is where it starts to be noticeable.
    if loss > 0.08 || jitter > 0.1 { return 1 }
    if loss > 0.02 || jitter > 0.05 { return 2 }
    return 3
  }

  func statsJson() async -> String {
    let report = await connection.statistics()
    // Deliberately reduced to the few numbers a quality indicator needs.
    // A full report contains candidate addresses — the other person's IP —
    // and the module contract forbids that value reaching an envelope or a log line.
    var out: [String: Any] = [:]
    for (_, stat) in report.statistics {
      guard stat.type == "inbound-rtp" || stat.type == "outbound-rtp" else { continue }
      for key in ["packetsLost", "jitter", "bytesReceived", "bytesSent", "framesPerSecond"] {
        if let value = stat.values[key] { out["\(stat.type).\(key)"] = value }
      }
    }
    let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8)
    return String(data: data, encoding: .utf8) ?? "{}"
  }

  /**
   * Stop everything and mark this connection over.
   *
   * The flag is raised FIRST and under the lock, before a single resource is
   * released: a negotiation Task suspended in libwebrtc resumes on another
   * thread, and the window this method is closing is precisely the one between
   * "close has begun" and "close has finished". Raising it afterwards would
   * leave `addLocalMedia` free to open the microphone during the teardown.
   *
   * Idempotent, because it is reached from three places that do not coordinate
   * with each other: `closeCall` on the bridge, `makeCall`'s tombstone check,
   * and the coordinator's own disposal one layer up.
   */
  func close() {
    // The capturer is CLAIMED in the same critical section that raises the
    // flag: `addLocalMedia` installs it under this lock, so
    // reading it afterwards would reopen by one line the gap this pairing
    // exists to close. Whoever takes the lock second sees the other's decision.
    stateLock.lock()
    let alreadyClosed = closed
    closed = true
    let doomed = capturer
    capturer = nil
    stateLock.unlock()
    guard !alreadyClosed else { return }

    Self.stopCapturer(doomed)
    // Before the connection closes: a view still holding a track would keep a
    // dead call's last frame on screen, and keep the track itself alive.
    VideoTrackRegistry.shared.clear(cid: cid)
    connection.close()
  }
}

// MARK: - delegate

extension CallPeerConnection: RTCPeerConnectionDelegate {
  func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    events.iceCandidate(
      cid: cid,
      sdp: candidate.sdp,
      mid: candidate.sdpMid ?? "",
      index: Int(candidate.sdpMLineIndex)
    )
  }

  func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCIceConnectionState) {
    events.iceState(cid: cid, state: Self.name(for: state))
  }

  func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCPeerConnectionState) {
    events.connectionState(cid: cid, state: Self.name(for: state))
  }

  func peerConnection(_ pc: RTCPeerConnection, didAdd receiver: RTCRtpReceiver,
                      streams: [RTCMediaStream]) {
    guard let track = receiver.track else { return }
    // The track was previously read for its `kind` and then dropped on the
    // floor, so the far end's video arrived, was decoded, and had nowhere to
    // go. Holding it here is what lets a view render it.
    if let video = track as? RTCVideoTrack {
      VideoTrackRegistry.shared.set(video, cid: cid, role: .remote)
    }
    events.remoteTrack(cid: cid, kind: track.kind, added: true)
  }

  func peerConnection(_ pc: RTCPeerConnection, didRemove receiver: RTCRtpReceiver) {
    guard let track = receiver.track else { return }
    if track is RTCVideoTrack {
      VideoTrackRegistry.shared.set(nil, cid: cid, role: .remote)
    }
    events.remoteTrack(cid: cid, kind: track.kind, added: false)
  }

  // Unified-plan requires these to exist; none of them carries a decision.
  func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
  func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCSignalingState) {}
  func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCIceGatheringState) {}
  func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

  static func name(for s: RTCIceConnectionState) -> String {
    switch s {
    case .new: return "new"
    case .checking: return "checking"
    case .connected: return "connected"
    case .completed: return "completed"
    case .failed: return "failed"
    case .disconnected: return "disconnected"
    case .closed: return "closed"
    case .count: return "new"
    @unknown default: return "new"
    }
  }

  static func name(for s: RTCPeerConnectionState) -> String {
    switch s {
    case .new: return "new"
    case .connecting: return "connecting"
    case .connected: return "connected"
    case .disconnected: return "disconnected"
    case .failed: return "failed"
    case .closed: return "closed"
    @unknown default: return "new"
    }
  }
}

enum CallError: Error {
  case peerConnectionFailed
  case noSuchCall
  case notConfigured
  /// The cid was closed while its connection was still being built. Not a
  /// failure of the negotiation — the negotiation was overtaken. See
  /// `TacendumCallImpl.closedCids`.
  case closed
}

/// What the peer connection reports upward. Implemented by the module facade;
/// declared here so this file depends on nothing above it.
protocol CallEventSink: AnyObject {
  func iceCandidate(cid: String, sdp: String, mid: String, index: Int)
  func iceState(cid: String, state: String)
  func connectionState(cid: String, state: String)
  func remoteTrack(cid: String, kind: String, added: Bool)
}
