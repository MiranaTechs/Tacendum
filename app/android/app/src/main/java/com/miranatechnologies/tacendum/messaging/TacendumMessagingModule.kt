package com.miranatechnologies.tacendum.messaging

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.miranatechnologies.tacendum.BuildConfig
import java.util.concurrent.Executors

/**
 * The JavaScript face of background delivery.
 *
 * Five things cross this bridge and nothing else:
 *
 *   * the foreground service's lifetime — started when a real session opens,
 *     stopped when it closes, so an ongoing "Connected" notification never
 *     outlives the socket it describes;
 *   * the device-idle transitions, forwarded to the pause policy in
 *     app/src/background.ts (the Doze contract);
 *   * one banner per delivered message, decided entirely on this side by
 *     MessageNotifier under the shared-state gates;
 *   * the tapped banner's thread key, turned into the `pending-nav` line
 *     app/src/pushnav.ts consumes;
 *   * the reconnect clock — `scheduleWake`/`cancelWake` out, EVENT_WAKE back —
 *     because React Native's own timers stop while the Activity is paused and
 *     `ws.ts` schedules every re-dial with one. See WakeScheduler for the
 *     measurement. No policy crosses: only "wake me in N milliseconds".
 *
 * A LEGACY React Native module rather than a codegen'd TurboModule, and the
 * reason is placement rather than preference: the six native modules live in
 * their own packages under app/modules/, each with a codegen spec and an iOS
 * half, and this code is neither — the service, its channels and its
 * notifications belong to the APPLICATION (the manifest that declares the
 * service is the application's, and iOS has an extension instead). React
 * Native's bridgeless interop layer registers a legacy module from a
 * ReactPackage exactly as it registers a TurboModule, so the cost is one
 * `NativeModules` lookup in JS instead of a generated type — and the JS side
 * (app/src/background.ts) types the surface itself and refuses to be anything
 * but Android-only.
 *
 * NOTHING HERE LOGS.
 */
class TacendumMessagingModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  /**
   * `pushTransport` — which push truth THIS BINARY embodies:
   * `"fcm"` when the build was wired against a google-services.json,
   * `"socket"` when it is the websocket-only build. A constant rather than
   * a method because its one consumer is consent-grade Settings copy
   * (SettingsScreen `pushNote`), which must describe the running binary
   * synchronously and must never describe the plan. BuildConfig.TACENDUM_FCM
   * is set from the same file-presence check that gates every other piece of
   * Firebase wiring (app/build.gradle's FCM header).
   */
  override fun getConstants(): MutableMap<String, Any> =
      hashMapOf("pushTransport" to (if (BuildConfig.TACENDUM_FCM) "fcm" else "socket"))

  private var navListenerInstalled = false

  /**
   * A tap arriving while the app is already alive lands here (the launcher
   * intent is `singleTask`, so the platform delivers `onNewIntent` rather than
   * a fresh activity). The cold case is covered by `captureNavIntent`, which
   * JS calls on every foreground edge.
   */
  private val navListener =
      object : BaseActivityEventListener() {
        override fun onNewIntent(intent: Intent) {
          consumeNavIntent(intent)
        }
      }

  // MARK: - lifecycle

  @ReactMethod
  fun start(promise: Promise) {
    val context = reactApplicationContext
    MessagingChannels.ensure(context)
    requestPostNotificationsIfNeeded()
    if (!navListenerInstalled) {
      context.addActivityEventListener(navListener)
      navListenerInstalled = true
    }
    // A fresh listener for a fresh session, and the memory of the last state
    // cleared with it: this session's policy has applied nothing yet, so the
    // first publish must be delivered whatever it says.
    IdleObserver.reset()
    IdleObserver.install { idle -> emitIdle(idle) }
    // The reconnect clock, installed with the idle observer and torn down with
    // it. Any wake left armed by a previous session is dropped first: it would
    // name an id this session's `ws.ts` has never issued, and the JS side would
    // discard it — but a scheduler that keeps firing into a discard is a leak
    // with a heartbeat, and this is where it ends.
    WakeScheduler.cancelAll()
    WakeScheduler.install { id -> emitWake(id) }
    MessagingForegroundService.start(context)
    // The intent that LAUNCHED this process, if it came from a banner: the
    // activity event listener above only ever sees taps that arrive while the
    // app is running.
    consumeNavIntent(reactApplicationContext.currentActivity?.intent)
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val context = reactApplicationContext
    IdleObserver.install(null)
    IdleObserver.reset()
    WakeScheduler.install(null)
    WakeScheduler.cancelAll()
    MessagingForegroundService.stop(context)
    // Belt and braces for the one case `onDestroy` cannot cover: a process
    // killed while backgrounded leaves its ongoing notification on screen,
    // promising a connection nothing is holding.
    MessagingForegroundService.cancelOngoing(context)
    promise.resolve(null)
  }

  // MARK: - the NSE-role handler

  /**
   * Render one message's banner. `payload` carries `from`, `msgId`, `roomId`,
   * `preview` and `structured`; every gate that decides what is SHOWN is read
   * from the shared-state files on this side (MessageNotifier).
   *
   * Resolves with the verdict — `blocked`, `generic`, `sender`, `full` — which
   * names a rule and never a value. Never rejects: a banner is not worth
   * failing a delivery path over, so an unexpected failure resolves as
   * `generic`, the same answer every other degraded route gives.
   */
  @ReactMethod
  fun notifyMessage(payload: ReadableMap, promise: Promise) {
    val from = payload.getString("from") ?: ""
    val msgId = payload.getString("msgId") ?: ""
    val roomId = payload.getString("roomId") ?: ""
    val preview = payload.getString("preview") ?: ""
    val structured = payload.hasKey("structured") && payload.getBoolean("structured")
    if (from.isEmpty() || msgId.isEmpty()) {
      promise.resolve(MessageNotifier.VERDICT_GENERIC)
      return
    }
    val context = reactApplicationContext
    QUEUE.execute {
      val verdict =
          try {
            MessageNotifier.show(context, from, msgId, roomId, preview, structured)
          } catch (failed: Exception) {
            MessageNotifier.VERDICT_GENERIC
          }
      promise.resolve(verdict)
    }
  }

  // MARK: - navigation

  /** Called on every foreground edge by app/src/background.ts. Resolves true
   * when a tap's thread key was found and written. */
  @ReactMethod
  fun captureNavIntent(promise: Promise) {
    promise.resolve(consumeNavIntent(reactApplicationContext.currentActivity?.intent))
  }

  /**
   * Read the thread key OUT of the intent — and remove it, so the same tap
   * cannot be redeemed twice. A launch intent survives in
   * `Activity.getIntent()` for the life of the activity, and without the
   * removal every later foreground edge would rewrite `pending-nav` with a
   * fresh timestamp, teleporting the app into a conversation nobody just
   * asked for (which is the exact staleness pushnav.ts's TTL exists to
   * prevent).
   */
  private fun consumeNavIntent(intent: Intent?): Boolean {
    val thread =
        try {
          intent?.getStringExtra(MessageNotifier.EXTRA_THREAD)
        } catch (hostile: Exception) {
          // A malformed extras bundle from anywhere is not worth a crash on a
          // launch path.
          null
        }
    if (thread.isNullOrEmpty()) return false
    intent?.removeExtra(MessageNotifier.EXTRA_THREAD)
    val activityIntent = reactApplicationContext.currentActivity?.intent
    if (activityIntent !== intent) activityIntent?.removeExtra(MessageNotifier.EXTRA_THREAD)
    // The shape check lives in PendingNav: only a bare thread key is ever
    // written, whatever an intent claims.
    return PendingNav.write(reactApplicationContext, thread)
  }

  // MARK: - Doze

  @ReactMethod
  fun deviceIdle(promise: Promise) {
    promise.resolve(MessagingForegroundService.isDeviceIdle(reactApplicationContext))
  }

  /** Diagnostic, for the dev hook: the OS's `dumpsys` is the authority
   * to assert against. */
  @ReactMethod
  fun serviceRunning(promise: Promise) {
    promise.resolve(MessagingForegroundService.isRunning())
  }

  // MARK: - the reconnect clock
  //
  // Two fire-and-forget methods rather than a Promise pair, because a promise
  // is the wrong shape for this: what JS wants is not "the wake was accepted"
  // but "the wake came due", and that arrives as EVENT_WAKE. See WakeScheduler
  // for the measured defect these exist to repair, and app/src/background.ts
  // for the JS half — which arms a `setTimeout` beside every one of these, so
  // an APK without this pair degrades to exactly the old behaviour instead of
  // to a socket that never re-dials.

  /** Poke JS back in `delayMs`, whatever the Activity's lifecycle is doing.
   * Doubles because that is what the bridge carries a JS number as. */
  @ReactMethod
  fun scheduleWake(id: Double, delayMs: Double) {
    WakeScheduler.schedule(id.toInt(), delayMs.toLong())
  }

  /** The wake is no longer wanted — it fired through the JS-side timer first,
   * or the socket was suspended (a Doze pause, a relock) before it came due. */
  @ReactMethod
  fun cancelWake(id: Double) {
    WakeScheduler.cancel(id.toInt())
  }

  // MARK: - event emitter plumbing

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter's contract; the events are delivered
    // through RCTDeviceEventEmitter, so there is nothing to register here.
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    // Same.
  }

  private fun emitIdle(idle: Boolean) {
    val context = reactApplicationContext
    try {
      if (!context.hasActiveReactInstance()) return
      context.emitDeviceEvent(EVENT_DEVICE_IDLE, idle)
    } catch (torn: Exception) {
      // The instance went away between the check and the emit (a reload, a
      // teardown). The policy it would have driven went with it.
    }
  }

  /**
   * A wake came due. The same route the idle transitions take, and the same
   * route React Native's own WebSocket module delivers `websocketMessage` on —
   * which is the evidence that this reaches JS while the Activity is paused:
   * the device checks' first four probes are messages decrypted and announced by a
   * backgrounded app, and every one of them arrived through this emitter.
   */
  private fun emitWake(id: Int) {
    val context = reactApplicationContext
    try {
      if (!context.hasActiveReactInstance()) return
      context.emitDeviceEvent(EVENT_WAKE, id.toDouble())
    } catch (torn: Exception) {
      // Same as above: the wake's JS half went with the instance, and the
      // `setTimeout` armed beside it is what the next foreground will run.
    }
  }

  /**
   * POST_NOTIFICATIONS, from API 33, asked for at the moment it is used rather
   * than at launch — the manifest's own rule for the dangerous permissions.
   *
   * Refusing it is a normal outcome: the socket still runs and messages still
   * arrive, but the foreground service's ongoing notification is not shown, so
   * the platform's own task manager becomes the only place the connection is
   * visible. Nothing here is load-bearing for delivery.
   */
  private fun requestPostNotificationsIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = reactApplicationContext
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED) {
      return
    }
    val activity = reactApplicationContext.currentActivity ?: return
    try {
      activity.requestPermissions(
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          PERMISSION_REQUEST,
      )
    } catch (refused: Exception) {
      // An activity that will not take a permission request (finishing, or
      // already showing one) is not an error: the next session asks again.
    }
  }

  companion object {
    const val NAME = "TacendumMessaging"

    /** The device event app/src/background.ts subscribes to. */
    const val EVENT_DEVICE_IDLE = "TacendumMessagingDeviceIdle"

    /** The other one: a reconnect wake came due, carrying its id. */
    const val EVENT_WAKE = "TacendumMessagingWake"

    private const val PERMISSION_REQUEST = 4902

    /**
     * One serial executor, off the native-modules thread: the notifier reads
     * and writes small files, and a delivery burst must not queue behind
     * anything else the bridge is doing. Daemon so it never holds up process
     * exit — the tacendum-crypto module's reasoning, applied to a much smaller
     * amount of work.
     */
    private val QUEUE =
        Executors.newSingleThreadExecutor { runnable ->
          Thread(runnable, "com.tacendum.messaging").apply { isDaemon = true }
        }
  }
}
