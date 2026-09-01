import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A SECOND IMPLEMENTATION OF AN OPERATIONAL QUESTION IS ITSELF THE DEFECT.
 *
 * The malformed-token refusal has to choose between two remedies that differ
 * in whether following them destroys the account, and the question it turns on
 * — "does an identity credential for this account resolve on this machine?" —
 * is one this CLI already answers, operationally, on the path that matters:
 * `cmdRegister` asks `stores.identity.exists()`, which is `identity.json` or
 * `readCredential(name)` (keychain.ts), the module that owns the marker, the
 * backend order, the legacy coordinates and the absent/failed distinction.
 *
 * The previous round answered it a SECOND time, in profile.ts, by hand: a file
 * check plus a hand-parse of `credential-backend.json`. Two implementations of
 * one question do not converge; they drift, and this one drifted in BOTH
 * directions at once —
 *
 *   - a marker naming a backend this build does not know reads, to the hand
 *     parse, as "not file, therefore the key is somewhere I cannot look,
 *     therefore present". `recordedMarker` reads the same file and answers
 *     null (the name is not a backend name), so on a file-preferred
 *     installation registration finds NO credential and mints a replacement
 *     account. The refusal promised a sign-in that keeps the owner binding,
 *     and the operator who followed it lost the binding.
 *   - a marker that was LOST beside a perfectly good keychain item reads as
 *     "absent". `readCredential` probes the preferred backend in exactly that
 *     state, finds the item and signs in safely. The refusal said "Do NOT
 *     register" about the one action that would have fixed everything.
 *
 * AND PRESENCE IS NOT CONTINUITY. Even a credential that resolves is only the
 * SAME account's credential if it is the same key: `cmdRegister` authenticates
 * whatever key it holds, and declines to inherit the class and the binding
 * when the server answers with a different userId (`previous?.userId ===
 * minted.userId`). A profile hand-copied beside somebody else's valid
 * identity.json therefore gets a promise of a same-account sign-in and an
 * overwrite as an ordinary, unbound account.
 *
 * Each test below runs the operator's path end to end: read the refusal, then
 * follow it, then require the refusal to have described what actually landed
 * on disk.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-remedyres-'));
const shimDir = mkdtempSync(join(tmpdir(), 'tacendum-remedyres-bin-'));
const fakeKeychain = mkdtempSync(join(tmpdir(), 'tacendum-remedyres-kc-'));

/** 26 characters of Crockford base32 — the alphabet the server mints in. */
const OWNER = '01WNERRESZVER0000000000000';

/** What an older build could have left on disk: a token with a line break in
 * it, which Node refuses as a header value. The account around it is intact. */
const LEGACY_TOKEN = 'LEGACYRES0LVE\nTAIL';

/**
 * The `secret-tool` contract, exactly as keychain.test.ts pins it: exit 0 with
 * the hex on stdout for a hit, silent exit 1 for a miss. A shim, because the
 * real tool needs a session bus and writing to a developer's keyring would be
 * vandalism — and because the state under test is a keychain item WITHOUT a
 * marker, which no real keyring makes convenient to arrange.
 */
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

/**
 * The server's account table, keyed by identity public key — which is what
 * makes "a different key is a different account" the mechanism under test
 * rather than a fixture decision.
 */
const accounts = new Map<string, { userId: string; integration: boolean }>();
let minted = 0;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true });
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      return json(200, {
        challenge: Buffer.from('resolver-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
    }
    if (req.method === 'POST' && req.url === '/v1/auth') {
      const parsed = JSON.parse(body || '{}') as { identityKey?: string; accountClass?: string };
      const key = parsed.identityKey ?? '';
      let row = accounts.get(key);
      if (row === undefined) {
        minted += 1;
        row = {
          userId: `01RESZVER${String(minted).padStart(2, '0')}ZZZZZZZZZZZZZZZ`,
          integration: parsed.accountClass === 'integration',
        };
        accounts.set(key, row);
      }
      return json(200, {
        userId: row.userId,
        authToken: `tok-resolver-${Math.random().toString(36).slice(2, 10)}`,
        ...(row.integration ? { accountClass: 'integration' as const } : {}),
      });
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') return json(200, {});
    if (req.method === 'POST' && req.url === '/v1/integrations/bind') {
      const parsed = JSON.parse(body || '{}') as { owner?: string };
      if (parsed.owner !== OWNER) {
        return json(400, { error: { code: 'bad_request', detail: 'unexpected owner' } });
      }
      res.writeHead(204);
      return res.end();
    }
    json(404, { error: { code: 'not_found', detail: 'no route' } });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  for (const dir of [home, shimDir, fakeKeychain]) rmSync(dir, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        FAKE_KEYCHAIN: fakeKeychain,
        TACENDUM_HOME: home,
        TACENDUM_API: apiBase,
        TACENDUM_WS: apiBase.replace('http://', 'ws://'),
        NODE_USE_SYSTEM_CA: '0',
        // The default for every step unless a test says otherwise: the
        // identity lives in identity.json and nowhere else, so the fixtures
        // are exact and no developer's real keychain is ever touched.
        TACENDUM_CREDENTIAL_STORE: 'file',
        ...env,
      },
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const dirOf = (name: string): string => join(home, name);
const profileFile = (name: string): string => join(dirOf(name), 'profile.json');
const identityFile = (name: string): string => join(dirOf(name), 'identity.json');
const markerFile = (name: string): string => join(dirOf(name), 'credential-backend.json');

interface Stored {
  userId?: string;
  authToken?: string;
  accountClass?: string;
  ownerUserId?: string;
}
const stored = (name: string): Stored =>
  JSON.parse(readFileSync(profileFile(name), 'utf8')) as Stored;

/** A bound integration whose token an older build downgraded. Returns its
 * userId — the account the operator is trying not to lose. */
async function boundIntegrationWithBadToken(name: string): Promise<string> {
  const reg = await runCli(['register', name, '--integration']);
  expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
  const pair = await runCli(['pair', name, OWNER]);
  expect(pair.code, `pair stderr was:\n${pair.stderr}`).toBe(0);
  const before = stored(name);
  expect(before.ownerUserId, 'the premise is missing — nothing was bound').toBe(OWNER);
  expect(before.accountClass, 'the premise is missing — not an integration').toBe('integration');
  writeFileSync(profileFile(name), JSON.stringify({ ...before, authToken: LEGACY_TOKEN }), {
    mode: 0o600,
  });
  return before.userId!;
}

describe('the remedy is decided by the resolver registration actually uses', () => {
  it('a marker naming an unknown backend is NOT proof of a key — register mints a new account', async () => {
    const name = 'resunknownmarker';
    const was = await boundIntegrationWithBadToken(name);

    // A copied installation: the account directory travelled, the credential
    // did not, and the marker names a backend written by some other build.
    // `recordedMarker` rejects it (not a backend name) and the read falls
    // through to a preferred backend of `file` — which is not there either.
    unlinkSync(identityFile(name));
    writeFileSync(markerFile(name), JSON.stringify({ backend: 'gnome-keyring', scope: 'home' }), {
      mode: 0o600,
    });

    const refusal = await runCli(['sync', name]);
    expect(refusal.code, 'an unusable stored credential must be refused').not.toBe(0);
    const message = `${refusal.stdout}${refusal.stderr}`;
    expect(message, 'the credential was echoed').not.toContain('LEGACYRES0LVE');

    // Follow it.
    const again = await runCli(['register', name]);
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const after = stored(name);

    // GROUND TRUTH FIRST: this is what the machine did, and the message had to
    // have described it.
    expect(after.userId, 'the premise changed: no new account was minted').not.toBe(was);
    expect(after.accountClass, 'the premise changed: the class survived').toBeUndefined();
    expect(after.ownerUserId, 'the premise changed: the binding survived').toBeUndefined();

    // THE ASSERTION.
    expect(
      message,
      'the refusal promised a sign-in for a machine that had no credential to present',
    ).not.toMatch(/signs in rather than creating anything/i);
    expect(message, 'the refusal did not warn that a NEW account would be minted').toMatch(
      /new account/i,
    );
    expect(message, 'the refusal did not name restoring the key as the thing to do first').toMatch(
      /identity\.json/i,
    );
  }, 180_000);

  it('a LOST marker beside a usable keychain item is NOT absence — register signs in', async () => {
    const name = 'reskeychainonly';
    const was = await boundIntegrationWithBadToken(name);

    // Move the credential into the (shimmed) keychain and drop the file, which
    // is the supported migration. Then LOSE the marker — keychain.ts's own doc
    // step 4, a disk restore that skipped a dotfile-ish sidecar.
    const mig = await runCli(['credential', name, '--migrate', '--remove-file'], {
      TACENDUM_CREDENTIAL_STORE: 'linux-libsecret',
    });
    expect(mig.code, `credential --migrate stderr was:\n${mig.stderr}`).toBe(0);
    expect(existsSync(identityFile(name)), 'the file was supposed to be removed').toBe(false);
    expect(existsSync(markerFile(name)), 'the migration recorded no marker').toBe(true);
    unlinkSync(markerFile(name));

    const refusal = await runCli(['sync', name], {
      TACENDUM_CREDENTIAL_STORE: 'linux-libsecret',
    });
    expect(refusal.code, 'an unusable stored credential must be refused').not.toBe(0);
    const message = `${refusal.stdout}${refusal.stderr}`;
    expect(message, 'the credential was echoed').not.toContain('LEGACYRES0LVE');

    // Follow it. The resolver finds the item and this is an ordinary sign-in.
    const again = await runCli(['register', name], {
      TACENDUM_CREDENTIAL_STORE: 'linux-libsecret',
    });
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const after = stored(name);

    // GROUND TRUTH: nothing was lost, and nothing needed restoring.
    expect(after.userId, 'a new account was minted for a client that still had its key').toBe(was);
    expect(after.accountClass).toBe('integration');
    expect(after.ownerUserId).toBe(OWNER);
    expect(after.authToken).not.toBe(LEGACY_TOKEN);

    // THE ASSERTION: the refusal must not have told the operator to stop.
    expect(
      message,
      'the refusal said "do NOT register" about the action that safely signs in',
    ).not.toMatch(/do NOT register/i);
    expect(
      message,
      'the refusal claimed the key was not on this machine, and the machine had it',
    ).not.toMatch(/is not on this machine/i);
    expect(message, 'the refusal did not tell the operator to register').toMatch(
      /tacendum register/i,
    );
  }, 180_000);

  it('presence is not continuity: a DIFFERENT key beside the profile is not a sign-in', async () => {
    const name = 'rescontinuity';
    const other = 'resotherkey';
    const was = await boundIntegrationWithBadToken(name);

    // A second, ordinary account with its own keypair — somebody else's key,
    // or this operator's own from a different account, restored into the wrong
    // directory. It is a perfectly valid identity.json; it is simply not this
    // account's.
    const reg = await runCli(['register', other]);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    const otherId = stored(other).userId!;
    expect(otherId).not.toBe(was);
    copyFileSync(identityFile(other), identityFile(name));

    const refusal = await runCli(['sync', name]);
    expect(refusal.code, 'an unusable stored credential must be refused').not.toBe(0);
    const message = `${refusal.stdout}${refusal.stderr}`;
    expect(message, 'the credential was echoed').not.toContain('LEGACYRES0LVE');

    // Follow it.
    const again = await runCli(['register', name]);
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const after = stored(name);

    // GROUND TRUTH: the key authenticated as the OTHER account, `cmdRegister`
    // declined to inherit anything, and the bound account is now unreachable
    // from this machine — exactly the damage the "restore the key first"
    // remedy exists to prevent, arrived at from the other side.
    expect(after.userId, 'the premise changed: the profile kept its own userId').toBe(otherId);
    expect(after.accountClass, 'the premise changed: the class was inherited').toBeUndefined();
    expect(after.ownerUserId, 'the premise changed: the binding was inherited').toBeUndefined();

    // THE ASSERTION. The refusal cannot know which of the two happens — that
    // is settled at the server — so it may not assert either one. What it must
    // do is name the comparison and both of its outcomes.
    expect(
      message,
      'the refusal promised a same-account sign-in it cannot know it will get',
    ).not.toMatch(/signs in rather than creating anything/i);
    expect(message, 'the refusal did not say the user id is compared').toMatch(/user id/i);
    expect(
      message,
      'the refusal did not describe the DIFFERENT-account outcome at all',
    ).toMatch(/differ/i);
    expect(message, 'the refusal did not say this profile would be overwritten').toMatch(
      /overwritten/i,
    );
    expect(message, 'the refusal did not say the old account becomes unreachable').toMatch(
      /unreachable|able to reach/i,
    );
  }, 180_000);
});

/**
 * DOCTOR AND THE REFUSAL CANNOT DISAGREE, because they are the same sentence.
 *
 * `doctor` reads its own credential (the identity check) and used to print an
 * unconditional "with the identity key on disk this signs in rather than
 * creating anything" from a completely separate place — so on a machine with a
 * bound profile and no identity, its own two checks contradicted each other
 * and the session remedy told the operator to do the destructive thing.
 */
describe('doctor prints the same forecast the refusal does', () => {
  it('does not tell an account with no credential to register', async () => {
    const name = 'resdoctor';
    await boundIntegrationWithBadToken(name);
    unlinkSync(identityFile(name));

    const doc = await runCli(['doctor', name, '--json']);
    const lines = doc.stdout.trim().split('\n').filter(Boolean);
    const results = lines.map((l) => JSON.parse(l) as { check: string; ok: boolean; remedy?: string });
    const identity = results.find((r) => r.check === 'identity')!;
    const session = results.find((r) => r.check === 'session')!;

    // The premise: doctor agrees there is no identity.
    expect(identity.ok, 'the premise is missing — doctor found an identity').toBe(false);

    // THE ASSERTION: the session remedy may not contradict it.
    expect(session.ok).toBe(false);
    expect(
      session.remedy ?? '',
      'the session remedy promised a sign-in while the identity check said there is no key',
    ).not.toMatch(/signs in( and replaces the token)? rather than creating/i);
    expect(session.remedy ?? '', 'the session remedy did not warn about minting').toMatch(
      /new account/i,
    );
  }, 180_000);

  /**
   * an earlier review: A NON-NULL BLOB IS NOT A RESOLVING
   * CREDENTIAL.
   *
   * An earlier revision gave the identity line the predicate every operational read
   * applies (`identityLoads` — parse, require a numeric registrationId, and
   * `IdentityKeyPair.deserialize` the base64). The FORECAST was left asking
   * `blob !== null`, so the two readings of the one read came apart again in
   * the state that matters most: doctor printed identity FAILURE and, one
   * line below, a session remedy promising that `tacendum register` would
   * present that key and sign in — for a credential registration is about to
   * refuse with the same error. That is the exact contradiction `forecastFrom`
   * exists to make impossible, arriving through the other predicate.
   *
   * The operator's path, end to end: read the remedy, then run the thing it
   * would have sent them to, and require the remedy to have described what
   * actually happens.
   */
  it('does not promise a sign-in on a credential the LOADER refuses — the forecast applies the identity line’s own predicate', async () => {
    const name = 'resdoctorjunk';
    const was = await boundIntegrationWithBadToken(name);

    // Present, non-null, and it will not load: the right shape with bytes
    // libsignal will not deserialize — `gate.doctor-identity-conformance`'s
    // corpus case, put in front of the forecast.
    writeFileSync(
      identityFile(name),
      JSON.stringify({ identityKeyPair: 'junk', registrationId: 1 }),
      { mode: 0o600 },
    );

    const doc = await runCli(['doctor', name, '--json']);
    const results = doc.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { check: string; ok: boolean; remedy?: string });
    const identity = results.find((r) => r.check === 'identity')!;
    const session = results.find((r) => r.check === 'session')!;

    // The premise: the identity line already refuses this credential.
    expect(identity.ok, 'the premise is missing — doctor accepted the junk credential').toBe(false);
    expect(session.ok).toBe(false);
    const remedy = session.remedy ?? '';

    // GROUND TRUTH: registration refuses it too, and nothing on disk moved.
    const again = await runCli(['register', name]);
    expect(again.code, 'the premise changed — registration accepted the junk credential').not.toBe(
      0,
    );
    const after = stored(name);
    expect(after.userId, 'the account was replaced by a run that was supposed to refuse').toBe(was);
    expect(after.ownerUserId, 'the binding did not survive the refused registration').toBe(OWNER);

    // THE ASSERTION: the forecast may not have sent the operator there.
    expect(
      remedy,
      'the session remedy told the operator to register, and registration refuses',
    ).not.toMatch(/run: tacendum register/i);
    expect(
      remedy,
      'the session remedy promised a sign-in the credential cannot deliver',
    ).not.toMatch(/register presents that key/i);
    // …and it says the same thing the identity line says, because it is the
    // same finding about the same bytes.
    expect(remedy, 'the remedy did not tell the operator to stop').toMatch(/do NOT register/i);
    expect(remedy, 'the remedy did not name the identity line’s own fix').toMatch(
      /restore identity\.json from backup/i,
    );
  }, 180_000);
});

/**
 * an earlier review: "RESTORE identity.json FROM BACKUP" IS FALSE
 * WHEN THE KEYCHAIN IS THE AUTHORITATIVE COPY.
 *
 * `credential-unusable` is the outcome for a credential that RESOLVES and does
 * not LOAD, and its advice was the identity line's, verbatim in substance:
 * restore identity.json. On a file-backend machine that is exactly right. On a
 * machine with a keychain backend recorded it is advice the operator can follow
 * to the letter with no effect at all, and this is not a contrived arrangement
 * — it is what the product does on its own:
 *
 *   - the once-per-command migration hook (`requireAccount` in main.ts ->
 *     `maybeMigrateCredential`) reads identity.json with `readFileSync`,
 *     hex-encodes it and stores it. It never parses it. A malformed credential
 *     migrates exactly as happily as a good one;
 *   - `recordBackend` then names the keychain, and `readCredential` step 1
 *     answers from the item and RETURNS — the retained file is not consulted at
 *     all when the item decodes;
 *   - so the restored file is never read again, by any command, and every one
 *     of them goes on refusing the same malformed bytes.
 *
 * The advice is now backend-aware, and this case is the proof rather than the
 * assertion: it drives the whole path — corrupt, let the hook migrate, restore
 * the file — then requires (a) that the migration really did copy malformed
 * bytes into the keychain, (b) that a restored identity.json changes nothing,
 * (c) that doctor's remedy names the keychain and the command that repairs it,
 * and (d) that running THAT command actually fixes the machine.
 */
interface DoctorLine {
  check: string;
  ok: boolean;
  remedy?: string;
}
const doctorLines = (r: { stdout: string }): DoctorLine[] =>
  r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DoctorLine);
const remedyOf = (r: { stdout: string }, check: string): string =>
  doctorLines(r).find((l) => l.check === check)?.remedy ?? '';

describe('the unusable-credential remedy names the copy commands actually read', () => {
  it('sends the operator to the keychain when the keychain is what holds the bad bytes', async () => {
    const name = 'reskeychainjunk';
    const keychainEnv = { TACENDUM_CREDENTIAL_STORE: 'linux-libsecret' };

    // The same starting state as the case above — a bound integration whose
    // stored token an older build downgraded — because that is the branch on
    // which doctor's SESSION line renders `forecast.advice`, and the advice is
    // what is under test. The credential and the token are independent faults;
    // the forecast answers the credential one first (`forecastFrom`'s order),
    // so what prints here is the `credential-unusable` advice.
    await boundIntegrationWithBadToken(name);
    // The operator's backup — the bytes "restore identity.json" would put back.
    // Taken before the corruption; the token downgrade does not touch this file.
    const backup = readFileSync(identityFile(name), 'utf8');

    // A credential that is PRESENT and does not LOAD: right shape, bytes
    // libsignal will not deserialize (the conformance corpus's own case).
    const junk = JSON.stringify({ identityKeyPair: 'junk', registrationId: 1 });
    writeFileSync(identityFile(name), junk, { mode: 0o600 });

    // THE FILE-BACKEND ANSWER FIRST, so what follows is a branch on where the
    // bytes live rather than a new sentence for everybody. Here identity.json
    // IS the copy every command reads, restoring it IS the whole recovery, and
    // naming a keychain command would be its own false advice.
    const onFile = remedyOf(await runCli(['doctor', name, '--json']), 'session');
    expect(onFile, 'the file backend lost its own recovery').toMatch(
      /Restore identity\.json from backup/,
    );
    expect(onFile, 'the file backend was sent to a keychain it does not use').not.toMatch(
      /--migrate/,
    );

    // NO BACKEND RECORDED YET — the shipping state, and the state the whole
    // sequence needs: `migrateCredential` answers 'already' for any recorded
    // marker it is not forced past, so an account that has met a keychain is
    // past this door. The register and pair steps above wrote a `file` marker
    // only because this harness pins every step to the file store; a box that
    // simply had no keychain when the account was created has none at all.
    unlinkSync(markerFile(name));

    // The product migrates it, unprompted, on the next command that names the
    // account — no flag, no parse, no validation. `requireAccount` (main.ts)
    // runs the hook BEFORE the command body, so the migration happens whatever
    // that command then makes of the downgraded token; its exit code is not
    // what is being observed here, the marker is.
    await runCli(['whoami', name, '--json'], keychainEnv);
    const marker = JSON.parse(readFileSync(markerFile(name), 'utf8')) as { backend?: string };
    expect(marker.backend, 'the migration hook never recorded a keychain backend').toBe(
      'linux-libsecret',
    );
    // (a) THE MECHANISM, asserted rather than assumed: the keychain item holds
    // the MALFORMED bytes, byte for byte. Nothing parsed them on the way in.
    const items = readdirSync(fakeKeychain)
      .map((f) => readFileSync(join(fakeKeychain, f), 'utf8').trim())
      .map((hex) => (/^(?:[0-9a-f]{2})+$/.test(hex) ? Buffer.from(hex, 'hex').toString('utf8') : ''));
    expect(items, 'the migration did not byte-copy the malformed credential').toContain(junk);

    // The operator follows the old advice, exactly.
    writeFileSync(identityFile(name), backup, { mode: 0o600 });

    const doc = await runCli(['doctor', name, '--json'], keychainEnv);
    const results = doctorLines(doc);
    const identity = results.find((r) => r.check === 'identity')!;
    const session = results.find((r) => r.check === 'session')!;

    // (b) THE RESTORED FILE CHANGED NOTHING. doctor validates the copy commands
    // read (`readCredential`), and it is still the keychain's.
    expect(
      identity.ok,
      'the premise is gone — the restored file answered, so the advice was never false',
    ).toBe(false);

    // (c) THE ASSERTION, on both renderings of the one read: the session
    // forecast and the identity line's own remedy.
    //
    // The wording moved in an earlier review, and the reason belongs
    // here because this test is what pinned the old one. The remedy is
    // phrased from the MARKER'S RECORDED backend, which is where a read is
    // TRIED first — and in the state THIS test builds (the item holds the
    // malformed bytes and decodes) that is also where the bytes came from, so
    // the unconditional "the unusable bytes are in the <backend> ITEM …
    // restoring the file ALONE changes nothing" was true. It is NOT true of
    // the sibling state — a recorded keychain whose lookup FAILS falls
    // through to the retained identity.json, and then the same sentence
    // printed beside a credential line saying the fallback file covers reads
    // (gate.answering-copy.test.ts builds that one). One paragraph now has to
    // hold in both, so what is asserted here is the recorded backend, the
    // "file alone is not enough" half, and the command — not a sentence that
    // silently picks one of the two copies.
    for (const [what, remedy] of [
      ['session', session.remedy ?? ''],
      ['identity', identity.remedy ?? ''],
    ] as const) {
      expect(
        remedy,
        `the ${what} remedy does not name the recorded backend whose item commands read first`,
      ).toMatch(/linux-libsecret backend is recorded/);
      expect(
        remedy,
        `the ${what} remedy does not say that restoring the file alone is not enough`,
      ).toMatch(/Restoring the FILE alone is not enough while the item is readable/);
      expect(
        remedy,
        `the ${what} remedy does not name the command that repairs the item`,
      ).toMatch(/tacendum credential <name> --migrate/);
    }
    expect(session.remedy ?? '', 'the forecast is not the unusable-credential one').toMatch(
      /do NOT register/i,
    );

    // (d) AND THE NAMED RECOVERY ACTUALLY RECOVERS. If this stops working the
    // advice becomes false again in the other direction. `--migrate` alone: the
    // parser is strict, so an invented `--force` would exit USAGE, and the
    // command forces on its own.
    const repair = await runCli(['credential', name, '--migrate'], keychainEnv);
    expect(repair.code, `credential --migrate stderr was:\n${repair.stderr}`).toBe(0);
    const identityAfter = doctorLines(await runCli(['doctor', name, '--json'], keychainEnv)).find(
      (r) => r.check === 'identity',
    )!;
    expect(
      identityAfter.ok,
      'the remedy named an operation that does not repair the machine',
    ).toBe(true);
  }, 180_000);
});
