import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerFrame, TypingFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps, type WsResult } from '../src/handlers/ws.js';
import { LIMITS } from '../src/ratelimit.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * The typing relay contract, asserted from the outside:
 * a connected correspondent receives the frame; everyone else — offline,
 * stranger, revoked, deleted account — produces a response byte-identical
 * to success, because a silent free frame that echoed delivery state would
 * be a stealth presence oracle. Nothing on this path may ever touch the
 * queue, the quota ledgers, push, or correspondence.
 *
 * Integration senders relay toward exactly the
 * recipients the send predicate lets them message — owner or same-crew
 * integration — and draw the earlier uniform drop toward everyone else.
 */

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

const SENDER = '0000000000000000000SENDER1';
const RECIPIENT = '0000000000000000000RECPT02';

let db: TestOnlyDataLayer;
let deps: TestDeps;
let wsDeps: WsDeps & { sender: ReturnType<typeof makeFakeSender> };

function typingFrame(overrides: Partial<TypingFrame> = {}): TypingFrame {
  return {
    type: 'typing',
    to: RECIPIENT,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ...overrides,
  };
}

async function sendTyping(
  frame: TypingFrame = typingFrame(),
  connectionId = 'conn-sender',
): Promise<WsResult> {
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

let msgSeq = 0;
/** Mint user-authored correspondence from -> to, the way a real send does. */
async function establish(from: string, to: string): Promise<void> {
  msgSeq += 1;
  const msgId = `01ARZ3NDEKTSV4RRFFQ69G5F${String(msgSeq).padStart(2, '0')}`;
  await db.enqueueMessage(
    {
      recipientId: to,
      msgId,
      senderId: from,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    },
    { establishesCorrespondence: true },
  );
  // The queue row itself is irrelevant to these tests; the ledger marker is
  // what matters (an ESTABLISHED ledger survives at zero items). Drain the
  // row so allQueued() assertions see only what typing itself writes.
  await db.deleteQueuedMessage(to, msgId);
}

function framesTo(connectionId: string): ServerFrame[] {
  return wsDeps.sender.posted
    .filter(p => p.connectionId === connectionId)
    .map(p => p.frame);
}

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  wsDeps = {
    ...deps,
    sender: makeFakeSender(),
    scheduleDrain: async () => {},
    schedulePush: async () => {},
  };
  await db.createUser({ userId: SENDER, createdAt: deps.now() });
  await db.createUser({ userId: RECIPIENT, createdAt: deps.now() });
});

describe('typing relay', () => {
  it('relays to a connected correspondent and stores nothing', async () => {
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 200 });
    const relayed = framesTo('conn-r');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({
      type: 'typing',
      from: SENDER,
      msgType: 'ciphertext',
      payload: 'QUJD',
    });
    // Nothing durable, nothing woken, nothing receipted.
    expect(await allQueued(db, RECIPIENT)).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
    expect(deps.alertsSent).toHaveLength(0);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('reverse-direction correspondence suffices (first reply may show typing)', async () => {
    await establish(RECIPIENT, SENDER);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    await sendTyping();

    expect(framesTo('conn-r')).toHaveLength(1);
  });

  it('an offline recipient produces a response byte-identical to a delivered one', async () => {
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });
    const online = await sendTyping();
    const senderFramesAfterOnline = framesTo('conn-sender').length;

    await db.deleteConnection(RECIPIENT, 'conn-r');
    const offline = await sendTyping();

    expect(JSON.stringify(offline)).toBe(JSON.stringify(online));
    // And the sender's own socket saw nothing new either time.
    expect(framesTo('conn-sender')).toHaveLength(senderFramesAfterOnline);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('a stranger with no correspondence in either direction is dropped, uniformly', async () => {
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-r')).toHaveLength(0);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('never mints correspondence — typing is automatic, not user-authored', async () => {
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    await sendTyping();

    expect(
      await db.hasQueuedCorrespondence(SENDER, RECIPIENT, Math.floor(deps.now() / 1000)),
    ).toBe(false);
  });

  it('has its own bucket: a drained wsSend does not stop typing', async () => {
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });
    while ((await deps.rateLimit.take(`wssend:${SENDER}`, LIMITS.wsSend)) === 0) {
      // drain the message bucket completely
    }

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-r')).toHaveLength(1);
  });

  it('rate-limits on its own bucket with the standard refusal', async () => {
    await establish(SENDER, RECIPIENT);
    while ((await deps.rateLimit.take(`typing:${SENDER}`, LIMITS.typing)) === 0) {
      // drain
    }

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 429 });
    const errors = framesTo('conn-sender').filter(f => f.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: 'error', code: 'rate_limited' });
  });

  it('a revoked recipient session is torn down, not delivered to — response still uniform', async () => {
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
      sessionDigest: 'digest-revoked',
    });
    wsDeps.sessionGuard = {
      active: async (digest: string) => digest === 'digest-sender-live',
    };

    const res = await wsDefaultHandler(
      {
        routeKey: '$default' as const,
        connectionId: 'conn-sender',
        senderUserId: SENDER,
        body: JSON.stringify(typingFrame()),
        sessionDigest: 'digest-sender-live',
      },
      wsDeps,
    );

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-r')).toHaveLength(0);
    expect(await db.getConnection(RECIPIENT)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-r');
  });

  it('an UNBOUND integration sender gets the uniform drop, even toward a correspondent', async () => {
    await db.createUser({
      userId: SENDER,
      createdAt: deps.now(),
      accountClass: 'integration',
    });
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-r')).toHaveLength(0);
  });

  it('payload never enters the logs', async () => {
    await establish(SENDER, RECIPIENT);
    await sendTyping(typingFrame({ payload: 'U0VDUkVUQ0FOQVJZ' }));
    expect(JSON.stringify(deps.logs)).not.toContain('U0VDUkVUQ0FOQVJZ');
  });
});

describe('integration senders', () => {
  const OWNER = '00000000000000000000WNER03';
  const PEER = '0000000000000000000PEER004';

  beforeEach(async () => {
    await db.createUser({ userId: OWNER, createdAt: deps.now() });
    // Re-mint SENDER as an integration (beforeEach above made it human).
    await db.createUser({
      userId: SENDER,
      createdAt: deps.now(),
      accountClass: 'integration',
    });
  });

  it('relays to its owner — no correspondence-ledger entry required', async () => {
    // Deliberately NO establish: the owner bind IS the relationship (the
    // predicate replaces the human stranger gate, exactly as on the send
    // path, which asks no ledger question of integrations either).
    expect(await db.bindIntegrationOwner(SENDER, RECIPIENT)).toBe('bound');
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 200 });
    const relayed = framesTo('conn-r');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ type: 'typing', from: SENDER });
    // Relay-only, still: nothing durable, nothing woken, nothing receipted.
    expect(await allQueued(db, RECIPIENT)).toHaveLength(0);
    expect(deps.pushesSent).toHaveLength(0);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('relays to a same-crew integration', async () => {
    await db.createUser({
      userId: PEER,
      createdAt: deps.now(),
      accountClass: 'integration',
    });
    expect(await db.adoptCrewMember(OWNER, SENDER, 'crew-1')).toBe('adopted');
    expect(await db.adoptCrewMember(OWNER, PEER, 'crew-1')).toBe('adopted');
    await db.putConnection({
      userId: PEER,
      connectionId: 'conn-peer',
      connectedAt: deps.now(),
    });

    const res = await sendTyping(typingFrame({ to: PEER }));

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-peer')).toHaveLength(1);
  });

  it('a BOUND integration typing to a stranger draws the drop of old — frame-level silence, byte-identical response', async () => {
    expect(await db.bindIntegrationOwner(SENDER, OWNER)).toBe('bound');
    // Give the stranger every advantage a human sender would need — live
    // connection AND established correspondence — and the drop must still be
    // indistinguishable, on the wire, from a delivered relay.
    await establish(SENDER, RECIPIENT);
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-r',
      connectedAt: deps.now(),
    });
    const dropped = await sendTyping();

    // The same frame toward the owner (connected) relays fine…
    await db.putConnection({
      userId: OWNER,
      connectionId: 'conn-owner',
      connectedAt: deps.now(),
    });
    const relayedRes = await sendTyping(typingFrame({ to: OWNER }));

    // …and the two responses are byte-identical: refusal is not observable.
    expect(JSON.stringify(dropped)).toBe(JSON.stringify(relayedRes));
    expect(framesTo('conn-r')).toHaveLength(0);
    expect(framesTo('conn-owner')).toHaveLength(1);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('a cross-crew integration recipient draws the uniform drop', async () => {
    const OTHER_OWNER = '00000000000000000000WNER23';
    await db.createUser({ userId: OTHER_OWNER, createdAt: deps.now() });
    await db.createUser({
      userId: PEER,
      createdAt: deps.now(),
      accountClass: 'integration',
    });
    expect(await db.adoptCrewMember(OWNER, SENDER, 'crew-1')).toBe('adopted');
    expect(await db.adoptCrewMember(OTHER_OWNER, PEER, 'crew-2')).toBe('adopted');
    await db.putConnection({
      userId: PEER,
      connectionId: 'conn-peer',
      connectedAt: deps.now(),
    });

    const res = await sendTyping(typingFrame({ to: PEER }));

    expect(res).toEqual({ statusCode: 200 });
    expect(framesTo('conn-peer')).toHaveLength(0);
    expect(framesTo('conn-sender')).toHaveLength(0);
  });

  it('rate-limits on the typing bucket exactly as a human sender does', async () => {
    expect(await db.bindIntegrationOwner(SENDER, RECIPIENT)).toBe('bound');
    while ((await deps.rateLimit.take(`typing:${SENDER}`, LIMITS.typing)) === 0) {
      // drain
    }

    const res = await sendTyping();

    expect(res).toEqual({ statusCode: 429 });
    const errors = framesTo('conn-sender').filter(f => f.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: 'error', code: 'rate_limited' });
  });
});
