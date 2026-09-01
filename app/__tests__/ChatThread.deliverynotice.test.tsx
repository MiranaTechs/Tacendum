/**
 * The room thread's honest failure line (a device-retest
 * defect): a room fan-out with failed legs settled honestly in
 * the ledger — and no reachable surface rendered it. `groupDeliveryNotice`
 * was exported and test-pinned but imported by zero screens, and
 * `aggregateFanoutStatus` folds 1-failed-of-4 to 'sent', so the sender saw a
 * plain check while a member silently missed the message.
 *
 * What these pin:
 *  - a room out-bubble whose fan-out has failed legs renders the sentence
 *    ("Not delivered to N of M") as a quiet sub-line under the bubble;
 *  - an all-delivered room fan-out renders NOTHING extra;
 *  - a 1:1 thread is UNCHANGED — even if the batch query somehow answered,
 *    the notice is a room surface (1:1s carry their own delivery states);
 *  - duress shows nothing: a decoy send enqueues ZERO legs (pinned in
 *    messaging.groups.send m4), so the decoy ledger the screen reads is
 *    empty and the surface is indistinguishable from all-delivered.
 *
 * Harness copied from ChatThread.room.test.tsx.
 */

import type { RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { session } from '../src/session';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ANA = ulid('ANA'); // the owner
const BEN = ulid('BEN');
const ME = ulid('ME1');

const T0 = new Date('2026-07-25T12:00:00').getTime();

const NAME_ROWS = [
  { peerId: ANA, displayName: 'Ana', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
];

type Row = Record<string, unknown>;

const SLOT_ROWS: RosterSlot[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
];

/**
 * `failureRows` is what the ONE batched read (`listFanoutFailures`) answers —
 * rows only for fan-outs with at least one LEG_FAILED leg. `room` false makes
 * the thread a 1:1: no group anchor, and the peer is BEN.
 */
function installDb(
  messageRows: Row[],
  opts: { failureRows?: Row[]; room?: boolean; dbName?: string } = {},
) {
  const { failureRows = [], room = true, dbName = 'tacendum.sqlite' } = opts;
  const instance = sqlite.instances.get(dbName)!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      // The batch: distinctive by its GROUP BY over outbox legs.
      if (s.includes('FROM outbox') && s.includes('GROUP BY')) {
        return { rows: failureRows };
      }
      if (s.includes('FROM messages')) return { rows: messageRows };
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return room && params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return room && params?.[0] === ROOM ? { rows: SLOT_ROWS } : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: NAME_ROWS };
      }
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: ME },
            { key: 'registrationId', value: '7' },
          ],
        };
      }
      return base(sql, params);
    },
  );
}

async function renderThread(
  peerId: string,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={peerId}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
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

const noticeNodes = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n =>
    String(n.props?.testID ?? '').startsWith('fanout-notice-'),
  );

/** My own room message: a fan-out whose aggregate folded to a plain 'sent'. */
const OUT_ID = `${ME}.M9`;
const outRow = (peerId: string): Row => ({
  msgId: OUT_ID,
  peerId,
  direction: 'out',
  status: 'sent',
  deletedAt: null,
  body: 'movie night friday?',
  ts: T0,
  authorId: ME,
});

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  session.setMode('real');
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  session.setMode('real');
  await db.close();
  db.setWorkspace('real');
});

test('a room fan-out with a failed leg says so under the bubble — the exact sentence the ledger numbers make', async () => {
  installDb([outRow(ROOM)], {
    failureRows: [{ localMsgId: OUT_ID, failed: 1, total: 4 }],
  });
  const tree = await renderThread(ROOM);
  const notice = tree.root.findAllByProps({
    testID: `fanout-notice-${OUT_ID}`,
  });
  expect(notice.length).toBeGreaterThan(0);
  expect(renderedText(tree)).toContain('Not delivered to 1 of 4');
});

test('an all-delivered room fan-out shows nothing extra — the notice is null while nothing has failed', async () => {
  installDb([outRow(ROOM)], { failureRows: [] });
  const tree = await renderThread(ROOM);
  expect(noticeNodes(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain('Not delivered');
});

test('a 1:1 thread is unchanged — the notice is a ROOM surface even if the batch read answered', async () => {
  // Adversarial: hand the 1:1 the same failure row. 1:1s carry their own
  // delivery states (error bubble + "Not sent."), so the room sentence must
  // not appear — the gate is the room anchor, not the query's silence.
  installDb([outRow(BEN)], {
    room: false,
    failureRows: [{ localMsgId: OUT_ID, failed: 1, total: 4 }],
  });
  const tree = await renderThread(BEN);
  expect(noticeNodes(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain('Not delivered');
});

/** My own stance announcement: an EVENT row (grp.consent), not a bubble —
 * the row shape whose failed legs review found rendered
 * NOWHERE: the event-row branch early-returns before the bubble's notice
 * block, discarding the sentence renderItem had already computed. */
const EVENT_ID = `${ME}.MA`;
const consentEventRow = (): Row => ({
  msgId: EVENT_ID,
  peerId: ROOM,
  direction: 'out',
  status: 'sent',
  deletedAt: null,
  body: JSON.stringify({ tcm: 'grp.consent', g: ROOM, a: BEN, s: 'hold', n: 4 }),
  ts: T0,
  authorId: ME,
});

test('an ANNOUNCEMENT row with a failed leg says so too — the event-row branch renders the same honest sentence', async () => {
  // A human announcement leg failed (including an identity-skipped member):
  // the stance event row must show the durable ledger's honest numbers.
  installDb([consentEventRow()], {
    failureRows: [{ localMsgId: EVENT_ID, failed: 1, total: 2 }],
  });
  const tree = await renderThread(ROOM);
  expect(
    tree.root.findAllByProps({ testID: `fanout-notice-${EVENT_ID}` }).length,
  ).toBeGreaterThan(0);
  const text = renderedText(tree);
  expect(text).toContain('Not delivered to 1 of 2');
  // The event sentence itself still renders — the notice adds, never replaces.
  expect(text).toContain('You’re not sharing');
});

test('an all-delivered announcement row shows nothing extra — the event-row notice is null while nothing has failed', async () => {
  installDb([consentEventRow()], { failureRows: [] });
  const tree = await renderThread(ROOM);
  expect(noticeNodes(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain('Not delivered');
});

test('duress shows nothing: a decoy send has NO legs, so the decoy ledger answers empty and the surface cannot tell duress from all-delivered', async () => {
  // The design: a decoy room send is one localEcho row and zero outbox legs
  // (messaging.groups.send m4 pins the zero). The screen derives the notice
  // ONLY from the leg ledger, so the decoy workspace's answer is empty and
  // the bubble renders exactly as an all-delivered real one — no tell.
  await db.close();
  session.setMode('duress');
  db.setWorkspace('decoy');
  await db.initDb();
  installDb([outRow(ROOM)], {
    failureRows: [],
    dbName: 'tacendum-decoy.sqlite',
  });
  const tree = await renderThread(ROOM);
  expect(noticeNodes(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain('Not delivered');
});
