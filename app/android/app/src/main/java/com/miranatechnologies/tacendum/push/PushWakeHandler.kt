package com.miranatechnologies.tacendum.push

import android.content.Context
import com.miranatechnologies.tacendum.call.CallWake
import com.miranatechnologies.tacendum.call.PushTokenStore
import com.miranatechnologies.tacendum.messaging.MessageNotifier

/**
 * What a routed wake DOES — the thin executor between
 * `TacendumFcmService` (compiled only when Firebase is wired) and the two
 * machines that already exist. Kept separate from the service so the routing
 * and this dispatch stay in the always-compiled tree, where the unit tests
 * and every audit can see them whether or not `google-services.json` exists.
 *
 * **Message wake → the NSE-role handler, and NOT a second render path.**
 * `MessageNotifier.show` is the same function the socket-delivery path calls,
 * applying the same gates in the same order: the block mirror first, the
 * badge, the revocable previews lease, the published self-id, the level. The
 * one difference is the arguments a wake can honestly supply — `preview` is
 * `''` and `roomId` is `''`, because THE WAKE CARRIES NO WORDS and this
 * process may have no unlocked workspace to compute them from. What that
 * yields is exactly iOS's locked-workspace posture, arrived at by policy
 * rather than mechanism: with the lease disarmed or the self-id retracted
 * (which is what a locked workspace looks like in the shared-state files),
 * the banner is the generic "New message" over a counted badge; with the
 * lease armed, the banner names the sender and never the content, because
 * content only exists after the app's own socket drains the ciphertext —
 * showing less than iOS's `.full` decrypt, which is the permitted direction.
 * The banner is keyed on the wire msgId, so when the drained message reaches
 * the ordinary delivery path, its own `notifyMessage` REPLACES this banner
 * rather than stacking a second one.
 *
 * **Call wake → the pre-JS Telecom ring, the shape iOS PushKit takes.** The
 * ring goes up from native code under a synthetic cid before any JavaScript
 * loads; the blocked-caller gate, the never-overwrite-a-pending-ring rule,
 * the watchdog and the rebind all live behind `CallWake`'s one entry point.
 *
 * Runs on the FCM callback thread and stays there: `MessageNotifier` reads a
 * handful of small files and posts a notification, `CallWake` hands off to
 * Telecom — neither needs the main thread, and a call wake must not wait in
 * line behind anything.
 *
 * Nothing here logs: every value in reach is an opaque
 * id or a wake kind, and the audits that scan this tree hold it that way.
 */
internal object PushWakeHandler {

  /** `onNewToken`: persist first, then both events — via the store's
   * single listener seam, so the module emits and JS registers exactly as it
   * does on iOS. */
  fun newToken(context: Context, token: String) {
    PushTokenStore.adopt(context, token)
  }

  fun handle(context: Context, wake: PushWake) {
    when (wake) {
      is PushWake.CallRing -> CallWake.reportIncomingPlaceholder(context, wake.cid, wake.from)
      is PushWake.Message ->
          try {
            MessageNotifier.show(
                context,
                from = wake.from,
                msgId = wake.msgId,
                roomId = "",
                preview = "",
                structured = false,
            )
          } catch (failed: Exception) {
            // A banner is not worth crashing a push handler over — the
            // message itself is untouched on the server queue, and the next
            // app open drains it. notifyMessage's own catch, same reasoning.
          }
      PushWake.Ignored -> Unit
    }
  }
}
