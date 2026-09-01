package com.miranatechnologies.tacendum.crypto

import java.security.SecureRandom
import org.signal.libsignal.crypto.Aes256GcmDecryption
import org.signal.libsignal.crypto.Aes256GcmEncryption

/**
 * The attachment-blob cipher — THE ONLY FILE in this repository permitted to
 * name `Aes256GcmEncryption` / `Aes256GcmDecryption`.
 * Either name appearing in any other shipped file is a defect, as is this
 * file naming the
 * platform-Keystore cipher family that belongs to `SecretStore.kt` alone —
 * the two allowlists are disjoint, which is why that family is not spelled out
 * here even in prose.
 *
 * THE CIPHER NEVER LEAVES LIBSIGNAL.
 * AES-256-GCM runs inside `libsignal_jni.so`, the same NIST SP 800-38D GCM the
 * Swift `Aes256GcmEncryptedData` path performs. What IS ours, because the Java
 * binding exposes only the streaming pair and no one-shot type, is three
 * responsibilities the Swift type owns on iOS:
 *
 *   1. the 12-byte nonce mint (`SecureRandom`, a sanctioned platform primitive);
 *   2. the `nonce(12) ‖ ciphertext ‖ tag(16)` framing, AAD empty — byte-
 *      identical to `Aes256GcmEncryptedData.concatenate()` and to what its
 *      length-checked `init(concatenated:)` accepts;
 *   3. the copy-ciphertext → `verifyTag` → only-then-return ordering, because
 *      `Aes256GcmDecryption.decrypt` mutates its buffer IN PLACE and the
 *      binding's own Javadoc warns that without `verifyTag` "you have no
 *      authenticity guarantees".
 *
 * This is exactly the shape where AEAD deployments actually fail: the nonce
 * source and the wire framing become OUR code. Here the
 * binding offers no alternative, so the hazard is taken on deliberately,
 * named, and fenced.
 *
 * FORBIDDEN VARIANTS, BY NAME (part of the permission, not advice about it):
 * no STREAMING decrypt, no CHUNKED decrypt, no PIPED decrypt — no exported
 * decryption object, no incremental API, no partial-output form. [open] is
 * exactly ONE function whose intermediate buffer never escapes the frame: on
 * a tampered blob it yields an error and ZERO plaintext, structurally, not by
 * caller courtesy. A second file touching the streaming pair, a non-empty
 * AAD, a version byte inside the blob, a key reused across two encryptions,
 * or encrypting anything that is not an attachment blob is a new decision, not
 * an extension of this one.
 *
 * Also mandatory here:
 *  - key/nonce/tag lengths asserted IN CODE before any cipher construction —
 *    the binding constructs with what it is given, and a vector suite only
 *    ever injects well-formed inputs;
 *  - the nonce is minted here and nowhere else, and [seal] mints the KEY too,
 *    so no caller can hand in a key that has already encrypted something —
 *    the property that makes nonce misuse structurally impossible;
 *  - encrypt-then-verify before any upload: the blob just produced is
 *    decrypted and compared, bounded by [MAX_ATTACHMENT_BYTES];
 *  - errors name LENGTHS and carry no key, nonce, plaintext or ciphertext
 *    bytes.
 */
internal object BlobCipher {
  const val KEY_BYTES = 32
  const val NONCE_BYTES = 12
  const val TAG_BYTES = 16

  /** nonce + tag: what an empty plaintext seals to. Shorter is torn. */
  const val MIN_BLOB_BYTES = NONCE_BYTES + TAG_BYTES

  /**
   * `MAX_ATTACHMENT_BYTES` (packages/shared/src/dto.ts): the cap is on the
   * base64 TEXT of the blob, because that is what the server signs into the
   * presigned PUT.
   */
  const val MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

  /** The platform CSPRNG. One instance, minting only nonces
   * and per-blob keys — never long-lived key material. */
  private val RNG = SecureRandom()

  /** AAD stays empty, and there is no `setAAD`-shaped call anywhere in this
   * file: an in-band discriminator would sit outside the AEAD and create two
   * length arithmetics over one buffer. Any future version goes in the
   * envelope, which rides the ratchet. */
  private val NO_AAD = ByteArray(0)

  /** A blob and the one key that ever encrypted it. */
  class Sealed(val key: ByteArray, val blob: ByteArray)

  /** Which guard refused. Tests assert on THIS, never on message prose. */
  enum class Check {
    KEY_LENGTH,
    NONCE_LENGTH,
    TAG_LENGTH,
    BLOB_LENGTH,
    AUTH,
    VERIFY_MISMATCH,
    TOO_LARGE,
  }

  class BlobCipherException(val check: Check, message: String) : RuntimeException(message)

  /**
   * Seal an attachment blob for upload: a fresh 32-byte key and a fresh
   * 12-byte nonce from the platform CSPRNG, each used exactly once. The key is
   * minted HERE rather than accepted as an argument so that "one key encrypts
   * one blob" is a property of the type rather than of every call site; it
   * reaches the recipient only inside the Signal-encrypted message envelope,
   * so libsignal still owns the only long-lived secret.
   *
   * Then ENCRYPT-THEN-VERIFY: the blob just produced is decrypted and compared
   * before it is allowed anywhere near an upload. It is the only check that
   * covers the nonce mint, the framing and truncation on the real path rather
   * than the vector path.
   */
  fun seal(plaintext: ByteArray): Sealed {
    val blobB64Length = base64Length(plaintext.size.toLong() + MIN_BLOB_BYTES)
    if (blobB64Length > MAX_ATTACHMENT_BYTES) {
      throw BlobCipherException(
          Check.TOO_LARGE,
          "attachment of ${plaintext.size} bytes would upload as $blobB64Length " +
              "base64 characters, over the $MAX_ATTACHMENT_BYTES cap",
      )
    }
    val key = ByteArray(KEY_BYTES)
    RNG.nextBytes(key)
    val nonce = ByteArray(NONCE_BYTES)
    RNG.nextBytes(nonce)
    val blob = sealWithNonce(key, nonce, plaintext)
    if (!open(key, blob).contentEquals(plaintext)) {
      throw BlobCipherException(
          Check.VERIFY_MISMATCH,
          "encrypt-then-verify failed: the blob just produced did not decrypt back to " +
              "its ${plaintext.size} bytes of plaintext",
      )
    }
    return Sealed(key, blob)
  }

  /**
   * Decrypt an attachment blob. ONE function, no streaming form.
   *
   * `Aes256GcmDecryption.decrypt` writes plaintext OVER the buffer it is
   * given, so the ciphertext is copied out of the caller's blob first and the
   * candidate plaintext lives only in that private copy until `verifyTag`
   * succeeds. No caller can observe a byte of it before authentication, and on
   * failure the buffer is wiped before the throw — this client hands decrypted
   * attachment bytes to code that acts on what it reads, so plaintext escaping
   * ahead of the tag is a chosen-plaintext feed, not a style preference.
   */
  fun open(key: ByteArray, blob: ByteArray): ByteArray {
    if (key.size != KEY_BYTES) {
      throw BlobCipherException(
          Check.KEY_LENGTH,
          "attachment key must be $KEY_BYTES bytes; got ${key.size}",
      )
    }
    if (blob.size < MIN_BLOB_BYTES) {
      throw BlobCipherException(
          Check.BLOB_LENGTH,
          "attachment blob must be at least $MIN_BLOB_BYTES bytes " +
              "(nonce $NONCE_BYTES + tag $TAG_BYTES); got ${blob.size}",
      )
    }
    val nonce = blob.copyOfRange(0, NONCE_BYTES)
    // The COPY: the binding decrypts in place, so this must not be a view of
    // the caller's blob, and it must not be readable from anywhere else.
    val buffer = blob.copyOfRange(NONCE_BYTES, blob.size - TAG_BYTES)
    val tag = blob.copyOfRange(blob.size - TAG_BYTES, blob.size)
    // Asserted in code before the construction, even though the slicing above
    // makes both true by arithmetic: the assertions are the thing that catches
    // a future edit to the arithmetic.
    assertNonce(nonce)
    assertTag(tag)
    val decryption = Aes256GcmDecryption(key, nonce, NO_AAD)
    decryption.decrypt(buffer)
    if (!decryption.verifyTag(tag)) {
      buffer.fill(0)
      throw BlobCipherException(Check.AUTH, "attachment blob failed authentication")
    }
    return buffer
  }

  /**
   * Seal with a CALLER-SUPPLIED nonce.
   *
   * Two callers, both of them the framing itself: [seal] — which mints the
   * nonce one line above the call — and the byte-parity suites, which must
   * reproduce a fixture whose nonce is pinned in its own blob bytes, and can
   * therefore check the ENCRYPT direction byte-exactly rather than only the
   * decrypt one. (The CLI's `sealForParityVectors` exists for the identical
   * reason and under the identical counterweight.)
   *
   * Nothing else may call it: a caller-chosen nonce beside a reused key is the
   * one failure AES-GCM cannot survive, which is why [seal] — the production
   * path — mints both and this function is `internal`.
   */
  fun sealWithNonce(key: ByteArray, nonce: ByteArray, plaintext: ByteArray): ByteArray {
    if (key.size != KEY_BYTES) {
      throw BlobCipherException(
          Check.KEY_LENGTH,
          "attachment key must be $KEY_BYTES bytes; got ${key.size}",
      )
    }
    assertNonce(nonce)
    // The binding encrypts IN PLACE, so the plaintext the caller handed us is
    // never mutated: it is copied, and the copy becomes the ciphertext.
    val buffer = plaintext.copyOf()
    val encryption = Aes256GcmEncryption(key, nonce, NO_AAD)
    encryption.encrypt(buffer)
    val tag = encryption.computeTag()
    assertTag(tag)
    val blob = ByteArray(NONCE_BYTES + buffer.size + TAG_BYTES)
    System.arraycopy(nonce, 0, blob, 0, NONCE_BYTES)
    System.arraycopy(buffer, 0, blob, NONCE_BYTES, buffer.size)
    System.arraycopy(tag, 0, blob, NONCE_BYTES + buffer.size, TAG_BYTES)
    return blob
  }

  private fun assertNonce(nonce: ByteArray) {
    if (nonce.size != NONCE_BYTES) {
      throw BlobCipherException(
          Check.NONCE_LENGTH,
          "attachment nonce must be $NONCE_BYTES bytes; got ${nonce.size}",
      )
    }
  }

  private fun assertTag(tag: ByteArray) {
    if (tag.size != TAG_BYTES) {
      throw BlobCipherException(
          Check.TAG_LENGTH,
          "attachment tag must be $TAG_BYTES bytes; got ${tag.size}",
      )
    }
  }

  private fun base64Length(rawBytes: Long): Long = 4 * ((rawBytes + 2) / 3)
}
