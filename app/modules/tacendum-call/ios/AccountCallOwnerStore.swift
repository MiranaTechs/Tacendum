import Darwin
import Foundation

/**
 * Atomic, synchronous persistence for the public account id used by PushKit.
 *
 * The file lives in Application Support, outside the crypto/shared directory
 * account deletion erases. Writes fsync both the replacement file and its
 * directory before returning, so the bridge promise is a real durable
 * boundary rather than UserDefaults' asynchronously scheduled persistence.
 */
final class AccountCallOwnerStore {
  private static let maxBytes = 512
  private let fileURL: URL

  init(fileURL: URL) {
    self.fileURL = fileURL
  }

  static func live() -> AccountCallOwnerStore {
    let base = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    return AccountCallOwnerStore(
      fileURL: base
        .appendingPathComponent("TacendumNative", isDirectory: true)
        .appendingPathComponent("call-account-owner", isDirectory: false)
    )
  }

  /** Missing, malformed, or oversized data is an explicit fail-closed owner. */
  func read() -> String {
    guard let data = try? Data(contentsOf: fileURL),
          data.count <= Self.maxBytes,
          let decoded = String(data: data, encoding: .utf8)
    else { return "" }
    let value = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else { return "" }
    return value
  }

  func write(_ rawOwner: String) throws {
    let owner = rawOwner.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !owner.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let data = owner.data(using: .utf8),
          data.count <= Self.maxBytes
    else { throw StoreError.invalidOwner }

    var directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    // Crypto identity is device-local. A restored owner without its identity
    // would admit an unanswerable call before JavaScript finishes setup.
    var backupValues = URLResourceValues()
    backupValues.isExcludedFromBackup = true
    try directory.setResourceValues(backupValues)
    guard try URL(fileURLWithPath: directory.path)
      .resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
    else { throw StoreError.backupExclusionFailed }
    #if os(iOS)
      try data.write(to: fileURL, options: [.atomic, .noFileProtection])
      try? FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.none],
        ofItemAtPath: directory.path
      )
    #else
      try data.write(to: fileURL, options: .atomic)
    #endif
    try sync(path: fileURL.path)
    try sync(path: directory.path)
  }

  private func sync(path: String) throws {
    let descriptor = open(path, O_RDONLY)
    guard descriptor >= 0 else { throw StoreError.syncFailed }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw StoreError.syncFailed }
  }

  private enum StoreError: Error {
    case invalidOwner
    case backupExclusionFailed
    case syncFailed
  }
}
