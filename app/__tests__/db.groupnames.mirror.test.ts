import * as crypto from 'tacendum-crypto';
import * as db from '../src/db';
import { GROUP_NAMES_FILE } from '../src/nse';
import { armedMarker, PREVIEWS_ARMED_FILE } from '../src/previews';
import { session } from '../src/session';

/**
 * The room-names mirror FOLLOWS THE DATABASE FROM db.ts, its own writer
 * — `setLocalName`'s reasoning: a mirror callers must
 * remember is a mirror one of them forgets, and the cost of forgetting here
 * is a room banner that misattributes itself as a 1:1, or keeps a deleted
 * room's name alive on the lock screen. This file pins every moment the
 * mirror's inputs change — boot, a room appearing, a room deleted, a rename —
 * end to end into the shared-state file the extension reads.
 */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;

const REAL = 'tacendum.sqlite';
const ROOM = '01ROOMZ3NDEKTSV4RRFFQ69G5A';

/** What the chats table currently answers for the mirror's SELECT. Mutable so
 * a test can move the database's truth and then poke the hook. */
let groupRows: { peerId: string; groupName: string | null; localName: string | null }[] = [];

/** Materialise the REAL instance with a model that serves the names SELECT
 * from `groupRows` and keeps the PRAGMA answers initDb's rebuild loop needs. */
function installModel(): FakeDb {
  const instance = (
    jest.requireMock('@op-engineering/op-sqlite') as {
      open: (o: { name: string }) => FakeDb;
    }
  ).open({ name: REAL });
  instance.execute.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes('PRAGMA table_info(attachments')) {
      return { rows: [{ name: 'direction' }] };
    }
    if (s.includes('PRAGMA table_info(reactions')) {
      return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
    }
    if (s.includes('PRAGMA table_info(pending_revisions')) {
      return { rows: [{ name: 'writerId' }] };
    }
    if (s.includes(`kind = 'group'`)) {
      return { rows: groupRows.map(r => ({ ...r })) };
    }
    return { rows: [] };
  });
  return instance;
}

/** Bounded condition wait — never a bare clock sleep. */
async function eventually(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
}

/** Settle every in-flight fire-and-forget, for NEGATIVE assertions. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
}

function mirror(): Record<string, string> | null {
  const raw = shared.get(GROUP_NAMES_FILE);
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, string>);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  shared.clear();
  groupRows = [];
  session.setMode('real');
  // The state db.ts publishes into: a real session whose previews lease is
  // live — App.tsx arms it, awaited, before it opens the workspace.
  shared.set(PREVIEWS_ARMED_FILE, armedMarker(Date.now()));
  db.setWorkspace('real');
  installModel();
});

afterEach(async () => {
  await db.close();
  await settle();
  session.setMode('real');
});

it('initDb rebuilds the mirror a relock retracted — with localName outranking the wire name', async () => {
  groupRows = [
    // A rename: the name I gave the room outranks the creator's.
    { peerId: ROOM, groupName: 'Kitchen', localName: ' The good kitchen ' },
    // Never renamed: the creator's name stands.
    { peerId: '01ROOMTWOAAAAAAAAAAAAAAAAA', groupName: 'Choir', localName: null },
    // No resolvable name: dropped, so the extension shows the generic body.
    { peerId: '01ROOMTHREEAAAAAAAAAAAAAAA', groupName: null, localName: '   ' },
  ];

  await db.initDb();

  await eventually(() => mirror() !== null);
  expect(mirror()).toEqual({
    [ROOM]: 'The good kitchen',
    '01ROOMTWOAAAAAAAAAAAAAAAAA': 'Choir',
  });
});

it("the publisher asks for ROOMS — the SELECT carries kind = 'group', not a bare chats scan", async () => {
  await db.initDb();
  await eventually(() => mirror() !== null);

  const named = (sqlite.instances.get(REAL)?.execute.mock.calls ?? [])
    .map(c => String(c[0]))
    .filter(s => s.includes('groupName') && s.includes('SELECT'));
  expect(named.length).toBeGreaterThan(0);
  for (const s of named) {
    expect(s).toContain(`WHERE kind = 'group'`);
  }
});

it('deleteGroup republishes — the deleted room leaves the file, whole-rewrite, not append', async () => {
  groupRows = [{ peerId: ROOM, groupName: 'Kitchen', localName: null }];
  await db.initDb();
  await eventually(() => mirror() !== null && ROOM in mirror()!);

  // The database's truth moves first (deleteGroup's own transaction), then
  // the mirror follows it.
  groupRows = [];
  await db.deleteGroup(ROOM, { purgeState: true });

  await eventually(() => mirror() !== null && !(ROOM in mirror()!));
  expect(mirror()).toEqual({});
});

it('setLocalName republishes — a room renamed for myself retitles its next banner', async () => {
  groupRows = [{ peerId: ROOM, groupName: 'Kitchen', localName: null }];
  await db.initDb();
  await eventually(() => mirror()?.[ROOM] === 'Kitchen');

  groupRows = [{ peerId: ROOM, groupName: 'Kitchen', localName: 'Casa' }];
  await db.setLocalName(ROOM, 'Casa');

  await eventually(() => mirror()?.[ROOM] === 'Casa');
  expect(mirror()).toEqual({ [ROOM]: 'Casa' });
});

it('a room APPEARING through the slot store republishes; slot-only writes do not', async () => {
  await db.initDb();
  await eventually(() => mirror() !== null);

  // Slot-only: who is in a room changes, what it is called does not. The
  // mirror must NOT be rewritten — precondition-first: erase it, so a
  // rewrite of any kind is visible.
  const slotOnly = await db.loadGroupStore(ROOM);
  slotOnly.putSlot({ memberId: ROOM, writerId: ROOM, seq: 1, state: 'in' });
  shared.delete(GROUP_NAMES_FILE);
  await slotOnly.persist();
  await settle();
  expect(shared.has(GROUP_NAMES_FILE)).toBe(false);

  // Presence: the room now exists as a chat, and its name must reach the
  // extension before its first banner does.
  groupRows = [{ peerId: ROOM, groupName: 'Kitchen', localName: null }];
  const appearing = await db.loadGroupStore(ROOM);
  appearing.setPresent(true);
  await appearing.persist();

  await eventually(() => mirror()?.[ROOM] === 'Kitchen');
  expect(mirror()).toEqual({ [ROOM]: 'Kitchen' });
});
