package com.miranatechnologies.tacendum.attach

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * The native halves of attaching beyond photos on Android,
 * a port of app/modules/attach/ios/AttachImpl.swift.
 *
 * Three jobs JS cannot do, and the properties that make them safe:
 *
 *  - [pickDocument] enforces the size cap NATIVELY, before the bytes exist in
 *    JS at all — and enforces it TWICE, because Android's picker hands back a
 *    provider's URI rather than a system-made copy, so the size is a claim
 *    until the stream itself is counted ([DocumentReader]).
 *  - [currentLocation] is a ONE-SHOT read, COARSE only, through
 *    androidx's `LocationManagerCompat` — the framework's own
 *    `getCurrentLocation` is API 30, above the minSdk-26 floor, and the
 *    compat call covers 26 through 29 with no hand-rolled fallback. No
 *    monitoring, no subscription, nothing that outlives the promise.
 *  - [previewFile] writes the decrypted bytes to a private temp file only for
 *    the lifetime of an IN-APP presentation and deletes it on dismiss.
 *
 * Nothing in this module touches the network.
 *
 * One presentation at a time, enforced with a `busy` rejection rather than a
 * queue: these are user-initiated surfaces, and a queued second picker
 * appearing after the first dismisses is a surprise, not a service. Every
 * completion path resolves or rejects EXACTLY once — each pending promise
 * lives in an [AtomicReference] that its settling path takes, because
 * `onActivityResult` and a lifecycle callback are allowed to arrive in
 * surprising orders.
 */
class AttachModule(reactContext: ReactApplicationContext) :
    NativeAttachSpec(reactContext), ActivityEventListener, LifecycleEventListener {

  /**
   * Reads, base64 work and file writes — megabytes of each — never on the
   * thread drawing UI.
   */
  private val work: ScheduledExecutorService =
      Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "tacendum.attach").apply { isDaemon = true }
      }

  private val pendingPick = AtomicReference<Pending?>(null)
  private val previewing = AtomicBoolean(false)
  private val locating = AtomicBoolean(false)

  /**
   * The promises a teardown would otherwise strand.
   *
   * `invalidate()` shuts the work executor down, which both discards whatever
   * is queued on it and makes every later hand-off throw. Any promise whose
   * only settling path runs on that executor therefore has to be reachable
   * from here, or a reload during a preview write, a document read, or a
   * location wait leaves a JS promise pending for the life of the runtime.
   * `pendingPick` already served this role; these two complete the set.
   */
  private val pendingPreview = AtomicReference<Settling?>(null)

  /**
   * The picked document's read, which lives on past the moment `pendingPick`
   * is taken: `finishPick` claims the pick atomically and then hands the
   * actual read to the work executor, so between those two acts the promise
   * would be reachable from nowhere.
   */
  private val pendingRead = AtomicReference<Settling?>(null)
  private val pendingLocation = AtomicReference<Settle?>(null)

  private class Pending(val promise: Promise, val maxBytes: Long)

  /**
   * A promise with two possible settlers — the work task that was going to
   * answer it, and a teardown that answers it first. `Promise.reject` is not
   * a no-op the second time, so the race is closed here rather than argued
   * about at each call site.
   */
  private class Settling(private val promise: Promise) {
    private val settled = AtomicBoolean(false)

    fun resolve(value: Any?) {
      if (settled.compareAndSet(false, true)) promise.resolve(value)
    }

    fun reject(code: String, message: String) {
      if (settled.compareAndSet(false, true)) promise.reject(code, message)
    }
  }

  /** How a location request is answered, whoever gets there first. */
  private fun interface Settle {
    operator fun invoke(code: String?, message: String?, value: WritableMap?)
  }

  /**
   * Hand work to the executor, and answer the caller when the executor is
   * gone. `ExecutorService.execute` on a shut-down executor THROWS rather
   * than dropping the task quietly, so without this the exception escapes
   * into the calling thread and the promise never settles.
   */
  private fun onWork(promise: Promise, block: () -> Unit) {
    try {
      work.execute(block)
    } catch (t: RejectedExecutionException) {
      promise.reject("cancelled", "the runtime went away")
    }
  }

  /**
   * Where a preview's decrypted bytes live, for exactly as long as the
   * preview does. `cacheDir` is credential-encrypted storage, and the
   * backup exclusion (`path="."`, every domain) already covers it.
   */
  private val previewDir: File
    get() = File(reactApplicationContext.cacheDir, "tacendum-preview")

  init {
    reactContext.addActivityEventListener(this)
    reactContext.addLifecycleEventListener(this)
    // Delete anything a previous run left behind. The dismissal cleanup
    // cannot fire if the app was FORCE-KILLED mid-preview — plaintext would
    // then sit in the cache until Android felt like purging it, which is a
    // promise this app does not get to make. Called at module init, so every
    // launch starts with an empty directory.
    runCatching { work.execute { previewDir.deleteRecursively() } }
  }

  // MARK: - document pick

  override fun pickDocument(maxBytes: Double, promise: Promise) {
    if (previewing.get()) {
      promise.reject("busy", "another picker or preview is already presented")
      return
    }
    val pending = Pending(promise, maxBytes.toLong())
    if (!pendingPick.compareAndSet(null, pending)) {
      promise.reject("busy", "another picker or preview is already presented")
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      pendingPick.compareAndSet(pending, null)
      promise.reject("no_ui", "no activity to present the picker from")
      return
    }
    // ACTION_OPEN_DOCUMENT, not GET_CONTENT: the one-shot read grant is
    // scoped to this URI and this launch, and nothing of ours holds a
    // persistable claim on the provider afterwards.
    val intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
        }
    val launched = runCatching { activity.startActivityForResult(intent, REQUEST_PICK) }
    if (launched.isFailure) {
      // A launch the system refuses has no result callback at all: without
      // this the JS promise hangs forever and the guard stays set, wedging
      // every later pick as 'busy'.
      pendingPick.compareAndSet(pending, null)
      promise.reject("present_failed", "the picker did not appear")
    }
  }

  override fun onActivityResult(
      activity: Activity,
      requestCode: Int,
      resultCode: Int,
      data: Intent?,
  ) {
    when (requestCode) {
      REQUEST_PICK -> finishPick(resultCode, data)
      REQUEST_PREVIEW -> endPreview()
    }
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun finishPick(resultCode: Int, data: Intent?) {
    val pending = pendingPick.getAndSet(null) ?: return
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      // Cancellation is an answer, not an error.
      pending.promise.resolve(null)
      return
    }
    val settling = Settling(pending.promise)
    pendingRead.set(settling)
    onWork(pending.promise) { readPicked(uri, pending.maxBytes, settling) }
  }

  private fun readPicked(uri: Uri, maxBytes: Long, settling: Settling) {
    val resolver = reactApplicationContext.contentResolver
    var claimedSize = DocumentReader.SIZE_UNKNOWN
    var providerName = ""
    runCatching {
      resolver
          .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
          ?.use { cursor ->
            if (cursor.moveToFirst()) {
              val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
              if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
                providerName = cursor.getString(nameColumn).orEmpty()
              }
              val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
              if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
                claimedSize = cursor.getLong(sizeColumn)
              }
            }
          }
    }

    pendingRead.compareAndSet(settling, null)
    when (val outcome =
        DocumentReader.read(claimedSize, maxBytes) { resolver.openInputStream(uri) }) {
      is DocumentReader.Outcome.TooLarge -> {
        settling.reject(
            "too_large",
            if (outcome.claimed) "file is ${outcome.atLeastBytes} bytes"
            else "file is more than ${maxBytes} bytes",
        )
      }
      is DocumentReader.Outcome.Failed -> settling.reject("read_failed", outcome.message)
      is DocumentReader.Outcome.Read -> {
        val bytes = outcome.bytes
        // SANITISED, where iOS does not need to be. On iOS the picked name is
        // `url.lastPathComponent` of a file the SYSTEM copied into our
        // sandbox, so a filesystem already normalised it. Here it is a raw
        // string a DocumentsProvider asserted and nothing ever wrote to disk
        // — newlines and bidi overrides spoof the bubble exactly as they
        // spoof a preview title. Running it through the same port makes the
        // Android name as trustworthy as the iOS one, which is parity in
        // effect rather than in call sequence.
        val name = SafeName.sanitize(providerName)
        val result = Arguments.createMap()
        result.putString("name", name)
        result.putInt("size", bytes.size)
        result.putString("mime", mimeFor(uri, name))
        result.putString("dataB64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        settling.resolve(result)
      }
    }
  }

  private fun mimeFor(uri: Uri, name: String): String {
    val fromProvider = runCatching { reactApplicationContext.contentResolver.getType(uri) }
        .getOrNull()
        ?.takeIf { it.isNotBlank() }
    if (fromProvider != null) return fromProvider
    val extension = name.substringAfterLast('.', "").lowercase()
    val fromExtension =
        runCatching { MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
    return fromExtension ?: PreviewActivity.DEFAULT_MIME
  }

  // MARK: - one-shot location

  override fun currentLocation(timeoutMs: Double, promise: Promise) {
    if (!locating.compareAndSet(false, true)) {
      promise.reject("busy", "a location request is already running")
      return
    }
    val settled = AtomicBoolean(false)
    val settle = Settle { code, message, value ->
      if (settled.compareAndSet(false, true)) {
        pendingLocation.set(null)
        locating.set(false)
        if (code != null) promise.reject(code, message ?: code) else promise.resolve(value)
      }
    }
    // Reachable from invalidate() from here on. The wait can be as long as
    // `timeoutMs` plus however long a person spends on a permission dialog,
    // which is the widest window in this module for a reload to land in.
    pendingLocation.set(settle)
    withCoarsePermission { outcome ->
      when (outcome) {
        PermissionOutcome.GRANTED -> startOneShot(timeoutMs, settle)
        // NOT 'denied': nobody refused anything. JS reads a location 'denied'
        // as a standing refusal and offers the Settings door for it, which is
        // the wrong door when the truth is that there was no foreground
        // activity to ask through. The audio module draws the same
        // distinction, for the same reason.
        PermissionOutcome.NO_UI ->
            settle("no_ui", "no activity is available to ask for location", null)
        PermissionOutcome.DENIED ->
            settle("denied", "location permission was refused", null)
      }
    }
  }

  private fun startOneShot(timeoutMs: Double, settle: Settle) {
    val manager =
        runCatching {
              reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            }
            .getOrNull()
    if (manager == null) {
      settle("unavailable", "this phone has no location service", null)
      return
    }
    val provider = coarseProvider(manager)
    if (provider == null) {
      settle("unavailable", "no location provider is available", null)
      return
    }
    val signal = CancellationSignal()
    // The timeout cancels the request as well as rejecting: a one-shot that
    // keeps listening after JS gave up is a standing claim on where the
    // person is, which is exactly what this module promises not to hold.
    val timeout =
        runCatching { work.schedule(
            {
              runCatching { signal.cancel() }
              settle("timeout", "no position was returned in time", null)
            },
            timeoutMs.toLong().coerceAtLeast(1L),
            TimeUnit.MILLISECONDS,
        ) }
            .getOrNull()
    if (timeout == null) {
      // No executor left to fire the deadline on, so nothing could ever end
      // this wait. Answer now rather than listen forever for a runtime that
      // has gone.
      runCatching { signal.cancel() }
      settle("cancelled", "the runtime went away", null)
      return
    }
    val consumer =
        androidx.core.util.Consumer<Location?> { location ->
          timeout.cancel(false)
          if (location == null) {
            settle("unavailable", "no position could be determined", null)
          } else {
            val value = Arguments.createMap()
            value.putDouble("lat", location.latitude)
            value.putDouble("lng", location.longitude)
            // `accuracy` is the 68%-confidence horizontal radius in metres —
            // the same quantity iOS reports as `horizontalAccuracy`.
            value.putDouble("acc", location.accuracy.toDouble())
            settle(null, null, value)
          }
        }
    runCatching {
          LocationManagerCompat.getCurrentLocation(manager, provider, signal, work, consumer)
        }
        .onFailure {
          timeout.cancel(false)
          settle("unavailable", it.message ?: "the position could not be requested", null)
        }
  }

  /**
   * COARSE only. Hundred-metre accuracy is sufficient for a shared
   * place, and asking for FINE would be asking for more than the feature
   * needs.
   *
   * FUSED is preferred where it exists (API 31+) because it answers fastest
   * and is the one provider that is always present there; NETWORK is the
   * coarse provider below that; GPS is the last resort and, held only with
   * the coarse permission, the platform fuzzes what it returns — which is the
   * accuracy this feature asked for anyway.
   */
  private fun coarseProvider(manager: LocationManager): String? {
    val candidates = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      candidates += LocationManager.FUSED_PROVIDER
    }
    candidates += LocationManager.NETWORK_PROVIDER
    candidates += LocationManager.GPS_PROVIDER
    return candidates.firstOrNull { candidate ->
      runCatching { LocationManagerCompat.hasProvider(manager, candidate) }.getOrDefault(false)
    }
  }

  private enum class PermissionOutcome {
    GRANTED,
    DENIED,
    NO_UI,
  }

  /**
   * Three outcomes, not two.
   *
   * "Refused" and "there was nobody to ask" are different facts, and only the
   * first one is worth sending the person to Settings over. Collapsing them
   * into a Boolean is how a location request made with no foreground activity
   * ends up reported to JS as a standing refusal.
   *
   * The completion fires exactly once and always fires: `ReactActivity` keeps
   * ONE permission listener, so a second module asking for something else
   * replaces ours and the replaced listener is never called. Without the
   * watchdog that would leave `locating` set and every later request
   * answering 'busy' for the life of the process.
   */
  private fun withCoarsePermission(completion: (PermissionOutcome) -> Unit) {
    val answered = AtomicBoolean(false)
    val answer: (PermissionOutcome) -> Unit = { outcome ->
      if (answered.compareAndSet(false, true)) completion(outcome)
    }
    val context = reactApplicationContext
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED) {
      answer(PermissionOutcome.GRANTED)
      return
    }
    val activity = context.currentActivity
    if (activity !is PermissionAwareActivity) {
      answer(PermissionOutcome.NO_UI)
      return
    }
    val listener = PermissionListener { code, _, results ->
      if (code != REQUEST_LOCATION_PERMISSION) return@PermissionListener false
      answer(
          if (results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
              PermissionOutcome.GRANTED
          else PermissionOutcome.DENIED
      )
      true
    }
    runCatching {
      work.schedule(
          { answer(PermissionOutcome.NO_UI) },
          PERMISSION_WAIT_LIMIT_SECONDS,
          TimeUnit.SECONDS,
      )
    }
    val posted =
        runCatching {
              (activity as Activity).runOnUiThread {
                runCatching {
                      activity.requestPermissions(
                          arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION),
                          REQUEST_LOCATION_PERMISSION,
                          listener,
                      )
                    }
                    .onFailure { answer(PermissionOutcome.NO_UI) }
              }
            }
            .isSuccess
    if (!posted) answer(PermissionOutcome.NO_UI)
  }

  // MARK: - preview

  override fun previewFile(dataB64: String, name: String, promise: Promise) {
    if (pendingPick.get() != null) {
      promise.reject("busy", "another picker or preview is already presented")
      return
    }
    if (!previewing.compareAndSet(false, true)) {
      promise.reject("busy", "another picker or preview is already presented")
      return
    }
    // The filename port (SafeName): traversal, control characters, bidi
    // spoofing and the 255-byte component limit, exactly as iOS handles them.
    val safeName = SafeName.sanitize(name)
    // Reachable from invalidate(): everything below runs on the work
    // executor, which a teardown both drains and closes.
    val settling = Settling(promise)
    pendingPreview.set(settling)
    onWork(promise) {
      val bytes = runCatching { Base64.decode(dataB64, Base64.DEFAULT) }.getOrNull()
      if (bytes == null) {
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("bad_data", "not base64")
        return@onWork
      }
      val dir = previewDir
      dir.deleteRecursively()
      if (!dir.mkdirs()) {
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("write_failed", "the preview directory could not be created")
        return@onWork
      }
      val file = File(dir, safeName)
      // CONTAINMENT, PROVEN RATHER THAN ARGUED. SafeName already removes every
      // separator, so this can only fail on a name nobody has thought of yet —
      // which is the point: the write is refused unless the resolved path is
      // genuinely inside our private directory.
      val inside =
          runCatching { file.canonicalPath.startsWith(dir.canonicalPath + File.separator) }
              .getOrDefault(false)
      if (!inside) {
        dir.deleteRecursively()
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("write_failed", "the file name did not resolve inside the preview directory")
        return@onWork
      }
      val written = runCatching { file.writeBytes(bytes) }
      if (written.isFailure) {
        dir.deleteRecursively()
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("write_failed", written.exceptionOrNull()?.message ?: "the file could not be written")
        return@onWork
      }
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        dir.deleteRecursively()
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("no_ui", "no activity to present the preview from")
        return@onWork
      }
      val intent =
          Intent(reactApplicationContext, PreviewActivity::class.java).apply {
            putExtra(PreviewActivity.EXTRA_PATH, file.absolutePath)
            putExtra(PreviewActivity.EXTRA_NAME, safeName)
            putExtra(PreviewActivity.EXTRA_MIME, mimeForName(safeName))
          }
      val launched = runCatching { activity.startActivityForResult(intent, REQUEST_PREVIEW) }
      if (launched.isFailure) {
        // Same refusal case as the picker: no presentation means no dismissal,
        // so the bytes and the busy flag would both persist.
        dir.deleteRecursively()
        pendingPreview.compareAndSet(settling, null)
        previewing.set(false)
        settling.reject("present_failed", "the preview did not appear")
        return@onWork
      }
      pendingPreview.compareAndSet(settling, null)
      settling.resolve(null)
    }
  }

  private fun mimeForName(name: String): String {
    val extension = name.substringAfterLast('.', "").lowercase()
    return runCatching { MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) }
        .getOrNull()
        ?.takeIf { it.isNotBlank() } ?: PreviewActivity.DEFAULT_MIME
  }

  /**
   * The plaintext leaves the disk with the presentation.
   *
   * Idempotent, and reached from two directions on purpose: the activity
   * result (the ordinary dismissal) and the host resuming (the app coming
   * back to the foreground, which cannot happen while the preview is on top
   * of it). The activity deletes the directory itself as well — three
   * independent deletes for one file, because "the temp is gone when the
   * preview closes" is the whole claim the previewer makes.
   */
  private fun endPreview() {
    if (!previewing.getAndSet(false)) return
    work.execute { previewDir.deleteRecursively() }
  }

  override fun onHostResume() {
    endPreview()
  }

  override fun onHostPause() = Unit

  override fun onHostDestroy() = Unit

  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(this)
    reactApplicationContext.removeLifecycleEventListener(this)
    // ANSWER EVERY PROMISE FIRST, THEN CLOSE THE EXECUTOR. A promise whose
    // only settling path runs on `work` is unsettleable the moment
    // shutdownNow() drops the queue, so the order of these two acts is the
    // whole guarantee. Each settle is idempotent, so a task that had already
    // started and finishes concurrently does not settle twice.
    pendingPick.getAndSet(null)?.promise?.reject("cancelled", "the runtime went away")
    pendingRead.getAndSet(null)?.reject("cancelled", "the runtime went away")
    pendingPreview.getAndSet(null)?.reject("cancelled", "the runtime went away")
    pendingLocation.getAndSet(null)?.invoke("cancelled", "the runtime went away", null)
    previewing.set(false)
    locating.set(false)
    runCatching { previewDir.deleteRecursively() }
    work.shutdownNow()
    super.invalidate()
  }

  private companion object {
    const val REQUEST_PICK = 0x7B01
    const val REQUEST_PREVIEW = 0x7B02
    const val REQUEST_LOCATION_PERMISSION = 0x7B03

    /**
     * How long a permission wait may hang before it is settled as NO_UI —
     * long enough that a person reading the dialog never trips it, short
     * enough that a listener React Native replaced does not wedge this
     * module for the life of the process.
     */
    const val PERMISSION_WAIT_LIMIT_SECONDS = 180L
  }
}
