import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  AccountsNotice,
  linkOpSignedBytes,
  TABLES,
  type LinkOp,
  type LinkOpTuple,
  type ServerFrame,
} from '@tacendum/shared';
import { verifyIdentitySignature } from '../src/handlers/auth-account.js';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  IDKEY_CLAIM_PREFIX,
  makeTestOnlyDataLayer,
  sessionTokenDigest,
  type TestOnlyDataLayer,
} from '../src/db/data.js';
import { authenticate } from '../src/handlers/auth.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import { deviceRevokeRoute, deviceUnlinkRoute } from '../src/handlers/devices-signed.js';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * Revoke/unlink teardown —
 * asserted by READING THE STORES, never by spying on calls: sessions,
 * socket row, push row, and the victim's agent bindings are checked as rows
 * that exist and then do not.
 *
 * The crash window is driven explicitly: the roster/tombstone TransactWrite
 * commits WITHOUT any teardown, and the suite proves the record alone is the
 * enforcement — the victim's already-issued bearer refuses at validation, a
 * send to the tombstoned ULID refuses at enqueue — and that re-running the
 * signed revoke call completes the teardown idempotently.
 *
 * The mutation-nonce replay bound is driven LITERALLY
 * (a fresh nonce re-signed per call would replay nothing): the identical signed request — one
 * captured body, same nonce, same expiry, same signature bytes — is replayed
 * through the handler, and the `boundAgents` bound is driven
 * both ways: the list rides OUTSIDE the signed tuple (the same signature
 * verifies with a different list, tombstoning a target-owned agent the
 * committed call omitted — the re-drive), and what it can buy
 * is BOUNDED to integrations the already-revoked target owns (the same
 * signed bytes naming anyone else's agent are the collapsed refusal). The
 * roster is never re-mutated by any replay.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;

// Digits only; '32' is this FILE's discriminator — see the twin comment in
// accounts-link.test.ts (same-millisecond loads collided ULIDs across the
// parallel heavy forks).
const RUN = `${Date.now()}32`;
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

/** Canary ids + every log sink, for the log-canary sweep at the end. */
const canaries = new Set<string>();
const allLogs: Array<TestDeps['logs']> = [];

function freshDeps(): TestDeps {
  deps = makeTestDeps(db);
  allLogs.push(deps.logs);
  return deps;
}

async function mkAcct(accountClass?: 'integration'): Promise<Acct> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now(), accountClass);
  expect(res.kind).toBe('ok');
  const token = `rt-tok-${RUN}-${++seq}`;
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

/** A phone+tablet group built through the transaction (signature strings
 * are the data layer's concern only here; the HANDLER paths under test
 * verify real signatures on the mutation they drive). */
async function mkGroup(): Promise<{ groupId: string; a: Acct; b: Acct }> {
  const a = await mkAcct();
  const b = await mkAcct();
  const groupId = uid();
  canaries.add(groupId);
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

/** The victim's live server footprint: socket row + push row. */
async function giveFootprint(acct: Acct): Promise<void> {
  await db.putConnection({
    userId: acct.userId,
    connectionId: `conn-${acct.userId}`,
    connectedAt: deps.now(),
    sessionDigest: sessionTokenDigest(acct.token),
  });
  await db.putPushToken({
    userId: acct.userId,
    platform: 'ios',
    alertToken: 'a'.repeat(64),
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 3600,
  });
}

function revokeEvent(
  groupId: string,
  actor: Acct,
  target: Acct,
  epoch: number,
  boundAgents?: string[],
): HttpEvent {
  const nonce = uid();
  const expiresAt = Math.floor(deps.now() / 1000) + 600;
  return post(actor.token, {
    groupId,
    targetUserId: target.userId,
    targetClass: 'tablet',
    rosterEpoch: epoch,
    offerNonce: nonce,
    expiresAt,
    ...(boundAgents ? { boundAgents } : {}),
    signature: sign(
      'revoke',
      {
        groupId,
        offererUserId: actor.userId,
        acceptorUserId: target.userId,
        subjectIdentityPubKey: target.pub,
        class: 'tablet',
        rosterEpoch: epoch,
        offerNonce: nonce,
        expiresAt,
      },
      actor.key,
    ),
  });
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  // Process-local flag override — same rationale as accounts-link.test.ts:
  // the real row is a store-wide singleton other suites toggle.
  db = { ...base, isAccountsFeatureEnabled: async () => true };
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
    await fn();
  });
}

describe('revoke teardown (revoke-lost/stolen)', () => {
  gated('after a signed revoke: sessions gone, socket row gone, push row gone, agent bindings tombstoned — read from the stores', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    await giveFootprint(b);
    // An integration bound to the victim (binding fate).
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');

    // Everything exists before.
    expect(await db.getSession(b.token)).toBeDefined();
    expect(await db.getConnection(b.userId)).toBeDefined();
    expect(await db.getPushToken(b.userId)).toBeDefined();
    expect(await db.getSession(agent.token)).toBeDefined();

    const res = await deviceRevokeRoute(revokeEvent(groupId, a, b, 1, [agent.userId]), deps);
    expect(res.statusCode).toBe(200);

    // The record (enforcement) — roster, tombstones, forwarding hint:
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(2);
    expect(group?.members.map((m) => m.userId)).toEqual([a.userId]);
    const bRow = await rawRow(SERVER_TABLES.users, { userId: b.userId });
    expect(bRow?.tombstoned).toBe(true);
    expect(bRow?.formerGroupId).toBe(groupId);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${b.pub}` }))?.tombstoned,
    ).toBe(true);
    // The agent binding is tombstoned IN the same transaction's write set —
    // BOTH its idkey claim (blocks re-auth) AND its USER row (the read-time
    // enforcement; previously only the claim was, leaving the agent's bearer
    // alive through the crash window):
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))
        ?.tombstoned,
    ).toBe(true);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);

    // The cleanup — every row read back from the store, not spied:
    expect(await db.getSession(b.token)).toBeUndefined();
    expect(await db.getConnection(b.userId)).toBeUndefined();
    expect(await db.getPushToken(b.userId)).toBeUndefined();
    expect(await db.getSession(agent.token)).toBeUndefined();
  });

  gated('the group case: the victim\'s agent held GROUP reach, and the same-transaction tombstone kills it whole', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    const wsDeps: WsDeps = {
      ...deps,
      sender: { async post() { return true; } },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const reach = (to: string) =>
      wsDefaultHandler(
        {
          routeKey: '$default',
          connectionId: `conn-${agent.userId}`,
          senderUserId: agent.userId,
          body: JSON.stringify({
            type: 'send',
            to,
            msgId: uid(),
            msgType: 'ciphertext',
            payload: 'QUJD',
          }),
        },
        wsDeps,
      );
    // Before: the agent bound to the tablet reaches the PHONE too — the
    // widened predicate (owner resolves to the owner's group).
    expect((await reach(a.userId)).statusCode).toBe(200);

    const res = await deviceRevokeRoute(revokeEvent(groupId, a, b, 1, [agent.userId]), deps);
    expect(res.statusCode).toBe(200);

    // After the ONE transaction: no reach anywhere — not the survivor, not
    // the dead owner — because the agent's own row is tombstoned (the record
    // is the enforcement; a stolen device never keeps agent reach).
    expect((await reach(a.userId)).statusCode).toBe(403);
    expect((await reach(b.userId)).statusCode).toBe(403);
  });

  gated('naming an agent the target does not own is the collapsed refusal — no partial tombstone', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const other = await mkAcct();
    const foreignAgent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(foreignAgent.userId, other.userId)).toBe('bound');
    const res = await deviceRevokeRoute(
      revokeEvent(groupId, a, b, 1, [foreignAgent.userId]),
      deps,
    );
    expect(res).toEqual(accountsRefusal());
    // Nothing moved: the roster is intact and the foreign agent lives.
    expect((await db.getAccountGroup(groupId))?.epoch).toBe(1);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${foreignAgent.pub}` }))
        ?.tombstoned,
    ).toBeUndefined();
  });
});

describe('the crash window: the record is the enforcement, teardown is re-driven cleanup', () => {
  gated('transaction committed + teardown skipped ⇒ bearer refused at validation, enqueue refused, and the re-run revoke completes teardown', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    await giveFootprint(b);

    // Commit the roster/tombstone transaction DIRECTLY — no handler, no
    // teardown: the crash-window state.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');
    // Teardown never ran: session, socket row, push row all still present.
    expect(await db.getSession(b.token)).toBeDefined();
    expect(await db.getConnection(b.userId)).toBeDefined();
    expect(await db.getPushToken(b.userId)).toBeDefined();

    // 1. The victim's already-issued bearer session is refused AT VALIDATION
    //    — the REAL bearer-validation function, reading the store.
    expect(
      await authenticate(
        { method: 'GET', path: '/', headers: { authorization: `Bearer ${b.token}` } },
        deps,
      ),
    ).toBeNull();

    // 2. A send to the tombstoned ULID refuses AT ENQUEUE, with the distinct
    // stale-roster error — and nothing lands in the dead queue.
    const inbox = new Map<string, ServerFrame[]>();
    const wsDeps: WsDeps = {
      ...deps,
      sender: {
        async post(connectionId, frame) {
          const frames = inbox.get(connectionId) ?? [];
          frames.push(frame as ServerFrame);
          inbox.set(connectionId, frames);
          return true;
        },
      },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const msgId = uid();
    const sendRes = await wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId: `conn-${a.userId}`,
        senderUserId: a.userId,
        body: JSON.stringify({
          type: 'send',
          to: b.userId,
          msgId,
          msgType: 'ciphertext',
          payload: 'QUJD',
        }),
      },
      wsDeps,
    );
    expect(sendRes.statusCode).toBe(403);
    const errors = (inbox.get(`conn-${a.userId}`) ?? []).filter((f) => f.type === 'error');
    expect(errors.at(-1)).toMatchObject({ type: 'error', code: 'recipient_revoked' });
    expect((await allQueued(db, b.userId)).map((m) => m.msgId)).not.toContain(msgId);

    // 3. Re-running the SIGNED revoke call — the IDENTICAL request a client
    // retries: ONE captured body, same nonce, same expiry, same signature
    // bytes, replayed verbatim (the permitted
    // replay, driven literally — a freshly signed request would replay
    // nothing) — finds the roster already mutated, proves the marker, and
    // completes the teardown idempotently.
    const identicalRetry = revokeEvent(groupId, a, b, 1);
    const retry = await deviceRevokeRoute(identicalRetry, deps);
    expect(retry.statusCode).toBe(200);
    expect(await db.getSession(b.token)).toBeUndefined();
    expect(await db.getConnection(b.userId)).toBeUndefined();
    expect(await db.getPushToken(b.userId)).toBeUndefined();

    // ...and a THIRD run of the SAME bytes is still 200 and still torn down
    // (idempotence) — and no replay ever re-mutates the roster: the group
    // row still shows the one committed removal.
    const again = await deviceRevokeRoute(identicalRetry, deps);
    expect(again.statusCode).toBe(200);
    const groupAfter = await db.getAccountGroup(groupId);
    expect(groupAfter?.epoch).toBe(2);
    expect(groupAfter?.members.map((m) => m.userId)).toEqual([a.userId]);
  });

  gated('the crash window closes for AGENTS too: transaction committed + teardown skipped ⇒ the agent bearer is refused at validation by the record', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // Commit the roster/tombstone transaction WITH the agent named — no
    // handler, no teardown: the crash-window state.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
        agents: [{ userId: agent.userId, identityKeyPub: agent.pub }],
      }),
    ).toBe('revoked');
    // Teardown never ran: the agent's session is still physically present...
    expect(await db.getSession(agent.token)).toBeDefined();
    // ..but the RECORD is the enforcement: the agent USER row is tombstoned and its already-issued bearer
    // is refused at validation — not left alive until teardown, which is the
    // gap tombstoning ONLY the idkey claim left open.
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);
    expect(
      await authenticate(
        { method: 'GET', path: '/', headers: { authorization: `Bearer ${agent.token}` } },
        deps,
      ),
    ).toBeNull();
    // ...and the idkey claim is tombstoned so the key can never re-auth.
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))
        ?.tombstoned,
    ).toBe(true);
  });

  gated('a NON-MEMBER cannot drive the idempotent-completion path: a stranger revoke of a committed-revoke ULID is REFUSED — no teardown, no forged notice', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    await giveFootprint(b);
    // Crash-window state: b revoked directly, teardown skipped.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');
    // A stranger that was NEVER a member, with its own valid account + key.
    const stranger = await mkAcct();
    const noticesBefore = (await allQueued(db, a.userId)).filter((m) => m.type === 'accounts').length;
    // The stranger signs a revoke over its OWN chosen tuple at an arbitrary
    // epoch and presents its own bearer — the completion path answered 200 and
    // ran teardown + a forged notice fan-out with NO authorization at all.
    const res = await deviceRevokeRoute(revokeEvent(groupId, stranger, b, 99999), deps);
    expect(res).toEqual(accountsRefusal());
    // No teardown ran on the stranger's say-so — b's footprint is untouched...
    expect(await db.getConnection(b.userId)).toBeDefined();
    expect(await db.getPushToken(b.userId)).toBeDefined();
    // ...and no forged memberRevoked notice was injected into member a's queue.
    expect((await allQueued(db, a.userId)).filter((m) => m.type === 'accounts').length).toBe(
      noticesBefore,
    );
  });

  gated('idempotent completion tombstones agents the committed revoke OMITTED — and boundAgents rides OUTSIDE the signed tuple, bounded to the target\'s own integrations (the amended bound, driven)', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    const agent2 = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    expect(await db.bindIntegrationOwner(agent2.userId, b.userId)).toBe('bound');
    const stranger = await mkAcct();
    const foreignAgent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(foreignAgent.userId, stranger.userId)).toBe('bound');
    // Commit the revoke WITHOUT naming any agent (the "revoke the phone now,
    // remember the bots afterwards" flow): b tombstoned, the agents untouched.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned,
    ).toBeUndefined();
    // The gap this closes: the agent's already-issued bearer still works.
    expect(
      await authenticate(
        { method: 'GET', path: '/', headers: { authorization: `Bearer ${agent.token}` } },
        deps,
      ),
    ).not.toBeNull();

    // ONE signed tuple — nonce, expiry, and signature FIXED. Every completion
    // call below replays these same signed bytes; only `boundAgents`, which
    // the pinned preimage deliberately does NOT cover (the committed call
    // may have omitted the agents), varies between calls.
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const signature = sign(
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
    );
    const completion = (boundAgents?: string[]): HttpEvent =>
      post(a.token, {
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        ...(boundAgents ? { boundAgents } : {}),
        signature,
      });

    // Re-issue the signed revoke NAMING the first agent: the completion path
    // tombstones it (record) and tears it down (cleanup).
    const retry = await deviceRevokeRoute(completion([agent.userId]), deps);
    expect(retry.statusCode).toBe(200);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))
        ?.tombstoned,
    ).toBe(true);
    expect(await db.getSession(agent.token)).toBeUndefined();

    // The SAME signature with a DIFFERENT boundAgents list verifies — the
    // list rides outside the signed tuple by design — and the re-drive
    // tombstones the second omitted agent too.
    const more = await deviceRevokeRoute(completion([agent2.userId]), deps);
    expect(more.statusCode).toBe(200);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent2.userId }))?.tombstoned).toBe(true);

    // …but what an unsigned list can BUY is bounded to integrations the
    // already-revoked target OWNS: the same signed bytes naming anyone
    // else's agent are the collapsed refusal, and nothing is tombstoned.
    const probe = await deviceRevokeRoute(completion([foreignAgent.userId]), deps);
    expect(probe).toEqual(accountsRefusal());
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: foreignAgent.userId }))?.tombstoned,
    ).toBeUndefined();

    // No completion replay ever re-mutated the roster.
    expect((await db.getAccountGroup(groupId))?.epoch).toBe(2);
  });

  gated('duplicate boundAgents entries are deduped, not a 500: the revoke succeeds and the agent is tombstoned', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    const agent = await mkAcct('integration');
    expect(await db.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // The SAME agent ULID listed twice would put two operations on one item —
    // a ValidationException (500) that breaks the collapsed refusal and leaks
    // an "is X an integration owned by Y" discriminator. Deduped to one.
    const res = await deviceRevokeRoute(
      revokeEvent(groupId, a, b, 1, [agent.userId, agent.userId]),
      deps,
    );
    expect(res.statusCode).toBe(200);
    expect((await rawRow(SERVER_TABLES.users, { userId: agent.userId }))?.tombstoned).toBe(true);
  });

  gated('a tombstoned SENDER cannot act: its own socket frame refuses in the unknown_sender shape', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');
    const inbox = new Map<string, ServerFrame[]>();
    const wsDeps: WsDeps = {
      ...deps,
      sender: {
        async post(connectionId, frame) {
          const frames = inbox.get(connectionId) ?? [];
          frames.push(frame as ServerFrame);
          inbox.set(connectionId, frames);
          return true;
        },
      },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const res = await wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId: `conn-${b.userId}`,
        senderUserId: b.userId,
        body: JSON.stringify({
          type: 'send',
          to: a.userId,
          msgId: uid(),
          msgType: 'ciphertext',
          payload: 'QUJD',
        }),
      },
      wsDeps,
    );
    expect(res.statusCode).toBe(403);
    const errors = (inbox.get(`conn-${b.userId}`) ?? []).filter((f) => f.type === 'error');
    // The SAME bytes a deleted account gets: the stolen device learns
    // nothing from the refusal's shape.
    expect(errors.at(-1)).toMatchObject({ type: 'error', code: 'unknown_sender' });
  });
});

describe('amicable unlink', () => {
  gated('unlink tears down sessions/socket/push but leaves the account alive — no tombstone, groupId cleared', async () => {
    freshDeps();
    const { groupId, a, b } = await mkGroup();
    await giveFootprint(b);
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + 600;
    const res = await deviceUnlinkRoute(
      post(a.token, {
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
    // Teardown ran...
    expect(await db.getSession(b.token)).toBeUndefined();
    expect(await db.getConnection(b.userId)).toBeUndefined();
    expect(await db.getPushToken(b.userId)).toBeUndefined();
    // ...but the device continues as the standalone anonymous account it
    // always was: row intact, no tombstone, no forwarding hint, claim row
    // clean — the key can re-auth.
    const bRow = await rawRow(SERVER_TABLES.users, { userId: b.userId });
    expect(bRow).toBeDefined();
    expect(bRow?.groupId).toBeUndefined();
    expect(bRow?.tombstoned).toBeUndefined();
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${b.pub}` }))?.tombstoned,
    ).toBeUndefined();
    // The unlinked device is told, in-band, on its durable queue — its
    // account lives on and its UI should say what happened. (The ACTOR needs
    // no notice; any third member would get one, but v1's two occupiable
    // slots mean no third exists yet.)
    const bQueue = await allQueued(db, b.userId);
    const noticeRow = bQueue.find((m) => m.type === 'accounts');
    expect(noticeRow).toBeDefined();
    // The notice is SIGNED and VERIFIABLE — it carries
    // the acting member's op-framed signature plus the full preimage
    // context, and the signature verifies under the actor's REGISTERED key
    // over the exact pinned byte stream. A client applies removals only
    // on this proof, never on server word alone.
    const notice = AccountsNotice.parse(
      JSON.parse(Buffer.from(noticeRow!.payload, 'base64').toString('utf8')),
    );
    if (notice.kind !== 'memberUnlinked') throw new Error('expected memberUnlinked');
    expect(notice).toMatchObject({
      userId: b.userId,
      actingUserId: a.userId,
      subjectIdentityPubKey: b.pub,
      offerNonce: nonce,
      signedRosterEpoch: 1,
    });
    expect(
      verifyIdentitySignature(
        a.pub,
        linkOpSignedBytes('unlink', {
          groupId: notice.groupId,
          offererUserId: notice.actingUserId,
          acceptorUserId: notice.userId,
          subjectIdentityPubKey: notice.subjectIdentityPubKey,
          class: notice.class,
          rosterEpoch: notice.signedRosterEpoch,
          offerNonce: notice.offerNonce,
          expiresAt: notice.expiresAt,
        }),
        notice.signature,
      ),
    ).toBe(true);
    // ...and a one-field lie (the wrong target class) verifies against
    // nothing — the signature binds the tuple, not the notice's word.
    expect(
      verifyIdentitySignature(
        a.pub,
        linkOpSignedBytes('unlink', {
          groupId: notice.groupId,
          offererUserId: notice.actingUserId,
          acceptorUserId: notice.userId,
          subjectIdentityPubKey: notice.subjectIdentityPubKey,
          class: 'phone',
          rosterEpoch: notice.signedRosterEpoch,
          offerNonce: notice.offerNonce,
          expiresAt: notice.expiresAt,
        }),
        notice.signature,
      ),
    ).toBe(false);
  });
});

describe('log-canary discipline', () => {
  gated('no member ULID and no groupId from any teardown flow appears in any retained log line', async () => {
    expect(canaries.size).toBeGreaterThanOrEqual(6);
    const retained = JSON.stringify(allLogs);
    for (const id of canaries) {
      expect(retained).not.toContain(id);
    }
  });
});
