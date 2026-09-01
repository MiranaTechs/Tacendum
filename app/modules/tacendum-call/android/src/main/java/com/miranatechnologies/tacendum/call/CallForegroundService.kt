package com.miranatechnologies.tacendum.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * The foreground service a call runs inside.
 *
 * Android will freeze a backgrounded process and revoke its microphone and
 * camera while it is frozen. A call is precisely the thing that must keep both
 * while the person is looking at something else, so the process has to hold a
 * foreground service for as long as media is live — and, from Android 14, it
 * has to say WHICH of those capabilities it is holding.
 *
 * `phoneCall|microphone|camera`, and the three are not interchangeable:
 *
 *   * `phoneCall` is what pairs the service with the self-managed Telecom
 *     connection and is what makes starting it from the background legal at
 *     all while a call exists;
 *   * `microphone` and `camera` are what keep the two sensors usable once the
 *     app is not visible. Declaring a type the service does not use is a Play
 *     policy problem, so `camera` is only ASSERTED for a video call — the
 *     manifest declares all three (a manifest is a superset of what any run
 *     may use), and `startForeground` names only the ones this call has.
 *
 * The service holds no state and makes no decisions: `TacendumCallModule`
 * starts it when the first connection installs and stops it when the last one
 * goes, derived from the live set rather than incremented and decremented —
 * the same derive-don't-set argument the keep-screen-awake flag makes, and for
 * the same reason, which is that a counter with an early return in it strands
 * a microphone indicator lit for the rest of the process's life.
 */
class CallForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call in progress"
    val notification = CallNotifications.buildOngoing(applicationContext, title)
    val types =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          var mask =
              ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
                  ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
          if (video) mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
          mask
        } else {
          0
        }
    try {
      ServiceCompat.startForeground(
          this,
          CallNotifications.ONGOING_NOTIFICATION_ID,
          notification,
          types,
      )
    } catch (refused: Exception) {
      // Android 12+ throws when a foreground service is started from a state
      // that does not allow it, and Android 14 throws again when the type is
      // not permitted for that state. Either way the call itself is still up —
      // Telecom holds it — so this stops the SERVICE rather than the call, and
      // says nothing that could carry a cid into a log.
      stopSelf()
      return START_NOT_STICKY
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  companion object {
    const val EXTRA_VIDEO = "com.miranatechnologies.tacendum.call.FGS_VIDEO"
    const val EXTRA_TITLE = "com.miranatechnologies.tacendum.call.FGS_TITLE"

    fun start(context: Context, video: Boolean, title: String) {
      val intent = Intent(context, CallForegroundService::class.java)
      intent.putExtra(EXTRA_VIDEO, video)
      intent.putExtra(EXTRA_TITLE, title)
      try {
        context.startForegroundService(intent)
      } catch (refused: Exception) {
        // Same reasoning as above: a call that cannot hold a foreground
        // service is degraded, not over.
      }
    }

    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, CallForegroundService::class.java))
      } catch (ignored: Exception) {
        // Stopping a service that is not running is not an error worth
        // propagating onto a teardown path.
      }
    }
  }
}
