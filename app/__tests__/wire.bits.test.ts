import * as db from '../src/db';

/**
 * The two bits the server reads off a send frame.
 *
 * Both were broken in ways that cancelled each other out. `urgent` was written
 * to the outbox in V1 with a note saying the transport would read it in V2,
 * and V2 never did — so the server saw `urgent === undefined` on every frame
 * this app had ever sent, including call offers. That stayed invisible because
 * the push schedulers were separately dropping `kind`, which sent everything
 * down the VoIP branch by accident, so calls rang regardless. Fix one without
 * the other and calls stop ringing.
 *
 * `notify` is new. It tells the server a frame is transport rather than
 * conversation: queue and deliver it exactly as usual, but raise no
 * notification. Without it a read receipt banners the person who sent the
 * message as "New message" — the feature inverting itself.
 *
 * op-sqlite is mocked in this suite, so these assert on the SQL and the bound
 * parameters, the same way the other migration tests do.
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

function callsMatching(re: RegExp, name = 'tacendum.sqlite') {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).filter(c =>
    re.test(String(c[0])),
  );
}

const PEER = '01JBQ0000000000000000PEER0';
const MSG = '01JBQ0000000000000000MSG01';

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
  await db.initDb();
});

async function enqueue(envelope: Parameters<typeof db.enqueueOutgoing>[1]) {
  await db.enqueueOutgoing(
    {
      msgId: MSG,
      peerId: PEER,
      direction: 'out',
      body: 'body',
      ts: 1_700_000_000_000,
      status: 'pending',
      expiresAt: null,
    },
    envelope,
  );
  const insert = callsMatching(/INSERT OR IGNORE INTO outbox/)[0];
  return insert?.[1] as unknown[];
}

describe('the outbox carries both bits', () => {
  it('migrates a notify column that defaults to notifying', async () => {
    // DEFAULT 1, not 0. Rows written before this column existed, and any
    // caller that says nothing, must keep today's behaviour rather than
    // silently going quiet.
    const added = callsMatching(/ALTER TABLE outbox ADD COLUMN notify/);

    expect(added).toHaveLength(1);
    expect(String(added[0]?.[0])).toContain('NOT NULL DEFAULT 1');
  });

  it('reads notify back out — a column nothing selects is a column nothing uses', async () => {
    // `urgent` spent a whole phase being written and never read. The select
    // list is the difference between persisting a bit and having one.
    await db.listOutbox();

    const select = callsMatching(/SELECT[\s\S]*FROM outbox/)[0];
    expect(String(select?.[0])).toContain('urgent');
    expect(String(select?.[0])).toContain('notify');
  });

  it('binds notify=1 for an ordinary message', async () => {
    const params = await enqueue({ msgType: 'ciphertext', payload: 'QUJD' });

    // Column order: msgId, peerId, msgType, payload, priority, urgent, notify.
    expect(params?.[5]).toBe(0); // urgent
    expect(params?.[6]).toBe(1); // notify
  });

  it('binds notify=0 for a carrier', async () => {
    const params = await enqueue({
      msgType: 'ciphertext',
      payload: 'QUJD',
      notify: false,
    });

    expect(params?.[6]).toBe(0);
  });

  it('keeps urgent and notify independent — a call offer is both', async () => {
    // A call must RING (urgent) and must not BANNER (notify false). They are
    // separate columns and separate wire fields; conflating them is how a call
    // becomes a notification, or a notification becomes a ring.
    const params = await enqueue({
      msgType: 'ciphertext',
      payload: 'QUJD',
      urgent: true,
      notify: false,
    });

    expect(params?.[5]).toBe(1);
    expect(params?.[6]).toBe(0);
  });

  it('has as many placeholders as bound values', async () => {
    // Adding a column to the list and forgetting the `?` is a runtime error
    // inside a transaction, on the send path, which the caller sees as a
    // message that will not leave the device.
    await enqueue({ msgType: 'ciphertext', payload: 'QUJD' });
    const insert = callsMatching(/INSERT OR IGNORE INTO outbox/)[0];
    const sql = String(insert?.[0]);
    const values = sql.slice(sql.indexOf('VALUES'));

    const placeholders = (values.match(/\?/g) ?? []).length;
    const literals = (values.match(/,\s*0\s*,/g) ?? []).length;
    expect(placeholders + literals).toBe((insert?.[1] as unknown[]).length + 1);
  });
});
