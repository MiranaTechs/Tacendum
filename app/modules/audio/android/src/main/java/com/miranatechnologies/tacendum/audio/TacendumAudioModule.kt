package com.miranatechnologies.tacendum.audio

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The native halves of voice notes on Android, a
 * port of app/modules/audio/ios/TacendumAudioImpl.swift.
 *
 * Two jobs JS cannot do, and the properties that make them safe:
 *
 *  - RECORDING writes to a private temp file because `MediaRecorder` requires
 *    a file descriptor — there is no buffer API, exactly as there is none on
 *    iOS. That plaintext is the one durable copy outside SQLite, so its
 *    lifetime is this class's central responsibility: deleted on stop (after
 *    read-in), on cancel, on every failure path, and swept at init and at
 *    launch for anything a kill left behind.
 *  - PLAYBACK is memory-only: `MediaPlayer.setDataSource(MediaDataSource)`
 *    plays the decrypted bytes with no file ever written, and the retained
 *    array is wiped and dropped on stop, on finish, and on every path that
 *    ends a playback.
 *
 * THE CALL GATE. iOS asks `CXCallObserver`, which is authoritative and
 * sees cellular calls. Android's authoritative equivalent costs
 * `READ_PHONE_STATE`, which this app does not spend, so the gate is
 * [CallBeacon] (our own Telecom calls, written by tacendum-call — never
 * imported here) OR'd with [AudioPolicy.callActiveForMode] (the system audio
 * mode). A recorded divergence notes what that buys and what it misses.
 *
 * THE SESSION DOCTRINE, TRANSPOSED. iOS refuses both voice-note entry points
 * while a call holds the shared `AVAudioSession`. Android's equivalent shared
 * resource is audio FOCUS plus the audio mode, and the same refusal applies
 * for the same reason: tacendum-call runs the call's audio, and a voice note
 * fighting it for the microphone is a race, not a feature. The RINGBACK is
 * the deliberate inverse — it REQUIRES a call, and it configures nothing at
 * all: no focus request, no mode change, no route override. It is one
 * `AudioTrack` with `USAGE_VOICE_COMMUNICATION` mixing into the routing the
 * call already established, which is what makes it behave like a call tone.
 *
 * Every promise resolves or rejects EXACTLY once: all state lives on one
 * serial executor, every entry point and every framework callback hops onto
 * it, and each finalize path clears the recording state before it settles
 * anything — a listener racing a manual stop finds the state already gone and
 * no-ops.
 */
class TacendumAudioModule(reactContext: ReactApplicationContext) :
    NativeTacendumAudioSpec(reactContext) {

  /**
   * Everything below lives on this thread. `MediaRecorder`/`MediaPlayer`
   * deliver callbacks on threads of their choosing, broadcasts arrive on
   * main, and JS calls arrive on the TurboModule queue; one serial executor
   * makes "who mutates state" a non-question and keeps disk reads and
   * megabyte base64 work off the thread drawing UI. It is SCHEDULED as well
   * as serial so the metering and progress tickers run on the same thread as
   * the state they read, with no second lock.
   */
  private val queue =
      Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "tacendum.audio").apply { isDaemon = true }
      }

  private val audioManager: AudioManager
    get() =
        reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  // MARK: - recording state

  private var recorder: MediaRecorder? = null
  private var recordingFile: File? = null
  private var levelTimer: ScheduledFuture<*>? = null

  /**
   * A start waiting on the permission dialog. The recorder does not exist
   * yet, so without this a second startRecording during the prompt would pass
   * the busy guard and two starts would race the same microphone.
   */
  private var startInFlight = false

  /**
   * The promise of a start that is waiting on the permission dialog.
   *
   * Held so [invalidate] can settle it. The iOS original does not need this:
   * its state queue outlives `invalidate()`, so the permission continuation
   * always runs and always rejects `'cancelled'`. This queue does NOT — a
   * teardown shuts it down — so without a handle on that promise, a reload
   * during a permission dialog would leave a JS promise pending forever.
   */
  private var pendingStart: Settling? = null

  /**
   * Bumped by [invalidate] and by cancel. A permission dialog is the slowest
   * thing this module does, and a grant returning after the runtime went away
   * would start the microphone for nobody, hot until the cap. Continuations
   * re-check the generation they began under and do nothing if it moved.
   */
  private var generation = 0

  // MARK: - playback state

  private var player: MediaPlayer? = null

  /**
   * The decrypted bytes the player is reading. Held explicitly so "wipe and
   * release the retained bytes on stop and on finish" is a visible act in
   * this file, not an artifact of the player's own retention.
   */
  private var playerSource: MemoryDataSource? = null
  private var progressTimer: ScheduledFuture<*>? = null
  private var noisyReceiver: BroadcastReceiver? = null

  // MARK: - ringback state

  /**
   * The outgoing-call ringback loop, wholly separate from the voice-note
   * [player]: the two can never coexist (voice notes refuse during calls, the
   * ringback refuses outside them), and sharing the slot would entangle the
   * ringback with focus bookkeeping it must never touch.
   */
  private var ringbackTrack: AudioTrack? = null

  // MARK: - message tone state

  /**
   * The message-arrival chime while it plays — one at a time, released by a
   * scheduled tick once its 340 ms are up. Its own slot, like the ringback:
   * it takes no focus and changes no mode, so it must never touch the focus
   * bookkeeping the voice-note slots carry.
   */
  private var toneTrack: AudioTrack? = null

  // MARK: - focus state

  /**
   * Whether WE hold audio focus (and therefore owe the abandon). Never true
   * while a call is up — the gate sees to that — and cleared without
   * abandoning when a focus loss means the focus is no longer ours to give
   * back.
   */
  private var focusOwned = false
  private var focusRequest: AudioFocusRequest? = null

  /**
   * WHICH focus is held, not merely that some is. Recording and playback ask
   * for different gains and different usages, and a request already in hand
   * only satisfies the next one when both match.
   */
  private var heldFocusGain = 0
  private var heldFocusUsage = 0

  private val focusListener =
      AudioManager.OnAudioFocusChangeListener { change -> onFocusChange(change) }

  /**
   * Where the one durable plaintext copy lives, for exactly as long as a
   * recording does. A dedicated directory so the sweep can be a single
   * recursive delete with nothing else's files at risk.
   *
   * `cacheDir` is credential-encrypted storage — the platform's own
   * at-rest protection, the analogue of the iOS `FileProtectionType.complete`
   * stamp — and the backup exclusion (`path="."`, every domain) already
   * covers it, so the directory is never copied off the device.
   */
  private val tempDir: File
    get() = File(reactApplicationContext.cacheDir, "tacendum-voice")

  init {
    // Every launch starts with an empty directory: the stop/cancel cleanup
    // cannot fire if the app was FORCE-KILLED mid-recording, and plaintext
    // sitting in the cache until Android felt like purging it is a promise
    // this app does not get to make. JS's sweepTemp() at launch is belt to
    // this braces.
    sweepLeftovers()
  }

  // MARK: - settling exactly once, across a queue that can go away

  /**
   * A promise that can be handed to two racing settlers.
   *
   * Only the recording start needs it, and only because that path has a gap
   * the iOS original does not: between the permission dialog going up and its
   * answer coming back, a reload can tear this module down. Both the teardown
   * and the late answer then have a legitimate claim on the same promise, and
   * `Promise.reject` called twice is a JS-visible error rather than a no-op.
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

  /**
   * Hand work to the state thread, and answer the caller if the thread is
   * gone.
   *
   * `ScheduledThreadPoolExecutor.execute` on a shut-down executor THROWS
   * `RejectedExecutionException` — it does not drop the task quietly. Two
   * consequences, both of which this helper exists to prevent: the throw
   * would escape into whichever thread called us (for a permission answer
   * that is the MAIN thread, arriving through
   * `onRequestPermissionsResult`, where an uncaught exception is a crash),
   * and the work that would have settled the JS promise never runs, so the
   * promise hangs. Every entry point goes through here.
   */
  private fun onQueue(promise: Promise, block: () -> Unit) {
    try {
      queue.execute(block)
    } catch (t: RejectedExecutionException) {
      promise.reject("cancelled", "the runtime went away")
    }
  }

  private fun onQueue(settling: Settling, block: () -> Unit) {
    try {
      queue.execute(block)
    } catch (t: RejectedExecutionException) {
      settling.reject("cancelled", "the runtime went away")
    }
  }

  /**
   * The same hand-off for framework callbacks that have no promise behind
   * them — a cap reached, a focus loss, a headset unplugged, a playback
   * finishing. They arrive on threads the framework picks (often main) and
   * can arrive AFTER a teardown, where the same
   * `RejectedExecutionException` would be an uncaught crash on whichever
   * thread delivered it. Swallowing is right here and only here: there is no
   * promise to answer, and every piece of state the block would have touched
   * was already released by [invalidate].
   */
  private fun onQueueQuietly(block: () -> Unit) {
    try {
      queue.execute(block)
    } catch (t: RejectedExecutionException) {
      // Nothing left to do it to.
    }
  }

  // MARK: - sweep

  private fun sweepLeftovers() {
    onQueueQuietly {
      // Never yank an active recording's file — a Metro reload constructs the
      // new module around the old one's invalidate, and ordering is the
      // harness's promise, not ours to assume.
      if (recorder != null) return@onQueueQuietly
      tempDir.deleteRecursively()
    }
  }

  override fun sweepTemp(promise: Promise) {
    onQueue(promise) {
      // A sweep with a recording somehow in flight still deletes everything:
      // the sweep's contract is "no plaintext survives", not "unless busy".
      discardRecording()
      tempDir.deleteRecursively()
      abandonFocusIfIdle()
      promise.resolve(null)
    }
  }

  // MARK: - recording

  override fun startRecording(maxSeconds: Double, promise: Promise) {
    onQueue(promise) {
      if (!(maxSeconds > 0.0)) {
        promise.reject("bad_args", "maxSeconds must be positive")
        return@onQueue
      }
      if (callIsActive()) {
        promise.reject("call_active", "recording is refused while a call is active")
        return@onQueue
      }
      if (recorder != null || startInFlight) {
        promise.reject("busy", "already recording")
        return@onQueue
      }
      startInFlight = true
      // From here the promise has TWO possible settlers — the permission
      // answer and a teardown that arrives before it — so it stops being a
      // bare Promise.
      val settling = Settling(promise)
      pendingStart = settling
      val gen = generation
      withMicPermission { outcome ->
        onQueue(settling) {
          startInFlight = false
          pendingStart = null
          // The runtime this recording was requested for is gone: resolve
          // nothing, start nothing, and leave the microphone alone.
          if (gen != generation) {
            settling.reject("cancelled", "the recording was cancelled before it began")
            return@onQueue
          }
          when (outcome) {
            PermissionOutcome.NO_UI -> {
              // NOT reported as 'denied': nobody refused anything. The app has
              // no foreground activity to ask through, which is a different
              // fact and must not be recorded by JS as a standing refusal.
              settling.reject("no_ui", "no activity is available to ask for the microphone")
              return@onQueue
            }
            PermissionOutcome.DENIED -> {
              settling.reject("denied", "microphone permission was refused")
              return@onQueue
            }
            PermissionOutcome.GRANTED -> Unit
          }
          // Re-checked, not assumed: a call can arrive while the permission
          // dialog is up, and the gate must hold at the moment the microphone
          // is actually opened, not the moment the person tapped.
          if (callIsActive()) {
            settling.reject("call_active", "recording is refused while a call is active")
            return@onQueue
          }
          if (recorder != null) {
            settling.reject("busy", "already recording")
            return@onQueue
          }
          beginRecording(maxSeconds, settling)
        }
      }
    }
  }

  private fun beginRecording(maxSeconds: Double, promise: Settling) {
    // A playing bubble yields to the recorder: one audio activity at a time
    // keeps "who owns the microphone" a fact rather than a race, and the
    // finished event lets the UI reset that bubble's control.
    if (player != null) {
      releasePlayer()
      safeEmit { emitOnPlaybackFinished() }
    }

    val dir = tempDir
    if (!dir.isDirectory && !dir.mkdirs()) {
      promise.reject("record_failed", "the recording directory could not be created")
      return
    }
    val file = File(dir, "voice-${UUID.randomUUID()}.m4a")

    // Configure AND take focus — unlike a call, nobody else will take it for
    // us, and the call gate above guarantees no owner is being fought.
    // TRANSIENT_EXCLUSIVE, not GAIN: a recording is a short exclusive act and
    // must not be ducked under, which is the closest thing Android has to
    // iOS's `.playAndRecord` + `setActive(true)`.
    if (!requestFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        AudioAttributes.USAGE_VOICE_COMMUNICATION)) {
      file.delete()
      promise.reject("record_failed", "the audio focus request was refused")
      return
    }

    // AAC-LC in an MPEG-4 container, mono, 24 kHz, 32 kbps — the same encode
    // the iOS recorder asks for, which is what lets either platform
    // decode the other's notes from memory.
    val rec =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          MediaRecorder(reactApplicationContext)
        } else {
          @Suppress("DEPRECATION") MediaRecorder()
        }
    try {
      rec.setAudioSource(MediaRecorder.AudioSource.MIC)
      rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      rec.setAudioChannels(1)
      rec.setAudioSamplingRate(24_000)
      rec.setAudioEncodingBitRate(32_000)
      rec.setOutputFile(file.absolutePath)
      // setMaxDuration IS the cap: the recorder auto-stops at maxSeconds and
      // the info listener finalizes into onRecordingFinished — no timer to
      // drift against the recorder, nothing for JS to enforce. This is the
      // Android spelling of iOS's `record(forDuration:)`.
      rec.setMaxDuration(AudioPolicy.maxDurationMillis(maxSeconds))
      rec.setOnInfoListener { source, what, _ ->
        if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
          onCapReached(source)
        }
      }
      rec.setOnErrorListener { source, _, _ -> onRecorderError(source) }
      rec.prepare()
      rec.start()
    } catch (t: Throwable) {
      runCatching { rec.reset() }
      runCatching { rec.release() }
      file.delete()
      abandonFocusIfIdle()
      promise.reject("record_failed", t.message ?: "the recorder refused to start")
      return
    }
    recorder = rec
    recordingFile = file
    startLevelTimer()
    promise.resolve(null)
  }

  override fun stopRecording(promise: Promise) {
    onQueue(promise) {
      val rec = recorder
      val file = recordingFile
      if (rec == null || file == null) {
        // Includes the cap/interruption race: the recording already finalized
        // into onRecordingFinished, and this promise must say so rather than
        // hang.
        promise.reject("not_recording", "no recording is in progress")
        return@onQueue
      }
      clearRecordingState()
      // Listeners detached BEFORE stop: the info listener serves the cap; a
      // manual stop finalizes right here, and two finalizers for one file is
      // exactly the double-settle this module exists to prevent.
      detachAndStop(rec)
      abandonFocusIfIdle()
      when (val outcome = finalizeRecording(file)) {
        is Finalized.Success -> promise.resolve(outcome.result)
        is Finalized.Failure -> promise.reject("finalize_failed", outcome.message)
      }
    }
  }

  /**
   * Cancelling also retires any in-flight permission request: the person
   * asked for this take to end, and a grant arriving afterwards must not
   * resurrect it.
   */
  override fun cancelRecording(promise: Promise) {
    onQueue(promise) {
      generation += 1
      discardRecording()
      abandonFocusIfIdle()
      promise.resolve(null)
    }
  }

  /** Stop and delete without ever reading the bytes. Safe when idle. */
  private fun discardRecording() {
    val rec = recorder ?: return
    val file = recordingFile
    clearRecordingState()
    detachAndStop(rec)
    file?.delete()
  }

  private fun clearRecordingState() {
    recorder = null
    recordingFile = null
    levelTimer?.cancel(false)
    levelTimer = null
  }

  /**
   * Detach the listeners, then stop and release. `stop()` throws when the
   * encoder never committed a valid file (a take shorter than the encoder's
   * first frame), which is not an error worth propagating: the finalize path
   * that follows reads an empty or absent file and reports "nothing was
   * recorded", which is the same truth in the vocabulary JS speaks.
   */
  private fun detachAndStop(rec: MediaRecorder) {
    runCatching { rec.setOnInfoListener(null) }
    runCatching { rec.setOnErrorListener(null) }
    runCatching { rec.stop() }
    runCatching { rec.reset() }
    runCatching { rec.release() }
  }

  private sealed interface Finalized {
    class Success(val result: WritableMap) : Finalized

    class Failure(val message: String) : Finalized
  }

  /**
   * Read, decode, DELETE. The deletion is unconditional — after this returns,
   * the plaintext exists nowhere on disk, whatever else happened.
   */
  private fun finalizeRecording(file: File): Finalized {
    try {
      val bytes = runCatching { file.readBytes() }.getOrNull()
      if (bytes == null || bytes.isEmpty()) return Finalized.Failure("nothing was recorded")
      // The DECODED duration is the truth: the wall clock measures how
      // long the recorder existed, not how much audio the encoder committed,
      // and those disagree exactly when it matters — interruption, encoder
      // trouble. Whole seconds, floor 1: the envelope's `dur` is 1..300 and a
      // sub-second note is honestly "1 second" at that granularity.
      val durationMs =
          probeDurationMs(bytes) ?: return Finalized.Failure("the recording could not be decoded")
      val result = Arguments.createMap()
      result.putString("dataB64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      result.putInt("durationSec", AudioPolicy.recordedSeconds(durationMs))
      return Finalized.Success(result)
    } finally {
      file.delete()
    }
  }

  /**
   * The decoder's answer, read from memory. `MediaMetadataRetriever` over a
   * [MemoryDataSource] is the Android `AVAudioPlayer(data:)` probe: it parses
   * the container the encoder actually wrote without a second file existing
   * anywhere.
   */
  private fun probeDurationMs(bytes: ByteArray): Long? {
    val retriever = MediaMetadataRetriever()
    val source = MemoryDataSource(bytes)
    return try {
      retriever.setDataSource(source)
      retriever
          .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
          ?.toLongOrNull()
          ?.takeIf { it >= 0L }
    } catch (t: Throwable) {
      null
    } finally {
      // release() closes the source; the bytes are NOT wiped — they are the
      // note, on their way to JS.
      runCatching { retriever.release() }
    }
  }

  /** The CAP path: `setMaxDuration` ran out and the recorder auto-stopped. */
  private fun onCapReached(source: MediaRecorder) {
    onQueueQuietly {
      // Manual stop and cancel detach the listener first, so this fires only
      // for the auto-stop — and if it races a manual stop onto the queue,
      // whichever runs second finds the recorder already cleared and no-ops.
      if (source !== recorder) return@onQueueQuietly
      val file = recordingFile ?: return@onQueueQuietly
      clearRecordingState()
      detachAndStop(source)
      abandonFocusIfIdle()
      val outcome = finalizeRecording(file)
      if (outcome is Finalized.Success) {
        safeEmit { emitOnRecordingFinished(outcome.result) }
      }
    }
  }

  /**
   * The encoder died mid-flight. Salvage what it committed — the same
   * finalize-or-clean path as the cap; the file never survives.
   */
  private fun onRecorderError(source: MediaRecorder) {
    onQueueQuietly {
      if (source !== recorder) return@onQueueQuietly
      val file = recordingFile ?: return@onQueueQuietly
      clearRecordingState()
      detachAndStop(source)
      abandonFocusIfIdle()
      val outcome = finalizeRecording(file)
      if (outcome is Finalized.Success) {
        safeEmit { emitOnRecordingFinished(outcome.result) }
      }
    }
  }

  private fun startLevelTimer() {
    levelTimer?.cancel(false)
    // runCatching, because this is called from beginRecording immediately
    // before the promise resolves: a scheduling refusal (the executor shut
    // down under a teardown) escaping here would leave the recorder running
    // and the JS promise unsettled. A missing meter is a cosmetic loss; an
    // unsettled start is not.
    levelTimer =
        runCatching { queue.scheduleAtFixedRate(
            {
              val rec = recorder ?: return@scheduleAtFixedRate
              // getMaxAmplitude is a LINEAR 16-bit peak since the previous
              // call; AudioPolicy converts to dBFS and applies the same −60 dB
              // floor and 0..1 clamp the iOS meter uses.
              val amplitude = runCatching { rec.maxAmplitude }.getOrDefault(0)
              safeEmit { emitOnLevel(AudioPolicy.levelForAmplitude(amplitude)) }
            },
            100L,
            100L,
            TimeUnit.MILLISECONDS,
        ) }
            .getOrNull()
  }

  // MARK: - playback

  override fun startPlayback(dataB64: String, promise: Promise) {
    onQueue(promise) {
      if (callIsActive()) {
        promise.reject("call_active", "playback is refused while a call is active")
        return@onQueue
      }
      // Playing over an in-flight recording would steal the microphone's
      // focus and truncate its file. The UI never offers this; the module
      // still refuses rather than trusting that.
      if (recorder != null || startInFlight) {
        promise.reject("busy", "a recording is in progress")
        return@onQueue
      }
      // One player at a time: bubble B replaces bubble A, and A's retained
      // bytes are wiped with it. No finished event for A — JS initiated this
      // switch and already knows.
      releasePlayer()
      val bytes =
          runCatching { Base64.decode(dataB64, Base64.DEFAULT) }.getOrNull()
              ?: run {
                promise.reject("bad_data", "not base64")
                return@onQueue
              }
      // GAIN, not TRANSIENT: a voice note interrupts background music rather
      // than ducking under it — a deliberate act; words cannot be heard under
      // a song. CONTENT_TYPE_SPEECH is what tells the platform which of
      // the two this is.
      if (!requestFocus(AudioManager.AUDIOFOCUS_GAIN, AudioAttributes.USAGE_MEDIA)) {
        promise.reject("play_failed", "the audio focus request was refused")
        return@onQueue
      }
      val source = MemoryDataSource(bytes)
      val mp = MediaPlayer()
      val durationMs: Long
      try {
        mp.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        // Memory only — no file is ever written for playback; the SQLite
        // attachments row stays the single durable decrypted copy.
        mp.setDataSource(source)
        mp.prepare()
        durationMs = mp.duration.toLong()
      } catch (t: Throwable) {
        // Bytes a decoder rejects: hostile or corrupt audio under a valid GCM
        // tag. The tag means the SENDER built this.
        runCatching { mp.reset() }
        runCatching { mp.release() }
        source.wipe()
        abandonFocusIfIdle()
        promise.reject("bad_data", "the audio could not be decoded")
        return@onQueue
      }
      // A length the decoder will not state cannot be checked against the
      // cap, so it is refused rather than played on trust — the fail-closed
      // direction. (`MediaPlayer` reports −1
      // for a stream whose duration it cannot determine.)
      if (durationMs < 0L) {
        runCatching { mp.reset() }
        runCatching { mp.release() }
        source.wipe()
        abandonFocusIfIdle()
        promise.reject("bad_data", "the audio length could not be determined")
        return@onQueue
      }
      // THE DECODED DURATION IS THE TRUTH. `dur` on the wire is a sender
      // claim, and a peer can claim one second while supplying a valid
      // half-hour of AAC. Refuse anything past the cap BEFORE it starts
      // playing, and hand the real length back so the bubble can correct
      // itself.
      if (AudioPolicy.exceedsPlaybackCap(durationMs)) {
        runCatching { mp.reset() }
        runCatching { mp.release() }
        source.wipe()
        abandonFocusIfIdle()
        promise.reject("too_long", "the audio is longer than the five-minute limit")
        return@onQueue
      }
      mp.setOnCompletionListener { finished -> onPlaybackEnded(finished) }
      mp.setOnErrorListener { failed, _, _ ->
        // A mid-stream decode failure means the same thing to the UI as
        // reaching the end: the control resets.
        onPlaybackEnded(failed)
        true
      }
      try {
        mp.start()
      } catch (t: Throwable) {
        runCatching { mp.reset() }
        runCatching { mp.release() }
        source.wipe()
        abandonFocusIfIdle()
        promise.reject("play_failed", "the player refused to start")
        return@onQueue
      }
      player = mp
      playerSource = source
      registerNoisyReceiver()
      startProgressTimer()
      // The real length goes back to JS so a bubble showing a lied-about
      // duration corrects itself the moment it is played.
      promise.resolve(durationMs / 1000.0)
    }
  }

  override fun stopPlayback(promise: Promise) {
    onQueue(promise) {
      releasePlayer()
      abandonFocusIfIdle()
      promise.resolve(null)
    }
  }

  private fun onPlaybackEnded(source: MediaPlayer) {
    onQueueQuietly {
      if (source !== player) return@onQueueQuietly // a switch already released it
      releasePlayer()
      abandonFocusIfIdle()
      safeEmit { emitOnPlaybackFinished() }
    }
  }

  /**
   * Stop and let go of the player AND the decrypted bytes it was reading —
   * the release half of "memory only". Safe when idle.
   */
  private fun releasePlayer() {
    progressTimer?.cancel(false)
    progressTimer = null
    unregisterNoisyReceiver()
    player?.let { mp ->
      runCatching { mp.setOnCompletionListener(null) }
      runCatching { mp.setOnErrorListener(null) }
      runCatching { mp.reset() }
      runCatching { mp.release() }
    }
    player = null
    playerSource?.wipe()
    playerSource = null
  }

  /**
   * The play head, four times a second — fast enough to read as motion, slow
   * enough to cost nothing. Only emits while the player is genuinely playing,
   * so a paused or interrupted note stops advancing.
   */
  private fun startProgressTimer() {
    progressTimer?.cancel(false)
    // Same reasoning as the level timer: scheduling must not be able to
    // strand startPlayback's promise.
    progressTimer =
        runCatching { queue.scheduleAtFixedRate(
            {
              val mp = player ?: return@scheduleAtFixedRate
              val playing = runCatching { mp.isPlaying }.getOrDefault(false)
              if (!playing) return@scheduleAtFixedRate
              val position = runCatching { mp.currentPosition }.getOrDefault(0)
              safeEmit { emitOnPlaybackProgress(position / 1000.0) }
            },
            0L,
            250L,
            TimeUnit.MILLISECONDS,
        ) }
            .getOrNull()
  }

  // MARK: - ringback (outgoing call)

  /**
   * Begin the ringback loop. Outgoing calls only, and the JS driver
   * (src/ui/ringback.ts) decides WHEN from the call state; this end enforces
   * only what native can see.
   *
   * THE DOCTRINE, INVERTED: where the voice-note entry points refuse while a
   * call exists, the ringback REQUIRES one. By the time an outgoing call is
   * ringing, tacendum-call has a Telecom Connection and the call's audio
   * routing is established, so this track only ever MIXES into it. It must
   * never become a second writer to that configuration: no focus request, no
   * mode change, no route override, and stopping gives nothing back (the
   * focus was never ours).
   *
   * With no call there is no routing to mix into, so it rejects 'no_call'
   * instead. Already ringing resolves quietly: the driver re-runs on app
   * foregrounding, and idempotence beats a second track under the first.
   */
  override fun startRingback(promise: Promise) {
    onQueue(promise) {
      if (ringbackTrack != null) {
        promise.resolve(null)
        return@onQueue
      }
      if (!callIsActive()) {
        promise.reject("no_call", "the ringback plays only during a call")
        return@onQueue
      }
      val pcm = RingbackTone.pcm
      // Nullable and declared OUTSIDE the try so the failure path can release
      // it: a track that was built and then threw on setLoopPoints or play()
      // still holds an audio-hardware buffer, and dropping the reference
      // leaks it for the life of the process.
      var track: AudioTrack? = null
      try {
        track =
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        // The call tone's usage, which is what puts it on the
                        // call's route and under the in-call volume rather
                        // than the media one.
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RingbackTone.SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                // MODE_STATIC + setLoopPoints is the hardware spelling of
                // iOS's `numberOfLoops = -1`: the whole cycle is written once
                // and the device repeats it with no thread feeding it.
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
        val written = track.write(pcm, 0, pcm.size)
        if (written != pcm.size) {
          runCatching { track.release() }
          promise.reject("ringback_failed", "the ringback buffer was not accepted")
          return@onQueue
        }
        track.setLoopPoints(0, RingbackTone.FRAME_COUNT, -1)
        track.play()
      } catch (t: Throwable) {
        runCatching { track?.release() }
        promise.reject("ringback_failed", t.message ?: "the ringback player refused to start")
        return@onQueue
      }
      ringbackTrack = track
      promise.resolve(null)
    }
  }

  /**
   * Stop the ringback and release it. Safe when idle — the terminal
   * transitions all call this without asking whether a ring was up.
   */
  override fun stopRingback(promise: Promise) {
    onQueue(promise) {
      stopRingbackNow()
      promise.resolve(null)
    }
  }

  /**
   * The release half. No focus is abandoned here, ever: the call's audio is
   * tacendum-call's to give back, and the ordinary next moment is the
   * answered call's voice flowing on it.
   */
  private fun stopRingbackNow() {
    val track = ringbackTrack ?: return
    ringbackTrack = null
    runCatching { track.pause() }
    runCatching { track.flush() }
    runCatching { track.stop() }
    runCatching { track.release() }
  }

  // MARK: - message tone (a text arrived while the app is open)

  /**
   * Play the message-arrival chime once — the port of the iOS
   * `playMessageTone` (TacendumAudioImpl.swift), with the platform's own
   * spelling of "a system notification sound": a short `AudioTrack` under
   * `USAGE_NOTIFICATION`, which puts it on the
   * notification stream — the device's notification volume, Do Not Disturb
   * and the ring/silent state all apply — and mixes it over whatever else
   * is playing. No focus request, no mode change, no route override: like
   * the ringback it is a writer to nothing.
   *
   * NEVER REJECTS. It is fired with `void` from the receive path, and a
   * delivery must not fail over a sound: a call up (the same [callIsActive]
   * gate the voice-note entry points refuse on — the call's audio owns the
   * route), a tone already sounding, a track that refused — every one
   * resolves quietly. JS decides WHEN (app/src/messageSound.ts); this end
   * enforces only what native can see.
   *
   * PARITY NOTE (devices session): this override exists because the
   * TurboModule spec is shared and codegen makes it abstract — the Android
   * build would not compile without it. The Android receive path's own
   * foreground chime wiring and the messages channel's sound are the
   * devices lane's items; this method is the callee they get for free.
   */
  override fun playMessageTone(promise: Promise) {
    // Enqueued on the quiet path, not `onQueue(promise)`: that helper
    // REJECTS "cancelled" when the executor is gone, and this promise's
    // contract is that it never rejects. A runtime that has gone away has
    // no chime to play, and "no chime" resolves.
    try {
      queue.execute { playMessageToneOnQueue(promise) }
    } catch (t: RejectedExecutionException) {
      promise.resolve(null)
    }
  }

  private fun playMessageToneOnQueue(promise: Promise) {
    if (callIsActive() || toneTrack != null) {
      promise.resolve(null)
      return
    }
    val pcm = MessageTone.pcm
    var track: AudioTrack? = null
    try {
      track =
          AudioTrack.Builder()
              .setAudioAttributes(
                  AudioAttributes.Builder()
                      // USAGE_NOTIFICATION, not the deprecated
                      // USAGE_NOTIFICATION_COMMUNICATION_INSTANT the API 33
                      // framework folds into it: the notification stream,
                      // its volume, Do Not Disturb and the ring/silent state.
                      .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                      .build()
              )
              .setAudioFormat(
                  AudioFormat.Builder()
                      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                      .setSampleRate(MessageTone.SAMPLE_RATE)
                      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                      .build()
              )
              .setTransferMode(AudioTrack.MODE_STATIC)
              .setBufferSizeInBytes(pcm.size * 2)
              .build()
      val written = track.write(pcm, 0, pcm.size)
      if (written != pcm.size) {
        runCatching { track.release() }
        promise.resolve(null)
        return
      }
      track.play()
    } catch (t: Throwable) {
      runCatching { track?.release() }
      promise.resolve(null)
      return
    }
    toneTrack = track
    // Released once the buffer has played out, with headroom for the
    // hardware's own latency; a teardown before then releases it early.
    runCatching {
      queue.schedule(
          { if (toneTrack === track) releaseToneNow() },
          MessageTone.DURATION_MS + 60,
          TimeUnit.MILLISECONDS,
      )
    }
    promise.resolve(null)
  }

  /** The release half. Nothing is given back because nothing was taken. */
  private fun releaseToneNow() {
    val track = toneTrack ?: return
    toneTrack = null
    runCatching { track.stop() }
    runCatching { track.release() }
  }

  // MARK: - interruption

  /**
   * Audio focus lost — the Android interruption. A call arriving, an alarm,
   * an assistant.
   *
   * FINALIZE, don't lose: the encoder is about to be starved, so
   * stopping closes the file around everything it committed, and the partial
   * note lands in preview — sendable or discardable, not silently gone. The
   * person answers their call and finds their words waiting.
   *
   * Every loss counts, ducking included: a recording cannot duck, and a
   * private voice note playing quietly under someone else's audio is not a
   * behaviour this app offers.
   */
  private fun onFocusChange(change: Int) {
    val lost =
        change == AudioManager.AUDIOFOCUS_LOSS ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ||
            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
    if (!lost) return
    onQueueQuietly {
      // The system already took it; it is not ours to give back.
      focusOwned = false
      val rec = recorder
      val file = recordingFile
      if (rec != null && file != null) {
        clearRecordingState()
        detachAndStop(rec)
        val outcome = finalizeRecording(file)
        if (outcome is Finalized.Success) {
          safeEmit { emitOnRecordingFinished(outcome.result) }
        }
        // A finalize failure here has no promise to reject and no event to
        // carry it; the UI's eventual stopRecording gets 'not_recording' and
        // resets. The file is already deleted either way.
      }
      if (player != null) {
        // The player is stopped with no resume path this UI offers; a bubble
        // stuck on "playing" over silence is a lie. Finished resets it.
        releasePlayer()
        safeEmit { emitOnPlaybackFinished() }
      }
      // Something took the audio mid-ring. A loop that resumes over whatever
      // comes next is not a ring — and the JS driver has no interruption
      // signal to restart it from, so ending it here is final.
      stopRingbackNow()
      abandonFocus()
    }
  }

  /**
   * Headphones unplugged mid-playback.
   *
   * iOS pauses the player itself and the route-change notification reports it
   * after the fact; Android sends `ACTION_AUDIO_BECOMING_NOISY` BEFORE the
   * switch and keeps playing unless the app acts — so where the iOS handler
   * observes a pause that already happened, this one has to cause it. Same
   * outcome, same reason: a private voice note must not blast out of the
   * loudspeaker because a cable moved. Treat it as finished; the person
   * re-taps to continue on the new route. Recording is unaffected — the
   * recorder continues on whatever microphone remains.
   */
  private fun registerNoisyReceiver() {
    if (noisyReceiver != null) return
    val receiver =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            onQueueQuietly {
              if (player == null) return@onQueueQuietly
              releasePlayer()
              abandonFocusIfIdle()
              safeEmit { emitOnPlaybackFinished() }
            }
          }
        }
    val registered =
        runCatching {
              ContextCompat.registerReceiver(
                  reactApplicationContext,
                  receiver,
                  IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                  ContextCompat.RECEIVER_NOT_EXPORTED,
              )
            }
            .isSuccess
    if (registered) noisyReceiver = receiver
  }

  private fun unregisterNoisyReceiver() {
    val receiver = noisyReceiver ?: return
    noisyReceiver = null
    runCatching { reactApplicationContext.unregisterReceiver(receiver) }
  }

  // MARK: - plumbing

  /**
   * Any call that has not ended — Tacendum's or the system's. The refusal
   * both voice-note entry points share, and the requirement the ringback
   * inverts.
   */
  private fun callIsActive(): Boolean {
    if (CallBeacon.activeCount() > 0) return true
    val mode = runCatching { audioManager.mode }.getOrNull() ?: return false
    return AudioPolicy.callActiveForMode(mode)
  }

  private fun requestFocus(gain: Int, usage: Int): Boolean {
    // ALREADY HOLDING THE RIGHT KIND is the only case that may short-circuit.
    // Holding a DIFFERENT kind must not: playback takes AUDIOFOCUS_GAIN with
    // USAGE_MEDIA, a recording takes AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE with
    // USAGE_VOICE_COMMUNICATION, and "play a voice note, then tap record" is
    // an ordinary two-tap sequence. A bare `if (focusOwned) return true` would
    // let that recording run under the playback's request — never registering
    // the exclusivity the comment at its call site promises, and telling this
    // module's own doctrine a lie. iOS has no equivalent hole because
    // `beginRecordingOnQueue` re-runs setCategory/setActive unconditionally on
    // every transition.
    if (focusOwned && heldFocusGain == gain && heldFocusUsage == usage) return true
    if (focusOwned) abandonFocus()
    val request =
        AudioFocusRequest.Builder(gain)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(usage)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setOnAudioFocusChangeListener(focusListener)
            .build()
    val granted =
        runCatching { audioManager.requestAudioFocus(request) }
            .getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED) ==
            AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (granted) {
      focusRequest = request
      focusOwned = true
      heldFocusGain = gain
      heldFocusUsage = usage
    }
    return granted
  }

  /**
   * The polite half: give the focus back so backgrounded music resumes, once
   * WE took it and nothing of ours still uses it.
   *
   * ONE DELIBERATE DEPARTURE FROM THE iOS SHAPE. `deactivateSessionIfIdle`
   * skips the deactivation whenever a call exists, because iOS has ONE shared
   * `AVAudioSession` and handing it back mid-call would be taking something
   * out of CallKit's hands. Android audio focus is per-REQUESTER: abandoning
   * the request this module made says nothing about the request tacendum-call
   * made, so there is nothing to take away from anybody, and the iOS
   * condition transplanted here would only strand our own request — held but
   * never released, and then leaked outright the next time one was built.
   * Not taking focus during a call is still enforced, by the gate, where it
   * belongs.
   */
  private fun abandonFocusIfIdle() {
    if (!focusOwned || recorder != null || player != null) return
    abandonFocus()
  }

  private fun abandonFocus() {
    focusOwned = false
    heldFocusGain = 0
    heldFocusUsage = 0
    val request = focusRequest ?: return
    focusRequest = null
    runCatching { audioManager.abandonAudioFocusRequest(request) }
  }

  private enum class PermissionOutcome {
    GRANTED,
    DENIED,
    NO_UI,
  }

  /**
   * Granted as an outcome, prompting only when the permission has never been
   * answered. The answer arrives on the main thread — callers hop back onto
   * the state queue before acting on it.
   *
   * THE COMPLETION FIRES EXACTLY ONCE, AND ALWAYS. Both halves are load
   * bearing, and neither is free on this platform:
   *
   *  - ONCE, because the caller's continuation settles a JS promise and
   *    clears `startInFlight`; a second call would settle twice.
   *  - ALWAYS, because `ReactActivity` keeps ONE permission listener. A
   *    second module asking for a different permission while this request is
   *    up REPLACES ours, and the replaced listener is never called — the
   *    grant lands somewhere else, this continuation never runs,
   *    `startInFlight` stays true, and the microphone button is dead until
   *    the app restarts. iOS cannot be pre-empted this way, so the original
   *    needs no watchdog; here one settles the wait as NO_UI rather than
   *    leaving it hanging. If the dialog is eventually answered after that,
   *    the answer is dropped and the next tap simply finds the permission
   *    already granted.
   */
  private fun withMicPermission(completion: (PermissionOutcome) -> Unit) {
    val answered = java.util.concurrent.atomic.AtomicBoolean(false)
    val answer: (PermissionOutcome) -> Unit = { outcome ->
      if (answered.compareAndSet(false, true)) completion(outcome)
    }
    val context = reactApplicationContext
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
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
      if (code != MIC_PERMISSION_REQUEST) return@PermissionListener false
      val granted =
          results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
      answer(if (granted) PermissionOutcome.GRANTED else PermissionOutcome.DENIED)
      true
    }
    // Generous: a person may sit on the dialog, read it, switch away and come
    // back. The watchdog exists for the listener that was REPLACED and will
    // never answer, not to hurry anybody.
    runCatching {
      queue.schedule(
          { answer(PermissionOutcome.NO_UI) },
          PERMISSION_WAIT_LIMIT_SECONDS,
          TimeUnit.SECONDS,
      )
    }
    // requestPermissions must be called on the main thread; this runs on the
    // state queue.
    val posted =
        runCatching {
              activity.runOnUiThread {
                runCatching {
                      activity.requestPermissions(
                          arrayOf(Manifest.permission.RECORD_AUDIO),
                          MIC_PERMISSION_REQUEST,
                          listener,
                      )
                    }
                    .onFailure { answer(PermissionOutcome.NO_UI) }
              }
            }
            .isSuccess
    if (!posted) answer(PermissionOutcome.NO_UI)
  }

  /**
   * The TurboModule's event sink is installed by the runtime and is null
   * until it is; a reload can also tear it down under a callback already in
   * flight. An emit is always best-effort telemetry for the UI — never a
   * promise settlement — so a dead sink is swallowed rather than allowed to
   * kill the audio thread.
   */
  private inline fun safeEmit(emit: () -> Unit) {
    runCatching { emit() }
  }

  /**
   * Runtime teardown (reload/shutdown). Synchronous on the state queue, so
   * after this returns no emit can land in the TurboModule being destroyed.
   * The microphone does not stay hot for a runtime that no longer exists: an
   * in-flight recording is discarded (file deleted), playback released.
   */
  override fun invalidate() {
    val teardown =
        runCatching {
          queue.submit {
            // FIRST: anything waiting on a permission dialog is now stale, so
            // its continuation starts nothing.
            generation += 1
            // ...and its JS promise is answered HERE rather than left to a
            // continuation this teardown is about to make unrunnable. Settling
            // is once-only, so a permission answer that still gets through
            // finds it already done.
            pendingStart?.reject("cancelled", "the recording was cancelled before it began")
            pendingStart = null
            startInFlight = false
            discardRecording()
            releasePlayer()
            stopRingbackNow()
            releaseToneNow()
            abandonFocus()
          }
        }
    // Bounded, because the state thread may be inside a prepare() the
    // framework owns the timing of, and blocking teardown forever is a worse
    // failure than a late cleanup.
    teardown.getOrNull()?.let { future -> runCatching { future.get(2, TimeUnit.SECONDS) } }
    queue.shutdownNow()
    super.invalidate()
  }

  private companion object {
    const val MIC_PERMISSION_REQUEST = 0x7A01

    /**
     * How long a permission wait may hang before it is settled as NO_UI —
     * long enough that a person reading the dialog never trips it, short
     * enough that a listener React Native replaced does not wedge the
     * recorder for the life of the process.
     */
    const val PERMISSION_WAIT_LIMIT_SECONDS = 180L
  }
}
