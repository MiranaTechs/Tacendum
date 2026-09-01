import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand,
  waitUntilTableExists,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY,
  DISCOVERY_LOOKUP_FLEET_DAILY_CEILING,
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  PREKEY_TARGET_DAILY_FETCH_BUDGET,
  TABLES,
  TABLE_ENV_VARS,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import { LIMITS } from '../src/ratelimit.js';
import { makeDdbRateLimiter } from '../src/ratelimit-ddb.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import { discoveryLookupRoute, discoveryRefusal, setDiscoverableRoute } from '../src/handlers/discovery.js';
import { emailRequestCodeRoute, emailVerifyRoute } from '../src/handlers/identifiers.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../src/handlers/keys.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, type TestDeps } from './helpers.js';

/**
 * The budget stack DRIVEN, not deep-equalled:
 *
 * 1. The daily lookup budget is FLEET-WIDE — two `makeDdbRateLimiter`
 * instances (two Lambda containers) share ONE DynamoDB fixed window, and
 * lookup N+1 fails closed on the real ratelimit-ddb path, never the
 * in-memory bucket.
 * 2. The anti-Sybil caller gate: a caller without a verified identifier, or
 * younger than the pinned 72 h minimum age, gets the UNIFORM refusal —
 * the same single-exit object a miss returns, so the gate is not itself
 * an oracle.
 * 3. The per-TARGET aggregate one-time-prekey budget (the drain floor
 * discovery was invented not to become): 30 fetches/day ACROSS ALL
 * requesters, then bundle responses degrade to signed-prekey-only — N
 * free attacker identities exhaust a budget that does not reset with N.
 * Driven across TWO DDB limiter instances: a
 * per-container implementation of the aggregate floor fails here.
 * 4. The 2,000/day fleet ceiling itself, on the SAME two-container real-DDB
 * shape (the in-memory exhaustion drive in
 * accounts-discovery.test.ts is the deterministic twin, this is the
 * cross-instance proof), with the over-cap probe emitting the field-free
 * scrape event.
 *
 * A PER-RUN rate-buckets table (the ratelimit-ddb.integration.test.ts
 * pattern): the limiter resolves its table from the env on every take, so
 * this suite creates a uniquely named table, points the env var at it, and
 * drops it — injected-clock rows never rot in the shared table.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

const RATE_TABLE = `tacendum_rate_buckets_ac7_${process.pid}_${randomBytes(4).toString('hex')}`;
const PREV_TABLE_ENV = process.env[TABLE_ENV_VARS.rateBuckets];

let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;
let flagOn = true;

// Digits only; '72' is this file's discriminator.
const RUN = `${Date.now()}72`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(`idkey-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `db-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 365,
  });
  return { userId, token };
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

async function attachEmail(
  deps: TestDeps,
  acct: { token: string; userId: string },
  email: string,
): Promise<void> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
}

beforeAll(async () => {
  client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeDataLayer(doc);
  db = { ...base, isAccountsFeatureEnabled: async () => flagOn };
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
    if (available) {
      await client.send(
        new CreateTableCommand({
          TableName: RATE_TABLE,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'bucket', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'bucket', KeyType: 'HASH' }],
        }),
      );
      await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: RATE_TABLE });
      process.env[TABLE_ENV_VARS.rateBuckets] = RATE_TABLE;
    }
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
}, 45000);

afterAll(async () => {
  if (PREV_TABLE_ENV === undefined) {
    delete process.env[TABLE_ENV_VARS.rateBuckets];
  } else {
    process.env[TABLE_ENV_VARS.rateBuckets] = PREV_TABLE_ENV;
  }
  if (!available) return;
  try {
    await client.send(new DeleteTableCommand({ TableName: RATE_TABLE }));
  } catch {
    // A leaked per-run table in DynamoDB Local is inert.
  }
}, 45000);

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('the daily lookup budget is FLEET-WIDE (two limiter instances, one DDB window)', () => {
  gated('twenty lookups split across two containers resolve; the twenty-first fails closed on EITHER — the uniform shape, driven through the real ratelimit-ddb path', async () => {
    // ONE clock shared by both "containers" and by the limiter's window
    // arithmetic: the deps clock is injected into makeDdbRateLimiter, so the
    // burst window (60 s) can be rolled between takes while the daily window
    // (86 400 s) keeps one count across BOTH instances.
    const depsA = makeTestDeps(db);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    depsA.rateLimit = containerA;
    const depsB: TestDeps = { ...depsA, rateLimit: containerB };

    const caller = await mkAcct(depsA);
    await attachEmail(depsA, caller, `fleet-caller-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

    const owner = await mkAcct(depsA);
    const email = `fleet-target-${RUN}@example.com`;
    await attachEmail(depsA, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), depsA)).statusCode,
    ).toBe(204);

    for (let n = 1; n <= DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY; n++) {
      // Roll the 60 s burst window; the 86 400 s daily window holds.
      depsA.advanceMs(61_000);
      const deps = n % 2 === 0 ? depsB : depsA;
      const res = await discoveryLookupRoute(post(caller.token, { email }), deps);
      expect(res.statusCode, `lookup ${n} (container ${n % 2 === 0 ? 'B' : 'A'})`).toBe(200);
    }
    // Lookup N+1 — from the container that in-memory accounting would have
    // admitted (each served only 10): FAILS CLOSED, because the count lives
    // in the shared DynamoDB window, not the container. And the refusal is
    // the one uniform object, indistinguishable from a miss.
    depsA.advanceMs(61_000);
    const over = await discoveryLookupRoute(post(caller.token, { email }), depsB);
    expect(over).toBe(discoveryRefusal());
    expect(over).toEqual(accountsRefusal());
  });
});

describe('the fleet-wide 2,000/day ceiling is fleet-wide IN FACT (two limiter instances, one DDB window)', () => {
  gated('two containers spend the ceiling between them on the real DDB window; the next admitted probe on EITHER refuses uniformly and emits the field-free scrape event', async () => {
    const depsA = makeTestDeps(db);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    depsA.rateLimit = containerA;
    const depsB: TestDeps = { ...depsA, rateLimit: containerB };

    const caller = await mkAcct(depsA);
    await attachEmail(depsA, caller, `fleetddb-caller-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const owner = await mkAcct(depsA);
    const email = `fleetddb-target-${RUN}@example.com`;
    await attachEmail(depsA, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), depsA)).statusCode,
    ).toBe(204);
    // One admitted lookup through container A — proves the path is open and
    // spends the ceiling's first token through the route itself.
    expect((await discoveryLookupRoute(post(caller.token, { email }), depsA)).statusCode).toBe(200);

    // Spend the REST of the ceiling split across both containers, directly
    // against the shared window (chunked for local-DDB throughput). No clock
    // motion here: every take lands in the same fixed window.
    const remaining = DISCOVERY_LOOKUP_FLEET_DAILY_CEILING - 1;
    let spent = 0;
    while (spent < remaining) {
      const chunk = Math.min(100, remaining - spent);
      await Promise.all(
        Array.from({ length: chunk }, (_, i) =>
          ((spent + i) % 2 === 0 ? containerA : containerB).take(
            'disc-fleet',
            LIMITS.discoveryLookupFleet,
          ),
        ),
      );
      spent += chunk;
    }

    // The over-cap probe — through container B, whose own accounting alone
    // (~half the ceiling) would have admitted it: FAILS CLOSED on the shared
    // DDB window, in the ONE uniform shape, and the scrape-alarm event fires
    // field-free.
    const over = await discoveryLookupRoute(post(caller.token, { email }), depsB);
    expect(over).toBe(discoveryRefusal());
    expect(over).toEqual(accountsRefusal());
    const scrape = depsA.logs.filter((l) => l.event === 'discovery_lookup_fleet_refused');
    expect(scrape.length).toBe(1);
    expect(scrape[0]!.fields).toEqual({});
    // And the ADMITTED counter counted exactly the
    // one admitted route probe — an over-cap refusal is not admitted volume.
    expect(depsA.logs.filter((l) => l.event === 'discovery_lookup_admitted').length).toBe(1);
  });
});

describe('the anti-Sybil caller gate (plus-address hoarding priced here)', () => {
  gated('a caller without a verified identifier, and a caller younger than 72 h, each get the UNIFORM refusal — byte- and object-identical to a miss', async () => {
    const deps = makeTestDeps(db);
    // A discoverable target stands ready, so the refusals below are
    // demonstrably the GATE, not the target's state.
    const owner = await mkAcct(deps);
    const email = `gate-target-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    // (a) Verified identifier, account age 71:59:59 — one second under the
    // pin: uniform refusal. (The burst-window roll is INSIDE the advance so
    // the probe lands exactly one second shy of the boundary.)
    const young = await mkAcct(deps);
    await attachEmail(deps, young, `young-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000 - 1000);
    const youngRes = await discoveryLookupRoute(post(young.token, { email }), deps);
    expect(youngRes).toBe(discoveryRefusal());

    // ...and one second later the SAME caller passes: the refusal above was
    // the age gate, nothing else.
    deps.advanceMs(1000);
    expect((await discoveryLookupRoute(post(young.token, { email }), deps)).statusCode).toBe(200);

    // (b) Old enough, NO verified identifier (solo, ungrouped): uniform.
    const unverified = await mkAcct(deps);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const unverifiedRes = await discoveryLookupRoute(post(unverified.token, { email }), deps);
    expect(unverifiedRes).toBe(discoveryRefusal());

    // (c) Old enough, GROUPED via a ceremony but with no verified
    // identifier: still uniform — the gate demands the identifier, not mere
    // grouping (a link ceremony costs nothing an attacker lacks).
    const g1 = await mkAcct(deps);
    const g2 = await mkAcct(deps);
    const groupId = uid();
    const offerNonce = `nonce-db-${RUN}-${++seq}`;
    const nowS = Math.floor(deps.now() / 1000);
    expect(
      await db.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: g1.userId,
        acceptorUserId: g2.userId,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: nowS + 600,
        offerSig: Buffer.from(`o-${offerNonce}`).toString('base64'),
      }),
    ).toBe('created');
    expect(
      await db.linkDeviceToGroup({
        offerNonce,
        acceptSig: Buffer.from(`a-${offerNonce}`).toString('base64'),
        nowSeconds: nowS,
        linkedAtMs: deps.now(),
      }),
    ).toBe('linked');
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const groupedRes = await discoveryLookupRoute(post(g1.token, { email }), deps);
    expect(groupedRes).toBe(discoveryRefusal());

    // All three gates and a genuine miss: ONE byte-stream.
    deps.advanceMs(61_000);
    const verified = await mkAcct(deps);
    await attachEmail(deps, verified, `verified-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const miss = await discoveryLookupRoute(
      post(verified.token, { email: `absent-${RUN}@example.com` }),
      deps,
    );
    for (const res of [youngRes, unverifiedRes, groupedRes, miss] as HttpResult[]) {
      expect(res).toBe(discoveryRefusal());
      expect(res).toEqual(accountsRefusal());
    }
  });
});

describe('the per-target aggregate one-time-prekey budget (release pin: 30/day across ALL requesters)', () => {
  gated('thirty fetches by thirty DISTINCT requesters ACROSS TWO CONTAINERS consume one-time prekeys; the thirty-first degrades to signed-prekey-only with the pool untouched — the anti-Sybil drain case, on the real DDB window', async () => {
    const deps = makeTestDeps(db);
    // TWO limiter containers over ONE DDB window:
    // the aggregate floor's whole point is cross-instance aggregation, so a
    // per-container in-memory implementation must fail this drive.
    const containerA = makeDdbRateLimiter(doc, () => deps.now());
    const containerB = makeDdbRateLimiter(doc, () => deps.now());
    const depsA: TestDeps = { ...deps, rateLimit: containerA };
    const depsB: TestDeps = { ...deps, rateLimit: containerB };
    const idKey = (n: number): string => {
      const bytes = Buffer.alloc(33);
      bytes[0] = 0x05;
      bytes.write(`ac7otp${RUN}:${n}`, 1);
      return bytes.toString('base64');
    };
    // The target, with a pool deeper than the daily budget so exhaustion
    // below is the BUDGET, never the pool. Its registered identity key is a
    // CANONICAL base64 fixture because the upload compares them by string
    // equality (dto.ts CanonicalBase64).
    const targetKey = idKey(0);
    const target = { userId: uid(), token: '' };
    expect(
      (await db.getOrCreateUserByIdentityKey(targetKey, target.userId, deps.now())).kind,
    ).toBe('ok');
    const prekeys = Array.from({ length: PREKEY_TARGET_DAILY_FETCH_BUDGET + 10 }, (_, i) => ({
      keyId: i + 1,
      pub: targetKey,
    }));
    const up = await uploadKeysHandler(
      {
        method: 'PUT',
        path: '/',
        headers: {},
        body: JSON.stringify({
          registrationId: 7,
          identityKey: targetKey,
          signedPrekey: { keyId: 900, pub: targetKey, sig: targetKey },
          kyberPrekey: { keyId: 901, pub: targetKey, sig: targetKey },
          oneTimePrekeys: prekeys,
        }),
      },
      deps,
      { userId: target.userId },
    );
    expect(up.statusCode).toBe(204);

    const fetchAs = async (caller: { userId: string }, n: number): Promise<HttpResult> =>
      getPrekeyBundleHandler(
        { method: 'GET', path: '/', headers: {}, pathParameters: { userId: target.userId } },
        // Alternate containers: the target's budget must aggregate across
        // them, never per-container.
        n % 2 === 0 ? depsB : depsA,
        { userId: caller.userId },
      );

    // Thirty DISTINCT requesters — free identities, exactly the Sybil shape
    // per-requester budgets cannot price — split across the two containers.
    // Each fetch consumes a one-time prekey against the TARGET's aggregate
    // budget in the SHARED DDB window.
    for (let n = 1; n <= PREKEY_TARGET_DAILY_FETCH_BUDGET; n++) {
      const requester = await mkAcct(deps);
      const res = await fetchAs(requester, n);
      expect(res.statusCode, `fetch ${n}`).toBe(200);
      expect(JSON.parse(res.body!).oneTimePrekey, `fetch ${n}`).toBeDefined();
    }
    const before = await db.countOneTimePrekeys(target.userId);
    expect(before).toBe(10);

    // The thirty-FIRST requester — a fresh identity on the container that
    // served only half the budget, so nothing caller-keyed or
    // container-local has refused it: the bundle still serves (session setup
    // succeeds — the standard X3DH signed-prekey fallback) but consumes NO
    // one-time prekey.
    const drained = await mkAcct(deps);
    const degraded = await fetchAs(drained, PREKEY_TARGET_DAILY_FETCH_BUDGET + 1);
    expect(degraded.statusCode).toBe(200);
    const body = JSON.parse(degraded.body!) as { oneTimePrekey?: unknown };
    expect(body.oneTimePrekey).toBeUndefined();
    expect(await db.countOneTimePrekeys(target.userId)).toBe(before);

    // The floor is NOT flag-gated: the kill switch
    // answers a DETECTED crawl, and the member ULIDs discovery already
    // disclosed survive the flag delete — so the drain floor those ULIDs
    // would be spent against survives it too. With the flag OFF the same
    // fetch STILL degrades to signed-prekey-only with the pool untouched (an
    // existing pre-accounts response shape — pool exhaustion — so the
    // kill-switch byte-identity rule, which governs disclosure surfaces, is
    // not violated by keeping the enforcement: the tombstone-refusal
    // precedent in keys.ts).
    flagOn = false;
    try {
      const killed = await fetchAs(await mkAcct(deps), PREKEY_TARGET_DAILY_FETCH_BUDGET + 2);
      expect(killed.statusCode).toBe(200);
      expect(JSON.parse(killed.body!).oneTimePrekey).toBeUndefined();
      expect(await db.countOneTimePrekeys(target.userId)).toBe(before);
    } finally {
      flagOn = true;
    }
  });
});
