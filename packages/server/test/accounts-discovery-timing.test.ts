import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  DISCOVERY_TIMING_MEDIAN_BOUND_MS,
  TABLES,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  normalizeUsernameIdentifier,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import { activePhoneClaimKeys, activeUsernameClaimKeys } from '../src/opaque-ref.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
} from '../src/handlers/discovery.js';
import {
  emailRequestCodeRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneVerifyRoute,
} from '../src/handlers/identifiers.js';
import { usernameClaimRoute, usernameUnlinkRoute } from '../src/handlers/username.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeTestDeps, type TestDeps } from './helpers.js';

/**
 * THE UNIFORM-TIMING COMMITMENT'S FAILING MODE. Two halves:
 *
 * 1. STRUCTURAL — the identifier-keyed refusal branches converge into ONE
 * shared resolution+response path. The handler's uniform exit returns a
 * single FROZEN result object, so reference identity across the branches
 * proves both reached the one exit function — a branch that minted its
 * own refusal cannot return the same object reference. Stated honestly:
 * reference identity proves the SHARED EXIT,
 * not the absence of divergent work before it — pre-exit divergence on
 * an X-keyed branch is exactly what half 2 exists to catch.
 *
 * 2. EMPIRICAL — an interleaved run against the real store bounds the
 * median timing delta under the release pin
 * (DISCOVERY_TIMING_MEDIAN_BOUND_MS) across the identifier-keyed
 * refusal classes: miss, non-consented hit, AND in-cool-down hit (the
 * third is likewise a fact about the
 * ADDRESS the caller has no right to time-read) — and, the
 * PHONE miss / PHONE non-consented pair under the SAME pin (the
 * second identifier class joins the run; within-class, because the
 * class is the CALLER's own populated request field, never an address
 * fact — the caller-keyed scope note below). The pinned pair (email
 * miss vs non-consented) keeps its 200 samples exactly as the
 * release pin words it. Interleaved, so machine load lands on every branch alike;
 * medians, so GC pauses and cold paths do not decide the verdict. An
 * implementation that reads the group row (or migrates, or pads) on
 * ONLY one refusal branch shifts a median by a DB round trip and fails.
 * At the USERNAME triple — miss, non-consented hit,
 * and LIVE-TOMBSTONE hit (a tombstone is read as non-consented
 * through the same one helper, no branch of its own) — joins under the
 * SAME pin in its own interleaved run (below), within-class for the
 * same caller-keyed reason as phone. Its run is SEPARATE for a clock
 * reason, not a timing one: every timed sample advances the injected
 * clock ~4,321 s to refill one daily lookup token, so eight branches
 * in one run would walk ~42 simulated days — past the 30-day tombstone
 * TTL — and the "tombstoned" branch would silently become a miss
 * mid-run (the store reaps an elapsed tombstone at the read). Three
 * branches × 105 samples walk ~15.8 days; the run asserts the
 * tombstone is STILL live at its end, so every sample measured what it
 * claims to (the frozen-clock lesson, applied to deadline arithmetic
 * under an advancing clock).
 *
 * Scope, stated with the same honesty: the CALLER-keyed
 * refusals (budgets, gate, missing key, malformed body) return earlier by
 * design and are identifier-INDEPENDENT — their timing varies only with the
 * caller's own state, so they are deliberately NOT sampled here; the runtime
 * pad that would equalize them was refused as new machinery.
 * The feature-flag read is the process-local stub every accounts suite uses
 * BECAUSE the real row is a store-wide singleton shared with parallel suite
 * files (the accounts-link discipline) — it sits in the wrapper BEFORE the
 * handler, identical work on every branch, and its real-row drive is
 * accounts-flag-gate.test.ts's.
 *
 * CROSS-CLASS, stated honestly: in production
 * the phone class carries ONE additional flag GetItem the email class never
 * pays — the two-tier kill switch's read. It fires FLAT (once per
 * phone-classed request, whatever the number resolves to — pinned by count
 * in accounts-phone-discovery.test.ts) and cannot join the email path, so the cross-class latency
 * step discloses only which class the CALLER populated — a fact the caller
 * authored — never anything about an address. The medians below are
 * therefore compared WITHIN class only; a phone-vs-email median comparison
 * under a closured flag would assert an equality production does not have,
 * and equalizing production was refused both ways (adding the read to
 * email's live path, or removing the phone kill switch).
 *
 * The clock discipline (the frozen-clock lesson): the INJECTED
 * deps clock advances only to refill the caller's lookup budgets; every
 * measurement is real `performance.now` around a real DynamoDB round trip
 * no fake timer sits beside an advancing one.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;

// Digits only; '73' is this file's discriminator.
const RUN = `${Date.now()}73`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** The test K_id (helpers.ts injects it as version 1). */
const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];

function post(token: string, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  // All three flags closured ON (the accounts-phone discipline): the
  // class-flag read the phone and username classes ride is process-local
  // and identical for every branch of its class, so it cannot separate
  // their medians — the real-row drives are accounts-phone.test.ts's and
  // accounts-username-routes.test.ts's.
  db = {
    ...base,
    isAccountsFeatureEnabled: async () => true,
    isAccountsPhoneFeatureEnabled: async () => true,
    isAccountsUsernameFeatureEnabled: async () => true,
  };
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

// The store outlives the run: every `phonehash#` claim row this suite minted
// at one of its fresh numbers is deleted, whatever the case's outcome, so no
// later run — or sibling suite — meets a stale claim at a number it believes
// fresh. Only the rows THIS run's numbers address; the samples above are
// untouched by this (it runs after the last measurement).
afterAll(async () => {
  if (!available) return;
  for (const number of issuedNumbers) {
    for (const claimKey of activePhoneClaimKeys(KEYS, number)) {
      await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }));
    }
  }
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(`idkey-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `t-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 365,
  });
  return { userId, token };
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

/** Per-run NANP numbers (+1555…, inside the allowlist). First local
 * digit fixed '2' — this file's own block, disjoint from the two phone
 * suites by construction (see accounts-phone-discovery.test.ts: same-ms
 * starts under the shared-store parallel run collide the -era bases).
 *
 * The base is a random draw, NOT the clock (the accounts-phone.test.ts
 * lesson): `RUN.slice(-5)` was only Date.now mod 1 000 beside the fixed
 * '73' — a one-second cycle — while the `phonehash#` claim rows this suite
 * mints persist in DynamoDB Local for as long as the container lives, so a
 * later run landing on the same clock digits met a PERSISTED claim at a
 * number it believed fresh. Every issued number is recorded so `afterAll`
 * can delete its claim rows. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 1_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+15552${`${(NUMBER_BASE + ++numSeq) % 1_000_000}`.padStart(6, '0')}`;
  issuedNumbers.push(number);
  return number;
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

/** A unique-per-run username inside USERNAME_STRICT: `<base><run digits>`
 * (DynamoDB Local persists across runs). The base carries the branch's
 * name; the digits are the run's. */
function freshName(base: string): string {
  return `${base}${RUN}`;
}

/** A username claimed through the REAL claim route by
 * an aged, email-verified owner — the gate both this suite's owners
 * already satisfy once the clock has moved 72 h. Returns the newest-version
 * claim key so the run can inspect the row it timed. */
async function claimName(
  deps: TestDeps,
  acct: { token: string },
  name: string,
  discoverable: boolean,
): Promise<string> {
  expect(
    (await usernameClaimRoute(post(acct.token, { username: name, discoverable }), deps))
      .statusCode,
  ).toBe(200);
  return activeUsernameClaimKeys(
    [{ version: 1, key: 'test-identifier-hmac-key' }],
    normalizeUsernameIdentifier(name),
  )[0]!;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('miss vs non-consented: one exit, one clock', () => {
  gated('STRUCTURAL: both branches return the SAME frozen object — the single shared exit — and its bytes', async () => {
    const deps = makeTestDeps(db);
    const caller = await mkAcct(deps);
    await attachEmail(deps, caller, `t-caller-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

    const owner = await mkAcct(deps);
    const ndEmail = `t-nd-${RUN}@example.com`;
    await attachEmail(deps, owner, ndEmail); // registered, consent OFF (default)

    deps.advanceMs(61_000);
    const miss = await discoveryLookupRoute(
      post(caller.token, { email: `t-miss-${RUN}@example.com` }),
      deps,
    );
    deps.advanceMs(61_000);
    const nonConsented = await discoveryLookupRoute(post(caller.token, { email: ndEmail }), deps);

    // Reference identity, then bytes — the object IS the proof of the shared
    // exit; the bytes are the uniform-refusal deep-equal.
    expect(miss).toBe(discoveryRefusal());
    expect(nonConsented).toBe(discoveryRefusal());
    expect(miss).toBe(nonConsented);
    expect(Object.isFrozen(miss)).toBe(true);
    expect(miss.statusCode).toBe(nonConsented.statusCode);
    expect(miss.body).toBe(nonConsented.body);
    expect(miss.headers).toEqual(nonConsented.headers);

    // The PHONE class returns through the SAME frozen exit: a phone
    // miss and a phone non-consented hit are the one object too — and
    // therefore byte-identical to the email refusals above, cross-class.
    const pndOwner = await mkAcct(deps);
    const pndNumber = freshNumber();
    await attachPhone(deps, pndOwner, pndNumber); // registered, consent OFF (default)
    deps.advanceMs(61_000);
    const phoneMiss = await discoveryLookupRoute(
      post(caller.token, { phone: freshNumber() }),
      deps,
    );
    deps.advanceMs(61_000);
    const phoneNc = await discoveryLookupRoute(post(caller.token, { phone: pndNumber }), deps);
    expect(phoneMiss).toBe(discoveryRefusal());
    expect(phoneNc).toBe(discoveryRefusal());
    expect(phoneMiss).toBe(miss);

    // The USERNAME class returns through the SAME frozen exit: a
    // username miss, a non-consented username hit, AND a live-tombstone hit
    // (the name unlinked, held for the former owner) are the one
    // object too — byte-identical to every refusal above, cross-class.
    const undOwner = await mkAcct(deps);
    await attachEmail(deps, undOwner, `t-und-${RUN}@example.com`);
    const utOwner = await mkAcct(deps);
    await attachEmail(deps, utOwner, `t-ut-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000); // the claim gate's age
    const undName = freshName('tnd');
    await claimName(deps, undOwner, undName, false); // held, consent OFF
    const utName = freshName('ttomb');
    await claimName(deps, utOwner, utName, true);
    expect((await usernameUnlinkRoute(post(utOwner.token, {}), deps)).statusCode).toBe(200);
    deps.advanceMs(61_000);
    const unameMiss = await discoveryLookupRoute(
      post(caller.token, { username: freshName('tmiss') }),
      deps,
    );
    deps.advanceMs(61_000);
    const unameNc = await discoveryLookupRoute(post(caller.token, { username: undName }), deps);
    deps.advanceMs(61_000);
    const unameTomb = await discoveryLookupRoute(post(caller.token, { username: utName }), deps);
    expect(unameMiss).toBe(discoveryRefusal());
    expect(unameNc).toBe(discoveryRefusal());
    expect(unameTomb).toBe(discoveryRefusal());
    expect(unameTomb).toBe(miss);
  });

  gated('EMPIRICAL: an interleaved run bounds the median delta under the release pin — the pinned 200-sample miss/non-consented pair, PLUS the in-cool-down branch, PLUS the phone miss/non-consented pair under the SAME pin, PLUS the discoverable SELF-hit branch (the self-discovery fix)', async () => {
    expect(DISCOVERY_TIMING_MEDIAN_BOUND_MS).toBe(5); // the release value, asserted as itself

    const deps = makeTestDeps(db);
    const caller = await mkAcct(deps);
    const selfEmail = `t2-caller-${RUN}@example.com`;
    await attachEmail(deps, caller, selfEmail);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    // THE FOURTH identifier-keyed refusal class (the self-discovery fix):
    // the caller's OWN registered, CONSENTED claim — a discoverable hit
    // owned by the caller's group refuses through the same frozen exit,
    // and its median joins the run under the same pin, so a self branch
    // that read the group row, migrated, or exited before the walk fails
    // here exactly as any other one-sided branch would.
    expect(
      (await setDiscoverableRoute(post(caller.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    const owner = await mkAcct(deps);
    const ndEmail = `t2-nd-${RUN}@example.com`;
    await attachEmail(deps, owner, ndEmail);
    const missEmail = `t2-miss-${RUN}@example.com`;

    // The PHONE pair: a registered non-consented phone claim and a
    // phone-space miss, sampled within-class under the same pin — the two
    // branches walk the phonehash# prefix into the same frozen exit, and a
    // group-row read (or a migration) on only one of them shifts this
    // median exactly as it would email's.
    const phoneOwner = await mkAcct(deps);
    const ndNumber = freshNumber();
    await attachPhone(deps, phoneOwner, ndNumber);
    const missNumber = freshNumber();

    // The THIRD identifier-keyed refusal class: a
    // registered, CONSENTED claim inside its recovery cool-down. Armed
    // through the real completion transaction; the horizon is set far past
    // the ~16 simulated days the budget-refill advances below cover, so the
    // branch stays in-cool-down for the whole run (the pinned 7-day VALUE is
    // the discovery suite's boundary case to assert — here the row only
    // needs to hold).
    const cdOwner = await mkAcct(deps);
    const cdEmail = `t2-cd-${RUN}@example.com`;
    await attachEmail(deps, cdOwner, cdEmail);
    const cdGroupId = (await db.getUserById(cdOwner.userId))!.groupId!;
    const cdClaim = (await db.getAccountGroup(cdGroupId))!.identifierRefs[0]!;
    const recovering = await mkAcct(deps);
    const armS = Math.floor(deps.now() / 1000);
    expect(
      await db.putRecoveryPending({
        groupId: cdGroupId,
        newUserId: recovering.userId,
        deviceClass: 'tablet',
        claimKey: cdClaim,
        requestedAt: deps.now(),
        completesAt: armS + 1,
        expiresAt: armS + 10_000_000,
      }),
    ).toBe('created');
    deps.advanceMs(2_000);
    const completed = await db.completeRecovery({
      groupId: cdGroupId,
      newUserId: recovering.userId,
      nowSeconds: Math.floor(deps.now() / 1000),
      linkedAtMs: deps.now(),
      discoverableAfter: Math.floor(deps.now() / 1000) + 100_000_000,
    });
    expect(completed.outcome).toBe('completed');
    expect(
      (await setDiscoverableRoute(post(cdOwner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    // Each timed call advances the injected clock far enough to refill ONE
    // daily token (86 400 s / 20 = 4 320 s) and roll the burst window, so
    // the budget never refuses inside the run and every sample measures the
    // same admitted path. Real clock around a real DynamoDB round trip —
    // the injected clock only refills budgets.
    const timed = async (body: { email: string } | { phone: string }): Promise<number> => {
      deps.advanceMs(4_321_000);
      const start = performance.now();
      const res = await discoveryLookupRoute(post(caller.token, body), deps);
      const elapsed = performance.now() - start;
      expect(res).toBe(discoveryRefusal());
      return elapsed;
    };

    const missSamples: number[] = [];
    const ncSamples: number[] = [];
    const cdSamples: number[] = [];
    const phoneMissSamples: number[] = [];
    const phoneNcSamples: number[] = [];
    const selfSamples: number[] = [];
    const branches: Array<{
      body: { email: string } | { phone: string };
      samples: number[];
    }> = [
      { body: { email: missEmail }, samples: missSamples },
      { body: { email: ndEmail }, samples: ncSamples },
      { body: { email: cdEmail }, samples: cdSamples },
      { body: { phone: missNumber }, samples: phoneMissSamples },
      { body: { phone: ndNumber }, samples: phoneNcSamples },
      { body: { email: selfEmail }, samples: selfSamples },
    ];

    // Warm-up (JIT, connection reuse) — discarded.
    for (let i = 0; i < 5; i++) {
      for (const branch of branches) await timed(branch.body);
    }

    // INTERLEAVED, with the branch order rotating so slow drift (load
    // arriving mid-run) cannot masquerade as a branch difference.
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < branches.length; j++) {
        const branch = branches[(i + j) % branches.length]!;
        branch.samples.push(await timed(branch.body));
      }
    }
    // The pinned pair keeps its pinned 200 samples exactly — the phone
    // pair joins BESIDE it (its own 200), never inside it.
    expect(missSamples.length + ncSamples.length).toBe(200);
    expect(cdSamples.length).toBe(100);
    expect(phoneMissSamples.length + phoneNcSamples.length).toBe(200);
    expect(selfSamples.length).toBe(100);

    const missMed = median(missSamples);
    const ncMed = median(ncSamples);
    const cdMed = median(cdSamples);
    expect(
      Math.abs(missMed - ncMed),
      `median(miss)=${missMed.toFixed(3)}ms median(non-consented)=${ncMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
    expect(
      Math.abs(missMed - cdMed),
      `median(miss)=${missMed.toFixed(3)}ms median(cool-down)=${cdMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
    // The phone pair, under the SAME pin: within-class, because the
    // class is the caller's own request field — an implementation that
    // migrated, padded, or read the group row on only ONE phone refusal
    // branch fails here exactly as email's would.
    const phoneMissMed = median(phoneMissSamples);
    const phoneNcMed = median(phoneNcSamples);
    expect(
      Math.abs(phoneMissMed - phoneNcMed),
      `median(phone miss)=${phoneMissMed.toFixed(3)}ms median(phone non-consented)=${phoneNcMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
    // The SELF-hit branch, under the SAME pin: a discoverable claim owned
    // by the caller's own group must cost what a miss costs — the walk, the
    // helper, one pure compare, never the positive branch's group read.
    const selfMed = median(selfSamples);
    expect(
      Math.abs(missMed - selfMed),
      `median(miss)=${missMed.toFixed(3)}ms median(self-hit)=${selfMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
  });

  gated('EMPIRICAL, the USERNAME triple: an interleaved run bounds the miss / non-consented / LIVE-TOMBSTONE medians under the SAME release pin — and the tombstone is still live when the run ends', async () => {
    expect(DISCOVERY_TIMING_MEDIAN_BOUND_MS).toBe(5);

    const deps = makeTestDeps(db);
    const caller = await mkAcct(deps);
    await attachEmail(deps, caller, `t3-caller-${RUN}@example.com`);

    // Two owners, both email-verified (the claim gate's possession
    // proof) and aged with the caller: one holds a name with consent OFF,
    // the other claims WITH consent and then unlinks — leaving the
    // tombstone the third branch reads. The tombstone's 30-day window
    // opens HERE, under the same advancing clock the run below moves.
    const ndOwner = await mkAcct(deps);
    await attachEmail(deps, ndOwner, `t3-nd-${RUN}@example.com`);
    const tombOwner = await mkAcct(deps);
    await attachEmail(deps, tombOwner, `t3-tomb-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    const ndName = freshName('tund');
    await claimName(deps, ndOwner, ndName, false);
    const tombName = freshName('tutomb');
    const tombKey = await claimName(deps, tombOwner, tombName, true);
    expect((await usernameUnlinkRoute(post(tombOwner.token, {}), deps)).statusCode).toBe(200);
    const tombstonedAtS = Math.floor(deps.now() / 1000);
    const missName = freshName('tumiss');

    const timed = async (body: { username: string }): Promise<number> => {
      deps.advanceMs(4_321_000);
      const start = performance.now();
      const res = await discoveryLookupRoute(post(caller.token, body), deps);
      const elapsed = performance.now() - start;
      expect(res).toBe(discoveryRefusal());
      return elapsed;
    };

    const missSamples: number[] = [];
    const ncSamples: number[] = [];
    const tombSamples: number[] = [];
    const branches: Array<{ body: { username: string }; samples: number[] }> = [
      { body: { username: missName }, samples: missSamples },
      { body: { username: ndName }, samples: ncSamples },
      { body: { username: tombName }, samples: tombSamples },
    ];
    for (let i = 0; i < 5; i++) {
      for (const branch of branches) await timed(branch.body);
    }
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < branches.length; j++) {
        const branch = branches[(i + j) % branches.length]!;
        branch.samples.push(await timed(branch.body));
      }
    }
    expect(missSamples.length + ncSamples.length).toBe(200);
    expect(tombSamples.length).toBe(100);

    // The deadline arithmetic, checked against the clock that actually
    // moved: the run walked under 30 days, and the row the tombstone branch
    // read is STILL the tombstone — not a reaped miss.
    const nowS = Math.floor(deps.now() / 1000);
    expect(nowS - tombstonedAtS).toBeLessThan(USERNAME_TOMBSTONE_TTL_SECONDS);
    const row = await db.getUsernameClaim(tombKey, nowS);
    expect(row).toBeDefined();
    expect((row as { tombstoned?: boolean }).tombstoned).toBe(true);

    const missMed = median(missSamples);
    const ncMed = median(ncSamples);
    const tombMed = median(tombSamples);
    expect(
      Math.abs(missMed - ncMed),
      `median(username miss)=${missMed.toFixed(3)}ms median(username non-consented)=${ncMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
    expect(
      Math.abs(missMed - tombMed),
      `median(username miss)=${missMed.toFixed(3)}ms median(username tombstoned)=${tombMed.toFixed(3)}ms`,
    ).toBeLessThanOrEqual(DISCOVERY_TIMING_MEDIAN_BOUND_MS);
  });
});
