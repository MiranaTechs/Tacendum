package com.miranatechnologies.tacendum.call

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * What the call module's manifest declares.
 *
 * `BLUETOOTH_CONNECT` used to be declared here (A8, f8be8fd) on the belief
 * that `AudioManager.availableCommunicationDevices` could not see a headset
 * without it. It can: the route matrix (`CallAudioGate.applyRoute`) reads
 * devices by TYPE and selects one by port id, and `BLUETOOTH_CONNECT` gates
 * the `android.bluetooth.*` APIs and the headset's MAC-address STRING —
 * nothing this module reads. A runtime permission that is declared and never
 * requested is a Play-review question with no answer, so the pin reads the
 * manifest SOURCE and refuses the declaration's return.
 *
 * `USE_FULL_SCREEN_INTENT` is pinned PRESENT beside it: the ring's
 * full-screen path is a manifest permission plus a runtime app-op, and
 * losing the manifest half would degrade every locked-phone ring to a
 * heads-up card with nothing to say why.
 *
 * Read as a file, deliberately — the merged manifest is a build output. The
 * path is module-relative because Gradle runs unit tests with the module
 * directory as the working directory. */
class CallModuleManifestTest {

  private val manifest = File("src/main/AndroidManifest.xml")

  private fun declaredPermissions(): Set<String> {
    assertTrue("manifest not found at ${manifest.absolutePath}", manifest.isFile)
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = true
    val document = factory.newDocumentBuilder().parse(manifest)
    val nodes = document.getElementsByTagName("uses-permission")
    val names = HashSet<String>()
    for (i in 0 until nodes.length) {
      names.add((nodes.item(i) as Element).getAttributeNS(ANDROID_NS, "name"))
    }
    return names
  }

  @Test
  fun bluetoothConnectIsNotDeclared() {
    assertFalse(
        "BLUETOOTH_CONNECT is declared but nothing requests or needs it",
        declaredPermissions().contains("android.permission.BLUETOOTH_CONNECT"),
    )
  }

  @Test
  fun theFullScreenIntentPermissionIsDeclared() {
    assertTrue(declaredPermissions().contains("android.permission.USE_FULL_SCREEN_INTENT"))
  }

  private companion object {
    const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
  }
}
