import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  DiscoveryLookupRequest,
  TABLES,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  normalizePhoneIdentifier,
  normalizeUsernameIdentifier,
  usernameSkeleton,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  EMAIL_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
  type IdentifierClaimRecord,
} from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  activeNameskelClaimKeys,
  activePhoneClaimKeys,
  activeUsernameClaimKeys,
  type IdentifierHmacKey,
} from '../src/opaque-ref.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
  setPhoneDiscoverableRoute,
  setUsernameDiscoverableRoute,
} from '../src/handlers/discovery.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneVerifyRoute,
} from '../src/handlers/identifiers.js';
import { usernameClaimRoute, usernameUnlinkRoute } from '../src/handlers/username.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import type { RateLimiter } from '../src/ratelimit.js';
import { makeMemoryDb, makeTestDeps, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Discovery-by-USERNAME: the three-way-oracle
 * discipline applied to the THIRD identifier class, over the memory twin
 * AND DynamoDB Local (the two-TestOnlyDataLayer shape: one scenario list, two
 * stores, so the twin can never drift more permissive than the store), with
 * the own edges driven by name:
 *
 * - the parallel-field wire's third field (the previous
 * {email}/{phone} fixture, RE-CUT DELIBERATELY, replays byte-identically
 * with the username flag ABSENT, and the response bytes equal the
 * previous fixture's: the response DTO is untouched by the username feature);
 * - the username oracle: miss, non-consented, and LIVE-TOMBSTONE answer the
 * ONE frozen object; only a consented live claim resolves to the
 * minimum; an ELAPSED tombstone reads as a miss and frees the name;
 * - THE POSSESSION-CLASS PIN (load-bearing): a username-only group
 * cannot search — it is refused at the gate before any lookup budget is
 * spent — while it can still BE FOUND;
 * - per-class consent, cross-class uniformity, the shared budgets (one
 * burst window and one fleet ceiling across three classes), the
 * class-keyed FLAT flag read, the two-tier kill switch, and the rotation
 * walk with positive-branch-only forward-migration of BOTH rows.
 *
 * Every deadline — the 72 h age, the 30-day tombstone — runs under the deps
 * clock, ADVANCED with `deps.advanceMs` (the frozen-clock landmine on
 * record). Names are unique per run and per case (DynamoDB Local persists
 * across runs). The flags are process-local closures with ON as the
 * default; the real-row drives are the flag-gate suite's.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

// Digits only (valid Crockford base32); '76' is this file's discriminator.
const RUN = `${Date.now()}76`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
/** The run's letter suffix: digits → a..j, inside USERNAME_STRICT. */
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');
let nameSeq = 0;
/** A per-case name family (`alice` → `alice<run><case>`); confusable
 * siblings are derived by substituting in the BASE (`al1ce`). */
function family(): (base: string) => string {
  const tag = `${SUFFIX}${'abcdefghij'[nameSeq % 10]}${'abcdefghij'[Math.floor(nameSeq / 10) % 10]}`;
  nameSeq += 1;
  return (base) => `${base}${tag}`;
}

/** Per-run NANP numbers (+1555 + 7 digits, inside the allowlist);
 * this FILE's fixed first local digit is '5' — disjoint from every other
 * suite's block by construction (the collision lesson).
 *
 * The base is a random draw, NOT the clock (the accounts-phone.test.ts
 * lesson): `RUN.slice(-5)` was only Date.now mod 1 000 beside the fixed
 * '76' — a one-second cycle — while the `phonehash#` claim rows the
 * DynamoDB Local half mints persist for as long as the container lives, so
 * a later run landing on the same clock digits met a PERSISTED claim at a
 * number it believed fresh. Every issued number is recorded (the memory
 * twin's too — a Delete of a row that was never written is a no-op) so
 * `afterAll` can delete its claim rows under both key versions. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 1_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+15555${`${(NUMBER_BASE + ++numSeq) % 1_000_000}`.padStart(6, '0')}`;
  issuedNumbers.push(number);
  return number;
}

const TEST_KID = 'test-identifier-hmac-key';
const V1: IdentifierHmacKey[] = [{ version: 1, key: TEST_KID }];
/** A rotation window: v2 newest, v1 retiring. */
const V12: IdentifierHmacKey[] = [{ version: 2, key: 'test-identifier-hmac-key-v2' }, ...V1];

/** Everything the field-free log discipline forbids, collected as it is minted:
 * names, skeletons, claim keys, ULIDs, groupIds, numbers, addresses. */
const canaries = new Set<string>();
const allLogs: LogEntry[][] = [];
const refusals: HttpResult[] = [];

interface Store {
  db: TestOnlyDataLayer;
  setMaster(on: boolean): void;
  setPhone(on: boolean): void;
  setUsername(on: boolean): void;
}

interface Acct {
  userId: string;
  token: string;
}

/** Deps with the rate limiter INSTRUMENTED (the routes-suite seam):
 * every take's bucket key is recorded, and `refuse` forces one bucket's
 * refusal without spending 2,000 takes. */
type SuiteDeps = TestDeps & { takes: string[]; refuse: Set<string> };
function freshDeps(db: TestOnlyDataLayer): SuiteDeps {
  const deps = makeTestDeps(db) as SuiteDeps;
  allLogs.push(deps.logs);
  const inner: RateLimiter = deps.rateLimit;
  deps.takes = [];
  deps.refuse = new Set();
  deps.rateLimit = {
    take: async (bucket, opts) => {
      deps.takes.push(bucket);
      for (const prefix of deps.refuse) if (bucket.startsWith(prefix)) return 60;
      return inner.take(bucket, opts);
    },
  };
  return deps;
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

async function mkAcct(db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct> {
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(`idkey-ud-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `ud-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    // The tombstone case advances the clock past 30 days; sessions must outlive it.
    expiresAt: Math.floor(deps.now() / 1000) + 400 * 86_400,
  });
  return { userId, token };
}

async function attachEmail(db: TestOnlyDataLayer, deps: TestDeps, acct: Acct, email: string): Promise<string> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  canaries.add(groupId);
  return activeEmailClaimKeys(V1, email)[0]!;
}

async function attachPhone(db: TestOnlyDataLayer, deps: TestDeps, acct: Acct, number: string): Promise<string> {
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
  return activePhoneClaimKeys(V1, normalizePhoneIdentifier(number))[0]!;
}

/** A grouped, email-verified account — a claimant and, once aged, a
 * gate-passing lookup caller. */
async function verifiedAcct(db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct & { groupId: string }> {
  const acct = await mkAcct(db, deps);
  await attachEmail(db, deps, acct, `${acct.userId}@example.test`);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  return { ...acct, groupId };
}

/** The handler's candidate keys for one name under one key set, every one
 * of them a canary (and their bare hashes, through the sweep below). */
function keysFor(name: string, keys: readonly IdentifierHmacKey[] = V1) {
  const normalized = normalizeUsernameIdentifier(name);
  const skeleton = usernameSkeleton(normalized);
  canaries.add(normalized);
  canaries.add(skeleton);
  const claimKeys = activeUsernameClaimKeys(keys, normalized);
  const skeletonKeys = activeNameskelClaimKeys(keys, skeleton);
  for (const k of [...claimKeys, ...skeletonKeys]) canaries.add(k);
  return { normalized, claimKeys, skeletonKeys };
}

/** A username claimed through the REAL claim route. */
async function claimName(
  deps: TestDeps,
  acct: Acct,
  username: string,
  discoverable: boolean,
): Promise<HttpResult> {
  keysFor(username);
  return usernameClaimRoute(post(acct.token, { username, discoverable }), deps);
}

type LookupBody = { email: string } | { phone: string } | { username: string };

async function lookup(deps: TestDeps, token: string, body: LookupBody): Promise<HttpResult> {
  // Roll the burst window first (the accounts-discovery helper discipline);
  // the cross-class burst drive is its own case below.
  deps.advanceMs(61_000);
  return discoveryLookupRoute(post(token, body), deps);
}

function expectUniform(res: HttpResult): void {
  refusals.push(res);
  // Reference identity — the frozen single-exit object (the discipline):
  // a username-classed refusal that minted its own answer cannot return it.
  expect(res).toBe(discoveryRefusal());
  expect(res).toEqual(accountsRefusal());
}

const eventsOf = (deps: TestDeps, event: string): LogEntry[] =>
  deps.logs.filter((l) => l.event === event);
const takesOf = (deps: SuiteDeps, prefix: string): string[] =>
  deps.takes.filter((b) => b.startsWith(prefix));

/**
 * THE SCENARIO LIST, over either TestOnlyDataLayer.
 */
function discoverySuite(
  label: string,
  getStore: () => Store,
  gated: (name: string, fn: () => Promise<void>) => void,
): void {
  describe(`${label}: discovery-by-username (advancing clock)`, () => {
    const on = (): Store => {
      const store = getStore();
      store.setMaster(true);
      store.setPhone(true);
      store.setUsername(true);
      return store;
    };

    /** A gate-passing username caller: possession proof, with no age wait. */
    const mkCaller = async (db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct & { groupId: string }> => {
      return verifiedAcct(db, deps);
    };

    gated('a newly verified account can resolve a consented username immediately while fresh email and phone lookups retain the age gate', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await verifiedAcct(db, deps);
      const target = await verifiedAcct(db, deps);
      const targetEmail = `${target.userId}@example.test`;
      const targetNumber = freshNumber();
      await attachPhone(db, deps, target, targetNumber);
      expect((await claimName(deps, target, f('fresh'), true)).statusCode).toBe(200);
      expect((await setDiscoverableRoute(post(target.token, { discoverable: true }), deps)).statusCode).toBe(204);
      expect((await setPhoneDiscoverableRoute(post(target.token, { discoverable: true }), deps)).statusCode).toBe(204);

      expect((await lookup(deps, caller.token, { username: `  ${f('fresh').toUpperCase()}  ` })).statusCode).toBe(200);
      expectUniform(await lookup(deps, caller.token, { email: targetEmail }));
      expectUniform(await lookup(deps, caller.token, { phone: targetNumber }));
    });

    gated('THE USERNAME ORACLE (uniform refusals): {miss, registered-not-discoverable, LIVE TOMBSTONE} answer ONE byte-stream and ONE object; only a consented live claim resolves to the minimum with NO name byte; consent OFF is immediate; the former owner reclaims through the tombstone; an ELAPSED tombstone reads as a miss, is reaped, and frees the name', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      // Owners, aged with the caller (the claim gate).
      const ndOwner = await verifiedAcct(db, deps);
      const dOwner = await verifiedAcct(db, deps);
      const tOwner = await verifiedAcct(db, deps);
      const stranger = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

      // (b) held, consent OFF — the explicit consent-at-claim bit, asserted
      // on the raw row (the structural default is OFF; only the write sets it).
      expect((await claimName(deps, ndOwner, f('nd'), false)).statusCode).toBe(200);
      const ndKey = keysFor(f('nd')).claimKeys[0]!;
      expect(
        ((await db.getUsernameClaim(ndKey, Math.floor(deps.now() / 1000))) as IdentifierClaimRecord)
          .discoverable,
      ).toBe(false);
      // (c) held, consent ON at claim.
      expect((await claimName(deps, dOwner, f('disc'), true)).statusCode).toBe(200);
      // (d) claimed consented, then UNLINKED: a live tombstone for 30 days.
      expect((await claimName(deps, tOwner, f('tomb'), true)).statusCode).toBe(200);
      expect((await usernameUnlinkRoute(post(tOwner.token, {}), deps)).statusCode).toBe(200);
      const tombKey = keysFor(f('tomb')).claimKeys[0]!;
      const tombRow = await db.getUsernameClaim(tombKey, Math.floor(deps.now() / 1000));
      expect((tombRow as { tombstoned?: boolean } | undefined)?.tombstoned).toBe(true);

      // (a) vs (b) vs (d): reference identity through the ONE frozen exit,
      // then pairwise bytes — the tombstone is NON-CONSENTED, nothing more.
      const miss = await lookup(deps, caller.token, { username: f('miss') });
      const nonConsented = await lookup(deps, caller.token, { username: f('nd') });
      const tombstoned = await lookup(deps, caller.token, { username: f('tomb') });
      for (const res of [miss, nonConsented, tombstoned]) expectUniform(res);
      for (const a of [miss, nonConsented, tombstoned]) {
        for (const b of [miss, nonConsented, tombstoned]) {
          expect(a.statusCode).toBe(b.statusCode);
          expect(a.body).toBe(b.body);
          expect(a.headers).toEqual(b.headers);
        }
      }
      // The refusal branches never migrate, never write: the tombstone is
      // still the tombstone after being read (its reap is the ELAPSED case).
      expect(
        ((await db.getUsernameClaim(tombKey, Math.floor(deps.now() / 1000))) as { tombstoned?: boolean })
          .tombstoned,
      ).toBe(true);

      // (c) resolves — EXACTLY the minimum, and the RAW spelling the
      // caller typed normalizes to the same row: no name byte, no skeleton
      // byte, no groupId in the answer (pointer never proof; no echo).
      const typed = `  ${f('disc').toUpperCase()} `;
      const hit = await lookup(deps, caller.token, { username: typed });
      expect(hit.statusCode).toBe(200);
      const body = JSON.parse(hit.body!) as {
        members: Array<{ userId: string; class: string }>;
        rosterVersion: number;
      };
      expect(Object.keys(body).sort()).toEqual(['members', 'rosterVersion']);
      expect(body.members).toEqual([{ userId: dOwner.userId, class: 'phone' }]);
      expect(body.rosterVersion).toBe(1);
      expect(hit.body!.includes(dOwner.groupId)).toBe(false);
      expect(hit.body!.toLowerCase().includes(f('disc'))).toBe(false);
      expect(hit.body!.includes(usernameSkeleton(f('disc')))).toBe(false);

      // THE THIRD ADMITTED COUNTER: every admitted USERNAME probe —
      // miss, non-consented, tombstoned, and hit alike — emitted the
      // field-free `discovery_lookup_admitted_username`, and NEVER either
      // possession class's counter (the caller's attach flow performs no
      // lookup, so the split is exact).
      const admitted = eventsOf(deps, 'discovery_lookup_admitted_username');
      expect(admitted.length).toBe(4);
      for (const entry of admitted) expect(entry.fields).toEqual({});
      expect(eventsOf(deps, 'discovery_lookup_admitted').length).toBe(0);
      expect(eventsOf(deps, 'discovery_lookup_admitted_phone').length).toBe(0);

      // Consent OFF through the per-class toggle: IMMEDIATELY unresolvable —
      // the strong read, no cache — and the same one object as the miss;
      // ON again restores.
      expect(
        (await setUsernameDiscoverableRoute(post(dOwner.token, { discoverable: false }), deps))
          .statusCode,
      ).toBe(204);
      expectUniform(await lookup(deps, caller.token, { username: f('disc') }));
      expect(
        (await setUsernameDiscoverableRoute(post(dOwner.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);
      expect((await lookup(deps, caller.token, { username: f('disc') })).statusCode).toBe(200);

      // THE FORMER OWNER RECLAIMS through the tombstone and the name
      // resolves again — to the same group.
      deps.advanceMs(7_000);
      expect((await claimName(deps, tOwner, f('tomb'), true)).statusCode).toBe(200);
      const reclaimed = await lookup(deps, caller.token, { username: f('tomb') });
      expect(reclaimed.statusCode).toBe(200);
      expect((JSON.parse(reclaimed.body!) as { members: Array<{ userId: string }> }).members).toEqual([
        { userId: tOwner.userId, class: 'phone' },
      ]);
      // Unlink again: tombstone reborn, held for 30 days − 1 s (the lookup
      // helper's own 61 s burst roll is part of the arithmetic — the probe
      // lands at freesAt − 1 s exactly)…
      deps.advanceMs(7_000);
      expect((await usernameUnlinkRoute(post(tOwner.token, {}), deps)).statusCode).toBe(200);
      const t0 = deps.now();
      deps.advanceMs(USERNAME_TOMBSTONE_TTL_SECONDS * 1000 - 1000 - 61_000);
      expectUniform(await lookup(deps, caller.token, { username: f('tomb') }));
      expect(deps.now()).toBe(t0 + USERNAME_TOMBSTONE_TTL_SECONDS * 1000 - 1000);
      expect(
        ((await db.getUsernameClaim(tombKey, Math.floor(deps.now() / 1000))) as { tombstoned?: boolean })
          .tombstoned,
      ).toBe(true);
      // …and at exactly freesAt the lookup is a plain miss (same bytes),
      // the read REAPED the tombstone, and a stranger's claim lands — the
      // namespace moved on, and the lookup follows it.
      deps.advanceMs(t0 + USERNAME_TOMBSTONE_TTL_SECONDS * 1000 - 61_000 - deps.now());
      expectUniform(await lookup(deps, caller.token, { username: f('tomb') }));
      expect(deps.now()).toBe(t0 + USERNAME_TOMBSTONE_TTL_SECONDS * 1000);
      expect(await db.getUsernameClaim(tombKey, Math.floor(deps.now() / 1000))).toBeUndefined();
      deps.advanceMs(7_000);
      expect((await claimName(deps, stranger, f('tomb'), true)).statusCode).toBe(200);
      const moved = await lookup(deps, caller.token, { username: f('tomb') });
      expect(moved.statusCode).toBe(200);
      expect((JSON.parse(moved.body!) as { members: Array<{ userId: string }> }).members).toEqual([
        { userId: stranger.userId, class: 'phone' },
      ]);
    });

    gated('PER-CLASS consent, driven BOTH ways on ONE group holding an email AND a username: email-ON + username-OFF refuses the username lookup while the email lookup resolves — and the mirror case mirrors', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      // ONE group holding its verified email (the per-class slot is one —
      // `verifiedAcct` already filled it) AND a username.
      const owner = await verifiedAcct(db, deps);
      const email = `${owner.userId}@example.test`;
      const emailKey = activeEmailClaimKeys(V1, email)[0]!;
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, owner, f('both'), false)).statusCode).toBe(200);
      const nameKey = keysFor(f('both')).claimKeys[0]!;
      const nowS = (): number => Math.floor(deps.now() / 1000);

      // Direction 1: EMAIL consent ON, username untouched (OFF at claim).
      expect(
        (await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      expect((await db.getIdentifierClaim(emailKey))?.discoverable).toBe(true);
      expect(((await db.getUsernameClaim(nameKey, nowS())) as IdentifierClaimRecord).discoverable).toBe(false);
      expect((await lookup(deps, caller.token, { email })).statusCode).toBe(200);
      expectUniform(await lookup(deps, caller.token, { username: f('both') }));

      // Direction 2 (the mirror): email OFF, USERNAME ON.
      expect(
        (await setDiscoverableRoute(post(owner.token, { discoverable: false }), deps)).statusCode,
      ).toBe(204);
      expect(
        (await setUsernameDiscoverableRoute(post(owner.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);
      expect((await db.getIdentifierClaim(emailKey))?.discoverable).toBe(false);
      expect(((await db.getUsernameClaim(nameKey, nowS())) as IdentifierClaimRecord).discoverable).toBe(true);
      expect((await lookup(deps, caller.token, { username: f('both') })).statusCode).toBe(200);
      expectUniform(await lookup(deps, caller.token, { email }));
    });

    gated('CROSS-CLASS uniformity: username miss / non-consented / tombstoned, email miss / non-consented, and phone miss / non-consented answer pairwise byte-identical — which field the caller populated teaches nothing', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      const ndEmailOwner = await mkAcct(db, deps);
      const ndEmail = `xc-nd-${RUN}@example.com`;
      await attachEmail(db, deps, ndEmailOwner, ndEmail);
      const ndPhoneOwner = await mkAcct(db, deps);
      const ndNumber = freshNumber();
      await attachPhone(db, deps, ndPhoneOwner, ndNumber);
      const ndNameOwner = await verifiedAcct(db, deps);
      const tombNameOwner = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, ndNameOwner, f('xcnd'), false)).statusCode).toBe(200);
      expect((await claimName(deps, tombNameOwner, f('xctomb'), true)).statusCode).toBe(200);
      expect((await usernameUnlinkRoute(post(tombNameOwner.token, {}), deps)).statusCode).toBe(200);

      const answers = [
        await lookup(deps, caller.token, { username: f('xcmiss') }),
        await lookup(deps, caller.token, { username: f('xcnd') }),
        await lookup(deps, caller.token, { username: f('xctomb') }),
        await lookup(deps, caller.token, { email: `xc-miss-${RUN}@example.com` }),
        await lookup(deps, caller.token, { email: ndEmail }),
        await lookup(deps, caller.token, { phone: freshNumber() }),
        await lookup(deps, caller.token, { phone: ndNumber }),
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

    gated('THE POSSESSION-CLASS PIN (load-bearing): a group whose ONLY identifier is a username is REFUSED at the caller gate for every class — before any lookup budget is spent, with nothing admitted — while its name still resolves for a gate-passing caller; re-attaching a possession proof re-admits it', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      // Consented targets in all three classes.
      const target = await verifiedAcct(db, deps);
      const targetEmail = `${target.userId}@example.test`;
      const targetNumber = freshNumber();
      await attachPhone(db, deps, target, targetNumber);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, target, f('target'), true)).statusCode).toBe(200);
      expect(
        (await setDiscoverableRoute(post(target.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      expect(
        (await setPhoneDiscoverableRoute(post(target.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);

      // X: verified, aged, claims a name (consented) — then SHEDS its email.
      // The per-class unlink leaves the name standing and the group alive
      // with exactly one ref: the username. By construction the only way a
      // username-only group can exist.
      const x = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, x, f('xonly'), true)).statusCode).toBe(200);
      expect((await emailUnlinkRoute(post(x.token, {}), deps)).statusCode).toBe(200);
      const xGroup = await db.getAccountGroup(x.groupId);
      expect(xGroup).toBeDefined();
      expect(xGroup!.identifierRefs).toHaveLength(1);
      expect(xGroup!.identifierRefs[0]!.startsWith(USERNAME_CLAIM_KEY_PREFIX)).toBe(true);
      expect((await db.getUserById(x.userId))!.groupId).toBe(x.groupId);

      // X cannot SEARCH — any class — and the refusal is the frozen object.
      // The gate sits before the daily, user, and fleet windows: none was
      // charged, nothing was admitted (only the per-device burst brake,
      // which precedes the gate by design, saw the probes).
      const mark = deps.takes.length;
      expectUniform(await lookup(deps, x.token, { username: f('target') }));
      expectUniform(await lookup(deps, x.token, { email: targetEmail }));
      expectUniform(await lookup(deps, x.token, { phone: targetNumber }));
      const spent = deps.takes.slice(mark);
      expect(spent.filter((k) => k.startsWith('discburst:'))).toHaveLength(3);
      expect(spent.filter((k) => k.startsWith('disc:'))).toEqual([]);
      expect(spent.filter((k) => k.startsWith('discuser:'))).toEqual([]);
      expect(spent.filter((k) => k === 'disc-fleet')).toEqual([]);
      for (const event of [
        'discovery_lookup_admitted',
        'discovery_lookup_admitted_phone',
        'discovery_lookup_admitted_username',
      ]) {
        expect(eventsOf(deps, event).length, event).toBe(0);
      }

      // …but X can still BE FOUND (holding a name qualifies you to be
      // found, never to search).
      const found = await lookup(deps, caller.token, { username: f('xonly') });
      expect(found.statusCode).toBe(200);
      expect((JSON.parse(found.body!) as { members: Array<{ userId: string }> }).members).toEqual([
        { userId: x.userId, class: 'phone' },
      ]);

      // A possession proof re-attached (a fresh email, same group — the
      // username ref made the group survive) re-admits X at the gate.
      await attachEmail(db, deps, x, `x-again-${RUN}@example.com`);
      expect((await db.getUserById(x.userId))!.groupId).toBe(x.groupId);
      expect((await lookup(deps, x.token, { username: f('target') })).statusCode).toBe(200);
      expect((await lookup(deps, x.token, { email: targetEmail })).statusCode).toBe(200);
      expect((await lookup(deps, x.token, { phone: targetNumber })).statusCode).toBe(200);
    });

    gated('the SHARED budgets (never doubled): ONE burst window across three classes (the class-free `discburst:` key), and the ONE `disc-fleet` ceiling — a username probe over the cap fails closed with the field-free scrape event and is NOT counted as admitted username volume', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      const target = await verifiedAcct(db, deps);
      const targetEmail = `${target.userId}@example.test`;
      const targetNumber = freshNumber();
      await attachPhone(db, deps, target, targetNumber);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, target, f('shared'), true)).statusCode).toBe(200);
      expect(
        (await setDiscoverableRoute(post(target.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      expect(
        (await setPhoneDiscoverableRoute(post(target.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);

      // Five admitted inside ONE minute, mixed classes; the sixth — a
      // USERNAME probe — refuses uniform; the seventh — email — too.
      deps.advanceMs(61_000);
      const mark = deps.takes.length;
      const bodies: LookupBody[] = [
        { email: targetEmail },
        { username: f('shared') },
        { phone: targetNumber },
        { username: f('shared') },
        { email: targetEmail },
      ];
      for (const [i, body] of bodies.entries()) {
        expect(
          (await discoveryLookupRoute(post(caller.token, body), deps)).statusCode,
          `burst lookup ${i + 1}`,
        ).toBe(200);
      }
      expectUniform(await discoveryLookupRoute(post(caller.token, { username: f('shared') }), deps));
      expectUniform(await discoveryLookupRoute(post(caller.token, { email: targetEmail }), deps));
      const burstKeys = deps.takes.slice(mark).filter((k) => k.startsWith('discburst:'));
      expect(burstKeys).toHaveLength(7);
      expect(new Set(burstKeys)).toEqual(new Set([`discburst:${caller.userId}`]));
      // And a 61 s roll re-admits the username class: it WAS the burst.
      expect((await lookup(deps, caller.token, { username: f('shared') })).statusCode).toBe(200);
      // The daily windows were charged on the SAME group/user keys the
      // possession classes charge — no username-classed window exists.
      const dailyKeys = new Set(deps.takes.slice(mark).filter((k) => k.startsWith('disc:') || k.startsWith('discuser:')));
      expect(dailyKeys).toEqual(new Set([`disc:${caller.groupId}`, `discuser:${caller.userId}`]));

      // The fleet ceiling: forced over-cap on the ONE `disc-fleet` window —
      // the username probe fails closed in the frozen shape, the field-free
      // scrape event fires, the username admitted counter does NOT move.
      const admittedBefore = eventsOf(deps, 'discovery_lookup_admitted_username').length;
      deps.refuse.add('disc-fleet');
      expectUniform(await lookup(deps, caller.token, { username: f('shared') }));
      deps.refuse.delete('disc-fleet');
      const scrape = eventsOf(deps, 'discovery_lookup_fleet_refused');
      expect(scrape).toHaveLength(1);
      expect(scrape[0]!.fields).toEqual({});
      expect(eventsOf(deps, 'discovery_lookup_admitted_username').length).toBe(admittedBefore);
      expect(takesOf(deps, 'disc-fleet').length).toBeGreaterThan(0);
    });

    gated('the class-flag read is CLASS-KEYED and FLAT (third class): exactly ONE username-flag read per username-classed lookup — miss, non-consented, tombstoned, and HIT alike — ZERO for any email- or phone-classed lookup, and ZERO phone-flag reads on the username path', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      const ndOwner = await verifiedAcct(db, deps);
      const dOwner = await verifiedAcct(db, deps);
      const tOwner = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, ndOwner, f('fnd'), false)).statusCode).toBe(200);
      expect((await claimName(deps, dOwner, f('fd'), true)).statusCode).toBe(200);
      expect((await claimName(deps, tOwner, f('ft'), true)).statusCode).toBe(200);
      expect((await usernameUnlinkRoute(post(tOwner.token, {}), deps)).statusCode).toBe(200);
      const emailOwner = await mkAcct(db, deps);
      const email = `flagreads-${RUN}@example.com`;
      await attachEmail(db, deps, emailOwner, email);
      expect(
        (await setDiscoverableRoute(post(emailOwner.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);
      const phoneOwner = await mkAcct(db, deps);
      const number = freshNumber();
      await attachPhone(db, deps, phoneOwner, number);
      expect(
        (await setPhoneDiscoverableRoute(post(phoneOwner.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);

      let usernameReads = 0;
      let phoneReads = 0;
      const counting: TestDeps = {
        ...deps,
        db: {
          ...db,
          isAccountsPhoneFeatureEnabled: async () => {
            phoneReads++;
            return db.isAccountsPhoneFeatureEnabled();
          },
          isAccountsUsernameFeatureEnabled: async () => {
            usernameReads++;
            return db.isAccountsUsernameFeatureEnabled();
          },
        },
      };
      const probe = async (body: LookupBody): Promise<HttpResult> => {
        deps.advanceMs(61_000);
        return discoveryLookupRoute(post(caller.token, body), counting);
      };
      expectUniform(await probe({ username: f('fmiss') }));
      expect(usernameReads).toBe(1); // miss: one read
      expectUniform(await probe({ username: f('fnd') }));
      expect(usernameReads).toBe(2); // non-consented: one read
      expectUniform(await probe({ username: f('ft') }));
      expect(usernameReads).toBe(3); // tombstoned: one read — never a second
      expect((await probe({ username: f('fd') })).statusCode).toBe(200);
      expect(usernameReads).toBe(4); // the POSITIVE branch pays the same one
      expect(phoneReads).toBe(0); // the username path never consults the phone flag

      expectUniform(await probe({ email: `flagreads-miss-${RUN}@example.com` }));
      expect((await probe({ email })).statusCode).toBe(200);
      expectUniform(await probe({ phone: freshNumber() }));
      expect((await probe({ phone: number })).statusCode).toBe(200);
      expect(usernameReads).toBe(4); // email and phone lookups: zero username-flag reads
      expect(phoneReads).toBe(2); // the phone class's own flat read, unchanged
    });

    gated('THE TWO-TIER KILL SWITCH: feature#accounts-username OFF collapses the username class ALONE while email and phone resolution stay live — the dark class spends NOTHING — master OFF collapses all three; restoring restores all three', async () => {
      const store = on();
      const { db } = store;
      const deps = freshDeps(db);
      const f = family();
      const caller = await mkCaller(db, deps);
      const target = await verifiedAcct(db, deps);
      const targetEmail = `${target.userId}@example.test`;
      const targetNumber = freshNumber();
      await attachPhone(db, deps, target, targetNumber);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(deps, target, f('kill'), true)).statusCode).toBe(200);
      expect(
        (await setDiscoverableRoute(post(target.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      expect(
        (await setPhoneDiscoverableRoute(post(target.token, { discoverable: true }), deps))
          .statusCode,
      ).toBe(204);

      // All flags on: all three classes resolve.
      expect((await lookup(deps, caller.token, { email: targetEmail })).statusCode).toBe(200);
      expect((await lookup(deps, caller.token, { phone: targetNumber })).statusCode).toBe(200);
      expect((await lookup(deps, caller.token, { username: f('kill') })).statusCode).toBe(200);

      // ONE operator delete of the username sub-flag: the class collapses
      // through the handler's own frozen exit while both possession classes
      // keep resolving on the same route in the same process.
      store.setUsername(false);
      expectUniform(await lookup(deps, caller.token, { username: f('kill') }));
      expect((await lookup(deps, caller.token, { email: targetEmail })).statusCode).toBe(200);
      expect((await lookup(deps, caller.token, { phone: targetNumber })).statusCode).toBe(200);

      // THE DARK CLASS SPENDS NOTHING (third
      // class): five flag-OFF username probes inside ONE minute — no clock
      // motion, no bucket take of ANY kind, nothing admitted — and an email
      // lookup in the SAME minute still resolves.
      deps.advanceMs(61_000);
      const mark = deps.takes.length;
      for (let i = 0; i < 5; i++) {
        expectUniform(await discoveryLookupRoute(post(caller.token, { username: f('kill') }), deps));
      }
      expect(deps.takes.slice(mark)).toEqual([]);
      expect(eventsOf(deps, 'discovery_lookup_admitted_username').length).toBe(1);
      expect(
        (await discoveryLookupRoute(post(caller.token, { email: targetEmail }), deps)).statusCode,
      ).toBe(200);

      // Master OFF collapses ALL THREE (wrapper-level; bytes deep-equal the
      // program collapse), regardless of the sub-flags.
      store.setUsername(true);
      store.setMaster(false);
      const dark: HttpResult[] = [];
      for (const body of [
        { email: targetEmail },
        { phone: targetNumber },
        { username: f('kill') },
      ] as LookupBody[]) {
        deps.advanceMs(61_000);
        dark.push(await discoveryLookupRoute(post(caller.token, body), deps));
      }
      refusals.push(...dark);
      for (const res of dark) expect(res).toEqual(accountsRefusal());

      // Restored: all three resolve again.
      store.setMaster(true);
      expect((await lookup(deps, caller.token, { email: targetEmail })).statusCode).toBe(200);
      expect((await lookup(deps, caller.token, { phone: targetNumber })).statusCode).toBe(200);
      expect((await lookup(deps, caller.token, { username: f('kill') })).statusCode).toBe(200);
    });

    gated('the username rotation walk (class-blind site): a rotation-window lookup resolves under the ≤2-version walk and forward-migrates the claim AND its skeleton row on the POSITIVE branch ONLY — the dormant non-consented row stays put', async () => {
      const { db } = on();
      const f = family();
      // Stand the claims up under v1 alone (pre-rotation).
      const depsV1 = freshDeps(db);
      const migOwner = await verifiedAcct(db, depsV1);
      const dormantOwner = await verifiedAcct(db, depsV1);
      depsV1.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claimName(depsV1, migOwner, f('mig'), true)).statusCode).toBe(200);
      expect((await claimName(depsV1, dormantOwner, f('dormant'), false)).statusCode).toBe(200);
      const migV1 = keysFor(f('mig'), V1);
      const dormantV1 = keysFor(f('dormant'), V1);

      // The fleet rotates: v2 newest, v1 retiring — a caller minted under it.
      const depsRot = freshDeps(db);
      depsRot.identifierHmac = { keys: V12 };
      const caller = await mkCaller(db, depsRot);
      const nowS = (): number => Math.floor(depsRot.now() / 1000);

      // POSITIVE: resolves through the walk AND migrates BOTH rows — the v2
      // claim row born carrying the v2 skeleton key, the group ref
      // re-pointed, the v1 claim row gone; keeps resolving at version 0.
      const hit = await lookup(depsRot, caller.token, { username: f('mig') });
      expect(hit.statusCode).toBe(200);
      const migV12 = keysFor(f('mig'), V12);
      const v2Row = (await db.getUsernameClaim(migV12.claimKeys[0]!, nowS())) as IdentifierClaimRecord;
      expect(v2Row?.groupId).toBe(migOwner.groupId);
      expect(v2Row?.skeletonKey).toBe(migV12.skeletonKeys[0]);
      expect(await db.getUsernameClaim(migV1.claimKeys[0]!, nowS())).toBeUndefined();
      expect(
        (await db.getAccountGroup(migOwner.groupId))!.identifierRefs.filter((ref) =>
          ref.startsWith(USERNAME_CLAIM_KEY_PREFIX),
        ),
      ).toEqual([migV12.claimKeys[0]]);
      expect((await lookup(depsRot, caller.token, { username: f('mig') })).statusCode).toBe(200);
      // The skeleton moved WITH the claim: a confusable squat of the name
      // under the rotated fleet is `taken` on the v2 skeleton row.
      const squatter = await verifiedAcct(db, depsRot);
      depsRot.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      const squat = f('mig').replace('mig', 'm1g');
      keysFor(squat, V12);
      expect(
        (await usernameClaimRoute(post(squatter.token, { username: squat, discoverable: true }), depsRot))
          .statusCode,
      ).toBe(409);

      // The NON-CONSENTED internal hit does NOT migrate (refusal uniformity outranks
      // migration opportunism): the dormant v1 rows survive untouched, no
      // v2 shadow is born.
      expectUniform(await lookup(depsRot, caller.token, { username: f('dormant') }));
      expect(
        ((await db.getUsernameClaim(dormantV1.claimKeys[0]!, nowS())) as IdentifierClaimRecord)?.groupId,
      ).toBe(dormantOwner.groupId);
      const dormantV12 = keysFor(f('dormant'), V12);
      expect(await db.getUsernameClaim(dormantV12.claimKeys[0]!, nowS())).toBeUndefined();
    });
  });
}

// --- The memory twin: unconditional. ---
let memDb: ReturnType<typeof makeMemoryDb>;
beforeAll(() => {
  memDb = makeMemoryDb();
});
discoverySuite(
  'memory twin',
  () => ({
    db: memDb,
    setMaster: (on) => memDb.setAccountsFeatureEnabled(on),
    setPhone: (on) => memDb.setAccountsPhoneFeatureEnabled(on),
    setUsername: (on) => memDb.setAccountsUsernameFeatureEnabled(on),
  }),
  (name, fn) => it(name, fn),
);

// --- DynamoDB Local: gated exactly as the accounts-* suites gate. ---
let doc: DynamoDBDocumentClient;
let ddb: TestOnlyDataLayer;
let available = false;
let flagOn = true;
let phoneFlagOn = true;
let usernameFlagOn = true;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  ddb = {
    ...base,
    isAccountsFeatureEnabled: async () => flagOn,
    isAccountsPhoneFeatureEnabled: async () => phoneFlagOn,
    isAccountsUsernameFeatureEnabled: async () => usernameFlagOn,
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
// at one of its fresh numbers is deleted, whatever the case's outcome, under
// both key versions of the rotation window (V12 ⊇ V1), so no later run — or
// sibling suite — meets a stale claim at a number it believes fresh. Only
// the rows THIS run's numbers address.
afterAll(async () => {
  if (!available) return;
  for (const number of issuedNumbers) {
    for (const claimKey of activePhoneClaimKeys(V12, number)) {
      await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }));
    }
  }
});

function gatedDdb(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

discoverySuite(
  'DynamoDB Local',
  () => ({
    db: ddb,
    setMaster: (on) => {
      flagOn = on;
    },
    setPhone: (on) => {
      phoneFlagOn = on;
    },
    setUsername: (on) => {
      usernameFlagOn = on;
    },
  }),
  gatedDdb,
);

// --- The wire and the replay (memory twin, deterministic). ---
const here = dirname(fileURLToPath(import.meta.url));
type Leg = { body: string; parsed: unknown; response: { statusCode: number; body: string } };
const uh3Fixture = JSON.parse(
  readFileSync(join(here, 'discovery-wire-pre-uh3.fixture.json'), 'utf8'),
) as { email: { hit: Leg; miss: Leg }; phone: { hit: Leg; miss: Leg } };
const acp2Fixture = JSON.parse(
  readFileSync(join(here, 'discovery-wire-pre-acp2.fixture.json'), 'utf8'),
) as { hit: Leg; miss: Leg };

describe('THE PARALLEL-FIELD WIRE, third field (the previous replay fixture RE-CUT DELIBERATELY)', () => {
  it('the CAPTURED previous {email} and {phone} bodies parse to the IDENTICAL objects under the one-of-three schema; {username} parses alone; every two-or-three-field, neither-field, and batch shape is malformed', () => {
    for (const leg of [uh3Fixture.email.hit, uh3Fixture.email.miss, uh3Fixture.phone.hit, uh3Fixture.phone.miss]) {
      const parsed = DiscoveryLookupRequest.parse(JSON.parse(leg.body));
      expect(parsed).toEqual(leg.parsed);
      expect('username' in parsed).toBe(false);
    }
    expect(DiscoveryLookupRequest.safeParse({ username: 'alice' }).success).toBe(true);
    for (const bad of [
      { email: 'a@b.co', username: 'alice' },
      { phone: '+15558675309', username: 'alice' },
      { email: 'a@b.co', phone: '+15558675309', username: 'alice' },
      {},
      { username: 'alice', usernames: ['alice'] },
    ]) {
      expect(DiscoveryLookupRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the TRANSCRIBED previous {email} and {phone} flows replay byte-identically through the handler — hit AND miss, both classes — with the username flag entirely ABSENT and never read; and the RESPONSE bytes are byte-identical to the previous fixture (the response DTO is untouched by the username feature: no echo, the class constant unchanged)', async () => {
    const mem = makeMemoryDb();
    mem.setAccountsFeatureEnabled(true);
    mem.setAccountsPhoneFeatureEnabled(true);
    mem.setAccountsUsernameFeatureEnabled(false); // ABSENT: neither possession path may consult it
    let usernameFlagReads = 0;
    const db: TestOnlyDataLayer = {
      ...mem,
      isAccountsUsernameFeatureEnabled: async () => {
        usernameFlagReads++;
        return false;
      },
    };
    const deps = makeTestDeps(db);
    const mk = async (userId: string, n: number): Promise<Acct> => {
      const token = `capture-token-${n}`;
      await mem.createUser({ userId, createdAt: deps.now(), identityKeyPub: `idkey-${userId}` });
      await mem.createSession({
        token,
        userId,
        createdAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 365 * 86400,
      });
      return { userId, token };
    };
    const emailOwner = await mk('01CAPTUREOWNER0000000000A1', 1);
    const phoneOwner = await mk('01CAPTUREPHONEOWNER00000A1', 2);
    const caller = await mk('01CAPTURECALLER000000000A1', 3);
    const attach = async (acct: Acct, email: string): Promise<void> => {
      expect(
        (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps))
          .statusCode,
      ).toBe(200);
      const code = deps.emailsSent.at(-1)!.code;
      expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
    };
    await attach(emailOwner, 'capture.owner@example.com');
    expect(
      (await setDiscoverableRoute(post(emailOwner.token, { discoverable: true }), deps)).statusCode,
    ).toBe(204);
    const number = (JSON.parse(uh3Fixture.phone.hit.body) as { phone: string }).phone;
    expect(
      (await phoneRequestCodeRoute(post(phoneOwner.token, { phone: number, class: 'phone' }), deps))
        .statusCode,
    ).toBe(200);
    const smsCode = deps.smsSent.at(-1)!.code;
    expect(
      (await phoneVerifyRoute(post(phoneOwner.token, { phone: number, code: smsCode }), deps))
        .statusCode,
    ).toBe(200);
    expect(
      (await setPhoneDiscoverableRoute(post(phoneOwner.token, { discoverable: true }), deps))
        .statusCode,
    ).toBe(204);
    await attach(caller, 'capture.caller@example.com');
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

    for (const leg of [uh3Fixture.email.hit, uh3Fixture.email.miss, uh3Fixture.phone.hit, uh3Fixture.phone.miss]) {
      deps.advanceMs(61_000);
      const res = await discoveryLookupRoute(post(caller.token, JSON.parse(leg.body)), deps);
      expect(res.statusCode, leg.body).toBe(leg.response.statusCode);
      expect(res.body, leg.body).toBe(leg.response.body);
    }
    expect(usernameFlagReads).toBe(0);

    // Byte-identical to the previous fixture: the email legs' captured responses ARE
    // the previous fixture's responses, and the phone hit differs from the
    // email hit ONLY in the seeded member ULID — no new field, no echo.
    expect(uh3Fixture.email.hit.response).toEqual(acp2Fixture.hit.response);
    expect(uh3Fixture.email.miss.response).toEqual(acp2Fixture.miss.response);
    expect(uh3Fixture.phone.miss.response).toEqual(acp2Fixture.miss.response);
    expect(uh3Fixture.phone.hit.response.body).toBe(
      acp2Fixture.hit.response.body.replace('01CAPTUREOWNER0000000000A1', '01CAPTUREPHONEOWNER00000A1'),
    );
  });
});

describe('the alarm twins (lookup lane; unameclaim-fleet) — the phone twin shape (the CDK synth pins live in the deployment stack)', () => {
  it('the handler counts the username class on its OWN field-free event and gates the caller on POSSESSION classes only (source pins beside the driven cases)', () => {
    const src = readFileSync(new URL('../src/handlers/discovery.ts', import.meta.url), 'utf8');
    expect(src).toContain("'discovery_lookup_admitted_username'");
    // The landed `identifierRefs.length === 0` gate is gone: the caller
    // gate counts EMAIL and PHONE refs and nothing else.
    expect(src.includes('identifierRefs.length === 0')).toBe(false);
    expect(src).toMatch(/classRefs\(callerGroup\.identifierRefs, EMAIL_CLAIM_KEY_PREFIX\)/);
    expect(src).toMatch(/classRefs\(callerGroup\.identifierRefs, PHONE_CLAIM_KEY_PREFIX\)/);
    // The lookup reads the username class through its tombstone-aware read.
    expect(src).toContain('deps.db.getUsernameClaim(claimKey, nowSeconds)');
    // Still the ONE read-time rule, no re-derivation.
    expect(src.includes('.discoverable ===')).toBe(false);
    expect(src.includes('.tombstoned ===')).toBe(false);
  });
});

describe('refusal-uniformity and log-canary sweeps (every refusal, then the sinks)', () => {
  it('every uniform refusal observed in this file is ONE byte-stream (status, headers, body)', () => {
    expect(refusals.length).toBeGreaterThan(10);
    const canonical = accountsRefusal();
    for (const res of refusals) {
      expect(res.statusCode).toBe(canonical.statusCode);
      expect(res.headers).toEqual(canonical.headers);
      expect(res.body).toBe(canonical.body);
    }
  });

  it('the log sinks contain NO username, NO skeleton, NO claim key or bare hash, NO address, NO E.164 number or its digits, NO member ULID, and NO groupId — and every admitted counter is field-free', () => {
    expect(canaries.size).toBeGreaterThan(30);
    let lines = 0;
    for (const sink of allLogs) {
      for (const entry of sink) {
        lines++;
        const line = JSON.stringify(entry);
        expect(line.includes('@'), line).toBe(false);
        for (const id of canaries) {
          expect(line.includes(id), `${entry.event} leaked ${id}`).toBe(false);
          if (id.startsWith('+')) {
            expect(line.includes(id.slice(1)), `${entry.event} leaked digits of ${id}`).toBe(false);
          }
          const hash = id.split('#').at(-1);
          if (hash && hash.length > 20) expect(line.includes(hash), `${entry.event} leaked a hash`).toBe(false);
        }
        if (entry.event.startsWith('discovery_lookup_admitted')) expect(entry.fields).toEqual({});
      }
    }
    expect(lines).toBeGreaterThan(0);
    // The possession-class prefix never appears in a retained line either
    // (a claim key would carry it).
    for (const sink of allLogs) {
      expect(JSON.stringify(sink).includes(EMAIL_CLAIM_KEY_PREFIX)).toBe(false);
      expect(JSON.stringify(sink).includes(USERNAME_CLAIM_KEY_PREFIX)).toBe(false);
    }
  });
});
