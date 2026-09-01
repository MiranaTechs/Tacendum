import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * the two cmdRegister release-blockers, both introduced by the previous
 * round's fix that widened the RATCHET lock to span the whole registration.
 *
 *  (1) Network I/O inside the ratchet lock starved the receive path: a
 *      registration response slower than the 10s lock budget made a live
 *      listener's ratchet acquisition time out, after which CallSession's
 *      broad decrypt catch marked the frame seen and ACKed it away
 *      undecrypted — reachable message loss, produced on demand by one
 *      drip-fed registration. The fix moves the network hold to a
 *      register-only lock the receive path never takes.
 *  (2) Registration minted its token OUTSIDE auth.lock, so it and a
 *      concurrent command's renewal revoked each other, and its late
 *      profile save could overwrite a rival's fresh token with an
 *      already-revoked one.
 *
 * Real child process against a local mock API, same shape as
 * gate.main-mcp.test.ts and for the same reason: both properties live across
 * the process's network round trips — what is HELD while a response is in
 * flight — and main.ts self-executes on import, so an in-process test could
 * see neither.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-reglock-'));
process.env.TACENDUM_HOME = home;

// lock.js is config-free; imported (not reimplemented) so the probe below
// contends exactly the way a concurrent listener's decrypt would.
const { withFileLockAsync } = await import('../src/lock.js');

/**
 * A lock is a DIRECTORY whose holder is a single-use entry named
 * `<12-digit seq>.<32-hex nonce>`. The directory is the
 * waiting room and outlives every holder, so `existsSync(lock)` is true from
 * the first acquisition onward and distinguishes nothing; "held" means an
 * entry is present inside it. Duplicated rather than imported: a test that
 * reads the rule off the code under test cannot catch the code changing it.
 */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;
function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath).filter((name) => ENTRY_RE.test(name));
  } catch {
    return [];
  }
}

const STALL_NAME = 'reglockbot';
const ORDER_NAME = 'regorderbot';
const USER_ID = '01REGB0TREGB0TREGB0TREGB0T';

/**
 * The observations are taken BY THE SERVER (or while the child is blocked on
 * its response), so they race nothing: the child cannot move while the reply
 * it is awaiting has not been sent.
 */
const gate = {
  stallUpload: false,
  authToken: 'tok-unset',
  calls: { challenge: 0, auth: 0, keys: 0 },
  uploadArrived: null as (() => void) | null,
  releaseUpload: null as Promise<void> | null,
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
    gate.calls.challenge += 1;
    json(200, {
      challenge: Buffer.from('reglock-challenge').toString('base64'),
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/auth') {
    gate.calls.auth += 1;
    json(200, { userId: USER_ID, authToken: gate.authToken });
    return;
  }
  if (req.method === 'PUT' && req.url === '/v1/keys') {
    gate.calls.keys += 1;
    if (gate.stallUpload) {
      gate.uploadArrived?.();
      await gate.releaseUpload;
    }
    json(200, {});
    return;
  }
  json(404, { error: { code: 'not_found', detail: `no route ${req.method} ${req.url}` } });
}

const server = createServer((req, res) => {
  // Drain the body first; undici will not hand over the response while the
  // request stream is unconsumed.
  req.on('data', () => {});
  req.on('end', () => void handle(req, res));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, TACENDUM_HOME: home, TACENDUM_API: apiBase, NODE_USE_SYSTEM_CA: '0' },
      },
    );
    child.stdin.end();
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe('registration holds no ratchet lock across the wire', () => {
  it('leaves ratchet.lock takeable mid-upload, keeps register.lock held, and never resurrects a superseded token', async () => {
    gate.stallUpload = true;
    gate.authToken = 'tok-minted-by-register';
    const uploadArrived = new Promise<void>((resolve) => (gate.uploadArrived = resolve));
    let releaseUpload!: () => void;
    gate.releaseUpload = new Promise<void>((resolve) => (releaseUpload = resolve));

    const child = runCli(['register', STALL_NAME]);
    await uploadArrived;
    // From here to releaseUpload() the child is parked awaiting our response:
    // every assertion below observes a process that cannot move.
    let result: { code: number | null; stderr: string };
    try {
      // (1) The receive path's lock must be FREE during the network phase.
      // Under the reverted code the child — a live pid, immune to the stale
      // steal — holds ratchet.lock here, so this acquisition burns its full
      // 10s budget and throws: exactly the timeout a concurrent listener hit
      // before its broad catch ACKed a valid frame away undecrypted.
      const probe = await withFileLockAsync(
        join(home, STALL_NAME, 'ratchet.lock'),
        async () => 'acquired',
      );
      expect(probe).toBe('acquired');

      // (2) Rival REGISTRATIONS, by contrast, are still serialized — the
      // register-only lock spans the upload, so no rival can rotate (pruning
      // this batch's private halves) or supersede this PUT before it lands.
      // That is the F1 property the ratchet-lock widening was trying to buy.
      // A holder ENTRY, not the directory: the directory is left behind by
      // any past acquisition, so asserting on it would pass just as happily
      // against a register that took the lock and dropped it before the PUT.
      expect(holderEntries(join(home, STALL_NAME, 'register.lock'))).toHaveLength(1);

      // (3) The mint's profile write happened under auth.lock BEFORE the
      // upload — not after it. A save deferred to after the upload could land
      // on top of a rival's fresher mint and put an already-revoked token
      // back on disk as the shared value.
      const profilePath = join(home, STALL_NAME, 'profile.json');
      expect(existsSync(profilePath), 'profile must be saved before the upload').toBe(true);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { authToken: string };
      expect(profile.authToken).toBe('tok-minted-by-register');

      // A rival command 401s and mints T2 while our upload is in flight, as
      // AuthSession.mint() would write it. Registration must leave it alone.
      writeFileSync(
        profilePath,
        JSON.stringify({ ...profile, authToken: 'tok-minted-by-rival' }),
        { mode: 0o600 },
      );
    } finally {
      releaseUpload();
      result = await child;
    }
    expect(result.code, `stderr was:\n${result.stderr}`).toBe(0);
    const final = JSON.parse(readFileSync(join(home, STALL_NAME, 'profile.json'), 'utf8')) as {
      authToken: string;
    };
    expect(final.authToken).toBe('tok-minted-by-rival');
  }, 120_000);
});

describe('registration mints under the per-account auth lock', () => {
  it('touches no auth route while another process holds auth.lock', async () => {
    gate.stallUpload = false;
    gate.authToken = 'tok-ordered-mint';
    gate.calls = { challenge: 0, auth: 0, keys: 0 };

    // Hold auth.lock the way AuthSession.mint() does — same file, live pid.
    mkdirSync(join(home, ORDER_NAME), { recursive: true, mode: 0o700 });
    let releaseAuthLock!: () => void;
    const held = new Promise<void>((resolve) => (releaseAuthLock = resolve));
    const hold = withFileLockAsync(join(home, ORDER_NAME, 'auth.lock'), () => held);

    const child = runCli(['register', ORDER_NAME]);
    let result: { code: number | null; stderr: string };
    try {
      // Rotation is local and owes auth.lock nothing; its last write is the
      // durable high-water mark. Once that lands the child's next step is the
      // mint, so give it ample time to reach the wire if it is going to.
      await waitFor(
        () => existsSync(join(home, ORDER_NAME, 'prekeys', 'next-id.json')),
        'the child to finish its local key generation',
      );
      await sleep(1500);
      // The property: with auth.lock held by a live process, registration has
      // signed NOTHING. Under the reverted code the challenge — and the mint
      // that revokes whatever token the lock holder just wrote — is already
      // on the wire by now, which is how a register and a renewal revoked
      // each other's tokens. Under the fix this cannot flake: the child would
      // have to acquire the very lock we are holding first.
      expect(gate.calls.challenge).toBe(0);
      expect(gate.calls.auth).toBe(0);
    } finally {
      // Well inside the child's 10s lock budget: waitFor returns within 50ms
      // of the mark landing, and the child starts queueing on auth.lock then.
      releaseAuthLock();
      await hold;
      result = await child;
    }
    expect(result.code, `stderr was:\n${result.stderr}`).toBe(0);
    expect(gate.calls.auth).toBe(1);
    const profile = JSON.parse(readFileSync(join(home, ORDER_NAME, 'profile.json'), 'utf8')) as {
      authToken: string;
      userId: string;
    };
    expect(profile.authToken).toBe('tok-ordered-mint');
    expect(profile.userId).toBe(USER_ID);
  }, 120_000);
});
