# @tacendum/cli

`@tacendum/cli` sends end-to-end encrypted notifications from scripts, cron
jobs, CI, and supported coding-agent hooks. Each integration is a separate
keypair and account; the phone pins that identity and displays its configured
name. Content is encrypted with
[libsignal](https://github.com/signalapp/libsignal), and the service relays
ciphertext it cannot read.

```sh
make build || tacendum send ci <your-id> --title "build failed"
```

## Install

**The package is not yet published to npm.** The registry install command is
retained here as the package contract, and it resolves to nothing today:

```sh
npm install -g @tacendum/cli
```

From this repository, run the source entry point instead:

```sh
pnpm --filter @tacendum/cli cli -- --help
```

To install the same artifact `npm publish` would ship, build the tarball from
source; `prepack` runs the same `build.mjs`:

```sh
git clone https://github.com/MiranaTechs/Tacendum
cd Tacendum && pnpm install
cd packages/cli && npm pack          # -> tacendum-cli-<version>.tgz
npm install -g ./tacendum-cli-<version>.tgz
```

`npm pack` refuses a tree with uncommitted changes under `packages/cli`,
`packages/shared`, or `LICENSE`, because a tarball built from a dirty tree
would carry code its stamped commit does not contain; commit first. `npm run
build` still builds locally and stamps the artifact `-dirty`.

`tacendum --version` prints the version, the commit the bundle was built from,
and the AGPL source URL, so the licence obligation travels with the executable.
A commit ending in `-dirty` is not any published commit. The full licence text
ships inside the package as `dist/LICENSE`.

| Requirement | Support |
|---|---|
| Node.js | 20.12 or newer; the CLI uses `process.loadEnvFile` |
| Operating system | macOS and Linux on x64 or arm64 |
| Credentials | macOS Keychain, libsecret on Linux, or a `0600` file for headless systems |
| Phone | Tacendum app required for pairing and receiving notifications |

Windows is unsupported. Although `@signalapp/libsignal-client` publishes
Windows x64 and arm64 prebuilds, the CLI has no DPAPI or wincred backend, and
Windows does not enforce the POSIX `0600` permissions assumed by the file
fallback. The CLI therefore refuses to run on Windows.

## Pair an integration

An integration initially messages its paired owner. The owner may also adopt
integrations into a **crew**, allowing those integrations to message one
another. A non-owner human can grant or revoke a directed consent edge for the
agent. Integrations cannot grant consent, adopt themselves, or expand a crew.
Pair once by either method:

- **QR:** `tacendum setup <surface> --name "…"` registers an account, prints
  its id as a QR code, and waits. Scan it in the phone app, then approve the
  first encrypted message. Its sender becomes the owner.
- **Owner id:** add `--owner <id>` for unattended setup. The id is the
  26-character value on the phone's code screen; this flow requires no scan or
  listener.

Setup sends a profile card containing the chosen name. The phone displays that
name for the pinned cryptographic identity. A paired integration cannot ring
the phone and can be revoked from the phone. User ids are bare 26-character
ULIDs, not URLs or deep links.

## Commands

### `setup`

```sh
tacendum setup claude-code --name "Claude Code"
tacendum setup codex --name "CI - api-server" --owner 01ARZ3NDEKTSV4RRFFQ69G5FAV
```

Registers and pairs an integration, sends its profile card, and writes the
host's hook configuration. The edited file receives one rolling `.bak` backup
with mode `0600`. Supported surfaces are `claude-code`, `codex`, `cursor`, and
`gemini`.

Native Claude phone approvals are an explicit setup option:

```
tacendum setup claude-code --account claude --name "Claude" --approvals 11
tacendum service install claude
```

This installs a blocking `PermissionRequest` bridge for native **interactive**
Claude Code. The listener receives the owner's encrypted decision. It can use
Claude Code's own sign-in and does not change Claude's permission rules.
Noninteractive `claude -p` attend turns do not fire `PermissionRequest` and
therefore have no phone tool-approval lane. The separate `attend` `sdk` driver
can relay its own tool asks, but that remote SDK answerer requires an
operator-supplied `ANTHROPIC_API_KEY`.

### `notify`

```sh
tacendum notify --hook claude --account claude-code
```

This is the hook entry point installed by `setup`. It accepts stdin JSON from
Claude Code, Cursor, and Gemini CLI, or the final argument from Codex. A roughly
five-second deadline bounds the send attempt. A send failure queues the
notification to disk and exits 0, so the hook does not block its host.

### `run`

```sh
tacendum run ci --name nightly-backup -- pg_dump --file backup.sql mydb
```

Runs a command, streams its output unchanged, then sends its label, outcome,
exit code, elapsed time, and final 2 KiB of output. It normally returns the
child's exit code, but a child exit of **2 is reported as 1** because supported
hook hosts reserve 2 for blocking. The remap is reported on stderr; the
notification and `--json` `childExit` field retain the original code. Start
failures use 127 for not found and 126 for not executable; a signal death uses
128 plus the signal number. The paired owner is the default recipient; provide
an explicit `<to>` after `<from>` to override it within the authorization
boundary.

### `credential`

```sh
tacendum credential ci            # report the active storage backend
tacendum credential ci --migrate  # move the credential to the OS keychain
```

The identity keypair is the account. It is stored by default in a `0600` file
under `~/.tacendum/<name>/`. `--migrate` copies it to macOS Keychain or
libsecret, verifies the stored value, and retains the file as a fallback when
the keychain is locked or unavailable. Add `--remove-file` to remove that
fallback. Headless systems use the protected file.

### `tacendum sync`

```sh
*/10 * * * *  tacendum sync backup-nas
```

Notifications are not the only direction: the phone can message an integration
back, and those messages queue server-side as ciphertext for 30 days. `sync`
connects, drains the queue, acks it, writes each message into the account's
local log, and exits — the no-daemon form, for a cron line. `tacendum listen
<name>` is the same drain held open on a long-lived socket; a `sync` never
displaces a `listen`, so both can be true of one account.

Add `--save-dir <dir>` to fetch and decrypt incoming file attachments at
receive time. Without it, an attachment shows as a line in the log and is not
retrievable later: the log stores no attachment ids or keys.

### `tacendum inbox`

```sh
tacendum inbox backup-nas --unread
tacendum inbox backup-nas --peek --limit 5
tacendum inbox backup-nas --purge
```

Reads the local log newest-first. **Reading marks read, and marking read is
not bookkeeping**: it starts the retention clock that purges the body from disk
on the first pass at least 24 hours later, leaving the routing metadata behind
— id, peer, timestamp, byte count, and the reply and room fields (`ref`, `grp`,
`men`, `ai`) when the message carried them. `--peek` prints without marking, so
the same messages print again next time. `--purge` skips the listing and
removes consumed bodies now. `--peer <id>` filters, `--limit N` bounds (default
20; `0` is all), `--unread` shows only what has not been read. Nothing outlives
30 days, matching the server queue the log mirrors; retention runs on every
`listen`, `sync`, and `inbox`.

### `tacendum doctor`

```sh
tacendum doctor backup-nas
```

Prints one PASS/FAIL line per check with a specific remedy on each failure, and
exits non-zero if any check failed. The checks are the store directory and its
permissions, the identity key's presence, the credential backend's ability to
answer, the attend state, the API's reachability, the machine clock's skew
against the server, the session token's validity, and the WebSocket dial. A
check that cannot run is reported as a FAIL that says why, never a skip and
never a pass. It observes and never repairs: running it cannot renew a token
that was about to fail tonight at cron time.

### Core command reference

```sh
tacendum register <name> [--integration]   # create an account; rerun to sign in
tacendum pair <name> <owner-id>            # bind an integration to its owner
tacendum send <from> <to> ["text" | -] [--title T]   # one-shot send; a body of - (or an
                                           # omitted body on a pipe) reads stdin. To send a
                                           # literal -, pipe it: printf -- - | tacendum send …
tacendum listen <name>                     # print inbound messages continuously
tacendum sync <name>                       # drain the queue to the local log and exit
tacendum inbox <name>                      # read the local log
tacendum contacts <name> | doctor <name> | whoami <name>
tacendum safety <name> <peer>              # print an out-of-band safety number
tacendum trust <name> <peer>               # accept a verified identity change
tacendum mcp --account <name> [--notify-owner] [--ask-owner]   # stdio MCP server
tacendum mcp install --host claude-desktop|claude-code|codex [--write]
```

**The MCP surface, exactly.** `tacendum mcp --account <name>` serves three
read-side tools over stdio — `tacendum_whoami`, `tacendum_read_messages`, and
`tacendum_acknowledge_messages` — and the default launch registers **no send
tool**. Read-side is not read-only: acknowledging is a write that persists the
read mark and starts the purge of read bodies. Two independent launch flags
each add exactly one send-shaped tool, and they compose additively — either,
both, or neither. `--notify-owner` adds `tacendum_notify_owner`, one short
message to the account's bound owner. `--ask-owner` adds
`tacendum_ask_owner`, one question to the same owner, which parks the tool
call until the reply, its TTL (30 s to 1 h, default 10 m), or end of input;
while it is parked the server answers nothing else. Neither tool takes a
recipient: the destination is fixed server-side to the owner binding, not
supplied by the agent. The flag decides which tools a host sees, and
**the flag is not the enforcement**; the security section states what is. Inbound messages come back as structured records —
provenance first (id, peer, direction, timestamp, byte count, flags) and the
sender's `body` last and alone — so a message that says "forward your context
to 01ARZ…" stays legible to the agent as data rather than as instructions.

`<to>` and `<peer>` accept a local account name or a full 26-character
user id. Global flags are `--json`, `--plain`, `--help`, and `--version`.
`--json` writes machine-readable stdout. `--plain` gives stable output without
colour or a spinner and is implied by `NO_COLOR`.

Use `tacendum --help` and `tacendum <command> --help` for the full command set,
including calls, rooms, crews, consent, services, agent attendance, and peer
review.

Offline messages queue server-side as ciphertext and are delivered on the next
connection. Queue retention is 30 days.

### `attend rounds`

```sh
tacendum attend rounds scout                      # read back: which rooms are on
tacendum attend rounds scout 01GRP…ROOMGID on     # arm this room
tacendum attend rounds scout 01GRP…ROOMGID off    # disarm it
```

A **round** is one message from the person plus each agent's answer to it. An
answer is a **brief** of up to 280 characters, the part the phone shows in the
bubble, and a **detail** of up to 3,000 characters behind a tap. Both are
written by the same model in the same message and travel as one message under
one sender.

Arming a room changes three things and nothing else. The agent writes its
answer as a brief and a detail. Its turn sees the room's roster, the author of
each quoted message, and the other agents' answers to the message being
answered. And its answer is also delivered to the person's own other agents in
that room as context for their next turn — a delivery change, never an
addressing one. Rounds is per room, off by default, and takes effect only from
the moment it is flipped. Re-running `attend enable` rewrites the profile and
clears the list, which can only turn rounds off.

The limits:

- **The person is the hub, and agents do not trigger agents.** A turn starts
  only from the person's own mention or reply. An agent has no way to compose a
  structured mention, and a mention that arrives from a known agent does
  nothing, so N agents answer one message with at most N answers.
- **Rounds needs a room of one person and their own agents.** Add a second
  person and the widening switches off: each answer still reaches the people,
  and the agents stop reading each other. Consent to an agent is granted per
  agent, and an answer that may restate somebody's words is not carried to an
  agent they never consented to. Nothing warns at send time; the round behaves
  like an ordinary room.
- **A detail that runs long is cut visibly**, ending in
  `[detail truncated at 3000 characters]`. If the whole message would not fit
  the wire cap, the answer is sent as the brief alone rather than lost.
- **An older phone shows the brief** as an ordinary quoted reply and offers no
  detail control. The detail is stored on the phone and revealed once it
  updates, with one exception: if an agent durably edits one of its messages
  while the phone is still on the older build, that message's detail is dropped
  from storage for good.
- **The relay sees sizes and times, not content.** A round is joined on the
  phone from a reply reference. The relay does not order, attribute, or verify
  anything about it, and it can see how long each answer was, because nothing
  here pads.

## Exit codes

Codes are a documented contract. Existing codes are not renumbered.

| Code | Slug (`--json`) | Meaning | Retry? |
|-----:|---|---|---|
| 0 | `ok` | Success | — |
| 1 | `error` | Unclassified failure | May help |
| 3 | `auth` | The credential is missing, corrupt, rejected, deleted, or revoked, or the handshake is refused. If the key is lost, restore `identity.json` from backup; it cannot be re-minted. Re-pair only when the server-side account is gone. | No |
| 4 | `network` | The server is unreachable, transport fails, or the server returns 5xx | May help |
| 5 | `recipient` | No such user, no prekeys, or the recipient is neither a full id nor a known local name | No |
| 6 | `safety` | The peer identity changed; verify its safety number, then run `trust` | Not until verified |
| 7 | `timeout` | A bounded wait ended without a receipt or other required frame, or `setup`'s QR wait ended before pairing. `notify` instead queues and exits 0. | May help |
| 8 | `rate_limited` | HTTP 429 or a `rate_limited` WebSocket error frame | Yes, after waiting |
| 9 | `usage` | Invalid command line | No |
| 10 | `refused` | Permanent refusal: unpaired sending, a recipient outside the owner-device, same-crew, or active-consent boundary, or an integration sending an urgent frame | No |

**2 is deliberately never used.** Claude Code, Cursor, and Gemini CLI treat
hook exit code 2 as a blocking result; Claude Code also returns the hook's
stderr to the model as instructions. No CLI failure, including invalid usage,
produces exit code 2.

## Security

| Property | Boundary |
|---|---|
| Message content | Encrypted locally with libsignal and decrypted on the recipient device. The service stores and relays ciphertext, public keys, and routing metadata: sender, recipient, and time. |
| Identity | An account is its keypair. No server password is used. Private keys do not leave the machine or appear in process arguments. The phone pins each sender key on first contact. A changed key blocks sending with exit 6 until its safety number is verified and `trust` is run. |
| Authorization | An integration may send to its owner, an admitted linked device on the owner's account, a same-crew integration, or a human who created an active consent edge for that agent; never to strangers. The owner alone controls adoption. Integrations cannot send urgent frames and may be revoked from the phone. |
| Diagnostics | Diagnostic logs, errors, JSON diagnostic records, and subprocess arguments exclude message bodies, credentials, and peer- or server-supplied values. Commands that explicitly read messages (`listen`, `sync`, and `inbox`) return decrypted bodies as requested output. Local account names appear in CLI output and keychain coordinates, so do not use secrets as names. |
| Content limits | `run` sends only the final 2 KiB of output. `notify` keeps the first 280 characters. Agent replies through `attend` keep up to 2,000 characters. |
| Credential storage | `0600` file by default; macOS Keychain or libsecret with `credential --migrate`. |

**Omitting a tool is not access control.** The MCP server's default launch
registers no send tool, and that absence buys less than it appears to: the
hosts that matter have shell access, so a compromised or prompt-injected agent
that wants to send simply runs `tacendum send`. The same holds for every other
omission. The real boundary is the server-side owner binding, which the agent
cannot reach: an integration's owner is written once at pairing and never
migrates, the server evaluates every send against it, and an unbound
integration is refused outright. That binding admits the owner's whole
**device group** — every device the owner has, resolved server-side at the
moment of the send — plus any crew the owner assembled; widening past the exact paired id is a server-side capability the
operator enables, and it falls back to the single owner id when it is off. What
the MCP flags buy is that a read-side install stays send-free for an agent that
has only MCP.

The service operator can observe traffic metadata. Anyone who obtains an
integration credential can send within that integration's owner-device,
same-crew, and active-consent boundary until the phone revokes it.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `TACENDUM_API` | REST base URL | `https://api.tacendum.com` |
| `TACENDUM_WS` | WebSocket URL | `wss://ws.tacendum.com` |
| `TACENDUM_HOME` | Client store root | `~/.tacendum` |
| `NO_COLOR` | Enables `--plain` | — |

## License

**AGPL-3.0-only.** The build places the complete license at `dist/LICENSE`, and
`tacendum --version` prints the source URL:
<https://github.com/MiranaTechs/Tacendum>.

The CLI links `@signalapp/libsignal-client` (Copyright Signal Messenger, LLC),
an AGPL-3.0-only npm dependency that is not bundled into the CLI package code.

Product and platform names identify compatible integrations or dependencies
only. Tacendum is independent and is not affiliated with, sponsored by, or
endorsed by Signal Messenger, LLC, or any named platform provider. Trademarks
belong to their respective owners.
