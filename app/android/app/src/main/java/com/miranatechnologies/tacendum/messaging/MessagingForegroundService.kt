package com.miranatechnologies.tacendum.messaging

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import java.util.concurrent.ConcurrentHashMap

/**
 * The foreground service that holds the socket.
 *
 * **Why it exists at all.** In a build without FCM wired there is no push
 * transport on Android, so the websocket IS the delivery path. iOS closes its
 * socket on backgrounding precisely so the server takes the push branch
 * (app/src/messaging.ts `pause`); Android has no branch to take, so the socket
 * must stay up while the app is away, and a process that is allowed to keep a
 * socket up while it is away is exactly what a foreground service is. The
 * visible ongoing notification is the price the platform charges for that, and
 * that trade was accepted deliberately.
 *
 * `remoteMessaging` is the type, which is what it is for: from Android 14 a
 * service must declare which capability it is holding, and this one is holding
 * "receiving messages for the user".
 *
 * **And it holds the reconnect clock** (`WakeScheduler`, below). Keeping a
 * socket alive turned out to be only half the job: React Native's timers on
 * this platform are Choreographer-driven and stop while the Activity is
 * paused, so the app could hold a socket in a pocket but could not DIAL one
 * there — the repair for a defect the device verification run measured directly.
 * This process is allowed to be awake while the app is away, and that is the
 * whole reason it can own a clock the Activity's lifecycle does not touch.
 *
 * **Signal's IncomingMessageObserver shape, adapted honestly.** There the
 * service owns the socket object; here the socket is the app's own JavaScript
 * WebSocket (app/src/ws.ts), and what this service owns is the PROCESS'S RIGHT
 * to keep it. The observer half — deciding when the socket should be up — is
 * app/src/background.ts, which is where the Doze policy lives too. This class
 * contributes the one thing only Kotlin can: the OS's idle signal.
 *
 * **The Doze policy, stated so it can be asserted** (step 1): under device
 * idle the socket is PAUSED and nothing is delivered; delivery resumes on exit
 * from idle. This class reports the transitions; app/src/background.ts applies
 * them, and app/__tests__/doze.android.test.ts pins both branches — a device
 * cannot attribute the silence under Doze to our pause rather than to the
 * platform's own network suspension, which is why the attribution lives in a
 * test instead of in a claim.
 *
 * START_NOT_STICKY, like the call service: a sticky restart would bring this
 * service back WITHOUT the JavaScript that owns the socket — an ongoing
 * notification promising a connection that does not exist. When the process
 * goes, the promise goes with it.
 *
 * Framework notification APIs rather than androidx: this is the application
 * module, which declares no androidx dependency of its own, and minSdk 26
 * means every call below exists on every device the app supports. The
 * two places that do not — the typed `startForeground` and the receiver
 * export flag — are branched explicitly.
 */
class MessagingForegroundService : Service() {

  private var idleReceiver: BroadcastReceiver? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    // Registered dynamically, and it has to be: ACTION_DEVICE_IDLE_MODE_CHANGED
    // is a protected broadcast the system does not deliver to manifest-declared
    // receivers. NOT_EXPORTED because nothing outside this app may reach it.
    val receiver =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED) return
            IdleObserver.publish(isDeviceIdle(applicationContext))
          }
        }
    idleReceiver = receiver
    val filter = IntentFilter(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(receiver, filter)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    MessagingChannels.ensure(applicationContext)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val type =
            if (Build.VERSION.SDK_INT >= 34) {
              ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            } else {
              // Typed foreground services are only REQUIRED from 34, and
              // `remoteMessaging` does not exist below it; the untyped call is
              // the correct one there, not a degraded one.
              0
            }
        startForeground(NOTIFICATION_ID, ongoing(), type)
      } else {
        startForeground(NOTIFICATION_ID, ongoing())
      }
    } catch (refused: Exception) {
      // Android 12+ throws when a foreground service is started from a state
      // that does not allow it, and 14 throws again when the type is not
      // permitted for that state. The socket itself is unaffected — it lives
      // in the app's JavaScript — so what is lost is the permission to keep it
      // up while the app is away, not the connection. Stop the service rather
      // than leave a half-started one, and say nothing that could name a
      // person.
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    // The current idle state, published on every start: a service that comes
    // up while the device is already idle must not leave the policy believing
    // the socket may stay open.
    IdleObserver.publish(isDeviceIdle(applicationContext))
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    idleReceiver?.let {
      try {
        unregisterReceiver(it)
      } catch (never: IllegalArgumentException) {
        // Not registered — nothing to undo.
      }
    }
    idleReceiver = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  /**
   * The ongoing notification. It says that this phone is connected and NOTHING
   * else: no sender, no count, no preview. It is visible to anyone who picks
   * the phone up, and the one thing it must never become is a disclosure of
   * its own.
   */
  private fun ongoing(): Notification =
      Notification.Builder(applicationContext, MessagingChannels.SERVICE)
          .setSmallIcon(android.R.drawable.stat_notify_sync)
          .setContentTitle("Connected")
          .setContentText("Ready to receive messages.")
          .setCategory(Notification.CATEGORY_SERVICE)
          .setOngoing(true)
          .setShowWhen(false)
          .setVisibility(Notification.VISIBILITY_SECRET)
          .setContentIntent(launchIntent(applicationContext))
          .build()

  private fun launchIntent(context: Context): PendingIntent? {
    val intent =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  companion object {
    const val NOTIFICATION_ID = 4901

    /** Diagnostic only — the device gate asserts the service through
     * `dumpsys`, which is the OS's answer rather than ours. */
    @Volatile private var running = false

    fun isRunning(): Boolean = running

    fun isDeviceIdle(context: Context): Boolean {
      val power = context.getSystemService(PowerManager::class.java) ?: return false
      return power.isDeviceIdleMode
    }

    fun start(context: Context) {
      val intent = Intent(context, MessagingForegroundService::class.java)
      try {
        context.startForegroundService(intent)
      } catch (refused: Exception) {
        // See onStartCommand: a socket that cannot hold a foreground service
        // is degraded — it dies with the next process freeze — not broken.
      }
    }

    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, MessagingForegroundService::class.java))
      } catch (ignored: Exception) {
        // Stopping a service that is not running is not an error worth
        // propagating onto a teardown path.
      }
    }

    /** Cancel the ongoing notification directly. The service's own
     * `onDestroy` does this, but a process that was killed while backgrounded
     * leaves the notification behind; JS calls this on the next start's
     * teardown path so a stale "Connected" cannot outlive the socket. */
    fun cancelOngoing(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      try {
        manager.cancel(NOTIFICATION_ID)
      } catch (ignored: Exception) {
        // Best effort, like everything else about a notification.
      }
    }
  }
}

/**
 * The seam between the service's broadcast receiver and the JavaScript that
 * owns the socket.
 *
 * A slot rather than a listener set: there is exactly one socket and exactly
 * one policy, and a set would let a Metro reload leave a dead module's listener
 * behind to pause a socket it no longer owns.
 */
internal object IdleObserver {
  @Volatile private var listener: ((Boolean) -> Unit)? = null
  @Volatile private var last: Boolean? = null

  fun install(next: ((Boolean) -> Unit)?) {
    listener = next
  }

  /** Edge-triggered: the platform sends the broadcast on a state change, but
   * the service also publishes on start, and re-announcing a state the policy
   * already applied would suspend a socket that is already suspended. */
  fun publish(idle: Boolean) {
    if (last == idle) return
    last = idle
    listener?.invoke(idle)
  }

  /** Forget the last state, so the next publish is delivered whatever it says.
   * Called when JS installs a fresh listener: a new session's policy has
   * applied nothing yet. */
  fun reset() {
    last = null
  }
}

/**
 * THE RECONNECT CLOCK — the other seam between this process and the socket,
 * and the repair for the defect the device run measured.
 *
 * **What was broken.** React Native's Android timers are driven by a
 * Choreographer frame callback that `onHostPause` removes, so `setTimeout` is
 * DEFERRED — parked, not fired late — for as long as the Activity is paused.
 * Measured on the emulator with this very service running: a self-rescheduling
 * 5-second chain fired 0 times in 100 seconds backgrounded, then 3 times
 * within 12 seconds of the app being foregrounded. `app/src/ws.ts` armed every
 * reconnect with `setTimeout`, so a socket that DROPPED while the app was away
 * could not dial again until the person opened the app — which is exactly the
 * failure this service exists to prevent, arrived at one layer down.
 *
 * **What this is, and what it deliberately is not.** A plain `Handler` on a
 * plain thread, counting one delay down and reporting that it came due. It
 * holds no policy: the backoff, the auth probe, the Doze pause and the
 * terminal `gone` latch all stay in `ws.ts`, where they are testable without a
 * device. The only thing that crosses this boundary is "wake me in N
 * milliseconds", and the only thing that comes back is the id of the wake that
 * arrived.
 *
 * **What it cannot promise.** `Handler.postDelayed` counts in
 * `SystemClock.uptimeMillis()`, which does not advance while the CPU is
 * suspended. On a real phone with the screen off the tick can therefore land
 * LATE — at the next wake the system takes for its own reasons — rather than
 * at the requested delay. That is a latency limit, not a correctness one, and
 * it is a strict improvement on the behaviour it replaces, which required the
 * person to open the app. Holding a partial `WakeLock` across a pending wake
 * is the standard hardening and is deliberately NOT done here: it would add
 * a manifest permission, a cost out of proportion to a latency-only
 * limit. Under Doze proper the socket is
 * supposed to be down anyway (`IdleObserver` → `pauseForIdle`), and
 * `ws.suspend()` cancels the pending wake on the way, so a throttled tick
 * there agrees with the policy rather than fighting it.
 *
 * A daemon thread, like the messaging module's executor and for the same
 * reason: it must never be why a process refuses to exit.
 */
internal object WakeScheduler {
  private val thread =
      HandlerThread("com.tacendum.messaging.wake").apply {
        isDaemon = true
        start()
      }
  private val handler = Handler(thread.looper)

  /** Armed wakes by id. Concurrent because `schedule`/`cancel` arrive on the
   * native-modules thread while the runnables run on ours. */
  private val pending = ConcurrentHashMap<Int, Runnable>()

  @Volatile private var listener: ((Int) -> Unit)? = null

  /** A slot, not a set — IdleObserver's reasoning: there is one socket and one
   * scheduler, and a Metro reload that left a dead module's listener behind
   * would poke a session that no longer exists. */
  fun install(next: ((Int) -> Unit)?) {
    listener = next
  }

  fun schedule(id: Int, delayMs: Long) {
    // Re-arming an id replaces it rather than stacking a second runnable: JS
    // mints a fresh id per wake, so this can only be a retry of one that never
    // got through, and two runnables for one id would dial twice.
    cancel(id)
    val task = Runnable {
      // Removed BEFORE the listener runs, so a cancel arriving from JS while
      // the callback is in flight cannot leave a stale entry behind.
      pending.remove(id)
      listener?.invoke(id)
    }
    pending[id] = task
    handler.postDelayed(task, if (delayMs < 0L) 0L else delayMs)
  }

  fun cancel(id: Int) {
    pending.remove(id)?.let { handler.removeCallbacks(it) }
  }

  /** Every armed wake dropped. Called when JS tears the session down: a wake
   * that outlived its session would dial a socket nobody owns. */
  fun cancelAll() {
    for (id in pending.keys.toList()) cancel(id)
  }
}
