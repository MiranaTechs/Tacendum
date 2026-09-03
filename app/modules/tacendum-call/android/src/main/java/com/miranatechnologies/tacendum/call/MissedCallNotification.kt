package com.miranatechnologies.tacendum.call

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The "Missed call" notice.
 *
 * A missed call on a locked phone used to leave nothing: the ring notification
 * came down with the Telecom connection (`DisconnectCause.MISSED` is
 * bookkeeping, not a notice), and the app posted nothing of its own — the only
 * way to learn of the call was to open the Calls tab. The JS side calls `post`
 * from the same path that writes the missed row; the row is the fact, this is
 * its notice.
 *
 * ITS OWN CHANNEL, separate from the ring's and the ongoing call's, for the
 * reason `CallNotifications` keeps those two apart: a missed call must neither
 * interrupt like a ring (IMPORTANCE_HIGH, full-screen) nor hide like an
 * in-progress call (IMPORTANCE_LOW, silent, ongoing). Default importance — a
 * sound and a shade entry, nothing that takes over the screen — and a person
 * can switch it off without losing either of the others. Created here rather
 * than in `CallNotifications.ensureChannels`, which is native-owned.
 *
 * TAGGED BY PEER. One notification id, a tag per peer: a second missed call
 * from the same person replaces the first rather than stacking, and clearing
 * by peer is `cancel(tag, id)`. Clearing ALL walks the active notifications
 * for the tag prefix, so nothing else this app posts is touched.
 *
 * The payload carries NOTHING but the title and the name: a posted
 * notification is readable by anything that can read the lock screen, and an
 * id, an offer or a thread in it would be that much readable. Tapping opens
 * the app — the Calls tab is where the row is.
 *
 * `displayName` is what JS knows; empty when it knows nothing (a locked
 * workspace refuses the read), in which case the name mirror the ring itself
 * paints from is consulted, and failing that the body says only that someone
 * called. Never throws: a refused post (POST_NOTIFICATIONS declined) costs the
 * notice, never the row or the call. */
internal object MissedCallNotification {

  const val CHANNEL = "tacendum-call-missed"
  const val NOTIFICATION_ID = 4303
  private const val TAG_PREFIX = "missed-call:"

  fun ensureChannel(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val channel =
        NotificationChannel(CHANNEL, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "Tells you about calls you did not answer."
    channel.setShowBadge(true)
    channel.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    manager.createNotificationChannel(channel)
  }

  fun post(context: Context, peerId: String, displayName: String) {
    ensureChannel(context)
    val known = displayName.ifEmpty { TelecomCenter.mirroredName(peerId) ?: "" }
    // `sym_call_missed` is the framework's own missed-call glyph, the one the
    // ring's Decline action already uses; see `CallNotifications` on why no
    // drawable of our own ships from a library.
    val notification =
        NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_missed)
            .setContentTitle("Missed call")
            .setContentText(known.ifEmpty { "Tap to see who called." })
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(launchIntent(context))
            .build()
    try {
      NotificationManagerCompat.from(context).notify(TAG_PREFIX + peerId, NOTIFICATION_ID, notification)
    } catch (denied: SecurityException) {
      // POST_NOTIFICATIONS was refused. The row is written either way; what
      // is lost is the notice. Not logged with a peer id attached.
    }
  }

  /** `peerId` empty clears every missed-call notice this app has up. */
  fun clear(context: Context, peerId: String) {
    val compat = NotificationManagerCompat.from(context)
    if (peerId.isNotEmpty()) {
      compat.cancel(TAG_PREFIX + peerId, NOTIFICATION_ID)
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val active =
        try {
          manager.activeNotifications
        } catch (unavailable: RuntimeException) {
          return
        }
    for (posted in active) {
      val tag = posted.tag ?: continue
      if (posted.id == NOTIFICATION_ID && tag.startsWith(TAG_PREFIX)) compat.cancel(tag, posted.id)
    }
  }

  private fun launchIntent(context: Context): PendingIntent? {
    val launch =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
        context,
        NOTIFICATION_ID,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
