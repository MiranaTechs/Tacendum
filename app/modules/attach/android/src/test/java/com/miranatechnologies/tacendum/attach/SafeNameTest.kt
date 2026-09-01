package com.miranatechnologies.tacendum.attach

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The filename port, checked against the Swift original's behaviour rather
 * than against its shape.
 *
 * Every case here is one the iOS comment names: traversal, control
 * characters, bidi spoofing, and the 255-BYTE component limit that a name
 * perfectly reasonable in UTF-16 units can still blow through. A port that
 * quietly used UTF-16 length, or that truncated between the halves of a
 * grapheme cluster, would pass a device test forever — the file writes, the
 * preview opens — while producing a different name than the iPhone would.
 *
 * Every special character below is built from its CODE POINT rather than
 * pasted in. Two reasons, both practical: a right-to-left override pasted
 * literally reorders the source line it sits on — the very trick the
 * sanitiser exists to defeat, played on the test that proves it — and a
 * zero-width character pasted into a diff is invisible to the person
 * reviewing it.
 */
class SafeNameTest {

  private fun cp(codePoint: Int): String = String(Character.toChars(codePoint))

  // MARK: - traversal (iOS: `lastPathComponent`)

  @Test
  fun `a traversal name keeps only its last component`() {
    assertEquals("x", SafeName.sanitize("../../x"))
    assertEquals("passwd", SafeName.sanitize("/etc/passwd"))
    assertEquals("note.txt", SafeName.sanitize("a/b/c/note.txt"))
  }

  @Test
  fun `trailing separators are dropped before the component is taken`() {
    assertEquals("scratch", SafeName.sanitize("scratch///"))
    assertEquals("tmp", SafeName.sanitize("/tmp/"))
    assertEquals("lock", SafeName.sanitize("/tmp/lock/"))
  }

  @Test
  fun `an ordinary name is left exactly alone`() {
    assertEquals("report.pdf", SafeName.sanitize("report.pdf"))
    assertEquals("Q3 numbers (final).xlsx", SafeName.sanitize("Q3 numbers (final).xlsx"))
    // Non-ASCII that is neither a control nor a format character survives
    // untouched: "rapport-ete.pdf" with an acute on each e.
    val accented = "rapport-" + cp(0x00E9) + "t" + cp(0x00E9) + ".pdf"
    assertEquals(accented, SafeName.sanitize(accented))
  }

  @Test
  fun `no separator can survive a name that is not the bare root`() {
    // The property the write path depends on: whatever comes out cannot steer
    // a path.
    val hostile = listOf("../../x", "/a/b", "a//b", "..//../x", "/etc/passwd/")
    for (name in hostile) {
      assertFalse("'$name' produced a separator", SafeName.sanitize(name).contains("/"))
    }
  }

  // MARK: - control and format characters

  @Test
  fun `newlines and tabs and nulls are removed`() {
    assertEquals("abc", SafeName.sanitize("a\nb\tc"))
    assertEquals("ab", SafeName.sanitize("a" + cp(0x0000) + "b"))
    assertEquals("ab", SafeName.sanitize("a" + cp(0x000D) + "b"))
    // C1 controls are category Cc too, and are far easier to overlook.
    assertEquals("ab", SafeName.sanitize("a" + cp(0x0085) + "b"))
    assertEquals("ab", SafeName.sanitize("a" + cp(0x007F) + "b"))
  }

  @Test
  fun `a right-to-left override cannot disguise an extension`() {
    // The classic: "invoice<RLO>gnp.exe" renders to the eye as
    // "invoiceexe.png" while being an executable.
    val spoofed = "invoice" + cp(0x202E) + "gnp.exe"
    assertEquals("invoicegnp.exe", SafeName.sanitize(spoofed))
  }

  @Test
  fun `every bidi control and the zero-width space are removed`() {
    val controls =
        listOf(
            0x202A, // LEFT-TO-RIGHT EMBEDDING
            0x202B, // RIGHT-TO-LEFT EMBEDDING
            0x202C, // POP DIRECTIONAL FORMATTING
            0x202D, // LEFT-TO-RIGHT OVERRIDE
            0x202E, // RIGHT-TO-LEFT OVERRIDE
            0x2066, // LEFT-TO-RIGHT ISOLATE
            0x2067, // RIGHT-TO-LEFT ISOLATE
            0x2068, // FIRST STRONG ISOLATE
            0x2069, // POP DIRECTIONAL ISOLATE
            0x200B, // ZERO WIDTH SPACE
        )
    for (control in controls) {
      assertEquals(
          "U+%04X survived".format(control),
          "ab",
          SafeName.sanitize("a" + cp(control) + "b"),
      )
    }
  }

  @Test
  fun `format characters outside the basic plane are removed too`() {
    // U+E0001 LANGUAGE TAG is category Cf and a surrogate pair — a code-UNIT
    // scan would leave half of it behind and produce an unpaired surrogate.
    val tagged = "a" + cp(0xE0001) + "b"
    assertEquals(4, tagged.length) // three "characters", four UTF-16 units
    assertEquals("ab", SafeName.sanitize(tagged))
  }

  // MARK: - the 200-BYTE budget

  @Test
  fun `the budget is counted in bytes, not in characters`() {
    // 60 emoji: 60 surrogate pairs (120 UTF-16 units) but 240 UTF-8 bytes. A
    // UTF-16 length check would let all 60 through and the write would fail
    // on the filesystem's byte limit.
    val grin = cp(0x1F600)
    val name = grin.repeat(60)
    assertEquals(120, name.length)
    assertEquals(240, name.toByteArray(Charsets.UTF_8).size)
    val safe = SafeName.sanitize(name)
    assertEquals(200, safe.toByteArray(Charsets.UTF_8).size)
    assertEquals(grin.repeat(50), safe)
  }

  @Test
  fun `truncation lands on a grapheme boundary, never inside a cluster`() {
    // 67 "e + COMBINING ACUTE ACCENT" clusters = 201 bytes, one over budget.
    //
    // Dropping whole CLUSTERS (Swift's `removeLast()`) keeps 66 of them, so
    // the result still ends with the combining mark that belongs to its base.
    // Dropping CODE POINTS would keep those 66 plus a bare "e" whose accent
    // was cut off — a different name, and one that reads differently.
    val cluster = "e" + cp(0x0301)
    val name = cluster.repeat(67)
    assertEquals(201, name.toByteArray(Charsets.UTF_8).size)
    val safe = SafeName.sanitize(name)
    assertEquals(198, safe.toByteArray(Charsets.UTF_8).size)
    assertEquals(cluster.repeat(66), safe)
    assertEquals(cp(0x0301)[0], safe.last())
  }

  @Test
  fun `a name exactly at the budget is untouched`() {
    val name = "a".repeat(200)
    assertEquals(name, SafeName.sanitize(name))
    assertEquals(200, SafeName.sanitize("a".repeat(201)).length)
  }

  @Test
  fun `truncation happens after stripping, not before`() {
    // 300 zero-width spaces in front of a short name: strip first and nothing
    // needs truncating; truncate first and the real name is thrown away.
    val name = cp(0x200B).repeat(300) + "receipt.pdf"
    assertEquals("receipt.pdf", SafeName.sanitize(name))
  }

  // MARK: - the fallback

  @Test
  fun `a name with nothing left becomes file`() {
    assertEquals("file", SafeName.sanitize(""))
    assertEquals("file", SafeName.sanitize("\n\t" + cp(0x0000)))
    assertEquals("file", SafeName.sanitize(cp(0x202E) + cp(0x202D) + cp(0x200B)))
  }

  // MARK: - the degenerate root, which fails closed rather than being invented over

  @Test
  fun `the bare root is carried through unchanged, exactly as NSString does`() {
    // NSString.lastPathComponent answers "/" for "/" and for "///", and iOS
    // then FAILS THE WRITE rather than inventing a plausible name. This side
    // matches to the character, and AttachModule's containment check — the
    // resolved path must start with the preview directory plus a separator —
    // refuses it before any byte is written, so both platforms answer the
    // same 'write_failed'. Rewriting it to "file" here would be the one place
    // this port silently improved on the original, and a silent improvement
    // is a divergence nobody wrote down.
    assertEquals("/", SafeName.lastPathComponent("/"))
    assertEquals("/", SafeName.lastPathComponent("///"))
    assertEquals("/", SafeName.sanitize("/"))
    assertEquals("/", SafeName.sanitize("///"))
    assertTrue(SafeName.sanitize("///").isNotEmpty())
  }
}
