import AVFoundation
import Foundation
import UIKit
import UserNotifications
import WebRTC

/**
 * The calling module's Swift half.
 *
 * A facade: it owns the peer-connection factory, one `CallPeerConnection` per
 * live call, and the wiring that turns native callbacks into JS events. It
 * holds no protocol state — no notion of ringing, no timers, no decisions
 * about when a call is over. That all lives in the reducer, above the bridge.
 *
 * Every method is async-friendly and every failure is surfaced as a rejected
 * promise rather than a silent no-op, because a call that fails quietly is
 * indistinguishable to the user from a call that is still connecting.
 *
 * **Rejection messages carry no cid and no interpolated error text.** A cid is
 * never logged and never a metric dimension (addendum 8), and it was reaching
 * the log indirectly — the message carried it and the JS side logs the whole
 * error. Interpolating a libwebrtc error is worse still: those strings can
 * contain an SDP or a candidate address, which is the peer's IP. The error
 * CODE is what a caller acts on; the underlying NSError travels as the third
 * argument, where the platform decides what to surface.
 */
@objc(TacendumCallImpl)
public final class TacendumCallImpl: NSObject {
  @objc public static let shared = TacendumCallImpl()

  private var factory: RTCPeerConnectionFactory?
  private var configuration: RTCConfiguration?
  private var calls: [String: CallPeerConnection] = [:]
  private let lock = NSLock()
  private var syntheticVideo = false
  private var fingerprintFault = false

  /// JS event sinks, rebound on every `start` so a Metro reload replaces the
  /// stale emitter rather than emitting into a destroyed TurboModule.
  private var emit: ((String, String) -> Void)?

  /// Events raised before JS was listening, oldest first.
  ///
  /// A cold launch from the lock screen runs in this order: iOS delivers the
  /// VoIP push, CallKit rings, the user answers, and only THEN does the React
  /// runtime come up. Every one of those events would otherwise be emitted
  /// into a nil sink and lost, so the phone would show an answered call the
  /// app had never heard of and the caller would sit in silence.
  ///
  /// Binding the emitter is not enough to flush: the TurboModule binds at
  /// construction, which happens when the JS module is first imported, while
  /// the listeners are attached later in `startCalling`. Between those two
  /// points codegen's own emitter drops anything with no listener — a second
  /// silent drop behind the first. So the buffer is released only when JS
  /// says it is ready, not when the emitter appears.
  private var pending: [(String, String)] = []
  private var jsReady = false
  /// Pressure observers are registered once per process and only while calling.
  private var monitoringPressure = false

  // / The tokens `startMonitoringPressure` gets back from /
  // `addObserver(forName:object:queue:using:)` — one per signal, held so /
  // `stopMonitoringPressure` can hand each one back. Block-based observers /
  // are removed by TOKEN; `removeObserver(self)` reaches only selector /
  // registrations, so the old stop leaked all three every call and each /
  // thermal/power/battery change then fired N `thermalStateChanged` events,
  // / in and out of calls.
  fileprivate var pressureObservers: [NSObjectProtocol] = []

  /// The audio-route observer behind `refreshProximity`, held for the life
  /// of the singleton — block-based observers are removed by TOKEN, never by
  /// `removeObserver(self)`, which only reaches selector registrations.
  private var routeObserver: NSObjectProtocol?

  private override init() {
    super.init()
    // THE PROXIMITY RULE'S THIRD INPUT. Live-ness and video are recomputed
    // where the calls map changes; the route changes on its own clock —
    // the speaker button, a headset plugged in, Bluetooth connecting — and
    // this is the one signal that says so.
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
    ) { [weak self] _ in
      self?.refreshProximity()
    }
  }

  /// The APNs ALERT token, which is not the VoIP one.
  ///
  /// This lives in the calling module because that is where the APNs surface
  /// already is — PushKit, the VoIP token, the CallKit handshake. A message
  /// notification is not a call, and the naming here says so; a separate
  /// native module for one token and one permission prompt would be a pod, a
  /// podspec and a codegen target for thirty lines.
  private var alertToken = ""

  /// Called by the app delegate, which is the only place iOS hands this over.
  @objc public func setAlertToken(_ hex: String) {
    alertToken = hex
    send("alertTokenUpdated", ["token": hex])
  }

  @objc public func currentAlertToken() -> String { alertToken }

  /**
   * Ask for permission to show notifications, then register for remote ones.
   *
   * Two separate things, and the order matters: `registerForRemoteNotifications`
   * yields a token whether or not the person agreed, but a token with no
   * permission produces a push that arrives and shows nothing. Registering
   * only after a grant means the server never holds a token it cannot use.
   *
   * Resolves with the outcome rather than throwing on refusal: being told no
   * is an answer, not an error, and the caller decides what to say about it.
   */
  @objc public func requestNotificationPermission(
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    UNUserNotificationCenter.current()
      .requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        DispatchQueue.main.async {
          if granted { UIApplication.shared.registerForRemoteNotifications() }
          resolve(granted ? "granted" : "denied")
        }
      }
  }

  /**
   * Set or clear the icon badge.
   *
   * `setBadgeCount` rather than the deprecated `applicationIconBadgeNumber`:
   * the latter is main-thread-only UIKit state and was deprecated in iOS 17
   * in favour of this, which goes through the notification centre and works
   * whether or not the app is foreground.
   *
   * The error is swallowed on purpose. It arrives when notifications are not
   * authorised, which is a state the app already knows about and already
   * handles — turning it into a rejected promise would make the drain path,
   * which is a message path, able to fail over a number on an icon.
   */
  @objc public func setBadgeCount(_ count: Int) {
    if #available(iOS 16.0, *) {
      UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    } else {
      // The pre-16 spelling. Deprecated since 17 and main-thread-only UIKit
      // state, which is why it is not the primary path — but the pod's
      // deployment target is below 16, so compiling without this fails the
      // whole app build, not just this method.
      DispatchQueue.main.async {
        UIApplication.shared.applicationIconBadgeNumber = count
      }
    }
  }

  // MARK: - missed calls

  /// Every missed-call request id starts with this; the peer's id follows,
  /// then a nonce. Clearing by peer is a prefix match over what is delivered.
  private static let missedCallPrefix = "missed-call."

  /**
   * Post the local "Missed call" notice.
   *
   * A missed call on a locked phone used to leave nothing at all: CallKit
   * ends the ring `.unanswered`, but `includesCallsInRecents` is off (§9.4)
   * and the app posted no notification, so the only way to learn of the
   * call was to open the Calls tab. The JS side calls this from the same
   * path that writes the missed row — the row is the fact; this is its
   * notice.
   *
   * `displayName` is what JS knows; empty when it knows nothing (a locked
   * workspace refuses the read), in which case the name mirror the ring
   * itself paints from is consulted, and failing that the body says only
   * that someone called. The payload carries NOTHING else — no id, no
   * offer, no thread — because a delivered notification is readable by
   * anything that can read the lock screen. `threadIdentifier` is the peer
   * id so the notice groups with that person's message notifications.
   * Never rejects: a refused post (notifications not authorised) costs the
   * notice, never the row or the call.
   */
  @objc public func postMissedCall(peerId: String, displayName: String) {
    let known = displayName.isEmpty
      ? (CallKitCenter.shared.mirroredName(for: peerId) ?? "")
      : displayName
    let content = UNMutableNotificationContent()
    content.title = "Missed call"
    content.body = known.isEmpty ? "Tap to see who called." : known
    content.sound = .default
    content.threadIdentifier = peerId
    let request = UNNotificationRequest(
      identifier: Self.missedCallPrefix + peerId + "." + UUID().uuidString,
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request) { _ in }
  }

  /// Clear the missed-call notices for `peerId` — every one of them when it
  /// is empty. The Calls tab clears all on open; a thread clears its peer.
  @objc public func clearMissedCall(peerId: String) {
    let prefix = peerId.isEmpty ? Self.missedCallPrefix : Self.missedCallPrefix + peerId + "."
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered.map { $0.request.identifier }.filter { $0.hasPrefix(prefix) }
      if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }
  }

  /// This binary's bundle identifier.
  ///
  /// `Bundle.main` rather than a constant compiled in from somewhere else:
  /// this value is sent to the server with the push registration, and the one
  /// thing it must never be is a stale copy of what the bundle id used to be.
  /// The empty fallback cannot happen for an app bundle, and is here only
  /// because the API is optional.
  @objc public func bundleIdentifier() -> String {
    Bundle.main.bundleIdentifier ?? ""
  }

  /// Deep enough for a cold launch's handful of CallKit events, shallow
  /// enough that a build which never calls `flushPendingEvents` leaks a
  /// bounded amount rather than growing for the life of the process.
  private static let maxPending = 32

  @objc public func bindEmitter(_ emit: @escaping (String, String) -> Void) {
    lock.lock()
    self.emit = emit
    lock.unlock()
    CallKitCenter.shared.events = self
  }

  /// JS has attached its listeners; deliver anything that happened first.
  ///
  /// Idempotent, and safe to call on every launch and every Metro reload.
  @objc public func flushPendingEvents() {
    lock.lock()
    jsReady = true
    let queued = pending
    pending = []
    let sink = emit
    lock.unlock()
    // Outside the lock: a listener that calls back into this class (ending a
    // call in response to a buffered `callKitEnd` does exactly that) would
    // otherwise deadlock on a non-recursive NSLock.
    guard let sink = sink else { return }
    for (event, payload) in queued { sink(event, payload) }
  }

  /// A reload tears down the JS half; buffer again until the new one is up.
  @objc public func suspendEvents() {
    lock.lock()
    jsReady = false
    lock.unlock()
  }

  private func ensureFactory() -> RTCPeerConnectionFactory {
    if let f = factory { return f }
    RTCInitializeSSL()
    // Manual audio. ARMED IN CallKitCenter's init — process start —
    // and only RE-ASSERTED here, because arming here, which is the first
    // createOffer/createAnswer of the process, was TOO LATE on the callee's
    // first call of a launch: CallKit's answer had already activated the
    // session, `didActivate` had already been consumed with the gate down,
    // and the unconditional `isAudioEnabled = false` that used to live here
    // then clobbered that activation forever — a call silent in both
    // directions that only a redial could fix. `armManualAudio` is idempotent
    // and never lowers `isAudioEnabled`; see its comment for the ordering
    // argument.
    CallKitCenter.shared.armManualAudio()

    let encoder = RTCDefaultVideoEncoderFactory()
    let decoder = RTCDefaultVideoDecoderFactory()
    // H.264 first — hardware encode/decode on every supported iPhone.
    // The order of this array is the order that reaches the SDP.
    let preferred = encoder.supportedCodecs().sorted { lhs, rhs in
      rank(lhs.name) < rank(rhs.name)
    }
    // Only when there IS one: leaving the factory's own default in place is
    // correct if the device reports no supported codecs, whereas forcing an
    // empty preference would leave the offer with nothing negotiable on it.
    if let best = preferred.first { encoder.preferredCodec = best }
    let f = RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    factory = f
    return f
  }

  private func rank(_ codec: String) -> Int {
    switch codec.lowercased() {
    case "h264": return 0
    case "vp8": return 1
    default: return 2
    }
  }

  // MARK: - configuration

  @objc public func configure(
    iceServersJson: String,
    relayOnly: Bool,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    guard let data = iceServersJson.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
      reject("bad_ice_servers", "ice server list is not valid JSON", nil)
      return
    }

    let config = RTCConfiguration()
    config.iceServers = parsed.compactMap { entry in
      guard let urls = entry["urls"] as? [String] else { return nil }
      if let username = entry["username"] as? String,
         let credential = entry["credential"] as? String {
        return RTCIceServer(urlStrings: urls, username: username, credential: credential)
      }
      return RTCIceServer(urlStrings: urls)
    }
    config.sdpSemantics = .unifiedPlan
    config.bundlePolicy = .maxBundle
    config.rtcpMuxPolicy = .require
    config.continualGatheringPolicy = .gatherContinually
    // Always-relay: with `.relay` no host candidate is ever offered, so
    // the peer never learns this device's IP address. It costs a relay hop for
    // every call and that is the trade the setting exists to make.
    config.iceTransportPolicy = relayOnly ? .relay : .all
    configuration = config
    resolve(nil)
  }

  private func call(_ cid: String) -> CallPeerConnection? {
    lock.lock()
    defer { lock.unlock() }
    return calls[cid]
  }

  /**
   * CIDS CLOSED WHILE THEIR CONNECTION WAS STILL BEING BUILT (a review
   * blocker, the native half).
   *
   * `createOffer` and `createAnswer` return the instant they are called and
   * do their work in a `Task`; `makeCall` installs the `CallPeerConnection`
   * into `calls` only when that Task is scheduled and runs. `closeCall(cid)`
   * arriving in between — which is exactly what the JS coordinator's
   * `dispose()` does on a relock, for every leg it can name — scanned a
   * dictionary the connection was not in yet, closed nothing, and resolved.
   * The Task then installed a LIVE peer connection: a microphone that
   * survived the very relock that was meant to end it, held by an object
   * nothing above the bridge still has a handle to.
   *
   * The scan cannot be made to cover a connection that does not exist, so the
   * close leaves a MARK and the install looks for it. This is the same shape
   * as the generation fence above the bridge, reduced to the one fact the
   * native side has: this cid is over.
   *
   * BOUNDED BY LIVENESS, NEVER BY COUNT ALONE. A cid is a fresh
   * ULID minted per call, per re-offer and per leg (`group.ts`: "A FRESH cid
   * per re-offer"); none is ever reused, so there is no moment at which
   * forgetting one would be correct — but a set that grows for the life of the
   * process is not acceptable either.
   *
   * The first bound was a plain FIFO trim at 256, on the reasoning that 256
   * later closes is "far beyond any window in which a close can still be
   * racing an install". That reasoning has no mechanism behind it. A
   * negotiation Task is scheduled by the Swift runtime and can be starved
   * arbitrarily long; a device that places or receives 256 calls while ONE
   * Task is stalled — a leg fan-out on a bad network re-offering, a burst of
   * group legs — evicts that Task's tombstone and restores the exact race the
   * tombstone exists to close, with a live microphone as the prize.
   *
   * So a tombstone is evicted only once nothing can still install under it:
   * `inFlightCids` names every cid whose negotiation Task has been issued and
   * has not finished. The count remains as a trim TARGET rather than a hard
   * ceiling — the set can exceed it only by the number of concurrently stalled
   * negotiations, which is bounded by the call and leg caps.
   */
  private var closedCids: Set<String> = []
  private var closedCidOrder: [String] = []
  private static let maxClosedCids = 256

  /**
   * Cids whose negotiation Task is live.
   *
   * Marked SYNCHRONOUSLY at the bridge method, before the `Task` is created,
   * and released when that Task finishes. Not inside `makeCall`, which is
   * where the install happens and therefore exactly too late: the whole race
   * is the window in which the Task has not been scheduled yet, and a cid that
   * is not yet in flight by that definition is one whose tombstone could be
   * evicted before it ever ran.
   *
   * A count rather than a flag: `createAnswer` can follow `createOffer` on one
   * cid (an ICE restart reuses the connection), and one Task finishing must not
   * declare the other's cid quiescent.
   */
  private var inFlightCids: [String: Int] = [:]

  private func beginNegotiation(_ cid: String) {
    lock.lock()
    inFlightCids[cid, default: 0] += 1
    lock.unlock()
  }

  private func endNegotiation(_ cid: String) {
    lock.lock()
    let remaining = (inFlightCids[cid] ?? 1) - 1
    if remaining <= 0 {
      inFlightCids.removeValue(forKey: cid)
      // The cid may have been held past the trim target purely because it was
      // in flight; now that it is not, the deferred eviction can happen.
      trimClosedLocked()
    } else {
      inFlightCids[cid] = remaining
    }
    lock.unlock()
  }

  /// Caller must hold `lock`.
  private func markClosedLocked(_ cid: String) {
    guard closedCids.insert(cid).inserted else { return }
    closedCidOrder.append(cid)
    trimClosedLocked()
  }

  /// Drop the oldest tombstones down to the target, SKIPPING any cid whose
  /// negotiation is still in flight. Caller must hold `lock`.
  private func trimClosedLocked() {
    guard closedCidOrder.count > Self.maxClosedCids else { return }
    var over = closedCidOrder.count - Self.maxClosedCids
    var kept: [String] = []
    kept.reserveCapacity(closedCidOrder.count)
    for cid in closedCidOrder {
      if over > 0 && inFlightCids[cid] == nil {
        closedCids.remove(cid)
        over -= 1
        continue
      }
      kept.append(cid)
    }
    closedCidOrder = kept
  }

  private func makeCall(_ cid: String) throws -> CallPeerConnection {
    guard let config = configuration else { throw CallError.notConfigured }
    // Refused before the connection is built when the close already landed:
    // constructing one only to throw it away would still have taken the
    // microphone for as long as it took to notice.
    lock.lock()
    let alreadyClosed = closedCids.contains(cid)
    lock.unlock()
    if alreadyClosed { throw CallError.closed }

    let pc = try CallPeerConnection(
      cid: cid, factory: ensureFactory(), config: config, events: self
    )
    #if DEBUG
      pc.useSyntheticVideo(syntheticVideo)
      pc.useFingerprintFault(fingerprintFault)
    #endif
    lock.lock()
    // THE SECOND LOOK, under the same lock that performs the install. The
    // check above is an optimisation; this one is the correctness argument.
    // A close landing between them would otherwise be overwritten by the very
    // assignment it was racing, and only a test that is atomic with the
    // insertion can see it.
    if closedCids.contains(cid) {
      lock.unlock()
      pc.close()
      throw CallError.closed
    }
    calls[cid] = pc
    lock.unlock()
    refreshIdleTimer()
    return pc
  }

  /**
   * KEEP THE SCREEN AWAKE WHILE A CALL IS LIVE.
   *
   * iOS dims and then locks the display on its ordinary inactivity timer no
   * matter what the app is doing, and CallKit does not change that: CallKit
   * owns the SYSTEM call UI, not this app's. So a video call went dark
   * mid-conversation — camera still up, audio still flowing, the other
   * person's face replaced by a locked screen — and the only way back was to
   * unlock the phone, which is the one thing you cannot do while holding it
   * up to be seen.
   *
   * DERIVED from `calls` rather than set by whoever starts or ends a call.
   * The flag is global to the process and it is the kind that leaks: a path
   * that raises it and returns early leaves the display permanently awake for
   * the rest of the app's life. Recomputing it from the live set means the
   * last connection to be removed always restores the system default, whether
   * it left through hangup, failure, or teardown.
   *
   * THE SET IS READ ON THE MAIN QUEUE, not before the hop to it. `UIApplication`
   * is main-only, so the write has to land there either way — and reading
   * first would let two refreshes sample in one order and apply in the other:
   * an install reads "live", a close reads and applies "not live", and the
   * install's stale "live" lands last and strands the display awake for the
   * rest of the app's life. Reading inside the block makes the last write win
   * with the truth, because the main queue serialises them and each one looks
   * at the set as it is when it runs.
   */
  private func refreshIdleTimer() {
    let apply = {
      self.lock.lock()
      let live = !self.calls.isEmpty
      self.lock.unlock()
      UIApplication.shared.isIdleTimerDisabled = live
    }
    if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    refreshProximity()
  }

  /**
   * BLANK THE SCREEN AGAINST THE FACE.
   *
   * CallKit manages the proximity sensor for the SYSTEM call UI, not for a
   * third-party in-call screen, and the idle timer above keeps the display
   * awake for the life of every call — so an earpiece call left a lit,
   * touch-live `CallScreen` pressed against a cheek, End and Mute along its
   * bottom edge. `isProximityMonitoringEnabled` is the lever: while it is
   * on, iOS turns the display off when the sensor covers and back on when it
   * clears.
   *
   * DERIVED, like the idle timer, from three facts read at apply time:
   *  - a call is live (a peer connection exists — dialling included, since
   *    the ringback is heard at the ear);
   *  - the audio is on the RECEIVER. Speaker, a headset or Bluetooth mean
   *    the phone is not at the face, and blanking then would blank a screen
   *    the person is looking at;
   *  - no call carries video. A video call is looked at whatever the camera
   *    is doing, and `hasLocalVideo` is what the peer connection knows.
   * Recomputed on every calls-map change, on every negotiation completing
   * (the video track is born inside it), on audio activation (the route is
   * applied there) and on every route change. The last connection to leave
   * therefore always restores the system default, by the same argument the
   * idle timer makes. */
  fileprivate func refreshProximity() {
    let apply = {
      self.lock.lock()
      let live = !self.calls.isEmpty
      let video = self.calls.values.contains { $0.hasLocalVideo }
      self.lock.unlock()
      let receiver = AVAudioSession.sharedInstance().currentRoute.outputs.contains {
        $0.portType == .builtInReceiver
      }
      let wanted = live && receiver && !video
      let device = UIDevice.current
      if device.isProximityMonitoringEnabled != wanted {
        device.isProximityMonitoringEnabled = wanted
      }
    }
    if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
  }

  // MARK: - negotiation

  @objc public func createOffer(
    cid: String, withVideo: Bool,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    // Before the Task, never inside it: see `inFlightCids`.
    beginNegotiation(cid)
    Task {
      defer { self.endNegotiation(cid) }
      do {
        let pc = try makeCall(cid)
        let sdp = try await pc.createOffer(withVideo: withVideo)
        // The local tracks were born inside the call above; the proximity
        // rule's video input can only be read now.
        refreshProximity()
        resolve(sdp)
      } catch {
        reject("offer_failed", "could not create an offer", error)
      }
    }
  }

  @objc public func createAnswer(
    cid: String, remoteOfferSdp: String, withVideo: Bool,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    // THE IN-APP ANSWER'S CALLKIT HALF. Every accept path funnels through
    // this method, and an accept taken on the app's own screen used to be
    // invisible to CallKit: no CXAnswerCallAction, so no audio-session
    // activation, no `didActivate`, and — under the manual-audio rule — a
    // WebRTC unit that never started. `answerFromApp` requests the missing
    // transaction exactly once per reported incoming call and no-ops
    // everywhere else: a system-UI answer already consumed the entry, an ICE
    // restart's re-answer finds it consumed, and a group leg's cid was never
    // reported to CallKit at all.
    CallKitCenter.shared.answerFromApp(cid: cid)
    beginNegotiation(cid)
    Task {
      defer { self.endNegotiation(cid) }
      do {
        // The offer may already have a peer connection if a restart arrived;
        // reuse it so the ICE credentials continue rather than reset.
        let pc = try call(cid) ?? makeCall(cid)
        let sdp = try await pc.createAnswer(remoteOfferSdp: remoteOfferSdp, withVideo: withVideo)
        refreshProximity()
        resolve(sdp)
      } catch {
        reject("answer_failed", "could not create an answer", error)
      }
    }
  }

  @objc public func setRemoteAnswer(
    cid: String, sdp: String,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    Task {
      guard let pc = call(cid) else {
        reject("no_such_call", "no such call", nil)
        return
      }
      do {
        try await pc.setRemoteAnswer(sdp)
        resolve(nil)
      } catch {
        reject("set_answer_failed", "could not apply the answer", error)
      }
    }
  }

  @objc public func addIceCandidates(
    cid: String, candidatesJson: String,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    guard let data = candidatesJson.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
      reject("bad_candidates", "candidate list is not valid JSON", nil)
      return
    }
    let candidates = parsed.compactMap { entry -> (String, String?, Int32)? in
      guard let sdp = entry["cand"] as? String else { return nil }
      return (sdp, entry["mid"] as? String, Int32(entry["idx"] as? Int ?? 0))
    }
    Task {
      guard let pc = call(cid) else {
        // Not an error: candidates for a call that has already ended are
        // ordinary, and redelivery makes them common.
        resolve(nil)
        return
      }
      do {
        try await pc.addRemoteCandidates(candidates)
        resolve(nil)
      } catch {
        reject("add_candidates_failed", "could not add candidates", error)
      }
    }
  }

  @objc public func restartIce(
    cid: String,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    Task {
      guard let pc = call(cid) else {
        reject("no_such_call", "no such call", nil)
        return
      }
      do {
        resolve(try await pc.createOffer(withVideo: false, iceRestart: true))
      } catch {
        reject("restart_failed", "could not restart ICE", error)
      }
    }
  }

  @objc public func closeCall(
    cid: String,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    lock.lock()
    // The tombstone is laid FIRST and under the same lock as the removal, so
    // a `makeCall` racing this cannot slip an install between the two.
    // Unconditional: the whole point is the case where `calls` has no entry
    // yet because the offer Task has not reached its install.
    markClosedLocked(cid)
    let pc = calls.removeValue(forKey: cid)
    lock.unlock()
    pc?.close()
    // AFTER the removal, and unconditional: this is the half that gives the
    // display back. A `closeCall` for a cid that was never installed still
    // recomputes, which costs nothing and is what makes the flag impossible
    // to strand raised.
    refreshIdleTimer()
    resolve(nil)
  }

  // MARK: - media

  /// THE APPLIED VERDICT.
  ///
  /// These were `call(cid)?.setAudioEnabled(on)` — a silent no-op when the cid
  /// named no live connection, which is exactly the case a small-group
  /// session must detect: the all-or-close-the-leg rule CLOSES a leg it cannot
  /// silence, and it can only do that if the leg says so. `false` means
  /// nothing was applied: either no connection for that cid, or no track on
  /// it. The media semantics of a successful call are unchanged.
  ///
  /// The bridge below resolves the boolean, and the TurboModule spec declares
  /// it — a spec method must exist in BOTH configurations or the generated
  /// protocol goes unconformed and the Release build fails (the rule
  /// `runSharedCaptureSpike` documents), so nothing here is `#if DEBUG`.
  @objc public func setAudioEnabled(cid: String, on: Bool) -> Bool {
    call(cid)?.setAudioEnabled(on) ?? false
  }

  @objc public func setVideoEnabled(cid: String, on: Bool) -> Bool {
    call(cid)?.setVideoEnabled(on) ?? false
  }
  @objc public func switchCamera(cid: String) { call(cid)?.switchCamera() }
  // Explicit selector. A single-argument Swift method whose name begins with
  // "set" is bridged as an ObjC SETTER — `setSpeaker:`, not the
  // `setSpeakerWithOn:` the naming rule would otherwise produce — and the
  // resulting error names the selector rather than the rule, which is not a
  // useful place to start looking.
  @objc(setSpeakerEnabled:)
  public func setSpeaker(on: Bool) { CallKitCenter.shared.setSpeaker(on) }

  #if DEBUG
    /**
     * The one factory, for the shared-capture spike.
     *
     * A video source cannot be shared across factories, so the spike's whole
     * premise rests on there being exactly one — which there is: `ensureFactory`
     * is lazily created and never reset. Exposed rather than duplicated,
     * because a spike that stood up its OWN factory would measure an
     * architecture this app does not have and report a reassuring number about
     * it. DEBUG-only, and it never appears in a Release binary.
     */
    @objc public static func sharedFactoryForSpike() -> RTCPeerConnectionFactory {
      shared.ensureFactory()
    }

  #endif

  /**
   * Run the capture spike and hand back its JSON measurement. It wants ten
   * minutes on physical hardware; the arguments stay open so the simulator arm
   * can be exercised in seconds.
   *
   * The METHOD is compiled in both configurations and only its BODY is
   * DEBUG-only — the shape `enableFingerprintFault` and `enableSyntheticVideo`
   * already use. That is not cosmetic: the TurboModule spec declares this, so
   * a method that existed only in DEBUG would leave the generated protocol
   * unconformed and fail the Release build outright. I wrote it the wrong way
   * round first; the Release build is what says so.
   */
  @objc public func runSharedCaptureSpike(
    legs: Int,
    seconds: Double,
    resolve: @escaping (Any?) -> Void
  ) {
    #if DEBUG
      SharedCaptureSpike.run(legs: legs, seconds: seconds) { json in resolve(json) }
    #else
      resolve("{\"error\":\"the capture spike is DEBUG-only and is not in this binary\"}")
    #endif
  }

  @objc public func getStats(cid: String, resolve: @escaping (Any?) -> Void) {
    Task {
      guard let pc = call(cid) else {
        resolve("{}")
        return
      }
      resolve(await pc.statsJson())
    }
  }

  @objc public func enableSyntheticVideo(_ on: Bool) {
    #if DEBUG
      syntheticVideo = on
    #endif
  }

  /// Fault injector: send a wrong `a=fingerprint` on the next offer or answer, so the
  /// DTLS handshake MUST fail. No-op in Release, where `FingerprintFault` does
  /// not exist.
  @objc public func enableFingerprintFault(_ on: Bool) {
    #if DEBUG
      fingerprintFault = on
    #endif
  }

  // MARK: - permissions

  @objc public func cameraPermission() -> String {
    Self.name(for: AVCaptureDevice.authorizationStatus(for: .video))
  }

  @objc public func micPermission() -> String {
    Self.name(for: AVCaptureDevice.authorizationStatus(for: .audio))
  }

  @objc public func requestPermissions(video: Bool, resolve: @escaping (Any?) -> Void) {
    Task {
      // Microphone first: an audio call is still a call, so a denied camera
      // must not stop us asking for the thing the call actually needs.
      _ = await AVCaptureDevice.requestAccess(for: .audio)
      if video { _ = await AVCaptureDevice.requestAccess(for: .video) }
      let result = ["camera": cameraPermission(), "mic": micPermission()]
      let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
      resolve(String(data: data, encoding: .utf8) ?? "{}")
    }
  }

  private static func name(for status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
  }

  // MARK: - emit

  fileprivate func send(_ event: String, _ payload: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
    let json = String(data: data, encoding: .utf8) ?? "{}"

    // Called from the CallKit main queue AND from libwebrtc's signaling
    // thread, so both the sink and the buffer are read under the lock.
    lock.lock()
    let sink = jsReady ? emit : nil
    if sink == nil {
      if pending.count >= Self.maxPending {
        // Drop the OLDEST: the newest events are the ones a late listener
        // still needs to act on, and the head of a queue this long is stale
        // by definition. Not logged with its payload — these carry cids.
        pending.removeFirst()
      }
      pending.append((event, json))
    }
    lock.unlock()

    // Outside the lock, for the same re-entrancy reason as the flush.
    sink?(event, json)
  }
}

// MARK: - device pressure

extension TacendumCallImpl {
  /**
   * Watch the pressure signals.
   *
   * All three are notification-driven rather than polled: a video call already
   * costs enough CPU without a timer waking to ask how hot the phone is, and
   * iOS coalesces these itself. Battery is the exception — there is no
   * "crossed 10%" notification, so it rides along on whichever of the other
   * two fires, plus the level-change notification the device posts as it
   * drains.
   *
   * `startMonitoringPressure` is called when a call starts rather than at
   * launch: battery monitoring has a real cost, and a phone that is not in a
   * call has nothing to reduce.
   */
  @objc public func startMonitoringPressure() {
    guard !monitoringPressure else { return }
    monitoringPressure = true

    // Must be on before `batteryLevel` returns anything but -1.
    DispatchQueue.main.async { UIDevice.current.isBatteryMonitoringEnabled = true }

    let center = NotificationCenter.default
    for name in [
      ProcessInfo.thermalStateDidChangeNotification,
      Notification.Name.NSProcessInfoPowerStateDidChange,
      UIDevice.batteryLevelDidChangeNotification,
    ] {
      // Kept by token: the only handle that can remove a block observer.
      pressureObservers.append(
        center.addObserver(
          forName: name, object: nil, queue: .main
        ) { [weak self] _ in
          self?.emitPressure()
        }
      )
    }
    // Once immediately: a call placed on an already-hot phone must start
    // capped rather than wait for the state to CHANGE, which it may not.
    emitPressure()
  }

  @objc public func stopMonitoringPressure() {
    guard monitoringPressure else { return }
    monitoringPressure = false
    // Each token, not `self`: these are block observers, and removing `self`
    // removed nothing — the handlers outlived the call and stacked up.
    let center = NotificationCenter.default
    for token in pressureObservers {
      center.removeObserver(token)
    }
    pressureObservers.removeAll()
    DispatchQueue.main.async { UIDevice.current.isBatteryMonitoringEnabled = false }
  }

  private func emitPressure() {
    let info = ProcessInfo.processInfo
    let thermal: String
    switch info.thermalState {
    case .nominal: thermal = "nominal"
    case .fair: thermal = "fair"
    case .serious: thermal = "serious"
    case .critical: thermal = "critical"
    @unknown default: thermal = "nominal"
    }
    // -1 means the device declines to say (Simulator, or monitoring not yet
    // live). Sent as null rather than as -1 so the policy can tell "unknown"
    // from "empty" — treating unknown as 0 would offer to drop every
    // Simulator call to voice.
    let level = UIDevice.current.batteryLevel
    var payload: [String: Any] = [
      "state": thermal,
      "lowPower": info.isLowPowerModeEnabled,
    ]
    payload["battery"] = level < 0 ? NSNull() : Double(level)
    send("thermalStateChanged", payload)
  }

  /// 0–3 bars for the quality indicator. 3 when there is no such call,
  /// so a sample racing a hangup cannot paint the last frame "poor".
  @objc public func sampleQuality(
    cid: String,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    guard let pc = call(cid) else {
      resolve(3)
      return
    }
    Task { resolve(await pc.sampleQuality()) }
  }

  /// Apply a pressure cap to a live call's encoder.
  @objc public func applyVideoCap(
    cid: String, maxLongEdge: Int, maxFps: Int,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    guard let pc = call(cid) else {
      // Not an error: a cap arriving for a call that has ended is ordinary.
      resolve(nil)
      return
    }
    pc.applyVideoCap(maxLongEdge: maxLongEdge, maxFps: maxFps)
    resolve(nil)
  }
}

extension TacendumCallImpl: CallEventSink {
  func iceCandidate(cid: String, sdp: String, mid: String, index: Int) {
    send("iceCandidate", ["cid": cid, "cand": sdp, "mid": mid, "idx": index])
  }

  func iceState(cid: String, state: String) {
    send("iceState", ["cid": cid, "state": state])
  }

  func connectionState(cid: String, state: String) {
    send("connectionState", ["cid": cid, "state": state])
  }

  func remoteTrack(cid: String, kind: String, added: Bool) {
    send(added ? "remoteTrackAdded" : "remoteTrackRemoved", ["cid": cid, "kind": kind])
  }
}

extension TacendumCallImpl: CallKitEventSink {
  func callKitAnswered(cid: String) { send("callKitAnswer", ["cid": cid]) }
  func callKitEnded(cid: String, reason: String) {
    send("callKitEnd", ["cid": cid, "reason": reason])
  }
  func callKitMuted(cid: String, muted: Bool) {
    send("callKitMute", ["cid": cid, "muted": muted])
  }
  func callKitAudioActivated() {
    // The route is APPLIED at activation (`didActivate`), so this is the
    // first moment the proximity rule can read it truthfully.
    refreshProximity()
    send("callKitAudioActivated", [:])
  }
  func callKitAudioDeactivated() { send("callKitAudioDeactivated", [:]) }
  /// `ringCid` — the placeholder ACTUALLY ringing for `from`, "" when none is,
  /// which on a second push for a peer already ringing is the FIRST ring's cid
  /// and not `cid`. JS needs that one to name a dismissal; `cid` would name a
  /// throwaway and match nothing.
  func voipPush(cid: String, from: String, ringCid: String) {
    send("voipPush", ["cid": cid, "from": from, "ringCid": ringCid])
  }
  func voipTokenUpdated(token: String) { emit?("voipTokenUpdated", token) }
}
