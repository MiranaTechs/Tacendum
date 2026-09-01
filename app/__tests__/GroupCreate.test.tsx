/**
 * ROOMS — creation.
 *
 * Same harness as messaging.groups.receive.test.ts, for the same reason: the
 * suite-wide op-sqlite mock RECORDS statements without executing them, so
 * every assertion here reads actual rows out of Node's real SQLite engine —
 * behaviour, not parameters.
 *
 * What this file proves:
 *  - `createRoom` anchors the room with THIS phone's id as owner, seeds the
 *    full roster as owner-lane `in` slots, writes the room's chats row
 *    (kind='group') and its first message row — and puts one encrypted
 *    invitation on the wire per member, none of them addressed to the room
 *    id (a room id never reaches `SendFrame.to`).
 *  - GROUP_MAX_MEMBERS binds in the COMPOSER, twice: `createRoom` refuses a
 *    13th seat before writing anything, and the screen closes unpicked rows
 *    once the room is full.
 *  - A room that would contain someone this iPhone blocks is never made —
 *    refused before any allocation (the gate order).
 *  - One member's failed invitation is LOUD (named in the result) and does
 *    not strand the others' invitations — fanOut's skip rule,
 *    applied to the invite.
 *  - The whole flow works from the SCREEN — name typed, rows picked, button
 *    pressed — so no fixture stops short of the code under test.
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
import { GROUP_MAX_MEMBERS } from '@tacendum/shared/group-envelope';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import {
  createRoom,
  GroupCreateScreen,
} from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';

// The invitations drain through the born-empty bucket (~3.83 tokens/s), so
// the create tests spend real seconds — close enough to Jest's DEFAULT 5 s
// per-test deadline for worker-scheduling stalls to expire it while nothing
// is wrong. Measured, pinned to the efficiency cores: the create test times
// out mid-act and the two RENDER-ONLY tests after it cascade-fail at
// `tree.root` — three false failures from one stall. Assertion deadlines are
// bounded in polls (see waitForSent); this ceiling is only the backstop
// against a genuine hang.
jest.setTimeout(120_000);

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Every `send`-type frame the socket saw, in order. */
function sentFrames(): { to: string; msgType: string; payload: string }[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; to?: string; msgType?: string; payload?: string })
    .filter(f => f.type === 'send') as {
    to: string;
    msgType: string;
    payload: string;
  }[];
}

/**
 * Invitations are room-scoped fan-out LEGS now, not 1:1 sends, so they drain
 * through the pacing bucket — born empty, ~3.8 tokens/s plus jitter —
 * instead of leaving synchronously. Real timers here (this suite drives a
 * real engine through real awaits), so the drain is awaited by polling on
 * the CONDITION with the budget counted in POLLS, never wall-clock: each
 * poll is one 25 ms timer grant from the same queue the drain's own timers
 * ride, so a stalled worker delays both together instead of expiring the
 * wait (a Date.now() deadline here failed under parallel-worker load).
 * 240 polls is the old 6 s at nominal speed; on exhaustion it returns and
 * lets the caller's assertion fail loudly.
 */
async function waitForSent(n: number, maxPolls = 240): Promise<void> {
  for (let poll = 0; sentFrames().length < n; poll++) {
    if (poll >= maxPolls) return; // let the assertion fail loudly
    await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
    await flush();
  }
}

/** The grp.new plaintexts handed to the ratchet, by recipient. */
function invitesComposedFor(): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const call of crypto.encryptText.mock.calls) {
    const [, peer, plaintext] = call as [string, string, string];
    try {
      const parsed = JSON.parse(plaintext) as Row;
      if (parsed.tcm === 'grp.new') out.set(peer, parsed);
    } catch {
      // profile cards etc.
    }
  }
  return out;
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockReset();
  crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' });
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  // The suite-wide randomBytes stand-in is position-deterministic, which was
  // fine while nothing here minted wire ids — but every fan-out leg's msgId
  // is 26 characters of CSPRNG, and identical draws collide on the
  // outbox PRIMARY KEY. Distinct draws, still deterministic per test.
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
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

// ---------------------------------------------------------------------------

describe('createRoom — the anchor, the roster, and the fan-out', () => {
  test('anchors ME as owner, seeds every seat, and invites each member — never the room id — on the wire', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');

    const { groupId, failed } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
    await flush();
    await waitForSent(2); // paced legs, not synchronous 1:1 sends

    expect(failed).toEqual([]);

    // The anchor: MYSELF as owner, written once.
    expect(q(`SELECT ownerId, name FROM groups WHERE groupId = ?`, groupId))
      .toEqual([{ ownerId: ME, name: 'Kitchen' }]);

    // The roster: every seat including mine, `in`, in MY lane — the same
    // slots a member's phone derives from the grp.new it accepts.
    expect(
      q(
        `SELECT memberId, writerId, state FROM group_members
         WHERE groupId = ? ORDER BY memberId`,
        groupId,
      ),
    ).toEqual(
      [BEN, CARA, ME]
        .sort()
        .map(memberId => ({ memberId, writerId: ME, state: 'in' })),
    );

    // The conversation exists as a room, not a person.
    expect(
      q(`SELECT kind, groupName FROM chats WHERE peerId = ?`, groupId),
    ).toEqual([{ kind: 'group', groupName: 'Kitchen' }]);

    // Its first row is the attributed grp.new, previewed honestly. 'pending'
    // now, not 'sent': the row is the fan-out's parent (one row, N legs, one
    // transaction), and aggregateFanoutStatus settles it from the leg
    // ledger once every leg receipts or fails — no receipt ever arrives in
    // this harness, so pending is the truthful state.
    const rows = q(
      `SELECT direction, authorId, status FROM messages WHERE peerId = ?`,
      groupId,
    );
    expect(rows).toEqual([
      { direction: 'out', authorId: ME, status: 'pending' },
    ]);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, groupId),
    ).toEqual([{ lastMessageText: 'New room' }]);

    // The wire: one encrypted frame per member; the plaintext grp.new that
    // reached the ratchet names the room, the roster and my seq for BOTH
    // members; and NO frame is addressed to the room id.
    const frames = sentFrames();
    expect(frames.map(f => f.to).sort()).toEqual([BEN, CARA].sort());
    expect(frames.every(f => f.to !== groupId)).toBe(true);
    const composed = invitesComposedFor();
    for (const member of [BEN, CARA]) {
      const invite = composed.get(member);
      expect(invite).toBeDefined();
      expect(invite!.g).toBe(groupId);
      expect(invite!.nm).toBe('Kitchen');
      expect((invite!.ms as string[]).sort()).toEqual([BEN, CARA, ME].sort());
    }
  });

  test('createRoom classes a RECORDED machine: ic on every invite, class on the seed slot', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Claude · laptop');
    // The machine record — the app's own knowledge of what CARA is. This is
    // the OWNER-side half of the consent-bootstrap fix: the roster write
    // carries the class, so an invitee's phone can offer the consent choice
    // before the agent ever speaks.
    await db.recordMachinePeer(CARA, Date.now());

    const { groupId, failed } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
    await flush();
    await waitForSent(2);
    expect(failed).toEqual([]);

    // Every invite leg names CARA in ic — the parallel list, never a reshaped
    // ms entry (old parsers strip the key; reshaping would refuse the invite).
    const composed = invitesComposedFor();
    for (const member of [BEN, CARA]) {
      expect(composed.get(member)!.ic).toEqual([CARA]);
    }
    // The creator's own seed slot is classed, and only CARA's.
    expect(
      q(
        `SELECT memberId, class FROM group_members
         WHERE groupId = ? ORDER BY memberId`,
        groupId,
      ),
    ).toEqual(
      [BEN, CARA, ME]
        .sort()
        .map(memberId => ({
          memberId,
          class: memberId === CARA ? 'integration' : null,
        })),
    );
  });

  test('a room of humans alone carries NO ic — absent is the safe default', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Humans', [BEN]);
    await flush();
    await waitForSent(1);
    expect(groupId).toBeDefined();
    const invite = invitesComposedFor().get(BEN)!;
    expect('ic' in invite).toBe(false);
  });

  test('a 13th seat is refused in the composer, before anything is written or sent', async () => {
    const many = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) =>
      pad(`X${i}Z`),
    );
    // Fixture sanity: this IS one over the cap once ME is counted.
    expect(many.length + 1).toBe(GROUP_MAX_MEMBERS + 1);

    await expect(createRoom(ME, 'Kitchen', many)).rejects.toThrow(/holds/);

    expect(q(`SELECT groupId FROM groups`)).toEqual([]);
    expect(q(`SELECT groupId FROM group_members`)).toEqual([]);
    expect(q(`SELECT groupId FROM group_counters`)).toEqual([]);
    expect(q(`SELECT peerId FROM chats`)).toEqual([]);
    expect(sentFrames()).toEqual([]);
  });

  test('a room that would contain someone this iPhone blocks is never made', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.blockPeer(EVE, Date.now());

    await expect(createRoom(ME, 'Kitchen', [BEN, EVE])).rejects.toThrow();

    expect(q(`SELECT groupId FROM groups`)).toEqual([]);
    expect(q(`SELECT groupId FROM group_counters`)).toEqual([]);
    expect(sentFrames()).toEqual([]);
    // The block itself is untouched.
    expect(q(`SELECT peerId FROM blocked_peers`)).toEqual([{ peerId: EVE }]);
  });

  test('one failed invitation is named, the others still go out, and the roster keeps the seat', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string) => {
        if (peer === CARA) throw new Error('ratchet said no');
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );

    const { groupId, failed } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
    await flush();
    await waitForSent(1); // Ben's paced leg

    expect(failed.map(f => f.peerId)).toEqual([CARA]);
    // Ben's invitation still went out.
    expect(sentFrames().map(f => f.to)).toContain(BEN);
    // Cara's seat is still on the roster: the roster is the owner's claim,
    // and silently shrinking it would be the exact omission.
    expect(
      q(
        `SELECT memberId FROM group_members WHERE groupId = ? AND memberId = ?`,
        groupId,
        CARA,
      ),
    ).toEqual([{ memberId: CARA }]);
  });
});

// ---------------------------------------------------------------------------

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

describe('GroupCreateScreen — the composer', () => {
  test('name it, pick two people, create: the room exists and the screen hands the ULID onward', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const onOpenRoom = jest.fn();

    const tree = await render(
      <GroupCreateScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenRoom={onOpenRoom}
      />,
    );

    // Fixture sanity: both people are pickable.
    expect(byId(tree, `room-pick-${BEN}`).length).toBeGreaterThan(0);
    expect(byId(tree, `room-pick-${CARA}`).length).toBeGreaterThan(0);

    await ReactTestRenderer.act(async () => {
      byId(tree, 'room-name-input')[0].props.onChangeText('Kitchen');
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, `room-pick-${BEN}`)[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, `room-pick-${CARA}`)[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, 'room-create')[0].props.onPress();
      await flush();
    });

    expect(onOpenRoom).toHaveBeenCalledTimes(1);
    const groupId = onOpenRoom.mock.calls[0][0] as string;
    expect(groupId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(q(`SELECT ownerId FROM groups WHERE groupId = ?`, groupId)).toEqual([
      { ownerId: ME },
    ]);
    await ReactTestRenderer.act(async () => {
      await waitForSent(2); // the invitations drain through the pacing bucket
    });
    expect(sentFrames().map(f => f.to).sort()).toEqual([BEN, CARA].sort());

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the screen closes the room at the cap: the 12th seat is the last, the next row is disabled and refuses the press', async () => {
    const people = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) =>
      pad(`P${i}Z`),
    );
    for (const id of people) await db.upsertChat(id, `P ${id.slice(1, 3)}`);

    const tree = await render(
      <GroupCreateScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenRoom={jest.fn()}
      />,
    );

    // Pick the first eleven: with me that is a full room of twelve.
    for (const id of people.slice(0, GROUP_MAX_MEMBERS - 1)) {
      await ReactTestRenderer.act(async () => {
        byId(tree, `room-pick-${id}`)[0].props.onPress();
      });
    }
    expect(byId(tree, 'room-cap-note').length).toBeGreaterThan(0);

    const last = people[GROUP_MAX_MEMBERS - 1];
    const lastRow = byId(tree, `room-pick-${last}`)[0];
    expect(lastRow.props.accessibilityState.disabled).toBe(true);
    // Behaviour, not the flag: even a press that slips through changes
    // nothing — the 13th seat does not exist.
    await ReactTestRenderer.act(async () => {
      lastRow.props.onPress();
    });
    expect(byId(tree, `room-picked-${last}`).length).toBe(0);
    // The eleven picked seats are still exactly eleven.
    const picked = people.filter(
      id => byId(tree, `room-picked-${id}`).length > 0,
    );
    expect(picked.length).toBe(GROUP_MAX_MEMBERS - 1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the honest limits sit behind the ⓘ: owner-only membership, leave-any-time, and the server line, unsoftened', async () => {
    await db.upsertChat(BEN, 'Ben');
    const tree = await render(
      <GroupCreateScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenRoom={jest.fn()}
      />,
    );

    // Behind the toggle, not inline.
    expect(byId(tree, 'room-about-body').length).toBe(0);
    await ReactTestRenderer.act(async () => {
      byId(tree, 'room-about')[0].props.onPress();
    });
    const texts = tree.root
      .findAllByType(require('react-native').Text)
      .map(n =>
        Array.isArray(n.props.children)
          ? n.props.children.join('')
          : String(n.props.children ?? ''),
      )
      .join('\n');
    expect(texts).toContain('Only you will ever be able to add or remove');
    expect(texts).toContain('Anyone can leave whenever they like');
    // The sentence pair: hidden room, unhidden fan-out — with the
    // closing clause at full strength.
    expect(texts).toContain('hides its name, its member list');
    expect(texts).toContain('does not hide the sending');
    expect(texts).toContain('wants the member list gets it');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
