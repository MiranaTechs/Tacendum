/**
 * THE CALL PATH'S CONNECT-BEFORE-RATCHET
 * EXEMPTION WAS A FALSE CLAIM.
 *
 * call-session.ts was exempted from routing through send.ts on the claim that
 * connect-before-ratchet "holds by construction". The gate disproved it by
 * execution: connect → force close 1006 → placeCall RESOLVED, logged CALL
 * sent, flipped hasSession false→true — and zero frames left the machine,
 * because `ws` silently drops a send() on a closed socket. The peer never got
 * the prekey message, so every later ciphertext rides a session it never
 * established. The runner is also publicly reachable before connect() at all.
 *
 * The fix is an enforced gate, not a comment: `assertSocketOpen()` before any
 * ratchet work (the bundle fetch counts — it consumes a one-time prekey),
 * re-asked under the ratchet lock, and once more after the encrypt so a
 * mid-encrypt close fails the send loudly instead of returning a msgId for a
 * frame that never existed. Each test here fails against the pre-fix code:
 * the assertions are on RATCHET STATE and WIRE BYTES, not on wording.
 *
 * The ws mock is readyState-faithful (OPEN=1/CLOSED=3, static OPEN) because
 * liveness is the property under test; crypto is the real libsignal path
 * throughout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MsgType, PrekeyBundle } from '@tacendum/shared';

const { sockets, hooks } = vi.hoisted(() => ({
  sockets: [] as Array<{
    readyState: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
    sentAfterClose: string[];
    forceClose(code: number): void;
  }>,
  // Set by a test to run code at a precise point; see the lock mock below.
  hooks: { afterLockedSection: undefined as (() => void) | undefined },
}));

vi.mock('ws', () => {
  // readyState-faithful: CONNECTING until the next tick, then OPEN; a
  // forceClose flips to CLOSED and fires 'close' — the shape of a 1006. A
  // send() on a non-OPEN socket is recorded separately and NOT delivered,
  // exactly as `ws` drops sendAfterClose into an absorbed 'error' event.
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    sentAfterClose: string[] = [];
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
    forceClose(code: number) {
      this.readyState = 3;
      for (const h of this.handlers.close ?? []) h(code);
    }
    send(data: string) {
      if (this.readyState === 1) this.sent.push(data);
      else this.sentAfterClose.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// The one deterministic hook the mid-encrypt case needs: run the REAL lock,
// then fire the test's hook after the locked section (bootstrap + encrypt)
// returned but before control goes back to sendEncrypted — i.e. after the
// ratchet advanced, before the post-encrypt liveness check.
vi.mock('../src/lock.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/lock.js')>();
  return {
    ...real,
    withFileLockAsync: async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
      const result = await real.withFileLockAsync(path, fn);
      hooks.afterLockedSection?.();
      return result;
    },
  };
});

// Set BEFORE the src imports below: config.ts snapshots TACENDUM_API at module
// evaluation, and a top-level `await import` evaluates during collection.
const home = mkdtempSync(join(tmpdir(), 'tacendum-liveness-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://liveness.test';

const { FileStores } = await import('../src/stores.js');
const { decryptEnvelope, generateAndStoreKeys, hasSession } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');
const { MAX_BODY_BYTES } = await import('../src/send.js');
const { CliError, EXIT } = await import('../src/exit.js');

const CALLER = 'live-caller';
const CALLER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const callerStores = new FileStores(CALLER);
const callerUpload = await generateAndStoreKeys(callerStores);
const peerUpload = await generateAndStoreKeys(new FileStores('live-peer'));

// A FRESH peer id per test (same real key material), because hasSession is
// keyed by address: the mid-encrypt case genuinely writes a session, and a
// shared peer would let one test's leftovers satisfy — or poison — the next
// test's ratchet-state assertions.
let testNo = 0;
let peerId = '';
function peerBundle(): PrekeyBundle {
  return {
    userId: peerId,
    registrationId: peerUpload.registrationId,
    identityKey: peerUpload.identityKey,
    signedPrekey: peerUpload.signedPrekey,
    kyberPrekey: peerUpload.kyberPrekey,
    // A DISTINCT one-time prekey per test: a peer-side decrypt CONSUMES the
    // prekey the frame rode in on (libsignal deletes it from the store), so
    // a shared [0] lets the first decrypting test starve every later one.
    oneTimePrekey: peerUpload.oneTimePrekeys[testNo - 1],
  };
}

let keysFetched = 0;
/** Set by the fetch-window test: runs before the bundle response is returned. */
let onKeysFetch: (() => void) | undefined;

const realFetch = globalThis.fetch;

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://liveness.test', '');
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/ws-ticket') {
      return json(200, { ticket: 'tkt', expiresAt: 1 });
    }
    if (path === `/v1/keys/${peerId}`) {
      keysFetched += 1;
      onKeysFetch?.();
      return json(200, peerBundle());
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
}

beforeEach(() => {
  testNo += 1;
  peerId = `01PEERPEERPEERPEERPEERPE${String(testNo).padStart(2, '0')}`;
  saveProfile({
    name: CALLER,
    identityKey: callerUpload.identityKey,
    userId: CALLER_ID,
    authToken: 'live-token',
    registrationId: callerUpload.registrationId,
    deviceId: 1,
  });
  sockets.length = 0;
  keysFetched = 0;
  onKeysFetch = undefined;
  hooks.afterLockedSection = undefined;
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

/** Every 'send' frame that reached an OPEN socket, plus every one `ws` would
 * have silently dropped — the gate's "frames actually sent" count. */
function wireSends(): { delivered: string[]; dropped: string[] } {
  return {
    delivered: sockets.flatMap(s => s.sent).filter(f => (JSON.parse(f) as { type: string }).type === 'send'),
    dropped: sockets.flatMap(s => s.sentAfterClose),
  };
}

describe('a dead call socket costs zero ratchet advances (rank 3)', () => {
  it('the gate repro: close 1006 after connect() resolves — placeCall must refuse, not pretend', async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      socket.forceClose(1006);

      // Pre-fix: resolved, logged CALL sent, hasSession false→true, 0 frames.
      await expect(session.runner.placeCall(peerId, false)).rejects.toThrow(
        /call socket is not open/,
      );
    } finally {
      session.close();
    }

    // The three facts the gate measured, now with the right values:
    expect(await hasSession(callerStores, peerId)).toBe(false); // no advance
    expect(keysFetched).toBe(0); // no one-time prekey burned
    const { delivered, dropped } = wireSends();
    expect(delivered).toEqual([]); // nothing claimed sent…
    expect(dropped).toEqual([]); // …and nothing silently swallowed by ws
  });

  it('the runner is reachable before connect() — that entry path pays nothing either', async () => {
    const session = new CallSession(CALLER);
    try {
      // No connect() at all. Pre-fix this fetched the bundle, burned the
      // peer's one-time prekey, established the session, and only THEN blew
      // up on the undefined socket.
      await expect(session.runner.placeCall(peerId, false)).rejects.toThrow(
        /call socket is not open/,
      );
    } finally {
      session.close();
    }
    expect(await hasSession(callerStores, peerId)).toBe(false);
    expect(keysFetched).toBe(0);
  });

  it('a close during the bundle fetch is caught under the lock, before the session store pays', async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      onKeysFetch = () => sockets.at(-1)?.forceClose(1006);
      await expect(session.runner.placeCall(peerId, false)).rejects.toThrow(
        /call socket is not open/,
      );
    } finally {
      session.close();
    }
    // The fetch itself raced the close and was already in flight — that
    // prekey is spent. What the under-lock re-check protects is the RATCHET:
    // no session was written, so the treadmill (advances nothing can carry)
    // never starts.
    expect(keysFetched).toBe(1);
    expect(await hasSession(callerStores, peerId)).toBe(false);
    expect(wireSends().delivered).toEqual([]);
    expect(wireSends().dropped).toEqual([]);
  });

  it('a close landing mid-encrypt fails the send LOUDLY — never a msgId for a frame that never existed', async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      // Fires after bootstrap+encrypt returned from the locked section —
      // the ratchet HAS advanced — and before the post-encrypt check.
      hooks.afterLockedSection = () => sockets.at(-1)?.forceClose(1006);
      await expect(session.runner.placeCall(peerId, false)).rejects.toThrow(
        /call socket is not open/,
      );
    } finally {
      session.close();
    }
    // Honest about the residual: this one advance is lost (the session now
    // exists locally) — the property is that the caller was TOLD, nothing
    // was silently dropped into a closed socket, and the next send starts
    // at the entry gate with zero further advances.
    expect(await hasSession(callerStores, peerId)).toBe(true);
    expect(wireSends().delivered).toEqual([]);
    expect(wireSends().dropped).toEqual([]);
  });

  it('a live socket still sends — the guard gates on liveness, not on history', async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const cid = await session.runner.placeCall(peerId, false);
      expect(cid).toBeTruthy();
    } finally {
      session.close();
    }
    const { delivered } = wireSends();
    expect(delivered).toHaveLength(1);
    const frame = JSON.parse(delivered[0] as string) as { to: string; msgType: string };
    expect(frame.to).toBe(peerId);
    expect(await hasSession(callerStores, peerId)).toBe(true);
    expect(frame.msgType).toBe('prekey'); // first contact, real ratchet
  });
});

/** gate.send-cap's snapshot, transplanted: every byte the caller's session
 * store persists, by file name. The dir is created lazily by the first
 * session write, so an absent dir is an empty store, not an error. */
function snapshotSessions(): Map<string, Buffer> {
  const dir = join(callerStores.root, 'sessions');
  const snap = new Map<string, Buffer>();
  if (!existsSync(dir)) return snap;
  for (const name of readdirSync(dir).sort()) {
    snap.set(name, readFileSync(join(dir, name)));
  }
  return snap;
}

function expectByteIdentical(before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [name, bytes] of before) {
    expect(after.get(name)?.equals(bytes), `session file ${name} changed`).toBe(true);
  }
}

/**
 * The seam the guard lives in, typed narrowly — NOT the command path, and
 * that is a finding, not a shortcut: call.ts answers a FATAL send failure
 * with its designed aftermath (`localHangup` — "the hangup announces the
 * end"), which sends an in-cap `call.end` that legitimately fetches a
 * bundle, establishes the session and delivers. So no command-level entry
 * can hold the store byte-identical around a refusal; the state-purity
 * claim is asserted against exactly the method the commit names, and the
 * command path is pinned separately below for what is true of it.
 */
function sendSeam(session: InstanceType<typeof CallSession>): {
  sendEncrypted(peerId: string, body: string, urgent: boolean): Promise<string>;
} {
  return session as unknown as {
    sendEncrypted(peerId: string, body: string, urgent: boolean): Promise<string>;
  };
}

// A body the refusal must never quote: if any of it leaks
// into the message, the refusal itself becomes a payload channel into stderr
// and CI logs.
const CAP_CANARY = 'CAPCANARY_c0ffee_never_in_an_error';
const oversized = (): string => CAP_CANARY + 'x'.repeat(MAX_BODY_BYTES + 1 - CAP_CANARY.length);

describe('an over-cap call body costs zero ratchet advances', () => {
  it('one byte over refuses before the prekey fetch, the session write, and the wire', async () => {
    const session = new CallSession(CALLER);
    let err: unknown;
    let before: Map<string, Buffer>;
    try {
      await session.connect();
      before = snapshotSessions();
      const body = oversized();
      expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_BODY_BYTES + 1);
      err = await sendSeam(session)
        .sendEncrypted(peerId, body, false)
        .then(() => null, (e: unknown) => e);
    } finally {
      session.close();
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as InstanceType<typeof CliError>).exitCode).toBe(EXIT.USAGE);
    // Actionable: names the actual size and the cap...
    expect((err as InstanceType<typeof CliError>).message).toContain(String(MAX_BODY_BYTES + 1));
    expect((err as InstanceType<typeof CliError>).message).toContain(String(MAX_BODY_BYTES));
    // ...and carries not one byte of the body.
    expect((err as InstanceType<typeof CliError>).message).not.toContain(CAP_CANARY);
    expect((err as InstanceType<typeof CliError>).message).not.toContain('xxxx');

    // THE POINT, asserted the way gate.send-cap asserts it: the persisted
    // session store did not move a byte...
    expectByteIdentical(before, snapshotSessions());
    // ...no session came into being for this peer, the guard sat BEFORE the
    // bundle fetch (a one-time prekey the peer never gets back), and nothing
    // touched the wire — not even a frame for `ws` to swallow.
    expect(await hasSession(callerStores, peerId)).toBe(false);
    expect(keysFetched).toBe(0);
    expect(wireSends().delivered).toEqual([]);
    expect(wireSends().dropped).toEqual([]);
  });

  it('a body exactly at the cap sends, decrypts, and DOES move session bytes (the snapshot is falsifiable)', async () => {
    const session = new CallSession(CALLER);
    let before: Map<string, Buffer>;
    const body = 'y'.repeat(MAX_BODY_BYTES);
    try {
      await session.connect();
      before = snapshotSessions();
      expect(await sendSeam(session).sendEncrypted(peerId, body, false)).toBeTruthy();
    } finally {
      session.close();
    }

    expect(keysFetched).toBe(1);
    const { delivered } = wireSends();
    expect(delivered).toHaveLength(1);
    const frame = JSON.parse(delivered[0] as string) as { msgType: MsgType; payload: string };
    // The at-cap frame is genuinely deliverable end to end — the real peer
    // key material decrypts it, so the advance below bought a frame that
    // exists, not a stranded counter.
    expect(
      await decryptEnvelope(new FileStores('live-peer'), peerId, CALLER_ID, frame.msgType, frame.payload),
    ).toBe(body);

    // CONTROL, and it is what makes the refusal test non-vacuous by
    // construction: this send moved the ratchet, and the snapshot comparison
    // SEES it — a snapshot that passed both with and without an advance
    // would prove nothing above.
    expect(await hasSession(callerStores, peerId)).toBe(true);
    const after = snapshotSessions();
    const changed =
      [...after.keys()].some(name => !before.has(name)) ||
      [...before].some(([name, bytes]) => !after.get(name)?.equals(bytes));
    expect(changed).toBe(true);
  });

  it('an over-cap OFFER refuses at the command path, and the offer body never touches the wire', async () => {
    // The real path this residual was recorded against: the canary rides
    // inside the offer's SDP (fixtureSdp), so the envelope reaching
    // sendEncrypted is over the cap by construction, and the operator sees
    // the classified refusal (call.ts passes a CliError through verbatim).
    const session = new CallSession(CALLER, {
      canary: CAP_CANARY + 'x'.repeat(MAX_BODY_BYTES),
    });
    try {
      await session.connect();
      await expect(session.runner.placeCall(peerId, false)).rejects.toThrow(/too large/);
    } finally {
      session.close();
    }

    // What follows the refusal is call.ts's designed aftermath, pinned here
    // so it cannot silently change shape: the fatal send failure hangs the
    // call up, and the hangup ANNOUNCES the end — one in-cap `call.end`
    // frame, which legitimately establishes the session and delivers. The
    // property under test is that the over-cap OFFER paid nothing and rode
    // nothing: every frame that reached the wire decrypts cleanly at the
    // peer (no stranded counter) and none of them is the offer.
    const { delivered, dropped } = wireSends();
    expect(dropped).toEqual([]);
    expect(delivered).toHaveLength(1);
    const frame = JSON.parse(delivered[0] as string) as { msgType: MsgType; payload: string };
    const plaintext = await decryptEnvelope(
      new FileStores('live-peer'), peerId, CALLER_ID, frame.msgType, frame.payload,
    );
    expect((JSON.parse(plaintext) as { tcm: string }).tcm).toBe('call.end');
    expect(plaintext).not.toContain(CAP_CANARY);
  });
});
