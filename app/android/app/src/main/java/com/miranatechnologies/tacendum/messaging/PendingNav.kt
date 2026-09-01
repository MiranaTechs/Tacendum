package com.miranatechnologies.tacendum.messaging

import android.content.Context

/**
 * The tap half of a banner — the Android twin of the
 * two lines AppDelegate.swift writes when a notification is tapped.
 *
 * ONE LINE, and only the line app/src/pushnav.ts will accept:
 *
 *     "<unix-ms> <threadIdentifier>"
 *
 * where the identifier is a bare 26-character id, or "g/" and one. That reader
 * validates the shape, applies a 10-minute TTL, DELETES the file, and only
 * then answers — so nothing here has to think about staleness, and nothing
 * here may write anything richer. The shape is restated as a regex rather than
 * imported because the two live in different languages, and the pin test in
 * app/__tests__ holds the JS half's literals together.
 *
 * WHAT IS ALLOWED ON DISK: a row key, and nothing else. No approval content,
 * no message byte, no name — what waits on disk while a lock screen stands
 * says nothing about anyone. The validation below is what enforces that: a
 * value that is not exactly a thread key is refused rather than written, so no
 * caller can widen the format by passing something else.
 */
internal object PendingNav {

  const val FILE = "pending-nav"

  /** peerId.ts's CANON alphabet, restated (pushnav.ts INTENT_LINE holds the
   * JS copy). A machine-minted key gets none of the folding tolerance a
   * human-typed id earns. */
  private val THREAD = Regex("^(g/)?[0-9A-HJKMNP-TV-Z]{26}$")

  /** Returns true when a line was written. False means the value was not a
   * thread key, or the container refused the write — in both cases the tap
   * simply opens the app, which is the failure direction a navigation nicety
   * is owed. */
  fun write(context: Context, thread: String, now: Long = System.currentTimeMillis()): Boolean {
    if (!THREAD.matches(thread)) return false
    if (now <= 0) return false
    return SharedState.write(context, FILE, "$now $thread")
  }
}
