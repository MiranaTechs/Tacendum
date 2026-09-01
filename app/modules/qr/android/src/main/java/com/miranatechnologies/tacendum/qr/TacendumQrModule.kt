package com.miranatechnologies.tacendum.qr

import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The Android QR module — zxing where iOS
 * uses CoreImage and Vision, CameraX where iOS presents an AVCaptureSession.
 *
 * It holds no policy: what a payload means, and whether a decoded string is an
 * id at all, is decided in `app/src/qr.ts`. The payload it draws is a BARE
 * ULID and stays one — no scheme, no prefix, no deep link.
 *
 * ONE DOCUMENTED DIVERGENCE FROM iOS: `writeSharePng`
 * resolves a `content://` URI from a FileProvider, where iOS resolves
 * `file://`. It is not a preference — a `file://` URI handed to another app
 * has thrown `FileUriExposedException` since API 24. Consumers of the shared
 * payload therefore see a different scheme, and the share intent must carry
 * `FLAG_GRANT_READ_URI_PERMISSION` for the grant to travel with it.
 *
 * Work runs on a single serial executor, not the JS thread: encoding rasters a
 * few hundred thousand pixels and decoding may load a camera-sized image, and
 * neither belongs on the thread that draws the app. Serial rather than pooled
 * because the share file is one fixed path — two concurrent writers to it
 * would be a race with no upside.
 */
class TacendumQrModule(reactContext: ReactApplicationContext) :
    NativeTacendumQrSpec(reactContext) {

  private val work: ExecutorService = Executors.newSingleThreadExecutor()

  /**
   * Run [body] off the JS thread and answer [promise] with what it returned.
   *
   * [fallback] is the code for something that is NOT one of the module's own
   * refusals — an out-of-memory, a filesystem fault. It is per-call rather
   * than one shared "something went wrong" because the code is the only thing
   * a bug report carries back, and a write failure reported as an encode
   * failure sends the reader to the wrong half of this file. Never the
   * exception's message: that could carry a path, and a path can carry a name.
   */
  private fun <T> off(promise: Promise, fallback: String, body: () -> T) {
    work.execute {
      try {
        promise.resolve(body())
      } catch (failure: QrCodec.QrFailure) {
        promise.reject(failure.code, failure.message)
      } catch (other: Throwable) {
        // Structure only, never content.
        promise.reject(fallback, other.javaClass.simpleName)
      }
    }
  }

  override fun encodePng(
      text: String,
      pixels: Double,
      darkHex: String,
      lightHex: String,
      promise: Promise,
  ) = off(promise, "qr_encode_failed") { QrCodec.encodePng(text, pixels.toInt(), darkHex, lightHex) }

  override fun decodeFile(fileUri: String, promise: Promise) =
      off(promise, "qr_decode_failed") {
        QrCodec.decodeImage(reactApplicationContext.contentResolver, fileUri).toWritableArray()
      }

  /**
   * Present the live scanner.
   *
   * Resolves with an EMPTY array — never a rejection — when the person
   * cancels, when there is no usable camera, when the permission is refused,
   * and when there is no activity to present from. None of those is an error:
   * the screen that asked already knows what to say when no id came back, and
   * a rejection would surface as a fault where a refusal is the truth.
   */
  override fun scanWithCamera(promise: Promise) {
    val host = reactApplicationContext.currentActivity
    if (host == null) {
      promise.resolve(emptyList<String>().toWritableArray())
      return
    }
    QrScannerActivity.present(host) { payloads -> promise.resolve(payloads.toWritableArray()) }
  }

  /**
   * Put the PNG where a share intent can reach it and resolve its URI.
   *
   * Cache, not files: this is a plaintext picture of the only address anyone
   * has for this account, so it must be evictable and must never reach a
   * backup. `getCacheDir()` is excluded from cloud backup and device transfer
   * by construction, and the app excludes every domain outright besides
   * — two independent reasons, neither relying on the other.
   */
  override fun writeSharePng(pngB64: String, promise: Promise) =
      off(promise, "qr_write_failed") {
        val file = QrCodec.writeShareFile(reactApplicationContext.cacheDir, pngB64)
        val authority = "${reactApplicationContext.packageName}.qrshare"
        FileProvider.getUriForFile(reactApplicationContext, authority, file).toString()
      }

  /**
   * Remove it. Called when the panel closes, not when the share sheet
   * dismisses — a receiving app keeps reading the file after the sheet is
   * gone. A missing file is the expected case as often as not, so this never
   * fails.
   */
  override fun clearSharePng(promise: Promise) {
    work.execute {
      try {
        QrCodec.shareFile(reactApplicationContext.cacheDir).delete()
      } catch (_: Throwable) {
        // Best effort, by design.
      }
      promise.resolve(null)
    }
  }

  override fun invalidate() {
    work.shutdown()
    super.invalidate()
  }

  private fun List<String>.toWritableArray(): WritableArray {
    val array = Arguments.createArray()
    for (payload in this) array.pushString(payload)
    return array
  }
}
