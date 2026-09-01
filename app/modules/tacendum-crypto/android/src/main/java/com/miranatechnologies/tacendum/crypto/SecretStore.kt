package com.miranatechnologies.tacendum.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The Keychain analogue — the app's string secrets (`authToken`,
 * `lock.passcode`, `lock.enabled`, ...) stored as one file per key, each
 * value encrypted at rest under a NON-EXPORTABLE `AndroidKeyStore` AES-GCM
 * key with no user-auth requirement (background reads must work on every
 * device; hardware-backed where the device provides it, software Keystore
 * otherwise — no security-level enforcement, a deliberate non-requirement).
 *
 * THIS IS THE ONE `javax.crypto` FILE IN SHIPPED CODE. The Keystore key is
 * usable through `javax.crypto.Cipher` or not at all — that is the platform
 * operating the platform's own key, not a second content
 * cipher. The invariants this file keeps: the
 * "AndroidKeyStore" provider literal is present, no cipher key is ever
 * built from raw key bytes this class holds — the raw-key "Keystore
 * wrapper" is the defect that rule exists to prevent — and every
 * `KeyGenerator.getInstance` here is provider-pinned. (`SecretStoreTest`,
 * in the never-shipped test source set, is the one other key-minting
 * entry; it may name no cipher construction.) A second `javax.crypto` site
 * anywhere is a defect, not a style question.
 *
 * Contract (mirrors the iOS Keychain surface):
 *  - `get` of an absent key is `''` — absence is a state, mapped to `null`
 *    at the JS facade; a PRESENT but unreadable value THROWS (fail-closed:
 *    "could not read" must never answer "no secret" — the reauth and lock
 *    paths make decisions on that answer).
 *  - `set` is an atomic write-rename; a reader sees old bytes or new bytes,
 *    never a prefix.
 *  - `delete` of an absent key succeeds (the relock/duress paths delete
 *    blind).
 *  - Pre-first-unlock the backing storage (credential-encrypted filesDir)
 *    and the Keystore may be unavailable: every failure here surfaces as a
 *    thrown exception the module maps to a clean promise rejection — null
 *    at the caller (reauth.ts `currentToken` catches to null), NEVER a
 *    native crash.
 *
 * Unlike the iOS Keychain, nothing here survives uninstall — key and files
 * die with the app data (a deliberate divergence) — and nothing is
 * backed up: the app's backup rules exclude every domain.
 *
 * On-disk layout under the store root (`filesDir/tacendum-secrets`):
 *   values/<key>   iv(12) ‖ ciphertext ‖ tag(16)
 *   tmp/<key>      in-flight atomic writes (renamed into values/)
 * The tmp/ subdirectory exists because the key alphabet admits '.', so ANY
 * sibling suffix scheme would itself be a readable key name; a separate
 * directory can never collide with a value.
 */
class SecretStore
/**
 * The key is INJECTED, and the constructor is `internal`, because this is
 * the JVM unit test's ONLY seam: the host JVM has no `AndroidKeyStore`
 * provider, so `SecretStoreTest` — a friend of this module's main source
 * set — hands in a throwaway software key and runs everything else exactly
 * as production does. Shipped code has exactly one entry point, `open`,
 * which binds the Keystore key; no src/main path ever mints a key outside
 * `AndroidKeyStore`.
 */
internal constructor(
    private val root: File,
    private val keyProvider: () -> SecretKey,
) {
  private val valuesDir = File(root, "values")
  private val tmpDir = File(root, "tmp")
  private val lock = Any()
  private var cachedKey: SecretKey? = null

  private fun storeKey(): SecretKey =
      synchronized(lock) {
        cachedKey ?: keyProvider().also { cachedKey = it }
      }

  /** '' when absent; throws when present but unreadable (fail-closed). */
  @Throws(IOException::class, GeneralSecurityException::class)
  fun get(key: String): String {
    requireValidKey(key)
    val file = File(valuesDir, key)
    // The ONE shape of absence is "the path does not exist", and only the
    // read itself can say so. Everything else — a directory squatting on the
    // value's path, EACCES, an unstatable parent, any I/O error — throws out
    // of the read. (A `!isFile` guard here once collapsed all of those into
    // '', and '' reads as logged-out / no lock at the JS facade.)
    val sealed =
        try {
          Files.readAllBytes(file.toPath())
        } catch (absent: NoSuchFileException) {
          return ""
        }
    if (sealed.size < IV_BYTES + TAG_BYTES) {
      // Shorter than one nonce plus one tag cannot be a value this class
      // wrote: corruption, and corruption is an error, never an answer.
      throw GeneralSecurityException("secret value unreadable")
    }
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(
        Cipher.DECRYPT_MODE,
        storeKey(),
        GCMParameterSpec(TAG_BYTES * 8, sealed, 0, IV_BYTES),
    )
    // A bad tag (tamper, truncation, wrong key) throws out of doFinal —
    // the fail-closed path SecretStoreTest pins.
    val plain = cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    return String(plain, Charsets.UTF_8)
  }

  @Throws(IOException::class, GeneralSecurityException::class)
  fun set(key: String, value: String) {
    requireValidKey(key)
    val cipher = Cipher.getInstance(TRANSFORM)
    // No caller-supplied nonce anywhere: init without parameters makes the
    // provider mint the nonce (the Keystore REQUIRES that — randomized
    // encryption is the point of a non-exportable key).
    cipher.init(Cipher.ENCRYPT_MODE, storeKey())
    val iv = cipher.iv
    if (iv == null || iv.size != IV_BYTES) {
      throw GeneralSecurityException("unexpected nonce length")
    }
    val box = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val sealed = ByteArray(iv.size + box.size)
    iv.copyInto(sealed, 0)
    box.copyInto(sealed, iv.size)
    synchronized(lock) {
      if (!valuesDir.isDirectory && !valuesDir.mkdirs()) {
        throw IOException("secret store unavailable")
      }
      if (!tmpDir.isDirectory && !tmpDir.mkdirs()) {
        throw IOException("secret store unavailable")
      }
      AtomicFiles.write(File(valuesDir, key), File(tmpDir, key), sealed)
    }
  }

  /** Delete-of-absent is success — the relock/duress paths delete blind. */
  @Throws(IOException::class)
  fun delete(key: String) {
    requireValidKey(key)
    synchronized(lock) {
      val file = File(valuesDir, key)
      if (file.isFile && !file.delete()) {
        throw IOException("secret delete failed")
      }
    }
  }

  private fun requireValidKey(key: String) {
    // Errors are generic and never echo the name.
    require(Names.isValidSecretKey(key)) { "invalid secret key" }
  }

  companion object {
    /** The platform keystore provider. */
    const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val KEY_ALIAS = "tacendum-secret-store"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16

    /** The production store: values sealed under the Keystore key. */
    fun open(root: File): SecretStore = SecretStore(root) { keystoreKey() }

    /**
     * The store's one key: generated inside `AndroidKeyStore` on first use
     * (non-exportable by construction — key material never exists outside
     * the Keystore), fetched thereafter. No user-auth requirement and no
     * unlocked-device requirement: background reads (websocket reconnect,
     * the NSE-role handler) must work with the screen off.
     */
    private fun keystoreKey(): SecretKey {
      val keystore = KeyStore.getInstance(KEYSTORE_PROVIDER)
      keystore.load(null)
      val existing = keystore.getKey(KEY_ALIAS, null)
      if (existing is SecretKey) return existing
      val generator =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
      generator.init(
          KeyGenParameterSpec.Builder(
                  KEY_ALIAS,
                  KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
              )
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256)
              .build()
      )
      return generator.generateKey()
    }
  }
}
