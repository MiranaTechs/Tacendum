# Tacendum

A Signal-style, end-to-end-encrypted messenger — 1:1 conversations, and small
group rooms built on nothing but them. The backend is written as
AWS-Lambda-shaped handlers hosted two ways — a local Node adapter and API Gateway — so
the whole system runs **entirely on one machine** with no AWS account, and a
cloud deploy is a packaging exercise rather than a rewrite. Clients are two
command-line proof clients (`alice`, `bob`) and a React Native iOS and Android app.

All content cryptography is [libsignal](https://github.com/signalapp/libsignal) — X3DH/PQXDH
key agreement + the Double Ratchet, with post-quantum (ML-KEM/Kyber) prekeys. There is **no
hand-written cryptography** anywhere; every crypto call comes from a short, enumerable
allowlist. Its shipped-runtime members: **libsignal** for everything that touches
content — identity, sessions, messages, attachment blobs — for the sign-in challenge
signature the server verifies with the same library, and for the Argon2 `PinHash` behind
the app's registration-PIN verifier (retained for encrypted backups); the **platform's**
RNG and Keychain, and its SHA-256 (CryptoKit) for the rooms' roster digest;
**libwebrtc's DTLS-SRTP stack (BoringSSL)** for call media, with every DTLS
fingerprint authenticated through libsignal before use; **`node:crypto` on credentials and
identifiers, never on content** — the two TURN HMACs (the relay credential, and a salted
pseudonym that keeps relay logs unjoinable to the messaging tables), session-token digests,
the constant-time compare on the waitlist origin secret, the ES256 signature over the APNs
provider token that Apple's token-based push authentication requires (all server-side), and
CSPRNG entropy for opaque ids, nonces and claim tokens on both the server and the CLI;
**the AWS SDK's own request signing**, server-side, for S3 presigned URLs and CloudFront
signed URLs — capability links over bytes that are already ciphertext; and the **`ws`
package's** WebSocket handshake SHA-1 and frame masking in the CLI and the local dev host.
The test suites' throwaway keygen and digests are also on the list; transport TLS is
deliberately out of scope. The point of the rule is that the list is short and
enumerable — anything not on it is a stop-and-flag — not that it is empty, and the list
is only worth having if it is re-derived from the tree rather than recited.

> **Licensing:** Tacendum is **AGPL-3.0-only** (root `LICENSE`; the CLI's package.json says
> the same): the app, the CLI and the server's
> authentication function all link libsignal, which is AGPL. The published terms, privacy
> policy and developers page state the license, a three-year written source offer for the
> complete corresponding source, and an AGPL §7 additional permission for App Store
> distribution of the code whose copyright is ours.

## What this repository contains

This repository is the complete Corresponding Source for the shipped clients and the
service: the iOS and Android app (`app/`), the shared wire and protocol modules
(`packages/shared/`), the server handlers and the local adapter that hosts them
(`packages/server/`), and the CLI (`packages/cli/`). That is everything the AGPL
obliges, and enough to build and run the whole system on one machine with no AWS
account — `pnpm infra:up` (DynamoDB Local, MinIO and coturn under docker compose),
`pnpm tables:create`, `pnpm dev`; the Setup section below walks through it.

Deployment infrastructure and release tooling are not part of this repository, and the
website and brand assets live in a separate repository.

Organisations that want a full self-hosted or private-infrastructure deployment can
engage Mirana Technologies Inc. to build and operate one as a commercial service —
write to [hello@tacendum.com](mailto:hello@tacendum.com).

---

## Requirements

- **Node** 20.19+ / 22.13+ / 24.3+ (tested on 22), **pnpm** 11, **Docker** (DynamoDB Local + MinIO).
- For the iOS app: **macOS**, **Xcode** 26+, **CocoaPods** 1.13+, **watchman**.
- For the Android app: the **Android SDK** (command-line tools with `ANDROID_HOME` set)
  — platform 36, build-tools 36.0.0, NDK 27.1.12297006 — plus a **JDK 17** for Gradle
  and a **JDK 21** for the host-JVM crypto suites, whose libsignal classes are class
  file major version 65 and will not load on 17. `minSdk` is 26; Gradle commands run
  from `app/android/`.
- On macOS 26, Node can segfault reading the system keychain with `NODE_USE_SYSTEM_CA=1`
  — every command below runs with `NODE_USE_SYSTEM_CA=0` (the scripts set it).

## Setup

```sh
cp .env.example .env         # ships TACENDUM_ENV=local — see below; do this FIRST
pnpm install                 # hoisted node_modules (Metro-friendly)
pnpm infra:up                # dynamodb-local :8000 + minio :9000/:9001
pnpm tables:create           # the local DynamoDB tables
```

The `cp` is what makes the checkout safe. An **installed** copy of the CLI defaults to
production (`api.tacendum.com`) so a first run is never connection-refused — the wrong
default inside a checkout. `TACENDUM_ENV` in the repo-root `.env` (`local` | `aws`; any
other value refuses to start rather than guessing) points **all** the checkout's tooling
at one backend: the CLI loads the file itself (no `source` needed; a real exported
variable still wins), and **debug** builds of the app bake it in at bundle time via
`react-native-dotenv` (restart Metro after changing it). Release builds of the app are
hard-wired to `aws` and ignore the environment entirely. `TACENDUM_API` / `TACENDUM_WS`
override the two endpoints individually and beat `TACENDUM_ENV`. One asymmetry worth
knowing: the CLI sees those two from the shell or the `.env` alike, but a **debug app**
build only sees them when the keys are present in a `.env` file — the bundler inlines
nothing for a key that appears in no file, which is why `.env.example` ships
`TACENDUM_API=`/`TACENDUM_WS=` as empty keys (empty means unset; a non-empty shell
export then wins). Release builds ignore these two as well.

Every CLI process prints one stderr line before its first request —
`tacendum: api localhost:8080 (local)` — read it to confirm which backend you are
about to talk to.

## Run the backend

```sh
pnpm dev                     # HTTP adapter :8080, WebSocket adapter :8081
```

The server prints structured JSON logs, and the logging rule is absolute: no payloads,
no plaintext, no tokens, no key material (`packages/server/src/log.ts`). There is no SMS
channel and no verification code — accounts are proved by signature (see the
registration note under the iOS demo below).

## Demo — CLI clients

Two shells, with the server running:

```sh
# register alice and bob — the keypair each client generates IS the account:
# no phone number, no verification code, nothing to type
cli register alice
cli register bob

# bob listens; alice sends
cli listen bob                         # in one shell
cli send alice bob "hello, bob"        # in another — decrypts on bob's side

# safety numbers (compare out of band; must match on both ends)
cli safety alice bob
cli safety bob alice

# if bob reinstalls (new identity), alice's next send is BLOCKED with a warning;
# accept the new safety number explicitly:
cli trust alice bob
```

`cli` is `pnpm --filter @tacendum/cli cli` (see `packages/cli`).

## Demo — iOS app

```sh
cd app/ios && pod install && cd -
# Device builds only (the Simulator needs none of this): copy the example to
# app/ios/Tacendum.local.xcconfig and set your Apple Team ID. Skip it and a
# device build stops with "requires a development team"; the Simulator is
# unaffected. The .example file documents the setup step.
cd app && pnpm start                   # Metro on :8083 (WS owns :8081)
# in another shell:
cd app && pnpm ios                      # builds + launches in the simulator
```

Registering is one tap with nothing to type: the phone generates a keypair, signs a
nonce the server issues, and that key IS the account — no phone number, no e-mail, no
verification code required; an e-mail or username can be linked later, optionally and
revocably, only if you want to be found. The thread header's **🔒 Verify** shows the safety number, and a
changed one blocks sending until you review it. Worth knowing why that matters here:
an account's identity key is immutable server-side, so a reinstall produces a NEW
contact rather than a changed number — which means a changed number on an existing
conversation has no benign explanation.

## Rooms — small group chat

Rooms are pure fan-out: **no group key, no server-side roster.**
A room message is encrypted N−1 times through the same pairwise Double Ratchet
sessions 1:1 messages use, and reaches the server as N−1 ordinary sends — no
server code knows rooms exist. Contents stay end-to-end encrypted; the honest price,
stated rather than softened, is that the server and Apple both learn who is in
every room from traffic shape. What the legs must never hand the server is
anything *better* than traffic shape: every leg's wire id is 26 characters of
pure CSPRNG carrying no timestamp (`packages/shared/src/msgid.ts`), because
monotonic ULIDs would have turned membership from an inference into an exact,
30-day-durable `SELECT`.

- **The creator owns the roster.** Only the owner adds or removes people; anyone
  may leave, always, and leaving cannot be blocked or undone. Membership is a
  claim each phone makes and folds for itself
  (`packages/shared/src/group-fold.ts`) — disagreement between phones is shown,
  not silently repaired.
- **Everything a 1:1 carries works in a room** — text, photos, documents, voice
  notes, location, replies, edits, deletes and reactions ride the same envelopes
  through the same switch. Rooms send no read receipts.
- **History is shared only if the owner chooses to**, and the room is told: a
  visible, attributed row records who shared how much with whom, and the
  disappearing-message timer still binds — nothing already expired comes back.
- **A room never looks like a person.** A person is a circle; a room is a walled
  square with a doorway — distinct at a glance in the chat list and the thread
  header — and at the full notification preview level, a locked-phone banner
  titles a room message with the room's name rather than the sender's. (The
  reduced preview level shows who wrote — never what, and never which room: a
  room's name is content, and that level promises to withhold content.)
- **The CLI is a full participant, not a renderer** — `tacendum room
  create|list|show|add|remove|leave|accept|decline|send|delete`.

## Tests

```sh
pnpm test        # unit + integration (vitest); integration needs infra up
pnpm typecheck && pnpm lint
```

End-to-end release verification runs against deployment infrastructure that is not
part of this repository.

## Optional AI integration

The CLI can drive an AI coding agent through the proprietary Anthropic Agent SDK.
The SDK is an `optionalDependencies` entry, is never imported statically, and is
loaded lazily at runtime only if it is installed; it is not bundled into any shipped
artifact and nothing in this repository requires it to build, test, or run. Using it
requires an operator-supplied Anthropic API key.

---

## Architecture

```
packages/
  shared/   wire DTOs + WS frames (zod), the auth-signature payload, table names,
            and the pure modules both clients import — the room roster fold, the
            group envelopes, the timestamp-free wire-id minter, the call machine
  server/   pure Lambda-shaped handlers (src/handlers/), a local HTTP/WS adapter
            (src/local/), and four Lambda entry points (src/aws/)
  cli/      alice/bob proof clients (@signalapp/libsignal-client, file-backed stores)
app/        React Native 0.86 iOS + Android app, one JS tree over two native
            TurboModule sets (modules/*/ios in Swift over Signal's official
            LibSignalClient pod, modules/*/android in Kotlin over
            libsignal-android) — ios/ and android/ are the two host projects
```

**Invariant:** every handler in `packages/server/src/handlers/` is a pure function of
`(event, deps)` matching API Gateway HTTP/WebSocket event shapes. The local adapter and
a cloud deployment are two hosts for the same handlers — moving between them changes no
handler code.

---

## Threat model

**What the server can see.** Metadata: which identity public keys hold accounts (an
e-mail or username a user chose to link is held only as a keyed scrambling, never in
the clear), who is messaging whom,
timing, and ciphertext sizes. **What it stores** is more than the slogan "public keys
and ciphertext," and the honest inventory matters: public key material (identity,
signed, one-time and Kyber prekeys), queued message ciphertext and attachment-blob
ciphertext, plus the operational rows the service cannot run without — account rows (a
random userId, a creation time, an account class), identity-key claim rows, session
rows (SHA-256 digests of bearer tokens, never the token itself), pending sign-in
challenges (an identity key and a server-chosen nonce), single-use WebSocket tickets,
live connection ids, rate-limit counters (keyed by userId or source IP), and — for a
device that registered for push — an APNs push-token row. A device token is the
capability to ring a phone, so that surface is write-only at the API and only the push
worker's role can read the table. What is stored **never** includes message plaintext
or private keys. A plaintext-leak check sends a canary and asserts it appears in no
log and no stored payload.

**What the server cannot see.** Message contents. Keys are generated on the client;
the server only relays sealed envelopes. Reading everything the server stores — a full
database dump — yields no message plaintext and no usable bearer
tokens, because session tokens are stored as SHA-256 digests. An **actively**
compromised server can do one thing more: substitute its own identity/prekeys when two
people first contact each other, and MITM that new session from its start. The safety
number is the defense — it is derived from both sides' identity keys, so a MITM'd
session shows mismatched numbers when compared out of band, which is why the app puts
**Verify** in the thread header. Already-established sessions cannot be read
retroactively or taken over silently: a changed key blocks sending until reviewed.

**What an attacker on the wire can do, and the defenses.**
- *Reorder / drop / duplicate frames* — clients dedupe by `msgId`; the drain is
  idempotent; sends are retried with a timeout.
- *Tamper with ciphertext* — libsignal decryption fails loudly; the message is rejected
  and never rendered.
- *Substitute a peer's identity key (MITM)* — Trust-On-First-Use pinning + **safety
  numbers**: a changed key blocks sending and warns until the user verifies out of band.
- *Forge or replay a sign-in* — there is no verification code left to brute-force:
  signing in means signing a server-issued nonce with the account's identity key
  (`handlers/auth-account.ts`). Challenges expire in 2 minutes and are consumed
  atomically (single-use even under concurrent redemption); both auth routes are
  per-IP rate limited; and the signed bytes are domain-tagged and bound to the API
  origin, so a signature a hostile endpoint tricks a client into producing cannot be
  redeemed against the real server.
- *Enumerate accounts* — there is no phone directory left to probe: an account is
  named by a public key, `/v1/auth` answers "no pending challenge" and "wrong
  challenge" with one generic response, and identity keys stay out of retained logs.
- *Flood / drain resources* — per-token, per-IP, and per-(caller,target) rate limits;
  transport payload caps; a per-sender WebSocket send limit.

**App lock & duress mode.** An optional passcode gates the UI (Settings → App Lock).
A duress entry at the same lock screen opens a decoy workspace instead: invented
contacts, garbled unreadable messages, your own real profile — rendered by the exact
same screens, with no network activity (reads as offline). There is **no independently
chosen second secret**: the user picks exactly one code, and how a duress entry is
recognized is deliberately not written down in these docs (`app/src/lock.ts` is the
reference; the app itself explains it at setup, so it is no secret from anyone who has
used the app). The decoy is generated on-device from platform randomness and a bundled
name corpus; not one byte of it derives from real chats. Honest limits: this is a
**presentation gate**, not an
encryption boundary (at-rest protection remains iOS Data Protection), and it defeats a
coercer who does not know Tacendum has a duress mode — an informed adversary who knows
to demand the real conversations is outside its power. There is no passcode recovery;
forgetting the code means signing out and losing this device's history.

**Known residuals.** On the app, `decryptEnvelope` advances
the ratchet in the native store before the plaintext is written to SQLite; a crash in that
narrow window loses one message. At-rest encryption on the iOS app is iOS Data Protection,
which the simulator does not enforce (device-only). `challenge_expired` remains distinct
from the generic `invalid_challenge` response (a small "a challenge was pending" signal,
kept so a client re-requests instead of blindly retrying).

**Still out of scope:** sealed sender, and multi-device — nothing multi-device is
built; if it comes it will be opt-in linked devices, each its own immutable keypair
account and never a shared key, with the anonymous single-device default unchanged.
Voice and video calls' load-bearing property is stated in the crypto paragraph
above: call media is libwebrtc DTLS-SRTP, and every DTLS fingerprint is authenticated
through libsignal before use. Rooms' addition to this analysis is one sentence: a room
has no group key and no server-side roster — every room message goes out N−1 times
through the ordinary pairwise ratchet, so contents stay exactly as unreadable as a
1:1, and what the server (and Apple, via push) gains is traffic shape: who is in which
room. The fan-out's wire ids carry no timestamp (`packages/shared/src/msgid.ts`), so
the N legs of one message never hand the server an exact join key — membership stays
an inference, and that inference is the stated price of refusing a server-side roster.

**Push notifications.** The app
declares `UIBackgroundModes` voip/audio (`app/ios/Tacendum/Info.plist`): a VoIP
(PushKit) push rings calls on a locked phone, and an alert push carries the queued
ciphertext — the same bytes the server stored and cannot read — to a
notification-service extension that decrypts a preview on-device, under the lock and
duress policy. Server-side, the handlers include the push routes (`PUT`/`DELETE
/v1/push-token`, a **write-only** surface — no route reads a token back out), the token
table, and a dedicated push-worker function whose role is the only one permitted to
read the APNs signing key. A fresh deployment ships a placeholder secret, and until an
operator supplies the real APNs `.p8` pushes silently do not send — that last step is
deliberately an operator action, not a code default. SMS is gone with the phone
number — no code path can publish a message.

## Reporting a security problem

Please do not open a public issue. Email **security@tacendum.com** — see
[SECURITY.md](SECURITY.md) for scope and reporting terms.
