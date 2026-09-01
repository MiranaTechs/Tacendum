import Foundation
import LibSignalClient

/**
 * Regression coverage for the shipped iOS protocol store's prekey scan.
 *
 * This file is compiled together with the REAL `TacendumStores.swift`.
 * It deliberately does not copy
 * the listing implementation: the test has to fail if the production method
 * goes back to `try? ... ?? []`.
 *
 * LibSignal's storage types are supplied by a compile-only test shim because
 * the pinned FFI archive has iOS slices but no macOS slice.  None of those
 * types are invoked here; the app build separately checks the production file
 * against the real pinned pod.
 */

// A command-line test executable has no App Group entitlement.  The
// production store already has this exact host-test fallback; this tiny seam
// only makes the symbol available without compiling the shipping
// `SharedContainer`, whose container lookup cannot succeed in this process.
enum SharedContainer {
  static func storeLockFile() -> URL? { nil }
}

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

func fail(_ what: String) {
  failures += 1
  print("  ✗ \(what)")
}

let fm = FileManager.default
let root = fm.temporaryDirectory
  .appendingPathComponent("tacendum-prekey-enumeration-tests-\(UUID().uuidString)")

do {
  try fm.createDirectory(at: root, withIntermediateDirectories: true)

  do {
    let stores = try TacendumFileStores(root: root)
    let prekeys = root.appendingPathComponent("prekeys", isDirectory: true)

    // The sole absence case: opening the store created this directory, so
    // deleting it exercises a genuinely missing path rather than an empty one.
    try fm.removeItem(at: prekeys)
    do {
      let ids = try stores.existingPreKeyIds()
      check(ids.isEmpty, "a genuinely missing prekey directory is an empty id set")
    } catch {
      fail("a missing prekey directory threw \(error)")
    }

    // The Android regression uses this same deterministic ENOTDIR shape.  The
    // old `try? contentsOfDirectory ?? []` returns normally here, which is the
    // exact fail-open result that restarts ids at one.
    try Data().write(to: prekeys)
    do {
      _ = try stores.existingPreKeyIds()
      fail("a failed prekey listing read as an empty id set")
    } catch is StoreError {
      check(true, "a non-directory prekey path propagates as StoreError")
    } catch {
      fail("a non-directory prekey path threw the wrong error type: \(error)")
    }

    // Preserve the normal contract while changing the failure direction.
    try fm.removeItem(at: prekeys)
    try fm.createDirectory(at: prekeys, withIntermediateDirectories: true)
    for name in ["3.bin", "1.bin", "not-an-id.bin", "2.tmp", "4294967296.bin"] {
      try Data().write(to: prekeys.appendingPathComponent(name))
    }
    do {
      let ids = try stores.existingPreKeyIds()
      check(ids == [1, 3], "valid ids remain filtered and sorted numerically")
      check((ids.max() ?? 0) + 1 == 4, "the caller's high-water mark remains fresh")
    } catch {
      fail("a valid prekey directory threw \(error)")
    }

    let address = try ProtocolAddress(name: "peer", deviceId: 1)
    let context = TacendumStoreContext()
    let sessions = root.appendingPathComponent("sessions", isDirectory: true)

    do {
      let record = try stores.loadSession(for: address, context: context)
      check(record == nil, "a genuinely missing session is nil")
    } catch {
      fail("a genuinely missing session threw \(error)")
    }

    do {
      let records = try stores.loadExistingSessions(for: [address], context: context)
      fail("a missing requested session produced a short list of \(records.count)")
    } catch StoreError.missingRecord {
      check(true, "a missing requested session fails the aligned batch read")
    } catch {
      fail("a missing requested session threw the wrong error: \(error)")
    }

    // `fileExists` returns false for this ENOTDIR path.  The old `read(_:)`
    // therefore fabricated "no session" instead of surfacing the I/O fault.
    try fm.removeItem(at: sessions)
    try Data().write(to: sessions)
    do {
      let record = try stores.loadSession(for: address, context: context)
      fail("an unreadable session path read as \(record == nil ? "absence" : "a record")")
    } catch is StoreError {
      check(true, "a failed session lookup propagates as StoreError")
    } catch {
      fail("a failed session lookup threw the wrong error type: \(error)")
    }
  }
} catch {
  fail("test setup failed: \(error)")
}

try? fm.removeItem(at: root)

let identityRoot = fm.temporaryDirectory
  .appendingPathComponent("tacendum-identity-existence-tests-\(UUID().uuidString)")
do {
  try fm.createDirectory(at: identityRoot, withIntermediateDirectories: true)
  do {
    let stores = try TacendumFileStores(root: identityRoot)

    // Make every child lookup fail with ENOTDIR.  Returning false here is the
    // dangerous direction: app registration treats false as permission to mint
    // a replacement identity.  The non-throwing property used by the NSE must
    // conservatively answer "present"; throwing app paths retain the I/O error.
    try fm.removeItem(at: identityRoot)
    try Data().write(to: identityRoot)
    check(stores.hasIdentity, "an indeterminate identity lookup fails closed")

    do {
      _ = try stores.identityKeyPair(context: TacendumStoreContext())
      fail("an unreadable identity path loaded successfully")
    } catch StoreError.noIdentity {
      fail("an unreadable identity path read as no identity")
    } catch is StoreError {
      check(true, "an unreadable identity path propagates as StoreError")
    } catch {
      fail("an unreadable identity path threw the wrong error type: \(error)")
    }
  }
} catch {
  fail("identity test setup failed: \(error)")
}
try? fm.removeItem(at: identityRoot)

let peerRoot = fm.temporaryDirectory
  .appendingPathComponent("tacendum-peer-clear-tests-\(UUID().uuidString)")
do {
  try fm.createDirectory(at: peerRoot, withIntermediateDirectories: true)
  do {
    let stores = try TacendumFileStores(root: peerRoot)
    let address = try ProtocolAddress(name: "peer", deviceId: 1)
    let session = peerRoot.appendingPathComponent("sessions/peer.1.bin")
    let identities = peerRoot.appendingPathComponent("identities", isDirectory: true)
    try Data("session".utf8).write(to: session)
    try fm.removeItem(at: identities)
    try Data().write(to: identities)

    do {
      try stores.clearPeer(address)
      fail("a failed peer-pin deletion reported reset success")
    } catch is StoreError {
      check(true, "clearPeer propagates a deletion failure")
    } catch {
      fail("clearPeer threw the wrong error type: \(error)")
    }
    check(
      !fm.fileExists(atPath: session.path),
      "clearPeer still attempts the session deletion after a pin failure")
  }
} catch {
  fail("clearPeer test setup failed: \(error)")
}
try? fm.removeItem(at: peerRoot)

print("\n\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
