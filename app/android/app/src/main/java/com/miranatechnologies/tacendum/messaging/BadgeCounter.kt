package com.miranatechnologies.tacendum.messaging

import android.content.Context

/**
 * The number a message notification carries —
 * the Kotlin half of app/ios/TacendumNSE/BadgeCounter.swift, and the same
 * arithmetic over the same two files:
 *
 *     badge = base + extra
 *
 * `base` is the unread total the app last computed from its database
 * (app/src/badge.ts `syncBadge`, written whenever the app foregrounds or
 * backgrounds); `extra` is how many message notifications this side has raised
 * since. The app owns the truth: whenever it recomputes it rewrites `base` and
 * DELETES `extra`, so any drift this counter accumulates self-heals the next
 * time the app is opened.
 *
 * Restated for Android, because the badge is not the same object here: on iOS
 * the number is a property of the app icon, and on Android it is a property of
 * a POSTED NOTIFICATION on a channel with `setShowBadge(true)`. So this
 * returns a number for `setNumber` rather than setting anything itself, and a
 * launcher that ignores it is launcher-best-effort by design.
 *
 * EXCLUSION IS A MONITOR, NOT A FILE LOCK, and the difference is the platform's
 * not a preference: iOS holds `flock` because two extension PROCESSES can
 * overlap, while Android v1 is one process — and `java.nio`'s FileLock is
 * held per-JVM, so two concurrent notifications inside this process would not
 * exclude each other with one, they would throw OverlappingFileLockException.
 * The monitor is the exclusion that actually exists here. A read-modify-write
 * without it loses increments, which is the defect both versions are avoiding.
 */
internal object BadgeCounter {

  private const val BASE_FILE = "badge-base"
  private const val EXTRA_FILE = "badge-extra"

  private fun readInt(context: Context, name: String): Int? =
      SharedState.read(context, name)?.trim()?.toIntOrNull()

  /**
   * Increment the counter and return the number to show, or null when the
   * container will not take the write — in which case the notification simply
   * carries no number, which every launcher treats as "leave it alone".
   *
   * The write is CHECKED rather than fire-and-forget, for the reason the Swift
   * version gives: a badge that reports a count the file does not hold makes
   * the next notification re-count from whatever survived, and the number
   * jumps around.
   */
  @Synchronized
  fun incrementedBadge(context: Context): Int? {
    val base = readInt(context, BASE_FILE) ?: 0
    val next = (readInt(context, EXTRA_FILE) ?: 0) + 1
    if (!SharedState.write(context, EXTRA_FILE, next.toString())) return null
    val total = base + next
    return if (total < 0) null else total
  }
}
