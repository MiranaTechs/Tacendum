/**
 * Saved AI requests exercise the real app SQL against isolated in-memory
 * SQLite engines. No application database file or relay is opened.
 */
import * as db from '../src/db';
import {
  AI_SAVED_TASK_MAX,
  AI_TASK_NAME_MAX,
  AI_TASK_PROMPT_MAX,
} from '../src/aiTasks';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => Engine;
};

interface FakeDb {
  execute: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (options: { name: string }) => FakeDb;
  __sqlite: { reset: () => void };
};

const PEER = '01JREQUESTPEER000000000001';
const OTHER = '01JREQUESTPEER000000000002';
const NOW = 1_800_000_000_000;

const engines: Engine[] = [];
let interleaveInsert = false;
let realEngine: Engine;

function templateCount(engine: Engine, peerId?: string): number {
  const rows = peerId
    ? engine
        .prepare('SELECT COUNT(*) AS c FROM ai_task_templates WHERE peerId = ?')
        .all(peerId)
    : engine.prepare('SELECT COUNT(*) AS c FROM ai_task_templates').all();
  return rows[0]!.c as number;
}

function bindEngine(name: string): Engine {
  const engine = new DatabaseSync(':memory:');
  engines.push(engine);
  const instance = sqlite.open({ name });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const args = (params ?? []).map(value => (value === undefined ? null : value));
    const rows = engine.prepare(String(sql)).all(...args);
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
    const insertId = engine
      .prepare('SELECT last_insert_rowid() AS id')
      .all()[0]!.id as number;
    if (interleaveInsert && /INSERT INTO ai_task_templates/.test(String(sql))) {
      engine.prepare("INSERT INTO insert_noise (value) VALUES ('interleaved')").all();
    }
    return { rows, rowsAffected: changes, insertId };
  });
  return engine;
}

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  engines.length = 0;
  interleaveInsert = false;
  const engine = bindEngine('tacendum.sqlite');
  realEngine = engine;
  await db.initDb();
  engine.prepare(
    'CREATE TABLE insert_noise (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)',
  ).all();
  engine.prepare("INSERT INTO insert_noise (value) VALUES ('one'), ('two')").all();
  await db.upsertChat(PEER, 'Codex');
  await db.upsertChat(OTHER, 'Claude');
});

afterEach(async () => {
  await db.close();
  for (const engine of engines) engine.close();
});

test('creates, orders, updates and deletes only the matching peer saved request', async () => {
  const first = await db.createAiTaskTemplate(
    PEER,
    '  Release review  ',
    '  Review the release evidence.  ',
    NOW,
  );
  const second = await db.createAiTaskTemplate(
    PEER,
    'Check privacy',
    'Inspect privacy boundaries.',
    NOW + 1,
  );
  const other = await db.createAiTaskTemplate(
    OTHER,
    'Other agent',
    'Review another project.',
    NOW + 2,
  );

  expect(first).toMatchObject({
    id: expect.any(Number),
    peerId: PEER,
    name: 'Release review',
    prompt: 'Review the release evidence.',
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(second).not.toBeNull();
  expect(other).not.toBeNull();
  await expect(db.listAiTaskTemplates(PEER)).resolves.toMatchObject([
    { id: second!.id, name: 'Check privacy' },
    { id: first!.id, name: 'Release review' },
  ]);

  await expect(
    db.updateAiTaskTemplate(
      OTHER,
      first!.id,
      'Wrong owner',
      'Must not update.',
      NOW + 3,
    ),
  ).resolves.toBe(false);
  await expect(
    db.updateAiTaskTemplate(PEER, first!.id, ' ', 'Must not replace.', NOW + 3),
  ).resolves.toBe(false);
  await expect(db.listAiTaskTemplates(PEER)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: first!.id,
        name: 'Release review',
        prompt: 'Review the release evidence.',
      }),
    ]),
  );
  await expect(
    db.updateAiTaskTemplate(
      PEER,
      first!.id,
      'Final review',
      'Review the final evidence.',
      NOW + 3,
    ),
  ).resolves.toBe(true);
  await expect(db.listAiTaskTemplates(PEER)).resolves.toMatchObject([
    {
      id: first!.id,
      name: 'Final review',
      prompt: 'Review the final evidence.',
      createdAt: NOW,
      updatedAt: NOW + 3,
    },
    { id: second!.id, name: 'Check privacy' },
  ]);

  await expect(db.deleteAiTaskTemplate(OTHER, first!.id)).resolves.toBe(false);
  await expect(db.deleteAiTaskTemplate(PEER, first!.id)).resolves.toBe(true);
  await expect(db.listAiTaskTemplates(PEER)).resolves.toMatchObject([
    { id: second!.id, name: 'Check privacy' },
  ]);
});

test('uses the insert result id even when another handle write interleaves', async () => {
  interleaveInsert = true;
  const created = await db.createAiTaskTemplate(
    PEER,
    'Race-safe id',
    'Review the insertion result.',
    NOW,
  );
  interleaveInsert = false;

  const listed = await db.listAiTaskTemplates(PEER);
  expect(created?.id).toBe(listed[0]?.id);
  expect(created?.id).toBe(1);
});

test('rejects malformed input and transactionally caps concurrent creates at twelve', async () => {
  await expect(
    db.createAiTaskTemplate(PEER, ' ', 'Prompt', NOW),
  ).resolves.toBeNull();
  await expect(
    db.createAiTaskTemplate(PEER, 'Name', '\n', NOW),
  ).resolves.toBeNull();
  await expect(
    db.createAiTaskTemplate(
      PEER,
      'n'.repeat(AI_TASK_NAME_MAX + 1),
      'Prompt',
      NOW,
    ),
  ).resolves.toBeNull();
  await expect(
    db.createAiTaskTemplate(
      PEER,
      'Name',
      'p'.repeat(AI_TASK_PROMPT_MAX + 1),
      NOW,
    ),
  ).resolves.toBeNull();
  await expect(
    db.createAiTaskTemplate('missing-peer', 'Name', 'Prompt', NOW),
  ).resolves.toBeNull();

  const created = await Promise.all(
    Array.from({ length: AI_SAVED_TASK_MAX + 1 }, (_, index) =>
      db.createAiTaskTemplate(
        PEER,
        `Request ${index + 1}`,
        `Review item ${index + 1}.`,
        NOW,
      ),
    ),
  );
  expect(created.filter(row => row !== null)).toHaveLength(AI_SAVED_TASK_MAX);
  expect(created.filter(row => row === null)).toHaveLength(1);
  const listed = await db.listAiTaskTemplates(PEER);
  expect(listed).toHaveLength(AI_SAVED_TASK_MAX);
  expect(listed.map(row => row.id)).toEqual(
    [...listed.map(row => row.id)].sort((a, b) => b - a),
  );
  await expect(
    db.createAiTaskTemplate(
      OTHER,
      'Independent quota',
      'Review this other agent.',
      NOW,
    ),
  ).resolves.toMatchObject({ peerId: OTHER });
});

test('delete, block, revoke and local wipe physically purge saved requests', async () => {
  await db.createAiTaskTemplate(PEER, 'Delete me', 'Review deletion.', NOW);
  await db.createAiTaskTemplate(OTHER, 'Keep me', 'Review the other agent.', NOW);
  await db.deleteChat(PEER);
  expect(templateCount(realEngine, PEER)).toBe(0);
  expect(templateCount(realEngine, OTHER)).toBe(1);

  await db.upsertChat(PEER, 'Codex again');
  await db.createAiTaskTemplate(PEER, 'Block me', 'Review blocking.', NOW + 1);
  await db.blockPeer(PEER, NOW + 2);
  expect(templateCount(realEngine, PEER)).toBe(0);
  await expect(
    db.createAiTaskTemplate(PEER, 'Too late', 'Do not restore this.', NOW + 3),
  ).resolves.toBeNull();

  await db.unblockPeer(PEER);
  await db.createAiTaskTemplate(PEER, 'Revoke me', 'Review revocation.', NOW + 4);
  await db.recordMachineRevoked(PEER, NOW + 5);
  expect(templateCount(realEngine, PEER)).toBe(0);
  await expect(
    db.createAiTaskTemplate(PEER, 'Too late', 'Do not restore this.', NOW + 6),
  ).resolves.toBeNull();

  await db.clearLocalState();
  expect(templateCount(realEngine)).toBe(0);
});

test('a create queued behind conversation deletion cannot restore saved text', async () => {
  const deleting = db.deleteChat(PEER);
  const staleSave = db.createAiTaskTemplate(
    PEER,
    'Retired request',
    'This text must not survive deletion.',
    NOW,
  );

  await deleting;
  await expect(staleSave).resolves.toBeNull();
  expect(templateCount(realEngine, PEER)).toBe(0);
});

test('keeps the real and decoy workspace saved requests isolated', async () => {
  await db.createAiTaskTemplate(
    PEER,
    'Real request',
    'Only the real workspace may read this.',
    NOW,
  );
  expect(templateCount(realEngine, PEER)).toBe(1);

  await db.close();
  db.setWorkspace('decoy');
  const decoyEngine = bindEngine('tacendum-decoy.sqlite');
  await db.initDb();
  await db.upsertChat(PEER, 'Decoy Codex');
  await expect(db.listAiTaskTemplates(PEER)).resolves.toEqual([]);
  await db.createAiTaskTemplate(
    PEER,
    'Decoy request',
    'Only the decoy workspace may read this.',
    NOW,
  );

  expect(templateCount(realEngine, PEER)).toBe(1);
  expect(templateCount(decoyEngine, PEER)).toBe(1);
  await expect(db.listAiTaskTemplates(PEER)).resolves.toMatchObject([
    { name: 'Decoy request' },
  ]);
});
