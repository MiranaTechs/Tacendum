/**
 * Gate: CLI AUTOMATIC CALL RESPONSES MINTED
 * "ESTABLISHED CORRESPONDENT".
 *
 * The server decides whether a send confers a relationship — the reverse-
 * correspondence signal that exempts a future caller from the stranger ring
 * budget and the stranger queue cap — from two carrier bits it can read
 * (packages/server/src/handlers/ws.ts):
 *
 *     establishesCorrespondence = frame.urgent !== true && frame.notify !== false
 *
 * The APP marks every call frame `notify:false` (isCarrierEnvelope treats all
 * `call.*` as carrier, app/src/messaging.ts derives the bit at its one send
 * choke point), so an app's ringing/busy never establishes. The CLI sent call
 * frames with NO `notify` bit at all, while its reducer AUTOMATICALLY emits
 * `call.ringing` on any inbound offer and `call.end{r:'busy'}` when a second
 * offer lands mid-call. Both are non-urgent, so the server read
 * `urgent!==true && notify!==false` as TRUE and recorded correspondence a
 * stranger induced without the victim doing anything — bypassing exactly the
 * budget and queue limits those bits gate.
 *
 * The fix is the CLI's mirror of the app's choke-point derivation: every call
 * TRANSPORT frame leaves `CallSession.sendEncrypted` carrying `notify:false`.
 * These tests drive the two AUTOMATIC responses through the real reducer and
 * the real ratchet, capture the wire frame, and apply the server's own
 * predicate to it — a stranger's induced auto-response must not establish.
 *
 * The ws mock is readyState-faithful (OPEN=1) and crypto is the real
 * libsignal path throughout; only the socket and the network are
 * doubled, because the property under test is the shape of the bytes the
 * server keys on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrekeyBundle } from '@tacendum/shared';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{
    readyState: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
  }>,
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    constructor(_url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
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
      if (this.readyState === 1) this.sent.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports below: config.ts snapshots TACENDUM_API at module
// evaluation, and a top-level `await import` evaluates during collection.
const home = mkdtempSync(join(tmpdir(), 'tacendum-notify-carrier-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://notify-carrier.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');

const CALLER = 'nc-caller';
const CALLER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const callerStores = new FileStores(CALLER);
const callerUpload = await generateAndStoreKeys(callerStores);
const peerUpload = await generateAndStoreKeys(new FileStores('nc-peer'));

/** A fresh peer id per test (same real key material): sessions are keyed by
 * address, so a shared id would let one test's ratchet satisfy the next. */
let testNo = 0;
const bundles = new Map<string, PrekeyBundle>();
function registerPeer(suffix: string): string {
  const id = `01PEERPEERPEERPEERPEER${suffix.padStart(4, '0')}`;
  bundles.set(id, {
    userId: id,
    registrationId: peerUpload.registrationId,
    identityKey: peerUpload.identityKey,
    signedPrekey: peerUpload.signedPrekey,
    kyberPrekey: peerUpload.kyberPrekey,
    oneTimePrekey: peerUpload.oneTimePrekeys[0],
  });
  return id;
}

const realFetch = globalThis.fetch;
function install(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://notify-carrier.test', '');
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/ws-ticket') return json(200, { ticket: 'tkt', expiresAt: 1 });
    const keyMatch = path.match(/^\/v1\/keys\/(.+)$/);
    if (keyMatch) {
      const bundle = bundles.get(keyMatch[1] as string);
      if (bundle) return json(200, bundle);
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
}

beforeEach(() => {
  testNo += 1;
  bundles.clear();
  saveProfile({
    name: CALLER,
    identityKey: callerUpload.identityKey,
    userId: CALLER_ID,
    authToken: 'nc-token',
    registrationId: callerUpload.registrationId,
    deviceId: 1,
  });
  sockets.length = 0;
  install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

interface WireSend {
  to: string;
  urgent?: boolean;
  notify?: boolean;
  msgType: string;
}

/** Every 'send' frame that reached the OPEN socket, parsed. */
function wireSends(): WireSend[] {
  return sockets
    .flatMap(s => s.sent)
    .map(f => JSON.parse(f) as { type: string } & WireSend)
    .filter(f => f.type === 'send');
}

/**
 * The server's own classification, transcribed verbatim from
 * packages/server/src/handlers/ws.ts (the `establishesCorrespondence` line).
 * A frame that satisfies this mints the reverse-correspondence signal — the
 * ring-budget and stranger-queue exemption a stranger must never induce.
 */
function serverWouldEstablish(frame: WireSend): boolean {
  return frame.urgent !== true && frame.notify !== false;
}

describe('a stranger cannot induce correspondence through an automatic call response (NEW HIGH 4)', () => {
  it('call.ringing — auto-emitted on any inbound offer — carries notify:false and does not establish', async () => {
    const peer = registerPeer(String(testNo));
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const now = Date.now();
      // A bare inbound offer. No user action follows; the ringing reply is the
      // reducer's, sent automatically.
      await session.runner.receiveOffer(peer, '01RINGCIDRINGCIDRINGCIDCC0', 'x', false, now + 60_000, now);
    } finally {
      session.close();
    }

    const ringing = wireSends().find(f => f.to === peer);
    expect(ringing, 'the auto-ringing frame must reach the wire').toBeDefined();
    // The bit the app sets on every call.* and the CLI omitted:
    expect(ringing?.notify).toBe(false);
    // And therefore the server does not record correspondence:
    expect(serverWouldEstablish(ringing as WireSend)).toBe(false);
  });

  it('call.end{r:busy} — auto-emitted when a second offer lands mid-call — carries notify:false and does not establish', async () => {
    const target = registerPeer(`A${testNo}`);
    const stranger = registerPeer(`B${testNo}`);
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      // In a live outgoing call to `target`…
      await session.runner.placeCall(target, false);
      const now = Date.now();
      // …a DIFFERENT peer's offer (different cid) provokes an automatic busy
      // refusal to that stranger — no user action, no prior contact.
      await session.runner.receiveOffer(stranger, '01BUSYCIDBUSYCIDBUSYCIDCC0', 'x', false, now + 60_000, now);
    } finally {
      session.close();
    }

    const busy = wireSends().find(f => f.to === stranger);
    expect(busy, 'the auto-busy frame must reach the stranger').toBeDefined();
    expect(busy?.notify).toBe(false);
    expect(serverWouldEstablish(busy as WireSend)).toBe(false);
  });

  it('the urgent frames a call legitimately sends still never establish either (the offer/end path is unaffected)', async () => {
    const target = registerPeer(`U${testNo}`);
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      await session.runner.placeCall(target, false);
    } finally {
      session.close();
    }
    // call.offer is urgent — establishment is barred by `urgent !== true`
    // regardless of notify — but it must still carry notify:false so an
    // offline recipient gets the ring wake, never a "you have a new message"
    // banner for call transport.
    const offer = wireSends().find(f => f.to === target);
    expect(offer?.urgent).toBe(true);
    expect(offer?.notify).toBe(false);
    expect(serverWouldEstablish(offer as WireSend)).toBe(false);
  });
});
