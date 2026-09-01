import Foundation

/**
 * What this notification is allowed to say, decided before anything is
 * decrypted.
 *
 * Read from files in the App Group container, because the extension cannot
 * reach the Keychain — doing so needs a shared `keychain-access-groups`
 * entitlement, and adding one rewrites the access group of items that already
 * exist, the lock passcode verifier among them.
 *
 * **Everything here fails closed.** A missing file, an unreadable container, a
 * value from a newer build: all of them mean "show nothing". That is the
 * opposite of the app's own default, and deliberately so — the app falls back
 * to the DEFAULT level because its only job is drawing a settings row, while
 * this decides what appears on a screen somebody else may be looking at.
 */
enum PreviewPolicy {
  enum Level: String {
    case full
    case sender
    case none
  }

  /// The file whose presence means a real session is open on this device.
  ///
  /// Written at a real unlock, removed at relock and on duress. Its ABSENCE is
  /// the safe state, which is also the state after a crash, a restore, a fresh
  /// install, and a reboot with no unlock since — so every one of those ends
  /// in a generic notification rather than somebody's message.
  private static let armedFile = "previews-armed"
  private static let levelFile = "preview-level"

  /**
   * The marker is a LEASE — `{"v":1,"deadline":<ms>}` — not a flag.
   *
   * A flag can only be revoked by a write, and the one moment revocation
   * matters most is the moment writes may not be possible: a duress entry
   * against shared-state files that turned read-only swallows both disarm
   * routes, and a flag would stay armed forever. A lease expires by itself —
   * the app renews the deadline at unlock and on backgrounding, so files
   * that cannot be written simply stop being renewed.
   *
   * The upper bound is the clock-rollback guard: a deadline further out than
   * any renewal could have written it is not a lease, it is a clock that
   * moved backwards after the write — honoured, it would stay armed for
   * however far the clock had drifted.
   */
  private static func leaseDeadline(_ text: String) -> Double? {
    guard let data = text.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          (obj["v"] as? Int) == 1,
          let deadline = (obj["deadline"] as? NSNumber)?.doubleValue
    else { return nil }
    let now = Date().timeIntervalSince1970 * 1000
    let plausible = 8.0 * 24 * 3600 * 1000
    guard now < deadline, deadline < now + plausible else { return nil }
    return deadline
  }

  private static func read(_ name: String) -> String? {
    guard let dir = SharedContainer.sharedStateRoot() else { return nil }
    return try? String(
      contentsOf: dir.appendingPathComponent(name),
      encoding: .utf8
    )
  }

  /// May this notification show anything beyond "New message"?
  ///
  /// Anything that does not parse as a live lease — a truncated write, a '0'
  /// left by the disarm fallback, an expired or implausible deadline — reads
  /// as disarmed.
  static func armed() -> Bool {
    guard let text = read(armedFile) else { return false }
    return leaseDeadline(text) != nil
  }

  /**
   * THE WRITE GATE: armed, and provably revocable.
   *
   * Before a preview may be rendered, the extension rewrites the lease in
   * place — same deadline, fresh witness — and reads its own write back. A
   * container where that fails is a container where the app's disarm would
   * ALSO fail, which is precisely the state in which a stale marker must not
   * be honoured: it can never be taken away, so it must not be usable. The
   * deadline is preserved verbatim; the extension proves the file is
   * writable, and never extends the permission.
   */
  static func armedAndWritable() -> Bool {
    guard let dir = SharedContainer.sharedStateRoot() else { return false }
    guard let text = try? String(
      contentsOf: dir.appendingPathComponent(armedFile), encoding: .utf8),
      leaseDeadline(text) != nil
    else { return false }

    // THE WITNESS IS A SEPARATE FILE, and the lease file is APP-OWNED — this
    // extension never writes it. The first version rewrote the lease itself
    // to prove writability, which opened a hole: interleave
    // "extension reads lease → duress DELETES it → extension's atomic write
    // recreates it" and the revocation is undone by the very gate meant to
    // enforce it. Writing a different file proves the same fact about the
    // container without being able to resurrect anything.
    let witnessURL = dir.appendingPathComponent("previews-witness")
    let witness = UUID().uuidString
    guard let data = witness.data(using: .utf8) else { return false }
    do {
      try data.write(
        to: witnessURL,
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
      )
    } catch { return false }
    guard let back = try? String(contentsOf: witnessURL, encoding: .utf8),
          back == witness
    else { return false }
    // And the lease must STILL be there after the proof — this is where the
    // read → delete → gate interleaving now lands: the delete wins.
    guard let again = try? String(
      contentsOf: dir.appendingPathComponent(armedFile), encoding: .utf8),
      leaseDeadline(again) != nil
    else { return false }
    return true
  }

  /// The owner's message-sound choice (`message-sound`, written by the app —
  /// app/src/messageSound.ts, Settings "Message sounds"). The one file here
  /// whose absence reads as ON: a missing, unreadable or unparseable value is
  /// the fresh-install state, and the default is on — the server's alert
  /// already carries `sound: default`, so honouring the default means
  /// touching nothing. Only a literal "0" turns the sound off, and OFF is
  /// the only direction this can move a banner: it never ADDS a sound to a
  /// notification that would have had none.
  ///
  /// Known limit, on record: the file is written under the
  /// shared-state protection class (readable only after the first unlock
  /// since boot), so between a reboot and that unlock an Off cannot be read
  /// and the banner keeps the server's default — the pre-feature sound, in
  /// the same window where previews fall back to "New message". Inverting
  /// the default (a silent `aps`, the extension adding a sound) would silence
  /// that window for every owner, including the default-ON majority, and
  /// would make this extension a line that SETS a sound; kept as built.
  static func messageSound() -> Bool {
    return read("message-sound") != "0"
  }

  static func level() -> Level {
    guard let raw = read(levelFile), let parsed = Level(rawValue: raw) else {
      // NOT the app's default. An unreadable preference here means the
      // extension does not know what it is allowed to reveal, and the only
      // safe answer to that is nothing.
      return .none
    }
    return parsed
  }

  /// The id this device decrypts as, published by the app when a real session
  /// opens and removed on relock and on duress.
  ///
  /// libsignal needs the local address as well as the sender's, and the push
  /// carries only the sender — the server does not put the recipient's own id
  /// in a payload it is delivering to them. Its absence is a second,
  /// independent reason the extension cannot decrypt, on top of the armed
  /// marker: no local address, nothing to decrypt with.
  static func selfUserId() -> String? {
    guard let id = read("self-user-id"), !id.isEmpty else { return nil }
    return id
  }

  /// Peers this device has blocked, mirrored out of the database by the app.
  ///
  /// A blocked sender can still put bytes on the wire — blocking is enforced
  /// on receipt, and is deliberately undetectable to them — so the server
  /// still queues their message and still sends a push. Without this the block
  /// would be visibly incomplete in the one place it is most conspicuous: the
  /// lock screen.
  static func blocked() -> Set<String> {
    guard let raw = read("blocked-peers") else { return [] }
    return Set(raw.split(separator: "\n").map(String.init).filter { !$0.isEmpty })
  }

  /// The saved display name for a peer, mirrored out of the database by the
  /// app (`PEER_NAMES_FILE` in app/src/nse.ts — written for CallKit's ring,
  /// read here to say WHO mentioned the owner at level `.full`).
  ///
  /// The same trust class as `groupName` below: app-written under
  /// `personName`'s precedence (the owner's name for a peer outranks the one
  /// the peer chose), deleted by `retractSelfId` on relock and on duress,
  /// and never a byte of any payload. Fails closed like everything above — a
  /// missing mirror, an unreadable container, an unknown peer — and every
  /// nil means the sender goes unnamed, so the banner falls back to its
  /// fixed constant rather than borrowing anything from the push.
  static func peerName(_ peerId: String) -> String? {
    guard let raw = read("peer-names"),
          let data = raw.data(using: .utf8),
          let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
          let name = map[peerId], !name.isEmpty
    else { return nil }
    return name
  }

  /// The name of a room, mirrored out of the database by the app
  /// (`GROUP_NAMES_FILE` in app/src/nse.ts).
  ///
  /// THE ONLY SOURCE A ROOM BANNER'S TITLE MAY HAVE. A `grp.msg` carries no
  /// name at all, and a `grp.new`'s claimed name is a sender-controlled byte
  /// this file never reads. Fails closed like everything above: a missing
  /// mirror, an unreadable container, a map from a newer build — all of them
  /// mean the room cannot be named, and an unnameable room's banner stays
  /// generic rather than borrowing anything from the payload.
  static func groupName(_ groupId: String) -> String? {
    guard let raw = read("group-names"),
          let data = raw.data(using: .utf8),
          let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
          let name = map[groupId], !name.isEmpty
    else { return nil }
    return name
  }
}
