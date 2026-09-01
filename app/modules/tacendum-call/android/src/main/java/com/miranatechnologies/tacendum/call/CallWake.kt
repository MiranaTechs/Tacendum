package com.miranatechnologies.tacendum.call

import android.content.Context

/**
 * The one public door a push-wake has into the ring machinery.
 *
 * `TacendumFcmService` lives in the application module and `TelecomCenter` is
 * internal to this one, deliberately — the wake gets exactly one entry point
 * with the preconditions handled, not the run of a state machine whose every
 * other method assumes the module facade is driving it.
 *
 * **What a cold process is missing, and why each line is here.** An FCM
 * call-wake can be the first thing that ever runs in this process: no
 * activity, no React, no `TacendumCallModule` — so nothing has registered the
 * PhoneAccount (`TelecomCenter.register` runs on module construction), nothing
 * has created the ring notification channel, and `TelecomCenter.appContext`
 * is null, which `reportFresh` reads as a refusal. Both calls are idempotent
 * — registering the same PhoneAccount replaces it, creating an existing
 * channel is a no-op — so the warm case pays two cheap re-assertions and the
 * cold case actually rings.
 *
 * The verdict completion is dropped on purpose: on the module path it
 * resolves a JS promise, and here there is no JavaScript to tell. Refusal has
 * the same meaning it has on iOS's PushKit path when CallKit refuses a
 * report — the placeholder machinery cleans itself up (`reportFresh`'s
 * refusal branch), and the app learns what happened when it next drains the
 * queue.
 *
 * Nothing here logs, and nothing here reads the wake's payload — the cid is
 * minted or opaque, `from` is an opaque id checked against the block mirror
 * inside `reportIncomingPlaceholder`, and no other byte of the push exists by
 * the time this is called (PushWakeRouter drops everything else).
 */
object CallWake {

  fun reportIncomingPlaceholder(context: Context, cid: String, from: String) {
    val app = context.applicationContext
    CallNotifications.ensureChannels(app)
    // The register verdict is CHECKED, not
    // discarded — recorded into TelecomGuard for the report path below to
    // consult. A refusal deliberately does NOT short-circuit this wake:
    // reportFresh reads the guard and answers the honest refusal verdict at
    // once, its refusal branch is the cleanup, and the voipPush emission
    // still reaches JS — the wake's messaging half (drain the envelope)
    // survives on a device whose calls cannot ring. That asymmetry IS the
    // Recorded divergence: calls fail closed with a reason, messaging unaffected.
    TelecomGuard.recordVerdict(TelecomCenter.register(app))
    TelecomCenter.reportIncomingPlaceholder(cid, from) {
      // No JS to answer — see the class note.
    }
  }
}
