import * as db from '../src/db';

/**
 * "Delete" that leaves every call behind.
 *
 * `deleteChat` purged reactions, attachments, outbox, drafts, held revisions,
 * vault items, messages and the chats row — and never `call_log`. Because
 * CallsScreen resolves names from `listChats`, the now-chatless person
 * degraded to a bare id fragment and stayed one tap from redial, under a
 * confirmation that says Tacendum has no copy to restore.
 *
 * WHAT THIS FILE MAY AND MAY NOT ASSERT. jest.setup.js mocks op-sqlite with a
 * recorder that RETURNS EMPTY ROWS WITHOUT EXECUTING ANYTHING, so no assertion
 * here can say which rows a DELETE reached. This file pins the emitted
 * statement and its bound parameters. Which rows survive requires separate
 * verification against a real SQLite engine.
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

const REAL = 'tacendum.sqlite';
const PEER = '01PEER0000000000000000000A';
const ROOM = '01ROOM0000000000000000000B';

function calls() {
  return sqlite.instances.get(REAL)?.execute.mock.calls ?? [];
}
function statements(): string[] {
  return calls().map(c => String(c[0]));
}
/** Statements (and their params) issued since a marked point. */
function since(): () => [string, unknown[] | undefined][] {
  const at = calls().length;
  return () =>
    calls()
      .slice(at)
      .map(c => [String(c[0]), c[1] as unknown[] | undefined]);
}

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
});

describe('deleteChat takes the 1:1 calls with it', () => {
  it('purges call_log for that peer, scoped away from the room legs', async () => {
    await db.initDb();
    const later = since();
    await db.deleteChat(PEER);
    const purge = later().filter(([sql]) => /DELETE FROM call_log/.test(sql));
    expect(purge).toHaveLength(1);
    expect(purge[0][0]).toMatch(/peerId = \?/);
    // The same scoping the outbox delete three lines above already makes: a
    // fan-out leg is queued against a MEMBER id, and a room call leg is
    // written against the member's id too, so an unscoped purge would take
    // the room's call history with a 1:1 delete. A room's calls belong to
    // the room and die with it (deleteGroup).
    expect(purge[0][0]).toMatch(/roomId IS NULL/);
    expect(purge[0][1]).toEqual([PEER]);
  });

  it('purges inside the same transaction, before the chats row', async () => {
    await db.initDb();
    const later = since();
    await db.deleteChat(PEER);
    const sql = later().map(([s]) => s);
    const beginAt = sql.indexOf('BEGIN IMMEDIATE');
    const callsAt = sql.findIndex(s => /DELETE FROM call_log/.test(s));
    const chatsAt = sql.findIndex(s => /DELETE FROM chats/.test(s));
    const commitAt = sql.indexOf('COMMIT');
    expect(beginAt).toBe(0);
    expect(callsAt).toBeGreaterThan(beginAt);
    expect(callsAt).toBeLessThan(chatsAt);
    expect(chatsAt).toBeLessThan(commitAt);
  });

  it('takes the always-relay row for that person too', async () => {
    await db.initDb();
    const later = since();
    await db.deleteChat(PEER);
    const purge = later().filter(([sql]) =>
      /DELETE FROM call_relay_prefs/.test(sql),
    );
    // The same residue the call_log hole was: one row naming the peer and
    // recording that this phone called them, left behind by the delete that
    // now claims to take the calls. It is a preference, not a protection -
    // and it cannot be one, because the row is gone in the same transaction
    // as the call_log rows that make hasCalledBefore true, so relayForPeer
    // falls back to its first-call default, which relays. Removing it can
    // only make the next call MORE careful, never less.
    expect(purge).toHaveLength(1);
    expect(purge[0][0]).toMatch(/peerId = \?/);
    expect(purge[0][1]).toEqual([PEER]);
  });

  it('names the call history and the relay row in its own doc comment', () => {
    // The doc comment is this function's contract, and the release advertises
    // exactly this behaviour. A summary that still lists only messages,
    // photos, vault items, the outbox and the draft is a contract that has
    // stopped describing the function.
    const { readFileSync } = require('fs') as {
      readFileSync: (path: string, encoding: string) => string;
    };
    const src = readFileSync(`${__dirname}/../src/db.ts`, 'utf8');
    const at = src.indexOf('export async function deleteChat');
    expect(at).toBeGreaterThan(0);
    const doc = src.slice(Math.max(0, at - 2600), at);
    expect(doc).toMatch(/call history/);
    expect(doc).toMatch(/call_relay_prefs/);
    // And it still says what it deliberately KEEPS, with the reason.
    expect(doc).toMatch(/blocked_peers/);
  });

  it('never names call_sessions — a 1:1 has no room roster to wipe', async () => {
    await db.initDb();
    const later = since();
    await db.deleteChat(PEER);
    expect(later().filter(([s]) => s.includes('call_sessions'))).toEqual([]);
  });
});

describe('deleteGroup takes the room calls and the room roster with it', () => {
  it('purges call_log and call_sessions for the room, in the default form', async () => {
    await db.initDb();
    const later = since();
    // The DEFAULT form — a local delete, not the counted grp.del. Calls are
    // conversation, so they go with the conversation in both forms.
    await db.deleteGroup(ROOM);
    const log = later().filter(([s]) => /DELETE FROM call_log/.test(s));
    const sessions = later().filter(([s]) =>
      /DELETE FROM call_sessions/.test(s),
    );
    expect(log).toHaveLength(1);
    expect(log[0][0]).toMatch(/roomId = \?/);
    expect(log[0][1]).toEqual([ROOM]);
    // db.ts's own comment above call_sessions: a missing wipe hands a coerced
    // unlock the membership the decoy exists to hide.
    expect(sessions).toHaveLength(1);
    expect(sessions[0][0]).toMatch(/roomId = \?/);
    expect(sessions[0][1]).toEqual([ROOM]);
  });

  it('purges them inside the transaction, before the chats row', async () => {
    await db.initDb();
    const later = since();
    await db.deleteGroup(ROOM, { purgeState: true });
    const sql = later().map(([s]) => s);
    const beginAt = sql.indexOf('BEGIN IMMEDIATE');
    const logAt = sql.findIndex(s => /DELETE FROM call_log/.test(s));
    const sessionsAt = sql.findIndex(s => /DELETE FROM call_sessions/.test(s));
    const chatsAt = sql.findIndex(s => /DELETE FROM chats/.test(s));
    expect(beginAt).toBe(0);
    expect(logAt).toBeGreaterThan(beginAt);
    expect(sessionsAt).toBeGreaterThan(beginAt);
    expect(logAt).toBeLessThan(chatsAt);
    expect(sessionsAt).toBeLessThan(chatsAt);
    expect(sql.indexOf('COMMIT')).toBeGreaterThan(chatsAt);
  });

  it('leaves the relay prefs alone — a choice about a PERSON is not the room’s', async () => {
    await db.initDb();
    const later = since();
    await db.deleteGroup(ROOM);
    // call_relay_prefs is keyed by peerId and a room id never appears in it.
    // Deleting a room must not reach a member's own always-relay choice, any
    // more than it reaches a block made inside it.
    expect(later().filter(([s]) => s.includes('call_relay_prefs'))).toEqual([]);
  });

  it('leaves the block list alone, exactly as the rest of the purge does', async () => {
    await db.initDb();
    const later = since();
    await db.deleteGroup(ROOM);
    expect(later().filter(([s]) => s.includes('blocked_peers'))).toEqual([]);
  });
});

describe('the whole-account wipe still names both tables', () => {
  it('sign-out clears call_log and call_sessions', async () => {
    await db.initDb();
    await db.clearLocalState();
    const wiped = statements().filter(s => s.startsWith('DELETE FROM'));
    expect(wiped).toContain('DELETE FROM call_log');
    expect(wiped).toContain('DELETE FROM call_sessions');
  });
});
