/**
 * ACK SAFETY. An ack deletes the server's only copy of a
 * message, so nothing may be acked that was not durably handled — and, the
 * harder half, nothing UNRECOVERABLE may be left to the "it will redeliver"
 * story, because the ratchet refuses the same ciphertext twice.
 *
 * Three release-blockers, each with the revert that must make its test fail:
 *  1. Post-decrypt spool failure was called "fail closed" but the message was
 *     already unrecoverable (ratchet advanced; redelivery purges as poison).
 *     Fix: preserve the plaintext in the undelivered quarantine before giving
 *     up. Revert: drop the `quarantineUndelivered` call in inbound.ts /
 *     call-session.ts.
 *  2. A LOCAL persistence failure during a decrypt (EIO/ENOSPC on the session
 *     save) is wrapped by libsignal in a code-Generic LibSignalErrorBase, so
 *     the `err instanceof CliError` guard missed it and the tamper branch
 *     ACKED a valid message away. Fix: the store-persistence probe. Revert:
 *     drop `|| probe.failed()` from either catch.
 *  3. CallSession.sendEncrypted ran `establishSession` — a session-store
 *     WRITE — outside the ratchet lock. Fix: bootstrap moved inside the same
 *     `withFileLockAsync` as the encrypt. Revert: move it back out.
 *
 * Real ciphertext through the real decrypt path throughout; the only fakes
 * are the socket, the reporter and fetch, because the properties under test
 * are about ACKS and PERSISTENCE, not cryptography.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
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
  // Enough of `ws` for CallSession.connect(): record the instance, open on
  // the next tick, capture outgoing frames, expose the message handlers so a
  // test can push server frames through the REAL WsClient parse path.
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
const home = mkdtempSync(join(tmpdir(), 'tacendum-acksafety-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://acksafety.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText, decryptEnvelope } = await import(
  '../src/messaging.js'
);
const { attachInbound, quarantineUndelivered, pruneUndelivered, undeliveredPath } = await import(
  '../src/inbound.js'
);
const { MessageLog, RETAIN_MS } = await import('../src/msglog.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');
const { clientDir, stateDir } = await import('../src/config.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;
type MessageRecord = import('../src/msglog.js').MessageRecord;

const ulid = monotonicFactory();

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otkIndex = 0,
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

/** The two WsClient methods the inbound policy uses, capturable. */
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

function fakeReporter(): { r: Reporter; lines: Record<string, unknown>[]; notes: string[] } {
  const lines: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const r = {
    json: true,
    plain: true,
    line: (record: Record<string, unknown>) => lines.push(record),
    emit: (record: Record<string, unknown>) => lines.push(record),
    note: (text: string) => notes.push(text),
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, lines, notes };
}

const ALICE = '01SENDERSENDERSENDERSENDER';
const BOB = '01RECVRECVRECVRECVRECVRECV';

const aliceStores = new FileStores('acks-alice');
const bobStores = new FileStores('acks-bob');
await generateAndStoreKeys(aliceStores);
const bobUpload = await generateAndStoreKeys(bobStores);
await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload));

const log = new MessageLog('acks-bob');

async function deliver(
  body: string,
  ws: FakeWs,
  r: Reporter,
  opts: { msgId?: string; msgType?: 'prekey' | 'ciphertext'; payload?: string } = {},
): Promise<string> {
  let msgType = opts.msgType;
  let payload = opts.payload;
  if (msgType === undefined || payload === undefined) {
    ({ msgType, payload } = await encryptText(aliceStores, ALICE, BOB, body));
  }
  const msgId = opts.msgId ?? ulid();
  const inbound = attachInbound({
    name: 'acks-bob',
    userId: BOB,
    stores: bobStores,
    ws: ws as unknown as WsClient,
    report: r,
    log,
    consume: true,
  });
  ws.deliver({ type: 'msg', from: ALICE, msgId, msgType, payload, ts: Date.now() });
  await inbound.settled();
  return msgId;
}

// Complete the handshake so later alice->bob envelopes are 'ciphertext' —
// the type whose on-disk session survives a failed save (the recovery test
// below depends on that, and asserts it).
{
  const ws = new FakeWs();
  const { r } = fakeReporter();
  await deliver('handshake: first contact', ws, r);
  const back = await encryptText(bobStores, BOB, ALICE, 'handshake: reply');
  await decryptEnvelope(aliceStores, ALICE, BOB, back.msgType, back.payload);
}

describe('the spool-failure path preserves the plaintext (inbound.ts)', () => {
  it('quarantines the decrypted message and still refuses to ack', async () => {
    const ws = new FakeWs();
    const { r, lines, notes } = fakeReporter();
    chmodSync(log.path, 0o400); // an append can no longer succeed
    let msgId: string;
    try {
      msgId = await deliver('quarantine payload — the last copy', ws, r);
    } finally {
      chmodSync(log.path, 0o600);
    }

    // The fail-closed half is unchanged: no ack, no seen, loud, shown.
    expect(ws.acked(msgId)).toBe(false);
    expect(bobStores.hasSeen(msgId)).toBe(false);
    expect(notes.some(n => n.includes('NOT acking'))).toBe(true);
    expect(lines.some(l => l.unlogged === true && l.text === 'quarantine payload — the last copy')).toBe(true);

    // THE FIX: the ratchet has advanced, so redelivery can never decrypt —
    // the quarantine is the only durable copy, and it must exist, hold the
    // record in spool shape, and be private.
    const qPath = undeliveredPath('acks-bob');
    expect(notes.some(n => n.includes(`preserved at ${qPath}`))).toBe(true);
    expect(existsSync(qPath)).toBe(true);
    const rows = readFileSync(qPath, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as MessageRecord);
    expect(rows.find(row => row.id === msgId)).toMatchObject({
      id: msgId,
      dir: 'in',
      peer: ALICE,
      tcm: '',
      text: 'quarantine payload — the last copy',
    });
    expect(statSync(qPath).mode & 0o077).toBe(0);
    // …and the broken spool itself gained nothing.
    expect(readFileSync(log.path, 'utf8')).not.toContain('quarantine payload');
  });

  it('refuses to quarantine into a loosened state dir, and says the render is the last copy', async () => {
    const ws = new FakeWs();
    const { r, lines, notes } = fakeReporter();
    chmodSync(stateDir('acks-bob'), 0o755); // fails BOTH the spool and the quarantine
    let msgId: string;
    try {
      msgId = await deliver('unpreservable payload', ws, r);
    } finally {
      chmodSync(stateDir('acks-bob'), 0o700);
    }
    expect(ws.acked(msgId)).toBe(false);
    // Honest about the residual, and no plaintext written where group/other
    // could read it.
    expect(notes.some(n => n.includes('ALSO failed'))).toBe(true);
    expect(readFileSync(undeliveredPath('acks-bob'), 'utf8')).not.toContain('unpreservable');
    expect(lines.some(l => l.text === 'unpreservable payload')).toBe(true);
  });

  it('ages quarantined rows out on the spool retention clock', () => {
    const name = 'acks-retention';
    const row = (text: string, ts: number): MessageRecord => ({
      id: ulid(),
      dir: 'in',
      peer: ALICE,
      ts,
      tcm: '',
      text,
      read: false,
    });
    quarantineUndelivered(name, row('ancient survivor', Date.now() - RETAIN_MS - 1000));
    expect(readFileSync(undeliveredPath(name), 'utf8')).toContain('ancient survivor');
    // A new quarantine write drops what has outlived the policy…
    quarantineUndelivered(name, row('fresh casualty', Date.now()));
    let content = readFileSync(undeliveredPath(name), 'utf8');
    expect(content).toContain('fresh casualty');
    expect(content).not.toContain('ancient survivor');
    // …and so does the prune every consuming attach runs, with no new write.
    quarantineUndelivered(name, row('stale straggler', Date.now() - RETAIN_MS - 1000));
    pruneUndelivered(name);
    content = readFileSync(undeliveredPath(name), 'utf8');
    expect(content).toContain('fresh casualty');
    expect(content).not.toContain('stale straggler');
  });
});

describe('a local persistence failure is not tamper (inbound.ts)', () => {
  it('leaves the frame queued when the session save fails, and consumes it on redelivery', async () => {
    const { msgType, payload } = await encryptText(aliceStores, ALICE, BOB, 'valid frame, failed save');
    // Premise of the recovery below: a 'ciphertext' envelope decrypts from
    // the on-disk session alone, so a save that never landed leaves the
    // redelivery fully decryptable. (A 'prekey' envelope would not — its
    // one-time prekey is consumed before the save — which is exactly the
    // residual the inline comments now state.)
    expect(msgType).toBe('ciphertext');
    const msgId = ulid();
    const sessionsDir = join(clientDir('acks-bob'), 'sessions');

    const ws = new FakeWs();
    const { r, notes } = fakeReporter();
    chmodSync(sessionsDir, 0o500); // the ratchet advance cannot be written
    try {
      await deliver('', ws, r, { msgId, msgType, payload });
    } finally {
      chmodSync(sessionsDir, 0o700);
    }

    // The old behaviour was the tamper branch: markSeen + ack — destroying
    // the server's only copy over OUR unwritable disk. Reverting the
    // `probe.failed()` guard makes all four of these fail.
    expect(ws.acked(msgId)).toBe(false);
    expect(bobStores.hasSeen(msgId)).toBe(false);
    expect(notes.some(n => n.includes('left on the server, will retry'))).toBe(true);
    expect(notes.some(n => n.includes('DECRYPT FAILED'))).toBe(false);

    // The disk recovers, the server redelivers the identical bytes: the
    // message decrypts, is spooled durably, and only then acked.
    const ws2 = new FakeWs();
    const { r: r2 } = fakeReporter();
    await deliver('', ws2, r2, { msgId, msgType, payload });
    expect(ws2.acked(msgId)).toBe(true);
    expect(bobStores.hasSeen(msgId)).toBe(true);
    const [latest] = log.read({ limit: 1 });
    expect(latest).toMatchObject({ id: msgId, text: 'valid frame, failed save' });
  });
});

describe('the mirrored CallSession paths (call-session.ts)', () => {
  const CALLER = 'acks-caller';
  const CALLER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const PEER1_ID = '01PEERPEERPEERPEERPEERPEER';
  const PEER2_ID = '01QRSTQRSTQRSTQRSTQRSTQRST';
  const LOCKED = 'acks-locked';
  const PEER3_ID = '01WXYZWXYZWXYZWXYZWXYZWXYZ';

  const realFetch = globalThis.fetch;
  let session: InstanceType<typeof CallSession>;
  let callerStores: InstanceType<typeof FileStores>;
  let peer1Stores: InstanceType<typeof FileStores>;
  let peer2Stores: InstanceType<typeof FileStores>;
  let callerSocket: (typeof wsInstances)[number];

  function deliverToCaller(frame: ServerFrame): void {
    for (const h of callerSocket.handlers.message ?? []) h(JSON.stringify(frame));
  }

  function ackedByCaller(msgId: string): boolean {
    return callerSocket.sent.some(f => {
      const parsed = JSON.parse(f) as { type: string; msgId?: string };
      return parsed.type === 'ack' && parsed.msgId === msgId;
    });
  }

  /** The frame queue is serial, so once a trailing already-seen marker frame
   * has been acked, every frame delivered before it has fully settled. */
  async function settleCaller(): Promise<void> {
    const marker = ulid();
    callerStores.markSeen(marker);
    deliverToCaller({
      type: 'msg',
      from: PEER1_ID,
      msgId: marker,
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 1,
    });
    await vi.waitFor(() => expect(ackedByCaller(marker)).toBe(true), { timeout: 5000 });
  }

  beforeAll(async () => {
    callerStores = new FileStores(CALLER);
    const callerUpload = await generateAndStoreKeys(callerStores);
    saveProfile({
      name: CALLER,
      identityKey: callerUpload.identityKey,
      userId: CALLER_ID,
      authToken: 'live-caller',
      registrationId: callerUpload.registrationId,
      deviceId: 1,
    });
    // Two inbound peers, on DIFFERENT one-time prekeys: the failed-save test
    // consumes peer1's before the failure, so peer2's must still be answerable.
    peer1Stores = new FileStores('acks-peer1');
    await generateAndStoreKeys(peer1Stores);
    await establishSession(peer1Stores, PEER1_ID, bundleFrom(CALLER_ID, callerUpload, 0));
    peer2Stores = new FileStores('acks-peer2');
    await generateAndStoreKeys(peer2Stores);
    await establishSession(peer2Stores, PEER2_ID, bundleFrom(CALLER_ID, callerUpload, 1));

    // The locked-bootstrap account, and the peer bundle its placeCall fetches.
    const lockedStores = new FileStores(LOCKED);
    const lockedUpload = await generateAndStoreKeys(lockedStores);
    saveProfile({
      name: LOCKED,
      identityKey: lockedUpload.identityKey,
      userId: CALLER_ID,
      authToken: 'live-locked',
      registrationId: lockedUpload.registrationId,
      deviceId: 1,
    });
    const peer3Bundle = bundleFrom(PEER3_ID, await generateAndStoreKeys(new FileStores('acks-peer3')));

    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input).replace('http://acksafety.test', '');
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/v1/ws-ticket') return json({ ticket: 'tkt', expiresAt: 1 });
      if (path === `/v1/keys/${PEER3_ID}`) return json(peer3Bundle);
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;

    session = new CallSession(CALLER);
    await session.connect();
    callerSocket = wsInstances[wsInstances.length - 1]!;
  }, 20000);

  afterAll(() => {
    session.close();
    globalThis.fetch = realFetch;
    if (previousHome === undefined) delete process.env.TACENDUM_HOME;
    else process.env.TACENDUM_HOME = previousHome;
    if (previousApi === undefined) delete process.env.TACENDUM_API;
    else process.env.TACENDUM_API = previousApi;
  });

  it('mirror: a failed store save leaves the frame on the server, not acked away', async () => {
    const { msgType, payload } = await encryptText(peer1Stores, PEER1_ID, CALLER_ID, 'call-path save failure');
    const msgId = ulid();
    const sessionsDir = join(clientDir(CALLER), 'sessions');
    chmodSync(sessionsDir, 0o500);
    try {
      deliverToCaller({ type: 'msg', from: PEER1_ID, msgId, msgType, payload, ts: Date.now() });
      await settleCaller();
    } finally {
      chmodSync(sessionsDir, 0o700);
    }
    // This branch did not exist here at all: CallSession had only identity
    // and tamper, so BOTH a lock refusal and a wrapped EACCES were acked
    // away. Reverting the guard flips both expectations.
    expect(ackedByCaller(msgId)).toBe(false);
    expect(callerStores.hasSeen(msgId)).toBe(false);
  });

  it('mirror: a spool-refused chat message is quarantined, not acked', async () => {
    // Seed the spool so its permissions can be broken.
    const callerLog = new MessageLog(CALLER);
    callerLog.append({
      id: ulid(),
      dir: 'in',
      peer: PEER2_ID,
      ts: Date.now(),
      tcm: '',
      text: 'seed',
      read: false,
    });
    const { msgType, payload } = await encryptText(
      peer2Stores,
      PEER2_ID,
      CALLER_ID,
      'call-path quarantine target',
    );
    const msgId = ulid();
    chmodSync(callerLog.path, 0o400);
    try {
      deliverToCaller({ type: 'msg', from: PEER2_ID, msgId, msgType, payload, ts: Date.now() });
      await settleCaller();
    } finally {
      chmodSync(callerLog.path, 0o600);
    }
    expect(ackedByCaller(msgId)).toBe(false);
    expect(callerStores.hasSeen(msgId)).toBe(false);
    const quarantined = readFileSync(undeliveredPath(CALLER), 'utf8');
    expect(quarantined).toContain('call-path quarantine target');
    expect(quarantined).toContain(msgId);
  });

  it('the first-contact bootstrap cannot mutate the session store outside the ratchet lock', async () => {
    const locked = new CallSession(LOCKED);
    // CONNECTED first: an earlier review (rank 3) closed the pre-connect
    // entry — a send now refuses at the socket-liveness gate before any
    // ratchet work (gate.call-socket-liveness.test.ts), so an unconnected
    // session would reject with the wrong error and never reach the lock
    // this test is about. This test used to enter through exactly that hole.
    await locked.connect();
    const root = clientDir(LOCKED);
    // 0500 on the account ROOT: the lock file cannot be created, so the lock
    // can never be taken — while sessions/ and identities/ INSIDE it stay
    // 0700-writable. Under the lock, an untakeable lock means the bootstrap
    // cannot have written anything; outside it (the defect), establishSession
    // writes both files before anyone asks for the lock.
    chmodSync(root, 0o500);
    try {
      await expect(locked.runner.placeCall(PEER3_ID, false)).rejects.toThrow(/account lock/);
      expect(existsSync(join(root, 'sessions', `${PEER3_ID}.1.bin`))).toBe(false);
      expect(existsSync(join(root, 'identities', `${PEER3_ID}.1.pub`))).toBe(false);
    } finally {
      chmodSync(root, 0o700);
      locked.close();
    }
  });
});

describe('a failure AFTER the ack is not a decrypt failure', () => {
  it('acks exactly once and never calls a delivered message rejected', async () => {
    // The decrypt catch used to span the RENDER as well as the decrypt, and
    // it feeds `classifyDecryptFailure` — which asks libsignal-shaped
    // questions and answers 'undecryptable' for anything it cannot place.
    // So `tacendum listen` piped into a pager the user quits, whose next
    // write throws EPIPE, took a message that was decrypted, spooled, marked
    // seen and ACKED, and ran it through the tamper branch: a SECOND ack on
    // the wire and `!! DECRYPT FAILED … — message rejected` printed about a
    // perfectly delivered message. CallSession closed its catch before the
    // render, so the two mirrored paths disagreed about one event.
    const ws = new FakeWs();
    const notes: string[] = [];
    const r = {
      json: false,
      plain: true,
      line: () => {
        const e = new Error('write EPIPE') as NodeJS.ErrnoException;
        e.code = 'EPIPE';
        throw e;
      },
      emit: () => {},
      note: (text: string) => notes.push(text),
      status: () => {},
      done: () => {},
    } as unknown as Reporter;

    const msgId = await deliver('a message that really was delivered', ws, r);

    const acks = ws.sent.filter(f => f.type === 'ack' && f.msgId === msgId);
    expect(acks.length, 'a render failure produced a SECOND ack').toBe(1);
    const said = notes.join('\n');
    expect(said, 'a delivered message was reported as a decrypt failure').not.toMatch(
      /DECRYPT FAILED/,
    );
    expect(said, 'a delivered message was reported as rejected').not.toMatch(/rejected/);
    // The record IS in the spool — the render failing must not lose it.
    expect(log.read().some(rec => rec.id === msgId), 'the delivered record is missing').toBe(true);
  });
});

