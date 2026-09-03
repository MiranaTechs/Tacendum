package com.miranatechnologies.tacendum.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoEncoder
import org.webrtc.VideoEncoderFactory
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * The calling module's Kotlin half — the
 * twin of `ios/TacendumCallImpl.swift`.
 *
 * A facade: it owns the peer-connection factory, one `CallPeerConnection` per
 * live call, and the wiring that turns native callbacks into JS events. It
 * holds no protocol state — no notion of ringing, no timers, no decisions
 * about when a call is over. That all lives in the reducer, above the bridge,
 * and this port does not touch it.
 *
 * **Rejection messages carry no cid and no interpolated error text.** A cid is
 * never logged and never a metric dimension; interpolating a libwebrtc error
 * is worse still, because those strings can contain an SDP or a candidate
 * address, which is the peer's IP. The error CODE is what a caller acts on.
 */
class TacendumCallModule(private val reactContext: ReactApplicationContext) :
    NativeTacendumCallSpec(reactContext), CallEventSink, TelecomCenter.EventSink {

  private var factory: PeerConnectionFactory? = null
  private var configuration: PeerConnection.RTCConfiguration? = null
  private val calls = HashMap<String, CallPeerConnection>()
  private val lock = Any()
  private var syntheticVideo = false
  private var fingerprintFault = false

  /** Events raised before JS was listening. See `PendingEventBuffer`. */
  private val buffer = PendingEventBuffer()

  private var pressure: PressureMonitor? = null

  /**
   * Negotiation runs here, never on the JS thread.
   *
   * ONE thread, so two negotiations for the same cid cannot interleave their
   * installs — the Swift side gets the same property from an unstructured
   * `Task` per call plus the tombstone below, and a pool here would give up
   * the ordering for a concurrency this module has no use for.
   */
  private val negotiation = Executors.newSingleThreadExecutor { Thread(it, "tacendum-call") }

  init {
    TelecomCenter.events = this
    // The register verdict is CHECKED, not
    // discarded — recorded into TelecomGuard, which every Telecom report path
    // consults before touching the platform, so a telecom-less device
    // (WiFi-only tablets are the known class) refuses calls at once with the
    // honest refusal verdict instead of dying inside addNewIncomingCall or
    // placeCall with nothing to say. Messaging never reads the verdict. JS
    // reads it back through the telecomAvailable surface once the JS half
    // lands its TurboModule contract method; until then the guard is
    // behavior-only.
    TelecomGuard.recordVerdict(TelecomCenter.register(reactContext.applicationContext))
    CallNotifications.ensureChannels(reactContext.applicationContext)
    CallAudioGate.attach(
        reactContext.applicationContext,
        { synchronized(lock) { calls.values.toList() } },
        { event, json -> send(event, json) },
    )
    // The ONE token feeds BOTH events, from the one place that hears
    // about it. `TacendumFcmService.onNewToken` adopts into the store; this
    // listener is how a rotation reaches JS while it is alive — through
    // `send`, so a token arriving before JS listens waits in the pre-JS
    // buffer with everything else. When JS is dead entirely, the store's
    // persistence is the delivery: the next boot's `adoptPushRegistration`
    // reads it back through `getVoipToken`, which is exactly how iOS re-reads
    // PushKit's cache. The event shapes mirror the Swift emitters: the VoIP
    // event is the raw token string, the alert event wraps it in `{token}`.
    PushTokenStore.install { token ->
      send("voipTokenUpdated", token)
      send("alertTokenUpdated", JSONObject().put("token", token).toString())
    }
  }

  override fun invalidate() {
    // A Metro reload or a catalyst teardown: the JS half is going away, so go
    // back to buffering rather than emitting into a destroyed runtime, and let
    // go of the monitors. The CALLS are deliberately left alone — Telecom
    // still holds them, and tearing down live media because JS reloaded is a
    // dropped call in exchange for tidiness.
    buffer.suspend()
    // The token listener goes with the module — IdleObserver's rule: a slot,
    // uninstalled on teardown, so a rotation cannot poke a dead module. The
    // token itself is persisted either way; the next module (or the next
    // boot) reads it back.
    PushTokenStore.install(null)
    pressure?.stop()
    pressure = null
    // The proximity lock is derived from the live calls, which are left
    // alone above — but a lock nobody can recompute is a lock that could
    // outlive its reason, so it goes with the module and the next one
    // re-derives it from the calls Telecom still holds.
    ProximityGuard.release()
    super.invalidate()
  }

  // MARK: - factory

  private fun ensureFactory(): PeerConnectionFactory {
    factory?.let {
      return it
    }
    PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(reactContext.applicationContext)
            .createInitializationOptions()
    )
    // MANUAL AUDIO FROM THE VERY FIRST MOMENT. If the audio unit could
    // start on libwebrtc's own timing even once, the Telecom handshake in
    // `CallAudioGate` would be advisory rather than authoritative — armed here,
    // before a factory exists, so no peer connection can ever be built without
    // it.
    CallAudioGate.useManualAudio = true

    val encoder =
        RankedVideoEncoderFactory(
            org.webrtc.DefaultVideoEncoderFactory(CallEgl.context, true, true)
        )
    val decoder = org.webrtc.DefaultVideoDecoderFactory(CallEgl.context)
    val audioModule =
        JavaAudioDeviceModule.builder(reactContext.applicationContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
    val built =
        PeerConnectionFactory.builder()
            .setOptions(PeerConnectionFactory.Options())
            .setVideoEncoderFactory(encoder)
            .setVideoDecoderFactory(decoder)
            .setAudioDeviceModule(audioModule)
            .createPeerConnectionFactory()
    factory = built
    return built
  }

  /**
   * H.264 first, VP8 second, everything else after.
   *
   * The ORDER of `getSupportedCodecs` is the order that reaches the SDP, which
   * is the codec preference the peer reads — the Android analogue of setting
   * `RTCDefaultVideoEncoderFactory.preferredCodec` on iOS. Wrapping rather
   * than replacing the default factory: the encoders themselves are the
   * platform's, and this only re-sorts the list it publishes.
   */
  private class RankedVideoEncoderFactory(private val inner: VideoEncoderFactory) :
      VideoEncoderFactory {
    override fun createEncoder(info: VideoCodecInfo?): VideoEncoder? = inner.createEncoder(info)

    override fun getSupportedCodecs(): Array<VideoCodecInfo> =
        inner.supportedCodecs.sortedBy { rank(it.name) }.toTypedArray()

    private fun rank(name: String): Int =
        when (name.lowercase()) {
          "h264" -> 0
          "vp8" -> 1
          else -> 2
        }
  }

  // MARK: - configuration

  override fun configure(iceServersJson: String, relayOnly: Boolean, promise: Promise) {
    val servers = ArrayList<PeerConnection.IceServer>()
    try {
      val parsed = JSONArray(iceServersJson)
      for (i in 0 until parsed.length()) {
        val entry = parsed.optJSONObject(i) ?: continue
        val urls = entry.optJSONArray("urls") ?: continue
        val list = (0 until urls.length()).mapNotNull { urls.optString(it).ifEmpty { null } }
        if (list.isEmpty()) continue
        val builder = PeerConnection.IceServer.builder(list)
        val username = entry.optString("username", "")
        val credential = entry.optString("credential", "")
        if (username.isNotEmpty() && credential.isNotEmpty()) {
          builder.setUsername(username).setPassword(credential)
        }
        servers.add(builder.createIceServer())
      }
    } catch (malformed: Exception) {
      promise.reject("bad_ice_servers", "ice server list is not valid JSON")
      return
    }

    val config = PeerConnection.RTCConfiguration(servers)
    config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
    config.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
    config.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
    config.continualGatheringPolicy =
        PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
    // Always-relay: with RELAY no host candidate is ever offered, so the
    // peer never learns this device's IP address. It costs a relay hop for
    // every call and that is the trade the setting exists to make.
    config.iceTransportsType =
        if (relayOnly) PeerConnection.IceTransportsType.RELAY
        else PeerConnection.IceTransportsType.ALL
    synchronized(lock) { configuration = config }
    promise.resolve(null)
  }

  private fun call(cid: String): CallPeerConnection? = synchronized(lock) { calls[cid] }

  // MARK: - the tombstone (cids closed while their connection was being built)

  /**
   * `createOffer` and `createAnswer` return the instant they are called and do
   * their work on the negotiation thread; the connection is installed only when
   * that work runs. A `close(cid)` arriving in between — which is exactly what
   * the JS coordinator's disposal does on a relock, for every leg it can name —
   * scans a map the connection is not in yet, closes nothing, and resolves. The
   * negotiation then installs a LIVE peer connection: a microphone that
   * survived the very relock that was meant to end it, held by an object
   * nothing above the bridge still has a handle to.
   *
   * The scan cannot be made to cover a connection that does not exist, so the
   * close leaves a MARK and the install looks for it.
   *
   * BOUNDED BY LIVENESS, NEVER BY COUNT ALONE. A cid is a fresh ULID per call,
   * per re-offer and per leg; none is ever reused, so there is no moment at
   * which forgetting one would be correct — but a set that grows for the life
   * of the process is not acceptable either. A plain FIFO trim at 256 has no
   * mechanism behind it: a negotiation can be starved arbitrarily long, and a
   * device that places 256 calls while ONE is stalled evicts that one's
   * tombstone and restores the exact race, with a live microphone as the prize.
   * So a tombstone is evicted only once nothing can still install under it.
   */
  private val closedCids = HashSet<String>()
  private val closedCidOrder = ArrayList<String>()

  /**
   * Cids whose negotiation has been issued and has not finished.
   *
   * Marked SYNCHRONOUSLY at the bridge method, before the work is queued, and
   * released when it finishes. Not inside the install, which is exactly too
   * late: the whole race is the window in which the work has not been
   * scheduled yet.
   *
   * A count rather than a flag: `createAnswer` can follow `createOffer` on one
   * cid (an ICE restart reuses the connection), and one finishing must not
   * declare the other's cid quiescent.
   */
  private val inFlightCids = HashMap<String, Int>()

  private fun beginNegotiation(cid: String) {
    synchronized(lock) { inFlightCids[cid] = (inFlightCids[cid] ?: 0) + 1 }
  }

  private fun endNegotiation(cid: String) {
    synchronized(lock) {
      val remaining = (inFlightCids[cid] ?: 1) - 1
      if (remaining <= 0) {
        inFlightCids.remove(cid)
        // The cid may have been held past the trim target purely because it
        // was in flight; now that it is not, the deferred eviction happens.
        trimClosedLocked()
      } else {
        inFlightCids[cid] = remaining
      }
    }
  }

  /** Caller holds `lock`. */
  private fun markClosedLocked(cid: String) {
    if (!closedCids.add(cid)) return
    closedCidOrder.add(cid)
    trimClosedLocked()
  }

  /** Caller holds `lock`. Drops the oldest, SKIPPING anything still in flight. */
  private fun trimClosedLocked() {
    if (closedCidOrder.size <= MAX_CLOSED_CIDS) return
    var over = closedCidOrder.size - MAX_CLOSED_CIDS
    val kept = ArrayList<String>(closedCidOrder.size)
    for (cid in closedCidOrder) {
      if (over > 0 && inFlightCids[cid] == null) {
        closedCids.remove(cid)
        over -= 1
        continue
      }
      kept.add(cid)
    }
    closedCidOrder.clear()
    closedCidOrder.addAll(kept)
  }

  private fun makeCall(cid: String): CallPeerConnection {
    val config = synchronized(lock) { configuration } ?: throw CallError.NotConfigured()
    // Refused before the connection is built when the close already landed:
    // constructing one only to throw it away would still have taken the
    // microphone for as long as it took to notice.
    if (synchronized(lock) { closedCids.contains(cid) }) throw CallError.Closed()

    val pc =
        CallPeerConnection(
            cid = cid,
            appContext = reactContext.applicationContext,
            factory = ensureFactory(),
            config = config,
            eglBase = CallEgl.base,
            events = this,
            manualAudio = CallAudioGate.useManualAudio,
            audioEnabledNow = CallAudioGate.isActive(),
        )
    if (BuildConfig.DEBUG) {
      pc.useSyntheticVideo(syntheticVideo)
      pc.useFingerprintFault(fingerprintFault)
    }
    val refused =
        synchronized(lock) {
          // THE SECOND LOOK, under the same lock that performs the install.
          // The check above is an optimisation; this one is the correctness
          // argument. A close landing between them would otherwise be
          // overwritten by the very assignment it was racing.
          if (closedCids.contains(cid)) {
            true
          } else {
            calls[cid] = pc
            false
          }
        }
    if (refused) {
      pc.close()
      throw CallError.Closed()
    }
    refreshCallPresence()
    return pc
  }

  /**
   * KEEP THE SCREEN AWAKE, AND HOLD THE FOREGROUND SERVICE, WHILE A CALL IS
   * LIVE — both DERIVED from `calls` rather than set by whoever starts or ends
   * one.
   *
   * `FLAG_KEEP_SCREEN_ON` is window state and it is the kind that leaks: a
   * path that raises it and returns early leaves the display permanently awake
   * for the rest of the app's life. Recomputing from the live set means the
   * last connection to be removed always restores the system default, whether
   * it left through hangup, failure or teardown. Android dims and locks on its
   * ordinary inactivity timer no matter what the app is doing, and Telecom
   * does not change that — so a video call goes dark mid-conversation, camera
   * still up, the other person's face replaced by a locked screen, and the way
   * back is to unlock the phone, which is the one thing you cannot do while
   * holding it up to be seen.
   *
   * THE SET IS READ ON THE UI THREAD, not before the hop to it. Reading first
   * would let two refreshes sample in one order and apply in the other: an
   * install reads "live", a close reads and applies "not live", and the
   * install's stale "live" lands last and strands the display awake.
   */
  private fun refreshCallPresence() {
    val context = reactContext.applicationContext
    // The proximity lock is derived from the same live set, at the same
    // moments — an install, a close — plus the negotiation that births the
    // video track it reads.
    CallAudioGate.refreshProximity()
    reactContext.runOnUiQueueThread {
      val live: Boolean
      val anyVideo: Boolean
      synchronized(lock) {
        live = calls.isNotEmpty()
        // Derived here too, and for the same reason the flag is: the service's
        // declared types must describe every live call, not the one that
        // happened to change last.
        anyVideo = calls.values.any { it.usesVideo }
      }
      val window = reactContext.currentActivity?.window
      if (live) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      if (live) CallForegroundService.start(context, anyVideo, "Call in progress")
      else CallForegroundService.stop(context)
    }
  }

  // MARK: - negotiation

  override fun createOffer(cid: String, withVideo: Boolean, promise: Promise) {
    // Before the work is queued, never inside it: see `inFlightCids`.
    beginNegotiation(cid)
    negotiation.execute {
      try {
        val pc = makeCall(cid)
        pc.createOffer(withVideo, false) { sdp, error ->
          endNegotiation(cid)
          // The local tracks were born inside the call above; the proximity
          // rule's video input can only be read now.
          CallAudioGate.refreshProximity()
          if (sdp != null) promise.resolve(sdp)
          else promise.reject("offer_failed", "could not create an offer")
        }
      } catch (failure: Throwable) {
        endNegotiation(cid)
        promise.reject("offer_failed", "could not create an offer")
      }
    }
  }

  override fun createAnswer(
      cid: String,
      remoteOfferSdp: String,
      withVideo: Boolean,
      promise: Promise,
  ) {
    beginNegotiation(cid)
    negotiation.execute {
      try {
        // The offer may already have a peer connection if a restart arrived;
        // reuse it so the ICE credentials continue rather than reset.
        val pc = call(cid) ?: makeCall(cid)
        pc.createAnswer(remoteOfferSdp, withVideo) { sdp, error ->
          endNegotiation(cid)
          CallAudioGate.refreshProximity()
          if (sdp != null) promise.resolve(sdp)
          else promise.reject("answer_failed", "could not create an answer")
        }
      } catch (failure: Throwable) {
        endNegotiation(cid)
        promise.reject("answer_failed", "could not create an answer")
      }
    }
  }

  override fun setRemoteAnswer(cid: String, sdp: String, promise: Promise) {
    val pc = call(cid)
    if (pc == null) {
      promise.reject("no_such_call", "no such call")
      return
    }
    negotiation.execute {
      pc.setRemoteAnswer(sdp) { error ->
        if (error == null) promise.resolve(null)
        else promise.reject("set_answer_failed", "could not apply the answer")
      }
    }
  }

  override fun addIceCandidates(cid: String, candidatesJson: String, promise: Promise) {
    val candidates = ArrayList<IceCandidate>()
    try {
      val parsed = JSONArray(candidatesJson)
      for (i in 0 until parsed.length()) {
        val entry = parsed.optJSONObject(i) ?: continue
        val sdp = entry.optString("cand", "")
        if (sdp.isEmpty()) continue
        candidates.add(IceCandidate(entry.optString("mid", ""), entry.optInt("idx", 0), sdp))
      }
    } catch (malformed: Exception) {
      promise.reject("bad_candidates", "candidate list is not valid JSON")
      return
    }
    val pc = call(cid)
    if (pc == null) {
      // Not an error: candidates for a call that has already ended are
      // ordinary, and redelivery makes them common.
      promise.resolve(null)
      return
    }
    negotiation.execute {
      try {
        pc.addRemoteCandidates(candidates)
        promise.resolve(null)
      } catch (failure: Throwable) {
        promise.reject("add_candidates_failed", "could not add candidates")
      }
    }
  }

  override fun restartIce(cid: String, promise: Promise) {
    val pc = call(cid)
    if (pc == null) {
      promise.reject("no_such_call", "no such call")
      return
    }
    beginNegotiation(cid)
    negotiation.execute {
      pc.createOffer(false, true) { sdp, error ->
        endNegotiation(cid)
        if (sdp != null) promise.resolve(sdp)
        else promise.reject("restart_failed", "could not restart ICE")
      }
    }
  }

  override fun close(cid: String, promise: Promise) {
    val pc =
        synchronized(lock) {
          // The tombstone is laid FIRST and under the same lock as the
          // removal, so a `makeCall` racing this cannot slip an install
          // between the two. Unconditional: the whole point is the case where
          // `calls` has no entry yet because the negotiation has not reached
          // its install.
          markClosedLocked(cid)
          calls.remove(cid)
        }
    pc?.close()
    // AFTER the removal, and unconditional: this is the half that gives the
    // display back and drops the foreground service. A close for a cid that
    // was never installed still recomputes, which costs nothing and is what
    // makes the flag impossible to strand raised.
    refreshCallPresence()
    promise.resolve(null)
  }

  // MARK: - media control

  override fun setAudioEnabled(cid: String, on: Boolean, promise: Promise) {
    // THE APPLIED VERDICT: `false` means nothing was applied — no connection
    // for that cid, or no track on it — which is what the group-call rule's
    // all-or-close-the-leg acts on. A leg the microphone cannot be silenced
    // toward is closed rather than left open behind a muted button.
    promise.resolve(call(cid)?.setAudioEnabled(on) ?: false)
  }

  override fun setVideoEnabled(cid: String, on: Boolean, promise: Promise) {
    promise.resolve(call(cid)?.setVideoEnabled(on) ?: false)
  }

  override fun switchCamera(cid: String, promise: Promise) {
    call(cid)?.switchCamera()
    promise.resolve(null)
  }

  override fun setSpeaker(cid: String, on: Boolean, promise: Promise) {
    // The cid is ignored, as on iOS: there is one audio route per DEVICE.
    TelecomCenter.setSpeaker(on)
    promise.resolve(null)
  }

  override fun getStats(cid: String, promise: Promise) {
    val pc = call(cid)
    if (pc == null) {
      promise.resolve("{}")
      return
    }
    pc.statsJson { json -> promise.resolve(json) }
  }

  override fun applyVideoCap(cid: String, maxLongEdge: Double, maxFps: Double, promise: Promise) {
    // Not an error: a cap arriving for a call that has ended is ordinary.
    call(cid)?.applyVideoCap(maxLongEdge.toInt(), maxFps.toInt())
    promise.resolve(null)
  }

  override fun sampleQuality(cid: String, promise: Promise) {
    val pc = call(cid)
    if (pc == null) {
      // 3 when there is no such call, so a sample racing a hangup cannot
      // paint the last frame "poor".
      promise.resolve(3.0)
      return
    }
    pc.sampleQuality { bars -> promise.resolve(bars.toDouble()) }
  }

  // MARK: - Telecom

  override fun reportOutgoingCall(cid: String, handle: String, video: Boolean, promise: Promise) {
    if (TelecomCenter.reportOutgoingCall(cid, handle, video)) promise.resolve(null)
    else promise.reject("report_failed", "notification/Connection creation failed")
  }

  override fun reportOutgoingConnected(cid: String, promise: Promise) {
    TelecomCenter.reportOutgoingConnected(cid)
    promise.resolve(null)
  }

  override fun reportIncomingCall(
      cid: String,
      peerId: String,
      handle: String,
      displayName: String,
      hasVideo: Boolean,
      promise: Promise,
  ) {
    TelecomCenter.reportIncomingCall(cid, peerId, handle, displayName, hasVideo) { refusal ->
      if (refusal == null) promise.resolve(null)
      else promise.reject("report_failed", "notification/Connection creation failed")
    }
  }

  override fun updateIncomingCallDisplay(cid: String, displayName: String, promise: Promise) {
    TelecomCenter.updateDisplay(cid, displayName)
    promise.resolve(null)
  }

  override fun dismissPendingIncomingCall(
      peerId: String,
      reason: String,
      cid: String,
      promise: Promise,
  ) {
    TelecomCenter.dismissPendingIncomingCall(peerId, reason, cid)
    promise.resolve(null)
  }

  override fun endCall(cid: String, reason: String, promise: Promise) {
    TelecomCenter.endCall(cid, reason)
    promise.resolve(null)
  }

  /** An in-app answer for a call reported under `cid` (a session's sid) —
   * see `TelecomCenter.answerFromApp`. Never rejects. */
  override fun answerReportedCall(cid: String, promise: Promise) {
    TelecomCenter.answerFromApp(cid)
    promise.resolve(null)
  }

  // MARK: - missed calls

  override fun postMissedCall(peerId: String, displayName: String, promise: Promise) {
    // Never rejects: a refused post costs the notice, never the row or the
    // call — the same rule `setBadgeCount` keeps.
    MissedCallNotification.post(reactContext.applicationContext, peerId, displayName)
    promise.resolve(null)
  }

  override fun clearMissedCall(peerId: String, promise: Promise) {
    MissedCallNotification.clear(reactContext.applicationContext, peerId)
    promise.resolve(null)
  }

  // MARK: - push surface

  /**
   * BOTH getters answer with the ONE persisted FCM token: Android
   * has a single wake token, and returning it from both surfaces is what
   * keeps the JS launch machinery — `uploadPushTokens`, the
   * `pushRegistrationAdopted` latch, the alert retry — byte-identical to iOS.
   * In a build without Firebase wired (no `google-services.json` at build
   * time — `TacendumFcmService` is not even compiled then) nothing ever
   * adopts a token, so this is `''` forever: the pre-FCM truth, told by
   * the same absence-as-`''` convention rather than by a rejection the boot
   * path would read as an error.
   */
  override fun getVoipToken(promise: Promise) =
      promise.resolve(PushTokenStore.current(reactContext.applicationContext))

  /**
   * A no-op, unlike iOS where this sets PushKit's `desiredPushTypes` and the
   * cached credentials answer back immediately. Firebase issues the token on
   * its own schedule — generated at first launch of a wired build, rotated
   * when Google decides — and every issuance lands in
   * `TacendumFcmService.onNewToken` whether or not anyone asked, so there is
   * nothing here to request. The launch-time read happens in JS instead:
   * `adoptPushRegistration` calls `uploadPushTokens`, which reads the
   * persisted token through the getters above.
   */
  override fun registerForVoipPush(promise: Promise) = promise.resolve(null)

  override fun getAlertToken(promise: Promise) =
      promise.resolve(PushTokenStore.current(reactContext.applicationContext))

  override fun requestNotificationPermission(promise: Promise) {
    val context = reactContext.applicationContext
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      // Before 33 there is no permission to ask for; the answer is whether
      // the person has switched notifications off in Settings.
      promise.resolve(
          if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted"
          else "denied"
      )
      return
    }
    if (hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      promise.resolve("granted")
      return
    }
    requestRuntimePermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) {
      // Refusal is an answer, not an error.
      promise.resolve(
          if (hasPermission(Manifest.permission.POST_NOTIFICATIONS)) "granted" else "denied"
      )
    }
  }

  override fun setBadgeCount(count: Double, promise: Promise) {
    // Never rejects. A badge is decoration; a failure to draw one must
    // not become an error on a path that is otherwise about delivering
    // messages.
    CallNotifications.setBadgeCount(count.toInt())
    promise.resolve(null)
  }

  /**
   * This binary's application id.
   *
   * Read from the running context rather than hardcoded, for the reason the
   * Swift file gives about `Bundle.main`: this value is sent to the server
   * with every push registration, and the one thing it must never be is a
   * stale copy of what the id used to be.
   */
  override fun bundleId(promise: Promise) = promise.resolve(reactContext.packageName)

  // MARK: - pressure

  override fun startMonitoringPressure(promise: Promise) {
    if (pressure == null) {
      pressure = PressureMonitor(reactContext.applicationContext) { event, json -> send(event, json) }
    }
    pressure?.start()
    promise.resolve(null)
  }

  override fun stopMonitoringPressure(promise: Promise) {
    pressure?.stop()
    promise.resolve(null)
  }

  // MARK: - event readiness

  override fun flushPendingEvents(promise: Promise) {
    val queued = synchronized(lock) { buffer.flush() }
    // Outside the lock: a listener that calls back into this module (ending a
    // call in response to a buffered `callKitEnd` does exactly that) would
    // otherwise deadlock.
    for (entry in queued) dispatch(entry.event, entry.json)
    promise.resolve(null)
  }

  // MARK: - permissions

  override fun cameraPermission(promise: Promise) =
      promise.resolve(permissionState(Manifest.permission.CAMERA, ASKED_CAMERA))

  override fun micPermission(promise: Promise) =
      promise.resolve(permissionState(Manifest.permission.RECORD_AUDIO, ASKED_MIC))

  override fun requestPermissions(video: Boolean, promise: Promise) {
    // Microphone first: an audio call is still a call, so a denied camera must
    // not stop us asking for the thing the call actually needs.
    val wanted = ArrayList<String>()
    wanted.add(Manifest.permission.RECORD_AUDIO)
    if (video) wanted.add(Manifest.permission.CAMERA)
    markAsked(ASKED_MIC)
    if (video) markAsked(ASKED_CAMERA)
    requestRuntimePermissions(wanted.toTypedArray()) {
      val result = JSONObject()
      result.put("camera", permissionState(Manifest.permission.CAMERA, ASKED_CAMERA))
      result.put("mic", permissionState(Manifest.permission.RECORD_AUDIO, ASKED_MIC))
      promise.resolve(result.toString())
    }
  }

  /**
   * `granted` | `denied` | `undetermined`, with the third synthesized.
   *
   * Android has no "not yet asked" state: an unheld permission and a refused
   * one are the same answer from `checkSelfPermission`. So the ever-asked bit
   * is remembered here, and `denied` is reported only after a real refusal —
   * a documented approximation. A person who refuses via
   * "don't ask again" reads as `denied`, not as iOS's `restricted`, which is a
   * concept Android does not have.
   */
  private fun permissionState(permission: String, askedKey: String): String {
    if (hasPermission(permission)) return "granted"
    return if (everAsked(askedKey)) "denied" else "undetermined"
  }

  private fun hasPermission(permission: String): Boolean =
      ContextCompat.checkSelfPermission(reactContext, permission) ==
          PackageManager.PERMISSION_GRANTED

  private fun prefs() =
      reactContext.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun everAsked(key: String): Boolean = prefs().getBoolean(key, false)

  private fun markAsked(key: String) {
    prefs().edit().putBoolean(key, true).apply()
  }

  /**
   * Ask, and call back when the system has answered.
   *
   * With no activity to ask through — the process was woken by a call, and no
   * UI exists yet — the callback runs immediately and the caller reads the
   * unchanged state. That is the honest answer: nothing was granted, and
   * pretending an unanswerable request succeeded would be worse.
   */
  private fun requestRuntimePermissions(permissions: Array<String>, done: () -> Unit) {
    val activity = reactContext.currentActivity as? PermissionAwareActivity
    if (activity == null) {
      done()
      return
    }
    val listener = PermissionListener { _, _, _ ->
      done()
      true
    }
    activity.requestPermissions(permissions, PERMISSION_REQUEST_CODE, listener)
  }

  // MARK: - dev only

  /**
   * Inert outside DEBUG, exactly as on iOS: the setter exists because codegen
   * generates the TurboModule surface from the TypeScript spec and that has no
   * conditional compilation, but the flag it writes is read only behind
   * `BuildConfig.DEBUG`. Not "the switch is gone", which would be false, but
   * "the switch is disconnected".
   */
  override fun enableSyntheticVideo(on: Boolean, promise: Promise) {
    if (BuildConfig.DEBUG) syntheticVideo = on
    promise.resolve(null)
  }

  /** Same shape, same reasoning — the fingerprint fault. */
  override fun enableFingerprintFault(on: Boolean, promise: Promise) {
    if (BuildConfig.DEBUG) fingerprintFault = on
    promise.resolve(null)
  }

  /**
   * The shared-capture spike is iOS-only.
   *
   * It resolves an explanatory measurement rather than rejecting, which is the
   * shape the iOS Release build already uses — the caller records the answer,
   * and a rejection would look like a spike that
   * crashed rather than one that was never run here. Android is not in the
   * question: the spike measures whether ONE camera can feed `legs` peer
   * connections at a thermal cost worth paying, and that measurement has to be
   * made per platform, on hardware, which is device-matrix work.
   */
  override fun runSharedCaptureSpike(legs: Double, seconds: Double, promise: Promise) {
    promise.resolve("{\"error\":\"the capture spike has not been ported to Android\"}")
  }

  // MARK: - emit

  private fun send(event: String, json: String) {
    // Called from the Telecom main thread AND from libwebrtc's signaling
    // thread, so the buffer is read under the lock.
    val deliverNow = synchronized(lock) { buffer.record(event, json) }
    // Outside the lock, for the same re-entrancy reason as the flush.
    if (deliverNow) dispatch(event, json)
  }

  private fun send(event: String, payload: JSONObject) = send(event, payload.toString())

  /**
   * One place that knows which generated emitter each event name belongs to.
   *
   * Codegen emits a `protected final emitOnX` per declared event, so there is
   * no generic "emit by name" to call — and a `when` that silently ignores an
   * unknown name would turn a typo into a lost event. Unknown names are
   * dropped deliberately and visibly here: there is exactly one writer of
   * these strings, the constants below, and the compiler checks them.
   */
  private fun dispatch(event: String, json: String) {
    when (event) {
      "iceState" -> emitOnIceState(json)
      "iceCandidate" -> emitOnIceCandidate(json)
      "connectionState" -> emitOnConnectionState(json)
      "remoteTrackAdded" -> emitOnRemoteTrackAdded(json)
      "remoteTrackRemoved" -> emitOnRemoteTrackRemoved(json)
      "callKitAnswer" -> emitOnCallKitAnswer(json)
      "callKitEnd" -> emitOnCallKitEnd(json)
      "callKitMute" -> emitOnCallKitMute(json)
      CallAudioGate.EVENT_AUDIO_ACTIVATED -> emitOnCallKitAudioActivated(json)
      CallAudioGate.EVENT_AUDIO_DEACTIVATED -> emitOnCallKitAudioDeactivated(json)
      "voipPush" -> emitOnVoipPush(json)
      "voipTokenUpdated" -> emitOnVoipTokenUpdated(json)
      "alertTokenUpdated" -> emitOnAlertTokenUpdated(json)
      CallAudioGate.EVENT_ROUTE_CHANGED -> emitOnAudioRouteChanged(json)
      PressureMonitor.EVENT -> emitOnThermalStateChanged(json)
      "statsSample" -> emitOnStatsSample(json)
      else -> Unit
    }
  }

  // MARK: - CallEventSink

  override fun iceCandidate(cid: String, sdp: String, mid: String, index: Int) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("cand", sdp)
    payload.put("mid", mid)
    payload.put("idx", index)
    send("iceCandidate", payload)
  }

  override fun iceState(cid: String, state: String) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("state", state)
    send("iceState", payload)
  }

  override fun connectionState(cid: String, state: String) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("state", state)
    send("connectionState", payload)
  }

  override fun remoteTrack(cid: String, kind: String, added: Boolean) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("kind", kind)
    send(if (added) "remoteTrackAdded" else "remoteTrackRemoved", payload)
  }

  // MARK: - TelecomCenter.EventSink

  override fun callKitAnswered(cid: String) {
    val payload = JSONObject()
    payload.put("cid", cid)
    send("callKitAnswer", payload)
  }

  override fun callKitEnded(cid: String, reason: String) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("reason", reason)
    send("callKitEnd", payload)
  }

  override fun callKitMuted(cid: String, muted: Boolean) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("muted", muted)
    send("callKitMute", payload)
  }

  override fun voipPush(cid: String, from: String, ringCid: String) {
    val payload = JSONObject()
    payload.put("cid", cid)
    payload.put("from", from)
    payload.put("ringCid", ringCid)
    send("voipPush", payload)
  }

  companion object {
    private const val MAX_CLOSED_CIDS = 256
    private const val PREFS = "tacendum-call-permissions"
    private const val ASKED_CAMERA = "asked-camera"
    private const val ASKED_MIC = "asked-mic"
    private const val PERMISSION_REQUEST_CODE = 4311
  }
}
