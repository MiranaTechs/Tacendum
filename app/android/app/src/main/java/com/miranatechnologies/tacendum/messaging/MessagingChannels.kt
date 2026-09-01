package com.miranatechnologies.tacendum.messaging

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/**
 * The two channels background delivery needs.
 *
 * They are separate for the reason CallNotifications gives about its own pair:
 * a person must be able to silence one without losing the other, and the two
 * have opposite jobs.
 *
 *   * MESSAGES — IMPORTANCE_DEFAULT, and `setShowBadge(true)` because on
 *     Android the badge is a property of a posted notification on a channel
 *     that allows one. A number on a notification whose channel refuses
 *     badges is silently ignored, which is the failure that reads as "the
 *     launcher does not support badges".
 *   * SERVICE — the ongoing notification the foreground service is required to
 *     show while it holds the socket. IMPORTANCE_LOW so
 *     it never makes a sound, and `setShowBadge(false)` so the thing that says
 *     "connected" cannot look like unread mail.
 *
 * The user-visible strings are the whole vocabulary this file has, and they
 * follow one rule: no "iPhone", no "Apple", nothing that names a message or a
 * person. A channel name appears in system settings forever; it says what the
 * channel is for and nothing about who uses it.
 */
internal object MessagingChannels {

  const val MESSAGES = "tacendum-messages"
  const val SERVICE = "tacendum-messaging-service"

  fun ensure(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return

    val messages =
        NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_DEFAULT)
    messages.description = "New messages."
    messages.setShowBadge(true)
    // PRIVATE, not PUBLIC: a secure lock screen hides the body and shows the
    // public version composed in MessageNotifier — the generic one. The
    // preview lease decides whether words may be composed at all; this decides
    // whether they may be READ from a locked screen, and the two gates are
    // independent on purpose.
    messages.lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
    manager.createNotificationChannel(messages)

    val service =
        NotificationChannel(SERVICE, "Connection", NotificationManager.IMPORTANCE_LOW)
    service.description = "Shows while this phone is connected and able to receive messages."
    service.setShowBadge(false)
    service.setSound(null, null)
    service.enableVibration(false)
    manager.createNotificationChannel(service)
  }
}
