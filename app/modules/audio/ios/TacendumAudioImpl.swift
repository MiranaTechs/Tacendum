import AudioToolbox
import AVFoundation
import CallKit
import Foundation

/**
 * The native halves of voice notes.
 *
 * Two jobs JS cannot do, and the properties that make them safe:
 *
 *  - RECORDING writes to a protected temp file because `AVAudioRecorder`
 *    requires a filesystem URL — there is no buffer API. That plaintext is
 *    the one durable copy outside SQLite, so its lifetime is this class's
 *    central responsibility: deleted on stop (after read-in), on cancel, on
 *    every failure path, and swept at launch for anything a kill left
 *    behind.
 *  - PLAYBACK is memory-only: `AVAudioPlayer(data:)` plays the decrypted
 *    bytes with no file ever written, and the retained `Data` is released on
 *    stop, on finish, and on every path that ends a playback.
 *
 * The audio session is shared with CallKit. tacendum-call's doctrine
 * (CallKitCenter.swift) is that `RTCAudioSession` runs manual audio and
 * CallKit ALONE activates the session — so this module never touches the
 * session while any call exists. `CXCallObserver` refuses both entry points
 * with 'call_active' before any configuration happens, the gate is
 * re-checked after the permission dialog (a call can arrive while it is up),
 * and the polite deactivation on stop is skipped whenever a call holds the
 * session. Not fighting that handshake is the whole design.
 *
 * The RINGBACK (the tone the caller hears while the far phone rings) is the
 * inverse case, and it keeps the same doctrine: it exists only DURING a call
 * and it configures NOTHING — no setCategory, no setActive, no route
 * override, ever. It is one `AVAudioPlayer` mixing into the session CallKit
 * already activated and CallKitCenter.applyCategory already routed, which is
 * precisely why it behaves like a call tone: the call's route (earpiece for
 * voice, loudspeaker for video), the in-call volume rocker, and — like a
 * real phone's ringback — audible with the silent switch on.
 *
 * Every promise resolves or rejects EXACTLY once: all state lives on one
 * serial queue, every entry point and every AVFoundation callback hops onto
 * it, and each finalize path clears the recording state before it settles
 * anything — a delegate callback racing a manual stop finds the state
 * already gone and no-ops.
 */
@objc(TacendumAudioImpl)
public final class TacendumAudioImpl: NSObject {
  @objc public static let shared = TacendumAudioImpl()

  /// Everything below lives on this queue. AVAudioRecorder and AVAudioPlayer
  /// deliver delegate callbacks on threads of their choosing, session
  /// notifications arrive on main, and JS calls arrive on the TurboModule
  /// queue; one serial queue makes "who mutates state" a non-question and
  /// keeps disk reads and megabyte base64 work off the thread drawing UI.
  private let queue = DispatchQueue(label: "tacendum.audio")

  /// Sees Tacendum calls AND cellular ones, which JS cannot.
  /// A public system observer — no import from tacendum-call, by design.
  /// Created with the singleton so its call list is warm long before the
  /// first record tap.
  private let callObserver = CXCallObserver()

  // Event sinks, bound by the .mm shim and cleared on invalidate. Read and
  // written only on `queue`, so a reload tearing the TurboModule down can
  // never race an emit into a dying C++ half.
  private var onLevel: ((Double) -> Void)?
  private var onRecordingFinished: (([String: Any]) -> Void)?
  private var onPlaybackFinished: (() -> Void)?

  // MARK: - recording state

  private var recorder: AVAudioRecorder?
  private var recordingURL: URL?
  private var levelTimer: DispatchSourceTimer?
  /// A start waiting on the permission dialog. The recorder does not exist
  /// yet, so without this a second startRecording during the prompt would
  /// pass the busy guard and two starts would race the same session.
  private var startInFlight = false
  /// Bumped by `invalidate()` and by every teardown. A permission dialog is
  /// the slowest thing this module does, and a grant returning after the
  /// runtime went away used to start the microphone for nobody, hot until
  /// the cap (found by review). Continuations re-check the generation they
  /// began under and do nothing if it moved.
  private var generation = 0
  /// Bumped by `invalidate()` and by any teardown. A permission dialog is
  /// the slowest thing this module does, and a grant that returns after the
  /// runtime went away used to start the microphone for nobody (found by
  /// review). Every continuation re-checks the generation it began under.

  // MARK: - playback state

  private var player: AVAudioPlayer?
  /// The decrypted bytes the player is reading. Held explicitly so "release
  /// the retained Data on stop and on finish" is a visible act in this file,
  /// not an artifact of the player's own retention.
  private var playerData: Data?
  /// Ticks the play head to JS while a note plays. Native rather than a JS
  /// timer on purpose: a timer keeps counting when the audio has actually
  /// stopped — an interruption, a route change, a call — and a progress bar
  /// that advances over silence is a lie the person can hear.
  private var progressTimer: DispatchSourceTimer?
  private var onPlaybackProgress: ((Double) -> Void)?

  // MARK: - ringback state

  /// The outgoing-call ringback loop, wholly separate from the voice-note
  /// `player`: the two can never coexist (voice notes refuse during calls,
  /// the ringback refuses outside them), and sharing the slot would entangle
  /// the ringback with `sessionOwned` bookkeeping it must never touch.
  private var ringbackPlayer: AVAudioPlayer?

  /// Whether WE activated the session (and therefore owe the polite
  /// deactivation). Never true while a call is up — the gate sees to that —
  /// and cleared without deactivating when an interruption or reset means
  /// the session is no longer ours to give back.
  private var sessionOwned = false

  /// Where the one durable plaintext copy lives, for exactly as long as a
  /// recording does. A dedicated directory so the sweep can be a single
  /// removeItem with nothing else's files at risk.
  private static var tempDir: URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("tacendum-voice", isDirectory: true)
  }

  override private init() {
    super.init()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    // An interruption (a call arriving, Siri, an alarm) FINALIZES the
    // recording rather than losing it: the person answers their call
    // and finds the partial note waiting in preview.
    center.addObserver(
      self,
      selector: #selector(handleInterruption(_:)),
      name: AVAudioSession.interruptionNotification,
      object: session
    )
    center.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: session
    )
    center.addObserver(
      self,
      selector: #selector(handleMediaServicesReset(_:)),
      name: AVAudioSession.mediaServicesWereResetNotification,
      object: session
    )
  }

  // MARK: - wiring

  @objc(bindOnLevel:onRecordingFinished:onPlaybackFinished:onPlaybackProgress:)
  public func bind(
    onLevel: @escaping (Double) -> Void,
    onRecordingFinished: @escaping ([String: Any]) -> Void,
    onPlaybackFinished: @escaping () -> Void,
    onPlaybackProgress: @escaping (Double) -> Void
  ) {
    queue.async {
      self.onLevel = onLevel
      self.onRecordingFinished = onRecordingFinished
      self.onPlaybackFinished = onPlaybackFinished
      self.onPlaybackProgress = onPlaybackProgress
    }
  }

  /// Runtime teardown (reload/shutdown). Synchronous on the state queue, so
  /// after this returns no emit can land in the TurboModule being destroyed.
  /// The microphone does not stay hot for a runtime that no longer exists:
  /// an in-flight recording is discarded (file deleted), playback released.
  @objc public func invalidate() {
    queue.sync {
      // FIRST: anything waiting on a permission dialog is now stale, so its
      // continuation starts nothing.
      self.generation &+= 1
      self.onLevel = nil
      self.onRecordingFinished = nil
      self.onPlaybackFinished = nil
      self.onPlaybackProgress = nil
      self.discardRecordingOnQueue()
      self.releasePlayerOnQueue()
      self.stopRingbackOnQueue()
      self.deactivateSessionIfIdleOnQueue()
    }
  }

  // MARK: - sweep

  /**
   * Delete anything a previous run left behind.
   *
   * The stop/cancel cleanup cannot fire if the app is FORCE-KILLED
   * mid-recording — plaintext would then sit in tmp until iOS felt like
   * purging it, which is a promise this app does not get to make. Called at
   * module init, so every launch starts with an empty directory; JS's
   * `sweepTemp()` at launch is belt to this braces.
   */
  @objc public func sweepLeftovers() {
    queue.async {
      // Never yank an active recording's file — a Metro reload constructs
      // the new module around the old one's invalidate, and ordering is the
      // harness's promise, not ours to assume.
      guard self.recorder == nil else { return }
      try? FileManager.default.removeItem(at: Self.tempDir)
    }
  }

  @objc(sweepTempWithResolve:)
  public func sweepTemp(resolve: @escaping () -> Void) {
    queue.async {
      // A sweep with a recording somehow in flight still deletes everything:
      // the sweep's contract is "no plaintext survives", not "unless busy".
      self.discardRecordingOnQueue()
      try? FileManager.default.removeItem(at: Self.tempDir)
      self.deactivateSessionIfIdleOnQueue()
      resolve()
    }
  }

  // MARK: - recording

  @objc(startRecording:resolve:reject:)
  public func startRecording(
    _ maxSeconds: Double,
    resolve: @escaping () -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    queue.async {
      guard maxSeconds > 0 else {
        reject("bad_args", "maxSeconds must be positive")
        return
      }
      guard !self.callIsActive else {
        reject("call_active", "recording is refused while a call is active")
        return
      }
      guard self.recorder == nil, !self.startInFlight else {
        reject("busy", "already recording")
        return
      }
      self.startInFlight = true
      let gen = self.generation
      self.withMicPermission { granted in
        self.queue.async {
          self.startInFlight = false
          // The runtime this recording was requested for is gone: resolve
          // nothing, start nothing, and leave the microphone alone.
          guard gen == self.generation else {
            reject("cancelled", "the recording was cancelled before it began")
            return
          }
          guard granted else {
            reject("denied", "microphone permission was refused")
            return
          }
          // Re-checked, not assumed: a call can arrive while the permission
          // dialog is up, and the gate must hold at the moment the session
          // is actually touched, not the moment the person tapped.
          guard !self.callIsActive else {
            reject("call_active", "recording is refused while a call is active")
            return
          }
          guard self.recorder == nil else {
            reject("busy", "already recording")
            return
          }
          self.beginRecordingOnQueue(maxSeconds: maxSeconds, resolve: resolve, reject: reject)
        }
      }
    }
  }

  private func beginRecordingOnQueue(
    maxSeconds: Double,
    resolve: () -> Void,
    reject: (String, String) -> Void
  ) {
    // A playing bubble yields to the recorder: one audio activity at a time
    // keeps "who owns the session" a fact rather than a race, and the
    // finished event lets the UI reset that bubble's control.
    if player != nil {
      releasePlayerOnQueue()
      onPlaybackFinished?()
    }

    let dir = Self.tempDir
    let url = dir.appendingPathComponent("voice-\(UUID().uuidString).m4a")
    let session = AVAudioSession.sharedInstance()
    do {
      // FileProtectionType.complete plus backup exclusion: the file
      // is the one durable plaintext copy outside SQLite. tmp is not backed
      // up today; the exclusion makes that a property of this directory
      // rather than a property of Apple's current policy.
      try FileManager.default.createDirectory(
        at: dir,
        withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete]
      )
      // FAIL CLOSED. `try?` here meant a directory that silently lacked the
      // protection this comment promises — a privacy control that reports
      // success while protecting nothing is worse than an absent one (found
      // by review). Both the exclusion and the protection level are now
      // verified, and a failure aborts the recording.
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var dirURL = dir
      try dirURL.setResourceValues(values)
      let applied = try FileManager.default
        .attributesOfItem(atPath: dir.path)[.protectionKey] as? FileProtectionType
      guard applied == .complete else {
        throw NSError(
          domain: "TacendumAudio",
          code: 1,
          userInfo: [
            NSLocalizedDescriptionKey:
              "the recording directory did not take complete file protection",
          ]
        )
      }

      // .allowBluetooth so a headset's microphone records. Configure AND
      // activate — unlike a call, nobody else will activate for us, and the
      // call gate above guarantees no owner is being fought.
      try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
      try session.setActive(true)
    } catch {
      try? FileManager.default.removeItem(at: url)
      reject("record_failed", error.localizedDescription)
      return
    }
    sessionOwned = true

    // AAC-LC in an MPEG-4 container, mono, 24 kHz, 32 kbps: the
    // boring first-class encode path, hardware-assisted, and the exact
    // format AVAudioPlayer(data:) decodes from memory on the receiving side.
    let rec: AVAudioRecorder
    do {
      rec = try AVAudioRecorder(url: url, settings: [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 24_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000,
      ])
    } catch {
      try? FileManager.default.removeItem(at: url)
      deactivateSessionIfIdleOnQueue()
      reject("record_failed", error.localizedDescription)
      return
    }
    rec.delegate = self
    rec.isMeteringEnabled = true
    guard rec.prepareToRecord() else {
      rec.delegate = nil
      try? FileManager.default.removeItem(at: url)
      deactivateSessionIfIdleOnQueue()
      reject("record_failed", "the recorder refused to prepare")
      return
    }
    // prepareToRecord created the file with the CONTAINER's default class,
    // not the directory's — the protection stamp has to land on the file
    // itself, before a single sample is written.
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path
    )
    // record(forDuration:) IS the cap: the audio system auto-stops at
    // maxSeconds and the delegate finalizes into onRecordingFinished — no
    // timer to drift against the recorder, nothing for JS to enforce.
    guard rec.record(forDuration: maxSeconds) else {
      rec.delegate = nil
      try? FileManager.default.removeItem(at: url)
      deactivateSessionIfIdleOnQueue()
      reject("record_failed", "the recorder refused to start")
      return
    }
    recorder = rec
    recordingURL = url
    startLevelTimerOnQueue()
    resolve()
  }

  @objc(stopRecordingWithResolve:reject:)
  public func stopRecording(
    resolve: @escaping ([String: Any]) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    queue.async {
      guard let rec = self.recorder, let url = self.recordingURL else {
        // Includes the cap/interruption race: the recording already
        // finalized into onRecordingFinished, and this promise must say so
        // rather than hang.
        reject("not_recording", "no recording is in progress")
        return
      }
      self.clearRecordingStateOnQueue()
      // Detached BEFORE stop: the delegate's finish callback serves the cap;
      // a manual stop finalizes right here, and two finalizers for one file
      // is exactly the double-settle this module exists to prevent.
      rec.delegate = nil
      rec.stop() // synchronous — "stops recording and closes the audio file"
      self.deactivateSessionIfIdleOnQueue()
      switch self.finalizeOnQueue(url: url) {
      case .success(let result): resolve(result)
      case .failure(let message): reject("finalize_failed", message)
      }
    }
  }

  /// Cancelling also retires any in-flight permission request: the person
  /// asked for this take to end, and a grant arriving afterwards must not
  /// resurrect it.
  @objc(cancelRecordingWithResolve:)
  public func cancelRecording(resolve: @escaping () -> Void) {
    queue.async {
      self.generation &+= 1
      self.discardRecordingOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      resolve()
    }
  }

  /// Stop and delete without ever reading the bytes. Safe when idle.
  private func discardRecordingOnQueue() {
    guard let rec = recorder else { return }
    let url = recordingURL
    clearRecordingStateOnQueue()
    rec.delegate = nil
    rec.stop()
    if let url { try? FileManager.default.removeItem(at: url) }
  }

  private func clearRecordingStateOnQueue() {
    recorder = nil
    recordingURL = nil
    levelTimer?.cancel()
    levelTimer = nil
  }

  private enum Finalized {
    case success([String: Any])
    case failure(String)
  }

  /// Read, decode, DELETE. The deletion is unconditional — after this
  /// returns, the plaintext exists nowhere on disk, whatever else happened.
  private func finalizeOnQueue(url: URL) -> Finalized {
    defer { try? FileManager.default.removeItem(at: url) }
    guard let data = try? Data(contentsOf: url), !data.isEmpty else {
      return .failure("nothing was recorded")
    }
    // The DECODED duration is the truth: the wall clock measures how
    // long the recorder existed, not how much audio the encoder committed,
    // and those disagree exactly when it matters — interruption, encoder
    // trouble. Whole seconds, floor 1: the envelope's `dur` is 1..300 and a
    // sub-second note is honestly "1 second" at that granularity.
    guard let probe = try? AVAudioPlayer(data: data) else {
      return .failure("the recording could not be decoded")
    }
    let durationSec = max(1, Int(probe.duration.rounded()))
    return .success(["dataB64": data.base64EncodedString(), "durationSec": durationSec])
  }

  private func startLevelTimerOnQueue() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
    timer.setEventHandler { [weak self] in
      guard let self, let rec = self.recorder, rec.isRecording else { return }
      rec.updateMeters()
      // averagePower is dBFS, −160…0. Normalise against a −60 dB floor:
      // quiet-room speech sits well inside it, so the indicator gets a
      // usable range instead of hugging the bottom.
      let db = Double(rec.averagePower(forChannel: 0))
      let level = max(0.0, min(1.0, (db + 60.0) / 60.0))
      self.onLevel?(level)
    }
    levelTimer?.cancel()
    levelTimer = timer
    timer.resume()
  }

  /// The play head, four times a second — fast enough to read as motion,
  /// slow enough to cost nothing. Only emits while the player is genuinely
  /// playing, so a paused or interrupted note stops advancing.
  private func startProgressTimerOnQueue() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 0.25)
    timer.setEventHandler { [weak self] in
      guard let self, let p = self.player, p.isPlaying else { return }
      self.onPlaybackProgress?(p.currentTime)
    }
    progressTimer?.cancel()
    progressTimer = timer
    timer.resume()
  }

  // MARK: - playback

  @objc(startPlayback:resolve:reject:)
  public func startPlayback(
    _ dataB64: String,
    resolve: @escaping (Double) -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    queue.async {
      guard !self.callIsActive else {
        reject("call_active", "playback is refused while a call is active")
        return
      }
      // Playing over an in-flight recording would steal its session and
      // truncate its file. The UI never offers this; the module still
      // refuses rather than trusting that.
      guard self.recorder == nil, !self.startInFlight else {
        reject("busy", "a recording is in progress")
        return
      }
      // One player at a time: bubble B replaces bubble A, and A's retained
      // bytes are released with it. No finished event for A — JS initiated
      // this switch and already knows.
      self.releasePlayerOnQueue()
      guard let data = Data(base64Encoded: dataB64) else {
        reject("bad_data", "not base64")
        return
      }
      let session = AVAudioSession.sharedInstance()
      do {
        // .playback, not .playAndRecord: a voice note plays through the
        // silent switch and interrupts background music — a deliberate act;
        // words cannot be heard under a song.
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
      } catch {
        self.deactivateSessionIfIdleOnQueue()
        reject("play_failed", error.localizedDescription)
        return
      }
      self.sessionOwned = true
      // THE DECODED DURATION IS THE TRUTH. `dur` on the wire is a sender
      // claim, and a peer can claim one second while supplying a valid
      // half-hour of AAC (found by review). Refuse anything past the cap
      // BEFORE it starts playing, and hand the real length back so the
      // bubble can correct itself.
      let p: AVAudioPlayer
      do {
        // Memory only — no file is ever written for playback; the
        // SQLite attachments row stays the single durable decrypted copy.
        p = try AVAudioPlayer(data: data)
      } catch {
        // Bytes a decoder rejects: hostile or corrupt audio under a valid
        // GCM tag. The tag means the SENDER built this.
        self.deactivateSessionIfIdleOnQueue()
        reject("bad_data", "the audio could not be decoded")
        return
      }
      // The cap, enforced on what the DECODER says rather than on what the
      // sender claimed. 300s matches VOICE_MAX_SECONDS in envelope.ts; a
      // small tolerance absorbs container rounding.
      guard p.duration <= 300.5 else {
        self.deactivateSessionIfIdleOnQueue()
        reject("too_long", "the audio is longer than the five-minute limit")
        return
      }
      p.delegate = self
      guard p.prepareToPlay(), p.play() else {
        self.deactivateSessionIfIdleOnQueue()
        reject("play_failed", "the player refused to start")
        return
      }
      self.player = p
      self.playerData = data
      self.startProgressTimerOnQueue()
      // The real length goes back to JS so a bubble showing a lied-about
      // duration corrects itself the moment it is played.
      resolve(p.duration)
    }
  }

  @objc(stopPlaybackWithResolve:)
  public func stopPlayback(resolve: @escaping () -> Void) {
    queue.async {
      self.releasePlayerOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      resolve()
    }
  }

  /// Stop and let go of the player AND the decrypted bytes it was reading —
  /// the release half of "memory only". Safe when idle.
  private func releasePlayerOnQueue() {
    progressTimer?.cancel()
    progressTimer = nil
    player?.delegate = nil
    player?.stop()
    player = nil
    playerData = nil
  }

  // MARK: - ringback (outgoing call)

  /**
   * One cycle of the ringback, synthesized at first use — the repo ships no
   * audio asset, so there is no binary blob to license alongside the AGPL
   * Corresponding Source and no provenance to account for. 24 kHz mono
   * 16-bit PCM in a minimal WAV wrapper (~188 KB, built once), so it plays
   * through the same memory-only `AVAudioPlayer(data:)` machinery as a
   * voice note.
   *
   * The sound is the app's visual language translated — one ink, no
   * ornament. Two pure sine pulses: G4 (392 Hz), then D5 (587.33 Hz), a
   * perfect fifth up, the second quieter like an answer from further away.
   * Each lasts 220 ms under a raised-cosine attack (25 ms) and release
   * (90 ms) so nothing clicks, peaking near −19 dBFS — quiet on purpose;
   * then rest to the end of a 4-second cycle. The long silence is what makes
   * it read as patient rather than urgent, and the pure tones are what keep
   * it from being a jingle — no melody, no timbre movement, no percussion.
   * The burst-then-silence cadence itself is the one convention every phone
   * network shares, so it still reads instantly as "their phone is ringing".
   */
  private static let ringbackWav: Data = synthesizeWav(
    seconds: 4,
    pulses: [
      Pulse(freq: 392.0, at: 0.0, dur: 0.22, attack: 0.025, release: 0.09, amp: 0.11),
      Pulse(freq: 587.33, at: 0.36, dur: 0.22, attack: 0.025, release: 0.09, amp: 0.085),
    ]
  )

  /// One pure sine pulse under a raised-cosine attack and release — the one
  /// figure every tone in this file is drawn with.
  private struct Pulse {
    let freq: Double
    let at: Double
    let dur: Double
    let attack: Double
    let release: Double
    let amp: Double
  }

  /**
   * The synthesizer both tones share: 24 kHz mono 16-bit PCM in a minimal
   * WAV wrapper, `seconds` long, with each pulse rendered in place. The
   * ringback's bytes are the SAME bytes the inline loop produced before the
   * message tone arrived — same rate, same buffer length (`rate * 4`), same
   * per-sample rounding — which is what keeps RingbackTone.kt's verbatim
   * port and its pinned expectations true of this file.
   */
  private static func synthesizeWav(seconds: Double, pulses: [Pulse]) -> Data {
    let rate = 24_000
    var samples = [Int16](repeating: 0, count: Int(Double(rate) * seconds))
    for p in pulses {
      let base = Int(p.at * Double(rate))
      for i in 0 ..< Int(p.dur * Double(rate)) {
        let t = Double(i) / Double(rate)
        let env: Double
        if t < p.attack {
          env = 0.5 - 0.5 * cos(.pi * t / p.attack)
        } else if t > p.dur - p.release {
          env = 0.5 - 0.5 * cos(.pi * (p.dur - t) / p.release)
        } else {
          env = 1.0
        }
        samples[base + i] = Int16((p.amp * env * sin(2 * .pi * p.freq * t) * 32_767).rounded())
      }
    }

    var data = Data(capacity: 44 + samples.count * 2)
    func ascii(_ s: String) { data.append(contentsOf: s.utf8) }
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    let byteCount = UInt32(samples.count * 2)
    ascii("RIFF"); le32(36 + byteCount); ascii("WAVE")
    ascii("fmt "); le32(16); le16(1); le16(1) // PCM, mono
    le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16)
    ascii("data"); le32(byteCount)
    // iOS is little-endian, which is what the WAV data chunk wants.
    samples.withUnsafeBytes { data.append(contentsOf: $0) }
    return data
  }

  /**
   * Begin the ringback loop. Outgoing calls only, and the JS driver
   * (src/ui/ringback.ts) decides WHEN from the call state; this end enforces
   * only what native can see.
   *
   * THE SESSION DOCTRINE, INVERTED: where the voice-note entry points refuse
   * while a call exists, the ringback REQUIRES one. By the time an outgoing
   * call is ringing, CallKit has activated the call's session — the
   * CXStartCallAction is fulfilled immediately and `didActivate` follows,
   * while the callee's ring confirmation takes a full network round trip —
   * so this player only ever MIXES into a session that is already up,
   * already `.playAndRecord`/`.voiceChat`, already routed by
   * CallKitCenter.applyCategory. It must never become a third writer to
   * that configuration: no category, no activation, no override, and
   * stopping gives nothing back (the session was never ours; CallKit
   * deactivates the call's).
   *
   * With no call there is no session to mix into, and playing would
   * implicitly bring one up — exactly the fight this module refuses to
   * have — so it rejects 'no_call' instead. Already ringing resolves
   * quietly: the driver re-runs on app foregrounding, and idempotence
   * beats a second player under the first.
   */
  @objc(startRingbackWithResolve:reject:)
  public func startRingback(
    resolve: @escaping () -> Void,
    reject: @escaping (String, String) -> Void
  ) {
    queue.async {
      guard self.ringbackPlayer == nil else {
        resolve()
        return
      }
      guard self.callIsActive else {
        reject("no_call", "the ringback plays only during a call")
        return
      }
      let p: AVAudioPlayer
      do {
        p = try AVAudioPlayer(data: Self.ringbackWav)
      } catch {
        reject("ringback_failed", error.localizedDescription)
        return
      }
      // Loops until told to stop. No delegate on purpose: an infinite loop
      // never finishes, and the voice-note delegate paths must never see it.
      p.numberOfLoops = -1
      guard p.prepareToPlay(), p.play() else {
        reject("ringback_failed", "the ringback player refused to start")
        return
      }
      self.ringbackPlayer = p
      resolve()
    }
  }

  /// Stop the ringback and release it. Safe when idle — the terminal
  /// transitions all call this without asking whether a ring was up.
  @objc(stopRingbackWithResolve:)
  public func stopRingback(resolve: @escaping () -> Void) {
    queue.async {
      self.stopRingbackOnQueue()
      resolve()
    }
  }

  /// The release half. No session deactivation here, ever: the call's
  /// session is CallKit's to give back, and the ordinary next moment is the
  /// answered call's audio flowing on it.
  private func stopRingbackOnQueue() {
    ringbackPlayer?.stop()
    ringbackPlayer = nil
  }

  // MARK: - message tone (a text arrived while the app is open)

  /**
   * The message-arrival chime: the ringback's figure — a pure fifth, the
   * second note the quieter answer — played an octave higher and in a third
   * of the time. D5 (587.33 Hz) for 85 ms, then A5 (880 Hz) for 110 ms,
   * 120 ms after it, under the same raised-cosine edges so nothing clicks;
   * 340 ms of buffer in all, peaking near −20 dBFS. Short enough to be a
   * tap on the shoulder rather than an announcement, and drawn with the
   * same one ink as the ring so the two read as one voice. Synthesized, like
   * the ringback: the repo ships no audio asset.
   */
  private static let messageToneWav: Data = synthesizeWav(
    seconds: 0.34,
    pulses: [
      Pulse(freq: 587.33, at: 0.0, dur: 0.085, attack: 0.008, release: 0.035, amp: 0.10),
      Pulse(freq: 880.0, at: 0.12, dur: 0.11, attack: 0.008, release: 0.05, amp: 0.08),
    ]
  )

  /// The registered system sound, 0 until the first play. Read and written
  /// only on `queue`.
  private var messageToneId: SystemSoundID = 0

  /**
   * Play the chime once. THE SESSION DOCTRINE HOLDS A THIRD WAY HERE: the
   * voice-note paths own the session, the ringback mixes into CallKit's,
   * and this touches the session NOT AT ALL — it is an AudioServices SYSTEM
   * sound, the platform's channel for exactly this class of tone. That is
   * why it is not an `AVAudioPlayer`: a player needs a category, and
   * setting one would make this module a third writer to the session while
   * a voice note may be playing under `.playback` — or, worse, while a call
   * holds it. A system sound obeys the ring/silent switch and the ringer
   * volume, ducks nothing, and costs no activation.
   *
   * Never rejects — no reject block is even taken. It is fired from the
   * receive path, and a delivery must not fail over a sound. A call up
   * (Tacendum's or cellular, the same `CXCallObserver` the voice-note gate
   * consults — the call's audio owns the route, and a chime under a live
   * conversation is noise, not news) resolves quietly, as does every
   * failure below. JS decides WHEN (app/src/messageSound.ts): this end
   * enforces only what native can see.
   */
  @objc(playMessageToneWithResolve:)
  public func playMessageTone(resolve: @escaping () -> Void) {
    queue.async {
      guard !self.callIsActive else {
        resolve()
        return
      }
      guard let id = self.messageToneSoundIdOnQueue() else {
        resolve()
        return
      }
      AudioServicesPlaySystemSound(id)
      resolve()
    }
  }

  /**
   * The sound id, registered on first use from a WAV written ONCE into
   * Caches. AudioServices takes a file URL and nothing else — there is no
   * data API — and Caches is the right home for bytes the app can
   * regenerate at will: non-sensitive (a synthesized tone, not a
   * recording), never backed up, and purgeable, which is why the file's
   * existence is re-checked on every play and the id re-registered if the
   * system swept it. Nil on any failure, and nil means "no chime", never an
   * error into the receive path.
   */
  private func messageToneSoundIdOnQueue() -> SystemSoundID? {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    else { return nil }
    let dir = caches.appendingPathComponent("tacendum-audio", isDirectory: true)
    let url = dir.appendingPathComponent("message-tone.wav")
    if messageToneId != 0 {
      if FileManager.default.fileExists(atPath: url.path) { return messageToneId }
      AudioServicesDisposeSystemSoundID(messageToneId)
      messageToneId = 0
    }
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try Self.messageToneWav.write(to: url, options: .atomic)
    } catch {
      return nil
    }
    var id: SystemSoundID = 0
    guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else {
      return nil
    }
    messageToneId = id
    return id
  }

  // MARK: - session notifications

  @objc private func handleInterruption(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: raw) == .began
    else { return }
    queue.async {
      // The system already took the session; it is not ours to give back.
      self.sessionOwned = false
      if let rec = self.recorder, let url = self.recordingURL {
        // FINALIZE, don't lose: the recorder is already paused, so
        // stop closes the file around everything the encoder committed, and
        // the partial note lands in preview — sendable or discardable, not
        // silently gone.
        self.clearRecordingStateOnQueue()
        rec.delegate = nil
        rec.stop()
        if case .success(let result) = self.finalizeOnQueue(url: url) {
          self.onRecordingFinished?(result)
        }
        // A finalize failure here has no promise to reject and no event to
        // carry it; the UI's eventual stopRecording gets 'not_recording'
        // and resets. The file is already deleted either way.
      }
      if self.player != nil {
        // The player is paused with no resume path this UI offers; a bubble
        // stuck on "playing" over silence is a lie. Finished resets it.
        self.releasePlayerOnQueue()
        self.onPlaybackFinished?()
      }
      // A cellular call or Siri took the session mid-ring. A loop that
      // resumes over whatever comes next is not a ring — and the JS driver
      // has no interruption signal to restart it from, so ending it here is
      // final. (The interrupted Tacendum call is itself moments from ending
      // or timing out; a silent remainder of its ring is the right price.)
      self.stopRingbackOnQueue()
    }
  }

  /// Headphones unplugged mid-playback: iOS pauses the player rather than
  /// blasting a private voice note out of the speaker. Treat it as finished —
  /// the person re-taps to continue on the new route. Recording is
  /// unaffected; the recorder continues on whatever microphone remains.
  @objc private func handleRouteChange(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
    else { return }
    queue.async {
      guard let p = self.player, !p.isPlaying else { return }
      self.releasePlayerOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      self.onPlaybackFinished?()
    }
  }

  /// The media server died (rare, real). Every AV object we hold is invalid
  /// and must be discarded, not called — so this salvages what the encoder
  /// already committed to disk, through the same finalize-or-clean path as
  /// an interruption, minus the stop() a dead recorder cannot honour.
  @objc private func handleMediaServicesReset(_ note: Notification) {
    queue.async {
      self.sessionOwned = false
      let url = self.recordingURL
      let wasRecording = self.recorder != nil
      let wasPlaying = self.player != nil
      self.recorder?.delegate = nil
      self.clearRecordingStateOnQueue()
      self.player?.delegate = nil
      self.player = nil
      self.playerData = nil
      // Dead with the rest of the media server's objects: discarded, not
      // stopped — a reset player is not ours to call.
      self.ringbackPlayer = nil
      // The registered system sound went with the server too. Disposed and
      // zeroed so the next chime re-registers from the file — otherwise the
      // WAV still exists and `messageToneSoundIdOnQueue` would hand back
      // the dead id forever.
      if self.messageToneId != 0 {
        AudioServicesDisposeSystemSoundID(self.messageToneId)
        self.messageToneId = 0
      }
      if wasRecording, let url {
        if case .success(let result) = self.finalizeOnQueue(url: url) {
          self.onRecordingFinished?(result)
        }
      }
      if wasPlaying { self.onPlaybackFinished?() }
    }
  }

  // MARK: - plumbing

  /// Any call that has not ended — Tacendum's (CallKit-reported) or
  /// cellular. The refusal both entry points share.
  private var callIsActive: Bool {
    callObserver.calls.contains { !$0.hasEnded }
  }

  /// The polite half: deactivate with .notifyOthersOnDeactivation so
  /// backgrounded music resumes — but only when WE activated the session,
  /// nothing of ours still uses it, and no call has taken it in the
  /// meantime (the call owns it; CallKit deactivates it).
  private func deactivateSessionIfIdleOnQueue() {
    guard sessionOwned, recorder == nil, player == nil else { return }
    sessionOwned = false
    guard !callIsActive else { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Granted as a Bool, prompting only when undetermined. iOS 17 moved
  /// record permission to AVAudioApplication; the deprecated session API
  /// remains for the 15.1 floor. The answer may arrive on any thread —
  /// callers hop back onto the state queue before acting on it.
  private func withMicPermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      case .undetermined: AVAudioApplication.requestRecordPermission { completion($0) }
      @unknown default: completion(false)
      }
    } else {
      let session = AVAudioSession.sharedInstance()
      switch session.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      case .undetermined: session.requestRecordPermission { completion($0) }
      @unknown default: completion(false)
      }
    }
  }
}

// MARK: - AVAudioRecorderDelegate

extension TacendumAudioImpl: AVAudioRecorderDelegate {
  /// The CAP path: record(forDuration:) ran out. Manual stop and cancel
  /// detach the delegate first, so this fires only for the auto-stop — and
  /// if it races a manual stop onto the queue, whichever runs second finds
  /// the recorder already cleared and no-ops.
  public func audioRecorderDidFinishRecording(
    _ recorder: AVAudioRecorder, successfully flag: Bool
  ) {
    queue.async {
      guard recorder === self.recorder, let url = self.recordingURL else { return }
      self.clearRecordingStateOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      guard flag else {
        try? FileManager.default.removeItem(at: url)
        return
      }
      if case .success(let result) = self.finalizeOnQueue(url: url) {
        self.onRecordingFinished?(result)
      }
    }
  }

  /// The encoder died mid-flight. Salvage what it committed — the same
  /// finalize-or-clean path as the cap; the file never survives.
  public func audioRecorderEncodeErrorDidOccur(
    _ recorder: AVAudioRecorder, error: Error?
  ) {
    queue.async {
      guard recorder === self.recorder, let url = self.recordingURL else { return }
      self.clearRecordingStateOnQueue()
      recorder.delegate = nil
      recorder.stop()
      self.deactivateSessionIfIdleOnQueue()
      if case .success(let result) = self.finalizeOnQueue(url: url) {
        self.onRecordingFinished?(result)
      }
    }
  }
}

// MARK: - AVAudioPlayerDelegate

extension TacendumAudioImpl: AVAudioPlayerDelegate {
  public func audioPlayerDidFinishPlaying(
    _ player: AVAudioPlayer, successfully flag: Bool
  ) {
    queue.async {
      guard player === self.player else { return } // a switch already released it
      self.releasePlayerOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      self.onPlaybackFinished?()
    }
  }

  /// A mid-stream decode failure means the same thing to the UI as reaching
  /// the end: the control resets. The retained bytes are released either way.
  public func audioPlayerDecodeErrorDidOccur(
    _ player: AVAudioPlayer, error: Error?
  ) {
    queue.async {
      guard player === self.player else { return }
      self.releasePlayerOnQueue()
      self.deactivateSessionIfIdleOnQueue()
      self.onPlaybackFinished?()
    }
  }
}
