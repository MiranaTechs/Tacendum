import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { LINK_OFFER_KEY_PREFIX, groupRowKey, makeDataLayer, type DataLayer } from '../src/db/data.js';
import { emailClaimKey, identifierClaimHash } from '../src/opaque-ref.js';
import { emailUnlinkRoute, emailVerifyRoute, emailRequestCodeRoute } from '../src/handlers/identifiers.js';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * downgrade-back-to-anonymous as a TESTED FIRST-CLASS
 * FLOW against REAL DynamoDB Local. The claim: downgrade
 * leaves the per-device accounts able to message, and the store state
 * deep-equals a never-opted-in fixture except the enumerated tombstones.
 *
 * The fixture discipline: the never-opted-in state is CAPTURED from the
 * store itself before any opt-in (a dump of every row this run minted), and
 * the post-downgrade dump must DEEP-EQUAL it — no allowlist of "probably
 * fine" residue. The scenarios enumerate their exceptions explicitly;
 * scenarios 1 and 2 — a group with NO pending ceremony and NO exchanged
 * mail — have NONE (a recovery-armed cool-down shadow is the one
 * sanctioned survivor, driven in the sweep suite's reap cases), and
 * scenario 4 drives the LOADED state whose residue names: every
 * exception is enumerated by exact key and every one carries a TTL bound
 * (the unloaded scenario alone could never
 * observe the documented ledger residue).
 *
 * Four scenarios:
 * 1. A CEREMONY group (phone+tablet, verified email, consent ON) with no
 * pending ceremonies and no exchanged mail walks the downgrade:
 * identifier unlink, then the roster down with the initiating device
 * LAST — the last exit is the transaction that deletes the group row.
 * Post-state deep-equals pre-state; the two devices then exchange a
 * REAL ws send as the strangers they now are.
 * 2. The LAZY-SOLO class:
 * an attach-created solo group's client can never learn its groupId (the
 * wire is uniform), so its downgrade IS the identifier unlink — the
 * server reaps the never-ceremonially-grouped solo group row in the
 * same transaction, returning the account to never-opted-in exactly.
 * 3. The scope bound of that reap, driven: a CEREMONY group's identifier
 * unlink does NOT dissolve the group (its members walked a ceremony,
 * know their groupId, and dissolve deliberately via the roster verbs).
 * 4. The LOADED downgrade: a still-pending link offer and one queued
 * sibling message ride into the walk-down. What survives is EXACTLY the
 * enumerated TTL-bounded residue (as amended) and disclose —
 * the offer row until its sessions-table TTL (inert meanwhile: its
 * acceptance refuses on the dead group), the dead nonce pointers on the
 * two rows that named it, and the queued message + pair-ledger rows
 * until message TTL — and NOTHING else differs from never-opted-in.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let base: DataLayer;
let db: DataLayer;
let available = false;

// '78' is this file's discriminator (the accounts-link parallel-fork lesson).
const RUN = `${Date.now()}78`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const TEST_KID = 'test-identifier-hmac-key';

beforeAll(async () => {
  const client = makeDynamoClient();
  base = makeDataLayer(makeDocClient(client));
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

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string; pub: string }> {
  const userId = uid();
  const pub = `idkey-dg-${userId}`;
  const res = await base.getOrCreateUserByIdentityKey(pub, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `dg-tok-${RUN}-${++seq}`;
  await base.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 30 * 86400,
  });
  return { userId, token, pub };
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

/** Canonical serialization: attribute order from DynamoDB is not stable, so
 * two dumps of the SAME state must compare equal — keys sorted recursively,
 * Sets rendered as sorted arrays. */
function canonical(value: unknown): unknown {
  if (value instanceof Set) return [...(value as Set<string>)].sort();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** Every row this run minted, across every app table — the fixture dump.
 * Items are matched by this run's RUN discriminator (every ULID, token,
 * groupId, claim hash input, and nonce this suite mints embeds it), then
 * canonicalized so two dumps compare structurally. */
async function dumpRun(): Promise<string[]> {
  const rows: string[] = [];
  for (const table of Object.values(SERVER_TABLES)) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await doc.send(
        new ScanCommand({
          TableName: table,
          ...(startKey !== undefined ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of res.Items ?? []) {
        const flat = JSON.stringify(canonical(item));
        if (flat.includes(RUN)) rows.push(`${table}:${flat}`);
      }
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey !== undefined);
  }
  return rows.sort();
}

async function attachEmailViaRoutes(
  deps: TestDeps,
  acct: { token: string },
  email: string,
  deviceClass: 'phone' | 'tablet',
): Promise<string> {
  const req = await emailRequestCodeRoute(post(acct.token, { email, class: deviceClass }), deps);
  expect(req.statusCode).toBe(200);
  const sent = deps.emailsSent[deps.emailsSent.length - 1]!;
  expect(sent.address).toBe(email);
  const verify = await emailVerifyRoute(post(acct.token, { email, code: sent.code }), deps);
  expect(verify.statusCode).toBe(200);
  return emailClaimKey(1, identifierClaimHash(TEST_KID, email));
}

describe('downgrade-back-to-anonymous, first-class', () => {
  gated('a ceremony group with no pending ceremony and no exchanged mail walks the downgrade (identifier unlink, roster walked down, initiator LAST) — the store deep-equals the captured never-opted-in fixture with ZERO exceptions, and the ex-siblings still message as strangers', async () => {
    const deps = makeTestDeps(db);
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const phone = await mkAcct(deps);
    const tablet = await mkAcct(deps);

    // THE NEVER-OPTED-IN FIXTURE: captured, not imagined.
    const fixture = await dumpRun();
    expect(fixture.length).toBeGreaterThan(0); // two rows + two sessions at least

    // Opt in: the real offer/link transactions (signature verification is
    // the suite; the flag-gate data-layer pattern), then the real attach
    // + consent routes.
    const groupId = uid();
    const offerNonce = `nonce-dg-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: phone.userId,
        acceptorUserId: tablet.userId,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: nowS() + 600,
        offerSig: b64(`o-${offerNonce}`),
      }),
    ).toBe('created');
    expect(
      await base.linkDeviceToGroup({
        offerNonce,
        acceptSig: b64(`a-${offerNonce}`),
        nowSeconds: nowS(),
        linkedAtMs: deps.now(),
      }),
    ).toBe('linked');
    const email = `dg-ceremony-${RUN}@example.com`;
    const claimKey = await attachEmailViaRoutes(deps, phone, email, 'phone');
    expect(await base.setIdentifierDiscoverable(claimKey, groupId, phone.userId, true)).toBe('set');
    // Loaded, provably: group row, claim row, groupId on both devices.
    expect((await base.getAccountGroup(groupId))?.identifierRefs).toEqual([claimKey]);
    expect((await base.getUserById(phone.userId))?.groupId).toBe(groupId);
    expect((await base.getUserById(tablet.userId))?.groupId).toBe(groupId);

    // THE DOWNGRADE (the client's walk, server half): identifier
    // unlink first (claims + consent die), then the roster walked down with
    // the initiating device LAST — its exit is the transaction that deletes
    // the group row.
    expect((await emailUnlinkRoute(post(phone.token, {}), deps)).statusCode).toBe(200);
    expect(
      await base.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    expect(
      await base.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: phone.userId,
        rosterEpoch: 2,
      }),
    ).toBe('unlinked');

    // Server residue: NONE. The post-downgrade dump deep-equals the
    // never-opted-in fixture — group row, claim row, consent, groupId
    // attributes, offer rows, code rows, reverse pointers: all gone, and
    // nothing new appeared. No enumerated exceptions in this scenario.
    expect(await base.getAccountGroup(groupId)).toBeUndefined();
    expect(await dumpRun()).toEqual(fixture);

    // And the per-device accounts still MESSAGE — the real ws handler, the
    // ordinary stranger path ("the devices continue as the unrelated
    // standalone contacts they now are").
    const wsDeps: WsDeps = {
      ...deps,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const msgId = uid();
    const sendRes = await wsDefaultHandler(
      {
        routeKey: '$default' as const,
        connectionId: `conn-${phone.userId}`,
        senderUserId: phone.userId,
        body: JSON.stringify({
          type: 'send',
          to: tablet.userId,
          msgId,
          msgType: 'ciphertext',
          payload: 'QUJD',
        }),
      },
      wsDeps,
    );
    expect(sendRes.statusCode).toBe(200);
    expect((await allQueued(base, tablet.userId)).map((m) => m.msgId)).toContain(msgId);
    // (the send queued one durable row for the tablet — drain it back out of
    // the fixture comparison's scope by ending the scenario here; the dump
    // comparison above ran BEFORE the send, deliberately.)
  });

  gated('the LAZY-SOLO class (row 29b): unlinking the identifier of a never-ceremonially-grouped attach-created solo group reaps the group row and the groupId in the same transaction — the account returns to never-opted-in EXACTLY', async () => {
    const deps = makeTestDeps(db);
    const solo = await mkAcct(deps);
    const fixture = await dumpRun();

    // The lazy solo group: born at attach, no ceremony ever. Its
    // client can never learn the server-minted groupId (the wire answers
    // uniformly — 's f11 note), so no client verb can ever reach
    // the roster walk: the identifier unlink IS this class's downgrade.
    const email = `dg-solo-${RUN}@example.com`;
    await attachEmailViaRoutes(deps, solo, email, 'phone');
    const soloRow = await base.getUserById(solo.userId);
    const soloGroupId = soloRow?.groupId;
    expect(soloGroupId).toBeDefined();
    expect(await base.getAccountGroup(soloGroupId!)).toBeDefined();

    expect((await emailUnlinkRoute(post(solo.token, {}), deps)).statusCode).toBe(200);

    // The reap: group row GONE, groupId attribute GONE, claim gone — the
    // store deep-equals the never-opted-in fixture, zero exceptions.
    expect(await base.getAccountGroup(soloGroupId!)).toBeUndefined();
    expect((await base.getUserById(solo.userId))?.groupId).toBeUndefined();
    expect(await dumpRun()).toEqual(fixture);
  });

  gated('the scope bound, driven: a CEREMONY group survives its identifier unlink intact — only the roster verbs dissolve a group whose members walked a ceremony', async () => {
    const deps = makeTestDeps(db);
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const groupId = uid();
    const offerNonce = `nonce-dg2-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: a.userId,
        acceptorUserId: b.userId,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: nowS() + 600,
        offerSig: b64(`o-${offerNonce}`),
      }),
    ).toBe('created');
    expect(
      await base.linkDeviceToGroup({
        offerNonce,
        acceptSig: b64(`a-${offerNonce}`),
        nowSeconds: nowS(),
        linkedAtMs: deps.now(),
      }),
    ).toBe('linked');
    const email = `dg-bound-${RUN}@example.com`;
    await attachEmailViaRoutes(deps, a, email, 'phone');

    expect((await emailUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);

    // The group survives whole: both members, their groupIds, the row.
    const group = await base.getAccountGroup(groupId);
    expect(group).toBeDefined();
    expect(group!.members.map((m) => m.userId).sort()).toEqual([a.userId, b.userId].sort());
    expect(group!.identifierRefs).toEqual([]);
    expect((await base.getUserById(a.userId))?.groupId).toBe(groupId);
    expect((await base.getUserById(b.userId))?.groupId).toBe(groupId);
    // (raw row shape asserted too: the reap must not have touched it)
    const raw = await doc.send(
      new GetCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: groupRowKey(groupId) },
        ConsistentRead: true,
      }),
    );
    expect(raw.Item?.epoch).toBe(1);
  });

  gated('the LOADED downgrade: a pending offer and queued sibling mail ride the walk-down — what survives is EXACTLY the enumerated TTL-bounded residue, nothing else differs from never-opted-in, and the leftover offer is inert', async () => {
    const deps = makeTestDeps(db);
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const phone = await mkAcct(deps);
    const tablet = await mkAcct(deps);
    const strangerC = await mkAcct(deps); // the pending offer's counterpart
    const fixture = await dumpRun();

    // Opt in (the scenario-1 walk), then LOAD the state the unloaded
    // scenario could never observe: a still-pending offer to a stranger,
    // and one real queued message between the siblings.
    const groupId = uid();
    const offerNonce0 = `nonce-dg4-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce: offerNonce0,
        groupId,
        offererUserId: phone.userId,
        acceptorUserId: tablet.userId,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: nowS() + 600,
        offerSig: b64(`o-${offerNonce0}`),
      }),
    ).toBe('created');
    expect(
      await base.linkDeviceToGroup({
        offerNonce: offerNonce0,
        acceptSig: b64(`a-${offerNonce0}`),
        nowSeconds: nowS(),
        linkedAtMs: deps.now(),
      }),
    ).toBe('linked');
    const email = `dg-loaded-${RUN}@example.com`;
    await attachEmailViaRoutes(deps, phone, email, 'phone');
    // The PENDING offer (never accepted): phone → strangerC, pinned to the
    // live roster's epoch.
    const offerNonce = `nonce-dg4p-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: phone.userId,
        acceptorUserId: strangerC.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 1,
        expiresAt: nowS() + 600,
        offerSig: b64(`o-${offerNonce}`),
      }),
    ).toBe('created');
    // One REAL queued message phone → tablet while grouped: this is what
    // mints the group-scoped pair-ledger rows recorded as
    // the dissolved-groupId residue class.
    const wsDeps: WsDeps = {
      ...deps,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const sentMsgId = uid();
    const sendRes = await wsDefaultHandler(
      {
        routeKey: '$default' as const,
        connectionId: `conn-${phone.userId}`,
        senderUserId: phone.userId,
        body: JSON.stringify({
          type: 'send',
          to: tablet.userId,
          msgId: sentMsgId,
          msgType: 'ciphertext',
          payload: 'QUJD',
        }),
      },
      wsDeps,
    );
    expect(sendRes.statusCode).toBe(200);

    // THE DOWNGRADE, loaded: identifier unlink, roster walked down,
    // initiator last.
    expect((await emailUnlinkRoute(post(phone.token, {}), deps)).statusCode).toBe(200);
    expect(
      await base.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    expect(
      await base.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: phone.userId,
        rosterEpoch: 2,
      }),
    ).toBe('unlinked');
    expect(await base.getAccountGroup(groupId)).toBeUndefined();

    // THE ENUMERATION (as amended): every surviving difference
    // from never-opted-in is one of the named TTL-bounded classes, by exact
    // key — and nothing else moved.
    const after = await dumpRun();
    const missing = fixture.filter((r) => !after.includes(r));
    const residue = after.filter((r) => !fixture.includes(r));
    // The only fixture rows allowed to have CHANGED are the two that now
    // carry the dead nonce pointer (their new serializations are classified
    // below).
    expect(missing.length).toBe(2);
    for (const row of missing) {
      expect(row.startsWith(`${SERVER_TABLES.users}:`)).toBe(true);
      expect(
        row.includes(`"userId":"${phone.userId}"`) || row.includes(`"userId":"${strangerC.userId}"`),
      ).toBe(true);
    }
    const parse = (row: string): { table: string; item: Record<string, unknown> } => {
      const idx = row.indexOf(':');
      return {
        table: row.slice(0, idx),
        item: JSON.parse(row.slice(idx + 1)) as Record<string, unknown>,
      };
    };
    for (const row of residue) {
      const { table, item } = parse(row);
      if (table === SERVER_TABLES.sessions) {
        // The pending-offer row: the ONE store here with a real TTL
        // attribute, its explicit expiresAt refused at every read meanwhile.
        expect(item.token).toBe(`${LINK_OFFER_KEY_PREFIX}${offerNonce}`);
        expect(typeof item.expiresAt).toBe('number');
      } else if (table === SERVER_TABLES.messages) {
        // The queued message and its pair-ledger rows, all TTL'd — filed
        // under the RECIPIENT (their undelivered mail).
        expect(item.recipientId).toBe(tablet.userId);
        expect(
          item.msgId === sentMsgId || String(item.msgId).startsWith('#quota'),
        ).toBe(true);
        expect(typeof item.expiresAt).toBe('number');
      } else if (table === SERVER_TABLES.users) {
        // The dead nonce pointers — and NOTHING else on those rows: strip
        // the pointer set and the row must byte-equal its never-opted-in
        // fixture serialization.
        expect(item.userId === phone.userId || item.userId === strangerC.userId).toBe(true);
        expect(item.linkOfferNonces).toEqual([offerNonce]); // canonical renders Sets as sorted arrays
        const stripped = { ...item };
        delete stripped.linkOfferNonces;
        expect(missing).toContain(`${table}:${JSON.stringify(stripped)}`);
      } else {
        throw new Error(`unenumerated downgrade residue: ${row}`);
      }
    }
    // The classes are all PRESENT (the loaded state was really driven):
    // one offer row, two pointer rows, the queued message + ≥1 ledger row.
    expect(residue.filter((r) => r.startsWith(`${SERVER_TABLES.sessions}:`)).length).toBe(1);
    expect(residue.filter((r) => r.startsWith(`${SERVER_TABLES.users}:`)).length).toBe(2);
    expect(residue.filter((r) => r.startsWith(`${SERVER_TABLES.messages}:`)).length).toBeGreaterThanOrEqual(2);

    // INERT, driven: the leftover offer cannot be accepted — the group it
    // names is gone, so the acceptance refuses without mutating anything.
    expect(
      await base.linkDeviceToGroup({
        offerNonce,
        acceptSig: b64(`a-${offerNonce}`),
        nowSeconds: nowS(),
        linkedAtMs: deps.now(),
      }),
    ).toBe('stale_epoch');
  });
});
