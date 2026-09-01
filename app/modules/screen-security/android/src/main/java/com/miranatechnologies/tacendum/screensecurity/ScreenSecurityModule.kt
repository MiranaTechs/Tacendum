package com.miranatechnologies.tacendum.screensecurity

import android.os.Build
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.util.concurrent.Executor
import java.util.function.Consumer

/**
 * Screen security on Android.
 *
 * THE POSTURE IS INVERTED FROM iOS, DELIBERATELY. The iOS module observes:
 * it reports `UIScreen.isCaptured` so JS can blank live content, and reports
 * screenshots after the fact so the conversation can disclose them, because
 * iOS gives an app no way to prevent either. Android does give one, so Android
 * takes it — `FLAG_SECURE` goes on the window in `MainActivity.onCreate`
 * before the first frame (see [ScreenSecurity]) and never comes off. Blocked
 * beats disclosed.
 *
 * WHAT THAT COSTS, STATED RATHER THAN HIDDEN:
 *
 *  - `onScreenshot` NEVER FIRES on Android. It is not a missing implementation
 *    and it is not a to-do: with `FLAG_SECURE` set the system refuses the
 *    screenshot, so there is no screenshot to disclose. "Prevented, not
 *    disclosed" is the whole sentence — the disclosure feature is
 *    structurally unreachable exactly because the stronger protection is on.
 *    The Settings copy says the same thing in the same words.
 *  - `getIsCaptured` is real only from API 35, where
 *    `WindowManager.addScreenRecordingCallback` exists; below that the
 *    platform offers an app no way to learn it is being recorded, and this
 *    module answers a constant `false` rather than guessing. That is safe
 *    here for the same reason: a recording of this app records a black
 *    rectangle whether or not JS knew to blank it. On iOS the same `false`
 *    would be a lie with consequences; on Android it is a statement about an
 *    unobservable that has already been neutralised.
 *
 * Nothing here logs and nothing here touches a payload.
 */
open class ScreenSecurityModule(reactContext: ReactApplicationContext) :
    NativeScreenSecuritySpec(reactContext) {

  /**
   * API 35 — the release that first lets an app learn it is being recorded.
   * Named through `VERSION_CODES` rather than as a bare 35 so the static
   * analysers recognise every call below as guarded; the unit test pins both
   * sides of the branch with `@Config(sdk = [34])` and `@Config(sdk = [35])`.
   */
  private companion object {
    const val RECORDING_CALLBACK_API = Build.VERSION_CODES.VANILLA_ICE_CREAM
  }

  /**
   * Callbacks are delivered on whatever thread this runs them on; the emitter
   * is thread-safe and JS is reached through it, so the work is a single
   * boolean comparison and there is nothing to hop a looper for.
   */
  private val callbackExecutor = Executor { command -> command.run() }

  private var recordingCallback: Consumer<Int>? = null
  private var captured = false

  /**
   * Begin reporting capture state. Idempotent, and a no-op below API 35 where
   * there is nothing to observe.
   *
   * This does NOT arm `FLAG_SECURE`: the flag is on the window from
   * `MainActivity.onCreate`, which runs long before any JS can call this, and
   * routing protection through a JS-initiated call would leave the first
   * frames of a cold launch unprotected — the exact window the always-on
   * design exists to close.
   */
  override fun start() {
    if (Build.VERSION.SDK_INT < RECORDING_CALLBACK_API) return
    if (recordingCallback != null) return
    val windows = windowManager() ?: return
    val callback = Consumer<Int> { state -> onRecordingState(state) }
    // The registration return value IS the current state, so arming and
    // seeding are one call and cannot disagree with each other.
    val initial =
        try {
          windows.addScreenRecordingCallback(callbackExecutor, callback)
        } catch (_: Throwable) {
          // Missing DETECT_SCREEN_RECORDING, or a device whose WindowManager
          // does not implement it. Unobservable, not unprotected: the window
          // is already secure, so this stays quiet and answers false.
          return
        }
    recordingCallback = callback
    captured = initial == WindowManager.SCREEN_RECORDING_STATE_VISIBLE
  }

  private fun onRecordingState(state: Int) {
    val now = state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE
    captured = now
    emitCapturedChanged(now)
  }

  /**
   * Current capture state.
   *
   * Below API 35 this is a constant `false` (see the class comment). From 35
   * it is the live value: the cached one once [start] has armed the callback,
   * and otherwise a one-shot register/unregister, because the registration
   * return value is the current state and a caller that never called [start]
   * still deserves the truth rather than a default.
   *
   * A failure resolves `false` rather than rejecting. That is the one place
   * this module defaults instead of throwing, and it is allowed
   * here because `false` does not unlock anything: the protection is the
   * window flag, which is already on, and this value only decides whether JS
   * draws its own extra cover over content the recorder cannot see anyway.
   */
  override fun getIsCaptured(promise: Promise) {
    if (Build.VERSION.SDK_INT < RECORDING_CALLBACK_API) {
      promise.resolve(false)
      return
    }
    if (recordingCallback != null) {
      promise.resolve(captured)
      return
    }
    val windows = windowManager()
    if (windows == null) {
      promise.resolve(false)
      return
    }
    val probe = Consumer<Int> {}
    val state =
        try {
          windows.addScreenRecordingCallback(callbackExecutor, probe)
        } catch (_: Throwable) {
          promise.resolve(false)
          return
        }
    try {
      windows.removeScreenRecordingCallback(probe)
    } catch (_: Throwable) {
      // Nothing to undo if it never took.
    }
    promise.resolve(state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE)
  }

  /** Drop the registration when the module goes away (reload, shutdown). */
  override fun invalidate() {
    val callback = recordingCallback
    recordingCallback = null
    if (callback != null && Build.VERSION.SDK_INT >= RECORDING_CALLBACK_API) {
      try {
        windowManager()?.removeScreenRecordingCallback(callback)
      } catch (_: Throwable) {
        // Already gone, or never took.
      }
    }
    super.invalidate()
  }

  /**
   * The WindowManager the recording callback is registered against.
   *
   * A seam, and the narrowest one that works: `WindowManager` is an interface
   * whose screen-recording methods are `default` and throw
   * `UnsupportedOperationException` on anything that does not implement them,
   * so a unit test can hand this a recording stand-in and hold the real
   * registration logic — the SDK branch, the idempotence, the seeding from the
   * return value — to account without a device. Overridden nowhere in shipped
   * code.
   */
  protected open fun windowManager(): WindowManager? =
      reactApplicationContext.getSystemService(WindowManager::class.java)

  /**
   * The last hop to JS, isolated for the same reason: `emitOnCapturedChanged`
   * is generated `final` and goes straight through a JNI callback that does
   * not exist on a host JVM, so this is the boundary a test can stand at
   * without stubbing anything that decides behaviour.
   */
  protected open fun emitCapturedChanged(captured: Boolean) {
    emitOnCapturedChanged(captured)
  }
}
