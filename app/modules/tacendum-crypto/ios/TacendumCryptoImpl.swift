import CryptoKit
import Foundation
import LibSignalClient
import Security

/**
 * All Signal-protocol operations for the app. Three parties
 * perform crypto in this file and no others: libsignal for
 * the protocol work and for `pinVerifier`'s Argon2 `PinHash`;
 * the platform — Keychain, `SecRandomCopyBytes`, and `CryptoKit.SHA256` for
 * the roster digest; nothing else. An earlier version of this
 * header said "every cryptographic call is a libsignal call", written before
 * the digest and the PIN hash existed and never updated — a header that
 * undercounts its own file is exactly the defect this one exists to prevent.
 * Called from TacendumCrypto.mm on a serial queue — store access is never
 * concurrent. Payloads are never logged.
 */
@objc(TacendumCryptoImpl)
public final class TacendumCryptoImpl: NSObject {
  @objc public static let shared = TacendumCryptoImpl()

  private let keychainService = "com.miranatechnologies.tacendum"
  private let deviceId: UInt32 = 1
  private let signedPreKeyId: UInt32 = 1
  private let kyberPreKeyId: UInt32 = 1
  private let oneTimePreKeyCount: UInt32 = 100

  private let context = TacendumStoreContext()

  private override init() {
    super.init()
  }

  // MARK: - Errors

  enum TacendumError: LocalizedError {
    case keychain(OSStatus, String)
    case rng(OSStatus)
    case badInput(String)
    /// A peer's identity key changed (safety number changed). The bridge maps
    /// this to the JS reject code "identity_changed" so the UI can block+warn.
    case identityChanged

    var errorDescription: String? {
      switch self {
      case .keychain(let status, let op): return "keychain \(op) failed (OSStatus \(status))"
      case .rng(let status): return "SecRandomCopyBytes failed (OSStatus \(status))"
      case .badInput(let detail): return "bad input: \(detail)"
      case .identityChanged: return "identity_changed: the peer's safety number changed"
      }
    }
  }

  // MARK: - Wire DTOs (shapes from @tacendum/shared)

  private struct SignedPrekeyDTO: Codable {
    let keyId: UInt32
    let pub: String
    let sig: String
  }

  private struct OneTimePrekeyDTO: Codable {
    let keyId: UInt32
    let pub: String
  }

  private struct UploadKeysDTO: Codable {
    let registrationId: UInt32
    let identityKey: String
    let signedPrekey: SignedPrekeyDTO
    let kyberPrekey: SignedPrekeyDTO
    let oneTimePrekeys: [OneTimePrekeyDTO]
  }

  private struct BundleDTO: Codable {
    let userId: String
    let registrationId: UInt32
    let identityKey: String
    let signedPrekey: SignedPrekeyDTO
    let kyberPrekey: SignedPrekeyDTO
    let oneTimePrekey: OneTimePrekeyDTO?
  }

  // MARK: - Protocol store location

  private static var storeDirName: String { SharedContainer.storeDirName }

  /// Where the store used to live: the app's own Application Support.
  ///
  /// Kept as a read source for the one-time migration, and NOT deleted when
  /// that migration succeeds. A release from now, when every install has
  /// migrated and been seen to work, it can go.
  ///
  /// **It is a FORENSIC copy, not a rollback path**, and the earlier version
  /// of this comment claimed otherwise. Downgrading to a build that reads the
  /// legacy store would resume a ratchet the App Group copy has since advanced
  /// past, and re-upgrading would jump back — two divergent histories for one
  /// session, which the peer answers with rejected or duplicated messages. If
  /// that build then re-registered, it would mint a second identity that the
  /// migration marker guarantees is never adopted.
  ///
  /// So what this buys is narrower than "rollback" and still worth having: if
  /// the migration goes wrong, the bytes are still on the device and can be
  /// recovered deliberately. It is not something to fall back to by accident.
  static func legacyProtocolStoreRoot() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    return base.appendingPathComponent(storeDirName, isDirectory: true)
  }

  /**
   * The protocol store, now inside the App Group container so the
   * notification-service extension can decrypt.
   *
   * **A NIL CONTAINER CALLS `fatalError`, AND THAT IS THE SAFE CHOICE.**
   *
   * A previous bridge converted errors here into `hasIdentity() == false` —
   * the answer that tells registration to mint a FRESH identity keypair. That
   * fail-open bridge is gone: `hasIdentity()` now rejects unless absence is a
   * confirmed ENOENT. A nil container remains a build-time invariant violation
   * rather than a recoverable runtime state, so it is still made unmistakable.
   *
   * That former chain turned "this build's entitlement is misconfigured" into
   * "your account is gone", silently, on launch. The fatal invariant remains
   * loud and recoverable by correcting the entitlement and launching again —
   * with every byte of the store still on disk.
   *
   * The container is nil only when the App Group entitlement is missing or
   * misspelled, which is a build-time mistake, not a runtime condition. There
   * is no user-facing state in which this is expected.
   */
  static func protocolStoreRoot() throws -> URL {
    guard let container = SharedContainer.root() else {
      fatalError(
        """
        App Group container unavailable (\(appGroupIdentifier)).
        Refusing to continue: this build cannot locate the irreplaceable \
        protocol store. Check com.apple.security.application-groups on the \
        app AND the extension, and that the provisioning profile carries it.
        """
      )
    }
    var dir = container.appendingPathComponent(storeDirName, isDirectory: true)
    // withIntermediateDirectories succeeds on an existing directory, so this is
    // both the create and the no-op path.
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    // Extracted so it can be exercised on the host against real directories —
    // see StoreMigration.swift and its harness. This file
    // imports LibSignalClient and cannot be compiled outside an iOS build, and
    // the single most destructive function in the project should not be one
    // that only runs when somebody builds for a device.
    try StoreMigration.run(
      legacy: legacyProtocolStoreRoot(),
      destination: dir,
      identityFileName: TacendumFileStores.identityFileName,
      lockFile: SharedContainer.storeLockFile()
    )
    // Re-asserted on every call rather than only at creation: a directory made
    // by a build that predates this flag, or one that came back from a restore
    // without it, would otherwise never get it. Read first so the steady state
    // is one stat and no write, and never fatal — failing to set a *backup*
    // flag must not take out every crypto call.
    //
    // (This used to warn that a throw here would be read as "no identity" and
    // prompt a re-registration. That is no longer true: `hasIdentity()` checks
    // the identity file directly and never builds a store. Kept non-fatal
    // anyway — a backup flag is not worth an error on any path.)
    if (try? dir.resourceValues(forKeys: [.isExcludedFromBackupKey]))?
      .isExcludedFromBackup != true
    {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? dir.setResourceValues(values)
    }
    return dir
  }

  // MARK: - Shared state (files the notification extension will read)

  /**
   * Small state files that must be legible to a process which is NOT this app.
   *
   * WHY FILES AND NOT THE KEYCHAIN. The notification-service extension needs to
   * know how much of a message it is allowed to show. The obvious place for a
   * preference is the Keychain, where the read-receipt and screen-security
   * settings live — but an extension can only read Keychain items through a
   * shared `keychain-access-groups` entitlement, and adding one CHANGES THE
   * ACCESS GROUP OF ITEMS THAT ALREADY EXIST. The lock passcode verifier is one
   * of them. Getting that wrong locks the owner out of their own app, which is
   * a worse failure than any notification behaviour is worth.
   *
   * WHY NOT SQLITE. op-sqlite is a JSI HostObject; touching the database from
   * an extension would boot Hermes inside a process with roughly 24 MB of dirty
   * memory to spend.
   *
   * So: plain files, one value each, in a directory both processes can reach.
   *
   * It lives NEXT TO the protocol store, and in this class, because this is
   * already the one place that knows where the container is — and the step that
   * moves the container to an App Group has to move both together or the
   * extension gets one and not the other.
   *
   * THE APP GROUP CONTAINER, and NOT the app's own container with a fallback.
   *
   * A fallback would be the worst possible behaviour here. If the group is
   * misconfigured — a typo in one entitlement, a provisioning profile that
   * does not carry it — then falling back to the app container gives a store
   * that works perfectly for the app and is invisible to the extension. The
   * settings screen would save a preference, read it back, and show it
   * correctly, while every notification quietly ignored it. Throwing means the
   * misconfiguration surfaces the first time anything touches this, instead of
   * as "previews just do not work" months later.
   *
   * The identifier is compiled in rather than read from the entitlement,
   * because the entitlement is the thing being checked: reading the group name
   * from the same file that grants it would make a typo agree with itself.
   */
  static var appGroupIdentifier: String { SharedContainer.appGroupIdentifier }

  static func sharedStateRoot() throws -> URL {
    guard let base = SharedContainer.root() else {
      throw NSError(
        domain: "TacendumCrypto",
        code: 23,
        userInfo: [
          NSLocalizedDescriptionKey:
            "app group container unavailable — check the entitlement on both targets",
        ]
      )
    }
    let dir = base.appendingPathComponent("tacendum-shared", isDirectory: true)
    try FileManager.default.createDirectory(
      at: dir,
      withIntermediateDirectories: true,
      // Readable once the device has been unlocked ONCE since boot, and not
      // before. That is exactly the guarantee the extension needs and exactly
      // the limit it must live with: a notification arriving on a phone that
      // rebooted and has not been unlocked cannot be previewed, by anyone,
      // because the bytes are not readable yet. `.complete` would be stricter
      // and would break every notification while the phone sits locked in a
      // pocket, which is when notifications matter most.
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    return dir
  }

  /// Reject anything that is not a plain lowercase name.
  ///
  /// These names come from JS, and a name is turned into a path. `..`, a
  /// slash, or a percent-escape would let a caller write outside the directory
  /// — including over the protocol store, which is its sibling. An allowlist
  /// rather than a denylist: there are three of these files and they are all
  /// spelled like `preview-level`.
  private static func sharedStateURL(_ name: String) throws -> URL {
    let ok = !name.isEmpty
      && name.count <= 64
      && name.allSatisfy { $0.isLowercase && $0.isLetter || $0.isNumber || $0 == "-" }
    guard ok else {
      throw NSError(
        domain: "TacendumCrypto",
        code: 22,
        userInfo: [NSLocalizedDescriptionKey: "invalid shared state name"]
      )
    }
    return try sharedStateRoot().appendingPathComponent(name, isDirectory: false)
  }

  /**
   * Prepare the backup-excluded DIRECTORY the SQLite databases live in, and
   * say where to open the named database.
   *
   * The message database is plain SQLite (`db.ts`: at-rest protection is iOS
   * Data Protection, not app-side crypto). Data Protection governs readability
   * on a locked device and has nothing to say about the backup service, so the
   * database — and every decrypted image in it — was copied into iCloud and
   * Finder backups in the clear. The key store has always been excluded, which
   * is why a restored backup cannot resurrect the ACCOUNT; this makes the
   * message text match the same promise.
   *
   * The whole design — why a directory rather than per-file flags, the
   * rejected alternatives, and the one-time migration from the Library root —
   * is argued in DatabaseDirectory.swift. This wrapper only validates the
   * name and marshals the result.
   *
   * SYNCHRONOUS AND NON-THROWING, unlike everything else in this file: it is
   * a TurboModule sync method, because the migration must complete before
   * op-sqlite's `open()` touches the new path and the JS caller (`db.ts
   * conn()`) is synchronous. Failures come back as `{"error": ...}` with
   * GENERIC text — no filenames (an error naming the
   * decoy would prove the decoy is armed). A failed exclusion is NOT an
   * error: it returns `excluded: false` so the caller can warn without the
   * open failing — the Bool that the old design silently discarded.
   *
   * `name` is a bare filename, validated to stay inside Library: a caller
   * that could pass `../` would be choosing where the migration moves files.
   */
  @objc public func prepareDatabaseDirectory(_ name: String) -> String {
    let ok = !name.isEmpty
      && name.count <= 64
      && !name.contains("/")
      && !name.contains("..")
    guard ok else {
      return #"{"error":"invalid database file name"}"#
    }
    guard
      let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
    else {
      return #"{"error":"no library directory"}"#
    }
    do {
      let prepared = try DatabaseDirectory.prepare(name: name, library: library)
      let dto: [String: Any] = [
        "location": prepared.location.path,
        "excluded": prepared.excluded,
      ]
      let data = try JSONSerialization.data(withJSONObject: dto)
      return String(decoding: data, as: UTF8.self)
    } catch {
      return #"{"error":"database directory migration failed"}"#
    }
  }

  @objc public func writeSharedState(_ name: String, value: String) throws {
    let url = try Self.sharedStateURL(name)
    // Atomic: the extension may read this at any moment, including while it is
    // being rewritten. A torn read of a preference that decides how much of a
    // message to show would be a preference that silently means nothing.
    try Data(value.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Empty string when the file does not exist.
  ///
  /// Absence is a legitimate state — the app has never written this value, or
  /// it was deliberately deleted — so it is not an error. Every caller has a
  /// safe default for the empty case, and that default is what makes the
  /// "delete to disarm" pattern work.
  @objc public func readSharedState(_ name: String) -> String {
    guard let url = try? Self.sharedStateURL(name),
          let data = try? Data(contentsOf: url),
          let text = String(data: data, encoding: .utf8)
    else { return "" }
    return text
  }

  @objc public func deleteSharedState(_ name: String) throws {
    let url = try Self.sharedStateURL(name)
    // Deleting something that is not there is success, not failure: this is
    // called on relock and on duress, where the only thing that matters is
    // that the file is gone afterwards.
    try TacendumFileStores.removeIfPresent(url)
  }

  private func stores() throws -> TacendumFileStores {
    try TacendumFileStores(root: Self.protocolStoreRoot())
  }

  private func address(_ userId: String) throws -> ProtocolAddress {
    try ProtocolAddress(name: userId, deviceId: deviceId)
  }

  private static func b64(_ data: Data) -> String {
    data.base64EncodedString()
  }

  private static func bytes(_ b64: String, _ what: String) throws -> Data {
    guard let data = Data(base64Encoded: b64) else {
      throw TacendumError.badInput("\(what) is not base64")
    }
    return data
  }

  // MARK: - Key management

  /// Generate identity + prekeys, persist private halves, return the public
  /// halves as JSON in the PUT /v1/keys shape (mirrors the CLI).
  @objc public func generateAndStoreKeys() throws -> String {
    let stores = try self.stores()

    let identity = IdentityKeyPair.generate()
    // 14-bit registration id (1..16383) from the platform RNG, Signal convention.
    let registrationId = try UInt32(randomInt(upperExclusive: 16383)) + 1
    try stores.initializeIdentity(identity, registrationId: registrationId)

    let now = UInt64(Date().timeIntervalSince1970 * 1000)

    // Signed (EC) prekey: signature over the serialized public key.
    let spkPriv = PrivateKey.generate()
    let spkSig = identity.privateKey.generateSignature(message: spkPriv.publicKey.serialize())
    let spkRecord = try SignedPreKeyRecord(
      id: signedPreKeyId, timestamp: now, privateKey: spkPriv, signature: spkSig)
    try stores.storeSignedPreKey(spkRecord, id: signedPreKeyId, context: context)

    // Signed last-resort Kyber prekey (PQXDH).
    let kyberPair = KEMKeyPair.generate()
    let kyberSig = identity.privateKey.generateSignature(message: kyberPair.publicKey.serialize())
    let kyberRecord = try KyberPreKeyRecord(
      id: kyberPreKeyId, timestamp: now, keyPair: kyberPair, signature: kyberSig)
    try stores.storeKyberPreKey(kyberRecord, id: kyberPreKeyId, context: context)

    // One-time (EC) prekeys.
    var oneTimePrekeys: [OneTimePrekeyDTO] = []
    for id in 1...oneTimePreKeyCount {
      let priv = PrivateKey.generate()
      try stores.storePreKey(
        PreKeyRecord(id: id, privateKey: priv), id: id, context: context)
      oneTimePrekeys.append(
        OneTimePrekeyDTO(keyId: id, pub: Self.b64(priv.publicKey.serialize())))
    }

    let upload = UploadKeysDTO(
      registrationId: registrationId,
      identityKey: Self.b64(identity.publicKey.serialize()),
      signedPrekey: SignedPrekeyDTO(
        keyId: signedPreKeyId,
        pub: Self.b64(spkPriv.publicKey.serialize()),
        sig: Self.b64(spkSig)),
      kyberPrekey: SignedPrekeyDTO(
        keyId: kyberPreKeyId,
        pub: Self.b64(kyberPair.publicKey.serialize()),
        sig: Self.b64(kyberSig)),
      oneTimePrekeys: oneTimePrekeys
    )
    return String(decoding: try JSONEncoder().encode(upload), as: UTF8.self)
  }

  /**
   * The full key bundle for an identity that ALREADY exists, rebuilt from the
   * records on disk — a Swift port of the CLI's `existingKeysForUpload`
   * (packages/cli/src/messaging.ts), which proved the app comment that
   * claimed this was impossible wrong: every stored record carries its public
   * half and signature.
   *
   * This is what lets registration KEEP an identity instead of destroying it.
   * The server's PUT /v1/keys is an upsert conditioned on the same identity
   * key, so re-uploading is idempotent; and the branch that used to call
   * `resetProtocolState` here — the one place the app destroyed an identity —
   * existed only because there was no way to produce this payload.
   *
   * Nothing is rotated, deliberately, same reasoning as the CLI: the identity
   * is the account and immutable server-side, and regenerating one-time
   * prekeys would strand any ciphertext already queued against the old ones —
   * the sender's X3DH picked a prekey whose private half would just have been
   * overwritten. Only the prekeys still on disk are advertised; consumed ones
   * are gone with their private halves.
   */
  @objc public func existingKeysForUpload() throws -> String {
    let stores = try self.stores()
    let identity = try stores.identityKeyPair(context: context)
    let registrationId = try stores.localRegistrationId(context: context)
    let spk = try stores.loadSignedPreKey(id: signedPreKeyId, context: context)
    let kyber = try stores.loadKyberPreKey(id: kyberPreKeyId, context: context)

    // FRESH one-time prekeys, at ids the store has never used — never a
    // re-advertisement of what is already on disk. The survivors' public
    // halves were the first version, and that is
    // wrong: the server consumes a prekey when a PEER FETCHES the bundle,
    // but this phone deletes its private half only when the resulting prekey
    // MESSAGE arrives. A key fetched-but-not-yet-used is still on disk here,
    // so re-uploading the survivors hands the same prekey to a second peer —
    // and whichever ciphertext lands second is undecryptable forever.
    //
    // New ids, old records kept: the in-flight ciphertext built against an
    // old prekey still finds its private half; the server's pool is replaced
    // wholesale with keys nobody has ever been handed. (The CLI's
    // `existingKeysForUpload` re-advertises survivors and carries this same
    // defect.)
    let nextId = (try stores.existingPreKeyIds().max() ?? 0) + 1
    var oneTimePrekeys: [OneTimePrekeyDTO] = []
    for id in nextId..<(nextId + oneTimePreKeyCount) {
      let priv = PrivateKey.generate()
      try stores.storePreKey(
        PreKeyRecord(id: id, privateKey: priv), id: id, context: context)
      oneTimePrekeys.append(
        OneTimePrekeyDTO(keyId: id, pub: Self.b64(priv.publicKey.serialize())))
    }

    let upload = UploadKeysDTO(
      registrationId: registrationId,
      identityKey: Self.b64(identity.publicKey.serialize()),
      signedPrekey: SignedPrekeyDTO(
        keyId: signedPreKeyId,
        pub: Self.b64(try spk.publicKey().serialize()),
        sig: Self.b64(spk.signature)),
      kyberPrekey: SignedPrekeyDTO(
        keyId: kyberPreKeyId,
        pub: Self.b64(try kyber.publicKey().serialize()),
        sig: Self.b64(kyber.signature)),
      oneTimePrekeys: oneTimePrekeys
    )
    return String(decoding: try JSONEncoder().encode(upload), as: UTF8.self)
  }

  /**
   * Does this device already have an identity keypair?
   *
   * **Answered by looking at the file, not by building a store.** It used to
   * be `try? self.stores()` with `return false` on failure, and that turned
   * every possible error into the single most consequential answer this
   * function can give. `TacendumFileStores.init` creates six directories, so a
   * full disk, a container that is briefly unwritable, or a protection class
   * that has not unlocked yet all produced "no identity" — and "no identity"
   * is how the app decides to register, which mints a FRESH keypair and
   * abandons the account that is sitting right there on disk.
   *
   * Checking `identity.json` directly avoids constructing a store, but the
   * check still has to throw: both root preparation and the path lookup can
   * fail, and `false` is reserved for a confirmed ENOENT. The JS boot path
   * already catches this method's rejection as `true`, which is the
   * fail-closed direction.
   *
   * This avoids constructing a store; it uses the same exact ENOENT-only
   * predicate as store reads. A registration that follows will build the store
   * and create the record directories then.
   */
  @objc public func hasIdentity() throws -> NSNumber {
    let root = try Self.protocolStoreRoot()
    return NSNumber(
      value: try TacendumFileStores.pathExists(
        root.appendingPathComponent(TacendumFileStores.identityFileName)
      )
    )
  }

  // MARK: - Account authentication

  /// Domain tag prefixed to every account challenge before signing.
  ///
  /// MUST equal `AUTH_CHALLENGE_DOMAIN` in packages/shared/src/dto.ts. These
  /// two constants are the client and server halves of one agreement, and
  /// nothing at build time can check that they match: a mismatch compiles
  /// cleanly, passes every unit test on both sides, and makes it impossible for
  /// anyone to sign in. Change one, change the other, and re-run the live probe.
  private static let authChallengeDomain = "tacendum-auth-v2"

  /// Sign a server-issued challenge with the identity private key.
  ///
  /// The signed bytes are:
  ///
  ///     domain ‖ uint16be(originBytes.count) ‖ originBytes ‖ RAW challenge
  ///
  /// — the RAW DECODED challenge, not the base64 text of it. Signing the base64
  /// string instead would be the easiest possible mistake here and would fail
  /// only against the deployed server, so it is spelled out rather than left to
  /// the reader.
  ///
  /// VERIFY WITH the signer transcription harness, which
  /// transcribes the construction below and checks it against the vectors. If
  /// you change these bytes, change that harness in the same commit, or it will
  /// go on passing against its own stale copy and prove nothing.
  ///
  /// THIS IS A HAND-MIRROR of `authSignedBytes()` in packages/shared/src/dto.ts,
  /// which is the authority. Nothing at build time checks that they agree, so
  /// `packages/shared/authvectors.json` pins known inputs to expected bytes —
  /// verify against it on device after touching either side. Four hand-written
  /// copies of this format is how the origin came to be missing from it.
  ///
  /// The origin is the AUDIENCE. Without it a signature is
  /// valid at any verifier, so a hostile endpoint could relay a real challenge,
  /// collect the signature, and redeem it at the real server as this account.
  /// It arrives from TypeScript rather than being read here, so exactly one
  /// place decides which server this install talks to.
  ///
  /// Same primitive libsignal already uses for the signed prekey below
  /// (`generateSignature`): no new cryptography, and
  /// the private key never crosses the bridge.
  @objc(signAuthChallenge:apiOrigin:error:)
  public func signAuthChallenge(_ challengeB64: String, apiOrigin: String) throws -> String {
    let challenge = try Self.bytes(challengeB64, "challenge")
    guard !challenge.isEmpty else {
      throw TacendumError.badInput("challenge must not be empty")
    }
    let originBytes = Data(apiOrigin.utf8)
    guard !originBytes.isEmpty, originBytes.count <= 0xFFFF else {
      // An empty audience verifies against nothing and would silently restore
      // the relay this length-prefixed field exists to close.
      throw TacendumError.badInput("apiOrigin must be a non-empty origin")
    }
    let stores = try self.stores()
    guard try stores.hasIdentityChecked() else {
      // Signing before keys exist is a caller-ordering bug: keypair accounts
      // generate the identity FIRST and authenticate with it second.
      throw TacendumError.badInput("no identity to sign with; generate keys first")
    }
    let identity = try stores.identityKeyPair(context: context)
    var message = Data(Self.authChallengeDomain.utf8)
    message.append(UInt8((originBytes.count >> 8) & 0xFF))
    message.append(UInt8(originBytes.count & 0xFF))
    message.append(originBytes)
    message.append(challenge)
    return Self.b64(identity.privateKey.generateSignature(message: message))
  }

  /// The account's identity public key, base64.
  ///
  /// Needed on every launch AFTER the first: `generateAndStoreKeys` returns it
  /// once and then refuses to run again (initializeIdentity throws if an
  /// identity exists), so re-authenticating an existing install has no other
  /// way to name the account. Returns '' when there is no identity, matching
  /// how `getSecret` reports absence, so the caller branches on a value rather
  /// than catching.
  @objc public func identityPublicKey() throws -> String {
    let stores = try self.stores()
    guard try stores.hasIdentityChecked() else { return "" }
    return Self.b64(try stores.identityKeyPair(context: context).publicKey.serialize())
  }

  // MARK: - Device linking

  /// Domain tag prefixed to every link-op preimage before signing.
  ///
  /// MUST equal `LINK_DOMAIN` in packages/shared/src/dto.ts — the client and
  /// server halves of one agreement, hardcoded HERE exactly as
  /// `tacendum-auth-v2` is: the same identity key signs auth
  /// challenges and link ops, so every distinct thing it signs must be
  /// unambiguously tagged, and no JS caller may choose the tag.
  private static let linkOpDomain = "tacendum-link-v1"

  /// The five ops the domain frames. A sixth op is
  /// a protocol change, refused here before anything is signed.
  private static let linkOps: Set<String> = ["offer", "accept", "unlink", "revoke", "dissolve"]

  /// Sign one op-framed link-op preimage with the identity private key.
  ///
  /// The signed bytes are:
  ///
  ///     "tacendum-link-v1" ‖ op ‖ groupId ‖ offererUlid ‖ acceptorUlid ‖
  ///     subjectIdentityPubKey ‖ class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt
  ///
  /// — EVERY field after the domain uint16be-length-prefixed (none is
  /// fixed-width, and two ULIDs sit adjacent: one field's end being another's
  /// beginning is the oldest concatenation bug there is). The subject key is
  /// the RAW DECODED serialized key bytes, not its base64 text — signing the
  /// spelling would make the signature depend on a transport encoding. The
  /// two integers arrive as ASCII-decimal strings from the facade
  /// (`String(n)` — TS is the one place that decides integer formatting) and
  /// are guarded to digits here, so a float or exponent spelling is refused
  /// rather than signed.
  ///
  /// THIS IS A HAND-MIRROR of `linkOpSignedBytes()` in
  /// packages/shared/src/dto.ts, which is the authority. Nothing at build
  /// time checks that the copies agree, so `packages/shared/linkvectors.json`
  /// pins known tuples to expected bytes and
  /// `packages/shared/linkvectors-swift.json` carries a device-run of THIS
  /// construction (minted by scripts/mint-linkvectors.sh, verified under the
  /// server's Node libsignal verify by app/__tests__/link-vectors.test.ts).
  /// **Change these bytes and you re-mint those fixtures in the same
  /// commit**, or they go on passing against a stale copy and prove nothing.
  ///
  /// Same primitive libsignal already uses for the signed prekey and the auth
  /// challenge (`generateSignature`): no new
  /// cryptography, and the private key never crosses the bridge.
  @objc(signLinkOp:groupId:offererUserId:acceptorUserId:subjectIdentityPubKeyB64:deviceClass:rosterEpoch:offerNonce:expiresAt:error:)
  public func signLinkOp(
    _ op: String,
    groupId: String,
    offererUserId: String,
    acceptorUserId: String,
    subjectIdentityPubKeyB64: String,
    deviceClass: String,
    rosterEpoch: String,
    offerNonce: String,
    expiresAt: String
  ) throws -> String {
    let message = try Self.linkOpMessage(
      op: op,
      groupId: groupId,
      offererUserId: offererUserId,
      acceptorUserId: acceptorUserId,
      subjectIdentityPubKeyB64: subjectIdentityPubKeyB64,
      deviceClass: deviceClass,
      rosterEpoch: rosterEpoch,
      offerNonce: offerNonce,
      expiresAt: expiresAt
    )
    let stores = try self.stores()
    guard try stores.hasIdentityChecked() else {
      throw TacendumError.badInput("no identity to sign with; generate keys first")
    }
    let identity = try stores.identityKeyPair(context: context)
    return Self.b64(identity.privateKey.generateSignature(message: message))
  }

  /// The ONE preimage assembly the signer above and the verifier below
  /// share: identical bytes by construction, so sign and verify cannot
  /// drift — the linkvectors fixtures and the link-signer
  /// transcription check go on pinning this exact byte stream.
  private static func linkOpMessage(
    op: String,
    groupId: String,
    offererUserId: String,
    acceptorUserId: String,
    subjectIdentityPubKeyB64: String,
    deviceClass: String,
    rosterEpoch: String,
    offerNonce: String,
    expiresAt: String
  ) throws -> Data {
    guard Self.linkOps.contains(op) else {
      throw TacendumError.badInput("unknown link op")
    }
    let digits = CharacterSet(charactersIn: "0123456789")
    for integer in [rosterEpoch, expiresAt] {
      guard !integer.isEmpty, integer.unicodeScalars.allSatisfy({ digits.contains($0) }) else {
        throw TacendumError.badInput("link-op integers must be ASCII decimal")
      }
    }
    let subject = try Self.bytes(subjectIdentityPubKeyB64, "subjectIdentityPubKey")
    let fields: [Data] = [
      Data(op.utf8),
      Data(groupId.utf8),
      Data(offererUserId.utf8),
      Data(acceptorUserId.utf8),
      subject,
      Data(deviceClass.utf8),
      Data(rosterEpoch.utf8),
      Data(offerNonce.utf8),
      Data(expiresAt.utf8),
    ]
    var message = Data(Self.linkOpDomain.utf8)
    for field in fields {
      guard !field.isEmpty, field.count <= 0xFFFF else {
        // An empty field verifies against nothing anyone meant to say, and an
        // oversize one cannot be length-prefixed. Both are caller bugs.
        throw TacendumError.badInput("link-op field empty or too long")
      }
      message.append(UInt8((field.count >> 8) & 0xFF))
      message.append(UInt8(field.count & 0xFF))
      message.append(field)
    }
    return message
  }

  /// Verify one op-framed link-op identity signature against a
  /// caller-supplied identity public key. The same libsignal verify the
  /// server's `verifyIdentitySignature` runs, over the same shared preimage
  /// the signer above assembles; a malformed key or signature answers FALSE
  /// (a bad certificate is indistinguishable from a wrong one), while a
  /// malformed tuple still throws — that is a caller bug, exactly as it is
  /// for the signer. No key material is touched: this reads only PUBLIC
  /// keys the caller supplies (no new primitive; the
  /// verify half of the identity-signature machinery already in use).
  @objc(verifyLinkOp:op:groupId:offererUserId:acceptorUserId:subjectIdentityPubKeyB64:deviceClass:rosterEpoch:offerNonce:expiresAt:signatureB64:error:)
  public func verifyLinkOp(
    _ identityPubKeyB64: String,
    op: String,
    groupId: String,
    offererUserId: String,
    acceptorUserId: String,
    subjectIdentityPubKeyB64: String,
    deviceClass: String,
    rosterEpoch: String,
    offerNonce: String,
    expiresAt: String,
    signatureB64: String
  ) throws -> NSNumber {
    let message = try Self.linkOpMessage(
      op: op,
      groupId: groupId,
      offererUserId: offererUserId,
      acceptorUserId: acceptorUserId,
      subjectIdentityPubKeyB64: subjectIdentityPubKeyB64,
      deviceClass: deviceClass,
      rosterEpoch: rosterEpoch,
      offerNonce: offerNonce,
      expiresAt: expiresAt
    )
    guard
      let keyBytes = try? Self.bytes(identityPubKeyB64, "identityPubKey"),
      let signature = try? Self.bytes(signatureB64, "signature"),
      let publicKey = try? PublicKey(keyBytes)
    else {
      return NSNumber(value: false)
    }
    let verified = (try? publicKey.verifySignature(message: message, signature: signature)) ?? false
    return NSNumber(value: verified)
  }

  // MARK: - Sessions / messaging

  /// X3DH/PQXDH session bootstrap from a fetched prekey bundle.
  @objc public func processPreKeyBundle(_ bundleJson: String, selfUserId: String) throws {
    let dto = try JSONDecoder().decode(BundleDTO.self, from: Data(bundleJson.utf8))
    let stores = try self.stores()

    let identityKey = try IdentityKey(bytes: Self.bytes(dto.identityKey, "identityKey"))
    let signedPub = try PublicKey(Self.bytes(dto.signedPrekey.pub, "signedPrekey.pub"))
    let signedSig = try Self.bytes(dto.signedPrekey.sig, "signedPrekey.sig")
    let kyberPub = try KEMPublicKey(Self.bytes(dto.kyberPrekey.pub, "kyberPrekey.pub"))
    let kyberSig = try Self.bytes(dto.kyberPrekey.sig, "kyberPrekey.sig")

    let bundle: PreKeyBundle
    if let oneTime = dto.oneTimePrekey {
      bundle = try PreKeyBundle(
        registrationId: dto.registrationId,
        deviceId: deviceId,
        prekeyId: oneTime.keyId,
        prekey: try PublicKey(Self.bytes(oneTime.pub, "oneTimePrekey.pub")),
        signedPrekeyId: dto.signedPrekey.keyId,
        signedPrekey: signedPub,
        signedPrekeySignature: signedSig,
        identity: identityKey,
        kyberPrekeyId: dto.kyberPrekey.keyId,
        kyberPrekey: kyberPub,
        kyberPrekeySignature: kyberSig
      )
    } else {
      // Empty-pool bundle: signed + kyber only.
      bundle = try PreKeyBundle(
        registrationId: dto.registrationId,
        deviceId: deviceId,
        signedPrekeyId: dto.signedPrekey.keyId,
        signedPrekey: signedPub,
        signedPrekeySignature: signedSig,
        identity: identityKey,
        kyberPrekeyId: dto.kyberPrekey.keyId,
        kyberPrekey: kyberPub,
        kyberPrekeySignature: kyberSig
      )
    }

    do {
      try LibSignalClient.processPreKeyBundle(
        bundle,
        for: try address(dto.userId),
        ourAddress: try address(selfUserId),
        sessionStore: stores,
        identityStore: stores,
        context: context
      )
    } catch where Self.isIdentityChange(error) {
      throw TacendumError.identityChanged
    }
  }

  @objc public func hasSession(_ peerUserId: String) throws -> NSNumber {
    let stores = try self.stores()
    let session = try stores.loadSession(for: try address(peerUserId), context: context)
    return NSNumber(value: session != nil)
  }

  // MARK: - Safety numbers / identity change

  /// Safety-number parameters — MUST match the CLI (packages/cli messaging.ts)
  /// so the same pair shows the same number on the app and the CLI.
  private let safetyIterations = 5200
  private let safetyVersion = 0

  /// Displayable safety number for (self, peer). Returns "" when the peer's
  /// identity is not yet pinned (the JS layer maps "" -> null). Pure libsignal.
  @objc public func safetyNumber(_ selfUserId: String, peerUserId: String) throws -> String {
    let stores = try self.stores()
    guard let peerIdentity = try stores.identity(for: try address(peerUserId), context: context)
    else {
      return ""
    }
    let selfIdentity = try stores.identityKeyPair(context: context).identityKey
    let generator = NumericFingerprintGenerator(iterations: safetyIterations)
    let fingerprint = try generator.create(
      version: safetyVersion,
      localIdentifier: Data(selfUserId.utf8),
      localKey: selfIdentity.publicKey,
      remoteIdentifier: Data(peerUserId.utf8),
      remoteKey: peerIdentity.publicKey
    )
    return fingerprint.displayable.formatted
  }

  /// Accept a peer's changed identity: forget the pin + session so the next
  /// contact re-pins (TOFU) and rebuilds the ratchet.
  @objc public func resetPeerIdentity(_ peerUserId: String) throws {
    let stores = try self.stores()
    try stores.clearPeer(try address(peerUserId))
  }

  /// True when a libsignal error is an untrusted-identity (changed-key) refusal.
  static func isIdentityChange(_ error: Error) -> Bool {
    if let signalError = error as? SignalError, case .untrustedIdentity = signalError {
      return true
    }
    return false
  }

  /// Encrypt plaintext for a peer; returns JSON {msgType, payload}.
  @objc public func encryptText(
    _ selfUserId: String, peerUserId: String, plaintext: String
  ) throws -> String {
    let stores = try self.stores()
    let ciphertext: CiphertextMessage
    do {
      ciphertext = try signalEncrypt(
        message: Data(plaintext.utf8),
        for: try address(peerUserId),
        localAddress: try address(selfUserId),
        sessionStore: stores,
        identityStore: stores,
        context: context
      )
    } catch where Self.isIdentityChange(error) {
      throw TacendumError.identityChanged
    }
    let msgType = ciphertext.messageType == .preKey ? "prekey" : "ciphertext"
    let result: [String: String] = [
      "msgType": msgType,
      "payload": Self.b64(ciphertext.serialize()),
    ]
    return String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
  }

  /// Decrypt an inbound envelope. Throws (loudly) on tamper/corruption.
  @objc public func decryptEnvelope(
    _ selfUserId: String, senderUserId: String, msgType: String, payloadB64: String
  ) throws -> String {
    let stores = try self.stores()
    let data = try Self.bytes(payloadB64, "payload")
    let senderAddr = try address(senderUserId)
    let selfAddr = try address(selfUserId)

    let plaintext: Data
    do {
      if msgType == "prekey" {
        let message = try PreKeySignalMessage(bytes: data)
        plaintext = try signalDecryptPreKey(
          message: message,
          from: senderAddr,
          localAddress: selfAddr,
          sessionStore: stores,
          identityStore: stores,
          preKeyStore: stores,
          signedPreKeyStore: stores,
          kyberPreKeyStore: stores,
          context: context
        )
      } else if msgType == "ciphertext" {
        let message = try SignalMessage(bytes: data)
        plaintext = try signalDecrypt(
          message: message,
          from: senderAddr,
          to: selfAddr,
          sessionStore: stores,
          identityStore: stores,
          context: context
        )
      } else {
        throw TacendumError.badInput("unknown msgType")
      }
    } catch where Self.isIdentityChange(error) {
      // A changed-identity prekey message: distinct from tamper/corruption so
      // the UI can block-and-warn instead of silently rejecting.
      throw TacendumError.identityChanged
    }

    guard let text = String(data: plaintext, encoding: .utf8) else {
      throw TacendumError.badInput("plaintext is not valid UTF-8")
    }
    return text
  }

  // MARK: - Platform RNG

  private func randomInt(upperExclusive: UInt32) throws -> UInt32 {
    var value: UInt32 = 0
    let status = withUnsafeMutableBytes(of: &value) {
      SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt32>.size, $0.baseAddress!)
    }
    guard status == errSecSuccess else { throw TacendumError.rng(status) }
    // Modulo bias is irrelevant here (ids, not key material).
    return value % upperExclusive
  }

  @objc public func randomBytes(_ count: Int) throws -> String {
    guard count > 0, count <= 4096 else {
      throw TacendumError.badInput("randomBytes count out of range")
    }
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    guard status == errSecSuccess else { throw TacendumError.rng(status) }
    return Data(bytes).base64EncodedString()
  }

  // MARK: - Platform digest

  /// SHA-256 of the decoded bytes, base64 — CryptoKit, the platform's digest.
  ///
  /// Sanctioned SOLELY for the group roster digest (`rd`) — a recorded
  /// exception to the no-new-cryptography rule: it digests a list of user ids
  /// the client already holds in the clear, performs no key agreement, no
  /// encryption and no signature, and protects no user content. A digest
  /// mismatch is disclosure to a human, never an authorization decision.
  ///
  /// MUST produce byte-identical output to `crypto.createHash('sha256')` in
  /// the CLI — a digest two clients compute differently is a permanent false
  /// alarm on honest traffic, which is why the jest suite pins the FIPS 180-4
  /// known-answer vectors both bindings have to hit.
  ///
  /// An empty input is VALID (SHA-256 of zero bytes is defined and is one of
  /// the pinned vectors); only undecodable base64 is an error. Any use beyond
  /// hashing bytes — truncation, encoding of the preimage, comparison — lives
  /// in TypeScript (`packages/shared` group-fold), where both bindings share
  /// one copy of it.
  @objc public func sha256(_ dataB64: String) throws -> String {
    let data = try Self.bytes(dataB64, "sha256 payload")
    // Fully qualified: the allowlist names CryptoKit.SHA256, so the code does too.
    return Self.b64(Data(CryptoKit.SHA256.hash(data: data)))
  }

  // MARK: - Attachment blob crypto (libsignal AES-256-GCM)

  private struct BlobEncryptDTO: Codable {
    let keyB64: String
    let blobB64: String
  }

  /// Encrypt an attachment blob for the presigned-upload path: fresh random
  /// 32-byte key per blob, libsignal AES-256-GCM, nonce+ciphertext+tag
  /// concatenated. The key reaches the recipient only inside the
  /// Signal-encrypted message envelope, so the blob store holds pure
  /// ciphertext it can never bind to a key.
  @objc public func blobEncrypt(_ plaintextB64: String) throws -> String {
    guard let plaintext = Data(base64Encoded: plaintextB64) else {
      throw TacendumError.badInput("blobEncrypt payload is not base64")
    }
    // Empty plaintext is safe HERE by construction, and that is load-bearing:
    // `plaintext` is a fresh non-slice Data from Data(base64Encoded:), and a
    // fresh empty Data survives the libsignal binding's
    // Data.withUnsafeMutableBytes call (device-measured — the `empty` vector
    // in packages/shared/blobvectors.json was minted by this exact path; the
    // binding's SignalBorrowedMutableBuffer accepts a nil base pointer for a
    // zero count). Do not replace this with a Data SLICE: the decrypt side
    // crashed on precisely that shape — see the empty-blob guard in
    // blobDecrypt below.
    var key = [UInt8](repeating: 0, count: Aes256GcmEncryptedData.keyLength)
    let status = SecRandomCopyBytes(kSecRandomDefault, key.count, &key)
    guard status == errSecSuccess else { throw TacendumError.rng(status) }
    let sealed = try Aes256GcmEncryptedData.encrypt(plaintext, key: key)
    let dto = BlobEncryptDTO(
      keyB64: Data(key).base64EncodedString(),
      blobB64: sealed.concatenate().base64EncodedString()
    )
    let json = try JSONEncoder().encode(dto)
    return String(data: json, encoding: .utf8)!
  }

  /// Argon2-harden a registration PIN into the 32-byte verifier.
  /// libsignal's PinHash is the same
  /// primitive Signal uses for PINs — nothing hand-rolled and no CommonCrypto
  /// — a sanctioned KDF, named explicitly rather than stretched under a
  /// clause that covered only identity/session/message/attachment crypto,
  /// which a KDF is not.
  ///
  /// `accessKey`, not `encryptionKey`: the access key is defined as the secret
  /// that proves entitlement to a stored value, which is exactly what verify
  /// checks. The encryption key is for sealing a payload we do not have.
  ///
  /// The PIN is normalized to NFKC before hashing so a PIN typed on a
  /// different keyboard still matches; the salt must be exactly 32 bytes.
  /// Neither the PIN nor the result is ever logged.
  @objc public func pinVerifier(_ pin: String, saltB64: String) throws -> String {
    guard let salt = Data(base64Encoded: saltB64), salt.count == 32 else {
      throw TacendumError.badInput("pinVerifier salt must be 32 base64-encoded bytes")
    }
    let normalized = pin.precomposedStringWithCompatibilityMapping
    guard let pinBytes = normalized.data(using: .utf8), !pinBytes.isEmpty else {
      throw TacendumError.badInput("pinVerifier pin must be non-empty UTF-8")
    }
    let hash = try PinHash(normalizedPin: pinBytes, salt: salt)
    return hash.accessKey.base64EncodedString()
  }

  /// Decrypt a downloaded attachment blob. The GCM tag rejects any tampered or
  /// substituted ciphertext — the store is untrusted.
  ///
  /// EMPTY-BLOB GUARD (crash-on-receive fix, measured on device). The legal
  /// 28-byte blob — nonce(12) ‖ tag(16), zero ciphertext bytes — is a blob
  /// blobEncrypt above can MINT, yet handing it straight to libsignal
  /// crashed the process: `Aes256GcmEncryptedData(concatenated:)` slices the
  /// ciphertext as `dropFirst(12).dropLast(16)`, a zero-length Data SLICE
  /// with a non-zero startIndex, and `decrypt(key:)` passes that slice to
  /// `Data.withUnsafeMutableBytes`, which traps (EXC_BREAKPOINT) on exactly
  /// that shape — the classic Swift empty-Data-slice pitfall. Any peer could
  /// crash this client by sending a 28-byte attachment.
  ///
  /// The guard below rebuilds the sealed struct from freshly materialized
  /// NON-SLICE Data before the cipher call — the same Data shape the encrypt
  /// path is device-proven to survive (see the comment in blobEncrypt).
  ///
  /// This adds NO cryptography and changes NO framing. The
  /// cipher call is still libsignal's own `Aes256GcmEncryptedData
  /// .decrypt(key:)`, tag verification included; only which Data instances
  /// carry the same bytes changes — a call-site correctness fix for the
  /// binding's unsafe-pointer precondition, not new crypto. A tampered empty
  /// blob (flipped tag byte) still throws cleanly through the same libsignal
  /// tag check; it just no longer takes the process down first.
  @objc public func blobDecrypt(_ keyB64: String, blobB64: String) throws -> String {
    guard let key = Data(base64Encoded: keyB64),
      key.count == Aes256GcmEncryptedData.keyLength
    else {
      throw TacendumError.badInput("blobDecrypt key is not a base64 32-byte key")
    }
    guard let blob = Data(base64Encoded: blobB64) else {
      throw TacendumError.badInput("blobDecrypt blob is not base64")
    }
    var sealed = try Aes256GcmEncryptedData(concatenated: blob)
    if sealed.ciphertext.isEmpty {
      // Materialize non-slice copies (Data(_:) copies the bytes; the fresh
      // empty Data for the ciphertext is the shape the FFI handles safely).
      sealed = Aes256GcmEncryptedData(
        nonce: Data(sealed.nonce),
        ciphertext: Data(),
        authenticationTag: Data(sealed.authenticationTag)
      )
    }
    return try sealed.decrypt(key: key).base64EncodedString()
  }

  // MARK: - Keychain secrets

  private func baseQuery(_ key: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: key,
    ]
  }

  /// Returns '' when absent (the spec's Promise<string> cannot carry null).
  @objc public func getSecret(_ key: String) throws -> String {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return "" }
    guard status == errSecSuccess, let data = result as? Data,
      let value = String(data: data, encoding: .utf8)
    else {
      throw TacendumError.keychain(status, "get")
    }
    return value
  }

  @objc public func setSecret(_ key: String, value: String) throws {
    let data = Data(value.utf8)
    var update = baseQuery(key)
    // Background WS reconnect must work after first unlock; never synced.
    // Sent on BOTH paths: the update re-classes an item an earlier build wrote,
    // so the protection class is a property of this code rather than of
    // whenever the item happened to be created.
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(update as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      update[kSecValueData as String] = data
      update[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(update as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw TacendumError.keychain(status, "set") }
  }

  @objc public func deleteSecret(_ key: String) throws {
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw TacendumError.keychain(status, "delete")
    }
  }

  // MARK: - Inbox spool (what the notification extension decrypted)

  /**
   * Everything the extension has decrypted and not yet handed over, as a JSON
   * array.
   *
   * Read, not drained: entries are removed one at a time by
   * `clearInboxEntry`, AFTER the app has committed each one to its database.
   * Deleting them here — or draining the whole directory at once — would lose
   * every message in flight if the app were killed mid-import, and these are
   * the one kind of message that cannot be re-fetched: the extension consumed
   * their ratchet keys, so the server's copy of the ciphertext is already
   * undecryptable.
   *
   * A file that will not parse is skipped rather than throwing. One truncated
   * write must not hold up every other message behind it, and the app has no
   * better answer for it than the extension did.
   */
  @objc public func readInbox() -> String {
    guard let dir = SharedContainer.inboxRoot(),
          let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
    else { return "[]" }

    var entries: [Any] = []
    for name in names.sorted() where name.hasSuffix(".json") {
      guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
            let object = try? JSONSerialization.jsonObject(with: data)
      else { continue }
      entries.append(object)
    }
    guard let out = try? JSONSerialization.data(withJSONObject: entries),
          let text = String(data: out, encoding: .utf8)
    else { return "[]" }
    return text
  }

  /// Drop one entry, once the app has durably stored it.
  ///
  /// Name-validated for the same reason the shared-state files are: the id
  /// comes from JS and becomes a path, and the protocol store is a sibling
  /// directory.
  @objc public func clearInboxEntry(_ msgId: String) throws {
    let ok = !msgId.isEmpty && msgId.count <= 64
      && msgId.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    guard ok, let dir = SharedContainer.inboxRoot() else {
      throw NSError(
        domain: "TacendumCrypto",
        code: 25,
        userInfo: [NSLocalizedDescriptionKey: "invalid inbox entry name"]
      )
    }
    let url = dir.appendingPathComponent("\(msgId).json")
    try TacendumFileStores.removeIfPresent(url)
  }

  // MARK: - Dev/testing

  /**
   * Wipe all protocol state (fresh-install simulation). Keychain secrets are
   * cleared by the caller via deleteSecret — this only removes store files.
   *
   * **BOTH ROOTS, and the staging directory.** Removing only the live one
   * would not be a wipe: the legacy copy in the app's own container is still
   * a complete store with the identity keypair in it, and the very next call
   * to `protocolStoreRoot()` would find no marker, find an identity in legacy,
   * and faithfully copy it back. A wipe that restores what it wiped on the
   * next launch is worse than no wipe at all, because everything reports
   * success.
   *
   * That is the cost of keeping the legacy directory around for a release, and
   * it is paid here rather than by not keeping it: a migration with no
   * rollback path is the more dangerous of the two.
   *
   * Best-effort per path rather than fail-fast. A wipe that stops at the first
   * error leaves more behind than one that keeps going, and the caller's
   * contract is "make it gone".
   */
  @objc public func resetProtocolState() throws {
    // The NSE holds this SAME lock through decryption and plaintext spooling.
    // Waiting for it before deleting both store and inbox prevents an old
    // notification from writing plaintext back after the new account starts.
    guard let lockFile = SharedContainer.storeLockFile() else {
      throw StoreError.io("account reset container unavailable")
    }
    try StoreLock.shared.lock(at: lockFile)
    defer { StoreLock.shared.unlock() }
    var firstError: Error?
    var targets: [URL] = []
    do {
      let root = try Self.protocolStoreRoot()
      targets.append(root)
      targets.append(
        root.deletingLastPathComponent()
          .appendingPathComponent("\(Self.storeDirName).migrating", isDirectory: true)
      )
    } catch {
      firstError = error
    }
    do {
      targets.append(try Self.legacyProtocolStoreRoot())
    } catch {
      firstError = firstError ?? error
    }
    if let inbox = SharedContainer.inboxRoot() { targets.append(inbox) }
    if let shared = SharedContainer.sharedStateRoot() { targets.append(shared) }

    for target in targets {
      do {
        try TacendumFileStores.removeIfPresent(target)
      } catch {
        firstError = firstError ?? error
      }
    }
    if let firstError { throw firstError }
  }
}
