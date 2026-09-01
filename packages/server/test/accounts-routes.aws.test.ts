import { describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { PrivateKey } from '@signalapp/libsignal-client';
import { linkOpSignedBytes, type LinkOp, type LinkOpTuple } from '@tacendum/shared';
import { activePhoneClaimKeys } from '../src/opaque-ref.js';
import { MAX_BODY_BYTES } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

// Both AWS adapters build their deps from aws/deps.js — swap the two factory
// functions for the deterministic test deps (memory twin, injected clock)
// while keeping everything else in the module REAL: makeAuthNoticePushSender
// is under test below and must be the production implementation. The factory
// seam is the ONLY mock: dispatch tables, adapters, wrappers, and handlers
// are all production code. The flag is the memory twin's operator setter —
// the real `feature#accounts` ROW read (absent/true/malformed/deleted, all
// fail-closed) is driven in isolation by the accounts-group suite, and
// binding the store-wide singleton row into this parallel suite is the same
// determinism-for-parallelism trade the sibling suites make.
vi.mock('../src/aws/deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aws/deps.js')>();
  return {
    ...actual,
    makeAwsDeps: (): unknown => testDeps,
    makeAuthDeps: (): unknown => testDeps,
  };
});
vi.mock('../src/aws/call-metrics.js', () => ({
  makeAwsCallMetrics: (): unknown => testDeps.callMetrics,
}));

/**
 * The five account routes through the REAL AWS dispatch path (the
 * exact gap this suite closes: five routes mounted on the local host while
 * neither deployed dispatch table carried any of them, so every local test
 * was green and every deployed call would have been a 404).
 *
 * What "real dispatch" means here: the events below enter through the SAME
 * `handler(event)` exports API Gateway invokes — aws/http.lambda.ts for the
 * signature-free INIT leg, aws/auth.lambda.ts for the four signed legs
 * (route placement — the signature decides the Lambda) — and are routed by
 * `event.routeKey` through the same tables the CDK stack pins (the parity
 * test in infra/test/tacendum-stack.test.ts holds the two sides equal).
 *
 * WIRING, not reachability (under the collapse every wrapper answers every
 * refusal identically, so refusal-only probes cannot tell four right
 * handlers from four keys aimed at one wrong one): with the flag ON, a full
 * ceremony runs THROUGH the dispatch tables with real libsignal signatures,
 * and each signed route key is proven to reach ITS OWN handler by the effect
 * only that handler produces (the op frame is inside the verified preimage,
 * so a cross-wired request refuses — driven both ways below).
 *
 * The pinned dark-deploy property (schema, flag row ABSENT = OFF — the
 * shipped default the memory twin also boots with): every probe of every
 * account route answers the program's ONE collapsed refusal — same status,
 * same body bytes, same headers per host — whether the probe carries a valid
 * bearer, garbage, nothing, or an OVERSIZED body (the adapters' pre-dispatch
 * 413 was a flag-independent "this route is wired" discriminator, now closed). Host header note: AuthFn's adapter wraps EVERY
 * response with the AGPL source-offer Link header (auth.lambda.ts
 * `offered`) and HttpFn adds none — and the
 * LOCAL host mirrors that per route (the four signed routes carry the
 * offer, the INIT leg does not), so cross-host byte equality of the refusal
 * IS claimed and asserted below, per route, against the deployed host that
 * serves it. Within each host the wrapper cannot discriminate cases because
 * 200s, 404s, and 429s on that host all carry the same header.
 */

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function httpEvent(over: {
  routeKey: string;
  body?: string;
  headers?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  const [method, path] = over.routeKey.split(' ');
  return {
    routeKey: over.routeKey,
    headers: over.headers ?? {},
    ...(over.body !== undefined ? { body: over.body } : {}),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, sourceIp: '127.0.0.1' },
    },
  } as unknown as APIGatewayProxyEventV2;
}

async function invokeHttp(event: APIGatewayProxyEventV2): Promise<LambdaResponse> {
  const { handler } = await import('../src/aws/http.lambda.js');
  return (await handler(event)) as LambdaResponse;
}

async function invokeAuth(event: APIGatewayProxyEventV2): Promise<LambdaResponse> {
  const { handler } = await import('../src/aws/auth.lambda.js');
  return (await handler(event)) as LambdaResponse;
}

const INIT_ROUTE = 'POST /v1/devices/link-offer';
const SIGNED_ROUTES = [
  'POST /v1/devices/link-offer/submit',
  'POST /v1/devices/link-accept',
  'POST /v1/devices/unlink',
  'POST /v1/devices/revoke',
];
//the six signature-free identifier/recovery legs
// ride HttpFn beside the INIT leg; the signature-verifying completion rides
// AuthFn beside the four signed legs (route placement).
const AC6_TOKEN_ROUTES = [
  'POST /v1/identifiers/email/request-code',
  'POST /v1/identifiers/email/verify',
  'POST /v1/identifiers/email/unlink',
  'POST /v1/recovery/request-code',
  'POST /v1/recovery/verify',
  'POST /v1/recovery/cancel',
];
const RECOVERY_SIGNED_ROUTE = 'POST /v1/recovery/complete';
//the discovery lookup + consent toggle — both
// signature-free, both on HttpFn (route placement).
const AC7_TOKEN_ROUTES = [
  'POST /v1/discovery/lookup',
  'POST /v1/identifiers/email/discoverable',
];
// The phone train: the four phone legs — all token-path,
// all on HttpFn, each gated on the MASTER flag AND feature#accounts-phone
// (accountsPhoneRoute); this suite drives them through
// the REAL dispatch below.
const PHONE_TOKEN_ROUTES = [
  'POST /v1/identifiers/phone/request-code',
  'POST /v1/identifiers/phone/verify',
  'POST /v1/identifiers/phone/unlink',
  'POST /v1/identifiers/phone/discoverable',
];
//the four username legs — all token-path, all
// on HttpFn, each gated on the MASTER flag AND feature#accounts-username
// (accountsUsernameRoute); driven through the REAL dispatch below like the
// phone legs, oversized bodies included.
const USERNAME_TOKEN_ROUTES = [
  'POST /v1/identifiers/username/claim',
  'POST /v1/identifiers/username/rename',
  'POST /v1/identifiers/username/unlink',
  'POST /v1/identifiers/username/discoverable',
];
/** Which deployed host serves a route key — the chooser every loop below
 * uses, so a route added to the wrong table here fails its parity case. */
const HTTP_HOSTED = new Set([
  INIT_ROUTE,
  ...AC6_TOKEN_ROUTES,
  ...AC7_TOKEN_ROUTES,
  ...PHONE_TOKEN_ROUTES,
  ...USERNAME_TOKEN_ROUTES,
]);

let userSeq = 0;
async function seedUser(over: Partial<Parameters<typeof db.createUser>[0]> = {}): Promise<{
  userId: string;
  token: string;
}> {
  // A REAL ULID: the request schemas pin ULID shape, so a prose id would be
  // refused at parse and this suite would prove nothing past the collapse.
  const userId = testDeps.newUserId();
  const token = `aws-route-token-${++userSeq}`;
  await db.createUser({
    userId,
    createdAt: testDeps.now(),
    identityKeyPub: `idkey-${userId}`,
    ...over,
  });
  await db.createSession({
    token,
    userId,
    createdAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
  });
  return { userId, token };
}

interface Signer {
  userId: string;
  token: string;
  key: PrivateKey;
  pub: string;
}

/** A user whose registered identity key is a REAL libsignal key, so the
 * signed legs verify real signatures through the real dispatch. */
async function seedSigner(): Promise<Signer> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const { userId, token } = await seedUser({ identityKeyPub: pub });
  return { userId, token, key, pub };
}

function sign(op: LinkOp, tuple: LinkOpTuple, key: PrivateKey): string {
  const pre = linkOpSignedBytes(op, tuple);
  const buf = new Uint8Array(new ArrayBuffer(pre.length));
  buf.set(pre);
  return Buffer.from(key.sign(buf)).toString('base64');
}

describe('the five account routes through the real AWS dispatch, flag ABSENT (the shipped default)', () => {
  it('every probe of every route — bearer-less, garbage body, valid bearer, or OVERSIZED body — gets the ONE collapsed byte-stream per host', async () => {
    db.setAccountsFeatureEnabled(false);
    const { token } = await seedUser();

    const probes = (routeKey: string): APIGatewayProxyEventV2[] => [
      // No bearer at all: while the flag is dark even the 401 never
      // surfaces, because the flag check runs first (devices.ts).
      httpEvent({ routeKey }),
      // Garbage body, no bearer.
      httpEvent({ routeKey, body: 'not json' }),
      // A VALID bearer and a well-formed-looking body: still the same bytes —
      // the flag outranks authentication.
      httpEvent({
        routeKey,
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ offerNonce: 'x', signature: 'y' }),
      }),
      // An OVERSIZED body: the adapter's own
      // pre-dispatch ceiling fires, and on an accounts route its answer is
      // the SAME collapsed refusal — a 413 here was a flag-independent
      // "this route is wired" discriminator on a dark deploy.
      httpEvent({ routeKey, body: 'a'.repeat(MAX_BODY_BYTES + 1) }),
    ];

    // The INIT leg, the six token-path legs, the two discovery
    // legs, the four phone legs, and the four username legs ride
    // HttpFn. With every flag absent (the shipped default) the phone and
    // username legs collapse at the master read exactly like every
    // accounts route — the master-ON/sub-flag-OFF splits are
    // accounts-flag-gate.test.ts's.
    const initResponses: LambdaResponse[] = [];
    for (const routeKey of [
      INIT_ROUTE,
      ...AC6_TOKEN_ROUTES,
      ...AC7_TOKEN_ROUTES,
      ...PHONE_TOKEN_ROUTES,
      ...USERNAME_TOKEN_ROUTES,
    ]) {
      for (const event of probes(routeKey)) initResponses.push(await invokeHttp(event));
    }
    // The four signed legs + recovery completion ride AuthFn.
    const authResponses: LambdaResponse[] = [];
    for (const routeKey of [...SIGNED_ROUTES, RECOVERY_SIGNED_ROUTE]) {
      for (const event of probes(routeKey)) authResponses.push(await invokeAuth(event));
    }

    const all = [...initResponses, ...authResponses];
    for (const res of all) expect(res.statusCode).toBe(403);
    // ONE body across all five routes and all probe shapes — byte-identical.
    const bodies = new Set(all.map((res) => res.body));
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toEqual({
      error: { code: 'accounts_refused', detail: 'not available' },
    });
    // ONE header set per host (the wrapper divides the hosts, never the
    // cases): all HttpFn refusals deep-equal each other, all AuthFn refusals
    // deep-equal each other.
    for (const res of initResponses) expect(res.headers).toEqual(initResponses[0]!.headers);
    for (const res of authResponses) expect(res.headers).toEqual(authResponses[0]!.headers);
    // And the AuthFn refusal carries the uniform source-offer header exactly
    // like every other AuthFn response — present, and identical across the
    // sixteen probes above (asserted by the loop), so it discriminates
    // nothing.
    expect(authResponses[0]!.headers?.link).toContain('rel=');

    // The contrast that keeps the 413 honest where it still belongs: a
    // NON-accounts route's oversized body stays the diagnosable 413 on the
    // same host — the collapse absorbed the accounts routes, not the
    // adapter's ceiling.
    const nonAccounts = await invokeAuth(
      httpEvent({ routeKey: 'POST /v1/auth/challenge', body: 'a'.repeat(MAX_BODY_BYTES + 1) }),
    );
    expect(nonAccounts.statusCode).toBe(413);
  });

  it('the collapsed 403 comes from the dispatched route, not a catch-all: an unknown devices routeKey is a distinct 404', async () => {
    db.setAccountsFeatureEnabled(false);
    const res = await invokeAuth(httpEvent({ routeKey: 'POST /v1/devices/does-not-exist' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '').error.code).toBe('not_found');
  });
});

describe('flag ON: the REAL handlers answer behind the AWS dispatch (not a mounted 404, not a stub)', () => {
  it('the INIT leg mints and RECORDS the signing tuple through http.lambda dispatch', async () => {
    db.setAccountsFeatureEnabled(true);
    try {
      const offerer = await seedUser();
      const acceptor = await seedUser();
      const res = await invokeHttp(
        httpEvent({
          routeKey: INIT_ROUTE,
          headers: { authorization: `Bearer ${offerer.token}` },
          body: JSON.stringify({
            acceptorUserId: acceptor.userId,
            acceptorClass: 'tablet',
            offererClass: 'phone',
          }),
        }),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body ?? '') as {
        groupId: string;
        rosterEpoch: number;
        offerNonce: string;
        expiresAt: number;
      };
      expect(body.rosterEpoch).toBe(0);
      // The proof the REAL handler ran: the TTL'd init row exists in the
      // store, keyed by the nonce the response minted.
      const init = await db.getLinkOfferInit(body.offerNonce, Math.floor(testDeps.now() / 1000));
      expect(init?.offererUserId).toBe(offerer.userId);
      expect(init?.acceptorUserId).toBe(acceptor.userId);
      expect(init?.groupId).toBe(body.groupId);
    } finally {
      db.setAccountsFeatureEnabled(false);
    }
  });

  it('a signed leg reaches the real handler through auth.lambda dispatch: a bearer-authenticated submit with an unknown nonce is the collapsed refusal, never a 404', async () => {
    db.setAccountsFeatureEnabled(true);
    try {
      const { token } = await seedUser();
      const res = await invokeAuth(
        httpEvent({
          routeKey: 'POST /v1/devices/link-offer/submit',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ offerNonce: 'no-such-nonce', signature: 'AAAA' }),
        }),
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? '').error.code).toBe('accounts_refused');
    } finally {
      db.setAccountsFeatureEnabled(false);
    }
  });

  /** One full ceremony through the REAL dispatch tables: init (HttpFn),
   * submit + accept (AuthFn). Returns the linked pair and the group. */
  async function linkPair(): Promise<{ a: Signer; b: Signer; groupId: string }> {
    const a = await seedSigner();
    const b = await seedSigner();
    const initRes = await invokeHttp(
      httpEvent({
        routeKey: INIT_ROUTE,
        headers: { authorization: `Bearer ${a.token}` },
        body: JSON.stringify({
          acceptorUserId: b.userId,
          acceptorClass: 'tablet',
          offererClass: 'phone',
        }),
      }),
    );
    expect(initRes.statusCode).toBe(200);
    const tuple = JSON.parse(initRes.body ?? '') as {
      groupId: string;
      rosterEpoch: number;
      offerNonce: string;
      expiresAt: number;
    };

    const offerSig = sign(
      'offer',
      {
        groupId: tuple.groupId,
        offererUserId: a.userId,
        acceptorUserId: b.userId,
        subjectIdentityPubKey: b.pub,
        class: 'tablet',
        rosterEpoch: tuple.rosterEpoch,
        offerNonce: tuple.offerNonce,
        expiresAt: tuple.expiresAt,
      },
      a.key,
    );
    const submitBody = JSON.stringify({ offerNonce: tuple.offerNonce, signature: offerSig });

    // CROSS-WIRING probe, before the real call: the VALID submit request
    // aimed at the link-accept key refuses (that handler resolves PROMOTED
    // offers, and none exists yet) and consumes nothing — a table where both
    // keys reached one handler could not answer this way and then promote.
    const crossed = await invokeAuth(
      httpEvent({
        routeKey: 'POST /v1/devices/link-accept',
        headers: { authorization: `Bearer ${b.token}` },
        body: submitBody,
      }),
    );
    expect(crossed.statusCode).toBe(403);

    const submitRes = await invokeAuth(
      httpEvent({
        routeKey: 'POST /v1/devices/link-offer/submit',
        headers: { authorization: `Bearer ${a.token}` },
        body: submitBody,
      }),
    );
    expect(submitRes.statusCode).toBe(200);
    // The submit handler's own effect: the init row was PROMOTED to a
    // pending offer.
    expect(
      await db.getLinkOffer(tuple.offerNonce, Math.floor(testDeps.now() / 1000)),
    ).toBeDefined();

    const acceptSig = sign(
      'accept',
      {
        groupId: tuple.groupId,
        offererUserId: a.userId,
        acceptorUserId: b.userId,
        subjectIdentityPubKey: a.pub,
        class: 'tablet',
        rosterEpoch: tuple.rosterEpoch,
        offerNonce: tuple.offerNonce,
        expiresAt: tuple.expiresAt,
      },
      b.key,
    );
    const acceptRes = await invokeAuth(
      httpEvent({
        routeKey: 'POST /v1/devices/link-accept',
        headers: { authorization: `Bearer ${b.token}` },
        body: JSON.stringify({ offerNonce: tuple.offerNonce, signature: acceptSig }),
      }),
    );
    expect(acceptRes.statusCode).toBe(200);
    // The accept handler's own effect: the roster exists with both members.
    const group = await db.getAccountGroup(tuple.groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => m.userId).sort()).toEqual([a.userId, b.userId].sort());
    return { a, b, groupId: tuple.groupId };
  }

  it('each of the four signed route keys reaches ITS OWN handler: a full ceremony with real signatures, and cross-wired requests refused by the op frame', async () => {
    db.setAccountsFeatureEnabled(true);
    try {
      // Ceremony 1 proves submit + accept (with the accept-key cross probe
      // inside linkPair). Now the mutations, which share one request schema
      // and differ ONLY in the op frame inside the verified preimage — the
      // exact property that makes cross-wiring detectable.
      const { a, b, groupId } = await linkPair();
      const expiresAt = Math.floor(testDeps.now() / 1000) + 300;
      const unlinkBody = JSON.stringify({
        groupId,
        targetUserId: b.userId,
        targetClass: 'tablet',
        rosterEpoch: 1,
        offerNonce: 'mut-nonce-unlink-1',
        expiresAt,
        signature: sign(
          'unlink',
          {
            groupId,
            offererUserId: a.userId,
            acceptorUserId: b.userId,
            subjectIdentityPubKey: b.pub,
            class: 'tablet',
            rosterEpoch: 1,
            offerNonce: 'mut-nonce-unlink-1',
            expiresAt,
          },
          a.key,
        ),
      });

      // The valid op='unlink' request aimed at the REVOKE key: the revoke
      // handler rebuilds an op='revoke' preimage, the signature fails, the
      // roster is untouched. If both keys reached one handler, this would
      // have mutated.
      const wrongKey = await invokeAuth(
        httpEvent({
          routeKey: 'POST /v1/devices/revoke',
          headers: { authorization: `Bearer ${a.token}` },
          body: unlinkBody,
        }),
      );
      expect(wrongKey.statusCode).toBe(403);
      expect((await db.getAccountGroup(groupId))?.members).toHaveLength(2);

      // At the UNLINK key the same bytes succeed — and produce the effect
      // only the unlink handler produces: the member leaves ALIVE.
      const unlinkRes = await invokeAuth(
        httpEvent({
          routeKey: 'POST /v1/devices/unlink',
          headers: { authorization: `Bearer ${a.token}` },
          body: unlinkBody,
        }),
      );
      expect(unlinkRes.statusCode).toBe(200);
      expect((await db.getAccountGroup(groupId))?.members.map((m) => m.userId)).toEqual([
        a.userId,
      ]);
      expect((await db.getUserById(b.userId))?.tombstoned).not.toBe(true);

      // Ceremony 2 for the REVOKE key: its distinct effect is the tombstone
      // + forwarding marker — the one thing the unlink handler never writes.
      const pair2 = await linkPair();
      const expiresAt2 = Math.floor(testDeps.now() / 1000) + 300;
      const revokeRes = await invokeAuth(
        httpEvent({
          routeKey: 'POST /v1/devices/revoke',
          headers: { authorization: `Bearer ${pair2.a.token}` },
          body: JSON.stringify({
            groupId: pair2.groupId,
            targetUserId: pair2.b.userId,
            targetClass: 'tablet',
            rosterEpoch: 1,
            offerNonce: 'mut-nonce-revoke-1',
            expiresAt: expiresAt2,
            signature: sign(
              'revoke',
              {
                groupId: pair2.groupId,
                offererUserId: pair2.a.userId,
                acceptorUserId: pair2.b.userId,
                subjectIdentityPubKey: pair2.b.pub,
                class: 'tablet',
                rosterEpoch: 1,
                offerNonce: 'mut-nonce-revoke-1',
                expiresAt: expiresAt2,
              },
              pair2.a.key,
            ),
          }),
        }),
      );
      expect(revokeRes.statusCode).toBe(200);
      const revoked = await db.getUserById(pair2.b.userId);
      expect(revoked?.tombstoned).toBe(true);
      expect(revoked?.formerGroupId).toBe(pair2.groupId);
      expect((await db.getAccountGroup(pair2.groupId))?.members.map((m) => m.userId)).toEqual([
        pair2.a.userId,
      ]);
    } finally {
      db.setAccountsFeatureEnabled(false);
    }
  });

  it('the two discovery keys reach their OWN handlers: the toggle flips the claim row through http.lambda dispatch, and the lookup resolves it (each proven by the effect only that handler produces)', async () => {
    db.setAccountsFeatureEnabled(true);
    try {
      const call = async (routeKey: string, token: string, body: unknown): Promise<LambdaResponse> =>
        invokeHttp(
          httpEvent({
            routeKey,
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          }),
        );
      const attach = async (who: { token: string }, email: string): Promise<void> => {
        expect(
          (await call('POST /v1/identifiers/email/request-code', who.token, { email, class: 'phone' }))
            .statusCode,
        ).toBe(200);
        const code = testDeps.emailsSent.at(-1)!.code;
        expect(
          (await call('POST /v1/identifiers/email/verify', who.token, { email, code })).statusCode,
        ).toBe(200);
      };

      // A gate-passing caller (verified identifier + 72 h age) and a target
      // whose OWNER consents — all through the REAL dispatch tables. The
      // accounts are minted, the clock advances past the age gate, and THEN
      // sessions are minted (seedUser's hour-long bearer would expire inside
      // the 72 h the age gate demands).
      const caller = await seedUser();
      const owner = await seedUser();
      testDeps.advanceMs(72 * 3600 * 1000);
      for (const who of [caller, owner]) {
        who.token = `${who.token}-aged`;
        await db.createSession({
          token: who.token,
          userId: who.userId,
          createdAt: testDeps.now(),
          expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
        });
      }
      await attach(caller, `aws-caller-${userSeq}@example.com`);
      const email = `aws-target-${userSeq}@example.com`;
      await attach(owner, email);

      // Toggle handler's own effect: the claim row's consent attribute flips.
      expect(
        (await call('POST /v1/identifiers/email/discoverable', owner.token, { discoverable: true }))
          .statusCode,
      ).toBe(204);
      // Lookup handler's own effect: the minimal disclosure resolves.
      const hit = await call('POST /v1/discovery/lookup', caller.token, { email });
      expect(hit.statusCode).toBe(200);
      const body = JSON.parse(hit.body ?? '') as { members: Array<{ userId: string }> };
      expect(body.members.map((m) => m.userId)).toEqual([owner.userId]);

      // Cross-wiring probe: the lookup request aimed at the TOGGLE key
      // answers the toggle's uniform 204 (and resolves nothing) — two keys
      // reaching one handler could not answer both shapes.
      const crossed = await call('POST /v1/identifiers/email/discoverable', caller.token, { email });
      expect(crossed.statusCode).toBe(403); // the toggle collapses the alien shape
      const offAgain = await call('POST /v1/discovery/lookup', owner.token, {
        discoverable: false,
      });
      expect(offAgain.statusCode).toBe(403); // the lookup collapses the alien shape
    } finally {
      db.setAccountsFeatureEnabled(false);
    }
  });
});

describe('the four phone keys reach their OWN handlers through the REAL AWS dispatch (the wiring ceremony)', () => {
  it('request-code sends, verify attaches, discoverable flips the claim, unlink takes it — each proven by the effect only that handler produces, with cross-wired requests collapsing', async () => {
    db.setAccountsFeatureEnabled(true);
    db.setAccountsPhoneFeatureEnabled(true);
    try {
      const owner = await seedUser();
      const number = `+1222${String(500_000 + ++userSeq).padStart(7, '0')}`;
      const call = async (routeKey: string, token: string, body: unknown): Promise<LambdaResponse> =>
        invokeHttp(
          httpEvent({
            routeKey,
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          }),
        );

      // CROSS-WIRING probe before anything real: a VERIFY-shaped body at
      // the request-code key is malformed for THAT handler's schema and
      // collapses, sending nothing — two keys on one handler could not
      // refuse this and then answer the real shapes below.
      const crossed = await call('POST /v1/identifiers/phone/request-code', owner.token, {
        phone: number,
        code: '123456',
      });
      expect(crossed.statusCode).toBe(403);
      expect(testDeps.smsSent).toHaveLength(0);

      // request-code's OWN effect: an SMS leaves the (fake) seam for
      // exactly this number.
      expect(
        (
          await call('POST /v1/identifiers/phone/request-code', owner.token, {
            phone: number,
            class: 'phone',
          })
        ).statusCode,
      ).toBe(200);
      expect(testDeps.smsSent).toHaveLength(1);
      expect(testDeps.smsSent[0]!.number).toBe(number);

      // verify's OWN effect: the attach commits — the caller is grouped and
      // the claim resolves to that group.
      const code = testDeps.smsSent[0]!.code;
      expect(
        (
          await call('POST /v1/identifiers/phone/verify', owner.token, { phone: number, code })
        ).statusCode,
      ).toBe(200);
      const groupId = (await db.getUserById(owner.userId))!.groupId!;
      const claimKey = activePhoneClaimKeys(
        [{ version: 1, key: 'test-identifier-hmac-key' }],
        number,
      )[0]!;
      expect((await db.getIdentifierClaim(claimKey))?.groupId).toBe(groupId);
      expect((await db.getIdentifierClaim(claimKey))?.discoverable).toBe(false);

      // discoverable's OWN effect: the phone claim's consent attribute
      // flips — the one thing no other phone handler writes.
      expect(
        (
          await call('POST /v1/identifiers/phone/discoverable', owner.token, {
            discoverable: true,
          })
        ).statusCode,
      ).toBe(204);
      expect((await db.getIdentifierClaim(claimKey))?.discoverable).toBe(true);

      // Cross-wiring, the other way: the discoverable-shaped body at the
      // UNLINK key is alien to that handler's (empty) expectations — the
      // unlink runs regardless of body and TAKES the claim, which is
      // exactly unlink's own distinct effect (and could never be the
      // toggle's uniform 204 leaving the claim standing).
      const unlinked = await call('POST /v1/identifiers/phone/unlink', owner.token, {});
      expect(unlinked.statusCode).toBe(200);
      expect(await db.getIdentifierClaim(claimKey)).toBeUndefined();
      expect(await db.getAccountGroup(groupId)).toBeUndefined(); // lazy-solo reap
      // A second unlink through the same key: nothing to take — collapsed.
      expect((await call('POST /v1/identifiers/phone/unlink', owner.token, {})).statusCode).toBe(
        403,
      );
    } finally {
      db.setAccountsFeatureEnabled(false);
      db.setAccountsPhoneFeatureEnabled(false);
    }
  });
});

describe('cross-host refusal parity : the local host answers the SAME bytes per route as the deployed host that serves it', () => {
  /** Raw node:http request — full header control (fetch forbids
   * content-length), resolve-once so a post-response teardown never races
   * the assertion. */
  function rawRequest(
    port: number,
    method: string,
    path: string,
    over: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = request(
        // agent: false — one fresh connection per probe: the oversize path
        // deliberately tears its connection down after responding, and a
        // pooled keep-alive socket would hand the NEXT probe a dead pipe.
        { host: '127.0.0.1', port, method, path, headers: over.headers ?? {}, agent: false },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString('utf8')));
          res.on('end', () => {
            if (!settled) {
              settled = true;
              resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
            }
          });
        },
      );
      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`${method} ${path}: ${err.message}`));
        }
      });
      if (over.body !== undefined) req.write(over.body);
      req.end();
    });
  }

  it('flag ABSENT: status, body, content-type, and the link header agree per route — the signed routes carry the offer on BOTH hosts, the INIT leg on NEITHER, and the oversized probe collapses identically', async () => {
    db.setAccountsFeatureEnabled(false);
    const { createHttpServer } = await import('../src/local/http.js');
    const server = createHttpServer(testDeps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const routeKey of [
        INIT_ROUTE,
        ...AC6_TOKEN_ROUTES,
        ...AC7_TOKEN_ROUTES,
        ...PHONE_TOKEN_ROUTES,
        ...USERNAME_TOKEN_ROUTES,
        ...SIGNED_ROUTES,
        RECOVERY_SIGNED_ROUTE,
      ]) {
        const [method, path] = routeKey.split(' ') as [string, string];
        const lambda = HTTP_HOSTED.has(routeKey)
          ? await invokeHttp(httpEvent({ routeKey, body: 'not json' }))
          : await invokeAuth(httpEvent({ routeKey, body: 'not json' }));
        const local = await rawRequest(port, method, path, { body: 'not json' });
        expect(local.status, routeKey).toBe(lambda.statusCode);
        expect(local.body, routeKey).toBe(lambda.body);
        expect(local.headers['content-type'], routeKey).toBe(
          lambda.headers?.['content-type'],
        );
        // The offer: present per route exactly as the DEPLOYED host for
        // that route answers — AuthFn wraps everything, HttpFn adds none.
        expect(local.headers.link, routeKey).toBe(lambda.headers?.link);
      }

      // The oversized probe, per host pair: one signed route (AuthFn twin)
      // and the INIT leg (HttpFn twin). Driven locally through the
      // declared-length fast path — headers only, no body written — so the
      // response is read deterministically before the connection tears down.
      for (const routeKey of [
        INIT_ROUTE,
        ...PHONE_TOKEN_ROUTES,
        ...USERNAME_TOKEN_ROUTES,
        'POST /v1/devices/unlink',
      ]) {
        const [method, path] = routeKey.split(' ') as [string, string];
        const lambda = HTTP_HOSTED.has(routeKey)
          ? await invokeHttp(httpEvent({ routeKey, body: 'a'.repeat(MAX_BODY_BYTES + 1) }))
          : await invokeAuth(httpEvent({ routeKey, body: 'a'.repeat(MAX_BODY_BYTES + 1) }));
        expect(lambda.statusCode, routeKey).toBe(403);
        const local = await rawRequest(port, method, path, {
          headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
        });
        expect(local.status, routeKey).toBe(403);
        expect(local.body, routeKey).toBe(lambda.body);
        expect(local.headers.link, routeKey).toBe(lambda.headers?.link);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('makeAuthNoticePushSender (the by-reference wake: AuthFn queues a PushWakeEvent for the worker that holds the credentials)', () => {
  const tokenRow = {
    userId: '01RECIPIENT00000000000000A',
    platform: 'ios' as const,
    alertToken: 'b'.repeat(64),
    bundleId: 'com.tacendum.test',
    updatedAt: 0,
    expiresAt: 9_999_999_999,
  };
  const alert = {
    from: '01ABOUTUSER00000000000000A',
    ts: 1_700_000_000_000,
    msgId: '01MSGID000000000000000000A',
    msgType: 'accounts',
    payload: 'eyJraW5kIjoibGlua09mZmVyIn0=',
  };

  async function makeSender(env: NodeJS.ProcessEnv): Promise<{
    sender: import('../src/handlers/http.js').Deps['push'];
    sent: InvokeCommand[];
  }> {
    const { makeAuthNoticePushSender } = await import('../src/aws/deps.js');
    const sent: InvokeCommand[] = [];
    const sender = makeAuthNoticePushSender(env, async (cmd) => {
      sent.push(cmd);
      return {};
    });
    return { sender, sent };
  }

  it('notify async-invokes the push worker with a kind:"message" PushWakeEvent and a fresh wakeId per call — no secret is fetched or named', async () => {
    const { sender, sent } = await makeSender({ PUSH_FUNCTION_NAME: 'PushFn-test' });
    expect(await sender.notify(tokenRow, alert)).toBe('sent');
    expect(await sender.notify(tokenRow, alert)).toBe('sent');
    expect(sent).toHaveLength(2);

    const first = sent[0]!.input;
    expect(first.FunctionName).toBe('PushFn-test');
    // Event, not RequestResponse: the queueing IS the durability (the
    // ws.lambda.ts rule — the container may freeze after the response).
    expect(first.InvocationType).toBe('Event');
    const payload = JSON.parse(Buffer.from(first.Payload as Uint8Array).toString('utf8')) as {
      recipientId: string;
      senderUserId: string;
      kind: string;
      message: { msgId: string; msgType: string; payload: string; ts: number };
      wakeId: string;
    };
    expect(payload.recipientId).toBe(tokenRow.userId);
    expect(payload.senderUserId).toBe(alert.from);
    // 'message' — the banner lane. An accounts notice must NEVER take the
    // worker's VoIP branch (kind absent means 'call' for back-compat, so the
    // field is load-bearing, not decorative).
    expect(payload.kind).toBe('message');
    expect(payload.message).toEqual({
      msgId: alert.msgId,
      msgType: alert.msgType,
      payload: alert.payload,
      ts: alert.ts,
    });
    // One scheduling decision, one redelivery claim: a real ULID, fresh per
    // call (the ws.ts mint rule — Lambda's async queue is at-least-once).
    expect(payload.wakeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const second = JSON.parse(
      Buffer.from(sent[1]!.input.Payload as Uint8Array).toString('utf8'),
    ) as { wakeId: string };
    expect(second.wakeId).not.toBe(payload.wakeId);
  });

  it('degrades to "failed" without invoking anything when PUSH_FUNCTION_NAME is absent, and when the invoke itself throws', async () => {
    const { sender, sent } = await makeSender({});
    expect(await sender.notify(tokenRow, alert)).toBe('failed');
    expect(sent).toHaveLength(0);

    const { makeAuthNoticePushSender } = await import('../src/aws/deps.js');
    const throwing = makeAuthNoticePushSender({ PUSH_FUNCTION_NAME: 'PushFn-test' }, async () => {
      throw new Error('throttled');
    });
    expect(await throwing.notify(tokenRow, alert)).toBe('failed');
  });

  it('wake stays "failed": no AuthFn route rings a call, and the VoIP lane gains no second holder', async () => {
    const { sender, sent } = await makeSender({ PUSH_FUNCTION_NAME: 'PushFn-test' });
    expect(await sender.wake(tokenRow, alert.from)).toBe('failed');
    expect(sent).toHaveLength(0);
  });
});
