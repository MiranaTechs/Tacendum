package com.miranatechnologies.tacendum.push

/**
 * What one FCM data message may become.
 *
 * THE WAKE CARRIES NO WORDS, and this file is where that is enforced: the
 * router reads exactly four keys — `kind`, `fromUser`, `to`, `msgId` — and every
 * other byte of the payload ceases to exist here. No preview, no ciphertext,
 * no display text can arrive by push, because nothing downstream is ever
 * handed the map. The server agrees from its side
 * (packages/server/src/push/fcm.ts: the FCM message is "data-only routing
 * facts"; the APNs alert arm ships ciphertext because iOS has an extension to
 * decrypt it — Android's extension-role handler runs in the app, which drains
 * the real envelope over its own socket).
 *
 * The wire shape, pinned against the server's two send lanes
 * (fcm.ts `sendCallWake` / `sendMessageWake`):
 * data-only, HIGH priority, all values strings, TTL 45 s for a
 * call and a day for a message —
 *
 *   call wake:     { kind: "call",    fromUser, to, ts }
 *   message wake:  { kind: "message", fromUser, ts, msgId, msgType }
 *
 * `fromUser`, NOT `from`: `from` is one of FCM's RESERVED data-payload keys,
 * and Google refuses the entire send — 400 INVALID_ARGUMENT, "Invalid data
 * payload key: from", measured against the live API the first time a wired
 * build existed. The shape both sides had originally pinned
 * could therefore never have delivered; both sides renamed the key in the
 * same change, and this constant is the app's half of that agreement.
 *
 * `ts` and `msgType` are deliberately unread: the drain re-fetches the real
 * envelope, so routing facts beyond "which lane, who, which banner identity"
 * have no consumer on this side.
 *
 * A wake this build cannot name is IGNORED — no banner, no ring. That is
 * iOS's own posture for an unreadable payload ("badges nothing and previews
 * nothing"), minus the server-composed fallback banner APNs displays, which
 * a data-only message does not have.
 */
internal sealed interface PushWake {
  /** Ring NOW, under a synthetic cid, before anything decrypts. */
  data class CallRing(val cid: String, val from: String, val to: String) : PushWake

  /** One message is queued; announce it through the NSE-role handler. */
  data class Message(val from: String, val msgId: String) : PushWake

  /** Unknown kind, missing identity — show less, which is nothing. */
  object Ignored : PushWake
}

internal object PushWakeRouter {

  const val KEY_KIND = "kind"
  const val KIND_CALL = "call"
  const val KIND_MESSAGE = "message"
  const val KEY_FROM = "fromUser"
  const val KEY_TO = "to"
  const val KEY_MSG_ID = "msgId"

  /**
   * `mintCid` is the synthetic-cid mint (the service passes a UUID, iOS's
   * exact fallback in CallKitCenter.swift): the wake carries no cid — the
   * real one is inside ciphertext the push does not have — so the ring goes
   * up under a throwaway that `reportIncomingCall` later rebinds.
   */
  fun route(data: Map<String, String>, mintCid: () -> String): PushWake =
      when (data[KEY_KIND]) {
        KIND_CALL -> {
          val to = data[KEY_TO].orEmpty()
          if (to.isEmpty()) {
            PushWake.Ignored
          } else {
            // An empty `from` still rings — the placeholder says "Incoming
            // call", which is iOS's behaviour for the same payload — but it
            // cannot pass the blocked-caller gate as anyone, because it names
            // no one.
            PushWake.CallRing(cid = mintCid(), from = data[KEY_FROM].orEmpty(), to = to)
          }
        }
        KIND_MESSAGE -> {
          val from = data[KEY_FROM].orEmpty()
          val msgId = data[KEY_MSG_ID].orEmpty()
          if (from.isEmpty() || msgId.isEmpty()) {
            // No sender to gate on, or no identity for the banner to replace
            // itself under on redelivery: the same refusal
            // TacendumMessagingModule.notifyMessage makes for the same holes.
            PushWake.Ignored
          } else {
            PushWake.Message(from = from, msgId = msgId)
          }
        }
        else -> PushWake.Ignored
      }
}
