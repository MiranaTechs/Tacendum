package com.miranatechnologies.tacendum.qr

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.zxing.PlanarYUVLuminanceSource
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The live QR scanner.
 *
 * CameraX with a custom analyzer, not ML Kit and not the Play Services barcode
 * scanner: this app has no GMS dependency and is not acquiring one here. The
 * analyzer reads the luminance plane and hands it to zxing's multi-reader.
 *
 * IT REPORTS EVERY SYMBOL IN THE TRIGGERING FRAME, and that is a contract
 * rather than an implementation detail. `app/src/qr.ts` refuses a picture
 * containing two different codes instead of guessing which person was meant; a
 * scanner that settled on its "best" symbol would make that refusal
 * unreachable by making the choice here — silently, with no idea what it was
 * choosing between. So the FIRST frame that yields any symbols settles the
 * scan with ALL of them.
 *
 * SETTLE ONCE. The promise is answered exactly once, by whichever of these
 * happens first: a frame that decoded, the Cancel button, the back gesture, a
 * refused camera permission, or the activity being destroyed for any other
 * reason. Every one of the non-decoding outcomes settles with an EMPTY list,
 * because to a caller they are the same fact — no id was obtained — and
 * distinguishing them would only invite the UI to say something it cannot know.
 */
class QrScannerActivity : ComponentActivity() {

  companion object {
    /**
     * The waiting caller. `AtomicReference` and not a plain field: `present`
     * claims it with compare-and-set, and every settle path takes it with
     * `getAndSet(null)`, so the promise is resolved exactly once no matter how
     * many of those paths fire.
     */
    private val waiting = AtomicReference<((List<String>) -> Unit)?>(null)

    /**
     * Show the scanner. [onSettled] is called exactly once, on some thread.
     *
     * A second request while one is outstanding settles the NEW one empty
     * rather than displacing the old: the first caller is already holding a
     * promise, and dropping it on the floor would hang a screen forever.
     */
    fun present(host: Activity, onSettled: (List<String>) -> Unit) {
      if (!waiting.compareAndSet(null, onSettled)) {
        onSettled(emptyList())
        return
      }
      try {
        host.startActivity(Intent(host, QrScannerActivity::class.java))
      } catch (_: Throwable) {
        // No scanner means no id; it does not mean an error worth surfacing.
        settle(emptyList())
      }
    }

    private fun settle(payloads: List<String>) {
      waiting.getAndSet(null)?.invoke(payloads)
    }
  }

  private val decoded = AtomicBoolean(false)
  private var analysisExecutor: ExecutorService? = null
  private var previewView: PreviewView? = null

  private val askForCamera =
      registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else finish()
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    // The same posture as the main window: what is on this
    // screen is a live camera and, a moment later, somebody's account id.
    window.setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE,
    )
    super.onCreate(savedInstanceState)

    val root = FrameLayout(this)
    val preview = PreviewView(this)
    previewView = preview
    root.addView(
        preview,
        FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ),
    )
    val cancel =
        Button(this).apply {
          // The platform's own localized string: this module holds no copy, and
          // an English literal here would be the one untranslated word on the
          // screen.
          setText(android.R.string.cancel)
          setOnClickListener { finish() }
        }
    root.addView(
        cancel,
        FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            .apply {
              gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
              bottomMargin = (48 * resources.displayMetrics.density).toInt()
            },
    )
    setContentView(root)

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      askForCamera.launch(Manifest.permission.CAMERA)
    }
  }

  private fun startCamera() {
    val executor = Executors.newSingleThreadExecutor()
    analysisExecutor = executor
    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener(
        {
          val provider =
              try {
                providerFuture.get()
              } catch (_: Throwable) {
                // No usable camera. Same outcome as cancelling.
                finish()
                return@addListener
              }
          val preview =
              Preview.Builder().build().also { it.surfaceProvider = previewView?.surfaceProvider }
          val analysis =
              ImageAnalysis.Builder()
                  // Only the newest frame matters: a backlog would decode a
                  // symbol the camera was pointed at seconds ago.
                  .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                  .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                  .build()
                  .also { it.setAnalyzer(executor, ::analyze) }
          // Back camera first — it is the one a person points at somebody
          // else's screen — but a device that only has a front camera can
          // still read a code, so falling back beats refusing.
          val bound =
              listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA).any {
                  selector ->
                try {
                  provider.unbindAll()
                  provider.bindToLifecycle(this, selector, preview, analysis)
                  true
                } catch (_: Throwable) {
                  false
                }
              }
          if (!bound) finish()
        },
        ContextCompat.getMainExecutor(this),
    )
  }

  /**
   * One frame. Reads the luminance plane only — zxing binarises greyscale, so
   * the colour planes are work nobody would look at — and settles on the first
   * frame that yields anything.
   */
  private fun analyze(image: ImageProxy) {
    try {
      if (decoded.get()) return
      val payloads =
          try {
            QrCodec.readAll(luminance(image))
          } catch (_: Exception) {
            // A frame that could not be read is an ordinary frame; the next one
            // gets its turn.
            return
          }
      if (payloads.isEmpty()) return
      if (!decoded.compareAndSet(false, true)) return
      settle(payloads)
      runOnUiThread { finish() }
    } finally {
      image.close()
    }
  }

  /**
   * The Y plane as a tight width x height byte array.
   *
   * Copied row by row rather than handed to zxing as-is: the plane's buffer is
   * padded to `rowStride`, and its last row may stop short of a full stride, so
   * a reader told the stride is the width would walk off the end of a real
   * camera buffer on the devices that pad most.
   */
  private fun luminance(image: ImageProxy): PlanarYUVLuminanceSource {
    val plane = image.planes[0]
    val buffer = plane.buffer
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val width = image.width
    val height = image.height
    val out = ByteArray(width * height)
    val row = ByteArray(rowStride)
    for (y in 0 until height) {
      val offset = y * rowStride
      if (offset >= buffer.limit()) break
      buffer.position(offset)
      val available = minOf(rowStride, buffer.remaining())
      buffer.get(row, 0, available)
      if (pixelStride == 1) {
        System.arraycopy(row, 0, out, y * width, minOf(width, available))
      } else {
        var source = 0
        var destination = y * width
        var x = 0
        while (x < width && source < available) {
          out[destination] = row[source]
          source += pixelStride
          destination += 1
          x += 1
        }
      }
    }
    return PlanarYUVLuminanceSource(out, width, height, 0, 0, width, height, false)
  }

  override fun onDestroy() {
    super.onDestroy()
    analysisExecutor?.shutdown()
    analysisExecutor = null
    // The catch-all. Cancel, back, permission refused, no camera, or the system
    // reclaiming the activity all land here; whichever settle ran first already
    // took the callback, so this is a no-op except when nothing else answered.
    settle(emptyList())
  }
}
