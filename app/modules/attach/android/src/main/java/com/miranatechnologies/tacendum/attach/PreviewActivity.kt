package com.miranatechnologies.tacendum.attach

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import kotlin.math.max

/**
 * The in-app previewer — Android's answer to QuickLook, and a
 * deliberately different bargain.
 *
 * iOS hands a temp file to `QLPreviewController`, a system surface that
 * renders in-process. Android's equivalent gesture would be `ACTION_VIEW`
 * with a `FileProvider` grant, which hands the decrypted bytes to whatever
 * app claims the type — breaking containment SILENTLY, for every type, every
 * time. This app rejects that: this activity renders images, PDFs and text itself,
 * the plaintext dies with the presentation, and for the types it cannot
 * render the ONLY path out is an export the person asks for by name, which
 * BREAKS CONTAINMENT BY DESIGN and says so on the screen before they choose
 * it (a recorded divergence).
 *
 * CONTAINMENT, CONCRETELY:
 *
 *  - `FLAG_SECURE` before the first frame, so the preview inherits the app's
 *    blocked-not-disclosed posture rather than being the one window in
 *    the app a screenshot can reach.
 *  - `excludeFromRecents` (manifest), so no thumbnail of the plaintext lands
 *    in the recents snapshot store.
 *  - The temp directory is deleted in [onDestroy] the moment this activity is
 *    finishing — belt to the module's own delete-on-result braces, because a
 *    preview that is swiped away must not depend on a callback reaching a JS
 *    runtime that may already be gone.
 */
class PreviewActivity : Activity() {

  private var previewFile: File? = null
  private var displayName: String = ""
  private var mimeType: String = DEFAULT_MIME

  private var pdfRenderer: PdfRenderer? = null
  private var pdfDescriptor: ParcelFileDescriptor? = null
  private var pdfPageIndex = 0
  private var pdfPageView: ImageView? = null
  private var pdfPageLabel: TextView? = null

  private lateinit var palette: Palette

  override fun onCreate(savedInstanceState: Bundle?) {
    // BEFORE the first frame, exactly as MainActivity does.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    super.onCreate(savedInstanceState)

    val path = intent?.getStringExtra(EXTRA_PATH)
    displayName = intent?.getStringExtra(EXTRA_NAME).orEmpty().ifEmpty { SafeName.FALLBACK }
    mimeType = intent?.getStringExtra(EXTRA_MIME).orEmpty().ifEmpty { DEFAULT_MIME }
    val file = path?.let { File(it) }
    if (file == null || !file.isFile) {
      // Nothing to show and nothing to contain: leave without drawing.
      setResult(RESULT_CANCELED)
      finish()
      return
    }
    previewFile = file
    palette = Palette.forNightMode(isNightMode())
    setContentView(buildRoot(file))
  }

  // MARK: - layout

  private fun buildRoot(file: File): View {
    val root =
        LinearLayout(this).apply {
          orientation = LinearLayout.VERTICAL
          setBackgroundColor(palette.ground)
          fitsSystemWindows = true
          layoutParams =
              ViewGroup.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.MATCH_PARENT,
              )
        }
    root.addView(buildHeader())
    // The header is a white sheet on a white ground in the day palette: the
    // seam is what tells them apart.
    root.addView(seam())
    val body =
        FrameLayout(this).apply {
          layoutParams =
              LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
    body.addView(buildBody(file))
    root.addView(body)
    return root
  }

  /** A one-pixel rule in [Palette.line], the app's hairline, across the column. */
  private fun seam(): View =
      View(this).apply {
        setBackgroundColor(palette.line)
        layoutParams =
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, HAIRLINE_PX)
      }

  private fun buildHeader(): View {
    val header =
        LinearLayout(this).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setBackgroundColor(palette.sheet)
          setPadding(dp(16), dp(14), dp(8), dp(14))
          layoutParams =
              LinearLayout.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.WRAP_CONTENT,
              )
        }
    val title =
        TextView(this).apply {
          text = displayName
          setTextColor(palette.inkStrong)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
          maxLines = 1
          // MIDDLE, not END: a hostile sender's padding cannot push the real
          // extension off the right edge when both ends stay visible.
          ellipsize = TextUtils.TruncateAt.MIDDLE
          layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
    val close =
        Button(this).apply {
          text = "Close"
          setTextColor(palette.pine)
          setBackgroundColor(Color.TRANSPARENT)
          setOnClickListener { finish() }
        }
    header.addView(title)
    header.addView(close)
    return header
  }

  private fun buildBody(file: File): View =
      when (Kind.of(mimeType, displayName)) {
        Kind.IMAGE -> buildImage(file) ?: buildUnsupported(UNRENDERABLE_IMAGE)
        Kind.PDF -> buildPdf(file) ?: buildUnsupported(UNRENDERABLE_PDF)
        Kind.TEXT -> buildText(file) ?: buildUnsupported(UNRENDERABLE_TEXT)
        Kind.OTHER -> buildUnsupported(null)
      }

  // MARK: - image

  /**
   * The picture at its own aspect, centred on the ground inside a one-pixel
   * [Palette.line] frame: drawn edge to edge on a white ground, an image with
   * white edges had no edge at all.
   */
  private fun buildImage(file: File): View? {
    val bitmap = decodeBounded(file) ?: return null
    val picture =
        ImageView(this).apply {
          setImageBitmap(bitmap)
          adjustViewBounds = true
          scaleType = ImageView.ScaleType.FIT_CENTER
          setBackgroundColor(palette.line)
          setPadding(HAIRLINE_PX, HAIRLINE_PX, HAIRLINE_PX, HAIRLINE_PX)
          layoutParams =
              FrameLayout.LayoutParams(
                  ViewGroup.LayoutParams.WRAP_CONTENT,
                  ViewGroup.LayoutParams.WRAP_CONTENT,
                  Gravity.CENTER,
              )
        }
    return FrameLayout(this).apply {
      setBackgroundColor(palette.ground)
      addView(picture)
      layoutParams =
          FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT,
          )
    }
  }

  /**
   * Decode at a bounded resolution. An attachment is capped in BYTES, not in
   * pixels, and a small highly-compressed image can still decode to hundreds
   * of megabytes of bitmap — an OOM here would kill the process with the
   * plaintext temp file still on disk, which is the one failure this
   * previewer must not have.
   */
  private fun decodeBounded(file: File): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    runCatching { BitmapFactory.decodeFile(file.absolutePath, bounds) }
    val widest = max(bounds.outWidth, bounds.outHeight)
    if (widest <= 0) return null
    var sample = 1
    while (widest / sample > MAX_IMAGE_EDGE_PX) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return runCatching { BitmapFactory.decodeFile(file.absolutePath, options) }.getOrNull()
  }

  // MARK: - pdf

  private fun buildPdf(file: File): View? {
    val descriptor =
        runCatching {
              ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            }
            .getOrNull() ?: return null
    val renderer =
        runCatching { PdfRenderer(descriptor) }
            .getOrElse {
              runCatching { descriptor.close() }
              return null
            }
    if (renderer.pageCount <= 0) {
      runCatching { renderer.close() }
      runCatching { descriptor.close() }
      return null
    }
    pdfDescriptor = descriptor
    pdfRenderer = renderer

    val column =
        LinearLayout(this).apply {
          orientation = LinearLayout.VERTICAL
          layoutParams =
              FrameLayout.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.MATCH_PARENT,
              )
        }
    // A white page on a white ground measures 1.00:1, so the rendered page
    // sits inside a one-pixel [Palette.line] frame.
    val page =
        ImageView(this).apply {
          adjustViewBounds = true
          scaleType = ImageView.ScaleType.FIT_CENTER
          setBackgroundColor(palette.line)
          setPadding(HAIRLINE_PX, HAIRLINE_PX, HAIRLINE_PX, HAIRLINE_PX)
          layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
    pdfPageView = page
    val scroller =
        ScrollView(this).apply {
          addView(page)
          layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
    column.addView(scroller)

    // One page at a time, rendered on demand: a long PDF rendered whole would
    // hold every page as a full-size bitmap at once.
    val bar =
        LinearLayout(this).apply {
          orientation = LinearLayout.HORIZONTAL
          gravity = Gravity.CENTER_VERTICAL
          setBackgroundColor(palette.sheet)
          setPadding(dp(8), dp(8), dp(8), dp(8))
        }
    val previous = Button(this).apply { text = "Previous" }
    val label =
        TextView(this).apply {
          setTextColor(palette.inkMuted)
          gravity = Gravity.CENTER
          layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
    val next = Button(this).apply { text = "Next" }
    pdfPageLabel = label
    previous.setTextColor(palette.pine)
    next.setTextColor(palette.pine)
    previous.setBackgroundColor(Color.TRANSPARENT)
    next.setBackgroundColor(Color.TRANSPARENT)
    previous.setOnClickListener { showPdfPage(pdfPageIndex - 1) }
    next.setOnClickListener { showPdfPage(pdfPageIndex + 1) }
    bar.addView(previous)
    bar.addView(label)
    bar.addView(next)
    if (renderer.pageCount > 1) {
      column.addView(seam())
      column.addView(bar)
    }

    showPdfPage(0)
    return column
  }

  private fun showPdfPage(index: Int) {
    val renderer = pdfRenderer ?: return
    if (index < 0 || index >= renderer.pageCount) return
    val target = pdfPageView ?: return
    val rendered =
        runCatching {
              renderer.openPage(index).use { page ->
                val width = max(dp(320), resources.displayMetrics.widthPixels)
                val scaled = width.toFloat() / page.width.toFloat()
                val height = max(1, (page.height * scaled).toInt())
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap
              }
            }
            .getOrNull() ?: return
    pdfPageIndex = index
    target.setImageBitmap(rendered)
    pdfPageLabel?.text = "Page ${index + 1} of ${renderer.pageCount}"
  }

  // MARK: - text

  private fun buildText(file: File): View? {
    val bytes =
        runCatching {
              file.inputStream().use { stream ->
                val cap = ByteArray(MAX_TEXT_BYTES)
                var total = 0
                while (total < cap.size) {
                  val read = stream.read(cap, total, cap.size - total)
                  if (read < 0) break
                  total += read
                }
                cap.copyOf(total)
              }
            }
            .getOrNull() ?: return null
    if (bytes.isEmpty()) return null
    val body = String(bytes, Charsets.UTF_8)
    val view =
        TextView(this).apply {
          text = body
          setTextColor(palette.inkBody)
          setTextIsSelectable(false)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
          typeface = android.graphics.Typeface.MONOSPACE
          setPadding(dp(16), dp(16), dp(16), dp(24))
        }
    return ScrollView(this).apply {
      addView(view)
      setBackgroundColor(palette.ground)
      layoutParams =
          FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT,
          )
    }
  }

  // MARK: - the disclosed exception

  /**
   * The screen for a type this app cannot draw.
   *
   * It says what it is going to cost, in the plainest words available,
   * BEFORE the person chooses it: everything else in this app keeps the
   * decrypted file inside the app and deletes it when the preview closes;
   * an export does not. ACTION_VIEW would have done this silently, for every
   * file. This asks.
   */
  private fun buildUnsupported(reason: String?): View {
    val column =
        LinearLayout(this).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(dp(24), dp(32), dp(24), dp(24))
          layoutParams =
              FrameLayout.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.MATCH_PARENT,
              )
        }
    column.addView(
        TextView(this).apply {
          text = reason ?: "This app cannot open this kind of file."
          setTextColor(palette.inkStrong)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        }
    )
    column.addView(
        TextView(this).apply {
          text =
              "Files you preview here stay inside Tacendum and are deleted when you close " +
                  "this screen. Saving a copy takes it out of Tacendum: it goes wherever you " +
                  "choose, is no longer protected by this app, and Tacendum cannot delete it " +
                  "for you afterwards."
          setTextColor(palette.inkBody)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
          setPadding(0, dp(16), 0, dp(24))
        }
    )
    column.addView(
        Button(this).apply {
          text = "Save a copy out of Tacendum"
          setTextColor(palette.onPine)
          setBackgroundColor(palette.pine)
          setOnClickListener { startExport() }
        }
    )
    column.addView(
        TextView(this).apply {
          text = mimeType
          setTextColor(palette.inkMuted)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
          setPadding(0, dp(24), 0, 0)
        }
    )
    return ScrollView(this).apply {
      addView(column)
      layoutParams =
          FrameLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT,
          )
    }
  }

  private fun startExport() {
    val intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = mimeType
          putExtra(Intent.EXTRA_TITLE, displayName)
        }
    runCatching { startActivityForResult(intent, REQUEST_EXPORT) }
        .onFailure { toast("No app on this phone can save a file.") }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_EXPORT) return
    val target = data?.data
    if (resultCode != RESULT_OK || target == null) return
    val source = previewFile ?: return
    val handler = Handler(Looper.getMainLooper())
    Thread {
          val ok = copyOut(source, target)
          handler.post {
            toast(
                if (ok) "Saved out of Tacendum. This app no longer protects that copy."
                else "The copy could not be saved."
            )
          }
        }
        .start()
  }

  private fun copyOut(source: File, target: Uri): Boolean =
      runCatching {
            contentResolver.openOutputStream(target)?.use { out ->
              source.inputStream().use { input -> input.copyTo(out) }
            } != null
          }
          .getOrDefault(false)

  // MARK: - lifecycle

  /**
   * The plaintext leaves the disk with the presentation.
   *
   * Guarded on [isFinishing] so a configuration change — which destroys and
   * recreates the activity — does not delete the file out from under the
   * recreated one. The manifest keeps the common rotations out of that path
   * anyway; this is the case that survives the ones it does not.
   */
  override fun onDestroy() {
    runCatching { pdfRenderer?.close() }
    runCatching { pdfDescriptor?.close() }
    pdfRenderer = null
    pdfDescriptor = null
    if (isFinishing) previewFile?.parentFile?.deleteRecursively()
    super.onDestroy()
  }

  /**
   * Every exit — the Close button, the back gesture, a `finish()` from
   * anywhere — carries a result, because the result is how the module learns
   * the presentation is over and releases its one-at-a-time guard.
   */
  override fun finish() {
    setResult(RESULT_OK)
    super.finish()
  }

  // MARK: - plumbing

  private enum class Kind {
    IMAGE,
    PDF,
    TEXT,
    OTHER;

    companion object {
      /**
       * The type decides, and the extension is the tie-break when a provider
       * offered nothing better than `application/octet-stream`.
       */
      fun of(mime: String, name: String): Kind {
        val lower = mime.lowercase()
        val extension = name.substringAfterLast('.', "").lowercase()
        return when {
          lower.startsWith("image/") -> IMAGE
          lower == "application/pdf" -> PDF
          lower.startsWith("text/") -> TEXT
          lower in TEXTUAL_APPLICATION_TYPES -> TEXT
          lower.endsWith("+json") || lower.endsWith("+xml") -> TEXT
          extension in IMAGE_EXTENSIONS -> IMAGE
          extension == "pdf" -> PDF
          extension in TEXT_EXTENSIONS -> TEXT
          else -> OTHER
        }
      }
    }
  }

  private class Palette(
      val ground: Int,
      val sheet: Int,
      val inkStrong: Int,
      val inkBody: Int,
      val inkMuted: Int,
      val pine: Int,
      val onPine: Int,
      /** The hairline between white surfaces: seams and the page frame. */
      val line: Int,
  ) {
    companion object {
      /** app/src/theme.ts, both palettes, token for token; line = lineStrong over the ground. */
      fun forNightMode(night: Boolean): Palette =
          if (night) {
            Palette(
                ground = Color.parseColor("#141414"),
                sheet = Color.parseColor("#232323"),
                inkStrong = Color.parseColor("#EDEDED"),
                inkBody = Color.parseColor("#C3C3C3"),
                inkMuted = Color.parseColor("#9A9A9A"),
                pine = Color.parseColor("#57AA7F"),
                onPine = Color.parseColor("#141414"),
                line = Color.parseColor("#515151"),
            )
          } else {
            Palette(
                ground = Color.parseColor("#FFFFFF"),
                sheet = Color.parseColor("#FFFFFF"),
                inkStrong = Color.parseColor("#181818"),
                inkBody = Color.parseColor("#404040"),
                inkMuted = Color.parseColor("#606060"),
                pine = Color.parseColor("#0E6B45"),
                onPine = Color.parseColor("#FFFFFF"),
                line = Color.parseColor("#BABABA"),
            )
          }
    }
  }

  private fun isNightMode(): Boolean =
      (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
          Configuration.UI_MODE_NIGHT_YES

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private fun toast(message: String) {
    runCatching { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
  }

  companion object {
    const val EXTRA_PATH = "com.miranatechnologies.tacendum.attach.PATH"
    const val EXTRA_NAME = "com.miranatechnologies.tacendum.attach.NAME"
    const val EXTRA_MIME = "com.miranatechnologies.tacendum.attach.MIME"

    const val DEFAULT_MIME = "application/octet-stream"

    private const val REQUEST_EXPORT = 0x7B10

    /** Bounded so a decompression bomb cannot OOM the process mid-preview. */
    private const val MAX_IMAGE_EDGE_PX = 4_096

    /** One physical pixel: the app's hairline, for seams and frames. */
    private const val HAIRLINE_PX = 1

    /** A megabyte of text is far past what anyone reads on a phone screen. */
    private const val MAX_TEXT_BYTES = 1 shl 20

    private const val UNRENDERABLE_IMAGE = "This image could not be decoded."
    private const val UNRENDERABLE_PDF = "This PDF could not be opened."
    private const val UNRENDERABLE_TEXT = "This text could not be read."

    private val TEXTUAL_APPLICATION_TYPES =
        setOf(
            "application/json",
            "application/xml",
            "application/javascript",
            "application/x-sh",
            "application/x-yaml",
            "application/yaml",
            "application/sql",
        )

    private val IMAGE_EXTENSIONS =
        setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif")

    private val TEXT_EXTENSIONS =
        setOf(
            "txt",
            "md",
            "markdown",
            "csv",
            "tsv",
            "json",
            "xml",
            "yaml",
            "yml",
            "log",
            "ini",
            "conf",
            "toml",
        )
  }
}
