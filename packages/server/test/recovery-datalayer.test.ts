import { describe, expect, it } from 'vitest';
import { KIT_ZERO_MATERIAL_B64 } from '@tacendum/shared';
import {
  EMAIL_CODE_KEY_PREFIX,
  IDKEY_CLAIM_PREFIX,
  KIT_ENROLL_CHALLENGE_KEY_PREFIX,
  KIT_REBIND_CHALLENGE_KEY_PREFIX,
  LINK_INIT_KEY_PREFIX,
  LINK_OFFER_KEY_PREFIX,
  type CoreKeys,
} from '../src/db/data.js';
import { makeMemoryDb, testIdentityKey } from './helpers.js';

/**
 * — the ADDITIVE half of the kit's data layer, against the
 * MEMORY TWIN ONLY.
 *
 * WHAT THIS FILE DOES NOT PROVE, said plainly so nobody reads it as more than
 * it is. It exercises `packages/server/test/helpers.ts`'s twin, not DynamoDB.
 * The store's `ConditionExpression`s, its `TransactWrite` atomicity and its
 * positional `CancellationReasons` parsing are UNVERIFIED by this suite. That
 * is deliberate and it is a scope limit, not an oversight: a real-store
 * sibling would drive DynamoDB Local, which means an entry in
 * `vitest.config.ts`'s heavy list (or it inherits the fast project's 15 s cap
 * and starts flaking the week the suite grows — the rot
 * `packages/shared/test/suite-classification.test.ts` exists to catch), and
 * that file is outside this pass's scope grant.
 * The real-store twin of this file is owed before any of it is wired to a
 * route.
 *
 * What it DOES prove is the thing that has burned this codebase before: the
 * twin does not drift more permissive than the store it stands in for. Every
 * assertion below names the store condition it mirrors, so the pair can be
 * read side by side when the real-store suite lands.
 *
 * NOTHING HERE IS REACHABLE FROM THE WIRE. There is no route, no handler and
 * no caller for any method under test.
 */

const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const SALT = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
const VERIFIER_DIGEST = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=';

const KEY_A = testIdentityKey(1);
const KEY_B = testIdentityKey(2);
const KEY_C = testIdentityKey(3);

function core(identityKeyPub: string, registrationId = 42): CoreKeys {
  return {
    registrationId,
    identityKeyPub,
    signedPrekey: { keyId: 1, pub: 'cA==', sig: 'cw==' },
    kyberPrekey: { keyId: 2, pub: 'cA==', sig: 'cw==' },
  };
}

/** An account born the way every real one is — row and claim in one step. */
async function bornAccount(db: ReturnType<typeof makeMemoryDb>, userId: string, key: string) {
  const res = await db.getOrCreateUserByIdentityKey(key, userId, 1_700_000_000_000);
  expect(res.kind).toBe('ok');
}

describe('kit enrolment rows', () => {
  it('writes the three attributes and reports success', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    expect(await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1_700_000_001_000)).toBe(true);
    const row = await db.getUserById(USER);
    expect(row?.kitSalt).toBe(SALT);
    expect(row?.kitVerifierDigest).toBe(VERIFIER_DIGEST);
    expect(row?.kitEnrolledAt).toBe(1_700_000_001_000);
  });

  it('replacing a kit needs no old kit — the identity key is the factor', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1);
    const salt2 = `${'B'.repeat(42)}A=`;
    expect(await db.setKitEnrollment(USER, salt2, 'ZGlnZXN0', 2)).toBe(true);
    const row = await db.getUserById(USER);
    expect(row?.kitSalt).toBe(salt2);
    expect(row?.kitVerifierDigest).toBe('ZGlnZXN0');
    expect(row?.kitEnrolledAt).toBe(2);
  });

  it('refuses a row that does not exist', async () => {
    // Mirrors `attribute_exists(userId)`. A REMOVE or SET on a bare key would
    // otherwise mint a user row for a ULID nobody registered.
    const db = makeMemoryDb();
    expect(await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1)).toBe(false);
  });

  it('refuses a TOMBSTONED row', async () => {
    // Mirrors `attribute_not_exists(tombstoned)`. A revoked device arming a
    // recovery for the account it was cut off from is a second way back in
    // for exactly the phone the revoke existed to lock out.
    const db = makeMemoryDb();
    await db.createUser({
      userId: USER,
      createdAt: 1,
      identityKeyPub: KEY_A,
      tombstoned: true,
    });
    expect(await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1)).toBe(false);
    expect((await db.getUserById(USER))?.kitSalt).toBeUndefined();
  });

  it('clearing removes all three attributes and is idempotent', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1);
    await db.clearKitEnrollment(USER);
    const row = await db.getUserById(USER);
    expect(row?.kitSalt).toBeUndefined();
    expect(row?.kitVerifierDigest).toBeUndefined();
    expect(row?.kitEnrolledAt).toBeUndefined();
    // Twice, and on an account that never enrolled: a user tearing up a piece
    // of paper does not have to learn whether the server agreed it existed.
    await expect(db.clearKitEnrollment(USER)).resolves.toBeUndefined();
    await expect(db.clearKitEnrollment(OTHER)).resolves.toBeUndefined();
  });

  it('the row still carries no live kit after clearing, and the account survives', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1);
    await db.clearKitEnrollment(USER);
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
  });
});

describe('kit challenge rows', () => {
  const CH = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const CH2 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';

  it('is single-use: the second consume answers nothing', async () => {
    const db = makeMemoryDb();
    await db.putKitChallenge({ kind: 'kitRebind', userId: USER, challenge: CH, expiresAt: 999 });
    const first = await db.consumeKitChallengeIfMatches('kitRebind', USER, CH);
    expect(first).toEqual({ kind: 'kitRebind', userId: USER, challenge: CH, expiresAt: 999 });
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeUndefined();
  });

  it('CONCURRENT mints coexist — the owner’s pending challenge survives a stranger’s spam', async () => {
    // §2 inv. 6 and §0.4, and the reason this is deliberately NOT the
    // one-outstanding `chal#` replace shape: `POST /v1/rebind/challenge` takes
    // nothing but a bare public ULID, so a replace-on-mint row would let any
    // stranger clobber the true owner's in-flight recovery at will.
    const db = makeMemoryDb();
    await db.putKitChallenge({ kind: 'kitRebind', userId: USER, challenge: CH, expiresAt: 1 });
    await db.putKitChallenge({ kind: 'kitRebind', userId: USER, challenge: CH2, expiresAt: 2 });
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH2)).toBeDefined();
    // The first is untouched by the second's mint AND by the second's spend.
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeDefined();
  });

  it('the two ceremonies are separate namespaces', async () => {
    // Mirrors the prefix-disjoint `echal#` / `rchal#` keys plus the `kind`
    // re-check every reader of that namespace makes. An enrolment nonce
    // spendable at the anonymous rebind route would be a category error with
    // teeth.
    const db = makeMemoryDb();
    await db.putKitChallenge({ kind: 'kitEnroll', userId: USER, challenge: CH, expiresAt: 1 });
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeUndefined();
    expect(await db.consumeKitChallengeIfMatches('kitEnroll', USER, CH)).toBeDefined();
  });

  it('a challenge for account A is dead for account B', async () => {
    const db = makeMemoryDb();
    await db.putKitChallenge({ kind: 'kitRebind', userId: USER, challenge: CH, expiresAt: 1 });
    expect(await db.consumeKitChallengeIfMatches('kitRebind', OTHER, CH)).toBeUndefined();
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeDefined();
  });

  it('an expired row is still SPENT by the attempt', async () => {
    // Mirrors the store: the conditional delete does not read the clock, so a
    // caller cannot retry a dead nonce until the clock suits them. Expiry is
    // the caller's judgement on the record handed back.
    const db = makeMemoryDb();
    await db.putKitChallenge({ kind: 'kitRebind', userId: USER, challenge: CH, expiresAt: 1 });
    const spent = await db.consumeKitChallengeIfMatches('kitRebind', USER, CH);
    expect(spent?.expiresAt).toBe(1);
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeUndefined();
  });

  it('an unknown nonce answers nothing rather than throwing', async () => {
    const db = makeMemoryDb();
    expect(await db.consumeKitChallengeIfMatches('kitRebind', USER, CH)).toBeUndefined();
  });
});

describe('rebindUserIdentity — the one SET of identityKeyPub after birth', () => {
  it('rekeys the SAME ULID, tombstones the old claim, writes the new one', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);

    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B, 7),
      nowMs: 1_700_000_002_000,
    });
    expect(res.kind).toBe('rebound');

    const row = await db.getUserById(USER);
    // THE POINT OF THE WHOLE FEATURE: the ULID does not change, so every
    // peer's address-book entry keeps resolving. That is what the kit buys
    // over the shipped identifier-recovery verb, which mints a new one.
    expect(row?.userId).toBe(USER);
    expect(row?.identityKeyPub).toBe(KEY_B);
    expect(row?.registrationId).toBe(7);

    // The OLD key is dead for auth — a found-or-stolen old phone must latch
    // `identity_tombstoned`, never be handed a fresh account.
    expect(
      (await db.getOrCreateUserByIdentityKey(KEY_A, '01ARZ3NDEKTSV4RRFFQ69G5FC1', 3)).kind,
    ).toBe('tombstoned');
    // The NEW key resolves to the same account, not to a second one.
    const resolved = await db.getOrCreateUserByIdentityKey(KEY_B, '01ARZ3NDEKTSV4RRFFQ69G5FC2', 4);
    expect(resolved.kind).toBe('ok');
    if (resolved.kind === 'ok') {
      expect(resolved.created).toBe(false);
      expect(resolved.user.userId).toBe(USER);
    }
  });

  it('claim rows stay unaddressable as accounts', async () => {
    // No new enumeration surface (§2 inv. 7): the claim rows this writes
    // share the users table and must remain unreachable through getUserById.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 1,
    });
    expect(await db.getUserById(`${IDKEY_CLAIM_PREFIX}${KEY_A}`)).toBeUndefined();
    expect(await db.getUserById(`${IDKEY_CLAIM_PREFIX}${KEY_B}`)).toBeUndefined();
  });

  it('rolls the prekey pool generation IN THE SAME STEP, orphaning the old pool', async () => {
    // This is what replaces the draft's
    // "wipe the pool BEFORE the commit precisely because it cannot be inside
    // it" with something atomic: no bundle can ever pair the new identity key
    // with an old one-time prekey, because the generation moved with the key.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.storeKeys(USER, core(KEY_A), [
      { keyId: 10, pub: 'cDEw' },
      { keyId: 11, pub: 'cDEx' },
    ]);
    const oldGen = (await db.getUserById(USER))?.prekeyPoolGen;
    expect(typeof oldGen).toBe('string');
    expect(await db.countOneTimePrekeys(USER, oldGen)).toBe(2);

    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 1,
    });
    expect(res.kind).toBe('rebound');
    const newGen = (await db.getUserById(USER))?.prekeyPoolGen;
    expect(newGen).not.toBe(oldGen);
    if (res.kind === 'rebound') expect(res.prekeyPoolGen).toBe(newGen);

    // The old pool is unreachable under the new generation — the honest
    // signed-prekey-only fallback, not a chimera bundle.
    expect(await db.countOneTimePrekeys(USER, newGen)).toBe(0);
    expect(await db.consumeOneTimePrekey(USER, newGen)).toBeUndefined();
    // The ROWS are still there under their own generation — nobody can reach
    // them, because a bundle only ever reads the generation off the user row.
    // Sweeping them is housekeeping, not a control, which is the difference
    // between this and the draft's pre-commit wipe.
    expect(await db.countOneTimePrekeys(USER, oldGen)).toBe(2);
  });

  it('is idempotent for the crashed client: old == new answers success and mutates nothing', async () => {
    // §0.5. Without the short-circuit, legs (a) and (c) address one item twice
    // and DynamoDB rejects the whole transaction as a ValidationException —
    // a 500, not the promised 409.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.storeKeys(USER, core(KEY_A), [{ keyId: 10, pub: 'cDEw' }]);
    const genBefore = (await db.getUserById(USER))?.prekeyPoolGen;

    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_A, 99),
      nowMs: 1,
    });
    expect(res).toEqual({ kind: 'unchanged' });
    const row = await db.getUserById(USER);
    expect(row?.identityKeyPub).toBe(KEY_A);
    // Nothing moved — not the generation, and not the registration id the
    // caller happened to pass.
    expect(row?.prekeyPoolGen).toBe(genBefore);
    expect(row?.registrationId).not.toBe(99);
  });

  it('REFUSES a row whose key has no claim, rather than minting a tombstone', async () => {
    // Leg (b) is an UPDATE under `attribute_exists(userId)`, the shape
    // `tombstoneIdentityKey` uses and the rule it states verbatim: "Only an
    // EXISTING claim can be tombstoned — this must never mint a bare
    // tombstone row for a key that was never registered."
    //
    // The draft made leg (b) an UNCONDITIONAL whole-item Put, justified by a
    // "legacy row minted through `createUser`". That path cannot exist in
    // production — `createUser` is on `TestOnlyDataLayer`, and production
    // births a row only through `getOrCreateUserByIdentityKey`'s claim
    // transaction — so the only states the Put served were drift states, in
    // which it discarded the claim's birth attributes and could repoint and
    // revoke ANOTHER account's live claim. A claimless row is drift worth
    // failing loudly on, which is what the roster revoke helper says too.
    const db = makeMemoryDb();
    await db.createUser({ userId: USER, createdAt: 1, identityKeyPub: KEY_A });
    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 2,
    });
    expect(res).toEqual({ kind: 'stale' });
    // All-or-none: the row did NOT rekey, and no bare tombstone was minted
    // for a key that was never registered.
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
    const afterA = await db.getOrCreateUserByIdentityKey(KEY_A, '01ARZ3NDEKTSV4RRFFQ69G5FC3', 3);
    expect(afterA.kind).not.toBe('tombstoned');
  });

  it('never repoints or revokes a claim that names a DIFFERENT account', async () => {
    // The drift state the unconditional Put was silently destructive in: the
    // rebinding account's old key has a claim, but that claim belongs to
    // someone else. A whole-item Put would have rewritten `claimedUserId` to
    // the rebinding account AND set `tombstoned: true` on it — a cross-account
    // identity-key revocation, reachable from a route that will be anonymous.
    const db = makeMemoryDb();
    await bornAccount(db, OTHER, KEY_A); // KEY_A's claim names OTHER
    await db.createUser({ userId: USER, createdAt: 1, identityKeyPub: KEY_A });

    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 2,
    });
    // The new claim is free, so this is not the 409 — it is leg (b)'s
    // `claimedUserId = :self`, and the answer must not be a commit.
    expect(res).toEqual({ kind: 'stale' });
    // KEY_A's claim was NOT revoked: OTHER, whose claim it is, keeps a live
    // key. (Resolution through `getOrCreateUserByIdentityKey` cannot be
    // asserted here — the test-only `createUser` used to PLANT the drift
    // re-points the twin's key→row map, which is exactly the kind of state
    // only drift produces.)
    expect(
      (await db.getOrCreateUserByIdentityKey(KEY_A, '01ARZ3NDEKTSV4RRFFQ69G5FC4', 3)).kind,
    ).not.toBe('tombstoned');
    expect((await db.getUserById(OTHER))?.identityKeyPub).toBe(KEY_A);
    // And nothing moved on the refused path.
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
  });

  it('REFUSES a TOMBSTONED row — a paper kit is not a way around a revoke', async () => {
    // Leg (a) carries `attribute_not_exists(tombstoned)`, the same guard
    // `setKitEnrollment` already applies. Without it a kit armed BEFORE the
    // revoke — the normal case, since the paper is printed while things are
    // fine — rekeyed the row and wrote a FRESH untombstoned claim for the new
    // key, leaving an account that can SIGN IN (nothing in `authHandler`
    // inspects `user.tombstoned`) but whose `userAccountState` is still
    // `tombstoned` and whose every enqueue refuses. That split state is worse
    // than either clean answer.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1); // armed while live
    // The roster revoke: the user row AND the idkey claim both tombstone.
    expect(await db.tombstoneAgentBindings([{ userId: USER, identityKeyPub: KEY_A }])).toBe('done');
    // Re-arming is already refused; the rebind must be too.
    expect(await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 2)).toBe(false);

    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 2,
    });
    expect(res).toEqual({ kind: 'stale' });
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
    // And the new key was NOT claimed — no second way in was created.
    const resolved = await db.getOrCreateUserByIdentityKey(KEY_B, '01ARZ3NDEKTSV4RRFFQ69G5FC5', 3);
    expect(resolved.kind).toBe('ok');
    if (resolved.kind === 'ok') expect(resolved.user.userId).not.toBe(USER);
  });

  it('refuses a NEW key already claimed by a different account — the 409', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await bornAccount(db, OTHER, KEY_B);
    const res = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 1,
    });
    expect(res).toEqual({ kind: 'key_in_use' });
    // All-or-none: nothing moved on the refused path.
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
    expect((await db.getUserById(OTHER))?.identityKeyPub).toBe(KEY_B);
  });

  it('loses to a racing writer rather than overwriting it', async () => {
    // Mirrors `identityKeyPub = :old`. A second rebind (or a delete) that
    // commits between the handler's read and this write WINS; this call is
    // told to re-read. Overwriting would be how two concurrent recoveries
    // both believe they own the account.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    const first = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 1,
    });
    expect(first.kind).toBe('rebound');
    // The loser still holds the pre-race key it read.
    const second = await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_C),
      nowMs: 2,
    });
    expect(second).toEqual({ kind: 'stale' });
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_B);
  });

  it('a deleted row answers stale, never a resurrection', async () => {
    const db = makeMemoryDb();
    expect(
      await db.rebindUserIdentity({
        userId: USER,
        expectedIdentityKeyPub: KEY_A,
        core: core(KEY_B),
        nowMs: 1,
      }),
    ).toEqual({ kind: 'stale' });
    expect(await db.getUserById(USER)).toBeUndefined();
  });

  it('key_in_use outranks stale when both conditions fail, matching the store', async () => {
    // The store reads CancellationReasons POSITIONALLY and tests index 2 (the
    // new claim) first. A twin that answered `stale` here would make a
    // handler test prove the wrong 4xx.
    const db = makeMemoryDb();
    await bornAccount(db, OTHER, KEY_B);
    expect(
      await db.rebindUserIdentity({
        userId: USER, // no such row
        expectedIdentityKeyPub: KEY_A,
        core: core(KEY_B), // and the key is taken
        nowMs: 1,
      }),
    ).toEqual({ kind: 'key_in_use' });
  });

  it('storeKeys is UNCHANGED by the rebind: a third key is still refused', async () => {
    // The exception is one code path and it is this one. `PUT /v1/keys` after
    // a rebind accepts the NEW key's batch under the same immutability check
    // it always had, and still 409s anything else — which is worth more than
    // folding one-time prekeys into the rebind payload would have been.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 1,
    });
    expect(await db.storeKeys(USER, core(KEY_C), [])).toBe(false);
    expect(await db.storeKeys(USER, core(KEY_B), [{ keyId: 1, pub: 'cA==' }])).toBe(true);
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_B);
    // And the OLD key stays refused too — the rebind did not reopen it.
    expect(await db.storeKeys(USER, core(KEY_A), [])).toBe(false);
  });

  it('`unchanged` asserts NOTHING about the row — the caller owes the read', async () => {
    // Pinned as the recorded contract, not as a nicety. The old==new branch
    // compares two CALLER-SUPPLIED strings and performs no read at all, so it
    // answers success against an EMPTY database. A handler that answered 200
    // plus a fresh session token here, having passed the REQUESTED key as
    // `expectedIdentityKeyPub` rather than the key it read off the row, would
    // mint a token for an account it never confirmed exists. The declaration
    // on `rebindUserIdentity` states the ordering obligation; this pins the
    // behaviour so nobody discovers it the other way round.
    const db = makeMemoryDb();
    expect(
      await db.rebindUserIdentity({
        userId: USER, // no such row
        expectedIdentityKeyPub: KEY_A,
        core: core(KEY_A),
        nowMs: 1,
      }),
    ).toEqual({ kind: 'unchanged' });
    expect(await db.getUserById(USER)).toBeUndefined();
  });

  it('leaves the kit enrolment in place — expiring it is a HANDLER policy, not a store one', async () => {
    // Recorded rather than assumed: §3 does not say a kit is
    // single-use, and the store deliberately takes no position. If the
    // redeem handler decides a used kit must be burned, it calls
    // `clearKitEnrollment` there, and this expectation flips with a plan
    // citation.
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1);
    await db.rebindUserIdentity({
      userId: USER,
      expectedIdentityKeyPub: KEY_A,
      core: core(KEY_B),
      nowMs: 2,
    });
    expect((await db.getUserById(USER))?.kitSalt).toBe(SALT);
  });
});

describe('claim rows are not accounts — the three new mutators refuse them', () => {
  // `getUserById` refuses claim keys (data.ts's `isClaimKey` /
  // `CLAIM_PREFIXES` doctrine) precisely so a caller-supplied `idkey#…`
  // cannot act as a registered-key oracle. The new mutators are on the same
  // table and carry the same guard: without it,
  // `setKitEnrollment('idkey#<b64>', …)` passes `attribute_exists(userId) AND
  // attribute_not_exists(tombstoned)` on a LIVE claim row and answers `true`
  // iff that identity key is registered and unrevoked — while writing kit
  // attributes onto a bookkeeping row. The DTOs are ULID-bound today, which
  // was true of every path this guard was later retrofitted to.
  const claimKey = `${IDKEY_CLAIM_PREFIX}${KEY_A}`;

  it('setKitEnrollment refuses a claim key and writes nothing', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A); // the claim row is live and untombstoned
    expect(await db.setKitEnrollment(claimKey, SALT, VERIFIER_DIGEST, 1)).toBe(false);
    // Indistinguishable from an unregistered key: the same `false`.
    expect(await db.setKitEnrollment(`${IDKEY_CLAIM_PREFIX}${KEY_C}`, SALT, VERIFIER_DIGEST, 1)).toBe(
      false,
    );
  });

  it('clearKitEnrollment is a no-op on a claim key', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    await expect(db.clearKitEnrollment(claimKey)).resolves.toBeUndefined();
    // The account itself is untouched.
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
  });

  it('rebindUserIdentity refuses a claim key', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    expect(
      await db.rebindUserIdentity({
        userId: claimKey,
        expectedIdentityKeyPub: KEY_A,
        core: core(KEY_B),
        nowMs: 1,
      }),
    ).toEqual({ kind: 'stale' });
    expect((await db.getUserById(USER))?.identityKeyPub).toBe(KEY_A);
  });
});

describe('all-zero kit material is refused by the store', () => {
  // The claim `packages/shared/src/recovery.ts` used to make without any code
  // behind it. A salt or digest of 32 zero bytes is the one value an attacker
  // gets for free. `KitEnrollRequest` refuses it on the wire; this is the
  // guard for a caller that never went through that schema.
  it('setKitEnrollment refuses a zeroed salt or a zeroed digest', async () => {
    const db = makeMemoryDb();
    await bornAccount(db, USER, KEY_A);
    expect(await db.setKitEnrollment(USER, KIT_ZERO_MATERIAL_B64, VERIFIER_DIGEST, 1)).toBe(false);
    expect(await db.setKitEnrollment(USER, SALT, KIT_ZERO_MATERIAL_B64, 1)).toBe(false);
    expect((await db.getUserById(USER))?.kitSalt).toBeUndefined();
    // And the real thing still works, so this is a refusal and not a break.
    expect(await db.setKitEnrollment(USER, SALT, VERIFIER_DIGEST, 1)).toBe(true);
  });
});

describe('sessions-table key namespaces stay prefix-disjoint', () => {
  it('no sessions-table key prefix is a prefix of another', () => {
    // The property `KIT_ENROLL_CHALLENGE_KEY_PREFIX`'s comment ASSERTS ("two
    // more prefix-disjoint namespaces beside chal#/wst#/sess:/linkoffer#/
    // emailcode#") and nothing checked. `echal#` and `emailcode#` diverge only
    // at the second character, which is thin margin for a property held by
    // prose. Same shape as the domain-tag table in
    // `packages/shared/test/recovery.test.ts`.
    const prefixes = [
      'chal#',
      'wst#',
      'sess:',
      LINK_OFFER_KEY_PREFIX,
      LINK_INIT_KEY_PREFIX,
      EMAIL_CODE_KEY_PREFIX,
      KIT_ENROLL_CHALLENGE_KEY_PREFIX,
      KIT_REBIND_CHALLENGE_KEY_PREFIX,
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(a.startsWith(b), `${a} starts with ${b} — the namespaces are not disjoint`).toBe(
          false,
        );
      }
    }
  });
});
