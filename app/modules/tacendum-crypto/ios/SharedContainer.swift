import Foundation

/**
 * The paths the app and the notification-service extension both need.
 *
 * Compiled into BOTH targets, which is the point: the two processes have to
 * agree on where the protocol store, the shared preferences and the inbox
 * spool live, and the only way to guarantee that is for there to be exactly
 * one definition. A constant duplicated in the extension is a constant that
 * drifts, and the failure it produces is silent — the extension opens an empty
 * directory, finds no identity, and every notification falls back to "New
 * message" with nothing to diagnose.
 *
 * Deliberately does NOT create anything and never migrates. Creation and
 * migration belong to the app, which owns the store's lifecycle; an extension
 * that created directories could race the app's migration, and one that ran
 * the migration itself would do it under a 30-second budget with no way to
 * report what happened.
 */
enum SharedContainer {
  /// Must match `com.apple.security.application-groups` in BOTH entitlements.
  static let appGroupIdentifier = "group.com.miranatechnologies.tacendum"

  /// nil when the App Group entitlement is missing or misspelled.
  ///
  /// The two callers treat nil very differently, and both are right: the app
  /// calls `fatalError`, because continuing there would read as "no identity"
  /// and mint a fresh keypair; the extension shows the generic notification,
  /// because a build problem must not stop a message arriving.
  static func root() -> URL? {
    FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupIdentifier
    )
  }

  static let storeDirName = "tacendum-protocol"

  /// The libsignal protocol store. Not created here.
  static func protocolStoreRoot() -> URL? {
    root()?.appendingPathComponent(storeDirName, isDirectory: true)
  }

  /// Small preference files: the preview level, the armed marker.
  static func sharedStateRoot() -> URL? {
    root()?.appendingPathComponent("tacendum-shared", isDirectory: true)
  }

  /**
   * Where the extension leaves plaintext for the app to pick up.
   *
   * The extension cannot write to the database — op-sqlite is a JSI
   * HostObject, so touching it would boot a JavaScript runtime inside a
   * process with roughly 24 MB of dirty memory to spend. So it writes one
   * small file per message and the app drains them.
   *
   * This is not an optimisation, it is a requirement: decrypting CONSUMES the
   * message key, so once the extension has decrypted, that ciphertext can
   * never be decrypted again by anyone. If the plaintext were not written
   * down, the message would be permanently gone — arrived, decrypted,
   * displayed for a moment, and then unrecoverable.
   */
  static func inboxRoot() -> URL? {
    root()?.appendingPathComponent("inbox", isDirectory: true)
  }

  /**
   * Mark a file or directory as excluded from iCloud and iTunes/Finder backups.
   *
   * FILE PROTECTION AND BACKUP EXCLUSION ARE DIFFERENT THINGS, and conflating
   * them is what left plaintext in people's backups. A protection class governs
   * whether the file is readable while the device is locked; it says nothing
   * about whether the backup service copies it out. The spool below is written
   * with `.completeFileProtectionUntilFirstUserAuthentication` and was, until
   * this existed, backed up in full.
   *
   * Idempotent, and deliberately non-throwing: a missing backup flag is never
   * worth failing a write that would otherwise have succeeded, and every caller
   * here is on a path where the alternative is losing a message.
   */
  @discardableResult
  static func excludeFromBackup(_ url: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: url.path) else { return false }
    if (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?
      .isExcludedFromBackup == true
    {
      return true
    }
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try target.setResourceValues(values)
      return true
    } catch {
      return false
    }
  }

  /**
   * The lock file guarding the protocol store, shared by both processes.
   *
   * **Beside the store, never inside it.** It used to live at
   * `<store>/.lock`, and the migration removes the whole store directory
   * before renaming the staged copy into place — which unlinks the lock's
   * inode. `flock` is held on an OPEN FILE DESCRIPTION, not on a path, so an
   * extension holding the old inode keeps a lock on a file that no longer
   * exists while the app opens a brand-new one at the same path. Both then
   * believe they hold the lock and both mutate the same ratchet, which is the
   * exact corruption the lock was added to prevent.
   *
   * At the container root it survives every operation on the store.
   */
  static func storeLockFile() -> URL? {
    root()?.appendingPathComponent("tacendum-store.lock")
  }
}
