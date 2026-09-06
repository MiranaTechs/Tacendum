package com.miranatechnologies.tacendum.crypto

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

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
 *      parent from the SYSTEM setting. That frame is the system's reading
 *      of light or dark, not this key's: nothing native reads these
 *      preferences pre-JS. (An earlier version of this comment claimed the
 *      screen-security cover path did, "exactly as ScreenSecurityImpl.swift
 *      reads the shared NSUserDefaults key on iOS". It does not, and no
 *      Swift file under app/modules references NSUserDefaults at all. The
 *      record was false; this is what actually happens.)
 *   2. `getConstants()` puts the stored choice on the module object, so the
 *      JS branch (appearance.ts) reads it SYNCHRONOUSLY at module init and
 *      the first rendered frame is already in the chosen palette. This runs
 *      on the JS thread at init, which is why it stays exactly one
 *      `getString` — no parsing, no second file, no work.
 *   3. `getAppearance()` remains as the async fallback for any build where
 *      the constant is absent, and `setAppearance()` is the write.
 *
 * A person who chose a palette the system disagrees with still sees one
 * frame of the system's ground at step 1 — the honest limit of a launch
 * theme, and the same one iOS's storyboard has. What step 2 removes is the
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
   * require time (step 2 above). Legacy-bridge constants are read on the JS
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
  }

  companion object {
    const val NAME = "TacendumAppearance"
    /** The constant's name on the JS module object; appearance.ts reads it
     * verbatim. */
    const val CONSTANT_INITIAL = "initialAppearance"
    /** One preferences file, so this accessor and anything that later reads
     * the choice natively cannot drift apart. Nothing reads it before JS
     * today — see the launch order above. */
    const val PREFS_NAME = "tacendum"
    /** Shared verbatim with appearance.ts, whose iOS arm keeps the same key
     * in NSUserDefaults through RN `Settings`. No Swift file reads it:
     * ScreenSecurityImpl.swift's cover paints the light paperGround from a
     * literal (`:158`), which is a separate owed fix, not this key. */
    const val KEY = "tacendum.appearance"
  }
}
