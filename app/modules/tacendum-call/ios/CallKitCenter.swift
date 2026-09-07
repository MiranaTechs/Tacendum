import AVFoundation
import CallKit
import Foundation
import PushKit
import WebRTC

/**
 * CallKit, PushKit, and the audio session.
 *
 * Experience calls the audio handshake "the most common source of 'the call
 * connects but there is no sound'", so the rule it specifies is followed
 * exactly and without exception:
 *
 *   `RTCAudioSession.useManualAudio = true`, and `isAudioEnabled` is driven
 *   ONLY by `provider(_:didActivate:)` and `provider(_:didDeactivate:)`.
 *
 * We configure the session and never activate it. CallKit owns activation, and
 * the WebRTC audio unit starts when CallKit says so — not when the call
 * connects, not when a track is added, not on a timer that usually works.
 *
 * The PushKit half implements the report-first-refine-second flow. iOS
 * terminates the app if a VoIP push does not produce a `reportNewIncomingCall`
 * essentially immediately, and the push deliberately carries no name — only
 * the ids the recipient could already derive — so the call is reported with a
 * placeholder and the display name is corrected once the envelope decrypts.
 * Reporting first is not a nicety; it is the difference between a ringing
 * phone and a killed process.
 */
@objc(CallKitCenter)
public final class CallKitCenter: NSObject {
  @objc public static let shared = CallKitCenter()

  private var provider: CXProvider?
  /// Guards `provider`'s check/create/store alone. A LEAF lock — nothing else
  /// is ever taken while it is held — and deliberately not `lock`: incoming
  /// reports first-touch the provider from PushKit's main queue while an
  /// outgoing start first-touches it from the TurboModule queue, and a
  /// cold-launch glare running both at once must not have to prove which map
  /// locks its call sites already hold. See `ensureProvider`.
  private let providerLock = NSLock()
  private let controller = CXCallController()
  private var voipRegistry: PKPushRegistry?
  private var voipToken = ""

  /**
   * Durable, install-local ownership for every native call surface.
   *
   * This deliberately lives in an atomic Application Support file rather
   * than the shared crypto directory: account deletion erases that directory,
   * and native must retain the explicit empty marker across a crash/relaunch
   * until JS adopts a real account again. An upgraded install with no file
   * starts empty and fails closed until its first adoption.
   */
  private static let accountOwnerStore = AccountCallOwnerStore.live()
  private let accountOwner = AccountCallOwner(
    initialOwner: CallKitCenter.accountOwnerStore.read()
  )

  /// cid ↔ CallKit UUID. CallKit speaks UUIDs; the protocol speaks ULIDs, and
  /// neither can be derived from the other.
  private var uuidByCid: [String: UUID] = [:]
  private var cidByUuid: [UUID: String] = [:]
  /// Incoming CallKit calls nobody has answered yet — through the system UI
  /// OR through the app. Guarded by `lock`, keyed by the CallKit UUID (which
  /// the rebind deliberately preserves, so membership survives it).
  ///
  /// This set exists because an IN-APP answer performs no CXAnswerCallAction
  /// on its own, and a CallKit call that is never answered never has its
  /// audio session activated: `didActivate` never fires, `isAudioEnabled`
  /// stays false, and the call connects with PERMANENTLY DEAD AUDIO in both
  /// directions — the audio handshake waiting forever for a step nobody was
  /// going to take. (The comments at `reportIncomingCall` and `pendingPush`
  /// long conceded the path existed; this is its closure.) `answerFromApp`
  /// consumes an entry to request the missing transaction exactly once;
  /// the system-UI answer consumes it so a later `createAnswer` on the same
  /// cid — an ICE restart, say — cannot re-answer a live call.
  private var unansweredIncoming: Set<UUID> = []
  /// Outgoing calls whose `connectedAt` has already been reported. Guarded by
  /// `lock`. Exists for one ordering guarantee: the `CXStartCallAction`
  /// perform reports `startedConnectingAt` AFTER its fulfill (Apple's
  /// canonical order), but the perform can arrive late — and CallKit must
  /// never hear "started connecting" about a call it was already told is
  /// connected, or about one a fast glare teardown has already ended. Entries
  /// leave in `forget` and on provider reset; incoming-only teardown paths
  /// (the placeholder watchdog, a push dismissal) never carry an outgoing
  /// UUID and so never need to.
  private var outgoingConnected: Set<UUID> = []
  private let lock = NSLock()

  /// Hears the audio unit's own start-failure report; see `audioUnitStartFailed`.
  private var audioUnitWatch: AudioUnitStartWatch?

  private override init() {
    super.init()
    // THE MANUAL-AUDIO GATE IS ARMED AT CONSTRUCTION, which is process start
    // for every path that can possibly matter: activation requires a
    // CXProvider, a CXProvider requires this singleton, and touching the
    // singleton runs this first. It used to be armed lazily in
    // `ensureFactory()` — the first createOffer/createAnswer of the process —
    // which on the CALLEE's first call of a launch is AFTER CallKit answers:
    // `didActivate` fired with `useManualAudio` still false, and the lazy arm
    // then wrote `isAudioEnabled = false` over an activation that will never
    // recur. The unit never started, the call was silent both ways, and only
    // hanging up and redialling — the second call of the process, gate
    // already armed — fixed it. Arming here makes the audio handshake
    // authoritative from the first call, not the second.
    armManualAudio()
    // And listen for the unit failing to START (see `audioUnitStartFailed`):
    // that failure was previously silent — no RTCAudioSessionDelegate was
    // registered anywhere in this module — and a start failure at activation
    // is a call that is silent until something forces the unit to re-init.
    let watch = AudioUnitStartWatch { [weak self] in self?.audioUnitStartFailed() }
    audioUnitWatch = watch
    RTCAudioSession.sharedInstance().add(watch)
  }

  private func accountBoundaryError() -> NSError {
    NSError(
      domain: "TacendumCall",
      code: 41,
      userInfo: [NSLocalizedDescriptionKey: "native calling has no current account"]
    )
  }

  /** A lease for direct JS call/media work. Empty ownership is denied. */
  func currentAccountLease() -> AccountCallLease? {
    accountOwner.currentLease()
  }

  /** A lease for a push, which must name the exact current recipient. */
  private func accountLease(for recipient: String) -> AccountCallLease? {
    accountOwner.lease(for: recipient)
  }

  func isCurrentAccountLease(_ lease: AccountCallLease) -> Bool {
    accountOwner.isCurrent(lease)
  }

  /**
   * Clear one account's native state before adopting another.
   *
   * Serialized on main with PushKit delivery and CallKit reporting. The owner
   * is invalidated and the empty value persisted first; only after CallKit,
   * queued events, and peer connections are cleared is a different nonempty
   * owner persisted. A same-owner call is intentionally a no-op.
   */
  @objc public func setAccountOwner(
    userId: String,
    completion: @escaping (Error?) -> Void
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async {
        self.setAccountOwner(userId: userId, completion: completion)
      }
      return
    }

    guard let change = accountOwner.beginChange(to: userId) else {
      completion(nil)
      return
    }

    // Persist denial before touching state. If the process dies during the
    // boundary, the next launch cannot resurrect the old account's calls.
    do {
      try Self.accountOwnerStore.write("")
    } catch {
      // Ownership is already denied in memory. End native state even though
      // JS will abort the account transition on this error; otherwise a live
      // old call could survive behind a bridge that now refuses to control it.
      clearCallsForAccountChange()
      TacendumCallImpl.shared.clearForAccountChange()
      completion(error)
      return
    }
    clearCallsForAccountChange()
    TacendumCallImpl.shared.clearForAccountChange()

    do {
      // Persist before publishing the in-memory owner. A failed write leaves
      // this process denied and setup fails until retry, rather than becoming
      // a false same-owner no-op. If atomic replacement completed before a
      // later fsync error, a relaunch may safely read the intended new owner.
      try Self.accountOwnerStore.write(change.owner)
    } catch {
      completion(error)
      return
    }
    accountOwner.finishChange(change)
    completion(nil)
  }

  private func clearCallsForAccountChange() {
    routeLock.lock()
    desiredSpeaker = false
    routeLock.unlock()

    lock.lock()
    let ids = Array(cidByUuid.keys)
    uuidByCid.removeAll()
    cidByUuid.removeAll()
    unansweredIncoming.removeAll()
    outgoingConnected.removeAll()
    pendingPush = nil
    pendingAnswered = false
    pendingPushConfirmed = false
    let parked = parkedRebind
    parkedRebind = nil
    cancelPlaceholderWatchdogLocked()
    lock.unlock()

    parked?.completion(accountBoundaryError())
    guard !ids.isEmpty else { return }
    let activeProvider = ensureProvider()
    for id in ids {
      activeProvider.reportCall(with: id, endedAt: nil, reason: .failed)
    }
  }

  /// `RTCAudioSession.useManualAudio = true`, `isAudioEnabled` low, exactly
  /// once. Idempotent, and a re-arm NEVER lowers `isAudioEnabled`: doing so
  /// after `didActivate` has raised it is the first-call clobber described in
  /// `init` above. `ensureFactory()` still calls this as belt-to-braces, but
  /// by then it is always a no-op — construction order guarantees the arm.
  func armManualAudio() {
    let session = RTCAudioSession.sharedInstance()
    guard !session.useManualAudio else { return }
    session.useManualAudio = true
    session.isAudioEnabled = false
  }

  /**
   * The call the VoIP push reported before anything could decrypt.
   *
   * The push carries no cid — the real one is inside the ciphertext, which is
   * the point of the design — so the ring goes up under a SYNTHETIC cid. The
   * two live device symptoms both fell out of forgetting that: the decrypted
   * offer later reported the REAL cid as a brand-new incoming call (a second
   * ring — the header banner over the full-screen placeholder), and the name
   * correction targeted a UUID CallKit had never seen (the ring stayed
   * "Incoming call"). `reportIncomingCall` rebinds instead: same CallKit
   * call, new key.
   */
  /// Whether this call wants the loudspeaker, and its own lock.
  ///
  /// Deliberately NOT under `lock`: that one is held across whole rebind
  /// decisions which themselves call `configureAudioSession`, and widening it
  /// to cover the route would be a re-entrant acquisition on a non-recursive
  /// lock. One Bool, one small lock, no interaction with the CallKit
  /// bookkeeping above.
  private let routeLock = NSLock()
  private var desiredSpeaker = false
  /// Whether CallKit has the session activated. Guards the route against a
  /// second call being REPORTED — a VoIP push, a glare offer — while the
  /// first one is talking. See `configureAudioSession`.
  private var audioActive = false
  /// Re-kicks spent on the CURRENT activation (guarded by `routeLock`, like
  /// the rest of the route state). One per activation: a unit that fails to
  /// start twice in a row is not going to be argued into it by a loop, and an
  /// unbounded retry against a session another app holds would spin forever.
  private var startFailureKicks = 0
  /// Which LOGICAL activation the route state describes (guarded by
  /// `routeLock`). Bumped once per genuine activation — the late real
  /// `didActivate` behind a simulator manual activation is the same one — so
  /// a start-failure re-kick in flight when a call ends and another activates
  /// can prove its failure belongs to the activation it is about to kick,
  /// rather than pulsing the NEXT call for the LAST call's failure.
  private var activationGeneration = 0
  #if targetEnvironment(simulator)
    /// The simulator fallback below activated the session MANUALLY (guarded
    /// by `routeLock`). CallKit never activated it, so CallKit will never
    /// deactivate it either — this flag is what obligates the symmetric
    /// teardown in `tearDownSimulatorActivationIfNeeded`.
    private var simulatorManualActivation = false
  #endif

  private var pendingPush: (cid: String, from: String)? = nil
  /// The person answered the placeholder before the offer decrypted. Parked,
  /// and replayed with the REAL cid the moment the rebind happens — emitting
  /// it with the synthetic cid sent JS looking for a stored offer under a key
  /// that never had one, and it ended the call the person just answered.
  private var pendingAnswered = false
  /// The push report's verdict has not returned yet. A rebind arriving in
  /// that window used to adopt a UUID CallKit was about to refuse — the
  /// refusal completion then found nothing to clean, nobody learned, and JS
  /// rang a call the callee could not see (with permanently dead audio on an
  /// in-app answer, since didActivate never fires for a call CallKit does
  /// not have). Unconfirmed rebinds are PARKED and re-driven by the verdict.
  private var pendingPushConfirmed = false
  /// The rebind that arrived while the verdict was in flight, as ARGS — not
  /// a closure. The verdict completion re-drives it through a single lock
  /// acquisition that re-checks the pending state, so a dismissal landing
  /// between "take" and "run" cannot make the re-drive fresh-report a call
  /// that was just cancelled. `completion` resolves the JS promise exactly
  /// once on every path.
  private struct ParkedRebind {
    let cid: String
    let peerId: String
    let handle: String
    let displayName: String
    let hasVideo: Bool
    let lease: AccountCallLease
    let completion: (Error?) -> Void
  }
  private var parkedRebind: ParkedRebind? = nil
  /**
   * Ends a placeholder nobody could ever answer or cancel.
   *
   * 75 seconds: the offer's 60-second ring TTL plus clock-skew slack — past
   * that, no legitimate answer path exists. Keyed on the CallKit UUID, which
   * the rebind deliberately PRESERVES, so the watchdog stays valid whether or
   * not the offer ever decrypted. Cancelled by answer, by end, and by
   * dismissal — anything that resolves the call like a call.
   */
  private var placeholderWatchdog: DispatchSourceTimer?
  /// Which call the watchdog guards, so an unrelated end cannot disarm it.
  private var placeholderWatchdogUuid: UUID?

  /// Watchdog fields are guarded by `lock` — the arm runs on whatever queue
  /// CallKit chooses for the report completion while every cancel runs on
  /// the TurboModule queue, and unsynchronized they raced: a cancel could
  /// no-op against a watchdog armed a microsecond later, which then killed
  /// the LIVE call at 75s. Callers that already hold the lock use the
  /// `-Locked` variants.
  private func armPlaceholderWatchdog(uuid: UUID) {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 75)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.placeholderWatchdog = nil
      self.placeholderWatchdogUuid = nil
      if let cid = self.cidByUuid[uuid] {
        if self.pendingPush?.cid == cid {
          self.pendingPush = nil
          self.pendingAnswered = false
          self.pendingPushConfirmed = false
        }
        self.uuidByCid.removeValue(forKey: cid)
        self.cidByUuid.removeValue(forKey: uuid)
        self.unansweredIncoming.remove(uuid)
        #if targetEnvironment(simulator)
          let empty = self.uuidByCid.isEmpty
        #endif
        self.lock.unlock()
        self.ensureProvider().reportCall(with: uuid, endedAt: nil, reason: .unanswered)
        #if targetEnvironment(simulator)
          // A pre-rebind answer armed the fallback; the rebind never came.
          if empty { self.tearDownSimulatorActivationIfNeeded() }
        #endif
      } else {
        self.lock.unlock()
      }
    }
    lock.lock()
    placeholderWatchdog?.cancel()
    placeholderWatchdogUuid = uuid
    placeholderWatchdog = timer
    lock.unlock()
    timer.resume()
  }

  private func cancelPlaceholderWatchdogLocked() {
    placeholderWatchdog?.cancel()
    placeholderWatchdog = nil
    placeholderWatchdogUuid = nil
  }

  private func cancelPlaceholderWatchdog() {
    lock.lock()
    cancelPlaceholderWatchdogLocked()
    lock.unlock()
  }

  /// Cancel only when the resolving call IS the guarded one — a stale
  /// `call.end` from a different peer, or an unrelated CallKit release, must
  /// not disarm the watchdog protecting a still-ringing placeholder.
  private func cancelPlaceholderWatchdog(ifGuarding uuid: UUID) {
    lock.lock()
    if placeholderWatchdogUuid == uuid { cancelPlaceholderWatchdogLocked() }
    lock.unlock()
  }

  /**
   * The saved display name for a peer, read from the App Group mirror.
   *
   * The app writes `peer-names` (a JSON object, ulid → name) alongside the
   * blocked-peers mirror; see app/src/nse.ts. Reading it here is what lets
   * the FIRST paint of the ring carry the caller's real name even when the
   * process was dead a moment ago — the app-side correction still runs later,
   * but it needs seconds the person is already spending looking at "Incoming
   * call".
   *
   * The group identifier is duplicated from SharedContainer.swift in the
   * crypto pod, which this pod cannot import. Both must match the
   * `com.apple.security.application-groups` entitlement; a mismatch does not
   * fail anything visibly — this simply reads nil and every ring falls back
   * to the placeholder.
   *
   * Nil before the first unlock after a reboot (file protection), in duress
   * (the app deletes the mirror), and for unknown callers. Every nil shows
   * the placeholder — never the raw ULID, which means nothing to anyone.
   */
  // Internal, not private: the missed-call notice (`TacendumCallImpl
  // .postMissedCall`) reads the same mirror when the JS side knows no name —
  // the locked phone's case, the one a missed call most often lands on.
  func mirroredName(for peerId: String) -> String? {
    guard !peerId.isEmpty,
          let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.miranatechnologies.tacendum"),
          let data = try? Data(contentsOf: container
            .appendingPathComponent("tacendum-shared", isDirectory: true)
            .appendingPathComponent("peer-names")),
          let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
          let name = map[peerId], !name.isEmpty
    else { return nil }
    return name
  }

  /**
   * Peers this device has blocked, read from the same App Group mirror.
   *
   * The alert half of this check lives in the notification-service extension
   * (`PreviewPolicy.blocked()`), and until this reader existed the mirror was
   * only HALF consulted: a blocked sender's message could not put their words
   * on the lock screen, but their `urgent` bit could still ring it
   * full-screen. Same file (`BLOCKED_FILE` in app/src/nse.ts), same format —
   * newline-separated ULIDs, rewritten whole so an unblock takes effect.
   *
   * Unlike `peer-names` above, this mirror deliberately SURVIVES relock and
   * duress — `retractSelfId` does not touch it — because the locked phone is
   * exactly where this reader does its work. Unreadable (no unlock since
   * reboot, container mismatch, no file yet) reads as EMPTY and the call
   * rings: a block is a policy this device knows about, and "cannot read the
   * policy" must degrade to an ordinary ring, not to a device no stranger's
   * call can reach.
   */
  private func blockedPeers() -> Set<String> {
    guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.miranatechnologies.tacendum"),
          let data = try? Data(contentsOf: container
            .appendingPathComponent("tacendum-shared", isDirectory: true)
            .appendingPathComponent("blocked-peers")),
          let text = String(data: data, encoding: .utf8)
    else { return [] }
    return Set(text.split(separator: "\n").map(String.init).filter { !$0.isEmpty })
  }

  weak var events: CallKitEventSink?

  // MARK: - provider

  private func ensureProvider() -> CXProvider {
    // CHECK/CREATE/STORE UNDER `providerLock`. Unsynchronized, a cold-launch
    // glare — an incoming report on PushKit's main queue racing an outgoing
    // start on the TurboModule queue, each of them the process's first
    // CallKit touch — could observe `provider == nil` twice and register TWO
    // CXProviders, where Apple's contract says one global provider per app.
    // Both "worked" until either one reset, at which point
    // `providerDidReset` cleared BOTH calls' bookkeeping.
    providerLock.lock()
    defer { providerLock.unlock() }
    if let p = provider { return p }
    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    // Generic, not phoneNumber: a Tacendum identity is not a phone number, and
    // handing CallKit a phone-shaped handle would put it in the system call
    // history where it does not belong.
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = false

    let p = CXProvider(configuration: config)
    p.setDelegate(self, queue: nil)
    provider = p
    return p
  }

  private func uuid(for cid: String) -> UUID {
    lock.lock()
    defer { lock.unlock() }
    if let existing = uuidByCid[cid] { return existing }
    let fresh = UUID()
    uuidByCid[cid] = fresh
    cidByUuid[fresh] = cid
    return fresh
  }

  private func cid(for uuid: UUID) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return cidByUuid[uuid]
  }

  /// The cid of the placeholder currently ringing FOR THIS CALLER, or "" when
  /// none is. Published on every voipPush so JS can name the exact placeholder
  /// a later verdict decided — a throwaway second-push cid never can, because
  /// `alreadyRinging` deliberately leaves `pendingPush` on the FIRST ring.
  ///
  /// CALLED WITH `lock` NOT HELD. `lock` is a plain NSLock and is not
  /// recursive; both emit sites reach here outside it, and that ordering is a
  /// hard requirement rather than a preference.
  private func ringingCid(for from: String) -> String {
    lock.lock()
    defer { lock.unlock() }
    guard let pending = pendingPush, pending.from == from else { return "" }
    return pending.cid
  }

  private func forget(cid: String) {
    lock.lock()
    if let uuid = uuidByCid.removeValue(forKey: cid) {
      cidByUuid.removeValue(forKey: uuid)
      unansweredIncoming.remove(uuid)
      outgoingConnected.remove(uuid)
    }
    #if targetEnvironment(simulator)
      let empty = uuidByCid.isEmpty
    #endif
    lock.unlock()
    #if targetEnvironment(simulator)
      // The LAST call is gone. If the simulator fallback activated the
      // session manually, nothing else will ever deactivate it — see
      // `tearDownSimulatorActivationIfNeeded`. Gated on empty so ending a
      // throwaway mapping (a second push's) cannot deactivate a live call.
      if empty { tearDownSimulatorActivationIfNeeded() }
    #endif
  }

  // MARK: - reporting

  @objc public func reportIncomingCall(
    cid: String,
    peerId: String,
    handle: String,
    displayName: String,
    hasVideo: Bool,
    completion: @escaping (Error?) -> Void
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async {
        self.reportIncomingCall(
          cid: cid, peerId: peerId, handle: handle,
          displayName: displayName, hasVideo: hasVideo,
          completion: completion
        )
      }
      return
    }
    guard let lease = currentAccountLease() else {
      completion(accountBoundaryError())
      return
    }
    // THE REBIND. If a VoIP push already rang this call under a synthetic
    // cid, this report is the decrypted offer catching up — the same call,
    // now with its real identity. Reporting it as NEW rang the phone twice
    // (banner over full-screen); instead the existing CallKit UUID is
    // re-keyed to the real cid and UPDATED in place, which is also what
    // makes the later name correction land and the cold-launch answer
    // rehydrate against a cid the stored offer actually uses.
    //
    // Matched on the caller, so two different people ringing in quick
    // succession cannot adopt each other's placeholder. An empty peerId
    // (an older JS layer) falls back to adopting the single pending call.
    lock.lock()
    guard accountOwner.isCurrent(lease) else {
      lock.unlock()
      completion(accountBoundaryError())
      return
    }
    if let pending = pendingPush, pending.from == peerId || peerId.isEmpty,
       !pendingPushConfirmed {
      // The report's verdict is STILL IN FLIGHT. Adopting now would re-key a
      // UUID CallKit may be about to refuse — the refusal completion then
      // finds nothing to clean, nobody learns, and JS rings a call the
      // callee cannot see. Park; the verdict completion re-drives this call
      // (success → the rebind below; refusal → pendingPush is cleared and
      // the re-entry takes the fresh path, earning its own honest verdict).
      // A previously parked rebind being overwritten must resolve its JS
      // promise first — losing it would hang the machine's report effect
      // forever. (In practice the machine refuses a second same-peer call
      // before it ever reaches here; this is the belt to that braces.)
      let displaced = parkedRebind
      parkedRebind = ParkedRebind(
        cid: cid, peerId: peerId, handle: handle,
        displayName: displayName, hasVideo: hasVideo,
        lease: lease,
        completion: completion
      )
      lock.unlock()
      displaced?.completion(nil)
      return
    }
    if let pending = pendingPush, pending.from == peerId || peerId.isEmpty,
       let existing = uuidByCid.removeValue(forKey: pending.cid) {
      uuidByCid[cid] = existing
      cidByUuid[existing] = cid
      pendingPush = nil
      pendingPushConfirmed = false
      let replayAnswer = pendingAnswered
      pendingAnswered = false
      lock.unlock()
      // The watchdog exists for the case where JS NEVER RUNS and nothing can
      // ever resolve the ring. The rebind is proof JS is alive — leaving the
      // timer armed here meant an IN-APP answer (which performs no
      // CXAnswerCallAction) hit the 75-second mark mid-call: CallKit was told
      // .unanswered, deactivated the audio session, and the call went silent.
      cancelPlaceholderWatchdog()

      let update = CXCallUpdate()
      // An empty displayName means JS has NO REAL NAME — its fallback is a
      // raw id, and stamping that over the mirror name this placeholder is
      // already showing is a downgrade. Consult the mirror; with nothing
      // there either, leave both fields unset — CXCallUpdate ignores unset
      // fields, so the ring keeps whatever it is showing.
      let resolved = displayName.isEmpty ? mirroredName(for: peerId) : displayName
      if let name = resolved, !name.isEmpty {
        update.remoteHandle = CXHandle(type: .generic, value: name)
        update.localizedCallerName = name
      }
      update.hasVideo = hasVideo
      // The fresh-report path configures the audio session; the rebind must
      // too, or a video call answered from the placeholder activates with
      // the voice route and the JS-side speaker toggle races it.
      configureAudioSession(video: hasVideo)
      ensureProvider().reportCall(with: existing, updated: update)
      // The answer that arrived while the offer was still decrypting, replayed
      // with the cid the rest of the system actually knows.
      if replayAnswer { events?.callKitAnswered(cid: cid) }
      completion(nil)
      return
    }
    lock.unlock()
    // The fresh report NEEDS a handle — CallKit shows it full-screen — so an
    // empty name from JS resolves through the mirror and then to the honest
    // placeholder, never to a raw id.
    let resolved = displayName.isEmpty ? (mirroredName(for: peerId) ?? "") : displayName
    let effective = resolved.isEmpty ? "Incoming call" : resolved
    reportFresh(
      cid: cid, handle: effective, displayName: effective,
      hasVideo: hasVideo, lease: lease, completion: completion
    )
  }

  /// Adopt the parked rebind — decided and re-keyed under ONE lock hold, so
  /// a dismissal cannot land between "take the parked value" and "act on
  /// it". Three outcomes, each resolving the parked JS promise exactly once:
  /// pending still confirmed → rebind (as if it had never parked); pending
  /// gone (dismissed while the verdict was in flight) → resolve WITHOUT
  /// reporting, because the call this rebind served no longer exists; no
  /// parked value → nothing to do.
  private func performParkedRebind() {
    lock.lock()
    guard let parked = parkedRebind else {
      lock.unlock()
      return
    }
    parkedRebind = nil
    guard accountOwner.isCurrent(parked.lease),
          let pending = pendingPush, pendingPushConfirmed,
          pending.from == parked.peerId || parked.peerId.isEmpty,
          let existing = uuidByCid.removeValue(forKey: pending.cid)
    else {
      lock.unlock()
      parked.completion(nil)
      return
    }
    uuidByCid[parked.cid] = existing
    cidByUuid[existing] = parked.cid
    pendingPush = nil
    pendingPushConfirmed = false
    let replayAnswer = pendingAnswered
    pendingAnswered = false
    lock.unlock()
    cancelPlaceholderWatchdog()
    let update = CXCallUpdate()
    let resolved = parked.displayName.isEmpty
      ? mirroredName(for: parked.peerId) : parked.displayName
    if let name = resolved, !name.isEmpty {
      update.remoteHandle = CXHandle(type: .generic, value: name)
      update.localizedCallerName = name
    }
    update.hasVideo = parked.hasVideo
    configureAudioSession(video: parked.hasVideo)
    ensureProvider().reportCall(with: existing, updated: update)
    if replayAnswer { events?.callKitAnswered(cid: parked.cid) }
    parked.completion(nil)
  }

  /// The unconditional new-call report. Separate from `reportIncomingCall` so
  /// the PUSH path can use it directly: a second VoIP push for the same
  /// caller (a cancellation is urgent too) must satisfy PushKit's report
  /// obligation WITHOUT entering the rebind — matching there would re-key the
  /// genuinely ringing call onto a throwaway cid and orphan it.
  private func reportFresh(
    cid: String,
    handle: String,
    displayName: String,
    hasVideo: Bool,
    lease: AccountCallLease,
    completion: @escaping (Error?) -> Void
  ) {
    let update = CXCallUpdate()
    // The HANDLE is what the full-screen incoming-call UI shows. The banner
    // shows `localizedCallerName`, which is why setting only that looked
    // correct on a notification and still announced a raw ULID full-screen.
    //
    // A Tacendum identity is not a phone number, so there is no addressable
    // handle to fall back on — the id is not something anyone can dial or
    // recognise. The name is the only value that means anything to a person,
    // and it goes in both places. The id remains the key CallKit is looked up
    // by internally (`uuid(for: cid)`), so nothing depends on it being here.
    update.remoteHandle = CXHandle(
      type: .generic,
      value: displayName.isEmpty ? handle : displayName
    )
    update.localizedCallerName = displayName
    update.hasVideo = hasVideo
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    configureAudioSession(video: hasVideo)
    // Every fresh incoming report starts UNANSWERED; the system-UI answer or
    // `answerFromApp` consumes the entry, and every path that drops the
    // cid↔UUID mapping drops it too. Inserted BEFORE the report so an answer
    // racing the verdict cannot miss it; removed on refusal, where there is
    // no CallKit call to ever answer.
    lock.lock()
    guard accountOwner.isCurrent(lease) else {
      lock.unlock()
      completion(accountBoundaryError())
      return
    }
    let id: UUID
    if let existing = uuidByCid[cid] {
      id = existing
    } else {
      id = UUID()
      uuidByCid[cid] = id
      cidByUuid[id] = cid
    }
    unansweredIncoming.insert(id)
    lock.unlock()
    ensureProvider().reportNewIncomingCall(with: id, update: update) { [weak self] error in
      // Account changes and PushKit entry are main-serialized. Bring CallKit's
      // asynchronous verdict onto that same queue before its generation check
      // so it cannot pass the check and then race a clear before touching maps
      // or driving the push callback.
      DispatchQueue.main.async {
        guard let self else {
          completion(error)
          return
        }
        if !self.accountOwner.isCurrent(lease) {
          self.lock.lock()
          if self.cidByUuid[id] == cid {
            self.cidByUuid.removeValue(forKey: id)
            self.uuidByCid.removeValue(forKey: cid)
          }
          self.unansweredIncoming.remove(id)
          self.lock.unlock()
          self.ensureProvider().reportCall(with: id, endedAt: nil, reason: .failed)
          completion(self.accountBoundaryError())
          return
        }
        if error != nil {
          self.lock.lock()
          self.unansweredIncoming.remove(id)
          self.lock.unlock()
        }
        completion(error)
      }
    }
  }

  /**
   * Fulfil iOS's one-report-per-VoIP-push obligation for an unauthorized
   * recipient without adopting any call state or waking JavaScript.
   */
  private func reportRejectedPush(
    completion: @escaping () -> Void
  ) {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: "Incoming call")
    update.localizedCallerName = "Incoming call"
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    // Ephemeral by design: no cid↔UUID mapping, unanswered marker, pending
    // push, parked answer, or event can cross this account boundary.
    let id = UUID()
    let activeProvider = ensureProvider()
    activeProvider.reportNewIncomingCall(with: id, update: update) { _ in
      activeProvider.reportCall(with: id, endedAt: nil, reason: .unanswered)
      completion()
    }
  }

  /**
   * The CallKit half of an IN-APP answer (the dead-audio-at-connect fix).
   *
   * Answering from this app's own incoming-call screen used to perform no
   * CXAnswerCallAction — nothing in the module could — so CallKit sat on a
   * reported call nobody ever answered: it never activated the audio session,
   * `didActivate` never fired, and under the manual-audio rule the WebRTC
   * unit therefore NEVER STARTED. The call connected with dead audio in both
   * directions (this device neither captured nor played), CallKit's own
   * bookkeeping showed a still-ringing call, and only a redial survived it.
   *
   * Called from the native `createAnswer` bridge method — the one funnel every
   * accept path crosses (in-app accept, glare adoption; see `unansweredIncoming`
   * for why a system-UI answer or an ICE restart cannot double-answer here).
   * Consuming the set entry under one lock hold makes the transaction
   * single-shot — and a REFUSED transaction puts the entry back, because a
   * refusal answered nothing: consuming it for good made an in-app accept
   * that raced a still-completing report verdict (unknownCallUUID) terminal —
   * no answered CallKit call, no `didActivate`, and nothing left for the
   * next `createAnswer` to answer. The action lands in our own `CXAnswerCallAction` handler,
   * which emits `callKitAnswered` upward — the reducer is already past
   * `incoming_ringing` by then and drops it, which is the idempotence the
   * JS side has always had.
   */
  @objc public func answerFromApp(cid: String) {
    lock.lock()
    guard let id = uuidByCid[cid], unansweredIncoming.remove(id) != nil else {
      lock.unlock()
      return
    }
    lock.unlock()
    controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { [weak self] error in
      guard error != nil else { return }
      // No cid, no interpolated error text (addendum 8): the code is enough
      // to know the transaction was refused, and refusal leaves behaviour
      // exactly as it was before this method existed.
      NSLog("[call] in-app answer transaction refused")
      // THE ENTRY GOES BACK (doc comment above): the refusal answered
      // nothing, so the call is still unanswered and the next `createAnswer`
      // through the funnel — an ICE restart's, say — must be able to request
      // the transaction again. Re-inserted only while the mapping still
      // exists: every teardown drops the mapping and the set entry together,
      // and re-adding an entry for a dropped mapping would leak it forever.
      // (A refusal because the system UI answered first re-arms too; the
      // re-request that could follow is refused the same way — bounded, and
      // strictly better than a live call held un-re-answerable.)
      guard let self else { return }
      self.lock.lock()
      if self.cidByUuid[id] != nil { self.unansweredIncoming.insert(id) }
      self.lock.unlock()
    }
    #if targetEnvironment(simulator)
      armSimulatorActivationFallback(uuid: id)
    #endif
  }

  /// Correct the placeholder once the envelope has decrypted.
  ///
  /// Both fields, for the reason above: a VoIP wake rings before anything has
  /// decrypted, so the first report carries a placeholder name and the id as
  /// its handle. Updating only the name left the full-screen UI — the surface
  /// someone actually looks at while deciding whether to answer — still
  /// showing the id.
  @objc public func updateDisplay(cid: String, displayName: String) {
    guard !displayName.isEmpty else { return }
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: displayName)
    update.localizedCallerName = displayName
    ensureProvider().reportCall(with: uuid(for: cid), updated: update)
  }

  @objc public func reportOutgoingCall(cid: String, handle: String, hasVideo: Bool) {
    // PROVIDER FIRST: a `CXStartCallAction` transaction submitted into a
    // process with no registered CXProvider — the fresh-launch caller, whose
    // first CallKit touch is this very method — can be refused outright. The
    // answer leg has always ensured the provider before it transacts; the
    // caller leg now does the same, before the action is even built.
    _ = ensureProvider()
    let id = uuid(for: cid)
    let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: handle))
    // `hasVideo` was hard-coded false here while every incoming path passed
    // the truth. Two things were wrong with that. CallKit recorded every
    // outgoing video call as a voice call — the wrong entry in Recents, and
    // the wrong thing to redial. And the session was configured for a voice
    // call, so it came up WITHOUT `.defaultToSpeaker` and landed on the
    // earpiece: a video call you place is exactly the one that has to be
    // audible from arm's length.
    action.isVideo = hasVideo
    configureAudioSession(video: hasVideo)
    controller.request(CXTransaction(action: action)) { [weak self] error in
      guard error != nil else { return }
      // The caller-side mirror of the in-app answer refusal above. No cid, no
      // interpolated error text (addendum 8): the constant is enough to know
      // the start transaction was refused. No retry loop either.
      NSLog("[call] outgoing start transaction refused")
      // And HANDLED, the way the answer leg restores its state on refusal:
      // this leg gives the call back. CallKit never accepted the start, so a
      // surviving mapping described a call the system does not have —
      // `reportOutgoingConnected` reported into it, no perform and therefore
      // no `didActivate` ever came, and the caller sat "connected" and DEAF
      // while the peer's phone kept ringing, until a timeout. The existing
      // ended event tears the JS call down honestly (the reducer ends a call
      // from any state, cancelling the offer toward the peer), and `forget`
      // drops the phantom mapping — which also stands the just-armed
      // simulator fallback down, since the timer fires only while its UUID
      // is still mapped.
      guard let self else { return }
      self.events?.callKitEnded(cid: cid, reason: "failed")
      self.forget(cid: cid)
    }
    // Unconditional, mirroring the answer leg: the perform handler also arms
    // this, but a REFUSED transaction never reaches the perform, and the
    // fallback is idempotent — it self-aborts when audio is already active
    // and fires only while this uuid is still mapped.
    #if targetEnvironment(simulator)
      armSimulatorActivationFallback(uuid: id)
    #endif
    // `startedConnectingAt` is NOT reported here: Apple's canonical order
    // reports it from the `CXStartCallAction` perform, after `fulfill()` —
    // see `provider(_:perform: CXStartCallAction)`. Reporting it here, pre-
    // perform, described a call CallKit had not yet accepted as started.
  }

  @objc public func reportOutgoingConnected(cid: String) {
    // LOOKUP, never create — the rule `endCall` below states: JS can report a
    // connect for a call CallKit no longer has (a refused start already gave
    // the mapping back; a glare teardown already ended it), and minting a
    // UUID here just to report it connected recreated the exact phantom the
    // refusal path cleans up.
    //
    // HOPPED TO MAIN, where the `CXStartCallAction` perform runs: both
    // outgoing reports are then submitted from one serial queue, so
    // `connectedAt` can never overtake `startedConnectingAt` mid-flight —
    // and when this block genuinely runs first (fast ICE while a busy main
    // thread delays the perform), the perform finds `outgoingConnected` and
    // skips its started report instead of describing a connected call as
    // merely starting.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let found = self.uuidByCid[cid]
      if let id = found { self.outgoingConnected.insert(id) }
      self.lock.unlock()
      guard let id = found else { return }
      self.ensureProvider().reportOutgoingCall(with: id, connectedAt: nil)
    }
  }

  @objc public func endCall(cid: String, reason: String) {
    // LOOKUP, never create: JS tears calls down that CallKit sometimes never
    // had (a report refused, a mapping already forgotten by the provider's
    // own end handler) — minting a UUID here just to report it ended left a
    // phantom mapping and a meaningless end transaction.
    lock.lock()
    let found = uuidByCid[cid]
    lock.unlock()
    guard let id = found else { return }
    cancelPlaceholderWatchdog(ifGuarding: id)
    ensureProvider().reportCall(with: id, endedAt: nil, reason: Self.endedReason(for: reason))
    // Also end our side of the transaction, or CallKit keeps the call alive
    // in its own bookkeeping and the next one is refused as "already active".
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    forget(cid: cid)
  }

  private static func endedReason(for reason: String) -> CXCallEndedReason {
    switch reason {
    case "decline", "busy": return .remoteEnded
    case "timeout", "expired", "cancelled": return .unanswered
    case "failed_ice", "failed_media": return .failed
    default: return .remoteEnded
    }
  }

  // MARK: - audio session

  /// CONFIGURE only. Activation belongs to CallKit; activating here is the bug
  /// this whole section exists to prevent.
  private func configureAudioSession(video: Bool) {
    // A LIVE CALL OWNS THE ROUTE, and a second call being reported must not
    // take it away.
    //
    // Every path that reports a call reaches this method, INCLUDING a VoIP
    // push arriving while a call is already up — and that one reports before
    // anything has decrypted, so it necessarily says `hasVideo: false`.
    // Reconfiguring on its behalf rewrote the live call's category, which on
    // an active session re-evaluates the route: a video call dropped to the
    // earpiece because someone else rang. The push may then be declined as
    // busy and never activate anything, so nothing would have put it back.
    //
    // The ANSWER IS STILL RECORDED, and only the session write is skipped.
    // Skipping both looked safer and was worse: hanging up a video call and
    // immediately placing a voice one reports the new call before CallKit has
    // deactivated the old session, so the record was skipped and the voice
    // call activated on the loudspeaker it inherited — under a UI that said
    // "speaker off". A record cannot disturb a live call, because nothing
    // reads it until the next activation, and the next activation belongs to
    // whichever call wrote it last.
    //
    // KNOWN RESIDUAL, and the trade is deliberate: if a live video call is
    // INTERRUPTED (a cellular call takes the session) after a refused push
    // wrote `false` here, it resumes on the earpiece, because its resumption
    // is an activation that reads this value. That needs a second call to
    // arrive AND be refused AND an interruption to follow, and one tap of the
    // speaker button corrects it — where the alternative it replaced was an
    // ordinary voice call, placed straight after a video one, coming up loud.
    routeLock.lock()
    desiredSpeaker = video
    let active = audioActive
    routeLock.unlock()
    guard !active else { return }

    applyCategory(speaker: video)
  }

  /**
   * Remember the route AND apply it.
   *
   * The remembering is half the fix. `overrideOutputAudioPort` only means
   * anything on an ACTIVE session, and this is called before CallKit
   * activates one: the controller asks for the speaker the moment a video
   * call gets a cid, which is while the call is still ringing. The override
   * was discarded, the session came up on the receiver — and the UI, which
   * had already recorded "speaker on", said so. Hence the live symptom: a
   * video call whose audio comes out of the earpiece under a lit speaker
   * button, fixed by toggling it off and on again, because by then the
   * session was active and the second override landed.
   *
   * So the desire is stored, and `didActivate` applies it at the first moment
   * it can mean anything. Applying it here too is not redundant: a mid-call
   * tap is the case where the session IS already active and must take effect
   * now rather than at an activation that may never come.
   */
  @objc public func setSpeaker(_ on: Bool) {
    routeLock.lock()
    let unchanged = desiredSpeaker == on
    desiredSpeaker = on
    routeLock.unlock()
    // A REPEAT of a route the session already carries is swallowed WITHOUT
    // touching the session. JS re-asserts the speaker the moment
    // `didActivate` reaches it — deliberately, as recovery for a request
    // lost before activation — and that event fires immediately after the
    // audio unit is allowed to start. Re-applying an already-satisfied
    // route there would put a category write (and the override clear) back
    // in the unit's start instant: the same multi-writer race
    // `didActivate`'s route-before-enable ordering exists to remove. A
    // LOST request (`desiredSpeaker` stale) or a DRIFTED session
    // (libwebrtc rewrote the config) falls through and is applied — the
    // recovery the re-assert exists for — and a wedged unit is not this
    // path's job: `audioUnitStartFailed` owns that re-kick.
    if unchanged && sessionCarriesRoute(speaker: on) { return }
    applyOutputRoute()
  }

  /// Whether the session's LIVE configuration already expresses this route —
  /// exactly the three fields `applyCategory` would write, so "carries" here
  /// means "applying would change nothing".
  private func sessionCarriesRoute(speaker: Bool) -> Bool {
    var options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
    if speaker { options.insert(.defaultToSpeaker) }
    let session = RTCAudioSession.sharedInstance()
    return session.category == AVAudioSession.Category.playAndRecord.rawValue
      && session.mode == AVAudioSession.Mode.voiceChat.rawValue
      && session.categoryOptions == options
  }

  /// Push the recorded route at the session. Before activation this still
  /// leaves the category correct, which is what makes the route come up right
  /// the first time rather than after a toggle.
  private func applyOutputRoute() {
    routeLock.lock()
    let speaker = desiredSpeaker
    routeLock.unlock()
    applyCategory(speaker: speaker)
  }

  /**
   * THE ROUTE IS EXPRESSED AS A CATEGORY OPTION, NOT AS A FORCED OVERRIDE.
   *
   * `overrideOutputAudioPort(.speaker)` is a *forced* transient route: it
   * seizes the built-in speaker and microphone even when headphones or a
   * Bluetooth headset are connected, so applying it for every video call
   * would yank a conversation out of someone's AirPods. `.defaultToSpeaker`
   * is the other mechanism Apple documents (QA1754) — it changes which
   * BUILT-IN device is the default, speaker instead of receiver, and leaves
   * an attached accessory as the route it already was.
   *
   * The two must not be mixed, and mixing them is its own bug: with
   * `.defaultToSpeaker` in the category, "speaker off" via
   * `overrideOutputAudioPort(.none)` returns to the category default — which
   * is still the speaker. The button would have done nothing on exactly the
   * calls it exists for.
   *
   * So the option carries the answer in both directions and the override is
   * cleared, which lets the category decide. Four cases, all correct:
   * speaker wanted with no accessory → loudspeaker; not wanted → earpiece;
   * either, with headphones or Bluetooth → the accessory, untouched.
   */
  private func applyCategory(speaker: Bool) {
    var options: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
    if speaker { options.insert(.defaultToSpeaker) }

    // AND LIBWEBRTC'S OWN CONFIGURATION, or it undoes this the next time it
    // initializes the audio unit. `AudioDeviceIOS::UpdateAudioUnit` calls
    // `ConfigureAudioSession()` -> `-[RTCAudioSession configureWebRTCSession:]`,
    // which applies `RTCAudioSessionConfiguration.webRTCConfiguration`
    // wholesale — and its stock value is `.playAndRecord`/`.voiceChat`/
    // `[.allowBluetooth]`, with NO `.defaultToSpeaker`. It runs on libwebrtc's
    // own audio thread, so for a call answered from the ring it lands just
    // AFTER `didActivate` applied the route here, and the loudspeaker silently
    // became the earpiece under a lit button — on both phones, cured only by
    // toggling the button off and on, because by then the audio unit is
    // already initialized and nothing reconfigures.
    //
    // This is written HERE, and only here, because `speaker` is the per-call
    // value `desiredSpeaker` — `configureAudioSession(video:)` re-derives it
    // on every report. A copy of this kept anywhere with a lifetime longer
    // than a call would latch: the singleton below is process-global, so a
    // stale `true` left behind by a video call makes the NEXT voice or room
    // call come out of the loudspeaker under a dark button. The two option
    // sets must stay identical or the two writers overwrite each other again.
    let webrtc = RTCAudioSessionConfiguration()
    webrtc.category = AVAudioSession.Category.playAndRecord.rawValue
    webrtc.mode = AVAudioSession.Mode.voiceChat.rawValue
    webrtc.categoryOptions = options
    RTCAudioSessionConfiguration.setWebRTC(webrtc)

    let session = RTCAudioSession.sharedInstance()
    session.lockForConfiguration()
    defer { session.unlockForConfiguration() }
    do {
      // ONLY WHEN IT WOULD CHANGE SOMETHING. Setting the category on an
      // active session re-evaluates the route immediately, which can clip the
      // first moment of a call — and `didActivate` calls through here on
      // every call, where the ordinary case is that the report already
      // configured exactly these options. Apple's own guidance is to
      // configure before activation; this keeps the re-application for the
      // case that needs it, which is a route asked for after configuration
      // and before activation.
      if session.category != AVAudioSession.Category.playAndRecord.rawValue
        || session.categoryOptions != options
        || session.mode != AVAudioSession.Mode.voiceChat.rawValue {
        try session.setCategory(.playAndRecord, with: options)
        try session.setMode(.voiceChat)
      }
      // Clear any earlier forced override so the category is what governs.
      // Without this a session that had once been forced to the speaker would
      // stay there no matter what the option said.
      try session.overrideOutputAudioPort(.none)
    } catch {
      // Non-fatal: CallKit may still activate a usable session. Failing the
      // call here would turn a possibly-degraded route into no call at all.
      NSLog("[call] audio session configuration failed: \(error)")
    }
  }

  // MARK: - PushKit

  @objc public func registerForVoipPush() {
    guard voipRegistry == nil else { return }
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    voipRegistry = registry
  }

  @objc public func currentVoipToken() -> String { voipToken }

  /**
   * Dismiss the placeholder a VoIP push rang, when the decrypted truth says
   * it must not ring: the caller is blocked or silenced (`mayCall` declined
   * AFTER the push already rang — the ring came up before anything could
   * decrypt), or the frame behind the push turned out to be a cancellation
   * (`call.end` is urgent too, and a push is a push).
   *
   * Matched on the caller for the same reason the rebind is; empty matches
   * whatever is pending. A dismissal with nothing pending is a no-op — the
   * ordinary path, since most declines happen after the rebind, where the
   * call has a real cid and the ordinary endCall handles it.
   *
   * AND MATCHED ON THE PLACEHOLDER ITSELF. `cid` names the ring the caller
   * decided about; a verdict that lands after this peer's placeholder was
   * replaced is a strict no-op instead of ending a ring it never decided —
   * and ending one is expensive here, because the body below clears
   * `pendingAnswered` (an answer the person already tapped) and abandons a
   * parked rebind (a call that then never re-rings). An empty `cid` degrades
   * to the caller-keyed match above, which is what a JS build older than this
   * signature sends and what makes the skew safe in that direction.
   *
   * DELIBERATELY NOT REFUSED: an ANSWERED placeholder, or one with a parked
   * rebind. When the cancellation is genuine, refusing would leave the person
   * in a silent "connected" call until the 75-second watchdog. The answer is
   * to make the dismissal correct, not to make it timid.
   */
  @objc public func dismissPendingIncomingCall(peerId: String, reason: String, cid: String) {
    lock.lock()
    guard let pending = pendingPush,
          peerId.isEmpty || pending.from == peerId,
          cid.isEmpty || pending.cid == cid else {
      // NOT cancelled above the guard: the controller dismisses on every
      // decrypted call.end, and a stale end from peer A must not disarm the
      // watchdog guarding peer B's still-ringing placeholder.
      lock.unlock()
      return
    }
    cancelPlaceholderWatchdogLocked()
    pendingPush = nil
    pendingAnswered = false
    pendingPushConfirmed = false
    // A rebind parked on this pending call must not be re-driven later —
    // the call is being dismissed; a re-drive would FRESH-report it and
    // ring a cancelled call. Abandon resolves the JS promise instead.
    let parked = parkedRebind
    parkedRebind = nil
    let uuid = uuidByCid.removeValue(forKey: pending.cid)
    if let uuid {
      cidByUuid.removeValue(forKey: uuid)
      unansweredIncoming.remove(uuid)
    }
    #if targetEnvironment(simulator)
      let empty = uuidByCid.isEmpty
    #endif
    lock.unlock()
    parked?.completion(nil)
    #if targetEnvironment(simulator)
      // The dismissed placeholder can have been ANSWERED pre-rebind, which
      // armed the fallback — the manual activation must not outlive it.
      if empty { tearDownSimulatorActivationIfNeeded() }
    #endif
    guard let uuid else { return }
    let why: CXCallEndedReason = reason == "cancelled" ? .remoteEnded : .unanswered
    ensureProvider().reportCall(with: uuid, endedAt: nil, reason: why)
  }
}

// MARK: - CXProviderDelegate

extension CallKitCenter: CXProviderDelegate {
  public func providerDidReset(_ provider: CXProvider) {
    // The route state goes FIRST, before the CallKit bookkeeping below.
    //
    // The two cannot be cleared under one lock — they are guarded by
    // different ones, and nesting them is the deadlock this file's second
    // lock exists to avoid — so there is a window either way. Clearing the
    // route first puts that window BEFORE the reset is processed rather than
    // after it: a call reported in it is one CallKit already considers gone,
    // whereas a call reported after it keeps the route it asks for.
    //
    // `audioActive` in particular: a reset while activated never produces the
    // `didDeactivate` that would clear it, and a stranded `true` makes every
    // later call skip its own audio configuration and inherit this one's
    // route forever.
    routeLock.lock()
    audioActive = false
    desiredSpeaker = false
    #if targetEnvironment(simulator)
      // Ownership dies with the reset, or a stale flag would let a LATER
      // call's teardown deactivate the session that call is still using.
      // The activation count the manual activation holds is stranded here —
      // the same residual a reset-while-activated has always had on device,
      // where CallKit's own `didDeactivate` never comes either.
      simulatorManualActivation = false
    #endif
    routeLock.unlock()

    // The system tore everything down. Every call we thought we had is gone.
    lock.lock()
    let cids = Array(uuidByCid.keys)
    uuidByCid.removeAll()
    cidByUuid.removeAll()
    unansweredIncoming.removeAll()
    outgoingConnected.removeAll()
    pendingPush = nil
    pendingAnswered = false
    lock.unlock()
    cancelPlaceholderWatchdog()
    for cid in cids { events?.callKitEnded(cid: cid, reason: "failed") }
  }

  public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    // ONE lock hold from UUID resolution through the parking decision. The
    // review's counterexample for the old resolve-release-recheck: the rebind
    // re-keys this UUID in the gap, so the answer resolved the SYNTHETIC cid,
    // then found pendingPush already cleared, and emitted the synthetic cid —
    // JS rehydrated no offer under it and ended the call the person just
    // answered. Held across both, the answer sees strictly-before (parked,
    // replayed by the rebind) or strictly-after (the real cid) — never the
    // seam between them.
    lock.lock()
    guard let cid = cidByUuid[action.callUUID] else {
      lock.unlock()
      action.fail()
      return
    }
    // Answered — by the system UI, or by the transaction `answerFromApp`
    // requested. Consumed under the SAME lock hold that resolved the cid, so
    // a `createAnswer` for this call arriving later (an ICE restart) finds
    // nothing left to answer.
    unansweredIncoming.remove(action.callUUID)
    if pendingPush?.cid == cid {
      // Answered before the offer decrypted. Park it; the rebind replays it
      // with the real cid. The watchdog stays ARMED on purpose: a parked
      // answer whose offer never arrives is exactly a ring nothing can
      // resolve, and the rebind cancels it the moment it proves JS alive.
      pendingAnswered = true
      lock.unlock()
      action.fulfill()
      #if targetEnvironment(simulator)
        armSimulatorActivationFallback(uuid: action.callUUID)
      #endif
      return
    }
    lock.unlock()
    cancelPlaceholderWatchdog(ifGuarding: action.callUUID)
    events?.callKitAnswered(cid: cid)
    action.fulfill()
    #if targetEnvironment(simulator)
      armSimulatorActivationFallback(uuid: action.callUUID)
    #endif
  }

  public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    // Correlated, like the answer action above and `endCall` below. `endCall`
    // reports the end and THEN requests this action, forgetting the mapping in
    // between — so by the time we are asked to perform it the `cid(for:)`
    // lookup below usually misses and everything after it is dead. An
    // uncorrelated cancel here would leave "disarm whatever watchdog happens
    // to be armed" as this action's only surviving effect, which after a
    // hang-up followed by a fresh push is a DIFFERENT placeholder's 75-second
    // failsafe — the one cover that survives JS never running at all.
    cancelPlaceholderWatchdog(ifGuarding: action.callUUID)
    if let cid = cid(for: action.callUUID) {
      lock.lock()
      if pendingPush?.cid == cid {
        pendingPush = nil
        pendingAnswered = false
      }
      lock.unlock()
      events?.callKitEnded(cid: cid, reason: "hangup")
      forget(cid: cid)
    }
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let cid = cid(for: action.callUUID) {
      events?.callKitMuted(cid: cid, muted: action.isMuted)
    }
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    action.fulfill()
    // Apple's canonical order: `startedConnectingAt` is reported FROM the
    // perform, after the fulfill — not from `reportOutgoingCall` before the
    // transaction was even accepted. A refused transaction therefore never
    // reports a connection that is not being attempted.
    //
    // GUARDED, because this perform can arrive late. A fast glare teardown
    // may already have forgotten and ended the call — reporting a dead call
    // as starting — and `reportOutgoingConnected`, serialized with this
    // handler on the main queue, may already have reported it connected;
    // started-after-connected runs CallKit's outgoing state machine
    // backwards. Connected-without-started is the tolerated direction.
    lock.lock()
    let startable = cidByUuid[action.callUUID] != nil
      && !outgoingConnected.contains(action.callUUID)
    lock.unlock()
    if startable {
      provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
    }
    #if targetEnvironment(simulator)
      armSimulatorActivationFallback(uuid: action.callUUID)
    #endif
  }

  /// The ONLY place the WebRTC audio unit starts.
  public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    let session = RTCAudioSession.sharedInstance()
    routeLock.lock()
    let alreadyActive = audioActive
    audioActive = true
    if !alreadyActive {
      // One kick budget and one generation per LOGICAL activation: the late
      // real `didActivate` behind a simulator manual activation is the same
      // activation, and resetting the budget for it let one activation spend
      // two kicks.
      activationGeneration &+= 1
      startFailureKicks = 0
    }
    routeLock.unlock()
    // Guarded for the one path that can arrive here twice: the simulator
    // fallback below activated manually and CallKit's real `didActivate`
    // landed later. `audioSessionDidActivate` counts activations, so a second
    // call would strand the count and unbalance the eventual deactivate.
    if !alreadyActive {
      session.audioSessionDidActivate(audioSession)
    }
    // THE ROUTE IS APPLIED HERE, not where it was asked for. Every request
    // that arrived before this moment — and for a video call that is all of
    // them, since the controller asks as soon as the call has a cid — landed
    // on a session that was not active yet. This is the first instant at
    // which the route means anything, so it is where the answer the call has
    // been carrying gets used.
    //
    // AND IT IS APPLIED BEFORE THE UNIT IS ALLOWED TO START. The old order —
    // enable first, route second — had three writers landing
    // on the session in the same instant: the VoiceProcessing unit's own
    // init/start on libwebrtc's audio thread, this method's setCategory and
    // unconditional `overrideOutputAudioPort(.none)` on the CallKit queue,
    // and libwebrtc's `configureWebRTCSession` just behind both. A category
    // write racing the unit's start can fail it ('!pri' /
    // kAudioUnitErr_CannotDoInCurrentContext) — silently, and for exactly the
    // calls that carry `.defaultToSpeaker` into activation, which is every
    // video call: a dead-both-ways call under a lit speaker button, cured by
    // toggling it, because the toggle's category flip forces the re-init this
    // ordering (and the start-failure re-kick below) now makes unnecessary.
    // Settling the category FIRST means the unit starts under the final
    // configuration and the only remaining writer is libwebrtc's, which
    // `applyCategory` already arms with identical options.
    applyOutputRoute()
    session.isAudioEnabled = true
    events?.callKitAudioActivated()
  }

  public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    routeLock.lock()
    let wasActive = audioActive
    audioActive = false
    startFailureKicks = 0
    #if targetEnvironment(simulator)
      // A real deactivation balances the manual activation's count below;
      // the teardown that finds the flag cleared then (correctly) does
      // nothing.
      simulatorManualActivation = false
    #endif
    routeLock.unlock()
    let session = RTCAudioSession.sharedInstance()
    session.isAudioEnabled = false
    // Balanced only when an activation is actually outstanding: on the
    // simulator the manual teardown can beat a real `didDeactivate` here,
    // and deactivating twice would drive WebRTC's activation count negative
    // — the mirror image of the stranded count the teardown exists to fix.
    if wasActive { session.audioSessionDidDeactivate(audioSession) }
    events?.callKitAudioDeactivated()
  }

  /**
   * The VoiceProcessing unit said it could not START (see `init`'s watch).
   *
   * Until this existed the failure had NO observer: the session stayed
   * activated, `isAudioEnabled` stayed true, and nothing anywhere would touch
   * the unit again — a call silent in both directions until a human toggled
   * the speaker button, whose category flip forces AudioDeviceIOS to re-init.
   * This does mechanically what that human remedy did: re-settle the route,
   * then pulse `isAudioEnabled` so the device module tears the failed unit
   * down and initializes a fresh one. ONCE per activation (`startFailureKicks`)
   * — a second consecutive failure means the session is genuinely unavailable
   * and a loop would not make it otherwise.
   *
   * Hopped to main: the report arrives on libwebrtc's audio thread, and the
   * re-kick takes the session's configuration lock, which does not belong on
   * the thread that is mid-failure underneath it.
   */
  private func audioUnitStartFailed() {
    routeLock.lock()
    let generation = activationGeneration
    let shouldKick = audioActive && startFailureKicks == 0
    if shouldKick { startFailureKicks += 1 }
    routeLock.unlock()
    guard shouldKick else { return }
    NSLog("[call] audio unit failed to start; re-kicking once")
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.routeLock.lock()
      // KEYED TO THE ACTIVATION whose unit failed, not merely to "some
      // activation is live": the original call can hang up and the NEXT
      // call's activation land while this hop is in flight, and a stale
      // failure must not spend the new activation's kick on it.
      let stillSame = self.audioActive && self.activationGeneration == generation
      self.routeLock.unlock()
      guard stillSame else { return }
      self.applyOutputRoute()
      let session = RTCAudioSession.sharedInstance()
      session.isAudioEnabled = false
      session.isAudioEnabled = true
    }
  }

  #if targetEnvironment(simulator)
    /**
     * SIMULATOR ONLY, compiled out of every device build: CallKit's
     * `didActivate` has a documented history of never arriving on the iOS
     * Simulator, and a leg run there (the standing test rig pairs a physical
     * iPhone with an iPad simulator) would keep `isAudioEnabled` false forever
     * — indistinguishable from the very defect this file exists to prevent.
     * Armed when an answer or start action is fulfilled; if the real
     * activation has not arrived shortly after, the session is activated
     * manually and driven through the SAME `didActivate` path, whose
     * `alreadyActive` guard keeps a late real activation from double-counting.
     *
     * KEYED TO THE CALL THAT ARMED IT: the timer fires only while ITS uuid is
     * still mapped, because "some call exists" let call A's leftover timer
     * activate call B's session before B's own answer. And a FAILED
     * `setActive` aborts — driving `didActivate` anyway would raise
     * `isAudioEnabled` over a session that never activated, the inversion of
     * the never-before-activation invariant this file enforces.
     */
    private func armSimulatorActivationFallback(uuid: UUID) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        guard let self else { return }
        self.routeLock.lock()
        let active = self.audioActive
        self.routeLock.unlock()
        if active { return }
        self.lock.lock()
        let stillLive = self.cidByUuid[uuid] != nil
        self.lock.unlock()
        guard stillLive else { return }
        NSLog("[call] simulator: didActivate never arrived; activating manually")
        let av = AVAudioSession.sharedInstance()
        do {
          try av.setActive(true)
        } catch {
          NSLog("[call] simulator: manual activation failed; leaving audio down")
          return
        }
        self.routeLock.lock()
        self.simulatorManualActivation = true
        self.routeLock.unlock()
        self.provider(self.ensureProvider(), didActivate: av)
      }
    }

    /**
     * The manual activation's MATCHING DEACTIVATION. CallKit never activated
     * the session, so CallKit will never deactivate it: without this, a
     * hangup on the simulator leg stranded `audioActive` true, left the
     * AVAudioSession active, and held RTCAudioSession's activation count one
     * high forever — the NEXT call's activation then saw `alreadyActive` and
     * skipped `audioSessionDidActivate`, the very handshake it needed.
     * Called wherever the LAST CallKit mapping drops. A teardown that lost
     * the race to a real `didDeactivate` (flag already cleared there) does
     * nothing — the balance already happened.
     */
    private func tearDownSimulatorActivationIfNeeded() {
      // MAIN-SERIALIZED with the fallback timer body above, which is not one
      // atomic step: its liveness checks, the `setActive`, the ownership
      // flag and the driven `didActivate` release locks between them. A
      // teardown arriving from the bridge thread (an `endCall` racing the
      // timer) could thread that gap — it read `simulatorManualActivation`
      // still false, found nothing to own, and returned; the timer then
      // activated and took ownership AFTER the only teardown opportunity had
      // passed, stranding `audioActive`, the AVAudioSession, and WebRTC's
      // activation count for the next simulator call. On main the timer body
      // runs whole, so a teardown hopped here lands strictly before it (the
      // timer's own liveness check then sees the mapping already gone and
      // aborts) or strictly after it (ownership is set, and this deactivates
      // it) — never inside. Callers already on main are serialized by the
      // thread itself and keep their synchronous behaviour.
      guard Thread.isMainThread else {
        DispatchQueue.main.async { [weak self] in
          self?.tearDownSimulatorActivationIfNeeded()
        }
        return
      }
      routeLock.lock()
      let owned = simulatorManualActivation && audioActive
      simulatorManualActivation = false
      if owned {
        audioActive = false
        startFailureKicks = 0
      }
      routeLock.unlock()
      guard owned else { return }
      NSLog("[call] simulator: deactivating manually (didDeactivate will not arrive)")
      let session = RTCAudioSession.sharedInstance()
      session.isAudioEnabled = false
      let av = AVAudioSession.sharedInstance()
      session.audioSessionDidDeactivate(av)
      try? av.setActive(false)
      events?.callKitAudioDeactivated()
    }
  #endif
}

// MARK: - PKPushRegistryDelegate

extension CallKitCenter: PKPushRegistryDelegate {
  public func pushRegistry(_ registry: PKPushRegistry,
                           didUpdate credentials: PKPushCredentials,
                           for type: PKPushType) {
    voipToken = credentials.token.map { String(format: "%02x", $0) }.joined()
    events?.voipTokenUpdated(token: voipToken)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    voipToken = ""
    events?.voipTokenUpdated(token: "")
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    // REPORT FIRST. iOS kills the app if a VoIP push does not produce a
    // reportNewIncomingCall almost immediately, and it does so whether or not
    // we were about to do something more useful. The payload carries only ids
    // — no name, no preview — so the call rings under a placeholder and the
    // name is corrected by updateDisplay once the envelope decrypts.
    let cid = payload.dictionaryPayload["cid"] as? String ?? UUID().uuidString
    let from = payload.dictionaryPayload["from"] as? String ?? ""
    let to = payload.dictionaryPayload["to"] as? String ?? ""

    // PushKit still requires a report when the target is absent, stale, or
    // belongs to another account. That report is deliberately ephemeral and
    // immediately ended: it cannot become pending native state and it cannot
    // wake JS to fetch an old account's offer.
    guard let lease = accountLease(for: to) else {
      reportRejectedPush(completion: completion)
      return
    }

    // The mirror gives the ring its real name on the FIRST paint. Fall back
    // to the placeholder, never the raw ULID — an opaque id on a full-screen
    // call is worse than saying nothing.
    let name = mirroredName(for: from) ?? "Incoming call"
    // THE BLOCKED-CALLER GATE — the VoIP half of the check the notification
    // extension already makes for alert pushes (NotificationService.swift).
    // `urgent` is a client-set bit on an opaque payload, so without this a
    // BLOCKED person could still ring the victim's locked phone full-screen.
    // What the block must NOT do is skip the report: the obligation above is
    // unconditional — iOS kills the process for a missing report and, on
    // repeat, revokes VoIP delivery for every call this app will ever get.
    // So the verdict is taken here and acted on AFTER the obligation is met:
    // report first, end immediately in the completion below. The mirror
    // survives relock and duress on purpose, and an unreadable mirror reads
    // as empty and rings — see `blockedPeers()`.
    let blocked = !from.isEmpty && blockedPeers().contains(from)
    lock.lock()
    guard accountOwner.isCurrent(lease) else {
      lock.unlock()
      reportRejectedPush(completion: completion)
      return
    }
    // NEVER OVERWRITE a pending ring. Every announced end is urgent, so a
    // caller cancelling (or timing out) while this phone is dead sends a
    // SECOND VoIP push — and pointing `pendingPush` at its fresh synthetic
    // cid orphaned the call that was actually ringing: the rebind then
    // re-keyed a call CallKit had refused (one call group, one call), the
    // cancel's dismissal found nothing, and the placeholder rang until a
    // human declined it. The second report still happens — iOS requires one
    // per push — CallKit refuses it, and its throwaway mapping is dropped.
    //
    // A BLOCKED push never becomes the pending ring either: its call is
    // ended in the completion, and both the rebind and the parked-rebind
    // paths key off `pendingPush`, so never setting it is what keeps a
    // blocked ring from adopting — or being adopted by — anything.
    let alreadyRinging = pendingPush != nil
    if !alreadyRinging && !blocked {
      pendingPush = (cid: cid, from: from)
      pendingAnswered = false
      pendingPushConfirmed = false
    }
    lock.unlock()
    // Direct to the fresh path, NOT reportIncomingCall: the rebind would
    // match the caller and adopt the throwaway.
    reportFresh(
      cid: cid,
      handle: name,
      displayName: name,
      hasVideo: false,
      lease: lease
    ) { error in
      // Account deletion/rotation may have completed while CallKit decided
      // the report. `reportFresh` has already ended and forgotten this UUID;
      // nothing from the old generation may touch pending state or JS.
      guard self.accountOwner.isCurrent(lease) else {
        completion()
        return
      }
      if blocked {
        // REPORT-THEN-IMMEDIATELY-END. The report above satisfied PushKit;
        // this takes the call down before the ring can persist — no watchdog
        // is armed and no parked rebind is re-driven, because neither exists
        // for a cid that never became `pendingPush`, and a genuinely ringing
        // call's state (its pending entry, its parked rebind, its watchdog)
        // is untouched for the same reason. The UUID is resolved before
        // `forget` drops the mapping; when CallKit REFUSED the report
        // (error != nil — a real call already ringing) the end names a UUID
        // CallKit does not know and is ignored. JS still hears the push:
        // the resume it triggers drains the envelope, and the receive path —
        // where blocking is enforced — discards it, so the server stops
        // holding a frame nothing will ever ring for.
        let id = self.uuid(for: cid)
        self.forget(cid: cid)
        self.ensureProvider().reportCall(with: id, endedAt: nil, reason: .unanswered)
        self.events?.voipPush(cid: cid, from: from, ringCid: self.ringingCid(for: from))
        completion()
        return
      }
      // The verdict is the truth; the state follows it — and a rebind that
      // arrived while the verdict was in flight is parked, waiting to be
      // re-driven here on either branch.
      if alreadyRinging {
        // A deliberate throwaway (a second push while one rings): drop its
        // mapping, touch nothing that belongs to the FIRST ring — least of
        // all a rebind parked on it.
        //
        // BUT `alreadyRinging` is a snapshot taken BEFORE this verdict
        // returned, and the first call can end inside that window. CallKit
        // then ACCEPTS this report (error == nil) and the throwaway is
        // ringing full-screen — merely forgetting its mapping strands it: an
        // answer resolves no cid (`CXAnswerCallAction` fails), no watchdog
        // was armed for a cid that never became `pendingPush`, and nothing
        // JS knows of can ever end it. End what CallKit accepted before
        // forgetting it. When the report was REFUSED the end names a UUID
        // CallKit does not know and is ignored — the blocked branch's
        // reasoning — so gating on the verdict is exactness, not safety.
        // Report-first is untouched: the report above already satisfied
        // PushKit on every path through here.
        if error == nil {
          let id = self.uuid(for: cid)
          self.forget(cid: cid)
          self.ensureProvider().reportCall(with: id, endedAt: nil, reason: .unanswered)
        } else {
          self.forget(cid: cid)
        }
      } else if error != nil {
        // CallKit REFUSED the first report — a push during an active call,
        // say. Clear the phantom; the parked rebind (if any) re-drives into
        // the FRESH path and earns its own honest verdict, which is what
        // lets JS's busy-teardown finally see the refusal.
        self.forget(cid: cid)
        self.lock.lock()
        if self.pendingPush?.cid == cid {
          self.pendingPush = nil
          self.pendingAnswered = false
          self.pendingPushConfirmed = false
        }
        let parked = self.parkedRebind
        self.parkedRebind = nil
        self.lock.unlock()
        if let parked {
          // Re-entry with pendingPush cleared takes the fresh path. (A
          // cancel racing this exact window can briefly fresh-ring a call
          // whose end is already in flight; the controller's endCall then
          // takes it down — accepted, and vanishingly narrow.)
          self.reportIncomingCall(
            cid: parked.cid, peerId: parked.peerId, handle: parked.handle,
            displayName: parked.displayName, hasVideo: parked.hasVideo,
            completion: parked.completion
          )
        }
      } else {
        self.lock.lock()
        let stillPending = self.pendingPush?.cid == cid
        if stillPending { self.pendingPushConfirmed = true }
        self.lock.unlock()
        // Armed only for a report CallKit ACCEPTED and still pending — a
        // dismissal that beat this completion already ended the placeholder,
        // and arming then would mint a mapping for an unreported UUID. The
        // arm runs STRICTLY BEFORE the parked rebind replays: the rebind's
        // cancel must run after it, or the watchdog ends up guarding a live
        // call and kills it at 75 seconds.
        if stillPending {
          self.armPlaceholderWatchdog(uuid: self.uuid(for: cid))
        }
        // Atomic under one lock hold: the re-drive re-checks the pending
        // state inside, so a dismissal landing after the arm cannot make
        // this re-ring a cancelled call.
        self.performParkedRebind()
      }
      // Only after CallKit has been told does JS hear about it — it may need
      // to reconnect the socket to fetch the envelope, and that must not
      // happen before the report.
      // The RINGING placeholder's cid, not this push's. On the `alreadyRinging`
      // branch above they differ and only this one is nameable: `pendingPush`
      // was left on the FIRST ring, so a dismissal tagged with the throwaway
      // would match nothing and the ring would stick to the watchdog. Read
      // outside the lock — `performParkedRebind()` has already taken and
      // released it, and `lock` is not recursive.
      self.events?.voipPush(cid: cid, from: from, ringCid: self.ringingCid(for: from))
      completion()
    }
  }
}

/// What CallKit and PushKit report upward.
protocol CallKitEventSink: AnyObject {
  func callKitAnswered(cid: String)
  func callKitEnded(cid: String, reason: String)
  func callKitMuted(cid: String, muted: Bool)
  func callKitAudioActivated()
  func callKitAudioDeactivated()
  /// `ringCid` is the cid of the placeholder actually ringing for `from`,
  /// "" when none is — which is not always `cid` (see `alreadyRinging`).
  func voipPush(cid: String, from: String, ringCid: String)
  func voipTokenUpdated(token: String)
}

/**
 * The one `RTCAudioSessionDelegate` this module registers, forwarding the one
 * callback it cares about (see `CallKitCenter.audioUnitStartFailed`).
 *
 * A SEPARATE OBJECT rather than a conformance on `CallKitCenter` itself, and
 * not out of taste: an @objc conformance on that public class lands in the
 * generated `-Swift.h`, which `TacendumCall.mm` imports — and that file's
 * header-order contract (see its top comment) would then extend to WebRTC's
 * headers too. A fileprivate class exports nothing. `RTCAudioSession` holds
 * its delegates weakly, so `CallKitCenter` keeps the strong reference.
 */
private final class AudioUnitStartWatch: NSObject, RTCAudioSessionDelegate {
  private let onStartFailure: () -> Void

  init(onStartFailure: @escaping () -> Void) {
    self.onStartFailure = onStartFailure
    super.init()
  }

  func audioSession(
    _ audioSession: RTCAudioSession, audioUnitStartFailedWithError error: Error
  ) {
    onStartFailure()
  }
}
