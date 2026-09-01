package com.miranatechnologies.tacendum.crypto

import java.io.File
import java.io.IOException
import java.nio.file.DirectoryIteratorException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes
import java.util.LinkedList
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.state.IdentityKeyStore
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.KyberPreKeyStore
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyStore
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SessionStore
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyStore

/**
 * File-backed libsignal protocol stores, over the SAME on-disk layout the iOS
 * build uses (`TacendumStores.swift`) — every stored record is
 * libsignal's own serialized form, produced by the same Rust core, so the
 * layout is portable by construction:
 *
 * ```
 * <root>/identity.json               {identityKeyPair: b64, registrationId}
 * <root>/sessions/<peer>.<dev>.bin   SessionRecord.serialize()
 * <root>/identities/<peer>.<dev>.pub TOFU-pinned peer IdentityKey.serialize()
 * <root>/prekeys/<id>.bin            PreKeyRecord.serialize()
 * <root>/signed-prekeys/<id>.bin     SignedPreKeyRecord.serialize()
 * <root>/kyber-prekeys/<id>.bin      KyberPreKeyRecord.serialize()
 * ```
 *
 * THIS FILE PERFORMS NO CRYPTOGRAPHY. It moves libsignal's
 * bytes to and from disk; every key operation happens inside libsignal.
 *
 * FAIL-CLOSED READS, which is the whole reason [readOrNull] exists instead of
 * a bare `File.exists()`: `null` means the file is GENUINELY ABSENT, and
 * nothing else. A read that fails on a file that IS there throws. Folding an
 * I/O error into "absent" would silently reset a TOFU identity pin or drop a
 * live session and re-bootstrap a fresh ratchet — the failure direction that
 * costs an account rather than a request.
 *
 * NO CROSS-PROCESS LOCK. iOS holds an flock for the store object's
 * lifetime because a notification extension decrypts in a second process;
 * Android v1 is single-process and every entry point is marshalled onto one
 * serial executor, so there is no concurrent store access to arbitrate. The
 * `store_busy` rejection code survives in the error mapper regardless, because
 * `app/src/messaging.ts` branches on it — it simply never fires here. If a
 * second process is ever introduced, this is a redesign (FileLock is per-JVM
 * channel and its intra-process semantics are not flock's), not a transliteration.
 *
 * Pure JVM on purpose — no Android imports — so the layout, the fail
 * direction, and the record round-trips are provable in host unit tests
 * against the real libsignal.
 */
internal class ProtocolStore(private val root: File) :
    IdentityKeyStore, PreKeyStore, SignedPreKeyStore, KyberPreKeyStore, SessionStore {

  class StoreException(val kind: Kind, message: String) : RuntimeException(message) {
    enum class Kind {
      NO_IDENTITY,
      IDENTITY_EXISTS,
      MISSING_RECORD,
      CORRUPT,
      IO,
      BAD_ADDRESS,
    }
  }

  private val identityPath = File(root, IdentityFile.FILE_NAME)
  private val identitiesDir = File(root, "identities")
  private val sessionsDir = File(root, "sessions")
  private val prekeysDir = File(root, "prekeys")
  private val signedPrekeysDir = File(root, "signed-prekeys")
  private val kyberPrekeysDir = File(root, "kyber-prekeys")

  init {
    for (dir in
        listOf(root, identitiesDir, sessionsDir, prekeysDir, signedPrekeysDir, kyberPrekeysDir)) {
      if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
        throw StoreException(StoreException.Kind.IO, "protocol store directory unavailable")
      }
    }
  }

  // --- local identity --------------------------------------------------

  fun hasIdentity(): Boolean = IdentityFile.hasIdentity(root)

  /** One-time initialization at registration. Refuses to overwrite: an
   * identity is the account, and overwriting one abandons it. */
  fun initializeIdentity(keyPair: IdentityKeyPair, registrationId: Int) {
    if (hasIdentity()) {
      throw StoreException(
          StoreException.Kind.IDENTITY_EXISTS,
          "identity already exists; refusing to overwrite",
      )
    }
    IdentityFile.write(
        root,
        IdentityFile.Record(
            identityKeyPairB64 = Codec.b64(keyPair.serialize()),
            registrationId = registrationId,
        ),
    )
  }

  private fun identityRecord(): IdentityFile.Record {
    if (!hasIdentity()) {
      throw StoreException(StoreException.Kind.NO_IDENTITY, "no identity — register first")
    }
    return IdentityFile.read(root)
  }

  override fun getIdentityKeyPair(): IdentityKeyPair {
    val record = identityRecord()
    val raw =
        try {
          Codec.unb64(record.identityKeyPairB64)
        } catch (bad: IllegalArgumentException) {
          throw StoreException(StoreException.Kind.CORRUPT, "corrupt store file: identity.json")
        }
    return IdentityKeyPair(raw)
  }

  override fun getLocalRegistrationId(): Int = identityRecord().registrationId

  // --- IdentityKeyStore (TOFU) -----------------------------------------

  private fun peerIdentityFile(address: SignalProtocolAddress) =
      File(identitiesDir, "${addressKey(address)}.pub")

  override fun getIdentity(address: SignalProtocolAddress): IdentityKey? {
    val raw = readOrNull(peerIdentityFile(address)) ?: return null
    return IdentityKey(raw)
  }

  override fun saveIdentity(
      address: SignalProtocolAddress,
      identity: IdentityKey,
  ): IdentityKeyStore.IdentityChange {
    val existing = getIdentity(address)
    val changed = existing != null && !existing.serialize().contentEquals(identity.serialize())
    writeAtomic(peerIdentityFile(address), identity.serialize())
    return if (changed) IdentityKeyStore.IdentityChange.REPLACED_EXISTING
    else IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED
  }

  override fun isTrustedIdentity(
      address: SignalProtocolAddress,
      identity: IdentityKey,
      direction: IdentityKeyStore.Direction,
  ): Boolean {
    // Trust on first use; afterwards the pinned bytes must match exactly. A
    // mismatch is what surfaces to JS as `identity_changed`.
    val existing = getIdentity(address) ?: return true
    return existing.serialize().contentEquals(identity.serialize())
  }

  /** Forget a peer's pinned identity and session so the next contact re-pins
   * (TOFU) and rebuilds the ratchet — the "accept a changed safety number"
   * flow. Best-effort on each path, like the iOS `clearPeer`. */
  fun clearPeer(address: SignalProtocolAddress) {
    peerIdentityFile(address).delete()
    sessionFile(address).delete()
  }

  // --- PreKeyStore ------------------------------------------------------

  private fun preKeyFile(id: Int) = File(prekeysDir, "$id.bin")

  /**
   * The one-time prekey ids still on disk, ascending. Consumed ones were
   * removed by [removePreKey], so this is exactly the set whose private halves
   * still exist — which is what `existingKeysForUpload` needs in order to mint
   * FRESH ids above the high-water mark rather than re-advertise survivors.
   */
  fun existingPreKeyIds(): List<Int> = recordIds(prekeysDir)

  override fun loadPreKey(id: Int): PreKeyRecord {
    val raw = readOrNull(preKeyFile(id)) ?: throw InvalidKeyIdException("no such prekey")
    return PreKeyRecord(raw)
  }

  override fun storePreKey(id: Int, record: PreKeyRecord) {
    writeAtomic(preKeyFile(id), record.serialize())
  }

  override fun containsPreKey(id: Int): Boolean = existsOrThrow(preKeyFile(id))

  /** Consumption: a one-time prekey's private half is deleted the moment the
   * message that used it decrypts. Best-effort — a failed delete must not fail
   * a decrypt that already advanced the ratchet. */
  override fun removePreKey(id: Int) {
    preKeyFile(id).delete()
  }

  // --- SignedPreKeyStore ------------------------------------------------

  private fun signedPreKeyFile(id: Int) = File(signedPrekeysDir, "$id.bin")

  override fun loadSignedPreKey(id: Int): SignedPreKeyRecord {
    val raw = readOrNull(signedPreKeyFile(id)) ?: throw InvalidKeyIdException("no such signed prekey")
    return SignedPreKeyRecord(raw)
  }

  override fun loadSignedPreKeys(): List<SignedPreKeyRecord> =
      recordIds(signedPrekeysDir).map { loadSignedPreKey(it) }

  override fun storeSignedPreKey(id: Int, record: SignedPreKeyRecord) {
    writeAtomic(signedPreKeyFile(id), record.serialize())
  }

  override fun containsSignedPreKey(id: Int): Boolean = existsOrThrow(signedPreKeyFile(id))

  override fun removeSignedPreKey(id: Int) {
    signedPreKeyFile(id).delete()
  }

  // --- KyberPreKeyStore -------------------------------------------------

  private fun kyberPreKeyFile(id: Int) = File(kyberPrekeysDir, "$id.bin")

  override fun loadKyberPreKey(id: Int): KyberPreKeyRecord {
    val raw = readOrNull(kyberPreKeyFile(id)) ?: throw InvalidKeyIdException("no such kyber prekey")
    return KyberPreKeyRecord(raw)
  }

  override fun loadKyberPreKeys(): List<KyberPreKeyRecord> =
      recordIds(kyberPrekeysDir).map { loadKyberPreKey(it) }

  override fun storeKyberPreKey(id: Int, record: KyberPreKeyRecord) {
    writeAtomic(kyberPreKeyFile(id), record.serialize())
  }

  override fun containsKyberPreKey(id: Int): Boolean = existsOrThrow(kyberPreKeyFile(id))

  /**
   * DELIBERATE NO-OP, matching iOS. The store holds exactly one Kyber prekey
   * and it is the LAST-RESORT key (id 1), which is reusable by design — the
   * interface's "if it's a one-time pre-key, remove it" branch has nothing to
   * remove here, and the replay ledger the last-resort branch describes is a
   * multi-key facility this single-key store does not have. Removing it would
   * strand every PQXDH bundle already advertised.
   */
  override fun markKyberPreKeyUsed(id: Int, signedPreKeyId: Int, baseKey: ECPublicKey) {
    // no-op by design
  }

  // --- SessionStore -----------------------------------------------------

  private fun sessionFile(address: SignalProtocolAddress) =
      File(sessionsDir, "${addressKey(address)}.bin")

  /** `null` when there is no session — the shape libsignal's own reference
   * store returns, and the shape `hasSession` reads. */
  override fun loadSession(address: SignalProtocolAddress): SessionRecord? {
    val raw = readOrNull(sessionFile(address)) ?: return null
    return SessionRecord(raw)
  }

  override fun loadExistingSessions(
      addresses: List<SignalProtocolAddress>
  ): List<SessionRecord> {
    val out = LinkedList<SessionRecord>()
    for (address in addresses) {
      // The interface contract is to THROW on a missing session, not to
      // return a short list: a caller handed a partial list would encrypt to
      // the wrong set of devices and never know.
      val record =
          loadSession(address) ?: throw NoSessionException(address, "no session for the address")
      out.add(record)
    }
    return out
  }

  /** Sub-devices only — device 1 is the primary, and this install has no
   * others (deviceId is pinned to 1 across every client). */
  override fun getSubDeviceSessions(name: String): List<Int> =
      (sessionsDir.list() ?: emptyArray())
          .filter { it.endsWith(".bin") }
          .mapNotNull { fileName ->
            val stem = fileName.removeSuffix(".bin")
            val dot = stem.lastIndexOf('.')
            if (dot <= 0) return@mapNotNull null
            if (stem.substring(0, dot) != name) return@mapNotNull null
            stem.substring(dot + 1).toIntOrNull()
          }
          .filter { it != 1 }
          .sorted()

  override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) {
    writeAtomic(sessionFile(address), record.serialize())
  }

  override fun containsSession(address: SignalProtocolAddress): Boolean =
      existsOrThrow(sessionFile(address))

  override fun deleteSession(address: SignalProtocolAddress) {
    sessionFile(address).delete()
  }

  override fun deleteAllSessions(name: String) {
    for (fileName in sessionsDir.list() ?: emptyArray()) {
      val stem = fileName.removeSuffix(".bin")
      val dot = stem.lastIndexOf('.')
      if (dot > 0 && stem.substring(0, dot) == name) {
        File(sessionsDir, fileName).delete()
      }
    }
  }

  // --- file plumbing ----------------------------------------------------

  private fun recordIds(dir: File): List<Int> =
      try {
        Files.newDirectoryStream(dir.toPath()).use { entries ->
          entries
              .map { it.fileName.toString() }
              .filter { it.endsWith(".bin") }
              .mapNotNull { it.removeSuffix(".bin").toIntOrNull() }
              .sorted()
        }
      } catch (absent: NoSuchFileException) {
        emptyList()
      } catch (err: DirectoryIteratorException) {
        throw StoreException(StoreException.Kind.IO, "protocol store read failed")
      } catch (err: IOException) {
        throw StoreException(StoreException.Kind.IO, "protocol store read failed")
      }

  /**
   * `<name>.<deviceId>` — the iOS key, so the two platforms name the same file
   * for the same peer.
   *
   * The name becomes a PATH SEGMENT beside the directories that hold protocol
   * state, so a separator or a dot-reference in it would let a peer id chosen
   * by a remote party write outside its own directory. iOS does not check
   * this; Android refuses, and refuses nothing a real id contains (ids are
   * ULIDs — 26 alphanumeric characters).
   *
   * The NUL guard is written as the ESCAPE `'\u0000'`, never as a literal NUL
   * byte typed into this file, and it must stay that way: one raw NUL makes
   * `grep` classify this whole file as binary and skip it SILENTLY, hiding
   * it from any grep-based scan. The
   * two guards are equal Chars — this is a source-hygiene rule, not a
   * behaviour change.
   */
  private fun addressKey(address: SignalProtocolAddress): String {
    val name = address.name
    if (name.isEmpty() ||
        name.length > 64 ||
        name == "." ||
        name == ".." ||
        name.contains('/') ||
        name.contains('\\') ||
        name.contains('\u0000')) {
      throw StoreException(StoreException.Kind.BAD_ADDRESS, "invalid peer address")
    }
    return "$name.${address.deviceId}"
  }

  /**
   * `null` ONLY when the file is genuinely absent. Every other I/O failure
   * throws — see the fail-closed note in the class doc.
   */
  private fun readOrNull(file: File): ByteArray? =
      try {
        Files.readAllBytes(file.toPath())
      } catch (absent: NoSuchFileException) {
        null
      } catch (err: IOException) {
        throw StoreException(StoreException.Kind.IO, "protocol store read failed")
      }

  /** The same fail direction for existence: an error is an error, never a
   * "no" — `File.isFile` folds both into `false`. */
  private fun existsOrThrow(file: File): Boolean =
      try {
        Files.readAttributes(file.toPath(), BasicFileAttributes::class.java)
        true
      } catch (absent: NoSuchFileException) {
        false
      } catch (err: IOException) {
        throw StoreException(StoreException.Kind.IO, "protocol store read failed")
      }

  /** Atomic write-rename: a reader sees the old record or the new one, never
   * a prefix. A torn session record is an unrecoverable ratchet. */
  private fun writeAtomic(target: File, bytes: ByteArray) {
    try {
      AtomicFiles.write(target, File(target.parentFile, "${target.name}.tmp"), bytes)
    } catch (err: IOException) {
      throw StoreException(StoreException.Kind.IO, "protocol store write failed")
    }
  }
}
