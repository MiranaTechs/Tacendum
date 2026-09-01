package com.miranatechnologies.tacendum.messaging

import android.content.Context
import java.util.UUID
import org.json.JSONObject

/**
 * What a notification is allowed to say — the Kotlin half of
 * app/ios/TacendumNSE/PreviewPolicy.swift, which is the correctness oracle for
 * every rule below.
 *
 * The iOS extension decides this BEFORE decrypting, because deciding after
 * would consume a ratchet key the app still needs. Android's handler runs
 * in-process (the websocket, not a push, is the delivery path), so the
 * decrypt has already happened inside the app that owns the ratchet — the
 * ordering property iOS needs is not available here and is not needed here.
 * What IS the same, exactly, is the permission model: the lease, the level,
 * the block mirror, and the two name mirrors, each read from the same file
 * with the same fail-closed reading.
 *
 * **Everything fails closed.** A missing file, an unreadable container, a
 * value from a newer build: all of them mean "show nothing". A banner is
 * rendered on a screen somebody else may be looking at, so the only safe
 * answer to "I do not know what I may reveal" is nothing.
 *
 * Nothing here logs. Every value it handles is a name, an id, or the state of
 * the duress lease, and none of it may reach a log.
 */
internal object PreviewPolicy {

  enum class Level {
    FULL,
    SENDER,
    NONE,
  }

  private const val ARMED_FILE = "previews-armed"
  private const val LEVEL_FILE = "preview-level"
  private const val SELF_ID_FILE = "self-user-id"
  private const val BLOCKED_FILE = "blocked-peers"
  private const val PEER_NAMES_FILE = "peer-names"
  private const val GROUP_NAMES_FILE = "group-names"
  private const val WITNESS_FILE = "previews-witness"

  /**
   * The clock-rollback bound, from PreviewPolicy.swift: a deadline further out
   * than any renewal could have written it (the lease is seven days,
   * app/src/previews.ts PREVIEW_LEASE_MS) is not a lease — it is a clock that
   * moved backwards after the write, and honouring it would stay armed for
   * however far the clock had drifted.
   */
  private const val PLAUSIBLE_MS = 8L * 24 * 60 * 60 * 1000

  /**
   * The marker is a LEASE — `{"v":1,"deadline":<ms>}` — not a flag, and the
   * reason is written down in previews.ts: a flag can only be revoked by a
   * write, and the moment revocation matters most is the moment writes may be
   * impossible. Anything that does not parse as a LIVE lease — a truncated
   * write, the disarm fallback's '0', an expired or implausible deadline —
   * reads as disarmed.
   */
  private fun leaseIsLive(text: String?): Boolean {
    if (text.isNullOrEmpty()) return false
    return try {
      val obj = JSONObject(text)
      if (obj.optInt("v", 0) != 1) return false
      if (!obj.has("deadline")) return false
      val deadline = obj.optDouble("deadline", Double.NaN)
      if (deadline.isNaN()) return false
      val now = System.currentTimeMillis().toDouble()
      now < deadline && deadline < now + PLAUSIBLE_MS
    } catch (unparseable: Exception) {
      false
    }
  }

  /** May this notification show anything beyond the generic body? */
  fun armed(context: Context): Boolean = leaseIsLive(SharedState.read(context, ARMED_FILE))

  /**
   * THE WRITE GATE: armed, and provably revocable.
   *
   * A container where the app's own disarm would fail is precisely the state
   * in which a stale marker must not be honoured — a permission that can never
   * be taken away must not be usable. So writability is PROVEN, by writing a
   * separate witness file and reading it back.
   *
   * THE WITNESS IS A SEPARATE FILE and the lease is app-owned; this side never
   * writes the lease. The iOS review found the hole that rule closes: rewriting
   * the lease to prove writability lets "read lease -> duress DELETES it ->
   * atomic write recreates it" undo the revocation through the very gate meant
   * to enforce it. And the lease must still be there AFTER the proof, which is
   * where that interleaving now lands: the delete wins.
   */
  fun armedAndWritable(context: Context): Boolean {
    if (!leaseIsLive(SharedState.read(context, ARMED_FILE))) return false
    val witness = UUID.randomUUID().toString()
    if (!SharedState.write(context, WITNESS_FILE, witness)) return false
    if (SharedState.read(context, WITNESS_FILE) != witness) return false
    return leaseIsLive(SharedState.read(context, ARMED_FILE))
  }

  /** NOT the app's default (`sender`): an unreadable preference here means
   * this side does not know what it may reveal, and the safe answer is
   * nothing. previews.ts records why the app's own fallback differs. */
  fun level(context: Context): Level =
      when (SharedState.read(context, LEVEL_FILE)) {
        "full" -> Level.FULL
        "sender" -> Level.SENDER
        else -> Level.NONE
      }

  /**
   * The id this device decrypts as, published when a real session opens and
   * retracted on relock and on duress (app/src/nse.ts).
   *
   * The Android handler does not need it to decrypt — the app decrypted
   * already — but it is kept as the second, independent gate iOS uses it as: a
   * relock that lands between the message arriving and the banner being
   * composed has retracted this file, and a retracted self-id means no
   * preview, whatever the lease says.
   */
  fun selfUserId(context: Context): String? =
      SharedState.read(context, SELF_ID_FILE)?.takeIf { it.isNotEmpty() }

  /**
   * Peers this device has blocked, mirrored out of the database by the app.
   *
   * A blocked sender can still put bytes on the wire — blocking is enforced on
   * receipt and is deliberately undetectable to them — so their message still
   * arrives. The app drops it from the conversation; without this mirror the
   * block would still be visibly incomplete in the one place it is most
   * conspicuous: a banner, from someone the owner blocked.
   */
  fun blocked(context: Context): Set<String> {
    val raw = SharedState.read(context, BLOCKED_FILE) ?: return emptySet()
    return raw.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
  }

  private fun nameFrom(context: Context, file: String, key: String): String? =
      try {
        val raw = SharedState.read(context, file)
        if (raw.isNullOrEmpty()) {
          null
        } else {
          JSONObject(raw).optString(key, "").takeIf { it.isNotEmpty() }
        }
      } catch (unparseable: Exception) {
        null
      }

  /** The app's mirror name for a peer — `PEER_NAMES_FILE` in app/src/nse.ts,
   * written under `personName`'s precedence and deleted on relock and on
   * duress. Never a byte of any payload. */
  fun peerName(context: Context, peerId: String): String? =
      nameFrom(context, PEER_NAMES_FILE, peerId)

  /** THE ONLY SOURCE A ROOM BANNER'S TITLE MAY HAVE. A
   * room the mirror cannot name shows the generic body rather than borrowing
   * a title from the sender, which would dress a room message as a 1:1. */
  fun groupName(context: Context, groupId: String): String? =
      nameFrom(context, GROUP_NAMES_FILE, groupId)

  /**
   * The banner's WHO: the mirror's name for the sender, else the app's own
   * shortId convention (app/src/person.ts) — the TAIL of the authenticated
   * id, never the full ULID.
   *
   * NotificationService.swift's `senderTitle`, character for character,
   * including the ellipsis: an account id is not sender-chosen display text,
   * and every app surface degrades to exactly this fragment for a peer who
   * shared no name.
   */
  fun senderTitle(context: Context, from: String): String {
    val name = peerName(context, from)
    if (name != null) return name
    return if (from.length <= 8) from else "…" + from.takeLast(8)
  }
}
