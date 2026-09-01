package com.miranatechnologies.tacendum.attach

import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.math.min

/**
 * The size cap, enforced twice — the provider's claim and then the bytes
 * themselves.
 *
 * WHY TWICE. iOS gets one honest number: `UIDocumentPickerViewController(...,
 * asCopy: true)` makes the SYSTEM copy the file into our sandbox, so
 * `attributesOfItem` is a stat() of a real file we own, and the second check
 * there (`data.count <= maxBytes`) is a formality against a TOCTOU race.
 * Android's `ACTION_OPEN_DOCUMENT` copies nothing: it hands back a
 * `content://` URI backed by a `DocumentsProvider` that any installed app can
 * publish, and `OpenableColumns.SIZE` is a number that provider simply
 * asserts. A hostile or merely buggy provider can claim 4 KB and stream a
 * gigabyte.
 *
 * So the claim is used for what it is good for — refusing an oversized file
 * without reading a byte of it — and the STREAM is what decides. The read
 * stops one byte past the cap, which is the whole point: a provider lying
 * about a 2 GB file must not be able to make this module allocate 2 GB in
 * order to discover the lie. The refusal therefore reports "more than
 * maxBytes" rather than an exact size, because the exact size was
 * deliberately never measured.
 *
 * Every function here is pure and stream-shaped, which is what lets
 * `AttachSizeRecountTest` build a stream that lies and prove the lie is
 * caught — no emulator, no provider, no `ContentResolver`.
 */
internal object DocumentReader {

  /** The provider declined to state a size (a null or absent SIZE column). */
  const val SIZE_UNKNOWN = -1L

  sealed interface Outcome {
    /** Within the cap, by the stream's own count. */
    class Read(val bytes: ByteArray) : Outcome

    /**
     * Refused. [claimed] distinguishes the provider's own admission from the
     * recount catching it out — the second is the one worth being able to
     * see, because it is a provider that lied.
     */
    class TooLarge(val claimed: Boolean, val atLeastBytes: Long) : Outcome

    class Failed(val message: String) : Outcome
  }

  /** The cheap half: refuse what the provider itself admits is too big. */
  fun claimExceeds(claimedSize: Long, maxBytes: Long): Boolean =
      claimedSize != SIZE_UNKNOWN && claimedSize >= 0L && claimedSize > maxBytes

  /**
   * Read at most `maxBytes + 1` bytes. Landing on that last byte proves the
   * source is over the cap without ever holding more than one byte of excess.
   */
  fun readCapped(input: InputStream, maxBytes: Long): Outcome {
    if (maxBytes < 0L) return Outcome.TooLarge(claimed = false, atLeastBytes = 0L)
    val limit = maxBytes + 1L
    val collected = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    try {
      while (total < limit) {
        val room = limit - total
        val want = min(buffer.size.toLong(), room).toInt()
        val read = input.read(buffer, 0, want)
        if (read < 0) break
        if (read == 0) continue
        collected.write(buffer, 0, read)
        total += read.toLong()
      }
    } catch (t: Throwable) {
      return Outcome.Failed(t.message ?: "the document could not be read")
    }
    if (total > maxBytes) return Outcome.TooLarge(claimed = false, atLeastBytes = total)
    return Outcome.Read(collected.toByteArray())
  }

  /**
   * The whole check, claim first and stream second.
   *
   * `openStream` is a lambda rather than an open stream so the claim can be
   * refused before anything is opened at all — a provider that would have
   * streamed a gigabyte never gets asked to.
   */
  fun read(claimedSize: Long, maxBytes: Long, openStream: () -> InputStream?): Outcome {
    if (claimExceeds(claimedSize, maxBytes)) {
      return Outcome.TooLarge(claimed = true, atLeastBytes = claimedSize)
    }
    val stream =
        try {
          openStream() ?: return Outcome.Failed("the document could not be opened")
        } catch (t: Throwable) {
          return Outcome.Failed(t.message ?: "the document could not be opened")
        }
    return stream.use { readCapped(it, maxBytes) }
  }
}
