import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A REMEDY MUST BE TRUE OF THE MACHINE IT IS PRINTED ON.
 *
 * `gate.binding-survives-refusal.test.ts` pins the outcome the malformed-token
 * refusal PROMISES: register again, and the account comes back with its class
 * and its owner binding. That promise was stated UNCONDITIONALLY, and it holds
 * on exactly one of the two states an operator can be in when they read it.
 *
 * `cmdRegister` sets `returning` from ONE fact and nothing else —
 * `stores.identity.exists()`. With an identity, the re-register is a sign-in:
 * same `userId`, the server reports the stored class, and `previous` (whose
 * `userId` matches) donates the `ownerUserId`. WITHOUT one, the client
 * generates a FRESH keypair, the server sees an `idkey#` claim it has never
 * seen and MINTS A NEW ACCOUNT — new `userId`, ordinary class, no owner — and
 * `previous` is not even consulted (`returning ? tryLoadProfile(name) : null`).
 * The old account is still there, still bound, and nothing on this machine can
 * reach it any more.
 *
 * So an operator holding a bound integration whose identity is gone — a
 * partial restore, a cleaned directory, a synced home that dropped a 0600 file
 * — was told by our own refusal that the safe thing to do was the thing that
 * strands them. Following a remedy must not be how the damage happens.
 *
 * THE TEST IS THE OPERATOR'S PATH, twice, and it asserts the MESSAGE against
 * the OUTCOME rather than against a wording: run the remedy, read what
 * actually landed on disk, and require the refusal to have said that.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-remedy-'));

/** 26 characters of Crockford base32 — the alphabet the server mints in, with
 * I, L, O and U absent, so `isUserId` accepts it at the command line. */
const OWNER = '01WNER0REMEDY0GATE0000000Z';

/** What an older build could have left on disk: a token with a line break in
 * it, which Node refuses as a header value. The account around it is intact. */
const LEGACY_TOKEN = 'LEGACYREMEDY\nTAIL';

/**
 * The server's account table, keyed the way the real one is: by the identity
 * public key. A client that has lost its identity presents a NEW key and is
 * therefore a NEW account — that is the whole mechanism under test, and a mock
 * that returned a fixed userId would hide it.
 */
const accounts = new Map<string, { userId: string; integration: boolean }>();
let minted = 0;
const bound = new Set<string>();

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/health') {
      json(200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      json(200, {
        challenge: Buffer.from('remedy-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth') {
      const parsed = JSON.parse(body || '{}') as { identityKey?: string; accountClass?: string };
      const key = parsed.identityKey ?? '';
      let row = accounts.get(key);
      if (row === undefined) {
        // Birth. The class is declared once, here, and never revisited.
        minted += 1;
        row = {
          // 26 characters of Crockford base32, as the real server mints.
          userId: `01REMEDY${String(minted).padStart(2, '0')}ZZZZZZZZZZZZZZZZ`,
          integration: parsed.accountClass === 'integration',
        };
        accounts.set(key, row);
      }
      json(200, {
        userId: row.userId,
        authToken: `tok-remedy-${Math.random().toString(36).slice(2, 10)}`,
        ...(row.integration ? { accountClass: 'integration' as const } : {}),
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      json(200, {});
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/integrations/bind') {
      const parsed = JSON.parse(body || '{}') as { owner?: string };
      if (parsed.owner !== OWNER) {
        json(400, { error: { code: 'bad_request', detail: 'unexpected owner' } });
        return;
      }
      bound.add(OWNER);
      res.writeHead(204);
      res.end();
      return;
    }
    json(404, { error: { code: 'not_found', detail: `no route ${req.method} ${req.url}` } });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TACENDUM_HOME: home,
        TACENDUM_API: apiBase,
        TACENDUM_WS: apiBase.replace('http://', 'ws://'),
        NODE_USE_SYSTEM_CA: '0',
        // The identity lives in identity.json and NOWHERE else, so "delete the
        // file" is the whole of "the identity is gone". Without this the
        // preferred backend on a developer's mac is the OS keychain and the
        // fixture would be probing a real one.
        TACENDUM_CREDENTIAL_STORE: 'file',
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

const profileFile = (name: string): string => join(home, name, 'profile.json');
const identityFile = (name: string): string => join(home, name, 'identity.json');

interface Stored {
  userId?: string;
  authToken?: string;
  accountClass?: string;
  ownerUserId?: string;
}
const stored = (name: string): Stored => JSON.parse(readFileSync(profileFile(name), 'utf8')) as Stored;

/** Register a bound integration and then downgrade its token to the one an
 * older build would have left. Returns the userId the server gave it. */
async function boundIntegrationWithBadToken(name: string): Promise<string> {
  const reg = await runCli(['register', name, '--integration']);
  expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
  const pair = await runCli(['pair', name, OWNER]);
  expect(pair.code, `pair stderr was:\n${pair.stderr}`).toBe(0);
  const before = stored(name);
  expect(before.ownerUserId, 'the premise is missing — nothing was bound').toBe(OWNER);
  expect(before.accountClass, 'the premise is missing — not an integration').toBe('integration');
  writeFileSync(profileFile(name), JSON.stringify({ ...before, authToken: LEGACY_TOKEN }, null, 2), {
    mode: 0o600,
  });
  expect(stored(name).authToken, 'the fixture did not take').toBe(LEGACY_TOKEN);
  return before.userId!;
}

/**
 * WHAT THIS FILE ASSERTED THAT WAS ITSELF WRONG, recorded because the
 * correction reads like a loosening and is the opposite.
 *
 * The first arm below used to require the refusal to say "signs in rather than
 * creating anything" — i.e. to PROMISE a same-account sign-in — whenever an
 * identity key was on disk. Presence is not continuity. `cmdRegister`
 * authenticates whatever key it holds and declines to inherit the class and
 * the binding when the server answers with a different userId
 * (`previous?.userId === minted.userId`), so a profile sitting beside somebody
 * else's perfectly valid identity.json gets a successful registration, a
 * different account, and a silent local unbinding. Which of the two happens is
 * settled AT THE SERVER and cannot be known from this machine before
 * authenticating.
 *
 * So the requirement is no longer "promise the outcome". It is: name the
 * comparison, and describe BOTH outcomes and what each costs. A test that
 * demanded an assertion nobody can honestly make was pinning the defect in
 * place, which is why it is written down here rather than quietly edited.
 * `gate.remedy-resolver.test.ts` holds the different-key arm.
 */
describe('the malformed-token remedy is true of BOTH states it can be read in', () => {
  it('WITH the identity on disk: it describes the sign-in it delivers, and the alternative', async () => {
    const name = 'remedykept';
    const was = await boundIntegrationWithBadToken(name);
    expect(existsSync(identityFile(name)), 'the identity must be present for this arm').toBe(true);

    const refusal = await runCli(['sync', name]);
    expect(refusal.code, 'an unusable stored credential must be refused').not.toBe(0);
    const message = `${refusal.stdout}${refusal.stderr}`;
    expect(message, 'the credential was echoed').not.toContain('LEGACYREMEDY');

    // Follow it.
    const again = await runCli(['register', name]);
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const after = stored(name);

    // WHAT ACTUALLY HAPPENED, and only then what the message was allowed to say.
    expect(after.userId, 'a new account was minted for a client that still had its key').toBe(was);
    expect(after.accountClass).toBe('integration');
    expect(after.ownerUserId).toBe(OWNER);
    expect(after.authToken).not.toBe(LEGACY_TOKEN);

    // THE OUTCOME THAT LANDED HAS TO BE ONE THE MESSAGE DESCRIBED — the
    // sign-in branch, named as such, with the binding it keeps.
    expect(message, 'the refusal did not describe the sign-in it delivers').toMatch(
      /if they MATCH, this is a sign-in/i,
    );
    expect(message, 'the refusal did not say the binding survives that branch').toMatch(
      /owner binding|keeps its class/i,
    );
    // …AND THE OTHER OUTCOME TOO, because this machine cannot tell them apart
    // in advance. An operator who reads only the first branch and finds the
    // second has been misled by a message that was true of one run.
    expect(message, 'the refusal did not say what is compared').toMatch(/user id/i);
    expect(message, 'the refusal described only one of the two outcomes').toMatch(/if they DIFFER/i);
    // IT IS STILL AN INSTRUCTION, not a hedge: the imperative and the command
    // to confirm with are both present.
    expect(message).toMatch(/run: tacendum register/i);
    expect(message).toMatch(/tacendum whoami/i);
  }, 180_000);

  it('WITHOUT it: the remedy mints a NEW unbound account, and the refusal must say so', async () => {
    const name = 'remedylost';
    const was = await boundIntegrationWithBadToken(name);

    // The state the promise was never true of: the profile survived, the key
    // did not. A partial restore, a cleaned directory, a synced home that
    // dropped a 0600 file.
    unlinkSync(identityFile(name));
    expect(existsSync(identityFile(name))).toBe(false);
    expect(existsSync(profileFile(name)), 'the profile must survive — that is the state').toBe(true);

    const refusal = await runCli(['sync', name]);
    expect(refusal.code, 'an unusable stored credential must be refused').not.toBe(0);
    const message = `${refusal.stdout}${refusal.stderr}`;
    expect(message, 'the credential was echoed').not.toContain('LEGACYREMEDY');

    // Follow it, exactly as written.
    const again = await runCli(['register', name]);
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const after = stored(name);

    // WHAT ACTUALLY HAPPENED. This is not the fix — this is the ground truth
    // the message has to match, and it is why the message may not promise a
    // sign-in here.
    expect(after.userId, 'the premise changed: a new account was NOT minted').not.toBe(was);
    expect(after.accountClass, 'the premise changed: the class was inherited').toBeUndefined();
    expect(after.ownerUserId, 'the premise changed: the binding was inherited').toBeUndefined();

    // THE ASSERTION. The refusal is read before any of the above happens, and
    // it is the only warning the operator gets.
    expect(
      message,
      'the refusal promised a sign-in that cannot happen without an identity key',
    ).not.toMatch(/signs in rather than creating/i);
    expect(
      message,
      'the refusal promised that the account keeps its class and owner binding, which it does not',
    ).not.toMatch(/keeps its class and its owner binding/i);
    expect(message, 'the refusal did not warn that a NEW account would be created').toMatch(
      /new account/i,
    );
    expect(message, 'the refusal did not warn that the owner binding would be lost').toMatch(
      /binding/i,
    );
    expect(
      message,
      'the refusal did not name the thing to do FIRST — restoring the key',
    ).toMatch(/identity\.json/i);

    // AND IT IS STILL AN INSTRUCTION, not a hedge: the operator is told what
    // to do, in the imperative, on both arms.
    expect(message.toLowerCase()).toContain('register');
  }, 180_000);
});
