package com.miranatechnologies.tacendum.call

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The ring, the ongoing-call notification, and the badge.
 *
 * **A self-managed `ConnectionService` shows no UI of its own.** That is the
 * trade accepted deliberately: the app owns the in-call experience, and the price is
 * that an incoming call is INVISIBLE unless this file puts something on the
 * screen. The full-screen intent is the mechanism — the same one the dialer
 * uses — and `Connection.onShowIncomingCallUi` is the moment Telecom says now.
 *
 * The two channels are separate on purpose. A ring must be able to interrupt
 * (IMPORTANCE_HIGH, and only that importance lets a full-screen intent take
 * over a locked screen); an in-progress call must not (IMPORTANCE_LOW, no
 * sound, no vibration, ongoing). Merging them would either make every
 * in-progress call buzz or make no incoming call ring, and a person can turn
 * one off without losing the other.
 *
 * **Icons come from the framework.** `android.R.drawable.*` rather than a
 * drawable of our own: a library that ships resources into the app's merged
 * resource table is a name collision waiting for the day two modules pick the
 * same one, and a call notification's icon is not where this product's design
 * lives.
 */
internal object CallNotifications {

  const val RING_CHANNEL = "tacendum-call-ring"
  const val ONGOING_CHANNEL = "tacendum-call-ongoing"
  const val RING_NOTIFICATION_ID = 4301
  const val ONGOING_NOTIFICATION_ID = 4302

  const val ACTION_ANSWER = "com.miranatechnologies.tacendum.call.ANSWER"
  const val ACTION_DECLINE = "com.miranatechnologies.tacendum.call.DECLINE"

  /**
   * The number the launcher should draw.
   *
   * The server raises a badge and only the device can clear one, so the rule
   * is that the server raises it and the app lowers it. On Android a badge is
   * not a property of the app — it is a property of a POSTED NOTIFICATION on a
   * channel with `setShowBadge(true)`. So this holds the number and the
   * notifications that carry it apply it; with nothing posted, the value is
   * remembered and applied to the next one. The call module posts no numbered notification
   * (a ring is not a count), so here the count is stored and the
   * message notifications are what render it — which is exactly
   * the launcher-best-effort behavior already described.
   *
   * It never rejects, in any of its layers. A badge is decoration; a failure
   * to draw one must not become an error on a path that is otherwise about
   * delivering messages.
   */
  @Volatile private var badgeCount = 0

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val ring =
        NotificationChannel(RING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
    ring.description = "Rings when someone calls you."
    ring.setShowBadge(false)
    ring.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    manager.createNotificationChannel(ring)

    val ongoing =
        NotificationChannel(ONGOING_CHANNEL, "Calls in progress", NotificationManager.IMPORTANCE_LOW)
    ongoing.description = "Shows while a call is connected."
    // Half of the badge mechanism lives on the CHANNEL: a number on a
    // notification whose channel refuses badges is silently ignored, and that
    // is the failure that looks like "the launcher does not support badges".
    ongoing.setShowBadge(true)
    ongoing.setSound(null, null)
    ongoing.enableVibration(false)
    manager.createNotificationChannel(ongoing)
  }

  fun setBadgeCount(count: Int) {
    badgeCount = if (count < 0) 0 else count
  }

  fun badgeCount(): Int = badgeCount

  // MARK: - the ring

  fun showRing(context: Context, connection: TacendumConnection) {
    ensureChannels(context)
    val name = connection.callerDisplayName ?: "Incoming call"
    val notification = buildRing(context, connection.cid, name)
    try {
      NotificationManagerCompat.from(context).notify(RING_NOTIFICATION_ID, notification)
    } catch (denied: SecurityException) {
      // POST_NOTIFICATIONS was refused. The Telecom call still exists and the
      // in-app UI can still answer it; what is lost is the lock-screen ring.
      // Not fatal, and not something to log with a cid attached.
    }
  }

  fun updateRingName(context: Context?, connection: TacendumConnection, name: String) {
    val ctx = context ?: return
    if (connection.state != android.telecom.Connection.STATE_RINGING) return
    showRing(ctx, connection)
  }

  fun clearRing(context: Context?) {
    // Reset here rather than in `showRing`: the update path re-posts the same
    // ring to correct its name, and resetting there would make a silenced
    // ring start making noise again the moment the offer decrypted.
    silenced = false
    val ctx = context ?: return
    NotificationManagerCompat.from(ctx).cancel(RING_NOTIFICATION_ID)
  }

  fun silenceRing() {
    // `Connection.onSilence` means "stop making noise, keep ringing". Cancel
    // is wrong here and re-posting silently is the shape that works: the
    // notification stays, the sound does not resume.
    silenced = true
  }

  @Volatile private var silenced = false

  private fun buildRing(context: Context, cid: String, name: String) =
      NotificationCompat.Builder(context, RING_CHANNEL)
          .setSmallIcon(android.R.drawable.sym_call_incoming)
          .setContentTitle(name)
          .setContentText("Incoming call")
          .setCategory(NotificationCompat.CATEGORY_CALL)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setAutoCancel(false)
          .setSilent(silenced)
          // `true` for the highPriority argument: without it the full-screen
          // intent degrades to a heads-up banner, which is the difference
          // between a phone that rings from a locked screen and one that
          // shows a card nobody sees.
          .setFullScreenIntent(launchIntent(context), true)
          .addAction(
              android.R.drawable.sym_call_incoming,
              "Answer",
              actionIntent(context, ACTION_ANSWER, cid),
          )
          .addAction(
              android.R.drawable.sym_call_missed,
              "Decline",
              actionIntent(context, ACTION_DECLINE, cid),
          )
          .setContentIntent(launchIntent(context))
          .build()

  /**
   * The app's own launcher intent, resolved from the package manager rather
   * than named as a class.
   *
   * This module must not compile against `MainActivity`: it is a library, the
   * activity belongs to the application, and a hard reference would make the
   * dependency point the wrong way. The launch intent is the same target the
   * launcher uses, which is what a person tapping a call notification expects.
   */
  private fun launchIntent(context: Context): PendingIntent? {
    val intent =
        context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun actionIntent(context: Context, action: String, cid: String): PendingIntent {
    val intent = Intent(context, CallActionReceiver::class.java)
    intent.action = action
    intent.putExtra(TelecomExtras.CID, cid)
    return PendingIntent.getBroadcast(
        context,
        action.hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  // MARK: - the ongoing-call notification (the foreground service's)

  fun buildOngoing(context: Context, title: String): android.app.Notification {
    ensureChannels(context)
    // `stat_sys_phone_call` carries a deprecation upstream and is still the
    // framework's own in-call glyph on every API this module supports. The
    // alternative is shipping a drawable from a library into the app's merged
    // resource table, which this file's header explains is a name collision
    // waiting to happen.
    @Suppress("DEPRECATION")
    val builder =
        NotificationCompat.Builder(context, ONGOING_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(title)
            .setContentText("Tap to return to the call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(launchIntent(context))
    val count = badgeCount
    if (count > 0) builder.setNumber(count)
    return builder.build()
  }
}

/**
 * Answer and Decline, from the notification's own buttons.
 *
 * A self-managed call has no system UI, so these two buttons are the only way
 * to resolve a ring without unlocking the phone and finding the app. Declared
 * in this module's manifest, not exported: an exported receiver here would let
 * any app on the device answer or decline this device's calls.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val cid = intent.getStringExtra(TelecomExtras.CID) ?: return
    val connection = TelecomCenter.connectionFor(cid) ?: return
    when (intent.action) {
      CallNotifications.ACTION_ANSWER -> TelecomCenter.onAnswered(connection)
      CallNotifications.ACTION_DECLINE -> TelecomCenter.onRejected(connection)
      else -> Unit
    }
  }
}
