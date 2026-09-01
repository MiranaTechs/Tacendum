# Security

## Reporting a vulnerability

Please report security issues privately to **security@tacendum.com** rather
than opening a public issue. Include what you did, what happened, and what
you expected; a proof of concept helps but is not required to get a reply.

We aim to acknowledge within 3 working days. If you do not hear back, that
is a failure on our side — please chase it.

Please do not run denial-of-service tests, spam, or automated scans against
`api.tacendum.com` or the TURN relay. Everything in this repository runs
locally with no AWS account (see the README), which is a better place to
test anyway.

## What we consider in scope

The clients and the service in this repository: the iOS app, the shared
protocol modules, the server handlers, and the CLI. Cryptographic issues
are the highest priority, followed by anything that lets one account affect
another's device, data, or availability.

Content cryptography is [libsignal](https://github.com/signalapp/libsignal);
please report issues in the protocol itself to Signal.

## Session revocation — what is enforced, and what a deployment must wire

Revoking a session (sign-out, "sign out everywhere else", account deletion,
or a superseding sign-in) enforces against any live WebSocket that session
opened through two independent mechanisms:

1. **The per-frame session guard**, entirely in this repository
   (`packages/server/src/handlers/session-guard.ts`). Every socket is bound
   at dial time to the session that opened it; a socket with no such binding
   is refused outright — there are no exempt "legacy" sockets. A positive
   ("still signed in") verdict is **never cached**: each client frame, each
   live delivery to a connected recipient, and each queue-drain slice
   re-reads the session with a strongly consistent read. Once a revocation
   commits, the socket's next frame is refused, its next live delivery is
   withheld, and its routing row is torn down; the only frames a revoked
   session can still land are those already in flight when the revocation
   committed (milliseconds of request overlap, irreducible under any
   check-then-act design). The one cadenced path is a long queue drain,
   which re-validates the session every 5 seconds mid-slice — so a socket
   revoked mid-drain stops receiving within ~5 seconds. Negative verdicts
   are cached (a revoked or expired session never becomes valid again), so
   this costs one session read per guarded action, not per retry.

2. **A proactive transport disconnect** — hanging the socket itself up at
   revocation time. This half is a *deployment* capability, not a code
   default: the HTTP and Auth functions front a different API than the
   WebSocket fleet, so they can only issue the hang-up if the deployment
   gives them `WS_API_DOMAIN` and `WS_API_STAGE` (the WebSocket API's
   execute-api management endpoint) **and** an IAM grant of
   `execute-api:ManageConnections` covering `DELETE` on that API's
   `@connections/*`. Our deployment (its infrastructure code is not part of
   this repository) wires all
   three onto exactly those two functions, and additionally sets
   `WS_DISCONNECT_REQUIRED=1`, under which the server **refuses to start**
   if the endpoint pair is missing (`packages/server/src/aws/deps.ts`) —
   so a production deployment cannot silently lose the capability.

**Degradation, stated honestly.** A deployment without the proactive wiring
(and without `WS_DISCONNECT_REQUIRED=1`, e.g. local development) still
enforces revocation through mechanism 1: the revoked socket's routing row is
deleted, it receives nothing further (live delivery and drains re-validate),
and its next frame is refused and the socket closed then. What is lost is
only the immediate hang-up — a revoked socket that never speaks may linger
open (deaf and mute) until it next sends or is delivered to. Any revocation
that needed the missing hang-up logs `ws_disconnector_unwired` naming the
absent variables, so the degraded state is visible in logs, never silent.

## Signing keys

`app/android/app/debug.keystore` is the conventional public Android debug
keystore (`androiddebugkey`) that every Android SDK ships; it signs debug
builds only and protects nothing. Release signing requires a separate upload
keystore, which is never part of this repository.

## Accepted dependency advisories

`pnpm audit --prod` is not empty, and pretending otherwise would be worse
than explaining why. Advisories that can be fixed by a patch-level bump are
forced through `overrides` in `pnpm-workspace.yaml`. Two remain, both
deliberately not forced:

| Advisory | Why it is not forced |
|---|---|
| `image-size` (< 2.0.3) — infinite loop in the ICNS/JXL/HEIF parsers | Reached only through Metro, the React Native bundler, which calls it at BUILD time to measure image assets that are part of this repository. The malicious input would have to be an image a developer added to their own project. Fixing it means 1.x → 2.x under Metro's asset pipeline. |
| `fast-xml-parser` (< 5.7.0) — XML comment/CDATA injection in XMLBuilder | Reached only through `@react-native-community/cli-platform-*`, which parses the developer's own Android/iOS project files during local development. Fixing it means 4.x → 5.x under the React Native CLI. |

Neither package is present in a shipped artifact. They are not compiled into
the iOS app, not bundled into the server's Lambda functions, and not included
in the published CLI tarball — they exist only in the development and build
toolchain, where the untrusted input they warn about does not occur.

This position is re-derived, not inherited: if either package becomes
reachable from shipped code, or a fix lands that does not require a major
bump, the override goes in and this table shrinks.
