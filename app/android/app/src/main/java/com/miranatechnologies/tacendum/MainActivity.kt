package com.miranatechnologies.tacendum

import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.miranatechnologies.tacendum.crypto.AppearancePrefsModule
import com.miranatechnologies.tacendum.screensecurity.ScreenSecurity

class MainActivity : ReactActivity() {

  /**
   * FLAG_SECURE goes on this window here — always on, no setting, and before
   * anything is drawn (blocked beats disclosed).
   *
   * BEFORE `super.onCreate`, deliberately. `super.onCreate` is where
   * ReactActivityDelegate builds the root view and the window starts its first
   * traversal; a flag applied after it, or in `onResume`, leaves a window that
   * is capturable for the frames nobody watches. `getWindow()` is already live
   * at this point — the activity was attached before `onCreate` was called —
   * so this is the earliest moment the flag can exist and the last one that is
   * still earlier than every frame.
   *
   * The consequence is recorded rather than hidden: with the window secure the
   * system refuses screenshots outright, so `onScreenshot` can never fire on
   * Android and the screenshot-DISCLOSURE feature is unreachable. Prevented,
   * not disclosed (Settings says the same sentence).
   *
   * The navigation bar takes the person's own appearance choice AFTER
   * `super.onCreate`, never before: that call builds the window (and, on
   * Android 15+, makes it edge-to-edge with the bar's icons in the SYSTEM's
   * tone), so this is the first moment the choice can win, and it is still
   * before the window is first shown (that happens at resume). Nothing in JS
   * can reach that bar; the launch theme can only follow the system's day or
   * night.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    ScreenSecurity.applySecureFlag(window)
    super.onCreate(savedInstanceState)
    restoreAdjustResizeUnderEnforcedEdgeToEdge()
    AppearancePrefsModule.applyNavigationBar(this)
  }

  /**
   * A system day/night switch arrives HERE rather than relaunching the
   * activity, because `uiMode` is in its configChanges, so the launch
   * theme's bar is never re-read. The stored choice decides what the
   * navigation bar does with it: under "light" or "dark" it repaints the
   * same bar; under "system" it follows [newConfig].
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    AppearancePrefsModule.applyNavigationBar(this, newConfig)
  }

  /**
   * THE KEYBOARD RESIZE THE MANIFEST CLAIMS, MADE TRUE AGAIN ON ANDROID 15+.
   *
   * `windowSoftInputMode="adjustResize"` stopped describing behavior the day
   * this app's targetSdk crossed 35: Android 15 ENFORCES edge-to-edge for
   * such apps, an edge-to-edge window is exactly the case the platform
   * documents `SOFT_INPUT_ADJUST_RESIZE` as IGNORED for, and the old
   * premise — "the window already resizes; a manual inset would be double
   * compensation" — was therefore false on every Android 15+ device.
   * Measured on a Pixel Tablet API 35 emulator, both
   * orientations: IME up, `mInputShown=true`, and the React window still
   * reported the full 1600x2560 — the composer laid out at the un-resized
   * window bottom, OCCLUDED behind the keyboard, with typing landing in a
   * field nobody can see. The phone rig never showed it only because its
   * AVD's Gboard sits in hardware-keyboard mode and never raises the full
   * IME; a real phone does.
   *
   * The restoration is the smallest one that makes the manifest's claim true:
   * pad the activity's content view by exactly the IME inset while the IME is
   * visible, so the React root resizes precisely as adjustResize used to
   * resize it. Zero when the IME is hidden — every existing layout is
   * byte-identical — and gated to API 35+, where enforcement is what
   * disabled the native resize; below 35 this window is not edge-to-edge
   * (`edgeToEdgeEnabled=false` still means something there) and adjustResize
   * still works, so installing the pad there would be the double
   * compensation that premise warned about. NOT fixed by flipping `edgeToEdgeEnabled`
   * instead: that re-plumbs system-bar handling on every screen — a shell
   * decision, not a keyboard fix — and NOT in JS: the gate keeping the
   * JS keyboard inset OFF on Android is CORRECT again the moment the window
   * resizes for real. The default insets dispatch is preserved
   * (`view.onApplyWindowInsets`), so children keep seeing what they see
   * today.
   */
  private fun restoreAdjustResizeUnderEnforcedEdgeToEdge() {
    if (Build.VERSION.SDK_INT < 35) return
    val content = findViewById<View>(android.R.id.content) ?: return
    content.setOnApplyWindowInsetsListener { view, insets ->
      val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
      if (view.paddingBottom != ime) {
        view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, ime)
      }
      view.onApplyWindowInsets(insets)
    }
    content.requestApplyInsets()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Tacendum"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
