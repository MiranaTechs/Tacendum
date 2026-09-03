import { beforeEach, describe, expect, it } from 'vitest';
import type { SendFrame, ServerFrame, TypingFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps, type WsResult } from '../src/handlers/ws.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/**
 * The predicate widening, asserted from the wire
 * side: ONE consent edge (human -> integration) admits integration->human on
 * the send arm AND that human's frames on the inbox arm; deleting it refuses
 * the NEXT frame in both directions; typing widens on the identical clause
 * and can never reach a recipient a durable send could not — before, during,
 * or after the edge.
 *
 * the error-code freeze is pinned in BYTES: a non-consented send draws
 * exactly the pre-widening `integration_recipient_forbidden` /
 * `integration_inbox_restricted` frames, code and detail verbatim — the
 * wire must not teach that a consent mechanism exists.
 *
 * Every clause of the fail-closed helper has a test that goes red when the
 * clause is deleted (the mutation-honesty rule): the edge-exists read, the
 * human-class guard, the integration-class guard, the owner-bound guard,
 * and the direction of the edge.
 */

const OWNER = '0000000000000000000MASTER1'; // int-claude's human owner
const HUMAN = '0000000000000000000PERSN01'; // the consenting co-member
const HUMAN2 = '0000000000000000000PERSN02'; // a second human, never consents
const AGENT = '0000000000000000000AGENT01'; // int-claude — bound + adopted
const AGENT2 = '0000000000000000000AGENT02'; // a same-crew sibling agent
const UNBOUND = '0000000000000000000NBND001'; // an integration paired to nobody

// The FROZEN refusals spelled out rather than imported: byte-for-byte
// what the previously deployed server answers, so any drift — a new code, a
// detail that mentions consent — turns these tests red.
const FROZEN_RECIPIENT_FORBIDDEN = {
  type: 'error',
  code: 'integration_recipient_forbidden',
  detail: 'integrations may only message their owner or their crew',
} as const;
const FROZEN_INBOX_RESTRICTED = {
  type: 'error',
  code: 'integration_inbox_restricted',
  detail: 'only the owner or a fellow crew member may message an integration',
} as const;

let db: TestOnlyDataLayer;
let deps: TestDeps;
let posted: Array<{ connectionId: string; frame: ServerFrame }>;
let wsDeps: WsDeps;

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G5F${String(msgSeq).padStart(2, '0')}`;
}

function sendFrame(to: string, over: Partial<SendFrame> = {}): SendFrame {
  return {
    type: 'send',
    to,
    msgId: nextMsgId(),
    msgType: 'ciphertext',
    payload: 'QUJD',
    ...over,
  };
}

function typingFrame(to: string): TypingFrame {
  return { type: 'typing', to, msgType: 'ciphertext', payload: 'QUJD' };
}

async function frameFrom(
  senderUserId: string,
  frame: SendFrame | TypingFrame,
): Promise<WsResult> {
  return wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId: `conn-${senderUserId}`,
      senderUserId,
      body: JSON.stringify(frame),
    },
    wsDeps,
  );
}

function framesTo(connectionId: string): ServerFrame[] {
  return posted.filter((p) => p.connectionId === connectionId).map((p) => p.frame);
}

function errorsTo(senderUserId: string): ServerFrame[] {
  return framesTo(`conn-${senderUserId}`).filter((f) => f.type === 'error');
}

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  posted = [];
  wsDeps = {
    ...deps,
    sender: {
      async post(connectionId, frame) {
        posted.push({ connectionId, frame });
        return true;
      },
    },
    scheduleDrain: async () => {},
    schedulePush: async () => {},
  };
  await db.createUser({ userId: OWNER, createdAt: deps.now() });
  await db.createUser({ userId: HUMAN, createdAt: deps.now() });
  await db.createUser({ userId: HUMAN2, createdAt: deps.now() });
  await db.createUser({
    userId: AGENT,
    createdAt: deps.now(),
    accountClass: 'integration',
    identityKeyPub: testIdentityKey(0x41),
  });
  await db.createUser({
    userId: AGENT2,
    createdAt: deps.now(),
    accountClass: 'integration',
    identityKeyPub: testIdentityKey(0x42),
  });
  await db.createUser({ userId: UNBOUND, createdAt: deps.now(), accountClass: 'integration' });
  // The REAL bind + adopt writers, as production leaves the rows.
  expect(await db.adoptCrewMember(OWNER, AGENT, 'crew-consent-1')).toBe('adopted');
  expect(await db.adoptCrewMember(OWNER, AGENT2, 'crew-consent-1')).toBe('adopted');
});

describe('the send arm (integration -> human)', () => {
  it('refuses with the FROZEN bytes when no edge exists — today’s wall stands', async () => {
    const res = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(AGENT)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    expect(await allQueued(db, HUMAN)).toHaveLength(0);
  });

  it('admits exactly the consented pair once the edge (human -> agent) exists', async () => {
    expect(await db.writeConsentEdge(HUMAN, AGENT, deps.now())).toBe('written');
    const res = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(res.statusCode).toBe(200);
    expect(errorsTo(AGENT)).toEqual([]);
    expect(await allQueued(db, HUMAN)).toHaveLength(1);
  });

  it('the edge is PAIR-scoped: a same-crew sibling agent is still refused toward the same human', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    const res = await frameFrom(AGENT2, sendFrame(HUMAN));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(AGENT2)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
  });

  it('the edge is DIRECTED: a reversed row (written under the agent’s partition) admits nothing', async () => {
    // The enforcement read is hasConsentEdge(human, agent). A row keyed the
    // other way around must not count — deleting the direction (swapping the
    // helper's operands) turns this red.
    await db.writeConsentEdge(AGENT, HUMAN, deps.now());
    const res = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(AGENT)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
  });

  it('a consented HUMAN2 edge does not admit delivery to HUMAN (no bleed across humans)', async () => {
    await db.writeConsentEdge(HUMAN2, AGENT, deps.now());
    const res = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(res.statusCode).toBe(403);
  });

  it('deleting the edge refuses the NEXT send — revocation is deletion', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    expect((await frameFrom(AGENT, sendFrame(HUMAN))).statusCode).toBe(200);
    await db.deleteConsentEdge(HUMAN, AGENT);
    const res = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(AGENT)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    expect(await allQueued(db, HUMAN)).toHaveLength(1); // only the pre-revoke frame
  });

  it('an edge toward an INTEGRATION admits nothing (the human-class guard): consent cannot widen agent->agent', async () => {
    // AGENT "consents" to AGENT2 (a hijacked agent could write this row via
    // the data layer even though the route refuses integration callers).
    // Cross-crew delivery must stay dead: the helper's human-class guard is
    // what this red-lines.
    const foreign = '0000000000000000000AGENT99';
    await db.createUser({ userId: foreign, createdAt: deps.now(), accountClass: 'integration' });
    await db.bindIntegrationOwner(foreign, HUMAN2);
    await db.writeConsentEdge(AGENT, foreign, deps.now());
    const res = await frameFrom(foreign, sendFrame(AGENT));
    expect(res.statusCode).toBe(403);
    // The SEND arm refuses first (foreign's recipient is neither its owner
    // nor same-crew nor a consenting HUMAN — AGENT is integration-class, so
    // the helper's human guard fails closed).
    expect(errorsTo(foreign)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
  });

  it('urgent stays forbidden for integrations — an edge grants no ring capability', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    const res = await frameFrom(AGENT, sendFrame(HUMAN, { urgent: true }));
    expect(res.statusCode).toBe(403);
    const errs = errorsTo(AGENT);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: 'integration_urgent_forbidden' });
  });
});

describe('the inbox arm (human -> integration)', () => {
  it('refuses with the FROZEN bytes when no edge exists', async () => {
    const res = await frameFrom(HUMAN, sendFrame(AGENT));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(HUMAN)).toEqual([FROZEN_INBOX_RESTRICTED]);
    expect(await allQueued(db, AGENT)).toHaveLength(0);
  });

  it('the SAME edge admits the human’s frames to the integration — one edge, both directions', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    const res = await frameFrom(HUMAN, sendFrame(AGENT));
    expect(res.statusCode).toBe(200);
    expect(await allQueued(db, AGENT)).toHaveLength(1);
  });

  it('deleting the ONE edge kills BOTH directions on the next frame', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    expect((await frameFrom(HUMAN, sendFrame(AGENT))).statusCode).toBe(200);
    expect((await frameFrom(AGENT, sendFrame(HUMAN))).statusCode).toBe(200);
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect((await frameFrom(HUMAN, sendFrame(AGENT))).statusCode).toBe(403);
    expect((await frameFrom(AGENT, sendFrame(HUMAN))).statusCode).toBe(403);
  });

  it('an UNBOUND integration accepts from nobody, edges notwithstanding (the owner-bound guard)', async () => {
    await db.writeConsentEdge(HUMAN, UNBOUND, deps.now());
    const res = await frameFrom(HUMAN, sendFrame(UNBOUND));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(HUMAN)).toEqual([FROZEN_INBOX_RESTRICTED]);
  });

  it('a non-consenting second human is still refused (the pair scope, inbox side)', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    const res = await frameFrom(HUMAN2, sendFrame(AGENT));
    expect(res.statusCode).toBe(403);
    expect(errorsTo(HUMAN2)).toEqual([FROZEN_INBOX_RESTRICTED]);
  });
});

describe('the crew-revoke tombstone outranks every edge', () => {
  it('a revoked agent is refused in both directions even while a live edge names it', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    // The owner's revoke, as integrationRevokeHandler leaves the store:
    // identity key tombstoned, user row + crew slot gone in one transaction.
    await db.tombstoneIdentityKey(testIdentityKey(0x41));
    await db.deleteCrewMemberAndReleaseSlot(AGENT, OWNER);
    // The edge still exists…
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(true);
    // …and admits NOTHING: the send arm fails closed on the sender row being
    // gone, the inbox arm on the recipient row being gone.
    const fromAgent = await frameFrom(AGENT, sendFrame(HUMAN));
    expect(fromAgent.statusCode).toBe(403);
    expect(errorsTo(AGENT)).toEqual([
      { type: 'error', code: 'unknown_sender', detail: 'account no longer exists' },
    ]);
    const toAgent = await frameFrom(HUMAN, sendFrame(AGENT));
    expect(toAgent.statusCode).toBe(404);
  });
});

describe('typing parity — never reaches whom a durable send could not', () => {
  async function connect(userId: string, connectionId: string): Promise<void> {
    await db.putConnection({ userId, connectionId, connectedAt: deps.now() });
  }

  it('integration -> human: dropped before the edge, relayed with it, dropped after deletion — always uniform 200', async () => {
    await connect(HUMAN, 'conn-h');
    // BEFORE: durable refused, typing silent.
    expect((await frameFrom(AGENT, typingFrame(HUMAN))).statusCode).toBe(200);
    expect(framesTo('conn-h')).toHaveLength(0);
    // WITH the edge: durable admitted, typing relays — the identical clause.
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    expect((await frameFrom(AGENT, typingFrame(HUMAN))).statusCode).toBe(200);
    expect(framesTo('conn-h').filter((f) => f.type === 'typing')).toHaveLength(1);
    // AFTER deletion: durable refused again, typing silent again.
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect((await frameFrom(AGENT, typingFrame(HUMAN))).statusCode).toBe(200);
    expect(framesTo('conn-h').filter((f) => f.type === 'typing')).toHaveLength(1);
  });

  it('human -> integration: the correspondence ledger alone no longer suffices once the edge is deleted', async () => {
    await connect(AGENT, 'conn-a');
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    // A DELIVERED durable send while consented mints the correspondence
    // ledger — the state that used to be an honest proxy for the inbox
    // predicate and stops being one the moment edges are deletable.
    expect((await frameFrom(HUMAN, sendFrame(AGENT))).statusCode).toBe(200);
    expect((await frameFrom(HUMAN, typingFrame(AGENT))).statusCode).toBe(200);
    const relayedWhileConsented = framesTo('conn-a').filter((f) => f.type === 'typing').length;
    expect(relayedWhileConsented).toBe(1);
    // Revoke. The ledger is still established — and typing must STOP anyway
    // (deleting the human-branch inbox clause in handleTyping is exactly
    // what turns this red: the durable send below is refused while typing
    // would keep relaying on the stale ledger for ~30 days).
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect((await frameFrom(HUMAN, sendFrame(AGENT))).statusCode).toBe(403);
    expect((await frameFrom(HUMAN, typingFrame(AGENT))).statusCode).toBe(200);
    expect(framesTo('conn-a').filter((f) => f.type === 'typing')).toHaveLength(
      relayedWhileConsented,
    );
  });

  it('human -> human typing is byte-identical to before the widening', async () => {
    // Establish correspondence and relay — the previous behaviour, pinned
    // so the new recipient read on the human branch changes no outcome.
    await db.enqueueMessage(
      {
        recipientId: HUMAN2,
        msgId: nextMsgId(),
        senderId: HUMAN,
        type: 'ciphertext',
        payload: 'QUJD',
        ts: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 3600,
      },
      { establishesCorrespondence: true },
    );
    await connect(HUMAN2, 'conn-h2');
    expect((await frameFrom(HUMAN, typingFrame(HUMAN2))).statusCode).toBe(200);
    expect(framesTo('conn-h2').filter((f) => f.type === 'typing')).toHaveLength(1);
  });

  it('the integration typing branch pays the SAME edge read for a nonexistent target as for an existing-but-refused one (no avoidable timing tell)', async () => {
    // The uniformity this branch claims is that its refusal outcomes are
    // indistinguishable. Short-circuiting the consent read for a target
    // with no user row made "no such account" one strongly consistent
    // GetItem cheaper than "exists but refused" — measurable the moment any
    // synchronous ack exists. Red-first: deleting the burn read in
    // handleTyping's `recipient === undefined` arm drops the nonexistent
    // case to zero edge reads and this comparison fails.
    let edgeReads = 0;
    const counting: TestOnlyDataLayer = {
      ...db,
      async hasConsentEdge(userId, agentId) {
        edgeReads += 1;
        return db.hasConsentEdge(userId, agentId);
      },
    };
    wsDeps = { ...wsDeps, db: counting };
    const NOBODY = '0000000000000000000NBDY001';
    edgeReads = 0;
    expect((await frameFrom(AGENT, typingFrame(NOBODY))).statusCode).toBe(200);
    const nonexistentCost = edgeReads;
    edgeReads = 0;
    expect((await frameFrom(AGENT, typingFrame(HUMAN2))).statusCode).toBe(200); // exists, refused
    const refusedCost = edgeReads;
    expect(nonexistentCost).toBe(1);
    expect(refusedCost).toBe(1);
  });
});

describe('consentAdmits — the fail-closed guards, called direct (the mutation-honesty debt)', () => {
  // The integration-class guard is redundant at all four CURRENT call sites
  // (each establishes the integration operand's class in its enclosing
  // condition), which is exactly why it exists — a FIFTH site must fail
  // closed — and exactly why no handler-driven test can turn its deletion
  // red. This direct call is what makes the header's mutation-honesty claim
  // true: delete `integration.accountClass === 'integration' &&` and the
  // first assertion goes green-to-red.
  it('an edge whose "integration" operand is human-class admits nothing — and every sibling guard still holds', async () => {
    const { consentAdmits } = await import('../src/handlers/ws.js');
    await db.writeConsentEdge(HUMAN, HUMAN2, deps.now()); // edge exists
    const human = { userId: HUMAN };
    // The integration-class guard: same edge, same owner binding, wrong
    // class on the integration side.
    expect(
      await consentAdmits(human, { userId: HUMAN2, ownerUserId: OWNER }, { db }),
    ).toBe(false);
    // The control: with the class right, the same operands admit.
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    expect(
      await consentAdmits(
        human,
        { userId: AGENT, accountClass: 'integration', ownerUserId: OWNER },
        { db },
      ),
    ).toBe(true);
    // The owner-bound guard, direct for symmetry.
    expect(
      await consentAdmits(
        human,
        { userId: AGENT, accountClass: 'integration', ownerUserId: '' },
        { db },
      ),
    ).toBe(false);
    // The human-class guard, direct for symmetry.
    expect(
      await consentAdmits(
        { userId: HUMAN, accountClass: 'integration' },
        { userId: AGENT, accountClass: 'integration', ownerUserId: OWNER },
        { db },
      ),
    ).toBe(false);
  });
});
