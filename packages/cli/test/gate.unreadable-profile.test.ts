import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A FAILED READ IS NEVER EVIDENCE THAT THE PROFILE IS GONE — and the command
 * that acts on the mistake is the one that DESTROYS something.
 *
 * profile.json is the only local record of what an account IS: its class, and
 * the owner an integration was paired with. `cmdRegister` carries those
 * forward from `tryLoadProfile`, which answers `null` for a file it merely
 * could not READ — a mode, an owner, a truncated write, a synced home that
 * dropped a 0600 file. So a recoverable state (fix the file, everything is
 * still there) was turned into an unrecoverable one by the very command
 * `doctor` recommended: registration rewrote the profile with no
 * `ownerUserId`, and the server went on holding the write-once binding while
 * every local surface said the integration was unbound.
 *
 * The gate log recorded this as a wrong REMEDY over a correct refusal, with
 * "nothing is destroyed" beside it. Both halves were false.
 *
 * THIS TEST IS THE OPERATOR'S PATH, end to end through the real binary:
 * corrupt the file, ask doctor what to do, do it, and read what survived.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-unreadable-'));

/** 26 characters of Crockford base32 — the shape `isUserId` accepts, with I,
 * L, O and U absent as the alphabet requires. */
const OWNER = '01WNER0NREAD0GATE0000000ZZ';

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
        challenge: Buffer.from('unreadable-challenge').toString('base64'),
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
          userId: `01NREAD${String(minted).padStart(2, '0')}ZZZZZZZZZZZZZZZZZ`,
          integration: parsed.accountClass === 'integration',
        };
        accounts.set(key, row);
      }
      return json(200, {
        userId: row.userId,
        authToken: `tok-unread-${Math.random().toString(36).slice(2, 10)}`,
        ...(row.integration ? { accountClass: 'integration' as const } : {}),
      });
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') return json(200, {});
    if (req.method === 'POST' && req.url === '/v1/integrations/bind') {
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

/** A profile a crash truncated mid-write: the file is there, it is 0600, it is
 * owned by us, and it is not a document. Chosen over `chmod 000` because a
 * suite that happens to run as root would silently stop exercising the
 * state — this one is unreadable to everybody. */
const TRUNCATED = '{"name":"bindkeep","userId":"01NREAD01ZZZZZZZZZZZZZZZZZ","authT';

describe('a profile that will not READ is never treated as a profile that is GONE', () => {
  it('doctor names the state and does NOT tell the operator to register', async () => {
    const name = 'bindkeep';
    expect((await runCli(['register', name, '--integration'])).code).toBe(0);
    expect((await runCli(['pair', name, OWNER])).code).toBe(0);
    const good = readFileSync(profileFile(name), 'utf8');
    expect(JSON.parse(good).ownerUserId, 'the premise is missing — nothing was bound').toBe(OWNER);

    writeFileSync(profileFile(name), TRUNCATED, { mode: 0o600 });

    const doc = await runCli(['doctor', name, '--json']);
    const lines = doc.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { check: string; ok: boolean; detail: string; remedy?: string });
    const session = lines.find((l) => l.check === 'session');
    expect(session, 'doctor printed no session line').toBeDefined();

    // IT SAYS WHAT IS TRUE. "no profile" is the sentence that made the next
    // command destructive, so it must not be the sentence.
    expect(session!.ok).toBe(false);
    expect(session!.detail).not.toMatch(/^no profile/);
    expect(session!.detail).toMatch(/could not be READ/i);
    // AND THE REMEDY IS NOT "REGISTER". The whole of an earlier finding is that an
    // operator followed this string.
    expect(session!.remedy, 'doctor still recommends the destructive command').toMatch(
      /do NOT register/i,
    );
    expect(session!.remedy).toMatch(/owner|paired|binding/i);
  }, 180_000);

  it('register REFUSES rather than overwriting it, and the file is untouched', async () => {
    const name = 'bindkeep';
    const before = readFileSync(profileFile(name), 'utf8');
    expect(before, 'the previous test left the wrong fixture').toBe(TRUNCATED);

    const again = await runCli(['register', name]);
    expect(again.code, 'register wrote over a profile it could not read').not.toBe(0);

    // THE FILE IS THE ASSERTION, not the exit code: a refusal that still
    // truncated the file would have the same status.
    expect(readFileSync(profileFile(name), 'utf8')).toBe(before);
  }, 180_000);

  it('…so repairing the file brings the binding back — it was never lost', async () => {
    const name = 'bindkeep';
    // What "recoverable" means: the operator fixes whatever made the file
    // unreadable (here, restoring the bytes) and the account is whole.
    const restored = JSON.stringify(
      {
        name,
        identityKey: JSON.parse(
          readFileSync(join(home, name, 'identity.json'), 'utf8'),
        ).identityKeyPair.slice(0, 44),
        userId: '01NREAD01ZZZZZZZZZZZZZZZZZ',
        authToken: 'tok-unread-restored',
        registrationId: 1,
        deviceId: 1,
        accountClass: 'integration',
        ownerUserId: OWNER,
      },
      null,
      2,
    );
    writeFileSync(profileFile(name), restored, { mode: 0o600 });

    const after = await runCli(['register', name]);
    expect(after.code, `register stderr was:\n${after.stderr}`).toBe(0);
    const stored = JSON.parse(readFileSync(profileFile(name), 'utf8')) as {
      ownerUserId?: string;
      accountClass?: string;
    };
    expect(stored.ownerUserId, 'the binding did not survive a readable re-registration').toBe(
      OWNER,
    );
    expect(stored.accountClass).toBe('integration');
  }, 180_000);
});
