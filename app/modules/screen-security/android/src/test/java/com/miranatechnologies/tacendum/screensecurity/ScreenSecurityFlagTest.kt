package com.miranatechnologies.tacendum.screensecurity

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import androidx.test.core.app.ApplicationProvider
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.WritableMap
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import java.lang.reflect.Proxy
import java.util.concurrent.Executor
import java.util.function.Consumer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The screen-security pins.
 *
 * Three claims, and each is written so that the cheap wrong implementation
 * FAILS it rather than passing quietly:
 *
 *  1. `FLAG_SECURE` is on the window BEFORE the first frame. The activity is
 *     driven only as far as `create()` — never started, never resumed, never
 *     made visible — so a flag applied in `onResume`, or after
 *     `setContentView`, is not yet set when the assertion runs.
 *  2. Below API 35 `getIsCaptured` is a constant `false` and nothing is
 *     registered anywhere. `@Config(sdk = [34])` is what makes "below" real.
 *  3. On API 35 the module actually REGISTERS a screen-recording callback,
 *     and firing that callback reaches `onCapturedChanged` and moves
 *     `getIsCaptured`. This is the assertion a constant-false implementation
 *     cannot survive: the emulator probe only ever observes
 *     an idle device, where constant-false and correct are indistinguishable,
 *     so if this test did not exist nothing else would notice the
 *     difference.
 *
 * The two seams the tests use — [ScreenSecurityModule.windowManager] and
 * [ScreenSecurityModule.emitCapturedChanged] — are the only things replaced.
 * The SDK branch, the idempotence, the seeding of the cached state from the
 * registration return value and the mapping of the state constant all run for
 * real.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScreenSecurityFlagTest {

  // ── 1. the flag, before the first frame ──────────────────────────────────

  /**
   * Mirrors `MainActivity.onCreate` exactly: the module helper first, `super`
   * second. A plain `Activity`, not `ReactActivity`, because what is under
   * test is the window flag and its timing — dragging a React instance into a
   * host-JVM test would prove nothing extra and would not run.
   */
  class SecureFlagProbeActivity : Activity() {
    var secureAtSuperOnCreate = false

    override fun onCreate(savedInstanceState: Bundle?) {
      ScreenSecurity.applySecureFlag(window)
      secureAtSuperOnCreate = isSecure(window.attributes.flags)
      super.onCreate(savedInstanceState)
    }
  }

  @Test
  fun `the window is secure after create, before start and resume`() {
    val controller = Robolectric.buildActivity(SecureFlagProbeActivity::class.java)
    // create() ONLY. onStart/onResume/visible() are where a frame could
    // first be drawn, and none of them has run at the assertion below.
    val activity = controller.create().get()

    assertTrue(
        "FLAG_SECURE must be on the window as soon as onCreate has run",
        isSecure(activity.window.attributes.flags),
    )
    assertTrue(
        "FLAG_SECURE must already be set when super.onCreate() takes the window",
        activity.secureAtSuperOnCreate,
    )
  }

  @Test
  fun `applySecureFlag leaves the other window flags alone`() {
    val activity = Robolectric.buildActivity(SecureFlagProbeActivity::class.java).create().get()
    val before = activity.window.attributes.flags
    ScreenSecurity.applySecureFlag(activity.window)
    assertEquals(
        "the helper owns exactly one bit and must not clear its neighbours",
        before,
        activity.window.attributes.flags,
    )
  }

  // ── 2. below API 35: constant false, nothing registered ──────────────────

  @Test
  @Config(sdk = [34])
  fun `below api 35 capture is false and no callback is registered`() {
    val windows = RecordingWindowManager(WindowManager.SCREEN_RECORDING_STATE_VISIBLE)
    val module = probeModule(windows.windowManager)

    module.start()
    assertEquals(
        "nothing may be registered on an SDK that has no such API",
        0,
        windows.registrations.size,
    )

    val promise = RecordingPromise()
    module.getIsCaptured(promise)
    assertEquals(
        "below API 35 getIsCaptured is a documented constant false",
        false,
        promise.resolved,
    )
    assertEquals("and it must never reject", null, promise.rejectedCode)
    assertTrue("and it must not emit", module.emitted.isEmpty())
  }

  // ── 3. API 35: registration happens, and firing it reaches JS ────────────

  @Test
  @Config(sdk = [35])
  fun `api 35 registers a screen recording callback`() {
    val windows = RecordingWindowManager(WindowManager.SCREEN_RECORDING_STATE_NOT_VISIBLE)
    val module = probeModule(windows.windowManager)

    module.start()

    assertEquals(
        "start() must register exactly one screen-recording callback on API 35",
        1,
        windows.registrations.size,
    )
    module.start()
    assertEquals(
        "start() is idempotent — a second call must not double-register",
        1,
        windows.registrations.size,
    )
  }

  @Test
  @Config(sdk = [35])
  fun `firing the registered callback emits onCapturedChanged and moves getIsCaptured`() {
    val windows = RecordingWindowManager(WindowManager.SCREEN_RECORDING_STATE_NOT_VISIBLE)
    val module = probeModule(windows.windowManager)
    module.start()

    val idle = RecordingPromise()
    module.getIsCaptured(idle)
    assertEquals("seeded from the registration return value", false, idle.resolved)

    // The device starts recording. This is the line a constant-false
    // implementation cannot answer: it never registered anything, so there is
    // no callback here to fire.
    windows.registrations.single().accept(WindowManager.SCREEN_RECORDING_STATE_VISIBLE)

    assertEquals(
        "the registered callback must reach onCapturedChanged",
        listOf(true),
        module.emitted,
    )
    val recording = RecordingPromise()
    module.getIsCaptured(recording)
    assertEquals("and must move the value getIsCaptured reports", true, recording.resolved)

    // ...and back again, so the mapping is a mapping and not a latch.
    windows.registrations.single().accept(WindowManager.SCREEN_RECORDING_STATE_NOT_VISIBLE)
    assertEquals(listOf(true, false), module.emitted)
    val stopped = RecordingPromise()
    module.getIsCaptured(stopped)
    assertEquals(false, stopped.resolved)
  }

  @Test
  @Config(sdk = [35])
  fun `api 35 reports a device that is already recording`() {
    val windows = RecordingWindowManager(WindowManager.SCREEN_RECORDING_STATE_VISIBLE)
    val module = probeModule(windows.windowManager)
    module.start()

    val promise = RecordingPromise()
    module.getIsCaptured(promise)
    assertEquals(
        "a recording that started before the app did is still a recording",
        true,
        promise.resolved,
    )
    assertNotEquals(
        "and the two recording states must not be the same constant",
        WindowManager.SCREEN_RECORDING_STATE_VISIBLE,
        WindowManager.SCREEN_RECORDING_STATE_NOT_VISIBLE,
    )
  }

  @Test
  @Config(sdk = [35])
  fun `api 35 without a window manager answers false rather than throwing`() {
    val module = probeModule(null)
    module.start()
    val promise = RecordingPromise()
    module.getIsCaptured(promise)
    assertEquals(false, promise.resolved)
    assertEquals(null, promise.rejectedCode)
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private fun probeModule(windows: WindowManager?): ProbeModule =
      ProbeModule(TestReactContext(), windows)

  private companion object {
    fun isSecure(flags: Int): Boolean =
        flags and WindowManager.LayoutParams.FLAG_SECURE != 0
  }

  /**
   * The real module with its two seams redirected: the WindowManager it
   * registers against, and the last JNI hop to JS (which cannot exist on a
   * host JVM — `emitOnCapturedChanged` goes through a native callback that is
   * only wired by the TurboModule runtime).
   */
  private class ProbeModule(
      context: ReactApplicationContext,
      private val windows: WindowManager?,
  ) : ScreenSecurityModule(context) {
    val emitted = mutableListOf<Boolean>()

    override fun windowManager(): WindowManager? = windows

    override fun emitCapturedChanged(captured: Boolean) {
      emitted += captured
    }
  }

  /**
   * A `WindowManager` that records screen-recording registrations.
   *
   * Built with `java.lang.reflect.Proxy` rather than by implementing the
   * interface: `addScreenRecordingCallback` and its partner are `default`
   * methods on the interface, so a hand-written stand-in would have to track
   * every unrelated method the platform adds to `WindowManager` in a future
   * SDK. Anything this test does not expect throws, which is itself an
   * assertion — the module may not reach for some other part of the interface.
   */
  private class RecordingWindowManager(private val stateAtRegistration: Int) {
    val registrations = mutableListOf<Consumer<Int>>()
    val executors = mutableListOf<Executor>()
    var removals = 0

    val windowManager: WindowManager =
        Proxy.newProxyInstance(
            WindowManager::class.java.classLoader,
            arrayOf<Class<*>>(WindowManager::class.java),
        ) { _, method, args ->
          when (method.name) {
            "addScreenRecordingCallback" -> {
              executors += args!![0] as Executor
              @Suppress("UNCHECKED_CAST")
              registrations += args[1] as Consumer<Int>
              stateAtRegistration
            }
            "removeScreenRecordingCallback" -> {
              @Suppress("UNCHECKED_CAST")
              registrations -= args!![0] as Consumer<Int>
              removals += 1
              null
            }
            "toString" -> "RecordingWindowManager"
            "hashCode" -> System.identityHashCode(this)
            "equals" -> false
            else -> throw UnsupportedOperationException(method.name)
          }
        } as WindowManager
  }

  /** A `Promise` that keeps what it was told instead of crossing the bridge. */
  private class RecordingPromise : Promise {
    var resolved: Any? = null
    var rejectedCode: String? = null

    override fun resolve(value: Any?) {
      resolved = value
    }

    private fun record(code: String?) {
      rejectedCode = code ?: "EUNSPECIFIED"
    }

    override fun reject(code: String?, message: String?) = record(code)

    override fun reject(code: String?, throwable: Throwable?) = record(code)

    override fun reject(code: String?, message: String?, throwable: Throwable?) = record(code)

    override fun reject(throwable: Throwable) = record(null)

    override fun reject(throwable: Throwable, userInfo: WritableMap) = record(null)

    override fun reject(code: String?, userInfo: WritableMap) = record(code)

    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) = record(code)

    override fun reject(code: String?, message: String?, userInfo: WritableMap) = record(code)

    override fun reject(
        code: String?,
        message: String?,
        throwable: Throwable?,
        userInfo: WritableMap?,
    ) = record(code)

    @Deprecated("Prefer a module-specific error code.", ReplaceWith("reject(code, message)"))
    override fun reject(message: String) = record(null)
  }

  /**
   * The smallest thing that is a `ReactApplicationContext`.
   *
   * `ReactApplicationContext` is abstract in RN 0.86 and its concrete
   * subclasses drag in a React instance, so this stubs the instance-facing
   * half: the module under test only ever uses the Context half, and anything
   * else throwing is a statement that it must stay that way.
   */
  private class TestReactContext :
      ReactApplicationContext(ApplicationProvider.getApplicationContext()) {
    private fun unavailable(): Nothing =
        throw UnsupportedOperationException("no React instance in a host-JVM test")

    override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T = unavailable()

    override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean =
        false

    override fun getNativeModules(): Collection<NativeModule> = emptyList()

    override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? = null

    override fun getNativeModule(moduleName: String): NativeModule? = null

    override fun getCatalystInstance(): CatalystInstance = unavailable()

    override fun hasActiveCatalystInstance(): Boolean = false

    override fun hasActiveReactInstance(): Boolean = false

    override fun hasCatalystInstance(): Boolean = false

    override fun hasReactInstance(): Boolean = false

    override fun destroy() = Unit

    override fun handleException(e: Exception) = throw e

    override fun isBridgeless(): Boolean = true

    override fun getJavaScriptContextHolder(): JavaScriptContextHolder = unavailable()

    override fun getJSCallInvokerHolder(): CallInvokerHolder = unavailable()

    override fun getFabricUIManager(): UIManager = unavailable()

    override fun getSourceURL(): String = ""

    override fun registerSegment(segmentId: Int, path: String, callback: Callback) = unavailable()
  }
}
