import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import { authSignedBytes, TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import { authChallengeHandler, authHandler } from '../src/handlers/auth-account.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * The one-session-supersedes rule stays STRICT for integration class under
 * grouping: two concurrent auths on ONE integration
 * account — the owner's real machine and a thief holding a copied key — still
 * supersede each other, with the owner GROUPED. The rule exists for exactly
 * the key-theft case, and grouping relaxes nothing about it
 * (auth-account.ts's revoke-supersedes property): per-ULID the supersede
 * stays exactly right — a sibling device is its own ULID with its own
 * sessions, untouched.
 *
 * Driven through the REAL auth handlers against REAL DynamoDB with REAL
 * libsignal signatures; "concurrent" is stated honestly as what the store
 * permits: BOTH challenges are outstanding at once (neither auth invalidates
 * the other's nonce — challenges are per-(key, nonce) rows), and whichever
 * auth completes later kills the earlier session.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: DataLayer;
let available = false;
let deps: TestDeps;

// Digits only; '34' is this FILE's discriminator (the accounts-link '31'
// rule for parallel heavy forks).
const RUN = `${Date.now()}34`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

let ipSeq = 0;
function post(path: string, body: unknown): HttpEvent {
  ipSeq++;
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    pathParameters: {},
    body: JSON.stringify(body),
    sourceIp: `198.51.101.${ipSeq % 250}`,
  };
}

interface Identity {
  priv: PrivateKey;
  publicB64: string;
}

function newIdentity(): Identity {
  const priv = PrivateKey.generate();
  return { priv, publicB64: Buffer.from(priv.getPublicKey().serialize()).toString('base64') };
}

/** Sign exactly what the server verifies, through the SHARED builder (the
 * auth-account.test.ts rule: a hand-rebuilt format agrees only with itself). */
function sign(identity: Identity, challengeB64: string): string {
  const message = authSignedBytes(deps.apiOrigin, challengeB64);
  return Buffer.from(identity.priv.sign(new Uint8Array(message))).toString('base64');
}

async function getChallenge(identity: Identity): Promise<string> {
  const res = await authChallengeHandler(
    post('/v1/auth/challenge', { identityKey: identity.publicB64 }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ challenge: string }>(res.body).challenge;
}

async function completeAuth(identity: Identity, challenge: string): Promise<string> {
  const res = await authHandler(
    post('/v1/auth', {
      identityKey: identity.publicB64,
      challenge,
      signature: sign(identity, challenge),
    }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ authToken: string }>(res.body).authToken;
}

/** Build the owner's phone+tablet group through the real link transaction
 * (signature strings are the data layer's concern here — the handlers under
 * test are the AUTH pair, which verify real signatures above). */
async function mkGroupedOwner(): Promise<{ phone: string; tablet: string }> {
  const mk = async (): Promise<string> => {
    const key = PrivateKey.generate();
    const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
    const userId = uid();
    const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now());
    expect(res.kind).toBe('ok');
    return userId;
  };
  const phone = await mk();
  const tablet = await mk();
  const groupId = uid();
  const nonce = uid();
  expect(
    await db.putLinkOffer({
      offerNonce: nonce,
      groupId,
      offererUserId: phone,
      offererClass: 'phone',
      acceptorUserId: tablet,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
      expiresAt: Math.floor(deps.now() / 1000) + 600,
      offerSig: `offer-sig-${nonce}`,
    }),
  ).toBe('created');
  expect(
    await db.linkDeviceToGroup({
      offerNonce: nonce,
      acceptSig: `accept-sig-${nonce}`,
      nowSeconds: Math.floor(deps.now() / 1000),
      linkedAtMs: deps.now(),
    }),
  ).toBe('linked');
  return { phone, tablet };
}

beforeAll(async () => {
  const client = makeDynamoClient();
  const base = makeDataLayer(makeDocClient(client));
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

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('two concurrent auths on one integration account still supersede each other (the theft property survives grouping)', () => {
  gated('with the owner GROUPED: the later auth kills the earlier session, both ways round, and no sibling session is touched', async () => {
    deps = makeTestDeps(db);
    const { phone, tablet } = await mkGroupedOwner();
    // The owner's own device sessions — which the per-ULID supersede must
    // never touch (a sibling is its own ULID with its own sessions).
    const phoneToken = `sup-owner-phone-${RUN}`;
    const tabletToken = `sup-owner-tablet-${RUN}`;
    for (const [token, userId] of [
      [phoneToken, phone],
      [tabletToken, tablet],
    ] as const) {
      await db.createSession({
        token,
        userId,
        createdAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 3600,
      });
    }

    // The integration, minted through the REAL auth flow (class at birth),
    // bound to the GROUPED owner's phone ULID.
    const identity = newIdentity();
    const firstChallenge = await getChallenge(identity);
    const firstAuth = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge: firstChallenge,
        signature: sign(identity, firstChallenge),
        accountClass: 'integration',
      }),
      deps,
    );
    expect(firstAuth.statusCode).toBe(200);
    const { userId: agentId, authToken: token1 } = parseBody<{
      userId: string;
      authToken: string;
    }>(firstAuth.body);
    expect(await db.bindIntegrationOwner(agentId, phone)).toBe('bound');
    expect(await db.getSession(token1)).toBeDefined();

    // BOTH challenges outstanding at once — the store's honest concurrency:
    // per-(key, nonce) challenge rows coexist, so neither auth can starve
    // the other of its nonce.
    const chalA = await getChallenge(identity);
    const chalB = await getChallenge(identity);

    // The "thief" completes first with challenge A: token1 dies.
    const tokenThief = await completeAuth(identity, chalA);
    expect(await db.getSession(token1)).toBeUndefined();
    expect(await db.getSession(tokenThief)).toBeDefined();

    // The owner's machine completes with challenge B — issued BEFORE the
    // thief's auth, still valid: the thief's session dies in turn. That is
    // the theft property: whoever proves the key LAST holds the only live
    // session, so a stolen key never yields a quietly parallel session.
    const tokenOwner = await completeAuth(identity, chalB);
    expect(await db.getSession(tokenThief)).toBeUndefined();
    expect(await db.getSession(tokenOwner)).toBeDefined();

    // Grouping relaxed NOTHING per-ULID: the owner's own device sessions —
    // phone and tablet alike — were never superseded by the agent's churn.
    expect(await db.getSession(phoneToken)).toBeDefined();
    expect(await db.getSession(tabletToken)).toBeDefined();
  });
});
