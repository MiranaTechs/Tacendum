/**
 * AN IDENTITY CHANGE MUST BE RECORDED, ON EVERY PATH.
 *
 * An earlier revision unified the decrypt CLASSIFIER across `attachInbound` and
 * `CallSession` but not the ACTIONS, and `assertAllDispositionsHandled` proves
 * only that each disposition is branched on — never that the branches agree.
 * So `listen` recorded the identity change and `listen --calls` did not, even
 * though both had just called the same `classifyDecryptFailure` and got the
 * same answer for the same bytes.
 *
 * Why the omission is fatal rather than cosmetic: `tacendum trust` is
 * destructive (it un-pins a verified key and drops the session), so cmdTrust
 * refuses unless `stores.hasIdentityChange(peer)`. On a bot that only ever runs
 * `tacendum listen bot --calls --auto-answer`, the un-recorded change meant the
 * operator could never accept the new identity, every later message from that
 * peer failed the same way, and the whole conversation aged out at the server's
 * 30-day TTL.
 *
 * These tests are written as PARITY tests on purpose: the defect was never
 * "CallSession is wrong", it was "the two paths disagree". Asserting the same
 * two properties against both paths, from one real reinstall each, is what
 * makes the next divergence fail here instead of in a deployment.
 *
 * Revert that must make this file red: drop `this.stores.markIdentityChange(...)`
 * from call-session.ts, or shorten its warning back to "— withheld".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const { wsInstances } = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
  }>,
}));

vi.mock('ws', () => {
  // Enough of `ws` for CallSession.connect(): record the instance, open on the
  // next tick, capture outgoing frames, and expose the handlers so a test can
  // push server frames through the REAL WsClient parse path.
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

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-idparity-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://idparity.test';

const { FileStores } = await import('../src/stores.js');
const { address, generateAndStoreKeys, establishSession, encryptText, isIdentityChange } =
  await import('../src/messaging.js');
const { PrivateKey } = await import('@signalapp/libsignal-client');
const { attachInbound } = await import('../src/inbound.js');
const { MessageLog } = await import('../src/msglog.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;
type FileStoresT = InstanceType<typeof FileStores>;

const ulid = monotonicFactory();
const realFetch = globalThis.fetch;

/** Bundles the fake server hands out on `GET /v1/keys/:id`, per peer id. */
const prekeyBundles = new Map<string, PrekeyBundle>();

const CALLS_BOT = 'idp-calls-bot';
const PLAIN_BOT = 'idp-plain-bot';
const CALLS_BOT_ID = `01${'CALLSBOT'.repeat(3)}`;
const PLAIN_BOT_ID = `01${'PLAINBOT'.repeat(3)}`;
const ALICE_ID = `01${'ALICEAAA'.repeat(3)}`;

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

class FakeWs {
  handlers: ((f: ServerFrame) => void)[] = [];
  sent: ClientFrame[] = [];
  onFrame(h: (f: ServerFrame) => void): void {
    this.handlers.push(h);
  }
  send(f: ClientFrame): void {
    this.sent.push(f);
  }
  deliver(f: ServerFrame): void {
    for (const h of this.handlers) h(f);
  }
  acked(msgId: string): boolean {
    return this.sent.some(f => f.type === 'ack' && f.msgId === msgId);
  }
}

function fakeReporter(): { r: Reporter; notes: string[] } {
  const notes: string[] = [];
  const r = {
    json: false,
    plain: true,
    line: () => {},
    emit: () => {},
    note: (text: string) => notes.push(text),
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, notes };
}

/**
 * Alice, twice: the install the bot pins, and the reinstall that must raise
 * UntrustedIdentity. Two independent key sets under ONE user id is exactly what
 * a phone wipe looks like on the wire, and it is the only way to produce the
 * error through the real decrypt path rather than by throwing a hand-made one.
 */
async function aliceInstalls(
  tag: string,
  botId: string,
  botUpload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otkIndex: number,
): Promise<FileStoresT> {
  const stores = new FileStores(tag);
  await generateAndStoreKeys(stores);
  await establishSession(stores, ALICE_ID, bundleFrom(botId, botUpload, otkIndex));
  return stores;
}

let callsSession: InstanceType<typeof CallSession>;
let callsSocket: (typeof wsInstances)[number];
let callsBotStores: FileStoresT;
let plainBotStores: FileStoresT;
let callsAliceFresh: FileStoresT;
let plainAliceFresh: FileStoresT;
let stderr: string[];

beforeAll(async () => {
  callsBotStores = new FileStores(CALLS_BOT);
  const callsUpload = await generateAndStoreKeys(callsBotStores);
  saveProfile({
    name: CALLS_BOT,
    identityKey: callsUpload.identityKey,
    userId: CALLS_BOT_ID,
    authToken: 'live-calls-bot',
    registrationId: callsUpload.registrationId,
    deviceId: 1,
  });

  plainBotStores = new FileStores(PLAIN_BOT);
  const plainUpload = await generateAndStoreKeys(plainBotStores);
  saveProfile({
    name: PLAIN_BOT,
    identityKey: plainUpload.identityKey,
    userId: PLAIN_BOT_ID,
    authToken: 'live-plain-bot',
    registrationId: plainUpload.registrationId,
    deviceId: 1,
  });

  const callsAliceOriginal = await aliceInstalls('idp-alice-calls-1', CALLS_BOT_ID, callsUpload, 0);
  callsAliceFresh = await aliceInstalls('idp-alice-calls-2', CALLS_BOT_ID, callsUpload, 1);
  const plainAliceOriginal = await aliceInstalls('idp-alice-plain-1', PLAIN_BOT_ID, plainUpload, 0);
  plainAliceFresh = await aliceInstalls('idp-alice-plain-2', PLAIN_BOT_ID, plainUpload, 1);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://idparity.test', '');
    if (path === '/v1/ws-ticket') {
      return new Response(JSON.stringify({ ticket: 'tkt', expiresAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The earlier outbound tests drive `sendEncrypted` for real, and its
    // first-contact path fetches the peer's prekey bundle before the bootstrap.
    const keys = /^\/v1\/keys\/(.+)$/.exec(path);
    if (keys) {
      const bundle = prekeyBundles.get(decodeURIComponent(keys[1]!));
      if (bundle) {
        return new Response(JSON.stringify(bundle), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;

  // stderr is an assertion target here: the escape hatch is only an escape
  // hatch if the operator is told its name.
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  callsSession = new CallSession(CALLS_BOT);
  await callsSession.connect();
  callsSocket = wsInstances[wsInstances.length - 1]!;

  // FIRST CONTACT, on the original install: both bots must have alice's old key
  // PINNED, or the reinstall below is plain TOFU and raises nothing at all.
  const greetCalls = await encryptText(callsAliceOriginal, ALICE_ID, CALLS_BOT_ID, 'hello from the old install');
  const greetId = ulid();
  deliverToCalls({ type: 'msg', from: ALICE_ID, msgId: greetId, ...greetCalls, ts: Date.now() });
  await vi.waitFor(() => expect(callsAcked(greetId)).toBe(true), { timeout: 10000 });

  const greetPlain = await encryptText(plainAliceOriginal, ALICE_ID, PLAIN_BOT_ID, 'hello from the old install');
  const ws = new FakeWs();
  const { r } = fakeReporter();
  const inbound = attachInbound({
    name: PLAIN_BOT,
    userId: PLAIN_BOT_ID,
    stores: plainBotStores,
    ws: ws as unknown as WsClient,
    report: r,
    log: new MessageLog(PLAIN_BOT),
    consume: true,
  });
  ws.deliver({ type: 'msg', from: ALICE_ID, msgId: ulid(), ...greetPlain, ts: Date.now() });
  await inbound.settled();
}, 30000);

afterAll(() => {
  callsSession.close();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

function deliverToCalls(frame: ServerFrame): void {
  for (const h of callsSocket.handlers.message ?? []) h(JSON.stringify(frame));
}

function callsAcked(msgId: string): boolean {
  return callsSocket.sent.some(f => {
    const parsed = JSON.parse(f) as { type: string; msgId?: string };
    return parsed.type === 'ack' && parsed.msgId === msgId;
  });
}

/** The frame queue is serial: once a trailing already-seen marker has been
 * acked, every frame delivered before it has fully settled. */
async function settleCalls(): Promise<void> {
  const marker = ulid();
  callsBotStores.markSeen(marker);
  deliverToCalls({
    type: 'msg',
    from: ALICE_ID,
    msgId: marker,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1,
  });
  await vi.waitFor(() => expect(callsAcked(marker)).toBe(true), { timeout: 10000 });
}

describe('a classified identity change is recorded by every inbound path', () => {
  it('listen --calls (CallSession) records the change and names `tacendum trust`', async () => {
    expect(callsBotStores.hasIdentityChange(ALICE_ID)).toBe(false);
    const { msgType, payload } = await encryptText(
      callsAliceFresh,
      ALICE_ID,
      CALLS_BOT_ID,
      'first message after the reinstall',
    );
    const msgId = ulid();
    const before = stderr.length;

    deliverToCalls({ type: 'msg', from: ALICE_ID, msgId, msgType, payload, ts: Date.now() });
    await settleCalls();

    const warnings = stderr.slice(before);
    // The withhold half, unchanged: the row stays queued so it can decrypt
    // after the operator accepts the new identity.
    expect(callsAcked(msgId)).toBe(false);
    expect(callsBotStores.hasSeen(msgId)).toBe(false);
    expect(warnings.some(w => w.includes('SAFETY NUMBER CHANGED'))).toBe(true);
    // THE DEFECT: without this record `tacendum trust` exits USAGE and the pin
    // can never be cleared, so the withheld message is withheld forever.
    expect(callsBotStores.hasIdentityChange(ALICE_ID)).toBe(true);
    // …and the only command that clears it has to be discoverable from the
    // warning; the sole listener on a bot host never prints anything else.
    expect(warnings.some(w => w.includes(`tacendum trust ${CALLS_BOT}`))).toBe(true);
  }, 30000);

  it('listen (attachInbound) does the same, for the same bytes', async () => {
    expect(plainBotStores.hasIdentityChange(ALICE_ID)).toBe(false);
    const { msgType, payload } = await encryptText(
      plainAliceFresh,
      ALICE_ID,
      PLAIN_BOT_ID,
      'first message after the reinstall',
    );
    const msgId = ulid();
    const ws = new FakeWs();
    const { r, notes } = fakeReporter();
    const inbound = attachInbound({
      name: PLAIN_BOT,
      userId: PLAIN_BOT_ID,
      stores: plainBotStores,
      ws: ws as unknown as WsClient,
      report: r,
      log: new MessageLog(PLAIN_BOT),
      consume: true,
    });
    ws.deliver({ type: 'msg', from: ALICE_ID, msgId, msgType, payload, ts: Date.now() });
    await inbound.settled();

    expect(ws.acked(msgId)).toBe(false);
    expect(plainBotStores.hasSeen(msgId)).toBe(false);
    expect(notes.some(n => n.includes('SAFETY NUMBER CHANGED'))).toBe(true);
    expect(plainBotStores.hasIdentityChange(ALICE_ID)).toBe(true);
    expect(notes.some(n => n.includes(`tacendum trust ${PLAIN_BOT}`))).toBe(true);
  }, 30000);
});

describe('C1 — the OUTBOUND bootstrap records it too', () => {
  it('establishSession records the change itself, so no call site can forget', async () => {
    // An earlier revision fixed the inbound half and left a fourth raise site:
    // `CallSession.sendEncrypted` -> `establishSession` raises the very same
    // UntrustedIdentity for a calls-only daemon and recorded nothing, so
    // `tacendum trust` refused ("no identity change is pending") and every
    // message from that peer stayed undecryptable and queued until the 30-day
    // server TTL dropped it. Two reviewers found it independently.
    //
    // The rule now lives where the error is RAISED rather than at each caller,
    // because a rule that must be remembered at four call sites diverges at
    // the fifth. This test drives establishSession directly for that reason —
    // it is asserting the property of the raise site, not of one of its
    // callers.
    const sender = new FileStores('idp-outbound-sender');
    await generateAndStoreKeys(sender);

    // A peer, then the SAME peer id re-registering with a fresh identity key —
    // a reinstall, which is exactly what makes libsignal refuse.
    const first = new FileStores('idp-outbound-peer-1');
    const firstUpload = await generateAndStoreKeys(first);
    const second = new FileStores('idp-outbound-peer-2');
    const secondUpload = await generateAndStoreKeys(second);
    const PEER = `01${'OUTBOUND'.repeat(3)}`;

    await establishSession(sender, ALICE_ID, bundleFrom(PEER, firstUpload, 0));
    expect(
      sender.hasIdentityChange(PEER),
      'a healthy first bootstrap must not look like an identity change',
    ).toBe(false);

    await expect(
      establishSession(sender, ALICE_ID, bundleFrom(PEER, secondUpload, 0)),
    ).rejects.toThrow();

    expect(
      sender.hasIdentityChange(PEER),
      'the outbound bootstrap raised an identity change without recording it — ' +
        '`tacendum trust` will refuse and the peer can never be un-pinned',
    ).toBe(true);
  });
});

/**
 * An earlier review — the RECORD-FAILURE ordering, pinned on both directions.
 *
 * The rule both listeners state in prose is "record, then warn — and if the
 * record write fails, NO warning naming `tacendum trust` is printed, because a
 * warning that names a command certain to be refused is worse than the raw
 * error" (cmdTrust refuses unless `stores.hasIdentityChange(peer)`). Until this
 * round, that seam was pinned by comments only, and the OUTBOUND path violated
 * it: `establishSession` swallows a failed record write and rethrows, so
 * `sendEncrypted`'s catch — keyed on the error's TYPE alone — printed the
 * `trust` instruction over a record that never landed.
 *
 * Reverts that must make this block red: make `sendEncrypted`'s warning
 * unconditional again (test 2), or swap warn before record in either inbound
 * branch (tests 3 and 4).
 */
describe('C1 — no path names `tacendum trust` unless the record landed', () => {
  /** `sendEncrypted` is the seam under test; it is private by design, so the
   * tests reach it directly rather than through a full call setup. */
  function sendFromCallsBot(peerId: string, text: string): Promise<string> {
    return (
      callsSession as unknown as {
        sendEncrypted(peerId: string, body: string, urgent: boolean): Promise<string>;
      }
    ).sendEncrypted(peerId, text, false);
  }

  /** Pin an identity for `peerId` on the calls bot, then serve a bundle for
   * the SAME id under a DIFFERENT key — the outbound view of a reinstall. */
  async function reinstalledPeer(peerId: string, storeTag: string): Promise<void> {
    await callsBotStores.identity.saveIdentity(address(peerId), PrivateKey.generate().getPublicKey());
    const peerStores = new FileStores(storeTag);
    const upload = await generateAndStoreKeys(peerStores);
    prekeyBundles.set(peerId, bundleFrom(peerId, upload, 0));
  }

  it('outbound: when the record lands, the warning names `tacendum trust`', async () => {
    const PEER = `01${'OKRECPER'.repeat(3)}`;
    await reinstalledPeer(PEER, 'idp-out-ok-peer');

    const before = stderr.length;
    let thrown: unknown;
    await sendFromCallsBot(PEER, 'hi').catch(err => {
      thrown = err;
    });
    expect(isIdentityChange(thrown), 'the safety error must still propagate').toBe(true);

    const warnings = stderr.slice(before);
    expect(callsBotStores.hasIdentityChange(PEER)).toBe(true);
    expect(
      warnings.some(
        w => w.includes('SAFETY NUMBER CHANGED') && w.includes(`tacendum trust ${CALLS_BOT}`),
      ),
      'a recorded change must tell the operator the command that clears it',
    ).toBe(true);
  }, 30000);

  it('outbound: when the record write FAILS, nothing names `trust`', async () => {
    const PEER = `01${'RECFAILS'.repeat(3)}`;
    await reinstalledPeer(PEER, 'idp-out-fail-peer');
    const spy = vi.spyOn(FileStores.prototype, 'markIdentityChange').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const before = stderr.length;
      let thrown: unknown;
      await sendFromCallsBot(PEER, 'hi').catch(err => {
        thrown = err;
      });
      // `establishSession` swallows the failed record write; the raw safety
      // error is what reaches the caller, unchanged.
      expect(isIdentityChange(thrown)).toBe(true);

      const warnings = stderr.slice(before);
      expect(callsBotStores.hasIdentityChange(PEER)).toBe(false);
      expect(
        warnings.some(w => w.includes('tacendum trust')),
        'the record never landed, so cmdTrust would refuse — naming it is the defect',
      ).toBe(false);
      expect(warnings.some(w => w.includes('SAFETY NUMBER CHANGED'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('inbound (CallSession): a failed record suppresses the warning and leaves the frame queued', async () => {
    const { msgType, payload } = await encryptText(
      callsAliceFresh,
      ALICE_ID,
      CALLS_BOT_ID,
      'second message after the reinstall',
    );
    const spy = vi.spyOn(FileStores.prototype, 'markIdentityChange').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const msgId = ulid();
      const before = stderr.length;
      deliverToCalls({ type: 'msg', from: ALICE_ID, msgId, msgType, payload, ts: Date.now() });
      await settleCalls();

      const warnings = stderr.slice(before);
      expect(callsAcked(msgId)).toBe(false);
      expect(callsBotStores.hasSeen(msgId)).toBe(false);
      // Record-then-warn: the throw from the record write must reach the
      // frame-queue catch BEFORE any line names `trust`.
      expect(warnings.some(w => w.includes('SAFETY NUMBER CHANGED'))).toBe(false);
      expect(warnings.some(w => w.includes('frame processing error'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('inbound (attachInbound): the same ordering for the same bytes', async () => {
    const { msgType, payload } = await encryptText(
      plainAliceFresh,
      ALICE_ID,
      PLAIN_BOT_ID,
      'second message after the reinstall',
    );
    const spy = vi.spyOn(FileStores.prototype, 'markIdentityChange').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const msgId = ulid();
      const ws = new FakeWs();
      const { r, notes } = fakeReporter();
      const inbound = attachInbound({
        name: PLAIN_BOT,
        userId: PLAIN_BOT_ID,
        stores: plainBotStores,
        ws: ws as unknown as WsClient,
        report: r,
        log: new MessageLog(PLAIN_BOT),
        consume: true,
      });
      ws.deliver({ type: 'msg', from: ALICE_ID, msgId, msgType, payload, ts: Date.now() });
      await inbound.settled();

      expect(ws.acked(msgId)).toBe(false);
      expect(plainBotStores.hasSeen(msgId)).toBe(false);
      expect(notes.some(n => n.includes('SAFETY NUMBER CHANGED'))).toBe(false);
      expect(notes.some(n => n.includes('frame processing error'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30000);
});

