package com.miranatechnologies.tacendum.call

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The pre-sink seam's semantics — BufferSemanticsTest's
 * three claims, restated for the buffer one seam earlier: retention before
 * any sink exists, 32-deep with the OLDEST dropped, and in-order drain.
 */
class SinkReplayBufferTest {

  @Test
  fun retainsUntilDrainedAndDrainsInOrder() {
    val buffer = SinkReplayBuffer<MutableList<String>>()
    buffer.record { it.add("first") }
    buffer.record { it.add("second") }
    buffer.record { it.add("third") }

    val sink = mutableListOf<String>()
    for (entry in buffer.drain()) entry(sink)

    assertEquals(listOf("first", "second", "third"), sink)
  }

  @Test
  fun drainEmptiesTheBuffer() {
    val buffer = SinkReplayBuffer<MutableList<String>>()
    buffer.record { it.add("only") }
    buffer.drain()

    assertEquals(0, buffer.size())
    assertEquals(0, buffer.drain().size)
  }

  @Test
  fun overflowDropsTheOldest() {
    val buffer = SinkReplayBuffer<MutableList<Int>>()
    for (i in 1..40) {
      buffer.record { it.add(i) }
    }

    val sink = mutableListOf<Int>()
    for (entry in buffer.drain()) entry(sink)

    // 32 deep: of 40 recorded, the first 8 are gone and the newest 32 —
    // the events most likely to describe the call on screen — survive.
    assertEquals((9..40).toList(), sink)
  }
}
