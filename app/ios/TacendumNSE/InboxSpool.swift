import Foundation

/**
 * Plaintext the extension decrypted, written down for the app to pick up.
 *
 * **This is not a cache and losing it is not recoverable.** Decrypting
 * CONSUMES a Double Ratchet message key: once the extension has decrypted a
 * ciphertext, that ciphertext can never be decrypted again, by this process or
 * any other — libsignal answers `DuplicatedMessage` and there is no way back.
 * So the plaintext is written to disk immediately after the decrypt and before
 * the notification is rendered, and a failure to write it means the extension
 * shows the generic body rather than a preview it cannot also persist.
 *
 * Be clear about what that does and does not buy. The ratchet advanced when
 * `signalDecrypt` returned; a failed write here does NOT undo it, and that
 * message is then gone. This ordering shrinks the window to the two
 * instructions between them — it cannot remove it without a store that can
 * commit ratchet state and plaintext together.
 *
 * One file per message rather than an appended log, because two extension
 * launches can overlap — a second push arriving while the first is still
 * running — and a rename into place is atomic where an append is not.
 *
 * The app drains this directory before it opens its socket, so the messages
 * the extension already took are in the database by the time the server
 * redelivers their ciphertext. The redelivery is then deduplicated by msgId,
 * which the app already does, and acked without a second decryption attempt.
 */
enum InboxSpool {
  /// One decrypted message, as the app expects to find it.
  struct Entry: Codable {
    let msgId: String
    let from: String
    /// Milliseconds since the epoch, the server's timestamp.
    let ts: Double
    /// The decrypted envelope body — exactly what `decryptEnvelope` returned.
    let body: String
  }

  enum SpoolError: LocalizedError {
    case noContainer

    var errorDescription: String? {
      switch self {
      case .noContainer: return "app group container unavailable"
      }
    }
  }

  /**
   * Write one entry, atomically.
   *
   * Named by msgId so a redelivery that the extension somehow decrypts twice
   * overwrites rather than duplicates — and so the app can tell, from the
   * filename alone, what it is about to read.
   *
   * `.completeFileProtectionUntilFirstUserAuthentication` matches the store
   * itself: readable once the device has been unlocked since boot, which is
   * exactly the window in which the extension could have decrypted anything at
   * all. Anything stricter would make the file unreadable to the app while the
   * phone sits locked, which is when it is most likely to be written.
   */
  static func write(_ entry: Entry) throws {
    guard let dir = SharedContainer.inboxRoot() else { throw SpoolError.noContainer }
    try FileManager.default.createDirectory(
      at: dir,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    /*
     * EXCLUDED FROM BACKUP, and the protection class above is not a substitute.
     *
     * This directory holds DECRYPTED message bodies — `{msgId, from, ts, body}`
     * in plain JSON — because the extension consumes the message key to read
     * them and the plaintext is the only remaining copy. A protection class
     * decides readability while the phone is locked; it does nothing about the
     * backup service, which copied the whole App Group container. So every
     * message that arrived while the app was closed sat in the owner's iCloud
     * backup in the clear, which is the exact opposite of what this product
     * promises.
     *
     * Set on the DIRECTORY, once, before the first entry lands in it: the flag
     * is inherited by files created inside, so a per-file call would be both
     * redundant and a chance to miss one.
     */
    SharedContainer.excludeFromBackup(dir)
    let data = try JSONEncoder().encode(entry)
    try data.write(
      to: dir.appendingPathComponent("\(entry.msgId).json"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
  }
}
