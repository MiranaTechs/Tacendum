import * as db from '../src/db';
import { encodeEnvelope, MAX_READ_IDS } from '../src/envelope';
import { messaging } from '../src/messaging';
import { setReadReceipts } from '../src/readReceipts';
import { session } from '../src/session';

/**
 * Read receipts (the filled second tick).
 *
 * `sent` and `delivered` are observations the SERVER makes anyway — it routed
 * the bytes. "Read" is different in kind: it reports on a person, saying they
 * picked up their phone, opened this conversation and looked. So it travels
 * peer-to-peer through the ratchet like a message, obeys every outbound gate a
 * message obeys, and can be switched off.
 *
 * These tests are mostly about the gates. The tick itself is cosmetic; the
 * ways a receipt can leak are not.
 */

const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const THEIRS = '01THEIRSZ3NDEKTSV4RRFFQ69G';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, { execute: jest.Mock }>; reset: () => void };
  }
).__sqlite;

function sqlFor(re: RegExp) {
  return (sqlite.instances.get('tacendum.sqlite')?.execute.mock.calls ?? []).filter(c =>
    re.test(String(c[0])),
  );
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  session.setMode('real');
  await setReadReceipts(true);
  jest.restoreAllMocks();
});

afterEach(async () => {
  await db.close();
  session.setMode('real');
});

describe('sending a read receipt', () => {
  function stubPending(ids: string[]) {
    jest.spyOn(db, 'unreadInboundIds').mockResolvedValue(ids);
  }

  it('sends one envelope naming the messages it read', async () => {
    stubPending([THEIRS]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![1]).toBe(encodeEnvelope({ tcm: 'read', ids: [THEIRS] }));
    // No preview: being told someone read you is not a new message, and a
    // preview line would reorder the chat list and look like traffic.
    expect(sent.mock.calls[0]![2]).toMatchObject({ preview: null });
    expect(marked).toHaveBeenCalledWith([THEIRS]);
  });

  it('sends NOTHING when the setting is off, and marks nothing', async () => {
    // Marking without sending would be worse than either: the receipt would
    // be withheld today and then silently never sent, even after the setting
    // came back on.
    await setReadReceipts(false);
    stubPending([THEIRS]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(sent).not.toHaveBeenCalled();
    expect(marked).not.toHaveBeenCalled();
  });

  it('sends nothing from a duress session', async () => {
    // A decoy must never confirm that the real person read anything.
    session.setMode('duress');
    stubPending([THEIRS]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(sent).not.toHaveBeenCalled();
  });

  it('leaves them unacknowledged when the send fails', async () => {
    // Otherwise a blocked or failed send would burn the flag and the receipt
    // would never be retried.
    stubPending([THEIRS]);
    jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockRejectedValue(new Error('blocked'));
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(marked).not.toHaveBeenCalled();
  });

  it('says nothing when there is nothing to acknowledge', async () => {
    stubPending([]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(sent).not.toHaveBeenCalled();
  });

  it('splits a long 1:1 backlog into MAX_READ_IDS envelopes, tail included', async () => {
    // The room gate sits directly above this loop, so the split is the first
    // behaviour a careless gate would break. One over the cap: the cap-sized
    // head and then a batch of one, each marked sent only after ITS envelope.
    const ids = Array.from({ length: MAX_READ_IDS + 1 }, (_, i) => `01MSG${i}`);
    stubPending(ids);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);

    await messaging.sendReadReceipt(PEER);

    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[0]![1]).toBe(
      encodeEnvelope({ tcm: 'read', ids: ids.slice(0, MAX_READ_IDS) }),
    );
    expect(sent.mock.calls[1]![1]).toBe(
      encodeEnvelope({ tcm: 'read', ids: ids.slice(MAX_READ_IDS) }),
    );
    expect(marked).toHaveBeenNthCalledWith(1, ids.slice(0, MAX_READ_IDS));
    expect(marked).toHaveBeenNthCalledWith(2, ids.slice(MAX_READ_IDS));
  });
});

describe('rooms send no read receipts', () => {
  // Each reader emitting N−1 receipts makes an active room O(N²) frames per
  // conversational round, and a receipt is addressed per-peer — so a room id
  // must never reach the addressing layer at all. Gated at the
  // SEAM, on the anchor's answer, exactly as both screens decide room-ness.
  const ROOM = '01R00MZ3NDEKTSV4RRFFQ69G5F';

  /** Answer the anchor query at the SQL layer, so the seam runs real db code
   * and the no-writes assertion below can speak about every statement. */
  function installAnchor(answer: 'room' | 'none') {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (String(sql).includes('SELECT groupId, ownerId, name FROM groups')) {
        return answer === 'room' && params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: PEER, name: 'Kitchen' }] }
          : { rows: [] };
      }
      return base(sql, params);
    });
  }

  function stubPending(ids: string[]) {
    jest.spyOn(db, 'unreadInboundIds').mockResolvedValue(ids);
  }

  it('a room read sends nothing and marks nothing — proved by the same fixture sending when the anchor says 1:1', async () => {
    stubPending([THEIRS]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);

    // THE PRECONDITION, asserted first so the fixture cannot pass vacuously:
    // with the anchor answering "not a room", this exact read sends.
    installAnchor('none');
    await messaging.sendReadReceipt(ROOM);
    expect(sent).toHaveBeenCalledTimes(1);
    sent.mockClear();
    marked.mockClear();

    // Now the ONLY change is the anchor's answer.
    installAnchor('room');
    await messaging.sendReadReceipt(ROOM);

    expect(sent).not.toHaveBeenCalled();
    // Left unmarked ON PURPOSE: `readSent` is "a receipt for this went out",
    // and none did. Burning the flag here would be lying to ourselves.
    expect(marked).not.toHaveBeenCalled();
  });

  it('only the envelope is suppressed: a room read issues not one local write', async () => {
    // The half that is easy to break silently: unread counts, the
    // blue-dot and lastOpenedAt are markChatOpened's and unreadCounts', and
    // the receipt path must not touch them — for a room, it must touch
    // NOTHING. `encryptAndEnqueue` is stubbed so a broken gate would fall
    // through to the real `markReadSent` and show up as an UPDATE below.
    installAnchor('room');
    stubPending([THEIRS]);
    jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const mark = instance.execute.mock.calls.length;

    await messaging.sendReadReceipt(ROOM);

    const issued = instance.execute.mock.calls
      .slice(mark)
      .map(c => String(c[0]));
    // Named precondition: the gate actually ran — the anchor was consulted.
    expect(issued.some(s => s.includes('FROM groups'))).toBe(true);
    // …and past the gate, silence: no readSent flip, no outbox row, no
    // chats touch. Local read state is exactly what delivery left it.
    expect(issued.filter(s => /^\s*(INSERT|UPDATE|DELETE)/i.test(s))).toEqual([]);
  });

  it('treats "don\'t know" as a room: an unanswerable anchor suppresses rather than sends', async () => {
    // Sending a receipt that should not exist is unrecoverable; withholding
    // one is not — `readSent` stays 0 and the next thread-open retries. So
    // anything short of the anchor's definite "not a room" falls silent.
    stubPending([THEIRS]);
    const sent = jest
      .spyOn(messaging as unknown as { encryptAndEnqueue: jest.Mock }, 'encryptAndEnqueue')
      .mockResolvedValue(undefined);
    const marked = jest.spyOn(db, 'markReadSent').mockResolvedValue(undefined);
    const anchor = jest.spyOn(db, 'getGroup');

    // Precondition: the anchor ANSWERING makes the very same read send.
    anchor.mockResolvedValue(null);
    await messaging.sendReadReceipt(PEER);
    expect(sent).toHaveBeenCalledTimes(1);
    sent.mockClear();
    marked.mockClear();

    anchor.mockRejectedValue(new Error('db is busy'));
    await messaging.sendReadReceipt(PEER); // must swallow, not throw

    expect(sent).not.toHaveBeenCalled();
    expect(marked).not.toHaveBeenCalled();
  });
});

describe('the markRead query cannot be aimed', () => {
  it('only touches MY delivered messages in THIS conversation', async () => {
    // `ids` arrives off the wire, so the SQL is the guard: direction 'out'
    // stops a peer rewriting their own rows, peerId stops one conversation
    // reaching into another, and status 'delivered' stops a receipt
    // resurrecting a failed send or overwriting an error row.
    await db.markRead(PEER, [THEIRS], 1_700_000_000_000);
    const sql = String(sqlFor(/UPDATE messages SET status = 'read'/)[0]?.[0] ?? '');

    expect(sql).toMatch(/direction = 'out'/);
    expect(sql).toMatch(/peerId = \?/);
    expect(sql).toMatch(/status = 'delivered'/);
  });

  it('does no work at all for an empty list', async () => {
    expect(await db.markRead(PEER, [], 1)).toBe(0);
    expect(sqlFor(/UPDATE messages SET status = 'read'/)).toHaveLength(0);
  });
});
