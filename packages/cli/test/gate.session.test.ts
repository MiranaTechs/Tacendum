import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-session-'));
process.env.TACENDUM_HOME = home;
// A placeholder the PARENT never dials; the children get the real port.
process.env.TACENDUM_API = 'http://gate-session.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { AuthSession } = await import('../src/session.js');
const { saveProfile, loadProfile } = await import('../src/profile.js');
const { CliError, EXIT } = await import('../src/exit.js');

const NAME = 'ci-bot';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/**
 * Concurrent mints across PROCESSES.
 *
 * The server revokes every prior session on each successful auth
 * (`auth-account.ts`): one account, one live token. Two `tacendum send`
 * processes — a `make -j` fan-out on the day the fleet's sessions expire —
 * both load the same expired profile before either writes, and both mint.
 * The second mint kills the first's token, and whichever profile write lands
 * LAST can leave the REVOKED token as the shared on-disk value, so the next
 * invocation starts dead.
 *
 * Real child processes, as in gate.lock.test.ts: the property is mutual
 * exclusion between processes, and a single Node process serializes itself
 * anyway, so an in-process version would prove nothing.
 */
describe('gate: token renewal is serialized across processes', () => {
  // Minted at REQUEST ARRIVAL, held before SENDING: the defect's window is a
  // response in flight while a second process auths, so the token (and the
  // revocation of its predecessor) must exist server-side the moment the
  // request lands, with only the reply delayed.
  let authCalls = 0;
  let challengeCalls = 0;
  let live = '';
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/v1/auth/challenge') {
        challengeCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            challenge: Buffer.from('nonce').toString('base64'),
            expiresAt: Math.floor(Date.now() / 1000) + 120,
          }),
        );
        return;
      }
      if (req.url === '/v1/auth') {
        authCalls += 1;
        live = `fresh-${authCalls}`; // every mint revokes the one before
        const body = JSON.stringify({ userId: USER_ID, authToken: live });
        const send = (token: string): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(token);
        };
        // The FIRST response is held for 2s — long past the point where the
        // second process, released by the barrier below, re-reads the profile.
        // Unserialized, that re-read still finds the stale token (the winner
        // has not saved yet) and mints; serialized, the loser is parked on
        // auth.lock for these 2s and adopts the winner's write instead.
        if (authCalls === 1) setTimeout(() => send(body), 2000);
        else send(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  it('one mint, one shared token, and the on-disk token is the LIVE one', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const stores = new FileStores(NAME);
    const upload = await generateAndStoreKeys(stores);
    saveProfile({
      name: NAME,
      identityKey: upload.identityKey,
      userId: USER_ID,
      authToken: 'expired-30-days-ago',
      registrationId: upload.registrationId,
      deviceId: 1,
    });

    // Both children load the expired profile, rendezvous on the barrier
    // directory, and only THEN renew — so both are provably past the read
    // before either can write, whatever their tsx startup skew was. That is
    // the exact interleaving the pre-lock disk re-read could not survive.
    const barrier = join(home, 'barrier');
    const sessionModule = fileURLToPath(new URL('../src/session.ts', import.meta.url));
    const storesModule = fileURLToPath(new URL('../src/stores.ts', import.meta.url));
    const script = join(home, 'child.mjs');
    writeFileSync(
      script,
      `import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
       import { join } from 'node:path';
       import { AuthSession } from ${JSON.stringify(sessionModule)};
       import { FileStores } from ${JSON.stringify(storesModule)};
       const auth = new AuthSession(${JSON.stringify(NAME)}, new FileStores(${JSON.stringify(NAME)}));
       mkdirSync(${JSON.stringify(barrier)}, { recursive: true });
       writeFileSync(join(${JSON.stringify(barrier)}, String(process.pid)), '');
       const deadline = Date.now() + 20000;
       while (readdirSync(${JSON.stringify(barrier)}).length < 2) {
         if (Date.now() > deadline) { console.error('sibling never arrived'); process.exit(1); }
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
       }
       process.stdout.write(await auth.reauth());`,
    );

    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
          stdio: 'pipe',
          env: { ...process.env, TACENDUM_HOME: home, TACENDUM_API: base },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`)),
        );
      });

    const [tokenA, tokenB] = await Promise.all([run(), run()]);

    // One auth for two processes. Unserialized this is 2, and the second
    // revokes the first — the make -j failure this gate pins.
    expect(authCalls).toBe(1);
    expect(challengeCalls).toBe(1);
    // Both commands proceed with the SAME token, so neither retries with one
    // the server already killed.
    expect(tokenA).toBe(live);
    expect(tokenB).toBe(live);
    // And the shared on-disk value is the live token — a late write of the
    // revoked one would make the NEXT invocation start dead.
    expect(loadProfile(NAME).authToken).toBe(live);
  }, 60_000);
});

describe('gate: disk adoption enforces the userId assertion', () => {
  it('refuses to adopt a token whose on-disk profile names a NEW userId', async () => {
    // The network path asserts userId is unchanged (constraint 2); the
    // disk-adoption branch used to adopt the whole profile unexamined, so a
    // re-registered name handed this process a token for an account its
    // sessions/ and identities/ are not keyed to.
    const name = 'ci-bot-adopt';
    const base = {
      name,
      identityKey: 'ZGlzcGxheS1vbmx5',
      userId: USER_ID,
      authToken: 'expired-30-days-ago',
      registrationId: 7,
      deviceId: 1,
    };
    saveProfile(base);
    const auth = new AuthSession(name, new FileStores(name));

    saveProfile({ ...base, userId: '01BOBBOBBOBBOBBOBBOBBOBBOB', authToken: 'minted-by-the-new-account' });

    const err = await auth.reauth().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as InstanceType<typeof CliError>).exitCode).toBe(EXIT.AUTH);
    expect((err as InstanceType<typeof CliError>).slug).toBe('account_gone');
    // Nothing adopted: the session still speaks for the account its stores
    // are keyed to.
    expect(auth.userId).toBe(USER_ID);
    expect(auth.token()).toBe('expired-30-days-ago');
  });
});
