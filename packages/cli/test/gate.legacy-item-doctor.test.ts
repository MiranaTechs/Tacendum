import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE LEGACY-COORDINATE BRANCH OF `credentialCheck`.
 *
 * An earlier revision's `probeUnrecorded` has TWO keychain-answering outcomes —
 * `scoped-item` and `legacy-item` — and an earlier revision's doctor fix landed for one:
 *
 *  - CASE 1: an account migrated to the keychain BEFORE item coordinates
 *    were home-scoped (item at `account=<name>`), whose identity.json
 *    `--migrate --remove-file` deleted, whose marker a later disk restore
 *    skipped. `readCredential` RETURNS THE CREDENTIAL (the legacy
 *    extension), `credentialStatus` names the keychain — and `credentialCheck`
 *    entered the marker arm with a NULL marker, skipped the legacy branch
 *    (gated `marker !== null`), and FAILed the healthy account with "the
 *    keychain has no usable item" and the remedy `gate.lost-marker.test.ts`
 *    itself names as harmful ("restore identity.json from backup"). The
 *    repair the FAIL never named — `credential --migrate` → re-home,
 *    marker re-recorded — works.
 *
 *  - CASE 2: with a PRE-SCOPING marker and no retained file, the legacy
 *    branch acted only on `legacy.kind === 'found'`. A FAILED legacy lookup —
 *    the keychain COULD NOT BE READ — fell through into the absent diagnosis:
 *    doctor prescribed "restore from backup; the key ... cannot be re-minted"
 *    for a keychain that was merely locked, directly under an identity line
 *    that DELEGATED cause-naming to it (an earlier revision gave doctor's three identity
 *    arms their own prose, so nothing delegates now — which leaves the remedy
 *    below as the report's ONLY advice for this state, and no less wrong).
 *    `readCredential` in the identical
 *    state refuses with EXIT.ERROR ("retry once the keychain is reachable").
 *    FAILED IS NOT ABSENT is the module header's capitalised doctrine, and
 *    `rehomeLegacyItem` applies it two functions away.
 *
 * Written RED against the earlier tree, controls alongside.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-legacyitem-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-legacyitem-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-legacyitem-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

/**
 * '' = bus up; 'all-fail' = every lookup/store fails as a headless box's do;
 * 'legacy-fail' = ONLY the legacy coordinate (account = raw name, not the
 * 64-hex home-scoped digest) fails its read — an earlier finding's trigger: a denied
 * item ACL / partially locked keyring answers the empty scoped coordinate
 * "absent" and refuses the populated legacy one.
 */
const SECRET_TOOL_SHIM = `#!/bin/bash
PATH=/usr/bin:/bin
state="$FAKE_KEYCHAIN"
mode="$FAKE_KEYCHAIN_MODE"
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
    if [ "$mode" = "all-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    cat > "$f"
    exit 0
    ;;
  lookup)
    if [ "$mode" = "all-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    if [ "$mode" = "legacy-fail" ] && [ "\${#acct}" -ne 64 ]; then
      echo "secret-tool: the item is locked and the prompt was dismissed" >&2
      exit 1
    fi
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    exit 1
    ;;
  clear)
    rm -f "$f"
    exit 0
    ;;
esac
exit 2
`;
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { cmdCredential, credentialCheck, credentialStatus, readCredential } = await import(
  '../src/keychain.js'
);
const { runDoctor } = await import('../src/doctor.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { IdentityKeyPair } = await import('@signalapp/libsignal-client');
type DoctorIo = import('../src/doctor.js').DoctorIo;
type Reporter = import('../src/output.js').Reporter;

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_KEYCHAIN;
  delete process.env.FAKE_KEYCHAIN_MODE;
  delete process.env.TACENDUM_CREDENTIAL_STORE;
  rmSync(home, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  rmSync(fakeState, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.FAKE_KEYCHAIN_MODE = '';
});

const REAL = JSON.stringify({
  identityKeyPair: Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64'),
  registrationId: 7,
});
const REAL_HEX = Buffer.from(REAL, 'utf8').toString('hex');

let seq = 0;
const identityPath = (name: string): string => join(clientDir(name), 'identity.json');
const markerPath = (name: string): string => join(clientDir(name), 'credential-backend.json');
const profilePath = (name: string): string => join(clientDir(name), 'profile.json');
/** The shared, pre-scoping keychain coordinate in the shim's fake state. */
const legacyItemPath = (name: string): string => join(fakeState, `lin-${name}`);

/**
 * The real history, fabricated byte-for-byte: a pre-scoping migration left the
 * item at `account = <name>` (`--remove-file` shipped before home-scoped
 * `itemAccount` did), identity.json is gone, and the
 * marker either survived pre-scoping (`{"backend":...}`, no `scope`) or was
 * lost to a disk restore that skipped dotfiles.
 */
function legacyAccount(opts: { marker: 'pre-scoping' | 'lost'; keepFile?: boolean }): string {
  const name = `li-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(
    profilePath(name),
    JSON.stringify({
      name,
      identityKey: 'IDKEYMARKERBASE64==',
      userId: '01LEGACYITEM00000000000000',
      authToken: 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rNxxxxx',
      registrationId: 7,
      deviceId: 1,
    }),
    { mode: 0o600 },
  );
  writeFileSync(legacyItemPath(name), REAL_HEX);
  if (opts.marker === 'pre-scoping') {
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret' }), {
      mode: 0o600,
    });
  }
  if (opts.keepFile) writeFileSync(identityPath(name), REAL, { mode: 0o600 });
  return name;
}

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

const deadIo: DoctorIo = {
  fetchImpl: (async () => {
    throw new Error('offline');
  }) as typeof fetch,
  dialWs: async () => {
    throw new CliError(EXIT.NETWORK, 'offline');
  },
  now: () => Date.now(),
};

describe('CASE 1 — a lost marker over a LEGACY item is the scoped twin, not a dead account', () => {
  it('premise: reads answer the credential, and status names the keychain', () => {
    const name = legacyAccount({ marker: 'lost' });
    expect(readCredential(name)).toBe(REAL);
    expect(credentialStatus(name)).toEqual({
      backend: 'linux-libsecret',
      recorded: false,
      fileRetained: false,
    });
  });

  it('doctor PASSes the working account with the probed wording and names the explicit repair', () => {
    const name = legacyAccount({ marker: 'lost' });
    const check = credentialCheck(name);
    // The gate's repro: ok:false, "the keychain has no usable item", remedy
    // "restore identity.json from backup; the key IS the account and cannot
    // be re-minted" — a FAIL about a machine whose reads answer fine, whose
    // remedy is the read-path switch, and whose "cannot be re-minted" is
    // false (the migrate re-homes and goes green).
    expect(check.ok, 'doctor FAILed a healthy account (the legacy twin of the scoped fix)').toBe(
      true,
    );
    expect(check.detail).toContain('linux-libsecret');
    expect(check.detail, 'the lost marker must be said out loud, not claimed recorded').toMatch(
      /probed/,
    );
    // The explicit command is the ONLY repair here: `maybeMigrateCredential`
    // returns null with a null marker and no file, so no ordinary command
    // re-homes this on its own.
    expect(check.detail).toMatch(/--migrate/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/no usable item/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/cannot be re-minted/);
  });

  it('the whole doctor surface agrees: identity PASSes and credential PASSes', async () => {
    const name = legacyAccount({ marker: 'lost' });
    const results = await runDoctor(name, deadIo);
    expect(results.find(r => r.check === 'identity')?.ok).toBe(true);
    expect(results.find(r => r.check === 'credential')?.ok).toBe(true);
  });

  it('the repair the FAIL never named works: --migrate re-homes and re-records', () => {
    const name = legacyAccount({ marker: 'lost' });
    const { rep, emitted } = fakeReporter();
    cmdCredential(name, { migrate: true, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.record.ok).toBe(true);
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { backend?: string; scope?: string })
        .scope,
    ).toBe('home');
    // The item is at the home-scoped coordinates now: remove the legacy copy
    // and reads must still answer.
    unlinkSync(legacyItemPath(name));
    expect(readCredential(name)).toBe(REAL);
    expect(credentialCheck(name).ok).toBe(true);
  });
});

describe('CASE 2 — a FAILED legacy read is never diagnosed as absence', () => {
  it('premise: readCredential refuses (EXIT.ERROR, keychain unreachable) in this state', () => {
    const name = legacyAccount({ marker: 'pre-scoping' });
    process.env.FAKE_KEYCHAIN_MODE = 'legacy-fail';
    let caught: unknown;
    try {
      readCredential(name);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.ERROR);
    expect((caught as CliError).message).toMatch(/could not be read/);
  });

  it('doctor names the unreadable keychain, not a lost credential', () => {
    const name = legacyAccount({ marker: 'pre-scoping' });
    process.env.FAKE_KEYCHAIN_MODE = 'legacy-fail';
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    // The gate's repro printed "the keychain has no usable item" with
    // "restore identity.json from backup; the key IS the account and cannot
    // be re-minted" — the account-ending remedy for a locked keychain, on
    // the very line the identity FAIL above it delegated cause-naming to.
    // (An earlier revision ended that delegation — doctor's identity arms name their own
    // cause now — which makes this line's remedy the only one the report
    // offers here, so the assertions below matter more, not less.)
    expect(check.detail, 'a failed read was reported as absence').toMatch(/could not be read/);
    expect(check.remedy ?? '').toMatch(/unlock the keychain|session bus/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/no usable item/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/cannot be re-minted/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/restore identity\.json/);
  });

  it('with the fallback file retained, the same failure keeps the calmer remedy', () => {
    const name = legacyAccount({ marker: 'pre-scoping', keepFile: true });
    process.env.FAKE_KEYCHAIN_MODE = 'legacy-fail';
    // Reads answer from the retained file in this state (readCredential doc
    // step 2), so the line must not panic — and must still not call the
    // failure an absence.
    expect(readCredential(name)).toBe(REAL);
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/could not be read/);
    expect(check.remedy ?? '').toMatch(/fallback file/);
    expect(`${check.detail} ${check.remedy ?? ''}`).not.toMatch(/cannot be re-minted/);
  });

  it('CONTROL (the reviewer’s): with BOTH coordinates unreadable the check already says so', () => {
    const name = legacyAccount({ marker: 'pre-scoping' });
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/could not be read/);
    expect(check.remedy ?? '').toMatch(/unlock the keychain|session bus/);
  });

  it('CONTROL: a healthy legacy item behind a pre-scoping marker still PASSes', () => {
    const name = legacyAccount({ marker: 'pre-scoping' });
    const check = credentialCheck(name);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/pre-home-scoped/);
    expect(check.detail).toContain('(recorded)');
  });

  it('rule-c sweep: the FILE arm’s comparison probe does not vouch past a failed read either', () => {
    // The earlier both-exist comparison probes the keychain beside a
    // retained file. A FAILED probe is not an absent item: the generic line
    // recommended the migrate that force-stores over whatever the failed
    // probe hid, with the mismatch warning never having had its chance to
    // run. Reads answer from the file, so the check stays green — it just
    // stops vouching for a comparison that never ran.
    const name = `li-file-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), REAL, { mode: 0o600 });
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const check = credentialCheck(name);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/could not be probed/);
    expect(check.detail).toMatch(/was not checked/);
    expect(check.detail).not.toMatch(/moves it \(the file stays as a fallback\)/);
  });
});
