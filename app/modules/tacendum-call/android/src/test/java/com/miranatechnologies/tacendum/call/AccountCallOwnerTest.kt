package com.miranatechnologies.tacendum.call

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountCallOwnerTest {

  @Test
  fun missingOwnerFailsClosedForPushesAndDirectMedia() {
    val owner = AccountCallOwner(initialOwner = "")

    assertNull(owner.leaseFor("new-account"))
    assertNull(owner.currentLease())
  }

  @Test
  fun onlyTheExactNonemptyPushRecipientIsAccepted() {
    val owner = AccountCallOwner(initialOwner = "current-account")

    assertNotNull(owner.leaseFor("current-account"))
    assertNull(owner.leaseFor("other-account"))
    assertNull(owner.leaseFor(""))
  }

  @Test
  fun sameOwnerIsIdempotentAndDoesNotInvalidateWork() {
    val owner = AccountCallOwner(initialOwner = "current-account")
    val lease = owner.currentLease()!!

    assertNull(owner.beginChange("current-account"))

    assertTrue(owner.isCurrent(lease))
  }

  @Test
  fun clearAndRotationInvalidateOldWorkBeforeAdoption() {
    val owner = AccountCallOwner(initialOwner = "old-account")
    val oldLease = owner.currentLease()!!

    val clear = owner.beginChange("")!!
    assertEquals("", owner.currentOwner)
    assertNull(owner.currentLease())
    assertFalse(owner.isCurrent(oldLease))
    owner.finishChange(clear)
    assertNull(owner.currentLease())

    val rotate = owner.beginChange("new-account")!!
    assertEquals("", owner.currentOwner)
    assertNull(owner.currentLease())
    owner.finishChange(rotate)

    assertEquals("new-account", owner.currentOwner)
    assertNull(owner.leaseFor("old-account"))
    val newLease = owner.leaseFor("new-account")!!
    assertTrue(owner.isCurrent(newLease))
    assertFalse(owner.isCurrent(oldLease))
  }

  @Test
  fun aSupersededTransitionCannotAdoptItsOwnerLate() {
    val owner = AccountCallOwner(initialOwner = "old-account")
    val stale = owner.beginChange("stale-account")!!
    val current = owner.beginChange("current-account")!!

    owner.finishChange(stale)
    assertEquals("", owner.currentOwner)

    owner.finishChange(current)
    assertEquals("current-account", owner.currentOwner)
  }

  @Test
  fun clearSupersedesAnInterruptedRotationAndCanRetryDurableDenial() {
    val owner = AccountCallOwner(initialOwner = "old-account")
    val staleAdoption = owner.beginChange("new-account")!!

    // Models retry after the adapter persisted empty but failed before
    // teardown/finish: owner is already empty, yet clear must still advance
    // the generation and make the earlier adoption stale.
    val clearingRetry = owner.beginChange("")!!
    owner.finishChange(staleAdoption)
    assertEquals("", owner.currentOwner)

    owner.finishChange(clearingRetry)
    assertEquals("", owner.currentOwner)
    assertNull(owner.currentLease())
  }
}
