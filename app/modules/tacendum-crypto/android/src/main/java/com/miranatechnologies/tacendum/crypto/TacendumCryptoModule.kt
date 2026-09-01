package com.miranatechnologies.tacendum.crypto

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.UntrustedIdentityException
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.fingerprint.NumericFingerprintGenerator
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.message.CiphertextMessage
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.svr2.PinHash

/**
 * A refusal this module authored, as opposed to one libsignal or the JVM
 * raised. Its message is a CONSTANT written here — it names a rule, never a
 * key, a file, or a byte — which is why it is the one class
 * of error whose text is allowed to cross the bridge. Everything else rejects
 * with the calling method's constant fallback, because a third party's
 * exception text is not something this side gets to vouch for.
 */
internal class BadInput(message: String) : RuntimeException(message)

/**
 * The Android crypto module.
 *
 * Three parties perform cryptography here and no others:
 * **libsignal** (identity, sessions, envelopes, attachment blobs via
 * [BlobCipher], and the `PinHash` Argon2 KDF), **the platform**
 * (`java.security.SecureRandom`, the `AndroidKeyStore` behind [SecretStore],
 * and `MessageDigest.getInstance("SHA-256")` — sanctioned SOLELY for the group
 * roster digest `rd`), and nothing else. This class itself performs no cipher
 * work: sealing and unsealing live behind [SecretStore] and [BlobCipher].
 *
 * THE REJECTION-CODE CONTRACT (`app/src/messaging.ts` branches
 * on it, so a different mapping silently poisons redeliverable messages):
 *
 * | code               | when                                   | JS behavior                                     |
 * |--------------------|----------------------------------------|-------------------------------------------------|
 * | `identity_changed` | libsignal refuses a changed peer key   | block-and-warn; never a poison row              |
 * | `store_busy`       | store lock timeout                     | NO error row, NO seen, NO ack — await redelivery |
 * | `crypto_error`     | everything else                        | tamper/poison on decrypt paths                   |
 *
 * `store_busy` is preserved and never produced on Android v1: there is no
 * second process and no store lock. It stays in the mapper because the
 * JS branch is the contract, not the lock.
 *
 * THREADING. Every Promise method is marshalled onto ONE process-global serial
 * executor — the analogue of the iOS `com.tacendum.crypto` dispatch queue, and
 * process-global for the same reason: a per-instance executor would let blocks
 * from a Metro-reloaded old instance race a new one over the same on-disk
 * store. `prepareDatabaseDirectory` is the one synchronous method and stays
 * OFF the executor, on the JS thread, because `db.ts conn()` is synchronous
 * and the directory must exist before op-sqlite opens the path.
 *
 * Rejection messages are constants — never interpolated, never naming a key, a
 * file, or a byte (an error naming the decoy proves the decoy
 * is armed).
 */
class TacendumCryptoModule(reactContext: ReactApplicationContext) :
    NativeTacendumCryptoSpec(reactContext) {

  private val filesDir: File
    get() = reactApplicationContext.filesDir

  /** One store, lazily opened; a failed open is retried on the next call
   * rather than latched (pre-first-unlock must heal into a working store). */
  private var secretStore: SecretStore? = null
  private val storeLock = Any()

  private fun store(): SecretStore =
      synchronized(storeLock) {
        secretStore ?: SecretStore.open(File(filesDir, SECRETS_DIR)).also { secretStore = it }
      }

  private fun protocolStore(): ProtocolStore = ProtocolStore(File(filesDir, PROTOCOL_DIR))

  // --- boot path ---

  override fun hasIdentity(promise: Promise) =
      onQueue(promise, "identity check failed") {
        // FAIL-CLOSED: an error must never read as "no identity" — a
        // false here re-registers and permanently abandons the account. Note
        // the bare file check: no store construction, no directory creation.
        IdentityFile.hasIdentity(File(filesDir, PROTOCOL_DIR))
      }

  override fun prepareDatabaseDirectory(fileName: String): String {
    // Name rule: non-empty, <=64, no '/', no '..'. Errors are
    // GENERIC and name no files (naming the decoy would
    // prove the decoy is armed).
    if (fileName.isEmpty() || fileName.length > 64 ||
        fileName.contains("/") || fileName.contains("..")) {
      return errorJson("invalid database file name")
    }
    val dir = File(filesDir, DB_DIR)
    if (!dir.isDirectory && !dir.mkdirs()) {
      return errorJson("database directory unavailable")
    }
    // Greenfield platform: no legacy layout, migration is a no-op.
    // excluded:true by construction — the harvested backup rules XML
    // excludes every domain (data_extraction_rules.xml / backup_rules.xml).
    val out = JSONObject()
    out.put("location", dir.absolutePath)
    out.put("excluded", true)
    return out.toString()
  }

  // --- key management ---

  override fun generateAndStoreKeys(promise: Promise) =
      onQueue(promise, "key generation failed") {
        val stores = protocolStore()
        val identity = IdentityKeyPair.generate()
        // 14-bit registration id, 1..16383 — the Signal convention, and the
        // range the server DTO validates. Modulo bias is irrelevant: this is
        // an id, not key material.
        val registrationId = RNG.nextInt(REGISTRATION_ID_UPPER_EXCLUSIVE) + 1
        stores.initializeIdentity(identity, registrationId)

        val now = System.currentTimeMillis()

        // Signed (EC) prekey: the signature is over the SERIALIZED PUBLIC KEY,
        // by the identity private key — libsignal's own primitive.
        val spk = ECKeyPair.generate()
        val spkSignature = identity.privateKey.calculateSignature(spk.publicKey.serialize())
        stores.storeSignedPreKey(
            SIGNED_PRE_KEY_ID,
            SignedPreKeyRecord(SIGNED_PRE_KEY_ID, now, spk, spkSignature),
        )

        // Signed LAST-RESORT Kyber prekey (PQXDH). One key, id 1, reusable —
        // which is why `markKyberPreKeyUsed` is a no-op in the store.
        val kyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
        val kyberSignature = identity.privateKey.calculateSignature(kyber.publicKey.serialize())
        stores.storeKyberPreKey(
            KYBER_PRE_KEY_ID,
            KyberPreKeyRecord(KYBER_PRE_KEY_ID, now, kyber, kyberSignature),
        )

        val oneTime = JSONArray()
        for (id in 1..ONE_TIME_PREKEY_COUNT) {
          val pair = ECKeyPair.generate()
          stores.storePreKey(id, PreKeyRecord(id, pair))
          oneTime.put(oneTimePrekeyJson(id, pair.publicKey))
        }

        uploadKeysJson(
                registrationId = registrationId,
                identityKey = identity.publicKey.serialize(),
                spkPub = spk.publicKey.serialize(),
                spkSig = spkSignature,
                kyberPub = kyber.publicKey.serialize(),
                kyberSig = kyberSignature,
                oneTimePrekeys = oneTime,
            )
            .toString()
      }

  override fun existingKeysForUpload(promise: Promise) =
      onQueue(promise, "key rebuild failed") {
        val stores = protocolStore()
        val identity = stores.getIdentityKeyPair()
        val registrationId = stores.getLocalRegistrationId()
        val spk = stores.loadSignedPreKey(SIGNED_PRE_KEY_ID)
        val kyber = stores.loadKyberPreKey(KYBER_PRE_KEY_ID)

        // FRESH one-time prekeys, at ids the store has NEVER used — never a
        // re-advertisement of the survivors. The server consumes a prekey when
        // a PEER FETCHES the bundle, but this phone deletes the private half
        // only when the resulting prekey MESSAGE arrives, so a
        // fetched-but-unused key is still on disk here; re-uploading it hands
        // the same prekey to a second peer and whichever ciphertext lands
        // second is undecryptable forever. New ids, old records kept: in-flight
        // ciphertext still finds its private half. Nothing is rotated — the
        // identity IS the account, and the signed and kyber prekeys are
        // re-advertised from their stored records, signatures included.
        val nextId = (stores.existingPreKeyIds().maxOrNull() ?: 0) + 1
        val oneTime = JSONArray()
        for (id in nextId until nextId + ONE_TIME_PREKEY_COUNT) {
          val pair = ECKeyPair.generate()
          stores.storePreKey(id, PreKeyRecord(id, pair))
          oneTime.put(oneTimePrekeyJson(id, pair.publicKey))
        }

        uploadKeysJson(
                registrationId = registrationId,
                identityKey = identity.publicKey.serialize(),
                spkPub = spk.keyPair.publicKey.serialize(),
                spkSig = spk.signature,
                kyberPub = kyber.keyPair.publicKey.serialize(),
                kyberSig = kyber.signature,
                oneTimePrekeys = oneTime,
            )
            .toString()
      }

  // --- account authentication ---

  override fun signAuthChallenge(challengeB64: String, apiOrigin: String, promise: Promise) =
      onQueue(promise, "challenge signing failed") {
        val challenge = Codec.unb64(challengeB64)
        // The origin arrives ALREADY NORMALIZED from the facade
        // (`normalizeOrigin`); it is appended verbatim, because exactly one
        // place decides which server this install talks to and it is not here.
        val message = AuthChallenge.signedBytes(challenge, apiOrigin)
        val stores = protocolStore()
        if (!stores.hasIdentity()) {
          // Signing before keys exist is a caller-ordering bug: keypair
          // accounts generate the identity FIRST and authenticate second.
          throw AuthChallenge.BadInput("no identity to sign with; generate keys first")
        }
        Codec.b64(stores.getIdentityKeyPair().privateKey.calculateSignature(message))
      }

  override fun signLinkOp(
      op: String,
      groupId: String,
      offererUserId: String,
      acceptorUserId: String,
      subjectIdentityPubKeyB64: String,
      deviceClass: String,
      rosterEpoch: String,
      offerNonce: String,
      expiresAt: String,
      promise: Promise,
  ) =
      onQueue(promise, "link-op signing failed") {
        // Byte assembly lives in LinkOp (crypto-free, host-tested against
        // packages/shared/linkvectors.json); the signature is the same
        // libsignal primitive that signs the auth challenge. The integers
        // arrive as ASCII decimal from the TypeScript facade and are appended
        // verbatim — one place decides formatting, and it is not here.
        val message =
            LinkOp.signedBytes(
                op,
                groupId,
                offererUserId,
                acceptorUserId,
                Codec.unb64(subjectIdentityPubKeyB64),
                deviceClass,
                rosterEpoch,
                offerNonce,
                expiresAt,
            )
        val stores = protocolStore()
        if (!stores.hasIdentity()) {
          // Signing before keys exist is a caller-ordering bug: keypair
          // accounts generate the identity FIRST and sign with it second.
          throw LinkOp.BadInput("no identity to sign with; generate keys first")
        }
        Codec.b64(stores.getIdentityKeyPair().privateKey.calculateSignature(message))
      }

  override fun verifyLinkOp(
      identityPubKeyB64: String,
      op: String,
      groupId: String,
      offererUserId: String,
      acceptorUserId: String,
      subjectIdentityPubKeyB64: String,
      deviceClass: String,
      rosterEpoch: String,
      offerNonce: String,
      expiresAt: String,
      signatureB64: String,
      promise: Promise,
  ) =
      onQueue(promise, "link-op verify failed") {
        // The SAME byte assembly the signer uses (LinkOp.signedBytes — one
        // builder, host-tested against packages/shared/linkvectors.json), so
        // sign and verify cannot drift; the verify is libsignal's
        // ECPublicKey.verifySignature — the verify half of the identity
        // primitive already in use. A
        // malformed key or signature answers FALSE, the server-verify
        // contract: a bad certificate is indistinguishable from a wrong one.
        val message =
            LinkOp.signedBytes(
                op,
                groupId,
                offererUserId,
                acceptorUserId,
                Codec.unb64(subjectIdentityPubKeyB64),
                deviceClass,
                rosterEpoch,
                offerNonce,
                expiresAt,
            )
        try {
          ECPublicKey(Codec.unb64(identityPubKeyB64))
              .verifySignature(message, Codec.unb64(signatureB64))
        } catch (_: Exception) {
          false
        }
      }

  override fun identityPublicKey(promise: Promise) =
      onQueue(promise, "identity read failed") {
        val stores = protocolStore()
        // '' when there is no identity — the facade maps it to null, matching
        // how getSecret reports absence, so the caller branches on a value
        // rather than catching.
        if (!stores.hasIdentity()) "" else Codec.b64(stores.getIdentityKeyPair().publicKey.serialize())
      }

  // --- sessions / messaging ---

  override fun processPreKeyBundle(bundleJson: String, selfUserId: String, promise: Promise) =
      onQueue(promise, "prekey bundle rejected") {
        val dto = JSONObject(bundleJson)
        val signed = dto.getJSONObject("signedPrekey")
        val kyber = dto.getJSONObject("kyberPrekey")
        val oneTime = dto.optJSONObject("oneTimePrekey")

        val identityKey = IdentityKey(Codec.unb64(dto.getString("identityKey")))
        val signedPub = ECPublicKey(Codec.unb64(signed.getString("pub")))
        val signedSig = Codec.unb64(signed.getString("sig"))
        val kyberPub = KEMPublicKey(Codec.unb64(kyber.getString("pub")))
        val kyberSig = Codec.unb64(kyber.getString("sig"))

        // Kyber is ALWAYS present — PQXDH is not optional on this wire. The
        // one-time prekey is: an empty pool yields a signed+kyber bundle, and
        // NULL_PRE_KEY_ID is how the binding spells "none".
        val bundle =
            PreKeyBundle(
                dto.getInt("registrationId"),
                DEVICE_ID,
                if (oneTime != null) oneTime.getInt("keyId") else PreKeyBundle.NULL_PRE_KEY_ID,
                if (oneTime != null) ECPublicKey(Codec.unb64(oneTime.getString("pub"))) else null,
                signed.getInt("keyId"),
                signedPub,
                signedSig,
                identityKey,
                kyber.getInt("keyId"),
                kyberPub,
                kyberSig,
            )

        val stores = protocolStore()
        // NOTE THE ORDER: SessionBuilder takes (remote, local) and
        // SessionCipher takes (local, remote). They are opposite, and getting
        // it wrong builds a session against the wrong address.
        SessionBuilder(
                stores,
                stores,
                stores,
                stores,
                address(dto.getString("userId")),
                address(selfUserId),
            )
            .process(bundle)
        null
      }

  override fun hasSession(peerUserId: String, promise: Promise) =
      onQueue(promise, "session check failed") {
        protocolStore().loadSession(address(peerUserId)) != null
      }

  override fun safetyNumber(selfUserId: String, peerUserId: String, promise: Promise) =
      onQueue(promise, "safety number failed") {
        val stores = protocolStore()
        val peerIdentity = stores.getIdentity(address(peerUserId))
        if (peerIdentity == null) {
          // '' when the peer identity is not yet TOFU-pinned (facade -> null).
          ""
        } else {
          // 5200 iterations, version 0 — MUST match the CLI and iOS or the
          // same pair reads a different number on each client.
          NumericFingerprintGenerator(SAFETY_ITERATIONS)
              .createFor(
                  SAFETY_VERSION,
                  selfUserId.toByteArray(Charsets.UTF_8),
                  stores.getIdentityKeyPair().publicKey,
                  peerUserId.toByteArray(Charsets.UTF_8),
                  peerIdentity,
              )
              .displayableFingerprint
              .displayText
        }
      }

  override fun resetPeer(peerUserId: String, promise: Promise) =
      onQueue(promise, "peer reset failed") {
        protocolStore().clearPeer(address(peerUserId))
        null
      }

  override fun encryptText(
      selfUserId: String,
      peerUserId: String,
      plaintext: String,
      promise: Promise,
  ) =
      onQueue(promise, "encrypt failed") {
        val stores = protocolStore()
        val ciphertext =
            SessionCipher(
                    stores,
                    stores,
                    stores,
                    stores,
                    stores,
                    address(selfUserId),
                    address(peerUserId),
                )
                .encrypt(plaintext.toByteArray(Charsets.UTF_8))
        val out = JSONObject()
        out.put(
            "msgType",
            if (ciphertext.type == CiphertextMessage.PREKEY_TYPE) "prekey" else "ciphertext",
        )
        out.put("payload", Codec.b64(ciphertext.serialize()))
        out.toString()
      }

  override fun decryptEnvelope(
      selfUserId: String,
      senderUserId: String,
      msgType: String,
      payloadB64: String,
      promise: Promise,
  ) =
      onQueue(promise, "decrypt failed") {
        val stores = protocolStore()
        val payload = Codec.unb64(payloadB64)
        val cipher =
            SessionCipher(
                stores,
                stores,
                stores,
                stores,
                stores,
                address(selfUserId),
                address(senderUserId),
            )
        val plaintext =
            when (msgType) {
              "prekey" -> cipher.decrypt(PreKeySignalMessage(payload))
              "ciphertext" -> cipher.decrypt(SignalMessage(payload))
              else -> throw BadInput("unknown msgType")
            }
        // Must be valid UTF-8; anything else is corruption, not a message.
        val text = String(plaintext, Charsets.UTF_8)
        if (!text.toByteArray(Charsets.UTF_8).contentEquals(plaintext)) {
          throw BadInput("plaintext is not valid UTF-8")
        }
        text
      }

  // --- attachment blobs ---

  override fun blobEncrypt(plaintextB64: String, promise: Promise) =
      onQueue(promise, "blob encrypt failed") {
        // Empty plaintext is VALID and load-bearing: the `empty` vector in
        // packages/shared/blobvectors.json is a legal 28-byte blob.
        val sealed = BlobCipher.seal(Codec.unb64(plaintextB64))
        val out = JSONObject()
        out.put("keyB64", Codec.b64(sealed.key))
        out.put("blobB64", Codec.b64(sealed.blob))
        out.toString()
      }

  override fun blobDecrypt(keyB64: String, blobB64: String, promise: Promise) =
      onQueue(promise, "blob decrypt failed") {
        // Returns plaintext BASE64 — unlike decryptEnvelope, which returns
        // UTF-8 text. Attachment bytes are not text.
        Codec.b64(BlobCipher.open(Codec.unb64(keyB64), Codec.unb64(blobB64)))
      }

  // --- registration lock ---

  override fun pinVerifier(pin: String, saltB64: String, promise: Promise) =
      onQueue(promise, "pin verifier failed") {
        val salt = Codec.unb64(saltB64)
        if (salt.size != PIN_SALT_BYTES) {
          throw BadInput("pinVerifier salt must be 32 base64-encoded bytes")
        }
        // NFKC, matching Swift's `precomposedStringWithCompatibilityMapping`,
        // so a PIN typed on a different keyboard still matches. There is no
        // other detector for a normalization divergence — it would break
        // registration-lock verification silently, on real accounts — which is
        // why packages/shared/pinvectors.json was minted from the shipped iOS
        // build before this line existed.
        val normalized = Normalizer.normalize(pin, Normalizer.Form.NFKC)
        val pinBytes = normalized.toByteArray(Charsets.UTF_8)
        if (pinBytes.isEmpty()) {
          throw BadInput("pinVerifier pin must be non-empty UTF-8")
        }
        // `accessKey`, not `encryptionKey`: the access key is the secret that
        // proves entitlement to a stored value, which is what verify checks.
        // Argon2 underneath — deliberately slow; never on a render path.
        // Neither the PIN nor the result is ever logged.
        Codec.b64(PinHash.svr1(pinBytes, salt).accessKey())
      }

  // --- secret store ---

  override fun getSecret(key: String, promise: Promise) =
      onQueue(promise, "secret read failed") {
        if (!Names.isValidSecretKey(key)) {
          throw BadInput("invalid secret key")
        }
        // '' when absent (the facade maps it to null); a PRESENT value that
        // cannot be read or unsealed rejects instead — fail-closed, and a
        // clean rejection rather than a crash pre-first-unlock (reauth.ts
        // currentToken catches to null).
        store().get(key)
      }

  override fun setSecret(key: String, value: String, promise: Promise) =
      onQueue(promise, "secret write failed") {
        if (!Names.isValidSecretKey(key)) {
          throw BadInput("invalid secret key")
        }
        store().set(key, value)
        null
      }

  override fun deleteSecret(key: String, promise: Promise) =
      onQueue(promise, "secret delete failed") {
        if (!Names.isValidSecretKey(key)) {
          throw BadInput("invalid secret key")
        }
        // Delete-of-absent is success (the relock/duress paths delete blind).
        store().delete(key)
        null
      }

  // --- shared state ---

  override fun writeSharedState(name: String, value: String, promise: Promise) =
      onQueue(promise, "shared state write failed") {
        if (!Names.isValidSharedStateName(name)) {
          throw BadInput("invalid shared state name")
        }
        val dir = File(filesDir, SHARED_STATE_DIR)
        if (!dir.isDirectory && !dir.mkdirs()) {
          throw IOException("shared state directory unavailable")
        }
        // The temp sibling's '.' suffix can never be read back through this
        // API: the shared-state alphabet has no '.', so "<name>.tmp" is not
        // a valid name (Names.isValidSharedStateName).
        AtomicFiles.write(
            File(dir, name),
            File(dir, "$name.tmp"),
            value.toByteArray(Charsets.UTF_8),
        )
        null
      }

  override fun readSharedState(name: String, promise: Promise) =
      onQueue(promise, "shared state read failed") {
        if (!Names.isValidSharedStateName(name)) {
          throw BadInput("invalid shared state name")
        }
        // Absence is a state, not an error: a missing file resolves as ''.
        val file = File(File(filesDir, SHARED_STATE_DIR), name)
        if (!file.isFile) "" else file.readText(Charsets.UTF_8)
      }

  override fun deleteSharedState(name: String, promise: Promise) =
      onQueue(promise, "shared state delete failed") {
        if (!Names.isValidSharedStateName(name)) {
          throw BadInput("invalid shared state name")
        }
        val file = File(File(filesDir, SHARED_STATE_DIR), name)
        // Delete-of-absent is success: "delete to disarm" means absence is
        // the goal state, not a precondition.
        if (file.isFile && !file.delete()) {
          throw IOException("shared state delete failed")
        }
        null
      }

  // --- inbox spool (the writer is the NSE-role background handler) ---

  override fun readInbox(promise: Promise) =
      onQueue(promise, "inbox read failed") {
        val dir = File(filesDir, INBOX_DIR)
        val entries = JSONArray()
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
        if (files != null) {
          files.sortBy { it.name }
          for (file in files) {
            // Unparseable files are skipped, never fatal: the launch path
            // must not be blocked (iOS contract, Impl:1033-1038).
            try {
              entries.put(JSONObject(file.readText(Charsets.UTF_8)))
            } catch (skipped: Exception) {
              // skip
            }
          }
        }
        entries.toString()
      }

  override fun clearInboxEntry(msgId: String, promise: Promise) =
      onQueue(promise, "inbox clear failed") {
        // The msgId guard is the path-traversal fence: the id becomes a file
        // name beside directories that hold protocol state.
        if (!Names.isValidInboxMsgId(msgId)) {
          throw BadInput("invalid inbox entry id")
        }
        val file = File(File(filesDir, INBOX_DIR), "$msgId.json")
        // Delete-of-absent is success — a redelivered clear must not fail
        // the durable-commit loop that calls it.
        if (file.isFile && !file.delete()) {
          throw IOException("inbox clear failed")
        }
        null
      }

  // --- platform RNG + digest ---

  override fun randomBytes(count: Double, promise: Promise) =
      onQueue(promise, "random bytes failed") {
        val n = count.toInt()
        // 0 < count <= 4096, integral (mirrors the iOS Impl).
        if (count != n.toDouble() || n <= 0 || n > RANDOM_BYTES_MAX) {
          throw BadInput("invalid byte count")
        }
        val bytes = ByteArray(n)
        RNG.nextBytes(bytes)
        Codec.b64(bytes)
      }

  override fun sha256(dataB64: String, promise: Promise) =
      onQueue(promise, "digest failed") {
        val data = Codec.unb64(dataB64)
        // The platform digest, sanctioned
        // SOLELY for the group roster digest `rd`. Empty input is VALID —
        // a FIPS 180-4 known-answer vector.
        Codec.b64(MessageDigest.getInstance("SHA-256").digest(data))
      }

  // --- dev/testing ---

  override fun resetProtocolState(promise: Promise) =
      onQueue(promise, "protocol state reset failed") {
        // Single root on Android — greenfield, no legacy layout and no
        // migration staging dir — with the iOS "make it
        // gone, best-effort, all roots" shape kept: attempt everything,
        // fail only after attempting all. Secrets are cleared by the caller
        // via deleteSecret, not here (the iOS contract).
        val roots = listOf(File(filesDir, PROTOCOL_DIR))
        var failed = false
        for (root in roots) {
          if (root.exists() && !root.deleteRecursively()) failed = true
        }
        if (failed) {
          throw IOException("protocol state reset failed")
        }
        null
      }

  // --- plumbing ---

  private fun address(userId: String) = SignalProtocolAddress(userId, DEVICE_ID)

  /**
   * Run [body] on the module's serial executor and settle [promise] with its
   * value, mapping any failure onto the three-code contract in the class doc.
   *
   * `fallback` is a CONSTANT per call site, and every message JS can ever see
   * is one this file wrote: either that fallback, or — for a [BadInput], the
   * refusals this module itself raises — the constant the guard carries, so a
   * caller learns which rule it broke. A THIRD PARTY'S exception text never
   * crosses: libsignal's may name key ids and lengths, and all of it stays
   * on this side of the bridge. The throwable still rides along for the
   * native stack, which does not reach the JS message.
   */
  private fun onQueue(promise: Promise, fallback: String, body: () -> Any?) {
    QUEUE.execute {
      try {
        promise.resolve(body())
      } catch (err: Throwable) {
        when {
          err is UntrustedIdentityException || err.cause is UntrustedIdentityException ->
              // A changed-identity refusal is DISTINCT from tamper so the UI
              // can block-and-warn instead of writing a poison row.
              promise.reject("identity_changed", "identity_changed", err)
          err is BadInput || err is AuthChallenge.BadInput ->
              // OUR refusal, with a message this file authored: a caller that
              // passed an invalid name, count, salt or msgType gets told which
              // rule it broke. Still `crypto_error` — the code is the contract,
              // and only the three codes exist.
              promise.reject("crypto_error", err.message ?: fallback, err)
          isStoreBusy(err) ->
              // Unreachable on Android v1 (single process, no store
              // lock). Kept because the JS branch — retry, do not poison — is
              // the contract, and it must survive whatever the store becomes.
              promise.reject("store_busy", "store_busy: protocol store is busy", err)
          else -> promise.reject("crypto_error", fallback, err)
        }
      }
    }
  }

  private fun isStoreBusy(err: Throwable): Boolean =
      err is StoreBusyException || err.cause is StoreBusyException

  /** The store-lock timeout this platform cannot currently raise. It is
   * declared so the mapper's `store_busy` arm is a real branch rather than
   * dead prose, and so a future second process has the type to throw. */
  internal class StoreBusyException(message: String) : RuntimeException(message)

  private fun oneTimePrekeyJson(id: Int, pub: ECPublicKey): JSONObject {
    val out = JSONObject()
    out.put("keyId", id)
    out.put("pub", Codec.b64(pub.serialize()))
    return out
  }

  /** The PUT /v1/keys shape (`UploadKeysDTO`, packages/shared). The facade
   * zod-parses this, so a field-name drift fails loudly at the boundary. */
  private fun uploadKeysJson(
      registrationId: Int,
      identityKey: ByteArray,
      spkPub: ByteArray,
      spkSig: ByteArray,
      kyberPub: ByteArray,
      kyberSig: ByteArray,
      oneTimePrekeys: JSONArray,
  ): JSONObject {
    val signed = JSONObject()
    signed.put("keyId", SIGNED_PRE_KEY_ID)
    signed.put("pub", Codec.b64(spkPub))
    signed.put("sig", Codec.b64(spkSig))
    val kyber = JSONObject()
    kyber.put("keyId", KYBER_PRE_KEY_ID)
    kyber.put("pub", Codec.b64(kyberPub))
    kyber.put("sig", Codec.b64(kyberSig))
    val out = JSONObject()
    out.put("registrationId", registrationId)
    out.put("identityKey", Codec.b64(identityKey))
    out.put("signedPrekey", signed)
    out.put("kyberPrekey", kyber)
    out.put("oneTimePrekeys", oneTimePrekeys)
    return out
  }

  private fun errorJson(reason: String): String {
    val out = JSONObject()
    out.put("error", reason)
    return out.toString()
  }

  companion object {
    // Directory names mirror the iOS store layout;
    // all under filesDir, all excluded from backup by the app's rules XML.
    private const val PROTOCOL_DIR = "tacendum-protocol"
    private const val SHARED_STATE_DIR = "tacendum-shared"
    private const val INBOX_DIR = "inbox"
    private const val SECRETS_DIR = "tacendum-secrets"
    // Neutral name — must not reveal decoy presence.
    private const val DB_DIR = "tacendum-db"

    private const val RANDOM_BYTES_MAX = 4096

    // The cross-platform constants that must not drift.
    // Every one of these is a wire agreement with the server, the
    // CLI and the iOS build — not a local choice.
    internal const val DEVICE_ID = 1
    internal const val SIGNED_PRE_KEY_ID = 1
    internal const val KYBER_PRE_KEY_ID = 1
    internal const val ONE_TIME_PREKEY_COUNT = 100
    internal const val REGISTRATION_ID_UPPER_EXCLUSIVE = 16383
    internal const val SAFETY_ITERATIONS = 5200
    internal const val SAFETY_VERSION = 0
    internal const val PIN_SALT_BYTES = 32

    /** One platform CSPRNG for the module. */
    private val RNG = SecureRandom()

    /**
     * ONE serial executor for the whole process, not one per instance: a
     * Metro reload builds a new module instance over the SAME on-disk store,
     * and a per-instance queue would let the old instance's blocks race the
     * new one's. Daemon threads so the executor never holds up process exit.
     */
    private val QUEUE =
        Executors.newSingleThreadExecutor { runnable ->
          Thread(runnable, "com.tacendum.crypto").apply { isDaemon = true }
        }
  }
}
