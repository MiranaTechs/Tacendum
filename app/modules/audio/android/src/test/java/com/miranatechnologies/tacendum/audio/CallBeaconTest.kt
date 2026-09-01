package com.miranatechnologies.tacendum.audio

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The own-Telecom half of the call gate.
 *
 * The gate's two failure directions are not symmetric. Stuck ON means the
 * microphone is refused forever with a message about a call that ended
 * hours ago; stuck OFF means a voice note starts fighting a live call for the
 * microphone — the exact race the gate exists to prevent. The refcount floor
 * is what keeps an unpaired teardown from producing the second one, and
 * nothing on a device would show it: a negative count looks like "no call",
 * which is what an idle phone looks like too.
 */
class CallBeaconTest {

  @Before fun clear() = CallBeacon.reset()

  @After fun clearAgain() = CallBeacon.reset()

  @Test
  fun `an idle process has no calls`() {
    assertEquals(0, CallBeacon.activeCount())
  }

  @Test
  fun `a call raises the gate and its end lowers it`() {
    CallBeacon.enter()
    assertEquals(1, CallBeacon.activeCount())
    CallBeacon.exit()
    assertEquals(0, CallBeacon.activeCount())
  }

  @Test
  fun `two overlapping calls need both endings`() {
    // One held, one active. The first teardown must not re-open the
    // microphone underneath the second.
    CallBeacon.enter()
    CallBeacon.enter()
    CallBeacon.exit()
    assertTrue("the second call still holds the gate", CallBeacon.activeCount() > 0)
    CallBeacon.exit()
    assertEquals(0, CallBeacon.activeCount())
  }

  @Test
  fun `an unpaired ending cannot drive the count negative`() {
    // A negative count would read as "no call" AND would swallow the next
    // real call's enter() — the gate silently disarmed, in the one direction
    // that costs something.
    CallBeacon.exit()
    CallBeacon.exit()
    CallBeacon.exit()
    assertEquals(0, CallBeacon.activeCount())
    CallBeacon.enter()
    assertEquals(1, CallBeacon.activeCount())
  }

  @Test
  fun `concurrent calls and endings settle exactly`() {
    // Telecom callbacks arrive on binder threads; the audio module reads this
    // from its own state thread. A non-atomic count would lose increments
    // under exactly this shape and leave the gate stuck in either direction.
    val threads =
        (0 until 8).map {
          Thread {
            repeat(500) {
              CallBeacon.enter()
              CallBeacon.exit()
            }
          }
        }
    threads.forEach { it.start() }
    threads.forEach { it.join() }
    assertEquals(0, CallBeacon.activeCount())
  }
}
