package com.miranatechnologies.tacendum.audio

import java.util.concurrent.atomic.AtomicInteger

/**
 * The own-Telecom half of the call gate.
 *
 * iOS holds a `CXCallObserver`: one public system object that sees Tacendum's
 * own CallKit calls AND cellular ones, with no import from tacendum-call.
 * Android has no permissionless equivalent — `TelecomManager.isInCall()` and
 * `isInManagedCall()` both cost `READ_PHONE_STATE`, which this app refuses to
 * spend — so the gate is assembled from two weaker parts:
 * [AudioPolicy.callActiveForMode] for anything the system's audio mode
 * reveals, and this beacon for our own Telecom calls, which the mode cannot
 * be trusted to report (a self-managed `ConnectionService` leaves the mode to
 * whatever audio stack the call actually runs, and an outgoing call is
 * RINGING — the exact moment the ringback needs — long before any of that
 * settles).
 *
 * THE DEPENDENCY POINTS THE OTHER WAY, DELIBERATELY — it keeps
 * the no-import-from-tacendum-call separation: this file is owned by the
 * audio module and imports nothing, and it is tacendum-call that
 * calls [enter]/[exit] as its Connections are created and destroyed. The
 * audio module therefore never learns the call module's types, and it
 * degrades honestly when nothing writes here: the gate falls back to the
 * audio-mode heuristic alone, which is already disclosed as the weaker
 * gate.
 *
 * A COUNT, NOT A FLAG. Two overlapping calls (one held, one active) must not
 * let the first one's teardown re-open the microphone under the second, and
 * a refcount is the only shape that survives that ordering. [exit] floors at
 * zero so an unpaired teardown cannot drive the count negative and silently
 * disarm the gate — the fail-safe direction.
 */
object CallBeacon {

  private val active = AtomicInteger(0)

  /** A Tacendum call now exists. Call once per Connection. */
  @JvmStatic
  fun enter() {
    active.incrementAndGet()
  }

  /** That call has ended. Floors at zero; safe to call unpaired. */
  @JvmStatic
  fun exit() {
    active.updateAndGet { current -> if (current > 0) current - 1 else 0 }
  }

  /** How many of our own calls are up. */
  @JvmStatic
  fun activeCount(): Int = active.get()

  /**
   * Forget every call.
   *
   * NOT called by the audio module's own `invalidate()`, deliberately: a
   * Metro reload tears the JS side down while a Telecom `ConnectionService`
   * — and this process singleton — keep running, so clearing here would
   * disarm the gate underneath a live call. It exists for the call service's
   * own destroy path and for the host-JVM suite, both of which know that
   * no call remains.
   */
  @JvmStatic
  fun reset() {
    active.set(0)
  }
}
