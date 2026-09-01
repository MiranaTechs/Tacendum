package com.miranatechnologies.tacendum.attach

import java.text.BreakIterator

/**
 * Filename sanitisation, ported verbatim from
 * app/modules/attach/ios/AttachImpl.swift (`previewFile`).
 *
 * The original's reasoning, unchanged:
 *
 *   Filename sanitised to its last path component so a hostile name like
 *   "../../x" cannot steer the write; the directory is ours and private.
 *   Traversal is only half of it. Bidi controls and newlines spoof the
 *   preview title exactly as they spoof the bubble, and a name that is fine
 *   in UTF-16 units can still exceed the filesystem's 255-BYTE component
 *   limit (emoji cost four bytes each), which fails the write.
 *
 * Each of the four steps has an exact Swift counterpart:
 *
 *  1. `(name as NSString).lastPathComponent` — trailing separators dropped,
 *     then everything up to the last one.
 *  2. `.components(separatedBy: .controlCharacters).joined()` — Swift's
 *     `CharacterSet.controlCharacters` is Unicode general categories **Cc and
 *     Cf**, which is why it already removes the bidi overrides and the
 *     zero-width space; [Character.CONTROL] and [Character.FORMAT] are the
 *     same two categories on this side.
 *  3. The ten explicit `replacingOccurrences` calls — redundant after step 2
 *     on both platforms, kept because the original keeps them and because a
 *     future Unicode recategorisation must not quietly re-open the hole.
 *  4. `while safeName.utf8.count > 200 { safeName.removeLast() }` then the
 *     `"file"` fallback — Swift's `removeLast()` drops one CHARACTER, which
 *     is a grapheme cluster, so this side walks grapheme boundaries with a
 *     [BreakIterator] rather than code points. Truncating mid-cluster would
 *     leave a combining mark orphaned onto whatever precedes it, which is a
 *     different name than iOS would have produced.
 */
internal object SafeName {

  /** The iOS budget: 200 UTF-8 bytes, comfortably under the 255-byte component limit. */
  const val MAX_UTF8_BYTES = 200

  /** The iOS fallback when nothing survives. */
  const val FALLBACK = "file"

  /**
   * The explicit list from the Swift source, in its order: LRE, RLE, PDF,
   * LRO, RLO, LRI, RLI, FSI, PDI, ZWSP.
   */
  private val EXPLICIT_STRIPS =
      intArrayOf(
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

  fun sanitize(name: String): String {
    val truncated = truncateToUtf8Bytes(stripFormatting(lastPathComponent(name)))
    return if (truncated.isEmpty()) FALLBACK else truncated
  }

  /**
   * `NSString.lastPathComponent`: trailing separators are dropped first, then
   * the segment after the last remaining separator. "/" answers "/" and ""
   * answers "" — both degenerate names that fail closed at the write on both
   * platforms rather than being rewritten into a plausible one here.
   */
  fun lastPathComponent(name: String): String {
    if (name.isEmpty()) return ""
    var end = name.length
    while (end > 1 && name[end - 1] == '/') end -= 1
    if (end == 1 && name[0] == '/') return "/"
    val start = name.lastIndexOf('/', end - 1) + 1
    return name.substring(start, end)
  }

  /** Unicode Cc and Cf, plus the explicit belt-and-braces list. */
  fun stripFormatting(name: String): String {
    val out = StringBuilder(name.length)
    var index = 0
    while (index < name.length) {
      val codePoint = name.codePointAt(index)
      val width = Character.charCount(codePoint)
      val type = Character.getType(codePoint)
      val isControlOrFormat =
          type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()
      val isExplicit = EXPLICIT_STRIPS.contains(codePoint)
      if (!isControlOrFormat && !isExplicit) out.appendCodePoint(codePoint)
      index += width
    }
    return out.toString()
  }

  /**
   * Drop whole grapheme clusters from the end until the name fits
   * [MAX_UTF8_BYTES] — the same result as the Swift `while` loop, computed in
   * one pass by finding the last cluster boundary whose prefix still fits.
   */
  fun truncateToUtf8Bytes(name: String): String {
    if (name.isEmpty()) return name
    if (utf8Length(name) <= MAX_UTF8_BYTES) return name
    val boundaries = BreakIterator.getCharacterInstance()
    boundaries.setText(name)
    var bytes = 0
    var lastFittingBoundary = 0
    var start = boundaries.first()
    var end = boundaries.next()
    while (end != BreakIterator.DONE) {
      bytes += utf8Length(name.substring(start, end))
      if (bytes > MAX_UTF8_BYTES) break
      lastFittingBoundary = end
      start = end
      end = boundaries.next()
    }
    return name.substring(0, lastFittingBoundary)
  }

  private fun utf8Length(value: String): Int = value.toByteArray(Charsets.UTF_8).size
}
