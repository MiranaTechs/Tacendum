import Foundation

/**
 * Compile-only surface for the host regression executable.
 *
 * The shipping build never sees this file.  It mirrors only the names and
 * signatures `TacendumStores.swift` type-checks against; every crypto-bearing
 * method traps because the enumeration test must not accidentally turn this
 * shim into a fake cryptographic implementation.  The normal Xcode build is
 * what verifies these conformances against the pinned LibSignalClient pod.
 */

public protocol StoreContext {}
public protocol IdentityKeyStore: AnyObject {}
public protocol PreKeyStore: AnyObject {}
public protocol SignedPreKeyStore: AnyObject {}
public protocol KyberPreKeyStore: AnyObject {}
public protocol SessionStore: AnyObject {}

public enum Direction { case sending, receiving }
public enum IdentityChange { case newOrUnchanged, replacedExisting }

public final class ProtocolAddress {
  public let name: String
  public let deviceId: UInt32

  public init(name: String, deviceId: UInt32) throws {
    self.name = name
    self.deviceId = deviceId
  }
}

public final class PublicKey {}

public struct IdentityKeyPair {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}

public struct IdentityKey {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}

public final class PreKeyRecord {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}

public final class SignedPreKeyRecord {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}

public final class KyberPreKeyRecord {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}

public final class SessionRecord {
  public init<Bytes: ContiguousBytes>(bytes: Bytes) throws { fatalError("compile-only shim") }
  public func serialize() -> Data { fatalError("compile-only shim") }
}
