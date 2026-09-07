package com.miranatechnologies.tacendum.call

/**
 * Events raised before JS was listening, oldest first (the
 * Kotlin port of `TacendumCallImpl.pending` / `flushPendingEvents`).
 *
 * A cold launch from the lock screen runs in this order: the socket or
 * Telecom wakes the process, the full-screen ring goes up, the user answers,
 * and only THEN does the React runtime come up. Every one of those events
 * would otherwise be emitted into a listener that does not exist and lost, so
 * the phone would show an answered call the app had never heard of and the
 * caller would sit in silence.
 *
 * Binding an emitter is not enough to flush. The TurboModule instance exists
 * from the moment the JS module is first imported, while the listeners are
 * attached later in `startCalling`; between those two points React Native's
 * own emitter drops anything with no listener — a second silent drop behind
 * the first. So the buffer is released only when JS SAYS it is ready
 * (`flushPendingEvents`), not when the module is constructed.
 *
 * **Why this is its own class rather than three fields on the module.** A
 * broken buffer passes a foreground loopback call naturally: in the
 * foreground JS is always ready, so nothing is ever buffered and nothing is
 * ever dropped. The failure only appears on a cold launch, on a device, in
 * the one second nobody is watching. Extracted here, with no Android import,
 * it is pinned by `BufferSemanticsTest` on the host JVM — retention,
 * drop-oldest overflow at 32, and in-order delivery — which is the layer that
 * can actually fail when the semantics regress.
 *
 * Thread-safety is the caller's `synchronized` — every method here is called
 * from `TacendumCallModule` under its own lock, and the tests exercise it
 * single-threaded, so a second lock inside would be a second thing to get
 * wrong for no gain.
 */
internal class PendingEventBuffer(private val capacity: Int = MAX_PENDING) {

  /** One buffered event: the codegen event name, and its JSON payload. */
  data class Entry(val event: String, val json: String)

  private val queued = ArrayDeque<Entry>()
  private var ready = false
  private var dropped = 0
  private var delivered = 0

  /** Whether JS has announced its listeners. */
  fun isReady(): Boolean = ready

  /** How many events are waiting. Test surface and diagnostics only. */
  fun size(): Int = queued.size

  /** How many were dropped by overflow — never logged with their payload. */
  fun droppedCount(): Int = dropped

  /**
   * How many buffered events a flush has handed on, cumulative.
   *
   * This is the counter the cold-launch device check is written against:
   * `TacendumDev.nativeCall.flushedEventCount()` on the JS side counts what
   * arrives, and this counts what left — a mismatch is the flush losing
   * events between the two, which is precisely the failure the buffer exists
   * to prevent and precisely the one an error-free run cannot rule out.
   */
  fun deliveredCount(): Int = delivered

  /**
   * Record an event.
   *
   * Returns true when the caller should emit it NOW (JS is listening), false
   * when it has been buffered instead. Deliberately a verdict rather than a
   * void: the emit has to happen OUTSIDE the caller's lock — a JS listener
   * that calls back into the module, which ending a call in response to a
   * buffered `callKitEnd` does exactly, would otherwise deadlock on a
   * non-reentrant lock.
   */
  fun record(event: String, json: String): Boolean {
    if (ready) return true
    if (queued.size >= capacity) {
      // Drop the OLDEST: the newest events are the ones a late listener still
      // needs to act on, and the head of a queue this long is stale by
      // definition. Not logged with its payload — these carry cids.
      queued.removeFirst()
      dropped += 1
    }
    queued.addLast(Entry(event, json))
    return false
  }

  /**
   * JS has attached its listeners; hand back everything that happened first.
   *
   * Idempotent, and safe to call on every launch and every Metro reload: a
   * second call finds an empty queue and returns an empty list.
   */
  fun flush(): List<Entry> {
    ready = true
    val out = ArrayList(queued)
    queued.clear()
    delivered += out.size
    return out
  }

  /**
   * A reload tears down the JS half; buffer again until the new one is up.
   *
   * The queue is NOT cleared — a reload mid-call must not lose the events
   * that arrive during it, which is the same reason the buffer exists at all.
   */
  fun suspend() {
    ready = false
  }

  /** Account deletion drops events that belong to the departing identity. */
  fun clear() {
    queued.clear()
  }

  companion object {
    /**
     * Deep enough for a cold launch's handful of Telecom events, shallow
     * enough that a build which never calls `flushPendingEvents` leaks a
     * bounded amount rather than growing for the life of the process. The
     * same 32 the Swift side uses; the number is pinned by
     * `BufferSemanticsTest` so a change has to be a decision.
     */
    const val MAX_PENDING = 32
  }
}
