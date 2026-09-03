import { describe, expect } from 'vitest';
import { DISCOVERY_MIN_ACCOUNT_AGE_SECONDS } from '@tacendum/shared';
import { type TestOnlyDataLayer } from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  activeNameskelClaimKeys,
  activeUsernameClaimKeys,
  type IdentifierHmacKey,
} from '../src/opaque-ref.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  discoveryLookupRoute,
  discoveryRefusal,
  setDiscoverableRoute,
} from '../src/handlers/discovery.js';
import { emailRequestCodeRoute, emailVerifyRoute } from '../src/handlers/identifiers.js';
import { usernameClaimRoute } from '../src/handlers/username.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, type TestDeps } from './helpers.js';
import { usernameSkeleton, normalizeUsernameIdentifier } from '@tacendum/shared';

/**
 * SELF-DISCOVERY IS A MISS (field-reported, device-verified): the lookup
 * used to resolve the CALLER'S OWN identifier — an authenticated user could
 * find their own account by their own attached email or claimed username and
 * start a self-conversation the clients cannot decrypt. The §9 rule-2 shape
 * of the fix: an identifier that resolves to the caller's own group is an
 * identifier the caller has no consented right to RESOLVE THROUGH DISCOVERY
 * (consent is consent to be found BY OTHERS), so the answer is the ONE
 * frozen refusal — reference-identical to the miss, byte-identical, through
 * the same single exit, with the resolution walk's work fully performed.
 *
 * Two stores, one scenario (the two-TestOnlyDataLayer discipline): the
 * exclusion lives in the handler ABOVE the TestOnlyDataLayer seam, and
 * running it over the memory twin AND DynamoDB Local pins exactly that —
 * neither store may observe a different answer. And the no-over-blocking
 * half is asserted in the same cases: a DIFFERENT caller still resolves the
 * very same identifiers, so the exclusion is keyed to the claim's owning
 * group, never to the identifier.
 *
 * THE SCENARIO LIVES HERE, IN A NON-TEST MODULE, BECAUSE ITS TWO STORES
 * BELONG TO DIFFERENT VITEST PROJECTS. The DynamoDB Local leg is `heavy`
 * (accounts-discovery-self.test.ts); CI runs only `--project fast`, so with
 * both legs in one file the store-blind memory twin — commented "always
 * runs" — stopped running on every PR the moment the file was reclassified
 * The twin now runs from
 * accounts-discovery-self.twin.test.ts in `fast`, the DynamoDB leg from the
 * `heavy` file, and BOTH call the one function below, so the two stores can
 * never drift apart into two scenarios.
 *
 * Two pins added at this file's own gate:
 * - THE WALK PIN: the claim-row reads each self probe drives are COUNTED
 *   and must equal the genuine miss's — "the resolution walk's work fully
 *   performed" is an assertion, not a comment, so an early self-return
 *   inserted after the admitted counter cannot pass.
 * - THE SIBLING PIN: a second device linked into A's group through the real
 *   recovery transaction is refused on A's identifier exactly as A is —
 *   the clause keys on the GROUP (§2.1: the account IS the group), and the
 *   stranger resolving the same identifier immediately after proves the
 *   cool-down that linking wrote is elapsed, so the sibling's refusal is
 *   the self clause's and nothing else's. */

// Digits only (valid Crockford base32); '79' is this file's discriminator
// (the accounts-link lesson: parallel forks mint same-millisecond RUN ids).
const RUN = `${Date.now()}79`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
/** The run's letter suffix: digits → a..j, inside USERNAME_STRICT. */
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');

const TEST_KID = 'test-identifier-hmac-key';
const V1: IdentifierHmacKey[] = [{ version: 1, key: TEST_KID }];

/** Every DDB claim row this run mints, deleted in afterAll (the store
 * outlives the run; the phone-suite citizenship rule). */
export const mintedClaimKeys = new Set<string>();

interface Acct {
  userId: string;
  token: string;
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
  const res = await db.getOrCreateUserByIdentityKey(`idkey-self-${userId}`, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `self-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 365,
  });
  return { userId, token };
}

async function attachEmail(db: TestOnlyDataLayer, deps: TestDeps, acct: Acct, email: string): Promise<void> {
  expect(
    (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
  mintedClaimKeys.add(activeEmailClaimKeys(V1, email)[0]!);
}

async function lookup(deps: TestDeps, token: string, body: unknown): Promise<HttpResult> {
  // Roll the burst window first (the accounts-discovery helper discipline).
  deps.advanceMs(61_000);
  return discoveryLookupRoute(post(token, body), deps);
}

/** THE SCENARIO, over either TestOnlyDataLayer. */
export function selfDiscoverySuite(
  label: string,
  getDb: () => TestOnlyDataLayer,
  gated: (name: string, fn: () => Promise<void>) => void,
): void {
  describe(`${label}: self-discovery resolves as a miss (email AND username), a linked sibling is self, a stranger still resolves`, () => {
    gated('the caller looking up its OWN discoverable email/username receives the ONE frozen miss — reference-identical, byte-identical, and WALK-identical to a genuine miss — a linked sibling is self, and a DIFFERENT caller resolves throughout', async () => {
      const store = getDb();
      // THE WALK PIN's counter: every claim-row read the handler drives is
      // counted through this wrapper, both classes, both stores.
      let claimReads = 0;
      const db: TestOnlyDataLayer = {
        ...store,
        getIdentifierClaim: async (claimKey) => {
          claimReads += 1;
          return store.getIdentifierClaim(claimKey);
        },
        getUsernameClaim: async (claimKey, nowSeconds) => {
          claimReads += 1;
          return store.getUsernameClaim(claimKey, nowSeconds);
        },
      };
      const deps = makeTestDeps(db);

      // A: the self-looker — verified email, consent ON, a consented
      // username; B: the stranger — its own verified email (the anti-Sybil
      // gate). One clock advance ages both past 72 h.
      const a = await mkAcct(db, deps);
      const aEmail = `self-a-${RUN}@example.com`;
      await attachEmail(db, deps, a, aEmail);
      expect(
        (await setDiscoverableRoute(post(a.token, { discoverable: true }), deps)).statusCode,
      ).toBe(204);
      const b = await mkAcct(db, deps);
      await attachEmail(db, deps, b, `self-b-${RUN}@example.com`);
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000);

      const aName = `self${SUFFIX}`;
      expect(
        (await usernameClaimRoute(post(a.token, { username: aName, discoverable: true }), deps))
          .statusCode,
      ).toBe(200);
      mintedClaimKeys.add(activeUsernameClaimKeys(V1, normalizeUsernameIdentifier(aName))[0]!);
      mintedClaimKeys.add(
        activeNameskelClaimKeys(V1, usernameSkeleton(normalizeUsernameIdentifier(aName)))[0]!,
      );

      // The stranger resolves BOTH identifiers (no over-blocking): consent
      // means consent to be found by OTHERS, and B is an other.
      for (const body of [{ email: aEmail }, { username: aName }]) {
        const hit = await lookup(deps, b.token, body);
        expect(hit.statusCode).toBe(200);
        const parsed = JSON.parse(hit.body!) as { members: Array<{ userId: string }> };
        expect(parsed.members.map((m) => m.userId)).toEqual([a.userId]);
      }

      // A genuine miss, captured in THIS test, is the comparison anchor —
      // for bytes AND for the walk's read count.
      const readsBeforeMiss = claimReads;
      const miss = await lookup(deps, a.token, { email: `self-nobody-${RUN}@example.com` });
      expect(miss).toBe(discoveryRefusal());
      const missWalkReads = claimReads - readsBeforeMiss;
      expect(missWalkReads).toBeGreaterThan(0);

      // THE BUG'S SHAPE: A looking up A. Byte-identical to the miss — body,
      // status, headers — and reference-identical to the frozen single exit,
      // so a self-branch that minted its own refusal (or worse, answered)
      // cannot pass.
      const admittedBefore = deps.logs.filter((l) => l.event.startsWith('discovery_lookup_admitted')).length;
      const readsBeforeSelfEmail = claimReads;
      const selfEmail = await lookup(deps, a.token, { email: aEmail });
      const readsBeforeSelfUsername = claimReads;
      const selfUsername = await lookup(deps, a.token, { username: aName });
      const readsAfterSelfUsername = claimReads;
      for (const res of [selfEmail, selfUsername]) {
        expect(res).toBe(discoveryRefusal());
        expect(res).toEqual(accountsRefusal());
        expect(res.statusCode).toBe(miss.statusCode);
        expect(res.body).toBe(miss.body);
        expect(res.headers).toEqual(miss.headers);
      }
      // Both self probes were ADMITTED (the volume counter fired before
      // resolution): the refusal is the resolution's answer, not a gate's —
      // the timing profile of the miss path, work included.
      const admittedAfter = deps.logs.filter((l) => l.event.startsWith('discovery_lookup_admitted')).length;
      expect(admittedAfter - admittedBefore).toBe(2);
      // THE WALK PIN: each self probe read exactly as many claim rows as the
      // genuine miss — the all-versions walk ran in full. An early
      // self-return placed after the admitted counter reads ZERO rows and
      // fails here; a self branch that walked twice (or re-derived) fails
      // the other way.
      expect(readsBeforeSelfUsername - readsBeforeSelfEmail).toBe(missWalkReads);
      expect(readsAfterSelfUsername - readsBeforeSelfUsername).toBe(missWalkReads);
      // And the self refusal disclosed nothing to the retained sink (rule 5).
      for (const entry of deps.logs) {
        const line = JSON.stringify(entry);
        expect(line.includes('@')).toBe(false);
        expect(line.includes(a.userId)).toBe(false);
        expect(line.includes(b.userId)).toBe(false);
      }

      // The stranger STILL resolves after the self refusals (the exclusion
      // wrote nothing, tombstoned nothing, migrated nothing).
      const again = await lookup(deps, b.token, { email: aEmail });
      expect(again.statusCode).toBe(200);

      // THE SIBLING PIN (§2.1: the account IS the group — the clause keys
      // on the GROUP, so a linked sibling's device is "self" too). A2 joins
      // A's group through the REAL recovery transaction (the timing suite's
      // linking recipe), under a device class the group does not hold (so
      // it is ADDED, never a supersession) and with an already-elapsed
      // cool-down (completion arms `discoverableAfter` on EVERY claim the
      // group holds — an elapsed value keeps them resolvable by others).
      const a2 = await mkAcct(db, deps);
      const aGroupId = (await db.getUserById(a.userId))!.groupId!;
      const armS = Math.floor(deps.now() / 1000);
      expect(
        await db.putRecoveryPending({
          groupId: aGroupId,
          newUserId: a2.userId,
          deviceClass: 'tablet',
          claimKey: activeEmailClaimKeys(V1, aEmail)[0]!,
          requestedAt: deps.now(),
          completesAt: armS + 1,
          expiresAt: armS + 10_000_000,
        }),
      ).toBe('created');
      deps.advanceMs(2_000);
      const completed = await db.completeRecovery({
        groupId: aGroupId,
        newUserId: a2.userId,
        nowSeconds: Math.floor(deps.now() / 1000),
        linkedAtMs: deps.now(),
        discoverableAfter: Math.floor(deps.now() / 1000), // already elapsed
      });
      expect(completed.outcome).toBe('completed');
      deps.advanceMs(DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000); // A2 ages past the 72 h gate
      const sibling = await lookup(deps, a2.token, { email: aEmail });
      expect(sibling).toBe(discoveryRefusal());
      // And the stranger resolves the SAME identifier immediately after —
      // proving the cool-down the linking wrote is elapsed, so the
      // sibling's refusal above is the self clause's and nothing else's.
      const strangerAfterLink = await lookup(deps, b.token, { email: aEmail });
      expect(strangerAfterLink.statusCode).toBe(200);
    });
  });
}
