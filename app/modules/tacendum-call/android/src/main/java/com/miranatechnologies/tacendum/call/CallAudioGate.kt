package com.miranatechnologies.tacendum.call

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.telecom.CallAudioState
import org.json.JSONObject

/**
 * The audio handshake, re-derived for Android.
 *
 * Experience calls this "the most common source of 'the call connects but there is
 * no sound'", and the iOS rule it states is exact:
 *
 *   `RTCAudioSession.useManualAudio = true`, and `isAudioEnabled` is driven
 *   ONLY by `provider(_:didActivate:)` and `provider(_:didDeactivate:)`.
 *
 * **Android has no `didActivate`.** There is no moment at which the platform
 * hands this process an audio session and says so. That absence is exactly why
 * this file exists rather than a straight port: the doctrine survives only if
 * something on this side plays the part, and the honest candidate is the
 * `Connection` reaching `STATE_ACTIVE` — the point at which Telecom considers
 * the call up and has arranged focus and routing around it. Everything else on
 * offer (a track being added, an ICE transition, a short delay that usually
 * works) is our own timing, which is the failure the handshake is about.
 *
 * So the re-derivation is:
 *
 *   * MANUAL AUDIO IS ARMED IN THE FACTORY, before any peer connection can
 *     exist — `useManualAudio` below, set by `TacendumCallModule.ensureFactory`
 *     and consulted by every `CallPeerConnection` at construction, which comes
 *     up with `setAudioPlayout(false)`/`setAudioRecording(false)`. libwebrtc's
 *     Android audio device module is per-connection, and those two calls are
 *     the same lever `isAudioEnabled` is on iOS.
 *   * THE UNIT STARTS IN EXACTLY ONE PLACE: `onConnectionActive` below.
 *     Exactly one line in this module raises `isAudioEnabled`, and it sits
 *     inside that function — the same discipline the Swift half keeps, and a
 *     structural check of that shape is the only kind that can catch this
 *     regressing, because a broken ordering still passes every unit test and
 *     only fails as silence on a device.
 *   * THE SYNTHETIC EVENT is emitted from the same place, so the JS reducer —
 *     which is written against `onCallKitAudioActivated` and is not touched by
 *     this port — sees the platform-shaped signal it already knows.
 *
 * What this does NOT claim: that Android's ACTIVE moment is as authoritative
 * as CallKit's. CallKit will not give the session before `didActivate`; Telecom
 * will not stop a determined app from opening a microphone earlier. The
 * guarantee here is a discipline this module keeps rather than one the
 * platform enforces — and saying so is the point of the paragraph.
 */
internal object CallAudioGate {

  /**
   * Manual audio, armed once in the factory and never cleared.
   *
   * If the audio unit could start on libwebrtc's own timing even once, the
   * handshake below would be advisory rather than authoritative.
   */
  @Volatile var useManualAudio = false

  /**
   * Whether the audio unit is running. Written in exactly two places: the
   * activation site below, and the deactivation beside it.
   */
  private var isAudioEnabled = false

  private var speakerWanted = false
  private var activeConnection: TacendumConnection? = null
  private val lock = Any()

  private var context: Context? = null
  private var connections: () -> List<CallPeerConnection> = { emptyList() }
  private var emit: (String, String) -> Unit = { _, _ -> }

  fun attach(
      appContext: Context,
      liveConnections: () -> List<CallPeerConnection>,
      sink: (String, String) -> Unit,
  ) {
    context = appContext.applicationContext
    connections = liveConnections
    emit = sink
    ProximityGuard.attach(appContext)
  }

  fun isActive(): Boolean = synchronized(lock) { isAudioEnabled }

  /**
   * Re-derive the proximity wake lock from the three facts it hangs on: the
   * audio unit running, the active connection's route on the earpiece, and
   * no live connection carrying video. Called from every path that can
   * change one of them — the activation site, the deactivation, the route
   * callback, and the module after a negotiation births a track or a close
   * drops one. Idempotent, so an extra call is free. */
  fun refreshProximity() {
    val (active, connection) = synchronized(lock) { Pair(isAudioEnabled, activeConnection) }
    val earpiece = connection?.route() == "earpiece"
    // `usesVideo`: the call took the camera, so it is a call the person looks
    // at whatever the camera is doing right now.
    val video = connections().any { it.usesVideo }
    ProximityGuard.refresh(active, earpiece, video)
  }

  /**
   * THE ONLY PLACE THE AUDIO UNIT STARTS.
   *
   * Idempotent: `onStateChanged(STATE_ACTIVE)` and a late
   * `onCallAudioStateChanged` both arrive for the same call, and a second
   * activation must be free rather than a second event JS has to de-duplicate.
   */
  fun onConnectionActive(connection: TacendumConnection) {
    val first =
        synchronized(lock) {
          activeConnection = connection
          if (isAudioEnabled) {
            false
          } else {
            isAudioEnabled = true
            true
          }
        }
    // The route is applied HERE, not where it was asked for. Every request
    // that arrived before this moment — and for a video call that is all of
    // them, since the controller asks as soon as the call has a cid — landed
    // on a call Telecom had not yet made active. This is the first instant at
    // which the route means anything.
    applyRoute(connection)
    // Every live connection, not just this one: a leg installed while the
    // audio unit was already running comes up manual and would otherwise stay
    // silent for the rest of the call.
    for (pc in connections()) pc.applyAudioUnit(true)
    // The unit is up and the route applied: the proximity rule can read both.
    refreshProximity()
    if (!first) return
    // Carries no cid: there is one audio path per DEVICE, not per call — the
    // same contract the iOS event has, which is why the JS reducer needs no
    // change.
    emit(EVENT_AUDIO_ACTIVATED, "{}")
    emitRoute(connection.route())
  }

  /** The other half. A deactivated call must not leave the unit running. */
  fun onConnectionInactive(connection: TacendumConnection) {
    // Sampled BEFORE this lock is taken. `TelecomCenter` has a lock of its
    // own and asking it a question while holding this one is the start of a
    // lock ordering nobody is tracking; the answer is a snapshot either way.
    val stillLive = TelecomCenter.hasLiveConnection()
    val wasEnabled =
        synchronized(lock) {
          if (activeConnection === connection) activeConnection = null
          // Only when nothing else is live: ending one leg of a group call
          // must not silence the others.
          val stop = isAudioEnabled && !stillLive
          if (stop) isAudioEnabled = false
          stop
        }
    // Whatever else is live, the lock is re-derived: a leg ending changes
    // nothing for the others, the last one ending releases it.
    refreshProximity()
    if (!wasEnabled) return
    for (pc in connections()) pc.applyAudioUnit(false)
    emit(EVENT_AUDIO_DEACTIVATED, "{}")
  }

  /** Remember the route the call wants, without applying it. */
  fun rememberRoute(speaker: Boolean) {
    synchronized(lock) { speakerWanted = speaker }
  }

  fun onRouteChanged(state: CallAudioState) {
    emitRoute(routeName(state.route))
    // The speaker button, a headset, Bluetooth: the route is the proximity
    // rule's input that moves on its own clock.
    refreshProximity()
  }

  /**
   * THE ROUTE MATRIX.
   *
   * `Connection.setAudioRoute` is the Telecom lever and the one that works
   * with a self-managed call; `AudioManager.setCommunicationDevice` (API 31+)
   * is the fallback for the window in which no Connection exists yet, with
   * `isSpeakerphoneOn` below 31.
   *
   * AN ACCESSORY IS NEVER YANKED. iOS expresses "speaker" as
   * `.defaultToSpeaker` rather than `overrideOutputAudioPort(.speaker)`
   * precisely so a conversation in someone's headphones is not seized; the
   * same rule is written out here, because Telecom's `ROUTE_SPEAKER` is the
   * forcing kind. Four cases, all correct: speaker wanted with no accessory →
   * loudspeaker; not wanted → earpiece; either, with a wired headset or
   * Bluetooth already routed → left alone.
   */
  @Suppress("DEPRECATION")
  fun applyRoute(connection: TacendumConnection?) {
    // `getCallAudioState`/`setAudioRoute` are deprecated from API 34 in favour
    // of the `CallEndpoint` API, which does not exist below 34. minSdk here is
    // 26, so the deprecated pair is the only spelling that covers the
    // supported range, and a second code path for 34+ would double the routing
    // logic — the part of this file most likely to be wrong — for no
    // behavioural difference. Revisit when minSdk reaches 34.
    val speaker = synchronized(lock) { speakerWanted }
    val state = connection?.callAudioState
    if (state != null) {
      val current = state.route
      if (current == CallAudioState.ROUTE_WIRED_HEADSET ||
          current == CallAudioState.ROUTE_BLUETOOTH) {
        return
      }
      connection.setAudioRoute(
          if (speaker) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_EARPIECE
      )
      return
    }
    val audio = context?.getSystemService(AudioManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = audio.availableCommunicationDevices
      val accessory =
          devices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
          }
      if (accessory != null) {
        audio.setCommunicationDevice(accessory)
        return
      }
      val wanted =
          devices.firstOrNull {
            it.type ==
                if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
          }
      if (wanted != null) audio.setCommunicationDevice(wanted)
      return
    }
    @Suppress("DEPRECATION")
    audio.isSpeakerphoneOn = speaker
  }

  private fun emitRoute(route: String) {
    val payload = JSONObject()
    payload.put("route", route)
    payload.put("speaker", route == "speaker")
    emit(EVENT_ROUTE_CHANGED, payload.toString())
  }

  private fun routeName(route: Int): String =
      when (route) {
        CallAudioState.ROUTE_SPEAKER -> "speaker"
        CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
        CallAudioState.ROUTE_WIRED_HEADSET -> "wired"
        CallAudioState.ROUTE_EARPIECE -> "earpiece"
        else -> "unknown"
      }

  const val EVENT_AUDIO_ACTIVATED = "callKitAudioActivated"
  const val EVENT_AUDIO_DEACTIVATED = "callKitAudioDeactivated"
  const val EVENT_ROUTE_CHANGED = "audioRouteChanged"
}
