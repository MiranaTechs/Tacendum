import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  CONSENT_MAX_EDGES,
  CREW_MAX_MEMBERS,
  linkOpSignedBytes,
  TABLES,
  type LinkOp,
  type LinkOpTuple,
  type SendFrame,
  type ServerFrame,
  type TypingFrame,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  groupRowKey,
  IDKEY_CLAIM_PREFIX,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
  type DeviceClass,
} from '../src/db/data.js';
import { ownerGroupAdmits, wsDefaultHandler, type WsDeps, type WsResult } from '../src/handlers/ws.js';
import { crewAdoptHandler } from '../src/handlers/crew.js';
import { consentWriteHandler } from '../src/handlers/consent.js';
import { accountsRefusal, linkOfferInitHandler } from '../src/handlers/devices.js';
import { deviceRevokeRoute, deviceUnlinkRoute } from '../src/handlers/devices-signed.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * Group-aware agent reach + per-group caps against
 * REAL DynamoDB — the pins, conditions, and the widened predicate are all
 * store behavior no memory double can prove.
 *
 * What this suite pins:
 * - an agent bound to the owner's phone ULID reaches the owner's tablet
 * ULID (the predicate widened at read time; `ownerUserId` never migrates) but NOT a non-member ULID — and the refusal bytes are the FROZEN
 * previous frames (the wire must not teach that grouping exists);
 * - an integration-class account offered a device-link slot is REFUSED in
 * the TRANSACTION (`attribute_not_exists(accountClass)` — the human-class
 * transaction precedent), not merely by a handler precheck;
 * - a 3-device owner still caps at 8 crew adoptions — the 9th fails (caps
 * count per GROUP, driven through the real adopt handler + transaction);
 * - all three binding fates: amicable unlink leaves the binding on the
 * standalone device and KILLS group reach; revoke-lost/stolen tombstones
 * the binding in the SAME transaction; and the link transaction's
 * per-group cap condition refuses a merge that would exceed 8 crew / 16
 * consent edges (belt-and-braces for any future pristineness relaxation).
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;
/** Process-local flag override (the accounts-link rule: the real row is a
 * store-wide singleton other suites toggle). Mutable so the kill-switch case
 * can restore the shipped per-ULID predicate. */
let flagOn = true;

// Digits only; '33' is this FILE's discriminator (the accounts-link '31' /
// revoke-teardown '32' rule: parallel heavy forks load within one
// millisecond and a bare Date.now() minted colliding ULIDs across files).
const RUN = `${Date.now()}33`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

interface Acct {
  userId: string;
  key: PrivateKey;
  pub: string;
  token: string;
}

let deps: TestDeps;
let posted: Array<{ connectionId: string; frame: ServerFrame }>;
let wsDeps: WsDeps;

// The FROZEN refusals (/ consent.ws.test.ts): byte-for-byte what the
// previous server answers, so any drift — a new code, a detail that mentions
// grouping — turns these tests red.
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

function freshDeps(): void {
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
}

async function mkAcct(accountClass?: 'integration'): Promise<Acct> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now(), accountClass);
  expect(res.kind).toBe('ok');
  const token = `reach-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 3600,
  });
  return { userId, key, pub, token };
}

function post(token: string, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

function sign(op: LinkOp, tuple: LinkOpTuple, key: PrivateKey): string {
  const pre = linkOpSignedBytes(op, tuple);
  const buf = new Uint8Array(new ArrayBuffer(pre.length));
  buf.set(pre);
  return Buffer.from(key.sign(buf)).toString('base64');
}

let msgSeq = 0;
function sendFrame(to: string): SendFrame {
  msgSeq += 1;
  return {
    type: 'send',
    to,
    msgId: `01ARZ3NDEKTSV4RRFFQ69G5F${String(msgSeq).padStart(2, '0')}`,
    msgType: 'ciphertext',
    payload: 'QUJD',
  };
}

function typingFrame(to: string): TypingFrame {
  return { type: 'typing', to, msgType: 'ciphertext', payload: 'QUJD' };
}

async function frameFrom(senderUserId: string, frame: SendFrame | TypingFrame): Promise<WsResult> {
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

function errorsTo(senderUserId: string): ServerFrame[] {
  return posted
    .filter((p) => p.connectionId === `conn-${senderUserId}`)
    .map((p) => p.frame)
    .filter((f) => f.type === 'error');
}

/** A phone+tablet group built through the real link transaction (signature
 * strings are the data layer's concern only here; the HANDLER paths under
 * test verify real signatures on the mutations they drive). */
async function mkGroup(): Promise<{ groupId: string; a: Acct; b: Acct }> {
  const a = await mkAcct();
  const b = await mkAcct();
  const groupId = uid();
  const nonce = uid();
  const expiresAt = Math.floor(deps.now() / 1000) + 600;
  expect(
    await db.putLinkOffer({
      offerNonce: nonce,
      groupId,
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
      expiresAt,
      offerSig: `offer-sig-${nonce}`,
    }),
  ).toBe('created');
  expect(
    await db.linkDeviceToGroup({
      offerNonce: nonce,
      acceptSig: `accept-sig-${nonce}`,
      nowSeconds: Math.floor(deps.now() / 1000),
      linkedAtMs: deps.now(),
    }),
  ).toBe('linked');
  return { groupId, a, b };
}

/** Plant the FUTURE-STATE 3-member roster directly (phone+tablet+desktop).
 * The desktop slot is schema-reserved and its ceremony REFUSED in v1
 * so no route can build this state today — which is exactly why the
 * per-group cap must already hold for it: the cap machinery, not the slot
 * reservation, is what keeps a 3-device owner at 8 crew slots the day a
 * desktop class lands. Raw writes, deliberately, with the same derived
 * bookkeeping the link transaction maintains. */
async function mk3Group(): Promise<{ groupId: string; members: Acct[] }> {
  const x = await mkAcct();
  const y = await mkAcct();
  const z = await mkAcct();
  const groupId = uid();
  const classes: DeviceClass[] = ['phone', 'tablet', 'desktop'];
  const members = [x, y, z];
  await doc.send(
    new PutCommand({
      TableName: SERVER_TABLES.users,
      Item: {
        userId: groupRowKey(groupId),
        members: members.map((m, i) => ({ userId: m.userId, class: classes[i], linkedAt: deps.now() })),
        memberClasses: new Set(classes),
        memberIds: new Set(members.map((m) => m.userId)),
        identifierRefs: [],
        epoch: 3,
        createdAt: deps.now(),
      },
    }),
  );
  for (const m of members) {
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: m.userId },
        UpdateExpression: 'SET groupId = :g',
        ExpressionAttributeValues: { ':g': groupId },
      }),
    );
  }
  return { groupId, members };
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

/** Adopt a fresh bound integration into `owner`'s crew via the REAL handler,
 * returning the handler's status code. Each call runs under fresh deps so
 * the per-caller adopt quota never interferes with what the cap test pins. */
async function adoptFresh(owner: Acct): Promise<number> {
  const agent = await mkAcct('integration');
  expect(await db.bindIntegrationOwner(agent.userId, owner.userId)).toBe('bound');
  const hdeps = makeTestDeps(db);
  const res = await crewAdoptHandler(
    post(owner.token, { member: agent.userId }),
    hdeps,
    { userId: owner.userId },
  );
  return res.statusCode;
}

/** Write a consent edge from `member` to a fresh integration via the REAL
 * route; return whether the edge was actually stored (the route answers the
 * uniform 204 either way). */
async function consentFresh(member: Acct): Promise<boolean> {
  const agent = await mkAcct('integration');
  await db.bindIntegrationOwner(agent.userId, member.userId);
  const hdeps = makeTestDeps(db);
  const res = await consentWriteHandler(
    post(member.token, { agent: agent.userId }),
    hdeps,
    { userId: member.userId },
  );
  expect(res.statusCode).toBe(204);
  return db.hasConsentEdge(member.userId, agent.userId);
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  db = { ...base, isAccountsFeatureEnabled: async () => flagOn };
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

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    flagOn = true;
    await fn();
  });
}

describe('group-aware reach ("owner" resolves to the owner\'s group at predicate time)', () => {
  gated('an agent bound to the phone reaches the tablet — and NOT a non-member — with the frozen refusal bytes', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    const stranger = await mkAcct();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');

    // The solo clause, unchanged: the exact bound owner.
    expect((await frameFrom(agent.userId, sendFrame(a.userId))).statusCode).toBe(200);
    // The widened clause: the owner's OTHER device, no bind change anywhere
    // (the row still names only the phone).
    expect((await frameFrom(agent.userId, sendFrame(b.userId))).statusCode).toBe(200);
    expect(await allQueued(db, b.userId)).toHaveLength(1);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.ownerUserId).toBe(
      a.userId,
    );
    // NOT a non-member, and the refusal is the FROZEN previous byte stream.
    const refused = await frameFrom(agent.userId, sendFrame(stranger.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    expect(await allQueued(db, stranger.userId)).toHaveLength(0);
  });

  gated('the inbox arm widens on the IDENTICAL helper: the tablet may message the phone\'s agent; a stranger may not', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    const stranger = await mkAcct();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');

    expect((await frameFrom(b.userId, sendFrame(agent.userId))).statusCode).toBe(200);
    expect(await allQueued(db, agent.userId)).toHaveLength(1);
    const refused = await frameFrom(stranger.userId, sendFrame(agent.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(stranger.userId)).toEqual([FROZEN_INBOX_RESTRICTED]);
  });

  gated('typing widens identically and never reaches whom a durable send could not — always the uniform 200', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    const stranger = await mkAcct();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');
    await db.putConnection({
      userId: b.userId,
      connectionId: 'conn-tablet',
      connectedAt: deps.now(),
    });
    await db.putConnection({
      userId: stranger.userId,
      connectionId: 'conn-stranger',
      connectedAt: deps.now(),
    });

    expect((await frameFrom(agent.userId, typingFrame(b.userId))).statusCode).toBe(200);
    expect(posted.filter((p) => p.connectionId === 'conn-tablet')).toHaveLength(1);
    expect((await frameFrom(agent.userId, typingFrame(stranger.userId))).statusCode).toBe(200);
    expect(posted.filter((p) => p.connectionId === 'conn-stranger')).toHaveLength(0);
  });

  gated('the kill switch restores the shipped per-ULID predicate: flag OFF, the sibling is refused while the exact owner still works', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');
    expect((await frameFrom(agent.userId, sendFrame(b.userId))).statusCode).toBe(200);

    flagOn = false;
    const refused = await frameFrom(agent.userId, sendFrame(b.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    // Reach WIDENING is a group-aware capability grant and collapses with
    // the flag; the exact-owner clause is shipped
    // behavior and survives.
    expect((await frameFrom(agent.userId, sendFrame(a.userId))).statusCode).toBe(200);
  });

  gated('ownerGroupAdmits fails closed on every operand (the consentAdmits mutation-honesty rule)', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    const wsDb = { db } as Pick<WsDeps, 'db'>;
    const bRow = (await db.getUserById(b.userId))!;
    // Not integration-class ⇒ never admits, rows notwithstanding.
    expect(await ownerGroupAdmits({ ownerUserId: a.userId }, bRow, wsDb)).toBe(false);
    // Unbound ⇒ never admits.
    expect(
      await ownerGroupAdmits({ accountClass: 'integration', ownerUserId: '' }, bRow, wsDb),
    ).toBe(false);
    // A tombstoned counterparty ⇒ never admits, even as a roster member.
    expect(
      await ownerGroupAdmits(
        { accountClass: 'integration', ownerUserId: a.userId },
        { ...bRow, tombstoned: true },
        wsDb,
      ),
    ).toBe(false);
    // An integration-class counterparty ⇒ never admits (agent-to-agent can
    // never ride the owner clause, whatever its rows claim).
    expect(
      await ownerGroupAdmits(
        { accountClass: 'integration', ownerUserId: a.userId },
        { ...bRow, accountClass: 'integration' },
        wsDb,
      ),
    ).toBe(false);
    // A counterparty in a DIFFERENT group ⇒ never admits.
    const { b: otherB } = await mkGroup();
    expect(
      await ownerGroupAdmits(
        { accountClass: 'integration', ownerUserId: a.userId },
        (await db.getUserById(otherB.userId))!,
        wsDb,
      ),
    ).toBe(false);
    // The honest positive, for mutation-honesty's sake.
    expect(
      await ownerGroupAdmits({ accountClass: 'integration', ownerUserId: a.userId }, bRow, wsDb),
    ).toBe(true);
  });
});

describe('integration-class link refusal (refused in the TRANSACTION)', () => {
  gated('an integration-class acceptor is refused by the link transaction itself — no group row, no groupId', async () => {
    freshDeps();
    const human = await mkAcct();
    const agent = await mkAcct('integration');
    const groupId = uid();
    const nonce = uid();
    // The offer row planted directly — the handler prechecks (ceremonyEligible,
    // registeredKeyOf) are bypassed ON PURPOSE: the condition, not the
    // precheck, is the authorization.
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: human.userId,
        offererClass: 'phone',
        acceptorUserId: agent.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('integration_class');
    expect(await rawRow(SERVER_TABLES.users, { userId: groupRowKey(groupId) })).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.groupId).toBeUndefined();
  });

  gated('an integration-class OFFERER is refused the same way', async () => {
    freshDeps();
    const human = await mkAcct();
    const agent = await mkAcct('integration');
    const groupId = uid();
    const nonce = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: agent.userId,
        offererClass: 'phone',
        acceptorUserId: human.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('integration_class');
    expect(await rawRow(SERVER_TABLES.users, { userId: groupRowKey(groupId) })).toBeUndefined();
  });

  gated('an agent can never DRIVE a ceremony: the signed roster-mutation route refuses an integration actor with the collapsed bytes (registeredKeyOf, structural)', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    // An agent trying to DRIVE a ceremony (here: sign a roster mutation as
    // "acting member") is the same structural refusal: one class arm in
    // registeredKeyOf covers every signed surface at once.
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const res = await deviceUnlinkRoute(
      post(agent.token, {
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        signature: sign(
          'unlink',
          {
            groupId,
            offererUserId: agent.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: nonce,
            expiresAt,
          },
          agent.key,
        ),
      }),
      deps,
    );
    expect(res).toEqual(accountsRefusal());
    expect((await db.getAccountGroup(groupId))?.epoch).toBe(1);
    expect((await db.getAccountGroup(groupId))?.members.map((m) => m.userId)).toEqual([
      a.userId,
      b.userId,
    ]);
  });
});

describe('caps count per GROUP', () => {
  it('asserts the pinned release values themselves, never a test-config shadow (release-pinned)', () => {
    expect(CREW_MAX_MEMBERS).toBe(8);
    expect(CONSENT_MAX_EDGES).toBe(16);
  });

  gated('a 3-device owner still caps at 8 crew adoptions — the 9th fails, from any member, while a solo control still adopts', async () => {
    freshDeps();
    const { members } = await mk3Group();
    const [x, y, z] = members as [Acct, Acct, Acct];
    // 8 adoptions distributed across all three member ULIDs — every one
    // through the REAL handler + transaction.
    const spread = [x, x, x, y, y, y, z, z];
    expect(spread).toHaveLength(CREW_MAX_MEMBERS);
    for (const owner of spread) {
      expect(await adoptFresh(owner)).toBe(204);
    }
    // The 9th refuses — from ANY member (here the one with the fewest own
    // adoptions, so a per-ULID cap would have admitted it: 2 < 8).
    expect(await adoptFresh(z)).toBe(409);
    expect(await adoptFresh(x)).toBe(409);
    // The cap is the GROUP's, not the fleet's: an unrelated solo owner
    // still adopts.
    const solo = await mkAcct();
    expect(await adoptFresh(solo)).toBe(204);
    // The counters remained per-ULID (the binding-fate carrier): 3+3+2.
    expect((await rawRow(SERVER_TABLES.users, { userId: x.userId }))?.crewCount).toBe(3);
    expect((await rawRow(SERVER_TABLES.users, { userId: y.userId }))?.crewCount).toBe(3);
    expect((await rawRow(SERVER_TABLES.users, { userId: z.userId }))?.crewCount).toBe(2);
  });

  gated('consent edges cap at 16 per GROUP: the 17th write is a deliberate silent loss, from any member', async () => {
    freshDeps();
    const { a, b } = await mkGroup();
    for (let i = 0; i < CONSENT_MAX_EDGES; i++) {
      expect(await consentFresh(i % 2 === 0 ? a : b)).toBe(true);
    }
    // The 17th answers the same uniform 204 and stores NOTHING —
    // from either member: the budget is one and shared.
    expect(await consentFresh(a)).toBe(false);
    expect(await consentFresh(b)).toBe(false);
    // An unrelated solo human is untouched by this group's exhaustion.
    const solo = await mkAcct();
    expect(await consentFresh(solo)).toBe(true);
  });
});

describe('the three binding fates', () => {
  gated('amicable unlink: the binding rides with the departing device — and group reach dies with the roster', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // Reach before: the agent bound to the tablet reaches the phone.
    expect((await frameFrom(agent.userId, sendFrame(a.userId))).statusCode).toBe(200);

    // B amicably unlinks itself — the REAL signed route, real signature.
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const res = await deviceUnlinkRoute(
      post(b.token, {
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        signature: sign(
          'unlink',
          {
            groupId,
            offererUserId: b.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: nonce,
            expiresAt,
          },
          b.key,
        ),
      }),
      deps,
    );
    expect(res.statusCode).toBe(200);

    // The binding survives ON THE DEPARTING ULID: same ownerUserId, the
    // agent still reaches its (now standalone) owner.
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.ownerUserId).toBe(
      b.userId,
    );
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBeUndefined();
    expect((await frameFrom(agent.userId, sendFrame(b.userId))).statusCode).toBe(200);
    // Group reach is DEAD: the former sibling refuses with the frozen bytes.
    const refused = await frameFrom(agent.userId, sendFrame(a.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
  });

  gated('revoke-lost/stolen: the binding is tombstoned in the SAME transaction — the agent cannot act the instant the roster commits', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    expect((await frameFrom(agent.userId, sendFrame(a.userId))).statusCode).toBe(200);

    // A revokes the lost tablet, naming its agent — the REAL route.
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const res = await deviceRevokeRoute(
      post(a.token, {
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        boundAgents: [agent.userId],
        signature: sign(
          'revoke',
          {
            groupId,
            offererUserId: a.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: nonce,
            expiresAt,
          },
          a.key,
        ),
      }),
      deps,
    );
    expect(res.statusCode).toBe(200);

    // Both tombstones landed in the roster transaction's write set (the
    // record is the enforcement): USER row AND idkey claim.
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))
        ?.tombstoned,
    ).toBe(true);
    // A stolen device's agent never keeps reach: the very next frame is
    // refused as a dead sender — toward the survivor AND the old owner.
    const refused = await frameFrom(agent.userId, sendFrame(a.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([
      { type: 'error', code: 'unknown_sender', detail: 'account no longer exists' },
    ]);
  });

  gated('the link transaction refuses a merge past 8 crew — first link AND join — with a distinct data-layer error, collapsed upstream', async () => {
    freshDeps();
    // FIRST LINK: a solo owner with 5 adoptions merging with a solo owner
    // holding 4 would put the group at 9 > 8. The handler prechecks would
    // already refuse a lived-in joiner; the offer is planted directly so the
    // TRANSACTION's own condition is what answers (belt-and-braces for any
    // future pristineness relaxation — exact words).
    const d = await mkAcct();
    const e = await mkAcct();
    for (let i = 0; i < 5; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, d.userId)).toBe('bound');
      expect(await db.adoptCrewMember(d.userId, agent.userId, uid())).toBe('adopted');
    }
    for (let i = 0; i < 4; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, e.userId)).toBe('bound');
      expect(await db.adoptCrewMember(e.userId, agent.userId, uid())).toBe('adopted');
    }
    const groupId = uid();
    const nonce = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: d.userId,
        offererClass: 'phone',
        acceptorUserId: e.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('cap_exceeded');
    expect(await rawRow(SERVER_TABLES.users, { userId: groupRowKey(groupId) })).toBeUndefined();

    // JOIN: an existing group holding 4 adoptions + a lived-in joiner with 5.
    const { groupId: g2, a } = await mkGroup();
    for (let i = 0; i < 4; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');
      expect(await db.adoptCrewMember(a.userId, agent.userId, uid())).toBe('adopted');
    }
    const joiner = await mkAcct();
    for (let i = 0; i < 5; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, joiner.userId)).toBe('bound');
      expect(await db.adoptCrewMember(joiner.userId, agent.userId, uid())).toBe('adopted');
    }
    const nonce2 = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce2,
        groupId: g2,
        offererUserId: a.userId,
        acceptorUserId: joiner.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 1,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce2,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('cap_exceeded');
    expect((await db.getAccountGroup(g2))?.epoch).toBe(1);
    expect((await rawRow(SERVER_TABLES.users, { userId: joiner.userId }))?.groupId).toBeUndefined();
  });

  gated('the link transaction refuses a merge past 16 consent edges — and admits an at-cap merge (refuses only EXCEEDING)', async () => {
    freshDeps();
    // Over-cap: 10 + 7 = 17 > 16.
    const f = await mkAcct();
    const g = await mkAcct();
    for (let i = 0; i < 10; i++) {
      expect(await db.writeConsentEdge(f.userId, uid(), deps.now())).toBe('written');
    }
    for (let i = 0; i < 7; i++) {
      expect(await db.writeConsentEdge(g.userId, uid(), deps.now())).toBe('written');
    }
    const groupId = uid();
    const nonce = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: f.userId,
        offererClass: 'phone',
        acceptorUserId: g.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('cap_exceeded');
    // The condition refuses only what would EXCEED the caps: 8 + 8 = 16
    // merges fine (belt-and-braces, not a new pristineness gate).
    const h = await mkAcct();
    const i2 = await mkAcct();
    for (let i = 0; i < 8; i++) {
      expect(await db.writeConsentEdge(h.userId, uid(), deps.now())).toBe('written');
      expect(await db.writeConsentEdge(i2.userId, uid(), deps.now())).toBe('written');
    }
    const groupId2 = uid();
    const nonce2 = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce2,
        groupId: groupId2,
        offererUserId: h.userId,
        offererClass: 'phone',
        acceptorUserId: i2.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce2,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('linked');
    // And once merged at the cap, the NEXT consent write from either member
    // is the group-cap refusal — the two enforcement points agree.
    expect(await consentFresh(h)).toBe(false);
  });
});

describe('group reach is pinned to DELIVERY', () => {
  gated('an unlink committing between admission and enqueue refuses the send with the FROZEN bytes — send arm', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');

    // The race, made deterministic: the widened admission passes against the
    // intact roster, then b's AMICABLE self-unlink commits before the
    // enqueue. Both user rows stay live, so only the transaction's
    // group-row membership pin can refuse.
    let fired = false;
    const raceDb: TestOnlyDataLayer = {
      ...db,
      async enqueueMessage(msg, opts) {
        if (!fired) {
          fired = true;
          expect(
            await db.unlinkDeviceFromGroup({
              groupId,
              actingUserId: b.userId,
              targetUserId: b.userId,
              rosterEpoch: 1,
            }),
          ).toBe('unlinked');
        }
        return db.enqueueMessage(msg, opts);
      },
    };
    wsDeps = { ...wsDeps, db: raceDb };

    const refused = await frameFrom(agent.userId, sendFrame(b.userId));
    expect(fired).toBe(true);
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    // Nothing landed in the departed device's queue.
    expect(await allQueued(db, b.userId)).toHaveLength(0);
    // Both rows are live — the tombstone conditions provably could not have
    // been what refused.
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.tombstoned).toBeUndefined();
  });

  gated('the same race on the INBOX arm refuses with ITS frozen bytes', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');

    let fired = false;
    const raceDb: TestOnlyDataLayer = {
      ...db,
      async enqueueMessage(msg, opts) {
        if (!fired) {
          fired = true;
          expect(
            await db.unlinkDeviceFromGroup({
              groupId,
              actingUserId: b.userId,
              targetUserId: b.userId,
              rosterEpoch: 1,
            }),
          ).toBe('unlinked');
        }
        return db.enqueueMessage(msg, opts);
      },
    };
    wsDeps = { ...wsDeps, db: raceDb };

    const refused = await frameFrom(b.userId, sendFrame(agent.userId));
    expect(fired).toBe(true);
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(b.userId)).toEqual([FROZEN_INBOX_RESTRICTED]);
    expect(await allQueued(db, agent.userId)).toHaveLength(0);
  });
});

describe('typing fails closed on tombstones', () => {
  gated('a tombstoned agent (binding tombstone committed, teardown crashed) can no longer relay typing to its live owner', async () => {
    freshDeps();
    const { b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // The crash window: the binding tombstone committed (the record), the
    // teardown — sessions, socket — did not run.
    expect(
      await db.tombstoneAgentBindings([{ userId: agent.userId, identityKeyPub: agent.pub }]),
    ).toBe('done');
    await db.putConnection({ userId: b.userId, connectionId: 'conn-owner-t', connectedAt: deps.now() });

    expect((await frameFrom(agent.userId, typingFrame(b.userId))).statusCode).toBe(200);
    expect(posted.filter((p) => p.connectionId === 'conn-owner-t')).toHaveLength(0);
  });

  gated('typing to a REVOKED owner (exact-owner arm) drops instead of relaying to the stolen socket', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // b revoked lost/stolen with teardown crashed: connection row survives.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');
    await db.putConnection({ userId: b.userId, connectionId: 'conn-stolen', connectedAt: deps.now() });

    expect((await frameFrom(agent.userId, typingFrame(b.userId))).statusCode).toBe(200);
    expect(posted.filter((p) => p.connectionId === 'conn-stolen')).toHaveLength(0);
  });

  gated('ownerGroupAdmits refuses a TOMBSTONED exact owner too (direct drive — the record is the enforcement)', async () => {
    freshDeps();
    const { a } = await mkGroup();
    const wsDb = { db } as Pick<WsDeps, 'db'>;
    const aRow = (await db.getUserById(a.userId))!;
    expect(
      await ownerGroupAdmits(
        { accountClass: 'integration', ownerUserId: a.userId },
        { ...aRow, tombstoned: true },
        wsDb,
      ),
    ).toBe(false);
  });

  gated('the HUMAN typing branch widens and narrows on the same roster: a sibling relays to the agent, the departed sibling cannot', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');
    await db.putConnection({ userId: agent.userId, connectionId: 'conn-agent-t', connectedAt: deps.now() });
    // Establish correspondence through the agent's own durable send to b
    // (the widened send arm): the agent is solo, so the ledger lands under
    // its bare ULID — exactly the key the typing branch's single-key
    // correspondence read probes.
    expect((await frameFrom(agent.userId, sendFrame(b.userId))).statusCode).toBe(200);

    // The widened HUMAN branch: the sibling's typing relays to the agent.
    expect((await frameFrom(b.userId, typingFrame(agent.userId))).statusCode).toBe(200);
    const typingRelays = (): number =>
      posted.filter((p) => p.connectionId === 'conn-agent-t' && p.frame.type === 'typing').length;
    expect(typingRelays()).toBe(1);

    // b departs amicably; the correspondence ledger OUTLIVES the roster —
    // typing must narrow with the roster, not ride the ledger.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: b.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    expect((await frameFrom(b.userId, typingFrame(agent.userId))).statusCode).toBe(200);
    expect(typingRelays()).toBe(1);
  });
});

describe('a stale nonmember cannot invite into a group', () => {
  gated('init refuses an offerer absent from the authoritative roster, and the join transaction refuses the planted offer', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    // b leaves; the roster is {a} at epoch 2, the tablet slot free.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: b.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    // The STALE NONMEMBER: a user row drifted to name G without membership.
    const s = await mkAcct();
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: s.userId },
        UpdateExpression: 'SET groupId = :g',
        ExpressionAttributeValues: { ':g': groupId },
      }),
    );
    const joiner = await mkAcct();

    // (a) the INIT leg refuses: the epoch it would mint is the CURRENT one,
    // which the accept-time epoch pin would happily admit.
    const initRes = await linkOfferInitHandler(
      post(s.token, { acceptorUserId: joiner.userId, acceptorClass: 'tablet' }),
      makeTestDeps(db),
      { userId: s.userId },
    );
    expect(initRes).toEqual(accountsRefusal());

    // (b) the TRANSACTION refuses a directly planted offer at the current
    // epoch — the condition, not the precheck, is the authorization.
    const nonce = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: s.userId,
        acceptorUserId: joiner.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 2,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('stale_epoch');
    expect((await db.getAccountGroup(groupId))?.members.map((m) => m.userId)).toEqual([a.userId]);
    expect((await rawRow(SERVER_TABLES.users, { userId: joiner.userId }))?.groupId).toBeUndefined();
  });
});

describe('the merged-cap PIN is what refuses under the race', () => {
  gated('a counter moving between the sum read and the commit cancels on the pin and re-refuses — deleting the pins would link an over-cap group', async () => {
    freshDeps();
    const d = await mkAcct();
    const e2 = await mkAcct();
    for (let i = 0; i < 4; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, d.userId)).toBe('bound');
      expect(await db.adoptCrewMember(d.userId, agent.userId, uid())).toBe('adopted');
    }
    for (let i = 0; i < 4; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, e2.userId)).toBe('bound');
      expect(await db.adoptCrewMember(e2.userId, agent.userId, uid())).toBe('adopted');
    }
    const groupId = uid();
    const nonce = uid();
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId,
        offererUserId: d.userId,
        offererClass: 'phone',
        acceptorUserId: e2.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 0,
        expiresAt: Math.floor(deps.now() / 1000) + 600,
        offerSig: 'sig',
      }),
    ).toBe('created');
    // 4 + 4 = 8 passes the sum read — then a NINTH adoption commits between
    // that read and the transaction, through a doc client trap on the first
    // TransactWrite. Only the in-transaction crew pin can catch it: were the
    // pins deleted, this link would COMMIT a 9-crew group under a green sum.
    let raced = false;
    const trapDoc = {
      send: async (cmd: unknown, ...rest: unknown[]) => {
        if (cmd instanceof TransactWriteCommand && !raced) {
          raced = true;
          const agent = await mkAcct('integration');
          expect(await db.bindIntegrationOwner(agent.userId, d.userId)).toBe('bound');
          expect(await db.adoptCrewMember(d.userId, agent.userId, uid())).toBe('adopted');
        }
        return (doc as unknown as { send: (...a: unknown[]) => Promise<unknown> }).send(
          cmd,
          ...rest,
        );
      },
    } as unknown as DynamoDBDocumentClient;
    const trapDb = makeTestOnlyDataLayer(trapDoc);
    expect(
      await trapDb.linkDeviceToGroup({
        offerNonce: nonce,
        acceptSig: 'sig',
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
      }),
    ).toBe('cap_exceeded');
    expect(raced).toBe(true);
    expect(await rawRow(SERVER_TABLES.users, { userId: groupRowKey(groupId) })).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: d.userId }))?.groupId).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: e2.userId }))?.groupId).toBeUndefined();
  });
});

describe('recovery carries the merged-cap and binding-fate rules', () => {
  /** Plant the proving claim + a completable pending recovery for `groupId`,
   * naming `r` as the recovering device in the given slot. */
  async function plantRecovery(
    groupId: string,
    r: Acct,
    deviceClass: DeviceClass,
  ): Promise<number> {
    const claimKey = `emailhash#v1#reach${RUN}${String(++seq).padStart(4, '0')}`;
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: {
          userId: claimKey,
          kind: 'identifierClaim',
          groupId,
          createdAt: deps.now(),
          verifiedAt: deps.now(),
          discoverable: false,
        },
      }),
    );
    const nowSec = Math.floor(deps.now() / 1000);
    expect(
      await db.putRecoveryPending({
        groupId,
        newUserId: r.userId,
        deviceClass,
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowSec - 10,
        expiresAt: nowSec + 3600,
      }),
    ).toBe('created');
    return nowSec;
  }

  gated('a lived-in recovering device cannot mint an over-cap group: completion refuses on the merged sum', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    for (let i = 0; i < 4; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, a.userId)).toBe('bound');
      expect(await db.adoptCrewMember(a.userId, agent.userId, uid())).toBe('adopted');
    }
    // The recovering device is admissible today (recovery pristineness never
    // named crew/consent state) yet holds 5 adoptions of its own.
    const r = await mkAcct();
    for (let i = 0; i < 5; i++) {
      const agent = await mkAcct('integration');
      expect(await db.bindIntegrationOwner(agent.userId, r.userId)).toBe('bound');
      expect(await db.adoptCrewMember(r.userId, agent.userId, uid())).toBe('adopted');
    }
    const nowSec = await plantRecovery(groupId, r, 'tablet');
    const res = await db.completeRecovery({
      groupId,
      newUserId: r.userId,
      nowSeconds: nowSec,
      linkedAtMs: deps.now(),
      discoverableAfter: nowSec + 7 * 86400,
    });
    expect(res.outcome).toBe('cap_exceeded');
    // Nothing moved: roster intact, incumbent alive, recovering device solo.
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => m.userId)).toEqual([a.userId, b.userId]);
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.tombstoned).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: r.userId }))?.groupId).toBeUndefined();
  });

  gated('recovery-replace is a binding fate: the incumbent tombstone kills its agent\'s reach in the SAME transaction, and the survivor completes the tombstones by the completion path', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // Group reach before: the tablet's agent reaches the phone.
    expect((await frameFrom(agent.userId, sendFrame(a.userId))).statusCode).toBe(200);

    const r = await mkAcct();
    const nowSec = await plantRecovery(groupId, r, 'tablet');
    const res = await db.completeRecovery({
      groupId,
      newUserId: r.userId,
      nowSeconds: nowSec,
      linkedAtMs: deps.now(),
      discoverableAfter: nowSec + 7 * 86400,
    });
    expect(res.outcome).toBe('completed');
    // Teardown deliberately NOT run (the handler's cleanup): the transaction
    // record alone must already kill the replaced device's agent reach.
    const refused = await frameFrom(agent.userId, sendFrame(a.userId));
    expect(refused.statusCode).toBe(403);
    expect(errorsTo(agent.userId)).toEqual([FROZEN_RECIPIENT_FORBIDDEN]);
    const toDead = await frameFrom(agent.userId, sendFrame(b.userId));
    expect(toDead.statusCode).toBe(403);
    expect(errorsTo(agent.userId)[1]).toEqual({
      type: 'error',
      code: 'recipient_revoked',
      detail: 'this device was revoked by its account',
    });

    // The SURVIVOR then names the incumbent's agents through the ordinary
    // revoke completion path — `completeRecovery` wrote the
    // tombstoned + formerGroupId marker for exactly this — and the agent's
    // own account dies whole (USER row + idkey claim).
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const done = await deviceRevokeRoute(
      post(a.token, {
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        boundAgents: [agent.userId],
        signature: sign(
          'revoke',
          {
            groupId,
            offererUserId: a.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: nonce,
            expiresAt,
          },
          a.key,
        ),
      }),
      deps,
    );
    expect(done.statusCode).toBe(200);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))
        ?.tombstoned,
    ).toBe(true);
  });
});

describe('a dead ULID never GAINS a binding', () => {
  gated('binding to a tombstoned owner refuses, and to a deleted/never-existing owner likewise — the integration row stays unbound', async () => {
    freshDeps();
    const victim = await mkAcct();
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: victim.userId },
        UpdateExpression: 'SET tombstoned = :t',
        ExpressionAttributeValues: { ':t': true },
      }),
    );
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, victim.userId)).toBe('unknown_owner');
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.ownerUserId).toBeUndefined();
    // A deleted (missing) owner row is the same refusal at the same pin.
    expect(await db.bindIntegrationOwner(agent.userId, uid())).toBe('unknown_owner');
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.ownerUserId).toBeUndefined();
  });
});
