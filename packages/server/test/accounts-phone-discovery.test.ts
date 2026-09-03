import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  DiscoveryLookupRequest,
  TABLES,
  normalizePhoneIdentifier,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { groupRowKey, makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  activePhoneClaimKeys,
  identifierClaimHash,
  phoneClaimKey,
} from '../src/opaque-ref.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
  setPhoneDiscoverableRoute,
} from '../src/handlers/discovery.js';
import {
  emailRequestCodeRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneVerifyRoute,
} from '../src/handlers/identifiers.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Discovery-by-phone against REAL DynamoDB Local — the
 * three-way-oracle discipline applied to the second identifier class,
 * with the own edges driven by name: the parallel-field wire (a
 * captured previous {email} request replays byte-identically and the
 * both-fields / neither-field / batch shapes collapse), PER-CLASS consent
 * driven in BOTH directions (email consent never implies phone
 * consent and neither ever implies the other), cross-class byte-uniformity
 * of every refusal (which identifier field the caller populated teaches
 * nothing), the phone rotation walk with positive-branch-only forward
 * migration, and the two-tier kill switch (`feature#accounts-phone` darkens
 * the phone class alone; `feature#accounts` darkens everything).
 *
 * Both flags are process-local closures with ON as this suite's default
 * (the accounts-phone discipline; the real `feature#accounts-phone` row
 * drive lives in accounts-phone.test.ts, the master row's in
 * accounts-group.test.ts) — the kill-switch describe below flips them
 * mid-flight through the same reads the handlers make.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;
let flagOn = true;
let phoneFlagOn = true;

// Digits only (valid Crockford base32); '74' is this file's discriminator.
const RUN = `${Date.now()}74`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Per-run NANP numbers (+1555 + 7 digits — inside the allowlist so
 * the attach leg's destination brake never interferes). The FIRST local
 * digit is this FILE's fixed '3': the -era `(slice(-6) + seq)` pattern
 * hands two suite files started in the same millisecond nearly identical
 * bases, and a cross-file collision means one file's attach draws the other
 * file's claim-conflict 403 under a green-alone run — the per-file digit
 * makes the three suites' number blocks disjoint by construction.
 *
 * The base is a random draw, NOT the clock (the accounts-phone.test.ts
 * lesson): `RUN.slice(-5)` was only Date.now mod 1 000 beside the fixed
 * '74' — a one-second cycle — while the `phonehash#` claim rows this suite
 * mints persist in DynamoDB Local for as long as the container lives, so a
 * later run landing on the same clock digits met a PERSISTED claim at a
 * number it believed fresh. Every issued number is recorded so `afterAll`
 * can delete its claim rows under every key version this suite writes. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 1_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+15553${`${(NUMBER_BASE + ++numSeq) % 1_000_000}`.padStart(6, '0')}`;
  issuedNumbers.push(number);
  return number;
}

/** The test K_id (helpers.ts injects it as version 1). */
const TEST_KID = 'test-identifier-hmac-key';
const KEYS = [{ version: 1, key: TEST_KID }];
/** The rotation case's v2 key: its lookup forward-migrates a claim row to
 * `phonehash#v2#`, so the cleanup walks BOTH versions. */
const K2 = 'test-identifier-hmac-key-v2';
const CLEANUP_KEYS = [{ version: 2, key: K2 }, ...KEYS];

/** ULIDs, groupIds, and E.164 strings that must never appear in a retained
 * log line. */
const canaries = new Set<string>();
const allLogs: LogEntry[][] = [];
const refusals: HttpResult[] = [];

function freshDeps(): TestDeps {
  const deps = makeTestDeps(db);
  allLogs.push(deps.logs);
  return deps;
}

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(`idkey-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `pd-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 365,
  });
  return { userId, token };
}

function post(token: string | undefined, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

async function attachEmail(
  deps: TestDeps,
  acct: { token: string; userId: string },
  email: string,
): Promise<string> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  canaries.add(groupId);
  return activeEmailClaimKeys(KEYS, email)[0]!;
}

async function attachPhone(
  deps: TestDeps,
  acct: { token: string; userId: string },
  number: string,
): Promise<string> {
  canaries.add(number);
  expect(
    (await phoneRequestCodeRoute(post(acct.token, { phone: number, class: 'phone' }), deps))
      .statusCode,
  ).toBe(200);
  const code = deps.smsSent.at(-1)!.code;
  expect(
    (await phoneVerifyRoute(post(acct.token, { phone: number, code }), deps)).statusCode,
  ).toBe(200);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  canaries.add(groupId);
  return activePhoneClaimKeys(KEYS, normalizePhoneIdentifier(number))[0]!;
}

/** A gate-passing lookup caller (verified EMAIL + ≥72 h age — the caller
 * gate is deliberately CLASS-BLIND; the budget suite drives it both ways). */
async function mkCaller(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const caller = await mkAcct(deps);
  await attachEmail(deps, caller, `pd-caller-${seq}-${RUN}@example.com`);
  deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
  return caller;
}

async function lookup(
  deps: TestDeps,
  token: string,
  body: { email: string } | { phone: string },
): Promise<HttpResult> {
  // Roll the burst window first (the accounts-discovery helper discipline);
  // the cross-class burst drive is the budget suite's.
  deps.advanceMs(61_000);
  return discoveryLookupRoute(post(token, body), deps);
}

function expectUniform(res: HttpResult): void {
  refusals.push(res);
  // Reference identity — the frozen single-exit object (the discipline):
  // a phone-classed refusal that minted its own answer cannot return it.
  expect(res).toBe(discoveryRefusal());
  expect(res).toEqual(accountsRefusal());
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  db = {
    ...base,
    isAccountsFeatureEnabled: async () => flagOn,
    isAccountsPhoneFeatureEnabled: async () => phoneFlagOn,
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

beforeEach(() => {
  flagOn = true;
  phoneFlagOn = true;
});

// The store outlives the run: every `phonehash#` claim row this suite minted
// at one of its fresh numbers is deleted, whatever the case's outcome, under
// every key version the suite writes (v1 attach, v2 forward-migration), so
// no later run — or sibling suite — meets a stale claim at a number it
// believes fresh. Only the rows THIS run's numbers address.
afterAll(async () => {
  if (!available) return;
  for (const number of issuedNumbers) {
    for (const claimKey of activePhoneClaimKeys(CLEANUP_KEYS, number)) {
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

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'discovery-wire-pre-acp2.fixture.json'),
    'utf8',
  ),
) as {
  hit: { body: string; parsed: unknown; response: { statusCode: number; body: string } };
  miss: { body: string; parsed: unknown; response: { statusCode: number; body: string } };
};

describe('THE PARALLEL-FIELD WIRE', () => {
  it('the CAPTURED previous {email} bodies parse to the IDENTICAL objects, and the both-fields / neither-field / batch shapes are malformed (.strict + exactly-one-of)', () => {
    expect(DiscoveryLookupRequest.parse(JSON.parse(fixture.hit.body))).toEqual(fixture.hit.parsed);
    expect(DiscoveryLookupRequest.parse(JSON.parse(fixture.miss.body))).toEqual(
      fixture.miss.parsed,
    );
    // The new phone half parses alone — and only alone.
    expect(DiscoveryLookupRequest.safeParse({ phone: '+15558675309' }).success).toBe(true);
    // Both fields populated: the refinement collapses it — the identifier
    // class IS the populated field, so two populated fields name no class.
    expect(
      DiscoveryLookupRequest.safeParse({ email: 'a@b.co', phone: '+15558675309' }).success,
    ).toBe(false);
    // Neither field: same.
    expect(DiscoveryLookupRequest.safeParse({}).success).toBe(false);
    // Batch shapes stay malformed for BOTH classes (the typed-single
    // contract, `.strict`): no quietly-stripped multi-lookup.
    expect(
      DiscoveryLookupRequest.safeParse({ email: 'a@b.co', emails: ['a@b.co'] }).success,
    ).toBe(false);
    expect(
      DiscoveryLookupRequest.safeParse({ phone: '+15558675309', phones: ['+15558675309'] })
        .success,
    ).toBe(false);
  });

  it('the TRANSCRIBED previous {email} flow replays byte-identically through the handler — hit AND miss — with the phone flag entirely ABSENT (no phone-flag read joins the email path)', async () => {
    // The transcription rig (memory twin, deterministic deps, seeded member
    // ULID): what this pins is the CURRENT handler's key order and bytes for
    // the landed {email} field set — honest scope per the fixture note; it
    // is not an independent capture of the previous runtime.
    const memDb = makeMemoryDb();
    memDb.setAccountsFeatureEnabled(true);
    memDb.setAccountsPhoneFeatureEnabled(false); // the email path must never consult it
    const deps = makeTestDeps(memDb);
    const mk = async (userId: string, n: number): Promise<{ userId: string; token: string }> => {
      const token = `capture-token-${n}`;
      await memDb.createUser({ userId, createdAt: deps.now(), identityKeyPub: `idkey-${userId}` });
      await memDb.createSession({
        token,
        userId,
        createdAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 365 * 86400,
      });
      return { userId, token };
    };
    const owner = await mk('01CAPTUREOWNER0000000000A1', 1);
    const caller = await mk('01CAPTURECALLER000000000A1', 2);
    const attach = async (acct: { token: string }, email: string): Promise<void> => {
      expect(
        (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps))
          .statusCode,
      ).toBe(200);
      const code = deps.emailsSent.at(-1)!.code;
      expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(
        200,
      );
    };
    await attach(owner, 'capture.owner@example.com');
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    await attach(caller, 'capture.caller@example.com');
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

    deps.advanceMs(61_000);
    const hit = await discoveryLookupRoute(post(caller.token, JSON.parse(fixture.hit.body)), deps);
    expect(hit.statusCode).toBe(fixture.hit.response.statusCode);
    expect(hit.body).toBe(fixture.hit.response.body);

    deps.advanceMs(61_000);
    const miss = await discoveryLookupRoute(
      post(caller.token, JSON.parse(fixture.miss.body)),
      deps,
    );
    expect(miss.statusCode).toBe(fixture.miss.response.statusCode);
    expect(miss.body).toBe(fixture.miss.response.body);
  });
});

describe('THE THREE-WAY PHONE ORACLE (uniform refusals)', () => {
  gated('{unregistered, registered-not-phone-discoverable} answer ONE byte-stream and ONE object; only registered-AND-phone-discoverable resolves to the minimum; consent OFF is immediately effective', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);

    // (b) registered, NOT discoverable — the DEFAULT OFF is the schema's,
    // asserted on the raw phone claim row, not the toggle's copy.
    const ndOwner = await mkAcct(deps);
    const ndNumber = freshNumber();
    const ndClaim = await attachPhone(deps, ndOwner, ndNumber);
    expect((await db.getIdentifierClaim(ndClaim))?.discoverable).toBe(false);

    // (c) registered AND discoverable — consent written by its OWNER through
    // the real PHONE toggle route (owner-written, per class).
    const dOwner = await mkAcct(deps);
    const dNumber = freshNumber();
    await attachPhone(deps, dOwner, dNumber);
    expect(
      (await setPhoneDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);

    // (a) unregistered vs (b) registered-not-discoverable: reference
    // identity through the ONE frozen exit, then bytes.
    const miss = await lookup(deps, caller.token, { phone: freshNumber() });
    const nonConsented = await lookup(deps, caller.token, { phone: ndNumber });
    expectUniform(miss);
    expectUniform(nonConsented);
    expect(miss.statusCode).toBe(nonConsented.statusCode);
    expect(miss.body).toBe(nonConsented.body);
    expect(miss.headers).toEqual(nonConsented.headers);

    // (c) resolves — EXACTLY the minimum: member ULIDs + classes + roster
    // version. No identifier echo (no E.164 byte, not even a '+'), no
    // groupId.
    const hit = await lookup(deps, caller.token, { phone: dNumber });
    expect(hit.statusCode).toBe(200);
    const body = JSON.parse(hit.body!) as {
      members: Array<{ userId: string; class: string }>;
      rosterVersion: number;
    };
    expect(Object.keys(body).sort()).toEqual(['members', 'rosterVersion']);
    expect(body.members).toEqual([{ userId: dOwner.userId, class: 'phone' }]);
    expect(body.rosterVersion).toBe(1);
    const dGroupId = (await db.getUserById(dOwner.userId))!.groupId!;
    expect(hit.body!.includes(dGroupId)).toBe(false);
    expect(hit.body!.includes('+')).toBe(false);
    expect(hit.body!.includes(dNumber)).toBe(false);

    // THE PER-CLASS ADMITTED COUNTER: every admitted PHONE
    // probe — miss, non-consented, and hit alike — emitted the field-free
    // `discovery_lookup_admitted_phone` event, and NEVER the email-class
    // counter; the caller-attach flow's email lookups are absent here, so
    // the split is exact.
    const phoneAdmitted = deps.logs.filter((l) => l.event === 'discovery_lookup_admitted_phone');
    expect(phoneAdmitted.length).toBe(3);
    for (const entry of phoneAdmitted) expect(entry.fields).toEqual({});
    expect(deps.logs.filter((l) => l.event === 'discovery_lookup_admitted').length).toBe(0);

    // Toggling phone consent OFF is IMMEDIATELY effective — strong read, no
    // cache — and the refusal is the same one object as the miss.
    expect(
      (await setPhoneDiscoverableRoute(post(dOwner.token, { discoverable: false }), deps))
        .statusCode,
    ).toBe(204);
    expectUniform(await lookup(deps, caller.token, { phone: dNumber }));
  });

  gated('PER-CLASS consent, driven BOTH ways on ONE two-identifier group: email-discoverable + phone-not refuses the phone lookup while the email lookup resolves — and the mirror case mirrors', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);

    // ONE group holding one verified email AND one verified phone (the
    // per-class slots coexisting).
    const owner = await mkAcct(deps);
    const email = `both-${RUN}@example.com`;
    const number = freshNumber();
    const emailClaim = await attachEmail(deps, owner, email);
    const phoneClaim = await attachPhone(deps, owner, number);

    // Direction 1: EMAIL consent ON, phone untouched. The email lookup
    // resolves; the PHONE lookup of the group's own verified number answers
    // the frozen uniform refusal — email consent never implied phone
    // consent, on the raw rows too.
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    expect((await db.getIdentifierClaim(emailClaim))?.discoverable).toBe(true);
    expect((await db.getIdentifierClaim(phoneClaim))?.discoverable).toBe(false);
    expect((await lookup(deps, caller.token, { email })).statusCode).toBe(200);
    expectUniform(await lookup(deps, caller.token, { phone: number }));

    // Direction 2 (the mirror): email consent OFF, PHONE consent ON. The
    // phone lookup resolves; the email lookup refuses — phone consent never
    // implied email consent either.
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: false }), deps)).statusCode,
    ).toBe(204);
    expect(
      (await setPhoneDiscoverableRoute(post(owner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);
    expect((await db.getIdentifierClaim(emailClaim))?.discoverable).toBe(false);
    expect((await db.getIdentifierClaim(phoneClaim))?.discoverable).toBe(true);
    expect((await lookup(deps, caller.token, { phone: number })).statusCode).toBe(200);
    expectUniform(await lookup(deps, caller.token, { email }));
  });

  gated('CROSS-CLASS uniformity: phone miss, email miss, and both non-consented hits answer pairwise byte-identical — which identifier field the caller populated teaches nothing', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const ndEmailOwner = await mkAcct(deps);
    const ndEmail = `xc-nd-${RUN}@example.com`;
    await attachEmail(deps, ndEmailOwner, ndEmail);
    const ndPhoneOwner = await mkAcct(deps);
    const ndNumber = freshNumber();
    await attachPhone(deps, ndPhoneOwner, ndNumber);

    const answers = [
      await lookup(deps, caller.token, { phone: freshNumber() }), // phone miss
      await lookup(deps, caller.token, { email: `xc-miss-${RUN}@example.com` }), // email miss
      await lookup(deps, caller.token, { phone: ndNumber }), // phone non-consented
      await lookup(deps, caller.token, { email: ndEmail }), // email non-consented
    ];
    for (const res of answers) expectUniform(res);
    for (const a of answers) {
      for (const b of answers) {
        expect(a.statusCode).toBe(b.statusCode);
        expect(a.body).toBe(b.body);
        expect(a.headers).toEqual(b.headers);
      }
    }
  });
});

describe("THE CLASS STRIP AT THE HANDLER, PHONE-CLASSED (the one shared hit-body builder covers both identifier classes)", () => {
  gated('a MIXED-CLASS roster resolved BY PHONE answers class ≡ the constant literal on EVERY member — never the stored tablet/desktop', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);

    // A phone-discoverable owner whose solo group is then RAW-widened to the
    // 3-class future-state roster (the agent-reach mk3Group precedent; the
    // email suite drives the {email} leg of this same redaction).
    const dOwner = await mkAcct(deps);
    const dNumber = freshNumber();
    await attachPhone(deps, dOwner, dNumber);
    expect(
      (await setPhoneDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);
    const tablet = await mkAcct(deps);
    const desktop = await mkAcct(deps);
    const gid = (await db.getUserById(dOwner.userId))!.groupId!;
    await doc.send(
      new UpdateCommand({
        TableName: TABLES.users,
        Key: { userId: groupRowKey(gid) },
        UpdateExpression: 'SET members = :m, memberClasses = :mc, memberIds = :mi',
        ExpressionAttributeValues: {
          ':m': [
            { userId: dOwner.userId, class: 'phone', linkedAt: deps.now() },
            { userId: tablet.userId, class: 'tablet', linkedAt: deps.now() },
            { userId: desktop.userId, class: 'desktop', linkedAt: deps.now() },
          ],
          ':mc': new Set(['phone', 'tablet', 'desktop']),
          ':mi': new Set([dOwner.userId, tablet.userId, desktop.userId]),
        },
      }),
    );
    // The STORED truth stays mixed — exactly what the response must not echo.
    expect((await db.getAccountGroup(gid))!.members.map((m) => m.class)).toEqual([
      'phone',
      'tablet',
      'desktop',
    ]);

    const hit = await lookup(deps, caller.token, { phone: dNumber });
    expect(hit.statusCode).toBe(200);
    const body = JSON.parse(hit.body!) as {
      members: Array<{ userId: string; class: string }>;
      rosterVersion: number;
    };
    expect(body.members).toEqual([
      { userId: dOwner.userId, class: 'phone' },
      { userId: tablet.userId, class: 'phone' },
      { userId: desktop.userId, class: 'phone' },
    ]);
    // No REAL class byte survives anywhere in the response bytes: reverting
    // discovery.ts to `class: m.class` fails HERE, where the single-member
    // 'phone' fixtures cannot tell constant from echo.
    expect(hit.body!.includes('tablet')).toBe(false);
    expect(hit.body!.includes('desktop')).toBe(false);
  });
});

describe('the phone rotation walk (class-blind)', () => {
  gated('a rotation-window phone lookup resolves under the ≤2-version walk and forward-migrates the claim on the POSITIVE branch ONLY — the dormant non-consented row stays put', async () => {
    // Stand the phone claims up under v1 alone, then look up inside a
    // rotation window where v2 is newest and v1 is retiring (the email
    // rotation case's exact shape, over the phonehash# namespace).
    const depsV1 = freshDeps();
    const migOwner = await mkAcct(depsV1);
    const migNumber = freshNumber();
    const v1Key = await attachPhone(depsV1, migOwner, migNumber);
    const migGroupId = (await db.getUserById(migOwner.userId))!.groupId!;
    expect(
      (await setPhoneDiscoverableRoute(post(migOwner.token, { discoverable: true }), depsV1))
        .statusCode,
    ).toBe(204);
    const dormantOwner = await mkAcct(depsV1);
    const dormantNumber = freshNumber();
    const dormantV1Key = await attachPhone(depsV1, dormantOwner, dormantNumber);

    const depsRot = freshDeps();
    depsRot.identifierHmac = {
      keys: [
        { version: 2, key: K2 },
        { version: 1, key: TEST_KID },
      ],
    };
    const caller = await mkCaller(depsRot);

    // POSITIVE: resolves through the walk AND migrates — v2 row born, group
    // ref re-pointed, v1 row gone; then keeps resolving at version 0.
    const hit = await lookup(depsRot, caller.token, { phone: migNumber });
    expect(hit.statusCode).toBe(200);
    const v2Key = phoneClaimKey(2, identifierClaimHash(K2, normalizePhoneIdentifier(migNumber)));
    expect((await db.getIdentifierClaim(v2Key))?.groupId).toBe(migGroupId);
    expect(await db.getIdentifierClaim(v1Key)).toBeUndefined();
    expect((await db.getAccountGroup(migGroupId))?.identifierRefs).toEqual([v2Key]);
    expect((await lookup(depsRot, caller.token, { phone: migNumber })).statusCode).toBe(200);

    // The NON-CONSENTED internal hit does NOT migrate (refusal uniformity outranks
    // migration opportunism — the refusal branches stay work-identical to a
    // miss): the dormant v1 phone claim survives untouched.
    expectUniform(await lookup(depsRot, caller.token, { phone: dormantNumber }));
    expect((await db.getIdentifierClaim(dormantV1Key))?.groupId).toBeDefined();
    const dormantV2Key = phoneClaimKey(
      2,
      identifierClaimHash(K2, normalizePhoneIdentifier(dormantNumber)),
    );
    expect(await db.getIdentifierClaim(dormantV2Key)).toBeUndefined();
  });
});

describe('the two-tier kill switch', () => {
  gated('feature#accounts-phone OFF collapses the phone class ALONE while email resolution stays live; master OFF collapses both; restoring restores both', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const emailOwner = await mkAcct(deps);
    const email = `kill-${RUN}@example.com`;
    await attachEmail(deps, emailOwner, email);
    expect(
      (await setDiscoverableRoute(post(emailOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);
    const phoneOwner = await mkAcct(deps);
    const number = freshNumber();
    await attachPhone(deps, phoneOwner, number);
    expect(
      (await setPhoneDiscoverableRoute(post(phoneOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);

    // Both flags on: both classes resolve.
    expect((await lookup(deps, caller.token, { email })).statusCode).toBe(200);
    expect((await lookup(deps, caller.token, { phone: number })).statusCode).toBe(200);

    // ONE operator delete of the SUB-flag: the phone CLASS collapses —
    // through the handler's own frozen exit (reference identity) — while
    // the email lookup keeps resolving on the same route in the same
    // process: the phone train dark inside a LIVE email discovery deploy.
    phoneFlagOn = false;
    expectUniform(await lookup(deps, caller.token, { phone: number }));
    expect((await lookup(deps, caller.token, { email })).statusCode).toBe(200);

    // THE DARK CLASS SPENDS NOTHING: five
    // flag-OFF phone probes inside ONE minute — no clock motion, no bucket
    // take of ANY kind — and the email lookup that follows in the SAME
    // minute still resolves. Before the fix the shared 5/min `discburst:`
    // window was charged before the class-flag check, so exactly this
    // sequence starved the caller's own LIVE email class for the minute —
    // and this case's old form hid it by rolling 61 s before every lookup.
    deps.advanceMs(61_000); // ONE fresh burst window for the whole sequence
    const takes: string[] = [];
    const innerLimiter = deps.rateLimit;
    deps.rateLimit = {
      take: async (bucket, opts) => {
        takes.push(bucket);
        return innerLimiter.take(bucket, opts);
      },
    };
    for (let i = 0; i < 5; i++) {
      const dark = await discoveryLookupRoute(post(caller.token, { phone: number }), deps);
      refusals.push(dark);
      expect(dark).toBe(discoveryRefusal());
    }
    expect(takes).toEqual([]); // no burst, no daily, no fleet — nothing spent
    const sameMinute = await discoveryLookupRoute(post(caller.token, { email }), deps);
    expect(sameMinute.statusCode).toBe(200);

    // Master OFF collapses BOTH classes (wrapper-level; bytes deep-equal
    // the program collapse), regardless of the sub-flag.
    phoneFlagOn = true;
    flagOn = false;
    deps.advanceMs(61_000);
    const emailDark = await discoveryLookupRoute(post(caller.token, { email }), deps);
    deps.advanceMs(61_000);
    const phoneDark = await discoveryLookupRoute(post(caller.token, { phone: number }), deps);
    refusals.push(emailDark, phoneDark);
    expect(emailDark).toEqual(accountsRefusal());
    expect(phoneDark).toEqual(accountsRefusal());
    expect(emailDark.body).toBe(phoneDark.body);

    // Both restored: both classes resolve again.
    flagOn = true;
    expect((await lookup(deps, caller.token, { email })).statusCode).toBe(200);
    expect((await lookup(deps, caller.token, { phone: number })).statusCode).toBe(200);
  });
});

describe('the class-flag read is CLASS-KEYED and FLAT', () => {
  gated('exactly ONE phone-flag read per phone-classed lookup — miss, non-consented, and HIT alike — and ZERO for any email-classed lookup: the cross-class latency step is a fact about the CALLER-chosen class, never about an address', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const ndOwner = await mkAcct(deps);
    const ndNumber = freshNumber();
    await attachPhone(deps, ndOwner, ndNumber);
    const dOwner = await mkAcct(deps);
    const dNumber = freshNumber();
    await attachPhone(deps, dOwner, dNumber);
    expect(
      (await setPhoneDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);
    const emailOwner = await mkAcct(deps);
    const email = `flagreads-${RUN}@example.com`;
    await attachEmail(deps, emailOwner, email);
    expect(
      (await setDiscoverableRoute(post(emailOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);

    // Count the flag reads through the handler's OWN deps seam: the
    // production read is one strongly consistent GetItem — structurally it
    // must fire FLAT (once per phone-classed request, whatever the number
    // resolves to) and NEVER on the email path (held
    // here as a counted fact). The timing suite
    // deliberately does not compare cross-class medians: this counter is
    // the structural pin of exactly what diverges — one class-keyed read
    // the caller opted into by populating the phone field.
    let phoneFlagReads = 0;
    const countingDeps: TestDeps = {
      ...deps,
      db: {
        ...db,
        isAccountsPhoneFeatureEnabled: async () => {
          phoneFlagReads++;
          return phoneFlagOn;
        },
      },
    };

    deps.advanceMs(61_000);
    expectUniform(
      await discoveryLookupRoute(post(caller.token, { phone: freshNumber() }), countingDeps),
    );
    expect(phoneFlagReads).toBe(1); // miss: one read
    deps.advanceMs(61_000);
    expectUniform(await discoveryLookupRoute(post(caller.token, { phone: ndNumber }), countingDeps));
    expect(phoneFlagReads).toBe(2); // non-consented: one read — never a second
    deps.advanceMs(61_000);
    expect(
      (await discoveryLookupRoute(post(caller.token, { phone: dNumber }), countingDeps)).statusCode,
    ).toBe(200);
    expect(phoneFlagReads).toBe(3); // the POSITIVE branch pays the same one

    deps.advanceMs(61_000);
    expectUniform(
      await discoveryLookupRoute(
        post(caller.token, { email: `flagreads-miss-${RUN}@example.com` }),
        countingDeps,
      ),
    );
    deps.advanceMs(61_000);
    expect(
      (await discoveryLookupRoute(post(caller.token, { email }), countingDeps)).statusCode,
    ).toBe(200);
    expect(phoneFlagReads).toBe(3); // email miss AND email hit: zero reads
  });
});

describe('refusal-uniformity and log-canary sweeps (every refusal, then the sinks)', () => {
  gated('every uniform refusal observed in this suite is ONE byte-stream (status, headers, body)', async () => {
    expect(refusals.length).toBeGreaterThan(5);
    const canonical = accountsRefusal();
    for (const res of refusals) {
      expect(res.statusCode).toBe(canonical.statusCode);
      expect(res.headers).toEqual(canonical.headers);
      expect(res.body).toBe(canonical.body);
    }
  });

  gated('the log sink captured across phone-lookup/toggle paths contains NO E.164 number, NO bare digit string of one, NO member ULID, and NO groupId', async () => {
    let lines = 0;
    for (const sink of allLogs) {
      for (const entry of sink) {
        lines++;
        const line = JSON.stringify(entry);
        expect(line.includes('@'), line).toBe(false);
        for (const id of canaries) {
          expect(line.includes(id), `${entry.event} leaked ${id}`).toBe(false);
          if (id.startsWith('+')) {
            expect(line.includes(id.slice(1)), `${entry.event} leaked digits of ${id}`).toBe(
              false,
            );
          }
        }
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});
