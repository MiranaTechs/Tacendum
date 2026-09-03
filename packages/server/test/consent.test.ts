import { beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_MAX_EDGES } from '@tacendum/shared';
import { consentDeleteHandler, consentWriteHandler } from '../src/handlers/consent.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { routes as httpLambdaRoutes } from '../src/aws/http.lambda.js';
import type { AuthContext, HttpEvent, HttpResult } from '../src/handlers/http.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/**
 * The consent-edge routes held to and:
 *
 * - — consenting to ANY well-formed ULID answers a uniform 204 behind
 * a quota: success, nonexistent target, non-integration target, self and
 * over-cap are byte-identical on the wire; the quota's 429 is the ONE
 * distinguishable refusal, and it is taken before anything else so each
 * probe of the non-oracle costs a token. Deletion equally uniform.
 * - — no route enumerates who consented to what: the deployed route
 * table holds a write and a delete and NOTHING else (pinned here against
 * the Lambda dispatch table; the CDK side and the no-GetItem IAM pin
 * live in infra/test).
 *
 * Every uniformity assertion compares WHOLE HttpResults, not just status
 * codes — a divergent header or body would be a wire tell too.
 */

const HUMAN = '0000000000000000000PERSN01';
const AGENT = '0000000000000000000AGENT01';
const IDENTITY_KEY = testIdentityKey(0x31);

let db: TestOnlyDataLayer;
let deps: TestDeps;
const auth: AuthContext = { userId: HUMAN };

function postEvent(body: unknown): HttpEvent {
  return { method: 'POST', path: '/v1/consent', headers: {}, body: JSON.stringify(body) };
}

function deleteEvent(agentId: string): HttpEvent {
  return {
    method: 'DELETE',
    path: `/v1/consent/${agentId}`,
    headers: {},
    pathParameters: { agentId },
  };
}

/** A run of distinct, well-formed ULIDs (digits are valid Crockford base32). */
function agentUlid(n: number): string {
  return `01000000000000000000${String(n).padStart(6, '0')}`;
}

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  await db.createUser({ userId: HUMAN, createdAt: deps.now(), identityKeyPub: IDENTITY_KEY });
  await db.createUser({ userId: AGENT, createdAt: deps.now(), accountClass: 'integration' });
  await db.bindIntegrationOwner(AGENT, HUMAN);
});

describe('POST /v1/consent — uniformity', () => {
  it('answers the SAME 204 for an existing integration, a nonexistent ULID, a human target, and self', async () => {
    const answers: HttpResult[] = [];
    const other = '0000000000000000000PERSN02';
    await db.createUser({ userId: other, createdAt: deps.now() });
    for (const agent of [AGENT, agentUlid(1), other, HUMAN]) {
      answers.push(await consentWriteHandler(postEvent({ agent }), deps, auth));
    }
    for (const answer of answers) {
      // Whole-result equality against the first: no status, header or body
      // may vary by target (the "indistinguishable on the wire").
      expect(answer).toEqual(answers[0]);
      expect(answer.statusCode).toBe(204);
      expect(answer.body).toBeUndefined();
    }
    // The write to the real integration DID land — 204 is not a no-op.
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(true);
    // The SELF edge is uniform on the wire and NOT STORED (a
    // remediation): it can admit nothing — consentAdmits needs a human AND
    // an integration on one row — so storing it only burned a cap slot.
    // Red-first: reverting the handler's self short-circuit stores the row
    // and this goes red.
    expect(await db.hasConsentEdge(HUMAN, HUMAN)).toBe(false);
  });

  it('a self grant burns NO cap slot: sixteen real grants still fit after it', async () => {
    expect((await consentWriteHandler(postEvent({ agent: HUMAN }), deps, auth)).statusCode).toBe(
      204,
    );
    for (let i = 1; i <= CONSENT_MAX_EDGES; i += 1) {
      expect(await db.writeConsentEdge(HUMAN, agentUlid(i), deps.now())).toBe('written');
    }
  });

  it('over-cap answers the SAME 204 and is silently lossy — the deliberate price of uniformity', async () => {
    for (let i = 1; i <= CONSENT_MAX_EDGES; i += 1) {
      expect(await db.writeConsentEdge(HUMAN, agentUlid(i), deps.now())).toBe('written');
    }
    const over = await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    const normal = await consentWriteHandler(postEvent({ agent: agentUlid(1) }), deps, auth);
    expect(over).toEqual(normal);
    expect(over.statusCode).toBe(204);
    // Lossy by design: the edge was NOT stored.
    // Deleting this cap's condition in writeConsentEdge turns this red.
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(false);
  });

  it('re-consent is idempotent: it neither errors nor double-counts a cap slot', async () => {
    // Two writes of the same agent, then fill the REMAINING cap-1 slots: if
    // the re-consent had double-counted, the last fill would be refused.
    await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    const again = await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    expect(again.statusCode).toBe(204);
    for (let i = 1; i <= CONSENT_MAX_EDGES - 1; i += 1) {
      expect(await db.writeConsentEdge(HUMAN, agentUlid(i), deps.now())).toBe('written');
    }
    expect(await db.hasConsentEdge(HUMAN, agentUlid(CONSENT_MAX_EDGES - 1))).toBe(true);
  });

  it('the quota is the ONE distinguishable refusal, and it is taken before the body is even parsed', async () => {
    // Five malformed bodies (400s) must each cost a token — the intsend
    // quota-before-read precedent. If the quota moved below the parse, the
    // sixth (valid) call would answer 204 and this goes red.
    for (let i = 0; i < 5; i += 1) {
      const res = await consentWriteHandler(postEvent({ agent: 'not-a-ulid' }), deps, auth);
      expect(res.statusCode).toBe(400);
    }
    const sixth = await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers?.['retry-after']).toBeDefined();
  });

  it('refuses a malformed target as a 400 about the REQUEST (shape, not an oracle)', async () => {
    const res = await consentWriteHandler(postEvent({ agent: '#count' }), deps, auth);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an integration-class caller — an injectable node never writes authorization state', async () => {
    const res = await consentWriteHandler(postEvent({ agent: agentUlid(7) }), deps, {
      userId: AGENT,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error?.code).toBe('integration_forbidden');
    expect(await db.hasConsentEdge(AGENT, agentUlid(7))).toBe(false);
  });

  it('refuses a caller whose account row is gone (token outlived the row — fail closed)', async () => {
    const res = await consentWriteHandler(postEvent({ agent: AGENT }), deps, {
      userId: '0000000000000000000GH0ST01',
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error?.code).toBe('unknown_owner');
  });

  it('logs the outcome and NEVER the parties — the retained log must not become the graph', async () => {
    await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    const line = deps.logs.find((l) => l.event === 'consent_write');
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain(HUMAN);
    expect(JSON.stringify(line)).not.toContain(AGENT);
  });
});

describe('DELETE /v1/consent/{agentId} — uniform deletion, separate budget', () => {
  it('answers the SAME 204 whether the edge existed or not, and the edge is gone after', async () => {
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    const existed = await consentDeleteHandler(deleteEvent(AGENT), deps, auth);
    const absent = await consentDeleteHandler(deleteEvent(agentUlid(9)), deps, auth);
    const repeat = await consentDeleteHandler(deleteEvent(AGENT), deps, auth);
    expect(existed).toEqual(absent);
    expect(existed).toEqual(repeat);
    expect(existed.statusCode).toBe(204);
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(false);
  });

  it('deletion frees a cap slot', async () => {
    for (let i = 1; i <= CONSENT_MAX_EDGES; i += 1) {
      await db.writeConsentEdge(HUMAN, agentUlid(i), deps.now());
    }
    await consentDeleteHandler(deleteEvent(agentUlid(1)), deps, auth);
    const res = await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth);
    expect(res.statusCode).toBe(204);
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(true);
  });

  it('revocation rides its OWN roomier budget — a drained write quota cannot lock the panic action', async () => {
    // Drain the write bucket completely…
    for (let i = 0; i < 6; i += 1) {
      await consentWriteHandler(postEvent({ agent: agentUlid(20 + i) }), deps, auth);
    }
    expect(
      (await consentWriteHandler(postEvent({ agent: AGENT }), deps, auth)).statusCode,
    ).toBe(429);
    // …and the delete still answers. Folding the two buckets turns this red.
    const res = await consentDeleteHandler(deleteEvent(agentUlid(20)), deps, auth);
    expect(res.statusCode).toBe(204);
  });

  it('refuses a malformed agentId (and thereby keeps the #count control row unaddressable)', async () => {
    const res = await consentDeleteHandler(deleteEvent('#count'), deps, auth);
    expect(res.statusCode).toBe(400);
  });
});

describe('no consent enumeration, anywhere', () => {
  it('the deployed dispatch table holds a write and a delete and NO read route', () => {
    const consentRoutes = Object.keys(httpLambdaRoutes).filter((key) =>
      key.includes('/v1/consent'),
    );
    expect(consentRoutes.sort()).toEqual(['DELETE /v1/consent/{agentId}', 'POST /v1/consent']);
    // No GET over consent exists under ANY path shape.
    expect(
      Object.keys(httpLambdaRoutes).some((key) => key.startsWith('GET') && key.includes('consent')),
    ).toBe(false);
  });

  it('the TestOnlyDataLayer exposes no listing over edges — the only reads are the point predicate and the destructive purge', async () => {
    // Structural pin: a future `listConsentEdges` must consciously break
    // this, not slip in beside the four methods budgeted.
    const consentMethods = Object.keys(db).filter((k) => k.toLowerCase().includes('consent'));
    expect(consentMethods.sort()).toEqual([
      'deleteConsentEdge',
      'hasConsentEdge',
      'purgeConsentEdges',
      'writeConsentEdge',
    ]);
  });
});

describe('account deletion sweeps the consent partition', () => {
  it('DELETE /v1/account purges every edge the caller wrote (and their cap counter with it)', async () => {
    await db.createSession({
      token: 'token-1',
      userId: HUMAN,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    await db.writeConsentEdge(HUMAN, AGENT, deps.now());
    await db.writeConsentEdge(HUMAN, agentUlid(3), deps.now());
    const res = await deleteAccountHandler(
      {
        method: 'DELETE',
        path: '/v1/account',
        headers: { authorization: 'Bearer token-1' },
      },
      deps,
      auth,
    );
    expect(res.statusCode).toBe(200);
    expect(await db.hasConsentEdge(HUMAN, AGENT)).toBe(false);
    expect(await db.hasConsentEdge(HUMAN, agentUlid(3))).toBe(false);
  });
});
