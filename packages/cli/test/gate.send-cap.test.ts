import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrekeyBundle } from '@tacendum/shared';
// exit.js is pure (no config reads), so a static import cannot race the
// TACENDUM_HOME pin below the mocks.
import { CliError, EXIT } from '../src/exit.js';
import type { AuthSession } from '../src/session.js';

/**
 * THE SEND GUARD THE CLI NEVER HAD — an over-cap body
 * must be refused BEFORE the ratchet advances, and the refusal must leave the
 * persisted session state BYTE-IDENTICAL.
 *
 * The bug this gate closes: `sendEncrypted` encrypted and sent with no size
 * check. The 16 KB `MAX_BODY_BYTES` lived only in `composeBody` — the
 * `tacendum send` command — so every other caller (attend replies, room
 * fan-out, the notify queue, any future carrier) could hand libsignal an
 * oversized body. `encryptText` durably advances the sender chain whether or
 * not the frame is ever accepted; the server enforces its own cap
 * (`MAX_PAYLOAD_B64_LENGTH`, frames.ts) and drops the frame; on a one-way
 * ratchet that loss is permanent and the peer's next decrypt can fail. The
 * app refuses before enqueue in three places; the CLI refused in none.
 *
 * Method: REAL libsignal stores and a REAL established session — the point is
 * the bytes the session store persists, so `messaging.js` is deliberately NOT
 * mocked (gate.send-unify.test.ts mocks it to observe ordering; this file
 * exists because that suite therefore cannot observe the ratchet itself).
 * Only the transport (`wsclient.js`) and the bundle fetch (`api.js`) are
 * mocked: the first so a "delivered" frame needs no server, the second so the
 * suite can PROVE a refusal fetches no bundle — the fetch consumes one of the
 * peer's one-time prekeys server-side, which is ratchet work by any name.
 */

const h = vi.hoisted(() => ({
  connectCalls: 0,
  bundleFetches: 0,
  sentFrames: [] as Record<string, unknown>[],
}));

vi.mock('../src/wsclient.js', () => ({
  WsClient: class {
    async connect(): Promise<void> {
      h.connectCalls += 1;
    }
    onFrame(): void {}
    send(frame: Record<string, unknown>): void {
      h.sentFrames.push(frame);
    }
    async waitFor(): Promise<Record<string, unknown>> {
      const last = h.sentFrames[h.sentFrames.length - 1];
      return { type: 'receipt', msgId: last?.msgId, state: 'sent' };
    }
    close(): void {}
  },
}));

vi.mock('../src/api.js', () => ({
  apiGetPrekeyBundle: async (): Promise<never> => {
    h.bundleFetches += 1;
    throw new Error('unexpected prekey-bundle fetch: the guard must refuse first');
  },
}));

const home = mkdtempSync(join(tmpdir(), 'tacendum-send-cap-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');
const { decryptEnvelope, establishSession, generateAndStoreKeys, hasSession } = await import(
  '../src/messaging.js'
);
const { MAX_BODY_BYTES, sendEncrypted, sendEncryptedAll, sendEncryptedFanout } = await import(
  '../src/send.js'
);

afterAll(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const ALICE = '01ALICEALICEALICEALICEALIC';
const BOB = '01BOBBOBBOBBOBBOBBOBBOBBOB';
const CAROL = '01CAROLCAROLCAROLCAROLCARO';

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
): PrekeyBundle {
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: upload.oneTimePrekeys[0],
  };
}

/** A real pair of accounts with a real alice→bob session on disk. */
async function establishedPair(
  aliceName: string,
  bobName: string,
): Promise<{
  aliceStores: InstanceType<typeof FileStores>;
  bobStores: InstanceType<typeof FileStores>;
}> {
  const aliceStores = new FileStores(aliceName);
  const bobStores = new FileStores(bobName);
  await generateAndStoreKeys(aliceStores);
  const bobUpload = await generateAndStoreKeys(bobStores);
  await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload));
  return { aliceStores, bobStores };
}

const auth = { userId: ALICE } as unknown as AuthSession;

/** Every byte the session store persists, by file name. */
function snapshotSessions(stores: InstanceType<typeof FileStores>): Map<string, Buffer> {
  const dir = join(stores.root, 'sessions');
  const snap = new Map<string, Buffer>();
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

function reset(): void {
  h.connectCalls = 0;
  h.bundleFetches = 0;
  h.sentFrames.length = 0;
}

// A body the error must NEVER quote: if any of it leaks into
// the refusal, the refusal itself becomes a payload channel into hook stderr
// and CI logs.
const CANARY = 'CANARY_c0ffee_never_in_an_error';
const oversized = (): string => CANARY + 'x'.repeat(MAX_BODY_BYTES + 1 - CANARY.length);

describe('an over-cap body is refused before the ratchet advances', () => {
  it('one byte over refuses, and the persisted session is byte-identical', async () => {
    reset();
    const { aliceStores } = await establishedPair('alice-cap-1', 'bob-cap-1');
    const before = snapshotSessions(aliceStores);

    const body = oversized();
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_BODY_BYTES + 1);
    const err = await sendEncrypted({ stores: aliceStores, auth, to: BOB, body }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    // Actionable: names the actual size and the cap...
    expect((err as CliError).message).toContain(String(MAX_BODY_BYTES + 1));
    expect((err as CliError).message).toContain(String(MAX_BODY_BYTES));
    // ...and carries not one byte of the body.
    expect((err as CliError).message).not.toContain(CANARY);
    expect((err as CliError).message).not.toContain('xxxx');

    // THE POINT OF THE PHASE, asserted first so a regression fails on the
    // ratchet claim itself: the persisted session did not move a byte.
    expectByteIdentical(before, snapshotSessions(aliceStores));
    // And nothing else happened either: no dial, no frame.
    expect(h.connectCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
  });

  it('a body exactly at the cap sends, decrypts, and DOES advance the ratchet (the snapshot is falsifiable)', async () => {
    reset();
    const { aliceStores, bobStores } = await establishedPair('alice-cap-2', 'bob-cap-2');
    const before = snapshotSessions(aliceStores);

    const body = 'y'.repeat(MAX_BODY_BYTES);
    const outcome = await sendEncrypted({ stores: aliceStores, auth, to: BOB, body });

    expect(h.connectCalls).toBe(1);
    expect(h.sentFrames).toHaveLength(1);
    const frame = h.sentFrames[0] as { msgType: 'prekey' | 'ciphertext'; payload: string };
    expect(outcome.receipt.type).toBe('receipt');
    // The at-cap frame is genuinely deliverable end to end.
    expect(await decryptEnvelope(bobStores, BOB, ALICE, frame.msgType, frame.payload)).toBe(body);

    // CONTROL, and it is what makes the refusal test non-vacuous by
    // construction: this send moved the ratchet, and the snapshot comparison
    // SEES it. A snapshot method that passed both with and without an
    // advance would prove nothing above.
    const after = snapshotSessions(aliceStores);
    const changed = [...before].some(([name, bytes]) => !after.get(name)?.equals(bytes));
    expect(changed).toBe(true);
  });

  it('a batch refuses WHOLE: the in-cap first message is not sent either', async () => {
    reset();
    const { aliceStores } = await establishedPair('alice-cap-3', 'bob-cap-3');
    const before = snapshotSessions(aliceStores);

    const err = await sendEncryptedAll({
      stores: aliceStores,
      auth,
      to: BOB,
      messages: [{ body: 'small and fine' }, { body: oversized() }],
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // Checked up front, before the socket: a bad batch delivers NOTHING,
    // rather than its first message and then a refusal — the partial shape
    // sendEncryptedAll's own contract calls a mid-sequence failure.
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect(h.connectCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
    expectByteIdentical(before, snapshotSessions(aliceStores));
  });

  it('with NO session: the refusal fetches no bundle and writes no session', async () => {
    reset();
    const { aliceStores } = await establishedPair('alice-cap-4', 'bob-cap-4');
    const before = snapshotSessions(aliceStores);
    expect(await hasSession(aliceStores, CAROL)).toBe(false);

    const err = await sendEncrypted({
      stores: aliceStores,
      auth,
      to: CAROL,
      body: oversized(),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CliError);
    // The bundle fetch consumes one of the peer's one-time prekeys
    // server-side, and `establishSession` writes a session record locally —
    // ratchet work by any name. The guard ran before both.
    expect(h.bundleFetches).toBe(0);
    expect(await hasSession(aliceStores, CAROL)).toBe(false);
    expectByteIdentical(before, snapshotSessions(aliceStores));
  });

  it('fan-out: an over-cap leg SETTLES as failed/usage, other legs still deliver, nothing advanced for the refused leg', async () => {
    reset();
    const { aliceStores } = await establishedPair('alice-cap-5', 'bob-cap-5');

    const outcomes = await sendEncryptedFanout({
      stores: aliceStores,
      auth,
      legs: [
        { to: BOB, body: oversized(), msgId: '01FANOUTLEGONE0000000000AA' },
        { to: BOB, body: 'fits fine', msgId: '01FANOUTLEGTWO0000000000BB' },
      ],
    });

    // The fan-out contract holds: the bad leg is a settled outcome carrying
    // its slug (never the message — the reason field reaches --json logs),
    // and the room does not abort around it.
    expect(outcomes).toEqual([
      {
        to: BOB,
        msgId: '01FANOUTLEGONE0000000000AA',
        state: 'failed',
        reason: 'usage',
      },
      { to: BOB, msgId: '01FANOUTLEGTWO0000000000BB', state: 'delivered' },
    ]);
    expect(h.sentFrames).toHaveLength(1);
    expect((h.sentFrames[0] as { msgId: string }).msgId).toBe('01FANOUTLEGTWO0000000000BB');
  });

  it('fan-out with ONLY an over-cap leg leaves the session byte-identical', async () => {
    reset();
    const { aliceStores } = await establishedPair('alice-cap-6', 'bob-cap-6');
    const before = snapshotSessions(aliceStores);

    const outcomes = await sendEncryptedFanout({
      stores: aliceStores,
      auth,
      legs: [{ to: BOB, body: oversized(), msgId: '01FANOUTONLYLEG000000000CC' }],
    });

    expect(outcomes).toEqual([
      { to: BOB, msgId: '01FANOUTONLYLEG000000000CC', state: 'failed', reason: 'usage' },
    ]);
    expect(h.sentFrames).toHaveLength(0);
    expectByteIdentical(before, snapshotSessions(aliceStores));
  });
});
