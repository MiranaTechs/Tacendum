package com.miranatechnologies.tacendum.attach

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The attach pin suite.
 *
 * THE THING BEING PROVEN: a provider that LIES about its size cannot slip a
 * larger file through.
 *
 * iOS never has to ask this question — `UIDocumentPickerViewController(...,
 * asCopy: true)` gets the system to copy the file into our sandbox first, so
 * the size check is a stat() of a file we own. Android's
 * `ACTION_OPEN_DOCUMENT` returns a `content://` URI backed by a
 * `DocumentsProvider` that any installed app may publish, and
 * `OpenableColumns.SIZE` is whatever that provider felt like writing. Every
 * test below therefore drives [DocumentReader] with a stream whose real
 * length is decided independently of the claim — which is precisely the shape
 * no device test can produce, because it needs a hostile provider to exist.
 *
 * The second property, easy to lose while fixing the first: the recount must
 * not read the whole oversized file to discover it is oversized. A 2 GB
 * source that gets fully buffered before being refused takes the process down
 * — the cap defeated by the code that enforces it. [readsOnlyOneByteOfExcess]
 * counts the bytes actually pulled.
 */
class AttachSizeRecountTest {

  private val max = 1_000L

  // MARK: - the honest paths

  @Test
  fun `a file within the cap is read whole`() {
    val bytes = ByteArray(500) { (it % 251).toByte() }
    val outcome = DocumentReader.read(500L, max) { ByteArrayInputStream(bytes) }
    val read = outcome as DocumentReader.Outcome.Read
    assertArrayEquals(bytes, read.bytes)
  }

  @Test
  fun `a file exactly at the cap is allowed`() {
    val bytes = ByteArray(max.toInt()) { 7 }
    val outcome = DocumentReader.read(max, max) { ByteArrayInputStream(bytes) }
    assertTrue(outcome is DocumentReader.Outcome.Read)
    assertEquals(max.toInt(), (outcome as DocumentReader.Outcome.Read).bytes.size)
  }

  @Test
  fun `an honest oversize claim is refused without opening the stream`() {
    // The claim's job: refuse a 2 GB pick without asking anybody to stream
    // 2 GB. If the stream is opened at all here, the cheap half of the check
    // did nothing.
    var opened = false
    val outcome =
        DocumentReader.read(2_000L, max) {
          opened = true
          ByteArrayInputStream(ByteArray(2_000))
        }
    assertFalse("the stream must not be opened for a claim already over the cap", opened)
    val refusal = outcome as DocumentReader.Outcome.TooLarge
    assertTrue("the refusal came from the claim", refusal.claimed)
    assertEquals(2_000L, refusal.atLeastBytes)
  }

  // MARK: - the lying provider

  @Test
  fun `a provider claiming four kilobytes and streaming a gigabyte is refused`() {
    // The whole point of the recount. The claim passes the first gate; the
    // bytes do not pass the second.
    val outcome = DocumentReader.read(4L, max) { endlessStream() }
    val refusal = outcome as DocumentReader.Outcome.TooLarge
    assertFalse("the refusal came from the RECOUNT, not the claim", refusal.claimed)
    assertTrue(refusal.atLeastBytes > max)
  }

  @Test
  fun `one byte over the cap is caught even when the claim says one byte under`() {
    val bytes = ByteArray((max + 1).toInt()) { 1 }
    val outcome = DocumentReader.read(max - 1, max) { ByteArrayInputStream(bytes) }
    val refusal = outcome as DocumentReader.Outcome.TooLarge
    assertFalse(refusal.claimed)
    assertEquals(max + 1, refusal.atLeastBytes)
  }

  @Test
  fun `a provider declining to state a size is still bounded by the stream`() {
    // SIZE_UNKNOWN means "no claim", not "no limit".
    val outcome =
        DocumentReader.read(DocumentReader.SIZE_UNKNOWN, max) { endlessStream() }
    val refusal = outcome as DocumentReader.Outcome.TooLarge
    assertFalse(refusal.claimed)
  }

  @Test
  fun `a nonsense negative claim does not disable the cap`() {
    val outcome = DocumentReader.read(-42L, max) { endlessStream() }
    assertTrue(outcome is DocumentReader.Outcome.TooLarge)
  }

  @Test
  fun readsOnlyOneByteOfExcess() {
    // A refusal that first buffers the whole oversized file is the cap
    // defeating itself. The reader must stop at maxBytes + 1.
    val counting = CountingStream(10_000_000)
    val outcome = DocumentReader.readCapped(counting, max)
    assertTrue(outcome is DocumentReader.Outcome.TooLarge)
    assertEquals(
        "exactly one byte past the cap may be read",
        max + 1,
        counting.delivered,
    )
  }

  // MARK: - failure paths

  @Test
  fun `a provider that cannot open answers read_failed, never a silent empty file`() {
    val outcome = DocumentReader.read(10L, max) { throw IOException("gone") }
    val failure = outcome as DocumentReader.Outcome.Failed
    assertEquals("gone", failure.message)
  }

  @Test
  fun `a null stream is a failure, not an empty document`() {
    val outcome = DocumentReader.read(10L, max) { null }
    assertTrue(outcome is DocumentReader.Outcome.Failed)
  }

  @Test
  fun `a stream that dies mid-read fails rather than returning a truncated file`() {
    // A half-read attachment that resolved successfully would be sent as if
    // it were the whole file.
    val outcome = DocumentReader.read(500L, max) { FailingStream(200) }
    assertTrue(outcome is DocumentReader.Outcome.Failed)
  }

  @Test
  fun `an empty document reads as empty rather than failing`() {
    val outcome = DocumentReader.read(0L, max) { ByteArrayInputStream(ByteArray(0)) }
    val read = outcome as DocumentReader.Outcome.Read
    assertEquals(0, read.bytes.size)
  }

  @Test
  fun `a zero-length read does not spin the loop forever`() {
    // Some providers answer 0 before data is ready; the reader must keep
    // asking rather than treating it as end of stream, and must still
    // terminate.
    val outcome = DocumentReader.readCapped(StutteringStream(byteArrayOf(1, 2, 3)), max)
    val read = outcome as DocumentReader.Outcome.Read
    assertArrayEquals(byteArrayOf(1, 2, 3), read.bytes)
  }

  // MARK: - the claim predicate on its own

  @Test
  fun `claimExceeds is true only for a stated size past the cap`() {
    assertTrue(DocumentReader.claimExceeds(max + 1, max))
    assertFalse(DocumentReader.claimExceeds(max, max))
    assertFalse(DocumentReader.claimExceeds(0L, max))
    assertFalse(DocumentReader.claimExceeds(DocumentReader.SIZE_UNKNOWN, max))
  }

  // MARK: - stream doubles

  /** A source that never ends — the gigabyte a provider claimed was 4 KB. */
  private fun endlessStream(): InputStream =
      object : InputStream() {
        override fun read(): Int = 0x5A

        override fun read(b: ByteArray, off: Int, len: Int): Int {
          java.util.Arrays.fill(b, off, off + len, 0x5A.toByte())
          return len
        }
      }

  /** Endless, but it counts what it was actually asked to hand over. */
  private class CountingStream(private val length: Long) : InputStream() {
    var delivered = 0L
      private set

    override fun read(): Int {
      if (delivered >= length) return -1
      delivered += 1
      return 0x5A
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (delivered >= length) return -1
      val n = minOf(len.toLong(), length - delivered).toInt()
      java.util.Arrays.fill(b, off, off + n, 0x5A.toByte())
      delivered += n.toLong()
      return n
    }
  }

  private class FailingStream(private val goodBytes: Int) : InputStream() {
    private var served = 0

    override fun read(): Int = throw IOException("the stream died")

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (served >= goodBytes) throw IOException("the stream died")
      val n = minOf(len, goodBytes - served)
      java.util.Arrays.fill(b, off, off + n, 1.toByte())
      served += n
      return n
    }
  }

  /** Answers 0 once before every real chunk. */
  private class StutteringStream(private val payload: ByteArray) : InputStream() {
    private var index = 0
    private var stutter = true

    override fun read(): Int = throw UnsupportedOperationException()

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (stutter) {
        stutter = false
        return 0
      }
      stutter = true
      if (index >= payload.size) return -1
      val n = minOf(len, payload.size - index)
      System.arraycopy(payload, index, b, off, n)
      index += n
      return n
    }
  }

  private fun assertArrayEquals(expected: ByteArray, actual: ByteArray) {
    org.junit.Assert.assertArrayEquals(expected, actual)
  }
}
