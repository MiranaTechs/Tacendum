package com.miranatechnologies.tacendum.call

/**
 * Events raised before any sink existed.
 *
 * `PendingEventBuffer` covers the window between the MODULE existing and JS
 * listening — which was every window this app had while the socket was the
 * only wake: a call could not arrive without JavaScript running, so
 * `TelecomCenter.events` was always set before Telecom had anything to say.
 * An FCM call-wake breaks that assumption one seam earlier: the process is
 * started by firebase, the ring goes up through Telecom, and a person can
 * ANSWER or DECLINE it before React Native has constructed a single module —
 * `events` is still null, and on iOS this window simply does not exist
 * because the OS launches the app for every VoIP push.
 *
 * So the seam gets the same treatment the module seam got: a bounded buffer,
 * 32 deep, dropping the OLDEST — `PendingEventBuffer`'s exact posture, for
 * the exact reason recorded there (the newest event is the one most likely to
 * describe the call the person is looking at). Entries are replayed IN ORDER
 * into the first sink installed, which is the module's constructor assigning
 * `TelecomCenter.events = this`; from there they land in the module's own
 * pre-JS buffer and reach JavaScript through the ordinary
 * `flushPendingEvents`, so a decline tapped before JS existed arrives exactly
 * as one tapped after.
 *
 * Not thread-safe by itself: the owner synchronizes, exactly as the module
 * synchronizes around `PendingEventBuffer`.
 */
internal class SinkReplayBuffer<T> {

  private val entries = ArrayDeque<(T) -> Unit>()

  fun record(entry: (T) -> Unit) {
    if (entries.size >= CAPACITY) entries.removeFirst()
    entries.addLast(entry)
  }

  /** Everything recorded, in arrival order, and the buffer emptied — the
   * caller invokes OUTSIDE its lock, for the re-entrancy reason
   * `flushPendingEvents` gives. */
  fun drain(): List<(T) -> Unit> {
    val out = entries.toList()
    entries.clear()
    return out
  }

  fun size(): Int = entries.size

  private companion object {
    const val CAPACITY = 32
  }
}
