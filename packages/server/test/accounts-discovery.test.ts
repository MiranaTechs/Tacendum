import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY,
  DISCOVERY_LOOKUP_BURST_PER_MINUTE,
  DISCOVERY_LOOKUP_FLEET_DAILY_CEILING,
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  DISCOVERY_TIMING_MEDIAN_BOUND_MS,
  PREKEY_TARGET_DAILY_FETCH_BUDGET,
  RECOVERY_DELAY_SECONDS,
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  TABLES,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { groupRowKey, makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import { activeEmailClaimKeys, emailClaimKey, identifierClaimHash } from '../src/opaque-ref.js';
import { LIMITS } from '../src/ratelimit.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
} from '../src/handlers/discovery.js';
import { emailRequestCodeRoute, emailUnlinkRoute, emailVerifyRoute } from '../src/handlers/identifiers.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Contact discovery against REAL DynamoDB Local —
 * THE THREE-WAY ORACLE TEST: for a caller
 * with every consented right EXCEPT the target's consent, {unregistered,
 * registered-not-discoverable} answer ONE byte-stream (body AND status AND
 * headers — and, structurally, ONE frozen result object, so both branches
 * provably return through the single shared exit), and only
 * registered-AND-discoverable resolves. Toggling consent OFF makes the
 * identifier immediately unresolvable; budget exhaustion (burst, daily, and
 * the fleet ceiling) returns the SAME uniform shape; the 7-day recovery
 * cool-down refuses uniformly and RE-ARMS onto a re-minted claim;
 * a rotation-window lookup forward-migrates the claim row on the
 * POSITIVE path only; and the retained log sink never holds an identifier
 * or a ULID.
 *
 * The flag is process-local (the accounts-link discipline): the real row is
 * a store-wide singleton the suite already drives; this suite owns the
 * DISCOVERY flows with the flag ON as its default case (the OFF collapse for
 * these routes is accounts-flag-gate.test.ts's, and the kill-switch case
 * below drives the same read mid-flight).
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: TestOnlyDataLayer;
let available = false;
let flagOn = true;

// Digits only (valid Crockford base32); '71' is this file's discriminator
// (the accounts-link lesson: parallel forks mint same-millisecond RUN ids).
const RUN = `${Date.now()}71`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** The test K_id (helpers.ts injects it as version 1). */
const TEST_KID = 'test-identifier-hmac-key';
const KEYS = [{ version: 1, key: TEST_KID }];

/** Member ULIDs + groupIds that must never appear in a retained log line. */
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
  const token = `disc-tok-${RUN}-${++seq}`;
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

/** Attach a verified email to the account through the REAL routes; returns
 * the claim key. The verify leg lazily creates the solo group. */
async function attachEmail(
  deps: TestDeps,
  acct: { token: string; userId: string },
  email: string,
  cls: 'phone' | 'tablet' = 'phone',
): Promise<string> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: cls }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  canaries.add(groupId);
  return activeEmailClaimKeys(KEYS, email)[0]!;
}

/** A gate-passing lookup caller: verified identifier + ≥72 h account age
 * (the anti-Sybil pair — its OWN clock does the aging). */
async function mkCaller(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const caller = await mkAcct(deps);
  await attachEmail(deps, caller, `caller-${seq}-${RUN}@example.com`);
  deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
  return caller;
}

async function lookup(deps: TestDeps, token: string, email: string): Promise<HttpResult> {
  // Roll the burst window first: this helper is for cases NOT probing the
  // burst budget, which has its own case below.
  deps.advanceMs(61_000);
  return discoveryLookupRoute(post(token, { email }), deps);
}

function expectUniform(res: HttpResult): void {
  refusals.push(res);
  // Reference identity — the frozen single-exit object, not merely equal
  // bytes: every uniform refusal of the lookup handler IS the one object the
  // shared exit returns, so reaching any other return path is detectable.
  expect(res).toBe(discoveryRefusal());
  // And the program-wide collapse: the same bytes as the dark-flag refusal.
  expect(res).toEqual(accountsRefusal());
}

beforeAll(async () => {
  const client = makeDynamoClient();
  const base = makeTestOnlyDataLayer(makeDocClient(client));
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

beforeEach(() => {
  flagOn = true;
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('release pins (release values, never a test shadow)', () => {
  it('asserts every constant verbatim', () => {
    expect(DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY).toBe(20);
    expect(DISCOVERY_LOOKUP_BURST_PER_MINUTE).toBe(5);
    expect(DISCOVERY_LOOKUP_FLEET_DAILY_CEILING).toBe(2000);
    expect(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS).toBe(72 * 3600);
    expect(PREKEY_TARGET_DAILY_FETCH_BUDGET).toBe(30);
    expect(DISCOVERY_TIMING_MEDIAN_BOUND_MS).toBe(5);
    expect(LIMITS.discoveryLookup).toEqual({ capacity: 20, refillPerSec: 20 / 86400 });
    expect(LIMITS.discoveryLookupBurst).toEqual({ capacity: 5, refillPerSec: 5 / 60 });
    expect(LIMITS.discoveryLookupFleet).toEqual({ capacity: 2000, refillPerSec: 2000 / 86400 });
    expect(LIMITS.prekeyTargetDaily).toEqual({ capacity: 30, refillPerSec: 30 / 86400 });
  });

  it('the lookup routes THROUGH identifierClaimDiscoverable — the ONE read-time rule — rather than re-deriving it', () => {
    const src = readFileSync(new URL('../src/handlers/discovery.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/identifierClaimDiscoverable\(/);
    // No handler-local re-derivation of either half of the rule.
    expect(src.includes('.discoverable ===')).toBe(false);
    expect(src.includes('.discoverableAfter')).toBe(false);
  });
});

describe('THE THREE-WAY ORACLE (uniform refusals)', () => {
  gated('{unregistered, registered-not-discoverable} answer ONE byte-stream and ONE object; only registered-discoverable resolves — with the minimal disclosure shape', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);

    // (b) registered, NOT discoverable — the DEFAULT OFF is the schema's,
    // asserted on the raw claim row, not the toggle's copy.
    const ndOwner = await mkAcct(deps);
    const ndEmail = `nd-${RUN}@example.com`;
    const ndClaim = await attachEmail(deps, ndOwner, ndEmail);
    expect((await db.getIdentifierClaim(ndClaim))?.discoverable).toBe(false);

    // (c) registered AND discoverable — consent written by its OWNER through
    // the real toggle route (owner-written, consent-grade).
    const dOwner = await mkAcct(deps);
    const dEmail = `disc-${RUN}@example.com`;
    await attachEmail(deps, dOwner, dEmail);
    expect(
      (await setDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    // (a) unregistered vs (b) registered-not-discoverable: deep-equal on
    // body AND status AND headers — and reference-identical (the single
    // exit), so the two branches cannot even THEORETICALLY diverge in bytes.
    const miss = await lookup(deps, caller.token, `nobody-${RUN}@example.com`);
    const nonConsented = await lookup(deps, caller.token, ndEmail);
    expectUniform(miss);
    expectUniform(nonConsented);
    expect(miss.statusCode).toBe(nonConsented.statusCode);
    expect(miss.body).toBe(nonConsented.body);
    expect(miss.headers).toEqual(nonConsented.headers);

    // (c) resolves — and carries EXACTLY the minimum: member ULIDs +
    // classes + roster version. No identifier echo, no names, no groupId.
    const hit = await lookup(deps, caller.token, dEmail);
    expect(hit.statusCode).toBe(200);
    const body = JSON.parse(hit.body!) as {
      members: Array<{ userId: string; class: string }>;
      rosterVersion: number;
    };
    expect(Object.keys(body).sort()).toEqual(['members', 'rosterVersion']);
    expect(body.members).toEqual([{ userId: dOwner.userId, class: 'phone' }]);
    for (const member of body.members) {
      expect(Object.keys(member).sort()).toEqual(['class', 'userId']);
    }
    expect(body.rosterVersion).toBe(1);
    const dGroupId = (await db.getUserById(dOwner.userId))!.groupId!;
    expect(hit.body!.includes(dGroupId)).toBe(false);
    expect(hit.body!.includes('@')).toBe(false);

    // The admitted-volume counter: every ADMITTED
    // probe — miss, non-consented, and hit alike — emitted the field-free
    // `discovery_lookup_admitted` event BEFORE resolution (branch-identical
    // work; the under-cap volume alarm's signal). Field-free —
    // the canary sweep below proves nothing identifying rides it.
    const admitted = deps.logs.filter((l) => l.event === 'discovery_lookup_admitted');
    expect(admitted.length).toBeGreaterThanOrEqual(3);
    for (const entry of admitted) expect(entry.fields).toEqual({});

    // Toggling consent OFF makes the identifier IMMEDIATELY unresolvable —
    // and the refusal is the same one object as the miss.
    expect(
      (await setDiscoverableRoute(post(dOwner.token, { discoverable: false }), deps)).statusCode,
    ).toBe(204);
    expectUniform(await lookup(deps, caller.token, dEmail));

    // The kill switch: one operator write collapses the route entirely
    // (wrapper-level, so the bytes still deep-equal the program collapse),
    // and restoring the flag restores resolution.
    expect(
      (await setDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    flagOn = false;
    deps.advanceMs(61_000);
    expect(await discoveryLookupRoute(post(caller.token, { email: dEmail }), deps)).toEqual(
      accountsRefusal(),
    );
    flagOn = true;
    expect((await lookup(deps, caller.token, dEmail)).statusCode).toBe(200);
  });

  gated('the consent toggle is the uniform 204: with a claim, without one, and for a solo account — indistinguishable; only a malformed body collapses', async () => {
    const deps = freshDeps();
    const withClaim = await mkAcct(deps);
    await attachEmail(deps, withClaim, `toggle-${RUN}@example.com`);
    const noClaim = await mkAcct(deps);

    const a = await setDiscoverableRoute(post(withClaim.token, { discoverable: true }), deps);
    const b = await setDiscoverableRoute(post(noClaim.token, { discoverable: true }), deps);
    expect(a).toEqual({ statusCode: 204 });
    // Silently lossy for the claimless caller (the consent-write precedent):
    // 204, nothing written, nothing disclosed by the shape of the answer.
    expect(b).toEqual(a);

    const malformed = await setDiscoverableRoute(
      post(withClaim.token, { discoverable: 'yes' }),
      deps,
    );
    refusals.push(malformed);
    expect(malformed).toEqual(accountsRefusal());
  });

  gated('a batch-shaped payload ({email, emails:[…]}) is MALFORMED, not a multi-lookup: the strict typed-single wire contract collapses it while the same caller typed-single resolves', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const owner = await mkAcct(deps);
    const email = `strict-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    // Zod would STRIP the unknown key and quietly execute the single lookup;
    // `.strict` makes the batch shape malformed
    // instead — the typed-single contract enforced on the wire, through
    // the same uniform exit as every refusal.
    deps.advanceMs(61_000);
    const batch = await discoveryLookupRoute(
      post(caller.token, { email, emails: [email, `second-${RUN}@example.com`] }),
      deps,
    );
    expectUniform(batch);
    expect((await lookup(deps, caller.token, email)).statusCode).toBe(200);
  });

  gated('the consent write binds CURRENT membership in-transaction: a non-member cannot toggle a group claim even with every precheck bypassed', async () => {
    const deps = freshDeps();
    const owner = await mkAcct(deps);
    const email = `member-${RUN}@example.com`;
    const claimKey = await attachEmail(deps, owner, email);
    const groupId = (await db.getUserById(owner.userId))!.groupId!;
    const stranger = await mkAcct(deps);
    // Precheck-bypassed direct write (the "with the precheck bypassed"
    // pattern): the handler's snapshot reads are UX; the transaction's
    // `contains(memberIds,:actor)` ConditionCheck is the authorization, so
    // a caller whose membership ended after those reads — or a stranger who
    // skipped them — cannot toggle the surviving group's discoverability.
    expect(
      await db.setIdentifierDiscoverable(claimKey, groupId, stranger.userId, true),
    ).toBe('gone');
    expect((await db.getIdentifierClaim(claimKey))?.discoverable).toBe(false);
    // The genuine member's write commits through the same condition.
    expect(await db.setIdentifierDiscoverable(claimKey, groupId, owner.userId, true)).toBe('set');
    expect((await db.getIdentifierClaim(claimKey))?.discoverable).toBe(true);
  });
});

describe("THE CLASS STRIP AT THE HANDLER (design decision): the hit answers the CONSTANT literal 'phone', never the stored class", () => {
  gated('a MIXED-CLASS roster (phone+tablet+desktop) resolves with class ≡ the constant on EVERY member — the revert-catcher for `class: m.class`', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);

    // A discoverable owner whose solo group is then RAW-widened to the
    // 3-class future-state roster (the agent-reach mk3Group precedent: no
    // route can fill the reserved desktop slot in v1 — which is exactly why
    // the redaction must already hold for it).
    const dOwner = await mkAcct(deps);
    const email = `strip-${RUN}@example.com`;
    await attachEmail(deps, dOwner, email);
    expect(
      (await setDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    const tablet = await mkAcct(deps);
    const desktop = await mkAcct(deps);
    const gid = (await db.getUserById(dOwner.userId))!.groupId!;
    const doc = makeDocClient(makeDynamoClient());
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

    const hit = await lookup(deps, caller.token, email);
    expect(hit.statusCode).toBe(200);
    const body = JSON.parse(hit.body!) as {
      members: Array<{ userId: string; class: string }>;
      rosterVersion: number;
    };
    // Every member answers the CONSTANT literal — the same byte for the
    // phone, the tablet, and the reserved desktop slot alike...
    expect(body.members).toEqual([
      { userId: dOwner.userId, class: 'phone' },
      { userId: tablet.userId, class: 'phone' },
      { userId: desktop.userId, class: 'phone' },
    ]);
    // ...and no REAL class byte survives anywhere in the response bytes:
    // reverting discovery.ts to `class: m.class` fails HERE, where the
    // single-member 'phone' fixtures cannot tell constant from echo.
    expect(hit.body!.includes('tablet')).toBe(false);
    expect(hit.body!.includes('desktop')).toBe(false);
  });
});

describe('budget exhaustion returns the SAME uniform shape', () => {
  gated('the 5/min burst: five rapid lookups pass, the sixth is the uniform refusal — same object as a miss', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const owner = await mkAcct(deps);
    const email = `burst-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    for (let i = 0; i < DISCOVERY_LOOKUP_BURST_PER_MINUTE; i++) {
      expect(
        (await discoveryLookupRoute(post(caller.token, { email }), deps)).statusCode,
        `burst lookup ${i + 1}`,
      ).toBe(200);
    }
    // The sixth, same minute: refused — but in the ONE uniform shape, never
    // a 429 (the deliberate widening of the caller-budget rule: on THIS
    // route the refusal shape is itself the oracle surface, so budget
    // refusals may not be distinguishable from a miss).
    expectUniform(await discoveryLookupRoute(post(caller.token, { email }), deps));
  });

  gated('the 20/day budget: twenty lookups resolve, the twenty-first refuses uniformly against a target that a fresh caller can still resolve', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const owner = await mkAcct(deps);
    const email = `daily-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    for (let n = 1; n <= DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY; n++) {
      expect((await lookup(deps, caller.token, email)).statusCode, `lookup ${n}`).toBe(200);
    }
    // The 21st: burst refilled (61 s roll), daily spent — the uniform shape.
    expectUniform(await lookup(deps, caller.token, email));
    // The budget is the caller's, not the target's: a second gate-passing
    // caller still resolves, so the refusal above was genuinely the budget.
    const caller2 = await mkCaller(deps);
    expect((await lookup(deps, caller2.token, email)).statusCode).toBe(200);
  });

  gated('the 20/day budget is per-ACCOUNT, not per member ULID: two linked siblings share ONE daily budget through the group key', async () => {
    const deps = freshDeps();
    // A two-member group via the ceremony; ONE verified email on the GROUP
    // (which is what satisfies BOTH members' eligibility — exactly why the
    // budget must collapse to the same scope: per-ULID keying would hand the
    // pair 40/day off one inbox round-trip).
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const pairGroupId = uid();
    const offerNonce = `nonce-${uid()}`;
    const nowS = Math.floor(deps.now() / 1000);
    expect(
      await db.putLinkOffer({
        offerNonce,
        groupId: pairGroupId,
        offererUserId: a.userId,
        acceptorUserId: b.userId,
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
    canaries.add(pairGroupId);
    await attachEmail(deps, a, `shared-${RUN}@example.com`);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

    const owner = await mkAcct(deps);
    const email = `shared-target-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);

    // Sibling A spends 19, sibling B is admitted for the 20th (so B is
    // demonstrably gate-passing) — then BOTH are refused: one shared count,
    // keyed by the group, not 20 apiece.
    for (let n = 1; n < DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY; n++) {
      expect((await lookup(deps, a.token, email)).statusCode, `sibling A lookup ${n}`).toBe(200);
    }
    expect((await lookup(deps, b.token, email)).statusCode, 'sibling B, the 20th').toBe(200);
    expectUniform(await lookup(deps, b.token, email));
    expectUniform(await lookup(deps, a.token, email));
  });

  gated('the fleet-wide 2,000/day ceiling: beyond it, uniform refusals + the scrape-alarm event (field-free)', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const owner = await mkAcct(deps);
    const email = `fleet-${RUN}@example.com`;
    await attachEmail(deps, owner, email);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    expect((await lookup(deps, caller.token, email)).statusCode).toBe(200);

    // Exhaust the shared ceiling directly against the SAME limiter the
    // handler draws (the deterministic in-memory twin; the cross-instance
    // fleet drive is accounts-discovery-budget.test.ts's, on the real DDB
    // window).
    for (let i = 0; i < DISCOVERY_LOOKUP_FLEET_DAILY_CEILING; i++) {
      await deps.rateLimit.take('disc-fleet', LIMITS.discoveryLookupFleet);
    }
    // Same instant — no burst roll: the 2,000/day bucket refills ~1.4 tokens
    // per 61 s, so any clock motion here would quietly re-admit the probe.
    expectUniform(await discoveryLookupRoute(post(caller.token, { email }), deps));
    // The scrape alarm's countable event fired, and it is FIELD-FREE (rule
    // 5): the infra metric filter counts it; nothing identifying rides it.
    const scrape = deps.logs.filter((l) => l.event === 'discovery_lookup_fleet_refused');
    expect(scrape.length).toBeGreaterThan(0);
    expect(scrape.at(-1)!.fields).toEqual({});
  });
});

describe('the 7-day cool-down consumer + re-arm, and the rotation walk', () => {
  gated('recovery arms the cool-down (claim + group), lookup refuses uniformly INSIDE it with consent ON, re-attach after unlink RE-ARMS it onto the fresh claim, and resolution returns at exactly discoverableAfter (the ≥ boundary)', async () => {
    const deps = freshDeps();
    const caller = await mkCaller(deps);
    const owner = await mkAcct(deps);
    const email = `cool-${RUN}@example.com`;
    const claimKey = await attachEmail(deps, owner, email);
    const groupId = (await db.getUserById(owner.userId))!.groupId!;
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    expect((await lookup(deps, caller.token, email)).statusCode).toBe(200);

    // A recovery completes (the mechanics are accounts-recovery.test.ts's;
    // this suite consumes their read-time effect).
    const recovering = await mkAcct(deps);
    const nowS = Math.floor(deps.now() / 1000);
    expect(
      await db.putRecoveryPending({
        groupId,
        newUserId: recovering.userId,
        deviceClass: 'tablet',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 1) * 1000);
    const completeS = Math.floor(deps.now() / 1000);
    const discoverableAfter = completeS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS;
    const completed = await db.completeRecovery({
      groupId,
      newUserId: recovering.userId,
      nowSeconds: completeS,
      linkedAtMs: deps.now(),
      discoverableAfter,
    });
    expect(completed.outcome).toBe('completed');

    // The cool-down is armed on the claim row AND carried on the GROUP row
    // (the f7 durable fix: the group is what survives an unlink).
    const armed = (await db.getIdentifierClaim(claimKey))!;
    expect(armed.discoverable).toBe(true); // consent untouched
    expect(armed.discoverableAfter).toBe(discoverableAfter);
    expect((await db.getAccountGroup(groupId))?.discoverableAfter).toBe(discoverableAfter);

    // INSIDE the cool-down, consent ON: the lookup refuses — uniformly, the
    // same single-exit object as a miss (a cool-down is not the
    // caller's to observe).
    expectUniform(await lookup(deps, caller.token, email));

    // The f7 bypass, CLOSED: unlink, then re-attach the same identifier —
    // the fresh claim row is born ALREADY carrying the group's cool-down.
    expect((await emailUnlinkRoute(post(owner.token, {}), deps)).statusCode).toBe(200);
    expect(await db.getIdentifierClaim(claimKey)).toBeUndefined();
    deps.advanceMs(61_000); // the address's resend cool-down
    const reClaim = await attachEmail(deps, owner, email);
    expect((await db.getIdentifierClaim(reClaim))?.discoverableAfter).toBe(discoverableAfter);
    expect(
      (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    expectUniform(await lookup(deps, caller.token, email));

    // The bypass, CLOSED: shedding the GROUP is no
    // escape either — unlink again, then attach the same address from a
    // BRAND-NEW pristine account into a fresh solo group (the recovered
    // attacker's cheapest identity; the "identity-sign an amicable
    // self-unlink then re-attach solo" loop is this same carrier-less-group
    // shape). The fresh claim is STILL born carrying the cool-down: the
    // ADDRESS-keyed shadow the completion wrote survives the claim row, the
    // group row, and the device alike — the cool-down follows the address.
    expect((await emailUnlinkRoute(post(owner.token, {}), deps)).statusCode).toBe(200);
    deps.advanceMs(61_000); // the address's resend cool-down
    const fresh = await mkAcct(deps);
    const freshClaim = await attachEmail(deps, fresh, email);
    expect((await db.getIdentifierClaim(freshClaim))?.discoverableAfter).toBe(discoverableAfter);
    expect(
      (await setDiscoverableRoute(post(fresh.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    expectUniform(await lookup(deps, caller.token, email));

    // At EXACTLY discoverableAfter the claim resolves again — the helper's
    // `now ≥ discoverableAfter` boundary, driven through the route. The
    // final advance lands the clock on the boundary second (the lookup
    // helper's own 61 s roll included).
    deps.advanceMs((discoverableAfter - Math.floor(deps.now() / 1000)) * 1000 - 61_000);
    const back = await lookup(deps, caller.token, email);
    expect(Math.floor(deps.now() / 1000)).toBe(discoverableAfter);
    expect(back.statusCode).toBe(200);
  });

  gated('a rotation-window lookup forward-migrates the claim to the newest K_id version on the POSITIVE path — and deliberately NOT on the refusal path (refusal uniformity outranks migration opportunism)', async () => {
    // Stand the claims up under v1 alone (the live key), then look up inside
    // a rotation window where v2 is newest and v1 is retiring.
    const depsV1 = freshDeps();
    const migOwner = await mkAcct(depsV1);
    const migEmail = `mig-${RUN}@example.com`;
    const v1Key = await attachEmail(depsV1, migOwner, migEmail);
    const migGroupId = (await db.getUserById(migOwner.userId))!.groupId!;
    expect(
      (await setDiscoverableRoute(post(migOwner.token, { discoverable: true }), depsV1)).statusCode,
    ).toBe(204);
    const dormantOwner = await mkAcct(depsV1);
    const dormantEmail = `dormant-${RUN}@example.com`;
    const dormantV1Key = await attachEmail(depsV1, dormantOwner, dormantEmail);

    const depsRot = freshDeps();
    const K2 = 'test-identifier-hmac-key-v2';
    depsRot.identifierHmac = {
      keys: [
        { version: 2, key: K2 },
        { version: 1, key: TEST_KID },
      ],
    };
    const caller = await mkCaller(depsRot);

    // The POSITIVE lookup resolves through the ≤2-GetItem walk AND migrates
    // the claim forward: v2 row born, group ref re-pointed, v1 row gone (the
    // f6 wiring — "any successful resolution opportunistically
    // re-writes").
    const hit = await lookup(depsRot, caller.token, migEmail);
    expect(hit.statusCode).toBe(200);
    const v2Key = emailClaimKey(2, identifierClaimHash(K2, migEmail));
    expect((await db.getIdentifierClaim(v2Key))?.groupId).toBe(migGroupId);
    expect(await db.getIdentifierClaim(v1Key)).toBeUndefined();
    expect((await db.getAccountGroup(migGroupId))?.identifierRefs).toEqual([v2Key]);
    // The migrated claim keeps resolving (now at version 0 of the walk).
    expect((await lookup(depsRot, caller.token, migEmail)).statusCode).toBe(200);

    // The NON-CONSENTED internal hit does NOT migrate: the refusal branches
    // must stay byte- and work-identical to a miss, so the dormant
    // row waits for a resolution moment that is already distinguishable —
    // exactly the recovery legs' recorded posture.
    expectUniform(await lookup(depsRot, caller.token, dormantEmail));
    expect((await db.getIdentifierClaim(dormantV1Key))?.groupId).toBeDefined();

    // Claim uniqueness holds across the WHOLE rotation window:
    // the dormant v1 claim still owns its address, so a second
    // account attaching that address under the v2-newest window is REFUSED
    // by the attach transaction's retiring-version condition check — the
    // same collapsed answer as every claim conflict — and no v2 claim row is
    // born to shadow the v1 consent state.
    const poacher = await mkAcct(depsRot);
    expect(
      (
        await emailRequestCodeRoute(
          post(poacher.token, { email: dormantEmail, class: 'phone' }),
          depsRot,
        )
      ).statusCode,
    ).toBe(200);
    const poachCode = depsRot.emailsSent.at(-1)!.code;
    const poach = await emailVerifyRoute(
      post(poacher.token, { email: dormantEmail, code: poachCode }),
      depsRot,
    );
    refusals.push(poach);
    expect(poach).toEqual(accountsRefusal());
    const dormantV2Key = emailClaimKey(2, identifierClaimHash(K2, dormantEmail));
    expect(await db.getIdentifierClaim(dormantV2Key)).toBeUndefined();
    expect((await db.getIdentifierClaim(dormantV1Key))?.groupId).toBeDefined();
    expect((await db.getUserById(poacher.userId))?.groupId).toBeUndefined();
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

  gated('the log sink captured across lookup/toggle paths contains NEITHER an identifier NOR any member ULID or groupId', async () => {
    let lines = 0;
    for (const sink of allLogs) {
      for (const entry of sink) {
        lines++;
        const line = JSON.stringify(entry);
        expect(line.includes('@'), line).toBe(false);
        for (const id of canaries) {
          expect(line.includes(id), `${entry.event} leaked ${id}`).toBe(false);
        }
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});
