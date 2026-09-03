package com.miranatechnologies.tacendum

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The launcher activity's task shape.
 *
 * `MainActivity` is `singleTask` and exported — it has to be both, it is the
 * launcher entry — and on API 26–29 (minSdk is 26, D8) a singleTask activity
 * with the DEFAULT task affinity is the StrandHogg-1 shape: another app that
 * declares this package name as its affinity can plant an activity in our
 * task and be brought forward as if it were ours. `android:taskAffinity=""`
 * is the platform's one-attribute mitigation. It is a manifest attribute, so
 * the pin lives where the attribute lives: this reads the manifest SOURCE and
 * refuses a MainActivity that has lost it.
 *
 * Read as a file, deliberately. The merged manifest is a build output, and a
 * JVM test that needs a build to have happened would go green on a stale one.
 * The path is module-relative because Gradle runs unit tests with the module
 * directory as the working directory. */
class ManifestTaskAffinityTest {

  private val manifest = File("src/main/AndroidManifest.xml")

  private fun mainActivity(): Element {
    assertTrue("manifest not found at ${manifest.absolutePath}", manifest.isFile)
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = true
    val document = factory.newDocumentBuilder().parse(manifest)
    val activities = document.getElementsByTagName("activity")
    for (i in 0 until activities.length) {
      val element = activities.item(i) as Element
      if (element.getAttributeNS(ANDROID_NS, "name") == ".MainActivity") return element
    }
    throw AssertionError("no <activity android:name=\".MainActivity\"> in the manifest")
  }

  @Test
  fun theLauncherActivityIsSingleTask() {
    assertEquals("singleTask", mainActivity().getAttributeNS(ANDROID_NS, "launchMode"))
  }

  @Test
  fun theLauncherActivityOwnsAnEmptyTaskAffinity() {
    val activity = mainActivity()
    assertTrue(
        "MainActivity must declare android:taskAffinity explicitly",
        activity.hasAttributeNS(ANDROID_NS, "taskAffinity"),
    )
    assertEquals("", activity.getAttributeNS(ANDROID_NS, "taskAffinity"))
  }

  private companion object {
    const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
  }
}
