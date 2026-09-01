import { describe, expect, it } from 'vitest';
import { makeUserRefSaltLoader, readIdentifierHmacKeys } from '../src/aws/deps.js';
import { emailRequestCodeRoute, emailVerifyRoute } from '../src/handlers/identifiers.js';
import { usernameClaimRoute, usernameRefusal } from '../src/handlers/username.js';
import type { Deps, HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * FIELD REPORT (build 23): the FIRST "Claim this name" on a
 * physical iPhone answers the frozen 403 ("That did not go through. Try
 * again later."); the SECOND tap, 2-4 s later, succeeds. The API access log
 * shows both first-tap refusals were the first identifier-lane request a
 * freshly initialized HttpFn container served, with NO handler event (refused
 * before `username_claim_admitted`), and the retry landed on the SAME
 * container and committed.
 *
 * THE MECHANISM UNDER TEST: production wires `Deps.identifierHmac` as a live
 * getter over `readIdentifierHmacKeys`, whose default loader is
 * `makeUserRefSaltLoader` — a SYNCHRONOUS read that, on its first call in a
 * container, STARTS the Secrets Manager fetch and answers `undefined`.
 * `makeAwsDeps` prewarms the TURN, APNs, FCM and user-ref-salt fetches at
 * construction (aws/deps.ts:405-408) but NOT K_id, so the first identifier
 * route a container serves pays the kick-off read itself and is refused by
 * `hmacKeys(deps) === undefined` (handlers/username.ts:149-150).
 *
 * This suite drives the REAL claim route with a Deps whose `identifierHmac`
 * is wired exactly as production wires it (live getter -> readIdentifierHmacKeys
 * -> makeUserRefSaltLoader with an injected, instantly-resolving fetch — no
 * Secrets Manager client is ever constructed), for a verified-email, grouped,
 * 73 h-old caller that passes every gate. A caller who passes every gate
 * must be admitted on the FIRST request the container serves.
 */

const TEST_KID = 'test-identifier-hmac-key';
const HOUR_MS = 3_600_000;
const RUN = `${Date.now()}77`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

function post(token: string, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

/** A fresh "container": deps whose K_id reaches the handler through the
 * production loader machinery, cold — the fetch has not been started. The
 * fetch itself resolves on the next microtask, like a warm Secrets Manager
 * answer; the shape under test is the loader's, not the network's. */
function coldContainerDeps(db: ReturnType<typeof makeMemoryDb>) {
  const fetches: string[] = [];
  const loadKey = makeUserRefSaltLoader(async (arn) => {
    fetches.push(arn);
    return TEST_KID;
  }, 'identifier_hmac_key_fetch_failed');
  const env = { IDENTIFIER_HMAC_KEY_ARN: 'arn:aws:secretsmanager:test:kid' };
  const base = makeTestDeps(db);
  // A property DESCRIPTOR, not Object.assign (which would evaluate the getter
  // once and freeze its first `undefined` — the very snapshot bug aws/deps.ts
  // documents against). The production wiring (aws/deps.ts:452-454): re-read
  // per access, the default loader replaced by one that never touches AWS.
  const deps = Object.create(base, {
    fetches: { value: fetches, enumerable: true },
    identifierHmac: {
      enumerable: true,
      get: () => readIdentifierHmacKeys(env, loadKey, () => undefined),
    },
  }) as Deps & { fetches: string[] };
  return { deps, base };
}

describe('the username claim on a COLD container (field report: first tap refused, second tap admitted)', () => {
  it('a verified, grouped, 73 h-old caller is ADMITTED on the first identifier-lane request the container serves', async () => {
    const db = makeMemoryDb();
    db.setAccountsFeatureEnabled(true);
    db.setAccountsUsernameFeatureEnabled(true);
    const { deps, base } = coldContainerDeps(db);

    // The caller: born at T, an email verified through the REAL attach
    // routes (the lazy-solo group and the possession proof), aged past
    // the 72 h gate. The attach routes need K_id too, so they run against
    // the base deps (the warm-container view) — the case is about the
    // claim's FIRST read on the cold deps below.
    const userId = uid();
    const res = await db.getOrCreateUserByIdentityKey(`idkey-cold-${userId}`, userId, base.now());
    expect(res.kind).toBe('ok');
    const token = `cold-tok-${RUN}`;
    await db.createSession({
      token,
      userId,
      createdAt: base.now(),
      expiresAt: Math.floor(base.now() / 1000) + 400 * 86_400,
    });
    const email = `${userId}@example.test`;
    expect(
      (await emailRequestCodeRoute(post(token, { email, class: 'phone' }), base)).statusCode,
    ).toBe(200);
    const code = base.emailsSent.at(-1)!.code;
    expect((await emailVerifyRoute(post(token, { email, code }), base)).statusCode).toBe(200);
    base.advanceMs(73 * HOUR_MS);
    expect((await db.getUserById(userId))?.groupId).toBeDefined();

    // Nothing has touched K_id on this container yet — exactly the state
    // the reported first tap found (a container warmed only by ws-ticket
    // and push-token calls).
    expect(deps.fetches).toEqual([]);

    // THE FIRST TAP. The only thing cold is K_id.
    const first = await usernameClaimRoute(post(token, { username: 'coldstart', discoverable: true }), deps);
    // The fetch was kicked off BY this request — the read that refused it.
    expect(deps.fetches).toEqual(['arn:aws:secretsmanager:test:kid']);
    // What the SECOND tap saw is what the first must answer.
    expect(
      { statusCode: first.statusCode, refusedBeforeAdmission: first === usernameRefusal() },
      'first identifier-lane request on a fresh container: refused by hmacKeys(deps) === undefined before username_claim_admitted',
    ).toEqual({ statusCode: 200, refusedBeforeAdmission: false });
  });

  it('the name lands on the FIRST tap, and the same bytes a moment later on the same container are a same-name rename — never a second claim (the asymmetry the report describes, closed)', async () => {
    const db = makeMemoryDb();
    db.setAccountsFeatureEnabled(true);
    db.setAccountsUsernameFeatureEnabled(true);
    const { deps, base } = coldContainerDeps(db);
    const userId = uid();
    await db.getOrCreateUserByIdentityKey(`idkey-cold-${userId}`, userId, base.now());
    const token = `cold-tok-${RUN}-b`;
    await db.createSession({
      token,
      userId,
      createdAt: base.now(),
      expiresAt: Math.floor(base.now() / 1000) + 400 * 86_400,
    });
    const email = `${userId}@example.test`;
    await emailRequestCodeRoute(post(token, { email, class: 'phone' }), base);
    const code = base.emailsSent.at(-1)!.code;
    await emailVerifyRoute(post(token, { email, code }), base);
    base.advanceMs(73 * HOUR_MS);

    const body = { username: 'coldstartb', discoverable: true };
    const first = await usernameClaimRoute(post(token, body), deps);
    // Let the in-flight fetch land (the reported 2-4 s between taps).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await usernameClaimRoute(post(token, body), deps);
    const claimed = base.logs.filter((l) => l.event === 'username_claimed').length;
    const renamed = base.logs.filter((l) => l.event === 'username_renamed').length;
    // The FIRST tap is the claim (before the fix: a 403 with no handler
    // event, and the second tap the claim — the CloudWatch picture exactly).
    // The second tap of identical bytes then reaches a group that already
    // holds the name: the claim verb IS rename for a holder a
    // same-name rename is a no-op that must not consume the cool-down, and
    // it answers the frozen refusal — never a second claim, never a rename.
    expect({ first: first.statusCode, second: second.statusCode, claimed, renamed }).toEqual({
      first: 200,
      second: 403,
      claimed: 1,
      renamed: 0,
    });
  });

  it('a K_id fetch that FAILS stays the collapsed refusal — the lane waits for a value, never invents one', async () => {
    const db = makeMemoryDb();
    db.setAccountsFeatureEnabled(true);
    db.setAccountsUsernameFeatureEnabled(true);
    const base = makeTestDeps(db);
    let attempts = 0;
    const loadKey = makeUserRefSaltLoader(async () => {
      attempts += 1;
      throw new Error('secrets manager unreachable');
    }, 'identifier_hmac_key_fetch_failed');
    const env = { IDENTIFIER_HMAC_KEY_ARN: 'arn:aws:secretsmanager:test:kid' };
    const deps = Object.create(base, {
      identifierHmac: {
        enumerable: true,
        get: () => readIdentifierHmacKeys(env, loadKey, () => undefined),
      },
    }) as Deps;
    const userId = uid();
    await db.getOrCreateUserByIdentityKey(`idkey-cold-${userId}`, userId, base.now());
    const token = `cold-tok-${RUN}-c`;
    await db.createSession({
      token,
      userId,
      createdAt: base.now(),
      expiresAt: Math.floor(base.now() / 1000) + 400 * 86_400,
    });
    const res = await usernameClaimRoute(post(token, { username: 'coldstartc', discoverable: true }), deps);
    expect(res).toBe(usernameRefusal());
    // One fetch per read that found nothing cached — the failed fetch is not
    // retried inside the wait, and no handler event fired.
    expect(attempts).toBe(1);
    expect(base.logs.filter((l) => l.event === 'username_claim_admitted')).toEqual([]);
  });
});
