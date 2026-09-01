package com.miranatechnologies.tacendum.screensecurity

import android.view.Window
import android.view.WindowManager

/**
 * The one place the secure-window flag is applied.
 *
 * ANDROID BLOCKS WHERE iOS ONLY WATCHES. iOS cannot stop a screenshot, so the
 * iOS module observes capture and discloses screenshots after the fact.
 * Android can stop both, so it does: with this flag on the window the system
 * refuses to screenshot the app, keeps it out of screen recordings and out of
 * the app-switcher thumbnail, and blanks it on non-secure external displays.
 * Blocked beats disclosed, which is why the flag is unconditional and has no
 * setting — see `ScreenSecurityModule` for what that inversion costs
 * (`onScreenshot` can never fire).
 *
 * It lives here rather than inline in MainActivity so exactly one definition
 * exists and a unit test can hold it to the timing that matters: the flag must
 * be on the window before the first frame is drawn, because a window that is
 * secure only from its second frame has already been captured once.
 */
object ScreenSecurity {

  /**
   * Make [window] uncapturable. Call from `Activity.onCreate` BEFORE
   * `super.onCreate`, which is the last moment that is still earlier than
   * every frame: `setFlags` here is applied while the window is being
   * assembled, so no traversal has run and nothing has reached the compositor.
   *
   * `setFlags` with the flag as its own mask, not `addFlags`: identical for a
   * single bit, but it states that this call decides the bit rather than
   * merely contributing to it.
   */
  @JvmStatic
  fun applySecureFlag(window: Window) {
    window.setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE,
    )
  }
}
