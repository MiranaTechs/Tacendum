package com.miranatechnologies.tacendum.crypto

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which appearance the navigation bar takes for a stored choice.
 *
 * The bar is painted natively (MainActivity, and every Settings change
 * through `setAppearance`) while the screen is painted by JS, so the two
 * resolve the same stored value independently. If they disagree, the bar
 * frames the screen in the other palette. These cases are App.tsx's
 * resolution and appearance.ts's default, restated: "dark" is dark,
 * "system" follows the phone, and "light", "" (never stored) and anything
 * unrecognised are light.
 */
class AppearanceNavigationBarTest {

  @Test
  fun `light, never stored and unrecognised are light whatever the phone says`() {
    for (choice in listOf("light", "", "blue", "Dark")) {
      for (systemNight in listOf(false, true)) {
        assertEquals(
            "choice '$choice' with the phone at night=$systemNight",
            false,
            AppearancePrefsModule.drawsDark(choice, systemNight),
        )
      }
    }
  }

  @Test
  fun `dark is dark whatever the phone says`() {
    assertEquals(true, AppearancePrefsModule.drawsDark("dark", false))
    assertEquals(true, AppearancePrefsModule.drawsDark("dark", true))
  }

  @Test
  fun `system follows the phone`() {
    assertEquals(false, AppearancePrefsModule.drawsDark("system", false))
    assertEquals(true, AppearancePrefsModule.drawsDark("system", true))
  }
}
