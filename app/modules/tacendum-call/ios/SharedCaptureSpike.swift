#if DEBUG

  import AVFoundation
  import Foundation
  import UIKit
  import WebRTC

  /**
   * The shared-capture spike, and nothing more.
   *
   * A TIMEBOXED SPIKE whose whole purpose is to answer one question
   * before anything is built on the answer: can ONE `RTCCameraVideoCapturer`
   * and ONE `RTCVideoSource` feed three video tracks across three peer
   * connections, on physical hardware, at a thermal and battery cost worth
   * paying? The design is explicit that if this fails, group calls stop here and
   * the next stage is not started. So this file deliberately builds none of it: there is
   * no `SharedCaptureSession`, and `CallPeerConnection` is untouched. A spike
   * that quietly becomes the implementation is how a "we'll measure first"
   * turns into a thing nobody ever measured.
   *
   * `#if DEBUG` wraps the whole file, exactly as `SyntheticVideoCapturer` and
   * `FingerprintFault` do and for the same reason: it must not exist in a
   * Release binary. It opens no sockets and touches no signalling — every peer
   * connection here is looped back to another one in this same process, so the
   * measurement is of CAPTURE, ENCODE and DECODE, which is the part the mesh
   * decision actually rests on.
   *
   * WHAT THE STRUCTURE ALREADY GIVES US, checked before writing a line of
   * this: `TacendumCallImpl.ensureFactory()` is a lazily-created singleton
   * that is never reset, so every peer connection in the app already shares
   * one `RTCPeerConnectionFactory`. That matters because a video source cannot
   * be shared across factories — had each connection built its own, the spike
   * would have been answering a question about an architecture we do not have.
   *
   * WHAT IT CANNOT ANSWER, and must not be read as answering: this runs three
   * ENCODES from one capture on one device. A real three-way mesh also runs
   * three DECODES of three remote streams over real networks with real packet
   * loss. The thermal figure here is a floor, not the number.
   */
  @objc final class SharedCaptureSpike: NSObject {
    /// One sender leg: a track off the shared source, its peer connection, and
    /// the loopback peer that receives it.
    private struct Leg {
      let index: Int
      let scale: Double
      let sender: RTCPeerConnection
      let receiver: RTCPeerConnection
      let rtpSender: RTCRtpSender
    }

    private static let queue = DispatchQueue(label: "tacendum.g11.spike")

    /**
     * Run the spike for `seconds`, with `legs` senders off one capture.
     *
     * Returns a JSON string rather than a typed result on purpose: this is a
     * measurement to be recorded by hand, not an API anything builds
     * against, and shaping it as data keeps it that way.
     */
    @objc static func run(
      legs legCount: Int,
      seconds: Double,
      completion: @escaping (String) -> Void
    ) {
      queue.async {
        let started = Date()
        var report: [String: Any] = [
          "legs": legCount,
          "requestedSeconds": seconds,
        ]

        let factory = TacendumCallImpl.sharedFactoryForSpike()
        // ONE source, ONE capturer — the entire point of the exercise.
        let source = factory.videoSource()
        var capturer: RTCVideoCapturer?
        var usedSynthetic = false
        if let device = RTCCameraVideoCapturer.captureDevices().first(where: {
          $0.position == .front
        }) {
          let camera = RTCCameraVideoCapturer(delegate: source)
          let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
          // 1280x720@30, matching CallPeerConnection's own choice so the
          // measurement is of the pipeline we actually ship.
          let target = formats.min { lhs, rhs in
            let l = CMVideoFormatDescriptionGetDimensions(lhs.formatDescription)
            let r = CMVideoFormatDescriptionGetDimensions(rhs.formatDescription)
            return abs(Int(l.width) - 1280) < abs(Int(r.width) - 1280)
          }
          if let format = target,
            let fps = format.videoSupportedFrameRateRanges.map({ $0.maxFrameRate }).max()
          {
            camera.startCapture(with: device, format: format, fps: Int(min(fps, 30)))
            capturer = camera
          }
        }
        if capturer == nil {
          // The Simulator has no camera. The check explicitly requires
          // the synthetic path to keep working, so this arm is a deliverable
          // rather than a convenience.
          let synthetic = SyntheticVideoCapturer(delegate: source)
          synthetic.startCapture()
          capturer = synthetic
          usedSynthetic = true
        }
        report["syntheticCapture"] = usedSynthetic

        // Per-sender scale factors, deliberately DIFFERENT so "applies
        // independently" is observable rather than assumed. Equal values would
        // pass whether the parameter was honoured per sender or globally.
        let scales: [Double] = [1.0, 2.0, 4.0]
        var built: [Leg] = []
        for i in 0..<legCount {
          let scale = scales[min(i, scales.count - 1)]
          guard
            let leg = buildLoopbackLeg(
              factory: factory, source: source, index: i, scale: scale)
          else {
            report["error"] = "leg \(i) failed to build"
            completion(json(report))
            return
          }
          built.append(leg)
        }

        // Thermal and battery are the decision inputs, so they are sampled
        // across the run rather than read once at the end: a device that is
        // .nominal at second 1 and .serious at second 600 is the finding.
        UIDevice.current.isBatteryMonitoringEnabled = true
        let batteryStart = UIDevice.current.batteryLevel
        var thermalSamples: [String] = []
        var interruptions = 0
        let observer = NotificationCenter.default.addObserver(
          forName: AVCaptureSession.wasInterruptedNotification,
          object: nil, queue: nil
        ) { _ in interruptions += 1 }
        // Backgrounding is a Verify item and cannot be simulated from here —
        // the operator has to background the app mid-run. Counted, so the
        // report says whether it was actually exercised.
        var backgroundings = 0
        let bgObserver = NotificationCenter.default.addObserver(
          forName: UIApplication.didEnterBackgroundNotification,
          object: nil, queue: nil
        ) { _ in backgroundings += 1 }

        let deadline = started.addingTimeInterval(seconds)
        while Date() < deadline {
          thermalSamples.append(thermalName(ProcessInfo.processInfo.thermalState))
          Thread.sleep(forTimeInterval: min(5, max(1, seconds / 20)))
        }

        NotificationCenter.default.removeObserver(observer)
        NotificationCenter.default.removeObserver(bgObserver)

        report["thermalSamples"] = thermalSamples
        report["thermalWorst"] = worst(thermalSamples)
        report["batteryStart"] = batteryStart
        report["batteryEnd"] = UIDevice.current.batteryLevel
        report["batteryDrain"] = batteryStart - UIDevice.current.batteryLevel
        report["captureInterruptions"] = interruptions
        report["backgroundings"] = backgroundings
        report["elapsedSeconds"] = Date().timeIntervalSince(started)

        collectStats(for: built) { perLeg in
          report["perLeg"] = perLeg
          // The headline: did every leg actually move frames? A leg that built
          // and negotiated but encoded nothing is the failure this spike is
          // most likely to find, and it looks like success from every angle
          // except this number.
          let encoding = perLeg.filter { ($0["framesEncoded"] as? Int ?? 0) > 0 }.count
          report["legsEncoding"] = encoding
          report["verdict"] =
            encoding == legCount
            ? "all \(legCount) legs encoded from one capture session"
            : "ONLY \(encoding)/\(legCount) legs encoded — the shared source does not fan out"
          for leg in built {
            leg.sender.close()
            leg.receiver.close()
          }
          if let camera = capturer as? RTCCameraVideoCapturer { camera.stopCapture() }
          completion(json(report))
        }
      }
    }

    /**
     * One sender peer connection fed by the SHARED source, looped back to a
     * receiver in this process.
     *
     * Loopback rather than a real remote because the question is whether one
     * capture can drive N encoders; a network would add variance without
     * adding evidence. Trickle ICE is skipped by waiting for gathering to
     * complete before exchanging, which keeps the negotiation synchronous and
     * the failure modes few.
     */
    private static func buildLoopbackLeg(
      factory: RTCPeerConnectionFactory,
      source: RTCVideoSource,
      index: Int,
      scale: Double
    ) -> Leg? {
      let config = RTCConfiguration()
      config.sdpSemantics = .unifiedPlan
      // No ICE servers: host candidates on the loopback interface are enough,
      // and reaching for STUN here would make the spike depend on the network
      // it is deliberately not measuring.
      config.iceServers = []
      let constraints = RTCMediaConstraints(
        mandatoryConstraints: nil, optionalConstraints: nil)

      guard
        let sender = factory.peerConnection(
          with: config, constraints: constraints, delegate: nil),
        let receiver = factory.peerConnection(
          with: config, constraints: constraints, delegate: nil)
      else { return nil }

      // A DISTINCT track id per leg off ONE source — this is the line the
      // whole spike is about.
      let track = factory.videoTrack(with: source, trackId: "g11-v\(index)")
      let rtpSender = sender.add(track, streamIds: ["g11-\(index)"])

      // Per-sender scaling, applied the way CallPeerConnection applies its own
      // encoding preferences, so an independence failure here would be a real
      // one rather than an artefact of a different code path.
      if let params = rtpSender?.parameters, let encoding = params.encodings.first {
        encoding.scaleResolutionDownBy = NSNumber(value: scale)
        rtpSender?.parameters = params
      }

      // NON-TRICKLE, and it has to be. The first version of this passed the
      // freshly-created offer straight across with `delegate: nil` and never
      // exchanged ICE candidates at all — so no leg ever connected, nothing
      // ever encoded, and the spike reported "0/3 legs encoded, the shared
      // source does not fan out". That reads exactly like the architectural
      // failure this spike exists to detect, and it would have stopped group
      // calls on the strength of a bug in the measuring instrument.
      //
      // Waiting for gathering to COMPLETE and then sending the local
      // description means the candidates ride inside the SDP, so no delegate
      // and no signalling channel is needed — which is what makes a loopback
      // measurement honest rather than elaborate.
      let sem = DispatchSemaphore(value: 0)
      var offered: RTCSessionDescription?
      sender.offer(for: constraints) { offer, _ in
        guard let offer else { sem.signal(); return }
        sender.setLocalDescription(offer) { _ in
          offered = offer
          sem.signal()
        }
      }
      guard sem.wait(timeout: .now() + 10) == .success, offered != nil,
        waitForGathering(sender),
        let localOffer = sender.localDescription
      else { return nil }

      var answered = false
      let sem2 = DispatchSemaphore(value: 0)
      receiver.setRemoteDescription(localOffer) { _ in
        receiver.answer(for: constraints) { answer, _ in
          guard let answer else { sem2.signal(); return }
          receiver.setLocalDescription(answer) { _ in
            answered = true
            sem2.signal()
          }
        }
      }
      guard sem2.wait(timeout: .now() + 10) == .success, answered,
        waitForGathering(receiver),
        let localAnswer = receiver.localDescription
      else { return nil }

      var ok = false
      let sem3 = DispatchSemaphore(value: 0)
      sender.setRemoteDescription(localAnswer) { _ in
        ok = true
        sem3.signal()
      }
      _ = sem3.wait(timeout: .now() + 10)
      guard ok, let rtpSender else { return nil }
      return Leg(
        index: index, scale: scale, sender: sender, receiver: receiver, rtpSender: rtpSender)
    }

    /**
     * Block until this connection has finished gathering ICE candidates.
     *
     * Polled rather than delegated on purpose: a delegate would mean an object
     * with a lifetime, retained across the run, for a spike whose whole virtue
     * is that it holds nothing. Bounded, because a gathering that never
     * completes must surface as a failed leg rather than a hung measurement.
     */
    private static func waitForGathering(_ pc: RTCPeerConnection) -> Bool {
      let deadline = Date().addingTimeInterval(10)
      while Date() < deadline {
        if pc.iceGatheringState == .complete { return true }
        Thread.sleep(forTimeInterval: 0.1)
      }
      return pc.iceGatheringState == .complete
    }

    /// `outbound-rtp` per leg: frames encoded, and the size actually sent —
    /// which is how `scaleResolutionDownBy` is verified rather than trusted.
    private static func collectStats(
      for legs: [Leg], completion: @escaping ([[String: Any]]) -> Void
    ) {
      var out: [[String: Any]] = []
      let group = DispatchGroup()
      for leg in legs {
        group.enter()
        leg.sender.statistics { report in
          var row: [String: Any] = ["leg": leg.index, "scaleRequested": leg.scale]
          for (_, stat) in report.statistics where stat.type == "outbound-rtp" {
            if let kind = stat.values["kind"] as? String, kind != "video" { continue }
            row["framesEncoded"] = (stat.values["framesEncoded"] as? NSNumber)?.intValue ?? 0
            row["frameWidth"] = (stat.values["frameWidth"] as? NSNumber)?.intValue ?? 0
            row["frameHeight"] = (stat.values["frameHeight"] as? NSNumber)?.intValue ?? 0
            row["bytesSent"] = (stat.values["bytesSent"] as? NSNumber)?.intValue ?? 0
          }
          out.append(row)
          group.leave()
        }
      }
      group.notify(queue: queue) {
        completion(out.sorted { ($0["leg"] as? Int ?? 0) < ($1["leg"] as? Int ?? 0) })
      }
    }

    private static func thermalName(_ s: ProcessInfo.ThermalState) -> String {
      switch s {
      case .nominal: return "nominal"
      case .fair: return "fair"
      case .serious: return "serious"
      case .critical: return "critical"
      @unknown default: return "unknown"
      }
    }

    private static func worst(_ samples: [String]) -> String {
      let rank = ["nominal": 0, "fair": 1, "serious": 2, "critical": 3, "unknown": 4]
      return samples.max { (rank[$0] ?? 0) < (rank[$1] ?? 0) } ?? "none"
    }

    private static func json(_ dict: [String: Any]) -> String {
      guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
        let s = String(data: data, encoding: .utf8)
      else { return "{\"error\":\"report could not be serialised\"}" }
      return s
    }
  }

#endif
