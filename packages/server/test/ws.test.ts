import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monotonicFactory } from 'ulid';

/** Monotonic so msgIds minted in the same millisecond still sort in order. */
const ulid = monotonicFactory();
import type { ServerFrame } from '@tacendum/shared';
import {
  CONNECTION_REAP_GRACE_MS,
  drainQueuedMessages,
  wsConnectHandler,
  wsDefaultHandler,
  wsDisconnectHandler,
  type WsDeps,
} from '../src/handlers/ws.js';
import { IDKEY_CLAIM_PREFIX, type DataLayer } from '../src/db/data.js';
import { ACTIVITY_TOUCH_TIMEOUT_MS } from '../src/activity.js';
import { activityActorRef } from '../src/opaque-ref.js';
import { allQueued, makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/** Fake transport: records frames per connectionId; `dead` connections refuse. */
function makeFakeSender() {
  const inbox = new Map<string, ServerFrame[]>();
  const dead = new Set<string>();
  return {
    inbox,
    dead,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      if (dead.has(connectionId)) return false;
      const frames = inbox.get(connectionId) ?? [];
      frames.push(frame);
      inbox.set(connectionId, frames);
      return true;
    },
  };
}

const B64 = 'Y2lwaGVydGV4dA=='; // "ciphertext"

const ALICE_KEY = testIdentityKey(0x01);
const BOB_KEY = testIdentityKey(0x02);
const UNREGISTERED_KEY = testIdentityKey(0x03);
const INTEGRATION_KEY = testIdentityKey(0x04);

describe('websocket handlers', () => {
  let db: DataLayer;
  let deps: TestDeps;
  let sender: ReturnType<typeof makeFakeSender>;
  let wsDeps: WsDeps;
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;
  let bobId: string;

  /**
   * An account and a live session, built straight on the data layer.
   *
   * Deliberately NOT driven through POST /v1/auth: these tests are about
   * message routing, and going through the real sign-in would drag a libsignal
   * signature and the per-IP auth limiter into every case for no coverage —
   * the auth path has its own suite (auth-account.test.ts). What matters here
   * is that the account row and its `idkey#` claim exist exactly as sign-in
   * would leave them, which is what getOrCreateUserByIdentityKey does.
   */
  async function makeUser(
    identityKey: string,
    accountClass?: 'integration',
  ): Promise<{ userId: string; token: string }> {
    const resolution = await db.getOrCreateUserByIdentityKey(
      identityKey,
      deps.newUserId(),
      deps.now(),
      accountClass,
    );
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    const token = deps.newAuthToken();
    await db.createSession({
      token,
      userId: resolution.user.userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    return { userId: resolution.user.userId, token };
  }

  beforeEach(async () => {
    db = makeMemoryDb();
    // Salted so $connect's activity touch actually writes (without the salt
    // the touch is skipped with a counter, never unsalted).
    deps = { ...makeTestDeps(db), userRefSalt: 'ws-test-user-ref-salt' };
    sender = makeFakeSender();
    // Drain inline like the local adapter: these tests exercise the pure
    // handlers' full connect-then-drain behavior over the fake transport.
    wsDeps = {
      ...deps,
      sender,
      schedulePush: async () => {},
      scheduleDrain: async (userId, connectionId) => {
        await drainQueuedMessages(userId, connectionId, { db, sender, now: deps.now });
      },
    };
    ({ userId: aliceId, token: aliceToken } = await makeUser(ALICE_KEY));
    ({ userId: bobId, token: bobToken } = await makeUser(BOB_KEY));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Dial as the session's owner. The socket takes ONLY a single-use ticket
   * now (deleted the transitional `?token=` branch), so the helper mints
   * one the way POST /v1/ws-ticket would and dials with it. An unknown token
   * dials with a ticket nothing minted — the dead-credential case.
   */
  async function connect(token: string, connectionId: string) {
    const session = await db.getSession(token);
    const ticket = deps.newAuthToken();
    if (session) {
      await db.putWsTicket({
        ticket,
        userId: session.userId,
        expiresAt: Math.floor(deps.now() / 1000) + 60,
        role: 'listen',
      });
    }
    return wsConnectHandler(
      { routeKey: '$connect', connectionId, queryStringParameters: { ticket } },
      wsDeps,
    );
  }

  function sendFrame(to: string, msgId: string, connectionId: string, senderUserId: string) {
    return wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId,
        senderUserId,
        body: JSON.stringify({ type: 'send', to, msgId, msgType: 'ciphertext', payload: B64 }),
      },
      wsDeps,
    );
  }

  it('$connect authenticates the ticket and records the connection', async () => {
    const res = await connect(aliceToken, 'conn-a');
    expect(res).toEqual({ statusCode: 200, userId: aliceId });
    expect(await db.getConnection(aliceId)).toMatchObject({ connectionId: 'conn-a' });
  });

  it('$connect records human activity only after drain scheduling succeeds', async () => {
    const events: string[] = [];
    wsDeps.scheduleDrain = async () => {
      events.push('drain');
    };
    const touch = vi.spyOn(db, 'touchActivity').mockImplementation(async () => {
      events.push('touch');
    });

    const res = await connect(aliceToken, 'conn-activity');

    expect(res.statusCode).toBe(200);
    expect(events).toEqual(['drain', 'touch']);
    // Keyed by the salted opaque ref, never the raw userId.
    expect(touch).toHaveBeenCalledWith(
      activityActorRef(aliceId, 'ws-test-user-ref-salt'),
      deps.now(),
      expect.any(AbortSignal),
    );
  });

  it('$connect does not record activity when drain scheduling fails', async () => {
    const touch = vi.spyOn(db, 'touchActivity');
    wsDeps.scheduleDrain = async () => {
      throw new Error('drain schedule failed');
    };

    await expect(connect(aliceToken, 'conn-no-activity')).rejects.toThrow(
      'drain schedule failed',
    );

    expect(touch).not.toHaveBeenCalled();
  });

  it('$connect does not record activity for integration accounts', async () => {
    const integration = await makeUser(INTEGRATION_KEY, 'integration');
    const touch = vi.spyOn(db, 'touchActivity');

    const res = await connect(integration.token, 'conn-integration');

    expect(res.statusCode).toBe(200);
    expect(touch).not.toHaveBeenCalled();
  });

  it('$connect succeeds when the activity user read rejects', async () => {
    vi.spyOn(db, 'getUserById').mockRejectedValue(new Error('activity read unavailable'));

    const res = await connect(aliceToken, 'conn-read-reject');

    expect(res.statusCode).toBe(200);
    expect(deps.logs.filter((row) => row.event === 'activity_touch_failed')).toHaveLength(1);
  });

  it('$connect succeeds when the activity write rejects', async () => {
    vi.spyOn(db, 'touchActivity').mockRejectedValue(new Error('activity write unavailable'));

    const res = await connect(aliceToken, 'conn-write-reject');

    expect(res.statusCode).toBe(200);
    expect(deps.logs.filter((row) => row.event === 'activity_touch_failed')).toHaveLength(1);
  });

  it('$connect bounds a never-settling activity read to 500 milliseconds', async () => {
    vi.useFakeTimers();
    const getUserById = vi.spyOn(db, 'getUserById').mockImplementation((_userId, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const pending = connect(aliceToken, 'conn-read-timeout');
    await vi.advanceTimersByTimeAsync(ACTIVITY_TOUCH_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ statusCode: 200 });
    expect(getUserById).toHaveBeenCalledOnce();
  });

  it('$connect bounds a never-settling activity write to the read shared 500ms signal', async () => {
    vi.useFakeTimers();
    const getUserById = vi.spyOn(db, 'getUserById').mockImplementation((_userId, signal) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ userId: aliceId, createdAt: deps.now() }),
          ACTIVITY_TOUCH_TIMEOUT_MS - 100,
        );
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const touch = vi.spyOn(db, 'touchActivity').mockImplementation((_userId, _nowMs, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const pending = connect(aliceToken, 'conn-shared-timeout');
    await vi.advanceTimersByTimeAsync(ACTIVITY_TOUCH_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ statusCode: 200 });
    expect(getUserById).toHaveBeenCalledOnce();
    expect(touch).toHaveBeenCalledOnce();
    expect(getUserById.mock.calls[0]?.[1]).toBe(touch.mock.calls[0]?.[2]);
  });

  it('$connect rejects a dead credential — and a bearer presented as ?token=', async () => {
    const res = await connect('bogus', 'conn-x');
    expect(res.statusCode).toBe(401);
    expect(res.userId).toBeUndefined();

    // The transitional bearer branch is DELETED: a perfectly valid
    // session token in the URL is refused exactly like no credential at all.
    const bearer = await wsConnectHandler(
      { routeKey: '$connect', connectionId: 'conn-y', queryStringParameters: { token: aliceToken } },
      wsDeps,
    );
    expect(bearer.statusCode).toBe(401);
    expect(bearer.userId).toBeUndefined();
  });

  it('online recipient: message delivered live, sender gets a delivered receipt', async () => {
    await connect(aliceToken, 'conn-a');
    await connect(bobToken, 'conn-b');
    const msgId = ulid();

    await sendFrame(bobId, msgId, 'conn-a', aliceId);

    const bobFrames = sender.inbox.get('conn-b') ?? [];
    expect(bobFrames).toHaveLength(1);
    expect(bobFrames[0]).toMatchObject({ type: 'msg', from: aliceId, msgId, payload: B64 });

    const aliceFrames = sender.inbox.get('conn-a') ?? [];
    expect(aliceFrames).toContainEqual({ type: 'receipt', msgId, state: 'delivered' });
  });

  it('offline recipient: message queued, sender gets a sent receipt', async () => {
    await connect(aliceToken, 'conn-a');
    const msgId = ulid();

    await sendFrame(bobId, msgId, 'conn-a', aliceId);

    expect(sender.inbox.get('conn-b')).toBeUndefined();
    expect(await allQueued(db, bobId)).toHaveLength(1);
    const aliceFrames = sender.inbox.get('conn-a') ?? [];
    expect(aliceFrames).toContainEqual({ type: 'receipt', msgId, state: 'sent' });
  });

  it('recipient socket dead but row stale: falls back to sent receipt, message stays queued', async () => {
    await connect(aliceToken, 'conn-a');
    await connect(bobToken, 'conn-b');
    sender.dead.add('conn-b'); // socket gone, row still present
    const msgId = ulid();

    await sendFrame(bobId, msgId, 'conn-a', aliceId);

    const aliceFrames = sender.inbox.get('conn-a') ?? [];
    expect(aliceFrames).toContainEqual({ type: 'receipt', msgId, state: 'sent' });
    expect(await allQueued(db, bobId)).toHaveLength(1);
  });

  it('drain on connect: queued messages replayed in msgId order, deleted only on ack', async () => {
    await connect(aliceToken, 'conn-a');
    const m1 = ulid();
    const m2 = ulid(); // monotonic factory -> m2 sorts after m1 even in the same ms
    await sendFrame(bobId, m1, 'conn-a', aliceId);
    await sendFrame(bobId, m2, 'conn-a', aliceId);

    await connect(bobToken, 'conn-b');
    const bobFrames = (sender.inbox.get('conn-b') ?? []).filter((f) => f.type === 'msg');
    expect(bobFrames.map((f) => (f.type === 'msg' ? f.msgId : ''))).toEqual([m1, m2]);
    // Still queued (no ack yet).
    expect(await allQueued(db, bobId)).toHaveLength(2);

    // Bob acks m1 -> only m2 remains.
    await wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId: 'conn-b',
        senderUserId: bobId,
        body: JSON.stringify({ type: 'ack', msgId: m1 }),
      },
      wsDeps,
    );
    const remaining = await allQueued(db, bobId);
    expect(remaining.map((m) => m.msgId)).toEqual([m2]);
  });

  it('re-drain is idempotent: same msgIds redelivered, client dedupes', async () => {
    await connect(aliceToken, 'conn-a');
    const msgId = ulid();
    await sendFrame(bobId, msgId, 'conn-a', aliceId);

    await connect(bobToken, 'conn-b1');
    // Second dial without ack, first socket still live: the $connect probe
    // spares conn-b1's row, but the drain replays to conn-b2 regardless —
    // which is exactly the redundancy this test says clients must dedupe.
    await connect(bobToken, 'conn-b2');
    const first = (sender.inbox.get('conn-b1') ?? []).filter((f) => f.type === 'msg');
    const second = (sender.inbox.get('conn-b2') ?? []).filter((f) => f.type === 'msg');
    expect(first.map((f) => (f.type === 'msg' ? f.msgId : ''))).toEqual([msgId]);
    expect(second.map((f) => (f.type === 'msg' ? f.msgId : ''))).toEqual([msgId]);
  });

  it('drain skips queued messages at or before the TTL boundary (TTL deletion is eventual)', async () => {
    const nowSec = Math.floor(deps.now() / 1000);
    const [mBefore, mAt, mAbove] = [ulid(), ulid(), ulid()];
    const row = (msgId: string, expiresAt: number) => ({
      recipientId: bobId,
      msgId,
      senderId: aliceId,
      type: 'ciphertext' as const,
      payload: B64,
      ts: deps.now(),
      expiresAt,
    });
    await db.enqueueMessage(row(mBefore, nowSec - 1));
    await db.enqueueMessage(row(mAt, nowSec));
    await db.enqueueMessage(row(mAbove, nowSec + 1));

    await drainQueuedMessages(bobId, 'conn-b', { db, sender, now: deps.now });

    const frames = (sender.inbox.get('conn-b') ?? []).filter((f) => f.type === 'msg');
    expect(frames.map((f) => (f.type === 'msg' ? f.msgId : ''))).toEqual([mAbove]);
    // Expired rows are left for DynamoDB TTL to reap; drain still never deletes.
    expect((await allQueued(db, bobId)).map((m) => m.msgId)).toEqual([
      mBefore,
      mAt,
      mAbove,
    ]);
  });

  it('drain delivers live messages in msgId order across interleaved expired rows', async () => {
    const nowSec = Math.floor(deps.now() / 1000);
    const [m1, m2, m3] = [ulid(), ulid(), ulid()];
    const row = (msgId: string, expiresAt: number) => ({
      recipientId: bobId,
      msgId,
      senderId: aliceId,
      type: 'ciphertext' as const,
      payload: B64,
      ts: deps.now(),
      expiresAt,
    });
    await db.enqueueMessage(row(m1, nowSec + 60));
    await db.enqueueMessage(row(m2, nowSec)); // expired mid-queue must not stop the drain
    await db.enqueueMessage(row(m3, nowSec + 60));

    await drainQueuedMessages(bobId, 'conn-b', { db, sender, now: deps.now });

    const frames = (sender.inbox.get('conn-b') ?? []).filter((f) => f.type === 'msg');
    expect(frames.map((f) => (f.type === 'msg' ? f.msgId : ''))).toEqual([m1, m3]);
    expect(await allQueued(db, bobId)).toHaveLength(3);
  });

  it('unknown recipient: error frame, nothing queued', async () => {
    await connect(aliceToken, 'conn-a');
    const res = await sendFrame('01JNKJNKJNKJNKJNKJNKJNKJNK', ulid(), 'conn-a', aliceId);
    expect(res.statusCode).toBe(404);
    const aliceFrames = sender.inbox.get('conn-a') ?? [];
    expect(aliceFrames.some((f) => f.type === 'error' && f.code === 'unknown_recipient')).toBe(true);
  });

  it('idkey-claim ids are never recipients: registered and unregistered keys are indistinguishable', async () => {
    await connect(aliceToken, 'conn-a');
    // Bob's sign-in wrote an 'idkey#<b64>' claim row into the users table
    // (mirrored by the memory store). Resolving it would give any
    // authenticated sender an is-this-key-registered oracle and a queue
    // nothing ever drains — the reason getUserById refuses claim prefixes.
    // Since the `to` schema cap, a claim-prefixed id —
    // longer than a 26-char ULID by construction — dies at the frame schema,
    // BEFORE any table read: both probes now draw the same `invalid_frame`
    // where they used to draw the same `unknown_recipient`. Indistinguishable
    // either way, which is the invariant this test exists to hold; the
    // refusal merely moved earlier and stopped costing a recipient read.
    const registered = await sendFrame(
      `${IDKEY_CLAIM_PREFIX}${BOB_KEY}`,
      ulid(),
      'conn-a',
      aliceId,
    );
    const unregistered = await sendFrame(
      `${IDKEY_CLAIM_PREFIX}${UNREGISTERED_KEY}`,
      ulid(),
      'conn-a',
      aliceId,
    );
    expect(registered.statusCode).toBe(400);
    expect(unregistered.statusCode).toBe(400);
    const errors = (sender.inbox.get('conn-a') ?? []).filter((f) => f.type === 'error');
    expect(errors.map((f) => f.type === 'error' && f.code)).toEqual([
      'invalid_frame',
      'invalid_frame',
    ]);
    expect(await allQueued(db, `${IDKEY_CLAIM_PREFIX}${BOB_KEY}`)).toHaveLength(0);
  });

  it('legacy phone-claim ids are STILL refused, though nothing writes them any more', async () => {
    // The phone path is deleted but its claim rows
    // are still sitting in the deployed users table, which is RETAIN and was
    // never purged. So the refusal is not vestigial: were a surviving legacy
    // claim addressable, that would be a 200-vs-404 registered-phone oracle
    // over the old user base, plus a queue nothing drains. This test is what
    // stops that being "tidied away".
    // Since `to: Ulid` a phone-claim id — '#', '+', lowercase —
    // dies at the frame schema before any table read, like the idkey probes
    // above: 400 `invalid_frame` where the CLAIM_PREFIXES guard used to
    // serve the 404. The getUserById guard stays, as defence-in-depth for
    // any non-frame path; the WIRE-level invariant this test holds is
    // unchanged — a claim row is never addressable and never queued to.
    // The row is SEEDED, because nothing writes one any more. Without it this
    // test would pass for the wrong reason — an absent row refuses whether or
    // not anything guards it — and would keep passing after both guards fell.
    const legacyClaim = 'phone#+15550100002';
    await db.createUser({ userId: legacyClaim, createdAt: 1 });

    await connect(aliceToken, 'conn-a');
    const legacy = await sendFrame(legacyClaim, ulid(), 'conn-a', aliceId);
    expect(legacy.statusCode).toBe(400);
    const errors = (sender.inbox.get('conn-a') ?? []).filter((f) => f.type === 'error');
    expect(errors.some((f) => f.type === 'error' && f.code === 'invalid_frame')).toBe(true);
    expect(await allQueued(db, legacyClaim)).toHaveLength(0);
  });

  it('malformed frame: error frame with invalid_frame', async () => {
    await connect(aliceToken, 'conn-a');
    const res = await wsDefaultHandler(
      { routeKey: '$default', connectionId: 'conn-a', senderUserId: aliceId, body: 'not json' },
      wsDeps,
    );
    expect(res.statusCode).toBe(400);
    const frames = sender.inbox.get('conn-a') ?? [];
    expect(frames.some((f) => f.type === 'error' && f.code === 'invalid_frame')).toBe(true);
  });

  it('oversized payload rejected by schema', async () => {
    await connect(aliceToken, 'conn-a');
    const big = 'A'.repeat(30_004); // > MAX_PAYLOAD_B64_LENGTH, valid b64 alphabet
    const res = await wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId: 'conn-a',
        senderUserId: aliceId,
        body: JSON.stringify({ type: 'send', to: bobId, msgId: ulid(), msgType: 'ciphertext', payload: big }),
      },
      wsDeps,
    );
    expect(res.statusCode).toBe(400);
  });

  it('drainQueuedMessages reports whether the socket survived the drain', async () => {
    const msgId = ulid();
    await db.enqueueMessage({
      recipientId: bobId,
      msgId,
      senderId: aliceId,
      type: 'ciphertext',
      payload: B64,
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 60,
    });
    await expect(
      drainQueuedMessages(bobId, 'conn-live', { db, sender, now: deps.now }),
    ).resolves.toMatchObject({ outcome: 'complete' });
    sender.dead.add('conn-dead');
    await expect(
      drainQueuedMessages(bobId, 'conn-dead', { db, sender, now: deps.now }),
    ).resolves.toMatchObject({ outcome: 'socket_gone' });
  });

  describe('stale connection cleanup (conditional deletes)', () => {
    it('$connect deletes the connection row it wrote and rethrows when the drain cannot be scheduled', async () => {
      wsDeps.scheduleDrain = async () => {
        throw new Error('drain schedule failed');
      };
      await expect(connect(aliceToken, 'conn-sched-fail')).rejects.toThrow('drain schedule failed');
      expect(await db.getConnection(aliceId)).toBeUndefined();
    });

    it('$connect cleanup preserves a newer connection row written by a racing reconnect', async () => {
      wsDeps.scheduleDrain = async (userId) => {
        // A racing reconnect overwrote the row before the failure surfaced.
        await db.putConnection({ userId, connectionId: 'conn-newer', connectedAt: deps.now() });
        throw new Error('drain schedule failed');
      };
      await expect(connect(aliceToken, 'conn-stale')).rejects.toThrow('drain schedule failed');
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-newer');
    });

    it("send to a dead recipient socket deletes the recipient's stale row (message stays queued)", async () => {
      await connect(aliceToken, 'conn-a');
      await connect(bobToken, 'conn-b');
      // Age the rows past the handshake grace window so the reap is armed.
      deps.advanceMs(CONNECTION_REAP_GRACE_MS);
      sender.dead.add('conn-b');
      const msgId = ulid();
      await sendFrame(bobId, msgId, 'conn-a', aliceId);
      expect(await db.getConnection(bobId)).toBeUndefined();
      expect(await allQueued(db, bobId)).toHaveLength(1);
      expect(sender.inbox.get('conn-a')).toContainEqual({ type: 'receipt', msgId, state: 'sent' });
    });

    it('a failed post to a freshly connected recipient leaves the row (handshake grace)', async () => {
      await connect(aliceToken, 'conn-a');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS); // only alice's row is old
      await connect(bobToken, 'conn-b'); // bob's row is brand new
      // AWS host: a post can fail with Gone while bob's handshake is still
      // settling; deleting the fresh row would blackhole the healthy socket.
      sender.dead.add('conn-b');
      const msgId = ulid();
      await sendFrame(bobId, msgId, 'conn-a', aliceId);
      expect((await db.getConnection(bobId))?.connectionId).toBe('conn-b');
      expect(await allQueued(db, bobId)).toHaveLength(1);
      expect(sender.inbox.get('conn-a')).toContainEqual({ type: 'receipt', msgId, state: 'sent' });
    });

    it('dead-recipient cleanup preserves a row overwritten by a reconnect during the failed post', async () => {
      await connect(aliceToken, 'conn-a');
      await connect(bobToken, 'conn-b-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS); // arm the reap for conn-b-old
      const basePost = sender.post.bind(sender);
      wsDeps.sender = {
        post: async (connectionId, frame) => {
          if (connectionId === 'conn-b-old') {
            // Bob reconnects while the post is in flight, then the post fails.
            await db.putConnection({
              userId: bobId,
              connectionId: 'conn-b-new',
              connectedAt: deps.now(),
            });
            return false;
          }
          return basePost(connectionId, frame);
        },
      };
      await sendFrame(bobId, ulid(), 'conn-a', aliceId);
      expect((await db.getConnection(bobId))?.connectionId).toBe('conn-b-new');
    });

    it("failed receipt post deletes the sender's stale row, not the recipient's", async () => {
      await connect(aliceToken, 'conn-a');
      await connect(bobToken, 'conn-b');
      sender.dead.add('conn-a'); // alice's socket died right after sending
      await sendFrame(bobId, ulid(), 'conn-a', aliceId);
      expect(await db.getConnection(aliceId)).toBeUndefined();
      expect((await db.getConnection(bobId))?.connectionId).toBe('conn-b');
    });

    it("failed receipt cleanup preserves the sender's newer connection after a reconnect", async () => {
      await connect(aliceToken, 'conn-a');
      // Dead BEFORE the reconnect: that is what a crash reconnect is, and it
      // is what lets the $connect probe displace the row. A still-live conn-a
      // would now be spared instead — that path has its own suite
      // (gate.connrow.test.ts).
      sender.dead.add('conn-a');
      await connect(aliceToken, 'conn-a2'); // reconnect overwrote the dead row
      await connect(bobToken, 'conn-b');
      await sendFrame(bobId, ulid(), 'conn-a', aliceId); // late frame from the old socket
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-a2');
    });

    it("failed error frame deletes the sender's stale row", async () => {
      await connect(aliceToken, 'conn-a');
      sender.dead.add('conn-a');
      const res = await sendFrame('01JNKJNKJNKJNKJNKJNKJNKJNK', ulid(), 'conn-a', aliceId);
      expect(res.statusCode).toBe(404);
      expect(await db.getConnection(aliceId)).toBeUndefined();
    });
  });

  it('$disconnect removes the connection but a stale disconnect does not clobber a reconnect', async () => {
    await connect(bobToken, 'conn-old');
    // The old socket died without a $disconnect (crash), so the reconnect's
    // probe finds it dead and takes the row; the stale $disconnect for it
    // arrives after the new row exists — the exact ordering the conditional
    // delete guards.
    sender.dead.add('conn-old');
    await connect(bobToken, 'conn-new'); // reconnect overwrites the dead row
    // Stale disconnect for the old socket arrives late:
    await wsDisconnectHandler(
      { routeKey: '$disconnect', connectionId: 'conn-old', senderUserId: bobId },
      wsDeps,
    );
    expect((await db.getConnection(bobId))?.connectionId).toBe('conn-new');
    // Real disconnect removes it.
    await wsDisconnectHandler(
      { routeKey: '$disconnect', connectionId: 'conn-new', senderUserId: bobId },
      wsDeps,
    );
    expect(await db.getConnection(bobId)).toBeUndefined();
  });
});
