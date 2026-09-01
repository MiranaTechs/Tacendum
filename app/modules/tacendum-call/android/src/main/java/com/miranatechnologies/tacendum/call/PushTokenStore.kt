package com.miranatechnologies.tacendum.call

import android.content.Context

/**
 * The FCM registration token, persisted.
 *
 * The whole rule in one place: Android has ONE push token — firebase issues
 * one registration token per app instance — and it feeds BOTH
 * `voipTokenUpdated` and `alertTokenUpdated`, so the JS launch machinery and
 * its `pushRegistrationAdopted` latch stay byte-identical to iOS. This object
 * is the token's single owner: `TacendumFcmService.onNewToken` adopts into it,
 * `TacendumCallModule.getVoipToken`/`getAlertToken` read it back, and the
 * listener slot is how the module hears about a rotation while JS is alive.
 *
 * **Why persisted, when iOS persists nothing.** iOS never needs to: PushKit
 * answers `didUpdatePushCredentials` from its own cache on every launch, so
 * the token re-arrives during `c.start()` whether or not JS was alive when it
 * was minted. FCM's `onNewToken` fires only when a token is GENERATED or
 * ROTATED — which can happen with no JavaScript loaded at all (the service is
 * a plain Android component) — and never re-fires on an ordinary launch. So
 * the mirror of PushKit's cache is this file: the token is written down when
 * it arrives, and the next boot's `adoptPushRegistration` →
 * `uploadPushTokens` → `getVoipToken()` reads it exactly the way iOS re-reads
 * PushKit's cache ("the registry may already hold a token from a previous
 * launch", app/src/call/index.ts).
 *
 * SharedPreferences, deliberately, and not the secret store: a push token
 * is the capability to WAKE this phone, not to read anything on it — the same
 * trust class as the APNs token iOS holds in PushKit's own plain cache. It is
 * excluded from every backup by the app's full exclusion (`path="."` in both
 * rules files), it dies with the app data exactly as the FCM registration it
 * names does, and it is never logged (the value appears in
 * no string this module builds).
 *
 * A LISTENER SLOT, not a set — IdleObserver's reasoning: there is exactly one
 * module emitting these events, and a set would let a Metro reload leave a
 * dead module's listener behind to emit into a destroyed runtime.
 */
object PushTokenStore {

  /** Seam for the JVM tests: the real persistence is SharedPreferences, which
   * a host-JVM test cannot construct. */
  internal interface Persistence {
    fun read(): String

    fun write(value: String): Boolean
  }

  private const val PREFS = "tacendum-push-token"
  private const val KEY = "fcm-token"

  /**
   * The FCM shape's ceiling, mirrored from `MAX_FCM_TOKEN_LENGTH`
   * (packages/shared/src/dto.ts): generous because Google has changed the
   * format before, bounded because nothing that arrives over a callback gets
   * to grow without limit.
   */
  internal const val MAX_TOKEN_LENGTH = 512

  @Volatile private var listener: ((String) -> Unit)? = null

  /**
   * Write-through cache. The warm path (JS alive, token rotates) must not
   * depend on a preferences write landing before the very next read — and if
   * the write ever fails, the process that WITNESSED the token still knows
   * it; only the next boot degrades to the retry FCM itself provides.
   */
  @Volatile private var cached: String? = null

  fun install(next: ((String) -> Unit)?) {
    listener = next
  }

  /** A new or rotated token. Persist FIRST, then tell whoever is listening —
   * the listener path ends in `getVoipToken` reads, so the value must be
   * readable before the event that announces it. */
  fun adopt(context: Context, token: String) = adopt(prefsPersistence(context), token)

  internal fun adopt(persistence: Persistence, token: String) {
    val trimmed = token.trim()
    // An empty or absurd token is not a rotation, and adopting it would
    // replace a working registration with garbage. FCM never delivers either;
    // this is the boundary saying so rather than trusting it.
    if (trimmed.isEmpty() || trimmed.length > MAX_TOKEN_LENGTH) return
    persistence.write(trimmed)
    cached = trimmed
    listener?.invoke(trimmed)
  }

  /** The current token, `''` when none has ever been adopted — which is every
   * launch of a build without Firebase wired (the pre-FCM truth, still
   * told by the same convention: absence-as-`''`). */
  fun current(context: Context): String = current(prefsPersistence(context))

  internal fun current(persistence: Persistence): String = cached ?: persistence.read()

  /** Tests only: a JVM suite must not inherit the previous test's cache. */
  internal fun resetForTest() {
    cached = null
    listener = null
  }

  private fun prefsPersistence(context: Context): Persistence {
    val prefs =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return object : Persistence {
      override fun read(): String = prefs.getString(KEY, "") ?: ""

      override fun write(value: String): Boolean = prefs.edit().putString(KEY, value).commit()
    }
  }
}
