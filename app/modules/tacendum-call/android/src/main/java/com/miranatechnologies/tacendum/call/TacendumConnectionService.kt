package com.miranatechnologies.tacendum.call

import android.net.Uri
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/**
 * The self-managed `ConnectionService` — Android's answer to
 * `CXProvider`.
 *
 * Telecom self-managed was chosen over an in-app-only call UI for three reasons,
 * and this class is where all three land: the OS knows a call is in progress
 * (so a cellular call and ours negotiate rather than talk over each other),
 * the `Connection` gives a real audio-activation moment to synthesize
 * `onCallKitAudioActivated` from, and the JS
 * reducer above the bridge is untouched.
 *
 * **The verdict is the whole point of this file.** `TelecomManager
 * .addNewIncomingCall` does not return a result; the system answers by calling
 * either `onCreateIncomingConnection` or `onCreateIncomingConnectionFailed`,
 * asynchronously, and that pair IS the CallKit `reportNewIncomingCall`
 * completion. Every state machine in `TelecomCenter` — the rebind, the parked
 * rebind, the placeholder watchdog — is driven by which of the two arrives.
 * A refusal here is reported upward with the constant verdict
 * `notification/Connection creation failed`.
 *
 * Registered in THIS module's manifest, with `BIND_TELECOM_CONNECTION_SERVICE`
 * and the `android.telecom.ConnectionService` intent filter, under its fully
 * qualified name: a library manifest's `android:name=".Foo"` resolves against
 * the APPLICATION's package, not the library's, and the failure mode is a
 * service the system cannot bind and a call that never rings.
 */
class TacendumConnectionService : ConnectionService() {

  override fun onCreateIncomingConnection(
      connectionManagerPhoneAccount: PhoneAccountHandle?,
      request: ConnectionRequest?,
  ): Connection? {
    val cid = TelecomCenter.cidFrom(request)
    val connection = TelecomCenter.buildConnection(applicationContext, cid, request)
    TelecomCenter.onIncomingConnectionCreated(cid, connection)
    return connection
  }

  override fun onCreateIncomingConnectionFailed(
      connectionManagerPhoneAccount: PhoneAccountHandle?,
      request: ConnectionRequest?,
  ) {
    TelecomCenter.onConnectionCreationFailed(TelecomCenter.cidFrom(request))
  }

  override fun onCreateOutgoingConnection(
      connectionManagerPhoneAccount: PhoneAccountHandle?,
      request: ConnectionRequest?,
  ): Connection? {
    val cid = TelecomCenter.cidFrom(request)
    val connection = TelecomCenter.buildConnection(applicationContext, cid, request)
    TelecomCenter.onOutgoingConnectionCreated(cid, connection)
    return connection
  }

  override fun onCreateOutgoingConnectionFailed(
      connectionManagerPhoneAccount: PhoneAccountHandle?,
      request: ConnectionRequest?,
  ) {
    TelecomCenter.onConnectionCreationFailed(TelecomCenter.cidFrom(request))
  }
}

/**
 * One live call, as Telecom sees it.
 *
 * `PROPERTY_SELF_MANAGED` is what makes this app's own in-call UI the one the
 * person sees, and what makes the full-screen ring OUR notification rather
 * than the dialer's. It also means Telecom shows nothing on its own: if this
 * class does not put a notification up in `onShowIncomingCallUi`, an incoming
 * call is completely invisible.
 *
 * The cid is a `var` because the REBIND re-keys a ringing placeholder to the
 * real cid once the offer decrypts (`TelecomCenter.reportIncomingCall`). The
 * Connection object is deliberately preserved across that — it is the thing
 * the person is looking at — so it has to be able to learn its new name.
 */
class TacendumConnection internal constructor(
    initialCid: String,
    private val hasVideo: Boolean,
) : Connection() {

  @Volatile internal var cid: String = initialCid

  /** The last mute state reported upward, so only CHANGES cross the bridge. */
  private var lastMuted = false

  init {
    connectionProperties = PROPERTY_SELF_MANAGED
    // Mute is offered; hold, grouping and DTMF are not — the same four
    // `supports…` answers the iOS `CXCallUpdate` gives, for the same reason:
    // this is a one-call-at-a-time app and a UI affordance for something the
    // protocol cannot do is a bug report waiting to happen.
    connectionCapabilities = CAPABILITY_MUTE
    audioModeIsVoip = true
    setVideoState(
        if (hasVideo) android.telecom.VideoProfile.STATE_BIDIRECTIONAL
        else android.telecom.VideoProfile.STATE_AUDIO_ONLY
    )
  }

  // MARK: - Telecom actions

  override fun onAnswer() {
    TelecomCenter.onAnswered(this)
  }

  /**
   * The video-state overload is deprecated upstream and still the one Telecom
   * calls for a video call on every API this module supports, so both are
   * implemented and both do the same thing: the video state is already in the
   * Connection, and answering is answering.
   */
  @Deprecated("Telecom's own deprecation; still dispatched for video answers")
  override fun onAnswer(videoState: Int) {
    TelecomCenter.onAnswered(this)
  }

  override fun onReject() {
    TelecomCenter.onRejected(this)
  }

  override fun onDisconnect() {
    TelecomCenter.onDisconnected(this)
  }

  override fun onAbort() {
    TelecomCenter.onDisconnected(this)
  }

  override fun onSilence() {
    CallNotifications.silenceRing()
  }

  /**
   * THE ACTIVATION MOMENT.
   *
   * iOS gets `provider(_:didActivate:)` — an explicit "the audio session is
   * yours now" from CallKit. Android has no such callback. What it has is a
   * `Connection` that enters `STATE_ACTIVE` when the call is genuinely up,
   * with Telecom's audio focus arranged around it, and that is the moment the
   * audio unit may start. Everything else — a track being added, an ICE state,
   * a timer that usually works — is our own timing, which is the single most
   * common cause of "the call connects but there is no sound".
   */
  override fun onStateChanged(state: Int) {
    when (state) {
      STATE_ACTIVE -> CallAudioGate.onConnectionActive(this)
      STATE_DISCONNECTED -> CallAudioGate.onConnectionInactive(this)
      else -> Unit
    }
  }

  /**
   * Deprecated from API 34 in favour of `onCallEndpointChanged`, and still the
   * callback Telecom dispatches on every API this module supports (minSdk 26).
   * Same reasoning as `CallAudioGate.applyRoute`: one routing path, not two.
   */
  @Deprecated("Telecom's own deprecation; the CallEndpoint API starts at 34")
  override fun onCallAudioStateChanged(state: CallAudioState?) {
    if (state == null) return
    CallAudioGate.onRouteChanged(state)
    // MUTE ARRIVES HERE, not as an action. iOS gets `CXSetMutedCallAction`
    // and reports it upward; Telecom has no mute callback at all — the mute
    // state rides on the audio state, and the only way to notice a person
    // muting from the system UI is to watch it change. Without this the
    // `onCallKitMute` event never fires on Android and the in-app microphone
    // button drifts out of step with the one the OS drew.
    if (state.isMuted != lastMuted) {
      lastMuted = state.isMuted
      TelecomCenter.onMuted(this, state.isMuted)
    }
    // The second trigger for the SAME activation site. A connection that is
    // already active when the route finally settles — a Bluetooth headset
    // connecting mid-setup does this — would otherwise have had its one
    // activation fire against a route that no longer exists. The site is
    // idempotent, so a second call is free.
    if (this.state == STATE_ACTIVE) CallAudioGate.onConnectionActive(this)
  }

  /**
   * Self-managed connections show their OWN incoming-call UI. This is the
   * only callback that says "now" — before it, a notification would race
   * Telecom's own bookkeeping, and after it, there is nothing else coming.
   */
  override fun onShowIncomingCallUi() {
    TelecomCenter.showIncomingCallUi(this)
  }

  internal fun finish(cause: Int) {
    setDisconnected(DisconnectCause(cause))
    destroy()
  }

  @Suppress("DEPRECATION")
  internal fun route(): String =
      // Deprecated from API 34 in favour of `CallEndpoint`; minSdk is 26, so
      // this is the spelling that covers the range. Same note as
      // `CallAudioGate.applyRoute`.
      when (callAudioState?.route) {
        CallAudioState.ROUTE_SPEAKER -> "speaker"
        CallAudioState.ROUTE_BLUETOOTH -> "bluetooth"
        CallAudioState.ROUTE_WIRED_HEADSET -> "wired"
        CallAudioState.ROUTE_EARPIECE -> "earpiece"
        else -> "unknown"
      }
}

/** Keys this module puts in the Telecom extras, and reads back out of them. */
internal object TelecomExtras {
  const val CID = "com.miranatechnologies.tacendum.call.CID"
  const val DISPLAY_NAME = "com.miranatechnologies.tacendum.call.DISPLAY_NAME"
  const val HAS_VIDEO = "com.miranatechnologies.tacendum.call.HAS_VIDEO"

  /**
   * The address a self-managed account answers on.
   *
   * `SCHEME_SIP` rather than `tel:`: a Tacendum identity is not a phone
   * number, and handing Telecom a phone-shaped handle would put the call in
   * the system call log where it does not belong — the same reasoning as the
   * iOS `CXHandle(type: .generic)` and `includesCallsInRecents = false`.
   */
  fun address(id: String): Uri = Uri.fromParts(android.telecom.PhoneAccount.SCHEME_SIP, id, null)

  fun outgoingExtras(cid: String, handle: String, hasVideo: Boolean): android.os.Bundle {
    val inner = android.os.Bundle()
    inner.putString(CID, cid)
    inner.putString(DISPLAY_NAME, handle)
    inner.putBoolean(HAS_VIDEO, hasVideo)
    val outer = android.os.Bundle()
    outer.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, inner)
    return outer
  }

  fun incomingExtras(cid: String, displayName: String, hasVideo: Boolean): android.os.Bundle {
    val inner = android.os.Bundle()
    inner.putString(CID, cid)
    inner.putString(DISPLAY_NAME, displayName)
    inner.putBoolean(HAS_VIDEO, hasVideo)
    val outer = android.os.Bundle()
    outer.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, inner)
    return outer
  }
}
