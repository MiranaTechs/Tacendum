package com.miranatechnologies.tacendum.call

import android.content.Context
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.webrtc.CapturerObserver
import org.webrtc.JavaI420Buffer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame

/**
 * A camera that does not exist — the Kotlin twin of
 * `ios/SyntheticVideoCapturer.swift`.
 *
 * The emulator's camera is either absent or an animated scene the AVD paints,
 * and every other verification in this port is emulator-based
 * (the device verification). Without a dependable frame source,
 * capture, encode, DTLS-SRTP, decode and render are testable only on two
 * physical phones, which is not a thing anyone runs per commit.
 *
 * So this emits an animated test pattern at 640×360@15: a moving pine bar on
 * the app's paper ground, with a frame counter rendered as a column of ticks.
 * Motion matters — a static image compresses to almost nothing and would let
 * a broken encoder look healthy. The counter matters because it makes "the far
 * end is showing MY frames" checkable by eye.
 *
 * **DEBUG-only by CONSTRUCTION SITE, not by file.** Kotlin has no `#if
 * DEBUG`, so the class compiles into every variant; what cannot happen in a
 * Release build is its construction — `CallPeerConnection.makeCapturer`
 * consults `useSyntheticVideo` only behind `BuildConfig.DEBUG`, and
 * `TacendumCallModule.enableSyntheticVideo` does not write the flag outside
 * DEBUG. Same honest weakening, and the same reasoning, as `FingerprintFault`:
 * the switch is disconnected rather than absent.
 */
internal class SyntheticVideoCapturer : VideoCapturer {

  private var observer: CapturerObserver? = null
  private var executor: ScheduledExecutorService? = null
  private var task: ScheduledFuture<*>? = null

  private var width = DEFAULT_WIDTH
  private var height = DEFAULT_HEIGHT
  private var fps = DEFAULT_FPS

  private var frameIndex = 0
  private var next = 0

  /**
   * A small ring of planes, reused. Allocating three direct buffers per frame
   * at 15 fps produces exactly the kind of memory churn that makes a
   * synthetic-source test misleading about real performance — and a ring of
   * three is what keeps the encoder from reading the plane the drawing pass
   * is halfway through.
   */
  private class Planes(width: Int, height: Int) {
    val chromaWidth = (width + 1) / 2
    val chromaHeight = (height + 1) / 2
    val y: ByteBuffer = ByteBuffer.allocateDirect(width * height)
    val u: ByteBuffer = ByteBuffer.allocateDirect(chromaWidth * chromaHeight)
    val v: ByteBuffer = ByteBuffer.allocateDirect(chromaWidth * chromaHeight)
  }

  private var ring: List<Planes> = emptyList()

  override fun initialize(
      helper: SurfaceTextureHelper?,
      context: Context?,
      capturerObserver: CapturerObserver?,
  ) {
    observer = capturerObserver
  }

  override fun startCapture(width: Int, height: Int, framerate: Int) {
    stopCapture()
    this.width = if (width > 0) width else DEFAULT_WIDTH
    this.height = if (height > 0) height else DEFAULT_HEIGHT
    this.fps = if (framerate > 0) framerate else DEFAULT_FPS
    ring = List(3) { Planes(this.width, this.height) }

    val exec = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "tacendum-synthetic-video")
    }
    executor = exec
    observer?.onCapturerStarted(true)
    task =
        exec.scheduleAtFixedRate(
            { emit() },
            0,
            (1000L / this.fps).coerceAtLeast(1L),
            TimeUnit.MILLISECONDS,
        )
  }

  override fun stopCapture() {
    task?.cancel(false)
    task = null
    executor?.shutdown()
    executor = null
    ring = emptyList()
    observer?.onCapturerStopped()
  }

  override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
    startCapture(width, height, framerate)
  }

  override fun dispose() {
    stopCapture()
    observer = null
  }

  override fun isScreencast(): Boolean = false

  private fun emit() {
    val planes = ring.getOrNull(next % ring.size.coerceAtLeast(1)) ?: return
    next += 1
    draw(planes, frameIndex)
    frameIndex += 1

    // `wrap` rather than `allocate`: the planes are the ring's, so the
    // buffer's release callback has nothing to free. Refcounting still works
    // — the frame is released below, the wrapper drops to zero, and the
    // no-op runs.
    val buffer =
        JavaI420Buffer.wrap(
            width,
            height,
            planes.y,
            width,
            planes.u,
            planes.chromaWidth,
            planes.v,
            planes.chromaWidth,
        ) {}
    val frame = VideoFrame(buffer, 0, System.nanoTime())
    try {
      observer?.onFrameCaptured(frame)
    } finally {
      frame.release()
    }
  }

  /**
   * Paper ground with a pine bar that sweeps left to right, plus a tick
   * column encoding the frame number. Written straight into the I420 planes:
   * a Canvas per frame would dominate the cost and make the capturer itself
   * the bottleneck under test.
   */
  private fun draw(planes: Planes, frame: Int) {
    // Paper ground (bright, near-neutral) and pine (dark, green-leaning) —
    // the same two values the rest of the product uses, so a frame that
    // reaches the far end is recognisably ours.
    val paperY = 236.toByte()
    val pineY = 60.toByte()
    val barWidth = 80
    val barX = (frame * 6) % (width - barWidth).coerceAtLeast(1)

    val y = planes.y
    y.clear()
    for (row in 0 until height) {
      val base = row * width
      for (col in 0 until width) y.put(base + col, paperY)
      // The sweeping bar.
      var col = barX
      val end = minOf(barX + barWidth, width)
      while (col < end) {
        y.put(base + col, pineY)
        col += 1
      }
      // Tick column: one mark per set bit of the frame counter, so a stalled
      // stream is obvious rather than merely suspected.
      val tickBand = row / 12
      if (tickBand < 16 && (frame shr tickBand) and 1 == 1) {
        for (t in 0 until minOf(10, width)) y.put(base + t, pineY)
      }
    }

    // Chroma: neutral over paper, green-shifted inside the bar.
    val u = planes.u
    val v = planes.v
    u.clear()
    v.clear()
    for (row in 0 until planes.chromaHeight) {
      val base = row * planes.chromaWidth
      for (col in 0 until planes.chromaWidth) {
        val inBar = (col * 2) >= barX && (col * 2) < barX + barWidth
        u.put(base + col, (if (inBar) 100 else 128).toByte())
        v.put(base + col, (if (inBar) 120 else 128).toByte())
      }
    }
  }

  companion object {
    const val DEFAULT_WIDTH = 640
    const val DEFAULT_HEIGHT = 360
    const val DEFAULT_FPS = 15
  }
}
