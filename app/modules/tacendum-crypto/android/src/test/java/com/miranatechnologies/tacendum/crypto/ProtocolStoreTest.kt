package com.miranatechnologies.tacendum.crypto

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.state.IdentityKeyStore
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType

/**
 * The file-backed protocol store against the REAL libsignal on the host JVM:
 * the on-disk layout iOS uses, the fail-closed read direction, TOFU, the
 * last-resort Kyber no-op, and the prekey-id high-water mark
 * `existingKeysForUpload` depends on.
 */
class ProtocolStoreTest {

  @get:Rule val temp = TemporaryFolder()

  private fun store(): ProtocolStore = ProtocolStore(temp.root)

  private fun address(name: String = PEER) = SignalProtocolAddress(name, 1)

  // --- layout ----------------------------------------------------------

  @Test
  fun `the on-disk layout is the iOS layout, file for file`() {
    val stores = store()
    stores.initializeIdentity(IdentityKeyPair.generate(), 4242)
    stores.storePreKey(7, PreKeyRecord(7, ECKeyPair.generate()))
    stores.storeSignedPreKey(1, signedPreKey(1))
    stores.storeKyberPreKey(1, kyberPreKey(1))
    stores.storeSession(address(), SessionRecord())
    stores.saveIdentity(address(), IdentityKeyPair.generate().publicKey)

    for (path in
        listOf(
            "identity.json",
            "prekeys/7.bin",
            "signed-prekeys/1.bin",
            "kyber-prekeys/1.bin",
            "sessions/$PEER.1.bin",
            "identities/$PEER.1.pub",
        )) {
      assertTrue("missing $path", File(temp.root, path).isFile)
    }
    // The atomic-write siblings must never survive a completed write: a
    // leftover `<name>.tmp` in prekeys/ would be counted by an id scan that
    // filtered on the wrong suffix.
    assertTrue(
        "a .tmp sibling survived the write",
        (File(temp.root, "prekeys").list() ?: emptyArray()).none { it.endsWith(".tmp") },
    )
  }

  @Test
  fun `records round-trip through libsignal's own serialization`() {
    val stores = store()
    val record = signedPreKey(1)
    stores.storeSignedPreKey(1, record)
    assertArrayEquals(record.serialize(), stores.loadSignedPreKey(1).serialize())

    val kyber = kyberPreKey(1)
    stores.storeKyberPreKey(1, kyber)
    assertArrayEquals(kyber.serialize(), stores.loadKyberPreKey(1).serialize())

    val prekey = PreKeyRecord(3, ECKeyPair.generate())
    stores.storePreKey(3, prekey)
    assertArrayEquals(prekey.serialize(), stores.loadPreKey(3).serialize())

    val session = SessionRecord()
    stores.storeSession(address(), session)
    assertArrayEquals(session.serialize(), stores.loadSession(address())!!.serialize())
  }

  // --- identity --------------------------------------------------------

  @Test
  fun `the identity round-trips and the registration id survives`() {
    val stores = store()
    val identity = IdentityKeyPair.generate()
    stores.initializeIdentity(identity, 16383)
    assertArrayEquals(identity.serialize(), store().getIdentityKeyPair().serialize())
    assertEquals(16383, store().getLocalRegistrationId())
  }

  @Test
  fun `initializeIdentity refuses to overwrite an existing identity`() {
    val stores = store()
    stores.initializeIdentity(IdentityKeyPair.generate(), 1)
    try {
      stores.initializeIdentity(IdentityKeyPair.generate(), 2)
      fail("the store overwrote an identity — that abandons the account")
    } catch (expected: ProtocolStore.StoreException) {
      assertEquals(ProtocolStore.StoreException.Kind.IDENTITY_EXISTS, expected.kind)
    }
  }

  @Test
  fun `reading an absent identity is an error, never an empty one`() {
    try {
      store().getIdentityKeyPair()
      fail("an absent identity read as a value")
    } catch (expected: ProtocolStore.StoreException) {
      assertEquals(ProtocolStore.StoreException.Kind.NO_IDENTITY, expected.kind)
    }
  }

  // --- TOFU ------------------------------------------------------------

  @Test
  fun `trust on first use, then exact bytes, and a change is reported as one`() {
    val stores = store()
    val first = IdentityKeyPair.generate().publicKey
    val second = IdentityKeyPair.generate().publicKey

    assertTrue(
        "an unpinned peer must be trusted on first use",
        stores.isTrustedIdentity(address(), first, IdentityKeyStore.Direction.SENDING),
    )
    assertNull("nothing is pinned yet", stores.getIdentity(address()))

    assertEquals(
        IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED,
        stores.saveIdentity(address(), first),
    )
    assertEquals(
        IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED,
        stores.saveIdentity(address(), first),
    )
    assertTrue(stores.isTrustedIdentity(address(), first, IdentityKeyStore.Direction.RECEIVING))
    assertFalse(
        "a changed key must NOT be trusted — this is what surfaces as identity_changed",
        stores.isTrustedIdentity(address(), second, IdentityKeyStore.Direction.RECEIVING),
    )
    assertEquals(
        IdentityKeyStore.IdentityChange.REPLACED_EXISTING,
        stores.saveIdentity(address(), second),
    )
  }

  @Test
  fun `clearPeer forgets the pin and the session so the next contact re-pins`() {
    val stores = store()
    stores.saveIdentity(address(), IdentityKeyPair.generate().publicKey)
    stores.storeSession(address(), SessionRecord())
    stores.clearPeer(address())
    assertNull(stores.getIdentity(address()))
    assertNull(stores.loadSession(address()))
    assertFalse(stores.containsSession(address()))
  }

  // --- fail direction --------------------------------------------------

  @Test
  fun `a read that FAILS throws — it never reads as absence`() {
    // The whole reason `readOrNull` exists. A directory where a record file
    // belongs is a read that cannot succeed and cannot be "no such file": if
    // this returned null, a transient I/O fault would reset a TOFU pin or drop
    // a live session and re-bootstrap a fresh ratchet.
    val stores = store()
    assertTrue(File(temp.root, "sessions/$PEER.1.bin").mkdirs())
    try {
      stores.loadSession(address())
      fail("an unreadable session file read as 'no session'")
    } catch (expected: ProtocolStore.StoreException) {
      assertEquals(ProtocolStore.StoreException.Kind.IO, expected.kind)
    }

    assertTrue(File(temp.root, "identities/$PEER.1.pub").mkdirs())
    try {
      stores.getIdentity(address())
      fail("an unreadable identity pin read as 'not pinned' — that is trust-on-first-use again")
    } catch (expected: ProtocolStore.StoreException) {
      assertEquals(ProtocolStore.StoreException.Kind.IO, expected.kind)
    }
  }

  @Test
  fun `a genuinely absent record is absence, not an error`() {
    val stores = store()
    assertNull(stores.loadSession(address()))
    assertNull(stores.getIdentity(address()))
    assertFalse(stores.containsPreKey(9))
    assertFalse(stores.containsSignedPreKey(9))
    assertFalse(stores.containsKyberPreKey(9))
    for (body in
        listOf<() -> Unit>(
            { stores.loadPreKey(9) },
            { stores.loadSignedPreKey(9) },
            { stores.loadKyberPreKey(9) },
        )) {
      try {
        body()
        fail("a missing record loaded successfully")
      } catch (expected: InvalidKeyIdException) {
        // libsignal's own "no such id" — the shape its callers handle.
      }
    }
  }

  @Test
  fun `a peer address that would escape its directory is refused`() {
    val stores = store()
    // The last two are the guard's other two arms: a backslash separator,
    // and a NUL — written as the ESCAPE here and in ProtocolStore.kt, because
    // a raw NUL byte would make grep classify the file as binary and skip it
    // silently.
    for (name in
        listOf("..", ".", "../../etc/passwd", "a/b", "", "a\\b", "a\u0000b")) {
      try {
        stores.loadSession(SignalProtocolAddress(name, 1))
        fail("a traversal-shaped peer address was accepted: $name")
      } catch (expected: ProtocolStore.StoreException) {
        assertEquals(ProtocolStore.StoreException.Kind.BAD_ADDRESS, expected.kind)
      }
    }
  }

  // --- prekeys ---------------------------------------------------------

  @Test
  fun `existingPreKeyIds treats only a missing directory as empty`() {
    val stores = store()
    val prekeys = File(temp.root, "prekeys")
    assertTrue(prekeys.delete())

    assertEquals(emptyList<Int>(), stores.existingPreKeyIds())

    assertTrue(prekeys.createNewFile())
    try {
      stores.existingPreKeyIds()
      fail("a failed prekey listing read as an empty id set")
    } catch (expected: ProtocolStore.StoreException) {
      assertEquals(ProtocolStore.StoreException.Kind.IO, expected.kind)
    }
  }

  @Test
  fun `existingPreKeyIds is the ascending set still on disk`() {
    val stores = store()
    for (id in listOf(3, 1, 2, 100)) {
      stores.storePreKey(id, PreKeyRecord(id, ECKeyPair.generate()))
    }
    assertEquals(listOf(1, 2, 3, 100), stores.existingPreKeyIds())
    // Consumption removes the private half — and the id must then be gone
    // from the set, or `existingKeysForUpload` would mint over it.
    stores.removePreKey(2)
    assertEquals(listOf(1, 3, 100), stores.existingPreKeyIds())
    assertFalse(stores.containsPreKey(2))
    // The high-water mark is what makes re-registration mint FRESH ids.
    assertEquals(101, (stores.existingPreKeyIds().maxOrNull() ?: 0) + 1)
  }

  @Test
  fun `markKyberPreKeyUsed is a no-op — the last-resort key is reusable`() {
    val stores = store()
    val record = kyberPreKey(1)
    stores.storeKyberPreKey(1, record)
    val baseKey = ECKeyPair.generate().publicKey
    // Called twice with the SAME tuple: a one-time key would be removed, and a
    // replay-tracking last-resort store would refuse the second call. Ours
    // does neither, because there is exactly one Kyber key and every bundle
    // already advertised names it.
    stores.markKyberPreKeyUsed(1, 1, baseKey)
    stores.markKyberPreKeyUsed(1, 1, baseKey)
    assertTrue(stores.containsKyberPreKey(1))
    assertArrayEquals(record.serialize(), stores.loadKyberPreKey(1).serialize())
  }

  @Test
  fun `sub-device sessions exclude the primary device this client pins to`() {
    val stores = store()
    stores.storeSession(SignalProtocolAddress(PEER, 1), SessionRecord())
    assertEquals(emptyList<Int>(), stores.getSubDeviceSessions(PEER))
    stores.deleteAllSessions(PEER)
    assertNull(stores.loadSession(address()))
  }

  @Test
  fun `an existing store opens over its own files without disturbing them`() {
    val first = store()
    first.initializeIdentity(IdentityKeyPair.generate(), 77)
    first.storePreKey(5, PreKeyRecord(5, ECKeyPair.generate()))
    val reopened = store()
    assertEquals(77, reopened.getLocalRegistrationId())
    assertEquals(listOf(5), reopened.existingPreKeyIds())
    assertNotNull(reopened.loadPreKey(5))
  }

  private fun signedPreKey(id: Int): SignedPreKeyRecord {
    val identity = IdentityKeyPair.generate()
    val pair = ECKeyPair.generate()
    return SignedPreKeyRecord(
        id,
        System.currentTimeMillis(),
        pair,
        identity.privateKey.calculateSignature(pair.publicKey.serialize()),
    )
  }

  private fun kyberPreKey(id: Int): KyberPreKeyRecord {
    val identity = IdentityKeyPair.generate()
    val pair = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
    return KyberPreKeyRecord(
        id,
        System.currentTimeMillis(),
        pair,
        identity.privateKey.calculateSignature(pair.publicKey.serialize()),
    )
  }

  private companion object {
    const val PEER = "01J0PEER0000000000000000AB"
  }
}
