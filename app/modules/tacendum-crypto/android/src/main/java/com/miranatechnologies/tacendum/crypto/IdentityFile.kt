package com.miranatechnologies.tacendum.crypto

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes

/**
 * The `hasIdentity()` boot check: a bare file-existence answer for
 * `<store>/identity.json`, with no store construction, no directory creation
 * and no lock acquisition.
 *
 * FAIL-CLOSED: an I/O error THROWS — it must never read as `false`.
 * A `false` here drives re-registration, which mints a fresh identity and
 * permanently abandons the account. `File.exists()` is therefore the wrong
 * primitive (it folds every error into `false`); `Files.readAttributes`
 * distinguishes "genuinely absent" (`NoSuchFileException`, the one condition
 * allowed to answer `false`) from "could not look" (any other `IOException`,
 * which propagates). `HasIdentityThrowsTest` pins the throw path.
 *
 * Pure JVM on purpose — no Android imports — so the fail-direction contract
 * is provable in a plain host unit test.
 */
object IdentityFile {
  const val FILE_NAME = "identity.json"

  @Throws(IOException::class)
  fun hasIdentity(storeRoot: File): Boolean {
    val path = File(storeRoot, FILE_NAME).toPath()
    return try {
      Files.readAttributes(path, BasicFileAttributes::class.java)
      true
    } catch (absent: NoSuchFileException) {
      // The file (or its parent directory) does not exist — the one
      // condition that may read as "no identity".
      false
    }
    // Every other IOException (permission failure, I/O fault) propagates:
    // an error is an error, never an answer.
  }

  /** The file's two fields, in the iOS shape (`TacendumStores.swift`'s
   * `IdentityFile`): the serialized identity key pair, base64, and the 14-bit
   * registration id. */
  data class Record(val identityKeyPairB64: String, val registrationId: Int)

  /**
   * Written and read by hand rather than through `org.json`, deliberately.
   * `org.json` lives in `android.jar`, whose host-JVM stub throws on every
   * call, and this record is on the path the host suites must prove — the one
   * that decides whether this device still has its account. Two fields, one of
   * them base64 (an alphabet with nothing JSON must escape) and one an
   * integer, so the encoder is total and the decoder can be strict.
   */
  fun write(storeRoot: File, record: Record) {
    val json =
        "{\"identityKeyPair\":\"${record.identityKeyPairB64}\"," +
            "\"registrationId\":${record.registrationId}}"
    val target = File(storeRoot, FILE_NAME)
    AtomicFiles.write(target, File(storeRoot, "$FILE_NAME.tmp"), json.toByteArray(Charsets.UTF_8))
  }

  /** STRICT: anything the writer above would not have produced is corruption,
   * never a partially-populated record. A record read as half-present is a
   * record that mints a second identity. */
  fun read(storeRoot: File): Record {
    val text = File(storeRoot, FILE_NAME).readText(Charsets.UTF_8)
    val keyPair =
        KEY_PAIR_FIELD.find(text)?.groupValues?.get(1)
            ?: throw IOException("corrupt store file: identity.json")
    val registrationId =
        REGISTRATION_ID_FIELD.find(text)?.groupValues?.get(1)?.toIntOrNull()
            ?: throw IOException("corrupt store file: identity.json")
    return Record(keyPair, registrationId)
  }

  private val KEY_PAIR_FIELD = Regex("\"identityKeyPair\"\\s*:\\s*\"([A-Za-z0-9+/=]*)\"")
  private val REGISTRATION_ID_FIELD = Regex("\"registrationId\"\\s*:\\s*(\\d+)")
}
