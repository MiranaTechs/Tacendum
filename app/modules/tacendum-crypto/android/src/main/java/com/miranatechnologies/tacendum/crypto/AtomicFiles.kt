package com.miranatechnologies.tacendum.crypto

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Atomic write-rename: a reader sees the old bytes or the new bytes,
 * never a prefix. The Android mirror of the iOS `.atomic` write the shared
 * state and secret store contracts require — write the full value to a temp
 * file, fsync it, then rename over the target in one filesystem operation.
 *
 * No cryptography in this file; it moves bytes it is
 * handed.
 */
object AtomicFiles {
  /**
   * Write `bytes` to `target` via `temp`, atomically. `temp` must live on
   * the same filesystem as `target` (same directory tree in practice — the
   * callers keep it beside or under the target's directory).
   */
  @Throws(IOException::class)
  fun write(target: File, temp: File, bytes: ByteArray) {
    FileOutputStream(temp).use { out ->
      out.write(bytes)
      // Durable BEFORE the rename: a rename that lands while the data is
      // still in the page cache can survive a crash as a full-length file of
      // zeros — the torn read the atomic contract exists to prevent.
      out.fd.sync()
    }
    try {
      Files.move(
          temp.toPath(),
          target.toPath(),
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING,
      )
    } catch (unsupported: AtomicMoveNotSupportedException) {
      // Same-directory renames are atomic on every filesystem Android app
      // storage uses, so this is unreachable there — but NEVER fall back to
      // a copy: a copy is exactly the torn-read window being closed.
      temp.delete()
      throw IOException("atomic rename unsupported", unsupported)
    }
  }
}
