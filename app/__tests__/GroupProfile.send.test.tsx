/**
 * ROOMS — the REAL GroupProfileScreen against the REAL send seam, on Node's REAL SQLite engine.
 *
 * Why this file exists: an independent gate ran 45 mutations against the
 * committed room work and 19 survived, the worst three through one structural
 * hole — messaging.groups.send.test.ts drives HAND-ROLLED COPIES of this
 * screen's closures against the real seam, and GroupProfile.test.tsx drives
 * the real screen against a FAKE seam. No test anywhere ran the screen's own
 * handlers through the real `fanOutMembership`, so screen-to-seam drift was
 * invisible. This suite is the missing combination: the rendered screen's own
 * controls, the real seam, the real engine (harness halves copied from those
 * two files; GroupCreate.test.tsx is the precedent for running all three
 * together).
 *
 * The three surviving mutations it kills, each a real failure mode on two
 * phones:
 *
 *  1. THE SEQUENCE LANE. The screen's roster/settings/delete writes reserve
 *     `reserveGroupSeq(groupId, 'writer')`. Mutated to 'msg', every test
 *     stayed green — the screen suite's mock returned the same counter for
 *     any lane — while on real phones the roster write arrives at or below
 *     the receiver's stored writer-lane seq and FOLDS AWAY AS STALE: a
 *     Remove that appears to work and silently takes effect nowhere
 *     (the exact defect class). Here the two lanes are made to answer
 *     DIFFERENT numbers before the press, so the wrong lane is observable
 *     in the composed envelope, the persisted slot, and the announcement
 *     row's sq.
 *
 *  2. THE FAILURE COPY on a PRE-apply failure. `if (appliedLocally)` and
 *     `if (purged)` forced to `if (true)` survived every test, because the
 *     committed copy tests only drive the POST-apply path. A blocked member
 *     or a stopped messaging session fails BEFORE anything is applied, so
 *     "That change was made on this iPhone but couldn't be sent" would be a
 *     lie — and for delete, claiming the room is gone (and firing
 *     onRoomGone) while it still stands. The pre-apply tests here pin the
 *     generic copy, the absence of the made-on-this-iPhone copy, and for
 *     delete that the room survives and onRoomGone never fires.
 *
 *  3. THE ANNOUNCEMENT ROW'S SHAPE. The screen suite's fake wrote the row
 *     via db.insertMessage (INSERT OR IGNORE, no authorId, no sq), so two
 *     assertions pinned the FAKE's SQL. Here the row the real seam writes —
 *     plain INSERT inside the fan-out transaction, authorId and sq present,
 *     parenting every leg — is read back out of the real engine.
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
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { createRoom } from '../src/screens/GroupCreateScreen';
import {
  GroupProfileScreen,
  ROOM_COPY,
} from '../src/screens/GroupProfileScreen';
import { session } from '../src/session';

// The real seam's drain is genuinely slow (the bucket is born empty), so
// tests here spend real seconds — close enough to Jest's DEFAULT 5 s per-test
// deadline for worker-scheduling stalls to expire it while nothing is wrong,
// and a mid-test expiry leaves the renderer broken so the SUITE'S OTHER tests
// cascade-fail at `tree.root` (measured, pinned to the efficiency cores).
// Every assertion deadline is bounded in polls instead (see `settle`); this
// ceiling is only the backstop against a genuine hang.
jest.setTimeout(120_000);

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
  decryptEnvelope: jest.Mock;
  randomBytes: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

// --- ids --------------------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const BEN = pad('BEN');
const CARA = pad('CARA');
const EVE = pad('EVE');

const PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: 'Me',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** The plaintext each member's leg carried, from the ratchet's own calls. */
function composedFor(): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const call of crypto.encryptText.mock.calls) {
    const [, peer, plaintext] = call as [string, string, string];
    try {
      out.set(peer, JSON.parse(plaintext) as Row);
    } catch {
      /* profile cards etc. */
    }
  }
  return out;
}

/** Both lane counters, so a test can state which lane answered (a
 * roster write on the wrong lane folds away as stale on every receiver). */
function counters(groupId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of q(
    `SELECT scope, seq FROM group_counters WHERE groupId = ?`,
    groupId,
  )) {
    out[String(row.scope)] = Number(row.seq);
  }
  return out;
}

/**
 * Make the two lanes answer DIFFERENT numbers before the screen acts. The
 * old screen-suite mock returned the same counter for any lane, which is
 * exactly why the 'writer' → 'msg' mutation could hide; with the msg lane
 * burned ahead, the wrong lane is a different number everywhere it lands.
 */
async function burnMsgLane(groupId: string, n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await db.reserveGroupSeq(groupId, 'msg');
}

/** Create MY room and clear the create fan-out's legs and mock traffic, so
 * every leg and ciphertext asserted below belongs to the SCREEN's action.
 * (The create fan-out has its own suites: GroupCreate.test.tsx and
 * messaging.groups.send.test.ts.) */
async function makeRoom(members: string[]): Promise<string> {
  const { groupId } = await createRoom(ME, 'Kitchen', members);
  q(`DELETE FROM outbox`);
  ws.calls.send.mockClear();
  crypto.encryptText.mockClear();
  return groupId;
}

// --- the rendered screen ----------------------------------------------------

const trees: ReactTestRenderer.ReactTestRenderer[] = [];

async function renderProfile(
  props: Partial<React.ComponentProps<typeof GroupProfileScreen>> & {
    groupId: string;
  },
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GroupProfileScreen me={PROFILE} onBack={jest.fn()} {...props} />,
    );
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  trees.push(tree);
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID }).length > 0;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = tree.root.findAll(
    n => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => node.props.onPress());
  await ReactTestRenderer.act(async () => {
    await flush();
  });
}

/**
 * The screen's actions run through `run()` — fire-and-forget — and the seam's
 * enqueue is transactional but its pacing drain rides real timers, so wait on
 * the CONDITION, bounded IN POLLS rather than by a fixed sleep or a wall
 * clock: the send suite's fixed-deadline polling produced 7 false mutation
 * kills under parallel-worker load, because worker scheduling can expire a
 * Date.now() budget while the drain made every bit of expected progress.
 * Each poll is one 25 ms timer grant from the same queue the drain's own
 * timers ride, so a stall delays both together. 200 polls is the old 5 s at
 * nominal speed; on exhaustion it returns and lets the caller's assertion
 * fail loudly.
 */
async function settle(
  done: () => boolean,
  maxPolls = 200,
): Promise<void> {
  for (let poll = 0; !done(); poll++) {
    if (poll >= maxPolls) return;
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
      await flush();
    });
  }
}

const outboxLegs = (): Row[] =>
  q(`SELECT msgId, peerId, payload, localMsgId FROM outbox ORDER BY peerId`);

const errorShown = (tree: ReactTestRenderer.ReactTestRenderer) => () =>
  tree.root.findAll(n => n.props?.testID === 'room-action-error').length > 0;

// ---------------------------------------------------------------------------

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockReset();
  crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' });
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  // Distinct deterministic draws: every fan-out leg's wire id is 26 chars of
  // CSPRNG, and the suite-wide position-deterministic stand-in
  // would collide legs on the outbox PRIMARY KEY.
  let draw = 0;
  crypto.randomBytes.mockImplementation(async (count: number) => {
    draw += 1;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = (i * 37 + 11 + draw * 53) % 256;
    return out;
  });
  ws.calls.send.mockClear();
  ws.state.open = true;
  session.setMode('real');
  db.setWorkspace('real');
  bindRealEngine();
  crypto.__keychain.set('authToken', 'token-1');
  await db.initDb();
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
});

afterEach(async () => {
  for (const tree of trees.splice(0)) {
    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  }
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

// ---------------------------------------------------------------------------
// 1. The sequence lane: the screen's writes ride 'writer', observably.
// ---------------------------------------------------------------------------

describe('the sequence lane — the screen reserves the WRITER lane, distinguishable from the message lane', () => {
  test('Remove through the screen: the roster write carries the writer-lane seq in the envelope, the slot, and the sq — and spends no msg-lane number', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const groupId = await makeRoom([BEN, CARA]);
    await burnMsgLane(groupId);
    // Precondition — the lanes CANNOT answer alike, or the wrong lane would
    // be invisible (exactly how the mutation hid under the screen suite's
    // same-counter mock): createRoom spent writer 1, the burn left msg at 5.
    expect(counters(groupId)).toEqual({ writer: 1, msg: 5 });

    const tree = await renderProfile({ groupId });
    expect(has(tree, `member-remove-${BEN}`)).toBe(true); // fixture reaches the screen
    await press(tree, `member-remove-${BEN}`);
    await press(tree, `member-remove-confirm-${BEN}`); // Remove asks first
    await settle(() => outboxLegs().length >= 2);

    // The union: the removed member's leg exists too.
    expect(outboxLegs().map(l => l.peerId).sort()).toEqual([BEN, CARA].sort());
    // What the RECEIVER folds: n = 2 is above every stored writer-lane slot
    // (seq 1), so the Remove takes effect. The mutated lane would say 6 —
    // at-or-below nothing, but a number the writer lane never allocated, so
    // the NEXT real writer write (2) arrives at-or-below the stored 6 and
    // folds away as stale: the silent-nowhere Remove.
    const composed = composedFor();
    expect(composed.get(BEN)!.tcm).toBe('grp.roster');
    expect(composed.get(BEN)!.n).toBe(2);
    expect(composed.get(CARA)!.n).toBe(2);
    // The write spent the WRITER lane and left the message lane alone.
    expect(counters(groupId)).toEqual({ writer: 2, msg: 5 });
    // The persisted slot agrees with the wire: one write, one number.
    expect(
      q(
        `SELECT seq, state FROM group_members
         WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        ME,
      ),
    ).toEqual([{ seq: 2, state: 'out' }]);
  });

  test('the timer through the screen: grp.set carries the writer-lane seq, and the settings slot and announcement row agree', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const groupId = await makeRoom([BEN, CARA]);
    await burnMsgLane(groupId);
    expect(counters(groupId)).toEqual({ writer: 1, msg: 5 });

    const tree = await renderProfile({ groupId });
    await press(tree, 'room-timer-3600');
    await settle(() => outboxLegs().length >= 2);

    const composed = composedFor();
    expect(composed.get(BEN)!.tcm).toBe('grp.set');
    expect(composed.get(BEN)!.s).toBe(3600);
    expect(composed.get(BEN)!.n).toBe(2);
    expect(counters(groupId)).toEqual({ writer: 2, msg: 5 });
    expect(
      q(
        `SELECT seq, disappearSec FROM group_settings
         WHERE groupId = ? AND writerId = ?`,
        groupId,
        ME,
      ),
    ).toEqual([{ seq: 2, disappearSec: 3600 }]);
    const announce = q(
      `SELECT authorId, sq FROM messages
       WHERE peerId = ? AND body LIKE '%grp.set%'`,
      groupId,
    );
    expect(announce).toEqual([{ authorId: ME, sq: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// 2. The announcement row is the REAL seam's, read back off the real engine.
// ---------------------------------------------------------------------------

describe('the roster-write class through the screen', () => {
  test('an owner Add of a RECORDED machine: c on the roster write, ic on the invite snapshot, class on the slot', async () => {
    const groupId = await makeRoom([CARA]);
    await db.upsertChat(BEN, 'Claude · laptop');
    await db.recordMachinePeer(BEN, Date.now());
    const tree = await renderProfile({ groupId });
    await press(tree, 'room-add');
    await press(tree, `room-add-${BEN}`);
    await settle(() => composedFor().size >= 2);

    const legs = composedFor();
    // The brand-new member's own leg is the grp.new snapshot — it carries ic,
    // so the added agent's own client (and any snapshot-folder) learns too.
    const invite = legs.get(BEN)!;
    expect(invite.tcm).toBe('grp.new');
    expect(invite.ic).toEqual([BEN]);
    // The standing member's leg is the roster write carrying c.
    const roster = legs.get(CARA)!;
    expect(roster.tcm).toBe('grp.roster');
    expect(roster.c).toBe('integration');
    // And this phone's own slot is classed.
    expect(
      q(
        `SELECT class FROM group_members WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        ME,
      ),
    ).toEqual([{ class: 'integration' }]);
  });

  test('an owner Add of a HUMAN to a room already holding a classed agent: the newcomer’s snapshot carries the EXISTING class', async () => {
    // The core bootstrap scenario: the agent is in the room FIRST (classed
    // at creation), the second human arrives LATER. That human's first fold is
    // the grp.new snapshot minted here, so the fold's EXISTING classes must
    // ride its `ic` (the fold-class disjunct of inviteIc) — the added member
    // is unclassed, so the write's-own-`c` disjunct contributes nothing.
    // Delete the fold-class disjunct and this reddens.
    await db.upsertChat(BEN, 'Claude · laptop');
    await db.recordMachinePeer(BEN, Date.now());
    const groupId = await makeRoom([BEN]);
    // Precondition: the creation classed the agent on this phone's own slot.
    expect(
      q(
        `SELECT class FROM group_members WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        ME,
      ),
    ).toEqual([{ class: 'integration' }]);
    await db.upsertChat(CARA, 'Cara');
    const tree = await renderProfile({ groupId });
    await press(tree, 'room-add');
    await press(tree, `room-add-${CARA}`);
    await settle(() => composedFor().size >= 2);

    const legs = composedFor();
    // The newcomer's leg is the snapshot, and it names the room's agent.
    const invite = legs.get(CARA)!;
    expect(invite.tcm).toBe('grp.new');
    expect(invite.ic).toEqual([BEN]);
    // The standing agent's leg is the human's roster write — no c: the added
    // member is a human and nothing was guessed about them.
    const roster = legs.get(BEN)!;
    expect(roster.tcm).toBe('grp.roster');
    expect('c' in roster).toBe(false);
  });

  test('an owner Add of a HUMAN carries no class anywhere — the phone never guesses', async () => {
    const groupId = await makeRoom([CARA]);
    await db.upsertChat(BEN, 'Ben');
    const tree = await renderProfile({ groupId });
    await press(tree, 'room-add');
    await press(tree, `room-add-${BEN}`);
    await settle(() => composedFor().size >= 2);

    for (const [, env] of composedFor()) {
      expect('c' in env).toBe(false);
      expect('ic' in env).toBe(false);
    }
    expect(
      q(
        `SELECT class FROM group_members WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        ME,
      ),
    ).toEqual([{ class: null }]);
  });
});

describe('the announcement row — the real seam’s shape, not the old fake’s', () => {
  test('a screen Remove lands ONE room-parented row carrying authorId and sq, and every leg points back at it', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const groupId = await makeRoom([BEN, CARA]);

    const tree = await renderProfile({ groupId });
    await press(tree, `member-remove-${BEN}`);
    await press(tree, `member-remove-confirm-${BEN}`); // Remove asks first
    await settle(() => outboxLegs().length >= 2);

    // The row the receive path can converge with: attributed (authorId) and
    // ordered (sq) — the columns the screen suite's fake never wrote, which
    // let two assertions pin db.insertMessage's INSERT OR IGNORE instead.
    const rows = q(
      `SELECT msgId, authorId, sq, direction, status FROM messages
       WHERE peerId = ? AND body LIKE '%grp.roster%'`,
      groupId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorId).toBe(ME);
    expect(rows[0]!.sq).toBe(2); // the writer lane's number, stored on the row
    expect(rows[0]!.direction).toBe('out');
    // 'pending' until the leg ledger settles it — no receipt arrives here.
    expect(rows[0]!.status).toBe('pending');
    // One row, N legs, one transaction: each leg parented to THIS row.
    const legs = outboxLegs();
    expect(legs).toHaveLength(2);
    expect(legs.every(l => l.localMsgId === rows[0]!.msgId)).toBe(true);
    expect(legs.every(l => l.payload !== '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. PRE-apply failures: the copy must not claim a change that never applied.
// ---------------------------------------------------------------------------

describe('a PRE-apply failure through the screen — the generic copy, never the made-on-this-iPhone claim', () => {
  test('a blocked member fails a Remove BEFORE the apply: generic copy, no sendFailed, the slot untouched, nothing composed or queued', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(EVE, 'Eve');
    const groupId = await makeRoom([BEN, EVE]);
    await messaging.blockPeer(EVE);
    // Precondition: the block is real in the store the gate reads.
    expect(q(`SELECT peerId FROM blocked_peers`)).toEqual([{ peerId: EVE }]);

    const tree = await renderProfile({ groupId });
    expect(has(tree, `member-remove-${BEN}`)).toBe(true);
    await press(tree, `member-remove-${BEN}`);
    await press(tree, `member-remove-confirm-${BEN}`); // Remove asks first
    await settle(errorShown(tree));

    // Precondition-holds proof that the press reached the seam rather than
    // dying in the fixture: writeRoster reserved its writer seq before the
    // gate threw.
    expect(counters(groupId).writer).toBe(2);

    // The copy: this change did NOT happen on this iPhone, and the screen
    // must not say it did. The mutation `if (appliedLocally)` → `if (true)`
    // shows the sendFailed line here — both assertions catch it.
    const text = renderedText(tree);
    expect(text).toContain(ROOM_COPY.failed);
    expect(text).not.toContain(ROOM_COPY.sendFailed);

    // And truly pre-apply: Ben's seat is untouched, nothing composed,
    // nothing queued (a refused write must not fork this roster).
    expect(
      q(
        `SELECT seq, state FROM group_members
         WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        ME,
      ),
    ).toEqual([{ seq: 1, state: 'in' }]);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });

  test('a stopped messaging session fails the timer BEFORE the apply: generic copy, no settings slot, no announcement', async () => {
    await db.upsertChat(BEN, 'Ben');
    const groupId = await makeRoom([BEN]);

    const tree = await renderProfile({ groupId });
    await ReactTestRenderer.act(async () => {
      messaging.stop(); // the relock, before the press
    });
    await press(tree, 'room-timer-3600');
    await settle(errorShown(tree));

    // The press reached setTimer (the seq was reserved) and then the seam
    // refused pre-apply — not a fixture that stopped short.
    expect(counters(groupId).writer).toBe(2);

    const text = renderedText(tree);
    expect(text).toContain(ROOM_COPY.failed);
    expect(text).not.toContain(ROOM_COPY.sendFailed);

    // Nothing applied, announced, or queued.
    expect(
      q(`SELECT writerId FROM group_settings WHERE groupId = ?`, groupId),
    ).toEqual([]);
    expect(
      q(`SELECT msgId FROM messages WHERE body LIKE '%grp.set%'`),
    ).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });

  test('Delete for everyone failing BEFORE the purge: the room still stands, onRoomGone is NOT called, and the copy never claims the room is gone', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const groupId = await makeRoom([BEN, CARA]);
    const onRoomGone = jest.fn();

    const tree = await renderProfile({ groupId, onRoomGone });
    await press(tree, 'room-delete-everyone');
    // Precondition: the confirm is really open — the press below presses it.
    expect(has(tree, 'room-delete-everyone-confirm')).toBe(true);
    await ReactTestRenderer.act(async () => {
      messaging.stop();
    });
    await press(tree, 'room-delete-everyone-confirm');
    await settle(errorShown(tree));

    // The confirm reached deleteEveryone (seq reserved), then the seam
    // refused before the apply could purge anything.
    expect(counters(groupId).writer).toBe(2);

    // The mutation `if (purged)` → `if (true)` claims the room is gone and
    // fires onRoomGone while it still stands. Every line below catches it.
    expect(onRoomGone).not.toHaveBeenCalled();
    const text = renderedText(tree);
    expect(text).toContain(ROOM_COPY.failed);
    expect(text).not.toContain(ROOM_COPY.deleteSendFailed);
    // The room really still stands, on the real engine.
    expect(
      q(`SELECT groupId FROM groups WHERE groupId = ?`, groupId),
    ).toHaveLength(1);
    expect(
      q(`SELECT peerId FROM chats WHERE peerId = ?`, groupId),
    ).toHaveLength(1);
    expect(
      q(`SELECT memberId FROM group_members WHERE groupId = ?`, groupId),
    ).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Delete for everyone through the screen, against the real purge.
// ---------------------------------------------------------------------------

describe('Delete for everyone through the screen — the real purge and the real legs', () => {
  test('the purge runs, the grp.del legs carry the writer-lane seq on a non-room parent, and the screen closes the room once', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const groupId = await makeRoom([BEN, CARA]);
    await burnMsgLane(groupId);
    expect(counters(groupId)).toEqual({ writer: 1, msg: 5 });
    const onRoomGone = jest.fn();

    const tree = await renderProfile({ groupId, onRoomGone });
    await press(tree, 'room-delete-everyone');
    await press(tree, 'room-delete-everyone-confirm');
    await settle(
      () =>
        outboxLegs().length >= 2 && onRoomGone.mock.calls.length > 0,
    );

    // The purge ran on the real engine…
    expect(q(`SELECT groupId FROM groups WHERE groupId = ?`, groupId)).toEqual([]);
    expect(
      q(`SELECT memberId FROM group_members WHERE groupId = ?`, groupId),
    ).toEqual([]);
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, groupId)).toEqual([]);
    // …and the screen was told exactly once.
    expect(onRoomGone).toHaveBeenCalledTimes(1);

    // The legs survived the purge (parented OUTSIDE the room) and carry the
    // WRITER lane's number — the mutated lane would say 6, not 2, and a
    // receiver folding grp.del against its writer-lane seq would drop it.
    const legs = outboxLegs();
    expect(legs.map(l => l.peerId).sort()).toEqual([BEN, CARA].sort());
    expect(legs.every(l => l.payload !== '')).toBe(true);
    const composed = composedFor();
    expect(composed.get(BEN)!.tcm).toBe('grp.del');
    expect(composed.get(BEN)!.n).toBe(2);
    expect(composed.get(CARA)!.n).toBe(2);
    const parent = q(
      `SELECT peerId, authorId, sq FROM messages WHERE msgId = ?`,
      legs[0]!.localMsgId,
    );
    expect(parent).toHaveLength(1);
    expect(parent[0]!.peerId).not.toBe(groupId);
    expect(parent[0]!.authorId).toBe(ME);
    expect(parent[0]!.sq).toBe(2);
  });

  /**
   * Sharing history, through the REAL sender: the
   * screen's press, messaging.shareHistory, the ratchet's own calls.
   */
  describe('sharing history with someone just added', () => {
    /** Put words in the room that are actually shareable. */
    async function seedTalk(groupId: string, n: number): Promise<void> {
      await db.upsertChat(BEN, 'Ben');
      await db.upsertChat(CARA, 'Cara');
      for (let i = 0; i < n; i++) {
        await db.insertMessage({
          msgId: `${CARA}.T${String(i).padStart(25, '0')}`,
          peerId: groupId,
          direction: 'in',
          body: `said ${i}`,
          ts: 1_000 + i,
          status: 'received',
          authorId: CARA,
        });
      }
    }

    test('the offer appears only after the add lands, and sending NOTHING sends nothing', async () => {
      const groupId = await makeRoom([CARA]);
      await seedTalk(groupId, 3);
      const tree = await renderProfile({ groupId });

      // No offer before an add: it must never look like a standing setting.
      expect(() => tree.root.findByProps({ testID: 'room-share-prompt' })).toThrow();

      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: 'room-add' }).props.onPress();
        await flush();
      });
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: `room-add-${BEN}` }).props.onPress();
        await flush();
      });
      tree.root.findByProps({ testID: 'room-share-prompt' }); // throws if absent
      crypto.encryptText.mockClear();

      // Rule 2: sharing is the deliberate act. Declining is one press and
      // must put NOTHING on the wire.
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: 'room-share-none' }).props.onPress();
        await flush();
      });
      expect(() => tree.root.findByProps({ testID: 'room-share-prompt' })).toThrow();
      const kinds = [...composedFor().values()].map(e => e.tcm);
      expect(kinds).not.toContain('grp.hist');
    });

    test('choosing an extent announces to EVERYONE and relays to the newcomer alone', async () => {
      const groupId = await makeRoom([CARA]);
      await seedTalk(groupId, 3);
      const tree = await renderProfile({ groupId });
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: 'room-add' }).props.onPress();
        await flush();
      });
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: `room-add-${BEN}` }).props.onPress();
        await flush();
      });
      crypto.encryptText.mockClear();
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: 'room-share-50' }).props.onPress();
        await flush();
      });

      // Every grp.hist plaintext the ratchet was actually asked to encrypt,
      // per recipient — composedFor() keeps only the last per peer, so read
      // the raw calls instead.
      const withPeer = crypto.encryptText.mock.calls
        .map(c => {
          const [, peer, text] = c as [string, string, string];
          try { return { peer, env: JSON.parse(text) as Record<string, unknown> }; }
          catch { return null; }
        })
        .filter((x): x is { peer: string; env: Record<string, unknown> } =>
          x !== null && x.env.tcm === 'grp.hist');

      expect(withPeer.length).toBeGreaterThan(0);
      // Rule 3: the announcement (no `e`) reaches every member, Cara included
      // — she is one of the people whose words moved.
      const announced = withPeer.filter(x => x.env.e === undefined).map(x => x.peer);
      expect(announced.sort()).toEqual([BEN, CARA].sort());
      // The transcript (with `e`) reaches ONLY the newcomer. If Cara ever
      // appears here, one person's history has been relayed to the room.
      const transcript = withPeer.filter(x => x.env.e !== undefined);
      expect([...new Set(transcript.map(x => x.peer))]).toEqual([BEN]);
      expect(transcript).toHaveLength(3); // one envelope per message

      // The claimed author is the ORIGINAL author, never the relayer.
      for (const x of transcript) {
        expect((x.env.e as Record<string, unknown>).a).toBe(CARA);
      }
      // The outcome is stated, not assumed: the room has already been told the
      // share happened, so a silent stall would leave everyone believing the
      // newcomer can see words they cannot.
      expect(renderedText(tree)).toContain('Sent 3 messages to Ben.');
    });

    test('a NON-OWNER is never offered the share, and the sender refuses one anyway', async () => {
      // Cara's room, not mine: I am an ordinary member.
      const groupId = pad('7R00M');
      const store = await db.loadGroupStore(groupId);
      store.setOwner(CARA);
      await store.persist();
      await db.insertMessage({
        msgId: `${CARA}.X${'0'.repeat(24)}`,
        peerId: groupId,
        direction: 'in',
        body: 'their words',
        ts: 1_000,
        status: 'received',
        authorId: CARA,
      });
      const tree = await renderProfile({ groupId });
      // The add button itself is owner-only, so there is no route to the
      // offer — but the guard that matters is the sender's, because a screen
      // is not a security boundary.
      expect(() => tree.root.findByProps({ testID: 'room-share-prompt' })).toThrow();
      await expect(messaging.shareHistory(groupId, BEN, 50)).rejects.toThrow(
        /only the owner/i,
      );
    });
  });

});
