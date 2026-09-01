import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { IdentityKeyPair } from '@signalapp/libsignal-client';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * keychain.ts under fake `security` / `secret-tool` binaries.
 *
 * The real tools need a GUI keychain or a session bus, neither of which a
 * test runner has — and a test that wrote to the developer's real login
 * keychain would be vandalism. So the tests install PATH shims that speak
 * each tool's verified contract (exit 44 = not-found for `security`, silent
 * nonzero = miss for `secret-tool`, `security -i` reads its command from
 * stdin) and additionally RECORD EVERY ARGV LINE — which is what lets a test
 * assert the one property that matters most here: the credential never
 * appears on a command line, where `ps` would show it to every user on the
 * box.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-keychain-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-keychain-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-keychain-state-'));
process.env.TACENDUM_HOME = home;

const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;

// Shims set their own PATH so they keep working even if a test narrows ours.
const SECURITY_SHIM = `#!/bin/bash
PATH=/usr/bin:/bin
state="$FAKE_KEYCHAIN"
mode="$FAKE_KEYCHAIN_MODE"
printf '%s\\n' "$*" >> "$state/argv.log"
if [ "$1" = "-i" ]; then
  line="$(cat)"
  printf 'STDIN:%s\\n' "$line" >> "$state/stdin.log"
  acct=$(printf '%s' "$line" | sed -n 's/.*-a "\\([^"]*\\)".*/\\1/p')
  hex=$(printf '%s' "$line" | sed -n 's/.*-w "\\([^"]*\\)".*/\\1/p')
  if [ "$mode" = "store-echo-stdin" ]; then
    printf '%s\\n' "$line" >&2
    exit 1
  fi
  if [ "$mode" = "store-fail" ] || [ "$mode" = "all-fail" ]; then
    echo "security: SecKeychainItemCreateFromContent: User interaction is not allowed." >&2
    exit 36
  fi
  printf '%s' "$hex" > "$state/mac-$acct"
  exit 0
fi
cmd="$1"; shift
acct=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-a" ]; then acct="$2"; fi
  shift
done
f="$state/mac-$acct"
case "$cmd" in
  find-generic-password)
    if [ "$mode" = "lookup-fail" ] || [ "$mode" = "all-fail" ]; then
      echo "security: SecKeychainSearchCopyNext: something broke" >&2
      exit 1
    fi
    if [ "$mode" = "lookup-corrupt" ]; then echo "zz-not-hex"; exit 0; fi
    if [ -f "$f" ]; then cat "$f"; echo; exit 0; fi
    echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
    exit 44
    ;;
  delete-generic-password)
    if [ -f "$f" ]; then rm -f "$f"; exit 0; fi
    exit 44
    ;;
esac
exit 2
`;

const SECRET_TOOL_SHIM = `#!/bin/bash
PATH=/usr/bin:/bin
state="$FAKE_KEYCHAIN"
mode="$FAKE_KEYCHAIN_MODE"
printf '%s\\n' "$*" >> "$state/argv.log"
cmd="$1"; shift
acct=""
prev=""
for a in "$@"; do
  if [ "$prev" = "account" ]; then acct="$a"; fi
  prev="$a"
done
f="$state/lin-$acct"
case "$cmd" in
  store)
    if [ "$mode" = "store-echo-stdin" ]; then
      cat >&2
      exit 1
    fi
    if [ "$mode" = "store-fail" ] || [ "$mode" = "all-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    cat > "$f"
    exit 0
    ;;
  lookup)
    if [ "$mode" = "lookup-fail" ] || [ "$mode" = "all-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    if [ "$mode" = "lookup-exit2-silent" ]; then exit 2; fi
    if [ "$mode" = "lookup-sigkill" ]; then kill -9 $$; fi
    if [ "$mode" = "lookup-corrupt" ]; then printf 'zz-not-hex'; exit 0; fi
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    exit 1
    ;;
  clear)
    if [ "$mode" = "clear-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    if [ "$mode" = "clear-silent-miss" ]; then
      exit 1
    fi
    rm -f "$f"
    exit 0
    ;;
esac
exit 2
`;

writeFileSync(join(shimDir, 'security'), SECURITY_SHIM);
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'security'), 0o755);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { FileStores } = await import('../src/stores.js');
const { runDoctor } = await import('../src/doctor.js');
const { IdentityKeyPair } = await import('@signalapp/libsignal-client');
type DoctorIo = import('../src/doctor.js').DoctorIo;
const {
  cmdCredential,
  credentialCheck,
  credentialStatus,
  deleteCredential,
  maybeMigrateCredential,
  migrateCredential,
  preferredBackend,
  readCredential,
} = await import('../src/keychain.js');
const { CliError, EXIT } = await import('../src/exit.js');
type Reporter = import('../src/output.js').Reporter;

/** A capturing stand-in for Reporter (whose private fields make the real
 * class nominal). cmdCredential only calls emit/note on it. */
function fakeReporter(): {
  rep: Reporter;
  emitted: Array<{ record: Record<string, unknown>; human: string }>;
} {
  const emitted: Array<{ record: Record<string, unknown>; human: string }> = [];
  const rep = {
    json: false,
    plain: true,
    emit(record: Record<string, unknown>, human: string) {
      emitted.push({ record, human });
    },
    line(record: Record<string, unknown>, human: string) {
      emitted.push({ record, human });
    },
    status() {},
    note() {},
  } as unknown as Reporter;
  return { rep, emitted };
}

/** Rule-4 canaries: a distinctive secret INSIDE the credential, and a name.
 * Any error message or doctor line that contains either is a leak.
 *
 * A REAL SERIALIZED KEYPAIR, not a marker string, an earlier revision. These
 * fixtures assert that `doctor` PASSES a healthy migrated account, and they
 * used to carry `identityKeyPair: 'SECRET-CANARY-77aQ'` — a value no
 * operational read would accept, because `getIdentityKey` deserializes the
 * base64 it finds. They passed only because doctor's predicate was WEAKER than
 * the loader's, which is the defect that round found: the fixture
 * was standing on the bug to prove the fix. The base64 of a generated keypair
 * is just as distinctive a canary — 44+ characters that appear nowhere else —
 * and it is now an identity the account could really use. */
const CANARY = Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64');
const BLOB = JSON.stringify({ identityKeyPair: CANARY, registrationId: 7 });
const BLOB_HEX = Buffer.from(BLOB, 'utf8').toString('hex');

/** A SECOND valid identity — what a same-named account in another
 * TACENDUM_HOME stores (gate rank 2's "two valid identities, silently
 * swapped": registrationId 222 vs BLOB's 7). */
const OTHER_CANARY = Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64');
const OTHER_BLOB = JSON.stringify({ identityKeyPair: OTHER_CANARY, registrationId: 222 });
const OTHER_HEX = Buffer.from(OTHER_BLOB, 'utf8').toString('hex');

let seq = 0;
/** A fresh registered-looking account: identity.json on disk, nothing else. */
function freshAccount(): string {
  const name = `kc-acct-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(join(clientDir(name), 'identity.json'), BLOB, { mode: 0o600 });
  return name;
}

const identityPath = (name: string): string => join(clientDir(name), 'identity.json');
const markerPath = (name: string): string => join(clientDir(name), 'credential-backend.json');
/** The item's account attribute: sha256(resolved home + "\n" + name) —
 * computed here INDEPENDENTLY of keychain.ts on purpose, so a drift in the
 * implementation's coordinate scheme fails these tests instead of being
 * silently followed. Reads TACENDUM_HOME at call time because the
 * two-homes tests switch it mid-test, exactly like the implementation. */
const acctAttr = (name: string): string =>
  createHash('sha256')
    .update(`${resolve(process.env.TACENDUM_HOME as string)}\n${name}`, 'utf8')
    .digest('hex');
const linItem = (name: string): string => join(fakeState, `lin-${acctAttr(name)}`);
const macItem = (name: string): string => join(fakeState, `mac-${acctAttr(name)}`);
/** The pre-scoping coordinates: the raw name WAS the account attribute, so
 * every home's same-named account landed on this one shim file. */
const legacyLinItem = (name: string): string => join(fakeState, `lin-${name}`);
const argvLog = (): string =>
  existsSync(join(fakeState, 'argv.log')) ? readFileSync(join(fakeState, 'argv.log'), 'utf8') : '';

function expectCliError(fn: () => unknown, exitCode: number): CliError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CliError);
  const err = caught as CliError;
  expect(err.exitCode).toBe(exitCode);
  // The standing repo constraint: exit 2 is Claude Code's hook-blocking code
  // and nothing in this CLI may ever produce it.
  expect(err.exitCode).not.toBe(2);
  // Rule 4: the credential and the (caller-supplied) account name never
  // appear in an error message.
  expect(err.message).not.toContain(CANARY);
  expect(err.message).not.toContain(BLOB_HEX);
  expect(err.message).not.toContain('kc-acct-');
  return err;
}

beforeEach(() => {
  process.env.FAKE_KEYCHAIN_MODE = '';
  delete process.env.TACENDUM_CREDENTIAL_STORE;
  rmSync(join(fakeState, 'argv.log'), { force: true });
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_KEYCHAIN;
  delete process.env.FAKE_KEYCHAIN_MODE;
  delete process.env.TACENDUM_CREDENTIAL_STORE;
});

describe('backend selection', () => {
  it('honours TACENDUM_CREDENTIAL_STORE and refuses unknown values', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'file';
    expect(preferredBackend()).toBe('file');
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
    expect(preferredBackend()).toBe('linux-libsecret');
    process.env.TACENDUM_CREDENTIAL_STORE = 'keychain-please';
    expectCliError(() => preferredBackend(), EXIT.USAGE);
  });

  it('the account attribute admits UPPERCASE — checkedName is case-insensitive', () => {
    // Pins the property the keychain.ts ITEM COORDINATES comment states:
    // the client-name class is [A-Za-z0-9_-] (the checkedName regex carries
    // /i), not lowercase-only — and the name enters the account-attribute
    // digest VERBATIM, so such a name round-trips intact.
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
    const name = `KC-Upper-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(join(clientDir(name), 'identity.json'), BLOB, { mode: 0o600 });
    expect(migrateCredential(name).action).toBe('migrated');
    expect(readCredential(name)).toBe(BLOB);
  });

  it('probes the platform tool when unset', () => {
    // The shim shadows the platform tool, so this is deterministic per-OS.
    const expected = process.platform === 'darwin' ? 'macos-keychain' : 'linux-libsecret';
    expect(preferredBackend()).toBe(expected);
  });
});

describe('migration (linux-libsecret driver)', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('mirrors into the keychain, verifies read-back, and RETAINS the file', () => {
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('migrated');
    expect(outcome.backend).toBe('linux-libsecret');
    expect(outcome.removedFile).toBe(false);
    // Non-destructive by default: the 0600 file still ships the account.
    expect(existsSync(identityPath(name))).toBe(true);
    expect(existsSync(markerPath(name))).toBe(true);
    // The keychain item holds the hex-encoded blob, byte-exact.
    expect(readFileSync(linItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('never puts the secret on a command line (argv is ps-visible)', () => {
    const name = freshAccount();
    migrateCredential(name);
    const argv = argvLog();
    expect(argv).toContain('store'); // the store DID go through the tool...
    expect(argv).not.toContain(BLOB_HEX); // ...but the secret rode stdin
    expect(argv).not.toContain(CANARY);
  });

  it('maybeMigrateCredential migrates once, then is a cheap no-op', () => {
    const name = freshAccount();
    const first = maybeMigrateCredential(name);
    expect(first?.action).toBe('migrated');
    expect(maybeMigrateCredential(name)).toBeNull();
  });

  it('falls back to the file on a headless box, with no flags, and records it', () => {
    process.env.FAKE_KEYCHAIN_MODE = 'store-fail';
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('kept-file');
    expect(outcome.backend).toBe('file');
    expect(existsSync(identityPath(name))).toBe(true);
    expect(readCredential(name)).toBe(BLOB);
    // Decided once: the auto path does not re-probe (and re-fail) every run.
    expect(maybeMigrateCredential(name)).toBeNull();
    // ...but the explicit command retries past a 'file' marker once the
    // keychain is back.
    process.env.FAKE_KEYCHAIN_MODE = '';
    expect(migrateCredential(name, { force: true }).action).toBe('migrated');
  });

  it('keeps the file when read-back does not match what was written', () => {
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-corrupt';
    const name = freshAccount();
    const outcome = migrateCredential(name, { removeFile: true });
    expect(outcome.action).toBe('kept-file');
    expect(outcome.removedFile).toBe(false);
    // The file survives even though removal was requested: removal is gated
    // on THIS call proving the keychain copy readable, and it was not.
    expect(existsSync(identityPath(name))).toBe(true);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('removes the file only after a verified read-back, and reads still work', () => {
    const name = freshAccount();
    const outcome = migrateCredential(name, { removeFile: true });
    expect(outcome.action).toBe('migrated');
    expect(outcome.removedFile).toBe(true);
    expect(existsSync(identityPath(name))).toBe(false);
    expect(readCredential(name)).toBe(BLOB);
  });
});

describe('read path: failed is not absent', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('a deleted keychain item falls back to a retained file silently', () => {
    const name = freshAccount();
    migrateCredential(name);
    unlinkSync(linItem(name)); // the user deleted the item in their keyring
    expect(readCredential(name)).toBe(BLOB);
  });

  it('item gone + file gone = AUTH (credential lost), never null', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(linItem(name));
    // null here would invite a re-register that mints a SECOND account.
    const err = expectCliError(() => readCredential(name), EXIT.AUTH);
    expect(err.message).toContain('restore');
  });

  it('keychain unreachable + file gone = transient ERROR, not AUTH, not null', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    const err = expectCliError(() => readCredential(name), EXIT.ERROR);
    expect(err.message).toContain('retry');
  });

  it('a lost marker self-heals: the keychain is probed before answering null', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(markerPath(name)); // e.g. a restore that skipped dotfiles
    expect(readCredential(name)).toBe(BLOB);
  });

  it('a fresh box answers null, even when the keychain probe itself fails', () => {
    expect(readCredential('kc-never-registered')).toBeNull();
    // Headless CI: tool present, no bus. Registration must not be blocked.
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    expect(readCredential('kc-never-registered')).toBeNull();
  });
});

describe('macos-keychain driver (security -i)', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'macos-keychain';
  });

  it('stores via stdin command mode and round-trips', () => {
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('migrated');
    expect(outcome.backend).toBe('macos-keychain');
    expect(readFileSync(macItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(readCredential(name)).toBe(BLOB);
    // The add command (secret included) arrived on stdin...
    const stdinLog = readFileSync(join(fakeState, 'stdin.log'), 'utf8');
    expect(stdinLog).toContain(`-w "${BLOB_HEX}"`);
    // ...and argv carried `-i` alone for the store, never the secret.
    expect(argvLog()).not.toContain(BLOB_HEX);
  });

  it('distinguishes exit 44 (absent -> AUTH) from other failures (-> ERROR)', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(macItem(name)); // shim now answers exit 44
    expectCliError(() => readCredential(name), EXIT.AUTH);

    const other = freshAccount();
    migrateCredential(other, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    expectCliError(() => readCredential(other), EXIT.ERROR);
  });
});

describe('file backend and misconfiguration', () => {
  it('TACENDUM_CREDENTIAL_STORE=file keeps everything in the 0600 file', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'file';
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('file-preferred');
    expect(existsSync(identityPath(name))).toBe(true);
    expect(existsSync(linItem(name))).toBe(false);
    expect(existsSync(macItem(name))).toBe(false);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('a bad env value fails the explicit command but never the auto path', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'not-a-backend';
    const name = freshAccount();
    expectCliError(() => migrateCredential(name), EXIT.USAGE);
    // The on-next-run hook precedes real commands (send, listen); a
    // misconfigured nicety must not take them down.
    expect(maybeMigrateCredential(name)).toBeNull();
    expect(readFileSync(identityPath(name), 'utf8')).toBe(BLOB);
  });
});

describe('deleteCredential', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('removes the item and the marker, never identity.json', () => {
    const name = freshAccount();
    migrateCredential(name);
    deleteCredential(name);
    expect(existsSync(linItem(name))).toBe(false);
    expect(existsSync(markerPath(name))).toBe(false);
    expect(existsSync(identityPath(name))).toBe(true); // not this function's to delete
  });

  it('distrusts a lost marker exactly as reads do: the orphaned item dies too', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(markerPath(name)); // the marker is lost; the keychain item is not
    deleteCredential(name);
    // Without the null-marker probe the item survives this call, and
    // readCredential's lost-marker self-heal then RESURRECTS a credential
    // the operator believed removed — undeletable-then-resurrectable.
    expect(existsSync(linItem(name))).toBe(false);
    expect(readCredential(name)).toBeNull();
  });

  it('the lost-marker probe is best-effort: a headless box still deletes', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(markerPath(name));
    process.env.FAKE_KEYCHAIN_MODE = 'clear-fail'; // no bus: clear fails loudly
    expect(() => deleteCredential(name)).not.toThrow();
  });

  it('silent-nonzero clear counts as already gone (the shared secret-tool heuristic)', () => {
    const name = freshAccount();
    migrateCredential(name);
    unlinkSync(linItem(name)); // the item is already gone from the keyring
    process.env.FAKE_KEYCHAIN_MODE = 'clear-silent-miss'; // clear exits 1, silently
    deleteCredential(name); // absent is the goal state of a delete — no error
    expect(existsSync(markerPath(name))).toBe(false);
  });

  it('a LOUD clear failure is a real failure: the item may still be present', () => {
    const name = freshAccount();
    migrateCredential(name);
    process.env.FAKE_KEYCHAIN_MODE = 'clear-fail';
    const err = expectCliError(() => deleteCredential(name), EXIT.ERROR);
    expect(err.message).toContain('retry');
    // The marker survives so the retry still knows where the item lives.
    expect(existsSync(markerPath(name))).toBe(true);
  });
});

describe('observability (doctor line + status)', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('reports the file backend before any migration', () => {
    const name = freshAccount();
    const status = credentialStatus(name);
    expect(status).toEqual({ backend: 'file', recorded: false, fileRetained: true });
    const check = credentialCheck(name);
    expect(check.check).toBe('credential');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('file');
  });

  it('reports the recorded keychain backend after migration', () => {
    const name = freshAccount();
    migrateCredential(name);
    expect(credentialStatus(name)).toEqual({
      backend: 'linux-libsecret',
      recorded: true,
      fileRetained: true,
    });
    const check = credentialCheck(name);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('linux-libsecret');
  });

  it('FAILs with a remedy when the recorded backend has lost the item', () => {
    const name = freshAccount();
    migrateCredential(name);
    unlinkSync(linItem(name));
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.remedy).toContain('--migrate'); // file retained -> recoverable
  });

  it('FAILs differently when the backend is unreachable, and echoes nothing', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('could not be read');
    for (const text of [check.detail, check.remedy ?? '']) {
      // The doctor rule: the caller-supplied name is never echoed, and the
      // credential obviously never is.
      expect(text).not.toContain('kc-acct-');
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(BLOB_HEX);
    }
  });

  it('a recorded file backend whose identity.json is gone says so — not "nothing recorded"', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'file';
    const name = freshAccount();
    migrateCredential(name); // records backend 'file'
    unlinkSync(identityPath(name));
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    // A marker DOES record a backend here; the doctor line must not claim
    // "no credential backend recorded" — a false line sends the operator
    // hunting the wrong failure (never-registered vs lost file).
    expect(check.detail).not.toContain('no credential backend recorded');
    expect(check.detail).toContain('recorded');
    expect(check.remedy).toContain('restore');
  });

  it('a fresh box (nothing recorded, no file) keeps the original wording', () => {
    const check = credentialCheck('kc-never-registered-doctor');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no credential backend recorded');
    expect(check.remedy).toContain('register');
  });

  it('doctor observes without repairing: no store, no marker rewrite', () => {
    const name = freshAccount(); // file era, no marker
    credentialCheck(name);
    expect(existsSync(markerPath(name))).toBe(false);
    expect(existsSync(linItem(name))).toBe(false);
  });
});

describe('F14: subprocess stderr never reaches an error or a detail string', () => {
  it('a secret-tool that echoes its stdin cannot leak the credential (gate repro)', () => {
    // The gate's shim: reads stdin (the credential hex), writes it to
    // stderr, exits 1. The old describeFailure forwarded 120 "sanitized"
    // characters of that stderr — i.e. the credential — into the outcome
    // detail that `credential --migrate` prints.
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
    process.env.FAKE_KEYCHAIN_MODE = 'store-echo-stdin';
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('kept-file'); // the fallback itself still works
    expect(outcome.detail).not.toContain(CANARY);
    expect(outcome.detail).not.toContain(BLOB_HEX.slice(0, 16));
    expect(outcome.detail).not.toContain(name);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('same for a security -i that echoes its stdin command line (macos)', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'macos-keychain';
    process.env.FAKE_KEYCHAIN_MODE = 'store-echo-stdin';
    const name = freshAccount();
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('kept-file');
    expect(outcome.detail).not.toContain(CANARY);
    expect(outcome.detail).not.toContain(BLOB_HEX.slice(0, 16));
    expect(outcome.detail).not.toContain(name);
  });

  it('a loud diagnostic surfaces only as a fixed classification, never its text', () => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
    const name = freshAccount();
    migrateCredential(name);
    process.env.FAKE_KEYCHAIN_MODE = 'clear-fail'; // stderr: "Cannot autolaunch D-Bus without X11"
    const err = expectCliError(() => deleteCredential(name), EXIT.ERROR);
    expect(err.message).not.toContain('autolaunch'); // raw stderr text may not travel
    expect(err.message).not.toContain('X11');
    expect(err.message).toContain('exited 1'); // the exit status may
    expect(err.message).toContain('no session bus'); // ...and the fixed classification
  });
});

describe('F11: an unclassifiable failure refuses rather than answering absent', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('a silent exit 2 from secret-tool is a FAILURE (ERROR), not absent (AUTH)', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-exit2-silent';
    const err = expectCliError(() => readCredential(name), EXIT.ERROR);
    expect(err.message).toContain('retry');
  });

  it('a signal-killed secret-tool is a FAILURE, not absent', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-sigkill';
    const err = expectCliError(() => readCredential(name), EXIT.ERROR);
    expect(err.message).toContain('retry');
  });

  it('the exact miss shape (exit 1, silent) still answers absent -> AUTH', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(linItem(name)); // shim: exit 1, nothing on stderr
    expectCliError(() => readCredential(name), EXIT.AUTH);
  });

  it('no marker, no file, but a PROFILE: a failed probe refuses instead of null', () => {
    // Profile evidence proves the account exists; null here is the
    // re-registration signal and would mint a second account.
    const name = `kc-prof-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(join(clientDir(name), 'profile.json'), '{}', { mode: 0o600 });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    const err = expectCliError(() => readCredential(name), EXIT.ERROR);
    expect(err.message).toContain('profile');
    expect(err.message).toContain('retry');
  });

  it('no marker, no file, profile present, keychain item undecodable -> AUTH', () => {
    const name = `kc-prof-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(join(clientDir(name), 'profile.json'), '{}', { mode: 0o600 });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-corrupt';
    const err = expectCliError(() => readCredential(name), EXIT.AUTH);
    expect(err.message).toContain('restore');
  });

  it('a fresh box (no profile) still answers null on the same failed probe', () => {
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    expect(readCredential('kc-fresh-no-profile')).toBeNull();
  });
});

describe('F10 honesty + credential status asserts existence', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('--migrate reports a migration whose reads follow the keychain, file retained', () => {
    const { rep, emitted } = fakeReporter();
    const name = freshAccount();
    cmdCredential(name, { migrate: true, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    // The wording matches what the code now does: FileIdentityKeyStore
    // routes exists()/load() through readCredential, so the keychain IS the
    // read path and the retained file is the fallback. (Until the stores
    // wiring landed this line was required to say "mirror" — reads had not
    // moved, and claiming they had would have invited a by-hand file delete.)
    expect(emitted[0].human).toContain('reads follow the keychain');
    expect(emitted[0].human).toContain('fallback');
    expect(existsSync(identityPath(name))).toBe(true);
  });

  it('--migrate --remove-file deletes the file after the verified read-back', () => {
    const { rep, emitted } = fakeReporter();
    const name = freshAccount();
    cmdCredential(name, { migrate: true, removeFile: true }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].record.removedFile).toBe(true);
    expect(existsSync(identityPath(name))).toBe(false);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('--remove-file still refuses when the read-back fails (removal gated in-call)', () => {
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-corrupt';
    const { rep, emitted } = fakeReporter();
    const name = freshAccount();
    cmdCredential(name, { migrate: true, removeFile: true }, rep);
    expect(emitted[0].record.removedFile).toBe(false);
    expect(existsSync(identityPath(name))).toBe(true);
  });

  it('--remove-file without --migrate is a usage error', () => {
    const { rep, emitted } = fakeReporter();
    const name = freshAccount();
    expectCliError(() => cmdCredential(name, { migrate: false, removeFile: true }, rep), EXIT.USAGE);
    expect(emitted).toHaveLength(0);
    expect(existsSync(identityPath(name))).toBe(true);
  });

  it('status on a never-registered name errors (USAGE), not ok:true', () => {
    const { rep, emitted } = fakeReporter();
    const err = expectCliError(
      () => cmdCredential('kc-status-never', { migrate: false, removeFile: false }, rep),
      EXIT.USAGE,
    );
    expect(emitted).toHaveLength(0);
    expect(err.message).toContain('register');
  });

  it('status still reports ok for an account with a credential', () => {
    const { rep, emitted } = fakeReporter();
    const name = freshAccount();
    cmdCredential(name, { migrate: false, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].record.ok).toBe(true);
  });

  it('status checks existence, not shape: lost marker + keychain item is still ok', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(markerPath(name));
    const { rep, emitted } = fakeReporter();
    cmdCredential(name, { migrate: false, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].record.ok).toBe(true);
  });

  it('status surfaces a lost credential as AUTH rather than an ok line', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    unlinkSync(linItem(name));
    const { rep, emitted } = fakeReporter();
    expectCliError(() => cmdCredential(name, { migrate: false, removeFile: false }, rep), EXIT.AUTH);
    expect(emitted).toHaveLength(0);
  });
});

describe('operational reads route through the keychain', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it('a file-era account adopts, on the exact byte path it always had (no subprocess)', () => {
    const name = freshAccount(); // identity.json on disk, no marker
    const stores = new FileStores(name);
    expect(stores.identity.exists()).toBe(true);
    // No marker + file present must stay one existsSync + one readFileSync:
    // the argv log records every shim invocation, and there must be none.
    expect(argvLog()).toBe('');
  });

  it('a keychain-only account still EXISTS and its identity still LOADS', async () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    expect(existsSync(identityPath(name))).toBe(false);
    const stores = new FileStores(name);
    // exists() is the gate that stops register/setup minting a SECOND
    // account over this one; false here would let a re-run orphan it.
    expect(stores.identity.exists()).toBe(true);
    // ...and the operational read path answers from the keychain: this is
    // the load() wiring (getLocalRegistrationId goes through load()).
    await expect(stores.identity.getLocalRegistrationId()).resolves.toBe(7);
  });

  it('an account with no file and no credential is genuinely absent', () => {
    const name = `kc-none-${seq++}`; // never registered, nothing anywhere
    const stores = new FileStores(name);
    expect(stores.identity.exists()).toBe(false);
  });

  it('an unreachable keychain makes exists() REFUSE, never answer false', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    const stores = new FileStores(name);
    // false here is the answer that re-registers; readCredential's refusal
    // (transient -> ERROR) must propagate out of exists() untouched.
    expectCliError(() => stores.identity.exists(), EXIT.ERROR);
  });

  it('initialize() refuses to mint over a keychain-only credential', () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    const stores = new FileStores(name);
    expect(() => stores.identity.initialize(IdentityKeyPair.generate(), 123)).toThrow(
      /already exists/,
    );
    // Nothing was written: a fresh identity.json beside the keychain item
    // would be a forked credential.
    expect(existsSync(identityPath(name))).toBe(false);
  });
});

describe('doctor on a migrated account', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  /** Network probes stubbed dead-fast: only the identity/credential lines are
   * under test here; doctor.test.ts owns the rest. */
  const deadIo: DoctorIo = {
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as typeof fetch,
    dialWs: async () => {
      throw new CliError(EXIT.NETWORK, 'offline');
    },
    now: () => Date.now(),
  };

  it('identity PASSES for a keychain-held key with no identity.json', async () => {
    const name = freshAccount();
    migrateCredential(name, { removeFile: true });
    const results = await runDoctor(name, deadIo);
    const identity = results.find((r) => r.check === 'identity');
    // Before the wiring this was a false FAIL telling the operator to
    // "restore from backup" a file that is gone on purpose.
    expect(identity?.ok).toBe(true);
    expect(identity?.detail).toContain('keychain');
    expect(results.find((r) => r.check === 'credential')?.ok).toBe(true);
  });

  it('doctor never repairs: no marker is written, no item stored', async () => {
    const name = freshAccount(); // file era: migration would be possible
    await runDoctor(name, deadIo);
    expect(existsSync(markerPath(name))).toBe(false);
    expect(existsSync(linItem(name))).toBe(false);
  });
});

describe('gate rank 2: item coordinates are (home, account), never (account)', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  it("two homes, one account name: each keeps its OWN credential (the gate's executed repro)", async () => {
    const name = `kc-twohomes-${seq++}`; // deliberately the SAME name in both homes
    // Home A: registered, migrated, file removed — keychain-only.
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), BLOB, { mode: 0o600 });
    expect(migrateCredential(name, { removeFile: true }).action).toBe('migrated');
    const homeB = mkdtempSync(join(tmpdir(), 'tacendum-keychain-homeB-'));
    try {
      // Home B: same account NAME, different identity, migrates too.
      process.env.TACENDUM_HOME = homeB;
      mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
      writeFileSync(join(clientDir(name), 'identity.json'), OTHER_BLOB, { mode: 0o600 });
      expect(migrateCredential(name, { removeFile: true }).action).toBe('migrated');
      expect(readCredential(name)).toBe(OTHER_BLOB);
      // Home A still reads ITS OWN credential. Under the shared coordinates
      // this returned OTHER_BLOB — B's `-U` store overwrote the one
      // (service, name) item in place, and the gate's repro then saw
      // getLocalRegistrationId() answer B's 222 for home A.
      process.env.TACENDUM_HOME = home;
      expect(readCredential(name)).toBe(BLOB);
      const stores = new FileStores(name);
      await expect(stores.identity.getLocalRegistrationId()).resolves.toBe(7);
    } finally {
      process.env.TACENDUM_HOME = home;
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('the caller-supplied name rides neither argv nor the security stdin line', () => {
    // The digest coordinate is what makes this possible: the old scheme put
    // the raw name in `secret-tool` argv (lookup, store, --label) and in the
    // `security -i` stdin command, defended only by checkedName's charset.
    process.env.TACENDUM_CREDENTIAL_STORE = 'macos-keychain';
    const name = freshAccount();
    migrateCredential(name); // store + verified read-back
    expect(readCredential(name)).toBe(BLOB);
    expect(argvLog()).not.toContain(name);
    const stdinLog = readFileSync(join(fakeState, 'stdin.log'), 'utf8');
    expect(stdinLog).not.toContain(name);

    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
    const other = freshAccount();
    migrateCredential(other);
    expect(readCredential(other)).toBe(BLOB);
    expect(argvLog()).not.toContain(other); // includes the store's --label
  });
});

describe('legacy coordinate transition: nobody strands, nobody adopts a stranger', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  /** A pre-scoping migrated account, as the upgrade finds it: v1 marker (no
   * `scope` field), item at the legacy coordinates (account = raw name),
   * identity.json per opts. */
  function legacyAccount(opts: { file: boolean }): string {
    const name = `kc-legacy-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    if (opts.file) writeFileSync(identityPath(name), BLOB, { mode: 0o600 });
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret' }), {
      mode: 0o600,
    });
    writeFileSync(legacyLinItem(name), BLOB_HEX);
    return name;
  }

  it('a file-removed pre-scoping account still READS on upgrade day, then re-homes', () => {
    const name = legacyAccount({ file: false });
    // Before any migration hook runs: the scoped coordinates are empty, and
    // without the legacy fallback this account would wake up EXIT.AUTH
    // ("restore from backup") the moment the CLI updated.
    expect(readCredential(name)).toBe(BLOB);
    // The hook re-homes it: scoped item stored and verified, marker
    // upgraded, and the legacy item LEFT IN PLACE (it may be the only
    // remaining copy for a same-named account in another home).
    const outcome = maybeMigrateCredential(name);
    expect(outcome?.action).toBe('migrated');
    expect(readFileSync(linItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(readFileSync(legacyLinItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { scope?: string }).scope,
    ).toBe('home');
    expect(readCredential(name)).toBe(BLOB);
    expect(maybeMigrateCredential(name)).toBeNull(); // cheap again
  });

  it('a file-retained pre-scoping account re-homes FROM THE FILE, never the shared item', () => {
    const name = legacyAccount({ file: true });
    // The gate's two-identity state: a same-named account in another home
    // overwrote the shared item; this home's file still holds ITS identity.
    writeFileSync(legacyLinItem(name), OTHER_HEX);
    // Reads prefer the file over the legacy fallback — identity NOT swapped.
    expect(readCredential(name)).toBe(BLOB);
    expect(maybeMigrateCredential(name)?.action).toBe('migrated');
    // Re-homed from the provably-own copy; the foreign item is untouched.
    expect(readFileSync(linItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(readFileSync(legacyLinItem(name), 'utf8')).toBe(OTHER_HEX);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('a failed re-home keeps the pre-scoping marker — never a file marker with no file', () => {
    const name = legacyAccount({ file: false });
    process.env.FAKE_KEYCHAIN_MODE = 'store-fail';
    expect(maybeMigrateCredential(name)).toBeNull();
    // Recording 'file' here (the file-flow fallback) would make
    // readCredential answer null — the word that re-registers. The
    // pre-scoping marker must survive so the legacy fallback keeps serving.
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { scope?: string }).scope,
    ).toBeUndefined();
    expect(readCredential(name)).toBe(BLOB);
    // ...and the next run, keychain back, completes the move.
    process.env.FAKE_KEYCHAIN_MODE = '';
    expect(maybeMigrateCredential(name)?.action).toBe('migrated');
    expect(readCredential(name)).toBe(BLOB);
  });

  it('a FOREIGN legacy item neither blocks nor seeds a fresh registration', () => {
    // Fresh box for this name: no dir, no marker, no profile — but another
    // home's same-named item sits at the shared coordinates. Adopting it
    // would hijack that identity AND block registration here.
    const name = `kc-foreign-${seq++}`;
    writeFileSync(legacyLinItem(name), OTHER_HEX);
    expect(readCredential(name)).toBeNull(); // registration may proceed
    expect(maybeMigrateCredential(name)).toBeNull();
    expect(readFileSync(legacyLinItem(name), 'utf8')).toBe(OTHER_HEX); // untouched
  });

  it('lost marker + profile + legacy-only item: reads self-heal, not "unregistered"', () => {
    // A pre-scoping migrated account whose marker a dotfile-skipping restore
    // dropped. The profile gates the legacy probe (contrast the foreign-item
    // test above, where no profile means no claim).
    const name = `kc-legacylost-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(join(clientDir(name), 'profile.json'), '{}', { mode: 0o600 });
    writeFileSync(legacyLinItem(name), BLOB_HEX);
    expect(readCredential(name)).toBe(BLOB);
  });

  it('delete removes the legacy item ONLY on byte-equal proof it is this home\'s', () => {
    // Ours: re-homed, legacy content identical -> proven ours -> removed.
    const ours = legacyAccount({ file: false });
    expect(maybeMigrateCredential(ours)?.action).toBe('migrated');
    deleteCredential(ours);
    expect(existsSync(linItem(ours))).toBe(false);
    expect(existsSync(legacyLinItem(ours))).toBe(false);
    expect(existsSync(markerPath(ours))).toBe(false);

    // A stranger's: content differs -> possibly another home's ONLY copy ->
    // left in place. (A stale keyring entry is recoverable by hand; a
    // deleted credential is not.)
    const shared = legacyAccount({ file: true });
    writeFileSync(legacyLinItem(shared), OTHER_HEX);
    expect(maybeMigrateCredential(shared)?.action).toBe('migrated'); // from the file
    deleteCredential(shared);
    expect(existsSync(linItem(shared))).toBe(false);
    expect(readFileSync(legacyLinItem(shared), 'utf8')).toBe(OTHER_HEX);
  });
});

describe('doctor: two identities under one name (gate rank 2, doctor finding)', () => {
  beforeEach(() => {
    process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
  });

  const deadIo: DoctorIo = {
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as typeof fetch,
    dialWs: async () => {
      throw new CliError(EXIT.NETWORK, 'offline');
    },
    now: () => Date.now(),
  };

  it('credential FAILs loudly when the keychain item and the retained file disagree', () => {
    const name = freshAccount();
    migrateCredential(name); // file retained, item stored, marker home-scoped
    writeFileSync(linItem(name), OTHER_HEX); // the item now holds a DIFFERENT identity
    // Commands answer from the item — the check must say so, not vouch for
    // whichever copy it happened to read.
    expect(readCredential(name)).toBe(OTHER_BLOB);
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('DIFFERENT');
    expect(check.detail).toContain('keychain item');
    for (const text of [check.detail, check.remedy ?? '']) {
      expect(text).not.toContain('kc-acct-');
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(OTHER_CANARY);
      expect(text).not.toContain(BLOB_HEX);
      expect(text).not.toContain(OTHER_HEX);
    }
  });

  it('doctor validates the copy commands USE, not whichever file happens to exist', async () => {
    const name = freshAccount();
    migrateCredential(name);
    // The retained file rots. Every command still works — reads answer from
    // the keychain item — and doctor reading identity.json directly would
    // FAIL an account that is healthy (and PASS one that is broken: the
    // mirror image is the gate's exact finding).
    writeFileSync(identityPath(name), 'not an identity at all', { mode: 0o600 });
    const results = await runDoctor(name, deadIo);
    const identity = results.find((r) => r.check === 'identity');
    expect(identity?.ok).toBe(true);
    // The file-vs-item divergence is the credential line's finding:
    const credential = results.find((r) => r.check === 'credential');
    expect(credential?.ok).toBe(false);
    expect(credential?.detail).toContain('DIFFERENT');
  });

  it('the transitional pre-scoping disagreement says where reads actually go: the file', () => {
    // v1 marker + retained file + foreign bytes at the shared coordinates —
    // the gate's repro frozen at the moment before the migration hook runs.
    const name = `kc-doclegacy-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), BLOB, { mode: 0o600 });
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret' }), {
      mode: 0o600,
    });
    writeFileSync(legacyLinItem(name), OTHER_HEX);
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('Commands use the file');
    // Doctor observes: no re-home happened, no marker rewrite.
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { scope?: string }).scope,
    ).toBeUndefined();
    expect(existsSync(linItem(name))).toBe(false);
  });

  it('a matching pre-scoping item is a PASS that names the transitional state', () => {
    const name = `kc-doctrans-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret' }), {
      mode: 0o600,
    });
    writeFileSync(legacyLinItem(name), BLOB_HEX);
    const check = credentialCheck(name);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('pre-home-scoped');
  });
});

describe('main.ts wiring: the once-per-command hook (real child process)', () => {
  // main() runs at module load, so the hook can only be observed from
  // outside — the same pattern as gate.main-mcp.test.ts. `whoami` is the
  // cheapest account-bearing command: no network, exit 0.
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
        cwd: repoRoot,
        env: {
          ...process.env, // carries the shim PATH, FAKE_KEYCHAIN, TACENDUM_HOME
          TACENDUM_CREDENTIAL_STORE: 'linux-libsecret',
          FAKE_KEYCHAIN_MODE: '',
          NODE_USE_SYSTEM_CA: '0',
        },
      });
      child.stdin.end();
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  it('an account-bearing command migrates once, then never again', async () => {
    const name = freshAccount();
    writeFileSync(
      join(clientDir(name), 'profile.json'),
      JSON.stringify({
        name,
        identityKey: 'pk',
        userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        authToken: 'tok',
        registrationId: 7,
        deviceId: 1,
      }),
      { mode: 0o600 },
    );
    const first = await runCli(['whoami', name]);
    expect(first.code, `stderr was:\n${first.stderr}`).toBe(0);
    // The hook ran: marker recorded, item stored, transition noted (the note
    // carries keychain.ts's fixed prose — never the name or the credential).
    expect(existsSync(markerPath(name))).toBe(true);
    expect(readFileSync(linItem(name), 'utf8')).toBe(BLOB_HEX);
    expect(first.stderr).toContain('credential:');
    expect(first.stderr).not.toContain(BLOB_HEX);
    // Decided once: the second run reads the marker and says nothing.
    const second = await runCli(['whoami', name]);
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain('credential:');
  }, 60_000);
});
