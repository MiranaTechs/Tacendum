import Foundation

/**
 * The per-sender continuation count behind the coalesced banner.
 *
 * The server folds one sender's alert banners into one on the device by
 * minting `apns-collapse-id` = the sender (packages/server/src/push/apns.ts,
 * the alert arm only — never voip; a ring must never replace a ring). Of a
 * burst, only the LAST banner survives, and a survivor that shows only the
 * last message under-reports the burst. This counter is what lets the render
 * step say "N new messages" instead — at preview level `.full` only;
 * every other level keeps today's exact rendering and never consults this.
 *
 * BadgeCounter's file pattern and trust class, deliberately: a small
 * line-oriented file in the shared container ("<sender> <count>" per line),
 * completeUntilFirstUserAuthentication, its own flock (never the store lock —
 * the same coupling argument BadgeCounter states), the same inode recheck
 * against the app's reset-by-unlink, and the same ownership: the APP owns the
 * truth and resets by DELETING the file whenever it takes over (app/src/
 * badge.ts, on the exact path that deletes badge-extra — cold start, every
 * foreground resume, and the wipe/lock clears). Any drift the counter picks
 * up — a counted push for a message the app had already fetched — self-heals
 * at the next reset, exactly as the badge's does.
 *
 * WHAT MAY LEAVE THIS FILE: an Int. The count is arithmetic on extension
 * launches, never a payload byte; the sender key is written to the file but
 * never rendered. The one payload-derived thing here — the key itself — is
 * shape-checked before it becomes a line in a line-oriented format, because a
 * key carrying a space or newline could corrupt a NEIGHBOR's line and inflate
 * another sender's count, and a wrong count is the one lie this feature
 * exists to end. A key that fails the shape reads as "count unknowable".
 */
enum CollapseCounter {
  private static let countsFile = "coalesce-counts"
  /// The whole file must fit this buffer or the counter refuses. ~35 bytes a
  /// sender leaves room for a couple of hundred distinct senders between
  /// resets — far past any honest inbox — and bounds what this 24 MB process
  /// can be made to hold. A refusal never loses data: the file is left as it
  /// was, frozen until the app's next reset deletes it.
  private static let maxBytes = 8192

  /// Count this extension launch for `sender` and return the new total, or
  /// nil when the count is unknowable — no container, an unlockable or
  /// overgrown file, a failed write, a key that does not look like an id
  /// (26 ASCII alphanumerics, the same shape guard classify applies to ids).
  /// nil means the caller renders exactly as it did before this counter
  /// existed: no coalesced body, today's banner. Showing less than the truth
  /// is the permitted direction; showing a wrong number is not.
  static func incrementedCount(for sender: String) -> Int? {
    guard sender.count == 26,
          sender.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
    else { return nil }
    guard let dir = SharedContainer.sharedStateRoot() else { return nil }
    try? FileManager.default.createDirectory(
      at: dir,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )

    let url = dir.appendingPathComponent(countsFile)
    var fd: Int32 = -1
    // Re-open when the inode changed under the lock: the app's reset DELETES
    // this file, and flock follows the open file description, not the path —
    // locking an inode the app just unlinked means counting into an orphan
    // nobody will ever read. One retry, exactly as BadgeCounter argues: a
    // second unlink during the retry just loses one increment, and the loss
    // points the permitted way (a missed coalescing, never a wrong count).
    for _ in 0..<2 {
      fd = open(url.path, O_CREAT | O_RDWR, 0o600)
      guard fd >= 0 else { return nil }
      // Blocking is fine: the only contention is another extension holding
      // this for microseconds.
      guard flock(fd, LOCK_EX) == 0 else { close(fd); return nil }
      var onDisk = stat()
      var mine = stat()
      if stat(url.path, &onDisk) == 0 && fstat(fd, &mine) == 0
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

    var buf = [UInt8](repeating: 0, count: maxBytes)
    let n = read(fd, &buf, buf.count)
    // A full buffer means the file may extend past it, and a rewrite from a
    // partial read would silently drop whatever was not read. Refuse instead:
    // the file freezes at its bound until the app's next reset.
    guard n < maxBytes else { return nil }
    var lines: [(key: Substring, count: Int)] = []
    if n > 0 {
      for line in String(decoding: buf.prefix(n), as: UTF8.self).split(separator: "\n") {
        let parts = line.split(separator: " ")
        // A malformed line is dropped, not preserved: preserving bytes this
        // parser cannot vouch for would let one corrupt write pin garbage in
        // place forever. Dropping loses at most a count, which self-heals.
        guard parts.count == 2, let c = Int(parts[1]), c > 0 else { continue }
        lines.append((parts[0], c))
      }
    }

    var next = 1
    var rewritten: [String] = []
    var found = false
    for (key, count) in lines {
      if key == sender {
        next = count + 1
        found = true
        rewritten.append("\(key) \(next)")
      } else {
        rewritten.append("\(key) \(count)")
      }
    }
    if !found { rewritten.append("\(sender) \(next)") }

    // Size the write BEFORE truncating: discovering the bound after
    // ftruncate would have already destroyed every sender's count.
    let bytes = Array(rewritten.joined(separator: "\n").utf8)
    guard bytes.count < maxBytes else { return nil }
    // Checked, not fire-and-forget — same as BadgeCounter: a full disk that
    // truncates the write must not report a count the file does not hold.
    guard lseek(fd, 0, SEEK_SET) == 0, ftruncate(fd, 0) == 0 else { return nil }
    let written = bytes.withUnsafeBufferPointer { ptr in
      write(fd, ptr.baseAddress, ptr.count)
    }
    guard written == bytes.count else { return nil }
    return next
  }
}
