package com.miranatechnologies.tacendum.crypto

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The secret store's
 * contract, pinned on the host JVM — name allowlists, atomic write,
 * fail-closed read, secret roundtrip. The store seals with a throwaway
 * software AES key handed through its `internal` key-injection constructor
 * (the unit-test source set is the module's friend), because the host JVM
 * has no `AndroidKeyStore`; everything ELSE — layout, framing, atomicity,
 * absence semantics, fail direction — is exactly the production path. The
 * Keystore key itself is exercised on the emulator by the on-device
 * lock-survival checks.
 *
 * This file names exactly ONE `javax.crypto` surface — `KeyGenerator`, to
 * mint the throwaway key, never from raw bytes — and NO cipher
 * construction. It is the one never-shipped key-minting entry under
 * `app/`; the cipher family itself
 * belongs to `SecretStore.kt` alone, and src/main mints no provider-
 * unpinned key anywhere.
 */
class SecretStoreTest {

  private val roots = mutableListOf<File>()

  private fun tempRoot(): File {
    val root = Files.createTempDirectory("tacendum-secretstore").toFile()
    roots.add(root)
    return root
  }

  /**
   * JVM-TEST SEAM (the ONLY caller of the store's `internal` constructor):
   * a throwaway software AES key minted by the platform's own
   * `KeyGenerator`. This provider-unpinned mint lives HERE, in the test
   * source set that never ships, precisely so no such path exists in
   * src/main.
   */
  private fun freshStore(root: File = tempRoot()): SecretStore {
    val generator = KeyGenerator.getInstance("AES")
    generator.init(256)
    val key = generator.generateKey()
    return SecretStore(root) { key }
  }

  @After
  fun cleanup() {
    for (root in roots) root.deleteRecursively()
    roots.clear()
  }

  // --- secret roundtrip ---

  @Test
  fun roundtripReturnsExactlyWhatWasStored() {
    val store = freshStore()
    store.set("authToken", "bearer-0123456789")
    assertEquals("bearer-0123456789", store.get("authToken"))
  }

  @Test
  fun absentKeyReadsAsEmptyString() {
    // '' = absent (the JS facade maps it to null). Absence is a state,
    // never an error — a fresh install asks before anything ever wrote.
    val store = freshStore()
    assertEquals("", store.get("authToken"))
  }

  @Test
  fun overwriteReplacesTheValue() {
    val store = freshStore()
    store.set("lock.passcode", "111111")
    store.set("lock.passcode", "222222")
    assertEquals("222222", store.get("lock.passcode"))
  }

  @Test
  fun emptyValueRoundtripsAsEmpty() {
    // Setting '' is legal and indistinguishable from absence at the JS
    // facade — the iOS Keychain behaves the same way.
    val store = freshStore()
    store.set("tacendum.readReceipts", "")
    assertEquals("", store.get("tacendum.readReceipts"))
  }

  @Test
  fun deleteRemovesAndDeleteOfAbsentSucceeds() {
    val store = freshStore()
    store.set("lock.enabled", "1")
    store.delete("lock.enabled")
    assertEquals("", store.get("lock.enabled"))
    // The relock/duress paths delete blind: absent must succeed.
    store.delete("lock.enabled")
    store.delete("never-written")
  }

  @Test
  fun distinctKeysAreIndependent() {
    val store = freshStore()
    store.set("authToken", "token")
    store.set("lock.passcode", "482913")
    store.delete("authToken")
    assertEquals("", store.get("authToken"))
    assertEquals("482913", store.get("lock.passcode"))
  }

  // --- values are sealed at rest ---

  @Test
  fun storedBytesDoNotContainThePlaintext() {
    val root = tempRoot()
    val store = freshStore(root)
    val secret = "the-crown-jewel-bearer-token"
    store.set("authToken", secret)
    val onDisk = File(File(root, "values"), "authToken").readBytes()
    assertFalse(
        "the value file must not contain the plaintext",
        String(onDisk, Charsets.ISO_8859_1).contains(secret),
    )
    // And the framing overhead is exactly nonce + tag.
    assertEquals(12 + secret.length + 16, onDisk.size)
  }

  @Test
  fun twoWritesOfTheSameValueDifferOnDisk() {
    // Fresh provider-minted nonce per write: identical plaintext must never
    // produce identical files (a repeated nonce under GCM is catastrophic).
    val root = tempRoot()
    val store = freshStore(root)
    store.set("authToken", "same-value")
    val first = File(File(root, "values"), "authToken").readBytes()
    store.set("authToken", "same-value")
    val second = File(File(root, "values"), "authToken").readBytes()
    assertFalse(first.contentEquals(second))
  }

  // --- fail-closed read ---

  @Test
  fun corruptValueThrowsAndNeverReadsAsAbsent() {
    // The fail-closed discipline applied to secrets: "could not read" must never
    // answer "no secret" — '' here would read as logged-out / no lock.
    val root = tempRoot()
    val store = freshStore(root)
    val valuesDir = File(root, "values")
    valuesDir.mkdirs()
    File(valuesDir, "authToken").writeBytes(ByteArray(64) { 0x41 })

    var returned: String? = null
    var thrown: Exception? = null
    try {
      returned = store.get("authToken")
    } catch (err: GeneralSecurityException) {
      thrown = err
    }
    assertNull("a corrupt value must never produce an answer", returned)
    assertNotNull("a corrupt value must surface as an error", thrown)
  }

  @Test
  fun presentButUnreadableValueThrowsAndNeverReadsAsAbsent() {
    // A directory squatting on the value's path is PRESENT but unreadable —
    // exactly the shape a `!isFile` guard once collapsed into '', which the
    // JS facade maps to null: "no secret", i.e. logged-out / no lock. Only
    // "the path does not exist" may answer absence; every other failure to
    // read must throw.
    val root = tempRoot()
    val store = freshStore(root)
    val valuesDir = File(root, "values")
    valuesDir.mkdirs()
    assertTrue(File(valuesDir, "authToken").mkdir())

    var returned: String? = null
    var thrown: Exception? = null
    try {
      returned = store.get("authToken")
    } catch (err: IOException) {
      thrown = err
    }
    assertNull("present-but-unreadable must never produce an answer", returned)
    assertNotNull("present-but-unreadable must surface as an error", thrown)
  }

  @Test
  fun truncatedValueThrows() {
    // Shorter than nonce+tag cannot be a value the store wrote.
    val root = tempRoot()
    val store = freshStore(root)
    val valuesDir = File(root, "values")
    valuesDir.mkdirs()
    File(valuesDir, "authToken").writeBytes(ByteArray(8))
    var thrown = false
    try {
      store.get("authToken")
    } catch (expected: GeneralSecurityException) {
      thrown = true
    }
    assertTrue(thrown)
  }

  @Test
  fun tamperedValueThrows() {
    val root = tempRoot()
    val store = freshStore(root)
    store.set("authToken", "bearer-0123456789")
    val file = File(File(root, "values"), "authToken")
    val bytes = file.readBytes()
    // Flip one bit of the last byte (inside the tag).
    bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    var thrown = false
    try {
      store.get("authToken")
    } catch (expected: GeneralSecurityException) {
      thrown = true
    }
    assertTrue("a flipped bit must fail the read, loudly", thrown)
  }

  // --- atomic write ---

  @Test
  fun writeLeavesTheValueAndNoTempResidue() {
    val root = tempRoot()
    val store = freshStore(root)
    store.set("authToken", "bearer")
    store.set("lock.passcode", "482913")
    store.set("authToken", "bearer-2")
    val tmpLeftovers = File(root, "tmp").listFiles()
    assertNotNull(tmpLeftovers)
    assertEquals(
        "every atomic write must end in a rename — residue means a torn write path",
        0,
        tmpLeftovers!!.size,
    )
    assertTrue(File(File(root, "values"), "authToken").isFile)
    assertTrue(File(File(root, "values"), "lock.passcode").isFile)
  }

  @Test
  fun tempFilesCanNeverCollideWithAValue() {
    // The key alphabet admits '.', so any same-directory suffix scheme would
    // itself be a readable key name; the store keeps in-flight writes in a
    // separate tmp/ directory instead. Prove the layout: values/ holds
    // exactly the keys written, nothing else.
    val root = tempRoot()
    val store = freshStore(root)
    store.set("authToken", "bearer")
    val names = File(root, "values").listFiles()!!.map { it.name }.sorted()
    assertEquals(listOf("authToken"), names)
  }

  @Test
  fun atomicHelperReplacesContentWholly() {
    // The helper the store (and the shared-state files) write through:
    // rename lands the FULL new bytes and consumes the temp file.
    val dir = tempRoot()
    val target = File(dir, "state")
    val temp = File(dir, "state.tmp")
    AtomicFiles.write(target, temp, "first".toByteArray(Charsets.UTF_8))
    AtomicFiles.write(target, temp, "second".toByteArray(Charsets.UTF_8))
    assertEquals("second", target.readText(Charsets.UTF_8))
    assertFalse(temp.exists())
  }

  // --- name allowlists ---

  @Test
  fun secretKeyNamesArePinned() {
    for (valid in
        listOf("authToken", "lock.passcode", "tacendum.pushTokens", "A-Z_a-z.0-9", "a".repeat(64))) {
      assertTrue(valid, Names.isValidSecretKey(valid))
    }
    for (invalid in
        listOf("", ".", "..", "a/b", "../authToken", "a b", "naïve", "a".repeat(65), "key\n")) {
      assertFalse(invalid, Names.isValidSecretKey(invalid))
    }
  }

  @Test
  fun sharedStateNamesArePinned() {
    for (valid in
        listOf(
            "preview-level",
            "previews-armed",
            "self-user-id",
            "blocked-peers",
            "peer-names",
            "group-names",
            "pending-nav",
            "a".repeat(64))) {
      assertTrue(valid, Names.isValidSharedStateName(valid))
    }
    // ASCII-lower pin: names the shipped Swift check would admit (Unicode
    // letters, uppercase, dots) are rejected here BY DESIGN —
    // and '.'-lessness is what makes the "<name>.tmp" sibling unreadable.
    for (invalid in
        listOf("", "Preview", "a.b", "a_b", "état", "a/b", "..", "a".repeat(65))) {
      assertFalse(invalid, Names.isValidSharedStateName(invalid))
    }
  }

  @Test
  fun inboxIdsArePinned() {
    for (valid in listOf("01KYDBSSDJSPC9J0E5N2AWMJ5Y", "msg_1-A", "a".repeat(64))) {
      assertTrue(valid, Names.isValidInboxMsgId(valid))
    }
    for (invalid in listOf("", ".", "..", "a.b", "a/b", "../x", "a".repeat(65))) {
      assertFalse(invalid, Names.isValidInboxMsgId(invalid))
    }
  }

  @Test
  fun storeRefusesInvalidKeysWithoutTouchingDisk() {
    val root = tempRoot()
    val store = freshStore(root)
    for (bad in listOf("..", ".", "a/b", "", "naïve")) {
      var refused = false
      try {
        store.get(bad)
      } catch (expected: IllegalArgumentException) {
        refused = true
      }
      assertTrue("get must refuse: $bad", refused)
      refused = false
      try {
        store.set(bad, "x")
      } catch (expected: IllegalArgumentException) {
        refused = true
      }
      assertTrue("set must refuse: $bad", refused)
      refused = false
      try {
        store.delete(bad)
      } catch (expected: IllegalArgumentException) {
        refused = true
      }
      assertTrue("delete must refuse: $bad", refused)
    }
    // Nothing was created by any refused call.
    assertFalse(File(root, "values").exists())
  }
}
