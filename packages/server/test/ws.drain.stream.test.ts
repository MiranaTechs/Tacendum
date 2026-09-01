import { describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import { drainQueuedMessages } from '../src/handlers/ws.js';
import type { QueuedMessage } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/** Monotonic so msgIds minted in the same millisecond still sort in order. */
const ulid = monotonicFactory();

const B64 = 'Y2lwaGVydGV4dA=='; // "ciphertext"

/**
 * B2 — the drain must STREAM the queue, not materialise it.
 *
 * The attack this locks out: flood a victim's offline queue until the drain
 * Lambda (256 MB / 30 s) dies while LISTING. A drain that materialises every
 * page into one array before posting anything delivers NOTHING when it dies —
 * and every reconnect repeats the same death, so the victim's entire backlog
 * is black-holed while senders hold `state:'sent'` receipts.
 *
 * A drain that consumes the queue page by page has already posted the earlier
 * pages when a later page kills it; clients ack what was posted, acks delete
 * rows, and the next reconnect starts from a smaller queue. Forward progress
 * instead of a black hole.
 */

function makeMsg(recipientId: string, expiresAt: number): QueuedMessage {
  return {
    recipientId,
    msgId: ulid(),
    senderId: 'sender-1',
    type: 'ciphertext',
    payload: B64,
    ts: 1_700_000_000_000,
    expiresAt,
  };
}

describe('B2 — drainQueuedMessages streams pages instead of materialising the queue', () => {
  const RECIPIENT = 'user-victim';

  function setup(pages: QueuedMessage[][], opts: { failAtPage?: number } = {}) {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    /** Interleaving log: 'fetch:N' when page N is produced, 'post:<msgId>' per frame. */
    const events: string[] = [];
    db.listQueuedMessages = async function* (recipientId: string) {
      expect(recipientId).toBe(RECIPIENT);
      let i = 0;
      for (const page of pages) {
        if (opts.failAtPage === i) {
          events.push(`fetch:${i}:boom`);
          throw new Error('page fetch exploded (simulated OOM/timeout budget)');
        }
        events.push(`fetch:${i}`);
        yield page;
        i += 1;
      }
    };
    const sender = {
      async post(_connectionId: string, frame: ServerFrame): Promise<boolean> {
        if (frame.type === 'msg') events.push(`post:${frame.msgId}`);
        return true;
      },
    };
    return { events, wsDeps: { db, sender, now: deps.now } };
  }

  it('posts each page as it arrives — page 1 is on the wire before page 2 is fetched', async () => {
    const live = Math.floor(1_700_000_000_000 / 1000) + 3600;
    const [m1, m2, m3, m4] = [
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live),
    ] as const;
    const { events, wsDeps } = setup([
      [m1, m2],
      [m3, m4],
    ]);

    await expect(drainQueuedMessages(RECIPIENT, 'conn-1', wsDeps)).resolves.toMatchObject({
      outcome: 'complete',
    });

    expect(events).toEqual([
      'fetch:0',
      `post:${m1.msgId}`,
      `post:${m2.msgId}`,
      'fetch:1',
      `post:${m3.msgId}`,
      `post:${m4.msgId}`,
    ]);
  });

  it('a later page blowing the budget still delivers every earlier page', async () => {
    const live = Math.floor(1_700_000_000_000 / 1000) + 3600;
    const [m1, m2, m3, m4] = [
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live),
      makeMsg(RECIPIENT, live), // never produced: fetching its page "kills the Lambda"
    ] as const;
    const { events, wsDeps } = setup([[m1, m2], [m3], [m4]], { failAtPage: 2 });

    await expect(drainQueuedMessages(RECIPIENT, 'conn-1', wsDeps)).rejects.toThrow(
      'page fetch exploded (simulated OOM/timeout budget)',
    );

    // Pages 0 and 1 were posted BEFORE the fatal fetch: the acked prefix is
    // what turns every reconnect into forward progress instead of a repeat.
    expect(events).toEqual([
      'fetch:0',
      `post:${m1.msgId}`,
      `post:${m2.msgId}`,
      'fetch:1',
      `post:${m3.msgId}`,
      'fetch:2:boom',
    ]);
  });

  it('the expiresAt filter is applied per page, not after materialisation', async () => {
    const nowSec = Math.floor(1_700_000_000_000 / 1000);
    const [expired, liveA, liveB] = [
      makeMsg(RECIPIENT, nowSec - 10),
      makeMsg(RECIPIENT, nowSec + 3600),
      makeMsg(RECIPIENT, nowSec + 3600),
    ] as const;
    const { events, wsDeps } = setup([
      [expired, liveA],
      [liveB],
    ]);

    await expect(drainQueuedMessages(RECIPIENT, 'conn-1', wsDeps)).resolves.toMatchObject({
      outcome: 'complete',
    });

    expect(events).toEqual([
      'fetch:0',
      `post:${liveA.msgId}`, // the expired one was skipped inside its page
      'fetch:1',
      `post:${liveB.msgId}`,
    ]);
  });
});
