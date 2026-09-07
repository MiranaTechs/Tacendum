package com.miranatechnologies.tacendum.call

import android.content.Context

/** A generation-bound authorization for one piece of native call work. */
internal class AccountCallLease internal constructor(
    internal val owner: String,
    internal val generation: Long,
)

/** The denied interval between invalidating old work and adopting a new id. */
internal class AccountCallOwnerChange internal constructor(
    internal val owner: String,
    internal val generation: Long,
)

/**
 * Thread-safe semantic core for the native account boundary.
 *
 * FCM delivery, Telecom creation, and WebRTC negotiation all finish
 * asynchronously. Their work remains authorized only while this owner and
 * generation still match the lease captured at entry.
 */
internal class AccountCallOwner(initialOwner: String) {
  private val lock = Any()
  private var owner = normalize(initialOwner)
  private var generation = 0L
  private var changeInProgress = false

  val currentOwner: String
    get() = synchronized(lock) { owner }

  fun currentLease(): AccountCallLease? =
      synchronized(lock) {
        if (owner.isEmpty()) null else AccountCallLease(owner, generation)
      }

  fun leaseFor(recipient: String): AccountCallLease? {
    val wanted = normalize(recipient)
    return synchronized(lock) {
      if (wanted.isEmpty() || wanted != owner) null else AccountCallLease(owner, generation)
    }
  }

  fun isCurrent(lease: AccountCallLease): Boolean =
      synchronized(lock) {
        owner.isNotEmpty() && owner == lease.owner && generation == lease.generation
      }

  /** Invalidate old work before native state is cleared or a new id persists. */
  fun beginChange(rawOwner: String): AccountCallOwnerChange? {
    val next = normalize(rawOwner)
    return synchronized(lock) {
      if (!changeInProgress && next == owner) return@synchronized null
      generation += 1
      owner = ""
      changeInProgress = true
      AccountCallOwnerChange(next, generation)
    }
  }

  /** A transition superseded by a later clear/change cannot adopt late. */
  fun finishChange(change: AccountCallOwnerChange) {
    synchronized(lock) {
      if (changeInProgress && owner.isEmpty() && generation == change.generation) {
        owner = change.owner
        changeInProgress = false
      }
    }
  }

  private fun normalize(value: String): String = value.trim()
}

/**
 * Process singleton plus durable Android storage for `AccountCallOwner`.
 * SharedPreferences is outside the protocol/crypto directory erased on
 * deletion, so an explicit empty owner survives restart.
 */
internal object AccountCallOwnership {
  private const val PREFS = "tacendum-call-permissions"
  private const val KEY_OWNER = "account-owner"
  private val initLock = Any()
  private val transitionLock = Any()
  @Volatile private var state: AccountCallOwner? = null

  private fun state(context: Context): AccountCallOwner {
    state?.let { return it }
    return synchronized(initLock) {
      state
          ?: AccountCallOwner(
                  context.applicationContext
                      .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                      .getString(KEY_OWNER, "")
                      .orEmpty()
              )
              .also { state = it }
    }
  }

  fun currentLease(context: Context): AccountCallLease? = state(context).currentLease()

  fun leaseFor(context: Context, recipient: String): AccountCallLease? =
      state(context).leaseFor(recipient)

  fun isCurrent(lease: AccountCallLease): Boolean = state?.isCurrent(lease) == true

  /**
   * Persist empty, clear platform/media state, then persist the new owner.
   * `commit` makes the promise's completion a durable boundary.
   */
  fun change(context: Context, rawOwner: String, clear: () -> Unit) {
    val app = context.applicationContext
    synchronized(transitionLock) {
      val policy = state(app)
      val change = policy.beginChange(rawOwner) ?: return
      val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      check(prefs.edit().putString(KEY_OWNER, "").commit())
      clear()
      // Persist before making the in-memory owner available. A failed write
      // leaves the policy in its denied transition, so retry cannot resolve as
      // a false same-owner no-op.
      check(prefs.edit().putString(KEY_OWNER, change.owner).commit())
      policy.finishChange(change)
    }
  }
}
