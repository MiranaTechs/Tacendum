import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES, type ServerFrame } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import {
  drainQueuedMessages,
  wsDefaultHandler,
  type WsDeps,
  type WsResult,
} from '../src/handlers/ws.js';
import { LIMITS } from '../src/ratelimit.js';
import { allQueued, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * Crew-scoped send + inbox widening and the per-recipient push
 * ceiling driven through the REAL ws handlers against REAL DynamoDB
 * Local — the db is never mocked, because the rows under test (crewId,
 * crewCount, ownerUserId) are written by the real bind and the adopt
 * transaction, and the predicates must be proven against exactly what those
 * writes leave behind. Only the transport (sender/schedulePush) is a recording fake, as in
 * ws.test.ts. Skips when DynamoDB Local is down unless TACENDUM_REQUIRE_DDB=1.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;

/** Run-unique, digits-only (valid Crockford base32) ULIDs, so reruns against a
 * persistent DynamoDB Local never collide with a previous run's rows — or with
 * crew.test.ts, whose scheme lacks this file's `9`-marker segment. */
const RUN = `${Date.now()}`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}9${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

const createdUsers: string[] = [];

/** Create an account row directly at the data layer (the routing suites'
 * pattern — auth has its own suites). `owner` binds via the real write-once
 * bind, exactly as pairing would leave the row: bound but NOT in any crew. */
async function mkUser(opts: { cls?: 'integration'; owner?: string } = {}): Promise<string> {
  const userId = uid();
  createdUsers.push(userId);
  await db.createUser({
    userId,
    createdAt: Date.now(),
    ...(opts.cls ? { accountClass: opts.cls } : {}),
  });
  if (opts.owner) {
    expect(await db.bindIntegrationOwner(userId, opts.owner)).toBe('bound');
  }
  return userId;
}

/** Adopt through the REAL transaction — the only writer of crewId — so the
 * rows the predicates see are the rows production would hold. Pairing comes
 * first, as production requires: adoption never claims, so an
 * unbound member would refuse owner_conflict. */
async function adopt(owner: string, member: string): Promise<void> {
  expect(await db.bindIntegrationOwner(member, owner)).toBe('bound');
  expect(await db.adoptCrewMember(owner, member, `crew-ws-${RUN}-${owner.slice(-6)}`)).toBe(
    'adopted',
  );
}

let deps: TestDeps;
let wsDeps: WsDeps;
let inbox: Map<string, ServerFrame[]>;
let scheduled: Array<{
  recipientId: string;
  senderUserId: string;
  kind: 'call' | 'message';
}>;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  db = makeDataLayer(doc);
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
});

afterAll(async () => {
  if (!available) return;
  for (const userId of createdUsers) {
    await db.purgeQueuedMessages(userId);
    await doc.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId } }));
  }
});

beforeEach(() => {
  deps = makeTestDeps(db);
  inbox = new Map();
  scheduled = [];
  wsDeps = {
    ...deps,
    sender: {
      async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
        const frames = inbox.get(connectionId) ?? [];
        frames.push(frame);
        inbox.set(connectionId, frames);
        return true;
      },
    },
    scheduleDrain: async () => {},
    // EVERY parameter named (the ws.urgent.test.ts lesson: a fake narrower
    // than the real signature is a fake that cannot see the bug).
    schedulePush: async (recipientId, senderUserId, kind, _message) => {
      scheduled.push({ recipientId, senderUserId, kind: kind ?? 'call' });
    },
  };
});

async function send(
  from: string,
  to: string,
  overrides: { msgId?: string; urgent?: boolean; notify?: boolean } = {},
): Promise<WsResult> {
  return wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId: `conn-${from}`,
      senderUserId: from,
      body: JSON.stringify({
        type: 'send',
        to,
        msgId: overrides.msgId ?? uid(),
        msgType: 'ciphertext',
        payload: 'QUJD',
        ...(overrides.urgent !== undefined ? { urgent: overrides.urgent } : {}),
        ...(overrides.notify !== undefined ? { notify: overrides.notify } : {}),
      }),
    },
    wsDeps,
  );
}

/** The most recent error frame posted back to `from`'s socket. */
function errorCode(from: string): string | undefined {
  const frames = inbox.get(`conn-${from}`) ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f?.type === 'error') return f.code;
  }
  return undefined;
}

/** The most recent receipt state posted back to `from`'s socket. */
function receiptState(from: string): string | undefined {
  const frames = inbox.get(`conn-${from}`) ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f?.type === 'receipt') return f.state;
  }
  return undefined;
}

async function queuedFor(userId: string): Promise<number> {
  return (await allQueued(db, userId)).length;
}

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('the send predicate', () => {
  gated('two crew members exchange messages, both directions', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    const a2 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);
    await adopt(owner, a2);

    expect((await send(a1, a2)).statusCode).toBe(200);
    expect(receiptState(a1)).toBe('sent');
    expect(await queuedFor(a2)).toBe(1);

    expect((await send(a2, a1)).statusCode).toBe(200);
    expect(receiptState(a2)).toBe('sent');
    expect(await queuedFor(a1)).toBe(1);
  });

  gated('a crew member still reaches its owner', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    expect((await send(a1, owner)).statusCode).toBe(200);
    expect(await queuedFor(owner)).toBe(1);
  });

  gated('a crew member cannot reach an integration in a DIFFERENT crew', async () => {
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    const b1 = await mkUser({ cls: 'integration' });
    await adopt(ownerA, a1);
    await adopt(ownerB, b1);

    expect((await send(a1, b1)).statusCode).toBe(403);
    expect(errorCode(a1)).toBe('integration_recipient_forbidden');
    expect(await queuedFor(b1)).toBe(0);
  });

  gated('a crew member cannot reach a crewless integration — even one its own owner bound', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);
    // Bound to the SAME human, never adopted: ownership is not membership.
    const loner = await mkUser({ cls: 'integration', owner });

    expect((await send(a1, loner)).statusCode).toBe(403);
    expect(errorCode(a1)).toBe('integration_recipient_forbidden');
    expect(await queuedFor(loner)).toBe(0);
  });

  gated('a crew member cannot reach a human who is not its owner', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    expect((await send(a1, stranger)).statusCode).toBe(403);
    expect(errorCode(a1)).toBe('integration_recipient_forbidden');
    expect(await queuedFor(stranger)).toBe(0);
  });

  gated('an already-deployed (crewless) integration gains nothing: no other integration, ever', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);
    const deployed = await mkUser({ cls: 'integration', owner });

    // Not even a crew member of its OWN owner's crew...
    expect((await send(deployed, a1)).statusCode).toBe(403);
    expect(errorCode(deployed)).toBe('integration_recipient_forbidden');
    expect(await queuedFor(a1)).toBe(0);
    // ...while its one pre-crew capability — the owner — still works.
    expect((await send(deployed, owner)).statusCode).toBe(200);
    expect(await queuedFor(owner)).toBe(1);
  });

  gated('two crewless integrations owned by DIFFERENT humans are refused — undefined === undefined must not form a crew', async () => {
    // THE named case. Neither row carries a crewId,
    // so an unguarded `sender.crewId === recipient.crewId` is
    // `undefined === undefined` — true — and every crewless integration in
    // the system would form one mutual, cross-tenant crew on deploy.
    const ownerX = await mkUser();
    const ownerY = await mkUser();
    const botOfX = await mkUser({ cls: 'integration', owner: ownerX });
    const botOfY = await mkUser({ cls: 'integration', owner: ownerY });

    expect((await send(botOfX, botOfY)).statusCode).toBe(403);
    expect(errorCode(botOfX)).toBe('integration_recipient_forbidden');
    expect(await queuedFor(botOfY)).toBe(0);
  });

  gated('urgent from a crew member is still refused', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    const a2 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);
    await adopt(owner, a2);

    expect((await send(a1, a2, { urgent: true })).statusCode).toBe(403);
    expect(errorCode(a1)).toBe('integration_urgent_forbidden');
    expect(await queuedFor(a2)).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  gated('an integration sending to a nonexistent ULID gets 404 — the deliberate code change', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    expect((await send(a1, uid())).statusCode).toBe(404);
    expect(errorCode(a1)).toBe('unknown_recipient');
  });

  gated('a rate-limited integration cannot use free sends to probe for accounts', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    // Spend the class quota directly (going through handleSend would burn the
    // ws flood bucket too — a different limiter doing a different job).
    while ((await deps.rateLimit.take(`intsend:${a1}`, LIMITS.integrationSend)) === 0) {
      // drain
    }

    // The oracle costs a token BEFORE the recipient read: over quota, the
    // probe answers 429 whether or not the ULID exists.
    expect((await send(a1, uid())).statusCode).toBe(429);
    expect(errorCode(a1)).toBe('rate_limited');
    expect((await send(a1, owner)).statusCode).toBe(429);
  });
});

describe('the inbox predicate', () => {
  gated('the owner still reaches its crew member', async () => {
    const owner = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    expect((await send(owner, a1)).statusCode).toBe(200);
    expect(await queuedFor(a1)).toBe(1);
  });

  gated('a human stranger cannot fill a crew member inbox', async () => {
    // The inbox mirror of the no-crewId refusal: the stranger has no crewId,
    // the member has one — not both-non-null-equal, and not the owner.
    const owner = await mkUser();
    const stranger = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    await adopt(owner, a1);

    expect((await send(stranger, a1)).statusCode).toBe(403);
    expect(errorCode(stranger)).toBe('integration_inbox_restricted');
    expect(await queuedFor(a1)).toBe(0);
  });

  gated('a crew OWNER cannot reach an integration in someone else crew', async () => {
    // The inbox mirror of the different-crewId refusal: both rows carry a
    // crewId, and they differ — an owner's own crew opens nobody else's bots.
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const a1 = await mkUser({ cls: 'integration' });
    const b1 = await mkUser({ cls: 'integration' });
    await adopt(ownerA, a1);
    await adopt(ownerB, b1);

    expect((await send(ownerA, b1)).statusCode).toBe(403);
    expect(errorCode(ownerA)).toBe('integration_inbox_restricted');
    expect(await queuedFor(b1)).toBe(0);
  });

  gated('a crewless human stranger cannot reach a crewless integration — undefined === undefined at the inbox site', async () => {
    // The inbox-site twin of the named send-predicate case: neither the human
    // stranger nor the deployed integration has a crewId. An unguarded inbox
    // equality would open every deployed bot's queue to every human — the
    // dead-drop capability the inbox restriction exists to prevent.
    const owner = await mkUser();
    const stranger = await mkUser();
    const deployed = await mkUser({ cls: 'integration', owner });

    expect((await send(stranger, deployed)).statusCode).toBe(403);
    expect(errorCode(stranger)).toBe('integration_inbox_restricted');
    expect(await queuedFor(deployed)).toBe(0);
  });
});

describe('a human sender is byte-identical to today', () => {
  gated('human -> human: sent receipt, queued, message wake scheduled', async () => {
    const alice = await mkUser();
    const bob = await mkUser();

    expect((await send(alice, bob)).statusCode).toBe(200);
    expect(receiptState(alice)).toBe('sent');
    expect(errorCode(alice)).toBeUndefined();
    expect(await queuedFor(bob)).toBe(1);
    expect(scheduled).toEqual([{ recipientId: bob, senderUserId: alice, kind: 'message' }]);
  });

  gated('human -> unknown ULID: 404 unknown_recipient, nothing queued', async () => {
    const alice = await mkUser();
    const ghost = uid();

    expect((await send(alice, ghost)).statusCode).toBe(404);
    expect(errorCode(alice)).toBe('unknown_recipient');
    expect(await queuedFor(ghost)).toBe(0);
  });

  gated('a human may still send urgent — the refusal is class-scoped', async () => {
    const alice = await mkUser();
    const bob = await mkUser();

    expect((await send(alice, bob, { urgent: true })).statusCode).toBe(200);
    expect(errorCode(alice)).toBeUndefined();
    expect(scheduled).toEqual([{ recipientId: bob, senderUserId: alice, kind: 'call' }]);
  });
});

describe('the per-recipient push ceiling', () => {
  gated('N senders stop waking one recipient at the ceiling; every message still delivers', async () => {
    const victim = await mkUser();
    const other = await mkUser();
    const senders: string[] = [];
    const capacity = LIMITS.pushMessageRecipient.capacity;
    for (let i = 0; i < capacity + 2; i++) senders.push(await mkUser());

    // Each sender is fresh — comfortably inside its OWN pushmsg budget — yet
    // together they cross the victim's ceiling: the flood no per-sender
    // bucket can see.
    for (const s of senders) {
      expect((await send(s, victim)).statusCode).toBe(200);
    }

    const wakes = scheduled.filter((p) => p.recipientId === victim && p.kind === 'message');
    expect(wakes).toHaveLength(capacity);
    expect(
      deps.logs.filter((l) => l.event === 'push_suppressed_recipient_rate_limited'),
    ).toHaveLength(2);

    // Suppressed the WAKE, never the message: every frame is durably queued...
    expect(await queuedFor(victim)).toBe(capacity + 2);
    // ...and deliverable — the whole queue drains to the victim's next socket,
    // the two suppressed frames included.
    expect((await drainQueuedMessages(victim, 'conn-victim', wsDeps)).outcome).toBe('complete');
    const drained = (inbox.get('conn-victim') ?? []).filter((f) => f.type === 'msg');
    expect(drained).toHaveLength(capacity + 2);

    // The ceiling is the VICTIM's, not the system's: the sender whose wake
    // was just suppressed still wakes a DIFFERENT recipient.
    const spent = senders[senders.length - 1];
    expect(spent).toBeDefined();
    if (!spent) return;
    expect((await send(spent, other)).statusCode).toBe(200);
    expect(scheduled.filter((p) => p.recipientId === other && p.kind === 'message')).toHaveLength(1);
    expect(await queuedFor(other)).toBe(1);
  });

  gated('a sender its own bucket already refused cannot drain the victim shared budget', async () => {
    // The recipient token is taken SECOND: a suppressed-by-sender-bucket wake
    // must not spend the victim's shared budget, or one over-budget sender
    // could silence everyone else's banners to that person — the exact
    // property the sender-keyed bucket was built to protect.
    const victim = await mkUser();
    const flooder = await mkUser();
    while ((await deps.rateLimit.take(`pushmsg:${flooder}`, LIMITS.pushMessage)) === 0) {
      // drain the flooder's own message-push budget
    }

    expect((await send(flooder, victim)).statusCode).toBe(200);
    expect(scheduled).toHaveLength(0); // sender-bucket suppression

    // The victim's FULL recipient budget is still there for everyone else.
    const capacity = LIMITS.pushMessageRecipient.capacity;
    for (let i = 0; i < capacity; i++) {
      const s = await mkUser();
      expect((await send(s, victim)).statusCode).toBe(200);
    }
    expect(scheduled.filter((p) => p.recipientId === victim)).toHaveLength(capacity);
  });

  gated('one sender cannot monopolise the victim ceiling: capped at its pair share, refused from its OWN budget', async () => {
    // The denial-of-notification shape records: a single
    // sender's own pushMessage budget (30/min) exceeds the victim's whole
    // shared ceiling (12/min since rooms raised it; 10 when this was written,
    // and the argument is unchanged either way — 30 still exceeds it), so
    // with only the shared bucket one compromised
    // crew member drains it and then eats each refill token — suppressing
    // every OTHER agent's wakes while their messages sit queued. The
    // pair-keyed fair share bounds the monopolist without touching anyone
    // else's tokens.
    const victim = await mkUser();
    const monopolist = await mkUser();
    const pairCap = LIMITS.pushMessagePair.capacity;
    const rcptCap = LIMITS.pushMessageRecipient.capacity;
    // The sizes only mean anything in this order: a pair share at or above
    // the ceiling would be no fair share at all.
    expect(pairCap).toBeLessThan(rcptCap);

    // The monopolist stays far inside its OWN sender budget — the attack's
    // exact shape: within-budget per bucket that exists, hostile in sum.
    for (let i = 0; i < rcptCap + 2; i++) {
      expect((await send(monopolist, victim)).statusCode).toBe(200);
    }
    // Its wakes stop at the PAIR bound, well short of the whole ceiling, and
    // under the distinct suppression reason...
    expect(scheduled.filter((p) => p.recipientId === victim)).toHaveLength(pairCap);
    expect(deps.logs.filter((l) => l.event === 'push_suppressed_pair_rate_limited')).toHaveLength(
      rcptCap + 2 - pairCap,
    );
    // ...and each refusal was paid from the PAIR bucket, never the shared
    // one: the remaining recipient budget is still there for everyone else.
    const others: string[] = [];
    for (let i = 0; i < rcptCap - pairCap; i++) others.push(await mkUser());
    for (const s of others) {
      expect((await send(s, victim)).statusCode).toBe(200);
    }
    expect(scheduled.filter((p) => p.recipientId === victim)).toHaveLength(rcptCap);

    // The AGGREGATE ceiling still holds exactly: one more fresh sender is
    // refused by the recipient bucket, not the pair bucket.
    const oneMore = await mkUser();
    expect((await send(oneMore, victim)).statusCode).toBe(200);
    expect(scheduled.filter((p) => p.recipientId === victim)).toHaveLength(rcptCap);
    expect(
      deps.logs.filter((l) => l.event === 'push_suppressed_recipient_rate_limited'),
    ).toHaveLength(1);

    // Suppression touched WAKES only: every frame, the monopolist's included,
    // is durably queued for delivery.
    expect(await queuedFor(victim)).toBe(rcptCap + 2 + others.length + 1);
  });

  gated('the ceiling is message-shaped: a spent banner budget never silences a RING', async () => {
    const victim = await mkUser();
    const caller = await mkUser();
    while (
      (await deps.rateLimit.take(`pushmsg-rcpt:${victim}`, LIMITS.pushMessageRecipient)) === 0
    ) {
      // spend the victim's entire recipient banner budget
    }

    expect((await send(caller, victim, { urgent: true })).statusCode).toBe(200);
    expect(scheduled).toEqual([{ recipientId: victim, senderUserId: caller, kind: 'call' }]);
  });
});
