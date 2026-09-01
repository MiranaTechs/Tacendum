package com.miranatechnologies.tacendum.crypto

import java.io.File
import org.json.JSONObject

/**
 * The shared cross-client fixtures, read from `packages/shared/`.
 *
 * The repo root arrives as a system property set by the module's Gradle
 * `testOptions` — never derived from the process working directory, which
 * differs between a Gradle run, an IDE run, and a script run.
 *
 * [require] is not politeness: a fixture that cannot be found must FAIL the
 * suite, never silently reduce it to zero cases. The vector suites in this
 * module are the only thing standing between a byte-format divergence and a
 * silent cross-client break, and a suite that certifies parity over an empty
 * list is worse than no suite.
 */
internal object Fixtures {
  private val repoRoot: File by lazy {
    val configured =
        System.getProperty("tacendum.repoRoot")
            ?: throw AssertionError(
                "tacendum.repoRoot is not set — the Gradle testOptions block that sets it is gone")
    File(configured).also {
      if (!it.isDirectory) throw AssertionError("tacendum.repoRoot does not exist: $configured")
    }
  }

  fun require(relativePath: String): JSONObject {
    val file = File(repoRoot, relativePath)
    if (!file.isFile) {
      throw AssertionError("missing shared fixture: $relativePath")
    }
    return JSONObject(file.readText(Charsets.UTF_8))
  }

  fun hex(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) {
      out.append(String.format("%02x", b))
    }
    return out.toString()
  }

  fun unhex(text: String): ByteArray {
    require(text.length % 2 == 0) { "hex string must have an even length" }
    val out = ByteArray(text.length / 2)
    for (i in out.indices) {
      out[i] = text.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    }
    return out
  }
}
