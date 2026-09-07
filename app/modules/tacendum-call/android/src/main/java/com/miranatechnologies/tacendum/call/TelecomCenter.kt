package com.miranatechnologies.tacendum.call

import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.telecom.ConnectionRequest
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import java.io.File
import org.json.JSONObject

/**
 * Telecom, the ring, and the placeholder bookkeeping
 * — the Kotlin twin of `ios/CallKitCenter.swift`.
 *
 * The Swift file's PushKit half becomes, on Android, an entry point
 * (`reportIncomingPlaceholder`) for a wake that arrives before anything has
 * decrypted. **The machinery landed with no caller, on purpose:** every
 * one of the races below is a RUNTIME race, not an iOS race, and porting them
 * later — once there is a caller and a bug report — is how the same two live
 * symptoms get rediscovered. The design says 1:1 and this is what
 * 1:1 means. The caller exists now: an FCM call-wake reaches this
 * through `CallWake.reportIncomingPlaceholder`, in a build with Firebase
 * wired, possibly before React Native has constructed a single module — which
 * is what the `SinkReplayBuffer` behind `events` is for.
 *
 * **The verdict.** CallKit's `reportNewIncomingCall` takes a completion that
 * says accepted-or-refused. Telecom's equivalent is asynchronous and arrives
 * as one of two `ConnectionService` callbacks; `TacendumConnectionService`
 * routes both here. Everything downstream — the rebind, the parked rebind, the
 * watchdog arm — keys off which one arrived, exactly as the Swift does.
 * Refusal is reported upward as the constant
 * `notification/Connection creation failed`.
 */
internal object TelecomCenter {

  /** What Telecom reports upward. Implemented by the module facade. */
  interface EventSink {
    fun callKitAnswered(cid: String)

    fun callKitEnded(cid: String, reason: String)

    fun callKitMuted(cid: String, muted: Boolean)

    /** `ringCid` is the placeholder actually ringing for `from`, "" when none. */
    fun voipPush(cid: String, from: String, ringCid: String)
  }

  const val REFUSAL_VERDICT = "notification/Connection creation failed"
  private const val ACCOUNT_ID = "tacendum-self-managed"
  private const val PLACEHOLDER_TIMEOUT_MS = 75_000L

  /**
   * How long a report may stay unanswered before it is TREATED as a refusal.
   *
   * Telecom always answers with one of the two callbacks in practice; a
   * promise that hangs forever if it ever does not is worse than one that
   * rejects, because the layer above has a busy-teardown for a refusal and
   * nothing at all for silence. Fail-direction discipline: the
   * unknown resolves to the answer that ends the call rather than the one
   * that leaves it ringing.
   */
  private const val VERDICT_TIMEOUT_MS = 8_000L

  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())

  /**
   * The sink, with a replay buffer behind it (see
   * `SinkReplayBuffer` for why the pre-MODULE window exists at all now that a
   * push can wake this process). Every emission below goes through `emit`,
   * which either delivers to the live sink or records for the first one
   * installed; installing a sink drains the buffer into it IN ORDER, before
   * any live event can interleave. In a socket-only build the buffer is
   * provably idle — the module installs its sink at construction and a call
   * cannot exist without the module — so this is a widening, not a change.
   */
  private val sinkLock = Any()
  private val preSink = SinkReplayBuffer<EventSink>()
  @Volatile private var sink: EventSink? = null

  var events: EventSink?
    get() = sink
    set(value) {
      val queued =
          synchronized(sinkLock) {
            sink = value
            if (value == null) emptyList() else preSink.drain()
          }
      // Outside the lock: a replayed event can re-enter this object (a
      // buffered decline ends a call), which is `flushPendingEvents`'s
      // deadlock reasoning one seam down.
      for (entry in queued) entry(value!!)
    }

  private fun emit(entry: (EventSink) -> Unit) {
    val target =
        synchronized(sinkLock) {
          val live = sink
          if (live == null) {
            preSink.record(entry)
            null
          } else {
            live
          }
        }
    target?.let(entry)
  }

  @Volatile private var appContext: Context? = null

  /** cid → the live Connection. Telecom speaks objects; the protocol speaks ULIDs. */
  private val connectionsByCid = HashMap<String, TacendumConnection>()

  /** cid → what to call when the verdict for its report arrives. */
  private val pendingVerdicts = HashMap<String, (String?) -> Unit>()

  /** Account generation that authorized each requested/live connection. */
  private val leaseByCid = HashMap<String, AccountCallLease>()

  /**
   * CIDS ENDED BEFORE THEIR VERDICT ARRIVED — the Telecom-side twin of the
   * module's tombstone, and it exists for the same reason.
   *
   * `addNewIncomingCall` does not return a Connection; the system creates one
   * later, on its own thread. A `call.end` landing in that window found
   * nothing in `connectionsByCid`, ended nothing, and resolved — and the
   * system then handed us a live self-managed Connection for a call the rest
   * of the app had already forgotten. Nothing above the bridge could name it,
   * so nothing could ever end it, and Telecom holds an in-call state that
   * blocks the next call from ringing at all.
   *
   * So the end leaves a MARK and the creation looks for it. Bounded by count
   * alone rather than by liveness (unlike the module's, which has an
   * in-flight set to consult): the window here is one Telecom round trip and
   * the 8-second verdict timeout is its ceiling, so an entry cannot be needed
   * longer than that.
   */
  private val endedBeforeVerdict = LinkedHashSet<String>()
  private const val MAX_ENDED_BEFORE_VERDICT = 64

  /** The name and video flag a report was made with, read back off the request. */
  private data class PendingReport(val displayName: String, val hasVideo: Boolean)

  /**
   * The call a wake reported before anything could decrypt.
   *
   * The wake carries no cid — the real one is inside the ciphertext, which is
   * the point of the design — so the ring goes up under a SYNTHETIC cid. The
   * two live iOS symptoms both fell out of forgetting that: the decrypted
   * offer later reported the REAL cid as a brand-new incoming call (a second
   * ring), and the name correction targeted a call the platform had never
   * seen. `reportIncomingCall` rebinds instead: same Connection, new key.
   */
  private var pendingPush: Pair<String, String>? = null // (cid, from)

  /** The person answered the placeholder before the offer decrypted. */
  private var pendingAnswered = false

  /** The report's verdict has not returned yet; rebinds arriving now PARK. */
  private var pendingPushConfirmed = false

  private class ParkedRebind(
      val cid: String,
      val peerId: String,
      val handle: String,
      val displayName: String,
      val hasVideo: Boolean,
      val lease: AccountCallLease,
      val completion: (String?) -> Unit,
  )

  private var parkedRebind: ParkedRebind? = null

  /**
   * Ends a placeholder nobody could ever answer or cancel.
   *
   * 75 seconds: the offer's 60-second ring TTL plus clock-skew slack — past
   * that, no legitimate answer path exists. Keyed on the CONNECTION, which the
   * rebind deliberately PRESERVES, so the watchdog stays valid whether or not
   * the offer ever decrypted. Cancelled by answer, by end, and by dismissal —
   * anything that resolves the call like a call.
   */
  private var watchdog: Runnable? = null
  private var watchdogConnection: TacendumConnection? = null

  /** The route, under its own lock — see `configureAudio`. */
  private val routeLock = Any()
  private var desiredSpeaker = false

  // MARK: - registration

  /**
   * Register the self-managed `PhoneAccount`.
   *
   * Idempotent: Telecom replaces an account registered twice under the same
   * handle, and this runs on every module construction because a process that
   * was killed and restarted has no account until it says so again.
   *
   * `MANAGE_OWN_CALLS` is a normal permission, granted at install, so there is
   * no runtime prompt to fail on — but a `SecurityException` here would still
   * mean no call can ever ring, so it is caught and reported as the refusal
   * verdict rather than crashing the process on module construction.
   *
   * THE ANSWER IS NO LONGER DISCARDABLE: both
   * callers record it into `TelecomGuard`, and `reportFresh` /
   * `reportOutgoingCall` consult that record before touching Telecom — a
   * device whose subsystem is absent (`getSystemService` null: the WiFi-only
   * tablet without `android.software.telecom`) or which refuses the account
   * fails every later call closed, at once, with the honest refusal verdict.
   */
  fun register(context: Context): Boolean {
    appContext = context.applicationContext
    // The harness's refusal seam (debug builds only — see
    // TelecomGuard.REFUSAL_SEAM_SETTING): forced, this register refuses
    // exactly as a telecom-less tablet does, and everything downstream — the
    // recorded verdict, the report guards, the honest refusal — is the
    // shipped code under test.
    if (TelecomGuard.refusalForced(context)) return false
    val telecom = context.getSystemService(TelecomManager::class.java) ?: return false
    return try {
      val account =
          PhoneAccount.builder(handle(context), "Tacendum")
              .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
              .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
              .setAddress(TelecomExtras.address(ACCOUNT_ID))
              .build()
      telecom.registerPhoneAccount(account)
      true
    } catch (denied: SecurityException) {
      false
    } catch (unsupported: IllegalArgumentException) {
      false
    }
  }

  private fun handle(context: Context): PhoneAccountHandle =
      PhoneAccountHandle(
          ComponentName(context.applicationContext, TacendumConnectionService::class.java),
          ACCOUNT_ID,
      )

  // MARK: - service callbacks

  fun cidFrom(request: ConnectionRequest?): String {
    val extras = request?.extras ?: return ""
    val incoming = extras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
    val outgoing = extras.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)
    return incoming?.getString(TelecomExtras.CID)
        ?: outgoing?.getString(TelecomExtras.CID)
        ?: extras.getString(TelecomExtras.CID)
        ?: ""
  }

  private fun detailsFrom(request: ConnectionRequest?): PendingReport {
    val extras = request?.extras
    val inner =
        extras?.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
            ?: extras?.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS)
            ?: extras
    return PendingReport(
        displayName = inner?.getString(TelecomExtras.DISPLAY_NAME) ?: "",
        hasVideo = inner?.getBoolean(TelecomExtras.HAS_VIDEO) ?: false,
    )
  }

  fun buildConnection(
      context: Context,
      cid: String,
      request: ConnectionRequest?,
  ): TacendumConnection {
    appContext = context.applicationContext
    val details = detailsFrom(request)
    val connection = TacendumConnection(cid, details.hasVideo)
    val name = details.displayName.ifEmpty { "Incoming call" }
    connection.setCallerDisplayName(name, TelecomManager.PRESENTATION_ALLOWED)
    connection.setAddress(TelecomExtras.address(cid.ifEmpty { ACCOUNT_ID }), TelecomManager.PRESENTATION_ALLOWED)
    return connection
  }

  fun onIncomingConnectionCreated(cid: String, connection: TacendumConnection) {
    if (adoptOrAbandon(cid, connection)) return
    if (!activateCreatedConnection(cid, connection) { it.setRinging() }) return
    deliverVerdict(cid, null)
  }

  fun onOutgoingConnectionCreated(cid: String, connection: TacendumConnection) {
    if (adoptOrAbandon(cid, connection)) return
    if (!activateCreatedConnection(cid, connection) { it.setDialing() }) return
    deliverVerdict(cid, null)
  }

  /**
   * The platform state transition and the final owner check share the same
   * lock account teardown uses. It therefore happens wholly before teardown
   * (which then ends it) or wholly after generation invalidation (and is
   * refused); it cannot set ringing/dialing after teardown removed the call.
   */
  private fun activateCreatedConnection(
      cid: String,
      connection: TacendumConnection,
      activate: (TacendumConnection) -> Unit,
  ): Boolean {
    val accepted =
        synchronized(lock) {
          val lease = leaseByCid[cid]
          val current =
              connectionsByCid[cid] === connection &&
                  lease != null &&
                  AccountCallOwnership.isCurrent(lease)
          if (current) activate(connection)
          current
        }
    if (accepted) return true
    deliverVerdict(cid, REFUSAL_VERDICT)
    connection.finish(DisconnectCause.CANCELED)
    return false
  }

  /**
   * Install the connection, or refuse it because the call is already over.
   *
   * Returns true when the connection was ABANDONED. The tombstone test and the
   * install happen under one lock hold, for the reason the module's own
   * second look gives: an end landing between a separate check and this
   * assignment would be overwritten by the very assignment it was racing.
   */
  private fun adoptOrAbandon(cid: String, connection: TacendumConnection): Boolean {
    val abandon =
        synchronized(lock) {
          val lease = leaseByCid[cid]
          if (
              endedBeforeVerdict.remove(cid) ||
                  lease == null ||
                  !AccountCallOwnership.isCurrent(lease)
          ) {
            leaseByCid.remove(cid)
            true
          } else {
            connectionsByCid[cid] = connection
            false
          }
        }
    if (!abandon) return false
    // The verdict is honest: nothing rang, and the layer above already
    // decided this call was over.
    deliverVerdict(cid, REFUSAL_VERDICT)
    connection.finish(DisconnectCause.CANCELED)
    return true
  }

  /** Caller holds `lock`. */
  private fun markEndedBeforeVerdictLocked(cid: String) {
    if (!pendingVerdicts.containsKey(cid)) return
    endedBeforeVerdict.add(cid)
    while (endedBeforeVerdict.size > MAX_ENDED_BEFORE_VERDICT) {
      val oldest = endedBeforeVerdict.iterator()
      oldest.next()
      oldest.remove()
    }
  }

  fun onConnectionCreationFailed(cid: String) {
    deliverVerdict(cid, REFUSAL_VERDICT)
  }

  private fun deliverVerdict(cid: String, refusal: String?) {
    // Taken under the lock and invoked outside it: the completion resolves a
    // JS promise and can re-enter this object, and `lock` guards decisions
    // rather than callbacks.
    val completion = synchronized(lock) {
      if (refusal != null) leaseByCid.remove(cid)
      pendingVerdicts.remove(cid)
    }
    completion?.invoke(refusal)
  }

  // MARK: - answering and ending

  fun onAnswered(connection: TacendumConnection) {
    // ONE lock hold from cid resolution through the parking decision. The
    // counterexample for a resolve-release-recheck: the rebind re-keys this
    // connection in the gap, so the answer resolves the SYNTHETIC cid, then
    // finds `pendingPush` already cleared and emits the synthetic cid — JS
    // rehydrates no offer under it and ends the call the person just answered.
    // Held across both, the answer sees strictly-before (parked, replayed by
    // the rebind) or strictly-after (the real cid), never the seam.
    var authorized = false
    val parked =
        synchronized(lock) {
          val cid = connection.cid
          val lease = leaseByCid[cid]
          authorized =
              connectionsByCid[cid] === connection &&
                  lease != null &&
                  AccountCallOwnership.isCurrent(lease)
          if (!authorized) {
            false
          } else if (pendingPush?.first == cid) {
            // Answered before the offer decrypted. Park it; the rebind
            // replays it with the real cid. The watchdog stays ARMED on
            // purpose: a parked answer whose offer never arrives is exactly a
            // ring nothing can resolve, and the rebind cancels it the moment
            // it proves JS alive.
            pendingAnswered = true
            true
          } else {
            false
          }
        }
    if (!authorized) {
      connection.finish(DisconnectCause.CANCELED)
      return
    }
    // Active either way: on Android the app makes the call active, and a
    // placeholder the person has already accepted is a call with audio.
    connection.setActive()
    CallNotifications.clearRing(appContext)
    if (parked) return
    cancelWatchdog(ifGuarding = connection)
    val cid = connection.cid
    emit { it.callKitAnswered(cid) }
  }

  fun onRejected(connection: TacendumConnection) {
    finishFromTelecom(connection, "decline", DisconnectCause.REJECTED)
  }

  fun onDisconnected(connection: TacendumConnection) {
    finishFromTelecom(connection, "hangup", DisconnectCause.LOCAL)
  }

  private fun finishFromTelecom(connection: TacendumConnection, reason: String, cause: Int) {
    // Correlated, like the answer above. An uncorrelated cancel would leave
    // "disarm whatever watchdog happens to be armed" as this action's only
    // surviving effect, which after a hang-up followed by a fresh wake is a
    // DIFFERENT placeholder's failsafe — the one cover that survives JS never
    // running at all.
    cancelWatchdog(ifGuarding = connection)
    val cid = connection.cid
    val authorized = synchronized(lock) {
      val lease = leaseByCid[cid]
      val current =
          connectionsByCid[cid] === connection &&
              lease != null &&
              AccountCallOwnership.isCurrent(lease)
      if (pendingPush?.first == cid) {
        pendingPush = null
        pendingAnswered = false
        pendingPushConfirmed = false
      }
      connectionsByCid.remove(cid)
      leaseByCid.remove(cid)
      current
    }
    CallNotifications.clearRing(appContext)
    connection.finish(cause)
    if (authorized) emit { it.callKitEnded(cid, reason) }
  }

  fun onMuted(connection: TacendumConnection, muted: Boolean) {
    val cid = connection.cid
    val authorized = synchronized(lock) {
      val lease = leaseByCid[cid]
      connectionsByCid[cid] === connection &&
          lease != null &&
          AccountCallOwnership.isCurrent(lease)
    }
    if (!authorized) return
    emit { it.callKitMuted(cid, muted) }
  }

  fun showIncomingCallUi(connection: TacendumConnection) {
    val context = appContext ?: return
    // ONLY FOR A CONNECTION STILL WANTED. Telecom delivers this callback
    // asynchronously, and every path that ends a ring — the blocked caller's
    // report-then-immediately-end, the watchdog, a dismissal — removes the
    // connection from the tracked set BEFORE finishing it, so the set is the
    // one authority for "this ring is still live". Measured
    // on the emulator, with a blocked CLI peer
    // calling a killed app: `endQuietly` ran clearRing and finish, Telecom's
    // own `onShowIncomingCallUi` landed AFTER both, and the re-posted ring
    // notification survived as an ONGOING "Incoming call" nothing would ever
    // clear — a blocked caller leaving a persistent mark is exactly what the
    // report-then-end path exists to prevent.
    val live = synchronized(lock) {
      val lease = leaseByCid[connection.cid]
      connectionsByCid[connection.cid] === connection &&
          lease != null &&
          AccountCallOwnership.isCurrent(lease)
    }
    if (!live) return
    CallNotifications.showRing(context, connection)
    // The delete-wins recheck, the same discipline armedAndWritable applies
    // to the previews lease: an end landing between the check above and the
    // post must still win, so ask again and take the notification down if
    // the connection vanished mid-post.
    val stillLive = synchronized(lock) {
      val lease = leaseByCid[connection.cid]
      connectionsByCid[connection.cid] === connection &&
          lease != null &&
          AccountCallOwnership.isCurrent(lease)
    }
    if (!stillLive) CallNotifications.clearRing(context)
  }

  // MARK: - reporting

  /**
   * THE REBIND. If a wake already rang this call under a synthetic cid, this
   * report is the decrypted offer catching up — the same call, now with its
   * real identity. Reporting it as NEW rings the phone twice; instead the
   * existing Connection is re-keyed to the real cid and UPDATED in place,
   * which is also what makes the later name correction land and the
   * cold-launch answer rehydrate against a cid the stored offer actually uses.
   *
   * Matched on the caller, so two different people ringing in quick
   * succession cannot adopt each other's placeholder. An empty peerId falls
   * back to adopting the single pending call.
   */
  fun reportIncomingCall(
      cid: String,
      peerId: String,
      handle: String,
      displayName: String,
      hasVideo: Boolean,
      lease: AccountCallLease,
      completion: (String?) -> Unit,
  ) {
    if (!AccountCallOwnership.isCurrent(lease)) {
      completion(REFUSAL_VERDICT)
      return
    }
    var displaced: ParkedRebind? = null
    var rebindTarget: TacendumConnection? = null
    var replayAnswer = false
    var didPark = false

    var stale = false
    synchronized(lock) {
      if (!AccountCallOwnership.isCurrent(lease)) {
        stale = true
        return@synchronized
      }
      val pending = pendingPush
      val matches = pending != null && (pending.second == peerId || peerId.isEmpty())
      if (matches && !pendingPushConfirmed) {
        // The report's verdict is STILL IN FLIGHT. Adopting now would re-key a
        // Connection Telecom may be about to refuse — the refusal then finds
        // nothing to clean, nobody learns, and JS rings a call the callee
        // cannot see. Park; the verdict re-drives this call (accepted → the
        // rebind below; refused → pendingPush is cleared and the re-entry
        // takes the fresh path, earning its own honest verdict).
        //
        // A previously parked rebind being overwritten must resolve its JS
        // promise first — losing it would hang the machine's report effect
        // forever.
        displaced = parkedRebind
        parkedRebind =
            ParkedRebind(cid, peerId, handle, displayName, hasVideo, lease, completion)
        didPark = true
      } else if (matches) {
        val existing = connectionsByCid.remove(pending!!.first)
        if (existing != null) {
          connectionsByCid[cid] = existing
          leaseByCid.remove(pending.first)
          leaseByCid[cid] = lease
          existing.cid = cid
          pendingPush = null
          pendingPushConfirmed = false
          replayAnswer = pendingAnswered
          pendingAnswered = false
          rebindTarget = existing
        }
      }
    }

    if (stale) {
      completion(REFUSAL_VERDICT)
      return
    }

    // The displaced promise is resolved OUTSIDE the lock, and the park itself
    // is what decides whether this call is over for now — not whether there
    // happened to be something to displace. Keyed on the flag rather than on
    // `displaced != null`, because the ordinary park displaces nothing and
    // must still not fall through to a fresh report.
    displaced?.completion?.invoke(null)
    if (didPark) return
    val target = rebindTarget
    if (target != null) {
      if (!AccountCallOwnership.isCurrent(lease)) {
        endQuietly(cid)
        completion(REFUSAL_VERDICT)
        return
      }
      // The watchdog exists for the case where JS NEVER RUNS and nothing can
      // ever resolve the ring. The rebind is proof JS is alive — leaving the
      // timer armed meant an IN-APP answer (which performs no Telecom action)
      // hit the 75-second mark mid-call and killed it.
      cancelWatchdog()
      applyDisplay(target, peerId, displayName)
      configureAudio(hasVideo)
      // The answer that arrived while the offer was still decrypting, replayed
      // with the cid the rest of the system actually knows.
      if (replayAnswer) emit { it.callKitAnswered(cid) }
      completion(null)
      return
    }

    // The fresh report NEEDS a name — the ring shows it full-screen — so an
    // empty name from JS resolves through the mirror and then to the honest
    // placeholder, never to a raw id, which means nothing to anyone.
    val resolved = displayName.ifEmpty { mirroredName(peerId) ?: "" }
    val effective = resolved.ifEmpty { handle.ifEmpty { "Incoming call" } }
    reportFresh(cid, effective, hasVideo, lease, completion)
  }

  /**
   * The unconditional new-call report. Separate from `reportIncomingCall` so
   * the WAKE path can use it directly: a second wake for the same caller (a
   * cancellation is urgent too) must satisfy the report obligation WITHOUT
   * entering the rebind — matching there would re-key the genuinely ringing
   * call onto a throwaway cid and orphan it.
   */
  private fun reportFresh(
      cid: String,
      displayName: String,
      hasVideo: Boolean,
      lease: AccountCallLease,
      completion: (String?) -> Unit,
  ) {
    val context = appContext
    val telecom = context?.getSystemService(TelecomManager::class.java)
    // Fail closed: a device whose Telecom refused registration fails THIS closed, at
    // once and honestly — the same verdict path an explicit Telecom refusal
    // takes, so the layer above runs its ordinary busy-teardown instead of
    // waiting out a doomed addNewIncomingCall (which throws for a
    // self-managed account that never registered — a fact the guard makes
    // unreachable rather than relies on). On the wake path the refusal
    // branch still emits voipPush, so messaging drains regardless.
    if (
        context == null ||
            telecom == null ||
            !TelecomGuard.callsPermitted() ||
            !AccountCallOwnership.isCurrent(lease)
    ) {
      completion(REFUSAL_VERDICT)
      return
    }
    configureAudio(hasVideo)
    val authorized =
        synchronized(lock) {
          if (!AccountCallOwnership.isCurrent(lease)) {
            false
          } else {
            leaseByCid[cid] = lease
            pendingVerdicts[cid] = completion
            true
          }
        }
    if (!authorized) {
      completion(REFUSAL_VERDICT)
      return
    }
    // Silence is a refusal (see VERDICT_TIMEOUT_MS): the completion is
    // resolved exactly once on every path, including the one where Telecom
    // never answers.
    //
    // AND THE TIMEOUT LEAVES THE SAME TOMBSTONE AN EXPLICIT END DOES. Telling
    // JS "refused" while a Connection is still on its way produces exactly the
    // orphan `endedBeforeVerdict` exists for: the layer above has no record of
    // the cid, so nothing it can do will ever answer or end the call the
    // system is about to hand us, and a self-managed Connection nobody can end
    // blocks the next one from ringing. Marked FIRST, then refused, so the
    // arrival can only find the mark already in place.
    main.postDelayed(
        {
          synchronized(lock) { markEndedBeforeVerdictLocked(cid) }
          deliverVerdict(cid, REFUSAL_VERDICT)
        },
        VERDICT_TIMEOUT_MS,
    )
    try {
      telecom.addNewIncomingCall(
          handle(context),
          TelecomExtras.incomingExtras(cid, displayName, hasVideo),
      )
    } catch (denied: SecurityException) {
      synchronized(lock) { leaseByCid.remove(cid) }
      deliverVerdict(cid, REFUSAL_VERDICT)
    } catch (refused: IllegalArgumentException) {
      synchronized(lock) { leaseByCid.remove(cid) }
      deliverVerdict(cid, REFUSAL_VERDICT)
    }
  }

  /**
   * A wake arrived and something must ring NOW.
   *
   * The websocket foreground service is what wakes this
   * process — and the whole `pendingPush` state machine above is written
   * against it. Kept here so the wake handler has one entry point rather than a
   * second copy of this reasoning.
   */
  fun reportIncomingPlaceholder(
      cid: String,
      from: String,
      lease: AccountCallLease,
      completion: (String?) -> Unit,
  ) {
    if (!AccountCallOwnership.isCurrent(lease)) {
      completion(REFUSAL_VERDICT)
      return
    }
    val name = mirroredName(from) ?: "Incoming call"
    // THE BLOCKED-CALLER GATE. Without it a BLOCKED person could still ring
    // the victim's locked phone full-screen: the urgency bit is client-set on
    // an opaque payload. An unreadable mirror reads as EMPTY and the call
    // rings — a block is a policy this device knows about, and "cannot read
    // the policy" must degrade to an ordinary ring, not to a device no
    // stranger's call can reach.
    val blocked = from.isNotEmpty() && blockedPeers().contains(from)

    val alreadyRinging =
        synchronized(lock) {
          if (!AccountCallOwnership.isCurrent(lease)) return@synchronized null
          val ringing = pendingPush != null
          // NEVER OVERWRITE a pending ring, and never let a BLOCKED wake
          // become one: both the rebind and the parked-rebind paths key off
          // `pendingPush`.
          if (!ringing && !blocked) {
            pendingPush = cid to from
            pendingAnswered = false
            pendingPushConfirmed = false
          }
          ringing
        }

    if (alreadyRinging == null) {
      completion(REFUSAL_VERDICT)
      return
    }

    reportFresh(cid, name, false, lease) { refusal ->
      if (!AccountCallOwnership.isCurrent(lease)) {
        endQuietly(cid)
        completion(REFUSAL_VERDICT)
        return@reportFresh
      }
      if (blocked) {
        // REPORT-THEN-IMMEDIATELY-END. The report satisfied the obligation;
        // this takes the call down before the ring can persist. JS still
        // hears the wake: the resume it triggers drains the envelope and the
        // receive path — where blocking is enforced — discards it, so the
        // server stops holding a frame nothing will ever ring for.
        endQuietly(cid)
        val ringing = ringingCid(from)
        emit { it.voipPush(cid, from, ringing) }
        completion(refusal)
        return@reportFresh
      }
      if (alreadyRinging) {
        // A deliberate throwaway (a second wake while one rings). But
        // `alreadyRinging` is a snapshot taken BEFORE this verdict returned
        // and the first call can end inside that window, in which case
        // Telecom ACCEPTS this report and the throwaway is ringing
        // full-screen — merely forgetting it strands it. End what was
        // accepted before forgetting it.
        endQuietly(cid)
      } else if (refusal != null) {
        // REFUSED — a wake during an active cellular call, say. Clear the
        // phantom; the parked rebind (if any) re-drives into the FRESH path
        // and earns its own honest verdict, which is what lets JS's
        // busy-teardown finally see the refusal.
        val parked =
            synchronized(lock) {
              if (pendingPush?.first == cid) {
                pendingPush = null
                pendingAnswered = false
                pendingPushConfirmed = false
              }
              connectionsByCid.remove(cid)
              leaseByCid.remove(cid)
              val p = parkedRebind
              parkedRebind = null
              p
            }
        if (parked != null) {
          reportIncomingCall(
              parked.cid,
              parked.peerId,
              parked.handle,
              parked.displayName,
              parked.hasVideo,
              parked.lease,
              parked.completion,
          )
        }
      } else {
        val stillPending = synchronized(lock) {
          val same = pendingPush?.first == cid
          if (same) pendingPushConfirmed = true
          same
        }
        // Armed only for a report Telecom ACCEPTED and still pending — a
        // dismissal that beat this verdict already ended the placeholder. The
        // arm runs STRICTLY BEFORE the parked rebind replays: the rebind's
        // cancel must run after it, or the watchdog ends up guarding a live
        // call and kills it at 75 seconds.
        if (stillPending) {
          val connection = synchronized(lock) { connectionsByCid[cid] }
          if (connection != null) armWatchdog(connection)
        }
        performParkedRebind()
      }
      // Only after Telecom has been told does JS hear about it — it may need
      // to reconnect the socket to fetch the envelope, and that must not
      // happen before the report. The RINGING placeholder's cid, not this
      // wake's: on the `alreadyRinging` branch they differ and only this one
      // is nameable. Captured NOW, not at replay: a buffered wake must name
      // the placeholder that was ringing when it happened.
      val ringing = ringingCid(from)
      emit { it.voipPush(cid, from, ringing) }
      completion(refusal)
    }
  }

  /**
   * Adopt the parked rebind — decided and re-keyed under ONE lock hold, so a
   * dismissal cannot land between "take the parked value" and "act on it".
   * Three outcomes, each resolving the parked JS promise exactly once.
   */
  private fun performParkedRebind() {
    var parked: ParkedRebind? = null
    var target: TacendumConnection? = null
    var replayAnswer = false
    var abandoned = false

    synchronized(lock) {
      parked = parkedRebind ?: return@synchronized
      parkedRebind = null
      val pending = pendingPush
      val matches =
          AccountCallOwnership.isCurrent(parked!!.lease) &&
              pending != null &&
              pendingPushConfirmed &&
              (pending.second == parked!!.peerId || parked!!.peerId.isEmpty())
      val existing = if (matches) connectionsByCid.remove(pending!!.first) else null
      if (existing == null) {
        abandoned = true
      } else {
        connectionsByCid[parked!!.cid] = existing
        leaseByCid.remove(pending!!.first)
        leaseByCid[parked!!.cid] = parked!!.lease
        existing.cid = parked!!.cid
        pendingPush = null
        pendingPushConfirmed = false
        replayAnswer = pendingAnswered
        pendingAnswered = false
        target = existing
      }
    }

    val value = parked ?: return
    if (abandoned || target == null) {
      // Pending gone (dismissed while the verdict was in flight): resolve
      // WITHOUT reporting, because the call this rebind served no longer
      // exists.
      value.completion(null)
      return
    }
    if (!AccountCallOwnership.isCurrent(value.lease)) {
      endQuietly(value.cid)
      value.completion(REFUSAL_VERDICT)
      return
    }
    cancelWatchdog()
    applyDisplay(target!!, value.peerId, value.displayName)
    configureAudio(value.hasVideo)
    if (replayAnswer) emit { it.callKitAnswered(value.cid) }
    value.completion(null)
  }

  /**
   * Correct the placeholder once the envelope has decrypted.
   *
   * An empty displayName means JS has NO REAL NAME — its fallback is a raw id,
   * and stamping that over the mirror name this placeholder is already showing
   * is a downgrade. Consult the mirror; with nothing there either, leave the
   * name alone, so the ring keeps whatever it is showing.
   */
  private fun applyDisplay(connection: TacendumConnection, peerId: String, displayName: String) {
    val resolved = displayName.ifEmpty { mirroredName(peerId) ?: "" }
    if (resolved.isEmpty()) return
    connection.setCallerDisplayName(resolved, TelecomManager.PRESENTATION_ALLOWED)
    CallNotifications.updateRingName(appContext, connection, resolved)
  }

  fun updateDisplay(cid: String, displayName: String) {
    if (displayName.isEmpty()) return
    val connection = synchronized(lock) { connectionsByCid[cid] } ?: return
    connection.setCallerDisplayName(displayName, TelecomManager.PRESENTATION_ALLOWED)
    CallNotifications.updateRingName(appContext, connection, displayName)
  }

  fun reportOutgoingCall(
      cid: String,
      handle: String,
      hasVideo: Boolean,
      lease: AccountCallLease,
  ): Boolean {
    // Fail closed BEFORE touching the platform — same reasoning as
    // reportFresh's guard. `false` reaches JS as the report_failed rejection,
    // which is the machine half of the honest refusal; the human half
    // (the degraded call affordance with its reason) is the JS half.
    if (!TelecomGuard.callsPermitted() || !AccountCallOwnership.isCurrent(lease)) return false
    val context = appContext ?: return false
    val telecom = context.getSystemService(TelecomManager::class.java) ?: return false
    // `hasVideo` reaches BOTH the Telecom record and the audio configuration.
    // Reporting an outgoing video call as a voice call gets the wrong entry in
    // the system's own bookkeeping AND brings the route up without the
    // loudspeaker default — a video call you place is exactly the one that has
    // to be audible from arm's length.
    configureAudio(hasVideo)
    val extras = TelecomExtras.outgoingExtras(cid, handle, hasVideo)
    extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle(context))
    val authorized = synchronized(lock) {
      if (!AccountCallOwnership.isCurrent(lease)) false
      else {
        leaseByCid[cid] = lease
        true
      }
    }
    if (!authorized) return false
    return try {
      telecom.placeCall(TelecomExtras.address(cid), extras)
      true
    } catch (denied: SecurityException) {
      synchronized(lock) { leaseByCid.remove(cid) }
      false
    } catch (refused: IllegalArgumentException) {
      synchronized(lock) { leaseByCid.remove(cid) }
      false
    }
  }

  fun reportOutgoingConnected(cid: String) {
    val connection = synchronized(lock) {
      val lease = leaseByCid[cid]
      if (lease != null && AccountCallOwnership.isCurrent(lease)) connectionsByCid[cid] else null
    } ?: return
    // ACTIVE is the activation moment: the audio unit starts from the
    // state change, in `CallAudioGate.onConnectionActive`, and nowhere else.
    connection.setActive()
  }

  /**
   * An answer taken on the app's OWN screen, for a call reported under `cid`
   * (a session's sid, for its one Telecom connection). The iOS twin requests
   * the `CXAnswerCallAction` CallKit never saw; here the Telecom equivalent
   * is making the ringing connection ACTIVE, which is this platform's
   * activation moment (§7.4, re-derived in `CallAudioGate`). No event goes up
   * — JS is the one answering — and a connection that is not ringing (already
   * answered from the notification, or outgoing) is left exactly as it is. */
  fun answerFromApp(cid: String) {
    val connection = synchronized(lock) {
      val lease = leaseByCid[cid]
      if (lease != null && AccountCallOwnership.isCurrent(lease)) connectionsByCid[cid] else null
    } ?: return
    if (connection.state != android.telecom.Connection.STATE_RINGING) return
    cancelWatchdog(ifGuarding = connection)
    connection.setActive()
    CallNotifications.clearRing(appContext)
  }

  fun endCall(cid: String, reason: String) {
    // LOOKUP, never create: JS tears calls down that Telecom sometimes never
    // had (a report refused, a mapping already forgotten by the disconnect
    // handler) — minting one here just to report it ended leaves a phantom.
    val connection =
        synchronized(lock) {
          val found = connectionsByCid.remove(cid)
          leaseByCid.remove(cid)
          // The tombstone is laid FIRST and under the same lock as the
          // removal, so a Connection the system is about to hand us cannot
          // slip in between the two.
          if (found == null) markEndedBeforeVerdictLocked(cid)
          found
        }
    if (connection == null) {
      deliverVerdict(cid, REFUSAL_VERDICT)
      return
    }
    cancelWatchdog(ifGuarding = connection)
    synchronized(lock) {
      if (pendingPush?.first == cid) {
        pendingPush = null
        pendingAnswered = false
        pendingPushConfirmed = false
      }
    }
    CallNotifications.clearRing(appContext)
    connection.finish(disconnectCauseFor(reason))
  }

  private fun endQuietly(cid: String) {
    val connection = synchronized(lock) {
      leaseByCid.remove(cid)
      connectionsByCid.remove(cid)
    } ?: return
    CallNotifications.clearRing(appContext)
    connection.finish(DisconnectCause.MISSED)
  }

  private fun disconnectCauseFor(reason: String): Int =
      when (reason) {
        "decline", "busy" -> DisconnectCause.REMOTE
        "timeout", "expired", "cancelled" -> DisconnectCause.MISSED
        "failed_ice", "failed_media" -> DisconnectCause.ERROR
        else -> DisconnectCause.REMOTE
      }

  /**
   * Dismiss the placeholder a wake rang, when the decrypted truth says it must
   * not ring: the caller is blocked or silenced (the ring came up before
   * anything could decrypt), or the frame behind the wake turned out to be a
   * cancellation.
   *
   * AND MATCHED ON THE PLACEHOLDER ITSELF. `cid` names the ring the caller
   * decided about; a verdict that lands after this peer's placeholder was
   * replaced is a strict no-op instead of ending a ring it never decided — and
   * ending one is expensive here, because the body clears an answer the person
   * already tapped and abandons a parked rebind. An empty `cid` degrades to
   * the caller-keyed match, which is what makes version skew safe.
   */
  fun dismissPendingIncomingCall(peerId: String, reason: String, cid: String) {
    var parked: ParkedRebind? = null
    var doomed: TacendumConnection? = null
    synchronized(lock) {
      val pending = pendingPush ?: return
      if (!(peerId.isEmpty() || pending.second == peerId)) return
      if (!(cid.isEmpty() || pending.first == cid)) return
      cancelWatchdogLocked()
      pendingPush = null
      pendingAnswered = false
      pendingPushConfirmed = false
      // A rebind parked on this pending call must not be re-driven later — the
      // call is being dismissed; a re-drive would FRESH-report it and ring a
      // cancelled call. Abandon resolves the JS promise instead.
      parked = parkedRebind
      parkedRebind = null
      doomed = connectionsByCid.remove(pending.first)
      leaseByCid.remove(pending.first)
      // Same window as `endCall`: the placeholder may be a report whose
      // Connection the system has not handed us yet, and a dismissal that
      // ended nothing would let it arrive alive and unreachable.
      if (doomed == null) markEndedBeforeVerdictLocked(pending.first)
    }
    parked?.completion?.invoke(null)
    val connection = doomed ?: return
    CallNotifications.clearRing(appContext)
    connection.finish(
        if (reason == "cancelled") DisconnectCause.REMOTE else DisconnectCause.MISSED
    )
  }

  /**
   * The cid of the placeholder currently ringing FOR THIS CALLER, or "" when
   * none is. Published on every wake so JS can name the exact placeholder a
   * later verdict decided — a throwaway second-wake cid never can, because
   * `alreadyRinging` deliberately leaves `pendingPush` on the FIRST ring.
   */
  private fun ringingCid(from: String): String =
      synchronized(lock) {
        val pending = pendingPush ?: return ""
        if (pending.second != from) "" else pending.first
      }

  // MARK: - watchdog

  private fun armWatchdog(connection: TacendumConnection) {
    val runnable = Runnable {
      var doomed: TacendumConnection? = null
      synchronized(lock) {
        watchdog = null
        watchdogConnection = null
        val cid = connection.cid
        if (connectionsByCid[cid] === connection) {
          if (pendingPush?.first == cid) {
            pendingPush = null
            pendingAnswered = false
            pendingPushConfirmed = false
          }
          connectionsByCid.remove(cid)
          doomed = connection
        }
      }
      if (doomed != null) {
        CallNotifications.clearRing(appContext)
        doomed!!.finish(DisconnectCause.MISSED)
      }
    }
    synchronized(lock) {
      watchdog?.let { main.removeCallbacks(it) }
      watchdog = runnable
      watchdogConnection = connection
    }
    main.postDelayed(runnable, PLACEHOLDER_TIMEOUT_MS)
  }

  private fun cancelWatchdogLocked() {
    watchdog?.let { main.removeCallbacks(it) }
    watchdog = null
    watchdogConnection = null
  }

  private fun cancelWatchdog() {
    synchronized(lock) { cancelWatchdogLocked() }
  }

  /**
   * Cancel only when the resolving call IS the guarded one — a stale
   * `call.end` from a different peer, or an unrelated Telecom release, must
   * not disarm the watchdog protecting a still-ringing placeholder.
   */
  private fun cancelWatchdog(ifGuarding: TacendumConnection) {
    synchronized(lock) { if (watchdogConnection === ifGuarding) cancelWatchdogLocked() }
  }

  // MARK: - audio route

  /**
   * CONFIGURE only. Activation belongs to the Connection reaching ACTIVE;
   * starting the audio unit here is the bug the handshake exists to prevent.
   *
   * A LIVE CALL OWNS THE ROUTE, and a second call being reported must not take
   * it away — every report path reaches here, including a wake arriving while
   * a call is already up, and that one reports before anything has decrypted,
   * so it necessarily says `hasVideo = false`. The ANSWER IS STILL RECORDED
   * and only the application is skipped: nothing reads the record until the
   * next activation, and the next activation belongs to whichever call wrote
   * it last.
   */
  private fun configureAudio(video: Boolean) {
    val active: Boolean
    synchronized(routeLock) {
      desiredSpeaker = video
      active = CallAudioGate.isActive()
    }
    if (active) return
    CallAudioGate.rememberRoute(video)
  }

  fun setSpeaker(on: Boolean) {
    synchronized(routeLock) { desiredSpeaker = on }
    CallAudioGate.rememberRoute(on)
    CallAudioGate.applyRoute(activeConnection())
  }

  fun desiredSpeaker(): Boolean = synchronized(routeLock) { desiredSpeaker }

  fun activeConnection(): TacendumConnection? =
      synchronized(lock) { connectionsByCid.values.firstOrNull() }

  /** The live Connection for a cid, or null. The notification actions' lookup. */
  fun connectionFor(cid: String): TacendumConnection? =
      synchronized(lock) { connectionsByCid[cid] }

  fun hasLiveConnection(): Boolean = synchronized(lock) { connectionsByCid.isNotEmpty() }

  // MARK: - shared-state mirrors

  /**
   * The saved display name for a peer, read from the shared-state mirror.
   *
   * The app writes `peer-names` (a JSON object, ulid → name) alongside the
   * blocked-peers mirror. Reading it here is what lets the FIRST paint of the
   * ring carry the caller's real name even when the process was dead a moment
   * ago — the app-side correction still runs later, but it needs seconds the
   * person is already spending looking at "Incoming call".
   *
   * Null in duress (the app deletes the mirror) and for unknown callers. Every
   * null shows the placeholder — never the raw ULID, which means nothing to
   * anyone.
   */
  // Internal, not private: the missed-call notice (`MissedCallNotification`)
  // reads the same mirror when the JS side knows no name — the locked
  // phone's case, the one a missed call most often lands on.
  fun mirroredName(peerId: String): String? {
    if (peerId.isEmpty()) return null
    val context = appContext ?: return null
    return try {
      val file = File(File(context.filesDir, SHARED_DIR), "peer-names")
      if (!file.isFile) return null
      val name = JSONObject(file.readText()).optString(peerId, "")
      name.ifEmpty { null }
    } catch (unreadable: Exception) {
      null
    }
  }

  /**
   * Peers this device has blocked, read from the same mirror.
   *
   * Deliberately SURVIVES relock and duress, because the locked phone is
   * exactly where this reader does its work. Unreadable reads as EMPTY and the
   * call rings.
   */
  private fun blockedPeers(): Set<String> {
    val context = appContext ?: return emptySet()
    return try {
      val file = File(File(context.filesDir, SHARED_DIR), "blocked-peers")
      if (!file.isFile) return emptySet()
      file.readText().split("\n").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    } catch (unreadable: Exception) {
      emptySet()
    }
  }

  private const val SHARED_DIR = "tacendum-shared"

  /** End and forget the departing account without replaying events to JS. */
  fun clearForAccountChange() {
    val connections: List<TacendumConnection>
    val verdicts: List<(String?) -> Unit>
    val parked: ParkedRebind?
    synchronized(lock) {
      connections = connectionsByCid.values.distinct()
      connectionsByCid.clear()
      leaseByCid.clear()
      verdicts = pendingVerdicts.values.toList()
      pendingVerdicts.clear()
      endedBeforeVerdict.clear()
      pendingPush = null
      pendingAnswered = false
      pendingPushConfirmed = false
      parked = parkedRebind
      parkedRebind = null
      cancelWatchdogLocked()
    }
    synchronized(sinkLock) { preSink.clear() }
    synchronized(routeLock) { desiredSpeaker = false }
    CallNotifications.clearRing(appContext)
    for (connection in connections) connection.finish(DisconnectCause.CANCELED)
    for (completion in verdicts) completion(REFUSAL_VERDICT)
    parked?.completion?.invoke(REFUSAL_VERDICT)
  }

  /**
   * The system tore everything down, or the process is going away. Every call
   * we thought we had is gone.
   */
  fun reset() {
    val cids: List<String>
    synchronized(lock) {
      cids = connectionsByCid.keys.toList()
      connectionsByCid.clear()
      leaseByCid.clear()
      pendingVerdicts.clear()
      pendingPush = null
      pendingAnswered = false
      pendingPushConfirmed = false
      parkedRebind = null
      endedBeforeVerdict.clear()
      cancelWatchdogLocked()
    }
    synchronized(routeLock) { desiredSpeaker = false }
    for (cid in cids) emit { it.callKitEnded(cid, "failed") }
  }
}
