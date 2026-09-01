import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clientDir, tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { profilePath } from './profile.js';
import { sanitizeServerField } from './render.js';
// From atomic-write.js, NOT from stores.js where it is re-exported: stores.ts
// imports readCredential from this module, so an import of stores.ts here
// would be a cycle (see atomic-write.ts's header).
import { writeFileAtomic } from './atomic-write.js';
import type { CheckResult } from './doctor.js';
import type { Reporter } from './output.js';

/**
 * OS keychain storage for the account credential, with
 * the shipping 0600 file as the headless fallback.
 *
 * THE CREDENTIAL is the byte content of `identity.json` — the identity
 * keypair that IS the account. It is written
 * exactly once per account (`FileIdentityKeyStore.initialize` refuses to
 * overwrite), so within ONE home the file and the keychain item hold the
 * same bytes when both are healthy. That is a property of this home's write
 * path, NOT a law of the machine: the OS keychain is machine-global, and
 * until items were scoped to the home (ITEM COORDINATES below) a second
 * TACENDUM_HOME using the same account name overwrote the item in place —
 * two valid identities under one coordinate, with reads silently following
 * whichever home wrote last (executed by an earlier review). So the two
 * copies CAN disagree. When they do, the marker decides what reads follow
 * (the keychain item, when it records one), the retained file is the
 * fallback for an unreachable or emptied keychain, and `credentialCheck`
 * reports the disagreement loudly instead of vouching for either copy.
 *
 * THREE BACKENDS, ONE DECISION POINT. `preferredBackend()` is the only place
 * the platform/env → backend rule lives, and `recordedBackend()` is the only
 * place "which backend holds THIS account's credential" lives — every read,
 * write, migration and doctor line goes through those two, because a second
 * copy of either rule is how a read path and a write path drift into using
 * different backends (the most-repeated defect class in this repo's review
 * history).
 *
 * THE MARKER, not re-detection, decides reads. Detection is environmental
 * (is the session bus up? is the login keychain unlocked?) and therefore
 * flappy; if reads re-detected, a credential stored in the keychain would
 * read as "absent" the first time detection flapped, and "absent" is what
 * lets a caller re-register — minting a SECOND account while every peer
 * still pins the first (see `session.ts` constraint 2 for what that costs).
 * So the backend actually used is recorded once, durably, in
 * `credential-backend.json` next to the stores, and reads follow it.
 *
 * FAILED IS NOT ABSENT. A keychain that cannot be reached (locked, no bus)
 * and a keychain that answers "no such item" demand opposite responses:
 * the first is transient (retry may help, EXIT.ERROR), the second means the
 * credential is gone (EXIT.AUTH, restore from backup). Conflating them
 * either wedges a working account or silently re-registers it. The
 * `Lookup` type below carries the distinction end to end and the tests
 * exercise both arms.
 *
 * THE SECRET NEVER RIDES ARGV. Every backend here shells out, and argv is
 * visible in `ps` to every user on the box for the lifetime of the process.
 *   - macOS: `security -i` reads its subcommand line from STDIN, so
 *     `add-generic-password … -w <value>` never appears in any argv (the
 *     read side, `find-generic-password -w`, carries no secret on argv and
 *     returns it on stdout, which only we see).
 *   - Linux: `secret-tool store` reads the secret from STDIN by design.
 *   - The value is hex-encoded first (see `toHex`), so it is also inert
 *     inside the quoted `security -i` command line — no quoting ambiguity,
 *     no newline surprises in what `find-generic-password -w` prints back.
 * The credential value itself never appears in a log line, an error, an
 * exception or `--json`; errors carry an errno from OUR
 * spawn, the tool's numeric exit status, and at most a FIXED classification
 * string matched against its stderr — never any fragment of the stderr text
 * itself. Both store paths feed the credential to the tool on stdin, and a
 * broken or impostor tool can echo that stdin straight back on stderr, so
 * subprocess stderr must be treated as if it contains the value.
 */

export type CredentialBackend = 'macos-keychain' | 'linux-libsecret' | 'file';

/**
 * ITEM COORDINATES: `(service=tacendum, account=sha256(home "\n" name))`.
 *
 * The account attribute is a digest over the resolved TACENDUM_HOME and the
 * client name, because the OS keychain is machine-global while accounts are
 * per-home. Under the original scheme (account = the raw client name — the
 * LEGACY coordinates below), two homes using the same account name shared
 * ONE item: `add-generic-password -U` and `secret-tool store` overwrite in
 * place, so the second home's migration silently replaced the first home's
 * credential and the first home then READ the second home's identity. Scoping the coordinate to (home, name) gives every
 * home its own item; it also keeps the caller-supplied name off
 * `security`/`secret-tool` argv, where `ps` shows argv to every user on the
 * box.
 *
 * RULE 1 IS NOT IN PLAY. Rule 1 ("cryptography goes through libsignal")
 * governs PROTOCOL cryptography; nothing here signs, encrypts, or derives a
 * key any peer trusts. A SHA-256 digest as a coordinate disambiguator is the
 * same non-protocol use this package already ships twice: the hostconfig
 * lock-file key (hostconfig.ts, `createHash('sha256')` on the config path)
 * and the Cursor conversation cache key (hooks.ts).
 *
 * LEGACY COORDINATES (`account = <name>`) are still READ — never written —
 * so pre-scoping users are not stranded: `readCredential` falls back to them
 * behind a pre-scoping marker, and the migration hook re-homes the item to
 * the scoped coordinate on the next command (see `migrateCredential`). The
 * legacy item itself is left in place except when a delete can prove it is
 * this home's (byte-equal content), because the one thing a shared
 * coordinate makes impossible is telling whose credential it holds.
 */
const SERVICE = 'tacendum';

/** The home-scoped account attribute — see ITEM COORDINATES. `resolve`
 * normalizes trailing slashes and relative TACENDUM_HOME spellings so one
 * home cannot mint two coordinate spaces; the name goes in verbatim (every
 * entry point has already passed it through `clientDir`/`checkedName`, and
 * case matters: `clientDir` treats Foo and foo as distinct on a
 * case-sensitive filesystem, so the digest must too). */
function itemAccount(name: string): string {
  return createHash('sha256')
    .update(`${resolve(tacendumHome())}\n${name}`, 'utf8')
    .digest('hex');
}

/**
 * Subprocess ceiling. Headless failures (no bus, interaction not allowed)
 * return in milliseconds; the only slow path is a GUI keychain-unlock prompt,
 * and this CLI's primary caller is a hook or a Makefile that cannot answer
 * one — better to fall back to the file (writes) or fail loudly (reads) than
 * to hang a CI step until its own timeout kills it without a diagnosis.
 */
const TOOL_TIMEOUT_MS = 20_000;

const MARKER_FILE = 'credential-backend.json';

/** The 0600 file that ships today — the fallback backend IS this file. */
function credentialFilePath(name: string): string {
  return join(clientDir(name), 'identity.json');
}

function markerPath(name: string): string {
  return join(clientDir(name), MARKER_FILE);
}

// --- encoding -----------------------------------------------------------------

/**
 * Hex, not the raw JSON and not base64: the value must survive (a) being
 * embedded in a double-quoted `security -i` command line, where quotes and
 * backslashes in raw JSON would be re-parsed, and (b) the round trip through
 * `find-generic-password -w`, which prints printable passwords raw but
 * hex-dumps anything else — storing text that is ALREADY pure lowercase hex
 * makes both directions unambiguous (verified live 2026-07-30: values like
 * `7b226b…` come back byte-identical, `-U` updates in place).
 */
function toHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

const HEX_RE = /^(?:[0-9a-f]{2})+$/;

function fromHex(hex: string): string | null {
  if (!HEX_RE.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('utf8');
}

// --- subprocess drivers -------------------------------------------------------

/** The absent/failed distinction, carried as data so no call site can drop it. */
type Lookup =
  | { kind: 'found'; hex: string }
  | { kind: 'absent' }
  | { kind: 'failed'; detail: string };

type StoreResult = { ok: true } | { ok: false; detail: string };

interface KeychainDriver {
  /** `account` is an item coordinate — the home-scoped digest from
   * `itemAccount`, or the raw client name ONLY on the legacy read/remove
   * paths documented at each call site. Drivers never decide coordinates. */
  store(account: string, hex: string): StoreResult;
  lookup(account: string): Lookup;
  /** Absent counts as success — deleting what is not there is the goal state. */
  remove(account: string): StoreResult;
}

/**
 * Tool failures are described WITHOUT their stderr text. Both store paths
 * feed the credential to the tool on STDIN, and a subprocess's stderr is not
 * ours to trust: a broken or impostor tool can echo that stdin straight back
 * (an earlier review demonstrated exactly this with a `secret-tool` shim,
 * leaking the credential hex through what used to be a "sanitized fragment").
 * Redacting the account name is not a defense when the text can BE the value.
 * What may travel: the tool name, an errno from OUR spawn, the numeric exit
 * status or the fact of a signal death, and a FIXED classification string
 * chosen by `classifyToolStderr` — never the diagnostic text itself. This is
 * what makes the module-header claim ("errors never carry the value") true.
 */
function describeFailure(
  tool: string,
  result: {
    status: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
    stderr?: string;
  },
): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `${tool} is not installed`;
    if (code === 'ETIMEDOUT') return `${tool} did not answer within ${TOOL_TIMEOUT_MS}ms`;
    return `${tool} could not be run (${sanitizeServerField(code ?? 'spawn error')})`;
  }
  if (result.status === null) return `${tool} was terminated by a signal`;
  const classified = classifyToolStderr(result.stderr ?? '');
  return `${tool} exited ${result.status}${classified ? ` (${classified})` : ''}`;
}

/**
 * The complete set of stderr-derived text that may ever reach an error, a log
 * or `--json`: these fixed return strings, or nothing. The patterns match the
 * two tools' known headless/locked diagnostics; anything unrecognized is
 * summarized by its exit status alone.
 */
function classifyToolStderr(stderr: string): string | null {
  if (/interaction is not allowed/i.test(stderr)) return 'keychain locked or no UI session';
  if (/d-?bus/i.test(stderr)) return 'no session bus';
  if (/locked/i.test(stderr)) return 'keyring locked';
  return null;
}

/** errSecItemNotFound: `security` exits 44 for find AND delete on a missing
 * item (verified live 2026-07-30). Anything else nonzero is a failure. */
const SEC_NOT_FOUND = 44;

const macDriver: KeychainDriver = {
  store(account, hex) {
    // `security -i` executes the subcommand read from stdin, so the `-w`
    // value never appears in argv (see module header). -U updates in place.
    const res = spawnSync('security', ['-i'], {
      input: `add-generic-password -a "${account}" -s "${SERVICE}" -U -w "${hex}"\n`,
      encoding: 'utf8',
      timeout: TOOL_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) {
      return { ok: false, detail: describeFailure('security', res) };
    }
    return { ok: true };
  },
  lookup(account) {
    const res = spawnSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE, '-w'],
      { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS },
    );
    if (!res.error && res.status === 0) return { kind: 'found', hex: res.stdout.trim() };
    if (!res.error && res.status === SEC_NOT_FOUND) return { kind: 'absent' };
    return { kind: 'failed', detail: describeFailure('security', res) };
  },
  remove(account) {
    const res = spawnSync(
      'security',
      ['delete-generic-password', '-a', account, '-s', SERVICE],
      { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS },
    );
    if (!res.error && (res.status === 0 || res.status === SEC_NOT_FOUND)) return { ok: true };
    return { ok: false, detail: describeFailure('security', res) };
  },
};

/**
 * secret-tool's one heuristic, in one place: it has no distinct not-found
 * exit code, so "nothing matched" must be inferred. The ONE shape that means
 * a miss is exit status exactly 1 (the code `secret-tool lookup`/`clear` use
 * for no-match) with NOTHING on stderr — a broken environment (no session
 * bus, locked keyring) writes a diagnostic, a usage error exits 2, and a
 * signal-killed tool has no exit status at all. Everything outside that
 * exact shape is a FAILURE, even when silent: "absent" is the answer that
 * lets a caller re-register (module header), so a result that cannot be
 * classified must refuse rather than volunteer it. Both `lookup` (miss =
 * absent) and `remove` (miss = already gone, the goal state of a delete)
 * apply THIS predicate rather than restating it — two hand-written copies of
 * an inference rule is how they drift (this repo's most-repeated defect
 * class). The tests pin the contract with shim binaries.
 */
function silentMiss(res: {
  error?: Error;
  status: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
}): boolean {
  return (
    !res.error &&
    res.signal == null &&
    res.status === 1 &&
    (res.stderr ?? '').trim() === ''
  );
}

const linuxDriver: KeychainDriver = {
  store(account, hex) {
    // `secret-tool store` reads the secret from stdin by design; argv carries
    // only the (non-secret) attributes. The label is the digest's first 12
    // chars, not the client name: the label rides argv and shows in every
    // keyring GUI, and the name is a caller-supplied value.
    const res = spawnSync(
      'secret-tool',
      ['store', '--label', `Tacendum (${account.slice(0, 12)})`, 'service', SERVICE, 'account', account],
      { input: hex, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS },
    );
    if (res.error || res.status !== 0) {
      return { ok: false, detail: describeFailure('secret-tool', res) };
    }
    return { ok: true };
  },
  lookup(account) {
    const res = spawnSync(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'account', account],
      { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS },
    );
    if (!res.error && res.status === 0) return { kind: 'found', hex: res.stdout.trim() };
    if (silentMiss(res)) return { kind: 'absent' };
    return { kind: 'failed', detail: describeFailure('secret-tool', res) };
  },
  remove(account) {
    const res = spawnSync(
      'secret-tool',
      ['clear', 'service', SERVICE, 'account', account],
      { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS },
    );
    if (!res.error && res.status === 0) return { ok: true };
    if (silentMiss(res)) return { ok: true };
    return { ok: false, detail: describeFailure('secret-tool', res) };
  },
};

const DRIVERS: Record<Exclude<CredentialBackend, 'file'>, KeychainDriver> = {
  'macos-keychain': macDriver,
  'linux-libsecret': linuxDriver,
};

// --- backend selection (the two single-home rules) ----------------------------

const BACKEND_NAMES: readonly CredentialBackend[] = [
  'macos-keychain',
  'linux-libsecret',
  'file',
];

function isBackendName(value: unknown): value is CredentialBackend {
  return typeof value === 'string' && (BACKEND_NAMES as string[]).includes(value);
}

/**
 * Which backend a NEW store would use — preference, not truth. Truth about an
 * existing credential is the marker (`recordedBackend`).
 *
 * `TACENDUM_CREDENTIAL_STORE` overrides: `file` keeps everything in the 0600
 * file, a backend name forces that backend, `auto`/unset probes the platform.
 * An unknown value throws rather than guessing — the same posture as
 * TACENDUM_ENV, and for the same reason: falling through on a typo is a
 * silent misconfiguration.
 *
 * The probe is PRESENCE ONLY (is the tool on PATH), never a live keychain
 * operation: a working-keychain probe would need to write something, and a
 * headless box answers the real question at store time anyway —
 * `migrateCredential` falls back to the file on any store failure, which is
 * how a CI runner with no keychain keeps working with no flags.
 */
export function preferredBackend(
  env: Record<string, string | undefined> = process.env,
): CredentialBackend {
  const override = env.TACENDUM_CREDENTIAL_STORE || undefined; // '' means unset
  if (override !== undefined && override !== 'auto') {
    if (!isBackendName(override)) {
      throw new CliError(
        EXIT.USAGE,
        `TACENDUM_CREDENTIAL_STORE names no known backend (expected ` +
          `"macos-keychain", "linux-libsecret", "file" or "auto"); refusing to guess`,
      );
    }
    return override;
  }
  if (process.platform === 'darwin' && toolExists('security')) return 'macos-keychain';
  if (process.platform === 'linux' && toolExists('secret-tool')) return 'linux-libsecret';
  return 'file';
}

/** PATH presence via a spawn that runs nothing secret and prints nothing of
 * ours: ENOENT is the one signal wanted; any other outcome means the binary
 * exists (usage chatter from a bare invocation included). */
function toolExists(tool: string): boolean {
  const res = spawnSync(tool, ['--this-flag-only-probes-existence'], {
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return (res.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
}

interface MarkerState {
  backend: CredentialBackend;
  /** True when the marker was written after item coordinates became
   * home-scoped (`scope: "home"`). A marker WITHOUT the field predates the
   * scoping: its keychain item sits at the legacy coordinates (account =
   * raw name) and gets re-homed by `migrateCredential` on the next command.
   * Meaningless for backend 'file'. */
  homeScoped: boolean;
}

/**
 * The backend this account's credential was actually stored under, or null
 * when nothing has been recorded — which is exactly the shipping state (the
 * 0600 file) plus the fresh-box state (nothing at all).
 *
 * A corrupt marker reads as null rather than throwing: null routes reads to
 * the file first and then the keychain probe (see `readCredential`), so both
 * places the credential could be are still consulted — the failure costs a
 * probe, never the account.
 */
function recordedMarker(name: string): MarkerState | null {
  const path = markerPath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      backend?: unknown;
      scope?: unknown;
    };
    if (!isBackendName(parsed.backend)) return null;
    return { backend: parsed.backend, homeScoped: parsed.scope === 'home' };
  } catch {
    return null;
  }
}

function recordedBackend(name: string): CredentialBackend | null {
  return recordedMarker(name)?.backend ?? null;
}

/** Durable like every store metadata write: a marker that vanishes in a power
 * cut would send the next read hunting through the fallback chain. `scope`
 * says the item (if any) lives at the home-scoped coordinates. An older CLI
 * still parses this marker (it reads only `backend`) but looks at its own
 * legacy coordinates — a downgrade after `--remove-file` therefore needs the
 * legacy item, which re-homing deliberately leaves in place. */
function recordBackend(name: string, backend: CredentialBackend): void {
  writeFileAtomic(markerPath(name), JSON.stringify({ backend, scope: 'home' }), { mode: 0o600 });
}

/**
 * identity.json's bytes as hex, with the raw fs error CONTAINED — the same
 * guard `FileIdentityKeyStore.readCredentialGuarded` (stores.ts) holds around
 * the store-mediated read, for the same reason: a raw fs error's message
 * embeds the full file path, and the path embeds the account name. What escapes is the errno alone, an OS-defined vocabulary word
 * shape-checked so an exotic error object cannot smuggle text through the
 * slot. An earlier revision's both-exist probe read this file bare, and so did the
 * pre-existing mirror arm one screen down — `doctor` died on the unreadable
 * credential it exists to diagnose, printing the account segment verbatim
 *. Every identity.json read in this module
 * now routes through here.
 */
function credentialFileGuarded(
  name: string,
): { ok: true; content: string } | { ok: false; errno: string } {
  try {
    return { ok: true, content: readFileSync(credentialFilePath(name), 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const errno =
      typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unreadable';
    return { ok: false, errno };
  }
}

/**
 * Where `readCredential` doc step 4 would answer for a NULL marker with no
 * file — the distrust-a-null-marker doctrine, factored so the observability
 * pair (`credentialStatus`, `credentialCheck`) and the marker repair
 * (`migrateCredential`) consult the same probe the read path performs
 * instead of re-deriving it (module header: one decision point). Its twin
 * sites already carried the doctrine — `readCredential` step 4 and
 * `deleteCredential`'s best-effort removal — and the observability pair was
 * the third face of that mirror and had neither.
 *
 * READ-ONLY: lookups only, no store, no marker write. NEVER THROWS: a
 * misconfigured TACENDUM_CREDENTIAL_STORE reads as 'nothing' here — the
 * explicit surfaces that want that refusal get it from `preferredBackend()`
 * directly. The profile gate is `readCredential`'s own: without a profile a
 * failure or a foreign item is a fresh box's normal state and answers
 * 'nothing'; the legacy coordinates are never consulted at all.
 */
type UnrecordedProbe =
  | { kind: 'scoped-item'; backend: Exclude<CredentialBackend, 'file'> }
  | { kind: 'legacy-item'; backend: Exclude<CredentialBackend, 'file'> }
  | { kind: 'unreachable'; backend: Exclude<CredentialBackend, 'file'>; detail: string }
  | { kind: 'foreign-item'; backend: Exclude<CredentialBackend, 'file'> }
  | { kind: 'nothing' };

function probeUnrecorded(name: string): UnrecordedProbe {
  let preferred: CredentialBackend;
  try {
    preferred = preferredBackend();
  } catch {
    return { kind: 'nothing' };
  }
  if (preferred === 'file') return { kind: 'nothing' };
  const driver = DRIVERS[preferred];
  const probe = driver.lookup(itemAccount(name));
  if (probe.kind === 'found' && fromHex(probe.hex) !== null) {
    return { kind: 'scoped-item', backend: preferred };
  }
  if (!existsSync(profilePath(name))) return { kind: 'nothing' };
  if (probe.kind === 'failed') {
    return { kind: 'unreachable', backend: preferred, detail: probe.detail };
  }
  if (probe.kind === 'found') return { kind: 'foreign-item', backend: preferred };
  // Scoped says absent, and a profile evidences the account: a pre-scoping
  // migration whose marker was lost left its item at the legacy coordinates.
  const legacy = driver.lookup(name);
  if (legacy.kind === 'found' && fromHex(legacy.hex) !== null) {
    return { kind: 'legacy-item', backend: preferred };
  }
  if (legacy.kind === 'failed') {
    return { kind: 'unreachable', backend: preferred, detail: legacy.detail };
  }
  if (legacy.kind === 'found') return { kind: 'foreign-item', backend: preferred };
  return { kind: 'nothing' };
}

// --- read ---------------------------------------------------------------------

/**
 * The account credential (identity.json content), from wherever it lives.
 * `null` means "no credential exists for this name" — the answer that lets a
 * caller register — and is only returned once every place the credential
 * could be has said absent.
 *
 * Resolution order, and why each step exists:
 *  1. Marker names a keychain backend → read the home-scoped item. On
 *     success, done.
 *  2. The retained file, if present. This is the shipping read path (no
 *     marker), the safety net for a locked keychain, and — because it lives
 *     INSIDE this home — the one copy whose ownership is beyond question:
 *     when the scoped item is missing (a pre-scoping marker whose item still
 *     sits at legacy coordinates, or a genuinely lost item), the file
 *     answers with THIS home's identity, never a neighbour's.
 *  3. Behind a PRE-SCOPING marker with no file, the legacy coordinates
 *     (account = raw name) are read as a fallback, or the migrated-then-
 *     `--remove-file` accounts of the global-coordinate era would all wake
 *     up "credential lost" after the upgrade. The marker is the ownership
 *     claim: this home once stored its credential there and verified the
 *     read-back. (A same-named account in ANOTHER home may have overwritten
 *     it since — the very defect that forced the scoping — but in that
 *     state the original bytes are unrecoverable and no answer here can
 *     restore them; `credentialCheck` is where the ambiguity is reported.)
 *  4. With NO marker and NO file, the preferred keychain is probed at the
 *     scoped coordinates before answering null: a lost marker (disk restore
 *     that skipped dotfiles, a corrupt write) must not make a keychain-held
 *     credential read as "unregistered" — that answer invites a re-register
 *     that mints a second account. A probe that finds the item self-heals
 *     the read. A probe FAILURE splits on the one other piece of evidence
 *     this machine holds: when a profile exists for the name, the account
 *     demonstrably exists, so an unclassifiable failure REFUSES
 *     (EXIT.ERROR) rather than answering the word that re-registers; on a
 *     fresh box (no profile) it still answers null, because "no bus" is the
 *     normal CI state and blocking first registration on it would strand
 *     every runner. The same split applies to a found-but-undecodable item:
 *     with a profile it is a lost credential (EXIT.AUTH), without one it is
 *     somebody else's item. ONLY with a profile does the probe extend to
 *     the legacy coordinates (a pre-scoping migration whose marker was
 *     lost): on a box with no profile a legacy item is a DIFFERENT home's
 *     credential, and adopting it would both hijack that identity and block
 *     this home's registration — the fresh box answers null and never
 *     touches it.
 *
 * When the marker names a keychain and the file is gone, the two lookup
 * outcomes are kept apart (module header): absent → EXIT.AUTH (the
 * credential is gone; restore it), failed → EXIT.ERROR (the keychain is
 * unreachable; retry can help). Neither returns null — null re-registers.
 */
export function readCredential(name: string): string | null {
  const filePath = credentialFilePath(name); // validates the name first
  const marker = recordedMarker(name);

  if (marker !== null && marker.backend !== 'file') {
    const recorded = marker.backend;
    const driver = DRIVERS[recorded];
    const result = driver.lookup(itemAccount(name));
    if (result.kind === 'found') {
      const decoded = fromHex(result.hex);
      if (decoded !== null) return decoded;
      // Undecodable item: something else wrote over ours. The retained file
      // (below) can still answer; without it this is indistinguishable from
      // a lost credential and must say so, not return garbage.
      if (!existsSync(filePath)) {
        throw new CliError(
          EXIT.AUTH,
          `the ${recorded} item for this account is not one this CLI wrote — ` +
            `restore identity.json from backup; the key IS the account and cannot be re-minted`,
        );
      }
    } else if (result.kind === 'failed' && !existsSync(filePath)) {
      throw new CliError(
        EXIT.ERROR,
        `the account credential is in the ${recorded} and it could not be read: ` +
          `${result.detail}. Nothing is wrong with the credential itself — retry ` +
          `once the keychain is reachable`,
      );
    } else if (result.kind === 'absent' && !existsSync(filePath)) {
      // Doc step 3: a pre-scoping marker's item still sits at the legacy
      // coordinates until the migration hook re-homes it. A home-scoped
      // marker never falls back here — its item was stored and verified at
      // the scoped coordinates, and a legacy item under this name would be
      // some other home's.
      if (!marker.homeScoped) {
        const legacy = driver.lookup(name);
        if (legacy.kind === 'found') {
          const decoded = fromHex(legacy.hex);
          if (decoded !== null) return decoded;
          throw new CliError(
            EXIT.AUTH,
            `the ${recorded} item for this account is not one this CLI wrote — ` +
              `restore identity.json from backup; the key IS the account and cannot be re-minted`,
          );
        }
        if (legacy.kind === 'failed') {
          throw new CliError(
            EXIT.ERROR,
            `the account credential is in the ${recorded} and it could not be read: ` +
              `${legacy.detail}. Nothing is wrong with the credential itself — retry ` +
              `once the keychain is reachable`,
          );
        }
      }
      throw new CliError(
        EXIT.AUTH,
        `the ${recorded} no longer has this account's credential and no fallback ` +
          `file remains — restore identity.json from backup; the key IS the ` +
          `account and cannot be re-minted`,
      );
    }
  }

  if (existsSync(filePath)) {
    // Guarded like every other identity.json read in this module: a raw EACCES/EIO here carried the full path — and the
    // account name inside it — onto whatever surface called this, including
    // `cmdCredential`'s stderr. `FileIdentityKeyStore.readCredentialGuarded`
    // wraps this same read for store-mediated callers; direct callers get the
    // identical fixed prose from here. A CliError is what doctor's identity
    // catch and the register-refusal chain already expect.
    const read = credentialFileGuarded(name);
    if (read.ok) return read.content;
    throw new CliError(
      EXIT.ERROR,
      `the account credential file could not be read (${read.errno}) — nothing is ` +
        `wrong with the credential itself; retry once the file is readable`,
    );
  }

  if (marker === null) {
    const preferred = preferredBackend();
    if (preferred !== 'file') {
      const probe = DRIVERS[preferred].lookup(itemAccount(name));
      if (probe.kind === 'found') {
        const decoded = fromHex(probe.hex);
        if (decoded !== null) return decoded;
      }
      // A profile is proof the account was registered from this machine, so
      // with no file and no marker the probe was the LAST place the
      // credential could be — and it did not answer "absent". Returning null
      // here would hand the caller the re-registration signal on the
      // strength of a failure nobody classified (doc step 4).
      if (probe.kind === 'failed' && existsSync(profilePath(name))) {
        throw new CliError(
          EXIT.ERROR,
          `a profile exists for this account but its credential could not be ` +
            `looked up in the ${preferred}: ${probe.detail}. Refusing to treat ` +
            `this as "unregistered" — retry once the keychain is reachable, or ` +
            `restore identity.json from backup`,
        );
      }
      if (probe.kind === 'found' && existsSync(profilePath(name))) {
        // Found-but-undecodable, with a profile: the account exists and the
        // one item under our coordinates is not one this CLI wrote.
        throw new CliError(
          EXIT.AUTH,
          `the ${preferred} item for this account is not one this CLI wrote — ` +
            `restore identity.json from backup; the key IS the account and cannot be re-minted`,
        );
      }
      if (probe.kind === 'absent' && existsSync(profilePath(name))) {
        // Doc step 4, last clause: a pre-scoping migration whose marker was
        // lost left its item at the legacy coordinates. The profile gates
        // this — a box that never registered the account has no claim to a
        // legacy item and must leave it alone.
        const legacy = DRIVERS[preferred].lookup(name);
        if (legacy.kind === 'found') {
          const decoded = fromHex(legacy.hex);
          if (decoded !== null) return decoded;
          throw new CliError(
            EXIT.AUTH,
            `the ${preferred} item for this account is not one this CLI wrote — ` +
              `restore identity.json from backup; the key IS the account and cannot be re-minted`,
          );
        }
        if (legacy.kind === 'failed') {
          throw new CliError(
            EXIT.ERROR,
            `a profile exists for this account but its credential could not be ` +
              `looked up in the ${preferred}: ${legacy.detail}. Refusing to treat ` +
              `this as "unregistered" — retry once the keychain is reachable, or ` +
              `restore identity.json from backup`,
          );
        }
      }
    }
  }

  return null;
}

// --- migration ----------------------------------------------------------------

export interface MigrationOutcome {
  /**
   * migrated        — the credential is in the keychain, verified readable
   *                   there (marker recorded), and reads follow it:
   *                   `FileIdentityKeyStore.exists`/`load` route through
   *                   `readCredential`, so no command requires identity.json
   *                   any more. The file is still retained unless
   *                   `removeFile` asked otherwise — a fallback for a locked
   *                   keychain, not the read path
   * already         — a marker already answered; nothing needed doing
   * kept-file       — a keychain was preferred but unusable, and NO keychain
   *                   backend was recorded yet; the 0600 file stays
   *                   authoritative and the marker says so
   * kept-recorded   — a keychain backend IS recorded and the store (or its
   *                   read-back) failed; the marker is KEPT, unrewritten.
   *                   Recording 'file' here is what an earlier review
   *                   executed: `readCredential` step 1 is gated on the
   *                   marker, so a marker flipped on a transient bus failure
   *                   permanently severed the read path to a healthy item —
   *                   the retained file (possibly stale, possibly junk)
   *                   answered forever, and no command ever consulted the
   *                   one good copy again. A transient failure is not
   *                   evidence against the recorded claim; reads fall back
   *                   to the file by the read path's own rule while the
   *                   item is unreachable, and answer from the item again
   *                   the moment it is not. (`rehomeLegacyItem` has always
   *                   taken exactly this posture for the no-file case: on
   *                   failure the marker is kept, never rewritten.)
   * kept-legacy     — a pre-scoping keychain item could not be re-homed to
   *                   the home-scoped coordinates and no file exists to fall
   *                   back on; the pre-scoping marker is kept so reads keep
   *                   answering wherever they already did, and the next
   *                   command retries the re-home. NOT a success: the
   *                   explicit command exits with `failureExit` —
   *                   `readCredential`'s own taxonomy for the underlying
   *                   state (ERROR when the keychain could not be read,
   *                   AUTH when it answered and nothing usable exists at
   *                   either coordinate) — because an earlier revision landed
   *                   EXIT.ERROR on `kept-recorded` and left this, its
   *                   mirror, reporting ok:true at exit 0 over a re-home
   *                   that never happened
   * file-preferred  — no keychain on this platform/config; file recorded
   * no-credential   — nothing to migrate (unregistered name)
   */
  action:
    | 'migrated'
    | 'already'
    | 'kept-file'
    | 'kept-recorded'
    | 'kept-legacy'
    | 'file-preferred'
    | 'no-credential';
  backend: CredentialBackend;
  /** True when the 0600 file was removed after a verified keychain read-back. */
  removedFile: boolean;
  /** Safe prose: never the credential, never the name. */
  detail: string;
  /**
   * On `kept-legacy` only: the exit class `readCredential`'s taxonomy assigns
   * the underlying keychain state, carried on the outcome because only
   * `rehomeLegacyItem` saw which lookups answered. `cmdCredential` refuses
   * with this code; the silent hook ignores it as it ignores every
   * non-'migrated' outcome.
   */
  failureExit?: typeof EXIT.ERROR | typeof EXIT.AUTH;
}

/**
 * Move the credential into the OS keychain.
 *
 * NON-DESTRUCTIVE BY DEFAULT: the file is left in place. The file is not
 * deleted until the keychain copy is provably readable back — and even then
 * only when explicitly asked, because a keychain that works today can be
 * locked tomorrow and the file costs nothing (this home writes it once;
 * `readCredential` uses it as the safety net whenever it is present).
 * Removal needed TWO things before it was safe to offer, and it shipped
 * after only one of them: (1) `FileIdentityKeyStore.exists`/`load` routing
 * through `readCredential` (stores.ts), so a missing file no longer invites
 * `cmdRegister` to mint a second account; and (2) HOME-SCOPED item
 * coordinates (see ITEM COORDINATES), because under the global coordinates a
 * same-named account in another TACENDUM_HOME overwrote the item in place —
 * which made the "immutable, verified" keychain copy this call had just
 * read back a value some later migration could silently replace, and a
 * removed file left nothing to recover from. Both hold now.
 *
 * `removeFile` deletes the file ONLY after this very call has read the
 * keychain item back and byte-compared it to the file content — never on the
 * strength of an earlier run's marker alone.
 *
 * RE-HOMING (the coordinate migration): a marker written before the scoping
 * (`homeScoped` false) has its item at the legacy coordinates. This call
 * moves it: from the retained file when one exists (the copy whose ownership
 * is certain), else from the legacy item itself (the marker is this home's
 * recorded claim to it — see `readCredential` doc step 3). The legacy item
 * is LEFT IN PLACE: it may be the only remaining copy for a same-named
 * account in another home, and `-U`-style overwrites mean nothing about the
 * item proves whose bytes it now holds. Deleting it is reserved for
 * `deleteCredential`, which only does so on byte-equal proof of ownership.
 *
 * A store/read-back failure is a FALLBACK, not an error: with a file, the
 * marker records 'file' and the account keeps working exactly as shipped —
 * this is the headless path, and it must need no flags. (Without a file — a
 * failed re-home of a legacy-only credential — the pre-scoping marker is
 * KEPT instead: recording 'file' with no file would make `readCredential`
 * answer null, the word that re-registers.) The decision is recorded so the
 * probe does not re-run (and re-fail) on every invocation; `force` (the
 * explicit `credential --migrate` command) retries past a 'file' marker for
 * the operator whose keychain has since come back.
 */
export function migrateCredential(
  name: string,
  opts: { force?: boolean; removeFile?: boolean } = {},
): MigrationOutcome {
  const filePath = credentialFilePath(name);
  const marker = recordedMarker(name);
  const recorded = marker?.backend ?? null;
  // A pre-scoping keychain marker means the item sits at the legacy
  // coordinates and must move — 'already' would leave the account reading
  // through the shared-coordinate fallback forever.
  const needsRehome = marker !== null && marker.backend !== 'file' && !marker.homeScoped;

  if (recorded !== null && !needsRehome && !opts.force && !opts.removeFile) {
    return {
      action: 'already',
      backend: recorded,
      removedFile: false,
      detail: 'a credential backend is already recorded for this account',
    };
  }

  const preferred = recorded !== null && recorded !== 'file' ? recorded : preferredBackend();

  if (!existsSync(filePath)) {
    // No file: either unregistered, or already migrated AND file-removed.
    if (recorded !== null && recorded !== 'file') {
      if (!needsRehome) {
        return {
          action: 'already',
          backend: recorded,
          removedFile: false,
          detail: 'the credential lives in the keychain and no file remains',
        };
      }
      return rehomeLegacyItem(name, recorded);
    }
    // NO MARKER AND NO FILE is not only the fresh box: it is also the
    // LOST-MARKER state (`readCredential` doc step 4 — a disk restore that
    // skipped dotfiles, a corrupt write) on a machine whose credential lives
    // in the keychain. Reads self-heal through the probe; this command is the
    // SHIPPED REPAIR an earlier review found missing: re-record
    // the marker so reads stop depending on the probe — which a restored
    // identity.json from the wrong home would silently pre-empt, because the
    // file wins over the probe. Same probe, same profile gate, same taxonomy
    // as the read path (`probeUnrecorded`).
    if (recorded === null) {
      const probe = probeUnrecorded(name);
      if (probe.kind === 'scoped-item') {
        recordBackend(name, probe.backend);
        return {
          action: 'migrated',
          backend: probe.backend,
          removedFile: false,
          detail:
            'the credential was already in the keychain but no backend marker was ' +
            'recorded (a lost or corrupt marker); the marker was restored and reads ' +
            'follow the keychain',
        };
      }
      if (probe.kind === 'legacy-item') {
        // A pre-scoping migration whose marker was lost: the profile is the
        // ownership evidence (readCredential's own gate), and the re-home
        // carries its own verify-then-record transaction and its own
        // failure taxonomy.
        return rehomeLegacyItem(name, probe.backend);
      }
      if (probe.kind === 'unreachable') {
        // A profile evidences the account; the probe was the LAST place the
        // credential could be and it did not answer "absent". Claiming
        // no-credential here would print the register invitation over a
        // machine whose keychain is merely unreachable.
        throw new CliError(
          EXIT.ERROR,
          `a profile exists for this account but its credential could not be ` +
            `looked up in the ${probe.backend}: ${probe.detail}. Nothing was ` +
            `recorded — retry once the keychain is reachable`,
        );
      }
      if (probe.kind === 'foreign-item') {
        throw new CliError(
          EXIT.AUTH,
          `the ${probe.backend} item for this account is not one this CLI wrote — ` +
            `restore identity.json from backup; the key IS the account and cannot be re-minted`,
        );
      }
      // 'nothing': genuinely fresh, fall through to no-credential.
    }
    return {
      action: 'no-credential',
      backend: 'file',
      removedFile: false,
      detail: 'no credential exists for this account on this machine',
    };
  }

  // Guarded: a bare read here surfaced the raw fs
  // error — path and account name included — on `credential --migrate`'s own
  // stderr and `--json`.
  const blobRead = credentialFileGuarded(name);
  if (!blobRead.ok) {
    throw new CliError(
      EXIT.ERROR,
      `identity.json exists but could not be read (${blobRead.errno}) — nothing ` +
        `was migrated; fix the file (permissions, ownership) and retry`,
    );
  }
  const blob = blobRead.content;

  if (preferred === 'file') {
    recordBackend(name, 'file');
    return {
      action: 'file-preferred',
      backend: 'file',
      removedFile: false,
      detail: 'no OS keychain is available here; the 0600 file remains authoritative',
    };
  }

  const driver = DRIVERS[preferred];
  const account = itemAccount(name); // home-scoped: another home's same-named account cannot touch it
  const hex = toHex(blob);
  const stored = driver.store(account, hex);
  let failure: string | null = stored.ok ? null : stored.detail;

  if (failure === null) {
    // PROVABLY READABLE BACK, byte for byte, before anything is recorded or
    // removed: a keychain that acks the write but returns something else (or
    // nothing) on read must leave the file authoritative, or the first read
    // after removal would be the moment the account is discovered lost.
    const back = driver.lookup(account);
    if (back.kind !== 'found') {
      failure =
        back.kind === 'failed' ? back.detail : 'stored item could not be found on read-back';
    } else if (back.hex !== hex) {
      failure = 'read-back did not match what was written';
    }
    if (failure !== null) driver.remove(account); // best-effort: no half-written item
  }

  if (failure !== null) {
    // TWO STATES, TWO POSTURES, split on what is already recorded. With NO keychain backend recorded this is the headless
    // first decision: record 'file' so the probe does not re-run (and
    // re-fail) on every invocation — the deliberate, flagless fallback the
    // tests pin. With a keychain backend RECORDED, recording 'file' is not a
    // fallback but a DOWNGRADE that outlives the failure: `readCredential`
    // step 1 is gated on the marker, so the flip stopped every later read
    // from consulting a healthy item over a junk retained file — permanently,
    // on the strength of one dead session bus. The marker is the ownership
    // claim ("this home stored its credential there and verified the
    // read-back"); a transient failure is not evidence against it, and
    // `readCredential` already answers from the file on its own while the
    // item is unreachable. Keep the marker; the explicit command surfaces the
    // failure (`cmdCredential` raises EXIT.ERROR on this action), the hook
    // stays silent, and the next reachable moment restores the item as the
    // read path with no state to undo.
    if (recorded !== null && recorded !== 'file') {
      return {
        action: 'kept-recorded',
        backend: recorded,
        removedFile: false,
        // "Unreachable" would be a lie for one of this arm's two shapes: a
        // store that SUCCEEDED and then failed its read-back reached the
        // keychain twice — the failed item is removed above rather than left
        // half-written. The prose covers both.
        detail:
          `${preferred} did not complete a verified re-store (${failure}); the recorded ` +
          `${recorded} backend is kept — reads fall back to the 0600 file until the ` +
          `item is readable again, and an item that failed its read-back was removed ` +
          `rather than left half-written`,
      };
    }
    recordBackend(name, 'file');
    return {
      action: 'kept-file',
      backend: 'file',
      removedFile: false,
      detail: `${preferred} unavailable (${failure}); the 0600 file remains authoritative`,
    };
  }

  recordBackend(name, preferred);

  let removedFile = false;
  if (opts.removeFile) {
    // The read-back above verified this exact process can read this exact
    // content out of the keychain — the precondition for removal.
    unlinkSync(filePath);
    removedFile = true;
  }

  return {
    action: 'migrated',
    backend: preferred,
    removedFile,
    detail: removedFile
      ? 'credential migrated into the keychain and verified readable; the fallback file was removed'
      : 'credential migrated into the keychain and verified readable; reads follow the ' +
        'keychain, and identity.json is retained as a fallback',
  };
}

/**
 * The no-file half of the coordinate migration: move a pre-scoping keychain
 * item (account = raw name) to the home-scoped coordinates for an account
 * whose 0600 file was already removed. The pre-scoping marker is this home's
 * recorded, read-back-verified claim to that item (`readCredential` doc step
 * 3). NON-DESTRUCTIVE: the legacy item is copied, never deleted here — the
 * shared coordinate means it may since have been overwritten by (and now
 * belong to) a same-named account in another home, and stranding that home
 * is worse than a stale item. On any failure the pre-scoping marker is kept,
 * NOT rewritten: reads keep answering through the legacy fallback and the
 * next command retries. (Recording 'file' — the file-flow fallback — would
 * be a lie with no file behind it: `readCredential` would then answer null,
 * the word that re-registers.)
 */
function rehomeLegacyItem(
  name: string,
  backend: Exclude<CredentialBackend, 'file'>,
): MigrationOutcome {
  const driver = DRIVERS[backend];
  const account = itemAccount(name);

  const atScoped = driver.lookup(account);
  if (atScoped.kind === 'found' && fromHex(atScoped.hex) !== null) {
    // A previous run stored the scoped item but died before the marker
    // write reached disk. Finish that transaction: upgrade the marker.
    recordBackend(name, backend);
    return {
      action: 'already',
      backend,
      removedFile: false,
      detail: 'the credential lives in the keychain and no file remains',
    };
  }

  const legacy = driver.lookup(name);
  if (legacy.kind !== 'found' || fromHex(legacy.hex) === null) {
    // Nothing usable to move. The marker stays as-is; `readCredential` owns
    // the taxonomy of this state (AUTH for gone, ERROR for unreachable) and
    // the outcome CARRIES it (`failureExit`) so the explicit command exits
    // with it instead of reporting ok:true over a re-home that never ran.
    // An unreachable keychain is also unreadable, so absence is only claimed
    // when the keychain ANSWERED (an earlier review's correction): a
    // failed lookup on either coordinate takes the unreachable arm.
    const unreachable = atScoped.kind === 'failed' || legacy.kind === 'failed';
    return {
      action: 'kept-legacy',
      backend,
      removedFile: false,
      failureExit: unreachable ? EXIT.ERROR : EXIT.AUTH,
      detail: unreachable
        ? `the ${backend} could not be read, so nothing was re-homed; reads are ` +
          `unchanged — retry once the keychain is reachable`
        : `the ${backend} answered and holds no usable item for this account at ` +
          `either coordinate, and no fallback file remains — restore identity.json ` +
          `from backup; the key IS the account and cannot be re-minted`,
    };
  }

  const stored = driver.store(account, legacy.hex);
  let failure: string | null = stored.ok ? null : stored.detail;
  if (failure === null) {
    const back = driver.lookup(account);
    if (back.kind !== 'found') {
      failure =
        back.kind === 'failed' ? back.detail : 'stored item could not be found on read-back';
    } else if (back.hex !== legacy.hex) {
      failure = 'read-back did not match what was written';
    }
    if (failure !== null) driver.remove(account); // best-effort: no half-written item
  }
  if (failure !== null) {
    // The legacy item is readable — reads keep answering from it — but the
    // re-home store (or its read-back) failed, so nothing moved and nothing
    // was recorded. `kept-recorded`'s taxonomy, one arm over: EXIT.ERROR,
    // retry once the keychain is healthy.
    return {
      action: 'kept-legacy',
      backend,
      removedFile: false,
      failureExit: EXIT.ERROR,
      detail: `${backend} unavailable (${failure}); the pre-home-scoped item remains the read path`,
    };
  }
  recordBackend(name, backend);
  return {
    action: 'migrated',
    backend,
    removedFile: false,
    detail:
      'credential re-homed to home-scoped keychain coordinates and verified readable; ' +
      'the item at the old shared coordinates was left in place',
  };
}

/**
 * The on-next-run hook: cheap when there is nothing to do, silent about how.
 * Intended to be called once per command start (after the account name is
 * known); it must never break the command it precedes, so every failure —
 * including a throw from a hostile PATH shim — degrades to "keep the file",
 * which is the shipping behavior.
 *
 * Returns null when nothing happened (already decided, or nothing to
 * migrate) so the caller can `report.note()` only real transitions.
 */
export function maybeMigrateCredential(name: string): MigrationOutcome | null {
  try {
    const marker = recordedMarker(name);
    if (marker !== null && (marker.backend === 'file' || marker.homeScoped)) {
      return null; // decided once, cheap forever
    }
    // A pre-scoping keychain marker still needs its item re-homed, with or
    // without a retained file; only the no-marker case requires a file to
    // have anything to migrate.
    if (marker === null && !existsSync(credentialFilePath(name))) return null;
    const outcome = migrateCredential(name);
    return outcome.action === 'migrated' ? outcome : null;
  } catch {
    // Even a USAGE-grade misconfiguration (bad TACENDUM_CREDENTIAL_STORE)
    // must not turn a `send` into a failure: the send never needed the
    // migration. The explicit `credential` command is where that error is
    // allowed to surface.
    return null;
  }
}

/** Remove the keychain item and the marker for an account (revoke/unregister
 * wiring). Never touches identity.json — deleting the one unrecoverable file
 * stays an explicit act of the caller that owns it.
 *
 * TWO COORDINATES, TWO POSTURES. The home-scoped item is removed outright:
 * its coordinate embeds this home, so it is this account's beyond question.
 * A LEGACY item (account = raw name — the shared, pre-scoping coordinate) is
 * removed ONLY when its content byte-matches a copy that is provably this
 * home's (the retained file, or the home-scoped item read just before its
 * removal): the shared coordinate means it may be a same-named account in
 * another TACENDUM_HOME, whose ONLY remaining copy this could be. An
 * unprovable legacy item is left in place — a stale entry in a keyring is
 * recoverable by hand; a deleted credential is not. */
export function deleteCredential(name: string): void {
  const marker = recordedMarker(name);
  const recorded = marker?.backend ?? null;
  const filePath = credentialFilePath(name);
  // Guarded. An unreadable file degrades to "not
  // provable as ours": the scoped item is still removed, and the legacy item
  // — whose deletion REQUIRES byte-equal proof of ownership — is left in
  // place, which is this function's conservative posture already.
  const fileRead = existsSync(filePath) ? credentialFileGuarded(name) : null;
  const fileHex = fileRead?.ok ? toHex(fileRead.content) : null;

  // No marker does NOT mean no keychain item — the marker can be lost
  // (disk restore that skipped dotfiles) or corrupt, exactly the states
  // `readCredential` step 4 self-heals by probing `preferredBackend()`.
  // Delete must distrust the null marker the same way, or the orphaned
  // item outlives this call and the read-side probe RESURRECTS a
  // credential the operator believed removed. Best-effort in that case,
  // mirroring the read probe's posture: a headless box that cannot reach a
  // keychain it never wrote to must not block the delete (removing what is
  // not there is the goal state, and `remove` already counts absent as
  // success).
  const probed = recorded === null ? preferredBackend() : null;
  const backend =
    recorded !== null && recorded !== 'file'
      ? recorded
      : probed !== null && probed !== 'file'
        ? probed
        : null;
  const bestEffort = recorded === null;

  if (backend !== null) {
    const driver = DRIVERS[backend];
    const account = itemAccount(name);

    // What is provably OURS, for judging the legacy item below — captured
    // BEFORE the scoped item is removed.
    let oursHex = fileHex;
    if (oursHex === null) {
      const atScoped = driver.lookup(account);
      if (atScoped.kind === 'found') oursHex = atScoped.hex;
    }

    const res = driver.remove(account);
    if (!res.ok && !bestEffort) {
      throw new CliError(
        EXIT.ERROR,
        `could not remove the ${backend} item: ${res.detail}. The credential ` +
          `may still be present; retry once the keychain is reachable`,
      );
    }

    if (oursHex !== null) {
      const legacy = driver.lookup(name);
      if (legacy.kind === 'found' && legacy.hex === oursHex) {
        const lres = driver.remove(name);
        if (!lres.ok && !bestEffort) {
          throw new CliError(
            EXIT.ERROR,
            `could not remove the ${backend} item: ${lres.detail}. The credential ` +
              `may still be present; retry once the keychain is reachable`,
          );
        }
      }
    }
  }
  const path = markerPath(name);
  if (existsSync(path)) unlinkSync(path);
}

// --- observability ------------------------------------------------------------

export interface CredentialStatus {
  /** Where reads for this account actually go. */
  backend: CredentialBackend;
  /** True when a marker records the choice; false when it is the pre-marker
   * default (the file) or a fresh box. */
  recorded: boolean;
  /** identity.json still on disk. */
  fileRetained: boolean;
}

export function credentialStatus(name: string): CredentialStatus {
  const fileRetained = existsSync(credentialFilePath(name));
  const recorded = recordedBackend(name);
  // `backend` is documented as "where reads for this account actually go" —
  // and with NO marker and NO file that is not the pre-marker default:
  // `readCredential` doc step 4 distrusts the null marker and probes the
  // preferred keychain before ever answering null, and `deleteCredential`
  // distrusts it the same way. The observability pair was the third face of
  // that mirror and had neither: after
  // `--migrate --remove-file` plus a lost marker, `credential` declared
  // backend `file` on a box with no file — right after `readCredential`
  // answered from the keychain — and doctor FAILed the healthy machine.
  // Read-only, like every probe in this module; the probe only ever runs in
  // the no-marker-no-file state, so a fresh box costs one lookup on a
  // surface that is already about to refuse.
  if (recorded === null && !fileRetained) {
    const probe = probeUnrecorded(name);
    if (probe.kind === 'scoped-item' || probe.kind === 'legacy-item') {
      return { backend: probe.backend, recorded: false, fileRetained };
    }
  }
  return {
    backend: recorded ?? 'file',
    recorded: recorded !== null,
    fileRetained,
  };
}

/**
 * The doctor line — READ ONLY, like every doctor check (doctor.ts: "doctor
 * observes; it never repairs"): it looks the keychain item up but never
 * stores, migrates, or rewrites a marker. The client name is never echoed
 * (doctor's own rule; `<name>` placeholder in remedies).
 *
 * DISAGREEMENT IS A FINDING. The keychain item and the retained file CAN
 * hold different identities (module header) — a restored backup, a copied
 * home directory, or the pre-scoping shared coordinate overwritten by a
 * same-named account in another home. In that state every command answers
 * from one source while the file holds another; a doctor that vouched for
 * whichever copy it happened to read would say "fine" about the exact
 * condition the operator most needs told about. So this check compares the
 * two whenever both exist and FAILS loudly on a mismatch, saying which copy
 * commands actually use.
 *
 * "WHENEVER BOTH EXIST" WAS WRITTEN A ROUND BEFORE IT WAS TRUE: the comparison lived only below the marker branch, so
 * with the marker saying 'file' it never ran though both copies existed —
 * and the file-arm instead answered ok:true and recommended the migrate
 * that would overwrite the item. That marker state is not exotic; it is
 * precisely what the earlier kept-file downgrade manufactured. The
 * file-arm now probes and compares too.
 */
export function credentialCheck(name: string): CheckResult {
  const status = credentialStatus(name);

  if (status.backend === 'file') {
    if (!status.fileRetained) {
      // `credentialStatus` already distrusted the null marker: reaching this
      // arm with nothing recorded means its probe found no decodable item
      // under our coordinates. What the probe DID find still matters,
      // because "restore or register" is wrong advice for a keychain that
      // merely could not be probed — `readCredential` REFUSES in that state
      // rather than treating the account as unregistered, and doctor's
      // identity line above this one USED TO defer here to name the cause
      //. It no longer does: an earlier revision gave all
      // three of doctor's identity arms their own prose — the refusal arm
      // interpolates the refusal's own message (`doctor.ts`) — so nothing
      // here is owed on another line's behalf. This arm still names what the
      // PROBE found, because it is the only surface that holds it.
      if (!status.recorded) {
        const probe = probeUnrecorded(name);
        if (probe.kind === 'unreachable') {
          return {
            check: 'credential',
            ok: false,
            detail:
              `no backend marker and no identity.json, but a profile exists and the ` +
              `${probe.backend} could not be probed — ${probe.detail}. Reads refuse ` +
              `rather than treat this account as unregistered`,
            remedy:
              'unlock the keychain / restore the session bus, then retry; if the ' +
              'credential is in the keychain: tacendum credential <name> --migrate ' +
              're-records the lost marker',
          };
        }
        if (probe.kind === 'foreign-item') {
          return {
            check: 'credential',
            ok: false,
            detail:
              `no backend marker and no identity.json, and the ${probe.backend} item ` +
              `under this account's coordinates is not one this CLI wrote`,
            remedy:
              'restore identity.json from backup; the key IS the account and cannot be re-minted',
          };
        }
        // 'nothing' falls through to the original wording below.
        // 'scoped-item'/'legacy-item' cannot reach this arm: credentialStatus
        // already answered with that backend.
      }
      return {
        check: 'credential',
        ok: false,
        // Two distinct states share this arm: nothing was ever recorded, and
        // a marker that records 'file' whose identity.json has since gone.
        // The line must be true in both, so it branches on which one it is.
        detail: status.recorded
          ? 'backend: file (recorded), but identity.json is gone from disk'
          : 'no credential backend recorded and no identity.json on disk',
        remedy:
          'if this client was ever registered, restore identity.json from backup; ' +
          'otherwise: tacendum register <name>',
      };
    }
    const preferred = preferredBackend();
    if (preferred !== 'file') {
      // BOTH-EXIST MEANS THIS ARM TOO. The
      // comparison below the marker branch never runs here — the marker (or
      // its absence) says 'file' — yet a keychain item CAN exist beside the
      // file: the earlier downgrade wrote exactly that state (healthy item,
      // marker flipped to 'file', junk file answering every read), and a
      // restored home directory or a hand-edited marker builds it too. In
      // that state this check said ok:true and RECOMMENDED the migrate that
      // would overwrite the one healthy copy with the file. Read-only, like
      // every probe in this function: one lookup, no store, no marker write.
      const probe = DRIVERS[preferred].lookup(itemAccount(name));
      if (probe.kind === 'found' && fromHex(probe.hex) !== null) {
        // GUARDED: this read was bare, and doctor died
        // on the unreadable credential it exists to diagnose — the raw fs
        // error carried the full path, account segment and all, where every
        // other doctor line masks. A check that cannot run says why.
        const fileRead = credentialFileGuarded(name);
        if (!fileRead.ok) {
          return {
            check: 'credential',
            ok: false,
            detail:
              `backend: file${status.recorded ? ' (recorded)' : ''}, but identity.json ` +
              `could not be read (${fileRead.errno}) — and a ${preferred} item exists ` +
              `beside it that this check could not compare against`,
            remedy:
              'fix the file (chmod 600 identity.json, check ownership and disk), then ' +
              're-run doctor — do not migrate until the two copies can be compared',
          };
        }
        const fileHex = toHex(fileRead.content);
        if (probe.hex !== fileHex) {
          return {
            check: 'credential',
            ok: false,
            detail:
              `backend: file${status.recorded ? ' (recorded)' : ''}, but a ${preferred} item ` +
              `for this account also exists and holds a DIFFERENT credential — commands use ` +
              `the FILE, NOT the item`,
            remedy:
              'two identities exist for this name — do not migrate until this is understood: ' +
              'tacendum credential <name> --migrate would overwrite the keychain item with ' +
              'the file. Compare: tacendum whoami <name> against what this home should be. ' +
              'To keep the ITEM, restore the identity.json that matches it from backup ' +
              'BEFORE migrating; to keep the FILE, run the migrate',
          };
        }
        return {
          check: 'credential',
          ok: true,
          detail:
            `backend: file (0600 identity.json); the ${preferred} item matches — ` +
            `tacendum credential <name> --migrate records the keychain as the read path`,
        };
      }
      if (probe.kind === 'failed') {
        // FAILED IS NOT ABSENT applies to the comparison probe too: a keychain that could not be read
        // is not a keychain with nothing beside the file, and the generic
        // line below RECOMMENDS the migrate — which force-stores over
        // whatever item the failed probe hid, without the mismatch warning
        // above ever having had its chance to run.
        //
        // AND "READS ANSWER FROM IT" IS EARNED BY A READ, NOT ASSERTED
        //: this arm vouched for the file without
        // opening it, in the very state where a present-but-unreadable
        // identity.json makes `readCredential` REFUSE with EXIT.ERROR.
        // Guarded exactly as its twins — the 'found' branch above and the
        // marker arm below.
        const fileRead = credentialFileGuarded(name);
        if (!fileRead.ok) {
          return {
            check: 'credential',
            ok: false,
            detail:
              `backend: file${status.recorded ? ' (recorded)' : ''}, but identity.json ` +
              `could not be read (${fileRead.errno}) — and the ${preferred} could not ` +
              `be probed, so whether an item exists beside the file was not checked`,
            remedy:
              'fix the file (chmod 600 identity.json, check ownership and disk) and ' +
              'unlock the keychain / restore the session bus, then re-run doctor — ' +
              'do not migrate until the two copies can be compared',
          };
        }
        // With the file read back, the check stays green; the line just stops vouching for
        // a comparison that never ran.
        return {
          check: 'credential',
          ok: true,
          detail:
            `backend: file (0600 identity.json); reads answer from it, but the ` +
            `${preferred} could not be probed — whether an item exists beside the file ` +
            `was not checked; migrate only once the keychain is reachable and doctor ` +
            `can compare the two`,
        };
      }
    }
    // The generic PASS below claims "(0600 identity.json)" and, implicitly,
    // that reads answer from the file — claims about a file this path never
    // opened, in the ordinary no-item state doctor's identity FAIL used to
    // delegate cause-naming to:
    // with the file present but unreadable, `readCredential` refuses with
    // EXIT.ERROR while this line said green and named nothing. Guarded like
    // its twins above and below; `fileRetained` is true on every path here
    // (the early return above handled its absence).
    const fileRead = credentialFileGuarded(name);
    if (!fileRead.ok) {
      return {
        check: 'credential',
        ok: false,
        detail:
          `backend: file${status.recorded ? ' (recorded)' : ''}, but identity.json ` +
          `could not be read (${fileRead.errno}) — commands read the file in this ` +
          `state and refuse rather than treat the account as unregistered`,
        remedy:
          'fix the file (chmod 600 identity.json, check ownership and disk), then ' +
          're-run doctor',
      };
    }
    return {
      check: 'credential',
      ok: true,
      detail:
        preferred === 'file'
          ? 'backend: file (0600 identity.json); no OS keychain available here'
          : `backend: file (0600 identity.json); ${preferred} is available — ` +
            `tacendum credential <name> --migrate moves it (the file stays as a fallback)`,
    };
  }

  // The marker, when one exists. Null here means the backend above was
  // PROBED past a lost marker (`credentialStatus`), and the phrasing below
  // says so instead of claiming "(recorded)".
  const marker = recordedMarker(name);
  const recordedTag = status.recorded ? 'recorded' : 'probed — the backend marker is lost';
  const driver = DRIVERS[status.backend];
  // GUARDED — the PRE-EXISTING mirror of the file-arm
  // read above; guarding only the arm an earlier revision added would be this phase's
  // signature failure.
  const fileRead = status.fileRetained ? credentialFileGuarded(name) : null;
  if (fileRead !== null && !fileRead.ok) {
    return {
      check: 'credential',
      ok: false,
      detail:
        `backend: ${status.backend} (${recordedTag}), but the retained identity.json ` +
        `could not be read (${fileRead.errno}) — the keychain item was not compared ` +
        `against it`,
      remedy:
        'fix the file (chmod 600 identity.json, check ownership and disk), then ' +
        're-run doctor; commands read the keychain item first either way',
    };
  }
  const fileHex = fileRead !== null && fileRead.ok ? toHex(fileRead.content) : null;

  const result = driver.lookup(itemAccount(name));
  if (result.kind === 'found' && fromHex(result.hex) !== null) {
    if (fileHex !== null && result.hex !== fileHex) {
      // Two valid identities under one name. Commands answer from the
      // keychain item (readCredential step 1); the file holds someone —or
      // someTIME— else. Silence here is how the gate's two-identity state
      // went undiagnosed.
      return {
        check: 'credential',
        ok: false,
        detail:
          `backend: ${status.backend} (recorded), but the keychain item and the retained ` +
          `identity.json hold DIFFERENT credentials — commands use the keychain item, ` +
          `NOT the file`,
        remedy:
          'two identities exist for this name — do not send until this is understood. ' +
          'Compare: tacendum whoami <name> against what this home should be. To make the ' +
          // `--migrate`, with NO `--force`: there is no such flag. `parseArgs`
          // is strict (args.ts) and rejects an unknown option with EXIT.USAGE,
          // so this line used to print a command that exits 9 without doing
          // anything — an operator following it word for word got an error
          // about the remedy instead of the repair. `cmdCredential` passes
          // `force: true` to `migrateCredential` itself; the explicit command
          // has always forced (found while verifying an earlier review).
          'FILE the credential again: tacendum credential <name> --migrate (it ' +
          're-stores the file over the item); to keep the ITEM, restore the matching ' +
          'identity.json from backup or remove the stale file by hand',
      };
    }
    if (!status.recorded) {
      // The lost-marker state, healthy but fragile: reads answer only
      // through the step-4 probe's self-heal, and a restored identity.json
      // from the wrong home would silently take reads over (the file wins
      // over the probe). PASS — the machine works — but the line names the
      // state and the shipped repair rather than vouching for it silently.
      return {
        check: 'credential',
        ok: true,
        detail:
          `backend: ${status.backend} (${recordedTag}); the item is readable and reads ` +
          `answer from it — run: tacendum credential <name> --migrate to re-record the ` +
          `marker; until then a restored identity.json would silently take over reads`,
      };
    }
    return {
      check: 'credential',
      ok: true,
      detail: `backend: ${status.backend} (recorded); item readable` +
        (status.fileRetained ? '; fallback file retained (contents match)' : ''),
    };
  }

  if (result.kind === 'absent' && (marker === null || !marker.homeScoped)) {
    // Pre-scoping marker: the item (if any) still sits at the shared legacy
    // coordinates — the read path readCredential actually uses in this
    // state, so the report must look where the commands look.
    //
    // A NULL marker belongs here too (an earlier review — the legacy twin
    // of the scoped lost-marker fix). Reaching this arm with nothing
    // recorded means `credentialStatus` PROBED past the lost marker — its
    // probe is the only way `status.backend` names a keychain without a
    // marker — and the scoped coordinate answered absent above, so the
    // probe's answer was `legacy-item`: a pre-scoping migration whose
    // marker a disk restore skipped. The probe's own profile gate already
    // vouched for ownership. Gated on the marker alone, this branch was
    // skipped for exactly that population and control fell to the absent
    // diagnosis below: doctor FAILed an account `readCredential` answers
    // from these very coordinates, with the remedy ("restore identity.json
    // from backup; ... cannot be re-minted") that is both harmful (a
    // foreign backup silently takes over reads) and false (the migrate
    // re-homes and goes green).
    const legacy = driver.lookup(name);
    if (legacy.kind === 'found' && fromHex(legacy.hex) !== null) {
      if (fileHex !== null && legacy.hex !== fileHex) {
        // The gate's executed repro: file = this home's identity, shared
        // item = a same-named account's (usually another TACENDUM_HOME).
        // Commands use the FILE here (readCredential prefers it over the
        // legacy fallback), but the state still needs telling.
        return {
          check: 'credential',
          ok: false,
          detail:
            `backend: ${status.backend} (recorded), but the item at the OLD shared keychain ` +
            `coordinates does not match the retained identity.json — it likely belongs to a ` +
            `same-named account in another TACENDUM_HOME. Commands use the file`,
          remedy:
            'run any command (or: tacendum credential <name> --migrate) to move this ' +
            "home's credential to its own coordinates; the shared item is left for its owner",
        };
      }
      if (!status.recorded) {
        // The lost-marker twin of the scoped PASS above: healthy but
        // fragile — and unlike the pre-scoping-marker state one arm down,
        // the on-command hook does NOT self-repair this
        // (`maybeMigrateCredential` returns null with a null marker and no
        // file), so the explicit command is the only repair and the line
        // must name it rather than promising a re-home no command performs.
        return {
          check: 'credential',
          ok: true,
          detail:
            `backend: ${status.backend} (${recordedTag}); the item is readable at the ` +
            `pre-home-scoped shared coordinates and reads answer from it — run: ` +
            `tacendum credential <name> --migrate to re-home it and re-record the ` +
            `marker; until then a restored identity.json would silently take over reads`,
        };
      }
      return {
        check: 'credential',
        ok: true,
        detail:
          `backend: ${status.backend} (recorded); item still at the pre-home-scoped shared ` +
          `coordinates${fileHex !== null ? ' (matches identity.json)' : ''} — the next ` +
          `command re-homes it`,
      };
    }
    if (legacy.kind === 'failed') {
      // FAILED IS NOT ABSENT (module header; an earlier review). The
      // scoped coordinate answered absent, but the coordinate the read path
      // actually uses in this state COULD NOT BE READ — a locked login
      // keychain or a denied item ACL in a non-UI session. `readCredential`
      // refuses with EXIT.ERROR here rather than treating the account as
      // gone; falling through to the absent diagnosis handed a merely
      // locked keychain the account-ending remedy, on the very line
      // doctor's identity FAIL USED TO delegate cause-naming to. It does not
      // any more — an earlier revision gave that arm its own prose (`doctor.ts`) — which
      // makes the remedy on THIS line the account's only advice rather than
      // the second of two, and no less wrong for a keychain that is merely
      // locked.
      // `rehomeLegacyItem` (`atScoped.kind === 'failed' || legacy.kind ===
      // 'failed'`) and `probeUnrecorded` (`unreachable`) already keep the
      // two apart; this surface must too.
      return {
        check: 'credential',
        ok: false,
        detail:
          `backend: ${status.backend} (${recordedTag}), but the item at the OLD shared ` +
          `keychain coordinates could not be read — ${legacy.detail}`,
        remedy: status.fileRetained
          ? 'the fallback file still covers reads; fix the keychain environment when convenient'
          : 'unlock the keychain / restore the session bus, then retry',
      };
    }
    // The legacy lookup ANSWERED (absent, or an item that is not ours) and
    // so did the scoped one: fall through to the arms below, which describe
    // that state — nothing usable at either coordinate — accurately.
  }

  if (result.kind === 'absent' || result.kind === 'found') {
    // 'found' here means found-but-not-ours (undecodable) — same remedy.
    return {
      check: 'credential',
      ok: false,
      detail: `backend: ${status.backend} (${recordedTag}), but the keychain has no usable item`,
      remedy: status.fileRetained
        ? 'the fallback file still covers reads — re-run: tacendum credential <name> --migrate'
        : 'restore identity.json from backup; the key IS the account and cannot be re-minted',
    };
  }
  return {
    check: 'credential',
    ok: false,
    detail: `backend: ${status.backend} (${recordedTag}), but it could not be read — ${result.detail}`,
    remedy: status.fileRetained
      ? 'the fallback file still covers reads; fix the keychain environment when convenient'
      : 'unlock the keychain / restore the session bus, then retry',
  };
}

// --- command entry point ------------------------------------------------------

/**
 * `tacendum credential <name>` — where the credential lives, `--migrate` to
 * move it into the OS keychain, and `--migrate --remove-file` to also delete
 * the 0600 file after the keychain copy is verified readable back.
 *
 * A migration is a real move now: `FileIdentityKeyStore.exists`/`load`
 * (stores.ts) route through `readCredential`, so the re-registration gate and
 * every operational identity read answer from the keychain — the retained
 * file is a fallback for a locked keychain, not the read path. `--remove-file`
 * needed TWO preconditions, not one: that wiring (deleting the file while
 * reads still required identity.json was exactly the state where a re-run
 * minted a SECOND account over the old profile), and the HOME-SCOPED item
 * coordinates — under the old shared coordinates a same-named account in
 * another TACENDUM_HOME could overwrite the item AFTER the file was removed,
 * leaving nothing of this identity anywhere (gate rank 2). Removal stays
 * gated on the same-call verified read-back inside `migrateCredential` —
 * never on an earlier run's marker.
 */
export function cmdCredential(
  name: string,
  opts: { migrate: boolean; removeFile: boolean },
  report: Reporter,
): void {
  if (opts.removeFile && !opts.migrate) {
    // Removal is a migration OUTCOME (file gone only after this call proved
    // the keychain copy readable), not a free-standing delete of the one
    // unrecoverable file.
    throw new CliError(EXIT.USAGE, '--remove-file only makes sense with --migrate');
  }
  if (opts.migrate) {
    const outcome = migrateCredential(name, { force: true, removeFile: opts.removeFile });
    if (outcome.action === 'no-credential') {
      throw new CliError(
        EXIT.USAGE,
        'no credential exists for this account on this machine — register it first ' +
          '(tacendum register <name>)',
      );
    }
    if (outcome.action === 'kept-recorded') {
      // The operator ran the EXPLICIT repair command — doctor's own remedy
      // for a bad item — and no verified re-store happened, so nothing was
      // recorded. `ok:true` at exit 0 here is what an earlier review
      // flagged: a success line about a repair that did not happen, printed
      // to an operator who was told the command verifies before it records.
      // EXIT.ERROR is `readCredential`'s own taxonomy for this state:
      // nothing is wrong with the credential, retry once the keychain is
      // healthy. The prose must not claim the keychain "could not be
      // reached" — one of this arm's shapes is a store that SUCCEEDED and
      // failed its read-back, where the keychain was reached twice and the
      // failed item removed. The outcome detail is already
      // safe prose (never the credential, never the name).
      throw new CliError(
        EXIT.ERROR,
        `the keychain re-store did not complete, so nothing was recorded: ` +
          `${outcome.detail}. The file was not touched; retry once the keychain ` +
          `is healthy`,
      );
    }
    if (outcome.action === 'kept-legacy') {
      // The same rule, one arm over: an earlier revision landed
      // EXIT.ERROR on `kept-recorded` and left its mirror on the ok:true
      // fall-through — in the state where the operator is WORSE off, because
      // no retained file exists. The exit class is `readCredential`'s for
      // the underlying state — ERROR for a keychain that could not be read
      // (retry can help), AUTH for a credential that is gone (restore from
      // backup) — carried on the outcome because only `rehomeLegacyItem`
      // saw which lookups answered.
      throw new CliError(
        outcome.failureExit ?? EXIT.ERROR,
        `the credential was not re-homed: ${outcome.detail}`,
      );
    }
    report.emit(
      {
        ok: true,
        action: outcome.action,
        backend: outcome.backend,
        removedFile: outcome.removedFile,
      },
      `${outcome.backend}: ${outcome.detail}`,
    );
    return;
  }

  const status = credentialStatus(name);
  // Status must assert that a credential actually EXISTS, not just that the
  // marker/file shape is well-formed: a never-registered name has a
  // perfectly well-formed shape (backend "file", nothing recorded, no file)
  // and used to report ok:true for it. `readCredential` is the existence
  // oracle because it already carries the whole taxonomy: it probes past a
  // lost marker before answering null, and for a recorded backend that
  // cannot answer it throws AUTH (credential gone) or ERROR (keychain
  // unreachable) instead of letting an ok:true line paper over either.
  if (readCredential(name) === null) {
    throw new CliError(
      EXIT.USAGE,
      'no credential exists for this account on this machine — register it first ' +
        '(tacendum register <name>)',
    );
  }
  report.emit(
    {
      ok: true,
      backend: status.backend,
      recorded: status.recorded,
      fileRetained: status.fileRetained,
    },
    `backend: ${status.backend}${status.recorded ? ' (recorded)' : ''}` +
      `${status.fileRetained ? '; fallback file retained' : ''}`,
  );
}
