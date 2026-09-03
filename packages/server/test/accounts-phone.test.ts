import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
  EMAIL_CODE_TTL_SECONDS,
  IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY,
  PHONE_SEND_FLEET_BURST_PER_MINUTE,
  PHONE_SEND_FLEET_DAILY_CEILING,
  PHONE_SENDS_PER_RECIPIENT_PER_DAY,
  PHONE_SUPPRESSION_TTL_SECONDS,
  TABLES,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  ACCOUNTS_FEATURE_FLAG_KEY,
  ACCOUNTS_PHONE_FEATURE_FLAG_KEY,
  EMAIL_CODE_KEY_PREFIX,
  isClaimKey,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
} from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  activePhoneClaimKeys,
  identifierClaimHash,
} from '../src/opaque-ref.js';
import { LIMITS, type RateLimiter } from '../src/ratelimit.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneUnlinkRoute,
  phoneVerifyRoute,
  recoveryRequestCodeRoute,
} from '../src/handlers/identifiers.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Phone linking against REAL DynamoDB Local — the accounts-identifier suite's
 * discipline applied to the second identifier class, with each class's own edges
 * driven by name: the per-class one-slot rule both ways, the SHARED cross-class
 * attach budget, the vendor-sends-only fleet accounting, the destination brake
 * driven with the seam instrumented, and the per-class unlink's raw-equal
 * survival in both directions.
 *
 * THIS FILE IS `heavy` (vitest.config.ts) AND CI RUNS ONLY `fast`. So the
 * store-blind pins that used to live here — the shared item-4(c) construction
 * byte vector, the input-space disjointness asserted through the wire schemas,
 * the Appendix A release pins, and the R-P7c strict-E.164 normalizer vectors —
 * now live in accounts-phone.pins.test.ts, which stays in `fast` and therefore
 * keeps running on every PR. Anything added here that does not
 * need :8000 belongs in that sibling, not in this file.
 *
 * Both flags are process-local and ON as this suite's default (the
 * accounts-identifier discipline): the OFF collapses live in
 * accounts-flag-gate.test.ts. */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let realDb: TestOnlyDataLayer;
let available = false;
let flagOn = true;
let phoneFlagOn = true;

// Digits only (valid Crockford base32); '71' is this file's discriminator.
const RUN = `${Date.now()}71`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Per-run, per-case NANP numbers: +15550 + 6 run/case digits — inside the
 * allowlist, in the `+15550` band no sibling suite generates (the
 * phone-discovery/timing/budget/username-discovery suites take +15552…5),
 * unique per run so a Scan match is THIS run's leak.
 *
 * The base is a random draw, NOT the clock: the earlier `RUN.slice(-6)`
 * base was only Date.now mod 10 000 (a 10-second cycle) beside the fixed
 * '71' discriminator, and the claim rows this suite mints persist in
 * DynamoDB Local for as long as the container lives — so a later run
 * landing on the same 4 clock digits met a PERSISTED `phonehash#` row at its
 * "fresh" number and the attach transaction answered `claim_exists` where
 * the test expects `identifier_cap` (the store's claim-Put condition runs
 * before the per-class snapshot CAS is classified). Every issued number is
 * recorded so `afterAll` can delete its claim rows — the store no longer
 * accumulates this suite's rows between runs. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 1_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+15550${`${(NUMBER_BASE + ++numSeq) % 1_000_000}`.padStart(6, '0')}`;
  issuedNumbers.push(number);
  return number;
}
/** The canary number: if these bytes (or the bare digit string) ever land in
 * a row or a log line, the plaintext leaked. */
const CANARY_PHONE = freshNumber();

/** The test K_id (helpers.ts injects it as version 1). */
const TEST_KID = 'test-identifier-hmac-key';
const KEYS = [{ version: 1, key: TEST_KID }];

const canaries = new Set<string>();
const allLogs: LogEntry[][] = [];
const refusals: HttpResult[] = [];

/** Deps with the rate limiter INSTRUMENTED:
 * every take's bucket key is recorded, so a suite can prove which windows a
 * branch touched — the fleet keys on a vendor send, and NEVER on a miss. */
function freshDeps(): TestDeps & { takes: string[] } {
  const deps = makeTestDeps(db) as TestDeps & { takes: string[] };
  allLogs.push(deps.logs);
  const inner: RateLimiter = deps.rateLimit;
  const takes: string[] = [];
  deps.takes = takes;
  deps.rateLimit = {
    take: async (bucket, opts) => {
      takes.push(bucket);
      return inner.take(bucket, opts);
    },
  };
  return deps;
}

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string }> {
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(`idkey-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `ph-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 30,
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

function expectRefused(res: HttpResult): void {
  refusals.push(res);
  expect(res).toEqual(accountsRefusal());
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

/** Full attach of `number` for `acct` through the REAL routes. */
async function attachPhone(
  deps: TestDeps,
  acct: { token: string },
  number: string,
  deviceClass = 'phone',
): Promise<void> {
  expect(
    (await phoneRequestCodeRoute(post(acct.token, { phone: number, class: deviceClass }), deps))
      .statusCode,
  ).toBe(200);
  const code = deps.smsSent.at(-1)!.code;
  expect(
    (await phoneVerifyRoute(post(acct.token, { phone: number, code }), deps)).statusCode,
  ).toBe(200);
}

async function attachEmail(deps: TestDeps, acct: { token: string }, email: string): Promise<void> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
}

beforeAll(async () => {
  const client = makeDynamoClient();
  const base = makeTestOnlyDataLayer(makeDocClient(client));
  doc = makeDocClient(client);
  // The UN-overridden layer: the real-flag-row suite below drives the real
  // `feature#accounts-phone` read (the master flag has this
  // suite in accounts-group.test.ts; the phone flag had only closures).
  realDb = base;
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

// The store outlives the run (DynamoDB Local persists between suites and
// between days): every `phonehash#` claim row this suite minted at one of
// its fresh numbers is deleted, whatever the case's outcome, so no later
// run — or a sibling suite — meets a stale claim at a number it believes
// fresh. Only the rows THIS run's numbers address; the ids are ULIDs on the
// full millisecond RUN and never collide.
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

describe('phone attach against real DynamoDB (ACP1 item 4)', () => {
  gated('attach requires a verified code: no code ever requested, and a wrong code, are both the collapsed refusal', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    expectRefused(
      await phoneVerifyRoute(post(acct.token, { phone: CANARY_PHONE, code: '999999' }), deps),
    );
    expect(
      (
        await phoneRequestCodeRoute(post(acct.token, { phone: CANARY_PHONE, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    expect(deps.smsSent).toHaveLength(1);
    expect(deps.smsSent[0]!.number).toBe(CANARY_PHONE);
    expectRefused(
      await phoneVerifyRoute(post(acct.token, { phone: CANARY_PHONE, code: '000000' }), deps),
    );
    const code = deps.smsSent[0]!.code;
    expect(
      (await phoneVerifyRoute(post(acct.token, { phone: CANARY_PHONE, code }), deps)).statusCode,
    ).toBe(200);
  });

  gated('the stored key is phonehash#v<K># with HMAC output — and a paged Scan of BOTH test tables finds neither the plaintext number nor its digit string anywhere', async () => {
    const deps = freshDeps();
    const number = freshNumber();
    const acct = await mkAcct(deps);
    await attachPhone(deps, acct, number);

    const claimKey = activePhoneClaimKeys(KEYS, number)[0]!;
    expect(claimKey).toBe(`phonehash#v1#${identifierClaimHash(TEST_KID, number)}`);
    const claim = await rawRow(SERVER_TABLES.users, { userId: claimKey });
    expect(claim?.kind).toBe('identifierClaim');
    expect(claim?.discoverable).toBe(false);
    canaries.add(claim?.groupId as string);

    // THE DUMP GREP, phone edition: every row of both tables, serialized —
    // neither the E.164 spelling NOR the bare digit string may appear
    // anywhere (a digit-only leak would evade an E.164 grep).
    for (const table of [SERVER_TABLES.users, SERVER_TABLES.sessions]) {
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new ScanCommand({
            TableName: table,
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        );
        const dump = JSON.stringify(page.Items ?? []);
        for (const leak of [number, number.slice(1), CANARY_PHONE, CANARY_PHONE.slice(1)]) {
          expect(dump.includes(leak), `${table} holds ${leak}`).toBe(false);
        }
        startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
    }
  });

  gated('an expired-but-unreaped phone code — row still present, expiresAt past — is REFUSED by the clock, never the reaper', async () => {
    const deps = freshDeps();
    const number = freshNumber();
    const acct = await mkAcct(deps);
    expect(
      (await phoneRequestCodeRoute(post(acct.token, { phone: number, class: 'phone' }), deps))
        .statusCode,
    ).toBe(200);
    const code = deps.smsSent.at(-1)!.code;
    deps.advanceMs((EMAIL_CODE_TTL_SECONDS + 1) * 1000);
    const row = await rawRow(SERVER_TABLES.sessions, {
      token: `${EMAIL_CODE_KEY_PREFIX}${acct.userId}#attach`,
    });
    expect(row?.kind).toBe('emailCode');
    expect(row?.expiresAt as number).toBeLessThan(Math.floor(deps.now() / 1000));
    expectRefused(await phoneVerifyRoute(post(acct.token, { phone: number, code }), deps));
  });

  gated('ONE verified phone per group, refused at BOTH arms — while one email + one phone COEXIST (the per-class one-slot rule, both ways)', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    const number = freshNumber();
    await attachPhone(deps, acct, number);
    const groupId = (await db.getUserById(acct.userId))!.groupId!;
    canaries.add(groupId);

    // ARM 1 (request-code precheck): a second phone for the same group.
    const second = freshNumber();
    deps.advanceMs(61 * 1000);
    expectRefused(
      await phoneRequestCodeRoute(post(acct.token, { phone: second, class: 'phone' }), deps),
    );
    expect(deps.smsSent).toHaveLength(1);

    // ARM 2 (the transaction condition): a hand-seeded valid code for a
    // second number still refuses at the refs-snapshot condition —
    // 'identifier_cap', never an attach.
    const secondKey = activePhoneClaimKeys(KEYS, second)[0]!;
    await db.putEmailCode({
      userId: acct.userId,
      purpose: 'attach',
      claimKey: secondKey,
      deviceClass: 'phone',
      code: '123456',
      attempts: 0,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + EMAIL_CODE_TTL_SECONDS,
    });
    expect(
      await db.attachIdentifier({
        userId: acct.userId,
        deviceClass: 'phone',
        existingGroupId: groupId,
        newGroupId: uid(),
        claimKey: secondKey,
        // A stale snapshot (as a racing handler would hold): the phone slot
        // filled after its read.
        refsSnapshot: [],
        nowMs: deps.now(),
      }),
    ).toBe('identifier_cap');
    await db.deleteEmailCode(acct.userId, 'attach');

    // COEXIST: the same group takes ONE email beside its phone.
    const email = `coexist-${RUN}@example.com`;
    await attachEmail(deps, acct, email);
    const refs = (await db.getAccountGroup(groupId))!.identifierRefs;
    expect(refs).toHaveLength(2);
    expect(refs).toContain(activePhoneClaimKeys(KEYS, number)[0]!);
    expect(refs).toContain(activeEmailClaimKeys(KEYS, email)[0]!);

    // ARM 3 — THE STORAGE-LAYER BACKSTOP: a caller passing
    // the MATCHING full snapshot (as a buggy or hostile TestOnlyDataLayer caller
    // that skipped the class check would) STILL refuses at the
    // transaction's own size cap — snapshot equality is a CAS, not a
    // cap, and the store enforces the pinned total itself.
    const third = freshNumber();
    const thirdKey = activePhoneClaimKeys(KEYS, third)[0]!;
    await db.putEmailCode({
      userId: acct.userId,
      purpose: 'attach',
      claimKey: thirdKey,
      deviceClass: 'phone',
      code: '123456',
      attempts: 0,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + EMAIL_CODE_TTL_SECONDS,
    });
    expect(
      await db.attachIdentifier({
        userId: acct.userId,
        deviceClass: 'phone',
        existingGroupId: groupId,
        newGroupId: uid(),
        claimKey: thirdKey,
        // The MATCHING snapshot — exactly what the group row holds.
        refsSnapshot: refs,
        nowMs: deps.now(),
      }),
    ).toBe('identifier_cap');
    await db.deleteEmailCode(acct.userId, 'attach');
    expect((await db.getAccountGroup(groupId))!.identifierRefs).toHaveLength(2);
    expect(await rawRow(SERVER_TABLES.users, { userId: thirdKey })).toBeUndefined();
  });

  gated('the SHARED 10/day group attach budget spends ACROSS classes: 6 email + 4 phone attempts exhaust it, and the 11th of EITHER class refuses bytes-uniform (429, one caller budget)', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    // 6 email asks + 4 phone asks, spaced past the idroute burst — ONE
    // caller-keyed bucket (`emailattach:<caller>`) spends for both classes.
    for (let n = 1; n <= 6; n++) {
      deps.advanceMs(61 * 1000);
      expect(
        (
          await emailRequestCodeRoute(
            post(acct.token, { email: `shared-${RUN}-${n}@example.com`, class: 'phone' }),
            deps,
          )
        ).statusCode,
      ).toBe(200);
    }
    for (let n = 1; n <= 4; n++) {
      deps.advanceMs(61 * 1000);
      expect(
        (
          await phoneRequestCodeRoute(
            post(acct.token, { phone: freshNumber(), class: 'phone' }),
            deps,
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY).toBe(10);
    // The 11th — of EITHER class — refuses on the ONE spent bucket, and the
    // two classes' refusals are byte-uniform against each other (a
    // class-split budget would answer one of them 200).
    deps.advanceMs(61 * 1000);
    const phoneOver = await phoneRequestCodeRoute(
      post(acct.token, { phone: freshNumber(), class: 'phone' }),
      deps,
    );
    const emailOver = await emailRequestCodeRoute(
      post(acct.token, { email: `shared-${RUN}-over@example.com`, class: 'phone' }),
      deps,
    );
    expect(phoneOver.statusCode).toBe(429);
    expect(emailOver.statusCode).toBe(429);
    expect(emailOver.body).toBe(phoneOver.body);
    // And no send left either seam for the over-budget asks.
    expect(deps.smsSent).toHaveLength(4);
    expect(deps.emailsSent).toHaveLength(6);
  });

  gated('3/day per-number sends and the 60 s resend cool-down, asserted verbatim — refusals byte-uniform with success, nothing leaves the seam', async () => {
    const deps = freshDeps();
    const number = freshNumber();
    const acct = await mkAcct(deps);
    const ask = async (): Promise<HttpResult> =>
      phoneRequestCodeRoute(post(acct.token, { phone: number, class: 'phone' }), deps);

    const firstRes = await ask();
    expect(firstRes.statusCode).toBe(200);
    expect(deps.smsSent).toHaveLength(1);
    // INSIDE the 60 s cool-down: refused, byte-identical, no send.
    const cooled = await ask();
    expect(cooled).toEqual(firstRes);
    expect(deps.smsSent).toHaveLength(1);
    // Past the cool-down, sends 2..3 of the day pass...
    for (let n = 2; n <= PHONE_SENDS_PER_RECIPIENT_PER_DAY; n++) {
      deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
      expect(await ask()).toEqual(firstRes);
      expect(deps.smsSent).toHaveLength(n);
    }
    // ...and the FOURTH is past the per-number daily budget: refused — same
    // bytes, no send.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(await ask()).toEqual(firstRes);
    expect(deps.smsSent).toHaveLength(PHONE_SENDS_PER_RECIPIENT_PER_DAY);
  });

  gated('THE VENDOR-SEND FLEET ACCOUNTING: a recovery-by-phone MISS spends the per-number and caller buckets but leaves BOTH fleet windows untouched — a run of misses at the fleet ceiling still admits the next real send — while every actual vendor send charges them', async () => {
    const deps = freshDeps();
    // Drain the DAILY fleet window to ONE remaining token by direct takes
    // on the same bucket the send branch charges — the ceiling at its real
    // 200 count, without 199 vendor sends.
    for (let n = 1; n <= PHONE_SEND_FLEET_DAILY_CEILING - 1; n++) {
      expect(await deps.rateLimit.take('smssend-fleet', LIMITS.phoneSendFleet)).toBe(0);
    }
    // A run of recovery MISSES (never-attached numbers): identifier-keyed
    // and caller budgets spend, the fleet windows do NOT.
    const prober = await mkAcct(deps);
    deps.takes.length = 0;
    for (let n = 1; n <= 3; n++) {
      deps.advanceMs(61 * 1000);
      const miss = await recoveryRequestCodeRoute(
        post(prober.token, { phone: freshNumber() }),
        deps,
      );
      expect(miss.statusCode).toBe(200);
    }
    expect(deps.smsSent).toHaveLength(0);
    expect(deps.takes.filter((key) => key === 'smssend-fleet')).toHaveLength(0);
    expect(deps.takes.filter((key) => key === 'smssend-fleet-burst')).toHaveLength(0);
    // The per-number and caller buckets DID spend on the misses — the
    // per-number one on its MISS window (a miss no longer spends the SEND
    // window, so strangers' probes cannot lock a number's owner out of
    // attaching it), the send window untouched.
    expect(deps.takes.some((key) => key.startsWith('phonemiss:'))).toBe(true);
    expect(deps.takes.some((key) => key.startsWith('phonesend:'))).toBe(false);
    expect(deps.takes.some((key) => key.startsWith('emailattach:'))).toBe(true);

    // The next REAL send is still admitted (the misses did not spend the
    // one remaining fleet token) — and it charges BOTH fleet windows.
    const owner = await mkAcct(deps);
    deps.takes.length = 0;
    expect(
      (
        await phoneRequestCodeRoute(post(owner.token, { phone: freshNumber(), class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    expect(deps.smsSent).toHaveLength(1);
    expect(deps.takes.filter((key) => key === 'smssend-fleet')).toHaveLength(1);
    expect(deps.takes.filter((key) => key === 'smssend-fleet-burst')).toHaveLength(1);

    // The ceiling is now SPENT (200 takes): the next would-be send refuses
    // uniform and emits the FIELD-FREE fleet counter.
    const another = await mkAcct(deps);
    const logsBefore = deps.logs.length;
    deps.takes.length = 0;
    const refusedRes = await phoneRequestCodeRoute(
      post(another.token, { phone: freshNumber(), class: 'phone' }),
      deps,
    );
    expect(refusedRes.statusCode).toBe(200); // uniform — the caller learns nothing
    expect(deps.smsSent).toHaveLength(1); // nothing left the seam
    const fleetEvents = deps.logs.slice(logsBefore).filter((e) => e.event === 'sms_send_fleet_refused');
    expect(fleetEvents).toHaveLength(1);
    expect(fleetEvents[0]!.fields).toEqual({});
    // THE ONE BOUNDED EXCEPTION to "vendor sends only", pinned AS STATED
    //: the burst take ran — and was granted — before the
    // daily ceiling refused, so ONE burst token was spent on this non-send
    // (≤5/min, self-healing; the daily window untouched by it). The reverse
    // order is refused with verified reason: daily-first would let
    // >burst-rate traffic burn the whole 200/day window on burst refusals —
    // a zero-spend exhaustion reopened.
    expect(deps.takes.filter((key) => key === 'smssend-fleet-burst')).toHaveLength(1);
    expect(deps.takes.filter((key) => key === 'smssend-fleet')).toHaveLength(1);
  });

  gated('the 5/min fleet BURST brake rides the send branch: five sends inside the minute pass, the sixth refuses uniform with no vendor call (and the daily window untouched by the refusal)', async () => {
    const deps = freshDeps();
    // Five sends from five callers to five numbers inside one minute.
    for (let n = 1; n <= PHONE_SEND_FLEET_BURST_PER_MINUTE; n++) {
      const acct = await mkAcct(deps);
      expect(
        (
          await phoneRequestCodeRoute(post(acct.token, { phone: freshNumber(), class: 'phone' }), deps)
        ).statusCode,
      ).toBe(200);
    }
    expect(deps.smsSent).toHaveLength(PHONE_SEND_FLEET_BURST_PER_MINUTE);
    const sixth = await mkAcct(deps);
    deps.takes.length = 0;
    const logsBefore = deps.logs.length;
    const res = await phoneRequestCodeRoute(
      post(sixth.token, { phone: freshNumber(), class: 'phone' }),
      deps,
    );
    expect(res.statusCode).toBe(200); // uniform
    expect(deps.smsSent).toHaveLength(PHONE_SEND_FLEET_BURST_PER_MINUTE);
    // The burst refusal happened BEFORE the daily take (order: burst, then
    // ceiling) — the daily window is not double-charged by refused sends.
    expect(deps.takes.filter((key) => key === 'smssend-fleet')).toHaveLength(0);
    // The burst brake is NOT silent: its refusal emits the
    // same field-free `sms_send_fleet_refused` counter the daily ceiling
    // emits — one counter, one metric filter, one alarm; a flood refused by
    // the worst-hour brake pages instead of vanishing until the daily
    // ceiling also exhausts.
    const burstEvents = deps.logs
      .slice(logsBefore)
      .filter((e) => e.event === 'sms_send_fleet_refused');
    expect(burstEvents).toHaveLength(1);
    expect(burstEvents[0]!.fields).toEqual({});
  });

  gated('THE SERVER-SIDE BRAKE: an off-allowlist destination (a non-+1 E.164) refuses through the uniform exit BEFORE the vendor seam is touched — driven with the seam instrumented', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    // The reference answer: a same-shaped ON-allowlist ask.
    const onList = await phoneRequestCodeRoute(
      post(acct.token, { phone: freshNumber(), class: 'phone' }),
      deps,
    );
    expect(onList.statusCode).toBe(200);
    expect(deps.smsSent).toHaveLength(1);

    const acct2 = await mkAcct(deps);
    for (const offList of ['+447911123456', '+8613800000000']) {
      const res = await phoneRequestCodeRoute(
        post(acct2.token, { phone: offList, class: 'phone' }),
        deps,
      );
      // The uniform identifier-keyed exit — byte-identical to the admitted
      // ask's answer; the caller cannot learn the allowlist's edge.
      expect(res.statusCode).toBe(onList.statusCode);
      expect(res.body).toBe(onList.body);
      deps.advanceMs(61 * 1000);
    }
    // The seam was NEVER touched and no code row was minted for either.
    expect(deps.smsSent).toHaveLength(1);
    expect(
      await rawRow(SERVER_TABLES.sessions, {
        token: `${EMAIL_CODE_KEY_PREFIX}${acct2.userId}#attach`,
      }),
    ).toBeUndefined();
  });

  gated("the vendor's SYNCHRONOUS refusal writes the phonesupp shadow, and the next send skips the vendor entirely — uniformly", async () => {
    const deps = freshDeps();
    const number = freshNumber();
    const acct = await mkAcct(deps);
    deps.setNextSmsOutcome('suppressed');
    const first = await phoneRequestCodeRoute(
      post(acct.token, { phone: number, class: 'phone' }),
      deps,
    );
    expect(first.statusCode).toBe(200);
    expect(deps.smsSent).toHaveLength(1);
    const hash = identifierClaimHash(TEST_KID, number);
    expect(
      await db.isIdentifierSuppressed(`phonesupp#v1#${hash}`, Math.floor(deps.now() / 1000)),
    ).toBe(true);
    // The phone TTL pin is CONSUMED by the store (it was
    // declared and read by nothing): the raw shadow row carries exactly
    // now + PHONE_SUPPRESSION_TTL_SECONDS, read off the key's class prefix.
    const shadowRow = await rawRow(SERVER_TABLES.users, { userId: `phonesupp#v1#${hash}` });
    expect(shadowRow?.kind).toBe('phoneSuppression');
    expect(shadowRow?.expiresAt).toBe(
      Math.floor(deps.now() / 1000) + PHONE_SUPPRESSION_TTL_SECONDS,
    );
    // The next request never reaches the seam, and the answer is the same.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(await phoneRequestCodeRoute(post(acct.token, { phone: number, class: 'phone' }), deps)).toEqual(
      first,
    );
    expect(deps.smsSent).toHaveLength(1);
  });
});

describe('PER-CLASS UNLINK, both directions raw-equal', () => {
  gated('with one email + one phone attached, the PHONE unlink leaves the email claim row, its consent attribute, and the group email ref RAW-EQUAL — and the mirror case mirrors — while the LAST class unlink fires the lazy-solo reap', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    const email = `perclass-${RUN}@example.com`;
    const number = freshNumber();
    await attachEmail(deps, acct, email);
    await attachPhone(deps, acct, number);
    const groupId = (await db.getUserById(acct.userId))!.groupId!;
    canaries.add(groupId);
    const emailKey = activeEmailClaimKeys(KEYS, email)[0]!;
    const phoneKey = activePhoneClaimKeys(KEYS, number)[0]!;
    // Consent ON for BOTH claims, so survival of the consent attribute is
    // demonstrable (it lives ON the claim row).
    expect(await db.setIdentifierDiscoverable(emailKey, groupId, acct.userId, true)).toBe('set');
    expect(await db.setIdentifierDiscoverable(phoneKey, groupId, acct.userId, true)).toBe('set');

    // DIRECTION 1: phone unlink — the email side survives raw-equal.
    const emailRowBefore = await rawRow(SERVER_TABLES.users, { userId: emailKey });
    expect(emailRowBefore?.discoverable).toBe(true);
    expect((await phoneUnlinkRoute(post(acct.token, {}), deps)).statusCode).toBe(200);
    expect(await rawRow(SERVER_TABLES.users, { userId: phoneKey })).toBeUndefined();
    const emailRowAfter = await rawRow(SERVER_TABLES.users, { userId: emailKey });
    expect(emailRowAfter).toEqual(emailRowBefore);
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([emailKey]);
    // A second phone unlink has nothing to remove: collapsed.
    expectRefused(await phoneUnlinkRoute(post(acct.token, {}), deps));

    // MIRROR: re-attach the phone, then EMAIL unlink — the phone side
    // survives raw-equal.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    await attachPhone(deps, acct, number);
    expect(await db.setIdentifierDiscoverable(phoneKey, groupId, acct.userId, true)).toBe('set');
    const phoneRowBefore = await rawRow(SERVER_TABLES.users, { userId: phoneKey });
    expect(phoneRowBefore?.discoverable).toBe(true);
    expect((await emailUnlinkRoute(post(acct.token, {}), deps)).statusCode).toBe(200);
    expect(await rawRow(SERVER_TABLES.users, { userId: emailKey })).toBeUndefined();
    const phoneRowAfter = await rawRow(SERVER_TABLES.users, { userId: phoneKey });
    expect(phoneRowAfter).toEqual(phoneRowBefore);
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([phoneKey]);
    // The group SURVIVED both single-class unlinks (the remainder was never
    // empty) — the lazy-solo reap did NOT fire early.
    expect((await db.getUserById(acct.userId))?.groupId).toBe(groupId);

    // THE LAST CLASS's unlink on the lazy-solo founder fires the row-29(b)
    // reap: group row gone, founder back to never-opted-in.
    expect((await phoneUnlinkRoute(post(acct.token, {}), deps)).statusCode).toBe(200);
    expect(await db.getAccountGroup(groupId)).toBeUndefined();
    expect((await db.getUserById(acct.userId))?.groupId).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: phoneKey })).toBeUndefined();
  });
});

describe('refusal-uniformity and log-canary sweeps (the error paths, then the sinks)', () => {
  gated('every collapsed refusal observed in this suite is ONE byte-stream (status, headers, body)', async () => {
    expect(refusals.length).toBeGreaterThan(3);
    const canonical = accountsRefusal();
    for (const res of refusals) {
      expect(res.statusCode).toBe(canonical.statusCode);
      expect(res.headers).toEqual(canonical.headers);
      expect(res.body).toBe(canonical.body);
    }
  });

  gated('the captured log sink across every flow holds NEITHER the canary number NOR any member ULID', async () => {
    let lines = 0;
    for (const sink of allLogs) {
      for (const entry of sink) {
        lines++;
        const line = JSON.stringify(entry);
        expect(line.includes('+1555'), line).toBe(false);
        expect(line.includes(CANARY_PHONE.slice(1)), line).toBe(false);
        for (const id of canaries) {
          expect(line.includes(id), `${entry.event} leaked ${id}`).toBe(false);
        }
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});

describe('feature#accounts-phone flag row — the REAL store read', () => {
  // The master flag has exactly this suite (accounts-group.test.ts): the
  // real row driven absent/true/malformed/deleted through the real
  // TestOnlyDataLayer. The phone flag — the dark gate, the class kill switch, AND
  // the completion dominance check — had only closures: bind its read to
  // the WRONG key constant (the copy-paste slip this suite exists to catch)
  // and the phone train silently enables itself on the email-v1 master
  // flip, with every closure-driven suite still green. This suite reads the
  // row for real, and proves the two flags are distinct keys with distinct
  // reads. The `feature#accounts-phone` row is a store-wide singleton no
  // OTHER suite writes (they all inject closures), so there is no
  // parallel-file race to flake on.
  gated('absent = OFF, operator-written {enabled: true} = ON, malformed = OFF, deleted = OFF — on the REAL DynamoDB row', async () => {
    await doc.send(
      new DeleteCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: ACCOUNTS_PHONE_FEATURE_FLAG_KEY },
      }),
    );
    expect(await realDb.isAccountsPhoneFeatureEnabled()).toBe(false);

    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: ACCOUNTS_PHONE_FEATURE_FLAG_KEY, enabled: true },
      }),
    );
    expect(await realDb.isAccountsPhoneFeatureEnabled()).toBe(true);

    // Malformed rows fail CLOSED — the master flag's exact discipline.
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: ACCOUNTS_PHONE_FEATURE_FLAG_KEY, enabled: 'yes' },
      }),
    );
    expect(await realDb.isAccountsPhoneFeatureEnabled()).toBe(false);

    await doc.send(
      new DeleteCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: ACCOUNTS_PHONE_FEATURE_FLAG_KEY },
      }),
    );
    expect(await realDb.isAccountsPhoneFeatureEnabled()).toBe(false);
  });

  gated('the two flags are DISTINCT keys — the copy-paste miswiring surface, pinned (the MASTER row is deliberately untouched here: accounts-group.test.ts owns that singleton, and two suites toggling it in parallel would race)', async () => {
    expect(ACCOUNTS_PHONE_FEATURE_FLAG_KEY).toBe('feature#accounts-phone');
    expect(ACCOUNTS_PHONE_FEATURE_FLAG_KEY).not.toBe(ACCOUNTS_FEATURE_FLAG_KEY);
    // Unaddressable as a user, like every feature# row.
    expect(isClaimKey(ACCOUNTS_PHONE_FEATURE_FLAG_KEY)).toBe(true);
    expect(await realDb.getUserById(ACCOUNTS_PHONE_FEATURE_FLAG_KEY)).toBeUndefined();
    // The slip itself needs no master-row write to catch: were
    // isAccountsPhoneFeatureEnabled bound to ACCOUNTS_FEATURE_FLAG_KEY, the
    // real-row case above would already fail both ways (a `{enabled: true}`
    // written at the PHONE key would read false; its delete would change
    // nothing) — the row-keyed round-trip IS the wiring proof.
  });
});
