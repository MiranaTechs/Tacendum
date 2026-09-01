#if DEBUG

  import Foundation
  import WebRTC

  /**
   * A camera that does not exist.
   *
   * The iOS Simulator has no camera. Every other verification in this project
   * is simulator-based — the verification script runs its end-to-end checks
   * there — and video calling breaks that assumption completely: without a
   * frame source, capture, encode, DTLS-SRTP, decode and render are testable
   * only on two physical phones, which is not a thing anyone runs per commit.
   *
   * So this emits an animated test pattern at 640×360@15: a moving pine bar on
   * the app's paper ground, with a frame counter rendered as a column of
   * ticks. Motion matters — a static image compresses to almost nothing and
   * would let a broken encoder look healthy. The counter matters because it
   * makes "the far end is showing MY frames" checkable by eye.
   *
   * `#if DEBUG` wraps the whole file: this must not exist in a Release binary,
   * where its only possible use is to fake a camera feed.
   */
  final class SyntheticVideoCapturer: RTCVideoCapturer {
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.tacendum.synthetic-video")
    private var frameIndex = 0

    private let width = 640
    private let height = 360
    private let fps = 15

    private var buffers: [CVPixelBuffer] = []
    private var next = 0

    func startCapture() {
      // A small ring of buffers, reused. Allocating a pixel buffer per frame
      // at 15 fps produces exactly the kind of memory churn that makes a
      // synthetic-source test misleading about real performance.
      buffers = (0..<3).compactMap { _ in Self.makeBuffer(width: width, height: height) }
      guard !buffers.isEmpty else { return }

      let t = DispatchSource.makeTimerSource(queue: queue)
      t.schedule(deadline: .now(), repeating: .milliseconds(1000 / fps))
      t.setEventHandler { [weak self] in self?.emit() }
      timer = t
      t.resume()
    }

    func stopCapture() {
      timer?.cancel()
      timer = nil
      buffers = []
    }

    deinit { timer?.cancel() }

    private func emit() {
      guard !buffers.isEmpty else { return }
      let buffer = buffers[next % buffers.count]
      next += 1
      draw(into: buffer, frame: frameIndex)
      frameIndex += 1

      let rtcBuffer = RTCCVPixelBuffer(pixelBuffer: buffer)
      let frame = RTCVideoFrame(
        buffer: rtcBuffer,
        rotation: ._0,
        timeStampNs: Int64(Date().timeIntervalSince1970 * 1_000_000_000)
      )
      delegate?.capturer(self, didCapture: frame)
    }

    private static func makeBuffer(width: Int, height: Int) -> CVPixelBuffer? {
      var buffer: CVPixelBuffer?
      let attrs: [String: Any] = [
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        // The format libwebrtc's iOS encoder path expects; anything else adds
        // a conversion that would not exist with a real camera.
        kCVPixelBufferPixelFormatTypeKey as String:
          kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      ]
      CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                          kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                          attrs as CFDictionary, &buffer)
      return buffer
    }

    /// Paper ground with a pine bar that sweeps left to right, plus a tick
    /// column encoding the frame number. Written straight into the Y and CbCr
    /// planes: a CoreGraphics context per frame would dominate the cost and
    /// make the capturer itself the bottleneck under test.
    private func draw(into buffer: CVPixelBuffer, frame: Int) {
      CVPixelBufferLockBaseAddress(buffer, [])
      defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

      guard
        let yPlane = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
        let cbcrPlane = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)
      else { return }

      let yStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
      let cbcrStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
      let y = yPlane.assumingMemoryBound(to: UInt8.self)
      let cbcr = cbcrPlane.assumingMemoryBound(to: UInt8.self)

      // Paper ground (bright, near-neutral) and pine (dark, green-leaning) —
      // the same two values the rest of the product uses, so a frame that
      // reaches the far end is recognisably ours.
      let paperY: UInt8 = 236
      let pineY: UInt8 = 60
      let barX = (frame * 6) % max(width - 80, 1)

      for row in 0..<height {
        let line = y.advanced(by: row * yStride)
        memset(line, Int32(paperY), width)
        // The sweeping bar.
        for col in barX..<min(barX + 80, width) { line[col] = pineY }
        // Tick column: one mark per set bit of the frame counter, so a stalled
        // stream is obvious rather than merely suspected.
        let tickBand = row / 12
        if tickBand < 16, (frame >> tickBand) & 1 == 1 {
          for col in 0..<10 { line[col] = pineY }
        }
      }

      // Chroma: neutral over paper, green-shifted inside the bar.
      for row in 0..<(height / 2) {
        let line = cbcr.advanced(by: row * cbcrStride)
        for col in 0..<(width / 2) {
          let inBar = (col * 2) >= barX && (col * 2) < barX + 80
          line[col * 2] = inBar ? 100 : 128      // Cb
          line[col * 2 + 1] = inBar ? 120 : 128  // Cr
        }
      }
    }
  }

#endif
