import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand,
  waitUntilTableExists,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY,
  DISCOVERY_LOOKUP_BURST_PER_MINUTE,
  DISCOVERY_LOOKUP_FLEET_DAILY_CEILING,
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  TABLES,
  TABLE_ENV_VARS,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import { activePhoneClaimKeys } from '../src/opaque-ref.js';
import { LIMITS, type RateLimiter } from '../src/ratelimit.js';
import { makeDdbRateLimiter } from '../src/ratelimit-ddb.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
  setPhoneDiscoverableRoute,
} from '../src/handlers/discovery.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneVerifyRoute,
} from '../src/handlers/identifiers.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeTestDeps, type TestDeps } from './helpers.js';

/**
 * ALL lookup budgets are SHARED ACROSS IDENTIFIER CLASSES (the honest economics' named bounds), DRIVEN on the real
 * DynamoDB fixed windows — two classes never hand a crawler twice the rate:
 *
 * 1. The 20/day per-GROUP budget spends across classes: 12 email + 8 phone
 * lookups exhaust ONE window and the 21st of EITHER class fails closed
 * on the real ratelimit-ddb path, split across two limiter containers.
 * 2. THE 5/MIN BURST IS ONE WINDOW ACROSS CLASSES: 3
 * email + 2 phone lookups inside the minute exhaust it
 * and the 6th of EITHER class refuses uniform — a class-prefixed
 * `discburst:` key (double the transient rate under green per-class
 * suites) turns this red, and the instrumented takes pin the ONE
 * class-free bucket key both classes drew.
 * 3. Phone lookups spend the SAME 2,000/day `disc-fleet` window email's do
 * (one ceiling, two containers): email spends it, the over-cap PHONE
 * probe fails closed with the field-free scrape event.
 * 4. The per-class admitted-volume counter: phone probes emit
 * the field-free `discovery_lookup_admitted_phone` beside the landed
 * email counter, and the CDK alarm shape watching it — 50% of the ONE
 * shared ceiling, the email alarm's exact shape — is pinned in
 * the deployment stack.
 * 5. The caller gate is CLASS-BLIND both ways, driven and never
 * overclaimed: a phone-only-verified caller passes for an
 * email lookup AND an email-only-verified caller passes for a phone
 * lookup — the honest economics (an email-verified caller
 * crawls phone space at inbox-round-trip prices) stated as code.
 *
 * A PER-RUN rate-buckets table (the accounts-discovery-budget pattern);
 * both flags are process-local closures, ON throughout (the OFF collapses
 * are accounts-phone-discovery.test.ts's).
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

const RATE_TABLE = `tacendum_rate_buckets_acp2_${process.pid}_${randomBytes(4).toString('hex')}`;
const PREV_TABLE_ENV = process.env[TABLE_ENV_VARS.rateBuckets];

let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;

// Digits only; '75' is this file's discriminator.
const RUN = `${Date.now()}75`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Per-run NANP numbers (+1555…, inside the allowlist). First local
 * digit fixed '4' — this file's own block, disjoint from its sibling
 * suites by construction (see accounts-phone-discovery.test.ts: same-ms
 * starts under the shared-store parallel run collide the -era bases).
 *
 * The base is a random draw, NOT the clock (the accounts-phone.test.ts
 * lesson): `RUN.slice(-5)` was only Date.now mod 1 000 beside the fixed
 * '75' — a one-second cycle — while the `phonehash#` claim rows this suite
 * mints persist in DynamoDB Local for as long as the container lives, so a
 * later run landing on the same clock digits met a PERSISTED claim at a
 * number it believed fresh. Every issued number is recorded so `afterAll`
 * can delete its claim rows. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 1_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+15554${`${(NUMBER_BASE + ++numSeq) % 1_000_000}`.padStart(6, '0')}`;
  issuedNumbers.push(number);
  return number;
}

/** The test K_id (helpers.ts injects it as version 1). */
const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(`idkey-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `pdb-tok-${RUN}-${++seq}`;
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
  acct: { token: string },
  email: string,
): Promise<void> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
}

async function attachPhone(
  deps: TestDeps,
  acct: { token: string },
  number: string,
): Promise<void> {
  expect(
    (await phoneRequestCodeRoute(post(acct.token, { phone: number, class: 'phone' }), deps))
      .statusCode,
  ).toBe(200);
  const code = deps.smsSent.at(-1)!.code;
  expect(
    (await phoneVerifyRoute(post(acct.token, { phone: number, code }), deps)).statusCode,
  ).toBe(200);
}

/** A discoverable email + phone target pair (two distinct owner groups). */
async function mkTargets(deps: TestDeps): Promise<{ email: string; number: string }> {
  const emailOwner = await mkAcct(deps);
  const email = `pdb-etarget-${seq}-${RUN}@example.com`;
  await attachEmail(deps, emailOwner, email);
  expect(
    (await setDiscoverableRoute(post(emailOwner.token, { discoverable: true }), deps)).statusCode,
  ).toBe(204);
  const phoneOwner = await mkAcct(deps);
  const number = freshNumber();
  await attachPhone(deps, phoneOwner, number);
  expect(
    (await setPhoneDiscoverableRoute(post(phoneOwner.token, { discoverable: true }), deps))
      .statusCode,
  ).toBe(204);
  return { email, number };
}

beforeAll(async () => {
  client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeDataLayer(doc);
  db = {
    ...base,
    isAccountsFeatureEnabled: async () => true,
    isAccountsPhoneFeatureEnabled: async () => true,
  };
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
  // The users store outlives the run: every `phonehash#` claim row this
  // suite minted at one of its fresh numbers is deleted, whatever the case's
  // outcome, so no later run — or sibling suite — meets a stale claim at a
  // number it believes fresh. Only the rows THIS run's numbers address.
  for (const number of issuedNumbers) {
    for (const claimKey of activePhoneClaimKeys(KEYS, number)) {
      await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }));
    }
  }
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

describe('the 20/day group budget spends ACROSS classes (one window, two containers)', () => {
  gated('12 email + 8 phone lookups exhaust the window; the 21st of EITHER class fails closed on the real DDB path — and a fresh caller still resolves, so the refusal was the budget', async () => {
    const depsA = makeTestDeps(db);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    depsA.rateLimit = containerA;
    const depsB: TestDeps = { ...depsA, rateLimit: containerB };

    const caller = await mkAcct(depsA);
    await attachEmail(depsA, caller, `pdb-caller-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const targets = await mkTargets(depsA);

    // 12 email + 8 phone, interleaved across classes AND containers — ONE
    // shared `disc:<group>` window counts them all.
    expect(DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY).toBe(20);
    for (let n = 1; n <= DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY; n++) {
      depsA.advanceMs(61_000); // roll the 60 s burst; the 86 400 s window holds
      const deps = n % 2 === 0 ? depsB : depsA;
      const body = n <= 12 ? { email: targets.email } : { phone: targets.number };
      const res = await discoveryLookupRoute(post(caller.token, body), deps);
      expect(res.statusCode, `lookup ${n} (${n <= 12 ? 'email' : 'phone'})`).toBe(200);
    }
    // The 21st — of EITHER class, from the container in-memory accounting
    // would have admitted: FAILS CLOSED in the one uniform shape. A
    // class-keyed daily budget (12 email + 8 phone both under their caps)
    // would admit BOTH of these.
    depsA.advanceMs(61_000);
    const overPhone = await discoveryLookupRoute(
      post(caller.token, { phone: targets.number }),
      depsB,
    );
    expect(overPhone).toBe(discoveryRefusal());
    expect(overPhone).toEqual(accountsRefusal());
    depsA.advanceMs(61_000);
    const overEmail = await discoveryLookupRoute(
      post(caller.token, { email: targets.email }),
      depsA,
    );
    expect(overEmail).toBe(discoveryRefusal());
    expect(overEmail).toEqual(accountsRefusal());

    // The budget is the caller group's, not the targets': a second
    // gate-passing caller resolves BOTH classes.
    const caller2 = await mkAcct(depsA);
    await attachEmail(depsA, caller2, `pdb-caller2-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect(
      (await discoveryLookupRoute(post(caller2.token, { email: targets.email }), depsA))
        .statusCode,
    ).toBe(200);
    depsA.advanceMs(61_000);
    expect(
      (await discoveryLookupRoute(post(caller2.token, { phone: targets.number }), depsB))
        .statusCode,
    ).toBe(200);
  });
});

describe('the 20/day window survives GROUP CHURN — the per-user anchor', () => {
  gated('exhaust the window, unlink the lazy-solo group, re-attach a fresh alias: a NEW groupId is minted, the fresh disc:<group> window would admit — and the 21st lookup STILL fails closed on the one discuser window', async () => {
    const deps = makeTestDeps(db);
    const container = makeDdbRateLimiter(doc, () => deps.now());
    // Instrumented takes (the burst suite's pattern): the churn must be
    // VISIBLE in the bucket keys — two distinct group windows drawn, ONE
    // user window across both — or the refusal below could be anything.
    const takes: string[] = [];
    deps.rateLimit = {
      take: async (bucket, opts) => {
        takes.push(bucket);
        return container.take(bucket, opts);
      },
    };

    const caller = await mkAcct(deps);
    await attachEmail(deps, caller, `pdb-churn-a-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const targets = await mkTargets(deps);
    const g1 = (await db.getUserById(caller.userId))!.groupId!;

    for (let n = 1; n <= DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY; n++) {
      deps.advanceMs(61_000); // roll the 60 s burst; both daily windows hold
      const res = await discoveryLookupRoute(post(caller.token, { email: targets.email }), deps);
      expect(res.statusCode, `lookup ${n}`).toBe(200);
    }

    // THE CHURN (the finding's exact vector): unlink the lazy-solo group's
    // last identifier — the group row dissolves and the user's groupId
    // clears — then verify a FRESH alias inside the 10/day attach
    // allowance: a brand-new groupId is minted while the caller's 72 h age
    // carries over untouched.
    expect((await emailUnlinkRoute(post(caller.token, {}), deps)).statusCode).toBe(200);
    expect((await db.getUserById(caller.userId))!.groupId).toBeUndefined();
    await attachEmail(deps, caller, `pdb-churn-b-${RUN}@example.com`);
    const g2 = (await db.getUserById(caller.userId))!.groupId!;
    expect(g2).not.toBe(g1);

    // The 21st lookup: the fresh `disc:<g2>` window admits it — a
    // group-only budget would hand the churned caller a full second 20 (and
    // ~220/day across the attach allowance) — but the ONE `discuser:`
    // window the churn cannot re-mint fails it closed, uniform.
    deps.advanceMs(61_000);
    const over = await discoveryLookupRoute(post(caller.token, { email: targets.email }), deps);
    expect(over).toBe(discoveryRefusal());
    expect(over).toEqual(accountsRefusal());

    // The takes tell the whole story: TWO distinct group windows were
    // drawn, and every daily take of this caller's rode ONE user window.
    const groupKeys = new Set(takes.filter((k) => k.startsWith('disc:')));
    expect(groupKeys.has(`disc:${g1}`)).toBe(true);
    expect(groupKeys.has(`disc:${g2}`)).toBe(true);
    const userKeys = takes.filter((k) => k.startsWith('discuser:'));
    expect(userKeys.length).toBe(DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY + 1); // 20 admitted + the refused 21st
    expect(new Set(userKeys).size).toBe(1);
    expect(userKeys[0]).toBe(`discuser:${caller.userId}`);

    // And a fresh gate-passing caller still resolves — the refusal above
    // was the churned caller's own spent budget, not the fleet's and not
    // the target's.
    const fresh = await mkAcct(deps);
    await attachEmail(deps, fresh, `pdb-churn-fresh-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect(
      (await discoveryLookupRoute(post(fresh.token, { email: targets.email }), deps)).statusCode,
    ).toBe(200);
  });
});

describe('THE BURST IS ONE WINDOW ACROSS CLASSES', () => {
  gated('3 email + 2 phone inside the minute exhaust the 5/min burst; the 6th of EITHER class refuses uniform; the instrumented takes pin ONE class-free discburst key', async () => {
    const depsA = makeTestDeps(db);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    // Instrument BOTH containers (the accounts-phone takes pattern): every
    // bucket key a lookup draws is recorded, so a class-prefixed burst key
    // — which would hand a two-class crawler 10/min under green per-class
    // suites — fails the one-key assertion below, not just the refusal
    // counts.
    const takes: string[] = [];
    const instrument = (inner: RateLimiter): RateLimiter => ({
      take: async (bucket, opts) => {
        takes.push(bucket);
        return inner.take(bucket, opts);
      },
    });
    depsA.rateLimit = instrument(containerA);
    const depsB: TestDeps = { ...depsA, rateLimit: instrument(containerB) };

    const caller = await mkAcct(depsA);
    await attachEmail(depsA, caller, `pdb-burst-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const targets = await mkTargets(depsA);
    depsA.advanceMs(61_000); // a fresh burst window for the drive itself
    takes.length = 0;

    // 3 email + 2 phone, SAME minute (no clock motion), split across the
    // two containers: all five admitted through the one shared window.
    expect(DISCOVERY_LOOKUP_BURST_PER_MINUTE).toBe(5);
    const bodies: Array<{ email: string } | { phone: string }> = [
      { email: targets.email },
      { phone: targets.number },
      { email: targets.email },
      { phone: targets.number },
      { email: targets.email },
    ];
    for (const [i, body] of bodies.entries()) {
      const res = await discoveryLookupRoute(
        post(caller.token, body),
        i % 2 === 0 ? depsA : depsB,
      );
      expect(res.statusCode, `burst lookup ${i + 1}`).toBe(200);
    }
    // The 6th — PHONE — refuses uniform; the 7th — EMAIL, other container —
    // refuses too: one window, either class, never 5-per-class.
    const sixth = await discoveryLookupRoute(post(caller.token, { phone: targets.number }), depsB);
    expect(sixth).toBe(discoveryRefusal());
    expect(sixth).toEqual(accountsRefusal());
    const seventh = await discoveryLookupRoute(
      post(caller.token, { email: targets.email }),
      depsA,
    );
    expect(seventh).toBe(discoveryRefusal());
    expect(seventh).toEqual(accountsRefusal());

    // THE CLASS-FREE KEY, pinned: every burst
    // take both classes drew used the ONE identical `discburst:<ulid>`
    // bucket — no class prefix, no per-class window.
    const burstKeys = takes.filter((k) => k.startsWith('discburst:'));
    expect(burstKeys.length).toBe(7); // 5 admitted + 2 refused probes
    expect(new Set(burstKeys).size).toBe(1);
    expect(burstKeys[0]).toBe(`discburst:${caller.userId}`);

    // And the refusal above was genuinely the BURST: one 61 s roll later the
    // same caller resolves again (daily window: 5 of 20 spent).
    depsA.advanceMs(61_000);
    expect(
      (await discoveryLookupRoute(post(caller.token, { phone: targets.number }), depsB))
        .statusCode,
    ).toBe(200);

    // The per-class admitted split counted exactly the admitted probes:
    // 3 email + (2 + 1 post-roll) phone, all field-free.
    const phoneAdmitted = depsA.logs.filter(
      (l) => l.event === 'discovery_lookup_admitted_phone',
    );
    const emailAdmitted = depsA.logs.filter((l) => l.event === 'discovery_lookup_admitted');
    expect(phoneAdmitted.length).toBe(3);
    expect(emailAdmitted.length).toBe(3);
    for (const entry of [...phoneAdmitted, ...emailAdmitted]) expect(entry.fields).toEqual({});
  });
});

describe('one 2,000/day fleet ceiling across classes (two containers, one DDB window)', () => {
  gated('email spends the shared ceiling; the over-cap PHONE probe fails closed with the field-free scrape event — phone lookups draw no second ceiling', async () => {
    const depsA = makeTestDeps(db);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    depsA.rateLimit = containerA;
    const depsB: TestDeps = { ...depsA, rateLimit: containerB };

    const caller = await mkAcct(depsA);
    await attachEmail(depsA, caller, `pdb-fleet-${RUN}@example.com`);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const targets = await mkTargets(depsA);

    // One admitted EMAIL lookup through container A: the path is open and
    // the first ceiling token is spent through the route itself.
    expect(
      (await discoveryLookupRoute(post(caller.token, { email: targets.email }), depsA))
        .statusCode,
    ).toBe(200);
    // Spend the REST of the one `disc-fleet` window split across both
    // containers (chunked for local-DDB throughput; no clock motion).
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

    // The over-cap probe is a PHONE lookup through container B: it fails
    // closed on the SAME window email exhausted — a phone-classed second
    // ceiling would admit it — in the ONE uniform shape, with the
    // field-free scrape event fired.
    const over = await discoveryLookupRoute(post(caller.token, { phone: targets.number }), depsB);
    expect(over).toBe(discoveryRefusal());
    expect(over).toEqual(accountsRefusal());
    const scrape = depsA.logs.filter((l) => l.event === 'discovery_lookup_fleet_refused');
    expect(scrape.length).toBe(1);
    expect(scrape[0]!.fields).toEqual({});
    // Admitted-counter honesty across the split: the one admitted email
    // probe counted on the email counter; the over-cap phone refusal is NOT
    // admitted volume — the phone counter never fired.
    expect(depsA.logs.filter((l) => l.event === 'discovery_lookup_admitted').length).toBe(1);
    expect(
      depsA.logs.filter((l) => l.event === 'discovery_lookup_admitted_phone').length,
    ).toBe(0);
  });
});

describe('the anti-Sybil caller gate is CLASS-BLIND both ways (driven, never overclaimed)', () => {
  gated('a caller whose ONLY verified identifier is a PHONE passes for an EMAIL lookup, and a caller whose only verified identifier is an EMAIL passes for a PHONE lookup', async () => {
    const deps = makeTestDeps(db);
    const targets = await mkTargets(deps);

    // Phone-only-verified caller → EMAIL lookup: ADMITTED. This is the
    // honest cost statement in reverse: a phone OTP buys the same
    // consent-free lookup eligibility an inbox round-trip does — the gate
    // demands A verified identifier and 72 h, never a class match.
    const phoneCaller = await mkAcct(deps);
    await attachPhone(deps, phoneCaller, freshNumber());
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect(
      (await discoveryLookupRoute(post(phoneCaller.token, { email: targets.email }), deps))
        .statusCode,
    ).toBe(200);

    // Email-only-verified caller → PHONE lookup: ADMITTED — an
    // email-verified caller crawls phone space at inbox-round-trip prices,
    // the SAME Sybil price email lookups carry, never a stronger one (the
    // retired "each phone-crawling Sybil pays for an SMS-receiving number"
    // claim must stay retired).
    const emailCaller = await mkAcct(deps);
    await attachEmail(deps, emailCaller, `pdb-gate-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect(
      (await discoveryLookupRoute(post(emailCaller.token, { phone: targets.number }), deps))
        .statusCode,
    ).toBe(200);

    // The gate half that DOES refuse stays class-blind too: a pristine
    // caller with NO verified identifier of either class is refused the
    // same frozen object for both classes.
    const unverified = await mkAcct(deps);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const eRef = await discoveryLookupRoute(post(unverified.token, { email: targets.email }), deps);
    deps.advanceMs(61_000);
    const pRef = await discoveryLookupRoute(
      post(unverified.token, { phone: targets.number }),
      deps,
    );
    expect(eRef).toBe(discoveryRefusal());
    expect(pRef).toBe(discoveryRefusal());
  });
});
