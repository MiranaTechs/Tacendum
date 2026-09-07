package com.miranatechnologies.tacendum.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pre-JS event buffer.
 *
 * **Why this exists as a unit test at all:** a broken buffer passes a
 * foreground loopback call naturally. In the foreground JS is always ready, so
 * nothing is ever buffered and nothing is ever dropped; the failure appears
 * only on a cold launch from a lock-screen answer, on a device, in the one
 * second nobody is watching. The device leg (`LEG: cold-launch-flush`) proves
 * delivery end to end; this proves the SEMANTICS the device leg would only
 * notice if they broke in exactly the right way.
 *
 * Three claims, one per pathology the buffer exists to prevent:
 *
 *   1. RETENTION — an event raised before any listener exists is kept, not
 *      dropped. Without this the phone shows an answered call the app never
 *      heard of and the caller sits in silence.
 *   2. OVERFLOW DROPS THE OLDEST at 32 — a build that never flushes leaks a
 *      bounded amount, and the events a late listener still needs to act on
 *      are the newest ones. Dropping the newest would be the same size bound
 *      and the wrong events.
 *   3. IN-ORDER DELIVERY — `callKitAnswer` before `callKitEnd` is a call that
 *      was answered and then ended; the reverse is a call that ended and was
 *      then answered, which the reducer would act on.
 */
class BufferSemanticsTest {

  @Test
  fun eventsRaisedBeforeJsIsReadyAreRetained() {
    val buffer = PendingEventBuffer()
    assertFalse("a fresh buffer is not ready", buffer.isReady())

    val deliverNow = buffer.record("callKitAnswer", """{"cid":"a"}""")
    assertFalse("record says do NOT emit — nothing is listening", deliverNow)
    assertEquals("and the event is held", 1, buffer.size())

    val flushed = buffer.flush()
    assertEquals("the flush hands it back", 1, flushed.size)
    assertEquals("callKitAnswer", flushed[0].event)
    assertEquals("""{"cid":"a"}""", flushed[0].json)
    assertEquals("and the buffer is empty afterwards", 0, buffer.size())
  }

  @Test
  fun afterFlushEventsGoStraightOut() {
    val buffer = PendingEventBuffer()
    buffer.flush()
    assertTrue("the buffer is ready once JS has announced itself", buffer.isReady())
    assertTrue("record says emit now", buffer.record("iceState", "{}"))
    assertEquals("nothing is buffered", 0, buffer.size())
  }

  @Test
  fun overflowIsThirtyTwoDeepAndDropsTheOldest() {
    val buffer = PendingEventBuffer()
    // One more than the cap, so exactly one drop is expected.
    for (i in 0 until PendingEventBuffer.MAX_PENDING + 1) {
      buffer.record("iceState", """{"n":$i}""")
    }
    assertEquals("the buffer is capped", PendingEventBuffer.MAX_PENDING, buffer.size())
    assertEquals("exactly one event was dropped", 1, buffer.droppedCount())

    val flushed = buffer.flush()
    assertEquals(PendingEventBuffer.MAX_PENDING, flushed.size)
    assertEquals(
        "the OLDEST went, not the newest — the head of a queue this long is stale",
        """{"n":1}""",
        flushed.first().json,
    )
    assertEquals(
        "the newest is still there, which is the one a late listener acts on",
        """{"n":${PendingEventBuffer.MAX_PENDING}}""",
        flushed.last().json,
    )
  }

  @Test
  fun theCapIsThirtyTwo() {
    // Pinned as its own claim: the number is a decision (deep enough for a
    // cold launch's handful of events, shallow enough that a build which never
    // flushes leaks a bounded amount), and changing it should require changing
    // this line rather than happening as a side effect.
    assertEquals(32, PendingEventBuffer.MAX_PENDING)
  }

  @Test
  fun flushDeliversInOrder() {
    val buffer = PendingEventBuffer()
    val order = listOf("voipPush", "callKitAnswer", "iceState", "callKitEnd")
    for (event in order) buffer.record(event, "{}")
    assertEquals(order, buffer.flush().map { it.event })
  }

  @Test
  fun aSecondFlushIsIdempotentAndEmpty() {
    val buffer = PendingEventBuffer()
    buffer.record("callKitAnswer", "{}")
    assertEquals(1, buffer.flush().size)
    // Safe to call on every launch and every Metro reload.
    assertEquals(0, buffer.flush().size)
    assertEquals("delivered counts events, not flushes", 1, buffer.deliveredCount())
  }

  @Test
  fun suspendBuffersAgainWithoutLosingWhatIsQueued() {
    val buffer = PendingEventBuffer()
    buffer.flush()
    buffer.suspend()
    assertFalse("a reload puts the buffer back in front of the emitter", buffer.isReady())
    assertFalse(buffer.record("callKitEnd", """{"cid":"z"}"""))

    // A second reload before the first flush must not discard what the first
    // one collected: a call that ends during a reload is exactly the event the
    // reducer cannot afford to miss.
    buffer.suspend()
    assertEquals(1, buffer.size())
    val flushed = buffer.flush()
    assertEquals(1, flushed.size)
    assertEquals("""{"cid":"z"}""", flushed[0].json)
  }

  @Test
  fun deliveredCountTracksWhatLeft() {
    // The counter the cold-launch device leg is written against: JS counts
    // what arrives, this counts what left, and a mismatch is the flush losing
    // events between the two.
    val buffer = PendingEventBuffer()
    assertEquals(0, buffer.deliveredCount())
    buffer.record("voipPush", "{}")
    buffer.record("callKitAnswer", "{}")
    buffer.flush()
    assertEquals(2, buffer.deliveredCount())
  }

  @Test
  fun accountClearDropsOldEventsWithoutUnbindingCurrentJs() {
    val buffer = PendingEventBuffer()
    buffer.record("callKitAnswer", """{"cid":"old"}""")
    buffer.clear()

    assertEquals(0, buffer.size())
    assertFalse(buffer.isReady())

    buffer.flush()
    buffer.clear()
    assertTrue("a clear does not make attached listeners disappear", buffer.isReady())
    assertTrue(buffer.record("callKitAnswer", """{"cid":"new"}"""))
  }
}
