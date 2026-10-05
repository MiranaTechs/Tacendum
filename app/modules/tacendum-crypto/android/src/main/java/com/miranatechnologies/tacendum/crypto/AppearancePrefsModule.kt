package com.miranatechnologies.tacendum.crypto

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.WindowInsetsController
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * The appearance accessor: the `tacendum.appearance` choice persisted in
 * SharedPreferences, because RN's `Settings` is iOS-only (its Android
 * fallback warn-and-returns-null).
 *
 * HOW THE CHOICE REACHES THE SCREEN, in the order a launch happens.
 *
 *   1. Before any of our code runs, the window is painted by the theme's
 *      `android:windowBackground` — paperGround in `values/styles.xml`, its
 *      dark twin in `values-night/styles.xml`, resolved by the DayNight
 *      parent from the SYSTEM setting — and both system bars by the same
 *      theme. That frame is the system's reading of light or dark, not this
 *      key's: a launch theme cannot read preferences. (An earlier version of
 *      this comment claimed the screen-security cover path read this key,
 *      "exactly as ScreenSecurityImpl.swift reads the shared NSUserDefaults
 *      key on iOS". It does not, and no Swift file under app/modules
 *      references NSUserDefaults at all. The record was false; this is what
 *      actually happens.)
 *   2. `MainActivity.onCreate`, before the window is first shown, reads
 *      this key natively for one thing: the navigation bar
 *      ([applyNavigationBar]). Nothing in JS can reach that bar (RN's
 *      StatusBar covers the status bar only), so without this it kept the
 *      system's day or night for the whole session, whatever the person
 *      chose, and on API 26, where the theme cannot ask for dark buttons,
 *      it showed the platform's white buttons on the white bar.
 *   3. `getConstants()` puts the stored choice on the module object, so the
 *      JS branch (appearance.ts) reads it SYNCHRONOUSLY at module init and
 *      the first rendered frame is already in the chosen palette. This runs
 *      on the JS thread at init, which is why it stays exactly one
 *      `getString` — no parsing, no second file, no work.
 *   4. `getAppearance()` remains as the async fallback for any build where
 *      the constant is absent, and `setAppearance()` is the write, which
 *      also repaints the navigation bar at once.
 *
 * A person who chose a palette the system disagrees with still sees one
 * frame of the system's ground at step 1 — the honest limit of a launch
 * theme, and the same one iOS's storyboard has. What step 3 removes is the
 * SECOND jump, which was ours.
 *
 * DELIBERATELY NOT the secret store: the appearance choice is not a
 * secret, must be identical across the real and duress workspaces, and must
 * be readable without constructing the Keystore cipher. SharedPreferences is
 * covered by the app's full backup exclusion (`sharedpref` domain, both
 * rules files), so the choice still never leaves the device.
 *
 * A plain (non-codegen) module on purpose: the surface is Android-only, and
 * the shared TurboModule specs must not grow methods iOS never implements.
 * No cryptography in this file.
 */
class AppearancePrefsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private fun prefs() =
      reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /**
   * The stored choice, delivered as a module constant so JS has it at
   * require time (step 3 above). Legacy-bridge constants are read on the JS
   * thread while the bundle loads, so this does ONE `getString` and nothing
   * else; a failed read is '' — the same "never stored" the async path
   * uses, which leaves the JS default standing rather than guessing.
   */
  override fun getConstants(): MutableMap<String, Any> =
      hashMapOf(CONSTANT_INITIAL to storedChoice())

  private fun storedChoice(): String =
      try {
        prefs().getString(KEY, "") ?: ""
      } catch (err: Exception) {
        ""
      }

  /** The stored choice, or '' when none was ever stored (absence is a
   * state — the JS side keeps its default). */
  @ReactMethod
  fun getAppearance(promise: Promise) {
    try {
      promise.resolve(prefs().getString(KEY, "") ?: "")
    } catch (err: Exception) {
      promise.reject("appearance_error", "appearance read failed", err)
    }
  }

  @ReactMethod
  fun setAppearance(value: String, promise: Promise) {
    if (value != "light" && value != "dark" && value != "system") {
      promise.reject("appearance_error", "invalid appearance value")
      return
    }
    try {
      prefs().edit().putString(KEY, value).apply()
      promise.resolve(null)
    } catch (err: Exception) {
      promise.reject("appearance_error", "appearance write failed", err)
    }
    // The navigation bar follows the new choice at once, whatever the write
    // did: JS has already repainted the screen in the new palette, and the
    // bar must not frame it in the old one. Queued after the write, so a
    // configuration change that re-reads the stored choice sees this one.
    // Window changes belong on the UI thread; this method runs on the
    // native-modules thread.
    UiThreadUtil.runOnUiThread {
      val activity = reactApplicationContext.currentActivity
      if (activity != null) {
        applyNavigationBar(activity, value, activity.resources.configuration)
      }
    }
  }

  companion object {
    const val NAME = "TacendumAppearance"
    /** The constant's name on the JS module object; appearance.ts reads it
     * verbatim. */
    const val CONSTANT_INITIAL = "initialAppearance"
    /** One preferences file, so this accessor and the one native reader of
     * the choice, [applyNavigationBar] (called from MainActivity before JS
     * exists, step 2 above), cannot drift apart. */
    const val PREFS_NAME = "tacendum"
    /** Shared verbatim with appearance.ts, whose iOS arm keeps the same key
     * in NSUserDefaults through RN `Settings`. No Swift file reads it:
     * ScreenSecurityImpl.swift's cover paints the light paperGround from a
     * literal (`:158`), which is a separate owed fix, not this key. */
    const val KEY = "tacendum.appearance"

    /**
     * theme.ts's `paperGround`, light and dark: the navigation bar's ground
     * in each appearance. app/__tests__/native.palette.test.ts reads both
     * back and compares them with theme.ts, so a palette pass cannot move
     * the screen and leave the bar behind.
     */
    const val NAVIGATION_BAR_LIGHT = "#FFFFFF"
    const val NAVIGATION_BAR_DARK = "#141414"

    /**
     * Whether the app draws dark for a stored [choice], resolved the way
     * App.tsx resolves it: "dark" is dark, "system" follows the phone's
     * night mode, and "light", "" (never stored) and anything unrecognised
     * are light, appearance.ts's default.
     */
    fun drawsDark(choice: String, systemNight: Boolean): Boolean =
        when (choice) {
          "dark" -> true
          "system" -> systemNight
          else -> false
        }

    /**
     * Paints [activity]'s navigation bar for the stored choice: the light
     * paperGround with dark icons, or the dark one with light icons. Call on
     * the UI thread, after `super.onCreate` (which builds the window and, on
     * Android 15+, makes it edge-to-edge with the bar's icons in the
     * SYSTEM's tone), and again from `onConfigurationChanged` with the new
     * [configuration]: `uiMode` is in MainActivity's configChanges, so a
     * system day/night switch arrives there instead of relaunching, and
     * under "system" the bar must follow it.
     */
    fun applyNavigationBar(
        activity: Activity,
        configuration: Configuration = activity.resources.configuration,
    ) {
      val choice =
          try {
            activity
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY, "") ?: ""
          } catch (err: Exception) {
            ""
          }
      applyNavigationBar(activity, choice, configuration)
    }

    /**
     * The icon tone is set here, in code, for every mode: the theme's
     * `windowLightNavigationBar` exists only from API 27, and minSdk is 26,
     * where the theme's white bar kept the platform's white buttons.
     *
     * Two mechanisms set it, and which one is safe depends on who else is
     * driving the window. Once anything calls the insets controller's
     * `setSystemBarsAppearance`, the platform stops reading the legacy
     * system-UI light flags for that window, the status bar's included.
     *   - Android 11 and below: the legacy flag, always. React Native's
     *     StatusBar sets the status bar's icons with the legacy flag there,
     *     and a controller call would freeze them. (This is also why this
     *     is not WindowInsetsControllerCompat, which calls the controller
     *     on Android 11.)
     *   - Android 12 to 14: the legacy flag until the window is attached,
     *     the controller after. A controller call made earlier is queued
     *     and replayed before the platform reads the theme's legacy flags,
     *     so it would drop the theme's light status bar and leave white
     *     status icons on the white bar until JS restyled them. Once the
     *     window is attached, the controller keeps the status bar's bit as
     *     it is, and RN's StatusBar uses the controller there too.
     *   - Android 15 and later: the controller, always. React Native makes
     *     the window edge-to-edge in `super.onCreate` and queues a
     *     controller call for this bar in the SYSTEM's tone; only a later
     *     controller call overrides it.
     *
     * From Android 15 the bar is also transparent, so the platform ignores
     * the colour (deprecated there, as the legacy flags are from Android 11,
     * hence the suppression); the icon tone still applies, and it also picks
     * the scrim behind three-button navigation.
     */
    @Suppress("DEPRECATION")
    private fun applyNavigationBar(
        activity: Activity,
        choice: String,
        configuration: Configuration,
    ) {
      val systemNight =
          (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
              Configuration.UI_MODE_NIGHT_YES
      val dark = drawsDark(choice, systemNight)
      val window = activity.window
      val decor = window.decorView
      if (Build.VERSION.SDK_INT < 35) {
        window.navigationBarColor =
            Color.parseColor(if (dark) NAVIGATION_BAR_DARK else NAVIGATION_BAR_LIGHT)
      }
      if (Build.VERSION.SDK_INT > Build.VERSION_CODES.R &&
          (Build.VERSION.SDK_INT >= 35 || decor.isAttachedToWindow)) {
        window.insetsController?.setSystemBarsAppearance(
            if (dark) 0 else WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
        )
      } else {
        decor.systemUiVisibility =
            if (dark) {
              decor.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
            } else {
              decor.systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
      }
    }
  }
}
