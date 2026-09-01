import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE REMEDY MUST BE TRUE OF THE COPY THE READ CAME FROM.
 *
 * `runDoctor` resolves the identity through `readCredential`, exactly as every
 * command does — that is an earlier revision's fix and it is right. But it phrases the
 * FAIL from `credentialStatus(name).backend`, which is the MARKER'S RECORDED
 * backend: where a read is TRIED first, not where the bytes in hand came from.
 * Those two differ along a path the product walks by itself. With a keychain
 * backend recorded and the lookup FAILING (locked keyring, no session bus, an
 * item something else wrote over), `readCredential` does not throw while a
 * retained identity.json exists — it falls through to the file (keychain.ts,
 * `readCredential` steps 1→2) and the FILE's bytes are what doctor validates.
 *
 * In that state the report contradicted itself in two adjacent lines:
 *
 *   identity   FAIL … remedy: The unusable bytes are in the linux-libsecret
 *                     ITEM … so restoring the file ALONE changes nothing
 *   credential FAIL … remedy: the fallback file still covers reads; fix the
 *                     keychain environment when convenient
 *
 * The first sentence is about bytes that came out of the second sentence's
 * file. An operator who believes it goes and re-stores a file they were just
 * told is already the one being read, and the actual repair — the malformed
 * identity.json in front of them — is the thing the advice steered them away
 * from.
 *
 * The fix is NOT to guess which copy answered: `readCredential` returns
 * `string | null` and carries no provenance, and re-deriving it here with a
 * second probe is the defect this file's neighbours were built to stop (two
 * reads at two instants are two answers — `forecastFrom`'s `backend`
 * parameter exists for that reason). The fix is a sentence that is TRUE IN
 * BOTH states and sends the operator to the credential line to learn which
 * one they are in.
 *
 * This test drives the fall-through for real — a `secret-tool` shim whose
 * lookup fails the way a dead session bus does — and asserts the printed
 * advice against the state on disk, not against a wording.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-answering-copy-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-answering-copy-bin-'));
process.env.TACENDUM_HOME = home;
const ORIGINAL_PATH = process.env.PATH ?? '';
process.env.PATH = `${shimDir}:${ORIGINAL_PATH}`;
process.env.TACENDUM_CREDENTIAL_STORE = 'linux-libsecret';

/**
 * A `secret-tool` whose LOOKUP fails the way a headless box's does: a
 * diagnostic on stderr and a nonzero exit, which `silentMiss` correctly
 * refuses to read as "absent". `store` succeeds so nothing here depends on
 * the failure arm being reached by accident.
 */
const SECRET_TOOL_SHIM = `#!/bin/bash
PATH=/usr/bin:/bin
if [ "$1" = "lookup" ]; then
  echo "secret-tool: Cannot autolaunch D-Bus without X11" >&2
  exit 1
fi
exit 0
`;
writeFileSync(join(shimDir, 'secret-tool'), SECRET_TOOL_SHIM);
chmodSync(join(shimDir, 'secret-tool'), 0o755);

const { clientDir } = await import('../src/config.js');
const { readCredential } = await import('../src/keychain.js');
const { runDoctor } = await import('../src/doctor.js');
const { CliError, EXIT } = await import('../src/exit.js');
type DoctorIo = import('../src/doctor.js').DoctorIo;

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(home, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

/** Present, and refused by every operational read — the state whose remedy is
 * under test. `identityLoads` and `IdentityKeyPair.deserialize` both reject
 * it; nothing here depends on WHY. */
const UNUSABLE = JSON.stringify({ identityKeyPair: 'junk', registrationId: 1 });

/** Network probes stubbed dead-fast: only the identity and credential lines
 * are under test, and doctor.test.ts owns the rest. */
const deadIo: DoctorIo = {
  fetchImpl: (async () => {
    throw new Error('offline');
  }) as typeof fetch,
  dialWs: async () => {
    throw new CliError(EXIT.NETWORK, 'offline');
  },
  now: () => Date.now(),
};

let seq = 0;
/**
 * A migrated account whose keychain has gone unreachable and whose fallback
 * file was retained — the shipping result of `credential --migrate` without
 * `--remove-file`, on a box that later lost its session bus.
 */
function unreachableKeychainAccount(): string {
  const name = `ac-${seq++}`;
  mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(join(clientDir(name), 'identity.json'), UNUSABLE, { mode: 0o600 });
  writeFileSync(
    join(clientDir(name), 'credential-backend.json'),
    JSON.stringify({ backend: 'linux-libsecret', scope: 'home' }),
    { mode: 0o600 },
  );
  return name;
}

describe('a recorded keychain whose lookup fails answers from the FILE', () => {
  it('readCredential falls through to identity.json rather than refusing', () => {
    const name = unreachableKeychainAccount();
    // The premise of the whole finding, executed rather than asserted: the
    // marker says keychain, the lookup fails, a file is retained, and the
    // bytes that come back are the FILE's. (Without the file this same
    // lookup raises EXIT.ERROR — `readCredential`'s failed-is-not-absent
    // arm — which is why the retained file is what makes the state quiet.)
    expect(readCredential(name)).toBe(UNUSABLE);
  });

  it('the identity remedy does not claim the bytes are in the item it never read', async () => {
    const name = unreachableKeychainAccount();
    const results = await runDoctor(name, deadIo);
    const identity = results.find(r => r.check === 'identity');
    const credential = results.find(r => r.check === 'credential');
    expect(identity?.ok).toBe(false);
    expect(credential?.ok).toBe(false);
    const remedy = identity?.remedy ?? '';

    // THE CONTRADICTION, pinned as a contradiction. The credential line for
    // this state says the fallback file is what covers reads; the identity
    // line must not, in the same report, tell the operator the unusable bytes
    // are in the item and that the file changes nothing.
    expect(credential?.remedy ?? '').toContain('the fallback file still covers reads');
    expect(remedy).not.toContain('restoring the file ALONE changes nothing');
    expect(remedy).not.toMatch(/unusable bytes are in the \S+ ITEM/);

    // …and it still has to be USEFUL. Naming neither copy is as bad as naming
    // the wrong one: the operator needs both halves of the repair and a way
    // to tell which half their machine needs.
    expect(remedy).toContain('identity.json');
    expect(remedy).toContain('--migrate');
    expect(remedy).toContain('credential line');
    // The cost of guessing wrong is the reason the whole paragraph exists.
    expect(remedy).toContain('THE KEY IS THE ACCOUNT');
  });

  it('the session forecast prints the SAME repair — one function, two renderings', async () => {
    const name = unreachableKeychainAccount();
    const results = await runDoctor(name, deadIo);
    const identity = results.find(r => r.check === 'identity');
    const session = results.find(r => r.check === 'session');
    // `forecastFrom` and the identity line are two renderings of one read; a
    // second copy of this sentence is how they come apart, so the session
    // advice must carry the identity remedy verbatim.
    expect(session?.remedy ?? '').toContain(identity?.remedy ?? '\u0000');
  });

  it('a FILE-backend machine still gets the plain answer, unchanged', async () => {
    const name = `ac-file-${seq++}`;
    mkdirSync(clientDir(name), { recursive: true, mode: 0o700 });
    writeFileSync(join(clientDir(name), 'identity.json'), UNUSABLE, { mode: 0o600 });
    // No marker: the shipping state. Nothing about the keychain belongs in
    // this remedy, and the earlier wording for it is not what changed.
    const results = await runDoctor(name, deadIo);
    const remedy = results.find(r => r.check === 'identity')?.remedy ?? '';
    expect(remedy).toContain('Restore identity.json from backup');
    expect(remedy).not.toContain('--migrate');
    expect(remedy).toContain('THE KEY IS THE ACCOUNT');
  });
});
