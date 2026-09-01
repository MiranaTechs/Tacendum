import { beforeEach, describe, expect, it } from 'vitest';
import type { SendFrame } from '@tacendum/shared';
import type { ServerFrame } from '@tacendum/shared';
import { URGENT_ACK_GRACE_MS, wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { deliverPushWake } from '../src/handlers/push-worker.js';
import { LIMITS } from '../src/ratelimit.js';
import type { DataLayer } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/** Fake transport: every post succeeds; these tests are about push, not
 * delivery, and the delivery paths are covered in ws.test.ts. */
function makeFakeSender() {
  const posted: Array<{ connectionId: string; frame: ServerFrame }> = [];
  return {
    posted,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      posted.push({ connectionId, frame });
      return true;
    },
  };
}

/**
 * the `urgent` hint. The server cannot see inside the
 * ciphertext, so this one bit is what lets a call ring a locked phone. Two
 * properties matter and are asserted here:
 *
 * 1. It wakes a device whose recipient has no live socket IMMEDIATELY — and
 * a recipient whose "live" socket took the bytes gets an ACK-VERIFIED
 * wake instead: a connection row is not proof of a running
 * process. iOS freezes an app seconds after a call ends while its socket
 * row lives on, API Gateway happily accepts bytes for the half-open TCP,
 * and the redialing caller sat at "Calling…" forever while the callee's
 * phone stayed dark. The probe waits out an ack grace and rings only if
 * the recipient never acked — a push to someone genuinely connected is
 * still pure battery and pure metadata, and their ack is what proves it.
 * 2. It is bounded per SENDER, so one hostile caller cannot ring-bomb a
 * victim while everyone else's calls still get through.
 */

const SENDER = '0000000000000000000SENDER1';
const RECIPIENT = '0000000000000000000RECPT02';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let db: DataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;
/** What handleSend asked the scheduler for — kind and probe, per wake. */
let scheduled: { kind: 'call' | 'message'; verify?: { msgId: string; ackGraceMs: number } }[];

function sendFrame(overrides: Partial<SendFrame> = {}): SendFrame {
  return {
    type: 'send',
    to: RECIPIENT,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ...overrides,
  } as SendFrame;
}

async function send(frame: SendFrame, connectionId = 'conn-sender') {
  return wsDefaultHandler(
    {
      routeKey: '$default' as const,
      connectionId,
      senderUserId: SENDER,
      body: JSON.stringify(frame),
    },
    wsDeps,
  );
}

beforeEach(async () => {
  scheduled = [];
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  wsDeps = {
    ...deps,
    sender: makeFakeSender(),
    scheduleDrain: async () => {},
    // Run the worker inline, exactly as the local adapter does, so these
    // tests still exercise the real token-read -> wake -> prune path.
    // EVERY PARAMETER NAMED. This fake used to take two, exactly like the
    // real adapters did, and that is how the production bug survived: the
    // handler passed `kind` and `message`, both implementations silently
    // dropped them, `deliverPushWake` read `kind === undefined` as 'call', and
    // every message notification went out as a VoIP ring instead. A test whose
    // fake has the same narrow shape as the bug cannot see the bug.
    // EVERY PARAMETER NAMED — including `verify`, for the same reason as the
    // note above: a fake that silently drops it would hide the entire
    // ack-probe path from every test in this file. The grace is CLAMPED to
    // keep the suite fast; the shipped number is pinned by its own test
    // below, so a clamp here cannot silently ship a different constant.
    schedulePush: async (recipientId, senderUserId, kind, message, verify) => {
      scheduled.push({ kind: kind ?? 'call', ...(verify ? { verify } : {}) });
      await deliverPushWake(
        {
          recipientId,
          senderUserId,
          ...(kind ? { kind } : {}),
          ...(message ? { message } : {}),
          ...(verify ? { verify: { ...verify, ackGraceMs: Math.min(verify.ackGraceMs, 50) } } : {}),
        },
        wsDeps,
      );
    },
  };
  await db.createUser({
    userId: RECIPIENT,
    createdAt: deps.now(),
  });
  await db.createUser({
    userId: SENDER,
    createdAt: deps.now(),
  });
  await db.putPushToken({
    userId: RECIPIENT,
    voipToken: 'a'.repeat(64),
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 86_400,
  });
});

describe('waking a sleeping device', () => {
  it('pushes exactly once when the frame is urgent and the recipient is offline', async () => {
    await send(sendFrame({ urgent: true }));
    expect(deps.pushesSent).toEqual([
      { userId: RECIPIENT, fromUserId: SENDER },
    ]);
    // A call is a RING, not a banner. The two branches must stay disjoint.
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('a "live" socket that takes the bytes gets a VERIFIED wake — and rings when no ack comes', async () => {
    // THIS TEST USED TO PIN THE BUG. It read "does NOT push when the
    // recipient has a live socket" and held the wake gated on the connection
    // row's existence — which is exactly how a frozen iOS process with a
    // half-open TCP swallowed a redial's offer while the caller sat at
    // "Calling…" (hardware testing). The row is not the proof;
    // the recipient's ACK is. Here nobody acks, so the probe must conclude
    // the socket is a zombie and ring.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-recipient',
      connectedAt: deps.now(),
    });
    await send(sendFrame({ urgent: true }));
    expect(scheduled).toEqual([
      { kind: 'call', verify: { msgId: MSG, ackGraceMs: URGENT_ACK_GRACE_MS } },
    ]);
    expect(deps.pushesSent).toEqual([{ userId: RECIPIENT, fromUserId: SENDER }]);
  });

  it('…and stays SILENT when the recipient acks within the grace', async () => {
    // The healthy-hangup half, and the reason the wake cannot be
    // unconditional: call.end is urgent on EVERY announced end, so a wake
    // that ignored the ack would VoIP-push the peer who just heard the
    // hangup over a perfectly healthy socket — and nothing arrives later to
    // dismiss the placeholder that push must report. The ack (which deletes
    // the queued row) is the liveness proof.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-recipient',
      connectedAt: deps.now(),
    });
    const inFlight = send(sendFrame({ urgent: true }));
    // The recipient's ack, landing inside the grace window — but the row must
    // EXIST before an ack can delete it, and `send` above is still enqueuing.
    // Wait for the row like a real ack does (it follows delivery), then delete.
    while (!(await db.getQueuedMessage(RECIPIENT, MSG))) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await db.deleteQueuedMessage(RECIPIENT, MSG);
    await inFlight;
    expect(scheduled).toHaveLength(1); // the probe was scheduled…
    expect(deps.pushesSent).toHaveLength(0); // …and the ack silenced it
  });

  it('an offline recipient still rings IMMEDIATELY — no probe, no grace', async () => {
    // The probe exists only because a connection row cast doubt. With no row
    // there is no doubt, and three seconds of grace before ringing a locked
    // phone would be pure added latency on the one path that was always
    // correct.
    await send(sendFrame({ urgent: true }));
    expect(scheduled).toEqual([{ kind: 'call', verify: undefined }]);
  });

  it('the shipped grace is 3 seconds — err long, the trade is asymmetric', () => {
    // Too long costs ring latency nobody can see (the caller's own UI says
    // "Calling…" for 45 s either way). Too short fires a redundant push at a
    // peer whose ack was merely slow, and the price of THAT is a CallKit
    // report nothing ever dismisses — a 75-second ghost ring. If this number
    // must move, it moves consciously, here.
    expect(URGENT_ACK_GRACE_MS).toBe(3_000);
  });

  it('pushes for an ordinary message when nobody is listening', async () => {
    // THIS RULE CHANGED, deliberately. It used to assert the opposite: no
    // push for anything but a call, so that the only thing APNs ever learned
    // was that someone was being rung.
    //
    // The cost of that was an app that told you nothing until you opened it,
    // which is not a messenger. The trade, stated plainly: Apple
    // now learns that a message arrived for this device at time T. It does not
    // learn who from — `from` is an opaque userId — and it cannot learn what,
    // because the payload is the ciphertext the server itself cannot read.
    await send(sendFrame({ urgent: false }));

    // `alertsSent`, NOT `pushesSent`. This assertion used to read
    // `pushesSent`, which is the VOIP array — and it passed, because the
    // scheduler was dropping `kind` and everything took the call branch. A
    // message that arrives as a VoIP push does not show a notification at all:
    // `mutable-content` lives only on the alert branch, so the extension never
    // launches, and a device holding a VoIP token instead rings CallKit with a
    // full incoming-call screen for a text message.
    expect(deps.alertsSent).toHaveLength(1);
    expect(deps.alertsSent[0]?.msgId).toBe(MSG);
    expect(deps.pushesSent).toHaveLength(0);
  });

  it('raises NO notification for a carrier frame, but still queues it', async () => {
    // `notify: false` marks transport — a read receipt, a reaction, an edit, a
    // profile sync. Each rewrites a row that already exists and never becomes
    // a message, so a banner for one announces mail that does not exist. The
    // worst case is the read receipt: it would tell the person who sent a
    // message that they have a new one, when what actually happened is that
    // somebody read theirs.
    await send(sendFrame({ notify: false }));

    expect(deps.alertsSent).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
    // Suppressed the BANNER, not the delivery. The ciphertext is queued and
    // drains on the next connect exactly as it always did.
    expect(await allQueued(db, RECIPIENT)).toHaveLength(1);
  });

  it('a call is still a RING even though it is also a carrier', async () => {
    // Call signalling is a carrier too, so it carries `notify: false` — and it
    // must still ring. The two bits are independent and read in that order:
    // urgent wins, and a non-urgent call frame (an ICE candidate, an answer)
    // correctly does neither.
    await send(sendFrame({ urgent: true, notify: false }));

    expect(deps.pushesSent).toHaveLength(1);
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('a non-urgent call frame neither rings nor banners', async () => {
    await send(sendFrame({ notify: false }));

    expect(deps.pushesSent).toHaveLength(0);
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('an absent notify bit still notifies — older clients keep working', async () => {
    // Absence is the safe default. A build that predates the bit must not go
    // silent because it does not know to say `notify: true`.
    await send(sendFrame({}));

    expect(deps.alertsSent).toHaveLength(1);
  });

  it('DOES push when the "live" socket refuses the bytes', async () => {
    // The stale-row case: a backgrounded iPhone's socket died without a
    // $disconnect, the row lingered, and delivery into it fails. Before this,
    // the row was reaped and then NOTHING happened — no banner, no badge,
    // nothing until the recipient opened the app. A connection that will not
    // take the bytes was never a connection, so the wake decision is the same
    // one the no-connection branch makes.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-dead',
      connectedAt: deps.now() - 60_000,
    });
    wsDeps.sender = { post: async () => false };

    await send(sendFrame({}));

    expect(deps.alertsSent).toHaveLength(1);
    expect(deps.alertsSent[0]?.msgId).toBe(MSG);
    // And the dead row is gone, so the next message takes the fast path.
    expect(await db.getConnection(RECIPIENT)).toBeUndefined();
  });

  it('a failed socket delivery of a CALL still rings', async () => {
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-dead',
      connectedAt: deps.now() - 60_000,
    });
    wsDeps.sender = { post: async () => false };

    await send(sendFrame({ urgent: true }));

    expect(deps.pushesSent).toHaveLength(1);
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('a failed CARRIER delivery stays silent — dead socket or not', async () => {
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-dead',
      connectedAt: deps.now() - 60_000,
    });
    wsDeps.sender = { post: async () => false };

    await send(sendFrame({ notify: false }));

    expect(deps.alertsSent).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
  });

  it('a reconnect racing the failed post gets the frame HANDED OVER, not assumed', async () => {
    // The suppress-on-newer-row rule had a hole: the newer socket's $connect
    // drain read the queue at some instant, and eventual consistency means
    // this frame's row may not have been visible to it — suppressing on the
    // row's existence alone silences the ONLY wake a call offer gets. So the
    // frame is posted to the newer socket instead: delivery is definitive.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-dead',
      connectedAt: deps.now() - 60_000,
    });
    const posted: Array<{ connectionId: string; frame: ServerFrame }> = [];
    wsDeps.sender = {
      async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
        posted.push({ connectionId, frame });
        if (connectionId === 'conn-dead') {
          // The recipient reconnects at the worst instant: after the read,
          // during the failed post.
          await db.putConnection({
            userId: RECIPIENT,
            connectionId: 'conn-new',
            connectedAt: deps.now(),
          });
          return false;
        }
        return true;
      },
    };

    await send(sendFrame({ urgent: true }));

    // The frame reached the NEW socket…
    expect(
      posted.filter(p => p.connectionId === 'conn-new' && p.frame.type === 'msg'),
    ).toHaveLength(1);
    // …and delivery now buys a PROBE, not silence: the newer row
    // taking the bytes proves no more about the process behind it than the
    // older one did. Nobody acks in this test, so the verified wake rings.
    expect(scheduled).toEqual([
      { kind: 'call', verify: { msgId: MSG, ackGraceMs: URGENT_ACK_GRACE_MS } },
    ]);
    expect(deps.pushesSent).toEqual([{ userId: RECIPIENT, fromUserId: SENDER }]);
    // And the sender's receipt tells the truth: delivered.
    const receipt = posted.filter(p => p.frame.type === 'receipt').at(-1);
    expect(receipt?.frame).toMatchObject({ state: 'delivered' });
  });

  it('when the newer socket is dead too, the wake still fires', async () => {
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-dead',
      connectedAt: deps.now() - 60_000,
    });
    wsDeps.sender = {
      async post(connectionId: string): Promise<boolean> {
        if (connectionId === 'conn-dead') {
          await db.putConnection({
            userId: RECIPIENT,
            connectionId: 'conn-new',
            connectedAt: deps.now(),
          });
        }
        // Both recipient sockets refuse; the sender's receipt post may too —
        // irrelevant here.
        return false;
      },
    };

    await send(sendFrame({ urgent: true }));

    expect(deps.pushesSent).toHaveLength(1);
  });

  it('texting cannot starve the CALL bucket', async () => {
    // The buckets used to be one, and a burst of texting silenced the same
    // sender's next call — the ring-bomb bound eating a friendly ring. The
    // message bucket is drained directly (going through handleSend 30 times
    // would trip the ws flood bound first, which is a different limiter doing
    // a different job); what matters is that the CALL bucket is untouched.
    while ((await deps.rateLimit.take(`pushmsg:${SENDER}`, LIMITS.pushMessage)) === 0) {
      // drain
    }

    await send(sendFrame({ urgent: true }));

    expect(deps.pushesSent).toHaveLength(1);
  });

  it('a spent PAIR banner budget never silences a RING either', async () => {
    // The (sender, recipient) fair-share bucket is the middle gate a message
    // wake passes, and — like the sender and recipient buckets flanking it —
    // it is message-shaped. Four quick texts to one person spend the pair
    // budget (LIMITS.pushMessagePair, 4 burst / 4 per minute), and the very
    // next frame between the SAME two people may be a call: the `kind ===
    // 'message'` guard in wakeRecipient is what keeps that call ringing.
    // Pinned so a refactor that hoists the pair take above the kind check
    // turns this red instead of shipping a missed call. The recipient-bucket
    // sibling of this test lives in crew.ws.test.ts ("the ceiling is
    // message-shaped").
    while (
      (await deps.rateLimit.take(
        `pushmsg-pair:${SENDER}:${RECIPIENT}`,
        LIMITS.pushMessagePair,
      )) === 0
    ) {
      // spend the pair's entire banner budget
    }

    await send(sendFrame({ urgent: true }));

    expect(deps.pushesSent).toHaveLength(1);
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('a ring-bombing caller cannot starve their own MESSAGE banners either', async () => {
    // The other direction of the same split.
    while ((await deps.rateLimit.take(`pushcall:${SENDER}`, LIMITS.pushSend)) === 0) {
      // drain
    }

    await send(sendFrame({}));

    expect(deps.alertsSent).toHaveLength(1);
  });

  it('does NOT push an ordinary message to a live socket', async () => {
    // It is about to be delivered over the socket. A banner for a
    // conversation already on screen is noise, and it would arrive twice.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-recipient',
      connectedAt: deps.now(),
    });
    await send(sendFrame({ urgent: false }));
    expect(deps.pushesSent).toHaveLength(0);
    expect(deps.alertsSent).toHaveLength(0);
  });

  it('does not push when the recipient never registered a token', async () => {
    await db.deletePushToken(RECIPIENT);
    const result = await send(sendFrame({ urgent: true }));
    // Still a normal, successful send — the message is queued either way.
    expect(result.statusCode).toBe(200);
    expect(deps.pushesSent).toHaveLength(0);
  });

  it('queues the message regardless, so the offer survives until the app opens', async () => {
    await send(sendFrame({ urgent: true }));
    const queued = await allQueued(db, RECIPIENT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.msgId).toBe(MSG);
  });
});

describe('a failed push is never the sender\'s problem', () => {
  it('still returns success and still receipts when the push throws', async () => {
    wsDeps.push = {
      wake: async () => {
        throw new Error('APNs is down');
      },
      notify: async () => {
        throw new Error('APNs is down');
      },
    };
    const result = await send(sendFrame({ urgent: true }));
    expect(result.statusCode).toBe(200);
    expect(await allQueued(db, RECIPIENT)).toHaveLength(1);
  });
});

describe('ring-bomb bound', () => {
  it('caps pushes per SENDER, not per recipient', async () => {
    // Crockford base32, 26 chars — an invalid ULID would be rejected by the
    // frame schema and this test would pass vacuously with zero pushes.
    const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const nthMsgId = (i: number) =>
      `${MSG.slice(0, 24)}${C[i % 32]}${C[(i * 7) % 32]}`;

    for (let i = 0; i < 20; i++) {
      const result = await send(sendFrame({ urgent: true, msgId: nthMsgId(i) }));
      expect(result.statusCode, `send ${i} was rejected`).toBe(200);
    }
    // Bounded well below the number of attempts.
    expect(deps.pushesSent.length).toBeLessThanOrEqual(10);
    expect(deps.pushesSent.length).toBeGreaterThan(0);
  });
});

describe('logging discipline', () => {
  it('records that a push happened without the payload, the token, or a cid', async () => {
    await send(sendFrame({ urgent: true }));
    const dump = JSON.stringify(deps.logs);
    expect(dump).not.toContain('QUJD'); // the payload
    expect(dump).not.toContain('a'.repeat(64)); // the device token
    expect(dump).not.toContain(MSG); // msgId is payload-adjacent metadata
  });
});
