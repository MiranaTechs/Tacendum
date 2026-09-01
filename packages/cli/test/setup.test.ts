/**
 * `tacendum setup`, driven end-to-end.
 *
 * The flows are exercised through the REAL pieces wherever one exists: real
 * libsignal stores on both ends (a scripted "phone" peer with its own
 * identity), the real `attachInbound` policy, the real `WsClient` against a
 * mocked `ws` transport, and a stub HTTP server standing in for the API.
 * What the assertions read is what actually crossed the wire — the frames
 * the production code sent, decrypted with the peer's own ratchet — because
 * a test that re-implements the envelope it is testing tests nothing (the
 * ws-ticket suite's lesson, kept).
 *
 * The env vars and the stub server are set up at MODULE TOP LEVEL, before
 * any `../src` import: config.ts reads the environment once, at evaluation
 * (see ws-ticket-fallback.test.ts for the incident that made this rule).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';

/* ── the scripted socket ─────────────────────────────────── */

interface Scripted {
  sent: Array<Record<string, unknown>>;
  acks: string[];
  onListenOpen: ((sock: FakeSocketApi) => void) | null;
  /** Every socket dialled, in order, by role — the send-order cases assert
   * the two pairing messages share ONE 'send' dial. */
  dials: string[];
  /** Refuse every 'send'-role dial at the handshake (a plain network error,
   * not 401/403/503, so WsClient neither re-auths nor redials) — the
   * connect-before-ratchet cases stand on this. */
  refuseSendDials: boolean;
}
interface FakeSocketApi {
  deliver(frame: unknown): void;
}

const wsCtl = vi.hoisted(
  (): Scripted => ({ sent: [], acks: [], onListenOpen: null, dials: [], refuseSendDials: false }),
);

vi.mock('ws', () => {
  class FakeWebSocket implements FakeSocketApi {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    role: string;
    constructor(url: string) {
      // The role rides in the single-use ticket the stub minted (`t-listen`
      // / `t-send`), which is exactly how the real server learns it too.
      this.role = url.includes('t-listen') ? 'listen' : 'send';
      wsCtl.dials.push(this.role);
      setTimeout(() => {
        if (this.role === 'send' && wsCtl.refuseSendDials) {
          this.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));
          return;
        }
        this.emit('open');
        if (this.role === 'listen') wsCtl.onListenOpen?.(this);
      }, 0);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const h of [...(this.handlers[event] ?? [])]) h(...args);
    }
    deliver(frame: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(frame)));
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close(): void {}
    send(data: string): void {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type === 'send') {
        wsCtl.sent.push(frame);
        setTimeout(() => this.deliver({ type: 'receipt', msgId: frame.msgId, state: 'sent' }), 0);
      }
      if (frame.type === 'ack') wsCtl.acks.push(frame.msgId as string);
    }
  }
  return { default: FakeWebSocket };
});

/* ── a controllable saveProfile (F9a: the disk fails AFTER the bind) ────── */

const profileCtl = vi.hoisted(() => ({ failOwnerSave: false }));
vi.mock('../src/profile.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/profile.js')>();
  return {
    ...mod,
    saveProfile: (profile: { ownerUserId?: string }) => {
      // Fails exactly the save that records the pairing — the profile that
      // carries ownerUserId — leaving registration's own saves untouched.
      if (profileCtl.failOwnerSave && profile.ownerUserId !== undefined) {
        throw Object.assign(new Error('ENOSPC: no space left on device (injected)'), {
          code: 'ENOSPC',
        });
      }
      return mod.saveProfile(profile as never);
    },
  };
});

/* ── the stub API ────────────────────────────────────────── */

interface StubState {
  /** identityKey -> account. Class is set at creation, as the server does. */
  users: Map<string, { userId: string; integration: boolean }>;
  /** userId -> the last PUT /v1/keys body. */
  uploads: Map<string, Record<string, unknown>>;
  /** userId -> bundle served on GET /v1/keys/<id>. */
  bundles: Map<string, unknown>;
  authCalls: Array<Record<string, unknown>>;
  binds: Array<Record<string, unknown>>;
  /** Fail the next N PUT /v1/keys with 503 (F8). */
  failUploads: number;
  /** Fail the next N POST /v1/ws-ticket with 401 (F9b: forces a re-mint). */
  failTickets: number;
  /** How many GET /v1/keys/<id> were served — each one hands out (and on the
   * real server CONSUMES) one of that user's one-time prekeys, so the
   * send-order cases read this as "prekeys burned". */
  bundleGets: number;
  /**
   * Fired on POST /v1/auth/challenge with the identityKey that asked, so a
   * test can make something happen at a point INSIDE the command it is
   * driving: after `ensureIntegrationAccount`'s pre-lock profile read and
   * before the `saveProfile` that follows the auth. The owner-inheritance race
   * has no other deterministic seam — two real processes
   * decide it by timing.
   */
  onChallenge: ((identityKey: string) => void) | null;
}
const stub: StubState = {
  users: new Map(),
  uploads: new Map(),
  bundles: new Map(),
  authCalls: [],
  binds: [],
  failUploads: 0,
  failTickets: 0,
  bundleGets: 0,
  onChallenge: null,
};

const CHALLENGE = Buffer.from('a fixed 32-byte-ish challenge!!!').toString('base64');

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c as Buffer));
  req.on('end', () => {
    const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
    const reply = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? '';
    if (url === '/v1/auth/challenge') {
      stub.onChallenge?.(body.identityKey as string);
      return reply(200, { challenge: CHALLENGE, expiresAt: Math.floor(Date.now() / 1000) + 300 });
    }
    if (url === '/v1/auth') {
      stub.authCalls.push(body);
      const key = body.identityKey as string;
      let user = stub.users.get(key);
      if (!user) {
        user = { userId: ulid(), integration: body.accountClass === 'integration' };
        stub.users.set(key, user);
      }
      return reply(200, {
        userId: user.userId,
        authToken: `tok-${user.userId}`,
        ...(user.integration ? { accountClass: 'integration' } : {}),
      });
    }
    if (url === '/v1/keys' && req.method === 'PUT') {
      if (stub.failUploads > 0) {
        stub.failUploads -= 1;
        return reply(503, { error: { code: 'unavailable', detail: 'try again later' } });
      }
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      stub.uploads.set(token.replace('tok-', ''), body);
      return reply(200, {});
    }
    if (url === '/v1/integrations/bind') {
      stub.binds.push({ ...body, auth: req.headers.authorization });
      return reply(200, {});
    }
    if (url === '/v1/ws-ticket') {
      if (stub.failTickets > 0) {
        stub.failTickets -= 1;
        return reply(401, { error: { code: 'auth_failed', detail: 'session expired' } });
      }
      return reply(200, {
        ticket: `t-${body.role as string}`,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
    }
    if (url.startsWith('/v1/keys/') && req.method === 'GET') {
      stub.bundleGets += 1;
      const bundle = stub.bundles.get(url.slice('/v1/keys/'.length));
      if (bundle) return reply(200, bundle);
      return reply(404, { error: { code: 'not_found', detail: 'no key bundle for this user' } });
    }
    return reply(500, { error: { code: 'unexpected', detail: url } });
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

const home = mkdtempSync(join(tmpdir(), 'tacendum-setup-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.TACENDUM_WS = 'ws://127.0.0.1:1';

const { cmdSetup, profileCardBody, qrPayload, renderPairingQr } = await import('../src/setup.js');
const { CliError, EXIT, exitCodeFor } = await import('../src/exit.js');
const { FileStores } = await import('../src/stores.js');
const { decryptEnvelope, encryptText, establishSession, generateAndStoreKeys, hasSession } =
  await import('../src/messaging.js');
const { loadProfile, tryLoadProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

/** A quiet reporter: plain (no ANSI status), never a TTY concern. */
const report = () => new Reporter({ json: false, plain: true });

/** One "phone": its own real libsignal stores plus the bundle the stub
 * serves for it, so the CLI's X3DH bootstrap runs against genuine keys. */
async function makePhone(name: string): Promise<{ userId: string; stores: InstanceType<typeof FileStores> }> {
  const stores = new FileStores(name);
  const upload = await generateAndStoreKeys(stores);
  const userId = ulid();
  stub.bundles.set(userId, {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[0],
  });
  return { userId, stores };
}

function bundleFromUpload(userId: string, upload: Record<string, unknown>): unknown {
  const u = upload as {
    registrationId: number;
    identityKey: string;
    signedPrekey: unknown;
    kyberPrekey: unknown;
    oneTimePrekeys: unknown[];
  };
  return {
    userId,
    registrationId: u.registrationId,
    identityKey: u.identityKey,
    signedPrekey: u.signedPrekey,
    kyberPrekey: u.kyberPrekey,
    oneTimePrekey: u.oneTimePrekeys[0],
  };
}

let confDir: string;
let entry: string;
beforeEach(() => {
  confDir = mkdtempSync(join(tmpdir(), 'tacendum-setup-conf-'));
  entry = join(confDir, 'main.js');
  writeFileSync(entry, 'entry');
  wsCtl.sent = [];
  wsCtl.acks = [];
  wsCtl.onListenOpen = null;
  wsCtl.dials = [];
  wsCtl.refuseSendDials = false;
  stub.authCalls = [];
  stub.binds = [];
  stub.failUploads = 0;
  stub.failTickets = 0;
  stub.bundleGets = 0;
  stub.onChallenge = null;
  profileCtl.failOwnerSave = false;
});
afterEach(() => {
  rmSync(confDir, { recursive: true, force: true });
});

const io = (target: string, extra: Record<string, unknown> = {}) => ({
  hostConfig: { entryPath: entry, targetPath: join(confDir, target) },
  // Injected like hostConfig and for the same reason — an omitted seam sends
  // the write to homedir(). The vitest config pins HOME to a temp dir as the
  // backstop (it caught exactly this omission once), but determinism belongs
  // to the test: assertions about the voice read THIS path.
  voice: { targetPath: join(confDir, `voice-${target}.md`) },
  pollMs: 25,
  ...extra,
});

describe('the QR payload guardrail', () => {
  it('is the bare ULID, verbatim (upper-cased), and nothing else', () => {
    expect(qrPayload('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(qrPayload('01arz3ndektsv4rrffq69g5fav')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
  it('refuses anything URL-, scheme- or fragment-shaped', () => {
    for (const bad of [
      'https://tacendum.com/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'tacendum:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'tacendum://pair/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '01ARZ3NDEKTSV4RRFF…',
      '',
    ]) {
      expect(() => qrPayload(bad)).toThrow(CliError);
    }
  });
  it('refuses 26 base32 characters that are not a canonical ULID (F21)', () => {
    // A ULID's first character carries the top bits of the 48-bit timestamp
    // and is capped at '7' — 26 base32 chars hold 130 bits, a ULID is 128.
    // The server can never mint 'ZZZZ…', so an id above the cap is a mangled
    // profile, not an account.
    expect(() => qrPayload('Z'.repeat(26))).toThrow(CliError);
    expect(() => qrPayload(`8${'0'.repeat(25)}`)).toThrow(CliError);
    // The largest canonical ULID is fine.
    expect(qrPayload(`7${'Z'.repeat(25)}`)).toBe(`7${'Z'.repeat(25)}`);
  });
  it('is the only thing the renderer accepts', () => {
    // renderPairingQr routes through qrPayload — a URL cannot reach the
    // encoder by construction.
    expect(() => renderPairingQr('https://example.com')).toThrow(CliError);
    expect(renderPairingQr('01ARZ3NDEKTSV4RRFFQ69G5FAV').length).toBeGreaterThan(100);
  });
});

describe('the profile card', () => {
  it('announces itself with the sentinel and carries the fields BOTH parsers require', () => {
    const body = profileCardBody('CI — api-server');
    // render.ts detects an envelope by this literal prefix; a card whose
    // first key is not `tcm` is ordinary text on every client.
    expect(body.startsWith('{"tcm":"profile"')).toBe(true);
    const card = JSON.parse(body) as Record<string, unknown>;
    expect(card.n).toBe('CI — api-server');
    // `a` and `v` are REQUIRED by the app's ProfileEnvelope zod schema —
    // omit either and the phone drops the whole card as unsupported.
    expect(card.a).toBe('');
    expect(typeof card.v).toBe('number');
  });
});

describe('argument refusals (all before any network call)', () => {
  it('refuses an unknown surface, a missing name, and an over-long name', async () => {
    await expect(cmdSetup(['vscode', '--name', 'x'], report())).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
    });
    await expect(cmdSetup(['codex'], report())).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(
      cmdSetup(['codex', '--name', 'x'.repeat(41)], report()),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });

  it('never echoes a rejected --owner value (it may be a mis-expanded secret)', async () => {
    const secret = 'AKIA-SUPERSECRET-VALUE-99';
    let thrown: CliError | undefined;
    try {
      await cmdSetup(['codex', '--name', 'CI', '--owner', secret], report());
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown?.message).not.toContain(secret);
  });

  it('refuses the QR flow off a terminal and points at --owner — the unattended flow', async () => {
    let thrown: CliError | undefined;
    try {
      await cmdSetup(
        ['codex', '--name', 'CI'],
        report(),
        io('config.toml', { stderrIsTty: false }),
      );
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown?.exitCode).toBe(EXIT.USAGE);
    expect(thrown?.message).toContain('--owner');
    // BEFORE registering: a headless run must refuse a setup that has not
    // started, never strand a freshly minted account — which is also why the
    // QR wait's timeout only ever guards an ATTENDED terminal nobody scans.
    expect(stub.authCalls).toHaveLength(0);
  });

  it('preflights the host config BEFORE any network or state — a missing artifact leaves NOTHING behind', async () => {
    // The same missing-artifact condition writeHostConfig would hit at the
    // END of the flow; the docblock's ordering promise ("PREFLIGHT BEFORE
    // ANY NETWORK OR STATE") is that it refuses at the START instead. If the
    // early preflightHostConfig call in cmdSetup is deleted, this run still
    // throws — but only after registering and pairing, and the assertions
    // below catch exactly that half-completed state.
    const phone = await makePhone('phone-preflight');
    let thrown: CliError | undefined;
    try {
      await cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'preflight-bot'],
        report(),
        {
          hostConfig: { entryPath: join(confDir, 'never-built.js'), targetPath: join(confDir, 'config.toml') },
        },
      );
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown?.exitCode).toBe(EXIT.ERROR);
    // No account was registered, nothing was bound, no frame left, and no
    // profile landed on disk: the refusal happened before the setup started.
    expect(stub.authCalls).toHaveLength(0);
    expect(stub.binds).toHaveLength(0);
    expect(wsCtl.sent).toHaveLength(0);
    expect(tryLoadProfile('preflight-bot')).toBeNull();
  });

  it('a host config the merge would REFUSE also stops setup before any network — the preflight is the merge', async () => {
    // The preflight's promise is every refusal the final write can make, not
    // just artifact existence: a foreign codex `notify` (and equally an
    // unparseable settings.json) used to surface only AFTER registration,
    // binding and both messages — the exact half-completed state the
    // docblock promises to prevent.
    const phone = await makePhone('phone-preflight-merge');
    const foreign = 'notify = ["acme", "notify", "--hook", "slack", "--account", "x"]\n';
    writeFileSync(join(confDir, 'config.toml'), foreign);
    await expect(
      cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'preflight-merge-bot'],
        report(),
        io('config.toml'),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.ERROR });
    expect(stub.authCalls).toHaveLength(0);
    expect(stub.binds).toHaveLength(0);
    expect(wsCtl.sent).toHaveLength(0);
    expect(tryLoadProfile('preflight-merge-bot')).toBeNull();
    expect(readFileSync(join(confDir, 'config.toml'), 'utf8')).toBe(foreign);
  });
});

describe('unrecoverable-state findings (F8, F9)', () => {
  it('F8: a failed key upload is retried by the re-run — profile-on-disk is not proof of registration', async () => {
    const phone = await makePhone('phone-f8');
    const argv = ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'f8-bot'];
    stub.failUploads = 1;
    await expect(cmdSetup(argv, report(), io('config.toml'))).rejects.toThrow();
    // The profile landed (saved BEFORE the upload, deliberately — that
    // ordering is cmdRegister's) but the keys never reached the server, so
    // this on-disk state must NOT read as "registered".
    const uid = loadProfile('f8-bot').userId;
    expect(stub.uploads.has(uid)).toBe(false);
    expect(stub.binds).toHaveLength(0);

    // The re-run finds the pending marker and re-drives registration —
    // including the upload it owes — instead of adopting the half-state and
    // skipping the upload forever (which also left QR pairing timing out
    // forever: a phone cannot X3DH against keys the server never got).
    await cmdSetup(argv, report(), io('config.toml'));
    expect(stub.uploads.has(uid)).toBe(true);
    expect(stub.binds).toHaveLength(1);
    expect(loadProfile('f8-bot').ownerUserId).toBe(phone.userId);
  });

  it('F9a: a failed owner save AFTER a successful server bind names the state, and the re-run completes it', async () => {
    const phone = await makePhone('phone-f9a');
    const argv = ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'f9a-bot'];
    const notes: string[] = [];
    const r = report();
    const original = r.note.bind(r);
    r.note = (text: string) => {
      notes.push(text);
      original(text);
    };
    profileCtl.failOwnerSave = true;
    try {
      await expect(cmdSetup(argv, r, io('config.toml'))).rejects.toThrow();
    } finally {
      profileCtl.failOwnerSave = false;
    }
    // The binding EXISTS on the server, the disk does not know it — and the
    // operator was told exactly that, plus the remedy.
    expect(stub.binds).toHaveLength(1);
    expect(loadProfile('f9a-bot').ownerUserId).toBeUndefined();
    expect(notes.some(n => n.includes('ON THE SERVER') && n.includes('re-run'))).toBe(true);

    // The remedy is true: the server accepts a repeat bind to the same owner
    // (write-once but idempotent), so the re-run completes the pairing.
    await cmdSetup(argv, report(), io('config.toml'));
    expect(loadProfile('f9a-bot').ownerUserId).toBe(phone.userId);
  });

  it('F9b: a token renewal during the pairing sends does not erase the owner', async () => {
    const phone = await makePhone('phone-f9b');
    // The first ws-ticket ask 401s, which makes the AuthSession re-mint and
    // save its profile snapshot mid-setup — AFTER the owner was persisted.
    stub.failTickets = 1;
    await cmdSetup(
      ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'f9b-bot'],
      report(),
      io('config.toml'),
    );
    // The renewal genuinely happened: one auth from registration, one from
    // the forced re-mint. (Without this line, a stub change that stops
    // provoking the mint would let the assertion below pass vacuously.)
    expect(stub.authCalls).toHaveLength(2);
    // A session constructed BEFORE owner persistence would save its stale
    // snapshot here and erase ownerUserId — sending the NEXT setup into a
    // retry of the write-once server binding.
    expect(loadProfile('f9b-bot').ownerUserId).toBe(phone.userId);
    expect(wsCtl.sent).toHaveLength(2);
  });
});

/**
 * THE DEFECT AN EARLIER REVIEW FIXED IN cmdRegister,
 * STILL STANDING IN ITS SIBLING.
 *
 * `profile.ts` names this file in as many words — "setup.ts asks the same
 * question about the same file" — and it asked it with `tryLoadProfile`,
 * which answers `null` for a profile that merely would not READ. Null means
 * "there is no profile", so setup fell through to registration and
 * `saveProfile` replaced a recoverable record with an unbound one; on the QR
 * path a timeout then printed "nothing was written" over a file it had
 * already overwritten.
 *
 * A CORRUPT DOCUMENT rather than a chmod, deliberately: the finding's
 * motivating case is an EACCES, but `readProfile` reaches `unreadable` by the
 * same route for any file that exists and will not parse, and a mode-based
 * fixture is the one thing in this suite that would behave differently for a
 * root CI runner. The state under test is "a file IS there and this process
 * could not turn it into a record", which is exactly what this produces.
 */
describe('a profile that will not READ is never treated as one that is GONE', () => {
  it('setup REFUSES rather than registering over it — and the bytes are still there afterwards', async () => {
    const phone = await makePhone('phone-unread');
    const dir = join(home, 'unread-bot');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'profile.json');
    const bytes = '{"name":"unread-bot","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","ownerU';
    writeFileSync(path, bytes, { mode: 0o600 });
    const authsBefore = stub.authCalls.length;

    await expect(
      cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'unread-bot'],
        report(),
        io('config.toml'),
      ),
      // The file's OWN diagnosis, carried, plus the sentence that is this
      // command's: `readProfile`'s `unreadable` arm reaches here with either
      // prose (a corrupt document says "not valid JSON", an EACCES says
      // "could not be read"), and what has to be true of both is that setup
      // said it stopped rather than reporting what it did.
    ).rejects.toThrow(/would REGISTER this account and REPLACE that file/);

    // The whole of the damage, measured where it happens: the file.
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    // …and nothing was registered on the way to the refusal, so the refusal
    // is BEFORE the write rather than a report of one.
    expect(stub.authCalls.length).toBe(authsBefore);
  });

  it('a re-drive INHERITS the binding — a failure before the re-bind must not unbind the account locally', async () => {
    const phone = await makePhone('phone-redrive');
    const argv = ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'redrive-bot'];
    await cmdSetup(argv, report(), io('config.toml'));
    expect(loadProfile('redrive-bot').ownerUserId).toBe(phone.userId);
    expect(stub.binds).toHaveLength(1);

    // F8's state, reached from an account that is ALREADY BOUND: a marker left
    // behind by a crash between the profile save and the key upload. The
    // re-run re-drives the whole registration — and the upload fails again, so
    // nothing downstream ever gets the chance to repair what the save did.
    writeFileSync(join(home, 'redrive-bot', 'setup-keys-upload.pending'), 'x\n');
    stub.failUploads = 1;
    await expect(cmdSetup(argv, report(), io('config.toml'))).rejects.toThrow();

    // The server's binding is write-once and was never touched. Only this
    // machine can forget it, and this is the line that says it did not.
    expect(loadProfile('redrive-bot').ownerUserId).toBe(phone.userId);
  });

  it('…and a successful re-drive is ALREADY PAIRED — it does not re-derive a binding it still has', async () => {
    const phone = await makePhone('phone-redrive2');
    const argv = ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'redrive2-bot'];
    await cmdSetup(argv, report(), io('config.toml'));
    expect(stub.binds).toHaveLength(1);

    writeFileSync(join(home, 'redrive2-bot', 'setup-keys-upload.pending'), 'x\n');
    await cmdSetup(argv, report(), io('config.toml'));
    // A second bind is the SYMPTOM of the loss: setup re-pairs only when it
    // reads the account as unbound. (The server takes a repeat bind to the
    // same owner, which is why this was survivable with `--owner` and not on
    // the QR path — there it draws a code and waits for a phone.)
    expect(stub.binds).toHaveLength(1);
    expect(loadProfile('redrive2-bot').ownerUserId).toBe(phone.userId);
  });
});

describe('the agent flow (--owner): the one an assistant can run unattended', () => {
  it('registers an integration, binds it, and the phone can decrypt card then hello', async () => {
    const phone = await makePhone('phone-agent');
    await cmdSetup(
      ['codex', '--name', 'CI Bot', '--owner', phone.userId.toLowerCase(), '--account', 'agent-bot'],
      report(),
      io('config.toml'),
    );

    // The account was created AS an integration — the class is set at birth
    // and cannot be added later, so it must be on the very first auth.
    expect(stub.authCalls[0]?.accountClass).toBe('integration');

    // Bound to the pasted owner, upper-cased to the wire spelling.
    expect(stub.binds).toHaveLength(1);
    expect(stub.binds[0]?.owner).toBe(phone.userId);
    const profile = loadProfile('agent-bot');
    expect(profile.ownerUserId).toBe(phone.userId);
    expect(profile.accountClass).toBe('integration');

    // Two frames left this machine, and their plaintext is only readable by
    // the phone's own ratchet — which is the whole product claim. The first
    // is the name card (a carrier: notify:false so it cannot banner the
    // phone), the second the human hello.
    expect(wsCtl.sent).toHaveLength(2);
    const [card, hello] = wsCtl.sent as Array<{
      to: string;
      msgType: 'prekey' | 'ciphertext';
      payload: string;
      notify?: boolean;
    }>;
    expect(card?.to).toBe(phone.userId);
    expect(card?.notify).toBe(false);
    expect(hello?.notify).toBeUndefined();

    const cardText = await decryptEnvelope(phone.stores, phone.userId, profile.userId, card!.msgType, card!.payload);
    const parsed = JSON.parse(cardText) as Record<string, unknown>;
    expect(parsed.tcm).toBe('profile');
    expect(parsed.n).toBe('CI Bot');
    const helloText = await decryptEnvelope(phone.stores, phone.userId, profile.userId, hello!.msgType, hello!.payload);
    expect(helloText).toContain('CI Bot');
    expect(helloText).toContain('nobody else');

    // And the host side is registered.
    expect(readFileSync(join(confDir, 'config.toml'), 'utf8')).toContain('"--account", "agent-bot"');
  });

  it('re-runs idempotently: no second bind, a fresh card, the config already current', async () => {
    const phone = await makePhone('phone-rerun');
    const argv = ['codex', '--name', 'CI Bot', '--owner', phone.userId, '--account', 'rerun-bot'];
    await cmdSetup(argv, report(), io('config.toml'));
    const bindsAfterFirst = stub.binds.length;
    const authAfterFirst = stub.authCalls.length;

    await cmdSetup(argv, report(), io('config.toml'));
    // The binding is write-once; a re-run must not even ask.
    expect(stub.binds.length).toBe(bindsAfterFirst);
    // And the account is adopted from disk, not re-registered.
    expect(stub.authCalls.length).toBe(authAfterFirst);
    // The name card goes out again — re-running with a new --name is the
    // documented rename path — but the HELLO does not: greeting the owner on
    // every re-run is a duplicate message, not idempotence (F5). So exactly
    // ONE more frame, and it is the carrier card (notify: false).
    expect(wsCtl.sent).toHaveLength(3);
    expect((wsCtl.sent[2] as { notify?: boolean }).notify).toBe(false);
  });

  it('refuses to re-point an already-paired account at a different owner', async () => {
    const phone = await makePhone('phone-a');
    const other = await makePhone('phone-b');
    await cmdSetup(
      ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'pinned-bot'],
      report(),
      io('config.toml'),
    );
    await expect(
      cmdSetup(
        ['codex', '--name', 'CI', '--owner', other.userId, '--account', 'pinned-bot'],
        report(),
        io('config.toml'),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(stub.binds).toHaveLength(1);
  });

  it('pairs FIRST and says so when the config write then fails — never silently half-done', async () => {
    const phone = await makePhone('phone-halffail');
    // A target whose parent is a FILE: mkdir fails after the pairing has
    // already succeeded — the exact late failure the state note exists for.
    const notes: string[] = [];
    const r = report();
    const original = r.note.bind(r);
    r.note = (text: string) => {
      notes.push(text);
      original(text);
    };
    await expect(
      cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'halffail-bot'],
        r,
        { hostConfig: { entryPath: entry, targetPath: join(entry, 'impossible', 'config.toml') } },
      ),
    ).rejects.toThrow();
    // The pairing exists and survives…
    expect(loadProfile('halffail-bot').ownerUserId).toBe(phone.userId);
    // …and the operator was told exactly which state they are in.
    expect(notes.some(n => n.includes('PAIRED') && n.includes('NOT written'))).toBe(true);
  });

  it('a plain fs error out of the config write maps to exit 1 — never 2, which every host reads as "block"', async () => {
    // NOT every throw on this path is a CliError: mkdirSync/writeFileSync in
    // writeHostConfig throw plain system Errors. The exit-2 guarantee does
    // not rest on the EXIT table covering everything — it rests on
    // exitCodeFor mapping every UNCLASSIFIED throw to EXIT.ERROR (1), and 2
    // being absent from the table. Both halves are pinned here.
    const phone = await makePhone('phone-exitcode');
    let thrown: unknown;
    try {
      await cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'exitcode-bot'],
        report(),
        // A target whose parent is a FILE: mkdirSync throws ENOTDIR, a plain
        // Error off the fs layer that no EXIT-table classification touches.
        { hostConfig: { entryPath: entry, targetPath: join(entry, 'impossible', 'config.toml') } },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliError);
    expect(exitCodeFor(thrown)).toBe(EXIT.ERROR);
    expect(exitCodeFor(thrown)).not.toBe(2);
  });
});

describe('the pairing sends ride sendEncryptedAll: connect first, one socket (send.ts)', () => {
  it('a refused socket costs ZERO session bootstrap — no prekey fetched, no session written', async () => {
    // The divergence this pins: sendPairingMessages used to fetch the
    // owner's bundle and establishSession BEFORE dialling, so every refused
    // socket consumed one of the owner's one-time prekeys and wrote a
    // session `hasSession` would then answer for — repeated failed setups
    // burned the account's prekeys against a peer they never reached.
    const phone = await makePhone('phone-order');
    wsCtl.refuseSendDials = true;
    await expect(
      cmdSetup(
        ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'order-bot'],
        report(),
        io('config.toml'),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT.NETWORK });

    // The failure hit the SEND half (the pairing itself exists)…
    expect(loadProfile('order-bot').ownerUserId).toBe(phone.userId);
    // …and the refused dial cost nothing ratchet-shaped: the bundle — whose
    // GET is what consumes a one-time prekey on the real server — was never
    // fetched, no session was written, and no frame left.
    expect(stub.bundleGets).toBe(0);
    expect(await hasSession(new FileStores('order-bot'), phone.userId)).toBe(false);
    expect(wsCtl.sent).toHaveLength(0);

    // The re-run completes it, and the prekey is spent only NOW — against a
    // socket that actually connected.
    wsCtl.refuseSendDials = false;
    await cmdSetup(
      ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'order-bot'],
      report(),
      io('config.toml'),
    );
    expect(stub.bundleGets).toBe(1);
    expect(await hasSession(new FileStores('order-bot'), phone.userId)).toBe(true);
  });

  it('the card and the hello share ONE send-role dial', async () => {
    // Two `sendEncrypted` calls would be two dials (two tickets, two
    // handshakes) for one delivery; `sendEncryptedAll` exists so both
    // messages ride one socket, and this is the assertion that keeps it so.
    const phone = await makePhone('phone-onedial');
    await cmdSetup(
      ['codex', '--name', 'CI', '--owner', phone.userId, '--account', 'onedial-bot'],
      report(),
      io('config.toml'),
    );
    expect(wsCtl.sent).toHaveLength(2);
    expect(wsCtl.dials).toEqual(['send']);
  });
});

describe('the QR flow: the phone speaks first, so the CLI listens', () => {
  it('pairs to the sender of the first decrypted message and answers with the card', async () => {
    const phone = await makePhone('phone-qr');
    // The "phone": when the CLI's listen socket opens, scan-and-send — an
    // X3DH bootstrap against the keys the CLI just uploaded, exactly what
    // the app does with a scanned code.
    wsCtl.onListenOpen = sock => {
      void (async () => {
        const me = loadProfile('claude-code');
        const upload = stub.uploads.get(me.userId);
        if (!upload) throw new Error('no upload captured for the integration');
        await establishSession(phone.stores, phone.userId, bundleFromUpload(me.userId, upload) as never);
        const { msgType, payload } = await encryptText(
          phone.stores,
          phone.userId,
          me.userId,
          'hi from my phone',
        );
        sock.deliver({ type: 'msg', from: phone.userId, msgId: ulid(), msgType, payload, ts: Date.now() });
      })();
    };

    await cmdSetup(
      ['claude-code', '--name', 'My Claude', '--seconds', '30'],
      report(),
      io('settings.json', { stderrIsTty: true }),
    );

    // The owner is the peer the decrypt PINNED, bound write-once.
    expect(stub.binds).toHaveLength(1);
    expect(stub.binds[0]?.owner).toBe(phone.userId);
    expect(loadProfile('claude-code').ownerUserId).toBe(phone.userId);

    // The pairing message itself was consumed under the real inbound policy:
    // decrypted, then ACKED (the ack is what stops 30 days of redelivery).
    expect(wsCtl.acks.length).toBeGreaterThan(0);

    // Card + hello went back, readable only by the phone.
    expect(wsCtl.sent).toHaveLength(2);
    const me = loadProfile('claude-code');
    const card = wsCtl.sent[0] as { msgType: 'prekey' | 'ciphertext'; payload: string };
    const text = await decryptEnvelope(phone.stores, phone.userId, me.userId, card.msgType, card.payload);
    expect((JSON.parse(text) as { n: string }).n).toBe('My Claude');

    // And the Claude hooks landed.
    const settings = JSON.parse(readFileSync(join(confDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('notify --hook claude');
  });

  it("never renders the phone's first message on ANY reporter surface (F12)", async () => {
    // The phone speaks first, and what it says is not ours to render: setup
    // output reaches hook and CI logs, so a first message that happens to
    // carry a secret must not cross stdout, stderr OR a --json record. The
    // message is still consumed under the full inbound policy — decrypted,
    // spooled, ACKED — only the rendering is withheld.
    const SECRET = 'TOTP-SEED-JBSWY3DPEHPK3PXP';
    const phone = await makePhone('phone-secret');
    wsCtl.onListenOpen = sock => {
      void (async () => {
        const me = loadProfile('muted-bot');
        const upload = stub.uploads.get(me.userId);
        if (!upload) throw new Error('no upload captured for the integration');
        await establishSession(phone.stores, phone.userId, bundleFromUpload(me.userId, upload) as never);
        const { msgType, payload } = await encryptText(
          phone.stores,
          phone.userId,
          me.userId,
          `here is my vault seed: ${SECRET}`,
        );
        sock.deliver({ type: 'msg', from: phone.userId, msgId: ulid(), msgType, payload, ts: Date.now() });
      })();
    };

    const r = report();
    const seen: string[] = [];
    for (const method of ['emit', 'line', 'note', 'status'] as const) {
      const original = (r[method] as (...a: unknown[]) => void).bind(r);
      (r as unknown as Record<string, (...a: unknown[]) => void>)[method] = (...a: unknown[]) => {
        seen.push(JSON.stringify(a));
        original(...a);
      };
    }

    await cmdSetup(
      ['claude-code', '--name', 'Muted', '--account', 'muted-bot', '--seconds', '30'],
      r,
      io('settings.json', { stderrIsTty: true }),
    );

    // Paired, consumed, acked — and the secret reached no reporter surface.
    expect(loadProfile('muted-bot').ownerUserId).toBe(phone.userId);
    expect(wsCtl.acks.length).toBeGreaterThan(0);
    expect(seen.join('\n')).not.toContain(SECRET);
    // The operator is still told the message arrived, and where to read it.
    expect(seen.join('\n')).toContain('tacendum inbox');
  });

  it('times out honestly: registered, NOT paired, nothing written', async () => {
    // No phone ever answers.
    wsCtl.onListenOpen = () => {};
    let thrown: CliError | undefined;
    try {
      await cmdSetup(
        ['gemini', '--name', 'Quiet', '--seconds', '1'],
        report(),
        io('settings.json', { stderrIsTty: true }),
      );
    } catch (err) {
      thrown = err as CliError;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown?.exitCode).toBe(EXIT.TIMEOUT);
    expect(thrown?.message).toContain('NOT paired');
    expect(stub.binds).toHaveLength(0);
    expect(loadProfile('gemini').ownerUserId).toBeUndefined();
  });
});

/**
 * OWNER INHERITANCE IS DECIDED UNDER THE LOCK THE SAVE HOLDS, not from a
 * snapshot taken before it.
 *
 * `ensureIntegrationAccount` reads the profile ONCE, at the top of the
 * function, and `register.lock` is taken after it. Two first-runs for the same
 * account — `setup` and a cron `register`, two CI steps — both read "no
 * profile". One wins, registers, and is paired, which writes `ownerUserId`.
 * The loser then takes the lock, authenticates as the SAME userId, and saves
 * from its stale `existing = null`: the record it writes has no owner, while
 * the server goes on holding the write-once binding. `boundTo` reads null and
 * the MCP server stops offering a send tool, on a machine whose pairing is
 * fine.
 *
 * WHAT THE LOSS COSTS, and why NOT passing `--owner` is what the case turns
 * on. With `--owner`, the pairing branch a few lines later re-binds the same
 * owner and puts the field back — the loss is real but self-healing, and
 * setup.ts says so at that save. WITHOUT it there is nothing to re-bind from:
 * an already-paired account should take the `already-paired` branch and
 * refresh its card, and instead the unbound record sends this run into the QR
 * flow, drawing a pairing code and waiting for a phone to pair an account that
 * was paired a second ago. Every failure between the two saves leaves the
 * machine unbound for good.
 *
 * DETERMINISTIC, not raced: `stub.onChallenge` writes the winner's paired
 * record at a point inside this command that the harness can name — after the
 * pre-lock read, before the save — using the identityKey the challenge itself
 * carries, so the planted profile is this account's rather than a fixture's.
 */
describe('setup carries forward a binding written after its pre-lock read', () => {
  it('keeps the owner a concurrent first-run wrote, and never re-enters pairing', async () => {
    const account = 'ownerrace-setup';
    // A REAL owner with real keys: the run that inherits correctly goes on to
    // refresh the name card, which needs a bundle to encrypt to. A fixture id
    // would fail that send and turn a green case into a different red one.
    const phone = await makePhone('phone-ownerrace');

    stub.onChallenge = (identityKey: string) => {
      // The account the stub is about to mint for this key, minted here so the
      // planted record carries the SAME userId — the inheritance guard
      // (`existing.userId === minted.userId`) declines otherwise and the case
      // would prove nothing about the race.
      let user = stub.users.get(identityKey);
      if (!user) {
        user = { userId: ulid(), integration: true };
        stub.users.set(identityKey, user);
      }
      mkdirSync(join(home, account), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(home, account, 'profile.json'),
        JSON.stringify(
          {
            name: account,
            identityKey,
            userId: user.userId,
            authToken: `tok-winner-${user.userId}`,
            registrationId: 4242,
            deviceId: 1,
            accountClass: 'integration',
            ownerUserId: phone.userId,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    };
    // No phone ever answers the QR listen. A run that inherits never opens it;
    // a run that lost the binding waits here and dies at the timeout, which is
    // exactly the shape this case is separating.
    wsCtl.onListenOpen = () => {};

    let thrown: Error | undefined;
    try {
      await cmdSetup(
        ['gemini', '--name', 'Racer', '--account', account, '--seconds', '1'],
        report(),
        io('settings.json', { stderrIsTty: true }),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(
      thrown?.message,
      'setup dropped the binding the winner had just written and fell into the QR flow for an ' +
        'account that is already paired — the server still holds the binding, so only this ' +
        'machine is unbound',
    ).toBeUndefined();
    expect(
      loadProfile(account).ownerUserId,
      'the inherited binding is not on disk after the save',
    ).toBe(phone.userId);
    expect(loadProfile(account).accountClass).toBe('integration');
    // …and it came from the RECORD, not from a fresh pairing: nothing in this
    // run may touch the server's write-once binding.
    expect(stub.binds, 'the run re-bound rather than inheriting').toHaveLength(0);
  });
});
