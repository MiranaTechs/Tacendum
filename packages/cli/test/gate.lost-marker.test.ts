import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { join } from 'node:path';

/**
 * THE OBSERVABILITY PAIR MUST DISTRUST A LOST MARKER.
 *
 * `readCredential` doc step 4 and `deleteCredential` both explicitly distrust
 * a null marker: with no marker and no file, the preferred keychain is probed
 * before "unregistered" is ever answered, because a lost marker (a disk
 * restore that skipped dotfiles, a corrupt write) must not make a
 * keychain-held credential read as absent. `credentialStatus` and
 * `credentialCheck` were the third face of that mirror and got neither: after
 * `--migrate --remove-file` plus a lost marker, `credential` declared
 * `backend:"file"` on a box with NO file — right after `readCredential`
 * answered from the keychain — while `doctor` printed
 * `FAIL credential — no credential backend recorded and no identity.json on
 * disk` at exit 1 about the same healthy machine. And the FAIL's remedy was
 * worse than useless: with no marker `readCredential` prefers the FILE over
 * the probe, so "restore identity.json from backup" with a backup from
 * another home silently switches the account's read path.
 *
 * No shipped command repaired the state either (`maybeMigrateCredential`
 * returns null with a null marker and no file); `credential --migrate` is now
 * that repair, and both reporting surfaces name it.
 *
 * Written RED against the pre-fix tree.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-lostmarker-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-lostmarker-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-lostmarker-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

/** '' = bus up; 'all-fail' = store and lookup both fail as a headless box's
 * do (same contract as gate.kept-file-downgrade.test.ts's shim). */
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
const {
  cmdCredential,
  credentialCheck,
  credentialStatus,
  migrateCredential,
  readCredential,
} = await import('../src/keychain.js');
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

let seq = 0;
const identityPath = (name: string): string => join(clientDir(name), 'identity.json');
const markerPath = (name: string): string => join(clientDir(name), 'credential-backend.json');
const profilePath = (name: string): string => join(clientDir(name), 'profile.json');

/** The gate's executed repro: migrate --remove-file, then the marker is lost. */
function lostMarkerAccount(): string {
  const name = `lm-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(identityPath(name), REAL, { mode: 0o600 });
  writeFileSync(
    profilePath(name),
    JSON.stringify({
      name,
      identityKey: 'IDKEYMARKERBASE64==',
      userId: '01LOSTMARKER00000000000000',
      authToken: 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rNxxxxx',
      registrationId: 7,
      deviceId: 1,
    }),
    { mode: 0o600 },
  );
  const outcome = migrateCredential(name, { removeFile: true });
  expect(outcome.action).toBe('migrated');
  expect(existsSync(identityPath(name))).toBe(false);
  unlinkSync(markerPath(name)); // the marker is lost
  // Premise: reads already self-heal through the step-4 probe.
  expect(readCredential(name)).toBe(REAL);
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

describe('credentialStatus reports where reads ACTUALLY go past a lost marker', () => {
  it('backend names the keychain, not a file that does not exist', () => {
    const name = lostMarkerAccount();
    expect(credentialStatus(name)).toEqual({
      backend: 'linux-libsecret',
      recorded: false,
      fileRetained: false,
    });
  });

  it('the credential command answers the same, at exit 0', () => {
    const name = lostMarkerAccount();
    const { rep, emitted } = fakeReporter();
    cmdCredential(name, { migrate: false, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.record).toMatchObject({
      ok: true,
      backend: 'linux-libsecret',
      recorded: false,
    });
  });

  it('a fresh box still reads as file/unrecorded — the probe finds nothing', () => {
    const name = `lm-fresh-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    expect(credentialStatus(name)).toEqual({
      backend: 'file',
      recorded: false,
      fileRetained: false,
    });
  });
});

describe('doctor stops FAILing the healthy machine and stops prescribing the read-path switch', () => {
  it('the credential line passes, says the marker is missing, and names the shipped repair', () => {
    const name = lostMarkerAccount();
    const check = credentialCheck(name);
    expect(check.ok, 'doctor FAILed a machine whose reads answer fine').toBe(true);
    expect(check.detail).toContain('linux-libsecret');
    // The state is real and the repair is named — the marker probe is a
    // self-heal on every read, not a recorded decision.
    expect(check.detail).toMatch(/--migrate/);
    // The old line prescribed restoring identity.json — the exact act that
    // silently switches the read path to a foreign backup.
    expect(check.detail).not.toContain('no credential backend recorded');
  });

  it('the identity line uses the keychain phrasing, not the file arm’s', async () => {
    const name = lostMarkerAccount();
    const results = await runDoctor(name, deadIo);
    const identity = results.find(r => r.check === 'identity');
    expect(identity?.ok).toBe(true);
    expect(identity?.detail, 'identityBackend came from the same blind credentialStatus').toContain(
      'keychain',
    );
    const credential = results.find(r => r.check === 'credential');
    expect(credential, 'no credential line in the report at all').toBeDefined();
    expect(credential?.ok).toBe(true);
  });

  it('a lost marker with the keychain UNREACHABLE names the keychain, not "register"', () => {
    const name = lostMarkerAccount();
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    // Reads refuse in this state (a profile exists, the probe failed) rather
    // than inviting a re-register; the doctor line must point at the same
    // cause instead of "restore identity.json from backup; otherwise register".
    expect(() => readCredential(name)).toThrowError(CliError);
    const check = credentialCheck(name);
    expect(check.ok).toBe(false);
    expect(`${check.detail} ${check.remedy ?? ''}`).toMatch(/keychain|session bus/i);
    expect(check.remedy ?? '').not.toMatch(/tacendum register/);
  });
});

describe('credential --migrate is the shipped repair for the lost marker', () => {
  it('re-records the marker over a verified probe, and reads follow the keychain again', () => {
    const name = lostMarkerAccount();
    const { rep, emitted } = fakeReporter();
    cmdCredential(name, { migrate: true, removeFile: false }, rep);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.record.ok).toBe(true);
    // The marker is back and durable.
    expect(existsSync(markerPath(name))).toBe(true);
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { backend?: string }).backend,
    ).toBe('linux-libsecret');
    expect(credentialStatus(name)).toEqual({
      backend: 'linux-libsecret',
      recorded: true,
      fileRetained: false,
    });
    expect(readCredential(name)).toBe(REAL);
  });

  it('with the keychain UNREACHABLE the repair refuses (ERROR) instead of claiming no-credential', () => {
    const name = lostMarkerAccount();
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const { rep, emitted } = fakeReporter();
    let caught: unknown;
    try {
      cmdCredential(name, { migrate: true, removeFile: false }, rep);
    } catch (err) {
      caught = err;
    }
    expect(caught, '--migrate on a dead bus claimed the account was unregistered').toBeInstanceOf(
      CliError,
    );
    expect((caught as CliError).exitCode).toBe(EXIT.ERROR);
    // Not the register invitation: a profile exists, the account is real.
    expect((caught as CliError).message).not.toMatch(/register it first/);
    expect(emitted.filter(e => e.record.ok === true)).toEqual([]);
    // Rule 4: the account name never rides the refusal.
    expect((caught as CliError).message).not.toContain(name);
  });

  it('a genuinely fresh box still refuses --migrate as unregistered', () => {
    const name = `lm-fresh-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    const { rep } = fakeReporter();
    let caught: unknown;
    try {
      cmdCredential(name, { migrate: true, removeFile: false }, rep);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.USAGE);
    expect((caught as CliError).message).toMatch(/register/);
  });
});
