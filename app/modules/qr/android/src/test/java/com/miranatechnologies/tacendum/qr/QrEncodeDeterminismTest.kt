package com.miranatechnologies.tacendum.qr

import com.google.zxing.RGBLuminanceSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The QR pins.
 *
 * What is worth pinning on a host JVM, and why each one is here:
 *
 *  - DETERMINISM. The same id, drawn twice, must be the same picture. A raster
 *    that varied — because something in the path interpolated, dithered or
 *    antialiased — would still "look like a QR" in every screenshot a person
 *    ever took of it, and would decode fine on the good phone it was tested
 *    on. This is the property no visual check catches.
 *  - GEOMETRY. Integer scale, quiet zone 4, module count inside 21...177, two
 *    colours and no third. Each is a decoder-failure mode rather than an
 *    aesthetic: a fractional scale gives some modules one more pixel than
 *    their neighbours, and that ragged edge is what a cheap decoder pointed at
 *    a screen reads as noise.
 *  - THE ROUND TRIP, HOST-SIDE. zxing draws it and zxing reads it back, with
 *    no Android graphics in between, so a break in the raster is caught here
 *    rather than on an emulator ten minutes later.
 *  - ALL SYMBOLS, NOT THE BEST ONE. Two codes in one frame must come back as
 *    two payloads. If this side collapsed them, the ambiguity refusal in
 *    `app/src/qr.ts` would be unreachable — the choice would already have been
 *    made here, silently.
 *  - BOUNDS BEFORE ALLOCATE. The decode ceiling is enforced on the DECLARED
 *    dimensions, which is the only point at which refusing costs nothing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class QrEncodeDeterminismTest {

  private companion object {
    /** Two fixed, distinct, canonical-alphabet ULIDs. */
    const val ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    const val OTHER_ID = "01BX5ZZKBKACTAV9WEVGEMMVRZ"
    const val DARK = "#181818"
    const val LIGHT = "#FFFFFF"
    const val PIXELS = 768
  }

  // ── determinism ──────────────────────────────────────────────────────────

  @Test
  fun `the same id renders to the same pixels every time`() {
    val first = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val second = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    assertEquals(first.edge, second.edge)
    assertTrue(
        "an id drawn twice must be the same picture, byte for byte",
        first.pixels.contentEquals(second.pixels),
    )
  }

  @Test
  fun `a different id renders to different pixels`() {
    val mine = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val theirs = QrCodec.render(OTHER_ID, PIXELS, DARK, LIGHT)
    assertTrue(
        "two accounts must not share a picture",
        !mine.pixels.contentEquals(theirs.pixels),
    )
  }

  @Test
  fun `encodePng is deterministic and non-empty`() {
    val first = QrCodec.encodePng(ID, PIXELS, DARK, LIGHT)
    val second = QrCodec.encodePng(ID, PIXELS, DARK, LIGHT)
    assertTrue("the PNG must not be empty", first.isNotEmpty())
    assertEquals("the same id must produce the same file", first, second)
  }

  // ── geometry ─────────────────────────────────────────────────────────────

  @Test
  fun `an id is a 25-module symbol — the correction level M is pinned by its size`() {
    // 26 characters is EXACTLY the byte-mode capacity of a version-2 symbol at
    // correction level M, which is 25 modules. This number is therefore the
    // detector for the EC level: at H the same payload needs version 3-4 and
    // comes out at 29 or 33 modules, and nothing else in this suite would
    // notice the change — the picture would still draw, still decode, and
    // still be deterministic, while every module got smaller on a screen the
    // symbol has to survive being photographed off.
    assertEquals(25, QrCodec.render(ID, PIXELS, DARK, LIGHT).modules)
    assertEquals(25, QrCodec.render(OTHER_ID, PIXELS, DARK, LIGHT).modules)
  }

  @Test
  fun `the symbol is a plausible QR and the raster is an integer multiple of it`() {
    val raster = QrCodec.render(ID, PIXELS, DARK, LIGHT)

    assertTrue(
        "a QR is 21 (version 1) to 177 (version 40) modules; ${raster.modules} is not",
        raster.modules in QrCodec.MIN_MODULES..QrCodec.MAX_MODULES,
    )
    assertEquals("the module bounds are the spec's, not a preference", 21, QrCodec.MIN_MODULES)
    assertEquals(177, QrCodec.MAX_MODULES)
    val total = raster.modules + 2 * QrCodec.QUIET_MODULES
    assertEquals(
        "scale is floor(requested / total): a request, not a promise",
        PIXELS / total,
        raster.scale,
    )
    assertEquals(
        "edge must be a whole number of modules — every module the same square",
        total * raster.scale,
        raster.edge,
    )
    assertTrue("the requested edge is a ceiling, never exceeded", raster.edge <= PIXELS)
    assertEquals("the raster is square", raster.edge * raster.edge, raster.pixels.size)
  }

  @Test
  fun `the quiet zone is four modules of paper on every side`() {
    val raster = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val light = QrCodec.argb(LIGHT)!!
    // The literal 4, not the constant: reading the constant back would make
    // this test agree with whatever the code decided, and the ISO quiet zone
    // is a fact about decoders rather than a setting.
    assertEquals("ISO asks for 4 modules of quiet zone", 4, QrCodec.QUIET_MODULES)
    val band = 4 * raster.scale

    for (y in 0 until raster.edge) {
      for (x in 0 until raster.edge) {
        val inQuietZone =
            y < band || x < band || y >= raster.edge - band || x >= raster.edge - band
        if (inQuietZone && raster.pixels[y * raster.edge + x] != light) {
          fail("ink inside the quiet zone at ($x, $y) — the ISO margin is not optional")
        }
      }
    }
  }

  @Test
  fun `the raster holds exactly two colours — nothing interpolated anything`() {
    val raster = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val dark = QrCodec.argb(DARK)!!
    val light = QrCodec.argb(LIGHT)!!
    val seen = raster.pixels.toHashSet()
    assertEquals(
        "a third colour means something smoothed an edge, which is what kills a scan",
        setOf(dark, light),
        seen,
    )
  }

  @Test
  fun `hex colours are parsed strictly`() {
    assertEquals(0xFF181818.toInt(), QrCodec.argb("#181818"))
    assertEquals(0xFFFFFFFF.toInt(), QrCodec.argb("#ffffff"))
    assertEquals(null, QrCodec.argb("181818"))
    assertEquals(null, QrCodec.argb("#18181"))
    assertEquals(null, QrCodec.argb("#18181G"))
    assertEquals(null, QrCodec.argb(""))
  }

  // ── the round trip, and the payload that must not change ─────────────────

  @Test
  fun `what is drawn reads back as exactly the bare id`() {
    val raster = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val payloads = decode(raster)
    assertEquals(
        "the payload is the bare ULID — no scheme, no prefix, no URL",
        listOf(ID),
        payloads,
    )
  }

  @Test
  fun `two codes in one image come back as two payloads`() {
    val mine = QrCodec.render(ID, PIXELS, DARK, LIGHT)
    val theirs = QrCodec.render(OTHER_ID, PIXELS, DARK, LIGHT)

    val gap = 32
    val width = mine.edge + gap + theirs.edge
    val height = maxOf(mine.edge, theirs.edge)
    val canvas = IntArray(width * height) { QrCodec.argb(LIGHT)!! }
    blit(canvas, width, mine, 0)
    blit(canvas, width, theirs, mine.edge + gap)

    val payloads = decode(width, height, canvas)
    assertEquals(
        "the ambiguity refusal in qr.ts needs BOTH, or it can never fire",
        setOf(ID, OTHER_ID),
        payloads.toSet(),
    )
  }

  @Test
  fun `a picture with no code is an empty list, not a failure`() {
    val blank = IntArray(64 * 64) { QrCodec.argb(LIGHT)!! }
    assertEquals(emptyList<String>(), decode(64, 64, blank))
  }

  // ── refusals ─────────────────────────────────────────────────────────────

  @Test
  fun `arguments outside the contract are refused before anything is drawn`() {
    refuses("qr_bad_argument") { QrCodec.render("", PIXELS, DARK, LIGHT) }
    refuses("qr_bad_argument") {
      QrCodec.render("x".repeat(QrCodec.MAX_TEXT_BYTES + 1), PIXELS, DARK, LIGHT)
    }
    refuses("qr_bad_argument") { QrCodec.render(ID, QrCodec.MIN_PIXELS - 1, DARK, LIGHT) }
    refuses("qr_bad_argument") { QrCodec.render(ID, QrCodec.MAX_PIXELS + 1, DARK, LIGHT) }
    refuses("qr_bad_argument") { QrCodec.render(ID, PIXELS, "181818", LIGHT) }
    refuses("qr_bad_argument") { QrCodec.render(ID, PIXELS, DARK, "#GGGGGG") }
  }

  @Test
  fun `the decode ceiling is enforced on the declared dimensions`() {
    // Nothing is allocated to reach any of these: they are answers about
    // numbers read out of the file header.
    refuses("qr_unreadable") { QrCodec.sampleSizeFor(0, 0) }
    refuses("qr_unreadable") { QrCodec.sampleSizeFor(-1, 100) }
    refuses("qr_too_large") { QrCodec.sampleSizeFor(QrCodec.MAX_SOURCE_EDGE + 1, 10) }
    refuses("qr_too_large") { QrCodec.sampleSizeFor(10, QrCodec.MAX_SOURCE_EDGE + 1) }
    // 20000 x 20000 is 400 megapixels: under the edge limit, far over the
    // pixel-count limit. Without the second check this one allocates 1.6 GB.
    refuses("qr_too_large") { QrCodec.sampleSizeFor(20_000, 20_000) }
  }

  @Test
  fun `oversized but sane images are sampled down to the working ceiling`() {
    assertEquals("a small picture is decoded whole", 1, QrCodec.sampleSizeFor(1024, 768))
    assertEquals("exactly at the ceiling still needs no sampling", 1, QrCodec.sampleSizeFor(4096, 4096))
    assertEquals("one pixel over halves it", 2, QrCodec.sampleSizeFor(4097, 4097))
    assertEquals(2, QrCodec.sampleSizeFor(8192, 8192))
    // A long, thin 80-megapixel panorama: inside both ceilings, and three
    // halvings (20000 -> 2500) away from the working edge.
    assertEquals(8, QrCodec.sampleSizeFor(20_000, 4_000))
    // Powers of two only — BitmapFactory rounds anything else down to 1, so a
    // computed 3 would decode at full size while claiming to have sampled.
    for ((width, height) in
        listOf(1024 to 768, 4097 to 4097, 8192 to 8192, 8900 to 8900, 20_000 to 4_000)) {
      val sample = QrCodec.sampleSizeFor(width, height)
      assertEquals("$sample is not a power of two", 0, sample and (sample - 1))
      assertTrue(
          "sampling must actually bring ${width}x$height under the ceiling",
          maxOf(width, height) / sample <= QrCodec.MAX_WORKING_EDGE,
      )
    }
    // The ceilings themselves, as literals: read back from the constants they
    // would agree with any value the code happened to hold, and every one of
    // these is a memory bound rather than a taste.
    assertEquals("the working ceiling is 4096", 4096, QrCodec.MAX_WORKING_EDGE)
    assertEquals(30_000, QrCodec.MAX_SOURCE_EDGE)
    assertEquals(80_000_000L, QrCodec.MAX_SOURCE_PIXELS)
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private fun decode(raster: QrCodec.Raster): List<String> =
      decode(raster.edge, raster.edge, raster.pixels)

  private fun decode(width: Int, height: Int, pixels: IntArray): List<String> =
      QrCodec.readAll(RGBLuminanceSource(width, height, pixels))

  /** Copy one square raster into a wider canvas at `originX`. */
  private fun blit(canvas: IntArray, canvasWidth: Int, source: QrCodec.Raster, originX: Int) {
    for (y in 0 until source.edge) {
      System.arraycopy(
          source.pixels,
          y * source.edge,
          canvas,
          y * canvasWidth + originX,
          source.edge,
      )
    }
  }

  private fun refuses(code: String, body: () -> Unit) {
    try {
      body()
      fail("expected $code")
    } catch (failure: QrCodec.QrFailure) {
      assertEquals(code, failure.code)
    }
  }
}
