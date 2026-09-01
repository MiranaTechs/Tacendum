import Foundation
import os

/**
 * The backup-excluded directory the SQLite databases live in, and the
 * one-time migration into it.
 *
 * WHY A DIRECTORY (this is the Fix-1 decision, defended in full).
 *
 * The message databases are plain SQLite in DELETE journal mode — SQLite's
 * default, which nothing here changes: op-sqlite issues no `PRAGMA
 * journal_mode`, `app/src` sets none, and there is no
 * SQLITE_DEFAULT_JOURNAL_MODE define in the build. In that mode the sidecar
 * that actually exists next to a database is `<db>-journal`: plaintext
 * pre-images of every page a write transaction touches, created during EVERY
 * write and, after a crash or jetsam kill mid-transaction, persisting as a
 * HOT journal. Verified against SQLite 3.51 on the host: the journal
 * survives a SIGKILL, and the next open does not even reliably unlink it —
 * recovery zeroes the header and leaves the pre-image bytes on disk until
 * some later write commits.
 *
 * The previous design flagged individual files at open time, with the suffix
 * list ["", "-wal", "-shm"]. That was wrong twice over: `-wal`/`-shm` are
 * WAL-mode sidecars these databases never create, and `-journal` — the one
 * that exists — was never flagged. No per-file scheme fixes it:
 *
 *   (a) Adding "-journal" to the list only reaches a journal that exists at
 *       open time. It usually does not (it lives inside write transactions),
 *       and the flag never survives to the next file: DELETE mode unlinks
 *       the journal at commit, and a fresh journal is a fresh inode with no
 *       attribute. Timing, not construction.
 *   (b) Switching to WAL makes `-wal`/`-shm` real, but a clean close deletes
 *       them, so at open time there is usually still nothing to flag, and
 *       the `-wal` minted after open — holding the NEWEST committed messages
 *       — is unflagged for the whole session, exactly when an overnight
 *       backup runs against a suspended app. It also changes crash and
 *       checkpoint semantics under a transaction helper (db.ts
 *       `runExclusive`) and an op-sqlite default that were built and tested
 *       on rollback journals. Same hole, more moving parts.
 *   (d) journal_mode=MEMORY or OFF is rejected outright: it trades the crash
 *       durability of a message database for a backup property — a crash
 *       mid-transaction then corrupts the database instead of rolling back.
 *
 * (c) — this file — closes the hole by construction. iOS backup exclusion on
 * a DIRECTORY covers its entire subtree: backupd does not descend into an
 * excluded directory, so every file SQLite ever mints beside the database —
 * present, hot, or future, whatever its suffix — is excluded from the moment
 * it is created, because it is created inside an excluded directory. The
 * exclusion is asserted BEFORE the migration moves anything in and before
 * the first open creates anything, so nothing ever exists in the directory
 * unexcluded. This is the same pattern the notification extension's spool
 * already uses (InboxSpool.swift flags its directory, not its files).
 *
 * This matters most for the DECOY database: it is written only at rare
 * moments, so under the old design a hot journal could sit unflagged for
 * months and be swept into nightly iCloud backups — and its FILENAME alone
 * proves the decoy feature is armed, which is the exact defeat the
 * exclusion exists to prevent.
 *
 * FOUNDATION-ONLY, deliberately, like StoreMigration.swift and for the same
 * reason: TacendumCryptoImpl.swift imports LibSignalClient and can only be
 * compiled inside a full iOS build, while this file compiles on the host in
 * a second and can be exercised against real files — including a real hot
 * journal produced by SIGKILLing sqlite3 mid-transaction.
 */
enum DatabaseDirectory {
  /// One directory for both workspaces. The name is deliberately neutral —
  /// it must not distinguish an install with a decoy from one without.
  static let dirName = "tacendum-db"

  /// Every sidecar SQLite can mint next to a database. `-journal` is the one
  /// DELETE mode actually creates; `-wal`/`-shm` are carried so a legacy
  /// file from any conceivable earlier state migrates with its family.
  static let sidecarSuffixes = ["-journal", "-wal", "-shm"]

  struct Prepared {
    let location: URL
    /// False when the exclusion attribute could not be set. The caller opens
    /// anyway (hardening, not correctness) but must surface the failure.
    let excluded: Bool
  }

  enum PrepError: LocalizedError {
    case migrationFailed

    /// Generic on purpose: no filenames (an error
    /// string naming the decoy would prove the decoy is armed).
    var errorDescription: String? { "database directory migration failed" }
  }

  /**
   * Create the directory, assert its exclusion flag, and migrate the named
   * database's family in from the Library root. Idempotent; the steady state
   * after the first run is one directory stat, one attribute read and four
   * file stats.
   *
   * Exclusion BEFORE migration, so the files land in a directory that is
   * already excluded — at no instant does a database file exist at the new
   * path without the flag above it.
   */
  @discardableResult
  static func prepare(name: String, library: URL) throws -> Prepared {
    let dir = library.appendingPathComponent(dirName, isDirectory: true)
    // Succeeds on an existing directory, so this is both the create and the
    // no-op path.
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let excluded = assertExcluded(dir)
    try migrate(name: name, from: library, into: dir)
    return Prepared(location: dir, excluded: excluded)
  }

  /**
   * Read-first idempotent flag assert. TRUE means the attribute is in place
   * (already set, or set now); FALSE means the write failed — and unlike the
   * SharedContainer helper this Bool is NOT discarded by the caller: it
   * travels back to JS as `excluded: false` and gets warned about. The
   * directory exists by the time this runs, so FALSE is always a genuine
   * attribute-write failure, never "nothing there yet".
   */
  static func assertExcluded(_ url: URL) -> Bool {
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
      // Observable at the native layer too, with nothing user-specific in
      // it: the directory name is a compile-time constant shared by
      // every install.
      os_log(
        "backup exclusion attribute could not be set on the database directory",
        type: .error
      )
      return false
    }
  }

  /**
   * Move a database family from the Library root (where every install before
   * this design kept it, backed up) into the excluded directory. Explicit
   * cases, in order:
   *
   * 1. LEGACY AND DESTINATION BOTH HOLD THE MAIN FILE — touch nothing. The
   *    only route here is a downgrade-and-back: an old build re-minted a
   *    Library-root database while the migrated one sat in the directory.
   *    The migrated copy stays authoritative; overwriting either way could
   *    destroy real messages. The legacy residue is accepted and reported in
   *    the published caveats rather than silently "resolved".
   *
   * 2. LEGACY MAIN EXISTS, DESTINATION DOES NOT — move the family, SIDECARS
   *    FIRST, MAIN LAST. A rollback journal is only meaningful adjacent to
   *    its own database, so the pair must travel together, and the order is
   *    the crash-safety argument: interrupted after the journal moved but
   *    before the main file, the next launch finds legacy-main-present /
   *    destination-main-absent and completes the move, reuniting the pair
   *    before anything opens the database. (Moved main-first, a crash would
   *    strand the hot journal where no recovery will ever look.) Same-volume
   *    rename, so no byte copy and no double storage.
   *
   * 3. NO LEGACY MAIN — delete any orphan legacy sidecars. An orphan journal
   *    happens for real: restore a backup made under the old design and the
   *    excluded database is absent while its never-flagged journal came
   *    back. Without its exact database the pre-images are unreadable as a
   *    database but still plaintext residue being re-backed-up; and moving
   *    it next to a FUTURE database of the same name would hand SQLite a
   *    bogus hot journal to "recover". Deletion is the only safe place for
   *    it.
   *
   * Failures while a legacy main exists throw — the caller must fail the
   * open rather than let SQLite mint a fresh empty database at the new path,
   * which every existing install would read as "my messages are gone".
   */
  static func migrate(name: String, from library: URL, into dir: URL) throws {
    let fm = FileManager.default
    let legacyMain = library.appendingPathComponent(name, isDirectory: false)
    let destMain = dir.appendingPathComponent(name, isDirectory: false)
    let legacyExists = fm.fileExists(atPath: legacyMain.path)
    let destExists = fm.fileExists(atPath: destMain.path)

    if legacyExists && destExists {
      return
    }

    if legacyExists {
      for suffix in sidecarSuffixes {
        let src = library.appendingPathComponent(name + suffix, isDirectory: false)
        let dst = dir.appendingPathComponent(name + suffix, isDirectory: false)
        if fm.fileExists(atPath: src.path) && !fm.fileExists(atPath: dst.path) {
          do { try fm.moveItem(at: src, to: dst) } catch { throw PrepError.migrationFailed }
        }
      }
      do { try fm.moveItem(at: legacyMain, to: destMain) } catch {
        throw PrepError.migrationFailed
      }
      return
    }

    for suffix in sidecarSuffixes {
      let src = library.appendingPathComponent(name + suffix, isDirectory: false)
      if fm.fileExists(atPath: src.path) {
        // Best-effort: an orphan that cannot be deleted today is no worse
        // than yesterday, and must not block the database opening.
        try? fm.removeItem(at: src)
      }
    }
  }
}
