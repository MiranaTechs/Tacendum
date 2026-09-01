# Security

## Reporting a vulnerability

Please report security issues privately to **security@tacendum.com** rather
than opening a public issue. Include what you did, what happened, and what
you expected; a proof of concept helps but is not required to get a reply.

We aim to acknowledge reports within 3 working days. Please follow up if you
do not receive an acknowledgement.

Do not run denial-of-service tests, spam, or automated scans against
`api.tacendum.com` or the TURN relay. The repository can run locally without
an AWS account; use a local environment for testing.

## What we consider in scope

The clients and the service in this repository: the iOS app, the shared
protocol modules, the server handlers, and the CLI. Cryptographic issues
are the highest priority, followed by anything that lets one account affect
another's device, data, or availability.

Content cryptography is [libsignal](https://github.com/signalapp/libsignal);
please report issues in the protocol itself to Signal.

## Session revocation — what is enforced, and what a deployment must wire

Revocation covers sign-out, "sign out everywhere else," account deletion, and
a superseding sign-in. It applies to live WebSockets through two mechanisms:

1. **Per-frame session guard.**
   `packages/server/src/handlers/session-guard.ts` binds every socket to its
   opening session at dial time and refuses an unbound socket. A positive
   ("still signed in") verdict is never cached: every client frame, live
   delivery to a connected recipient, and queue-drain slice re-reads the
   session with a strongly consistent read. After revocation commits, the
   next frame is refused, the next live delivery is withheld, and the routing
   row is removed. Only frames already in flight at commit time can still
   land. A long queue drain revalidates every 5 seconds, so a socket revoked
   mid-drain stops receiving within about 5 seconds. Negative verdicts are
   cached because a revoked or expired session cannot become valid again.

2. **Proactive transport disconnect.** The HTTP and Auth functions front a
   different API from the WebSocket fleet. To close a socket at revocation,
   both functions need `WS_API_DOMAIN` and `WS_API_STAGE` for the WebSocket
   execute-api management endpoint, plus an IAM
   `execute-api:ManageConnections` grant covering `DELETE` on that API's
   `@connections/*`. Production sets those values and
   `WS_DISCONNECT_REQUIRED=1`; with that flag, the server refuses to start if
   the endpoint pair is missing (`packages/server/src/aws/deps.ts`).

Without the proactive wiring and without `WS_DISCONNECT_REQUIRED=1`, as in
local development, mechanism 1 still deletes the routing row, blocks further
delivery, and refuses and closes the socket on its next frame. The socket may
remain open but unable to send or receive until then. A revocation that needed
the unavailable disconnect logs `ws_disconnector_unwired` and names the
missing variables.

## Signing keys

`app/android/app/debug.keystore` contains only the conventional public Android
debug credential (`androiddebugkey`). It signs debug builds and protects
nothing. Release signing requires a separate upload keystore, which is never
part of this repository.

## Accepted dependency advisories

As of 2026-09-01, `pnpm audit --prod` against the checked-in lockfile reports
three advisories across two build-only packages. Their available fixes require
major-version changes in the surrounding toolchain. Advisories fixable with a
patch-level bump are forced through `overrides` in `pnpm-workspace.yaml`.

| Advisory | Why it is not forced |
|---|---|
| `image-size` (< 2.0.3) — infinite loop in the ICNS/JXL/HEIF parsers | Reached only through Metro, the React Native bundler, which calls it at BUILD time to measure image assets that are part of this repository. The malicious input would have to be an image a developer added to their own project. Fixing it means 1.x → 2.x under Metro's asset pipeline. |
| `fast-xml-parser` (< 5.7.0) — XML comment/CDATA injection in XMLBuilder | Reached only through `@react-native-community/cli-platform-*`, which parses the developer's own Android/iOS project files during local development. Fixing it means 4.x → 5.x under the React Native CLI. |

Neither package is present in the app, Lambda bundles, or packed CLI artifact.
They are used only by the development and build toolchain, where the documented
workflow gives them repository-controlled project inputs rather than remote
user content.

If either package becomes reachable from a packaged runtime, or a compatible
fix is available, the package should be overridden and this table updated.
