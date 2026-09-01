package com.miranatechnologies.tacendum.qr

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.NotFoundException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.multi.qrcode.QRCodeMultiReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream

/**
 * The two halves of a QR picture that JavaScript cannot do — drawing the
 * symbol, and reading one back out of a still image — with zxing where iOS
 * uses CoreImage and Vision.
 *
 * This object holds NO POLICY. It does not know what a Tacendum id looks like,
 * it does not decide whether a decoded string is one, and it never inspects a
 * payload; `app/src/qr.ts` owns all of that, exactly as it does on iOS. In
 * particular the payload it is handed is a BARE ULID and this file never
 * wraps, prefixes or URL-ifies it — a scheme here would put the id somewhere a
 * browser can open, log and sync, which is the one thing the QR design forbids.
 *
 * Nothing logs: every error detail below describes
 * structure — a length, a range, a dimension — and never content.
 *
 * The geometry constants are the iOS ones, deliberately, because the two
 * platforms have to produce pictures that scan off each other's screens.
 */
internal object QrCodec {

  /** Codes exist for diagnosis; `app/src/qr.ts` deliberately does not branch. */
  class QrFailure(val code: String, detail: String) : Exception("$code: $detail")

  /**
   * Longest string we will draw. A Tacendum id is 26 characters; the headroom
   * is slack, not an invitation.
   */
  const val MAX_TEXT_BYTES = 512

  /** Below 64 nothing is scannable; above 2048 it is a wall poster. */
  const val MIN_PIXELS = 64
  const val MAX_PIXELS = 2048

  /**
   * Quiet zone, in modules, baked into the exported PNG. ISO asks for 4. The
   * file leaves the app and gets cropped, pasted and recompressed by people we
   * do not control, so it cannot borrow the panel's padding — it carries its
   * own. zxing's writer is asked for MARGIN 0 so this is the only quiet zone
   * in the picture and its size is ours, not the library's.
   */
  const val QUIET_MODULES = 4

  /** Version 1 is 21 modules, version 40 is 177. Outside that is not a symbol. */
  const val MIN_MODULES = 21
  const val MAX_MODULES = 177

  /** Refused from the file's declared dimensions, before a pixel is allocated. */
  const val MAX_SOURCE_EDGE = 30_000
  const val MAX_SOURCE_PIXELS = 80_000_000L

  /**
   * Working ceiling for decoding. `inSampleSize` brings anything larger down
   * to this before a bitmap is allocated, which is both the memory bound and
   * the quality path — a power-of-two box filter keeps module edges far better
   * than an arbitrary rescale would.
   */
  const val MAX_WORKING_EDGE = 4096

  /** One file, one fixed name — never the id in the name. */
  const val SHARE_DIRECTORY = "tacendum-qr"
  const val SHARE_FILENAME = "tacendum-id.png"

  // ── encode ────────────────────────────────────────────────────────────────

  /** A finished raster: `edge` x `edge` ARGB pixels, one entry per pixel. */
  class Raster(val edge: Int, val modules: Int, val scale: Int, val pixels: IntArray)

  /**
   * The symbol itself, one bit per module, at correction level M.
   *
   * M, not H, and this is the same deliberate trade the iOS side documents: a
   * 26-character id is exactly the byte-mode capacity of a version-2 symbol at
   * M (25 modules), where H would need version 3-4 (29-33 modules) for the
   * same payload. The picture is displayed small, screenshotted, recompressed
   * and photographed off a screen — conditions where robustness comes from
   * each module being big enough to survive resampling, not from having more,
   * smaller modules carrying more redundancy.
   */
  fun encodeMatrix(text: String): Array<BooleanArray> {
    val hints =
        mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            // 0, because the quiet zone is added below at our own size. Asking
            // zxing for 4 here would give a matrix that is already padded and
            // make the module count unreadable from its dimensions.
            EncodeHintType.MARGIN to 0,
            EncodeHintType.CHARACTER_SET to "UTF-8",
        )
    val matrix =
        try {
          // 1x1 requested: zxing's writer never shrinks below the natural
          // symbol, so this asks for exactly one pixel per module.
          QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 1, 1, hints)
        } catch (e: Exception) {
          throw QrFailure("qr_encode_failed", "the writer produced nothing")
        }
    val modules = matrix.width
    if (modules != matrix.height || modules < MIN_MODULES || modules > MAX_MODULES) {
      throw QrFailure("qr_encode_failed", "implausible symbol")
    }
    return Array(modules) { y -> BooleanArray(modules) { x -> matrix.get(x, y) } }
  }

  /**
   * Draw the symbol into a pixel grid.
   *
   * The one defect that matters is a blurry symbol, so the raster is built by
   * hand rather than by scaling an image: one pixel per module, then an INTEGER
   * replication with no interpolation and no antialiasing anywhere in the path.
   * Any fractional scale gives some modules one more pixel than their
   * neighbours, and that ragged edge is exactly what a cheap decoder pointed at
   * a screen reads as noise. `pixels` is therefore a REQUEST, not a promise —
   * at 768 with a 25-module symbol this is scale 23, edge 759.
   */
  fun render(text: String, pixels: Int, darkHex: String, lightHex: String): Raster {
    if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) {
      throw QrFailure("qr_bad_argument", "text must be 1...$MAX_TEXT_BYTES bytes")
    }
    if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
      throw QrFailure("qr_bad_argument", "pixels must be $MIN_PIXELS...$MAX_PIXELS")
    }
    val dark = argb(darkHex) ?: throw QrFailure("qr_bad_argument", "colours must be #RRGGBB")
    val light = argb(lightHex) ?: throw QrFailure("qr_bad_argument", "colours must be #RRGGBB")

    val symbol = encodeMatrix(text)
    val modules = symbol.size
    val total = modules + 2 * QUIET_MODULES
    val scale = maxOf(1, pixels / total)
    val edge = total * scale

    val out = IntArray(edge * edge) { light }
    val origin = QUIET_MODULES * scale
    for (my in 0 until modules) {
      val row = symbol[my]
      for (mx in 0 until modules) {
        if (!row[mx]) continue
        val top = origin + my * scale
        val left = origin + mx * scale
        for (dy in 0 until scale) {
          val base = (top + dy) * edge + left
          java.util.Arrays.fill(out, base, base + scale, dark)
        }
      }
    }
    return Raster(edge, modules, scale, out)
  }

  /** The raster as PNG bytes, base64. */
  fun encodePng(text: String, pixels: Int, darkHex: String, lightHex: String): String {
    val raster = render(text, pixels, darkHex, lightHex)
    val bitmap =
        Bitmap.createBitmap(raster.pixels, raster.edge, raster.edge, Bitmap.Config.ARGB_8888)
    val bytes = ByteArrayOutputStream()
    val wrote = bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
    bitmap.recycle()
    if (!wrote || bytes.size() == 0) {
      throw QrFailure("qr_encode_failed", "no PNG")
    }
    return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
  }

  // ── decode ────────────────────────────────────────────────────────────────

  /**
   * The `inSampleSize` that brings a `width` x `height` source under the
   * working ceiling, having first refused sources that are absurd.
   *
   * Called with the DECLARED dimensions, before any pixels are allocated —
   * that ordering is the whole point of the bounds pass, and it is why a
   * hostile or merely enormous picture is refused rather than paged into
   * memory and then judged.
   */
  fun sampleSizeFor(width: Int, height: Int): Int {
    if (width <= 0 || height <= 0) {
      throw QrFailure("qr_unreadable", "no pixel dimensions")
    }
    if (width > MAX_SOURCE_EDGE ||
        height > MAX_SOURCE_EDGE ||
        width.toLong() * height.toLong() > MAX_SOURCE_PIXELS) {
      throw QrFailure("qr_too_large", "image beyond the decode ceiling")
    }
    // Powers of two only: BitmapFactory rounds anything else down to one, so
    // computing a non-power-of-two here would silently decode at a bigger size
    // than the caller was promised.
    var sample = 1
    while (maxOf(width, height) / sample > MAX_WORKING_EDGE) {
      sample *= 2
    }
    return sample
  }

  /**
   * Every distinct QR payload in the image at [uriString], in detection order.
   *
   * Finding nothing is a NORMAL outcome and returns an empty list: "there is
   * no QR in this photo" is a sentence the JS layer writes, not an error this
   * side raises.
   */
  fun decodeImage(resolver: ContentResolver, uriString: String): List<String> {
    val open = streamOpener(resolver, uriString)

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open().use { BitmapFactory.decodeStream(it, null, bounds) }
    val sample = sampleSizeFor(bounds.outWidth, bounds.outHeight)

    val options =
        BitmapFactory.Options().apply {
          inSampleSize = sample
          inPreferredConfig = Bitmap.Config.ARGB_8888
        }
    val bitmap =
        open().use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw QrFailure("qr_unreadable", "no decodable pixels")

    try {
      val width = bitmap.width
      val height = bitmap.height
      if (width <= 0 || height <= 0) {
        throw QrFailure("qr_unreadable", "no decodable pixels")
      }
      val pixels = IntArray(width * height)
      bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
      return readAll(RGBLuminanceSource(width, height, pixels))
    } finally {
      bitmap.recycle()
    }
  }

  /**
   * Every distinct payload zxing can find in one luminance frame.
   *
   * `QRCodeMultiReader`, never the single-symbol reader, and that is the
   * ambiguity contract rather than a nicety: `app/src/qr.ts` refuses a picture
   * containing two different codes instead of guessing which person was meant,
   * and it can only do that if this side reports ALL of them. A reader that
   * returned the first symbol would make the refusal unreachable by making the
   * choice here, silently, with no idea what it was choosing between.
   *
   * Duplicates collapse: one symbol reported twice is not two codes, and
   * treating it as ambiguity would refuse pictures that are perfectly clear.
   */
  fun readAll(source: LuminanceSource): List<String> {
    val hints =
        mapOf<DecodeHintType, Any>(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
        )
    // Two binarizers because they fail on opposite pictures: Hybrid handles
    // uneven lighting (a photo of a screen), Global handles the flat synthetic
    // image (a screenshot) that Hybrid's local thresholding can smear.
    for (binarizer in
        listOf(
            BinaryBitmap(HybridBinarizer(source)),
            BinaryBitmap(GlobalHistogramBinarizer(source)),
        )) {
      val found =
          try {
            QRCodeMultiReader().decodeMultiple(binarizer, hints)
          } catch (_: NotFoundException) {
            continue
          } catch (e: Exception) {
            throw QrFailure("qr_decode_failed", "the reader could not run")
          }
      val payloads = LinkedHashSet<String>()
      for (result in found) {
        val text = result.text ?: continue
        payloads.add(text)
      }
      if (payloads.isNotEmpty()) return payloads.toList()
    }
    return emptyList()
  }

  // ── the share file ────────────────────────────────────────────────────────

  fun shareDirectory(cacheDir: File): File = File(cacheDir, SHARE_DIRECTORY)

  fun shareFile(cacheDir: File): File = File(shareDirectory(cacheDir), SHARE_FILENAME)

  /**
   * Write the PNG where a share intent can reach it. Atomic and always to the
   * same path, so at most one of these exists and the previous one is replaced
   * rather than accumulated.
   */
  fun writeShareFile(cacheDir: File, pngB64: String): File {
    val bytes =
        try {
          Base64.decode(pngB64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
          throw QrFailure("qr_bad_argument", "not base64 PNG bytes")
        }
    if (bytes.isEmpty()) throw QrFailure("qr_bad_argument", "not base64 PNG bytes")

    val directory = shareDirectory(cacheDir)
    val file = shareFile(cacheDir)
    try {
      directory.mkdirs()
      val staging = File(directory, "$SHARE_FILENAME.tmp")
      staging.writeBytes(bytes)
      if (!staging.renameTo(file)) {
        staging.delete()
        throw QrFailure("qr_write_failed", "could not write the share file")
      }
    } catch (e: QrFailure) {
      throw e
    } catch (e: Exception) {
      throw QrFailure("qr_write_failed", "could not write the share file")
    }
    return file
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /**
   * A function that opens the source afresh each time it is called.
   *
   * Two passes read the same image — dimensions first, pixels second — and a
   * `content://` stream cannot be rewound, so the opener is what lets the
   * bounds-before-allocate ordering hold for a picture that came from the
   * system picker as well as for one on disk.
   */
  private fun streamOpener(resolver: ContentResolver, uriString: String): () -> InputStream {
    val uri = Uri.parse(uriString)
    return when (uri.scheme) {
      null,
      "file" -> {
        val path = uri.path ?: throw QrFailure("qr_bad_argument", "not a readable uri")
        val file = File(path)
        if (!file.isFile) throw QrFailure("qr_unreadable", "no such file")
        ({ file.inputStream() })
      }
      "content" -> ({
        resolver.openInputStream(uri) ?: throw QrFailure("qr_unreadable", "nothing behind the uri")
      })
      else -> throw QrFailure("qr_bad_argument", "not a readable uri")
    }
  }

  /**
   * '#RRGGBB' -> opaque ARGB, or null. Strict on purpose: the palette lives in
   * the theme and arrives as a parameter, so anything else is a caller bug
   * worth surfacing rather than a colour worth guessing.
   */
  fun argb(hex: String): Int? {
    if (hex.length != 7 || hex[0] != '#') return null
    var value = 0
    for (index in 1 until 7) {
      val digit =
          when (val c = hex[index]) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> return null
          }
      value = value shl 4 or digit
    }
    return value or (0xFF shl 24)
  }
}
