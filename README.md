# Tacendum

Tacendum is an end-to-end encrypted messenger for 1:1 conversations and small
rooms. Message and attachment cryptography uses
[libsignal](https://github.com/signalapp/libsignal). The same Lambda-shaped
handlers run behind a local Node adapter or API Gateway, so the full stack can
run locally without an AWS account. Clients include a React Native app for iOS
and Android and command-line clients.

## License

Tacendum is **AGPL-3.0-only** (`LICENSE`; the CLI package declares the same
license). The app, CLI, and server authentication function link libsignal,
which is also AGPL-3.0-only. The published terms, privacy policy, and developers
page state the license, a three-year written offer for the complete
Corresponding Source, and an AGPL Section 7 additional permission for App Store
distribution of code whose copyright is ours. See `THIRD-PARTY-NOTICES.md` for
dependency attribution.

## Repository layout

This repository is the complete Corresponding Source for the client and
service code in this tree.

| Path | Contents |
|---|---|
| `app/` | React Native 0.86 iOS and Android app, with Swift and Kotlin TurboModules |
| `packages/shared/` | Wire DTOs, WebSocket frames, auth-signature payloads, table names, room folding, group envelopes, timestamp-free message IDs, and call state machines |
| `packages/server/` | Pure handlers, the local HTTP/WebSocket host, and eight Lambda entry points |
| `packages/cli/` | libsignal-based command-line clients and integration tooling |

Every handler in `packages/server/src/handlers/` is a function of
`(event, deps)` using API Gateway HTTP or WebSocket event shapes. The local
adapter and a cloud deployment host the same handlers without changing handler
code.

Deployment infrastructure, release tooling, the website, and brand assets are
maintained separately. The source here is sufficient to build and run the
system locally.

## Requirements

- **Node:** 20.19+, 22.13+, or 24.3+ (tested on 22); **pnpm:** 11.
- **Local services:** Docker for DynamoDB Local and MinIO. coturn is an
  optional Docker Compose profile.
- **iOS:** macOS, Xcode 26+, CocoaPods 1.13+, and watchman.
- **Android:** Android SDK platform 36, build-tools 36.0.0, NDK
  27.1.12297006, and `ANDROID_HOME`. Gradle uses JDK 17; the host-JVM crypto
  suites require JDK 21 because libsignal classes use class-file version 65.
  `minSdk` is 26, and Gradle commands run from `app/android/`.
- **macOS 26:** Node can segfault while reading the system keychain with
  `NODE_USE_SYSTEM_CA=1`. Project scripts set `NODE_USE_SYSTEM_CA=0`.

## Quick start

From the repository root:

```sh
cp .env.example .env
pnpm install
pnpm infra:up
pnpm tables:create
pnpm dev
```

The local HTTP adapter listens on port 8080 and the WebSocket adapter on 8081.
Use `pnpm turn:up` when the optional local coturn service is needed.

Copying `.env.example` first keeps checkout commands on the local backend.
Backend selection follows these rules:

- `TACENDUM_ENV` accepts `local` or `aws`; any other value is refused.
- Non-empty `TACENDUM_API` and `TACENDUM_WS` values override the selected
  environment individually.
- The CLI loads the root `.env` itself, with exported environment variables
  taking precedence. An installed CLI defaults to the hosted service at
  `api.tacendum.com`.
- Debug app builds inline the root `.env` through `react-native-dotenv`.
  `TACENDUM_API` and `TACENDUM_WS` must exist in an `.env` file, even when
  empty; empty means unset, and a non-empty shell export can then override it.
  Restart Metro after changing the file.
- Release app builds always use `aws` and ignore these environment settings.

Before its first request, each CLI process prints the selected backend to
stderr, for example `tacendum: api localhost:8080 (local)`.

The server emits structured JSON logs. Its logging boundary is absolute: no
message payloads, plaintext, tokens, or key material
(`packages/server/src/log.ts`). Account registration is proved by signature
and requires no phone number or verification code. The tree also contains an
optional phone attach and recovery path; its app UI is disabled by default
(`PHONE_UI_ENABLED=false`), and its server routes require a separate feature
flag before they can send SMS verification codes.

## CLI demo

With the local server running, define a copyable shorthand and use two shells:

```sh
cli() { pnpm --filter @tacendum/cli cli "$@"; }

cli register alice
cli register bob

# One shell
cli listen bob

# Another shell
cli send alice bob "hello, bob"

# Compare these out of band; both ends must match
cli safety alice bob
cli safety bob alice

# After verifying a replacement identity
cli trust alice bob
```

Each client-generated keypair is the account. Registration needs no phone
number, email address, or verification code. If a peer reinstalls, the new
identity blocks sending until its safety number is reviewed and explicitly
trusted.

See [`packages/cli/README.md`](packages/cli/README.md) for installation,
pairing, automation, and core commands. `tacendum --help` is the complete
command reference.

## Mobile app

Install iOS dependencies from the repository root:

```sh
cd app
bundle install
cd ios
bundle exec pod install
cd ../..
```

Simulator builds need no signing configuration. For a device build, copy the
signing template and set `TACENDUM_DEVELOPMENT_TEAM`:

```sh
cp app/ios/Tacendum.xcconfig.example app/ios/Tacendum.local.xcconfig
```

Start Metro on port 8083 in shell 1:

```sh
pnpm --dir app start
```

Launch a client from shell 2:

```sh
pnpm --dir app ios
# or
pnpm --dir app android
```

Registration is one tap: the phone generates a keypair, signs a server nonce,
and uses that key as the account. An email address or username can be linked
later, optionally and revocably, for discovery. The thread header's **Verify**
action shows the safety number. Identity keys are immutable server-side, so a
reinstall creates a new contact; a changed key on an existing conversation has
no benign explanation and blocks sending until reviewed.

See [`app/README.md`](app/README.md) for platform-specific setup and checks.

## Rooms

A room message is sent as N-1 ordinary pairwise libsignal messages. There is no
group key and no server-side roster; server handlers receive ordinary pairwise
sends and have no room model. Contents remain end-to-end encrypted, but the
server and Apple can infer room membership from traffic shape. Each leg's
26-character wire ID is pure CSPRNG output with no timestamp
(`packages/shared/src/msgid.ts`), so the legs do not provide an exact,
30-day-durable join key.

- The creator controls additions and removals. Anyone can leave, and leaving
  cannot be blocked or undone. Each phone folds membership claims locally;
  disagreement is shown rather than silently repaired
  (`packages/shared/src/group-fold.ts`).
- Text, photos, documents, voice notes, locations, replies, edits, deletes,
  and reactions use the same envelopes as 1:1 messages. Rooms send no read
  receipts.
- The owner may share history. A visible row records who shared how much and
  with whom, while the disappearing-message timer prevents expired content
  from returning.
- Rooms are visually distinct from people. Full notification previews use the
  room name; reduced previews reveal the sender but not content or the room
  name.
- The CLI supports `tacendum room
  create|list|show|add|remove|leave|accept|decline|send|delete`.

## Cryptographic boundary

There is no hand-written content cryptography. The runtime allowlist is short
and explicit:

- **libsignal:** X3DH/PQXDH key agreement, Double Ratchet messaging,
  ML-KEM/Kyber prekeys, identity and session operations, message and attachment
  encryption, the sign-in challenge signature verified by the server, and the
  Argon2 `PinHash` used by the registration-PIN verifier retained for encrypted
  backups.
- **Platform APIs:** secure randomness and credential storage, plus CryptoKit
  SHA-256 for room roster digests.
- **libwebrtc with BoringSSL:** DTLS-SRTP call media. Every DTLS fingerprint is
  authenticated through libsignal before use.
- **`node:crypto`, never for content:** the TURN relay-credential HMAC, a
  salted relay pseudonym that cannot be joined to messaging tables, session
  token digests, constant-time comparison of the waitlist origin secret, the
  ES256 signature on APNs provider tokens, and CSPRNG entropy for opaque IDs,
  nonces, and claim tokens on the server and CLI.
- **AWS SDK request signing:** S3 presigned URLs and CloudFront signed URLs,
  which are capability links to bytes already encrypted by the client.
- **`ws`:** standard WebSocket handshake SHA-1 and frame masking in the CLI
  and local host.

Test-only throwaway key generation and digests are also accounted for.
Transport TLS is outside this application-cryptography inventory. Any use not
on the allowlist is a stop-and-review condition, and the allowlist must be
re-derived from the tree rather than copied from documentation.

## Tests

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Some Vitest suites use DynamoDB Local, the active Docker context, and installed
or credentialed coding-agent binaries. Review `vitest.config.ts` and run the
full suite only in an isolated development environment. Integration suites
require the relevant local services described above. Deployment end-to-end
verification uses infrastructure that is not included here. Mobile Jest
commands are documented in `app/README.md`.

## Optional Anthropic SDK driver

The CLI can optionally drive an agent through the proprietary Anthropic Agent
SDK. The SDK is an `optionalDependencies` entry, is never imported statically,
is loaded lazily only when installed, and is never included in the CLI bundle.
Nothing in this repository requires it to build, test, or run. Use of that
driver requires an operator-supplied Anthropic API key.

## Threat model

### Server visibility and stored data

The server sees account identity public keys, sender and recipient metadata,
timing, and ciphertext sizes. A linked email address or username is stored only
as a keyed scrambling, never in plaintext. Clients generate private keys; the
server relays sealed envelopes.

Stored data includes public identity, signed, one-time, and Kyber prekeys;
queued message and attachment ciphertext; account rows containing a random
user ID, creation time, and account class; identity-key claims; SHA-256 session
token digests; pending sign-in challenges containing an identity key and
server nonce; single-use WebSocket tickets; live connection IDs; rate-limit
counters keyed by user ID or source IP; and APNs device-token rows.

An APNs device token is the capability to ring a phone. The push-token API is
write-only, and only the push worker's role can read the token table. Stored
data never includes message plaintext, private keys, or usable bearer tokens.
A plaintext-leak check sends a canary and asserts that it appears in no
retained log or stored payload.

### Active server compromise

A database dump yields no message plaintext or usable bearer token. An
actively compromised server can substitute identity and prekey material when
two people first connect and can therefore intercept that new session from its
start. Safety numbers defend against this: they derive from both identity keys
and will not match when compared out of band after substitution.

Established sessions cannot be read retroactively or taken over silently. A
changed identity key blocks sending until it is reviewed.

### Network attacker

- Reordered, dropped, or duplicated frames are handled with `msgId`
  deduplication, an idempotent drain, and bounded retries.
- Ciphertext tampering causes libsignal decryption to fail; the message is
  rejected and never rendered.
- Identity substitution is exposed by trust-on-first-use pinning and safety
  numbers; a changed key blocks sending until out-of-band verification.
- Sign-in requires a signature over a domain-tagged, API-origin-bound server
  nonce. Challenges expire after two minutes, are consumed atomically, and
  both auth routes are rate-limited per source IP. A signature induced by a
  hostile endpoint cannot be redeemed at the real service.
- Accounts cannot be enumerated through a phone directory. Accounts are named
  by public key, `/v1/auth` gives one generic response for absent and incorrect
  challenges, and identity keys are excluded from retained logs.
- Per-token, per-IP, and per-(caller,target) limits, transport payload caps,
  and a per-sender WebSocket send limit bound resource use.

### App lock and duress

An optional passcode gates the UI. A duress entry at the same lock screen opens
a decoy workspace with invented contacts, garbled messages, and the user's real
profile, rendered by the normal screens without network activity. The user
chooses one code, with no independently chosen second secret. Recognition is
explained by the app during setup and implemented in `app/src/lock.ts`, but is
not described here.

The decoy uses platform randomness and a bundled name corpus and derives
nothing from real chats. It is a presentation gate, not an encryption
boundary; at-rest protection remains iOS Data Protection. It can mislead a
coercer who does not know the feature exists, but not an informed adversary who
demands the real conversations. There is no passcode recovery; forgetting it
requires signing out and loses this device's history.

### Known residuals

- `decryptEnvelope` advances the native ratchet before writing plaintext to
  SQLite. A crash in that narrow window loses one message.
- iOS at-rest encryption is iOS Data Protection, which the simulator does not
  enforce.
- `challenge_expired` remains distinct from `invalid_challenge`, revealing
  that a challenge had been pending so the client can request a new one rather
  than retry blindly.

### Identity scope

Sealed sender is not implemented. Linked devices are separately keyed accounts
joined by verified device-linking certificates; identity private keys are not
shared between devices.

Calls use libwebrtc DTLS-SRTP and authenticate every DTLS fingerprint through
libsignal. Rooms use pairwise ratchets and expose the traffic-shape limitation
described above.

### Push notifications

The iOS app declares the `voip` and `audio` background modes. PushKit wakes a
locked phone for calls. Alert pushes carry queued ciphertext to a notification
service extension, which decrypts a preview on-device under the lock and
duress policy.

The server exposes write-only `PUT` and `DELETE /v1/push-token` routes, stores
device tokens separately, and gives only the dedicated push-worker role access
to the APNs signing key. A fresh deployment contains a placeholder secret;
pushes remain disabled until an operator supplies the APNs `.p8` key. SMS is
limited to the feature-gated account phone-verification path described above;
it is not a message transport.

## Reporting a security problem

Do not open a public issue. Email **security@tacendum.com** and see
[`SECURITY.md`](SECURITY.md) for scope and reporting terms.

## Commercial deployments and independence

Mirana Technologies Inc. offers commercial self-hosted and private
infrastructure deployments. Contact
[hello@tacendum.com](mailto:hello@tacendum.com).

Product names identify compatible integrations only. Tacendum is independent
and is not affiliated with, sponsored by, or endorsed by Signal Messenger or
any named platform provider. Trademarks belong to their respective owners.
