import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * THE REMEDY WAS THE MECHANISM OF THE DAMAGE, AGAIN — doctor's unusable-credential remedy described `tacendum
 * credential <name> --migrate` as a command that "cannot run at all while the
 * keychain is unreachable" and "verifies the read-back before recording
 * anything". Both were false of the shipped command: with a keychain backend
 * RECORDED and the keychain merely unreachable, `migrateCredential`'s
 * kept-file arm did not refuse — it recorded backend `file`, emitted
 * `ok:true action:kept-file` at exit 0, and from that moment `readCredential`
 * step 1 (gated on `marker.backend !== 'file'`) never consulted the healthy
 * keychain item again. A transient bus failure permanently severed the read
 * path to the one good copy, and the account answered from whatever junk the
 * fallback file held:
 *
 *   control  : bus down -> FILE(junk); bus UP -> ITEM(real)   [self-heals]
 *   treatment: bus down -> FILE(junk); bus UP -> FILE(junk)   [never recovers]
 *
 * And 1b: after the downgrade, `credentialCheck` took its `backend === 'file'`
 * arm, reported ok:true, and RECOMMENDED the migrate that would overwrite the
 * real item with the junk file — while its own docblock claimed the two copies
 * are compared "whenever both exist".
 *
 * These tests drive the REAL commands through the same directory-backed
 * `secret-tool` shim the gate used, with `FAKE_KEYCHAIN_MODE` as the phase
 * switch. Written RED against the pre-fix tree.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-downgrade-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-downgrade-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-downgrade-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

/** The phase switch: '' = bus up; 'all-fail' = the session bus is down (store
 * and lookup both fail the way a headless box's do). Same contract as
 * keychain.test.ts's shim, pared to what these states need. */
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
const { cmdCredential, credentialCheck, migrateCredential, readCredential } = await import(
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

/** A REAL identity (keychain.test.ts's doctrine): the item under guard holds
 * bytes libsignal will deserialize, so "the healthy copy" is not standing on a
 * weaker predicate than the loader's. */
const REAL = JSON.stringify({
  identityKeyPair: Buffer.from(IdentityKeyPair.generate().serialize()).toString('base64'),
  registrationId: 7,
});
const REAL_HEX = Buffer.from(REAL, 'utf8').toString('hex');
/** What the fallback file degrades to in the gate's repro: present, parseable
 * shape, bytes no operational read accepts. */
const JUNK = JSON.stringify({ identityKeyPair: 'junk', registrationId: 1 });

let seq = 0;
const acctAttr = (name: string): string =>
  createHash('sha256')
    .update(`${resolve(process.env.TACENDUM_HOME as string)}\n${name}`, 'utf8')
    .digest('hex');
const linItem = (name: string): string => join(fakeState, `lin-${acctAttr(name)}`);
const identityPath = (name: string): string => join(clientDir(name), 'identity.json');
const markerPath = (name: string): string => join(clientDir(name), 'credential-backend.json');
const markerBackend = (name: string): string | undefined =>
  (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { backend?: string }).backend;

/** A migrated account whose ITEM holds the real identity and whose retained
 * file has since gone bad — the exact two-copy state the gate reproduced. */
function shadowableAccount(): string {
  const name = `dg-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(identityPath(name), REAL, { mode: 0o600 });
  const outcome = migrateCredential(name);
  expect(outcome.action).toBe('migrated'); // premise: item verified readable
  writeFileSync(identityPath(name), JUNK, { mode: 0o600 });
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

describe('a transient keychain failure must not flip a recorded keychain marker', () => {
  it('the gate’s treatment now matches its control: --migrate on a dead bus keeps the marker, and the item answers again when the bus returns', () => {
    const name = shadowableAccount();
    expect(markerBackend(name)).toBe('linux-libsecret');

    // The phase switch: the session bus dies, and the operator runs the
    // command doctor's remedy names.
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const { rep, emitted } = fakeReporter();
    let caught: unknown;
    try {
      cmdCredential(name, { migrate: true, removeFile: false }, rep);
    } catch (err) {
      caught = err;
    }

    // The explicit repair command may not claim success for a repair that did
    // not happen: EXIT.ERROR, the keychain-unreachable taxonomy readCredential
    // already uses ("retry can help"), never ok:true at exit 0.
    expect(caught, 'cmdCredential --migrate reported success with the keychain unreachable').toBeInstanceOf(
      CliError,
    );
    expect((caught as CliError).exitCode).toBe(EXIT.ERROR);
    expect(emitted.filter(e => e.record.ok === true)).toEqual([]);
    // Rule 4: no name, no credential bytes in the refusal.
    expect((caught as CliError).message).not.toContain(name);
    expect((caught as CliError).message).not.toContain(REAL_HEX.slice(0, 16));

    // THE MARKER DID NOT FLIP — the fact that makes the damage impossible.
    expect(markerBackend(name), 'a transient store failure rewrote the marker to file').toBe(
      'linux-libsecret',
    );

    // Bus still down: reads fall back to the file, exactly as before the fix.
    expect(readCredential(name)).toBe(JUNK);

    // Bus back up: the recorded backend routes reads to the ITEM again — the
    // self-heal the control run showed and the treatment run lost.
    process.env.FAKE_KEYCHAIN_MODE = '';
    expect(readCredential(name), 'the read path to the healthy item was severed').toBe(REAL);
  });

  it('the deliberate kept-file fallback is untouched where it was sound: no recorded backend', () => {
    // keychain.test.ts pins this headless path and the gate judged it sound:
    // FIRST decision on a box whose keychain is unusable records `file` so the
    // probe does not re-run (and re-fail) on every invocation. Only the
    // downgrade OVER an existing keychain marker changed.
    const name = `dg-fresh-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), REAL, { mode: 0o600 });
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const outcome = migrateCredential(name);
    expect(outcome.action).toBe('kept-file');
    expect(outcome.backend).toBe('file');
    expect(markerBackend(name)).toBe('file');
    expect(readCredential(name)).toBe(REAL);
  });
});

describe('1b: credentialCheck must not bless a junk file shadowing a healthy item', () => {
  /** The field state the old kept-file arm manufactured: marker says `file`,
   * the file is junk, and a healthy item sits at this home's coordinates. */
  function downgradedAccount(): string {
    const name = `dg-shadow-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), JUNK, { mode: 0o600 });
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'file', scope: 'home' }), {
      mode: 0o600,
    });
    writeFileSync(linItem(name), REAL_HEX);
    return name;
  }

  it('the both-exist comparison its docblock promises actually runs in the file arm', () => {
    const name = downgradedAccount();
    const check = credentialCheck(name);
    // ok:true here printed "libsecret is available — --migrate moves it":
    // a recommendation to overwrite the one healthy copy with the junk file.
    expect(check.ok, 'credentialCheck vouched for a junk file shadowing a live item').toBe(false);
    expect(check.detail).toMatch(/DIFFERENT/);
    // The remedy must warn what migrate would do here, not recommend it bare.
    expect(check.remedy ?? '').toMatch(/overwrite/);
    expect(check.remedy ?? '').toMatch(/two identities/);
    // Which copy commands answer from, stated: the FILE (marker says so).
    expect(check.detail).toMatch(/commands use the FILE/i);
    // Rule 4 on both strings.
    for (const text of [check.detail, check.remedy ?? '']) {
      expect(text).not.toContain('dg-shadow-');
      expect(text).not.toContain(REAL_HEX.slice(0, 16));
    }
  });

  it('liveness: a matching item, an absent item, and an unreachable keychain all keep ok:true', () => {
    // Matching item: the ordinary retained-fallback state, nothing to report.
    const matching = `dg-match-${seq++}`;
    mkdirSync(clientDir(matching), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(matching), REAL, { mode: 0o600 });
    writeFileSync(markerPath(matching), JSON.stringify({ backend: 'file', scope: 'home' }), {
      mode: 0o600,
    });
    writeFileSync(linItem(matching), REAL_HEX);
    expect(credentialCheck(matching).ok).toBe(true);

    // No item at all: the shipping pre-migration state, migrate stays offered.
    const plain = `dg-plain-${seq++}`;
    mkdirSync(clientDir(plain), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(plain), REAL, { mode: 0o600 });
    const noItem = credentialCheck(plain);
    expect(noItem.ok).toBe(true);
    expect(noItem.detail).toContain('--migrate');

    // Unreachable keychain: nothing to compare against; the file genuinely
    // covers reads and the check must not fail on a probe it cannot make.
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    expect(credentialCheck(plain).ok).toBe(true);
  });
});

describe('the remedy says what the command does', () => {
  it('doctor’s unusable-credential remedy no longer claims --migrate cannot run, and states the kept-marker truth it now has', async () => {
    // gate.answering-copy.test.ts's state: recorded keychain, unusable file,
    // lookup failing — the state whose remedy paragraph is under test.
    const name = `dg-remedy-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(identityPath(name), JUNK, { mode: 0o600 });
    writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret', scope: 'home' }), {
      mode: 0o600,
    });
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    const results = await runDoctor(name, deadIo);
    const identity = results.find(r => r.check === 'identity');
    expect(identity?.ok).toBe(false);
    const remedy = identity?.remedy ?? '';

    // The two falsehoods the gate executed, gone:
    expect(remedy, 'the remedy still calls the destructive command an impossible no-op').not.toContain(
      'cannot run at all',
    );
    // What the command ACTUALLY does now in that state — asserted here as
    // text, and asserted as behaviour by the marker test above, so the two
    // cannot drift apart silently again:
    expect(remedy).toMatch(/keeps the recorded backend/);
    expect(remedy).toMatch(/retry once the keychain is reachable/);
    // The parts that were right stay: both-copies phrasing, the command, the
    // pointer to the credential line, and the cost sentence.
    expect(remedy).toContain('tacendum credential <name> --migrate');
    expect(remedy).toContain('credential line');
    expect(remedy).toContain('THE KEY IS THE ACCOUNT');
  });
});
