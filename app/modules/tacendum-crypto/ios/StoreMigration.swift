import Foundation

/**
 * Moving the libsignal protocol store into the App Group container, once.
 *
 * **Why this is its own file.** It is the most dangerous code in the project:
 * it handles the only copy of an identity keypair that cannot be regenerated,
 * and getting it wrong does not corrupt a message or drop a notification — it
 * permanently abandons an account, because the server's `idkey#` claim makes a
 * regenerated keypair a DIFFERENT user with no path back.
 *
 * `TacendumCryptoImpl.swift` imports LibSignalClient, which cannot be compiled
 * on the host, so anything living there can only be exercised inside a full
 * iOS build. Foundation-only, this compiles and runs in about a second against
 * real temporary directories — a harness that
 * follows the same pattern as the SDP trimmer for the same reason: an
 * assertion that guards something this consequential has to run on every
 * commit, not on the rare occasions someone builds for a device.
 *
 * **COPY, VERIFY, MARK. Never move.** A move is one operation with no
 * inspectable middle: if it half-completes, the identity is in an unknown
 * state and there is no second copy. A copy leaves the original untouched
 * whatever happens, and the original is removed by a LATER release, after this
 * one has been seen to work in the wild. Shipping the deletion in the same
 * release that starts reading somewhere else means there is no rollback.
 */
enum StoreMigration {
  /// Written into the destination once the copy is verified.
  static let markerName = "migrated-from-app-container"

  enum MigrationError: LocalizedError {
    case verificationFailed

    var errorDescription: String? {
      switch self {
      case .verificationFailed:
        return "protocol store migration failed verification; legacy store left intact"
      }
    }
  }

  /// What a run decided to do. Returned for tests and for logging that says
  /// something more useful than "ok".
  enum Outcome: Equatable {
    /// The marker was already there.
    case alreadyMigrated
    /// The destination held an identity but no marker — marker written, nothing copied.
    case adoptedExisting
    /// Neither side has an identity. A fresh install.
    case nothingToMigrate
    /// Copied and verified.
    case migrated
  }

  /**
   * The order of these checks IS the safety argument.
   *
   * 1. Marker present → done. Never migrate twice, so the destination stays
   *    authoritative even after the legacy directory is eventually deleted.
   *
   * 2. Destination already holds an identity → write the marker and stop.
   *    Either a previous run finished and the marker write did not, or this
   *    install registered straight into the container. Copying over it would
   *    replace a live identity with an older one.
   *
   * 3. Legacy holds no identity → nothing to do.
   *
   * 4. Otherwise copy. The destination reached here provably has NO identity,
   *    and that is precisely what makes it safe to clear a partial directory
   *    left behind by an interrupted attempt — there is nothing in it worth
   *    keeping.
   *
   * Throws on failure, leaving the legacy store intact and unmarked, so the
   * next launch tries again.
   */
  @discardableResult
  static func run(
    legacy: URL,
    destination: URL,
    identityFileName: String,
    /// Held across the whole migration. The destination directory is REMOVED
    /// and replaced here, so anything reading the store at that moment — the
    /// notification extension, launched by a push that arrived during an
    /// upgrade — must be excluded for the duration. nil skips locking, which
    /// is only for host tests with no second process.
    lockFile: URL? = nil,
    fileManager fm: FileManager = .default
  ) throws -> Outcome {
    guard let lockFile else {
      return try body(legacy: legacy, destination: destination,
                      identityFileName: identityFileName, fm: fm)
    }
    return try StoreLock.shared.withLock(at: lockFile) {
      try body(legacy: legacy, destination: destination,
               identityFileName: identityFileName, fm: fm)
    }
  }

  private static func body(
    legacy: URL,
    destination: URL,
    identityFileName: String,
    fm: FileManager
  ) throws -> Outcome {
    let marker = destination.appendingPathComponent(markerName)
    if fm.fileExists(atPath: marker.path) { return .alreadyMigrated }

    if fm.fileExists(atPath: destination.appendingPathComponent(identityFileName).path) {
      try Data("1".utf8).write(to: marker, options: .atomic)
      return .adoptedExisting
    }

    guard fm.fileExists(atPath: legacy.appendingPathComponent(identityFileName).path) else {
      return .nothingToMigrate
    }

    // Staged as a sibling of the destination so the commit is a rename within
    // one volume rather than a second copy that could itself be interrupted.
    let staging = destination
      .deletingLastPathComponent()
      .appendingPathComponent("\(destination.lastPathComponent).migrating", isDirectory: true)
    if fm.fileExists(atPath: staging.path) { try fm.removeItem(at: staging) }
    try fm.copyItem(at: legacy, to: staging)

    // VERIFY BEFORE COMMITTING. `copyItem` reports success for a copy that a
    // full disk truncated, and the identity file is the one thing here that
    // cannot be regenerated — so it is read back and parsed, not counted.
    let copied = staging.appendingPathComponent(identityFileName)
    guard let data = try? Data(contentsOf: copied),
          (try? JSONSerialization.jsonObject(with: data)) != nil
    else {
      try? fm.removeItem(at: staging)
      throw MigrationError.verificationFailed
    }

    // Safe by step 4 above: whatever is at `destination` has no identity in it.
    if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
    try fm.moveItem(at: staging, to: destination)
    try Data("1".utf8).write(
      to: destination.appendingPathComponent(markerName),
      options: .atomic
    )
    return .migrated
  }
}
