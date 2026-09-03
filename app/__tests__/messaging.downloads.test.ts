/**
 * The automatic attachment download is BOUNDED.
 *
 * Incoming photos, files and voice notes download automatically — that is the
 * product behaviour ("the photo just appears") and it survives here. What must
 * not survive is the unbounded version: any peer this phone has not blocked
 * can address an arbitrary number of carrier messages at ≤10 MiB blob
 * pointers, and an automatic fetch of every one of them is a device-storage
 * and bandwidth exhaustion primitive (each blob is buffered whole, base64, in
 * a JS string, then written to SQLite).
 *
 * The bounds under test:
 *  - MAX_CONCURRENT_DOWNLOADS = 2  (pre-existing; held by the pump tests in
 *    messaging.blocking.test.ts)
 *  - a QUEUE-DEPTH cap: auto-fetch jobs beyond the backlog cap are refused
 *  - an AUTO-FETCH BUDGET per rolling window: bytes and count
 *
 * Degradation is graceful and VISIBLE, never silent: a refused auto-fetch
 * lands its row on 'failed', which ChatThreadScreen renders as "tap to
 * retry" — the message is still there, the photo is one deliberate tap away,
 * and the boot-time reconcile does not resurrect the flood (it re-queues only
 * missing/'pending' rows). A MANUAL retry is the user's own consent and is
 * exempt from the budget and the depth cap.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
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
      return true;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
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
  getChat: jest.fn(),
  getGroup: jest.fn(),
  hasSeen: jest.fn(),
  getMessage: jest.fn(),
  listOutbox: jest.fn(),
  listChats: jest.fn(),
  listMessages: jest.fn(),
  listAttachments: jest.fn(),
  listAttachmentMeta: jest.fn(),
  listRecentMessages: jest.fn(),
  listHeldRevisions: jest.fn(),
  takeHeldRevision: jest.fn(),
  listIdentityChanged: jest.fn(),
  listBlockedPeers: jest.fn(),
  getBlockedAt: jest.fn(),
  loadProfile: jest.fn(),
  chatsMissingMyProfile: jest.fn(),
  peerHasMyProfile: jest.fn(),
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
  sumAttachmentBytes: jest.fn(),
  sumAvatarBytes: jest.fn(),
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
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
}));

import type { MessageRow } from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { handlers: { frame?: (f: unknown) => void } };
  }
).__ws;

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';

async function flush(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function imageBody(att: string): string {
  return JSON.stringify({ tcm: 'image', att, key: 'a2V5', w: 10, h: 20 });
}

function msgIdFor(i: number): string {
  return `01F6MSG${String(i).padStart(5, '0')}`;
}

async function deliverImage(i: number): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValueOnce(imageBody(`att-${i}`));
  ws.handlers.frame?.({
    type: 'msg',
    from: FRIEND,
    msgId: msgIdFor(i),
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

/** A profile card carrying an encrypted avatar blob pointer — the seam that
 * drives queueAvatarDownload -> fetchAvatar -> setPeerAvatar. */
async function deliverAvatarCard(i: number): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValueOnce(
    JSON.stringify({
      tcm: 'profile',
      n: 'Mallory',
      a: '',
      v: 1_700_000_000_000 + i,
      att: `att-avatar-${i}`,
      key: 'a2V5',
    }),
  );
  ws.handlers.frame?.({
    type: 'msg',
    from: FRIEND,
    msgId: msgIdFor(9000 + i),
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

/** putAttachment calls for one msgId, as their state arguments. */
function attachmentStates(msgId: string): string[] {
  return db
    .putAttachment!.mock.calls.filter(c => c[0] === msgId)
    .map(c => String(c[2]));
}

function resetDb(): void {
  const reads: Array<[string, unknown]> = [
    ['getChat', undefined],
    ['getGroup', null],
    ['hasSeen', false],
    ['getMessage', null],
    ['listOutbox', []],
    ['listChats', []],
    ['listMessages', []],
    ['listAttachments', []],
    ['listAttachmentMeta', []],
    ['listRecentMessages', []],
    ['listHeldRevisions', []],
    ['takeHeldRevision', null],
    ['listIdentityChanged', []],
    ['listBlockedPeers', []],
    ['getBlockedAt', null],
    ['loadProfile', null],
    ['chatsMissingMyProfile', []],
    ['peerHasMyProfile', false],
  ];
  for (const [name, value] of reads) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(value);
  }
  for (const name of Object.keys(db)) {
    if (!reads.some(([n]) => n === name)) {
      db[name]!.mockReset();
      db[name]!.mockResolvedValue(undefined);
    }
  }
  db.applyEdit!.mockResolvedValue(true);
  db.tombstoneMessage!.mockResolvedValue(true);
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  resetDb();
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  api.apiGetAttachmentUrl!.mockResolvedValue({
    downloadUrl: 'https://blobs/get',
  });
  api.downloadBlob!.mockResolvedValue('Y2lwaGVy');
  crypto.decryptEnvelope!.mockReset();
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.blobDecrypt!.mockReset().mockResolvedValue('cGxhaW4=');
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  await messaging.start(ME);
  await flush();
  db.putAttachment!.mockClear();
  api.downloadBlob!.mockClear();
  api.apiGetAttachmentUrl!.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

describe('the ordinary case is unchanged — the photo still just appears', () => {
  test('a single incoming image auto-downloads to ready', async () => {
    await deliverImage(1);
    expect(api.downloadBlob).toHaveBeenCalledTimes(1);
    expect(attachmentStates(msgIdFor(1))).toEqual(['pending', 'pending', 'ready']);
  });
});

describe('the BYTE budget: a flood of 10 MiB pointers stops auto-fetching', () => {
  test('auto-fetch stops at the window byte budget; the refused row is VISIBLE and manually fetchable', async () => {
    // One shared 32 MiB string: jest retains arguments/results by reference,
    // so this costs one allocation, not nine.
    const BIG = 'x'.repeat(32 * 1024 * 1024);
    api.downloadBlob!.mockResolvedValue(BIG);

    // 8 × 32 MiB = 256 MiB — exactly the window budget. The ninth must not
    // auto-fetch.
    for (let i = 1; i <= 9; i++) await deliverImage(i);

    expect(api.downloadBlob).toHaveBeenCalledTimes(8);
    // The ninth message still landed, visibly: its attachment row is 'failed'
    // (ChatThreadScreen's "tap to retry"), never silently dropped.
    expect(attachmentStates(msgIdFor(9))).toContain('failed');
    expect(attachmentStates(msgIdFor(9))).not.toContain('ready');

    // The user's own tap is consent — manual retry is exempt from the budget.
    db.getMessage!.mockResolvedValue({
      msgId: msgIdFor(9),
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-9'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow);
    await messaging.retryAttachment(msgIdFor(9), 'in', imageBody('att-9'));
    await flush();
    expect(api.downloadBlob).toHaveBeenCalledTimes(9);
  });
});

describe('the COUNT budget: many small pointers are bounded too', () => {
  test('auto-fetch stops at the window count budget', async () => {
    for (let i = 1; i <= 301; i++) await deliverImage(i);

    expect(api.downloadBlob).toHaveBeenCalledTimes(300);
    expect(attachmentStates(msgIdFor(301))).toContain('failed');
    expect(attachmentStates(msgIdFor(301))).not.toContain('ready');
  });
});

describe('avatars share the window — a hostile card per version is the same flood', () => {
  test('an avatar offered after the budget is spent is skipped, not fetched', async () => {
    const BIG = 'x'.repeat(32 * 1024 * 1024);
    api.downloadBlob!.mockResolvedValue(BIG);
    for (let i = 1; i <= 8; i++) await deliverImage(i);
    expect(api.downloadBlob).toHaveBeenCalledTimes(8);

    // A profile card carrying a blob pointer, arriving into a spent window.
    crypto.decryptEnvelope!.mockResolvedValueOnce(
      JSON.stringify({
        tcm: 'profile',
        n: 'Mallory',
        a: '',
        v: 1_700_000_000_000,
        att: 'att-avatar',
        key: 'a2V5',
      }),
    );
    ws.handlers.frame?.({
      type: 'msg',
      from: FRIEND,
      msgId: msgIdFor(9000),
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 1_700_000_000_000,
    });
    await flush();

    expect(api.downloadBlob).toHaveBeenCalledTimes(8);
    expect(
      api.apiGetAttachmentUrl!.mock.calls.map(c => c[1]),
    ).not.toContain('att-avatar');
  });
});

describe('the STORAGE ceiling: the rate bounds cannot bound the SUM', () => {
  /**
   * 256 MiB/hour is ~6 GiB/day: a patient sender who never trips the window
   * still fills the disk in weeks. The ceiling is on TOTAL stored attachment
   * bytes, measured from the attachments table itself at session start —
   * persistent because the disk is the ledger — and advanced in memory as
   * fetches land. Same degradation contract as the window: visibly 'failed',
   * manual retry exempt, nothing already stored is ever deleted to make room.
   *
   * The 4 GiB literal is pinned by hand, like the window numbers above: an
   * implementation that drifts from it must fail here as a conscious act.
   */
  const CEILING = 4 * 1024 * 1024 * 1024;
  /** What one fetched blob adds to the ledger: the STORED plaintext base64
   * ('cGxhaW4=' from the blobDecrypt mock), not the wire ciphertext. */
  const STORED = 'cGxhaW4='.length;

  async function restartWithStoredBytes(total: number): Promise<void> {
    messaging.stop();
    db.sumAttachmentBytes!.mockResolvedValue(total);
    await messaging.start(ME);
    await flush();
    db.putAttachment!.mockClear();
    api.downloadBlob!.mockClear();
    api.apiGetAttachmentUrl!.mockClear();
  }

  test('a session opening AT the ceiling refuses auto-fetch visibly; a manual tap still fetches', async () => {
    await restartWithStoredBytes(CEILING);

    await deliverImage(1);
    expect(api.downloadBlob).not.toHaveBeenCalled();
    // Visible, never silent: the row lands on 'failed' ("tap to retry"),
    // the message itself untouched.
    expect(attachmentStates(msgIdFor(1))).toContain('failed');
    expect(attachmentStates(msgIdFor(1))).not.toContain('ready');

    // The user's own tap is consent — exempt from the ceiling exactly as it
    // is exempt from the window.
    db.getMessage!.mockResolvedValue({
      msgId: msgIdFor(1),
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-1'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow);
    await messaging.retryAttachment(msgIdFor(1), 'in', imageBody('att-1'));
    await flush();
    expect(api.downloadBlob).toHaveBeenCalledTimes(1);
  });

  test('binds AT the ceiling and not before, advancing by what each fetch STORED', async () => {
    // One blob and one byte short of the line: the first fetch lands the
    // ledger at CEILING - 1 — one byte under — so the second must still be
    // admitted (binds at the line, not before), and the third, first to find
    // the ledger past it, refused.
    await restartWithStoredBytes(CEILING - STORED - 1);

    await deliverImage(1);
    await deliverImage(2);
    expect(api.downloadBlob).toHaveBeenCalledTimes(2);
    expect(attachmentStates(msgIdFor(2))).toContain('ready');

    await deliverImage(3);
    expect(api.downloadBlob).toHaveBeenCalledTimes(2);
    expect(attachmentStates(msgIdFor(3))).toContain('failed');
    expect(attachmentStates(msgIdFor(3))).not.toContain('ready');
  });

  test('freeing content frees the budget: the next session re-reads the disk', async () => {
    // The flood found the ceiling…
    await restartWithStoredBytes(CEILING);
    await deliverImage(1);
    expect(api.downloadBlob).not.toHaveBeenCalled();

    // …the person deleted the flood chat, and the ledger is the table, so
    // the next unlock simply measures less. No counter to heal, nothing to
    // have drifted.
    await restartWithStoredBytes(0);
    await deliverImage(2);
    expect(api.downloadBlob).toHaveBeenCalledTimes(1);
    expect(attachmentStates(msgIdFor(2))).toContain('ready');
  });

  // Chat avatars are stored bytes too, and "one per peer" is no
  // bound when accounts are free — a Sybil roster of maximum-size faces walks
  // past the ceiling. The session measurement must count them, and each
  // avatar write must advance the in-memory ledger by its replacement delta.

  test('the ceiling counts stored AVATARS at session start, not only attachments', async () => {
    // The attachments table is empty; the avatars alone have filled the disk
    // to the line. A fetch must be refused on the SUM of both.
    messaging.stop();
    db.sumAttachmentBytes!.mockResolvedValue(0);
    db.sumAvatarBytes!.mockResolvedValue(CEILING);
    await messaging.start(ME);
    await flush();
    db.putAttachment!.mockClear();
    api.downloadBlob!.mockClear();

    await deliverImage(1);
    expect(api.downloadBlob).not.toHaveBeenCalled();
    expect(attachmentStates(msgIdFor(1))).toContain('failed');
    expect(attachmentStates(msgIdFor(1))).not.toContain('ready');
  });

  test('a fetched avatar advances the ledger by its replacement delta and counts toward the ceiling', async () => {
    // Open one avatar's worth under the line, with the ledger returning STORED
    // as the write's delta. The avatar fetch must land the ledger exactly AT
    // the ceiling, so the next image is refused.
    messaging.stop();
    db.sumAttachmentBytes!.mockResolvedValue(CEILING - STORED);
    db.sumAvatarBytes!.mockResolvedValue(0);
    db.setPeerAvatar!.mockResolvedValue(STORED);
    await messaging.start(ME);
    await flush();
    db.putAttachment!.mockClear();
    api.downloadBlob!.mockClear();

    await deliverAvatarCard(1);
    expect(db.setPeerAvatar).toHaveBeenCalled();

    // The avatar's bytes are now on the ledger, which is at the ceiling, so
    // the image cannot auto-fetch.
    await deliverImage(1);
    expect(attachmentStates(msgIdFor(1))).toContain('failed');
    expect(attachmentStates(msgIdFor(1))).not.toContain('ready');
  });
});

describe('the QUEUE-DEPTH cap: a backlog cannot grow without bound', () => {
  test('auto jobs beyond the backlog cap are refused visibly; a manual retry is not', async () => {
    // Downloads that never resolve: the queue can only grow.
    api.downloadBlob!.mockImplementation(() => new Promise(() => {}));

    // 2 saturate the pump; 128 wait in the queue; 131 onward must be refused.
    for (let i = 1; i <= 133; i++) await deliverImage(i);

    expect(api.downloadBlob).toHaveBeenCalledTimes(2);
    expect(attachmentStates(msgIdFor(130))).not.toContain('failed');
    expect(attachmentStates(msgIdFor(131))).toContain('failed');
    expect(attachmentStates(msgIdFor(132))).toContain('failed');
    expect(attachmentStates(msgIdFor(133))).toContain('failed');

    // A manual retry joins the queue past the cap rather than being refused:
    // no NEW 'failed' write for it.
    db.getMessage!.mockResolvedValue({
      msgId: msgIdFor(131),
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-131'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow);
    const failedBefore = attachmentStates(msgIdFor(131)).filter(
      s => s === 'failed',
    ).length;
    await messaging.retryAttachment(msgIdFor(131), 'in', imageBody('att-131'));
    await flush();
    const failedAfter = attachmentStates(msgIdFor(131)).filter(
      s => s === 'failed',
    ).length;
    expect(failedAfter).toBe(failedBefore);
  });
});
