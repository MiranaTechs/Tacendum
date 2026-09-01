package com.miranatechnologies.tacendum.crypto

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * The appearance accessor: the `tacendum.appearance` choice persisted in
 * SharedPreferences, because RN's `Settings` is iOS-only (its Android
 * fallback warn-and-returns-null) and the choice must be readable by native
 * code before JS runs — the screen-security cover path reads the same
 * preferences file to paint in the chosen palette pre-JS, exactly as
 * ScreenSecurityImpl.swift reads the shared NSUserDefaults key on iOS.
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
    /** One preferences file, named so the pre-JS native reader and this
     * accessor can never drift apart. */
    const val PREFS_NAME = "tacendum"
    /** Shared verbatim with appearance.ts and, on iOS, with
     * ScreenSecurityImpl.swift's NSUserDefaults key. */
    const val KEY = "tacendum.appearance"
  }
}
