import Foundation

/**
 * Tests for the protocol-store migration (NSE step 4).
 *
 * Plain Swift, no XCTest, no LibSignalClient — so `StoreMigration` can be
 * compiled and exercised by a plain swiftc run in about a
 * second, against real temporary directories and a real FileManager. Same
 * reasoning as the SDP trimmer's harness: this guards the only copy of an
 * identity keypair that cannot be regenerated, and an assertion that
 * consequential must run on every commit rather than on the rare occasions
 * somebody builds for a device.
 *
 * It lives OUTSIDE `ios/` because the podspec globs every Swift file under
 * `ios/`, so a test file in there would be compiled into the shipping app. It
 * is `main.swift` because Swift permits top-level code only in that file.
 *
 * The headline assertions are the destructive ones: a failed copy must leave
 * the legacy store untouched, and a destination that already holds an identity
 * must never be overwritten.
 */

// Unbuffered, so results already printed survive a crash later in the file.
// Swift buffers stdout when it is not a terminal, and a `try!` that trips in a
// later section would otherwise discard every ✓ and ✗ before it — turning "the
// assertion designed for this caught it" into an opaque trap with no output.
setvbuf(stdout, nil, _IONBF, 0)

var failures = 0
var passes = 0

func check(_ condition: Bool, _ what: String) {
  if condition {
    passes += 1
    print("  ✓ \(what)")
  } else {
    failures += 1
    print("  ✗ \(what)")
  }
}

func section(_ title: String) {
  print("")
  print("== \(title)")
}

let IDENTITY = "identity.json"
let fm = FileManager.default

/// A throwaway root per case, so nothing leaks between them.
func scratch(_ name: String) -> URL {
  let base = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("tacendum-migration-tests")
    .appendingPathComponent(name)
  try? fm.removeItem(at: base)
  try! fm.createDirectory(at: base, withIntermediateDirectories: true)
  return base
}

/// A store directory with an identity file and one session, like a real one.
@discardableResult
func makeStore(_ dir: URL, identity: String? = #"{"identityKeyPair":"AAAA","registrationId":7}"#)
  -> URL
{
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  try! fm.createDirectory(
    at: dir.appendingPathComponent("sessions"), withIntermediateDirectories: true)
  try! Data("session-bytes".utf8)
    .write(to: dir.appendingPathComponent("sessions/peer.1.bin"))
  if let identity {
    try! Data(identity.utf8).write(to: dir.appendingPathComponent(IDENTITY))
  }
  return dir
}

func identityText(_ dir: URL) -> String? {
  try? String(contentsOf: dir.appendingPathComponent(IDENTITY), encoding: .utf8)
}

func hasMarker(_ dir: URL) -> Bool {
  fm.fileExists(atPath: dir.appendingPathComponent(StoreMigration.markerName).path)
}

// ---------------------------------------------------------------------------
section("a fresh install migrates nothing")
// ---------------------------------------------------------------------------
do {
  let root = scratch("fresh")
  let legacy = root.appendingPathComponent("legacy")
  let dest = root.appendingPathComponent("container/tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)

  let outcome = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(outcome == .nothingToMigrate, "reports nothingToMigrate")
  check(!hasMarker(dest), "writes no marker — a later install may still need to migrate")
  check(identityText(dest) == nil, "creates no identity out of nowhere")
}

// ---------------------------------------------------------------------------
section("an existing install is copied, verified and marked")
// ---------------------------------------------------------------------------
do {
  let root = scratch("existing")
  let legacy = makeStore(root.appendingPathComponent("legacy"))
  let dest = root.appendingPathComponent("container/tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)

  let outcome = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(outcome == .migrated, "reports migrated")
  check(identityText(dest) == identityText(legacy), "the identity arrived byte for byte")
  check(
    fm.fileExists(atPath: dest.appendingPathComponent("sessions/peer.1.bin").path),
    "sessions came too — an identity with no sessions is every conversation broken")
  check(hasMarker(dest), "marker written")

  // THE ONE THAT MATTERS MOST. The legacy store is the rollback path, and a
  // release that deletes it is a release with none.
  check(identityText(legacy) != nil, "the LEGACY store is left completely intact")
}

// ---------------------------------------------------------------------------
section("it runs exactly once")
// ---------------------------------------------------------------------------
do {
  let root = scratch("once")
  let legacy = makeStore(root.appendingPathComponent("legacy"))
  let dest = root.appendingPathComponent("container/tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)
  try! StoreMigration.run(legacy: legacy, destination: dest, identityFileName: IDENTITY)

  // The live store moves on: a new session is written after the migration.
  try! Data("newer".utf8).write(to: dest.appendingPathComponent("sessions/peer.2.bin"))
  // And the legacy copy is edited to something that would be obvious if copied.
  try! Data(#"{"identityKeyPair":"STALE","registrationId":1}"#.utf8)
    .write(to: legacy.appendingPathComponent(IDENTITY))

  let second = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(second == .alreadyMigrated, "second run is a no-op")
  check(
    identityText(dest)?.contains("STALE") == false,
    "the stale legacy identity did NOT overwrite the live one")
  check(
    fm.fileExists(atPath: dest.appendingPathComponent("sessions/peer.2.bin").path),
    "work done after the migration survives")
}

// ---------------------------------------------------------------------------
section("a destination that already has an identity is adopted, never overwritten")
// ---------------------------------------------------------------------------
do {
  // Reached when a previous run copied successfully and then died before
  // writing the marker — or when this install registered straight into the
  // container. Copying here would replace a live identity with an older one.
  let root = scratch("adopt")
  let legacy = makeStore(
    root.appendingPathComponent("legacy"),
    identity: #"{"identityKeyPair":"OLD","registrationId":1}"#)
  let dest = makeStore(
    root.appendingPathComponent("container/tacendum-protocol"),
    identity: #"{"identityKeyPair":"LIVE","registrationId":2}"#)

  let outcome = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(outcome == .adoptedExisting, "reports adoptedExisting")
  check(identityText(dest)?.contains("LIVE") == true, "the LIVE identity is untouched")
  check(hasMarker(dest), "marker written, so this decision is made once")
}

// ---------------------------------------------------------------------------
section("an interrupted attempt is recoverable")
// ---------------------------------------------------------------------------
do {
  // A partial destination with no identity: a copy that died halfway. It has
  // nothing worth keeping, which is exactly why clearing it is safe — and the
  // check that proves it is the identity check, not a guess.
  let root = scratch("partial")
  let legacy = makeStore(root.appendingPathComponent("legacy"))
  let dest = root.appendingPathComponent("container/tacendum-protocol")
  try! fm.createDirectory(
    at: dest.appendingPathComponent("sessions"), withIntermediateDirectories: true)
  try! Data("half".utf8).write(to: dest.appendingPathComponent("sessions/partial.bin"))

  let outcome = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(outcome == .migrated, "retries and completes")
  check(identityText(dest) == identityText(legacy), "the identity arrived")
  check(
    !fm.fileExists(atPath: dest.appendingPathComponent("sessions/partial.bin").path),
    "the half-written debris is gone rather than merged")
}

// ---------------------------------------------------------------------------
section("a stale staging directory does not block a retry")
// ---------------------------------------------------------------------------
do {
  let root = scratch("staging")
  let legacy = makeStore(root.appendingPathComponent("legacy"))
  let container = root.appendingPathComponent("container")
  let dest = container.appendingPathComponent("tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)
  // Debris from a previous crash, in the way of copyItem.
  try! fm.createDirectory(
    at: container.appendingPathComponent("tacendum-protocol.migrating"),
    withIntermediateDirectories: true)

  let outcome = try! StoreMigration.run(
    legacy: legacy, destination: dest, identityFileName: IDENTITY)

  check(outcome == .migrated, "clears the stale staging directory and completes")
  check(
    !fm.fileExists(
      atPath: container.appendingPathComponent("tacendum-protocol.migrating").path),
    "no staging directory left behind")
}

// ---------------------------------------------------------------------------
section("a corrupt identity fails the migration and changes nothing")
// ---------------------------------------------------------------------------
do {
  // `copyItem` reports success for a copy a full disk truncated. The identity
  // file is the one thing that cannot be regenerated, so it is parsed rather
  // than counted — and a failure must leave both sides exactly as they were.
  let root = scratch("corrupt")
  let legacy = makeStore(root.appendingPathComponent("legacy"), identity: "{ truncated")
  let container = root.appendingPathComponent("container")
  let dest = container.appendingPathComponent("tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)

  var threw = false
  do {
    try StoreMigration.run(legacy: legacy, destination: dest, identityFileName: IDENTITY)
  } catch {
    threw = true
  }

  check(threw, "throws rather than reporting success")
  check(!hasMarker(dest), "NO marker — so the next launch tries again")
  check(identityText(legacy) == "{ truncated", "the legacy store is untouched")
  check(
    !fm.fileExists(
      atPath: container.appendingPathComponent("tacendum-protocol.migrating").path),
    "the failed staging copy is cleaned up")
}

// ---------------------------------------------------------------------------
section("the store lock is re-entrant within a process")
// ---------------------------------------------------------------------------
do {
  // `flock` on a second descriptor for the same file blocks even for the same
  // process, so a method that takes the lock and calls another that does the
  // same would deadlock on itself. This is the case that would hang forever
  // rather than fail — hence a real assertion rather than trust.
  let root = scratch("reentrant")
  let lockFile = root.appendingPathComponent(".lock")

  var inner = false
  try! StoreLock.shared.withLock(at: lockFile) {
    try! StoreLock.shared.withLock(at: lockFile) {
      inner = true
    }
  }
  check(inner, "a nested acquisition completes instead of deadlocking")

  // And the lock is genuinely free afterwards, not left held by the depth
  // counter going wrong.
  var again = false
  try! StoreLock.shared.withLock(at: lockFile) { again = true }
  check(again, "the lock is released once the outermost holder is done")
}

// ---------------------------------------------------------------------------
section("the store lock excludes a second process")
// ---------------------------------------------------------------------------
do {
  // The property the whole file exists for, tested the only way that proves
  // it: another OS process, holding the same lock, while this one tries.
  let root = scratch("crossprocess")
  let lockFile = root.appendingPathComponent(".lock")
  let flagFile = root.appendingPathComponent("held")

  // A helper that takes the lock via /usr/bin/flock-equivalent shell builtin.
  // `shlock` is not universal, so use a tiny perl that flocks and sleeps.
  let helper = Process()
  helper.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
  helper.arguments = [
    "-e",
    """
    use Fcntl ':flock';
    open(my $fh, '>>', $ARGV[0]) or die;
    flock($fh, LOCK_EX) or die;
    open(my $f, '>', $ARGV[1]); print $f "1"; close $f;
    sleep 2;
    """,
    lockFile.path,
    flagFile.path,
  ]
  try! helper.run()

  // Wait until the helper says it holds the lock.
  let waitUntil = Date().addingTimeInterval(3)
  while !fm.fileExists(atPath: flagFile.path) && Date() < waitUntil {
    usleep(20_000)
  }
  check(fm.fileExists(atPath: flagFile.path), "the other process took the lock")

  let started = Date()
  var acquired = false
  do {
    try StoreLock.shared.withLock(at: lockFile) { acquired = true }
  } catch {
    acquired = false
  }
  let waited = Date().timeIntervalSince(started)

  helper.waitUntilExit()
  check(acquired, "this process eventually acquired it")
  check(waited > 0.3, "it WAITED rather than walking straight through (\(Int(waited * 1000))ms)")
}

// ---------------------------------------------------------------------------
section("the migration does not unlink the lock out from under a holder")
// ---------------------------------------------------------------------------
do {
  // The lock lived at <store>/.lock, and the migration REMOVES the store
  // directory before renaming the staged copy in. `flock` is held on an open
  // file description, not a path — so an extension holding the old inode would
  // keep a lock on a file that no longer exists while the app opened a fresh
  // one at the same path. Both would believe they held it, and both would
  // advance the same ratchet. The lock now lives beside the store.
  let root = scratch("lockinode")
  let container = root.appendingPathComponent("container")
  let dest = container.appendingPathComponent("tacendum-protocol")
  try! fm.createDirectory(at: dest, withIntermediateDirectories: true)
  let legacy = makeStore(root.appendingPathComponent("legacy"))
  let lockFile = container.appendingPathComponent("tacendum-store.lock")

  // Take the lock, note which inode it is, migrate, and check it survived.
  try! StoreLock.shared.withLock(at: lockFile) {
    let before = try! fm.attributesOfItem(atPath: lockFile.path)[.systemFileNumber] as! Int
    try! StoreMigration.run(
      legacy: legacy, destination: dest, identityFileName: IDENTITY)
    let after = try! fm.attributesOfItem(atPath: lockFile.path)[.systemFileNumber] as! Int
    check(before == after, "the lock file is the SAME inode after a migration")
  }
  check(identityText(dest) != nil, "and the migration still completed")
}

// ---------------------------------------------------------------------------
print("")
print("\(passes) passed, \(failures) failed")
if failures > 0 { exit(1) }
