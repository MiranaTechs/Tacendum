package com.miranatechnologies.tacendum.crypto

/**
 * The name allowlists — ASCII pins,
 * deliberately STRICTER than the shipped Swift check, which admits Unicode
 * letters/digits (a recorded divergence). Every real
 * name is ASCII, so nothing real diverges; a name only the Swift check would
 * accept is rejected here by design.
 *
 * A name becomes a path, and the protocol store is a sibling directory —
 * these guards are traversal prevention, not tidiness. `SecretStoreTest`
 * pins all three rules.
 */
object Names {
  /** Secret keys mirror iOS Keychain accounts, which are dotted
   * (`lock.passcode`, `tacendum.pushTokens`), so '.' is admitted. */
  private val SECRET_KEY = Regex("^[A-Za-z0-9._-]{1,64}$")

  /** Shared-state files (`preview-level`, `blocked-peers`, ...). */
  private val SHARED_STATE = Regex("^[a-z0-9-]{1,64}$")

  /** Inbox spool ids (msgId, ULID-shaped in practice). */
  private val INBOX_MSG_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

  /**
   * The dot names are refused BY NAME: "." and ".." satisfy the character
   * class above but are directory references, not names — `File(dir, "..")`
   * is the parent traversal the allowlist exists to prevent. (The other two
   * rules admit no '.' at all, so only this rule needs the guard.)
   */
  fun isValidSecretKey(key: String): Boolean =
      key != "." && key != ".." && SECRET_KEY.matches(key)

  fun isValidSharedStateName(name: String): Boolean = SHARED_STATE.matches(name)

  fun isValidInboxMsgId(msgId: String): Boolean = INBOX_MSG_ID.matches(msgId)
}
