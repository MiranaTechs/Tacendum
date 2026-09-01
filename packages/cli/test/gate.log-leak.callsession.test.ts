/**
 * The log-leak sweep — the CallSession MIRROR of gate.log-leak.test.ts.
 *
 * Same rule, same shared functions (`describeLocalFailure` / `localErrno` /
 * `describeUndecryptable`, inbound.ts), asserted separately against
 * `listen --calls` because this package's most repeated defect is a rule
 * implemented at two call sites that then diverge: a fix re-inlined into
 * call-session.ts alone would leave every one of these red while the plain
 * listener's file stays green.
 *
 * Sabotage handles: re-inline `err.message` (or raw `err.name/err.message`)
 * at any of CallSession's three failure prints — the matching test here sees
 * the path, the account name, the planted text, or the control bytes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { PrekeyBundle, ServerFrame } from '@tacendum/shared';

const { wsInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
  }>,
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    constructor(_url: string) {
      wsInstances.push(this);
      setTimeout(() => {
        for (const h of this.handlers.open ?? []) h();
      }, 0);
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
    close() {}
    send(data: string) {
      this.sent.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Same undecryptable-branch injection as the plain-listener file: a marker
// payload throws an error carrying control bytes and an oversize tail; every
// other payload runs real crypto.
vi.mock('../src/messaging.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/messaging.js')>();
  return {
    ...mod,
    decryptEnvelope: async (
      ...args: Parameters<typeof mod.decryptEnvelope>
    ): Promise<string> => {
      if (args[4] === 'EVIL-INJECT') {
        const e = new Error(`bad bytes \u001b[31mforged\u0007 line${'X'.repeat(300)}`);
        e.name = 'Evil\u007f\u009bName';
        throw e;
      }
      return mod.decryptEnvelope(...args);
    },
  };
});

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-leakcs-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://leakcs.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { clientDir } = await import('../src/config.js');
type FileStoresT = InstanceType<typeof FileStores>;

const ulid = monotonicFactory();
const realFetch = globalThis.fetch;
/**
 * The rule assumes a control character in a pattern is a typo. Here the
 * control characters ARE the assertion — this constant exists to catch one
 * reaching a terminal, so a pattern that could not name them could not fail.
 * Same disable, same reason, as render.ts's `LINE_BREAK`.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const BOT = 'leakcs-bot';
const BOT_ID = `01${'LEAKCSBT'.repeat(3)}`;
const P1_ID = `01${'LEAKCSP1'.repeat(3)}`; // session-save EACCES
const P2_ID = `01${'LEAKCSP2'.repeat(3)}`; // ratchet-lock refusal
const P3_ID = `01${'LEAKCSP3'.repeat(3)}`; // spool write failure

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otkIndex: number,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[otkIndex],
  };
}

let session: InstanceType<typeof CallSession>;
let socket: (typeof wsInstances)[number];
let botStores: FileStoresT;
let p1Stores: FileStoresT;
let p2Stores: FileStoresT;
let p3Stores: FileStoresT;
let stdout: string[];
let stderr: string[];

beforeAll(async () => {
  botStores = new FileStores(BOT);
  const botUpload = await generateAndStoreKeys(botStores);
  saveProfile({
    name: BOT,
    identityKey: botUpload.identityKey,
    userId: BOT_ID,
    authToken: 'live-leakcs-bot',
    registrationId: botUpload.registrationId,
    deviceId: 1,
  });

  // Three real correspondents, one per failure under test — each one's FIRST
  // message is an independent prekey envelope, so an earlier test's induced
  // store failure cannot bleed into a later test's decrypt.
  p1Stores = new FileStores('leakcs-p1');
  await generateAndStoreKeys(p1Stores);
  await establishSession(p1Stores, P1_ID, bundleFrom(BOT_ID, botUpload, 0));
  p2Stores = new FileStores('leakcs-p2');
  await generateAndStoreKeys(p2Stores);
  await establishSession(p2Stores, P2_ID, bundleFrom(BOT_ID, botUpload, 1));
  p3Stores = new FileStores('leakcs-p3');
  await generateAndStoreKeys(p3Stores);
  await establishSession(p3Stores, P3_ID, bundleFrom(BOT_ID, botUpload, 2));

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://leakcs.test', '');
    if (path === '/v1/ws-ticket') {
      return new Response(JSON.stringify({ ticket: 'tkt', expiresAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;

  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  session = new CallSession(BOT);
  await session.connect();
  socket = wsInstances[wsInstances.length - 1]!;
}, 30000);

afterAll(() => {
  session.close();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

function deliver(frame: ServerFrame): void {
  for (const h of socket.handlers.message ?? []) h(JSON.stringify(frame));
}

function acked(msgId: string): boolean {
  return socket.sent.some(f => {
    const parsed = JSON.parse(f) as { type: string; msgId?: string };
    return parsed.type === 'ack' && parsed.msgId === msgId;
  });
}

describe('the calls daemon mirrors the log-leak rule at all three failure prints', () => {
  it('local failure (session-save EACCES): errno only — no path, no account name', async () => {
    const { msgType, payload } = await encryptText(p1Stores, P1_ID, BOT_ID, 'mail vs full disk');
    expect(msgType).toBe('prekey');
    const msgId = ulid();
    const beforeErr = stderr.length;

    const sessionsDir = join(clientDir(BOT), 'sessions');
    chmodSync(sessionsDir, 0o500);
    try {
      deliver({ type: 'msg', from: P1_ID, msgId, msgType, payload, ts: Date.now() });
      await vi.waitFor(
        () =>
          expect(
            stderr.slice(beforeErr).some(l => l.includes('left on the server, will retry')),
          ).toBe(true),
        { timeout: 10000 },
      );
    } finally {
      chmodSync(sessionsDir, 0o700);
    }

    const slice = stderr.slice(beforeErr).join('\n');
    expect(slice).toContain('(EACCES)');
    expect(slice).not.toContain(BOT);
    expect(slice).not.toContain(clientDir(BOT));
    expect(acked(msgId)).toBe(false);
    expect(botStores.hasSeen(msgId)).toBe(false);
  }, 30000);

  it('local failure (ratchet-lock refusal): fixed prose — never lock.ts’s path-bearing remedy', async () => {
    const { msgType, payload } = await encryptText(p2Stores, P2_ID, BOT_ID, 'mail vs held lock');
    const msgId = ulid();
    const beforeErr = stderr.length;

    // A fresh PLAIN FILE at the lock path: `ensureLockDir` refuses fast with
    // the CliError whose message deliberately embeds the path.
    const lockPath = botStores.ratchetLockPath();
    rmSync(lockPath, { recursive: true, force: true });
    writeFileSync(lockPath, 'held', { mode: 0o600 });
    try {
      deliver({ type: 'msg', from: P2_ID, msgId, msgType, payload, ts: Date.now() });
      await vi.waitFor(
        () =>
          expect(
            stderr.slice(beforeErr).some(l => l.includes('left on the server, will retry')),
          ).toBe(true),
        { timeout: 10000 },
      );
    } finally {
      rmSync(lockPath, { force: true });
    }

    const slice = stderr.slice(beforeErr).join('\n');
    expect(slice).toContain('ratchet lock');
    expect(slice).not.toContain(BOT);
    expect(slice).not.toContain(clientDir(BOT));
    expect(acked(msgId)).toBe(false);
  }, 30000);

  it('spool write failure: errno and the custody pointer — never the exception text', async () => {
    const planted = "/planted/other-account/messages.jsonl";
    const spy = vi.spyOn(MessageLog.prototype, 'append').mockImplementation(() => {
      throw Object.assign(new Error(`ENOSPC: no space left on device, open '${planted}'`), {
        code: 'ENOSPC',
      });
    });
    try {
      const { msgType, payload } = await encryptText(p3Stores, P3_ID, BOT_ID, 'the last copy');
      const msgId = ulid();
      const beforeErr = stderr.length;

      deliver({ type: 'msg', from: P3_ID, msgId, msgType, payload, ts: Date.now() });
      await vi.waitFor(
        () =>
          expect(
            stderr.slice(beforeErr).some(l => l.includes('message log write failed')),
          ).toBe(true),
        { timeout: 10000 },
      );

      const slice = stderr.slice(beforeErr).join('\n');
      expect(slice).toContain('message log write failed (ENOSPC)');
      expect(slice).not.toContain(planted);
      expect(acked(msgId)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('the tamper print: name and message stripped and bounded, purge semantics unchanged', async () => {
    const msgId = ulid();
    const beforeErr = stderr.length;

    deliver({
      type: 'msg',
      from: P1_ID,
      msgId,
      msgType: 'ciphertext',
      payload: 'EVIL-INJECT',
      ts: Date.now(),
    });
    await vi.waitFor(
      () => expect(stderr.slice(beforeErr).some(l => l.includes('DECRYPT FAILED'))).toBe(true),
      { timeout: 10000 },
    );

    const note = stderr.slice(beforeErr).find(l => l.includes('DECRYPT FAILED'))!;
    expect(note).not.toMatch(CONTROL);
    expect(note).toContain('…');
    expect(note).not.toContain('X'.repeat(250));
    expect(acked(msgId)).toBe(true);
    expect(botStores.hasSeen(msgId)).toBe(true);
  }, 30000);
});
