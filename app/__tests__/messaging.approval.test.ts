/**
 * The `x.approval` receive branch: the ONE `x.*` kind
 * this build can use, taken ABOVE the generic carrier drop.
 *
 * The contract, from the scout notes and
 * the recorded defect map:
 *
 *  - a WELL-FORMED request becomes an `approvals` row, persisted BEFORE
 *    markSeen/ack (the ack purges the server's only copy; a crash between
 *    would lose the request for good);
 *  - it NEVER becomes a messages row (the row would hold a command line at
 *    rest — and its arrivedAt stamp is what the unread query counts
 *    while the thread filter keeps it invisible: the phantom unread), and it
 *    NEVER touches the preview line (previewFor yields '' for carriers, so a
 *    touch would blank the chat's last words);
 *  - a MALFORMED request falls to the generic prefix drop — acked, no row,
 *    no crash. This is also the PRE-CARD behaviour: remove the branch and the
 *    well-formed case takes this path too, which is what makes the feature
 *    deployable against builds already in the field;
 *  - duress never persists and never renders (the decoy workspace must not
 *    hold a real machine's pending commands); the frame still acks
 *    byte-identically, because not acking is the observable difference.
 *
 * Wire bytes come from the committed cross-client fixture
 * (`packages/shared/approvalvectors.json`) — the same bytes the shared, CLI
 * and envelope suites parse, so this file cannot drift from the wire form
 * without one of them going red too.
 *
 * Harness copied from messaging.carrier.drop.test.ts (mocked decryptEnvelope,
 * ws.handlers.frame, db spies).
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
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
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
  getAiAgentState: jest.fn(),
  getAiNotifyPreference: jest.fn(),
  beginAiNotifyPreference: jest.fn(),
  clearAiNotifyPreferenceRequest: jest.fn(),
  applyAiNotifyPreferenceAck: jest.fn(),
  insertMessage: jest.fn(),
  insertApproval: jest.fn(),
  recordAiWork: jest.fn(),
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
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
  unreadInboundIds: jest.fn(),
  markReadSent: jest.fn(),
  getGroup: jest.fn(),
  listGroupMemberSlots: jest.fn(),
}));

import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
  __inbox: Map<string, unknown>;
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

interface VectorCase {
  name: string;
  kind: string;
  valid: boolean;
  note: string;
  body: string;
}

// The committed cross-client fixture, by relative path — the same bytes the
// envelope/shared/CLI suites parse (the authvectors.json pattern).
const vectors = require('../../packages/shared/approvalvectors.json') as {
  cases: VectorCase[];
};

const vector = (name: string): VectorCase => {
  const found = vectors.cases.find(c => c.name === name);
  if (!found) throw new Error(`approvalvectors.json is missing the '${name}' case`);
  return found;
};

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  for (const name of Object.keys(db)) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
  db.listOutbox!.mockResolvedValue([]);
  db.listChats!.mockResolvedValue([]);
  db.listMessages!.mockResolvedValue([]);
  db.listAttachments!.mockResolvedValue([]);
  db.listAttachmentMeta!.mockResolvedValue([]);
  db.listRecentMessages!.mockResolvedValue([]);
  db.listHeldRevisions!.mockResolvedValue([]);
  db.listIdentityChanged!.mockResolvedValue([]);
  db.listBlockedPeers!.mockResolvedValue([]);
  // Device-set reads: an EMPTY world, so the
  // single-leg wire this suite pins stays byte-for-byte what it was.
  db.listPeerDevices!.mockResolvedValue([]);
  db.listLinkedDevices!.mockResolvedValue([]);
  db.getPeerDevice!.mockResolvedValue(null);
  db.chatsMissingMyProfile!.mockResolvedValue([]);
  db.hasSeen!.mockResolvedValue(false);
  db.getMessage!.mockResolvedValue(null);
  db.loadProfile!.mockResolvedValue(null);
  db.peerHasMyProfile!.mockResolvedValue(true);
  db.beginAiNotifyPreference!.mockResolvedValue(true);
  db.applyAiNotifyPreferenceAck!.mockResolvedValue(true);
  db.getGroup!.mockResolvedValue(null);

  ws.state.open = true;
  ws.calls.send.mockReset().mockImplementation(() => true);
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  crypto.__inbox.clear();

  await messaging.start(ME);
  await settle();
  ws.calls.send.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

function acksFor(msgId: string): unknown[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type?: string; msgId?: string })
    .filter(f => f.type === 'ack' && f.msgId === msgId);
}

async function injectDurable(body: string, msgId: string): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValue(body);
  ws.handlers.frame?.({
    type: 'msg',
    from: FRIEND,
    msgId,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    ts: 5,
  });
  await settle();
}

/** The generic-drop contract, verbatim from messaging.carrier.drop.test.ts,
 * plus the one line this file adds: no approvals row either. */
function expectDroppedWhole(msgId: string): void {
  expect(db.markSeen!).toHaveBeenCalledWith(msgId, expect.any(Number));
  expect(acksFor(msgId)).toHaveLength(1);
  expect(db.insertApproval!).not.toHaveBeenCalled();
  expect(db.insertMessage!).not.toHaveBeenCalled();
  expect(db.touchChat!).not.toHaveBeenCalled();
  expect(db.setChatPreview!).not.toHaveBeenCalled();
  expect(db.upsertChat!).not.toHaveBeenCalled();
}

describe('a well-formed x.approval — the fixture request, applied', () => {
  test('becomes an approvals row: persist before ack, no messages row, no unread, no preview touch', async () => {
    const listener = jest.fn();
    const off = messaging.subscribe(listener);
    const msgId = '01APPROVALFRAME00000000A01';

    await injectDurable(vector('request').body, msgId);
    off();

    // The row, field by field from the fixture bytes. `arrivedAt` is THIS
    // phone's clock (the countdown base, display only); `ts` is the frame's.
    expect(db.insertApproval!).toHaveBeenCalledTimes(1);
    expect(db.insertApproval!).toHaveBeenCalledWith({
      peerId: FRIEND,
      q: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
      wireMsgId: msgId,
      kind: 'exec',
      payload: 'npm test -- --watch=false\ncwd: /Users/op/tacendum',
      ttlSec: 600,
      sessionTag: 's-7c2e',
      verbs: ['approve', 'deny'],
      ts: 5,
      arrivedAt: expect.any(Number),
    });

    // PERSIST BEFORE ACK: the ack purges the server's only copy, and the
    // ratchet key is already spent — a crash between the two must find the
    // row on disk. Asserted on invocation order, not on prose.
    const persistedAt = db.insertApproval!.mock.invocationCallOrder[0]!;
    const seenAt = db.markSeen!.mock.invocationCallOrder[0]!;
    const ackAt = ws.calls.send.mock.invocationCallOrder[0]!;
    expect(persistedAt).toBeLessThan(seenAt);
    expect(seenAt).toBeLessThan(ackAt);
    expect(acksFor(msgId)).toHaveLength(1);

    // The chat EXISTS (the card needs a thread to live in) but its line is
    // untouched: no messages row (rule 4 at rest + the phantom unread), no
    // preview touch (the blanked line), no reorder.
    expect(db.upsertChat!).toHaveBeenCalledWith(FRIEND);
    expect(db.insertMessage!).not.toHaveBeenCalled();
    expect(db.touchChat!).not.toHaveBeenCalled();
    expect(db.setChatPreview!).not.toHaveBeenCalled();

    // The thread is showing new state, so subscribers repaint.
    expect(listener).toHaveBeenCalled();
  });

  test('stores and records bounded context only when it names the exact request', async () => {
    const msgId = '01APPROVALFRAME00000000A04';
    const q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
    const work = {
      provider: 'claude',
      updatedAt: 1_800_000_000_000,
      event: 'needs-review',
      eventId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
      requestId: q,
      project: 'Tacendum',
      context: {
        availability: 'captured',
        capturedAt: 1_799_999_999_000,
        repository: 'natln/Tacendum',
        branch: 'feature/chat-review',
        resultSummary: 'Review the exact command below.',
      },
    } as const;
    db.insertApproval!.mockResolvedValueOnce(true);

    await injectDurable(
      JSON.stringify({
        tcm: 'x.approval',
        q,
        k: 'exec',
        p: 'pnpm test',
        x: 600,
        a: ['approve', 'deny'],
        work,
      }),
      msgId,
    );

    expect(db.insertApproval!).toHaveBeenCalledWith(
      expect.objectContaining({ q, payload: 'pnpm test', work }),
    );
    const arrivedAt = db.insertApproval!.mock.calls[0]![0].arrivedAt as number;
    expect(db.recordAiWork!).toHaveBeenCalledWith(
      FRIEND,
      msgId,
      arrivedAt,
      work,
      'approval',
    );
    expect(db.recordAiWork!.mock.invocationCallOrder[0]).toBeLessThan(
      db.markSeen!.mock.invocationCallOrder[0]!,
    );
  });

  test('a mismatched or malformed context costs itself, never q/p', async () => {
    db.insertApproval!.mockResolvedValue(true);
    const q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
    await injectDurable(
      JSON.stringify({
        tcm: 'x.approval',
        q,
        k: 'exec',
        p: 'pnpm test',
        x: 600,
        a: ['approve', 'deny'],
        work: {
          provider: 'claude',
          updatedAt: 1_800_000_000_000,
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFX',
        },
      }),
      '01APPROVALFRAME00000000A05',
    );
    await injectDurable(
      JSON.stringify({
        tcm: 'x.approval',
        q: '01J8MEAPPR0VAQ4X2C6TKN9RFY',
        k: 'exec',
        p: 'pnpm lint',
        x: 600,
        a: ['approve', 'deny'],
        work: { provider: 'claude' },
      }),
      '01APPROVALFRAME00000000A06',
    );

    expect(db.insertApproval!).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ work: expect.anything() }),
    );
    expect(db.insertApproval!).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ q: '01J8MEAPPR0VAQ4X2C6TKN9RFY', payload: 'pnpm lint' }),
    );
    expect(db.insertApproval!.mock.calls[1]![0]).not.toHaveProperty('work');
    expect(db.recordAiWork!).not.toHaveBeenCalled();
  });

  test('an unknown verb in `a` still lands the row — a verb costs the answer, never the frame', async () => {
    const msgId = '01APPROVALFRAME00000000A02';
    await injectDurable(vector('request-unknown-verb').body, msgId);
    expect(db.insertApproval!).toHaveBeenCalledTimes(1);
    expect(db.insertApproval!).toHaveBeenCalledWith(
      expect.objectContaining({ verbs: ['approve', 'deny', 'escalate'] }),
    );
    expect(acksFor(msgId)).toHaveLength(1);
  });

  test('the NSE-spool drain re-enters the same branch — a spooled request lands the same row', async () => {
    messaging.stop();
    const msgId = '01APPROVALFRAME00000000A03';
    crypto.__inbox.set(msgId, {
      from: FRIEND,
      msgId,
      ts: 7,
      body: vector('request').body,
    });
    db.insertApproval!.mockClear();
    ws.calls.send.mockClear();

    await messaging.start(ME);
    await settle();

    expect(db.insertApproval!).toHaveBeenCalledTimes(1);
    expect(db.insertApproval!).toHaveBeenCalledWith(
      expect.objectContaining({ q: '01J8MEAPPR0VAQ4X2C6TKN9RFV', wireMsgId: msgId, ts: 7 }),
    );
    expect(acksFor(msgId)).toHaveLength(1);
  });
});

describe('what stays on the generic drop — the floor under the card', () => {
  test('a malformed x.approval falls to the prefix drop: acked, no row, no crash (the pre-card behaviour, pinned)', async () => {
    // Both invalid fixture cases: over-cap payload and a raw session id in
    // `s`. parseEnvelope refuses each, so the branch above cannot match and
    // the prefix drop must — this is exactly what every build BEFORE the
    // card does with every x.approval, which is why removing the branch
    // must land here rather than anywhere new.
    await injectDurable(vector('request-overcap').body, '01APPROVALFRAME00000000B01');
    expectDroppedWhole('01APPROVALFRAME00000000B01');

    await injectDurable(vector('request-wrong-tag').body, '01APPROVALFRAME00000000B02');
    expectDroppedWhole('01APPROVALFRAME00000000B02');
  });

  test('an x.approval.answer arriving durable is dropped whole — this build consumes answers nowhere', async () => {
    // Registered in the union (encodable, parseable) but with NO apply
    // branch: the prefix drop is what catches a parsed-but-unhandled kind.
    await injectDurable(vector('answer').body, '01APPROVALFRAME00000000B03');
    expectDroppedWhole('01APPROVALFRAME00000000B03');
  });

  test('other x.* kinds keep the drop untouched beside the new branch', async () => {
    await injectDurable(
      '{"tcm":"x.zzz","q":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
      '01APPROVALFRAME00000000B04',
    );
    expectDroppedWhole('01APPROVALFRAME00000000B04');
  });
});

describe('duress', () => {
  test('a duress session persists nothing and renders nothing — the frame still acks byte-identically', async () => {
    // Belt and braces: a duress session's messaging never starts (network-
    // silent), so this branch should be unreachable — but
    // the call branch checks the mode anyway and this one must too: nothing
    // about a real machine's pending commands may surface in the decoy.
    const listener = jest.fn();
    const off = messaging.subscribe(listener);
    session.setMode('duress');

    const msgId = '01APPROVALFRAME00000000C01';
    const request = JSON.parse(vector('request').body) as Record<string, unknown>;
    await injectDurable(
      JSON.stringify({
        ...request,
        work: {
          provider: 'claude',
          updatedAt: 1_800_000_000_000,
          event: 'needs-review',
          eventId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
          requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
        },
      }),
      msgId,
    );
    off();

    expect(db.insertApproval!).not.toHaveBeenCalled();
    expect(db.insertMessage!).not.toHaveBeenCalled();
    expect(db.upsertChat!).not.toHaveBeenCalled();
    expect(db.recordAiWork!).not.toHaveBeenCalled();
    expect(db.markSeen!).toHaveBeenCalledWith(msgId, expect.any(Number));
    expect(acksFor(msgId)).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('generation ownership at structured-work awaits', () => {
  const work = {
    provider: 'claude',
    updatedAt: 1_800_000_000_000,
    event: 'needs-review',
    eventId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
    requestId: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
  } as const;

  test('a relock while the approval insert waits cannot write work into the next workspace', async () => {
    let release!: (stored: boolean) => void;
    db.insertApproval!.mockImplementationOnce(
      () => new Promise<boolean>(resolve => { release = resolve; }),
    );
    const msgId = '01APPROVALFRAME00000000D01';
    crypto.decryptEnvelope!.mockResolvedValue(
      JSON.stringify({
        tcm: 'x.approval',
        q: work.requestId,
        k: 'exec',
        p: 'pnpm test',
        x: 600,
        a: ['approve', 'deny'],
        work,
      }),
    );
    ws.handlers.frame?.({
      type: 'msg',
      from: FRIEND,
      msgId,
      msgType: 'ciphertext',
      payload: 'Q0lQSEVS',
      ts: 5,
    });
    await settle(10);
    messaging.stop();
    release(true);
    await settle();

    expect(db.recordAiWork!).not.toHaveBeenCalled();
    expect(acksFor(msgId)).toHaveLength(0);
  });

  test('a relock while profile apply waits cannot write its snapshot into the next workspace', async () => {
    let release!: () => void;
    db.applyPeerProfile!.mockImplementationOnce(
      () => new Promise<void>(resolve => { release = resolve; }),
    );
    const msgId = '01APPROVALFRAME00000000D02';
    crypto.decryptEnvelope!.mockResolvedValue(
      JSON.stringify({
        tcm: 'profile',
        n: 'Claude Code',
        a: '',
        v: Date.now(),
        work: {
          provider: 'claude',
          updatedAt: Date.now(),
          capabilities: { notifications: true, approvals: true, tasks: false },
        },
        notifyPrefAck: {
          q: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
          routine: 'quiet',
        },
      }),
    );
    ws.handlers.frame?.({
      type: 'msg',
      from: FRIEND,
      msgId,
      msgType: 'ciphertext',
      payload: 'Q0lQSEVS',
      ts: 5,
    });
    await settle(10);
    messaging.stop();
    release();
    await settle();

    expect(db.recordAiWork!).not.toHaveBeenCalled();
    expect(db.applyAiNotifyPreferenceAck!).not.toHaveBeenCalled();
    expect(acksFor(msgId)).toHaveLength(0);
  });
});

describe('owner-controlled AI routine notifications', () => {
  const preferenceQ = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
  const profile = {
    userId: ME,
    registrationId: 1,
    displayName: 'Owner',
    about: 'Available',
    avatarB64: '',
    profileVersion: 7,
  };
  const agentState = {
    peerId: FRIEND,
    provider: 'claude',
    capabilities: { notifications: true, approvals: true, tasks: false },
  };

  test('queues an exact profile-carried request while the effective value remains unchanged', async () => {
    db.loadProfile!.mockResolvedValue(profile);
    db.getAiAgentState!.mockResolvedValue(agentState);

    const q = await messaging.setAiRoutinePreference(FRIEND, 'quiet');

    expect(q).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(db.beginAiNotifyPreference!).toHaveBeenCalledWith(
      FRIEND,
      q,
      'quiet',
      expect.any(Number),
    );
    expect(db.beginAiNotifyPreference!.mock.invocationCallOrder[0]).toBeLessThan(
      db.enqueueOutgoing!.mock.invocationCallOrder[0]!,
    );
    const plaintext = crypto.encryptText!.mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(plaintext)).toEqual({
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPref: { q, routine: 'quiet' },
    });
    expect(db.enqueueOutgoing!.mock.calls.at(-1)?.[1]).toMatchObject({
      notify: false,
    });
    expect(db.markMyProfileSent!).not.toHaveBeenCalled();
  });

  test('refuses a request without a current source-backed notification capability', async () => {
    db.loadProfile!.mockResolvedValue(profile);
    db.getAiAgentState!.mockResolvedValue({
      ...agentState,
      capabilities: { notifications: false, approvals: true, tasks: false },
    });

    await expect(
      messaging.setAiRoutinePreference(FRIEND, 'quiet'),
    ).rejects.toThrow('not configured');
    expect(db.beginAiNotifyPreference!).not.toHaveBeenCalled();
    expect(crypto.encryptText!).not.toHaveBeenCalled();
  });

  test('a manual retry reuses the durable pending q instead of inventing a new request', async () => {
    db.loadProfile!.mockResolvedValue(profile);
    db.getAiAgentState!.mockResolvedValue(agentState);
    db.getAiNotifyPreference!.mockResolvedValue({
      peerId: FRIEND,
      effectiveRoutine: 'all',
      pendingQ: preferenceQ,
      requestedRoutine: 'quiet',
      requestedAt: 1,
      acknowledgedAt: null,
    });

    await expect(
      messaging.retryAiRoutinePreference(FRIEND),
    ).resolves.toBe(preferenceQ);

    expect(db.beginAiNotifyPreference!).not.toHaveBeenCalled();
    const plaintext = crypto.encryptText!.mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(plaintext).notifyPref).toEqual({
      q: preferenceQ,
      routine: 'quiet',
    });
  });

  test('a storage refusal leaves no preference carrier to flush', async () => {
    db.loadProfile!.mockResolvedValue(profile);
    db.getAiAgentState!.mockResolvedValue(agentState);
    db.beginAiNotifyPreference!.mockResolvedValueOnce(false);

    await expect(
      messaging.setAiRoutinePreference(FRIEND, 'quiet'),
    ).rejects.toThrow('not available');
    expect(crypto.encryptText!).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
  });

  test('an authenticated exact ack is applied even when its profile version is old', async () => {
    await injectDurable(
      JSON.stringify({
        tcm: 'profile',
        n: 'Claude Code',
        a: '',
        v: 1,
        notifyPrefAck: { q: preferenceQ, routine: 'quiet' },
      }),
      '01APPROVALFRAME00000000E01',
    );

    expect(db.applyAiNotifyPreferenceAck!).toHaveBeenCalledWith(
      FRIEND,
      preferenceQ,
      'quiet',
      expect.any(Number),
    );
    expect(db.applyPeerProfile!).toHaveBeenCalled();
  });

  test('malformed preference metadata costs only itself and the profile still applies', async () => {
    await injectDurable(
      JSON.stringify({
        tcm: 'profile',
        n: 'Claude Code',
        a: '',
        v: 2,
        notifyPrefAck: { q: 'wrong', routine: 'silent' },
      }),
      '01APPROVALFRAME00000000E02',
    );

    expect(db.applyPeerProfile!).toHaveBeenCalledWith(
      FRIEND,
      expect.objectContaining({ displayName: 'Claude Code', version: 2 }),
    );
    expect(db.applyAiNotifyPreferenceAck!).not.toHaveBeenCalled();
  });
});
