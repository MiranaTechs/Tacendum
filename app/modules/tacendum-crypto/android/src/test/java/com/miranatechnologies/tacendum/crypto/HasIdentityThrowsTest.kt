package com.miranatechnologies.tacendum.crypto

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The account-loss guard, pinned.
 *
 * `hasIdentity` answers the most consequential boolean in the app: `false`
 * drives re-registration, which mints a fresh identity and permanently
 * abandons the account. So the I/O-error path must THROW — a later refactor
 * that catch-and-returns-false passes every other check; this
 * test is the one detector.
 */
class HasIdentityThrowsTest {

  private val roots = mutableListOf<File>()

  private fun tempRoot(): File {
    val root = Files.createTempDirectory("tacendum-hasidentity").toFile()
    roots.add(root)
    return root
  }

  @After
  fun cleanup() {
    for (root in roots) {
      // Restore access so the unreadable fixture can be deleted.
      try {
        Files.setPosixFilePermissions(
            root.toPath(), PosixFilePermissions.fromString("rwx------"))
      } catch (ignored: Exception) {
        // best-effort
      }
      root.deleteRecursively()
    }
    roots.clear()
  }

  @Test
  fun absentFileReadsAsFalse() {
    val root = tempRoot()
    assertFalse(IdentityFile.hasIdentity(root))
  }

  @Test
  fun absentStoreDirectoryReadsAsFalse() {
    // Fresh install: the protocol store directory itself does not exist yet.
    val root = File(tempRoot(), "never-created")
    assertFalse(IdentityFile.hasIdentity(root))
  }

  @Test
  fun presentFileReadsAsTrue() {
    val root = tempRoot()
    File(root, IdentityFile.FILE_NAME).writeText("{}")
    assertTrue(IdentityFile.hasIdentity(root))
  }

  @Test
  fun ioErrorThrowsAndNeverReadsAsFalse() {
    val root = tempRoot()
    File(root, IdentityFile.FILE_NAME).writeText("{}")
    // Deny all access on the store directory: the identity file EXISTS but
    // cannot be looked at — the exact condition that must never answer
    // "no identity".
    Files.setPosixFilePermissions(
        root.toPath(), PosixFilePermissions.fromString("---------"))

    var returned: Boolean? = null
    var thrown: IOException? = null
    try {
      returned = IdentityFile.hasIdentity(root)
    } catch (err: IOException) {
      thrown = err
    }

    assertNull("an I/O error must never produce a boolean verdict", returned)
    assertNotNull("the unreadable store must surface as an IOException", thrown)
  }
}
