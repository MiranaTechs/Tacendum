import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `kept-legacy` MUST CARRY `readCredential`'s EXIT TAXONOMY.
 *
 * An earlier revision landed EXIT.ERROR on `kept-recorded` and cited `rehomeLegacyItem`'s
 * posture as its precedent — then left `kept-legacy`, the outcome that
 * function actually returns, on the ok:true fall-through in `cmdCredential`.
 * Reproduced through the real binary with a pre-scoping marker, no scope, no
 * identity.json:
 *
 *   bus DOWN  : plain `credential` exits 1 (ERROR) — `--migrate` exited 0
 *               `{"ok":true,"action":"kept-legacy"}`
 *   item GONE : plain `credential` exits 3 (AUTH)  — `--migrate` exited 0
 *               with a BYTE-IDENTICAL line
 *
 * Two states whose taxonomies `readCredential` deliberately keeps opposite
 * collapsed to one ok:true from the explicit repair command — in the state
 * where the operator is WORSE off than kept-recorded, because there is no
 * retained file. And per the gate's own correction: the defect is the
 * ok:true/exit-0 and the collapsed taxonomy, NOT a false absence word — an
 * unreachable keychain is also unreadable, so absence may only be claimed
 * when the keychain ANSWERED.
 *
 * Written RED against the fall-through.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-keptlegacy-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-keptlegacy-bin-'));
const fakeState = mkdtempSync(join(tmpdir(), 'tacendum-keptlegacy-state-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.FAKE_KEYCHAIN = fakeState;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

/** '' = bus up; 'all-fail' = bus down; 'store-fail' = lookups answer but the
 * store side is broken (the arm-2 shape: a readable legacy item whose re-home
 * store cannot land). */
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
    if [ "$mode" = "all-fail" ] || [ "$mode" = "store-fail" ]; then
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
    if [ "$mode" = "all-fail" ]; then
      echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
      exit 1
    fi
    rm -f "$f"
    exit 0
    ;;
esac
exit 2
`;
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { cmdCredential, maybeMigrateCredential, readCredential } = await import(
  '../src/keychain.js'
);
const { CliError, EXIT } = await import('../src/exit.js');
const { IdentityKeyPair } = await import('@signalapp/libsignal-client');
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
const markerPath = (name: string): string => join(clientDir(name), 'credential-backend.json');
/** The LEGACY coordinate: account = the raw client name. */
const legacyItem = (name: string): string => join(fakeState, `lin-${name}`);

/** The gate's repro state: pre-scoping keychain marker (no `scope` field), no
 * identity.json, and whatever the test puts at the legacy coordinate. */
function preScopingAccount(): string {
  const name = `kl-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath(name), JSON.stringify({ backend: 'linux-libsecret' }), {
    mode: 0o600,
  });
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

function runMigrate(name: string): { caught: CliError | null; okEmits: number } {
  const { rep, emitted } = fakeReporter();
  try {
    cmdCredential(name, { migrate: true, removeFile: false }, rep);
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return { caught: err as CliError, okEmits: emitted.filter(e => e.record.ok === true).length };
  }
  return { caught: null, okEmits: emitted.filter(e => e.record.ok === true).length };
}

describe('kept-legacy arm 1: nothing usable to move', () => {
  it('bus DOWN: --migrate refuses with EXIT.ERROR, like the plain read, and claims no absence', () => {
    const name = preScopingAccount();
    process.env.FAKE_KEYCHAIN_MODE = 'all-fail';
    // Control: the read side's taxonomy for this state.
    let readErr: unknown;
    try {
      readCredential(name);
    } catch (err) {
      readErr = err;
    }
    expect(readErr).toBeInstanceOf(CliError);
    expect((readErr as CliError).exitCode).toBe(EXIT.ERROR);

    const { caught, okEmits } = runMigrate(name);
    expect(caught, '--migrate reported ok:true over a re-home that never ran').not.toBeNull();
    expect(caught?.exitCode, 'the unreachable-keychain state must exit ERROR like the read').toBe(
      EXIT.ERROR,
    );
    expect(okEmits).toBe(0);
    // The gate's own correction: an unreachable keychain is also unreadable —
    // the refusal must not claim the item is ABSENT.
    expect(caught?.message ?? '').not.toMatch(/no .*item to re-home/i);
    expect(caught?.message ?? '').not.toMatch(/answered and holds no/i);
    // The marker survives: the next reachable moment retries the re-home.
    expect(existsSync(markerPath(name))).toBe(true);
  });

  it('item GONE (bus up): --migrate refuses with EXIT.AUTH, like the plain read', () => {
    const name = preScopingAccount();
    // Bus is up; both coordinates genuinely answer "no item".
    let readErr: unknown;
    try {
      readCredential(name);
    } catch (err) {
      readErr = err;
    }
    expect(readErr).toBeInstanceOf(CliError);
    expect((readErr as CliError).exitCode).toBe(EXIT.AUTH);

    const { caught, okEmits } = runMigrate(name);
    expect(caught, '--migrate reported ok:true over a credential that is GONE').not.toBeNull();
    expect(caught?.exitCode, 'the gone-credential state must exit AUTH like the read').toBe(
      EXIT.AUTH,
    );
    expect(okEmits).toBe(0);
    expect(caught?.message ?? '').toMatch(/restore identity\.json from backup/);
  });
});

describe('kept-legacy arm 2: a readable legacy item whose re-home store failed', () => {
  it('--migrate refuses with EXIT.ERROR, keeps the marker, and reads keep answering', () => {
    const name = preScopingAccount();
    writeFileSync(legacyItem(name), REAL_HEX);
    process.env.FAKE_KEYCHAIN_MODE = 'store-fail';

    // Reads work in this state — the legacy fallback answers.
    expect(readCredential(name)).toBe(REAL);

    const { caught, okEmits } = runMigrate(name);
    expect(caught, '--migrate reported success over a store that failed').not.toBeNull();
    expect(caught?.exitCode).toBe(EXIT.ERROR);
    expect(okEmits).toBe(0);
    // Nothing was recorded, nothing was moved, reads are unchanged.
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { scope?: string }).scope,
    ).toBeUndefined();
    expect(readCredential(name)).toBe(REAL);
    // Rule 4 and the secret rule: no name, no credential bytes.
    expect(caught?.message ?? '').not.toContain(name);
    expect(caught?.message ?? '').not.toContain(REAL_HEX.slice(0, 16));
  });

  it('the silent hook stays silent over the same state', () => {
    const name = preScopingAccount();
    writeFileSync(legacyItem(name), REAL_HEX);
    process.env.FAKE_KEYCHAIN_MODE = 'store-fail';
    expect(maybeMigrateCredential(name)).toBeNull();
  });

  it('and a healthy bus still re-homes: the repair itself is untouched', () => {
    const name = preScopingAccount();
    writeFileSync(legacyItem(name), REAL_HEX);
    const { caught, okEmits } = runMigrate(name);
    expect(caught).toBeNull();
    expect(okEmits).toBe(1);
    expect(
      (JSON.parse(readFileSync(markerPath(name), 'utf8')) as { scope?: string }).scope,
    ).toBe('home');
    expect(readCredential(name)).toBe(REAL);
  });
});
