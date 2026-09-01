import { afterAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * DOCTOR MUST NOT DIE ON THE UNREADABLE CREDENTIAL IT EXISTS TO DIAGNOSE
 *.
 *
 * An earlier revision's both-exist comparison read identity.json with a bare
 * `toHex(readFileSync(...))` — and so did the PRE-EXISTING mirror arm one
 * screen down. `runDoctor` pushed `credentialCheck(name)` with no catch
 * (unlike the identity read right above it, which IS caught into a FAIL
 * line), so `doctor <name>` with an unreadable identity.json died with a raw
 * `EACCES: permission denied, open '<home>/<name>/identity.json'` — ZERO
 * checks printed, and the account segment plus the full home path printed
 * verbatim where every other doctor line masks through `shownPath`.
 *
 * Two shipped rules broke at once: "a check that cannot run must say why,
 * not kill the report", and keychain.ts's "the client name is never echoed".
 * `FileIdentityKeyStore.readCredentialGuarded` (stores.ts) exists precisely
 * to stop a raw fs error carrying that path; the probe reads bypassed it.
 *
 * BOTH arms are pinned here — guarding only the line an earlier revision added is this
 * phase's signature failure. Written RED against the bare reads.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-docunread-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-docunread-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-docunread-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

const SECRET_TOOL_SHIM = `#!/bin/bash
PATH=/usr/bin:/bin
state="$FAKE_KEYCHAIN"
cmd="$1"; shift
acct=""
prev=""
for a in "$@"; do
  if [ "$prev" = "account" ]; then acct="$a"; fi
  prev="$a"
done
f="$state/lin-$acct"
case "$cmd" in
  store) cat > "$f"; exit 0 ;;
  lookup) if [ -f "$f" ]; then cat "$f"; exit 0; fi; exit 1 ;;
  clear) rm -f "$f"; exit 0 ;;
esac
exit 2
`;
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { credentialCheck, migrateCredential } = await import('../src/keychain.js');
const { runDoctor } = await import('../src/doctor.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { IdentityKeyPair } = await import('@signalapp/libsignal-client');
type DoctorIo = import('../src/doctor.js').DoctorIo;

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_KEYCHAIN;
  delete process.env.TACENDUM_CREDENTIAL_STORE;
  // Unreadable files must be made removable again before rm -rf.
  for (const entry of ['docu-newarm', 'docu-mirrorarm', 'docu-doctor'] as const) {
    const p = join(home, entry, 'identity.json');
    try {
      if (existsSync(join(home, entry))) chmodSync(p, 0o600);
    } catch {
      /* already gone */
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  rmSync(fakeState, { recursive: true, force: true });
});

const REAL = JSON.stringify({
  identityKeyPair: Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64'),
  registrationId: 7,
});

const identityPath = (name: string): string => join(clientDir(name), 'identity.json');

const deadIo: DoctorIo = {
  fetchImpl: (async () => {
    throw new Error('offline');
  }) as typeof fetch,
  dialWs: async () => {
    throw new CliError(EXIT.NETWORK, 'offline');
  },
  now: () => Date.now(),
};

describe('credentialCheck survives an unreadable identity.json — both arms', () => {
  it('the NEW arm (backend file, item beside the file): a FAIL line, not a throw', () => {
    const name = 'docu-newarm';
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), REAL, { mode: 0o600 });
    // An item exists at the scoped coordinates (the earlier downgrade shape),
    // so the file arm's comparison probe finds it and reads the file.
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('migrated');
    // Force the marker back to 'file' — the downgrade state the new arm was
    // written for — then make the file unreadable.
    writeFileSync(
      join(clientDir(name), 'credential-backend.json'),
      JSON.stringify({ backend: 'file', scope: 'home' }),
      { mode: 0o600 },
    );
    chmodSync(identityPath(name), 0o000);
    try {
      let check: import('../src/doctor.js').CheckResult;
      try {
        check = credentialCheck(name);
      } catch (err) {
        throw new Error(
          `credentialCheck THREW over the unreadable file it exists to diagnose: ${String(
            (err as Error).name,
          )}`,
        );
      }
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/could not be read|unreadable/i);
      // The errno travels; the path and the name do not.
      expect(check.detail).toMatch(/EACCES/);
      for (const text of [check.detail, check.remedy ?? '']) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(home);
      }
    } finally {
      chmodSync(identityPath(name), 0o600);
    }
  });

  it('the PRE-EXISTING mirror arm (recorded keychain, retained file): a FAIL line, not a throw', () => {
    const name = 'docu-mirrorarm';
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), REAL, { mode: 0o600 });
    const outcome = migrateCredential(name); // marker records linux-libsecret; file retained
    expect(outcome.action).toBe('migrated');
    chmodSync(identityPath(name), 0o000);
    try {
      let check: import('../src/doctor.js').CheckResult;
      try {
        check = credentialCheck(name);
      } catch (err) {
        throw new Error(
          `the MIRROR arm threw over the unreadable retained file: ${String((err as Error).name)}`,
        );
      }
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/EACCES/);
      for (const text of [check.detail, check.remedy ?? '']) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(home);
      }
    } finally {
      chmodSync(identityPath(name), 0o600);
    }
  });
});

describe('doctor’s report survives, masked, with every other check still present', () => {
  it('doctor on the gate’s exact repro prints the checks and masks the path', async () => {
    const name = 'docu-doctor';
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), REAL, { mode: 0o600 });
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('migrated');
    chmodSync(identityPath(name), 0o000);
    try {
      let results: import('../src/doctor.js').CheckResult[];
      try {
        results = await runDoctor(name, deadIo);
      } catch (err) {
        throw new Error(
          `doctor DIED on the unreadable credential it exists to diagnose: ${String(
            (err as Error).name,
          )}`,
        );
      }
      // The report survived: the credential line is a FAIL that says why, and
      // the checks around it still ran.
      const credential = results.find(r => r.check === 'credential');
      expect(credential?.ok).toBe(false);
      for (const check of ['home', 'identity', 'credential', 'api']) {
        expect(
          results.some(r => r.check === check),
          `check '${check}' vanished from the report`,
        ).toBe(true);
      }
      // The doctor rule: no line carries the account segment (`shownPath`
      // masks it; the bare home path is deliberately printable).
      for (const r of results) {
        expect(`${r.detail} ${r.remedy ?? ''}`).not.toContain(name);
      }
    } finally {
      chmodSync(identityPath(name), 0o600);
    }
  });
});
