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

The npm registry does not currently carry this package. The registry install
command is retained here as the package contract:

```sh
npm install -g @tacendum/cli
```

From this repository, run the source entry point instead:

```sh
pnpm --filter @tacendum/cli cli -- --help
```

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

### Core command reference

```sh
tacendum register <name> [--integration]   # create an account; rerun to sign in
tacendum pair <name> <owner-id>            # bind an integration to its owner
tacendum send <from> <to> ["text"] [--title T]   # one-shot send; body may come from stdin
tacendum listen <name>                     # print inbound messages continuously
tacendum sync <name>                       # drain the queue to the local log and exit
tacendum inbox <name>                      # read the local log
tacendum contacts <name> | doctor <name> | whoami <name>
tacendum safety <name> <peer>              # print an out-of-band safety number
tacendum trust <name> <peer>               # accept a verified identity change
tacendum mcp --account <name>              # stdio MCP server; no send tool
tacendum mcp install --host claude-desktop|claude-code|codex [--write]
```

The MCP server reads messages and marks them read, starting the purge of read
bodies. `<to>` and `<peer>` accept a local account name or a full 26-character
user id. Global flags are `--json`, `--plain`, `--help`, and `--version`.
`--json` writes machine-readable stdout. `--plain` gives stable output without
colour or a spinner and is implied by `NO_COLOR`.

Use `tacendum --help` and `tacendum <command> --help` for the full command set,
including calls, rooms, crews, consent, services, agent attendance, and peer
review.

Offline messages queue server-side as ciphertext and are delivered on the next
connection. Queue retention is 30 days.

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
