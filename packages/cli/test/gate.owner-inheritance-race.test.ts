import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * OWNER INHERITANCE MUST BE DECIDED FROM A READ THE SAVE'S OWN LOCK COVERS.
 *
 * `cmdRegister` overwrites profile.json unconditionally, and everything the new
 * record keeps of the old one — the account class, and the `ownerUserId` a
 * paired integration is bound with — comes from a read of that file. The read
 * was gated on `returning`, a snapshot of `stores.identity.exists()` taken at
 * the very top of the command, BEFORE `register.lock` is acquired
 *.
 *
 * THE RACE, in the shape an operator actually meets it. Two first-runs for the
 * same account start together — a cron wrapper and a human, `setup` and
 * `register`, two CI steps. Both snapshot "no identity here". One wins the
 * lock, registers, and is paired, which writes `ownerUserId`. The loser then
 * takes the lock, finds the winner's identity and authenticates as the SAME
 * userId — and skips the profile read entirely, because its snapshot said
 * there was nothing to read. `saveProfile` writes a record with no owner.
 *
 * The server is untouched: `bind` is write-once and the account stays bound.
 * So this is purely local amnesia, and it is invisible from every server-side
 * check — `whoami` starts answering `boundTo: null` and the MCP server stops
 * advertising a send tool, on a machine whose pairing is fine.
 *
 * HOW THE INTERLEAVING IS MADE DETERMINISTIC. Two real processes would decide
 * the outcome by timing, and a race that fails one run in fifty is not a gate.
 * What the loser holds at its save site is exactly this: `returning` false, and
 * on disk a profile carrying this account's userId and an `ownerUserId`. The
 * stub server produces that state at a point it can name — the loser's own
 * `POST /v1/auth/challenge`, which happens after the snapshot and before the
 * save — by writing the winner's paired profile itself. The challenge body
 * carries the identityKey the loser generated, so the planted record is this
 * account's, not a fixture's.
 *
 * BOTH HALVES, because the same read exists twice. `ensureIntegrationAccount`
 * (setup.ts) is `cmdRegister`'s duplicate by declared intent, and its `existing`
 * is read before `register.lock` too. Its half of this gate lives in
 * setup.test.ts, where the harness that can drive `cmdSetup` without touching
 * a real host config already is.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-ownerrace-'));

/** 26 Crockford characters each, first character under '8' so both are
 * canonical ULIDs — `qrPayload`'s rule, and what the server would mint. */
const BOT = '01B0TWNERRACEV1V0RB1NDSVRX';
const OWNER = '01WNERWNERRACEV1V0RB1NDSVR';

const ACCOUNT = 'ownerrace';

/** Set for the run under test: plant the winner's PAIRED profile at the moment
 * the loser asks for its challenge. */
let plantOnChallenge = false;
/** What the plant actually wrote, so an assertion can prove the premise. */
let planted: Record<string, unknown> | null = null;

const profileFile = (): string => join(home, ACCOUNT, 'profile.json');

function plantPairedProfile(identityKey: string): void {
  mkdirSync(join(home, ACCOUNT), { recursive: true, mode: 0o700 });
  const record = {
    name: ACCOUNT,
    identityKey,
    userId: BOT,
    // A perfectly usable token — this record is not damaged in any way, which
    // is the point: nothing about it invites being overwritten.
    authToken: 'tok-winner-ownerrace',
    registrationId: 4242,
    deviceId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  };
  writeFileSync(profileFile(), JSON.stringify(record, null, 2), { mode: 0o600 });
  planted = record;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += String(d)));
  req.on('end', () => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const parsed = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true });
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      // THE WINNER LANDS HERE. After the loser's `returning` snapshot (taken
      // at the top of cmdRegister) and before its `saveProfile` (inside
      // auth.lock, after the auth below).
      if (plantOnChallenge) plantPairedProfile(String(parsed.identityKey ?? ''));
      return json(200, {
        challenge: Buffer.from('ownerrace-challenge-32-bytes-ish').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
    }
    if (req.method === 'POST' && req.url === '/v1/auth') {
      // THE SAME userId every time — one account, returning. A different id
      // would make the inheritance guard (`previous.userId === minted.userId`)
      // decline on its own and prove nothing about the race.
      return json(200, {
        userId: BOT,
        authToken: `tok-ownerrace-${Math.random().toString(36).slice(2, 10)}`,
        accountClass: 'integration',
      });
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') return json(200, {});
    if (req.method === 'GET' && req.url === '/v1/me') return json(200, { userId: BOT });
    return json(404, { error: { code: 'not_found', detail: `no route ${req.method} ${req.url}` } });
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
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
        // The credential must stay in identity.json: a keychain backend would
        // put this fixture's key material in the developer's login keyring.
        TACENDUM_CREDENTIAL_STORE: 'file',
        NODE_USE_SYSTEM_CA: '0',
      },
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

beforeEach(() => {
  plantOnChallenge = false;
  planted = null;
  rmSync(join(home, ACCOUNT), { recursive: true, force: true });
});

describe('register decides inheritance from a read inside its own lock', () => {
  it('keeps the binding a concurrent first-run wrote after this one snapshotted "absent"', async () => {
    expect(existsSync(profileFile()), 'the premise needs a clean account').toBe(false);
    plantOnChallenge = true;

    const reg = await runCli(['register', ACCOUNT, '--integration']);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);

    // The premise, asserted rather than assumed: the winner's paired record
    // really was on disk before this process saved.
    expect(planted, 'the stub never planted the winner’s profile').not.toBeNull();
    expect(planted?.ownerUserId).toBe(OWNER);

    const stored = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    expect(
      stored.ownerUserId,
      'the loser’s save stripped the binding the winner had just written — the server still ' +
        'holds it, so nothing but this machine knows the integration came unbound',
    ).toBe(OWNER);
    expect(stored.userId, 'the account under test changed identity').toBe(BOT);
    expect(stored.accountClass).toBe('integration');
    // …and the TOKEN is this run's, not the planted one: inheritance must take
    // the binding forward without taking a stale credential with it.
    expect(stored.authToken, 'the planted token was carried forward').not.toBe(
      planted?.authToken,
    );
  }, 120_000);

  it('invents no owner when there was none — the liveness control', async () => {
    const reg = await runCli(['register', ACCOUNT, '--integration']);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    const stored = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    expect(stored.ownerUserId, 'an unbound registration acquired an owner').toBeUndefined();
    expect(stored.userId).toBe(BOT);

    // …and the ordinary returning sign-in still carries forward what IS there.
    writeFileSync(
      profileFile(),
      JSON.stringify({ ...stored, ownerUserId: OWNER }, null, 2),
      { mode: 0o600 },
    );
    const again = await runCli(['register', ACCOUNT]);
    expect(again.code, `register stderr was:\n${again.stderr}`).toBe(0);
    const back = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    expect(back.ownerUserId, 'a plain returning sign-in lost the binding').toBe(OWNER);
  }, 120_000);
});
