import Foundation

/**
 * A cross-process lock around the libsignal protocol store.
 *
 * **Why this has to exist.** Once the notification-service extension decrypts,
 * two processes share one ratchet. The app is alive in the background, an
 * alert push launches the extension, and both open the same session files.
 * Double Ratchet state is not merely a cache: decrypting CONSUMES a message
 * key and advances the chain. Two writers interleaving there do not produce a
 * conflict anyone notices — they produce a session that is silently wrong from
 * then on, so every later message in that conversation fails to decrypt, on
 * both sides, permanently.
 *
 * `flock` is the right primitive: it is per-open-file-description, the kernel
 * releases it if the process dies, and an extension that iOS kills for
 * exceeding its memory budget therefore cannot leave the store wedged. A
 * lockfile written with a sentinel byte would not survive that.
 *
 * **Re-entrant within a process, exclusive across them.** `flock` on a second
 * descriptor for the same file blocks even when the caller is the same
 * process, so a method that takes the lock and calls another that does the
 * same would deadlock on itself. A recursive mutex and a depth counter make
 * the nested case free, while the single shared descriptor keeps the kernel
 * lock held for exactly as long as the outermost caller needs it.
 */
final class StoreLock {
  static let shared = StoreLock()

  private let mutex = NSRecursiveLock()
  private var fd: Int32 = -1
  private var depth = 0
  private var lockedPath: String?

  private init() {}

  /// How long to wait before giving up, in seconds.
  ///
  /// An extension has roughly 30 seconds in total, so blocking forever would
  /// turn "the app is busy" into "the notification never rendered" with no
  /// diagnosis. Five is far longer than any store operation and far short of
  /// the budget.
  static let timeoutSeconds = 5.0

  enum LockError: LocalizedError {
    case cannotOpen(String)
    case timedOut

    var errorDescription: String? {
      switch self {
      case .cannotOpen(let path): return "cannot open store lock at \(path)"
      // The `store_busy:` prefix is a CONTRACT with TacendumCrypto.mm, which
      // maps it to a distinct rejection code — exactly the mechanism
      // `identity_changed:` uses. It matters because of what the JS catch
      // does with an unrecognised error: treats it as tamper, writes a
      // visible error row, marks the ciphertext seen and acks it away. A
      // busy lock is the one failure here that is transient BY CONSTRUCTION
      // — the holder is the notification extension, which lives for seconds
      // — so it must surface as "try again", never as poison.
      case .timedOut: return "store_busy: timed out waiting for the store lock"
      }
    }
  }

  /**
   * Run `body` holding the exclusive store lock.
   *
   * The lock is taken around the whole operation rather than around each file
   * write, because the unit that must be atomic is "read the session, decrypt,
   * write the session back" — locking the writes alone would still let two
   * processes read the same session state and both advance it.
   */
  func withLock<T>(at url: URL, _ body: () throws -> T) throws -> T {
    try lock(at: url)
    defer { unlock() }
    return try body()
  }

  /**
   * The unscoped pair, for a lock whose extent is an OBJECT'S LIFETIME rather
   * than a closure — which is how the protocol store takes it: `init` locks
   * and `deinit` unlocks, so the lock covers exactly as long as a caller holds
   * a store. A closure cannot express that without rewriting every call site
   * to nest, and nesting is what the recursive depth below exists to survive.
   *
   * `unlock()` must be paired with a successful `lock()`. The store's `init`
   * unwinds explicitly on failure because `deinit` does not run when `init`
   * throws.
   */
  func lock(at url: URL) throws {
    mutex.lock()
    if depth == 0 {
      do {
        try acquire(at: url)
      } catch {
        mutex.unlock()
        throw error
      }
    }
    depth += 1
    // The recursive mutex stays held until `unlock`, which is what makes the
    // depth counter safe to read and write without a second lock.
  }

  func unlock() {
    depth -= 1
    if depth == 0 { release() }
    mutex.unlock()
  }

  private func acquire(at url: URL) throws {
    let path = url.path
    if fd < 0 || lockedPath != path {
      if fd >= 0 { close(fd) }
      // 0o600: the container is already private to the app group, but a lock
      // file is still a file and there is no reason for it to be readable.
      fd = open(path, O_CREAT | O_RDWR, 0o600)
      guard fd >= 0 else { throw LockError.cannotOpen(path) }
      lockedPath = path
    }

    // Polled rather than blocking, so the deadline is real. `flock` has no
    // timeout of its own, and LOCK_NB plus a sleep is the portable way to get
    // one without a signal handler.
    let deadline = Date().addingTimeInterval(Self.timeoutSeconds)
    while true {
      if flock(fd, LOCK_EX | LOCK_NB) == 0 { return }
      if Date() >= deadline { throw LockError.timedOut }
      usleep(20_000)
    }
  }

  private func release() {
    guard fd >= 0 else { return }
    // The descriptor is deliberately NOT closed: it is reused for the next
    // acquisition, and closing it is what would drop the lock prematurely if
    // any other reference existed.
    flock(fd, LOCK_UN)
  }
}
