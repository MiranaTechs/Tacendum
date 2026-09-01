package com.miranatechnologies.tacendum.call

import android.content.Context
import org.json.JSONObject
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * One call's peer connection — the Kotlin twin of
 * `ios/CallPeerConnection.swift`.
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
 * claim rests on. libwebrtc's DTLS-SRTP is a sanctioned primitive; every
 * fingerprint is authenticated through libsignal before it gets here, because
 * it arrives inside a ratcheted envelope.
 *
 * **Callbacks, not `async`.** The Swift file is written in structured
 * concurrency; libwebrtc's Java API is `SdpObserver`-shaped, and adding a
 * coroutines dependency to reproduce the syntax would add a dependency to
 * reproduce syntax. Every suspension point in the Swift version is a callback
 * boundary here, and each one is followed by the same look at `closed` — the
 * checks are the port, not the keywords.
 */
internal class CallPeerConnection(
    val cid: String,
    private val appContext: Context,
    private val factory: PeerConnectionFactory,
    config: PeerConnection.RTCConfiguration,
    private val eglBase: EglBase,
    private val events: CallEventSink,
    /**
     * Manual audio. When armed, this connection's audio unit is held
     * OFF at construction and started only by the activation site in
     * `CallAudioGate` — never on our own timing, never when a track is added.
     */
    private val manualAudio: Boolean,
    audioEnabledNow: Boolean,
) {

  private val connection: PeerConnection

  private var audioTrack: AudioTrack? = null
  private var audioSource: org.webrtc.AudioSource? = null
  private var videoTrack: VideoTrack? = null
  private var videoSource: VideoSource? = null
  private var capturer: VideoCapturer? = null
  private var surfaceHelper: SurfaceTextureHelper? = null
  private var usingSyntheticVideo = false
  /** Fault injector: send a deliberately wrong `a=fingerprint`. DEBUG-gated. */
  private var faultFingerprint = false
  /** Which camera the capture is on, so a flip knows what to flip to. */
  private var frontCamera = true

  /**
   * Whether this call ever took the camera.
   *
   * Read by the module to derive the foreground service's declared types from
   * the LIVE SET rather than from whichever call last changed — passing the
   * caller's `withVideo` through would mean hanging up a voice call beside a
   * live video one re-declared the service without `camera`, and Android would
   * take the camera away from the call still using it.
   */
  @Volatile var usesVideo = false
    private set

  /**
   * Candidates that arrived before the remote description was applied.
   * libwebrtc rejects them outright in that window, and dropping them costs
   * exactly the connectivity path they described.
   */
  private val pendingRemoteCandidates = ArrayList<IceCandidate>()
  private var remoteDescriptionSet = false
  /** Local tracks are added exactly once per peer connection. */
  private var localMediaAdded = false

  /**
   * THIS CONNECTION IS OVER.
   *
   * `TacendumCallModule`'s tombstone closes the race in which `close(cid)`
   * arrives BEFORE the negotiation has installed the connection. It says
   * nothing about the far more ordinary one that comes after: the module
   * installs and unlocks, `close(cid)` removes the entry and closes it, and
   * the same negotiation then walks on into `createOffer`/`createAnswer` —
   * adding local media to a closed connection, which takes the microphone and
   * (with video) starts a capture session for a call that no longer exists
   * anywhere. The map no longer holds it, so nothing above the bridge can
   * close it a second time.
   *
   * One flag, under `stateLock` like every other cross-thread field here,
   * read at each point where this object is about to acquire hardware or
   * advance the negotiation.
   */
  private var closed = false
  /** Previous cumulative counters, so quality is per interval, not lifetime. */
  private var lastPacketsLost = 0.0
  private var lastPacketsReceived = 0.0

  /** Guards every field above. */
  private val stateLock = Any()

  init {
    // No data channel and no legacy constraints beyond the one that matters.
    // `DtlsSrtpKeyAgreement` is required: without it libwebrtc would fall back
    // to SDES, which puts the media keys IN the SDP as plaintext. Inside our
    // envelope that is still ratcheted, but it discards the property that even
    // a future compromise of the signalling channel cannot retroactively
    // decrypt the media. Kept as an explicit constraint even though M124 has
    // no SDES to fall back to, for the reason the Swift file gives: this is
    // the line a reviewer looks for, and a build that silently stopped
    // honouring it should fail loudly rather than quietly negotiate something
    // else.
    val constraints = MediaConstraints()
    constraints.optional.add(MediaConstraints.KeyValuePair("DtlsSrtpKeyAgreement", "true"))
    // DEPRECATED ON PURPOSE. The constraints overload of `createPeerConnection`
    // is the only one that carries `DtlsSrtpKeyAgreement`; the modern
    // constructor drops media constraints entirely on the reasoning that DTLS
    // is now the only option. That reasoning is almost certainly right for
    // M124, and "almost certainly" is not the standard for the line the media
    // E2EE claim rests on — an explicit mandate that a future libwebrtc
    // rejects is a loud build failure, where an implicit default that changes
    // is a silent one.
    @Suppress("DEPRECATION")
    val built = factory.createPeerConnection(config, constraints, Observer())
    connection = built ?: throw CallError.PeerConnectionFailed()
    // MANUAL AUDIO, applied before anything can add a track. A unit
    // that started here even once would make the Telecom handshake advisory
    // rather than authoritative, which is the "connected call, no sound"
    // class of bug this whole ordering exists to prevent.
    if (manualAudio) applyAudioUnit(audioEnabledNow)
  }

  // MARK: - audio unit

  /**
   * Start or stop THIS connection's audio unit.
   *
   * The Android analogue of `RTCAudioSession.isAudioEnabled`:
   * `setAudioPlayout`/`setAudioRecording` gate the audio device module for
   * this peer connection, which is the same lever at the same level. Called
   * only from `CallAudioGate` — the single activation site.
   */
  fun applyAudioUnit(enabled: Boolean) {
    connection.setAudioPlayout(enabled)
    connection.setAudioRecording(enabled)
  }

  // MARK: - media

  /**
   * Add the local tracks. Audio always; video only when the call opened with
   * it, because adding a video transceiver we never use still negotiates a
   * second m-line and costs setup time.
   *
   * **Idempotent, and that is load-bearing.** `createOffer` guards with
   * `if (!iceRestart)`, but `createAnswer` does not, and the module
   * deliberately REUSES an existing peer connection when an ICE restart
   * arrives so the credentials continue. Running this twice would add two more
   * tracks and rebind every field to the new objects — while the ORIGINAL
   * tracks stay associated with the transceivers the remote description names
   * and keep transmitting. Every control then points at the wrong object:
   * `setAudioEnabled` mutes a track that is not on the air, the UI says muted,
   * and the microphone keeps going for the rest of the call.
   */
  fun addLocalMedia(withVideo: Boolean) {
    // Test-and-set under the lock, with the closed test in the SAME critical
    // section: a `close()` landing between a separate check and this
    // assignment would be overwritten by the very state change it was racing,
    // and the microphone would open behind it.
    val alreadyAdded =
        synchronized(stateLock) {
          val skip = localMediaAdded || closed
          localMediaAdded = true
          skip
        }
    if (alreadyAdded) return

    // CREATE OUTSIDE THE LOCK, INSTALL UNDER IT OR DESTROY.
    //
    // Building a video source, a track and a camera session takes real time —
    // device enumeration, format selection, a capture start. Doing that with
    // the lock released and assigning `this.capturer` only at the end leaves a
    // window in which `close()` raises `closed`, sees a null capturer, stops
    // nothing and returns; `close()` is idempotent, so nothing ever comes back
    // for the capturer this method then installs. That is a camera still
    // running, with its indicator lit, on a call the app believes is over.
    //
    // So the objects are built into LOCALS and the lock is retaken to decide
    // their fate atomically with the flag that condemns them.
    val newAudioSource = factory.createAudioSource(MediaConstraints())
    val audio = factory.createAudioTrack("a0", newAudioSource)

    var newSource: VideoSource? = null
    var newTrack: VideoTrack? = null
    var newCapturer: VideoCapturer? = null
    var newHelper: SurfaceTextureHelper? = null
    if (withVideo) {
      val source = factory.createVideoSource(false)
      newSource = source
      newTrack = factory.createVideoTrack("v0", source)
      val helper = SurfaceTextureHelper.create("tacendum-capture", eglBase.eglBaseContext)
      newHelper = helper
      // STARTED before the re-check, deliberately. The alternative — install
      // first, start after — moves the same hole one line down: `close()`
      // would stop a capturer that has not begun, and the start would run
      // behind it. A capturer that is running by the time the lock is taken is
      // one this method can always account for.
      newCapturer = makeCapturer(source, helper)
    }

    val closedInGap =
        synchronized(stateLock) {
          val gone = closed
          if (!gone) {
            audioTrack = audio
            audioSource = newAudioSource
            videoSource = newSource
            videoTrack = newTrack
            capturer = newCapturer
            surfaceHelper = newHelper
          }
          gone
        }

    if (closedInGap) {
      // The call died while this was being built. Nothing was installed, so
      // nothing here is reachable from `close()` — which means this is the
      // only place that can end it.
      stopCapturer(newCapturer)
      newCapturer?.dispose()
      newHelper?.dispose()
      audio.setEnabled(false)
      newTrack?.setEnabled(false)
      newSource?.dispose()
      newAudioSource.dispose()
      return
    }

    connection.addTrack(audio, listOf("s0"))
    val track = newTrack ?: return
    usesVideo = true
    connection.addTrack(track, listOf("s0"))
    // Published so a preview can render it. Without this the local PiP has
    // nothing to show and the person cannot tell whether their camera is
    // pointed at them, which is the first thing anyone checks. AFTER the
    // install, so it can never outlive the `clear(cid)` in `close()`.
    VideoTrackRegistry.set(track, cid, VideoTrackRegistry.Role.LOCAL)
    applyVideoEncodingPreferences()
  }

  /**
   * Build and START a capturer WITHOUT installing it: the caller decides,
   * under `stateLock`, whether it becomes `this.capturer` or is stopped.
   */
  private fun makeCapturer(source: VideoSource, helper: SurfaceTextureHelper): VideoCapturer? {
    if (BuildConfig.DEBUG && usingSyntheticVideo) {
      // The emulator has no dependable camera, so without this the whole
      // media pipeline — capture, encode, DTLS-SRTP, decode, render — is only
      // testable on two physical phones.
      val synthetic = SyntheticVideoCapturer()
      synthetic.initialize(helper, appContext, source.capturerObserver)
      synthetic.startCapture(
          SyntheticVideoCapturer.DEFAULT_WIDTH,
          SyntheticVideoCapturer.DEFAULT_HEIGHT,
          SyntheticVideoCapturer.DEFAULT_FPS,
      )
      return synthetic
    }
    val enumerator = Camera2Enumerator(appContext)
    val names = enumerator.deviceNames
    val front = names.firstOrNull { enumerator.isFrontFacing(it) }
    val chosen = front ?: names.firstOrNull() ?: return null
    frontCamera = front != null
    val camera = enumerator.createCapturer(chosen, null) ?: return null
    camera.initialize(helper, appContext, source.capturerObserver)
    // 1280×720 @ 30. The encoder's degradation preference handles the
    // rest; picking a lower capture format here would put a ceiling the
    // adaptation cannot lift when conditions improve.
    camera.startCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT, CAPTURE_FPS)
    return camera
  }

  /**
   * The ONE way a capturer is stopped. `close()` and the abandoned-install
   * path must not be able to drift apart about what "stopped" means — a
   * synthetic capturer the teardown forgot is a hardware camera on the next
   * build that makes it real.
   */
  private fun stopCapturer(target: VideoCapturer?) {
    if (target == null) return
    try {
      target.stopCapture()
    } catch (interrupted: InterruptedException) {
      // `stopCapture` blocks on the camera thread and declares an interrupt.
      // Restore the flag and carry on with teardown: a half-torn-down camera
      // is worse than a late one.
      Thread.currentThread().interrupt()
    }
  }

  private fun applyVideoEncodingPreferences() {
    val sender =
        connection.senders.firstOrNull { it.track()?.kind() == MediaStreamTrack.VIDEO_TRACK_KIND }
            ?: return
    val params = sender.parameters ?: return
    // `BALANCED` drops resolution and frame rate together. `MAINTAIN_FRAMERATE`
    // looks markedly worse on a talking head, which is what these calls are.
    params.degradationPreference = RtpParameters.DegradationPreference.BALANCED
    for (encoding in params.encodings) {
      // A ceiling, not a target: congestion control still starts low and
      // ramps. 4.5 Mbps is sized for 720p30 with headroom for motion and low
      // light, and sits well under the relay's per-session bound, so a relayed
      // call is never clipped by its own encoder cap.
      encoding.maxBitrateBps = MAX_BITRATE_BPS
      encoding.minBitrateBps = MIN_BITRATE_BPS
    }
    sender.setParameters(params)
  }

  /**
   * Cap the encoder under thermal or battery pressure.
   *
   * `scaleResolutionDownBy` rather than restarting capture at a lower format:
   * a stop/start cycle drops roughly a second of video and would happen every
   * time the phone crossed a thermal boundary, which is exactly when it is
   * already struggling. Scaling is applied by the encoder on frames it
   * already has.
   */
  fun applyVideoCap(maxLongEdge: Int, maxFps: Int) {
    val sender =
        connection.senders.firstOrNull { it.track()?.kind() == MediaStreamTrack.VIDEO_TRACK_KIND }
            ?: return
    val params = sender.parameters ?: return
    val captureLongEdge = CAPTURE_WIDTH.toDouble()
    val scale =
        if (maxLongEdge <= 0) 1.0 else maxOf(1.0, captureLongEdge / maxLongEdge.toDouble())
    for (encoding in params.encodings) {
      // null, not 1.0, when uncapped: libwebrtc treats an explicit 1.0 as a
      // pinned request and stops adapting resolution downward on its own,
      // which would disable the network-driven degradation the design relies on.
      encoding.scaleResolutionDownBy = if (scale > 1.0) scale else null
      encoding.maxFramerate = if (maxFps > 0) maxFps else null
      // Bitrate follows resolution; leaving the full cap against 640×360 would
      // spend the saved pixels back on an unnecessarily high bitrate and heat
      // the radio instead of the encoder. The uncapped value must match
      // `applyVideoEncodingPreferences`, or lifting a cap would "restore" the
      // call to a different ceiling than it started with.
      encoding.maxBitrateBps = if (scale > 1.0) CAPPED_BITRATE_BPS else MAX_BITRATE_BPS
    }
    sender.setParameters(params)
  }

  /**
   * Enable or disable the local audio track, and SAY WHETHER IT HAPPENED.
   *
   * `audioTrack` is null until `addLocalMedia` has run, and a connection torn
   * down by a failure has none either — so "mute" against one of those
   * silences nothing and reports nothing, which for a microphone is the worst
   * shape a failure can take: the UI and the system call UI both say muted
   * while the track transmits. The verdict is what the group-call rule's
   * all-or-close-the-leg acts on: a leg that cannot be silenced is CLOSED
   * rather than left open behind a muted button.
   */
  fun setAudioEnabled(on: Boolean): Boolean {
    val track = synchronized(stateLock) { audioTrack } ?: return false
    track.setEnabled(on)
    return true
  }

  /** The camera's half of the same contract. */
  fun setVideoEnabled(on: Boolean): Boolean {
    val track = synchronized(stateLock) { videoTrack } ?: return false
    track.setEnabled(on)
    return true
  }

  fun switchCamera() {
    val camera = synchronized(stateLock) { capturer } as? CameraVideoCapturer ?: return
    camera.switchCamera(
        object : CameraVideoCapturer.CameraSwitchHandler {
          override fun onCameraSwitchDone(isFrontCamera: Boolean) {
            frontCamera = isFrontCamera
            // Re-announce so an attached preview re-reads its mirroring: a
            // back-camera preview must NOT be mirrored, and a stale hint
            // leaves the person looking at a reversed image of the room.
            val track = synchronized(stateLock) { videoTrack } ?: return
            VideoTrackRegistry.set(track, cid, VideoTrackRegistry.Role.LOCAL)
          }

          override fun onCameraSwitchError(error: String?) {
            // Nothing to say and nothing to log: the message is libwebrtc's
            // and can carry device detail. The camera stays where it was,
            // which is a working call.
          }
        }
    )
  }

  fun useSyntheticVideo(on: Boolean) {
    usingSyntheticVideo = on
  }

  fun useFingerprintFault(on: Boolean) {
    faultFingerprint = on
  }

  /**
   * Applied AFTER `SdpTrimmer.trim` and after `setLocalDescription`, so the
   * description libwebrtc holds is the honest one and only the SDP that
   * LEAVES this device carries the wrong fingerprint. That is what the server
   * would be able to do, and therefore what the no-MITM claim is about.
   */
  private fun faulted(sdp: String): String =
      if (BuildConfig.DEBUG && faultFingerprint) FingerprintFault.corrupt(sdp) else sdp

  // MARK: - negotiation

  /**
   * Whether `close()` has run. Every callback boundary in the negotiation
   * below is a place a close can land, so each one is followed by a look at
   * this.
   */
  val isClosed: Boolean
    get() = synchronized(stateLock) { closed }

  fun createOffer(withVideo: Boolean, iceRestart: Boolean, done: (String?, Throwable?) -> Unit) {
    // ABANDONED, not merely unsuccessful. The negotiation that reaches here
    // was started before the close arrived, and the call it is negotiating
    // for is over; the failure travels back as an ordinary `offer_failed`
    // rejection, which the reducer already treats as a call that could not be
    // placed.
    if (isClosed) return done(null, CallError.Closed())
    if (!iceRestart) addLocalMedia(withVideo)
    val constraints = MediaConstraints()
    if (iceRestart) {
      constraints.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
    }
    connection.createOffer(
        sdpObserver(
            onCreated = { desc ->
              if (isClosed) return@sdpObserver done(null, CallError.Closed())
              // Trim BEFORE setting the local description, so the description
              // libwebrtc holds is the one the peer received. Setting the
              // untrimmed one and sending the trimmed one would make the two
              // ends disagree about what was negotiated.
              val trimmed =
                  SessionDescription(SessionDescription.Type.OFFER, SdpTrimmer.trim(desc.description))
              connection.setLocalDescription(
                  sdpObserver(
                      onSet = {
                        if (isClosed) done(null, CallError.Closed())
                        else done(faulted(trimmed.description), null)
                      },
                      onFailed = { done(null, CallError.Negotiation()) },
                  ),
                  trimmed,
              )
            },
            onFailed = { done(null, CallError.Negotiation()) },
        ),
        constraints,
    )
  }

  fun createAnswer(remoteOfferSdp: String, withVideo: Boolean, done: (String?, Throwable?) -> Unit) {
    if (isClosed) return done(null, CallError.Closed())
    addLocalMedia(withVideo)
    connection.setRemoteDescription(
        sdpObserver(
            onSet = {
              if (isClosed) return@sdpObserver done(null, CallError.Closed())
              drainPendingCandidates()
              if (isClosed) return@sdpObserver done(null, CallError.Closed())
              connection.createAnswer(
                  sdpObserver(
                      onCreated = { desc ->
                        if (isClosed) return@sdpObserver done(null, CallError.Closed())
                        val trimmed =
                            SessionDescription(
                                SessionDescription.Type.ANSWER,
                                SdpTrimmer.trim(desc.description),
                            )
                        connection.setLocalDescription(
                            sdpObserver(
                                onSet = {
                                  if (isClosed) done(null, CallError.Closed())
                                  else done(faulted(trimmed.description), null)
                                },
                                onFailed = { done(null, CallError.Negotiation()) },
                            ),
                            trimmed,
                        )
                      },
                      onFailed = { done(null, CallError.Negotiation()) },
                  ),
                  MediaConstraints(),
              )
            },
            onFailed = { done(null, CallError.Negotiation()) },
        ),
        SessionDescription(SessionDescription.Type.OFFER, remoteOfferSdp),
    )
  }

  fun setRemoteAnswer(sdp: String, done: (Throwable?) -> Unit) {
    connection.setRemoteDescription(
        sdpObserver(
            onSet = {
              drainPendingCandidates()
              done(null)
            },
            onFailed = { done(CallError.Negotiation()) },
        ),
        SessionDescription(SessionDescription.Type.ANSWER, sdp),
    )
  }

  fun addRemoteCandidates(candidates: List<IceCandidate>) {
    val ready = ArrayList<IceCandidate>()
    synchronized(stateLock) {
      for (candidate in candidates) {
        if (remoteDescriptionSet) {
          ready.add(candidate)
        } else {
          // Buffered rather than dropped: candidates routinely arrive before
          // the answer is applied, and each one is a path the call might need.
          pendingRemoteCandidates.add(candidate)
        }
      }
    }
    for (candidate in ready) connection.addIceCandidate(candidate)
  }

  /**
   * Mark the remote description applied and take the buffer, as ONE step.
   *
   * Split from the drain below so the flag flip and the hand-off cannot be
   * interleaved: setting the flag first and emptying the buffer second leaves
   * a window in which a concurrent `addRemoteCandidates` sees
   * `remoteDescriptionSet == true`, adds its candidates directly, and the
   * drain then re-adds the ones already queued.
   */
  private fun takePendingCandidates(): List<IceCandidate> =
      synchronized(stateLock) {
        remoteDescriptionSet = true
        val queued = ArrayList(pendingRemoteCandidates)
        pendingRemoteCandidates.clear()
        queued
      }

  private fun drainPendingCandidates() {
    for (candidate in takePendingCandidates()) connection.addIceCandidate(candidate)
  }

  // MARK: - stats

  /**
   * 0–3 bars for the local quality indicator.
   *
   * Reduced to a single integer HERE rather than in JS, and that is the point:
   * `statsJson` below is already stripped of candidate addresses, but the
   * safest version of "getStats never leaves the device" is one where no stats
   * payload crosses the bridge at all. An Int cannot leak an IP.
   *
   * Measured over the LAST interval, not the call's lifetime. Cumulative loss
   * would mean a call that was bad for ten seconds and has been fine since
   * still shows one bar, which is a claim about the present that is false.
   */
  fun sampleQuality(done: (Int) -> Unit) {
    connection.getStats { report ->
      var lost = 0.0
      var received = 0.0
      var jitter = 0.0
      for (stat in report.statsMap.values) {
        if (stat.type != "inbound-rtp") continue
        lost += numberOf(stat.members["packetsLost"])
        received += numberOf(stat.members["packetsReceived"])
        jitter = maxOf(jitter, numberOf(stat.members["jitter"]))
      }

      val deltaLost: Double
      val deltaReceived: Double
      synchronized(stateLock) {
        deltaLost = maxOf(0.0, lost - lastPacketsLost)
        deltaReceived = maxOf(0.0, received - lastPacketsReceived)
        lastPacketsLost = lost
        lastPacketsReceived = received
      }

      // Nothing arrived in this window — the usual reason is that the call has
      // only just connected. Three bars rather than one: an indicator that
      // opens on "poor" and climbs is worse than no indicator, because the
      // person reads the first frame and decides the call is bad.
      val total = deltaLost + deltaReceived
      if (total <= 0.0) return@getStats done(3)

      val loss = deltaLost / total
      // Jitter is seconds. 100 ms is where a conversation starts to break up;
      // 50 ms is where it starts to be noticeable.
      if (loss > 0.08 || jitter > 0.1) return@getStats done(1)
      if (loss > 0.02 || jitter > 0.05) return@getStats done(2)
      done(3)
    }
  }

  fun statsJson(done: (String) -> Unit) {
    connection.getStats { report ->
      // Deliberately reduced to the few numbers a quality indicator needs.
      // A full report contains candidate addresses — the other person's IP —
      // and the module contract forbids that value reaching an envelope or a log line.
      val out = JSONObject()
      val stats = report.statsMap
      for (stat in stats.values) {
        if (stat.type != "inbound-rtp" && stat.type != "outbound-rtp") continue
        for (key in
            listOf("packetsLost", "jitter", "bytesReceived", "bytesSent", "framesPerSecond")) {
          val value = stat.members[key] ?: continue
          out.put("${stat.type}.$key", value)
        }
        // THE NEGOTIATED CODEC, and nothing else about it. A codec name is not
        // an address and not an identity; it is the one field the emulator
        // loopback leg can capture to prove media actually negotiated, and
        // The contract asks for exactly that — present and non-empty, with NO
        // codec-identity assertion on the emulator, because emulator codecs
        // are software and a VP8 result there says nothing about H.264 on real
        // hardware. That row is physical-device matrix work.
        val codecId = stat.members["codecId"] as? String ?: continue
        val mime = stats[codecId]?.members?.get("mimeType") as? String ?: continue
        out.put("${stat.type}.codec", mime)
      }
      done(out.toString())
    }
  }

  private fun numberOf(value: Any?): Double =
      when (value) {
        is Number -> value.toDouble()
        else -> 0.0
      }

  /**
   * Stop everything and mark this connection over.
   *
   * The flag is raised FIRST and under the lock, before a single resource is
   * released: a negotiation callback resumes on another thread, and the window
   * this method is closing is precisely the one between "close has begun" and
   * "close has finished". Raising it afterwards would leave `addLocalMedia`
   * free to open the microphone during the teardown.
   *
   * Idempotent, because it is reached from three places that do not
   * coordinate with each other: the bridge's `close`, the module's tombstone
   * check, and the coordinator's own disposal one layer up.
   */
  fun close() {
    // The capturer is CLAIMED in the same critical section that raises the
    // flag: `addLocalMedia` installs it under this lock, so reading it
    // afterwards would reopen by one line the gap this pairing exists to
    // close. Whoever takes the lock second sees the other's decision.
    var alreadyClosed = false
    var doomedCapturer: VideoCapturer? = null
    var doomedHelper: SurfaceTextureHelper? = null
    var doomedSource: VideoSource? = null
    var doomedAudioSource: org.webrtc.AudioSource? = null
    synchronized(stateLock) {
      alreadyClosed = closed
      closed = true
      doomedCapturer = capturer
      doomedHelper = surfaceHelper
      doomedSource = videoSource
      doomedAudioSource = audioSource
      capturer = null
      surfaceHelper = null
      videoSource = null
      audioSource = null
    }
    if (alreadyClosed) return

    stopCapturer(doomedCapturer)
    doomedCapturer?.dispose()
    doomedHelper?.dispose()
    // Before the connection closes: a view still holding a track would keep a
    // dead call's last frame on screen, and keep the track itself alive.
    VideoTrackRegistry.clear(cid)
    connection.close()
    // AFTER the connection: a source disposed while the peer connection still
    // references it is a native crash, not a leak.
    doomedSource?.dispose()
    doomedAudioSource?.dispose()
  }

  // MARK: - observers

  /**
   * `SdpObserver` is a four-method interface and every use here needs two of
   * them, so this adapter keeps the negotiation above readable.
   *
   * **The failure string is discarded, on purpose.** libwebrtc's error text
   * can contain an SDP or a candidate — which is to say the other person's IP
   * — and the module contract forbids that value reaching a log line or an envelope. The
   * caller learns THAT the step failed, which is what it acts on; the text
   * that would tell it why is exactly the text that must not travel.
   */
  private fun sdpObserver(
      onCreated: (SessionDescription) -> Unit = {},
      onSet: () -> Unit = {},
      onFailed: () -> Unit,
  ): SdpObserver =
      object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = onCreated(description)

        override fun onSetSuccess() = onSet()

        override fun onCreateFailure(error: String?) = onFailed()

        override fun onSetFailure(error: String?) = onFailed()
      }

  private inner class Observer : PeerConnection.Observer {
    override fun onIceCandidate(candidate: IceCandidate) {
      events.iceCandidate(
          cid = cid,
          sdp = candidate.sdp,
          mid = candidate.sdpMid ?: "",
          index = candidate.sdpMLineIndex,
      )
    }

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
      events.iceState(cid, iceStateName(state))
    }

    override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
      events.connectionState(cid, connectionStateName(state))
    }

    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
      val track = receiver.track() ?: return
      // The track was previously read for its `kind` and dropped on the floor,
      // so the far end's video arrived, was decoded, and had nowhere to go.
      // Holding it here is what lets a view render it.
      if (track is VideoTrack) {
        VideoTrackRegistry.set(track, cid, VideoTrackRegistry.Role.REMOTE)
      }
      events.remoteTrack(cid, track.kind(), true)
    }

    override fun onRemoveTrack(receiver: RtpReceiver) {
      val track = receiver.track() ?: return
      if (track is VideoTrack) {
        VideoTrackRegistry.set(null, cid, VideoTrackRegistry.Role.REMOTE)
      }
      events.remoteTrack(cid, track.kind(), false)
    }

    // Unified-plan requires these to exist; none of them carries a decision.
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit

    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

    override fun onAddStream(stream: MediaStream) = Unit

    override fun onRemoveStream(stream: MediaStream) = Unit

    override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit

    override fun onRenegotiationNeeded() = Unit
  }

  companion object {
    const val CAPTURE_WIDTH = 1280
    const val CAPTURE_HEIGHT = 720
    const val CAPTURE_FPS = 30
    const val MAX_BITRATE_BPS = 4_500_000
    const val MIN_BITRATE_BPS = 150_000
    const val CAPPED_BITRATE_BPS = 600_000

    fun iceStateName(state: PeerConnection.IceConnectionState): String =
        when (state) {
          PeerConnection.IceConnectionState.NEW -> "new"
          PeerConnection.IceConnectionState.CHECKING -> "checking"
          PeerConnection.IceConnectionState.CONNECTED -> "connected"
          PeerConnection.IceConnectionState.COMPLETED -> "completed"
          PeerConnection.IceConnectionState.FAILED -> "failed"
          PeerConnection.IceConnectionState.DISCONNECTED -> "disconnected"
          PeerConnection.IceConnectionState.CLOSED -> "closed"
        }

    fun connectionStateName(state: PeerConnection.PeerConnectionState): String =
        when (state) {
          PeerConnection.PeerConnectionState.NEW -> "new"
          PeerConnection.PeerConnectionState.CONNECTING -> "connecting"
          PeerConnection.PeerConnectionState.CONNECTED -> "connected"
          PeerConnection.PeerConnectionState.DISCONNECTED -> "disconnected"
          PeerConnection.PeerConnectionState.FAILED -> "failed"
          PeerConnection.PeerConnectionState.CLOSED -> "closed"
        }
  }
}

/**
 * What went wrong, as a TYPE rather than a message.
 *
 * The messages that cross to JS are constants chosen by the module; these
 * exist so the module can tell "the call was closed underneath this" from
 * "libwebrtc refused the step", which are different rejections with different
 * meanings above the bridge.
 */
internal sealed class CallError(message: String) : Exception(message) {
  class PeerConnectionFailed : CallError("peer connection failed")

  class NotConfigured : CallError("not configured")

  class Negotiation : CallError("negotiation failed")

  /**
   * The cid was closed while its connection was still being built. Not a
   * failure of the negotiation — the negotiation was overtaken.
   */
  class Closed : CallError("closed")
}

/**
 * What the peer connection reports upward. Implemented by the module facade;
 * declared here so this file depends on nothing above it.
 */
internal interface CallEventSink {
  fun iceCandidate(cid: String, sdp: String, mid: String, index: Int)

  fun iceState(cid: String, state: String)

  fun connectionState(cid: String, state: String)

  fun remoteTrack(cid: String, kind: String, added: Boolean)
}
