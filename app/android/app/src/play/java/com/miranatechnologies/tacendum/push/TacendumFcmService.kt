package com.miranatechnologies.tacendum.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.UUID

/**
 * The FCM entry point — deliberately the THINNEST class in
 * the tree, because it is the only one whose compilation is conditional.
 *
 * **This file is in `src/play/`, which app/build.gradle adds to the main
 * source set ONLY when `google-services.json` exists beside it.** Everything
 * with substance — the routing (`PushWakeRouter`), the dispatch
 * (`PushWakeHandler`), the token store, the ring machinery, the NSE-role
 * handler — lives in the always-compiled tree, where the JVM tests and the
 * logging audits reach it in every build state. What lives here is exactly
 * the part that cannot compile without `firebase-messaging` on the classpath:
 * the subclass declaration and the two overrides. If this file grows logic,
 * that logic has left the tested, audited world — do not let it.
 *
 * The manifest declares this service unconditionally but ENABLED only when
 * the build was wired (the `tacendumFcmEnabled` placeholder), and Firebase
 * itself exists only in wired builds — so in an unwired build this class is
 * neither compiled, enabled, nor reachable.
 *
 * Both overrides run on FCM's own background thread and are handed nothing
 * but ids: `onMessageReceived` forwards the data map through the router,
 * which reads four keys and drops the rest — THE WAKE CARRIES NO WORDS —
 * and `onNewToken` forwards the one token that feeds both JS events.
 * Nothing here logs.
 */
class TacendumFcmService : FirebaseMessagingService() {

  override fun onNewToken(token: String) {
    PushWakeHandler.newToken(applicationContext, token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    PushWakeHandler.handle(
        applicationContext,
        // The UUID mint is iOS's exact fallback for a wake with no cid
        // (CallKitCenter.swift: `?? UUID().uuidString`).
        PushWakeRouter.route(message.data) { UUID.randomUUID().toString() },
    )
  }
}
