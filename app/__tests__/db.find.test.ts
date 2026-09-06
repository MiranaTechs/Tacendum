import * as db from '../src/db';

// The house idiom for reading a source file from a test (App.scrim.test.ts,
// AiDisclosure.test.ts): a typed `require`, because app/ carries no @types/node.
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};

/**
 * Find in this conversation — the SQL half.
 *
 * WHAT THIS FILE MAY AND MAY NOT ASSERT. jest.setup.js mocks op-sqlite with a
 * recorder that returns empty rows WITHOUT EXECUTING anything, so no assertion
 * here can say which rows a LIKE matches. This file pins the emitted statement
 * and its bound parameters. Actual escaping and exclusion of retracted rows
 * require separate verification against a real SQLite engine.
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

function calls() {
  return sqlite.instances.get(REAL)?.execute.mock.calls ?? [];
}
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

describe('findMessages — the statement', () => {
  it('reads named columns, excludes retracted rows, and takes a bound limit', async () => {
    await db.initDb();
    const later = since();
    await db.findMessages(PEER, 'note', 50);
    const written = later();
    expect(written).toHaveLength(1);
    const [sql, params] = written[0];
    expect(sql).not.toMatch(/SELECT \*/);
    for (const column of [
      'msgId',
      'peerId',
      'direction',
      'body',
      'ts',
      'status',
      'editedAt',
      'deletedAt',
      'expiresAt',
      'authorId',
      'sq',
      'outsider',
      'sharedBy',
      'ai',
      'arrivedAt',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    // A retracted row keeps its place in the thread with an empty body; it is
    // not something to find.
    expect(sql).toMatch(/deletedAt IS NULL/);
    expect(sql).toMatch(/ORDER BY ts DESC, msgId DESC/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(params?.[params.length - 1]).toBe(50);
  });

  it('binds TWO patterns, because SQLite LIKE folds ASCII only', async () => {
    await db.initDb();
    const later = since();
    await db.findMessages(PEER, 'NOTE', 50);
    const [sql, params] = later()[0];
    const likes = sql.match(/LIKE \? ESCAPE/g) ?? [];
    expect(likes).toHaveLength(2);
    // As typed, then locale-lowercased: the JS refinement is the authority on
    // case, and the second pattern is what keeps the prefilter from throwing
    // away rows that refinement would have kept.
    expect(params).toContain('%NOTE%');
    expect(params).toContain('%note%');
  });

  it('escapes the wildcards and the escape character itself', async () => {
    await db.initDb();
    const later = since();
    await db.findMessages(PEER, '50%_off~', 50);
    const [sql, params] = later()[0];
    const escape = /ESCAPE '(.)'/.exec(sql)?.[1];
    expect(escape).toBeTruthy();
    const patterns = (params as unknown[]).filter(
      p => typeof p === 'string' && p.startsWith('%') && p.endsWith('%'),
    );
    expect(patterns).toHaveLength(2);
    for (const p of patterns) {
      // Every wildcard the person typed is neutralised, and so is the escape
      // character — otherwise a body containing it would silently change what
      // the next character means.
      expect(p).toBe(`%50${escape}%${escape}_off${escape}${escape}%`);
    }
  });

  it('drops the peer clause when the caller passes null', async () => {
    await db.initDb();
    const later = since();
    await db.findMessages(null, 'note', 20);
    const [sql, params] = later()[0];
    // One statement for both callers: the cross-conversation reader is not
    // built this release, but the signature and the SQL are.
    expect(sql).toMatch(/\(peerId = \? OR \? IS NULL\)/);
    expect((params as unknown[])[0]).toBeNull();
    expect((params as unknown[])[1]).toBeNull();
  });

  it('binds a POSITIVE INTEGER limit, whatever the caller passed', async () => {
    await db.initDb();
    // In SQLite a NEGATIVE limit means NO LIMIT, and a non-integer is
    // coerced. The rows this statement returns are raw bodies, and an image
    // or file body is JSON carrying base64 - so a caller's NaN parse, -1
    // sentinel or off-by-one would turn a capped prefilter into a read of
    // every envelope on the phone, on every keystroke. The clamp is here
    // rather than in the caller because the caller is the thing that can be
    // wrong.
    const bound = async (limit: number) => {
      const later = since();
      await db.findMessages(PEER, 'note', limit);
      const params = later()[0][1] as unknown[];
      return params[params.length - 1];
    };
    expect(await bound(-1)).toBe(1);
    expect(await bound(0)).toBe(1);
    expect(await bound(12.7)).toBe(12);
    expect(await bound(Number.NaN)).toBe(1);
    // And a ceiling, so no caller can ask for the whole table either.
    expect(await bound(100000)).toBe(200);
    expect(await bound(Number.POSITIVE_INFINITY)).toBe(200);
    // The ordinary case is untouched.
    expect(await bound(50)).toBe(50);
  });

  it('maps an empty answer to an empty list', async () => {
    await db.initDb();
    await expect(db.findMessages(PEER, 'note', 50)).resolves.toEqual([]);
  });
});

describe('findMessages — the contract written beside it', () => {
  it('says in the source that the SQL is a prefilter, and names the residual', () => {
    // Not decoration. A body is sometimes an envelope, so a three-letter
    // query LIKE-matches inside base64 key material; a caller that trusts
    // this function's rows as final would show a person a "match" that is a
    // fragment of a photo. The doc comment is where that is stated, and a
    // move that drops it drops the reason.
    const src = readFileSync(`${__dirname}/../src/db.ts`, 'utf8');
    const at = src.indexOf('export async function findMessages');
    expect(at).toBeGreaterThan(0);
    const doc = src.slice(Math.max(0, at - 2500), at);
    expect(doc).toMatch(/PREFILTER|prefilter/);
    expect(doc).toMatch(/displayText/);
    // The documented residual: a non-ASCII case-only difference may miss.
    expect(doc).toMatch(/ASCII/);
  });
});
