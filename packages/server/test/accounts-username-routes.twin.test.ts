import { beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  IdentifierStateResponse,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TAKEN_STATUS,
  normalizeUsernameIdentifier,
  usernameSkeleton,
  type LinkOfferInitResponse,
} from '@tacendum/shared';
import { USERNAME_CLAIM_KEY_PREFIX, type UsernameTombstoneRecord } from '../src/db/data.js';
import { activeNameskelClaimKeys, activeUsernameClaimKeys } from '../src/opaque-ref.js';
import type { RateLimiter } from '../src/ratelimit.js';
import { accountsRefusal, linkOfferInitRoute } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
} from '../src/handlers/discovery.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
} from '../src/handlers/identifiers.js';
import {
  identifierStateRoute,
  usernameClaimRoute,
  usernameRefusal,
  usernameRenameRoute,
  usernameTaken,
  usernameUnlinkRoute,
} from '../src/handlers/username.js';
import type { Handler, HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * THE FOUNDER REPORT'S SERVER RULES, IN THE PROJECT CI RUNS (the 2026-10-08
 * gate pass; vitest.config.ts' own rule, TOOLCHAIN-CORRECTNESS-1): every
 * pin below also stands in accounts-username-routes.test.ts,
 * accounts-discovery-budget.test.ts and accounts-link.test.ts — all three
 * on the `heavy` list, which runs on a developer's machine and nowhere
 * else. A mutation that deleted the /claim guard, the state route's roster
 * check, the link init's class-mismatch refusal, the group age anchor or
 * the member-held take-back passed CI green. This is the store-blind half
 * of each, over `makeMemoryDb` and the REAL route handlers — the
 * accounts-link.twin / accounts-discovery-self.twin pattern. The twin may
 * never drift more permissive than the store (helpers.ts), and the heavy
 * suites prove the store; this file proves the HANDLERS, where every one
 * of these rules lives.
 */

// Digits only (valid Crockford base32); '83' is this file's discriminator.
const RUN = `${Date.now()}83`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');
let nameSeq = 0;
function family(): (base: string) => string {
  const tag = `${SUFFIX}${'abcdefghij'[nameSeq % 10]}${'abcdefghij'[Math.floor(nameSeq / 10) % 10]}`;
  nameSeq += 1;
  return (base) => `${base}${tag}`;
}

const TEST_KID = 'test-identifier-hmac-key';
const KEYS = [{ version: 1, key: TEST_KID }];

type Db = ReturnType<typeof makeMemoryDb>;
type TwinDeps = TestDeps & { takes: string[]; refuse: Set<string> };
interface Acct {
  userId: string;
  token: string;
}

/** Deps with the limiter instrumented: every take's bucket is recorded and
 * `refuse` forces one bucket's refusal (the routes suite's shape). */
function freshDeps(db: Db): TwinDeps {
  const deps = makeTestDeps(db) as TwinDeps;
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    sourceIp: '127.0.0.1',
  };
}
function get(token: string | undefined): HttpEvent {
  return {
    method: 'GET',
    path: '/',
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    sourceIp: '127.0.0.1',
  };
}

async function mkAcct(db: Db, deps: TestDeps): Promise<Acct> {
  const userId = uid();
  expect((await db.getOrCreateUserByIdentityKey(`idkey-twin-${userId}`, userId, deps.now())).kind).toBe('ok');
  const token = `twin-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 400 * 86_400,
  });
  return { userId, token };
}

/** A verified email through the REAL attach routes, under the caller's
 * roster class (`phone` for a solo founder; a grouped caller's declared
 * class must be the roster's own). */
async function attachEmail(deps: TestDeps, acct: Acct, email: string, cls: 'phone' | 'tablet' = 'phone'): Promise<void> {
  expect((await emailRequestCodeRoute(post(acct.token, { email, class: cls }), deps)).statusCode).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
}

async function verifiedAcct(db: Db, deps: TestDeps): Promise<Acct & { groupId: string }> {
  const acct = await mkAcct(db, deps);
  await attachEmail(deps, acct, `${acct.userId}@example.test`);
  return { ...acct, groupId: (await db.getUserById(acct.userId))!.groupId! };
}

/** A sibling joined into `holder`'s group through the data layer's join
 * branch at the group's current epoch — the linked iPad with no local
 * identifier row of its own. */
async function linkSibling(db: Db, deps: TestDeps, holder: Acct & { groupId: string }): Promise<Acct> {
  const sibling = await mkAcct(db, deps);
  const group = (await db.getAccountGroup(holder.groupId))!;
  const offerNonce = `nonce-twin-${RUN}-${++seq}`;
  const nowS = Math.floor(deps.now() / 1000);
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId: holder.groupId,
      offererUserId: holder.userId,
      acceptorUserId: sibling.userId,
      acceptorClass: 'tablet',
      rosterEpoch: group.epoch,
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
  expect((await db.getUserById(sibling.userId))?.groupId).toBe(holder.groupId);
  return sibling;
}

function keysFor(name: string) {
  const normalized = normalizeUsernameIdentifier(name);
  return {
    claimKeys: activeUsernameClaimKeys(KEYS, normalized),
    skeletonKeys: activeNameskelClaimKeys(KEYS, usernameSkeleton(normalized)),
  };
}

function claim(deps: TestDeps, acct: Acct, username: string, discoverable = true, route: Handler = usernameClaimRoute): Promise<HttpResult> {
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
}

const takesOf = (deps: TwinDeps, prefix: string): string[] => deps.takes.filter((b) => b.startsWith(prefix));
const eventsOf = (deps: TestDeps, event: string): number => deps.logs.filter((l) => l.event === event).length;

async function readState(deps: TestDeps, acct: Acct): Promise<IdentifierStateResponse> {
  const res = await identifierStateRoute(get(acct.token), deps);
  expect(res.statusCode).toBe(200);
  return IdentifierStateResponse.parse(JSON.parse(res.body!));
}

let db: Db;
beforeEach(() => {
  db = makeMemoryDb();
  db.setAccountsFeatureEnabled(true);
  db.setAccountsUsernameFeatureEnabled(true);
});

describe('the /claim spelling never renames (U1, 2026-10-08) — the memory twin', () => {
  it('a sibling\'s /claim of another name on a holding group, the held name through /claim from the sibling and from the holder: the frozen refusal BEFORE the budgets — only idroute drawn, nothing admitted, no transaction; /rename still renames; /rename on a claimless group claims', async () => {
    const deps = freshDeps(db);
    const f = family();
    const a = await verifiedAcct(db, deps);
    const s = await linkSibling(db, deps, a);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
    const aliceKey = keysFor(f('alice')).claimKeys[0]!;
    const admitted = eventsOf(deps, 'username_claim_admitted');
    const unameclaim = takesOf(deps, 'unameclaim').length;

    for (const [who, name] of [
      [s, f('zed')],
      [s, f('alice')],
      [a, f('alice')],
      [a, f('zed')],
    ] as const) {
      const takesBefore = deps.takes.length;
      expectFrozen(await claim(deps, who, name));
      // Exactly one bucket drawn: the caller's route budget.
      expect(deps.takes.slice(takesBefore)).toEqual([`idroute:${who.userId}`]);
    }
    expect(eventsOf(deps, 'username_claim_admitted')).toBe(admitted);
    expect(takesOf(deps, 'unameclaim')).toHaveLength(unameclaim);
    const group = (await db.getAccountGroup(a.groupId))!;
    expect(group.identifierRefs).toContain(aliceKey);
    expect(group.usernameRenamedAt).toBeUndefined();
    expect(await db.getUsernameClaim(keysFor(f('zed')).claimKeys[0]!, Math.floor(deps.now() / 1000))).toBeUndefined();

    // /rename is the explicit intent: it renames (the sibling too).
    expect((await claim(deps, s, f('zed'), true, usernameRenameRoute)).statusCode).toBe(200);
    expect((await db.getAccountGroup(a.groupId))!.identifierRefs).toContain(keysFor(f('zed')).claimKeys[0]);
    // ...and on a claimless group it still claims.
    deps.advanceMs(USERNAME_RENAME_COOLDOWN_SECONDS * 1000);
    expect((await usernameUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);
    deps.advanceMs(USERNAME_RENAME_COOLDOWN_SECONDS * 1000);
    expect((await claim(deps, a, f('bob'), true, usernameRenameRoute)).statusCode).toBe(200);
    expect((await db.getAccountGroup(a.groupId))!.identifierRefs).toContain(keysFor(f('bob')).claimKeys[0]);
  });
});

describe('GET /v1/identifiers/state — the memory twin', () => {
  it('a sibling reads the group\'s facts (holdsUsername, the live rows\' stamps, the consent bit); the window ends in seconds and is null at exactly 30 d; only idstate is drawn; a stale pointer\'s non-member reads all false; flag-dark is the collapsed refusal', async () => {
    const deps = freshDeps(db);
    const f = family();
    const a = await verifiedAcct(db, deps);
    const emailSince = Math.floor(deps.now() / 1000);
    const s = await linkSibling(db, deps, a);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect(await readState(deps, s)).toEqual({
      hasVerifiedIdentifier: true,
      emailLinked: true,
      phoneLinked: false,
      holdsUsername: false,
      usernameCooldownUntil: null,
      usernameSince: null,
      emailSince,
      usernameFindable: null,
      emailFindable: false,
    });
    expect((await claim(deps, a, f('alice'), false)).statusCode).toBe(200);
    const aliceSince = Math.floor(deps.now() / 1000);
    expect(await readState(deps, s)).toMatchObject({
      holdsUsername: true,
      usernameCooldownUntil: null,
      usernameSince: aliceSince,
      usernameFindable: false,
    });
    // A rename stamps the window and moves the name's birth stamp.
    deps.advanceMs(7_000);
    expect((await claim(deps, a, f('bob'), true, usernameRenameRoute)).statusCode).toBe(200);
    const t0 = Math.floor(deps.now() / 1000);
    expect(await readState(deps, s)).toMatchObject({
      usernameCooldownUntil: t0 + USERNAME_RENAME_COOLDOWN_SECONDS,
      usernameSince: t0,
      usernameFindable: true,
    });
    deps.advanceMs(USERNAME_RENAME_COOLDOWN_SECONDS * 1000 - 1000);
    expect((await readState(deps, s)).usernameCooldownUntil).toBe(t0 + USERNAME_RENAME_COOLDOWN_SECONDS);
    deps.advanceMs(1000);
    expect((await readState(deps, s)).usernameCooldownUntil).toBeNull();
    // The bucket: idstate only, never idroute.
    const idrouteBefore = takesOf(deps, `idroute:${s.userId}`).length;
    deps.refuse.add('idroute:');
    expect((await identifierStateRoute(get(s.token), deps)).statusCode).toBe(200);
    deps.refuse.delete('idroute:');
    deps.refuse.add('idstate:');
    expectFrozen(await identifierStateRoute(get(s.token), deps));
    deps.refuse.delete('idstate:');
    expect(takesOf(deps, `idroute:${s.userId}`)).toHaveLength(idrouteBefore);
    // A pointer is not membership: a caller absent from the roster reads
    // nothing of the former group.
    const realGetGroup = deps.db.getAccountGroup.bind(deps.db);
    deps.db.getAccountGroup = async (groupId) => {
      const group = await realGetGroup(groupId);
      return group ? { ...group, members: group.members.filter((m) => m.userId !== s.userId) } : undefined;
    };
    try {
      expect(await readState(deps, s)).toEqual({
        hasVerifiedIdentifier: false,
        emailLinked: false,
        phoneLinked: false,
        holdsUsername: false,
        usernameCooldownUntil: null,
        usernameSince: null,
        emailSince: null,
        usernameFindable: null,
        emailFindable: null,
      });
    } finally {
      deps.db.getAccountGroup = realGetGroup;
    }
    // Flag dark: the collapsed refusal, never a 401 and never the facts.
    db.setAccountsUsernameFeatureEnabled(false);
    expect(await identifierStateRoute(get(s.token), deps)).toEqual(accountsRefusal());
    expect(await identifierStateRoute(get(undefined), deps)).toEqual(accountsRefusal());
    db.setAccountsUsernameFeatureEnabled(true);
    expect((await identifierStateRoute(get(undefined), deps)).statusCode).toBe(401);
  });
});

describe('S1: the 72 h discovery age is the account\'s — the memory twin', () => {
  it('a device linked today into a 10-day-old verified group searches by email at once; a 1 h device in a 1 h group is refused with the uniform miss', async () => {
    const deps = freshDeps(db);
    const owner = await mkAcct(db, deps);
    const email = `s1-target-${RUN}@example.test`;
    await attachEmail(deps, owner, email);
    expect((await setDiscoverableRoute(post(owner.token, { discoverable: true }), deps)).statusCode).toBe(204);
    const lookup = async (who: Acct): Promise<HttpResult> => {
      deps.advanceMs(61_000);
      return discoveryLookupRoute(post(who.token, { email }), deps);
    };
    const phone = await verifiedAcct(db, deps);
    deps.advanceMs(10 * 86_400_000);
    const ipad = await linkSibling(db, deps, phone);
    expect((await lookup(ipad)).statusCode).toBe(200);
    const phone2 = await verifiedAcct(db, deps);
    deps.advanceMs(3_600_000);
    const tablet2 = await linkSibling(db, deps, phone2);
    const young = await lookup(tablet2);
    expect(young).toBe(discoveryRefusal());
    expect(young).toEqual(accountsRefusal());
  });
});

describe('S2 (a): the link INIT leg tolerates the roster\'s own class — the memory twin', () => {
  it('an attach-created founder declaring its roster class is admitted and named its group; a class the roster does not hold is the collapsed refusal', async () => {
    const deps = freshDeps(db);
    const a = await verifiedAcct(db, deps);
    const b = await mkAcct(db, deps);
    const declared = await linkOfferInitRoute(
      post(a.token, { acceptorUserId: b.userId, acceptorClass: 'tablet', offererClass: 'phone' }),
      deps,
    );
    expect(declared.statusCode).toBe(200);
    expect((JSON.parse(declared.body!) as LinkOfferInitResponse).groupId).toBe(a.groupId);
    const c = await mkAcct(db, deps);
    expect(
      await linkOfferInitRoute(
        post(a.token, { acceptorUserId: c.userId, acceptorClass: 'tablet', offererClass: 'tablet' }),
        deps,
      ),
    ).toEqual(accountsRefusal());
    // And the classless init (what the new client sends) is admitted too.
    expect(
      (await linkOfferInitRoute(post(a.token, { acceptorUserId: c.userId, acceptorClass: 'tablet' }), deps))
        .statusCode,
    ).toBe(200);
  });
});

describe('S3: the take-back survives the dissolving unlink, and so does the window — the memory twin', () => {
  it('after the name leaves as the LAST identifier the tombstone names the member, a stranger gets the 409, the solo device reads the carried window, the fresh group inherits it (a different name frozen) and the own name comes back', async () => {
    const deps = freshDeps(db);
    const f = family();
    const nowS = (): number => Math.floor(deps.now() / 1000);
    const a = await verifiedAcct(db, deps);
    deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);
    expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
    const aliceKey = keysFor(f('alice')).claimKeys[0]!;
    deps.advanceMs(7_000);
    expect((await emailUnlinkRoute(post(a.token, undefined), deps)).statusCode).toBe(200);
    deps.advanceMs(7_000);
    expect((await usernameUnlinkRoute(post(a.token, {}), deps)).statusCode).toBe(200);
    const unlinkedAt = nowS();
    expect(await db.getAccountGroup(a.groupId)).toBeUndefined();
    const tomb = (await db.getUsernameClaim(aliceKey, nowS())) as UsernameTombstoneRecord;
    expect(tomb.formerUserId).toBe(a.userId);
    expect(tomb.formerGroupId).toBeUndefined();
    expect((await db.getUserById(a.userId))!.usernameRenamedAt).toBe(unlinkedAt);
    expect((await readState(deps, a)).usernameCooldownUntil).toBe(unlinkedAt + USERNAME_RENAME_COOLDOWN_SECONDS);
    const c = await verifiedAcct(db, deps);
    deps.advanceMs(7_000);
    expectTaken(await claim(deps, c, f('alice')));
    deps.advanceMs(60_000);
    await attachEmail(deps, a, `${a.userId}-again@example.test`);
    const newGroupId = (await db.getUserById(a.userId))!.groupId!;
    expect(newGroupId).not.toBe(a.groupId);
    expect((await db.getAccountGroup(newGroupId))!.usernameRenamedAt).toBe(unlinkedAt);
    deps.advanceMs(7_000);
    expectFrozen(await claim(deps, a, f('bob')));
    expect((await claim(deps, a, f('alice'))).statusCode).toBe(200);
    expect((await db.getAccountGroup(newGroupId))!.identifierRefs.some((r) => r.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toBe(true);
    const live = await db.getUsernameClaim(aliceKey, nowS());
    expect(live && 'groupId' in live ? live.groupId : undefined).toBe(newGroupId);
  });
});
