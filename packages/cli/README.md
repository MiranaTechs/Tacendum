# @tacendum/cli

End-to-end encrypted notifications to your phone — from shell scripts, cron
jobs, CI, and AI coding agents (Claude Code, Codex CLI, Cursor, Gemini CLI).

Every integration you set up is its **own account with its own keypair**, and
appears on your phone as a **named sender** ("Claude Code", "CI — api-server",
"backup-nas"). The name is backed by a cryptographic identity your phone pins,
not by a spoofable string. Messages are encrypted with the Signal protocol via
[libsignal](https://github.com/signalapp/libsignal); the server relays
ciphertext it cannot read.

```
make build || tacendum send ci <your-id> --title "build failed"
```

No phone number, no captcha, no self-hosted server: an integration account is
minted from a keypair in one command and paired to your phone with a QR code
or a pasted id.

## Install

```
npm install -g @tacendum/cli
```

Requires Node.js **20.12 or newer** (the CLI uses `process.loadEnvFile`,
added in 20.12). `@signalapp/libsignal-client` ships prebuilt native binaries
for macOS, Linux and Windows on x64 and arm64; there is nothing to compile.

Supported operating systems: **macOS and Linux**. The credential backends
are the macOS Keychain and libsecret on Linux — Linux is first-class, not a
port — with a `0600` file as the headless fallback (see
`tacendum credential` below). **Windows is not yet supported**: no Windows
credential backend (DPAPI/wincred) exists, and the file fallback's `0600`
posture is a POSIX permission assumption that Windows does not honor, so
the CLI refuses to run there rather than store a credential it cannot
protect. The libsignal prebuilds above include Windows binaries; that is a
fact about the dependency's build artifacts, not a support claim.

You also need the Tacendum app on the phone that should receive the
notifications.

## Pairing: how an integration meets your phone

An integration account starts out able to message **only the owner it is
paired to**. The owner can widen that deliberately by adopting integrations
into a *crew*, which exists for one case: an agent running a fleet of
subagents, where the members need to reach each other and not just you. It is
the owner's action — an integration can neither adopt itself nor pull anyone
in. The security section states the exact boundary. Pairing happens once, in
either of two flows:

- **QR flow** (interactive): run `tacendum setup <surface> --name "…"` in a
  terminal. It registers a fresh integration account, prints its id as a QR
  code, and listens. Scan the QR from the Tacendum app; the app sends the
  first (encrypted) message, and its sender becomes the owner. You approve the
  pairing on the phone.
- **Owner-id flow** (unattended — the one an AI agent or a provisioning
  script can complete alone): pass `--owner <id>`, where `<id>` is the
  26-character user id shown on your phone's own code screen. No listening,
  no scanning.

After pairing, the integration sends your phone a profile card carrying the
`--name` you chose, which is what the app displays as the sender.

A paired integration cannot ring your phone and can be revoked from the phone
at any time. Ids are bare 26-character ULIDs — never URLs, never deep links.

## Commands, one worked example each

### `tacendum setup` — onboard an agent surface in one command

```
tacendum setup claude-code --name "Claude Code"
```

Registers an integration account, pairs it (QR flow as shown; add
`--owner <id>` for the unattended flow), sends the profile card, and writes
the host's hook configuration for you (with a single rolling `.bak` backup,
mode 0600, of the file it edits). Surfaces: `claude-code`, `codex`, `cursor`,
`gemini`.

```
tacendum setup codex --name "CI - api-server" --owner 01ARZ3NDEKTSV4RRFFQ69G5FAV
```

### `tacendum notify` — the hook entry point agents call

```
tacendum notify --hook claude --account claude-code
```

This is the command `setup` wires into the host's hook config; you rarely type
it yourself. It reads the host's hook payload (stdin JSON for Claude Code,
Cursor and Gemini CLI; final argv argument for Codex), composes a bounded
notification, and sends it. It is built to **never block the agent**: an
internal ~5 s deadline bounds the network attempt, any send failure queues the
notification to disk and exits 0, and exit code 2 — the code every supported
host treats as "block the agent" — is never used, by contract (see the exit
code table).

### `tacendum run` — wrap any command that has no hooks

```
tacendum run ci --name nightly-backup -- pg_dump --file backup.sql mydb
```

Runs the command, streams its output through unchanged, and when it exits
sends one notification: label, outcome, exit code, wall-clock time, and the
last 2 KiB of output. The wrapper exits with the child's own exit code — with
one deliberate exception: a child exit of **2 is reported as 1**, because 2
is the code agent hosts read as "block the agent" (see the exit-code table),
and this wrapper is built to run inside their hooks. The remap is announced
on stderr, and the notification and the `--json` record (`childExit`) carry
the real code. Start failures follow the shell's own conventions (127 not
found, 126 not executable) and a signal death exits 128 + signal number —
so everywhere outside that one exception it is a drop-in inside scripts,
Makefiles and cron lines. The recipient defaults to the paired owner; pass
an explicit `<to>` after `<from>` to override.

### `tacendum credential` — where the account key lives

```
tacendum credential ci            # report the storage backend in use
tacendum credential ci --migrate  # move it into the OS keychain
```

The credential is the identity keypair that *is* the account. By default it
is a `0600` file under `~/.tacendum/<name>/`. `--migrate` moves it into the
OS keychain (macOS Keychain, or libsecret on Linux) and verifies it reads
back before trusting it; the file is retained as a fallback for a locked or
unreachable keychain unless you add `--remove-file`. Headless machines
without a keychain keep the file — the same posture as an ssh key.

### Everything else

```
tacendum register <name> [--integration]   # mint an account (re-run = sign in)
tacendum pair <name> <owner-id>            # bind an integration to its owner
tacendum send <from> <to> ["text"] [--title T]   # one-shot send; body may be piped on stdin
tacendum listen <name>                     # stay connected, print inbound
tacendum sync <name>                       # drain the queue to the local log and exit (cron-friendly)
tacendum inbox <name>                      # read the local log
tacendum contacts <name> | doctor <name> | whoami <name>
tacendum safety <name> <peer>              # print the safety number to verify out of band
tacendum trust <name> <peer>               # accept a changed peer identity (after verifying!)
tacendum mcp --account <name>              # MCP server over stdio — no send tool; it reads messages and marks them read (which starts the purge of read bodies)
tacendum mcp install --host claude-desktop|claude-code|codex [--write]
```

`<to>` and `<peer>` are a local client name or a bare 26-character user id.
Global flags: `--json` (machine-readable stdout), `--plain` (stable output,
no colour, no spinner; implied by `NO_COLOR`), `--help`, `--version`.

Messages a phone sends while an integration is offline queue server-side (as
ciphertext) and are delivered on the next connect; the queue's retention is
30 days.

## Exit codes

The numbers are a published contract: appended to, never renumbered.

| Code | Slug (`--json`) | Meaning | Retry? |
|-----:|---|---|---|
| 0 | `ok` | Success | — |
| 1 | `error` | Unclassified failure | May help |
| 3 | `auth` | The credential is unusable: the server no longer accepts the account (deleted, revoked, a refused handshake), or the local credential is gone or is not one this CLI wrote. The error names the remedy — restore `identity.json` from backup when the credential itself is lost or corrupt (the key IS the account and cannot be re-minted); re-pair only when the account is gone server-side. Do not loop | No |
| 4 | `network` | Server unreachable, the transport failed, or the server answered 5xx | May help |
| 5 | `recipient` | The recipient could not be addressed: no such user, no prekeys to open a session with, or the argument is neither a full 26-character id nor a known local name | No |
| 6 | `safety` | Peer's safety number changed; send refused — verify out of band, then `trust` | Not until verified |
| 7 | `timeout` | A bounded wait expired with nothing decided: no receipt (or other awaited server frame) arrived in time, or `setup`'s QR wait ended before any pairing message. (`notify` never exits 7: its internal deadline queues the notification and exits 0.) | May help |
| 8 | `rate_limited` | Rate limited — an HTTP 429, or the server's `rate_limited` WebSocket error frame. Wait, then retry the same thing | Yes, after waiting |
| 9 | `usage` | The command line was wrong | No |
| 10 | `refused` | The server said no, permanently: an unpaired integration sending, an integration addressing a recipient outside its owner-or-crew boundary, or an integration attempting an urgent (ring) frame | No |

**2 is deliberately never used.** Claude Code, Cursor and Gemini CLI all
treat hook exit code 2 as "block the action" (Claude Code additionally feeds
that hook's stderr back to the model as instructions). This tool exists to
run inside those hooks, so no failure of this CLI — not even a mistyped flag
— may ever produce it.

## Security posture, in plain language

- **End-to-end encrypted.** All message content is encrypted on your machine
  with the Signal protocol via libsignal and decrypted only on your phone.
  The server stores and relays ciphertext, public keys, and routing metadata
  (who sent to whom, and when) — never plaintext.
- **Keys never leave your machines.** An account is its keypair. Nothing here
  ever asks the server (or you) for a password, and the private key is never
  passed on a process argument list.
- **The sender name is a key, not a label.** Each integration is a distinct
  account; your phone pins its identity key on first contact (trust on first
  use). If a pinned key ever changes, sends are refused (exit 6) until you
  verify the safety number out of band and explicitly run `tacendum trust`.
- **Owner-bound sending, server-enforced.** A paired integration can message
  its owner — and, if the owner has adopted integrations into a **crew**,
  fellow integrations of that same crew. The crew case is deliberate and has
  one purpose: a fleet of subagents under one agent, whose members report to
  each other as well as to you. Never a human who is not the owner,
  and never anything outside the crew the owner assembled; adoption is the
  owner's action, which an integration can neither perform nor widen. An
  integration cannot ring the phone (the server refuses urgent frames from
  integrations) and is revocable from the phone. So a compromised or
  prompt-injected agent holding the credential can send only to you and to
  crew-mates you yourself adopted — never to strangers.
- **Nothing sensitive in logs or errors.** Message bodies, peer- and
  server-supplied values, and every credential are kept out of log lines,
  error messages, `--json` records and subprocess argument lists by design —
  a captured build tail full of tokens appears in exactly one place, the
  encrypted message body. The one deliberate exception: the LOCAL account
  names you chose appear in the CLI's own output (they are how it talks
  about your accounts) and in the OS keychain item coordinates — so name
  accounts like accounts, not like secrets.
- **Bounded content.** `run` caps what it sends (the last 2 KiB of output —
  a build log ends with its verdict), and `notify` clips the agent's message
  to a chat bubble (280 chars, head kept — prose starts with its outcome).
  Both bounds also limit what a hostile prompt could exfiltrate through a
  notification.
- **Credential at rest**: `0600` file by default, OS keychain via
  `tacendum credential --migrate` (see above).

Threat-model honesty: the server operator can see traffic metadata, and
anyone holding an integration's credential file can send messages as that
integration — to its owner, and to any crew-mates the owner has adopted —
until it is revoked from the phone.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `TACENDUM_API` | REST base URL | `https://api.tacendum.com` |
| `TACENDUM_WS` | WebSocket URL | `wss://ws.tacendum.com` |
| `TACENDUM_HOME` | Client store root | `~/.tacendum` |
| `NO_COLOR` | Implies `--plain` | — |

## License

**AGPL-3.0-only.** The full licence text ships in this package
(`dist/LICENSE`), and `tacendum --version` prints the source repository URL:
<https://github.com/MiranaTechs/Tacendum>. The CLI links
`@signalapp/libsignal-client` (Copyright Signal Messenger, LLC), which is
itself AGPL-3.0-only and is installed as a regular npm dependency, not
bundled into this package's code.

This is an independent project; it is not affiliated with or endorsed by
Signal Messenger, LLC.
