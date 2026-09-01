/**
 * ROOMS — the send path.
 *
 * What this file proves, and against what:
 *
 *  - fanOut's gate order and composition — duress above everything, block
 *    before ANY allocation, identity-change skipping one member loudly — are
 *    proved against the transport mock and a module-mocked `../src/db`,
 *    because every assertion is about CALLS (what reached the wire, what was
 *    allocated, what was refused) rather than about SQL.
 *  - The one-transaction invariant's SQL lives in db.enqueueOutgoingFanout
 *    and is pinned by db.fanout.test.ts and was PROVED separately on Node's
 *    real SQLite engine; here we pin that fanOut hands
 *    that one function one message row and all N legs — and never touches
 *    enqueueOutgoing/insertMessage on the real path.
 *  - The wire-id property is re-asserted AT THIS LAYER: the pure-layer
 *    test proves randomMsgId's output; this proves the send path actually
 *    routes every leg through it (a fanOut quietly minting nextMsgId ULIDs
 *    would pass the pure test and hand the server a membership join key).
 *  - Pacing runs against fake clocks (modern fake timers drive Date.now and
 *    the resume timer in lockstep): a fan-out to 11 members never exceeds 24
 *    frames in any 6-second window, legs are jittered, and a fan-out the
 *    budget cannot admit is QUEUED (zero sends, zero attempt bumps) rather
 *    than started.
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
    start(_token: string) {
      calls.start(_token);
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
  apiWsTicket: jest.fn(),
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
  // reads
  getChat: jest.fn(),
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
  // rooms
  getGroup: jest.fn(),
  listGroupMemberSlots: jest.fn(),
  listGroupSettingsSlots: jest.fn(),
  // The marker-OR-record agent set fanOut prunes non-mention legs by.
  listMachinePeers: jest.fn(),
  listRoomAgentAuthorIds: jest.fn(),
  reserveGroupSeq: jest.fn(),
  enqueueOutgoingFanout: jest.fn(),
  aggregateFanoutStatus: jest.fn(),
  markLegFailed: jest.fn(),
  fanoutDeliveryState: jest.fn(),
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

import type { FanoutLeg, MessageRow, OutboxRow } from '../src/db';
import * as blocking from '../src/blocking';
import { MENTION_MARK } from '../src/envelope';
import {
  groupDeliveryNotice,
  groupSafetySkipBanner,
  messaging,
} from '../src/messaging';
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

const ME = '01ME00000000000000000000AA';
const ROOM = '01R88MZ3NDEKTSV4RRFFQ69G5A';
/** Valid Crockford ULIDs (no I, L, O, U) for the other eleven seats. */
function member(i: number): string {
  return `01MBR${String(i).padStart(3, '0')}${'0'.repeat(18)}`;
}
const MEMBERS = Array.from({ length: 11 }, (_, i) => member(i));

/** Long enough for the send chain (fold → gates → encrypt ×11 → enqueue). */
async function flush(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function sendFrames(): Array<{ type: string; msgId: string; to: string }> {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; msgId: string; to: string })
    .filter(f => f.type === 'send');
}

/** The roster the fold consumes: every seat written IN on the owner's lane
 * (ME is the owner), which is exactly rule 3's admission shape. */
function rosterSlots(ids: string[]) {
  return ids.map((memberId, i) => ({
    memberId,
    writerId: ME,
    seq: i + 1,
    state: 'in' as const,
  }));
}

function enqueuedFanouts(): Array<
  [MessageRow & { authorId: string; sq: number }, FanoutLeg[]]
> {
  return db.enqueueOutgoingFanout!.mock.calls as never;
}

function resetDb(): void {
  const reads: Array<[string, unknown]> = [
    ['getChat', null],
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
    ['saveMyProfileCard', null],
    ['getGroup', { groupId: ROOM, ownerId: ME, name: 'Kitchen' }],
    ['listGroupMemberSlots', rosterSlots([ME, ...MEMBERS])],
    // No agents here, so fanOut prunes nobody and every fan-out below
    // reaches the full folded roster.
    ['listMachinePeers', []],
    ['listRoomAgentAuthorIds', []],
    ['listGroupSettingsSlots', []],
    ['reserveGroupSeq', 7],
    ['fanoutDeliveryState', {
      total: 0, queued: 0, sent: 0, delivered: 0, failed: 0, failedPeerIds: [],
    }],
  ];
  const writes = [
    'insertMessage',
    'enqueueOutgoing',
    'enqueueOutgoingFanout',
    'aggregateFanoutStatus',
    'markLegFailed',
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
  ];
  for (const [name, value] of reads) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(value);
  }
  for (const name of writes) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  resetDb();
  ws.state.open = true;
  ws.calls.send.mockReset();
  ws.calls.send.mockImplementation((_frame: unknown) => true);
  ws.calls.start.mockClear();
  ws.calls.stop.mockClear();
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  // REAL entropy for wire ids: the jest.setup default returns the SAME bytes
  // on every call, which would make every wire msgId identical and the design
  // property vacuous in both directions.
  crypto.randomBytes!.mockReset().mockImplementation(async (n: number) => {
    const bytes = (
      require('crypto') as { randomBytes: (c: number) => Uint8Array }
    ).randomBytes(n);
    return Uint8Array.from(bytes);
  });
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

async function startMessaging(): Promise<void> {
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
  db.listOutbox!.mockClear();
  db.touchChat!.mockClear();
}

describe('fanOut composes once and commits once', () => {
  it('one message = one enqueueOutgoingFanout call: one row keyed ${me}.${m} with authorId+sq, plus one leg per member — never enqueueOutgoing', async () => {
    await startMessaging();
    const { localMsgId, skipped } = await messaging.fanOut(ROOM, 'hello room');

    expect(skipped).toEqual([]);
    expect(db.enqueueOutgoingFanout).toHaveBeenCalledTimes(1);
    const [row, legs] = enqueuedFanouts()[0];
    // The row: the SINGLE bubble, keyed by the composite the design id.
    expect(row.msgId).toBe(localMsgId);
    expect(row.msgId.startsWith(`${ME}.`)).toBe(true);
    expect(row.msgId.slice(ME.length + 1)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.peerId).toBe(ROOM);
    expect(row.direction).toBe('out');
    expect(row.body).toBe('hello room');
    expect(row.status).toBe('pending');
    expect(row.authorId).toBe(ME);
    expect(row.sq).toBe(7);
    // The legs: one per member, none for me, each encrypted individually.
    expect(legs).toHaveLength(11);
    expect(new Set(legs.map(l => l.peerId))).toEqual(new Set(MEMBERS));
    for (const leg of legs) {
      expect(leg.msgType).toBe('ciphertext');
      expect(leg.payload).toBe('Q0lQSEVS');
      expect(leg.notify).toBe(true);
    }
    // The 1:1 write paths are NOT how a room message lands.
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
    // The wire envelope wraps the body in grp.msg with the fields.
    expect(crypto.encryptText).toHaveBeenCalledTimes(11);
    const wrapper = crypto.encryptText!.mock.calls[0][2] as string;
    expect(wrapper).toContain('"tcm":"grp.msg"');
    expect(wrapper).toContain(`"g":"${ROOM}"`);
    expect(wrapper).toContain('"sq":7');
    expect(wrapper).toContain('"b":"hello room"');
    const rd = (JSON.parse(wrapper) as { rd: string }).rd;
    expect(rd).toMatch(/^[A-Za-z0-9+/]{11}$/);
    // Preview and chat-list touch, exactly as a 1:1 send.
    expect(db.touchChat).toHaveBeenCalledWith(ROOM, 'hello room', expect.any(Number));
  });

  it('legs are handed over in random (wire-id) order, not roster order', async () => {
    await startMessaging();
    await messaging.fanOut(ROOM, 'shuffle me');
    const [, legs] = enqueuedFanouts()[0];
    // outbox.seq — the flush order — is assigned in this array's order, so
    // THIS order is the transmit order: it must be the wire ids' own sorted
    // order (pure CSPRNG ⇒ a uniform shuffle of the roster), which an
    // unshuffled fan-out matches with probability 1/11! ≈ 2.5e-8.
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i - 1].msgId < legs[i].msgId).toBe(true);
    }
    const rosterOrder = [...MEMBERS];
    expect(legs.map(l => l.peerId)).not.toEqual(rosterOrder);
  });

  it('a relock mid-fan-out aborts before anything is written', async () => {
    await startMessaging();
    let calls = 0;
    crypto.encryptText!.mockImplementation(async () => {
      calls += 1;
      if (calls === 3) messaging.stop(); // the relock, mid-compose
      return { msgType: 'ciphertext', payload: 'Q0lQSEVS' };
    });
    await expect(messaging.fanOut(ROOM, 'cut off')).rejects.toThrow(
      'messaging not started',
    );
    // NOTHING was written: the one transaction had not happened yet, so no
    // leg — and no message row — can land in whichever workspace opens next.
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    // And the compose STOPPED AT the relock: the per-LEG stale check is what
    // this pins (a single pre-commit check would also write nothing, but it
    // would keep running the ratchet against a store the relock is closing —
    // eight more encrypts after the workspace was told to quiesce). The
    // mutation that deletes the per-leg check makes this read 11.
    expect(crypto.encryptText).toHaveBeenCalledTimes(3);
  });

  it('refuses a roster past GROUP_MAX_MEMBERS in the composer, before any allocation', async () => {
    await startMessaging();
    const oversize = [ME, ...Array.from({ length: 12 }, (_, i) => member(i))];
    db.listGroupMemberSlots!.mockResolvedValue(rosterSlots(oversize));
    await expect(messaging.fanOut(ROOM, 'too many')).rejects.toThrow(
      /ceiling is 12/,
    );
    expect(db.reserveGroupSeq).not.toHaveBeenCalled();
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
  });

  it('refuses to post into a room the fold says I am out of', async () => {
    await startMessaging();
    db.listGroupMemberSlots!.mockResolvedValue(rosterSlots(MEMBERS)); // no ME
    await expect(messaging.fanOut(ROOM, 'ghost post')).rejects.toThrow(
      'you are not in this room',
    );
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
  });
});

describe('the wire msgId join key stays dead AT THIS LAYER', () => {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const toBigInt = (id: string): bigint => {
    let v = 0n;
    for (const ch of id) v = v * 32n + BigInt(ALPHABET.indexOf(ch));
    return v;
  };
  const sharedPrefix = (a: string, b: string): number => {
    let n = 0;
    while (n < a.length && a[n] === b[n]) n++;
    return n;
  };

  it('no two legs of one fan-out share more than 6 leading characters, and none are base-32 adjacent — over 30 fan-outs', async () => {
    await startMessaging();
    for (let round = 0; round < 30; round++) {
      await messaging.fanOut(ROOM, `round ${round}`);
    }
    const fanouts = enqueuedFanouts();
    expect(fanouts).toHaveLength(30);
    for (const [, legs] of fanouts) {
      const ids = legs.map(l => l.msgId);
      expect(ids).toHaveLength(11);
      for (const id of ids) {
        expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          // THE the design assertion, re-run where the legs are actually minted: a
          // fanOut that quietly reached for nextMsgId would share 25 of 26.
          expect(sharedPrefix(ids[i], ids[j])).toBeLessThanOrEqual(6);
          const gap = toBigInt(ids[i]) - toBigInt(ids[j]);
          expect(gap === 1n || gap === -1n).toBe(false);
        }
      }
    }
  });
});

describe('a blocked member makes the room read-only', () => {
  it('throws BlockedPeerError before ANY allocation: no counter, no id, no prekey fetch, no ratchet, no row', async () => {
    await startMessaging();
    await messaging.blockPeer(member(4));
    db.reserveGroupSeq!.mockClear();
    crypto.encryptText!.mockClear();

    await expect(messaging.fanOut(ROOM, 'around them')).rejects.toMatchObject({
      name: 'BlockedPeerError',
    });
    expect(db.reserveGroupSeq).not.toHaveBeenCalled();
    expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
    // And never the silent omission: nothing was sent to the OTHER members
    // either — the whole argument is that omitting B is itself the tell.
  });

  it('every fanOut gate consults the ROOM kind — groupMessage, never the 1:1 message row', async () => {
    // Behaviour cannot pin this (both table rows are false, the point),
    // so the routing is pinned directly: the day someone argues room traffic
    // to a blocked member differs from 1:1 text, the argument lands on the
    // groupMessage row — a fan-out still reading 'message' would silently
    // inherit whatever that argument decides for private messages.
    const gate = jest.spyOn(blocking, 'maySendTo');
    await startMessaging();
    gate.mockClear();

    await messaging.fanOut(ROOM, 'a room send');

    const kinds = gate.mock.calls.map(c => c[0]);
    // Gate 2 (pre-allocation) plus the per-leg defence in depth: one consult
    // per recipient per site, 11 recipients each.
    expect(kinds.filter(k => k === 'groupMessage')).toHaveLength(22);
    expect(kinds).not.toContain('message');
    gate.mockRestore();
  });
});

describe('a changed safety number skips that member loudly', () => {
  it('skips the flagged member, sends the other 10 legs, and the banner names them', async () => {
    const ben = member(6);
    db.listIdentityChanged!.mockResolvedValue([ben]);
    await startMessaging();

    const { skipped } = await messaging.fanOut(ROOM, 'partial send');
    expect(skipped).toEqual([ben]);
    const [, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(10);
    expect(legs.map(l => l.peerId)).not.toContain(ben);
    // The state behind the banner, queryable per room, and the copy that
    // names the person. NOT SAFETY_COPY.changed — that sentence hard-pauses
    // a 1:1 and is written for one person (the deliberate asymmetry).
    expect(messaging.skippedInRoom(ROOM)).toEqual([ben]);
    const banner = groupSafetySkipBanner(['Ben']);
    expect(banner).toContain('Ben’s safety number changed');
    expect(banner).toContain('not receiving messages in this room');
  });

  it('an identity change surfacing mid-compose skips that leg only; the rest still send', async () => {
    const cara = member(2);
    const caraErr = new Error('identity changed');
    crypto.isIdentityChangeError!.mockImplementation((e: unknown) => e === caraErr);
    crypto.encryptText!.mockImplementation(async (_s: string, peer: string) => {
      if (peer === cara) throw caraErr;
      return { msgType: 'ciphertext', payload: 'Q0lQSEVS' };
    });
    await startMessaging();

    const { skipped } = await messaging.fanOut(ROOM, 'mid-compose');
    expect(skipped).toEqual([cara]);
    const [, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(10);
    expect(legs.map(l => l.peerId)).not.toContain(cara);
    expect(messaging.skippedInRoom(ROOM)).toEqual([cara]);
    expect(db.setIdentityChanged).toHaveBeenCalledWith(cara, expect.any(Number));
  });

  it('accepting the identity change takes the banner down', async () => {
    const ben = member(6);
    db.listIdentityChanged!.mockResolvedValue([ben]);
    await startMessaging();
    await messaging.fanOut(ROOM, 'partial');
    expect(messaging.skippedInRoom(ROOM)).toEqual([ben]);
    await messaging.acceptIdentityChange(ben);
    expect(messaging.skippedInRoom(ROOM)).toEqual([]);
  });
});

describe('duress: one decoy row, ZERO frames', () => {
  it('writes exactly one local row and consults neither the roster nor the wire — asserted against the transport mock', async () => {
    session.setMode('duress');
    const { skipped } = await messaging.fanOut(ROOM, 'decoy words');
    expect(skipped).toEqual([]);
    // ZERO frames of any type — the transport mock saw nothing at all.
    expect(ws.calls.send).not.toHaveBeenCalled();
    // ONE row, through localEcho's local-only seam, already 'sent'.
    expect(db.insertMessage).toHaveBeenCalledTimes(1);
    const echoed = db.insertMessage!.mock.calls[0][0] as MessageRow;
    expect(echoed.peerId).toBe(ROOM);
    expect(echoed.body).toBe('decoy words');
    expect(echoed.status).toBe('sent');
    // Nothing real was touched: no crypto, no allocation, no fan-out write —
    // and the roster was never even READ, because a duress session must not
    // fold slot tables to decide whether to fake a send.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
    expect(db.reserveGroupSeq).not.toHaveBeenCalled();
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
    expect(db.getGroup).not.toHaveBeenCalled();
    expect(db.listGroupMemberSlots).not.toHaveBeenCalled();
  });
});

describe('the preview DEFAULT resolves names — the retry path hands fanOut a stored mention envelope bare', () => {
  it('fanOut without an explicit preview writes “@Cara …”, never the mention’s words with the marks dropped', async () => {
    await startMessaging();
    const cara = member(0);
    db.getChat!.mockImplementation(async (id: unknown) =>
      id === cara ? { peerId: cara, displayName: 'Cara', localName: null } : null,
    );
    // ChatThreadScreen.retrySend re-fans the STORED envelope with no preview
    // (the original send passed its own resolved text; the retry cannot — it
    // only holds the wire body). The default must resolve, or the retry
    // rewrites the chat line to " lunch? ".
    const body = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch? ${MENTION_MARK}`,
      who: [cara, ME],
    });
    await messaging.fanOut(ROOM, body);
    expect(db.touchChat).toHaveBeenCalledWith(
      ROOM,
      '@Cara lunch? @you',
      expect.any(Number),
    );
  });

  it('the duress leg hands localEcho the same resolved default', async () => {
    session.setMode('duress');
    const cara = member(0);
    db.getChat!.mockImplementation(async (id: unknown) =>
      id === cara ? { peerId: cara, displayName: 'Cara', localName: null } : null,
    );
    const body = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch?`,
      who: [cara],
    });
    await messaging.fanOut(ROOM, body);
    expect(db.touchChat).toHaveBeenCalledWith(
      ROOM,
      '@Cara lunch?',
      expect.any(Number),
    );
  });
});

describe('flush routes leg failures through the ledger, not the 1:1 error path', () => {
  const leg = (msgId: string, peerId: string, over: Partial<OutboxRow> = {}): OutboxRow => ({
    msgId,
    peerId,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    attempts: 0,
    priority: 0,
    urgent: 0,
    notify: 1,
    localMsgId: `${ME}.01AAAAAAAAAAAAAAAAAAAAAAAA`,
    ...over,
  });

  it('a leg past the retry cap becomes a failed ledger row — never markOutgoingError, never a deleted row', async () => {
    await startMessaging();
    db.listOutbox!.mockResolvedValue([
      leg('01LEGSPENTAAAAAAAAAAAAAAAA', member(1), { attempts: 10 }),
    ]);
    ws.handlers.state?.('open');
    await flush();
    expect(db.markLegFailed).toHaveBeenCalledWith('01LEGSPENTAAAAAAAAAAAAAAAA');
    expect(db.markOutgoingError).not.toHaveBeenCalled();
    expect(db.deleteOutboxEnvelope).not.toHaveBeenCalled();
  });

  it('a leg to a member blocked in the same tick fails into the ledger instead of vanishing', async () => {
    db.listBlockedPeers!.mockResolvedValue([member(4)]);
    await startMessaging();
    db.listOutbox!.mockResolvedValue([
      leg('01LEGBLOCKEDAAAAAAAAAAAAAA', member(4)),
    ]);
    ws.handlers.state?.('open');
    await flush();
    expect(db.markLegFailed).toHaveBeenCalledWith('01LEGBLOCKEDAAAAAAAAAAAAAA');
    expect(db.markOutgoingError).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
  });
});

describe('the honest copy', () => {
  it('"Not delivered to N of M" reads failed-of-total, and nothing renders while nothing failed', () => {
    expect(groupDeliveryNotice({ failed: 2, total: 11 })).toBe(
      'Not delivered to 2 of 11',
    );
    expect(groupDeliveryNotice({ failed: 11, total: 11 })).toBe(
      'Not delivered to 11 of 11',
    );
    expect(groupDeliveryNotice({ failed: 0, total: 11 })).toBeNull();
    expect(groupDeliveryNotice({ failed: 0, total: 0 })).toBeNull();
  });

  it('the skip banner names every skipped member and never renders empty', () => {
    expect(groupSafetySkipBanner([])).toBeNull();
    expect(groupSafetySkipBanner(['Ben'])).toBe(
      'Ben’s safety number changed. They are not receiving messages in this room until you review it.',
    );
    const two = groupSafetySkipBanner(['Ben', 'Cara'])!;
    expect(two).toContain('Ben and Cara');
    expect(two).toContain('safety numbers changed');
    const three = groupSafetySkipBanner(['Ana', 'Ben', 'Cara'])!;
    expect(three).toContain('Ana, Ben and Cara');
  });
});

describe('pacing and admission control against a fake clock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** 3 fan-outs × 11 legs already queued, plus one call frame that must not
   * wait behind them. Jitter bytes are driven to distinct small values so
   * the drain finishes inside the retry window and the jitter is visible. */
  function queuedLegs(): OutboxRow[] {
    const rows: OutboxRow[] = [
      {
        msgId: '01CALLSIGNALAAAAAAAAAAAAAA',
        peerId: member(0),
        msgType: 'ciphertext',
        payload: 'T0ZGRVI=',
        attempts: 0,
        priority: 1,
        urgent: 1,
        notify: 0,
        localMsgId: null,
      },
    ];
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 11; i++) {
        rows.push({
          msgId: `01LEG${f}${String(i).padStart(2, '0')}${'0'.repeat(17)}`,
          peerId: member(i),
          msgType: 'ciphertext',
          payload: 'Q0lQSEVS',
          attempts: 0,
          priority: 0,
          urgent: 0,
          notify: 1,
          localMsgId: `${ME}.01GM${f}AAAAAAAAAAAAAAAAAAAA`,
        });
      }
    }
    return rows;
  }

  it('11-member fan-outs never exceed 24 frames in any 6-second window; legs are jittered; call signalling goes first and unpaced', async () => {
    let jitterCall = 0;
    crypto.randomBytes!.mockImplementation(async (n: number) => {
      if (n === 2) {
        // Distinct, small jitters (0..96 ms) so gaps are visibly unequal.
        jitterCall += 1;
        return Uint8Array.from([0, (jitterCall * 31) % 97]);
      }
      return Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
    });
    await messaging.start(ME);
    await flush();
    ws.calls.send.mockClear();

    const times: Array<{ msgId: string; at: number }> = [];
    ws.calls.send.mockImplementation((frame: unknown) => {
      const f = frame as { type: string; msgId: string };
      if (f.type === 'send') times.push({ msgId: f.msgId, at: Date.now() });
      return true;
    });
    db.listOutbox!.mockResolvedValue(queuedLegs());
    const t0 = Date.now();
    ws.handlers.state?.('open');
    await flush();

    // ADMISSION CONTROL: the bucket is born empty (the server-side window may
    // still be depleted from the previous run), so at +50 ms the fan-outs are
    // QUEUED, not started — zero legs sent, zero attempts burned. The call
    // frame went immediately: a ring does not wait behind a photo or a room.
    await jest.advanceTimersByTimeAsync(50);
    expect(times.filter(t => t.msgId.startsWith('01LEG'))).toHaveLength(0);
    expect(times.filter(t => t.msgId.startsWith('01CALL'))).toHaveLength(1);
    expect(db.bumpOutboxAttempt).toHaveBeenCalledTimes(1); // the call frame only

    // Drain everything: 33 legs at ~3.83/s ≈ 8.6 s + jitter.
    await jest.advanceTimersByTimeAsync(14_000);
    const legTimes = times
      .filter(t => t.msgId.startsWith('01LEG'))
      .map(t => t.at - t0)
      .sort((a, b) => a - b);
    expect(legTimes).toHaveLength(33); // each leg exactly once — no resends

    // THE the design BOUND, over every send this socket made (call frame included):
    // no 6-second window anywhere holds more than 24 frames.
    const all = times.map(t => t.at - t0).sort((a, b) => a - b);
    for (let i = 0; i < all.length; i++) {
      let count = 0;
      for (let j = i; j < all.length && all[j] < all[i] + 6_000; j++) count++;
      expect(count).toBeLessThanOrEqual(24);
    }

    // JITTER: the gaps between paced legs are NOT a metronome. With
    // the driven jitter bytes the refill interval alone would repeat one gap.
    const gaps = new Set<number>();
    for (let i = 1; i < legTimes.length; i++) {
      gaps.add(legTimes[i] - legTimes[i - 1]);
    }
    expect(gaps.size).toBeGreaterThanOrEqual(3);
  });
});
