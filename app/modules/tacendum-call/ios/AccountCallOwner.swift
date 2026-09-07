import Foundation

/**
 * A generation-bound account lease for native call work.
 *
 * Push delivery and platform report callbacks are asynchronous. Matching the
 * recipient once is therefore insufficient: deletion can clear the account,
 * and a different account can be created on the same install, before the
 * callback returns. A lease is usable only while both its owner and generation
 * still match.
 */
struct AccountCallLease: Equatable {
  fileprivate let owner: String
  fileprivate let generation: UInt64
}

/** The denied interval between invalidating old work and adopting a new id. */
struct AccountCallOwnerChange {
  let owner: String
  fileprivate let generation: UInt64
}

/**
 * Thread-safe semantic core for the native account boundary.
 *
 * Persistence and call teardown live in the platform adapters. Keeping the
 * ownership rule here makes its races testable without CallKit or a device.
 */
final class AccountCallOwner {
  private let lock = NSLock()
  private var owner: String
  private var generation: UInt64 = 0
  private var changeInProgress = false

  init(initialOwner: String) {
    owner = Self.normalize(initialOwner)
  }

  var currentOwner: String {
    lock.lock()
    defer { lock.unlock() }
    return owner
  }

  func currentLease() -> AccountCallLease? {
    lock.lock()
    defer { lock.unlock() }
    guard !owner.isEmpty else { return nil }
    return AccountCallLease(owner: owner, generation: generation)
  }

  func lease(for recipient: String) -> AccountCallLease? {
    let wanted = Self.normalize(recipient)
    lock.lock()
    defer { lock.unlock() }
    guard !wanted.isEmpty, wanted == owner else { return nil }
    return AccountCallLease(owner: owner, generation: generation)
  }

  func isCurrent(_ lease: AccountCallLease) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return !owner.isEmpty && owner == lease.owner && generation == lease.generation
  }

  /**
   * Invalidate first. The adapter clears native state and durable storage
   * before calling `finishChange`, so a crash cannot restore the old owner.
   */
  func beginChange(to rawOwner: String) -> AccountCallOwnerChange? {
    let next = Self.normalize(rawOwner)
    lock.lock()
    defer { lock.unlock() }
    guard changeInProgress || next != owner else { return nil }
    generation &+= 1
    owner = ""
    changeInProgress = true
    return AccountCallOwnerChange(owner: next, generation: generation)
  }

  /** A superseded transition cannot adopt its account late. */
  func finishChange(_ change: AccountCallOwnerChange) {
    lock.lock()
    defer { lock.unlock() }
    guard changeInProgress, owner.isEmpty, generation == change.generation else { return }
    owner = change.owner
    changeInProgress = false
  }

  private static func normalize(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
