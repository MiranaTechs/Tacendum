import Foundation

/**
 * The number the extension puts on the app icon.
 *
 * The server used to send a badge and it was removed for a reason worth
 * restating: the server can only count its delivery queue, and that queue
 * carries read receipts, reactions and edits — so somebody READING your
 * messages raised your badge. The server cannot tell the difference; the
 * distinction is inside the ciphertext.
 *
 * The extension CAN tell the difference — better, it no longer needs to.
 * Since the `notify` bit landed, the server pushes only real messages;
 * carriers are queued silently. So every push that launches this extension is
 * one new message, and the badge is simple arithmetic:
 *
 *     badge = base + extra
 *
 * where `base` is the unread total the app last computed from its database
 * (written whenever it foregrounds or backgrounds), and `extra` is how many
 * pushes this extension has counted since. The app owns the truth: whenever
 * it recomputes, it rewrites `base` and deletes `extra`, so any drift the
 * counter accumulates — a push for a message the app had already fetched, a
 * lost increment — self-heals the next time the app opens.
 *
 * The increment holds its own `flock` on the counter file, NOT the store
 * lock. Two extension launches can overlap, and a read-modify-write without
 * exclusion loses increments; but tying this to the store lock would couple
 * a cosmetic number to the one lock that guards ratchet state — and
 * `StoreLock` is a singleton whose fd follows its most recent path, so
 * taking it for a second file while the store is locked would corrupt the
 * exclusion that actually matters.
 */
enum BadgeCounter {
  private static let baseFile = "badge-base"
  private static let extraFile = "badge-extra"

  /// Increment the counter and return the badge to display, or nil when the
  /// container is unavailable — in which case the notification simply carries
  /// no badge, which iOS treats as "leave it alone".
  static func incrementedBadge() -> Int? {
    guard let dir = SharedContainer.sharedStateRoot() else { return nil }
    try? FileManager.default.createDirectory(
      at: dir,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )

    let base = readInt(dir.appendingPathComponent(baseFile)) ?? 0

    let extraURL = dir.appendingPathComponent(extraFile)
    var fd: Int32 = -1
    // Re-open when the inode changed under the lock: the app's badge sync
    // DELETES this file (that is how it resets the counter), and flock
    // follows the open file description, not the path. Locking an inode the
    // app just unlinked means counting into an orphan nobody will ever read
    // — the same class of bug as the store lock living inside the migrated
    // directory. One retry is enough: a second unlink during the retry just
    // loses one increment, and the next app sync heals the count anyway.
    for _ in 0..<2 {
      fd = open(extraURL.path, O_CREAT | O_RDWR, 0o600)
      guard fd >= 0 else { return nil }
      // Blocking is fine: the only contention is another extension holding
      // this for microseconds.
      guard flock(fd, LOCK_EX) == 0 else { close(fd); return nil }
      var onDisk = stat()
      var mine = stat()
      if stat(extraURL.path, &onDisk) == 0 && fstat(fd, &mine) == 0
        && onDisk.st_ino == mine.st_ino {
        break
      }
      flock(fd, LOCK_UN)
      close(fd)
      fd = -1
    }
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    defer { flock(fd, LOCK_UN) }

    var buf = [UInt8](repeating: 0, count: 32)
    let n = read(fd, &buf, buf.count)
    let current = n > 0
      ? Int(String(decoding: buf.prefix(n), as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
      : 0
    let next = current + 1

    // Checked, not fire-and-forget: a full disk that truncates the write
    // must not report a badge the file does not hold — the next push would
    // re-count from whatever survived and the icon would jump around.
    guard lseek(fd, 0, SEEK_SET) == 0, ftruncate(fd, 0) == 0 else { return nil }
    let bytes = Array("\(next)".utf8)
    let written = bytes.withUnsafeBufferPointer { ptr in
      write(fd, ptr.baseAddress, ptr.count)
    }
    guard written == bytes.count else { return nil }
    return base + next
  }

  private static func readInt(_ url: URL) -> Int? {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    return Int(text.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}
