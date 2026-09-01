import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  EMAIL_CODE_ATTEMPT_CAP,
  EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
  EMAIL_CODE_TTL_SECONDS,
  IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY,
  IDENTIFIER_SEND_FLEET_DAILY_CEILING,
  IDENTIFIER_SENDS_PER_RECIPIENT_PER_DAY,
  TABLES,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { EMAIL_CODE_KEY_PREFIX, makeDataLayer, type DataLayer } from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  emailClaimKey,
  identifierClaimHash,
} from '../src/opaque-ref.js';
import { LIMITS } from '../src/ratelimit.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../src/handlers/identifiers.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Email linking against REAL DynamoDB Local: attach
 * requires a verified code; the store holds HMAC output and NEVER the
 * identifier (the suite scans its own test-DB dump for the plaintext);
 * unlink takes the claim row, its consent, and the group's identifierRef
 * together; the pinned budgets are asserted VERBATIM as release values;
 * the derived-subkey construction is pinned to a byte fixture an
 * undomain-separated HMAC fails; and the captured log sink across the
 * attach/verify/recovery error paths holds neither the canary identifier
 * nor any member ULID.
 *
 * The flag is process-local (the accounts-link discipline): the real row is
 * a store-wide singleton the suite already drives; this suite owns the
 * IDENTIFIER flows, with the flag ON as its default case (the OFF collapse
 * for these routes is accounts-flag-gate.test.ts's).
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;
let flagOn = true;

// Digits only (valid Crockford base32); '61' is this file's discriminator
// (the accounts-link lesson: parallel forks mint same-millisecond RUN ids).
const RUN = `${Date.now()}61`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** The canary identifier: if these bytes ever land in a row or a log line,
 * the plaintext leaked. Unique per run so a Scan match is THIS run's leak. */
const CANARY_EMAIL = `canary-${RUN}@example.com`;
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

async function mkAcct(deps: TestDeps): Promise<{ userId: string; token: string; pub: string }> {
  const userId = uid();
  canaries.add(userId);
  const pub = `idkey-${userId}`;
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `id-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 24 * 3600 * 30,
  });
  return { userId, token, pub };
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

/** Ceremony-link two accounts at the data layer (the flag-gate pattern —
 * signatures are the suite; this one needs a grouped caller). */
async function linkPair(
  deps: TestDeps,
  a: { userId: string },
  b: { userId: string },
): Promise<string> {
  const groupId = uid();
  canaries.add(groupId);
  const offerNonce = `nonce-id-${RUN}-${++seq}`;
  const nowS = Math.floor(deps.now() / 1000);
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId,
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
  return groupId;
}

beforeAll(async () => {
  const client = makeDynamoClient();
  const base = makeDataLayer(makeDocClient(client));
  doc = makeDocClient(client);
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

describe('the pinned derived-subkey construction', () => {
  it('matches the byte fixture, and an undomain-separated or merely-concatenated HMAC FAILS the vector', () => {
    // Byte-pinned OUTSIDE this suite (literals, not recomputed pins): the
    // fixture key and identifier are frozen strings, and the expected value
    // is the base64url of HMAC-SHA256(HMAC-SHA256(K_id, "HMAC_IDENTIFIER"),
    // identifier) computed once and committed. If the construction drifts —
    // the domain constant dropped, moved into the message, or the derivation
    // reordered — the module stops reproducing this literal.
    const K = 'fixture-K_id-for-the-AC6-byte-vector';
    const id = 'vector.alice@example.com';
    const PINNED = 'QLcp5YQ3m-KOa04lbZm-SdFW19aXfYxKYznwq5pgGdk';
    expect(identifierClaimHash(K, id)).toBe(PINNED);

    // The two wrong constructions the pin exists to refuse, assembled by
    // hand (node:crypto in a test recomputing what the code under test must
    // match):
    // 1. HMAC_IDENTIFIER unused — a direct HMAC(K_id, identifier).
    const direct = createHmac('sha256', K).update(id).digest('base64url');
    expect(direct).toBe('vGxC4sc-tN8ud5TUTaTu_WdGRDxUL1AX6wjG881N7Sc');
    expect(direct).not.toBe(PINNED);
    // 2. The constant merely CONCATENATED into the message instead of
    // applied as a derived subkey.
    const concatenated = createHmac('sha256', K)
      .update(`HMAC_IDENTIFIER${id}`)
      .digest('base64url');
    expect(concatenated).toBe('MzJx8SmmG54teEeJKJXflxAFc-25toLnuW1u8t3SAdE');
    expect(concatenated).not.toBe(PINNED);

    // And the faithful reproduction: the same node:crypto hands rebuild the
    // module's answer, so the pin is a construction, not a magic string.
    const derived = createHmac('sha256', K).update('HMAC_IDENTIFIER').digest();
    expect(createHmac('sha256', derived).update(id).digest('base64url')).toBe(PINNED);
  });

  it('the pinned release values, asserted verbatim (never a test shadow)', () => {
    expect(EMAIL_CODE_TTL_SECONDS).toBe(5 * 60);
    expect(EMAIL_CODE_ATTEMPT_CAP).toBe(5);
    expect(EMAIL_CODE_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(IDENTIFIER_SENDS_PER_RECIPIENT_PER_DAY).toBe(5);
    expect(IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY).toBe(10);
    expect(IDENTIFIER_SEND_FLEET_DAILY_CEILING).toBe(1000);
    expect(LIMITS.identifierSendRecipient).toEqual({ capacity: 5, refillPerSec: 5 / 86400 });
    expect(LIMITS.identifierResend).toEqual({ capacity: 1, refillPerSec: 1 / 60 });
    expect(LIMITS.identifierAttach).toEqual({ capacity: 10, refillPerSec: 10 / 86400 });
    expect(LIMITS.identifierSendFleet).toEqual({ capacity: 1000, refillPerSec: 1000 / 86400 });
  });
});

describe('attach against real DynamoDB', () => {
  gated('attach requires a verified code: no code ever requested, and a wrong code, are both the collapsed refusal — and every wrong attempt is spent against the cap', async () => {
    const deps = freshDeps();
    const acct = await mkAcct(deps);
    // No code ever requested.
    expectRefused(
      await emailVerifyRoute(post(acct.token, { email: CANARY_EMAIL, code: '999999' }), deps),
    );
    // Request one, then present the WRONG code.
    expect(
      (
        await emailRequestCodeRoute(
          post(acct.token, { email: CANARY_EMAIL, class: 'phone' }),
          deps,
        )
      ).statusCode,
    ).toBe(200);
    expect(deps.emailsSent).toHaveLength(1);
    expect(deps.emailsSent[0]!.address).toBe(CANARY_EMAIL);
    expectRefused(
      await emailVerifyRoute(post(acct.token, { email: CANARY_EMAIL, code: '000000' }), deps),
    );
    // The right code still works after ONE wrong attempt (cap is 5).
    const code = deps.emailsSent[0]!.code;
    const ok = await emailVerifyRoute(post(acct.token, { email: CANARY_EMAIL, code }), deps);
    expect(ok.statusCode).toBe(200);
  });

  gated('the stored key is HMAC output, never the identifier: the claim row sits at the derived key, and a full dump of both tables holds no plaintext identifier', async () => {
    const deps = freshDeps();
    const email = `dump-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    expect(
      (
        await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect(
      (await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode,
    ).toBe(200);

    // The claim row lives at EXACTLY the pinned versioned derived-subkey
    // address (emailhash#v1#<HMAC(HMAC(K_id,"HMAC_IDENTIFIER"), email)>).
    const claimKey = activeEmailClaimKeys(KEYS, email)[0]!;
    expect(claimKey).toBe(`emailhash#v1#${identifierClaimHash(TEST_KID, email)}`);
    const claim = await rawRow(SERVER_TABLES.users, { userId: claimKey });
    expect(claim?.kind).toBe('identifierClaim');
    expect(claim?.discoverable).toBe(false);
    const groupId = claim?.groupId as string;
    canaries.add(groupId);
    // The lazy solo group was born with the declared class, certless (there was no ceremony to forge a certificate from).
    const group = await db.getAccountGroup(groupId);
    expect(group?.members).toEqual([
      expect.objectContaining({ userId: acct.userId, class: 'phone' }),
    ]);
    expect(group?.members[0]!.certs).toBeUndefined();
    expect(group?.identifierRefs).toEqual([claimKey]);
    // The code row was consumed single-use by the attach transaction (the
    // per-purpose attach slot).
    expect(
      await rawRow(SERVER_TABLES.sessions, {
        token: `${EMAIL_CODE_KEY_PREFIX}${acct.userId}#attach`,
      }),
    ).toBeUndefined();

    // THE DUMP GREP: every row of both tables, serialized, must not contain
    // the plaintext identifier anywhere — not as a key, not as an attribute,
    // not inside a nested map. (The canary from other tests is swept too.)
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
        expect(dump.includes(email), table).toBe(false);
        expect(dump.includes(CANARY_EMAIL), table).toBe(false);
        startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
    }
  });

  gated('unlink deletes the claim row AND its consent AND removes the group row identifierRef', async () => {
    const deps = freshDeps();
    const email = `unlink-${RUN}@example.com`;
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const groupId = await linkPair(deps, a, b);
    expect(
      (
        await emailRequestCodeRoute(post(a.token, { email, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(a.token, { email, code }), deps)).statusCode).toBe(200);
    const claimKey = activeEmailClaimKeys(KEYS, email)[0]!;
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([claimKey]);
    // Consent ON, so the unlink demonstrably deletes it WITH the row (it
    // lives on the claim row).
    expect(await db.setIdentifierDiscoverable(claimKey, groupId, a.userId, true)).toBe('set');

    const res = await emailUnlinkRoute(post(b.token, {}), deps);
    expect(res.statusCode).toBe(200);
    expect(await rawRow(SERVER_TABLES.users, { userId: claimKey })).toBeUndefined();
    expect(await db.getIdentifierClaim(claimKey)).toBeUndefined();
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([]);
    // A second unlink has nothing to remove: collapsed.
    expectRefused(await emailUnlinkRoute(post(b.token, {}), deps));
  });

  gated('wrong-code attempts hit the cap: five spent attempts kill the row, and the RIGHT code is refused after them', async () => {
    const deps = freshDeps();
    const email = `cap-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    expect(
      (
        await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    for (let i = 0; i < EMAIL_CODE_ATTEMPT_CAP; i++) {
      expectRefused(
        await emailVerifyRoute(post(acct.token, { email, code: '000000' }), deps),
      );
    }
    // Attempt 6 — with the CORRECT code: the row is dead (the conditional
    // increment refuses past the cap), one collapsed answer.
    expectRefused(await emailVerifyRoute(post(acct.token, { email, code }), deps));
  });

  gated('an expired-but-unreaped code — row still present, expiresAt past — is REFUSED: TTL reaping is cleanup, never the enforcement', async () => {
    const deps = freshDeps();
    const email = `expiry-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    expect(
      (
        await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    deps.advanceMs((EMAIL_CODE_TTL_SECONDS + 1) * 1000);
    // The row is STILL IN THE STORE (DynamoDB Local never reaps; production
    // reaps lazily) — the refusal below is the explicit expiresAt check.
    const row = await rawRow(SERVER_TABLES.sessions, {
      token: `${EMAIL_CODE_KEY_PREFIX}${acct.userId}#attach`,
    });
    expect(row?.kind).toBe('emailCode');
    expect(row?.expiresAt as number).toBeLessThan(Math.floor(deps.now() / 1000));
    expectRefused(await emailVerifyRoute(post(acct.token, { email, code }), deps));
  });

  gated('a second verified email on the same group is REFUSED — the one-identifier v1 cap, enforced as the transaction condition, not just the request-time precheck', async () => {
    const deps = freshDeps();
    const first = `one-${RUN}@example.com`;
    const second = `two-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    expect(
      (
        await emailRequestCodeRoute(post(acct.token, { email: first, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(acct.token, { email: first, code }), deps)).statusCode).toBe(
      200,
    );
    const groupId = (await db.getUserById(acct.userId))!.groupId!;
    canaries.add(groupId);
    // The request-time arm: a group already holding its one email refuses
    // the second request outright (UX; collapsed).
    expectRefused(
      await emailRequestCodeRoute(post(acct.token, { email: second, class: 'phone' }), deps),
    );
    // The TRANSACTION arm (the enforcement): plant a validated code row and
    // drive the attach transaction directly — the size(identifierRefs)
    // condition refuses even when every precheck is bypassed.
    const secondKey = activeEmailClaimKeys(KEYS, second)[0]!;
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
        nowMs: deps.now(),
      }),
    ).toBe('identifier_cap');
    await db.deleteEmailCode(acct.userId, 'attach');
  });

  gated('resend inside the cool-down and sends past the per-recipient budget are REFUSED — no email leaves, while the ANSWER stays byte-uniform (the budget key is the identifier, not the caller)', async () => {
    const deps = freshDeps();
    const email = `budget-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    const ask = async (): Promise<HttpResult> =>
      emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps);

    const firstRes = await ask();
    expect(firstRes.statusCode).toBe(200);
    expect(deps.emailsSent).toHaveLength(1);
    // INSIDE the 60 s cool-down: the send is REFUSED (nothing leaves the
    // seam) and the bytes are IDENTICAL to success — a distinguishable
    // refusal on an identifier-keyed budget would disclose send traffic
    // against an address the caller may only be probing.
    const cooled = await ask();
    expect(cooled).toEqual(firstRes);
    expect(deps.emailsSent).toHaveLength(1);
    // Past the cool-down, sends 2..5 of the day pass...
    for (let n = 2; n <= IDENTIFIER_SENDS_PER_RECIPIENT_PER_DAY; n++) {
      deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
      expect(await ask()).toEqual(firstRes);
      expect(deps.emailsSent).toHaveLength(n);
    }
    // ...and the SIXTH is past the per-recipient daily budget: refused —
    // same bytes, no send.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(await ask()).toEqual(firstRes);
    expect(deps.emailsSent).toHaveLength(IDENTIFIER_SENDS_PER_RECIPIENT_PER_DAY);
  });

  gated('one group per identifier, ever: a SECOND account verifying an already-claimed address is refused at the claim-uniqueness condition (claim_exists), collapsed (gate fix — the invariant was untested)', async () => {
    const deps = freshDeps();
    const email = `oneowner-${RUN}@example.com`;
    const first = await mkAcct(deps);
    expect(
      (await emailRequestCodeRoute(post(first.token, { email, class: 'phone' }), deps)).statusCode,
    ).toBe(200);
    const c1 = deps.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(first.token, { email, code: c1 }), deps)).statusCode).toBe(
      200,
    );
    const firstGroup = (await db.getUserById(first.userId))!.groupId!;
    canaries.add(firstGroup);
    // A DIFFERENT pristine account proves the same inbox and tries to attach:
    // the claim row already exists, so the attach transaction's
    // attribute_not_exists(userId) refuses — collapsed, indistinguishable from
    // any other refusal (the caller has no consented right to learn the
    // address is already claimed).
    const second = await mkAcct(deps);
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(
      (await emailRequestCodeRoute(post(second.token, { email, class: 'phone' }), deps)).statusCode,
    ).toBe(200);
    const c2 = deps.emailsSent.at(-1)!.code;
    expectRefused(await emailVerifyRoute(post(second.token, { email, code: c2 }), deps));
    // The claim still names the FIRST group only; the second account is ungrouped.
    const claimKey = activeEmailClaimKeys(KEYS, email)[0]!;
    expect((await db.getIdentifierClaim(claimKey))?.groupId).toBe(firstGroup);
    expect((await db.getUserById(second.userId))?.groupId).toBeUndefined();
  });

  gated('a suppressed address stops reaching the provider: the SES suppression answer writes the HMAC-keyed shadow, and the next send skips the seam — uniformly', async () => {
    const deps = freshDeps();
    const email = `suppressed-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    deps.setNextEmailOutcome('suppressed');
    const first = await emailRequestCodeRoute(
      post(acct.token, { email, class: 'phone' }),
      deps,
    );
    expect(first.statusCode).toBe(200);
    expect(deps.emailsSent).toHaveLength(1);
    // The shadow row exists, keyed by the versioned HMAC ref — never the
    // address (asserted by the dump grep above for the whole store).
    const hash = identifierClaimHash(TEST_KID, email);
    expect(await db.isIdentifierSuppressed(`emailsupp#v1#${hash}`, Math.floor(deps.now() / 1000))).toBe(true);
    // The next request never reaches the seam, and the answer is the same.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).toEqual(
      first,
    );
    expect(deps.emailsSent).toHaveLength(1);
  });
});

describe('refusal-uniformity and log-canary sweeps (the error paths, then the sinks)', () => {
  gated('recovery request-code answers IDENTICAL bytes for a linked and an unknown identifier, and only the linked one produces a send', async () => {
    const deps = freshDeps();
    const email = `linked-${RUN}@example.com`;
    const owner = await mkAcct(deps);
    expect(
      (
        await emailRequestCodeRoute(post(owner.token, { email, class: 'phone' }), deps)
      ).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(owner.token, { email, code }), deps)).statusCode).toBe(200);
    canaries.add((await db.getUserById(owner.userId))!.groupId!);

    const recovering = await mkAcct(deps);
    // Step past the linked address's resend cool-down (the owner's attach
    // request consumed it) so the HIT genuinely sends.
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    const sendsBefore = deps.emailsSent.length;
    const hit = await recoveryRequestCodeRoute(post(recovering.token, { email }), deps);
    expect(hit.statusCode).toBe(200);
    expect(deps.emailsSent.length).toBe(sendsBefore + 1);
    const missTaker = await mkAcct(deps);
    const miss = await recoveryRequestCodeRoute(
      post(missTaker.token, { email: `nobody-${RUN}@example.com` }),
      deps,
    );
    // BYTE-IDENTICAL: status, headers, body — registration state is exactly
    // what the caller has no consented right to resolve.
    expect(miss).toEqual(hit);
    expect(deps.emailsSent.length).toBe(sendsBefore + 1);

    // And a recovery VERIFY error path (wrong code) for the log sweep below.
    expectRefused(
      await recoveryVerifyRoute(
        post(recovering.token, { email, code: '000000', class: 'phone' }),
        deps,
      ),
    );
  });

  gated('a recovery request-code NEVER clobbers the caller\'s own pending ATTACH code — the registered-vs-not oracle is closed for a HIT and a MISS alike (gate fix)', async () => {
    const deps = freshDeps();
    // A registered address to probe (the HIT), stood up by its owner.
    const registered = `probed-${RUN}@example.com`;
    const owner = await mkAcct(deps);
    expect(
      (await emailRequestCodeRoute(post(owner.token, { email: registered, class: 'phone' }), deps))
        .statusCode,
    ).toBe(200);
    const ownerCode = deps.emailsSent.at(-1)!.code;
    expect(
      (await emailVerifyRoute(post(owner.token, { email: registered, code: ownerCode }), deps))
        .statusCode,
    ).toBe(200);
    canaries.add((await db.getUserById(owner.userId))!.groupId!);

    // For each probe outcome, a fresh pristine caller requests an ATTACH code
    // for its OWN address, probes via recovery request-code, then verifies its
    // OWN attach code. Pre-fix a HIT overwrote the shared code slot (purpose
    // flipped to 'recovery') and the attach verify then REFUSED, while a MISS
    // left it and the verify SUCCEEDED — a 200-vs-403 registration oracle. With
    // per-purpose slots the attach verify succeeds in BOTH cases: no oracle.
    for (const probe of [registered, `absent-${RUN}@example.com`]) {
      const own = `own-${seq}-${RUN}@example.com`;
      const caller = await mkAcct(deps);
      expect(
        (await emailRequestCodeRoute(post(caller.token, { email: own, class: 'phone' }), deps))
          .statusCode,
      ).toBe(200);
      const ownCode = deps.emailsSent.at(-1)!.code;
      deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
      expect(
        (await recoveryRequestCodeRoute(post(caller.token, { email: probe }), deps)).statusCode,
      ).toBe(200);
      // The attach verify for the caller's OWN address is UNAFFECTED by what
      // the probe resolved to (200 whether the probe HIT or MISSED).
      expect(
        (await emailVerifyRoute(post(caller.token, { email: own, code: ownCode }), deps)).statusCode,
      ).toBe(200);
      canaries.add((await db.getUserById(caller.userId))!.groupId!);
    }
  });

  gated('the recovery leg carries a PER-ACCOUNT daily send ceiling: one pristine account cycling distinct addresses is 429\'d past the pinned budget, so it cannot drain the fleet ceiling alone (gate fix)', async () => {
    const deps = freshDeps();
    const drainer = await mkAcct(deps);
    // Distinct never-registered addresses (each miss answers uniform 200), each
    // request spaced a full idroute minute apart so the 10/min burst limiter
    // refills and the DAILY per-account ceiling is what finally bites.
    for (let n = 1; n <= IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY; n++) {
      deps.advanceMs(60 * 1000);
      const res = await recoveryRequestCodeRoute(
        post(drainer.token, { email: `drain-${RUN}-${n}@example.com` }),
        deps,
      );
      expect(res.statusCode).toBe(200);
    }
    // The 11th: idroute has refilled, but the caller-keyed daily ceiling is
    // spent — a 429 (caller budgets keep their 429s; the address stays uniform).
    deps.advanceMs(60 * 1000);
    const over = await recoveryRequestCodeRoute(
      post(drainer.token, { email: `drain-${RUN}-over@example.com` }),
      deps,
    );
    expect(over.statusCode).toBe(429);
  });

  gated('K_id rotation is REAL: a claim resolved under a retiring version migrates forward to the newest, and a completed rotation orphans only what never resolved (gate fix)', async () => {
    const deps = freshDeps();
    const email = `rotate-${RUN}@example.com`;
    const acct = await mkAcct(deps);
    // Attach under the live (v1) key: the claim row sits at the v1 address and
    // the group's identifierRef names it.
    expect(
      (await emailRequestCodeRoute(post(acct.token, { email, class: 'phone' }), deps)).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(acct.token, { email, code }), deps)).statusCode).toBe(200);
    const groupId = (await db.getUserById(acct.userId))!.groupId!;
    canaries.add(groupId);
    const v1Key = activeEmailClaimKeys(KEYS, email)[0]!;
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([v1Key]);

    // A rotation window: v2 is the new K_id, v1 the retiring one. The forward
    // migration re-points the ref and moves the claim to v2.
    const K2 = 'test-identifier-hmac-key-v2';
    const v2Key = emailClaimKey(2, identifierClaimHash(K2, email));
    expect(v2Key).not.toBe(v1Key);
    const claim = (await db.getIdentifierClaim(v1Key))!;
    expect(await db.migrateIdentifierClaimForward({ oldClaimKey: v1Key, newClaimKey: v2Key, claim })).toBe(
      'migrated',
    );
    // The claim now lives at v2, the group names v2, and the v1 row is gone —
    // so retiring v1 orphans nothing that resolved.
    expect((await db.getIdentifierClaim(v2Key))?.groupId).toBe(groupId);
    expect(await db.getIdentifierClaim(v1Key)).toBeUndefined();
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([v2Key]);
    // Idempotent: a second migrate finds nothing to move.
    expect(await db.migrateIdentifierClaimForward({ oldClaimKey: v1Key, newClaimKey: v2Key, claim })).toBe(
      'noop',
    );
  });

  gated('every collapsed refusal observed in this suite is ONE byte-stream (status, headers, body)', async () => {
    expect(refusals.length).toBeGreaterThan(5);
    const canonical = accountsRefusal();
    for (const res of refusals) {
      expect(res.statusCode).toBe(canonical.statusCode);
      expect(res.headers).toEqual(canonical.headers);
      expect(res.body).toBe(canonical.body);
    }
  });

  gated('the log sink captured across attach/verify/recovery paths contains NEITHER the canary identifier NOR any member ULID', async () => {
    let lines = 0;
    for (const sink of allLogs) {
      for (const entry of sink) {
        lines++;
        const line = JSON.stringify(entry);
        expect(line.includes('@'), line).toBe(false);
        expect(line.toLowerCase().includes('canary'), line).toBe(false);
        for (const id of canaries) {
          expect(line.includes(id), `${entry.event} leaked ${id}`).toBe(false);
        }
      }
    }
    // The sweep must have seen real traffic, or it proves nothing.
    expect(lines).toBeGreaterThan(0);
  });
});
