import Foundation
import LibSignalClient

/**
 * File-backed libsignal protocol stores, mirroring the CLI layout.
 * Every stored record is libsignal's own serialized form —
 * this file only does storage, never cryptography. At-rest
 * protection is iOS Data Protection; the directory is excluded from backup.
 *
 * Layout under Application Support/tacendum-protocol/:
 *   identity.json            identity key pair (b64) + registration id
 *   sessions/<peer>.<dev>.bin
 *   identities/<peer>.<dev>.pub   TOFU-pinned peer identity keys
 *   prekeys/<id>.bin
 *   signed-prekeys/<id>.bin
 *   kyber-prekeys/<id>.bin
 */

final class TacendumStoreContext: StoreContext {}

enum StoreError: LocalizedError {
  case noIdentity
  case identityExists
  case missingRecord(String)
  case corrupt(String)
  case io(String)

  var errorDescription: String? {
    switch self {
    case .noIdentity: return "no identity — register first"
    case .identityExists: return "identity already exists; refusing to overwrite"
    case .missingRecord(let what): return "missing record: \(what)"
    case .corrupt(let what): return "corrupt store file: \(what)"
    case .io(let what): return "protocol store I/O failed: \(what)"
    }
  }
}

final class TacendumFileStores {
  /// The one irreplaceable file in the store.
  ///
  /// Exposed because the migration into the App Group container has to verify
  /// it arrived, and `hasIdentity()` has to check for it WITHOUT constructing
  /// a store — constructing one creates directories and can throw, and a throw
  /// there used to read as "this device has no identity", which is the answer
  /// that makes the app mint a fresh keypair and abandon the account.
  static let identityFileName = "identity.json"

  let root: URL

  private var identityPath: URL {
    root.appendingPathComponent(Self.identityFileName)
  }
  private var identitiesDir: URL { root.appendingPathComponent("identities", isDirectory: true) }
  private var sessionsDir: URL { root.appendingPathComponent("sessions", isDirectory: true) }
  private var prekeysDir: URL { root.appendingPathComponent("prekeys", isDirectory: true) }
  private var signedPrekeysDir: URL { root.appendingPathComponent("signed-prekeys", isDirectory: true) }
  private var kyberPrekeysDir: URL { root.appendingPathComponent("kyber-prekeys", isDirectory: true) }

  /// Held for this object's lifetime. See `deinit`.
  private var lockHeld = false

  /**
   * Opening a store TAKES THE CROSS-PROCESS LOCK, and closing it releases.
   *
   * The lock belongs to the object's lifetime rather than to each file write,
   * because the unit that has to be atomic is the whole operation — read the
   * session, decrypt, write it back. Locking the writes alone would still let
   * the app and the notification extension both read one session state and
   * both advance it, which does not fail loudly; it silently desynchronises
   * the ratchet so every later message in that conversation is undecryptable
   * on both sides, forever.
   *
   * Every caller in `TacendumCryptoImpl` has the same shape — `let stores =
   * try self.stores()` and then use it — so the lock covers exactly the store
   * access and is dropped once ARC releases the binding after its last use.
   * Anything a method does afterwards is base64 and JSON, which touches
   * nothing shared.
   */
  init(root: URL) throws {
    self.root = root
    // The container's lock file, NOT one inside the store: the migration
    // deletes the store directory, and a lock whose inode is unlinked stops
    // excluding anyone. The fallback is for host tests, which have no
    // container and no second process.
    try StoreLock.shared.lock(
      at: SharedContainer.storeLockFile() ?? root.appendingPathComponent(".lock")
    )
    lockHeld = true
    do {
      for dir in [root, identitiesDir, sessionsDir, prekeysDir, signedPrekeysDir, kyberPrekeysDir] {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      }
    } catch {
      // Never leave the lock held by an object that failed to initialise —
      // `deinit` does not run when `init` throws.
      StoreLock.shared.unlock()
      lockHeld = false
      throw error
    }
  }

  deinit {
    if lockHeld { StoreLock.shared.unlock() }
  }

  // MARK: - Local identity

  private struct IdentityFile: Codable {
    let identityKeyPair: String  // b64 of IdentityKeyPair.serialize()
    let registrationId: UInt32
  }

  /// Non-throwing for the notification extension's early guard.  An
  /// indeterminate lookup answers "present", never "absent": the next real
  /// read will throw and the extension can fall back without inviting any
  /// caller to mint a replacement identity.
  var hasIdentity: Bool {
    do {
      return try hasIdentityChecked()
    } catch {
      return true
    }
  }

  func hasIdentityChecked() throws -> Bool {
    try Self.pathExists(identityPath)
  }

  /// One-time initialization at registration. Refuses to overwrite.
  func initializeIdentity(_ keyPair: IdentityKeyPair, registrationId: UInt32) throws {
    guard try !hasIdentityChecked() else { throw StoreError.identityExists }
    let record = IdentityFile(
      identityKeyPair: keyPair.serialize().base64EncodedString(),
      registrationId: registrationId
    )
    try JSONEncoder().encode(record).write(to: identityPath, options: .atomic)
  }

  private func loadIdentityFile() throws -> IdentityFile {
    guard let data = try read(identityPath) else { throw StoreError.noIdentity }
    return try JSONDecoder().decode(IdentityFile.self, from: data)
  }

  // MARK: - Helpers

  private func addrKey(_ address: ProtocolAddress) -> String {
    "\(address.name).\(address.deviceId)"
  }

  /// `true` or `false` only when `lstat` could answer the question.  Foundation's
  /// `fileExists` collapses every lookup failure into `false`, which is not an
  /// absence predicate for account and ratchet state.
  static func pathExists(_ url: URL) throws -> Bool {
    var info = stat()
    guard lstat(url.path, &info) == 0 else {
      let code = errno
      if code == ENOENT { return false }
      throw StoreError.io("path lookup")
    }
    return true
  }

  static func removeIfPresent(_ url: URL) throws {
    guard try pathExists(url) else { return }
    do {
      try FileManager.default.removeItem(at: url)
    } catch {
      throw StoreError.io("record removal")
    }
  }

  /// Forget a peer's pinned identity + session so the next contact re-pins
  /// (TOFU) and rebuilds the ratchet — the "accept a changed safety number"
  /// flow.
  func clearPeer(_ address: ProtocolAddress) throws {
    let identity = identitiesDir.appendingPathComponent("\(addrKey(address)).pub")
    let session = sessionsDir.appendingPathComponent("\(addrKey(address)).bin")
    var firstError: Error?
    for target in [identity, session] {
      do {
        try Self.removeIfPresent(target)
      } catch {
        firstError = firstError ?? error
      }
    }
    if let firstError { throw firstError }
  }

  /// nil means the record is genuinely absent (file does not exist). A read
  /// failure on an EXISTING file throws — it must never be reported as absence,
  /// or a transient I/O error would silently reset a TOFU identity pin or drop
  /// a live session and re-bootstrap a fresh ratchet (fail-closed, not open).
  private func read(_ url: URL) throws -> Data? {
    guard try Self.pathExists(url) else { return nil }
    do {
      return try Data(contentsOf: url)
    } catch {
      throw StoreError.io("record")
    }
  }
}

// MARK: - IdentityKeyStore (TOFU; the safety-number UX builds on top)

extension TacendumFileStores: IdentityKeyStore {
  func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
    let file = try loadIdentityFile()
    guard let data = Data(base64Encoded: file.identityKeyPair) else {
      throw StoreError.corrupt("identity.json")
    }
    return try IdentityKeyPair(bytes: data)
  }

  func localRegistrationId(context: StoreContext) throws -> UInt32 {
    try loadIdentityFile().registrationId
  }

  private func peerPath(_ address: ProtocolAddress) -> URL {
    identitiesDir.appendingPathComponent("\(addrKey(address)).pub")
  }

  func saveIdentity(
    _ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext
  ) throws -> IdentityChange {
    let existing = try self.identity(for: address, context: context)
    let changed = existing != nil && existing!.serialize() != identity.serialize()
    try identity.serialize().write(to: peerPath(address), options: .atomic)
    return changed ? .replacedExisting : .newOrUnchanged
  }

  func isTrustedIdentity(
    _ identity: IdentityKey, for address: ProtocolAddress, direction: Direction,
    context: StoreContext
  ) throws -> Bool {
    guard let existing = try self.identity(for: address, context: context) else {
      return true  // trust on first use
    }
    return existing.serialize() == identity.serialize()
  }

  func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
    guard let data = try read(peerPath(address)) else { return nil }
    return try IdentityKey(bytes: data)
  }
}

// MARK: - PreKeyStore

extension TacendumFileStores: PreKeyStore {
  private func preKeyPath(_ id: UInt32) -> URL {
    prekeysDir.appendingPathComponent("\(id).bin")
  }

  /// The one-time prekeys still on disk, ascending. Consumed ones were
  /// removed by `removePreKey`, so this set defines the high-water mark above
  /// which fresh upload ids are minted. Existing records stay untouched for
  /// ciphertext already in flight against their private halves.
  func existingPreKeyIds() throws -> [UInt32] {
    // Check absence at the syscall boundary. `FileManager.fileExists` and a
    // broad `try?` both fold lookup failures into false/empty; only ENOENT is
    // allowed to mean that this directory genuinely is not there.
    guard try Self.pathExists(prekeysDir) else { return [] }

    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: prekeysDir.path)
    } catch {
      throw StoreError.io("prekey directory")
    }
    return names
      .filter { $0.hasSuffix(".bin") }
      .compactMap { UInt32($0.dropLast(4)) }
      .sorted()
  }

  func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
    guard let data = try read(preKeyPath(id)) else { throw StoreError.missingRecord("prekey \(id)") }
    return try PreKeyRecord(bytes: data)
  }

  func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
    try record.serialize().write(to: preKeyPath(id), options: .atomic)
  }

  func removePreKey(id: UInt32, context: StoreContext) throws {
    try? FileManager.default.removeItem(at: preKeyPath(id))
  }
}

// MARK: - SignedPreKeyStore

extension TacendumFileStores: SignedPreKeyStore {
  private func signedPreKeyPath(_ id: UInt32) -> URL {
    signedPrekeysDir.appendingPathComponent("\(id).bin")
  }

  func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
    guard let data = try read(signedPreKeyPath(id)) else {
      throw StoreError.missingRecord("signed prekey \(id)")
    }
    return try SignedPreKeyRecord(bytes: data)
  }

  func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try record.serialize().write(to: signedPreKeyPath(id), options: .atomic)
  }
}

// MARK: - KyberPreKeyStore

extension TacendumFileStores: KyberPreKeyStore {
  private func kyberPreKeyPath(_ id: UInt32) -> URL {
    kyberPrekeysDir.appendingPathComponent("\(id).bin")
  }

  func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
    guard let data = try read(kyberPreKeyPath(id)) else {
      throw StoreError.missingRecord("kyber prekey \(id)")
    }
    return try KyberPreKeyRecord(bytes: data)
  }

  func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try record.serialize().write(to: kyberPreKeyPath(id), options: .atomic)
  }

  /// Our single kyber prekey is last-resort (reusable) — never deleted.
  func markKyberPreKeyUsed(
    id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: StoreContext
  ) throws {
    // no-op by design
  }
}

// MARK: - SessionStore

extension TacendumFileStores: SessionStore {
  private func sessionPath(_ address: ProtocolAddress) -> URL {
    sessionsDir.appendingPathComponent("\(addrKey(address)).bin")
  }

  func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
    guard let data = try read(sessionPath(address)) else { return nil }
    return try SessionRecord(bytes: data)
  }

  func loadExistingSessions(
    for addresses: [ProtocolAddress], context: StoreContext
  ) throws -> [SessionRecord] {
    var out: [SessionRecord] = []
    for address in addresses {
      guard let session = try loadSession(for: address, context: context) else {
        throw StoreError.missingRecord("session \(addrKey(address))")
      }
      out.append(session)
    }
    return out
  }

  func storeSession(
    _ record: SessionRecord, for address: ProtocolAddress, context: StoreContext
  ) throws {
    try record.serialize().write(to: sessionPath(address), options: .atomic)
  }
}
