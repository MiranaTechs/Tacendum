import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  TABLES,
  TABLE_ENV_VARS,
  USERNAME_CLAIMS_PER_ACCOUNT_PER_DAY,
  USERNAME_CLAIM_FLEET_DAILY_CEILING,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TAKEN_BODY,
  USERNAME_TAKEN_STATUS,
  normalizeUsernameIdentifier,
  usernameSkeleton,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import {
  EMAIL_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
  type IdentifierClaimRecord,
} from '../src/db/data.js';
import { activeNameskelClaimKeys, activeUsernameClaimKeys } from '../src/opaque-ref.js';
import { LIMITS, type RateLimiter } from '../src/ratelimit.js';
import { makeDdbRateLimiter } from '../src/ratelimit-ddb.js';
import { accountsRefusal, isAccountsCollapsedRoute } from '../src/handlers/devices.js';
import { emailRequestCodeRoute, emailVerifyRoute } from '../src/handlers/identifiers.js';
import { setUsernameDiscoverableRoute } from '../src/handlers/discovery.js';
import {
  usernameClaimRoute,
  usernameEligibilityRoute,
  usernameRefusal,
  usernameRenameRoute,
  usernameTaken,
  usernameUnlinkRoute,
} from '../src/handlers/username.js';
import { routes as httpDispatch } from '../src/aws/http.lambda.js';
import type { Handler, HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * (part B) — THE ROUTES: the claim gate, the refusal
 * discipline, the budgets, the flag, driven through the REAL wrapped routes
 * against the memory twin AND DynamoDB Local (heavy project; the twin runs
 * unconditionally, the store is gated on :8000 exactly as the accounts-*
 * suites gate — TACENDUM_REQUIRE_DDB=1 turns the skip into a failure). One
 * scenario list, two DataLayers (the accounts-username-claims discipline),
 * so the twin can never drift more permissive than the store.
 *
 * EVERY deadline here — the 72 h age, the 30-day rename cool-down, the
 * 30-day tombstone, the fixed budget windows — runs under the deps clock,
 * ADVANCED with `deps.advanceMs` (the frozen-clock landmine on record).
 *
 * Names are UNIQUE PER RUN AND PER CASE (DynamoDB Local persists across
 * runs): the run digits are spelled into letters the skeleton folds leave
 * alone. Reserved names are the exception — they are refused BEFORE
 * hashing, so nothing about them ever reaches a row.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';
const DAY_MS = 86_400_000;

// Digits only (valid Crockford base32); '74' is this file's discriminator.
const RUN = `${Date.now()}74`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
/** The run's letter suffix: digits → a..j, a charset the skeleton folds
 * leave alone, inside USERNAME_STRICT. */
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');
let nameSeq = 0;
/** A per-case name family (`alice` → `alice<run><case>`): confusable
 * siblings are derived by substituting in the BASE (`al1ce`). */
function family(): (base: string) => string {
  const tag = `${SUFFIX}${'abcdefghij'[nameSeq % 10]}${'abcdefghij'[Math.floor(nameSeq / 10) % 10]}`;
  nameSeq += 1;
  return (base) => `${base}${tag}`;
}

const TEST_KID = 'test-identifier-hmac-key';
const KEYS = [{ version: 1, key: TEST_KID }];

/** Everything the field-free log discipline forbids, collected as it is minted. */
const canaries = new Set<string>();
const allLogs: TestDeps['logs'][] = [];

interface Store {
  db: TestOnlyDataLayer;
  setMaster(on: boolean): void;
  setUsername(on: boolean): void;
}

interface Acct {
  userId: string;
  token: string;
}

/** Deps with the rate limiter INSTRUMENTED: every take's bucket key is
 * recorded, so a case can prove which windows an attempt touched — and
 * `refuse` lets a case force one bucket's refusal without spending 2,000
 * takes. */
type RoutesDeps = TestDeps & { takes: string[]; refuse: Set<string> };
function freshDeps(db: TestOnlyDataLayer): RoutesDeps {
  const deps = makeTestDeps(db) as RoutesDeps;
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
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    sourceIp: '127.0.0.1',
  };
}

async function mkAcct(db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct> {
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(`idkey-un-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `un-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    // The suites advance the clock past 60 days; the session must outlive it.
    expiresAt: Math.floor(deps.now() / 1000) + 400 * 86_400,
  });
  return { userId, token };
}

/** A verified email through the REAL attach routes — the possession
 * proof (the lazy-solo group is born here). */
async function attachEmail(deps: TestDeps, acct: Acct, email: string): Promise<void> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
}

/** A grouped, verified account — the claimant admits. */
async function verifiedAcct(db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct & { groupId: string }> {
  const acct = await mkAcct(db, deps);
  await attachEmail(deps, acct, `${acct.userId}@example.test`);
  const groupId = (await db.getUserById(acct.userId))!.groupId!;
  canaries.add(groupId);
  return { ...acct, groupId };
}

function keysFor(name: string) {
  const normalized = normalizeUsernameIdentifier(name);
  const skeleton = usernameSkeleton(normalized);
  canaries.add(normalized);
  canaries.add(skeleton);
  const claimKeys = activeUsernameClaimKeys(KEYS, normalized);
  const skeletonKeys = activeNameskelClaimKeys(KEYS, skeleton);
  for (const k of [...claimKeys, ...skeletonKeys]) canaries.add(k);
  return { normalized, claimKeys, skeletonKeys };
}

async function claim(
  deps: TestDeps,
  acct: Acct,
  username: string,
  discoverable = true,
  route: Handler = usernameClaimRoute,
): Promise<HttpResult> {
  keysFor(username);
  return route(post(acct.token, { username, discoverable }), deps);
}

function expectFrozen(res: HttpResult): void {
  expect(res).toBe(usernameRefusal());
  expect(res).toEqual(accountsRefusal());
  expect(res.statusCode).toBe(403);
}

function expectTaken(res: HttpResult): void {
  expect(res).toBe(usernameTaken());
  expect(res.statusCode).toBe(USERNAME_TAKEN_STATUS);
  expect(res.body).toBe(USERNAME_TAKEN_BODY);
  expect(res.headers).toEqual({ 'content-type': 'application/json' });
  expect(res).not.toEqual(accountsRefusal());
}

const takesOf = (deps: RoutesDeps, prefix: string): string[] =>
  deps.takes.filter((b) => b.startsWith(prefix));
const eventsOf = (deps: TestDeps, event: string): number =>
  deps.logs.filter((l) => l.event === event).length;

/**
 * THE SCENARIO LIST, over either TestOnlyDataLayer.
 */
function routesSuite(
  label: string,
  getStore: () => Store,
  gated: (name: string, fn: () => Promise<void>) => void,
): void {
  describe(`${label}: the username routes (advancing clock)`, () => {
    const on = (): Store => {
      const store = getStore();
      store.setMaster(true);
      store.setUsername(true);
      return store;
    };

    gated('a newly verified account claims immediately while identifier-less solo and linked callers remain refused before claim budgets', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      // Three callers born at T: a solo device, a ceremony-linked pair with
      // NO identifier (a link ceremony costs nothing an attacker lacks),
      // and one that verifies an email — the possession proof.
      const solo = await mkAcct(db, deps);
      const g1 = await mkAcct(db, deps);
      const g2 = await mkAcct(db, deps);
      const groupId = uid();
      canaries.add(groupId);
      const offerNonce = `nonce-un-${RUN}-${++seq}`;
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
      const verified = await verifiedAcct(db, deps);

      // Freshly verified: possession proof is sufficient; there is no age wait.
      expectFrozen(await claim(deps, solo, f('solo')));
      expectFrozen(await claim(deps, g1, f('grouped')));
      expect((await claim(deps, verified, f('young'))).statusCode).toBe(200);
      expect(takesOf(deps, 'unameclaim:')).toEqual([`unameclaim:${verified.groupId}`]);
      expect(takesOf(deps, 'unameclaim-fleet')).toHaveLength(1);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(1);
      // The row: the claimant's group, the explicit consent bit, no plaintext.
      const { claimKeys } = keysFor(f('young'));
      const row = (await db.getUsernameClaim(claimKeys[0]!, Math.floor(deps.now() / 1000))) as
        | IdentifierClaimRecord
        | undefined;
      expect(row?.groupId).toBe(verified.groupId);
      expect(row?.discoverable).toBe(true);
    });

    gated('caller-owned eligibility is false without possession proof and true for a verified sibling, with no name or reason in the response', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const first = await mkAcct(db, deps);
      const sibling = await mkAcct(db, deps);
      const groupId = uid();
      canaries.add(groupId);
      const offerNonce = `nonce-elig-${RUN}-${++seq}`;
      const nowS = Math.floor(deps.now() / 1000);
      expect(await db.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: first.userId,
        acceptorUserId: sibling.userId,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: nowS + 600,
        offerSig: Buffer.from(`o-${offerNonce}`).toString('base64'),
      })).toBe('created');
      expect(await db.linkDeviceToGroup({
        offerNonce,
        acceptSig: Buffer.from(`a-${offerNonce}`).toString('base64'),
        nowSeconds: nowS,
        linkedAtMs: deps.now(),
      })).toBe('linked');

      const before = await usernameEligibilityRoute(post(sibling.token, undefined), deps);
      expect(before.statusCode).toBe(200);
      expect(JSON.parse(before.body!)).toEqual({ hasVerifiedIdentifier: false });

      await attachEmail(deps, first, `${first.userId}@example.test`);
      const after = await usernameEligibilityRoute(post(sibling.token, undefined), deps);
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.body!)).toEqual({ hasVerifiedIdentifier: true });
      expect(Object.keys(JSON.parse(after.body!))).toEqual(['hasVerifiedIdentifier']);
      expect(takesOf(deps, `idroute:${sibling.userId}`)).toHaveLength(2);
      expect(takesOf(deps, 'unameclaim')).toEqual([]);

      // A user-row pointer is not membership. Simulate an eventual stale
      // groupId by returning the real group with this caller absent from its
      // authoritative roster; no former-group proof may cross that boundary.
      const realGetUser = deps.db.getUserById.bind(deps.db);
      const realGetGroup = deps.db.getAccountGroup.bind(deps.db);
      const consistency: Array<boolean | undefined> = [];
      deps.db.getUserById = async (userId, signal, opts) => {
        consistency.push(opts?.consistent);
        return realGetUser(userId, signal, opts);
      };
      deps.db.getAccountGroup = async (groupId) => {
        const group = await realGetGroup(groupId);
        return group
          ? { ...group, members: group.members.filter((member) => member.userId !== sibling.userId) }
          : undefined;
      };
      try {
        const staleNonmember = await usernameEligibilityRoute(post(sibling.token, undefined), deps);
        expect(staleNonmember.statusCode).toBe(200);
        expect(JSON.parse(staleNonmember.body!)).toEqual({ hasVerifiedIdentifier: false });
        expect(consistency).toEqual([true]);
      } finally {
        deps.db.getUserById = realGetUser;
        deps.db.getAccountGroup = realGetGroup;
      }
      expect(takesOf(deps, `idroute:${sibling.userId}`)).toHaveLength(3);
    });

    gated('THE REFUSAL DISCIPLINE (carve-out): `taken` is the ONE distinguishable answer — one frozen 409 object, byte-pinned — and a live claim, a skeleton conflict, a reserved name (exact and skeleton-vs-skeleton), and a live tombstone all answer it identically; the former owner reclaims through it', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      const b = await verifiedAcct(db, deps);
      const c = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

      expect((await claim(deps, a, f('alice'), false)).statusCode).toBe(200);
      const answers: HttpResult[] = [];
      // Occupancy: the exact row.
      answers.push(await claim(deps, b, f('alice')));
      // The skeleton row: al1ce and a_lice fold onto alice.
      deps.advanceMs(7_000);
      answers.push(await claim(deps, b, f('al1ce')));
      deps.advanceMs(7_000);
      answers.push(await claim(deps, b, f('a_lice')));
      // The denylist: exact, case/whitespace-normalized, and the
      // skeleton-vs-SKELETON match the i→l fold requires.
      for (const reserved of ['admin', ' Tacendum ', 'adm1n', 'm0derator', 'rnirana']) {
        deps.advanceMs(7_000);
        answers.push(await claim(deps, b, reserved));
      }
      // A live tombstone: A unlinks; a stranger is refused for 30 days…
      deps.advanceMs(7_000);
      expect((await usernameUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);
      deps.advanceMs(7_000);
      answers.push(await claim(deps, c, f('alice')));
      answers.push(await claim(deps, c, f('al1ce')));
      for (const res of answers) expectTaken(res);
      expect(new Set(answers).size).toBe(1);
      expect(eventsOf(deps, 'username_claim_taken')).toBe(answers.length);
      // …while the former owner reclaims through the same condition.
      deps.advanceMs(7_000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      // The reserved names never reached the store: no row exists at any
      // of their keys (they were refused BEFORE hashing).
      const nowS = Math.floor(deps.now() / 1000);
      for (const reserved of ['admin', 'tacendum', 'adm1n', 'm0derator', 'rnirana']) {
        expect(await db.getUsernameClaim(keysFor(reserved).claimKeys[0]!, nowS)).toBeUndefined();
      }
      // And the rename spelling of the verb answers the same one bit.
      deps.advanceMs(7_000);
      expectTaken(await claim(deps, b, f('alice'), true, usernameRenameRoute));
    });

    gated('THE AFFIX RULE: an operator/brand word as the first or last `_`-separated segment — exact or by skeleton — answers the same frozen `taken` and reaches no row; an ordinary two-part name still claims', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      const b = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      const affixed = [
        'tacendum_support',
        'mirana_official',
        'admin_alice',
        'security_team',
        'bob_tacendum',
        'adm1n_bob', // the i→l fold: skeleton-vs-skeleton on the segment
        'rnirana_help', // rn→m
        'staff__alice', // a doubled separator is still a separator
      ];
      for (const name of affixed) {
        deps.advanceMs(7_000);
        expectTaken(await claim(deps, a, name));
      }
      const nowS = Math.floor(deps.now() / 1000);
      for (const name of affixed) {
        expect(await db.getUsernameClaim(keysFor(name).claimKeys[0]!, nowS)).toBeUndefined();
      }
      // The rule is affix-shaped, not substring-shaped: an ordinary two-part
      // name, and a name that merely CONTAINS an operator word, both claim.
      deps.advanceMs(7_000);
      expect((await claim(deps, a, f('alice_smith'))).statusCode).toBe(200);
      deps.advanceMs(7_000);
      expect((await claim(deps, b, f('teamster'))).statusCode).toBe(200);
    });

    gated('a MALFORMED body — rider field, missing consent bit, a name outside USERNAME_STRICT, non-JSON — is the frozen refusal and charges NO claim budget (parse before spend)', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      const bodies: unknown[] = [
        { username: f('alice') },
        { username: f('alice'), discoverable: true, extra: 1 },
        { username: f('alice'), discoverable: 'yes' },
        { username: 'ab', discoverable: true },
        { username: '1abc', discoverable: true },
        { username: 'al ice', discoverable: true },
        { username: 'alíce', discoverable: true },
        'not json',
        '',
      ];
      for (const body of bodies) {
        // The 10/min route budget refills one token per 6 s: keep the PARSE
        // the refuser, so the empty-budget assertion below is about spend.
        deps.advanceMs(13_000);
        expectFrozen(await usernameClaimRoute(post(a.token, body), deps));
        expectFrozen(await usernameRenameRoute(post(a.token, body), deps));
      }
      expect(takesOf(deps, 'unameclaim')).toEqual([]);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(0);
      // The unlink verb's pinned emptiness: a rider collapses, the name
      // stays held; the bare and `{}` spellings both unlink.
      deps.advanceMs(60_000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      deps.advanceMs(13_000);
      expectFrozen(await usernameUnlinkRoute(post(a.token, { rider: true }), deps));
      expectFrozen(await usernameUnlinkRoute(post(a.token, 'not json'), deps));
      const held = (await db.getAccountGroup(a.groupId))!.identifierRefs;
      expect(held.some((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toBe(true);
      expect((await usernameUnlinkRoute(post(a.token, undefined), deps)).statusCode).toBe(200);
      // Nothing to remove: the collapsed refusal, as the email/phone twins.
      expectFrozen(await usernameUnlinkRoute(post(a.token, {}), deps));
      // The email survives the per-class unlink by construction.
      const after = (await db.getAccountGroup(a.groupId))!.identifierRefs;
      expect(after.some((ref) => ref.startsWith(EMAIL_CLAIM_KEY_PREFIX))).toBe(true);
      expect(after.some((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toBe(false);
    });

    gated('THE BUDGETS: ten attempts draw the group-scoped `unameclaim:` bucket — never `emailattach:` — and the eleventh is the FROZEN 403, not a 429 and not `taken`; the window refills a day later; rename draws the same bucket; the route budget and the fleet ceiling refuse in the same frozen shape with the field-free counter', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      const b = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      const mark = deps.takes.length;
      for (let n = 1; n <= USERNAME_CLAIMS_PER_ACCOUNT_PER_DAY; n++) {
        // The 10/min route budget refills one token per 6 s; the daily
        // claim window does not move in 7 s (10/86 400 per second).
        deps.advanceMs(7_000);
        expectTaken(await claim(deps, b, f('alice')));
      }
      const spent = deps.takes.slice(mark);
      expect(spent.filter((k) => k === `unameclaim:${b.groupId}`)).toHaveLength(10);
      expect(spent.filter((k) => k === 'unameclaim-fleet')).toHaveLength(10);
      expect(spent.some((k) => k.startsWith('emailattach:'))).toBe(false);
      deps.advanceMs(7_000);
      const eleventh = await claim(deps, b, f('alice'));
      expectFrozen(eleventh);
      expect(eleventh.statusCode).not.toBe(429);
      // Refused at the caller bucket: no fleet token spent, nothing admitted.
      expect(deps.takes.slice(mark).filter((k) => k === 'unameclaim-fleet')).toHaveLength(10);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(11);
      // The window rolls with the clock: a day later the same caller is
      // back to `taken` — the budget refusal was the budget, not the name.
      deps.advanceMs(DAY_MS);
      expectTaken(await claim(deps, b, f('alice')));
      // Rename charges the SAME caller bucket (a's, this time).
      const beforeRename = deps.takes.length;
      expect((await claim(deps, a, f('bob'), true, usernameRenameRoute)).statusCode).toBe(200);
      expect(deps.takes.slice(beforeRename)).toContain(`unameclaim:${a.groupId}`);
      expect(deps.takes.slice(beforeRename)).toContain('unameclaim-fleet');
      // The fleet ceiling: refused in the frozen shape + the counter, and
      // NOT counted as admitted.
      const admitted = eventsOf(deps, 'username_claim_admitted');
      deps.refuse.add('unameclaim-fleet');
      deps.advanceMs(7_000);
      expectFrozen(await claim(deps, b, f('carol')));
      expect(eventsOf(deps, 'username_claim_fleet_refused')).toBe(1);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(admitted);
      deps.refuse.delete('unameclaim-fleet');
      // The caller-keyed ROUTE budget too: this lane never answers 429.
      deps.refuse.add('idroute:');
      expectFrozen(await claim(deps, b, f('carol')));
      expectFrozen(await usernameUnlinkRoute(post(a.token, {}), deps));
      deps.refuse.delete('idroute:');
    });

    gated('RENAME under an ADVANCING clock: the five-item transaction re-points the name, a stranger is refused the old name (tombstone), the cool-down refuses a second rename at 30 d − 1 s and admits it at 30 d (the former-owner reclaim), and a same-name rename is the frozen refusal', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      const c = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      // T0: the rename, through the /rename spelling.
      expect((await claim(deps, a, f('bob'), true, usernameRenameRoute)).statusCode).toBe(200);
      const t0 = deps.now();
      const refs = (await db.getAccountGroup(a.groupId))!.identifierRefs;
      expect(refs.filter((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toEqual([
        keysFor(f('bob')).claimKeys[0],
      ]);
      // A stranger is refused the OLD name: the tombstone holds it for A.
      deps.advanceMs(7_000);
      expectTaken(await claim(deps, c, f('alice')));
      // The cool-down (caller-state, frozen bytes): T0 + 1 d, T0 + 30 d − 1 s.
      deps.advanceMs(DAY_MS);
      expectFrozen(await claim(deps, a, f('alice')));
      deps.advanceMs(t0 + USERNAME_RENAME_COOLDOWN_SECONDS * 1000 - 1000 - deps.now());
      expectFrozen(await claim(deps, a, f('alice')));
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(3);
      // T0 + 30 d exactly: admitted — A takes its old name back through
      // its own tombstone (the former-owner right, at the boundary).
      deps.advanceMs(1000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      // The no-op: renaming to the held name is the frozen refusal and
      // consumes nothing (the cool-down stamp is the previous rename's).
      deps.advanceMs(USERNAME_RENAME_COOLDOWN_SECONDS * 1000);
      expectFrozen(await claim(deps, a, f('alice')));
      expect((await claim(deps, a, f('dave'))).statusCode).toBe(200);
    });

    gated('UNLINK IS A NAME CHANGE (the anti-hoarding rule): after an unlink the claim of ANOTHER name is the frozen refusal for 30 d — budget charged, no transaction, no tombstone minted, the stamp untouched — while the reclaim of the SAME name is admitted at once through the own-tombstone pre-read; at 30 d − 1 s still frozen, at 30 d admitted; a claim never stamps', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      const c = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      const nowS = (): number => Math.floor(deps.now() / 1000);
      const stampOf = async (): Promise<number | undefined> =>
        (await db.getAccountGroup(a.groupId))!.usernameRenamedAt;
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      expect(await stampOf()).toBeUndefined();
      // T0: the unlink stamps the cool-down.
      deps.advanceMs(7_000);
      expect((await usernameUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);
      const t0 = nowS();
      expect(await stampOf()).toBe(t0);
      // The hoard attempt, frozen: an attempt (the caller bucket drawn, the
      // admitted counter fired), never `taken`, nothing minted at `bob`'s
      // keys, the stamp untouched.
      deps.advanceMs(7_000);
      const mark = deps.takes.length;
      const admitted = eventsOf(deps, 'username_claim_admitted');
      expectFrozen(await claim(deps, a, f('bob')));
      expect(deps.takes.slice(mark)).toContain(`unameclaim:${a.groupId}`);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(admitted + 1);
      expect(await db.getUsernameClaim(keysFor(f('bob')).claimKeys[0]!, nowS())).toBeUndefined();
      expect(await stampOf()).toBe(t0);
      // `bob` was free all along — C takes it — so A's refusal was the
      // cool-down, never occupancy.
      deps.advanceMs(7_000);
      expect((await claim(deps, c, f('bob'))).statusCode).toBe(200);
      // The SAME name back: A's own live tombstone admits it at once.
      deps.advanceMs(7_000);
      expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
      expect(await stampOf()).toBe(t0);
      // A rename inside the window is still the cool-down: unlink+reclaim
      // laundered nothing.
      deps.advanceMs(7_000);
      expectFrozen(await claim(deps, a, f('carol'), true, usernameRenameRoute));
      // Unlink again (T1), then 30 d − 1 s: another name still frozen;
      // 30 d exactly: admitted — and the claim leaves the stamp at T1.
      deps.advanceMs(7_000);
      expect((await usernameUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);
      const t1 = nowS();
      expect(await stampOf()).toBe(t1);
      deps.advanceMs(USERNAME_RENAME_COOLDOWN_SECONDS * 1000 - 1000);
      expectFrozen(await claim(deps, a, f('carol')));
      deps.advanceMs(1000);
      expect((await claim(deps, a, f('carol'))).statusCode).toBe(200);
      expect(await stampOf()).toBe(t1);
    });

    gated('THE CONSENT TOGGLE: the claim writes the explicit bit; the per-class toggle flips it both ways with the uniform 204; a malformed toggle collapses; the toggle never implies the email class', async () => {
      const { db } = on();
      const deps = freshDeps(db);
      const f = family();
      const a = await verifiedAcct(db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      expect((await claim(deps, a, f('alice'), false)).statusCode).toBe(200);
      const { claimKeys } = keysFor(f('alice'));
      const read = async (): Promise<IdentifierClaimRecord> =>
        (await db.getUsernameClaim(claimKeys[0]!, Math.floor(deps.now() / 1000))) as IdentifierClaimRecord;
      expect((await read()).discoverable).toBe(false);
      expect(
        (await setUsernameDiscoverableRoute(post(a.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      expect((await read()).discoverable).toBe(true);
      // The email class is untouched by the username toggle.
      const emailRef = (await db.getAccountGroup(a.groupId))!.identifierRefs.find((ref) =>
        ref.startsWith(EMAIL_CLAIM_KEY_PREFIX),
      )!;
      expect((await db.getIdentifierClaim(emailRef))?.discoverable).toBe(false);
      expect(
        (await setUsernameDiscoverableRoute(post(a.token, { discoverable: false }), deps)).statusCode,
      ).toBe(204);
      expect((await read()).discoverable).toBe(false);
      expect(await setUsernameDiscoverableRoute(post(a.token, { discoverable: 'no' }), deps)).toEqual(
        accountsRefusal(),
      );
    });

    gated('THE FLAG: with feature#accounts-username ABSENT (the shipped default) every username route collapses to the frozen bytes — bearer or none, well-formed or garbage — while the master stays live; master OFF collapses them too; the sub-flag deleted after enablement collapses them again (the kill switch)', async () => {
      const store = on();
      const deps = freshDeps(store.db);
      const routes: Array<[string, Handler]> = [
        ['claim', usernameClaimRoute],
        ['rename', usernameRenameRoute],
        ['unlink', usernameUnlinkRoute],
        ['discoverable', setUsernameDiscoverableRoute],
        ['eligibility', usernameEligibilityRoute],
      ];
      const a = await verifiedAcct(store.db, deps);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
      const probes = (token: string | undefined): HttpEvent[] => [
        post(token, { username: 'flagprobe', discoverable: true }),
        post(token, 'not json'),
        post(token, ''),
        post(token, undefined),
      ];
      const collapse = async (why: string): Promise<void> => {
        for (const [name, route] of routes) {
          for (const event of [...probes(a.token), ...probes(undefined)]) {
            const res = await route(event, deps);
            expect(res, `${why}: ${name}`).toEqual(accountsRefusal());
            expect(res.statusCode, `${why}: ${name}`).not.toBe(401);
          }
        }
      };
      store.setUsername(false);
      await collapse('username flag absent, master on');
      // The master is LIVE beside the dark class: an email probe reaches auth.
      expect((await emailRequestCodeRoute(post(undefined, {}), deps)).statusCode).toBe(401);
      store.setMaster(false);
      await collapse('master off');
      store.setUsername(true);
      await collapse('master off, username on');
      // Both on: the gate opens (a bearer-less probe reaches the bearer check).
      store.setMaster(true);
      for (const [name, route] of routes) {
        expect((await route(post(undefined, {}), deps)).statusCode, name).toBe(401);
      }
      // One operator delete of the sub-flag later: dark again.
      store.setUsername(false);
      await collapse('kill switch');
      // Nothing was ever charged or admitted through a dark route.
      expect(takesOf(deps, 'unameclaim')).toEqual([]);
      expect(eventsOf(deps, 'username_claim_admitted')).toBe(0);
    });
  });
}

// --- The memory twin: unconditional. ---
let memDb: ReturnType<typeof makeMemoryDb>;
beforeAll(() => {
  memDb = makeMemoryDb();
});
routesSuite(
  'memory twin',
  () => ({
    db: memDb,
    setMaster: (on) => memDb.setAccountsFeatureEnabled(on),
    setUsername: (on) => memDb.setAccountsUsernameFeatureEnabled(on),
  }),
  (name, fn) => it(name, fn),
);

// --- DynamoDB Local: gated exactly as the accounts-* suites gate. A
// PER-RUN rate-buckets table for the fleet-window case (the
// accounts-discovery-budget pattern): injected-clock rows never rot in the
// shared table. ---
const RATE_TABLE = `tacendum_rate_buckets_uh2_${process.pid}_${randomBytes(4).toString('hex')}`;
const PREV_TABLE_ENV = process.env[TABLE_ENV_VARS.rateBuckets];
let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let ddb: TestOnlyDataLayer;
let available = false;
let flagOn = true;
let usernameFlagOn = true;

beforeAll(async () => {
  client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  ddb = {
    ...base,
    isAccountsFeatureEnabled: async () => flagOn,
    isAccountsUsernameFeatureEnabled: async () => usernameFlagOn,
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
}, 45_000);

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
}, 45_000);

function gatedDdb(name: string, fn: () => Promise<void>, timeoutMs?: number): void {
  it(
    name,
    async (ctx) => {
      if (!available) return ctx.skip();
      await fn();
    },
    timeoutMs,
  );
}

routesSuite(
  'DynamoDB Local',
  () => ({
    db: ddb,
    setMaster: (on) => {
      flagOn = on;
    },
    setUsername: (on) => {
      usernameFlagOn = on;
    },
  }),
  gatedDdb,
);

describe('the fleet ceiling is FLEET-WIDE (two DDB limiter instances, one fixed window)', () => {
  gatedDdb('1,999 tokens spent through container A leave exactly one admitted claim for container B; the next attempt on EITHER container is the frozen refusal with the field-free counter — driven through the real ratelimit-ddb path', async () => {
    flagOn = true;
    usernameFlagOn = true;
    const f = family();
    const depsA = freshDeps(ddb);
    const containerA = makeDdbRateLimiter(doc, () => depsA.now());
    const containerB = makeDdbRateLimiter(doc, () => depsA.now());
    depsA.rateLimit = containerA;
    // Container B: its own limiter AND its own log sink (the deps object's
    // `log` closes over A's array — a spread alone would share it).
    const logsB: TestDeps['logs'] = [];
    const depsB: RoutesDeps = {
      ...depsA,
      rateLimit: containerB,
      logs: logsB,
      log: (event, fields = {}) => logsB.push({ event, fields }),
    };
    allLogs.push(logsB);
    const a = await verifiedAcct(ddb, depsA);
    const b = await verifiedAcct(ddb, depsA);
    depsA.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    // Spend the fleet window down to its last token — from container A,
    // straight against the shared row (each take is one atomic ADD).
    for (let n = 1; n < USERNAME_CLAIM_FLEET_DAILY_CEILING; n++) {
      expect(await containerA.take('unameclaim-fleet', LIMITS.usernameClaimFleet)).toBe(0);
    }
    // The 2,000th admission lands on container B (in-memory accounting
    // would have seen an empty window there).
    expect((await claim(depsB, a, f('alice'))).statusCode).toBe(200);
    // 2,001: refused on EITHER container — the count lives in the window.
    depsA.advanceMs(7_000);
    expectFrozen(await claim(depsA, b, f('bob')));
    expectFrozen(await claim(depsB, b, f('bob')));
    expect(eventsOf(depsA, 'username_claim_fleet_refused')).toBe(1);
    expect(eventsOf(depsB, 'username_claim_fleet_refused')).toBe(1);
    // The window rolls with the clock: a day later the claim lands.
    depsA.advanceMs(DAY_MS);
    expect((await claim(depsB, b, f('bob'))).statusCode).toBe(200);
  }, 240_000); // 1,999 sequential DDB Local UpdateItems: ~22 s alone, past the heavy pool's 60 s under CPU contention.
});

describe('the pins, the route tables, the collapse mark', () => {
  it('Pinned release values, asserted verbatim (never a test shadow)', () => {
    expect(USERNAME_CLAIMS_PER_ACCOUNT_PER_DAY).toBe(10);
    expect(USERNAME_CLAIM_FLEET_DAILY_CEILING).toBe(2000);
    expect(LIMITS.usernameClaim).toEqual({ capacity: 10, refillPerSec: 10 / 86400 });
    expect(LIMITS.usernameClaimFleet).toEqual({ capacity: 2000, refillPerSec: 2000 / 86400 });
    // The caller bucket is the attach pin's size, in its OWN window.
    expect(LIMITS.usernameClaim).toEqual(LIMITS.identifierAttach);
    expect(USERNAME_TAKEN_STATUS).toBe(409);
    expect(USERNAME_TAKEN_BODY).toBe('{"error":"taken"}');
    // Both frozen answers are singletons — reference identity holds.
    expect(usernameTaken()).toBe(usernameTaken());
    expect(usernameRefusal()).toBe(usernameRefusal());
    expect(Object.isFrozen(usernameTaken())).toBe(true);
    expect(Object.isFrozen(usernameRefusal())).toBe(true);
  });

  it('the AWS dispatch table and the local adapter both list all five routes, and every one carries the host-adapter collapse mark', () => {
    const keys = [
      'POST /v1/identifiers/username/claim',
      'POST /v1/identifiers/username/rename',
      'POST /v1/identifiers/username/unlink',
      'POST /v1/identifiers/username/discoverable',
      'GET /v1/identifiers/username/eligibility',
    ];
    for (const key of keys) {
      const route = httpDispatch[key];
      expect(route, key).toBeDefined();
      expect(isAccountsCollapsedRoute(route!), key).toBe(true);
    }
    expect(httpDispatch['POST /v1/identifiers/username/claim']).toBe(usernameClaimRoute);
    expect(httpDispatch['POST /v1/identifiers/username/rename']).toBe(usernameRenameRoute);
    expect(httpDispatch['POST /v1/identifiers/username/unlink']).toBe(usernameUnlinkRoute);
    expect(httpDispatch['POST /v1/identifiers/username/discoverable']).toBe(
      setUsernameDiscoverableRoute,
    );
    expect(httpDispatch['GET /v1/identifiers/username/eligibility']).toBe(
      usernameEligibilityRoute,
    );
    // The local adapter's table is module-private; its source is the census.
    const local = readFileSync(new URL('../src/local/http.ts', import.meta.url), 'utf8');
    for (const key of keys) {
      const pattern = key.slice(key.indexOf(' ') + 1);
      expect(local, key).toContain(`pattern: '${pattern}'`);
    }
  });

});

describe('field-free logging over every log line this file produced', () => {
  it('no name, no skeleton, no claim key, no hash, no ULID, no groupId reached a log line', () => {
    expect(canaries.size).toBeGreaterThan(20);
    for (const logs of allLogs) {
      const stream = JSON.stringify(logs);
      for (const canary of canaries) expect(stream).not.toContain(canary);
      // The hashes ride inside the claim keys; pin their bare form too.
      for (const canary of canaries) {
        const hash = canary.split('#').at(-1);
        if (hash && hash.length > 20) expect(stream).not.toContain(hash);
      }
    }
    // And the field-free counters are exactly that: no fields at all.
    for (const logs of allLogs) {
      for (const entry of logs) {
        if (entry.event.startsWith('username_claim_')) expect(entry.fields).toEqual({});
      }
    }
  });
});
