/**
 * SHARED ROOM VAULT — the messaging half.
 *
 * What this file is actually protecting:
 *
 *  - BOTH SIDES GET A ROW. The vault is not a carrier: a peer changing
 *    the door code is a thing I am entitled to be told about, so it announces
 *    on both phones exactly as a timer change does. The timer shipped without
 *    that and the two sides disagreed silently — the sender saw raw JSON, the
 *    recipient saw nothing.
 *  - THE ROW BODY IS THE ENVELOPE, SECRET INCLUDED. That is how the state
 *    travels, so every path that turns a body into words has to be checked: the
 *    preview must say neither the value NOR the title, and nothing about the
 *    send may put the credential anywhere but the ratchet.
 *  - THE LOCAL WRITE HAPPENS ONLY IF THE FRAME WAS QUEUED. A refused send (a
 *    block, an unverified safety number) must leave the vault untouched, or
 *    this phone shows something the other phone was never told.
 *  - A REPLAY ANNOUNCES NOTHING. A write that changed nothing must not leave a
 *    row, or one replayed envelope becomes an endless stream of notices.
 *
 * Harness copied from messaging.timer.test.ts — same mocked ./db and ./ws.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: true };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return state.open;
    }
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

jest.mock('../src/db', () => ({
  // Device-set defaults: the reads every send
  // and receive now consults — an EMPTY world here, so suites predating
  // multi-device keep exercising the single-leg wire byte-for-byte. A suite
  // that defines its own version below wins (later keys override).
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  getPeerDevice: jest.fn(async () => null),
  upsertPeerDevice: jest.fn(async () => undefined),
  markChatOpened: jest.fn(async () => undefined),
  setLocalName: jest.fn(async () => undefined),
  replaceSiblingMachinePeers: jest.fn(async () => undefined),
  // vault
  getVaultItem: jest.fn(async () => null),
  listVaultSlots: jest.fn(async () => []),
  mergeVaultSlot: jest.fn(async () => true),
  commitVaultSlot: jest.fn(async () => true),
  releaseVaultSeq: jest.fn(async () => undefined),
  listVaultItems: jest.fn(async () => []),
  // A real allocator, not a constant: the counter is what the whole scheme
  // rests on, and a mock that handed out the same number twice would make
  // every ordering assertion here agree for the wrong reason. It honours
  // `floor` for the same reason — a mock that ignored it would let the
  // counter-regression repair be asserted against nothing.
  reserveVaultSeq: (() => {
    const counters = new Map<string, number>();
    return jest.fn(
      async (
        peerId: string,
        id: string,
        writerId: string,
        _at: number,
        floor = 0,
      ) => {
        const key = `${peerId}|${id}|${writerId}`;
        const next = Math.max((counters.get(key) ?? 0) + 1, floor + 1);
        counters.set(key, next);
        return next;
      },
    );
  })(),
  // disappearing messages
  setDisappearTimer: jest.fn(async () => true),
  armExpiry: jest.fn(),
  sweepExpired: jest.fn(async () => 0),
  getChat: jest.fn(async () => undefined),
  // reads
  hasSeen: jest.fn(),
  getMessage: jest.fn(),
  listOutbox: jest.fn(),
  listChats: jest.fn(),
  listMessages: jest.fn(),
  listAttachments: jest.fn(),
  listRecentMessages: jest.fn(),
  listHeldRevisions: jest.fn(),
  takeHeldRevision: jest.fn(),
  listIdentityChanged: jest.fn(),
  listBlockedPeers: jest.fn(),
  getBlockedAt: jest.fn(),
  loadProfile: jest.fn(),
  chatsMissingMyProfile: jest.fn(),
  peerHasMyProfile: jest.fn(),
  // writes
  insertMessage: jest.fn(),
  enqueueOutgoing: jest.fn(),
  touchChat: jest.fn(),
  upsertChat: jest.fn(),
  setChatPreview: jest.fn(),
  markSeen: jest.fn(),
  applyReceipt: jest.fn(),
  bumpOutboxAttempt: jest.fn(),
  deleteOutboxEnvelope: jest.fn(),
  markOutgoingError: jest.fn(),
  putAttachment: jest.fn(),
  setReaction: jest.fn(),
  applyEdit: jest.fn(),
  tombstoneMessage: jest.fn(),
  holdRevision: jest.fn(),
  dropHeldRevision: jest.fn(),
  applyPeerProfile: jest.fn(),
  setPeerAvatar: jest.fn(),
  markMyProfileSent: jest.fn(),
  saveMyProfileCard: jest.fn(),
  setIdentityChanged: jest.fn(),
  setSafetyChecked: jest.fn(),
  setSafetyMismatch: jest.fn(),
  clearPeerPairSafety: jest.fn(),
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
}));

import type { ProfileRow } from '../src/db';
import { VAULT_ACK_TRUST_MAX } from '../src/envelope';
import { BlockedPeerError, messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void; state?: (s: string) => void };
      calls: { start: jest.Mock; stop: jest.Mock; send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const ME = '01MEZZZ3NDEKTSV4RRFFQ69G5F';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';
const BLOCKED = '01BLOCKEDZ3NDEKTSV4RRFFQ69';
const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
/** The one string that must never leave the ratchet. */
const SECRET = '4417-front-door';

const MY_PROFILE: ProfileRow = {
  userId: ME,
  registrationId: 1,
  displayName: 'Me',
  about: 'here',
  avatarB64: '',
  profileVersion: 7,
};

async function flush(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Deliver one inbound frame whose plaintext is `body`. */
const SENDER_CLOCK = 1_700_000_000_000;

async function deliver(
  from: string,
  msgId: string,
  body: string,
  ts = SENDER_CLOCK,
): Promise<void> {
  crypto.decryptEnvelope.mockResolvedValueOnce(body);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts,
  });
  await flush();
}

/** A peer's counter for an item. Any positive integer will do — and that IS the
 * point: nothing on this wire is a clock any more, so there is no such thing as
 * a frame that is "too far ahead" to apply. */
const N = 3;

function vaultSet(
  id: string,
  title: string,
  body: string,
  n: number,
  k = 0,
): string {
  return JSON.stringify({ tcm: 'vault', op: 'set', id, title, body, n, k });
}
function vaultDel(id: string, n: number, k = 0): string {
  return JSON.stringify({ tcm: 'vault', op: 'del', id, n, k });
}

function resetDb(): void {
  const reads: Array<[string, unknown]> = [
    ['getVaultItem', null],
    ['listVaultSlots', []],
    ['mergeVaultSlot', true],
    ['commitVaultSlot', true],
    ['releaseVaultSeq', undefined],
    ['listVaultItems', []],
    ['hasSeen', false],
    ['getMessage', null],
    ['listOutbox', []],
    ['listChats', []],
    ['listMessages', []],
    ['listAttachments', []],
    ['listRecentMessages', []],
    ['listHeldRevisions', []],
    ['takeHeldRevision', null],
    ['listIdentityChanged', []],
    ['listBlockedPeers', []],
    ['getBlockedAt', null],
    ['loadProfile', null],
    ['chatsMissingMyProfile', []],
    ['peerHasMyProfile', false],
    ['applyEdit', true],
    ['tombstoneMessage', true],
    ['saveMyProfileCard', MY_PROFILE],
    ['getChat', undefined],
    ['setDisappearTimer', true],
    ['sweepExpired', 0],
  ];
  const writes = [
    'insertMessage',
    'enqueueOutgoing',
    'touchChat',
    'upsertChat',
    'setChatPreview',
    'markSeen',
    'applyReceipt',
    'bumpOutboxAttempt',
    'deleteOutboxEnvelope',
    'markOutgoingError',
    'putAttachment',
    'setReaction',
    'holdRevision',
    'dropHeldRevision',
    'applyPeerProfile',
    'setPeerAvatar',
    'markMyProfileSent',
    'setIdentityChanged',
    'setSafetyChecked',
    'setSafetyMismatch',
    'clearPeerPairSafety',
    'blockPeer',
    'unblockPeer',
    'armExpiry',
  ];
  for (const [name, value] of reads) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(value);
  }
  for (const name of writes) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
  db.reserveVaultSeq!.mockClear();
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  resetDb();
  ws.state.open = true;
  ws.calls.send.mockClear();
  ws.calls.start.mockClear();
  ws.calls.stop.mockClear();
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.decryptEnvelope!.mockReset();
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(false);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

async function start(): Promise<void> {
  db.listBlockedPeers!.mockResolvedValue([]);
  // Device-set reads: an EMPTY world, so the
  // single-leg wire this suite pins stays byte-for-byte what it was.
  db.listPeerDevices!.mockResolvedValue([]);
  db.listLinkedDevices!.mockResolvedValue([]);
  db.getPeerDevice!.mockResolvedValue(null);
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
  db.insertMessage!.mockClear();
  db.enqueueOutgoing!.mockClear();
  db.touchChat!.mockClear();
  db.mergeVaultSlot!.mockClear();
  db.commitVaultSlot!.mockClear();
  db.releaseVaultSeq!.mockClear();
  crypto.encryptText!.mockClear();
}

/** Every string this phone handed to anything that is not the ratchet. */
function nonWireStrings(): string {
  return JSON.stringify([
    db.touchChat!.mock.calls,
    db.setChatPreview!.mock.calls,
    db.upsertChat!.mock.calls,
  ]);
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('saving an item', () => {
  it('sends the envelope, stores one out row, and writes the item locally as ME', async () => {
    await start();
    const id = await messaging.saveVaultItem(FRIEND, {
      id: ITEM,
      title: 'Front door',
      body: SECRET,
    });
    await flush();

    expect(id).toBe(ITEM);
    const sent = crypto.encryptText!.mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(sent)).toMatchObject({
      tcm: 'vault',
      op: 'set',
      id: ITEM,
      title: 'Front door',
      body: SECRET,
    });
    // The sender's announcement row is free: encryptAndEnqueue stores every
    // plaintext it sends, and the body IS the envelope.
    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as {
      body: string;
      direction: string;
      peerId: string;
    };
    expect(row).toMatchObject({ peerId: FRIEND, direction: 'out' });
    expect(row.body).toBe(sent);
    // Committed into MY slot, at the number reserved before the frame was
    // built. `writerId` is not on the wire: it is my account id here and
    // `frame.from` on their phone, so no payload a peer can construct writes
    // into a slot that is not theirs.
    expect(db.commitVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: FRIEND,
        id: ITEM,
        title: 'Front door',
        body: SECRET,
        writerId: ME,
        seq: JSON.parse(sent).n,
        deleted: 0,
      }),
    );
  });

  it('reserves the counter BEFORE the frame and commits the content after it', async () => {
    // The order is the fix for DIVERGENCE 3. The number has to exist before the
    // envelope that carries it; the content must not exist until the envelope
    // is safely queued, or this phone shows something the other was never told.
    await start();
    const order: string[] = [];
    db.reserveVaultSeq!.mockImplementationOnce(async () => {
      order.push('reserve');
      return 7;
    });
    crypto.encryptText!.mockImplementationOnce(async () => {
      order.push('encrypt');
      return { msgType: 'ciphertext', payload: 'Q0lQSEVS' };
    });
    db.commitVaultSlot!.mockImplementationOnce(async () => {
      order.push('commit');
      return true;
    });

    await messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: 'b' });
    await flush();

    expect(order).toEqual(['reserve', 'encrypt', 'commit']);
    expect(JSON.parse(crypto.encryptText!.mock.calls.at(-1)?.[2] as string).n).toBe(
      7,
    );
  });

  it('two overlapping saves take two different numbers, and the later one wins', async () => {
    // DIVERGENCE 3 as it actually happened: the version was read early and
    // written late with an await in the gap, so two taps in quick succession
    // put two different bodies under one identical ordering key — and each
    // phone then resolved by its own arrival order.
    await start();
    await Promise.all([
      messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: 'first' }),
      messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: 'second' }),
    ]);
    await flush();

    const sent = crypto
      .encryptText!.mock.calls.map(c => JSON.parse(c[2] as string))
      .filter(e => e.tcm === 'vault');
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map(e => e.n)).size).toBe(2);
    // And each number carries its OWN body, on the wire and in the commit.
    for (const frame of sent) {
      expect(db.commitVaultSlot).toHaveBeenCalledWith(
        expect.objectContaining({ seq: frame.n, body: frame.body }),
      );
    }
  });

  it('tells the other phone what it had already seen of theirs', async () => {
    // `k`, the field a clock cannot express. Without it, "I edited after
    // reading your change" and "we both edited blind" are indistinguishable.
    await start();
    db.listVaultSlots!.mockResolvedValue([
      { writerId: FRIEND, seq: 4 },
      { writerId: ME, seq: 2 },
    ]);
    await messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: 'b' });
    await flush();
    expect(JSON.parse(crypto.encryptText!.mock.calls.at(-1)?.[2] as string).k).toBe(
      4,
    );
  });

  it('refuses an over-long value at the composer, before anything is allocated', async () => {
    // DIVERGENCE 1. This used to encode, encrypt and send happily, and arrive
    // as "Unsupported message" — with the server's copy already purged and the
    // ratchet key spent, so it was gone on both phones.
    await start();
    await expect(
      messaging.saveVaultItem(FRIEND, {
        id: ITEM,
        title: 'Backup codes',
        body: 'x'.repeat(9000),
      }),
    ).rejects.toMatchObject({
      name: 'VaultItemRefusedError',
      field: 'body',
      reason: 'too-long',
    });
    await flush();

    // Nothing at all happened: no counter, no ratchet, no prekey, no row.
    expect(db.reserveVaultSeq).not.toHaveBeenCalled();
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
    expect(db.commitVaultSlot).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
  });

  it('the typed refusal names the field and the limit, and never the value', async () => {
    // An error string is logged, rendered and sometimes copied. The value here
    // is a credential, so the message may name the box and not its contents.
    await start();
    await expect(
      messaging.saveVaultItem(FRIEND, { id: ITEM, title: '', body: SECRET }),
    ).rejects.toMatchObject({ field: 'title', reason: 'empty' });
    await expect(
      messaging.saveVaultItem(FRIEND, {
        id: ITEM,
        title: 'x'.repeat(81),
        body: SECRET,
      }),
    ).rejects.toMatchObject({ field: 'title', limit: 80 });
    await expect(
      messaging.saveVaultItem(FRIEND, {
        id: ITEM,
        title: 'Door',
        body: '{"tcm":"shot"}',
      }),
    ).rejects.toMatchObject({ field: 'body', reason: 'envelope' });
    const err = await messaging
      .saveVaultItem(FRIEND, {
        id: ITEM,
        title: 'Door',
        body: SECRET.repeat(2000),
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('limit 8192');
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('mints a ULID when the caller is creating rather than editing', async () => {
    await start();
    const id = await messaging.saveVaultItem(FRIEND, {
      title: 'Wi-Fi',
      body: 'hunter2',
    });
    await flush();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.parse(crypto.encryptText!.mock.calls.at(-1)?.[2] as string).id).toBe(
      id,
    );
  });

  it('takes the next number in MY slot, and a peer’s number cannot reach it', async () => {
    // What `max(now, current + 1)` was trying to do, without the clock. A peer
    // whose counter is enormous used to pin an item at a version this phone
    // could never beat; now their number lives on a different line entirely and
    // my slot simply counts on.
    await start();
    db.listVaultSlots!.mockResolvedValue([
      { writerId: FRIEND, seq: Number.MAX_SAFE_INTEGER },
    ]);

    await messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: 'b' });
    await flush();

    const sent = JSON.parse(crypto.encryptText!.mock.calls.at(-1)?.[2] as string);
    // A small number of my own, not a number derived from theirs.
    expect(sent.n).toBeLessThan(1000);
    expect(sent.k).toBe(Number.MAX_SAFE_INTEGER);
    // The floor is THEIR view of MY counter (their slot's ackSeq), which is 0
    // here because this peer has acknowledged nothing of mine — so their
    // enormous `seq` reaches my allocation no more than it reaches my slot.
    expect(db.reserveVaultSeq).toHaveBeenCalledWith(
      FRIEND,
      ITEM,
      ME,
      expect.any(Number),
      0,
    );
  });

  it('previews in words — never the value, never the title, never the envelope', async () => {
    // previewFor's output lands in chats.lastMessageText and is what a
    // notification would show: outside the Room, outliving the item, readable
    // without opening anything. The title is a label a person chose for a
    // secret, so it stays on the thread row and goes no further.
    await start();
    await messaging.saveVaultItem(FRIEND, {
      id: ITEM,
      title: 'Front door',
      body: SECRET,
    });
    await flush();

    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Saved to the vault',
      expect.any(Number),
    );
    const outside = nonWireStrings();
    expect(outside).not.toContain(SECRET);
    expect(outside).not.toContain('Front door');
    expect(outside).not.toContain('tcm');
  });

  it('the ANNOUNCEMENT expires with the Room; the ITEM does not', async () => {
    // The real interaction between the vault and disappearing messages, and it
    // is not the one the first draft tested. Outbound rows get an expiresAt
    // stamped whenever the Room's timer is on, envelope or not — so the notice
    // goes when the conversation does, while `vault_items` is a table
    // `sweepExpired` does not name and cannot reach (asserted in
    // db.vault.test.ts). A vault item is kept indefinitely; the design says so out
    // loud, because that is a retention INCREASE rather than a privacy gain.
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 3600 });

    await messaging.saveVaultItem(FRIEND, {
      id: ITEM,
      title: 'Front door',
      body: SECRET,
    });
    await flush();

    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as {
      expiresAt: number | null;
    };
    expect(row.expiresAt).toBeGreaterThan(Date.now());
    // The item write carries no expiry of any kind — there is no field for one.
    const item = db.commitVaultSlot!.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(item)).not.toContain('expiresAt');
  });

  it('a deletion re-transmits nothing — no title, no value on the wire', async () => {
    await start();
    await messaging.deleteVaultItem(FRIEND, ITEM);
    await flush();

    const sent = crypto.encryptText!.mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(sent)).toEqual({
      tcm: 'vault',
      op: 'del',
      id: ITEM,
      n: expect.any(Number),
      k: expect.any(Number),
    });
    expect(sent).not.toContain(SECRET);
    expect(db.commitVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: FRIEND,
        id: ITEM,
        writerId: ME,
        title: '',
        body: '',
        deleted: 1,
      }),
    );
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Removed from the vault',
      expect.any(Number),
    );
  });
});

describe('what a refused send must not leave behind', () => {
  it('sends NOTHING to a blocked peer, and writes no item', async () => {
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();
    crypto.encryptText!.mockClear();
    db.commitVaultSlot!.mockClear();
    db.reserveVaultSeq!.mockClear();
    db.enqueueOutgoing!.mockClear();
    ws.calls.send.mockClear();

    await expect(
      messaging.saveVaultItem(BLOCKED, { id: ITEM, title: 'a', body: SECRET }),
    ).rejects.toBeInstanceOf(BlockedPeerError);
    await expect(messaging.deleteVaultItem(BLOCKED, ITEM)).rejects.toBeInstanceOf(
      BlockedPeerError,
    );
    await flush();

    // No ratchet advance, no prekey of theirs consumed, no counter taken, no
    // row, nothing queued. The block gate is above the allocation too.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
    expect(db.reserveVaultSeq).not.toHaveBeenCalled();
    expect(db.commitVaultSlot).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  it('a changed safety number SURFACES, and the vault is left alone', async () => {
    // The one failure this path must not swallow: a vault write is the last
    // thing that should go quietly to a key nobody has verified. The content is
    // committed from onEnqueued, so a throw leaves nothing on screen — and the
    // reserved number is handed back, so it leaves nothing at all.
    await start();
    crypto.isIdentityChangeError!.mockReturnValue(true);
    crypto.encryptText!.mockRejectedValue(new Error('identity'));

    await expect(
      messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: SECRET }),
    ).rejects.toThrow(/safety number changed/);
    await flush();

    expect(db.commitVaultSlot).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(db.releaseVaultSeq).toHaveBeenCalledWith(
      FRIEND,
      ITEM,
      ME,
      expect.any(Number),
    );
  });

  it('but a throw AFTER the outbox commit gives NOTHING back', async () => {
    // The other half, and the sharper one. `releaseVaultSeq` used to run for
    // every throw, under a comment asserting "nothing reached the wire, so
    // nobody can be holding this number". That is false for everything after
    // `enqueueOutgoing`, which is its own transaction: touchChat, the content
    // commit, `notify()` (whose subscribers are unguarded, unlike
    // emitEnvelope's) and `flushPending()` all run afterwards.
    //
    // Releasing there walks my counter back to seq-1 while a durable outbox row
    // carrying seq is still queued. My next save reserves seq AGAIN with
    // different content, the peer's merge sees `seq > seq` as false and drops
    // it, and the two phones hold different credentials with nothing on either
    // screen to say so — and reconcileLocalState cannot repair it, because it
    // replays at the frame's own number against a slot that has been walked
    // back.
    //
    // A throwing UI subscriber is the cheapest way to reach that window and is
    // a real one: `notify()` is called on every send.
    await start();
    // Undo what the identity-change test above left on the singleton and on the
    // crypto mock, so the only failure in play is the one under examination.
    crypto.isIdentityChangeError!.mockReturnValue(false);
    crypto.encryptText!.mockResolvedValue({ msgType: 1, payload: 'ct' });
    await messaging.acceptIdentityChange(FRIEND);
    db.releaseVaultSeq!.mockClear();
    db.enqueueOutgoing!.mockClear();
    const unsubscribe = messaging.subscribe(() => {
      throw new Error('a listener blew up');
    });
    try {
      await expect(
        messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'a', body: SECRET }),
      ).rejects.toThrow(/listener blew up/);
      await flush();
    } finally {
      unsubscribe();
    }

    // The frame is durable and will flush, so the number it carries is spent.
    expect(db.enqueueOutgoing).toHaveBeenCalled();
    expect(db.releaseVaultSeq).not.toHaveBeenCalled();
  });
});

describe('a coerced write stays local and silent', () => {
  it('puts nothing on the wire, does not throw, and lands in the open workspace', async () => {
    // Without the duress seam this reaches encryptAndEnqueue and throws
    // 'messaging not started' — an error string a healthy real session never
    // produces, i.e. a one-tap oracle telling a coercer which code was entered.
    await start();
    messaging.stop();
    session.setMode('duress');
    db.loadProfile!.mockResolvedValue(MY_PROFILE);
    crypto.encryptText!.mockClear();
    ws.calls.send.mockClear();
    db.insertMessage!.mockClear();

    await expect(
      messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'Door', body: SECRET }),
    ).resolves.toBe(ITEM);
    await flush();

    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
    // The decoy vault visibly accepts it, and the row lands 'sent' — a
    // 'pending' row would show a spinner that resolves in a workspace with no
    // socket.
    expect(db.commitVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: FRIEND, id: ITEM, body: SECRET }),
    );
    expect(db.insertMessage!.mock.calls.at(-1)?.[0]).toMatchObject({
      direction: 'out',
      status: 'sent',
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('a vault write arriving from the peer', () => {
  it('applies it into THEIR slot and announces it with one in row', async () => {
    await start();
    await deliver(FRIEND, '01VAULTIN', vaultSet(ITEM, 'Front door', SECRET, N));

    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: FRIEND,
        id: ITEM,
        title: 'Front door',
        body: SECRET,
        seq: N,
        // THEIR account id, taken from `frame.from` and never from the payload:
        // a peer cannot write into a slot that is not theirs.
        writerId: FRIEND,
        deleted: 0,
      }),
    );
    expect(db.insertMessage!.mock.calls.at(-1)?.[0]).toMatchObject({
      msgId: '01VAULTIN',
      peerId: FRIEND,
      direction: 'in',
      body: vaultSet(ITEM, 'Front door', SECRET, N),
      status: 'received',
    });
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Saved to the vault',
      expect.any(Number),
    );
    expect(nonWireStrings()).not.toContain(SECRET);
  });

  it('stamps updatedAt with THIS phone’s clock, never the sender’s (minor 4)', async () => {
    // `frame.ts` inbound and `Date.now()` outbound is what made the two phones
    // list the same vault in different orders even when every value agreed.
    await start();
    const senderClock = 1_700_000_000_000; // what `deliver` puts in frame.ts
    await deliver(FRIEND, '01VAULTIN', vaultSet(ITEM, 'Door', SECRET, N));
    const applied = db.mergeVaultSlot!.mock.calls.at(-1)?.[0] as {
      updatedAt: number;
    };
    expect(applied.updatedAt).not.toBe(senderClock);
    expect(applied.updatedAt).toBeGreaterThan(senderClock);
  });

  it('persists the row BEFORE acking, so a crash cannot lose the notice', async () => {
    await start();
    const order: string[] = [];
    db.insertMessage!.mockImplementation(async () => {
      order.push('insertMessage');
    });
    db.markSeen!.mockImplementation(async () => {
      order.push('markSeen');
    });
    ws.calls.send.mockImplementation(() => {
      order.push('ack');
      return true;
    });

    await deliver(FRIEND, '01VAULTIN', vaultSet(ITEM, 'Door', SECRET, N));

    expect(order).toEqual(['insertMessage', 'markSeen', 'ack']);
  });

  it('a superseded or replayed frame announces nothing — and is still acked', async () => {
    // Otherwise one replayed envelope becomes an endless stream of
    // "they saved ... to the vault" lines.
    await start();
    db.mergeVaultSlot!.mockResolvedValue(false);

    await deliver(FRIEND, '01OLD', vaultSet(ITEM, 'Door', 'stale', 1));

    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01OLD' });
  });

  it('DIVERGENCE 2: an honest 25-hour clock skew no longer silences the item', async () => {
    // A peer restoring from a backup with a wrong date. The old guard dropped
    // anything stamped more than 24h ahead AND ACKED IT, which purged the
    // server's copy and spent the ratchet key — so that item was gone for good.
    // Nothing in the ordering is a clock now, so there is nothing to clamp and
    // no reason to drop: the frame applies, and its `updatedAt` is stamped from
    // THIS phone rather than from the peer's broken one.
    await start();
    const skewed = Date.now() + 25 * 60 * 60 * 1000;
    await deliver(FRIEND, '01SKEWED', vaultSet(ITEM, 'Door', SECRET, N), skewed);

    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({ seq: N, body: SECRET }),
    );
    const applied = db.mergeVaultSlot!.mock.calls.at(-1)?.[0] as {
      updatedAt: number;
    };
    expect(applied.updatedAt).toBeLessThan(skewed);
    expect(db.insertMessage).toHaveBeenCalled();
  });

  it('DIVERGENCE 2: and their NEXT edit lands too, so nothing is sticky', async () => {
    // The sticky half, which was the worse one. Under the old rule the poisoned
    // version was inherited by every later write of that item — `max(now,
    // current + 1)` — so once a skewed frame had been seen, the clamp kept
    // firing on that one credential forever, even after the clock was fixed.
    await start();
    const skewed = Date.now() + 25 * 60 * 60 * 1000;
    await deliver(FRIEND, '01ONE', vaultSet(ITEM, 'Door', 'first', 1), skewed);
    await deliver(FRIEND, '01TWO', vaultSet(ITEM, 'Door', 'second', 2), skewed);
    await deliver(FRIEND, '01THREE', vaultSet(ITEM, 'Door', 'third', 3));
    const applied = db
      .mergeVaultSlot!.mock.calls.map(c => (c[0] as { body: string }).body);
    expect(applied).toEqual(['first', 'second', 'third']);
  });

  it('clamps a peer’s acknowledgement to a write I actually made', async () => {
    // Unclamped, `k: 999999` claims they had seen a write of mine that never
    // existed — their slot would then dominate mine and my value would vanish
    // with no trace. `k` can only legitimately name one of MY writes, so the
    // clamp is exact rather than heuristic.
    await start();
    db.listVaultSlots!.mockResolvedValue([{ writerId: ME, seq: 2 }]);
    await deliver(FRIEND, '01LIAR', vaultSet(ITEM, 'Door', SECRET, N, 999_999));

    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({ ackSeq: 2 }),
    );
  });

  it('an acknowledgement I hold no slot to check is BELIEVED — it is the repair', async () => {
    // This used to store 0 here, on the reasoning that an unverifiable claim
    // should count for nothing. That reasoning was wrong, and it cost an item:
    // the ONE case where I hold no slot to check against is the case where
    // `deleteChat` purged it, and 0 threw away the only
    // surviving record of how high MY counter had got. My next write then
    // restarted at 1 under a peer still holding 7, and the merge's one-way
    // ratchet discarded every frame in between — silently, permanently, with
    // the two phones showing different door codes.
    //
    // `k` IS that record: it is their copy of my counter, and believing it
    // suppresses nothing, because the slot it would order against does not
    // exist and my next reservation is floored above it (see the test below).
    await start();
    db.listVaultSlots!.mockResolvedValue([]);
    await deliver(FRIEND, '01FIRST', vaultSet(ITEM, 'Door', SECRET, 1, 5));
    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({ ackSeq: 5 }),
    );
  });

  it('a relock between the READ and the WRITE writes nothing and acks nothing', async () => {
    // the quiesce rules: an entry guard is not enough, because a
    // continuation suspended in an await must not write into whichever
    // workspace opened next. This branch reads my slot (for the clamp) and then
    // writes, and it was the one write in the inbound vault path with no
    // re-check between the two — its neighbours both have one.
    //
    // Acking matters as much as writing: an acked frame is purged from the
    // server and the ratchet key is spent, so a frame applied to nothing and
    // acked anyway is a credential nobody has. Redelivery is the only repair
    // this transport has, and it only happens if we stay silent.
    await start();
    db.listVaultSlots!.mockImplementation(async () => {
      messaging.stop(); // the lock screen, landing mid-merge
      return [];
    });

    await deliver(FRIEND, '01RELOCK', vaultSet(ITEM, 'Door', SECRET, 1, 0));

    expect(db.mergeVaultSlot).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalledWith({
      type: 'ack',
      msgId: '01RELOCK',
    });
    db.listVaultSlots!.mockResolvedValue([]);
  });

  it('but only up to a bound, so a liar cannot exhaust my counter', async () => {
    // The price of believing it. `k` may legally be MAX_SAFE_INTEGER, and a
    // floor that high makes my very next number unsendable — the schema refuses
    // `n` above MAX_SAFE_INTEGER — which would freeze that item against its own
    // owner. Loud rather than silent, but still a peer-triggered denial, so the
    // claim is bounded where it is believed.
    await start();
    db.listVaultSlots!.mockResolvedValue([]);
    await deliver(
      FRIEND,
      '01GREEDY',
      vaultSet(ITEM, 'Door', SECRET, 1, Number.MAX_SAFE_INTEGER),
    );
    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({ ackSeq: VAULT_ACK_TRUST_MAX }),
    );
  });

  it('THE REPAIR: after the conversation is deleted, my writes still land', async () => {
    // End to end, and the whole reason the two changes above exist.
    //
    // `deleteChat` purges vault_items for that peer and tells the peer nothing,
    // so MY counter restarts while THEIR copy of my slot stays at 7. The item
    // can only come back through one of their frames — and that frame carries
    // k = 7, which is exactly the number my next write has to clear.
    await start();
    // An earlier test in this file leaves FRIEND's safety number unaccepted on
    // the singleton, and this test sends: clear it, so the refusal under
    // examination is the vault's and not that one's.
    await messaging.acceptIdentityChange(FRIEND);
    // Nothing left locally: the purge happened.
    db.listVaultSlots!.mockResolvedValue([]);
    await deliver(FRIEND, '01BACK', vaultSet(ITEM, 'Door', 'theirs', 9, 7));
    const merged = db.mergeVaultSlot!.mock.calls.at(-1)?.[0] as {
      ackSeq: number;
    };
    expect(merged.ackSeq).toBe(7);

    // Now I edit it. The slot list the sender reads is the state that merge
    // produced: their slot at seq 9, holding their view of my counter.
    db.listVaultSlots!.mockResolvedValue([
      { writerId: FRIEND, seq: 9, ackSeq: 7 },
    ]);
    await messaging.saveVaultItem(FRIEND, { id: ITEM, title: 'Door', body: 'mine' });
    await flush();

    const sent = JSON.parse(crypto.encryptText!.mock.calls.at(-1)?.[2] as string);
    // Strictly above the high-water mark they still hold, so their merge guard
    // applies it instead of discarding it. Without the floor this is 1.
    expect(sent.n).toBeGreaterThan(7);
    expect(db.reserveVaultSeq).toHaveBeenCalledWith(
      FRIEND,
      ITEM,
      ME,
      expect.any(Number),
      7,
    );
  });

  it('a set with no title or no value is dropped rather than stored blank', async () => {
    // Both fields are optional on the wire because a `del` carries neither, so
    // "absent" is a shape a peer can send at will. Dropped where it is APPLIED
    // and not refused by the parser: a parser refusal costs the whole message,
    // and this transport gives no second copy.
    await start();
    await deliver(FRIEND, '01NOTITLE', JSON.stringify({ tcm: 'vault', op: 'set', id: ITEM, body: SECRET, n: N, k: 0 }));
    await deliver(FRIEND, '01NOBODY', JSON.stringify({ tcm: 'vault', op: 'set', id: ITEM, title: 'Door', n: N, k: 0 }));

    expect(db.mergeVaultSlot).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01NOTITLE' });
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01NOBODY' });
  });

  it('a deletion tombstones and announces', async () => {
    await start();
    await deliver(FRIEND, '01VAULTDEL', vaultDel(ITEM, N));

    expect(db.mergeVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: FRIEND,
        id: ITEM,
        writerId: FRIEND,
        seq: N,
        title: '',
        body: '',
        deleted: 1,
      }),
    );
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Removed from the vault',
      expect.any(Number),
    );
  });

  it('a blocked peer’s vault frame is decrypted and dropped — nothing is written', async () => {
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();
    db.mergeVaultSlot!.mockClear();
    db.insertMessage!.mockClear();

    await deliver(BLOCKED, '01BLOCKEDVAULT', vaultSet(ITEM, 'Door', SECRET, N));

    expect(db.mergeVaultSlot).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
    // Still acked: an un-drained queue is itself a tell.
    expect(ws.calls.send).toHaveBeenCalledWith({
      type: 'ack',
      msgId: '01BLOCKEDVAULT',
    });
  });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('boot-time replay', () => {
  it('re-commits my own vault rows, because the content write hangs off onEnqueued', async () => {
    // The window react/edit/del also have: the outbox row is committed and the
    // process dies before the side effect lands. Exactly idempotent here — the
    // frame carries the number that was reserved for it, so the replay rewrites
    // the same bytes at the same number. THE THREAD ROW IS THE VAULT'S
    // WRITE-AHEAD LOG, and it is the only durable second copy there is.
    db.listChats!.mockResolvedValue([{ peerId: FRIEND }]);
    db.listMessages!.mockResolvedValue([
      {
        msgId: '01MINE',
        peerId: FRIEND,
        direction: 'out',
        body: vaultSet(ITEM, 'Door', SECRET, 4, 2),
        ts: 1_700_000_000_000,
        status: 'sent',
      },
      {
        msgId: '01THEIRS',
        peerId: FRIEND,
        direction: 'in',
        body: vaultSet(ITEM, 'Door', 'theirs', 3),
        ts: 1_700_000_000_001,
        status: 'received',
      },
    ]);

    await messaging.start(ME);
    await flush();

    // Mine only. Their row is not replayed: the inbound handler already applied
    // it before it acked, and replaying it would let a redelivered frame count
    // twice.
    expect(db.mergeVaultSlot).not.toHaveBeenCalled();
    expect(db.commitVaultSlot).toHaveBeenCalledTimes(1);
    expect(db.commitVaultSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ITEM,
        body: SECRET,
        writerId: ME,
        seq: 4,
        ackSeq: 2,
      }),
    );
    // And it takes no new number: a replay must not be able to advance the
    // counter, or every launch would look like a fresh edit to the peer.
    expect(db.reserveVaultSeq).not.toHaveBeenCalled();
  });
});
