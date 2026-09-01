import * as crypto from 'tacendum-crypto';
import * as db from '../src/db';
import { PEER_NAMES_FILE } from '../src/nse';
import { armedMarker, PREVIEWS_ARMED_FILE } from '../src/previews';
import { session } from '../src/session';

/**
 * The PEER-names mirror follows the database from db.ts on the group
 * mirror's exact reasoning (db.groupnames.mirror.test.ts): a mirror callers
 * must remember is a mirror one of them forgets. This file pins the two
 * moments db.ts itself must republish — a rename, and Delete conversation —
 * and the boundary that keeps room names OUT of the peer file: rooms are
 * chats rows too, and a bare listChats scan used to write a renamed room's
 * name into the lease-ungated peer file.
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
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5A';
const OTHER = '01PEERTWOAAAAAAAAAAAAAAAAA';

/** What the chats table currently answers for the peer mirror's SELECT. */
let peerRows: {
  peerId: string;
  displayName: string | null;
  localName: string | null;
}[] = [];

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
    if (s.includes(`COALESCE(kind, 'peer') = 'peer'`) && s.includes('displayName')) {
      return { rows: peerRows.map(r => ({ ...r })) };
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
  const raw = shared.get(PEER_NAMES_FILE);
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, string>);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  shared.clear();
  peerRows = [];
  session.setMode('real');
  shared.set(PREVIEWS_ARMED_FILE, armedMarker(Date.now()));
  db.setWorkspace('real');
  installModel();
});

afterEach(async () => {
  await db.close();
  await settle();
  session.setMode('real');
});

it('setLocalName republishes with personName precedence, dropping the nameless', async () => {
  await db.initDb();
  peerRows = [
    // My label outranks their card.
    { peerId: PEER, displayName: 'Helen R.', localName: ' Mum ' },
    // No name anywhere: absent from the file, so the ring keeps its
    // placeholder rather than showing a ULID.
    { peerId: OTHER, displayName: null, localName: '   ' },
  ];

  await db.setLocalName(PEER, 'Mum');

  await eventually(() => mirror()?.[PEER] === 'Mum');
  expect(mirror()).toEqual({ [PEER]: 'Mum' });
});

it('deleteChat republishes — the deleted contact leaves the file', async () => {
  // FALSIFYING CASE, run at authoring time: remove the republish from
  // deleteChat. The name then lingers in the shared container and a
  // straggler VoIP push greets the owner with a contact this phone
  // deliberately no longer holds.
  await db.initDb();
  peerRows = [{ peerId: PEER, displayName: 'Ayana', localName: null }];
  await db.setLocalName(PEER, null);
  await eventually(() => mirror()?.[PEER] === 'Ayana');

  // The database's truth moves first (deleteChat's own transaction), then
  // the mirror follows it.
  peerRows = [];
  await db.deleteChat(PEER);

  await eventually(() => mirror() !== null && !(PEER in mirror()!));
  expect(mirror()).toEqual({});
});

it("the publisher asks for PEOPLE — kind-filtered, never a bare chats scan", async () => {
  // The regression this pins: both peer publishers used to map listChats
  // whole, so a renamed ROOM's name landed in the peer file — the same
  // disclosure class as a contact, minus the group mirror's gates.
  await db.initDb();
  peerRows = [{ peerId: PEER, displayName: 'Ayana', localName: null }];
  await db.setLocalName(PEER, null);
  await eventually(() => mirror() !== null);

  // The name-publisher SELECT and nothing else: `getChat`'s full column list
  // carries lastMessageAt, the group publisher's carries groupName — both
  // excluded, so this matches exactly `listPeerNames`.
  const selects = (sqlite.instances.get(REAL)?.execute.mock.calls ?? [])
    .map(c => String(c[0]))
    .filter(
      s =>
        s.includes('SELECT') &&
        s.includes('displayName') &&
        s.includes('localName') &&
        !s.includes('lastMessageAt') &&
        !s.includes('groupName'),
    );
  expect(selects.length).toBeGreaterThan(0);
  for (const s of selects) {
    expect(s).toContain(`COALESCE(kind, 'peer') = 'peer'`);
  }
});

it('a mirror that cannot be written does not fail the delete', async () => {
  await db.initDb();
  peerRows = [{ peerId: PEER, displayName: 'Ayana', localName: null }];
  // Once, not permanently: clearAllMocks clears calls but keeps
  // implementations, so a standing rejection would poison any test appended
  // after this one.
  (crypto.writeSharedState as jest.Mock).mockRejectedValueOnce(
    new Error('container unavailable'),
  );

  await expect(db.deleteChat(PEER)).resolves.toBeUndefined();
});
