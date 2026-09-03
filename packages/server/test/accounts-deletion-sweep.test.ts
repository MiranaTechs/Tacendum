import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  EMAIL_SUPPRESSION_TTL_SECONDS,
  RECOVERY_DELAY_SECONDS,
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  TABLES,
  type DeviceClass,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  EMAIL_CODE_KEY_PREFIX,
  LINK_INIT_KEY_PREFIX,
  LINK_OFFER_KEY_PREFIX,
  IDKEY_CLAIM_PREFIX,
  groupRowKey,
  recoveryRowKey,
  emailCooldownKeyFromClaimKey,
  makeDataLayer,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
} from '../src/db/data.js';
import { emailClaimKey, emailSuppressionKey, identifierClaimHash } from '../src/opaque-ref.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { emailRequestCodeRoute } from '../src/handlers/identifiers.js';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * the four-surfaces deletion sweep, against REAL
 * DynamoDB Local (heavy project; run with TACENDUM_REQUIRE_DDB=1).
 *
 * The pinned shape, in its own order:
 * 1. A FULLY-LOADED grouped account (3 devices, verified email, discovery
 * ON, a pending link offer AND a pending init leg, an agent bound, a
 * pending recovery) — then ONE member is deleted and the SURVIVOR CASE
 * is asserted BEFORE any end state (per-member semantics: the
 * group row, the identifier claims, the discovery consent, and both
 * other members survive untouched apart from the roster change;
 * survivor corruption FAILS here).
 * 2. THEN every member is deleted and the whole test store is scanned for
 * ANY row containing any member ULID or the groupId — only
 * stated-tombstone rows may remain, and this suite enumerates the
 * permitted survivors by exact key. Identifier claims are found via the
 * group row's identifierRefs reverse list — a GetItem walk, never a
 * Query (the suite performs that walk itself).
 * 3. The -deferred PHYSICAL REAPS, each driven: an expired
 * recovery row, an expired code row, an expired suppression shadow, and
 * an elapsed emailcool shadow are all refused by the explicit clock
 * (already true) AND physically deleted at the refusing read (new).
 * 4. The known residual, recorded with driven bounds: a LAST-MEMBER
 * self-revoke that names no agents leaves the unnamed agent's bearer
 * alive — with every owner-directed and group capability dead.
 *
 * The 3-member roster is seeded at the ROW level (the precedent): the
 * desktop slot is schema-reserved in v1 (link-refused), but the sweep
 * must already hold at the schema's ≤3 maximum the day that reservation lifts.
 *
 * The rate limiter here is the in-memory test limiter (no rate rows land in
 * the store), so the end-state scan proves the DURABLE stores clean; the
 * TTL'd rate-window class is the stated residual, driven elsewhere.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let base: TestOnlyDataLayer;
let db: TestOnlyDataLayer;
let available = false;

// Digits only (valid Crockford base32); '77' is this file's discriminator
// (the accounts-link lesson: parallel forks mint same-millisecond RUN ids).
const RUN = `${Date.now()}77`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
const b64 = (s: string): string => Buffer.from(s).toString('base64');

const TEST_KID = 'test-identifier-hmac-key';

beforeAll(async () => {
  const client = makeDynamoClient();
  base = makeTestOnlyDataLayer(makeDocClient(client));
  doc = makeDocClient(client);
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

function freshDeps(): TestDeps {
  return makeTestDeps(db);
}

async function mkAcct(
  deps: TestDeps,
  accountClass?: 'integration',
): Promise<{ userId: string; token: string; pub: string }> {
  const userId = uid();
  const pub = `idkey-sweep-${userId}`;
  const res = await base.getOrCreateUserByIdentityKey(pub, userId, deps.now(), accountClass);
  expect(res.kind).toBe('ok');
  const token = `sweep-tok-${RUN}-${++seq}`;
  await base.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 30 * 86400,
  });
  return { userId, token, pub };
}

/** Seed a group row at the ROW level (the precedent) WITH the derived
 * memberIds/memberClasses sets the roster transactions condition on. */
async function seedGroup(
  nowMs: number,
  members: Array<{ userId: string; class: DeviceClass }>,
  epoch: number,
): Promise<string> {
  const groupId = uid();
  const certs = {
    offerSig: b64(`sig-${groupId}`),
    acceptSig: b64(`sig-${groupId}`),
    groupId,
    offererUserId: members[0]!.userId,
    acceptorUserId: members[1]!.userId,
    class: members[1]!.class,
    rosterEpoch: 0,
    offerNonce: `nonce-sweep-${RUN}-${++seq}`,
    expiresAt: Math.floor(nowMs / 1000) + 600,
  };
  await doc.send(
    new PutCommand({
      TableName: SERVER_TABLES.users,
      Item: {
        userId: groupRowKey(groupId),
        members: members.map((m) => ({ ...m, linkedAt: nowMs, certs })),
        memberClasses: new Set(members.map((m) => m.class)),
        memberIds: new Set(members.map((m) => m.userId)),
        identifierRefs: [],
        epoch,
        createdAt: nowMs,
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
  return groupId;
}

async function rawRow(
  table: string,
  key: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

function delEvent(token: string): HttpEvent {
  return { method: 'DELETE', path: '/v1/account', headers: { authorization: `Bearer ${token}` } };
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

/** The real ws handler with a swallow-everything transport — refusals are
 * read from the returned status, deliveries from the durable queue. */
function mkWsDeps(deps: TestDeps): WsDeps {
  return {
    ...deps,
    sender: { post: async () => true },
    scheduleDrain: async () => {},
    schedulePush: async () => {},
  };
}

/** Drive one real send frame through wsDefaultHandler as `senderUserId`. */
async function driveSend(
  wsDeps: WsDeps,
  senderUserId: string,
  to: string,
  msgId: string,
): Promise<number> {
  const res = await wsDefaultHandler(
    {
      routeKey: '$default' as const,
      connectionId: `conn-${senderUserId}`,
      senderUserId,
      body: JSON.stringify({ type: 'send', to, msgId, msgType: 'ciphertext', payload: 'QUJD' }),
    },
    wsDeps,
  );
  return res.statusCode;
}

/** Attach a verified email to the group through the REAL attach transaction
 * (code row + attachIdentifier), returning the versioned claim key. */
async function attachEmail(
  deps: TestDeps,
  owner: { userId: string },
  groupId: string | undefined,
  email: string,
  deviceClass: DeviceClass,
): Promise<{ claimKey: string; newGroupId: string }> {
  const hash = identifierClaimHash(TEST_KID, email);
  const claimKey = emailClaimKey(1, hash);
  const nowMs = deps.now();
  await base.putEmailCode({
    userId: owner.userId,
    purpose: 'attach',
    claimKey,
    deviceClass,
    code: '123456',
    attempts: 0,
    createdAt: nowMs,
    expiresAt: Math.floor(nowMs / 1000) + 300,
  });
  const newGroupId = uid();
  const result = await base.attachIdentifier({
    userId: owner.userId,
    deviceClass,
    ...(groupId !== undefined ? { existingGroupId: groupId } : {}),
    newGroupId,
    claimKey,
    nowMs,
  });
  expect(result).toBe('attached');
  return { claimKey, newGroupId };
}

/** Scan EVERY app-stack table for items whose serialized form contains any
 * canary string — the end-state walk. Returns `${table}:${JSON key}` labels. */
async function scanForCanaries(canaries: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const tables = Object.values(SERVER_TABLES);
  for (const table of tables) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await doc.send(
        new ScanCommand({
          TableName: table,
          ...(startKey !== undefined ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of res.Items ?? []) {
        const flat = JSON.stringify(item, (_k, v) => (v instanceof Set ? [...v] : v));
        if (canaries.some((c) => flat.includes(c))) {
          found.push(`${table}:${JSON.stringify(Object.fromEntries(Object.entries(item).filter(([k]) => ['userId', 'token', 'recipientId', 'bucket', 'agentId', 'keyId', 'msgId'].includes(k))))}`);
        }
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey !== undefined);
  }
  return found.sort();
}

describe('the four-surfaces sweep: survivor case FIRST, then the everything-deleted end state', () => {
  gated('a fully-loaded grouped account: deleting ONE member preserves the group, its claims, its consent, its pending recovery, and both other members — then deleting every member leaves NOTHING naming a member ULID or the groupId beyond the enumerated stated tombstones', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);

    // --- The fully-loaded account ---
    const phone = await mkAcct(deps);
    const tablet = await mkAcct(deps);
    const desktop = await mkAcct(deps); // seeded raw into the reserved slot
    const gid = await seedGroup(
      deps.now(),
      [
        { userId: phone.userId, class: 'phone' },
        { userId: tablet.userId, class: 'tablet' },
        { userId: desktop.userId, class: 'desktop' },
      ],
      2,
    );
    // Verified email + discovery ON (consent lives ON the claim row).
    const email = `sweep-${RUN}@example.com`;
    const { claimKey } = await attachEmail(deps, phone, gid, email, 'phone');
    expect(await base.setIdentifierDiscoverable(claimKey, gid, phone.userId, true)).toBe('set');
    // A pending OFFER row and a pending INIT row, both naming the phone as
    // offerer (the linkOfferNonces reverse pointers are what the sweep walks).
    const strangerA = await mkAcct(deps);
    const strangerB = await mkAcct(deps);
    const offerNonce = `nonce-sweep-off-${RUN}-${++seq}`;
    const initNonce = `nonce-sweep-init-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce,
        groupId: gid,
        offererUserId: phone.userId,
        acceptorUserId: strangerA.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 2,
        expiresAt: nowS() + 600,
        offerSig: b64(`o-${offerNonce}`),
      }),
    ).toBe('created');
    expect(
      await base.putLinkOfferInit(
        {
          offerNonce: initNonce,
          groupId: gid,
          offererUserId: phone.userId,
          acceptorUserId: strangerB.userId,
          acceptorClass: 'tablet',
          rosterEpoch: 2,
          expiresAt: nowS() + 600,
        },
        nowS(),
      ),
    ).toBe('created');
    // A bound-but-unadopted agent on the phone (crewCount stays 0, so the
    // crew_not_empty refusal does not apply — the member-deletion binding
    // fate is exactly what this drives). Consent edges both ways: one the
    // phone WROTE (purged with it), one an unrelated human wrote TOWARD the
    // agent (the stated residual — it survives).
    const agent = await mkAcct(deps, 'integration');
    expect(await base.bindIntegrationOwner(agent.userId, phone.userId)).toBe('bound');
    const outsider = await mkAcct(deps);
    expect(await base.writeConsentEdge(phone.userId, agent.userId, deps.now())).toBe('written');
    expect(await base.writeConsentEdge(outsider.userId, agent.userId, deps.now())).toBe('written');
    // A pending recovery against the group (a pristine recovering device).
    const recoverer = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        groupId: gid,
        newUserId: recoverer.userId,
        deviceClass: 'phone',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');

    const tabletRowBefore = await rawRow(SERVER_TABLES.users, { userId: tablet.userId });
    const desktopRowBefore = await rawRow(SERVER_TABLES.users, { userId: desktop.userId });

    // --- FIRST: delete ONE member; the survivor case is asserted before any
    // end state (survivor corruption FAILS here). ---
    const res = await deleteAccountHandler(
      delEvent(phone.token),
      deps,
      { userId: phone.userId } satisfies AuthContext,
    );
    expect(res.statusCode).toBe(200);

    // The deleted member is GONE whole: row, idkey claim (a human key is
    // freed, never tombstoned — revoke is the tombstoning verb).
    expect(await base.getUserById(phone.userId)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${phone.pub}` })).toBeUndefined();
    // The group row survives with the OTHER TWO members and a bumped epoch —
    // the deletion ran the amicable-unlink transaction, not a group kill.
    const groupAfterOne = await base.getAccountGroup(gid);
    expect(groupAfterOne).toBeDefined();
    expect(groupAfterOne!.members.map((m) => m.userId).sort()).toEqual(
      [tablet.userId, desktop.userId].sort(),
    );
    expect(groupAfterOne!.epoch).toBe(3);
    // Identifier claim + discovery consent survive untouched.
    expect(groupAfterOne!.identifierRefs).toEqual([claimKey]);
    const claimAfterOne = await base.getIdentifierClaim(claimKey);
    expect(claimAfterOne?.groupId).toBe(gid);
    expect(claimAfterOne?.discoverable).toBe(true);
    // The pending recovery survives — survivors can still cancel it.
    expect(await base.getRecoveryPending(gid)).toBeDefined();
    // Both other members' rows are untouched apart from nothing at all.
    expect(await rawRow(SERVER_TABLES.users, { userId: tablet.userId })).toEqual(tabletRowBefore);
    expect(await rawRow(SERVER_TABLES.users, { userId: desktop.userId })).toEqual(desktopRowBefore);
    // The deleted member's pending offer AND init rows are physically gone —
    // found via its linkOfferNonces reverse pointers, GetItem walk, no Query.
    expect(await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${offerNonce}` })).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.sessions, { token: `${LINK_INIT_KEY_PREFIX}${initNonce}` })).toBeUndefined();
    // The counterparties keep DEAD nonce pointers — the tolerated
    // residue, stated: the rows they point at are gone.
    const strangerRow = await rawRow(SERVER_TABLES.users, { userId: strangerA.userId });
    expect([...((strangerRow?.linkOfferNonces as Set<string> | undefined) ?? [])]).toContain(offerNonce);
    // Sessions and the calling token are dead.
    expect(await base.getSession(phone.token)).toBeUndefined();

    // --- The member-deletion binding fate (f5), driven with bounds:
    // the bound-but-unadopted agent OUTLIVES its deleted owner — bearer and
    // consent-edge reach only. Enumeration is impossible by design (no
    // owner→integrations index; DELETE /v1/account carries no body), so the
    // fate is this RECORDED bounded residual, not a tombstone. ---
    const agentRow = await base.getUserById(agent.userId);
    expect(agentRow).toBeDefined();
    expect(agentRow!.tombstoned).toBeUndefined(); // bearer survives (the bound)
    expect(agentRow!.ownerUserId).toBe(phone.userId); // names a ULID that resolves to nobody
    // Owner-directed reach is dead: the owner row is gone and the ULID can
    // never be re-minted (ULID collision aside, the claim row was the mint).
    expect(await base.getUserById(phone.userId)).toBeUndefined();
    // The edge the OWNER wrote died with it; the outsider's edge toward the
    // agent survives (the / stated class — writer-deletable only).
    expect(await base.hasConsentEdge(phone.userId, agent.userId)).toBe(false);
    expect(await base.hasConsentEdge(outsider.userId, agent.userId)).toBe(true);
    // The bounds DRIVEN THROUGH THE REAL HANDLERS, not inferred from rows
    //: the surviving agent's bearer still
    // authenticates (its sessions were never touched), and each reach arm
    // answers exactly what the record predicts.
    expect(await base.getSession(agent.token)).toBeDefined();
    const wsDeps = mkWsDeps(deps);
    // Owner-directed send: the dead ULID answers 404 unknown_recipient —
    // forever, since the idkey claim was the mint and it died with the row.
    expect(await driveSend(wsDeps, agent.userId, phone.userId, uid())).toBe(404);
    // Group reach fails CLOSED on the missing owner row: a surviving
    // member without a consent edge refuses with the frozen previous bytes.
    expect(await driveSend(wsDeps, agent.userId, tablet.userId, uid())).toBe(403);
    // Consent-edge reach SURVIVES (the writer-deletable bound): the
    // outsider's edge admits the send, and the frame lands durably.
    const consentMsgId = uid();
    expect(await driveSend(wsDeps, agent.userId, outsider.userId, consentMsgId)).toBe(200);
    expect((await allQueued(base, outsider.userId)).map((m) => m.msgId)).toContain(consentMsgId);

    // --- THEN: delete every member. The last member's exit takes the group
    // row, every claim the reverse list names, and the pending recovery. ---
    const resT = await deleteAccountHandler(delEvent(tablet.token), deps, { userId: tablet.userId });
    expect(resT.statusCode).toBe(200);
    const groupBeforeLast = await base.getAccountGroup(gid);
    expect(groupBeforeLast!.members.map((m) => m.userId)).toEqual([desktop.userId]);
    // The reverse-list walk the suite performs itself: capture the
    // refs BEFORE the last exit, GetItem each — never a Query.
    const refsBeforeLast = groupBeforeLast!.identifierRefs;
    expect(refsBeforeLast).toEqual([claimKey]);
    const resD = await deleteAccountHandler(delEvent(desktop.token), deps, { userId: desktop.userId });
    expect(resD.statusCode).toBe(200);
    expect(await base.getAccountGroup(gid)).toBeUndefined();
    for (const ref of refsBeforeLast) {
      expect(await rawRow(SERVER_TABLES.users, { userId: ref })).toBeUndefined();
    }
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(gid) })).toBeUndefined();
    // The recovering device's reverse pointer cleared with the recovery row
    // (the stale-pointer class, reaped here).
    expect((await base.getUserById(recoverer.userId))?.recoveryGroupId).toBeUndefined();

    // --- The end state OF ACCOUNT DELETION ITSELF, scanned BEFORE any
    // further operation (the old order deleted
    // the surviving agent first, so the scan proved a state no deletion
    // sweep produces and hid the exact inherited residual this suite was
    // meant to characterize): after all three members are gone, EXACTLY ONE
    // row still names a member ULID — the surviving agent's own user row,
    // whose write-once `ownerUserId` is the recorded bounded residual.
    const residualAfterMembers = await scanForCanaries([
      phone.userId,
      tablet.userId,
      desktop.userId,
      gid,
    ]);
    expect(residualAfterMembers).toEqual([
      `${SERVER_TABLES.users}:${JSON.stringify({ userId: agent.userId })}`,
    ]);

    // The agent tears itself down (the ownerless operator's own documented
    // path): its row deletes; its KEY tombstones permanently — the ONE
    // stated-tombstone class this scenario leaves, enumerated by exact key.
    const resA = await deleteAccountHandler(delEvent(agent.token), deps, { userId: agent.userId });
    expect(resA.statusCode).toBe(200);
    const agentTombstone = await rawRow(SERVER_TABLES.users, {
      userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}`,
    });
    expect(agentTombstone?.tombstoned).toBe(true);

    // --- The final scan: EVERY table, paged, for ANY row containing any
    // member ULID or the groupId. The permitted survivors are enumerated by
    // exact key above (the agent's idkey tombstone — which names the agent's
    // KEY, no member ULID; the outsider's consent edge — agent + outsider
    // ids only). Nothing else may remain: an empty match set IS the assert.
    const leaks = await scanForCanaries([phone.userId, tablet.userId, desktop.userId, gid]);
    expect(leaks).toEqual([]);
  });
});

describe('the -deferred physical reaps: the explicit clock refuses (already), and the refusing read now REAPS', () => {
  gated('an expired pending-recovery row refuses completion by the clock AND is physically deleted at that read, its reverse pointer cleared; an expired row met by cancel reaps the same way', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    // A solo attach-created group with a pending recovery.
    const owner = await mkAcct(deps);
    const email = `reap-rec-${RUN}@example.com`;
    const { claimKey, newGroupId } = await attachEmail(deps, owner, undefined, email, 'phone');
    const recoverer = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        groupId: newGroupId,
        newUserId: recoverer.userId,
        deviceClass: 'tablet',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    // Past the completion window: the row is provably still present
    // (expired-but-unreaped — the users table has no TTL attribute at all),
    // the completion refuses by the clock, AND the refusing read reaps it.
    deps.advanceMs((RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS + 60) * 1000);
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) })).toBeDefined();
    const outcome = await base.completeRecovery({
      groupId: newGroupId,
      newUserId: recoverer.userId,
      nowSeconds: nowS(),
      linkedAtMs: deps.now(),
      discoverableAfter: nowS() + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
    });
    expect(outcome.outcome).toBe('stale');
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) })).toBeUndefined();
    expect((await base.getUserById(recoverer.userId))?.recoveryGroupId).toBeUndefined();
    // And the CANCEL path reaps an expired row the same way (a second
    // pending row, expired, met by a member's cancel: 'gone' + physically gone).
    const recoverer2 = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        groupId: newGroupId,
        newUserId: recoverer2.userId,
        deviceClass: 'tablet',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    deps.advanceMs((RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS + 60) * 1000);
    expect(await base.cancelRecoveryPending(newGroupId, nowS())).toBe('gone');
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) })).toBeUndefined();
  });

  gated('an expired verification-code row refuses by the clock AND is physically deleted at that read (the sessions-table TTL stays the async backstop, never the enforcement)', async () => {
    const deps = freshDeps();
    const user = await mkAcct(deps);
    const hash = identifierClaimHash(TEST_KID, `reap-code-${RUN}@example.com`);
    await base.putEmailCode({
      userId: user.userId,
      purpose: 'attach',
      claimKey: emailClaimKey(1, hash),
      deviceClass: 'phone',
      code: '654321',
      attempts: 0,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 300,
    });
    deps.advanceMs(301 * 1000);
    const codeKey = `${EMAIL_CODE_KEY_PREFIX}${user.userId}#attach`;
    expect(await rawRow(SERVER_TABLES.sessions, { token: codeKey })).toBeDefined();
    expect(
      await base.takeEmailCodeAttempt(user.userId, 'attach', Math.floor(deps.now() / 1000)),
    ).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.sessions, { token: codeKey })).toBeUndefined();
  });

  gated('a suppression shadow now carries the pinned explicit expiry, refuses nothing past it, and the elapsed row is physically deleted at the read — SES account-level suppression stays the durable authority', async () => {
    // The release pin, asserted as the release value (never a shadow).
    expect(EMAIL_SUPPRESSION_TTL_SECONDS).toBe(90 * 86400);
    const deps = freshDeps();
    const hash = identifierClaimHash(TEST_KID, `reap-supp-${RUN}@example.com`);
    const suppKey = emailSuppressionKey(1, hash);
    await base.putIdentifierSuppression(suppKey, deps.now());
    const row = await rawRow(SERVER_TABLES.users, { userId: suppKey });
    expect(row?.expiresAt).toBe(Math.floor(deps.now() / 1000) + EMAIL_SUPPRESSION_TTL_SECONDS);
    expect(await base.isIdentifierSuppressed(suppKey, Math.floor(deps.now() / 1000))).toBe(true);
    // Still suppressed just inside the window; row intact.
    deps.advanceMs((EMAIL_SUPPRESSION_TTL_SECONDS - 60) * 1000);
    expect(await base.isIdentifierSuppressed(suppKey, Math.floor(deps.now() / 1000))).toBe(true);
    // Past it: not suppressed, and the read REAPED the row.
    deps.advanceMs(120 * 1000);
    expect(await base.isIdentifierSuppressed(suppKey, Math.floor(deps.now() / 1000))).toBe(false);
    expect(await rawRow(SERVER_TABLES.users, { userId: suppKey })).toBeUndefined();
  });

  gated('an elapsed emailcool shadow is inert by its own clock (already) and physically deleted at the reading walk (a reap class)', async () => {
    const deps = freshDeps();
    const nowS = Math.floor(deps.now() / 1000);
    const hash = identifierClaimHash(TEST_KID, `reap-cool-${RUN}@example.com`);
    const claimKey = emailClaimKey(1, hash);
    const coolKey = emailCooldownKeyFromClaimKey(claimKey);
    // Planted in exactly the shape completeRecovery's transaction writes
    // (kind + discoverableAfter + updatedAt) — driving the whole recovery
    // ceremony again here would re-test the reap is what is under test.
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: coolKey, kind: 'emailCooldown', discoverableAfter: nowS + 60, updatedAt: nowS },
      }),
    );
    // Live: read back, row stays.
    expect(await base.getIdentifierRecoveryCooldown([claimKey], nowS)).toBe(nowS + 60);
    expect(await rawRow(SERVER_TABLES.users, { userId: coolKey })).toBeDefined();
    // Elapsed: no cool-down, and the walk reaped the shadow.
    expect(await base.getIdentifierRecoveryCooldown([claimKey], nowS + 120)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: coolKey })).toBeUndefined();
  });
});

describe('the known residual, recorded with DRIVEN bounds: a last-member self-revoke naming no agents', () => {
  gated('the unnamed agent keeps its bearer (row untombstoned) while every owner-directed and group capability is dead: owner row tombstoned, group row + claims + recovery gone', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const gid = await seedGroup(
      deps.now(),
      [
        { userId: a.userId, class: 'phone' },
        { userId: b.userId, class: 'tablet' },
      ],
      1,
    );
    const email = `f3-${RUN}@example.com`;
    const { claimKey } = await attachEmail(deps, a, gid, email, 'phone');
    const agent = await mkAcct(deps, 'integration');
    expect(await base.bindIntegrationOwner(agent.userId, b.userId)).toBe('bound');
    // An outsider's consent edge toward the agent — the reach arm the
    // record says survives the revoke, driven below.
    const outsider = await mkAcct(deps);
    expect(await base.writeConsentEdge(outsider.userId, agent.userId, deps.now())).toBe('written');
    const recoverer = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        groupId: gid,
        newUserId: recoverer.userId,
        deviceClass: 'phone',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    // a amicably unlinks (b becomes the last member)...
    expect(
      await base.unlinkDeviceFromGroup({
        groupId: gid,
        actingUserId: a.userId,
        targetUserId: a.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    // ...then b self-revokes as the LAST member, naming NO agents (the
    // stolen-device worst case with a stale or empty machine roster).
    expect(
      await base.revokeDeviceFromGroup({
        groupId: gid,
        actingUserId: b.userId,
        targetUserId: b.userId,
        rosterEpoch: 2,
        agents: [],
      }),
    ).toBe('revoked');
    // The bounds, exactly as recorded (f3 →): the group row, its
    // claims, and the pending recovery all died with the last member...
    expect(await base.getAccountGroup(gid)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: claimKey })).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(gid) })).toBeUndefined();
    // ...the owner row is TOMBSTONED (owner-directed sends refuse, auth
    // refuses the key — the record is the enforcement)...
    const ownerRow = await rawRow(SERVER_TABLES.users, { userId: b.userId });
    expect(ownerRow?.tombstoned).toBe(true);
    // ...and the UNNAMED agent's bearer capability survives, exactly the
    // recorded residual: row live, key untombstoned. Its reach is bounded to
    // bearer + consent-edges (writer-deletable) + same-crew traffic; every
    // owner/group predicate fails closed on the tombstoned owner row.
    const agentRow = await base.getUserById(agent.userId);
    expect(agentRow?.tombstoned).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${agent.pub}` }))?.tombstoned).toBeUndefined();
    // The bounds DRIVEN THROUGH THE REAL HANDLERS ("driven" must
    // mean the handlers answered,
    // not that the rows looked right): the bearer still authenticates;
    // owner-directed traffic refuses on the tombstone; the consent edge
    // still carries a frame end to end.
    expect(await base.getSession(agent.token)).toBeDefined();
    const wsDeps = mkWsDeps(deps);
    // The tombstoned owner refuses AT ENQUEUE — recipient_revoked's 403,
    // the record being the enforcement.
    expect(await driveSend(wsDeps, agent.userId, b.userId, uid())).toBe(403);
    // The consent-edge arm survives, exactly the recorded bound.
    const f3MsgId = uid();
    expect(await driveSend(wsDeps, agent.userId, outsider.userId, f3MsgId)).toBe(200);
    expect((await allQueued(base, outsider.userId)).map((m) => m.msgId)).toContain(f3MsgId);
  });
});

describe('the fix-pass closures: recovery rows can neither be born dead nor die orphaned, and shadows reap across the rotation window', () => {
  gated('a recovery cannot be created against a dead claim or a dead group — the transaction refuses what the precheck can no longer see (fix f4)', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const rec = {
      deviceClass: 'tablet' as const,
      requestedAt: deps.now(),
      completesAt: nowS() + RECOVERY_DELAY_SECONDS,
      expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
    };
    // Dead GROUP: the lazy-solo unlink reaped group AND claim; a recovery
    // planted from the stale precheck snapshot must refuse whole.
    const owner = await mkAcct(deps);
    const { claimKey, newGroupId } = await attachEmail(deps, owner, undefined, `f4a-${RUN}@example.com`, 'phone');
    expect(
      await base.unlinkIdentifierClass({ userId: owner.userId, groupId: newGroupId, refsSnapshot: [claimKey], claimKeys: [claimKey] }),
    ).toBe('unlinked');
    const r1 = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({ ...rec, groupId: newGroupId, newUserId: r1.userId, claimKey }),
    ).toBe('stale');
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) })).toBeUndefined();
    expect((await base.getUserById(r1.userId))?.recoveryGroupId).toBeUndefined();
    // Dead CLAIM, live group: a ceremony group that unlinked its identifier
    // mid-window — the claim condition alone refuses.
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const gid = await seedGroup(
      deps.now(),
      [
        { userId: a.userId, class: 'phone' },
        { userId: b.userId, class: 'tablet' },
      ],
      1,
    );
    const { claimKey: ck2 } = await attachEmail(deps, a, gid, `f4b-${RUN}@example.com`, 'phone');
    expect(await base.unlinkIdentifierClass({ userId: a.userId, groupId: gid, refsSnapshot: [ck2], claimKeys: [ck2] })).toBe('unlinked');
    const r2 = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({ ...rec, groupId: gid, newUserId: r2.userId, claimKey: ck2 }),
    ).toBe('stale');
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(gid) })).toBeUndefined();
    expect((await base.getUserById(r2.userId))?.recoveryGroupId).toBeUndefined();
  });

  gated('the solo row delete takes the pending-recovery row in the SAME transaction — and a row re-minted for another device survives the stale hint (fix f2)', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const owner = await mkAcct(deps);
    const { claimKey, newGroupId } = await attachEmail(deps, owner, undefined, `f2-${RUN}@example.com`, 'phone');
    const shape = {
      groupId: newGroupId,
      deviceClass: 'tablet' as const,
      claimKey,
      requestedAt: deps.now(),
      completesAt: nowS() + RECOVERY_DELAY_SECONDS,
      expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
    };
    const r1 = await mkAcct(deps);
    expect(await base.putRecoveryPending({ ...shape, newUserId: r1.userId })).toBe('created');
    // The fused path: NO purge runs here — the deleteUser transaction alone
    // must take the recovery row with the recovering device's row.
    expect(
      await base.deleteUser(
        r1.userId,
        { identityKeyPub: r1.pub, pendingRecoveryGroupId: newGroupId },
        { requireEmptyCrew: true },
      ),
    ).toBe('deleted');
    expect(await base.getUserById(r1.userId)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) })).toBeUndefined();
    // The stale-hint arm: the row now names ANOTHER device; a deletion
    // carrying the stale hint deletes its own row and leaves the
    // replacement's recovery untouched (condition-cancel, retry-without).
    const r2 = await mkAcct(deps);
    expect(await base.putRecoveryPending({ ...shape, newUserId: r2.userId })).toBe('created');
    const stale = await mkAcct(deps);
    expect(
      await base.deleteUser(
        stale.userId,
        { identityKeyPub: stale.pub, pendingRecoveryGroupId: newGroupId },
        { requireEmptyCrew: true },
      ),
    ).toBe('deleted');
    expect(await base.getUserById(stale.userId)).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) }))?.newUserId).toBe(r2.userId);
  });

  gated('a LIVE cancel clears the refused device\'s reverse pointer, and a replacement clears the displaced device\'s (fix f5)', async () => {
    const deps = freshDeps();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const owner = await mkAcct(deps);
    const { claimKey, newGroupId } = await attachEmail(deps, owner, undefined, `f5-${RUN}@example.com`, 'phone');
    const shape = {
      groupId: newGroupId,
      deviceClass: 'tablet' as const,
      claimKey,
      requestedAt: deps.now(),
      completesAt: nowS() + RECOVERY_DELAY_SECONDS,
      expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
    };
    const devA = await mkAcct(deps);
    expect(await base.putRecoveryPending({ ...shape, newUserId: devA.userId })).toBe('created');
    expect((await base.getUserById(devA.userId))?.recoveryGroupId).toBe(newGroupId);
    // Live cancel: the row stays (canceled, replaceable, readable-refusing)
    // but the pointer goes — no live row keeps naming a recovery that was
    // refused out from under it.
    expect(await base.cancelRecoveryPending(newGroupId, nowS())).toBe('canceled');
    expect((await base.getUserById(devA.userId))?.recoveryGroupId).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(newGroupId) }))?.canceled).toBe(true);
    // Replacement over the canceled row for a DIFFERENT device: the new
    // pointer is set, the displaced device stays clean.
    const devB = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        ...shape,
        newUserId: devB.userId,
        requestedAt: deps.now(),
      }),
    ).toBe('created');
    expect((await base.getUserById(devB.userId))?.recoveryGroupId).toBe(newGroupId);
    expect((await base.getUserById(devA.userId))?.recoveryGroupId).toBeUndefined();
    // Replacement over an EXPIRED (never-canceled) row: the displaced
    // device's pointer — which no cancel ever cleared — goes with it.
    deps.advanceMs((RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS + 60) * 1000);
    const devC = await mkAcct(deps);
    expect(
      await base.putRecoveryPending({
        ...shape,
        newUserId: devC.userId,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    expect((await base.getUserById(devC.userId))?.recoveryGroupId).toBe(newGroupId);
    expect((await base.getUserById(devB.userId))?.recoveryGroupId).toBeUndefined();
  });

  gated('the suppression shadow suppresses AND reaps across the WHOLE rotation window — a retiring-version row is neither ineffective nor unreachable (fix f1)', async () => {
    const deps = freshDeps();
    // A two-version window: v2 is newest (what sends key on), v1 retiring —
    // exactly the state in which the old newest-only read made a v1 shadow
    // both ineffective and unreapable forever.
    const routeDeps = {
      ...deps,
      identifierHmac: {
        keys: [
          { version: 2, key: `${TEST_KID}-v2` },
          { version: 1, key: TEST_KID },
        ],
      },
    };
    const caller = await mkAcct(deps);
    const email = `f1-rotate-${RUN}@example.com`;
    const v1Key = emailSuppressionKey(1, identifierClaimHash(TEST_KID, email));
    await base.putIdentifierSuppression(v1Key, deps.now());
    // Inside the window: the v1 shadow SUPPRESSES a send keyed v2 — the
    // walk visits every active version, so no SES call leaves.
    const sent = deps.emailsSent.length;
    const res = await emailRequestCodeRoute(post(caller.token, { email, class: 'phone' }), routeDeps);
    expect(res.statusCode).toBe(200); // uniform refusal
    expect(deps.emailsSent.length).toBe(sent);
    expect(await rawRow(SERVER_TABLES.users, { userId: v1Key })).toBeDefined();
    // Past the pinned 90 days: the send proceeds AND the reading walk
    // physically reaps the elapsed v1 row. (A fresh bearer — the 30-day
    // session lapsed across the advance; the shadow's clock is the fact
    // under test, not the session's.)
    deps.advanceMs((EMAIL_SUPPRESSION_TTL_SECONDS + 60) * 1000);
    const token2 = `sweep-tok-${RUN}-${++seq}`;
    await base.createSession({
      token: token2,
      userId: caller.userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 30 * 86400,
    });
    const res2 = await emailRequestCodeRoute(post(token2, { email, class: 'phone' }), routeDeps);
    expect(res2.statusCode).toBe(200);
    expect(deps.emailsSent.length).toBe(sent + 1);
    expect(await rawRow(SERVER_TABLES.users, { userId: v1Key })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The queued-ciphertext purge on account
// deletion paged the caller's queue at the DEFAULT consistency: a stale page
// could miss a row enqueued moments before the delete, and that ciphertext
// (plus senderId / recipientId / ts) then lived to its 30-day TTL — "it
// expires eventually" is not deletion. DynamoDB Local does not simulate the
// stale replica, so the property is pinned on the SDK command itself, the
// purgeConsentEdges / queue.consistency.test.ts discipline. Not gated: no
// store is touched.
// ---------------------------------------------------------------------------

describe('purgeQueuedMessages reads the queue strongly consistently', () => {
  it('every page of the keys-only Query carries ConsistentRead, and each page is deleted', async () => {
    const commands: unknown[] = [];
    let page = 0;
    const doc = {
      send: async (cmd: unknown): Promise<unknown> => {
        commands.push(cmd);
        if (cmd instanceof QueryCommand) {
          page += 1;
          // Two pages: the first continues, the second is the last.
          return page === 1
            ? { Items: [{ recipientId: 'R', msgId: 'M1' }], LastEvaluatedKey: { recipientId: 'R', msgId: 'M1' } }
            : { Items: [{ recipientId: 'R', msgId: 'M2' }] };
        }
        return {}; // BatchWrite: nothing unprocessed
      },
    } as unknown as DynamoDBDocumentClient;

    await makeDataLayer(doc).purgeQueuedMessages('R');

    const queries = commands.filter((c) => c instanceof QueryCommand) as QueryCommand[];
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.input.TableName).toBe(SERVER_TABLES.messages);
      expect(q.input.ConsistentRead).toBe(true);
      // Keys only: ciphertext is never read to be destroyed.
      expect(q.input.ProjectionExpression).toBe('recipientId, msgId');
    }
    const deleted = (commands.filter((c) => c instanceof BatchWriteCommand) as BatchWriteCommand[])
      .flatMap((b) => b.input.RequestItems?.[SERVER_TABLES.messages] ?? [])
      .map((w) => (w.DeleteRequest?.Key as { msgId: string }).msgId);
    expect(deleted).toEqual(['M1', 'M2']);
  });
});
