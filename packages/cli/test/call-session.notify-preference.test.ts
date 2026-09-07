import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrekeyBundle, ServerFrame } from '@tacendum/shared';

type SocketHarness = {
  readyState: number;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  sent: string[];
  autoReceipt: boolean;
  receiptsEmitted: number;
  onIncomingAck?: (() => void) | undefined;
  forceClose(code: number): void;
};

const { sockets } = vi.hoisted(() => ({ sockets: [] as SocketHarness[] }));

vi.mock('ws', () => {
  class FakeWebSocket implements SocketHarness {
    static readonly OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    sent: string[] = [];
    autoReceipt = true;
    receiptsEmitted = 0;
    onIncomingAck?: (() => void) | undefined;

    constructor(_url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        for (const handler of this.handlers.open ?? []) handler();
      }, 0);
    }

    on(event: string, callback: (...args: unknown[]) => void) {
      (this.handlers[event] ??= []).push(callback);
      return this;
    }

    off(event: string, callback: (...args: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter((handler) => handler !== callback);
      return this;
    }

    removeAllListeners() {
      this.handlers = {};
      return this;
    }

    close() {
      this.readyState = 3;
    }

    forceClose(code: number) {
      this.readyState = 3;
      for (const handler of this.handlers.close ?? []) handler(code);
    }

    send(data: string) {
      if (this.readyState !== 1) return;
      this.sent.push(data);
      const frame = JSON.parse(data) as {
        type: string;
        msgId?: string;
      };
      if (frame.type === 'ack') {
        this.onIncomingAck?.();
      } else if (frame.type === 'send' && frame.msgId !== undefined && this.autoReceipt) {
        setTimeout(() => {
          this.receiptsEmitted += 1;
          const receipt = JSON.stringify({
            type: 'receipt',
            msgId: frame.msgId,
            state: 'delivered',
          });
          for (const handler of this.handlers.message ?? []) handler(receipt);
        }, 0);
      }
    }
  }
  return { default: FakeWebSocket };
});

const home = mkdtempSync(join(tmpdir(), 'tacendum-call-pref-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://call-pref.test';

const { applyOwnerNotifyPreference, readRoutineNotifyPreference } =
  await import('../src/ai-notify-preference.js');
const { CallSession } = await import('../src/call-session.js');
const { decryptEnvelope, encryptText, establishSession, generateAndStoreKeys } =
  await import('../src/messaging.js');
const { MessageLog } = await import('../src/msglog.js');
const { blockedPath } = await import('../src/blocked.js');
const { saveProfile } = await import('../src/profile.js');
const { FileStores } = await import('../src/stores.js');

type CallSessionT = InstanceType<typeof CallSession>;
type FileStoresT = InstanceType<typeof FileStores>;

const ulid = monotonicFactory();
const realFetch = globalThis.fetch;
const Q = '01J00000000000000000000010';
let fixtureNo = 0;
let session: CallSessionT;
let socket: SocketHarness;
let botAccount: string;
let botId: string;
let ownerId: string;
let otherId: string;
let botStores: FileStoresT;
let ownerStores: FileStoresT;
let otherStores: FileStoresT;
let stderr: string[];

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  oneTimeIndex: number,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[oneTimeIndex],
  };
}

function profileRequest(q: string, routine: 'all' | 'quiet'): string {
  return JSON.stringify({
    tcm: 'profile',
    n: 'Owner',
    a: '',
    v: 7,
    notifyPref: { q, routine },
  });
}

type WireSend = {
  type: 'send';
  to: string;
  msgId: string;
  msgType: 'prekey' | 'ciphertext';
  payload: string;
  urgent?: boolean;
  notify?: boolean;
};

function sentFrames(): WireSend[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === 'send') as WireSend[];
}

function incomingAcked(msgId: string): boolean {
  return socket.sent.some((raw) => {
    const frame = JSON.parse(raw) as { type: string; msgId?: string };
    return frame.type === 'ack' && frame.msgId === msgId;
  });
}

function deliver(frame: ServerFrame): void {
  for (const handler of socket.handlers.message ?? []) {
    handler(JSON.stringify(frame));
  }
}

async function requestFrom(
  stores: FileStoresT,
  from: string,
  body: string,
): Promise<{ msgId: string; sentBefore: number }> {
  const { msgType, payload } = await encryptText(stores, from, botId, body);
  const msgId = ulid();
  const sentBefore = sentFrames().length;
  deliver({ type: 'msg', from, msgId, msgType, payload, ts: Date.now() });
  await vi.waitFor(() => expect(incomingAcked(msgId)).toBe(true), {
    timeout: 10_000,
  });
  return { msgId, sentBefore };
}

async function waitForAcceptedAppAck(expectedSendCount: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(sentFrames()).toHaveLength(expectedSendCount);
      expect(socket.receiptsEmitted).toBe(expectedSendCount);
    },
    { timeout: 10_000 },
  );
  // Let the receipt wake finish the inbound continuation before teardown can
  // turn a successful send into a synthetic closed-socket failure.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshotSessions(): Map<string, Buffer> {
  const dir = join(botStores.root, 'sessions');
  const snapshot = new Map<string, Buffer>();
  if (!existsSync(dir)) return snapshot;
  for (const name of readdirSync(dir).sort()) {
    snapshot.set(name, readFileSync(join(dir, name)));
  }
  return snapshot;
}

function expectSessionsEqual(before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [name, bytes] of before) {
    expect(after.get(name)?.equals(bytes), `session file ${name} changed`).toBe(true);
  }
}

beforeEach(async () => {
  fixtureNo += 1;
  sockets.length = 0;
  botAccount = `call-pref-bot-${fixtureNo}`;
  botId = ulid();
  ownerId = ulid();
  otherId = ulid();
  botStores = new FileStores(botAccount);
  ownerStores = new FileStores(`call-pref-owner-${fixtureNo}`);
  otherStores = new FileStores(`call-pref-other-${fixtureNo}`);
  const botUpload = await generateAndStoreKeys(botStores);
  await generateAndStoreKeys(ownerStores);
  await generateAndStoreKeys(otherStores);
  await establishSession(ownerStores, ownerId, bundleFrom(botId, botUpload, 0));
  await establishSession(otherStores, otherId, bundleFrom(botId, botUpload, 1));
  saveProfile({
    name: botAccount,
    identityKey: botUpload.identityKey,
    userId: botId,
    authToken: 'call-pref-token',
    registrationId: botUpload.registrationId,
    deviceId: 1,
    ownerUserId: ownerId,
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://call-pref.test', '');
    if (path === '/v1/ws-ticket') {
      return new Response(JSON.stringify({ ticket: 'ticket', expiresAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  session = new CallSession(botAccount);
  await session.connect();
  socket = sockets.at(-1)!;
});

afterEach(() => {
  session.close();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

describe('call-enabled listener owner notification preference parity', () => {
  it('persists before relay ack and returns an exact encrypted quiet app ack', async () => {
    let atRelayAck: unknown;
    socket.onIncomingAck = () => {
      atRelayAck = readRoutineNotifyPreference(botAccount);
    };
    const logBefore = new MessageLog(botAccount).read().length;
    const { sentBefore } = await requestFrom(ownerStores, ownerId, profileRequest(Q, 'quiet'));
    await waitForAcceptedAppAck(sentBefore + 1);

    expect(atRelayAck).toEqual({ q: Q, routine: 'quiet' });
    expect(readRoutineNotifyPreference(botAccount)).toEqual({
      q: Q,
      routine: 'quiet',
    });
    const ack = sentFrames().at(-1)!;
    expect(ack).toMatchObject({
      to: ownerId,
      urgent: false,
      notify: false,
    });
    const plaintext = await decryptEnvelope(ownerStores, ownerId, botId, ack.msgType, ack.payload);
    expect(JSON.parse(plaintext)).toEqual({
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPrefAck: { q: Q, routine: 'quiet' },
    });
    expect(new MessageLog(botAccount).read()).toHaveLength(logBefore);
  }, 30_000);

  it('re-acks a lost same-q request without rebinding a conflicting value', async () => {
    const first = await requestFrom(ownerStores, ownerId, profileRequest(Q, 'quiet'));
    await waitForAcceptedAppAck(first.sentBefore + 1);
    // The first encrypted app ack is deliberately never opened by the owner.
    const second = await requestFrom(ownerStores, ownerId, profileRequest(Q, 'all'));
    await waitForAcceptedAppAck(second.sentBefore + 1);

    expect(readRoutineNotifyPreference(botAccount)).toEqual({
      q: Q,
      routine: 'quiet',
    });
    const retryAck = sentFrames().at(-1)!;
    const plaintext = await decryptEnvelope(
      ownerStores,
      ownerId,
      botId,
      retryAck.msgType,
      retryAck.payload,
    );
    expect(JSON.parse(plaintext).notifyPrefAck).toEqual({
      q: Q,
      routine: 'quiet',
    });
  }, 30_000);

  it('acks but never applies or app-acks a non-owner request', async () => {
    applyOwnerNotifyPreference(botAccount, ownerId, ownerId, profileRequest(Q, 'all'));
    const later = '01J00000000000000000000020';
    const { sentBefore } = await requestFrom(otherStores, otherId, profileRequest(later, 'quiet'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readRoutineNotifyPreference(botAccount)).toEqual({
      q: Q,
      routine: 'all',
    });
    expect(sentFrames()).toHaveLength(sentBefore);
  }, 30_000);

  it('acks but never applies or app-acks a blocked owner request', async () => {
    const path = blockedPath(botAccount);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([ownerId]));
    const { sentBefore } = await requestFrom(ownerStores, ownerId, profileRequest(Q, 'quiet'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readRoutineNotifyPreference(botAccount)).toEqual({ routine: 'all' });
    expect(sentFrames()).toHaveLength(sentBefore);
  }, 30_000);

  it('a socket dying after relay ack costs the app ack zero extra ratchet advances', async () => {
    let afterInbound = new Map<string, Buffer>();
    socket.onIncomingAck = () => {
      afterInbound = snapshotSessions();
      socket.forceClose(1006);
    };
    const { sentBefore } = await requestFrom(ownerStores, ownerId, profileRequest(Q, 'quiet'));
    await vi.waitFor(
      () =>
        expect(stderr.some((line) => line.includes('acknowledgement could not be sent'))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );

    expect(readRoutineNotifyPreference(botAccount)).toEqual({
      q: Q,
      routine: 'quiet',
    });
    expect(sentFrames()).toHaveLength(sentBefore);
    expectSessionsEqual(afterInbound, snapshotSessions());
  }, 30_000);
});
