package com.miranatechnologies.tacendum.audio

import android.media.MediaDataSource
import kotlin.math.min

/**
 * A `MediaDataSource` over bytes that are already in memory — the Android
 * answer to `AVAudioPlayer(data:)`.
 *
 * This is the whole reason a received voice note never touches the disk in
 * the clear. `MediaPlayer.setDataSource(File|Uri|path)` would all require a
 * plaintext file; `setDataSource(MediaDataSource)` reads from wherever we
 * say, so the decrypted bytes stay in the heap and the SQLite attachments row
 * remains the single durable decrypted copy.
 *
 * The same object also serves `MediaMetadataRetriever` when a finished
 * RECORDING is probed for its true duration, so neither the play path nor the
 * probe path ever needs a second file.
 *
 * [wipe] is the explicit release half. `close()` is called by the framework
 * when the player is done, and zeroing there would corrupt a source another
 * reader still holds, so the two acts are kept separate: the framework closes,
 * the module wipes when it is releasing the bytes for good.
 */
internal class MemoryDataSource(private val bytes: ByteArray) : MediaDataSource() {

  @Volatile private var closed = false

  override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
    if (closed) return -1
    if (position < 0L) return -1
    if (position >= bytes.size.toLong()) return -1 // end of stream
    if (size <= 0) return 0
    val available = bytes.size.toLong() - position
    val count = min(size.toLong(), available).toInt()
    System.arraycopy(bytes, position.toInt(), buffer, offset, count)
    return count
  }

  override fun getSize(): Long = bytes.size.toLong()

  override fun close() {
    closed = true
  }

  /**
   * Overwrite the plaintext in place. The heap copy is the only one that ever
   * existed, and a `ByteArray` the JVM has not collected yet is still a
   * readable copy — so the release path zeroes it rather than merely dropping
   * the reference.
   */
  fun wipe() {
    closed = true
    bytes.fill(0)
  }
}
