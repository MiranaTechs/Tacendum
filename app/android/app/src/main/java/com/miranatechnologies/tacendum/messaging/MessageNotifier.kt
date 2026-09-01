package com.miranatechnologies.tacendum.messaging

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * The handler that plays the notification-service extension's role, in-process
 * — the Android twin of the iOS notification service extension.
 *
 * app/ios/TacendumNSE/NotificationService.swift is the oracle for every rule
 * below. What is IDENTICAL is the permission model and the order the gates are
 * consulted in:
 *
 *   1. THE BLOCK, before anything happens on a blocked sender's behalf — no
 *      badge, no banner. A blocked sender can still put bytes on the wire, so
 *      their message still arrives; the block mirror is what keeps it off the
 *      screen. (The app also drops it from the conversation. Two layers,
 *      because this one reads a FILE, which a relock leaves standing, and the
 *      other reads a database, which a relock closes.)
 *   2. THE BADGE, before any preview gate, because it is not a preview: a
 *      locked phone still counts its mail, it just does not display any of it.
 *   3. THE LEASE and THE LEVEL — armed AND provably revocable, a published
 *      self-id, and a level that is not `none`. Anything else shows the
 *      generic body.
 *   4. THE RENDER, from mirrors only.
 *
 * What is DIFFERENT, and why: iOS decides before decrypting, because deciding
 * after would consume a ratchet key the app still needs. Android delivers over
 * the socket into the app that owns the ratchet, so the plaintext exists
 * before this is called and the decision is only about what may be SHOWN. The
 * app therefore hands in a preview line it has already computed with
 * `previewFor` — the same function that writes `chats.lastMessageText`, whose
 * own comments record that it is "what a notification would show" and that it
 * must never carry a vault title, a filename, or coordinates. This side never
 * parses an envelope and never sees a raw payload byte.
 *
 * NOTHING HERE LOGS — no `Log`, no `println`, at any level. Every value that
 * crosses this file is a name, an id, or a message preview, and an audit
 * script scans this tree to keep it that way.
 */
internal object MessageNotifier {

  /** What was actually shown. Returned to JS for the device gate and the dev
   * hook; it names a RULE, never a value. */
  const val VERDICT_BLOCKED = "blocked"
  const val VERDICT_GENERIC = "generic"
  const val VERDICT_SENDER = "sender"
  const val VERDICT_FULL = "full"

  /** The intent extra a tapped banner carries; the module turns it into the
   * `pending-nav` line (PendingNav). */
  const val EXTRA_THREAD = "com.miranatechnologies.tacendum.messaging.THREAD"

  /** The body every degraded path shows. The server's generic push says
   * exactly this on iOS; here the app composes it, so it is written down
   * once. */
  private const val GENERIC_BODY = "New message"

  private const val MESSAGE_ID_BASE = 0x4A00

  /**
   * @param from the AUTHENTICATED sender's id (the ratchet vouches for it).
   * @param msgId the wire message id — the notification's identity, so a
   *   redelivery replaces its own banner instead of posting a second one.
   * @param roomId the room this belongs to, or empty for a 1:1.
   * @param preview the app's own preview line for the body, or empty. Shown
   *   only at level `full`.
   * @param structured whether the body was an ENVELOPE rather than plain
   *   words. In a room only a fixed constant may be shown — never the
   *   body — and `previewFor` returns a constant exactly when the
   *   body was structured — so this bit is what keeps a room's words off the
   *   screen while still saying "Photo".
   */
  fun show(
      context: Context,
      from: String,
      msgId: String,
      roomId: String,
      preview: String,
      structured: Boolean,
  ): String {
    MessagingChannels.ensure(context)

    // 1. THE BLOCK.
    if (PreviewPolicy.blocked(context).contains(from)) return VERDICT_BLOCKED

    // 2. THE BADGE — independent of the lease and the level, deliberately.
    val badge = BadgeCounter.incrementedBadge(context)

    // 3. THE GATES. `armedAndWritable` is the write gate: a lease that cannot
    // be rewritten is a lease that can never be revoked, and a permission that
    // cannot be taken away must not be usable. `selfUserId` is the second,
    // independent gate — a relock retracts it (app/src/nse.ts retractSelfId),
    // so a relock landing between arrival and render suppresses the preview of
    // the message in flight, not just the next one.
    val level = PreviewPolicy.level(context)
    val armed =
        level != PreviewPolicy.Level.NONE &&
            PreviewPolicy.selfUserId(context) != null &&
            PreviewPolicy.armedAndWritable(context)

    var title = appLabel(context)
    var body = GENERIC_BODY
    var verdict = VERDICT_GENERIC
    // The thread a tap navigates to. Set ONLY when something was previewed: an
    // id written to `pending-nav` while the phone is locked and previews are
    // disarmed would be exactly the disclosure the disarm exists to prevent,
    // so a generic banner opens the app and navigates nowhere — which is what
    // iOS does too (its generic content carries no threadIdentifier, and
    // pushnav.ts refuses a line without one).
    var thread = ""

    if (armed) {
      if (roomId.isNotEmpty()) {
        val roomName = PreviewPolicy.groupName(context, roomId)
        if (level == PreviewPolicy.Level.FULL && roomName != null) {
          // THE NAME COMES FROM THE APP'S MIRROR AND NOWHERE ELSE. A room the
          // mirror cannot name keeps the generic body: titling it with the
          // sender would dress a room message as a 1:1 (the rule's
          // misattribution), and showing less is the permitted direction.
          title = roomName
          if (structured && preview.isNotEmpty()) body = preview
          verdict = VERDICT_FULL
          thread = "g/$roomId"
        } else if (level == PreviewPolicy.Level.SENDER) {
          // Who wrote — never what, and never which room: the room's name is
          // content about the owner's life, which is what `sender` promises to
          // withhold.
          title = PreviewPolicy.senderTitle(context, from)
          verdict = VERDICT_SENDER
          // The ROOM, not the sender — the one deliberate departure from
          // NotificationService.swift, which threads this case on the sender.
          // Navigation happens inside the app after an unlock, so the thread
          // key is not a disclosure (it is the same "g/" line iOS writes at
          // `full`); sending the tap to a 1:1 that never received the message
          // is simply wrong. The bytes at rest are identical either way.
          thread = "g/$roomId"
        }
      } else {
        title = PreviewPolicy.senderTitle(context, from)
        verdict = VERDICT_SENDER
        thread = from
        if (level == PreviewPolicy.Level.FULL && preview.isNotEmpty()) {
          body = preview
          verdict = VERDICT_FULL
        }
      }
    }

    val builder =
        Notification.Builder(context, MessagingChannels.MESSAGES)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            // What a SECURE LOCK SCREEN may show instead: the generic banner,
            // always. The lease decides whether words may be composed at all;
            // this decides whether composed words may be read without
            // unlocking, and the two gates are independent.
            .setPublicVersion(genericPublicVersion(context))
    val tap = tapIntent(context, thread)
    if (tap != null) builder.setContentIntent(tap)
    if (badge != null) builder.setNumber(badge)
    if (thread.isNotEmpty()) builder.setGroup(thread)

    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager != null) {
      try {
        manager.notify(notificationId(msgId), builder.build())
      } catch (denied: Exception) {
        // POST_NOTIFICATIONS refused, or the manager refused the post. The
        // message is already in the app's database; what is lost is the
        // banner. Not fatal, and not something to log with a sender attached.
      }
    }
    return verdict
  }

  /**
   * A stable id per WIRE MESSAGE, deliberately not per sender.
   *
   * Per-sender would collapse a burst into one banner, which is what iOS does
   * — but there the server mints the collapse id and the extension counts its
   * own launches so the survivor can say "N new messages". Nothing on this
   * side counts, so collapsing would silently drop every message but the last.
   * Per-message stacks them, and keying on the wire id means a REDELIVERY of
   * the same message replaces its own banner rather than posting a second one.
   */
  private fun notificationId(msgId: String): Int = MESSAGE_ID_BASE + (msgId.hashCode() and 0xFFFF)

  private fun appLabel(context: Context): String =
      context.applicationInfo.loadLabel(context.packageManager).toString()

  private fun genericPublicVersion(context: Context): Notification =
      Notification.Builder(context, MessagingChannels.MESSAGES)
          .setSmallIcon(android.R.drawable.stat_notify_chat)
          .setContentTitle(appLabel(context))
          .setContentText(GENERIC_BODY)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
          .build()

  /**
   * The tap: the app's own launcher intent, carrying the thread key when there
   * is one.
   *
   * The launcher intent rather than a trampoline of our own, for two reasons.
   * A person tapping a message notification expects the app they would have
   * opened anyway; and Android 12 forbids a notification from bouncing through
   * a receiver or a service to reach an activity, so a trampoline would have to
   * be an activity — one more surface, for a navigation nicety.
   *
   * The extra is consumed by TacendumMessagingModule, which writes the
   * `pending-nav` line in the app's own process (PendingNav) — the same
   * one-line format AppDelegate.swift writes, read by app/src/pushnav.ts under
   * the same 10-minute TTL.
   */
  private fun tapIntent(context: Context, thread: String): PendingIntent? {
    val intent =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (thread.isNotEmpty()) intent.putExtra(EXTRA_THREAD, thread)
    return PendingIntent.getActivity(
        context,
        // A request code per thread: with one shared code, FLAG_UPDATE_CURRENT
        // would rewrite every outstanding banner's extras to the newest
        // thread, and taps would land in the wrong conversation.
        if (thread.isEmpty()) 0 else thread.hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
