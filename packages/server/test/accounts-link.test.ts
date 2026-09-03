import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  AccountsNotice,
  authSignedBytes,
  LINK_OFFER_TTL_SECONDS,
  linkOpSignedBytes,
  TABLES,
  type LinkOp,
  type LinkOpTuple,
  type LinkOfferInitResponse,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  IDKEY_CLAIM_PREFIX,
  LINK_INIT_KEY_PREFIX,
  LINK_OFFER_KEY_PREFIX,
  LINK_OFFER_POINTER_CAP,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
} from '../src/db/data.js';
import {
  authChallengeHandler,
  authHandler,
  verifyIdentitySignature,
} from '../src/handlers/auth-account.js';
import { accountsRefusal, linkOfferInitRoute } from '../src/handlers/devices.js';
import {
  deviceRevokeRoute,
  deviceUnlinkRoute,
  linkAcceptRoute,
  linkOfferSubmitRoute,
} from '../src/handlers/devices-signed.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, parseBody, type LogEntry, type TestDeps } from './helpers.js';

/**
 * Link/unlink/revoke endpoints against REAL DynamoDB and
 * REAL libsignal signatures — a mocked verifier would make the one property
 * that matters (only the holder of the identity private key can advance a
 * ceremony or mutate a roster) untestable.
 *
 * Refusal discipline is asserted BYTE-IDENTICALLY: every refused case below
 * is collected and deep-equalled — body AND status AND headers — against the
 * one shared exit (`accountsRefusal`), so a branch that grows its own error
 * shape fails here first.
 *
 * The `feature#accounts` flag is process-local here (an override of the one
 * read method): the REAL row is a store-wide singleton the suite
 * (accounts-group) already drives through absent/true/malformed/deleted
 * against the real store, and two suites toggling one singleton row while
 * the heavy project runs files in parallel would race each other into
 * flakes. The gate ORDER and collapse are accounts-flag-gate.test.ts's.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;

// Digits only (valid Crockford base32). The trailing '31' is a per-FILE
// discriminator: the three suites load within the same millisecond when
// the heavy project runs them in parallel forks, and a bare Date.now run
// id minted IDENTICAL ULIDs across files (measured — cross-suite claim-row
// collisions in getOrCreateUserByIdentityKey).
const RUN = `${Date.now()}31`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Canary ids (member ULIDs, groupIds) that must NEVER appear in a retained
 * log line. */
const canaries = new Set<string>();
/** Every log sink minted this run — scanned by the canary test. */
const allLogs: LogEntry[][] = [];
/** Every collapsed refusal observed — deep-equalled by the byte-identity
 * test at the end. */
const refusals: HttpResult[] = [];

function freshDeps(): TestDeps {
  const deps = makeTestDeps(db);
  allLogs.push(deps.logs);
  return deps;
}

interface Acct {
  userId: string;
  key: PrivateKey;
  pub: string;
  token: string;
}

async function mkAcct(deps: TestDeps): Promise<Acct> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const userId = uid();
  canaries.add(userId);
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `link-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 3600,
  });
  return { userId, key, pub, token };
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

function sign(op: LinkOp, tuple: LinkOpTuple, key: PrivateKey): string {
  const pre = linkOpSignedBytes(op, tuple);
  const buf = new Uint8Array(new ArrayBuffer(pre.length));
  buf.set(pre);
  return Buffer.from(key.sign(buf)).toString('base64');
}

/** Assert THE collapsed refusal — one byte-stream, recorded for the
 * cross-case identity test. */
function expectRefused(res: HttpResult): void {
  refusals.push(res);
  expect(res).toEqual(accountsRefusal());
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

/** Run the INIT leg for a→b and return the minted tuple. */
async function initOffer(
  deps: TestDeps,
  a: Acct,
  b: Acct,
  opts: { acceptorClass?: string; offererClass?: string | undefined } = {},
): Promise<LinkOfferInitResponse> {
  const res = await linkOfferInitRoute(
    post(a.token, {
      acceptorUserId: b.userId,
      acceptorClass: opts.acceptorClass ?? 'tablet',
      ...('offererClass' in opts
        ? opts.offererClass !== undefined
          ? { offererClass: opts.offererClass }
          : {}
        : { offererClass: 'phone' }),
    }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  const init = parseBody<LinkOfferInitResponse>(res.body);
  canaries.add(init.groupId);
  return init;
}

function offerTuple(init: LinkOfferInitResponse, a: Acct, b: Acct): LinkOpTuple {
  return {
    groupId: init.groupId,
    offererUserId: a.userId,
    acceptorUserId: b.userId,
    subjectIdentityPubKey: b.pub,
    class: 'tablet',
    rosterEpoch: init.rosterEpoch,
    offerNonce: init.offerNonce,
    expiresAt: init.expiresAt,
  };
}

/** Full ceremony a(phone) + b(tablet): init → submit → accept. */
async function linkPair(deps: TestDeps, a: Acct, b: Acct): Promise<LinkOfferInitResponse> {
  const init = await initOffer(deps, a, b);
  const submit = await linkOfferSubmitRoute(
    post(a.token, {
      offerNonce: init.offerNonce,
      signature: sign('offer', offerTuple(init, a, b), a.key),
    }),
    deps,
  );
  expect(submit.statusCode).toBe(200);
  const accept = await linkAcceptRoute(
    post(b.token, {
      offerNonce: init.offerNonce,
      signature: sign('accept', { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub }, b.key),
    }),
    deps,
  );
  expect(accept.statusCode).toBe(200);
  return init;
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  // Process-local flag override (see header): every OTHER method is the real
  // store. The routes under test read the flag through this exact call.
  db = { ...base, isAccountsFeatureEnabled: async () => true };
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

afterAll(() => {
  // nothing global to restore: the flag override never touched the store.
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

// ---------------------------------------------------------------------------
// REFUSAL CASES FIRST (TDD order; every one must be the collapsed refusal).
// ---------------------------------------------------------------------------

describe('collapsed refusals (one exit, one byte-stream)', () => {
  gated('a signed offer whose tuple disagrees with the recorded init row is REFUSED (first-link circularity fix)', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    // A signs a DIFFERENT groupId than the init row recorded — a client
    // choosing its own groupId/epoch matches no init row and dies here.
    const lying = { ...offerTuple(init, a, b), groupId: uid() };
    expectRefused(
      await linkOfferSubmitRoute(
        post(a.token, { offerNonce: init.offerNonce, signature: sign('offer', lying, a.key) }),
        deps,
      ),
    );
    // ...and no offer row was minted: the init row is still the only state.
    expect(await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${init.offerNonce}` })).toBeUndefined();
  });

  gated('a bearer token alone cannot advance a ceremony: submit without any identity signature is REFUSED', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    expectRefused(
      await linkOfferSubmitRoute(post(a.token, { offerNonce: init.offerNonce }), deps),
    );
  });

  gated('a forged acceptance signature is REFUSED', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    const submit = await linkOfferSubmitRoute(
      post(a.token, {
        offerNonce: init.offerNonce,
        signature: sign('offer', offerTuple(init, a, b), a.key),
      }),
      deps,
    );
    expect(submit.statusCode).toBe(200);
    // The RIGHT tuple signed by the WRONG key (a key the attacker holds).
    const forger = PrivateKey.generate();
    expectRefused(
      await linkAcceptRoute(
        post(b.token, {
          offerNonce: init.offerNonce,
          signature: sign(
            'accept',
            { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
            forger,
          ),
        }),
        deps,
      ),
    );
    // Nothing linked.
    expect(await db.getAccountGroup(init.groupId)).toBeUndefined();
  });

  gated('an expired-but-unreaped offer is REFUSED — the explicit expiry decides, never TTL reaping', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    const submit = await linkOfferSubmitRoute(
      post(a.token, {
        offerNonce: init.offerNonce,
        signature: sign('offer', offerTuple(init, a, b), a.key),
      }),
      deps,
    );
    expect(submit.statusCode).toBe(200);
    // Cross the offer's own expiry. DynamoDB Local reaps nothing, so the row
    // is still physically present — exactly the expired-but-unreaped state.
    deps.advanceMs((LINK_OFFER_TTL_SECONDS + 1) * 1000);
    const raw = await rawRow(SERVER_TABLES.sessions, {
      token: `${LINK_OFFER_KEY_PREFIX}${init.offerNonce}`,
    });
    expect(raw).toBeDefined(); // unreaped...
    expectRefused(
      await linkAcceptRoute(
        post(b.token, {
          offerNonce: init.offerNonce,
          signature: sign(
            'accept',
            { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
            b.key,
          ),
        }),
        deps,
      ),
    ); // ...refused anyway.
  });

  gated('a stale-epoch offer is REFUSED — an acceptance never lands over a roster that moved after signing', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const c = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    // The group sits at epoch 1. Plant an offer signed against epoch 5 —
    // the data layer stores it (opaque), the transaction refuses it.
    const nonce = uid();
    const expiresAt = Math.floor(deps.now() / 1000) + LINK_OFFER_TTL_SECONDS;
    expect(
      await db.putLinkOffer({
        offerNonce: nonce,
        groupId: init.groupId,
        offererUserId: a.userId,
        acceptorUserId: c.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 5,
        expiresAt,
        offerSig: sign(
          'offer',
          {
            groupId: init.groupId,
            offererUserId: a.userId,
            acceptorUserId: c.userId,
            subjectIdentityPubKey: c.pub,
            class: 'tablet',
            rosterEpoch: 5,
            offerNonce: nonce,
            expiresAt,
          },
          a.key,
        ),
      }),
    ).toBe('created');
    expectRefused(
      await linkAcceptRoute(
        post(c.token, {
          offerNonce: nonce,
          signature: sign(
            'accept',
            {
              groupId: init.groupId,
              offererUserId: a.userId,
              acceptorUserId: c.userId,
              subjectIdentityPubKey: a.pub,
              class: 'tablet',
              rosterEpoch: 5,
              offerNonce: nonce,
              expiresAt,
            },
            c.key,
          ),
        }),
        deps,
      ),
    );
  });

  gated('a reused nonce is REFUSED — offers are single-use, consumed by the winning transaction', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    // Replay B's own acceptance verbatim: the offer row is gone.
    expectRefused(
      await linkAcceptRoute(
        post(b.token, {
          offerNonce: init.offerNonce,
          signature: sign(
            'accept',
            { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
            b.key,
          ),
        }),
        deps,
      ),
    );
  });

  /** A signed mutation request for the unlink/revoke routes. */
  function mutationReq(
    init: LinkOfferInitResponse,
    actor: Acct,
    target: Acct,
    op: 'unlink' | 'revoke',
    targetClass: 'phone' | 'tablet',
    epoch: number,
    nowSec: number,
  ): HttpEvent {
    const nonce = uid();
    const expiresAt = nowSec + 600;
    const tuple: LinkOpTuple = {
      groupId: init.groupId,
      offererUserId: actor.userId,
      acceptorUserId: target.userId,
      subjectIdentityPubKey: target.pub,
      class: targetClass,
      rosterEpoch: epoch,
      offerNonce: nonce,
      expiresAt,
    };
    return post(actor.token, {
      groupId: init.groupId,
      targetUserId: target.userId,
      targetClass,
      rosterEpoch: epoch,
      offerNonce: nonce,
      expiresAt,
      signature: sign(op, tuple, actor.key),
    });
  }

  gated('TOCTOU: two mutations signed at the SAME epoch, applied concurrently — exactly one commits; the loser is REFUSED', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    const nowSec = Math.floor(deps.now() / 1000);
    // Mutual amicable unlinks (neither tombstones the other's SESSION, so
    // the loser's refusal is the roster serialization, never a dead bearer).
    const [aRes, bRes] = await Promise.all([
      deviceUnlinkRoute(mutationReq(init, a, b, 'unlink', 'tablet', 1, nowSec), deps),
      deviceUnlinkRoute(mutationReq(init, b, a, 'unlink', 'phone', 1, nowSec), deps),
    ]);
    // Exactly ONE commits.
    expect([aRes.statusCode, bRes.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const loser = aRes.statusCode === 200 ? bRes : aRes;
    // The loser is REFUSED. Almost always the collapsed refusal (the roster
    // serialization); in one legal interleaving the WINNER's teardown has
    // already deleted the loser's session before the loser's bearer check
    // ran, and the refusal is the standard 401 — itself proof exactly one
    // mutation committed. The deterministic condition-vs-precheck proof is
    // the next test's, where no interleaving exists to blur it.
    expect([401, 403]).toContain(loser.statusCode);
    if (loser.statusCode === 403) expectRefused(loser);
    // Exactly ONE mutation landed: the epoch moved once, one member left.
    const group = await db.getAccountGroup(init.groupId);
    expect(group?.epoch).toBe(2);
    expect(group?.members).toHaveLength(1);
    const aRow = await rawRow(SERVER_TABLES.users, { userId: a.userId });
    const bRow = await rawRow(SERVER_TABLES.users, { userId: b.userId });
    expect([aRow?.groupId, bRow?.groupId].filter((g) => g === init.groupId)).toHaveLength(1);
  });

  gated('the ConditionExpression is the authorization, not the precheck: a passing precheck with a failing condition still refuses', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    // Make the precheck and the condition DISAGREE (the corrupt-derived-
    // set construction): the handler's precheck reads `members` (A present —
    // passes); the transaction's `contains(memberIds,:actor)` reads the
    // derived set, from which A is removed here. The refusal that follows
    // can therefore ONLY be the condition's.
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: `group#${init.groupId}` },
        UpdateExpression: 'DELETE memberIds :a',
        ExpressionAttributeValues: { ':a': new Set([a.userId]) },
      }),
    );
    const nowSec = Math.floor(deps.now() / 1000);
    expectRefused(
      await deviceUnlinkRoute(mutationReq(init, a, b, 'unlink', 'tablet', 1, nowSec), deps),
    );
    // Nothing committed: epoch unmoved, both members still present.
    const group = await db.getAccountGroup(init.groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members).toHaveLength(2);
  });

  gated('mid-ceremony pristineness race: the joiner gaining a groupId between submit and accept is REFUSED by the transaction condition', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    const submit = await linkOfferSubmitRoute(
      post(a.token, {
        offerNonce: init.offerNonce,
        signature: sign('offer', offerTuple(init, a, b), a.key),
      }),
      deps,
    );
    expect(submit.statusCode).toBe(200);
    // Simulate the raceable class: an identifier attach
    // lazily creating B a solo group AFTER the submit-leg precheck passed.
    // Raw write on purpose — the precheck cannot see it and must not be
    // what refuses; the accept transaction's attribute_not_exists(groupId)
    // condition is.
    const lazyGroup = uid();
    canaries.add(lazyGroup);
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: b.userId },
        UpdateExpression: 'SET groupId = :g',
        ExpressionAttributeValues: { ':g': lazyGroup },
      }),
    );
    expectRefused(
      await linkAcceptRoute(
        post(b.token, {
          offerNonce: init.offerNonce,
          signature: sign(
            'accept',
            { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
            b.key,
          ),
        }),
        deps,
      ),
    );
    // The ceremony's group was never born.
    expect(await db.getAccountGroup(init.groupId)).toBeUndefined();
  });

  gated('class=desktop is REFUSED — the slot is a schema reservation only', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    expectRefused(
      await linkOfferInitRoute(
        post(a.token, { acceptorUserId: b.userId, acceptorClass: 'desktop', offererClass: 'phone' }),
        deps,
      ),
    );
    expectRefused(
      await linkOfferInitRoute(
        post(a.token, { acceptorUserId: b.userId, acceptorClass: 'tablet', offererClass: 'desktop' }),
        deps,
      ),
    );
  });

  gated('cross-group steal: an acceptance for a ULID the offer never named is REFUSED', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const thief = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    const submit = await linkOfferSubmitRoute(
      post(a.token, {
        offerNonce: init.offerNonce,
        signature: sign('offer', offerTuple(init, a, b), a.key),
      }),
      deps,
    );
    expect(submit.statusCode).toBe(200);
    // The thief holds the nonce (delivered notices are not secrets) and a
    // perfectly valid signature under its OWN registered key.
    expectRefused(
      await linkAcceptRoute(
        post(thief.token, {
          offerNonce: init.offerNonce,
          signature: sign(
            'accept',
            { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
            thief.key,
          ),
        }),
        deps,
      ),
    );
    expect(await db.getAccountGroup(init.groupId)).toBeUndefined();
  });

  gated('a NON-MEMBER cannot mutate a roster it does not belong to: a stranger’s signed unlink is REFUSED by the transaction’s membership condition', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const stranger = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    const nowSec = Math.floor(deps.now() / 1000);
    // The stranger holds a valid account + identity key and signs a well-formed
    // unlink of b — but it is in nobody's roster. `contains(memberIds,:actor)`
    // is the ONLY place membership is enforced and it refuses here: the
    // base authorization property no earlier test drove through the handler.
    expectRefused(
      await deviceUnlinkRoute(mutationReq(init, stranger, b, 'unlink', 'tablet', 1, nowSec), deps),
    );
    // Nothing moved: epoch unchanged, both members present.
    const group = await db.getAccountGroup(init.groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members).toHaveLength(2);
  });

  gated('a mutation whose expiresAt is beyond the server ceiling is REFUSED — a captured signature is never a multi-year replay capability', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await linkPair(deps, a, b);
    const nowSec = Math.floor(deps.now() / 1000);
    // One second past the pinned ceiling (one offer TTL from now). An earlier shape
    // gave the signer the expiry with NO server maximum, so `now + 20 years`
    // was accepted; the ceiling caps replay to at most one offer TTL.
    const farFuture = nowSec + LINK_OFFER_TTL_SECONDS + 1;
    const nonce = uid();
    const tuple: LinkOpTuple = {
      groupId: init.groupId,
      offererUserId: a.userId,
      acceptorUserId: b.userId,
      subjectIdentityPubKey: b.pub,
      class: 'tablet',
      rosterEpoch: 1,
      offerNonce: nonce,
      expiresAt: farFuture,
    };
    expectRefused(
      await deviceRevokeRoute(
        post(a.token, {
          groupId: init.groupId,
          targetUserId: b.userId,
          targetClass: 'tablet',
          rosterEpoch: 1,
          offerNonce: nonce,
          expiresAt: farFuture,
          signature: sign('revoke', tuple, a.key),
        }),
        deps,
      ),
    );
    // Nothing committed: b is still a member, untombstoned.
    expect((await db.getAccountGroup(init.groupId))?.members).toHaveLength(2);
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.tombstoned).toBeUndefined();
  });

  gated('every refusal above is ONE byte-stream: deep-equal on body AND status AND headers', async () => {
    // The cases above pushed every refusal they saw; a branch that grew its
    // own error shape (a zod detail, a distinct code, an extra header) fails
    // HERE even if its own test forgot to look.
    expect(refusals.length).toBeGreaterThanOrEqual(10);
    const canonical = accountsRefusal();
    for (const r of refusals) {
      expect(r.statusCode).toBe(canonical.statusCode);
      expect(r.headers).toEqual(canonical.headers);
      expect(r.body).toBe(canonical.body);
    }
  });
});

// ---------------------------------------------------------------------------
// The ceremony itself.
// ---------------------------------------------------------------------------

describe('link ceremony happy path', () => {
  gated('init mints the tuple; submit verifies A and writes the offer; accept verifies B and commits the group', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);

    const init = await initOffer(deps, a, b);
    expect(init.rosterEpoch).toBe(0);
    expect(init.expiresAt).toBe(Math.floor(deps.now() / 1000) + LINK_OFFER_TTL_SECONDS);
    // The init row exists; no offer row does (no signature yet).
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_INIT_KEY_PREFIX}${init.offerNonce}` }),
    ).toBeDefined();
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${init.offerNonce}` }),
    ).toBeUndefined();

    const offerSig = sign('offer', offerTuple(init, a, b), a.key);
    const submit = await linkOfferSubmitRoute(
      post(a.token, { offerNonce: init.offerNonce, signature: offerSig }),
      deps,
    );
    expect(submit.statusCode).toBe(200);
    // Init row CONSUMED (single-use), offer row born carrying A's signature.
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_INIT_KEY_PREFIX}${init.offerNonce}` }),
    ).toBeUndefined();
    const offerRow = await rawRow(SERVER_TABLES.sessions, {
      token: `${LINK_OFFER_KEY_PREFIX}${init.offerNonce}`,
    });
    expect(offerRow?.offerSig).toBe(offerSig);

    // Offer delivery rode the durable queue: B's queue holds
    // an 'accounts' row whose payload is the linkOffer notice.
    const queued = await allQueued(db, b.userId);
    const noticeRow = queued.find((m) => m.type === 'accounts');
    expect(noticeRow).toBeDefined();
    const notice = AccountsNotice.parse(
      JSON.parse(Buffer.from(noticeRow!.payload, 'base64').toString('utf8')),
    );
    expect(notice).toMatchObject({
      kind: 'linkOffer',
      groupId: init.groupId,
      offererUserId: a.userId,
      acceptorUserId: b.userId,
      offerNonce: init.offerNonce,
    });

    const acceptSig = sign(
      'accept',
      { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub },
      b.key,
    );
    const accept = await linkAcceptRoute(
      post(b.token, { offerNonce: init.offerNonce, signature: acceptSig }),
      deps,
    );
    expect(accept.statusCode).toBe(200);

    const group = await db.getAccountGroup(init.groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => [m.userId, m.class])).toEqual([
      [a.userId, 'phone'],
      [b.userId, 'tablet'],
    ]);
    // BOTH ceremony signatures persisted as the link certificates.
    for (const member of group?.members ?? []) {
      expect(member.certs!.offerSig).toBe(offerSig);
      expect(member.certs!.acceptSig).toBe(acceptSig);
    }
    // ..and the certificates verify: the stored tuple context re-derives
    // both pinned preimages against the parties' REGISTERED keys.
    const certs = group!.members[0]!.certs!;
    expect(
      verifyIdentitySignature(
        a.pub,
        linkOpSignedBytes('offer', {
          groupId: certs.groupId,
          offererUserId: certs.offererUserId,
          acceptorUserId: certs.acceptorUserId,
          subjectIdentityPubKey: b.pub,
          class: certs.class,
          rosterEpoch: certs.rosterEpoch,
          offerNonce: certs.offerNonce,
          expiresAt: certs.expiresAt,
        }),
        certs.offerSig,
      ),
    ).toBe(true);
    // Both user rows stamped.
    expect((await rawRow(SERVER_TABLES.users, { userId: a.userId }))?.groupId).toBe(init.groupId);
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.groupId).toBe(init.groupId);
  });
});

// ---------------------------------------------------------------------------
// Per-op byte vectors (the pinned bindings).
// ---------------------------------------------------------------------------

describe('per-op byte vectors (packages/shared/linkvectors.json)', () => {
  interface VectorCase {
    op: LinkOp;
    groupId: string;
    offererUserId: string;
    acceptorUserId: string;
    subjectIdentityPubKey: string;
    class: 'phone' | 'tablet' | 'desktop';
    rosterEpoch: number;
    offerNonce: string;
    expiresAt: number;
    signerIdentityKeyB64: string;
    preimageHex: string;
    signatureB64: string;
  }
  const vectors = JSON.parse(
    readFileSync(new URL('../../shared/linkvectors.json', import.meta.url), 'utf8'),
  ) as { domain: string; cases: VectorCase[] };

  it('carries all five ops under the pinned domain', () => {
    expect(vectors.domain).toBe('tacendum-link-v1');
    expect(vectors.cases.map((c) => c.op).sort()).toEqual(
      ['accept', 'dissolve', 'offer', 'revoke', 'unlink'].sort(),
    );
  });

  for (const op of ['offer', 'accept', 'unlink', 'revoke', 'dissolve'] as const) {
    it(`${op}: the preimage builder reproduces the pinned bytes and the signature verifies — a one-byte mutation fails`, () => {
      const c = vectors.cases.find((v) => v.op === op)!;
      const pre = linkOpSignedBytes(c.op, {
        groupId: c.groupId,
        offererUserId: c.offererUserId,
        acceptorUserId: c.acceptorUserId,
        subjectIdentityPubKey: c.subjectIdentityPubKey,
        class: c.class,
        rosterEpoch: c.rosterEpoch,
        offerNonce: c.offerNonce,
        expiresAt: c.expiresAt,
      });
      expect(Buffer.from(pre).toString('hex')).toBe(c.preimageHex);
      // The same server verify the auth path uses (named machinery).
      expect(verifyIdentitySignature(c.signerIdentityKeyB64, pre, c.signatureB64)).toBe(true);
      // A flipped byte in ANY structural region fails — not just the fixed
      // 16-byte domain prefix "tacendum-link-v1" (mutating byte 7,
      // the 'm' of the domain, proved only that verification is
      // signature-over-bytes, exercising none of the op frame, the uint16
      // length prefixes, or the nine field encodings the vector exists to pin).
      // Cover a length-prefix byte (16, the op's length hi byte), an op-frame
      // byte (18), a mid-preimage field byte, and the last field byte; each
      // must break the signature.
      const flipPositions = [16, 18, Math.floor(pre.length / 2), pre.length - 1];
      for (const pos of flipPositions) {
        const mutated = Uint8Array.from(pre);
        mutated[pos]! ^= 0x01;
        expect(
          verifyIdentitySignature(c.signerIdentityKeyB64, mutated, c.signatureB64),
          `flip@${pos}`,
        ).toBe(false);
      }
    });
  }

  it('the op frame alone separates the five ops: one tuple never yields two byte-streams', () => {
    const c = vectors.cases.find((v) => v.op === 'offer')!;
    const tuple = {
      groupId: c.groupId,
      offererUserId: c.offererUserId,
      acceptorUserId: c.acceptorUserId,
      subjectIdentityPubKey: c.subjectIdentityPubKey,
      class: c.class,
      rosterEpoch: c.rosterEpoch,
      offerNonce: c.offerNonce,
      expiresAt: c.expiresAt,
    };
    const streams = (['offer', 'accept', 'unlink', 'revoke', 'dissolve'] as const).map((op) =>
      Buffer.from(linkOpSignedBytes(op, tuple)).toString('hex'),
    );
    expect(new Set(streams).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Revoke-with-tombstone against the REAL auth handler.
// ---------------------------------------------------------------------------

describe('revoke-with-tombstone', () => {
  let ipSeq = 0;
  /** An account minted through the REAL keypair auth flow — challenge,
   * libsignal signature, POST /v1/auth — so the tombstone case below drives
   * the handler production runs, not a mock of it. */
  async function realAuthAcct(deps: TestDeps): Promise<Acct> {
    const key = PrivateKey.generate();
    const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
    const ip = `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
    const chalRes = await authChallengeHandler(
      { method: 'POST', path: '/', headers: {}, body: JSON.stringify({ identityKey: pub }), sourceIp: ip },
      deps,
    );
    expect(chalRes.statusCode).toBe(200);
    const { challenge } = parseBody<{ challenge: string }>(chalRes.body);
    const signed = authSignedBytes(deps.apiOrigin, challenge);
    const buf = new Uint8Array(new ArrayBuffer(signed.length));
    buf.set(signed);
    const authRes = await authHandler(
      {
        method: 'POST',
        path: '/',
        headers: {},
        body: JSON.stringify({
          identityKey: pub,
          challenge,
          signature: Buffer.from(key.sign(buf)).toString('base64'),
        }),
        sourceIp: ip,
      },
      deps,
    );
    expect(authRes.statusCode).toBe(200);
    const { userId, authToken } = parseBody<{ userId: string; authToken: string }>(authRes.body);
    canaries.add(userId);
    return { userId, key, pub, token: authToken };
  }

  gated('after a signed revoke, the victim key gets 403 identity_tombstoned from the REAL auth handler', async () => {
    const deps = freshDeps();
    const a = await realAuthAcct(deps);
    const b = await realAuthAcct(deps);
    const init = await linkPair(deps, a, b);

    const nowSec = Math.floor(deps.now() / 1000);
    const nonce = uid();
    const expiresAt = nowSec + 600;
    const revoke = await deviceRevokeRoute(
      post(a.token, {
        groupId: init.groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: nonce,
        expiresAt,
        signature: sign(
          'revoke',
          {
            groupId: init.groupId,
            offererUserId: a.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: nonce,
            expiresAt,
          },
          a.key,
        ),
      }),
      deps,
    );
    expect(revoke.statusCode).toBe(200);

    // The claim row is tombstoned...
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: `${IDKEY_CLAIM_PREFIX}${b.pub}` }))?.tombstoned,
    ).toBe(true);

    // ...and the REAL auth path refuses the key, terminally. The signature
    // below VERIFIES — the caller is authentic, the KEY is dead.
    const ip = `10.9.99.${(ipSeq++ % 250) + 1}`;
    const chalRes = await authChallengeHandler(
      { method: 'POST', path: '/', headers: {}, body: JSON.stringify({ identityKey: b.pub }), sourceIp: ip },
      deps,
    );
    expect(chalRes.statusCode).toBe(200);
    const { challenge } = parseBody<{ challenge: string }>(chalRes.body);
    const signed = authSignedBytes(deps.apiOrigin, challenge);
    const buf = new Uint8Array(new ArrayBuffer(signed.length));
    buf.set(signed);
    const authRes = await authHandler(
      {
        method: 'POST',
        path: '/',
        headers: {},
        body: JSON.stringify({
          identityKey: b.pub,
          challenge,
          signature: Buffer.from(b.key.sign(buf)).toString('base64'),
        }),
        sourceIp: ip,
      },
      deps,
    );
    expect(authRes.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(authRes.body).error.code).toBe(
      'identity_tombstoned',
    );
    // The dead row keeps the forwarding hint.
    const bRow = await rawRow(SERVER_TABLES.users, { userId: b.userId });
    expect(bRow?.tombstoned).toBe(true);
    expect(bRow?.formerGroupId).toBe(init.groupId);
  });
});

// ---------------------------------------------------------------------------
// The acceptor's reverse pointer is written on
// the OFFERER's signature — and A is the caller — so any account that knew a
// solo user's ULID could grow that user's row 10×/hour per free identity until
// the 400 KB item cap bricked it, and nothing ever removed the pointer of an
// offer B never accepted. Three layers, each driven against the real store.
// ---------------------------------------------------------------------------

describe('reverse-pointer growth is bounded', () => {
  const submitFor = (deps: TestDeps, a: Acct, b: Acct, init: LinkOfferInitResponse) =>
    linkOfferSubmitRoute(
      post(a.token, {
        offerNonce: init.offerNonce,
        signature: sign('offer', offerTuple(init, a, b), a.key),
      }),
      deps,
    );
  const pointers = async (userId: string): Promise<Set<string>> =>
    ((await rawRow(SERVER_TABLES.users, { userId }))?.linkOfferNonces as Set<string> | undefined) ??
    new Set();

  gated('LAYER 1 — a RECIPIENT-keyed budget bounds ceremonies aimed at one account: Sybil offerers exhaust `linkoffer-rcpt:<B>`, the refusal is the collapsed one, B\'s row holds only the admitted pointers, and the window refills on its own clock', async () => {
    const deps = freshDeps();
    const b = await mkAcct(deps);
    const sybils = [await mkAcct(deps), await mkAcct(deps), await mkAcct(deps)];
    // Init AND submit each charge B's window (capacity 5): two whole
    // ceremonies fit, the third Sybil's submit is the sixth take — refused
    // collapsed, through the one exit, with its OWN offerer budget untouched.
    for (const a of sybils.slice(0, 2)) {
      expect((await submitFor(deps, a, b, await initOffer(deps, a, b))).statusCode).toBe(200);
    }
    const third = await initOffer(deps, sybils[2]!, b);
    expectRefused(await submitFor(deps, sybils[2]!, b, third));
    expect((await pointers(b.userId)).size).toBe(2);
    // An hour on the window has refilled (10/hour) and a fresh ceremony lands.
    deps.advanceMs(3600 * 1000);
    const fourth = await mkAcct(deps);
    expect((await submitFor(deps, fourth, b, await initOffer(deps, fourth, b))).statusCode).toBe(200);
    expect((await pointers(b.userId)).size).toBe(3);
  });

  gated('LAYER 2 — the pointer set is CAPPED at LINK_OFFER_POINTER_CAP as a transaction condition, and a FULL set self-heals: the refusing write reaps every nonce whose rows are gone or expired, then lands', async () => {
    const deps = freshDeps();
    const b = await mkAcct(deps);
    const nowS = Math.floor(deps.now() / 1000);
    // One offerer per ceremony, so only B's set — the row the caller does
    // NOT own — approaches the cap.
    const offerer = async (): Promise<string> => {
      const id = uid();
      canaries.add(id);
      expect((await db.getOrCreateUserByIdentityKey(`idkey-${id}`, id, deps.now())).kind).toBe('ok');
      return id;
    };
    const promote = async (expiresAt: number, at: number) => {
      const offerNonce = uid();
      expect(
        await db.putLinkOfferInit(
          {
            offerNonce,
            groupId: uid(),
            offererUserId: await offerer(),
            acceptorUserId: b.userId,
            acceptorClass: 'tablet',
            offererClass: 'phone',
            rosterEpoch: 0,
            expiresAt,
          },
          at,
        ),
      ).toBe('created');
      return db.promoteLinkOfferInit(offerNonce, 'c2ln', at);
    };
    for (let i = 0; i < LINK_OFFER_POINTER_CAP; i++) {
      expect(await promote(nowS + LINK_OFFER_TTL_SECONDS, nowS)).toBe('promoted');
    }
    expect((await pointers(b.userId)).size).toBe(LINK_OFFER_POINTER_CAP);
    // One more while every earlier offer is still LIVE: refused at the
    // condition — the row cannot grow past the cap however many push on it.
    expect(await promote(nowS + LINK_OFFER_TTL_SECONDS, nowS)).toBe('pointer_cap');
    expect((await pointers(b.userId)).size).toBe(LINK_OFFER_POINTER_CAP);
    // Past every earlier expiry — rows physically present, DynamoDB Local
    // reaps nothing — the refusing write reaps the dead pointers and lands.
    const later = nowS + LINK_OFFER_TTL_SECONDS + 1;
    expect(await promote(later + LINK_OFFER_TTL_SECONDS, later)).toBe('promoted');
    expect((await pointers(b.userId)).size).toBe(1);
  });

  gated('LAYER 3 — an EXPIRED offer met at the refusing read reaps BOTH parties\' pointers; an expired INIT met at submit reaps the offerer\'s — the rows themselves stay for the TTL, refused at every read', async () => {
    const deps = freshDeps();
    const a = await mkAcct(deps);
    const b = await mkAcct(deps);
    const init = await initOffer(deps, a, b);
    expect((await submitFor(deps, a, b, init)).statusCode).toBe(200);
    expect((await pointers(a.userId)).has(init.offerNonce)).toBe(true);
    expect((await pointers(b.userId)).has(init.offerNonce)).toBe(true);
    deps.advanceMs((LINK_OFFER_TTL_SECONDS + 1) * 1000);
    expectRefused(
      await linkAcceptRoute(
        post(b.token, {
          offerNonce: init.offerNonce,
          signature: sign('accept', { ...offerTuple(init, a, b), subjectIdentityPubKey: a.pub }, b.key),
        }),
        deps,
      ),
    );
    expect((await pointers(a.userId)).has(init.offerNonce)).toBe(false);
    expect((await pointers(b.userId)).has(init.offerNonce)).toBe(false);
    // Pointer-only: the expired row is still physically present (DynamoDB
    // Local reaps nothing) and still refused — every reader classifies it
    // on its own terms, exactly as before.
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${init.offerNonce}` }),
    ).toBeDefined();
    // The init-only half: opened, never submitted in time.
    const stale = await initOffer(deps, a, b);
    expect((await pointers(a.userId)).has(stale.offerNonce)).toBe(true);
    deps.advanceMs((LINK_OFFER_TTL_SECONDS + 1) * 1000);
    expectRefused(await submitFor(deps, a, b, stale));
    expect((await pointers(a.userId)).has(stale.offerNonce)).toBe(false);
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_INIT_KEY_PREFIX}${stale.offerNonce}` }),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 5: the retained log never holds a canary id.
// ---------------------------------------------------------------------------

describe('log-canary discipline', () => {
  gated('no member ULID and no groupId from any flow above appears in any retained log line', async () => {
    expect(canaries.size).toBeGreaterThanOrEqual(10);
    const retained = JSON.stringify(allLogs);
    for (const id of canaries) {
      expect(retained).not.toContain(id);
    }
  });
});
