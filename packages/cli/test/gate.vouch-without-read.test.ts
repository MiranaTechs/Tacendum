import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GROUP-CALL REMEDIATION: NO LINE VOUCHES FOR A READ IT
 * NEVER MADE, AND NO LINE PROMISES THAT ANOTHER LINE WILL.
 *
 * An earlier finding (keychain.ts): the file arm's `probe.kind === 'failed'` branch
 * answered ok:true with "backend: file (0600 identity.json); reads answer
 * from it, …" WITHOUT opening identity.json — in a state where, with the file
 * present but unreadable, `readCredential` REFUSES with EXIT.ERROR. The
 * guarded read already existed as this arm's twins: the 'found' branch above
 * it and the marker arm below both route through `credentialFileGuarded`.
 * Rule-c sweep: the generic PASS the file arm falls through to makes the same
 * unread claims ("(0600 identity.json)", reads answering) and is the very
 * line the ordinary no-item state lands on.
 *
 * An earlier finding (doctor.ts): the identity FAIL arm said "the identity could not
 * be read — the credential check names the cause" UNCONDITIONALLY, but in the
 * ordinary no-item state the credential check reached its generic ok:true
 * having never opened the file: nothing in the report named the file
 * permission. The sentence is made true by (a) doctor naming the cause it
 * already holds — the refusal's own path-free prose — and (b) the credential
 * arms above no longer passing over an unreadable file.
 *
 * Written RED against the unguarded arms and the delegation sentence.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-vouch-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-vouch-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-vouch-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

// The keychain suite's verified secret-tool contract: silent exit 1 = miss
// (absent); FAKE_KEYCHAIN_MODE=lookup-fail = D-Bus failure (a FAILED probe,
// which is not an absence).
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
  store) cat > "$f"; exit 0 ;;
  lookup)
    if [ "$mode" = "lookup-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    exit 1
    ;;
  clear) rm -f "$f"; exit 0 ;;
esac
exit 2
`;
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { credentialCheck } = await import('../src/keychain.js');
const { runDoctor } = await import('../src/doctor.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { IdentityKeyPair } = await import('@signalapp/libsignal-client');
type DoctorIo = import('../src/doctor.js').DoctorIo;

let seq = 0;
const used: string[] = [];

beforeEach(() => {
  delete process.env.FAKE_KEYCHAIN_MODE;
  process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.FAKE_KEYCHAIN;
  delete process.env.TACENDUM_CREDENTIAL_STORE;
  delete process.env.FAKE_KEYCHAIN_MODE;
  // Unreadable files must be made removable again before rm -rf.
  for (const name of used) {
    try {
      if (existsSync(join(home, name))) chmodSync(join(home, name, 'identity.json'), 0o600);
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

/** Backend 'file' with the file retained and NO marker — the shipping state. */
function fileAccount(): string {
  const name = `vouch-${seq++}`;
  used.push(name);
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(join(clientDir(name), 'identity.json'), REAL, { mode: 0o600 });
  return name;
}

function withUnreadable(name: string, run: () => void): void {
  chmodSync(join(clientDir(name), 'identity.json'), 0o000);
  try {
    run();
  } finally {
    chmodSync(join(clientDir(name), 'identity.json'), 0o600);
  }
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

// ---------------------------------------------------------------------------
describe('f2: the file arm does not vouch for a read it never made', () => {
  it('failed-probe arm, unreadable file: FAILS naming the errno, never "reads answer from it"', () => {
    const name = fileAccount();
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    withUnreadable(name, () => {
      const check = credentialCheck(name);
      // Pre-fix: ok:true, "backend: file (0600 identity.json); reads answer
      // from it, …" — over a file every read of which throws EXIT.ERROR.
      expect(check.ok, `vouched without reading: ${check.detail}`).toBe(false);
      expect(check.detail).toMatch(/could not be read/);
      expect(check.detail).toMatch(/EACCES/);
      expect(check.detail).not.toMatch(/reads answer from it/);
      expect(check.detail).not.toMatch(/0600 identity\.json/);
      // The probe failure is still disclosed — the read guard must not eat
      // the failed-is-not-absent finding this arm was added for.
      expect(check.detail).toMatch(/was not checked/);
      for (const text of [check.detail, check.remedy ?? '']) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(home);
      }
    });
  });

  it('CONTROL: failed-probe arm with a READABLE file keeps its earned green', () => {
    const name = fileAccount();
    process.env.FAKE_KEYCHAIN_MODE = 'lookup-fail';
    const check = credentialCheck(name);
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toMatch(/reads answer from it/);
    expect(check.detail).toMatch(/could not be probed/);
    expect(check.detail).toMatch(/was not checked/);
  });

  it('rule-c sweep — generic arm (probe absent), unreadable file: FAILS naming the errno', () => {
    const name = fileAccount();
    // Default shim mode: the scoped lookup misses silently — an ABSENT item,
    // so control falls to the generic PASS that claimed "(0600 identity.json)".
    withUnreadable(name, () => {
      const check = credentialCheck(name);
      expect(check.ok, `the generic arm vouched without reading: ${check.detail}`).toBe(false);
      expect(check.detail).toMatch(/could not be read/);
      expect(check.detail).toMatch(/EACCES/);
      expect(check.remedy ?? '').toMatch(/chmod 600/);
      for (const text of [check.detail, check.remedy ?? '']) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(home);
      }
    });
  });

  it('CONTROL: generic arm with a READABLE file still recommends the migrate', () => {
    const name = fileAccount();
    const check = credentialCheck(name);
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toMatch(/0600 identity\.json/);
    expect(check.detail).toMatch(/--migrate/);
  });

  it('rule-c sweep — generic arm with NO keychain at all (store=file): same guard', () => {
    const name = fileAccount();
    process.env.TACENDUM_CREDENTIAL_STORE = 'file';
    withUnreadable(name, () => {
      const check = credentialCheck(name);
      expect(check.ok, `the no-keychain arm vouched without reading: ${check.detail}`).toBe(false);
      expect(check.detail).toMatch(/EACCES/);
    });
    const readable = credentialCheck(name);
    expect(readable.ok, readable.detail).toBe(true);
    expect(readable.detail).toMatch(/no OS keychain available here/);
  });
});

// ---------------------------------------------------------------------------
describe('f3: doctor names the cause it holds instead of promising another line will', () => {
  it('ordinary no-item state, unreadable file: identity AND credential both name it', async () => {
    const name = fileAccount();
    // Default shim mode: probe answers absent — the exact state where the
    // credential check used to reach its generic ok:true having never opened
    // the file, while the identity FAIL above it promised "the credential
    // check names the cause".
    let results: import('../src/doctor.js').CheckResult[] = [];
    // `withUnreadable` is sync-only; doctor is async, so the chmod window is
    // held open by hand here.
    chmodSync(join(clientDir(name), 'identity.json'), 0o000);
    try {
      results = await runDoctor(name, deadIo);
    } finally {
      chmodSync(join(clientDir(name), 'identity.json'), 0o600);
    }

    const identity = results.find(r => r.check === 'identity');
    expect(identity?.ok).toBe(false);
    // The cause, on the line that holds it: readCredential's own path-free
    // refusal prose, errno included — not a promise about a different line.
    expect(identity?.detail).toMatch(/could not be read/);
    expect(identity?.detail, `the delegation sentence survived: ${identity?.detail}`).toMatch(
      /EACCES/,
    );
    // …and the line it used to delegate to now genuinely names the cause too.
    const credential = results.find(r => r.check === 'credential');
    expect(credential?.ok, `credential PASSed over the unreadable file: ${credential?.detail}`).toBe(
      false,
    );
    expect(credential?.detail).toMatch(/EACCES/);
    // Doctor's masking rule holds on every line.
    for (const r of results) {
      expect(`${r.detail} ${r.remedy ?? ''}`).not.toContain(name);
    }
  });
});
