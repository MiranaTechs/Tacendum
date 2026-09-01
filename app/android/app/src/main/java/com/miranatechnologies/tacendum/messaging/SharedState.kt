package com.miranatechnologies.tacendum.messaging

import android.content.Context
import java.io.File

/**
 * The shared-state files, from the side that plays the notification-service
 * extension's role.
 *
 * On iOS these files live in an App Group container because two PROCESSES need
 * them — the app writes, the extension reads. Android has one process, so
 * nothing here crosses a process boundary; what it crosses is a LANGUAGE
 * boundary, and that is enough to make the contract worth restating. The app's
 * JavaScript writes `previews-armed`, `preview-level`, `blocked-peers`,
 * `peer-names`, `group-names` and `badge-base` through the crypto module
 * (TacendumCryptoModule.writeSharedState); this file reads them back at the
 * moment a banner is about to be composed, and writes exactly two of its own:
 * the badge counter and the witness (see PreviewPolicy.armedAndWritable).
 *
 * THE THREE THINGS THAT MUST NOT DRIFT from the crypto module's copy, because
 * a divergence would be a file one side can write and the other cannot read:
 *
 *   * the directory — `filesDir/tacendum-shared`;
 *   * the name allowlist — `[a-z0-9-]{1,64}`, the Appendix's ASCII pin,
 *     deliberately stricter than the shipped Swift check (a recorded divergence);
 *   * the write — bytes into a `<name>.tmp` sibling, then an atomic rename.
 *     The '.' in the temp name is what keeps it unreadable through this API:
 *     the alphabet above has no '.', so `<name>.tmp` is not a valid name.
 *
 * They are restated rather than imported because `AtomicFiles` and `Names` are
 * `internal` to the tacendum-crypto Gradle module and Kotlin's `internal` is
 * module-scoped. The crypto module remains the source of truth; if that
 * contract ever moves, this file moves with it in the same commit.
 *
 * EVERYTHING HERE FAILS CLOSED, exactly as PreviewPolicy.swift does: an
 * unreadable file, a missing directory, an unwritable container all read as
 * "nothing is known", and every caller turns "nothing is known" into "show
 * less". Nothing in this file logs, at any level: these are names, ids, and
 * the state of the duress lease, and none of it may reach a log.
 */
internal object SharedState {

  /** Mirrors `SHARED_STATE_DIR` in TacendumCryptoModule. */
  private const val DIR = "tacendum-shared"

  /** The Appendix's shared-state name pin. ASCII, and deliberately so. */
  private val NAME = Regex("^[a-z0-9-]{1,64}$")

  fun dir(context: Context): File = File(context.filesDir, DIR)

  fun file(context: Context, name: String): File? {
    if (!NAME.matches(name)) return null
    return File(dir(context), name)
  }

  /** The file's text, or null for absent/invalid/unreadable — one answer for
   * all three, because every caller treats them identically. */
  fun read(context: Context, name: String): String? {
    val f = file(context, name) ?: return null
    return try {
      if (!f.isFile) null else f.readText(Charsets.UTF_8)
    } catch (unreadable: Exception) {
      null
    }
  }

  /**
   * Write bytes, atomically, through a temp sibling and a rename — the same
   * shape `AtomicFiles.write` uses on the crypto side, so a reader can never
   * observe a half-written lease or a truncated mirror.
   *
   * Returns false rather than throwing: the two callers (the witness proof and
   * the badge counter) both treat a failed write as a fact about the container
   * rather than an error to propagate onto a delivery path.
   */
  fun write(context: Context, name: String, value: String): Boolean {
    val target = file(context, name) ?: return false
    val parent = target.parentFile ?: return false
    if (!parent.isDirectory && !parent.mkdirs()) return false
    val tmp = File(parent, "$name.tmp")
    return try {
      tmp.writeBytes(value.toByteArray(Charsets.UTF_8))
      if (!tmp.renameTo(target)) {
        tmp.delete()
        false
      } else {
        true
      }
    } catch (failed: Exception) {
      try {
        tmp.delete()
      } catch (ignored: Exception) {
        // Best effort; a stray temp is not worth failing a write over.
      }
      false
    }
  }
}
