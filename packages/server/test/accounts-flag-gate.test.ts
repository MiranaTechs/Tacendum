import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import { accountsRefusal, linkOfferInitRoute } from '../src/handlers/devices.js';
import {
  deviceRevokeRoute,
  deviceUnlinkRoute,
  linkAcceptRoute,
  linkOfferSubmitRoute,
} from '../src/handlers/devices-signed.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  recoveryCancelRoute,
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../src/handlers/identifiers.js';
import { discoveryLookupRoute, setDiscoverableRoute } from '../src/handlers/discovery.js';
import { recoveryCompleteRoute } from '../src/handlers/recovery-signed.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../src/handlers/keys.js';
import { errorResult, type Handler, type HttpEvent, type HttpResult } from '../src/handlers/http.js';
import { PrivateKey } from '@signalapp/libsignal-client';
import { EMAIL_CODE_TTL_SECONDS, RECOVERY_DELAY_SECONDS, RECOVERY_DISCOVERY_COOLDOWN_SECONDS, authSignedBytes } from '@tacendum/shared';
import { activeEmailClaimKeys, activePhoneClaimKeys } from '../src/opaque-ref.js';
// THE REAL DISPATCH TABLES: the
// collapse cases below reach the handlers through the SAME tables the two
// deployed Lambdas dispatch on — never direct handler imports — so a route
// key mapped to the wrong (or no) handler fails here, not in production.
import { routes as httpDispatch } from '../src/aws/http.lambda.js';
import { routes as authDispatch } from '../src/aws/auth.lambda.js';
import { makeTestDeps, type TestDeps, KEY_FIXTURE } from './helpers.js';

/**
 * The `feature#accounts` flag gate: every accounts route added SO FAR is driven with the flag
 * OFF — THE SHIPPED DEFAULT — as the default case, and every probe answers
 * the ONE collapsed byte-stream: the dark deploy is dark by construction,
 * against custom clients too, and the same read is the kill switch.
 *
 * The flag value is injected process-locally (an override of the one read
 * method on the REAL data layer): the production row is a store-wide
 * SINGLETON, and the suite (accounts-group.test.ts) already drives the
 * real row through absent/true/malformed/deleted against the real store —
 * absent ≡ false is exactly its pinned equivalence. Two suites toggling one
 * singleton row while the heavy project runs files in parallel would race
 * each other into flakes; this suite owns the gate ORDER and the collapse,
 * not the row read.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;
let flagOn = false;
let phoneFlagOn = false;
let usernameFlagOn = false;

let deps: TestDeps;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  db = {
    ...base,
    isAccountsFeatureEnabled: async () => flagOn,
    isAccountsPhoneFeatureEnabled: async () => phoneFlagOn,
    isAccountsUsernameFeatureEnabled: async () => usernameFlagOn,
  };
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
  // The shipped defaults, restored before every test: ALL OFF.
  flagOn = false;
  phoneFlagOn = false;
  usernameFlagOn = false;
  deps = makeTestDeps(db);
});

/** Every route the accounts program has added so far — the roster this suite
 * exists to keep honest. the seven joined per this header's own
 * instruction: the six token-path identifier/recovery legs and the
 * signature-verifying recovery completion, plus
 * the discovery lookup and the consent toggle — for the lookup this OFF
 * collapse IS the kill switch (one operator write stops a
 * detected crawl). */
/** The four phone route keys — resolved from the REAL AWS dispatch
 * table (an import-path green is not deployment evidence; these
 * entries prove the keys exist in the table the deployed Lambda dispatches
 * on, and every probe below travels through them). */
const PHONE_ROUTE_KEYS = [
  'POST /v1/identifiers/phone/request-code',
  'POST /v1/identifiers/phone/verify',
  'POST /v1/identifiers/phone/unlink',
  'POST /v1/identifiers/phone/discoverable',
] as const;
const phoneDispatchRoutes: ReadonlyArray<[name: string, route: Handler]> = PHONE_ROUTE_KEYS.map(
  (key) => {
    const route = httpDispatch[key];
    if (!route) throw new Error(`phone route missing from the AWS dispatch table: ${key}`);
    return [key, route];
  },
);

/** The username route keys (including caller eligibility), resolved from
 * the REAL AWS dispatch table for the same finding-13 reason. */
const USERNAME_ROUTE_KEYS = [
  'POST /v1/identifiers/username/claim',
  'POST /v1/identifiers/username/rename',
  'POST /v1/identifiers/username/unlink',
  'POST /v1/identifiers/username/discoverable',
  'GET /v1/identifiers/username/eligibility',
] as const;
const usernameDispatchRoutes: ReadonlyArray<[name: string, route: Handler]> =
  USERNAME_ROUTE_KEYS.map((key) => {
    const route = httpDispatch[key];
    if (!route) throw new Error(`username route missing from the AWS dispatch table: ${key}`);
    return [key, route];
  });

const ROUTES: ReadonlyArray<[name: string, route: Handler]> = [
  ['POST /v1/devices/link-offer (init)', linkOfferInitRoute],
  ['POST /v1/devices/link-offer/submit', linkOfferSubmitRoute],
  ['POST /v1/devices/link-accept', linkAcceptRoute],
  ['POST /v1/devices/unlink', deviceUnlinkRoute],
  ['POST /v1/devices/revoke', deviceRevokeRoute],
  ['POST /v1/identifiers/email/request-code', emailRequestCodeRoute],
  ['POST /v1/identifiers/email/verify', emailVerifyRoute],
  ['POST /v1/identifiers/email/unlink', emailUnlinkRoute],
  ['POST /v1/recovery/request-code', recoveryRequestCodeRoute],
  ['POST /v1/recovery/verify', recoveryVerifyRoute],
  ['POST /v1/recovery/cancel', recoveryCancelRoute],
  ['POST /v1/recovery/complete', recoveryCompleteRoute],
  ['POST /v1/discovery/lookup', discoveryLookupRoute],
  ['POST /v1/identifiers/email/discoverable', setDiscoverableRoute],
  //the four phone legs join the master-flag roster THROUGH the real
  // dispatch table. They are additionally gated on their own
  // feature#accounts-phone row — the describe below owns that gate; the
  // flag-ON cases here turn BOTH flags on for exactly that reason.
  ...phoneDispatchRoutes,
  //the four username legs join the same way — gated on their own
  // feature#accounts-username row; the describe below owns that gate.
  ...usernameDispatchRoutes,
];

function probe(withBearer: boolean, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: withBearer ? { authorization: 'Bearer flag-gate-probe-token' } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('flag ABSENT (the shipped default): every route collapses', () => {
  for (const [name, route] of ROUTES) {
    gated(`${name} refuses with the collapsed error — bearer or no bearer, parseable body or garbage`, async () => {
      const results: HttpResult[] = [
        await route(probe(true, { anything: true }), deps),
        await route(probe(false, { anything: true }), deps),
        await route(probe(true, 'not json'), deps),
        await route(probe(false, ''), deps),
      ];
      for (const res of results) {
        expect(res).toEqual(accountsRefusal());
      }
    });
  }

  gated('the collapsed refusal is ONE byte-stream ACROSS routes: body, status, and headers deep-equal everywhere', async () => {
    const all: HttpResult[] = [];
    for (const [, route] of ROUTES) {
      all.push(await route(probe(true, {}), deps));
      all.push(await route(probe(false, {}), deps));
    }
    const canonical = accountsRefusal();
    for (const res of all) {
      expect(res.statusCode).toBe(canonical.statusCode);
      expect(res.headers).toEqual(canonical.headers);
      expect(res.body).toBe(canonical.body);
    }
  });

  gated('the flag is checked FIRST: a dark probe is not even told it is unauthenticated', async () => {
    // With the flag off, a bearer-less probe gets the SAME collapsed bytes
    // as everything else — never the 401 the middleware would mint — so a
    // custom client cannot even learn the routes exist behind auth.
    for (const [, route] of ROUTES) {
      const res = await route(probe(false, {}), deps);
      expect(res.statusCode).not.toBe(401);
      expect(res).toEqual(accountsRefusal());
    }
  });
});

describe('flag ON admits the routes (the per-route flows are accounts-link.test.ts’s)', () => {
  gated('with the flag on, an unauthenticated probe now reaches the bearer check — proof the gate opened', async () => {
    flagOn = true;
    // The phone and username legs demand their sub-flags too (their own
    // describes drive the master-on/sub-off collapse); this case is about
    // the gates OPENING.
    phoneFlagOn = true;
    usernameFlagOn = true;
    for (const [name, route] of ROUTES) {
      const res = await route(probe(false, {}), deps);
      expect(res.statusCode, name).toBe(401);
    }
  });

  gated('the kill switch: flag deleted after a prior enablement collapses every route again', async () => {
    flagOn = true;
    phoneFlagOn = true;
    usernameFlagOn = true;
    for (const [, route] of ROUTES) {
      expect((await route(probe(false, {}), deps)).statusCode).toBe(401);
    }
    // One operator delete later (absent = OFF — the -pinned read):
    flagOn = false;
    for (const [, route] of ROUTES) {
      expect(await route(probe(false, {}), deps)).toEqual(accountsRefusal());
      expect(await route(probe(true, {}), deps)).toEqual(accountsRefusal());
    }
  });
});

describe('surfaces join the gate: group-aware behavior on the EXISTING bundle route', () => {
  // changed an EXISTING route, so the gate here is not a collapsed
  // refusal but BYTE-IDENTITY to the shipped surface: flag OFF — or DELETED
  // after a prior enablement — must serve a GROUPED (even a REVOKED) target
  // exactly the pre-accounts bytes. The deep roster/quota assertions live in
  // accounts-roster.test.ts / accounts-quota-group.test.ts; this suite owns
  // the gate ORDER and the reversion, as it does for the routes above.
  const RUN = `${Date.now()}`;
  let seq = 0;
  const uid = (): string => `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
  const runIdentityKey = (n: number): string => {
    const bytes = Buffer.alloc(33);
    bytes[0] = 0x05;
    bytes.write(`fg${RUN}:${n}`, 1);
    return bytes.toString('base64');
  };

  async function mkKeyedUser(): Promise<string> {
    const userId = uid();
    const idKey = runIdentityKey(seq);
    const res = await db.getOrCreateUserByIdentityKey(idKey, userId, Date.now());
    expect(res.kind).toBe('ok');
    const up = await uploadKeysHandler(
      {
        method: 'PUT',
        path: '/',
        headers: {},
        body: JSON.stringify({
          registrationId: 9,
          identityKey: idKey,
          signedPrekey: { keyId: 1, pub: KEY_FIXTURE.curvePub, sig: KEY_FIXTURE.sig },
          kyberPrekey: { keyId: 2, pub: KEY_FIXTURE.kyberPub, sig: KEY_FIXTURE.sig },
          oneTimePrekeys: [],
        }),
      },
      deps,
      { userId },
    );
    expect(up.statusCode).toBe(204);
    return userId;
  }

  gated('flag deleted after enablement: a grouped target reverts to the byte-identical legacy bundle, and a revoked target’s forwarding hint disappears', async () => {
    const a = await mkKeyedUser();
    const c = await mkKeyedUser();
    const nowS = Math.floor(Date.now() / 1000);
    const offerNonce = `nonce-fg-${RUN}-${++seq}`;
    const groupId = uid();
    expect(
      await db.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: a,
        acceptorUserId: c,
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
        linkedAtMs: Date.now(),
      }),
    ).toBe('linked');
    expect(
      await db.revokeDeviceFromGroup({ groupId, actingUserId: a, targetUserId: c, rosterEpoch: 1 }),
    ).toBe('revoked');

    const fetch = async (target: string): Promise<HttpResult> =>
      getPrekeyBundleHandler(
        { method: 'GET', path: '/', headers: {}, pathParameters: { userId: target } },
        deps,
        { userId: uid() },
      );

    // ENABLED: the grouped survivor's bundle carries the device dimension,
    // and the revoked ULID serves the forwarding hint.
    flagOn = true;
    const groupedOn = await fetch(a);
    expect(groupedOn.statusCode).toBe(200);
    expect(groupedOn.body).toContain('"rosterVersion"');
    const hintOn = await fetch(c);
    expect(hintOn.statusCode).toBe(404);
    expect(hintOn.body).toContain('"recipient_revoked"');
    expect(hintOn.body).toContain('"siblings"');

    // One operator delete later: the SHIPPED surface, byte for byte — the
    // legacy bundle built in the handler's exact field order from the row
    // itself, no rosterVersion, no siblings, no hint. Enforcement stays: the
    // revoked device still gets no bundle, just the plain legacy not_found.
    flagOn = false;
    const row = await db.getUserById(a);
    const legacyBody = JSON.stringify({
      userId: a,
      registrationId: row!.registrationId,
      identityKey: row!.identityKeyPub,
      signedPrekey: row!.signedPrekey,
      kyberPrekey: row!.kyberPrekey,
      lowPrekeyCount: true,
    });
    const groupedOff = await fetch(a);
    expect(groupedOff.statusCode).toBe(200);
    expect(groupedOff.body).toBe(legacyBody);
    expect(await fetch(c)).toEqual(errorResult(404, 'not_found', 'no key bundle for this user'));
  });
});

describe("the username class's OWN gate: feature#accounts-username, AND-ed with the master, driven through the REAL dispatch table", () => {
  gated('with feature#accounts-username ABSENT and the MASTER ON, every route collapses through the real dispatch — bearer or none, well-formed, garbage, or long-garbage body (the true OVERSIZED collapse rides the adapters, accounts-routes.aws.test.ts) — while the email surface stays live', async () => {
    flagOn = true; // a LIVE accounts deploy
    for (const [name, route] of usernameDispatchRoutes) {
      const results: HttpResult[] = [
        await route(probe(true, { username: 'probe', discoverable: true }), deps),
        await route(probe(false, { username: 'probe', discoverable: true }), deps),
        await route(probe(true, 'not json'), deps),
        await route(probe(false, ''), deps),
        await route(probe(true, 'a'.repeat(4096)), deps),
      ];
      for (const res of results) {
        expect(res, name).toEqual(accountsRefusal());
        expect(res.statusCode, name).not.toBe(401);
      }
    }
    expect(
      (await httpDispatch['POST /v1/identifiers/email/request-code']!(probe(false, {}), deps))
        .statusCode,
    ).toBe(401);
  });

  gated('master OFF collapses the class; the username flag deleted AFTER enablement collapses the four legs again (the class kill switch — and the K_id rotation-window brake)', async () => {
    flagOn = true;
    usernameFlagOn = true;
    for (const [name, route] of usernameDispatchRoutes) {
      expect((await route(probe(false, {}), deps)).statusCode, name).toBe(401);
    }
    usernameFlagOn = false;
    for (const [name, route] of usernameDispatchRoutes) {
      expect(await route(probe(false, {}), deps), name).toEqual(accountsRefusal());
      expect(await route(probe(true, {}), deps), name).toEqual(accountsRefusal());
    }
    expect(
      (await httpDispatch['POST /v1/identifiers/email/request-code']!(probe(false, {}), deps))
        .statusCode,
    ).toBe(401);
    flagOn = false;
    usernameFlagOn = true;
    for (const [, route] of usernameDispatchRoutes) {
      expect(await route(probe(false, {}), deps)).toEqual(accountsRefusal());
    }
  });
});

describe("the phone train's OWN gate: feature#accounts-phone, AND-ed with the master, driven through the REAL dispatch tables", () => {
  const RUN = `${Date.now()}73`;
  let seq = 0;
  const uid = (): string => `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
  const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];

  /** Per-run NANP numbers in this describe's own `+1333` band. The base is a
   * random draw, NOT the clock (the accounts-phone.test.ts lesson):
   * `RUN.slice(-6)` was only Date.now() mod 10 000 beside the fixed '73' —
   * a 10-second cycle — while the `phonehash#` claim row the seeded phone
   * group mints persists in DynamoDB Local for as long as the container
   * lives, so a later run landing on the same clock digits met a PERSISTED
   * claim at a number it believed fresh. Every issued number is recorded so
   * `afterAll` can delete its claim rows. */
  let numSeq = 0;
  const NUMBER_BASE = randomInt(0, 10_000_000);
  const issuedNumbers: string[] = [];
  const freshNumber = (): string => {
    const number = `+1333${`${(NUMBER_BASE + ++numSeq) % 10_000_000}`.padStart(7, '0')}`;
    issuedNumbers.push(number);
    return number;
  };

  afterAll(async () => {
    if (!available) return;
    for (const number of issuedNumbers) {
      for (const claimKey of activePhoneClaimKeys(KEYS, number)) {
        await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }));
      }
    }
  });

  gated('with feature#accounts-phone ABSENT and the MASTER ON, every route collapses through the real dispatch — while the email surface stays live (the phone train is dark inside a live accounts deploy)', async () => {
    flagOn = true; // a LIVE email-v1 deploy
    for (const [name, route] of phoneDispatchRoutes) {
      const results: HttpResult[] = [
        await route(probe(true, { anything: true }), deps),
        await route(probe(false, { anything: true }), deps),
        await route(probe(true, 'not json'), deps),
      ];
      for (const res of results) expect(res, name).toEqual(accountsRefusal());
    }
    // The email surface is LIVE beside the dark phone train: the same
    // bearer-less probe of an email route reaches the bearer check.
    expect(
      (await httpDispatch['POST /v1/identifiers/email/request-code']!(probe(false, {}), deps))
        .statusCode,
    ).toBe(401);
  });

  gated('master OFF collapses both classes; the phone flag deleted AFTER enablement collapses the phone legs again (the class kill switch)', async () => {
    // Both on: the phone gate opens (bearer check reached).
    flagOn = true;
    phoneFlagOn = true;
    for (const [name, route] of phoneDispatchRoutes) {
      expect((await route(probe(false, {}), deps)).statusCode, name).toBe(401);
    }
    // One operator delete of the SUB-flag later: the phone legs collapse
    // again while email stays live.
    phoneFlagOn = false;
    for (const [name, route] of phoneDispatchRoutes) {
      expect(await route(probe(false, {}), deps), name).toEqual(accountsRefusal());
      expect(await route(probe(true, {}), deps), name).toEqual(accountsRefusal());
    }
    expect(
      (await httpDispatch['POST /v1/identifiers/email/request-code']!(probe(false, {}), deps))
        .statusCode,
    ).toBe(401);
    // Master OFF: both classes collapse.
    flagOn = false;
    phoneFlagOn = true;
    for (const [, route] of phoneDispatchRoutes) {
      expect(await route(probe(false, {}), deps)).toEqual(accountsRefusal());
    }
    expect(
      await httpDispatch['POST /v1/identifiers/email/request-code']!(probe(false, {}), deps),
    ).toEqual(accountsRefusal());
  });

  /** Seed a solo group holding one claim of `cls`, plus a PAST-DELAY pending
   * recovery for a fresh signer device — all at the data layer (the attach
   * and recovery FLOWS are the accounts-phone suites'; this suite owns the
   * gate), completion driven through the REAL auth dispatch table. */
  async function seedPendingRecovery(cls: 'email' | 'phone'): Promise<{
    groupId: string;
    completer: { token: string; userId: string };
    completeBody: () => Promise<Record<string, string>>;
    cancelToken: string;
  }> {
    const nowS = (): number => Math.floor(deps.now() / 1000);
    // The group founder (bearer only — cancel is bearer-authorized).
    const founderId = uid();
    expect((await db.getOrCreateUserByIdentityKey(`fg-idkey-${founderId}`, founderId, deps.now())).kind).toBe('ok');
    const founderToken = `fg-tok-${RUN}-${++seq}`;
    await db.createSession({ token: founderToken, userId: founderId, createdAt: deps.now(), expiresAt: nowS() + 400 * 86400 });
    const identifier = cls === 'phone' ? freshNumber() : `fg-${RUN}-${seq}@example.com`;
    const claimKey =
      cls === 'phone'
        ? activePhoneClaimKeys(KEYS, identifier)[0]!
        : activeEmailClaimKeys(KEYS, identifier.toLowerCase())[0]!;
    await db.putEmailCode({
      userId: founderId,
      purpose: 'attach',
      claimKey,
      deviceClass: 'phone',
      code: '111111',
      attempts: 0,
      createdAt: deps.now(),
      expiresAt: nowS() + EMAIL_CODE_TTL_SECONDS,
    });
    const groupId = uid();
    expect(
      await db.attachIdentifier({
        userId: founderId,
        deviceClass: 'phone',
        newGroupId: groupId,
        claimKey,
        nowMs: deps.now(),
      }),
    ).toBe('attached');
    // The recovering device: a REAL libsignal key (completion verifies a
    // real signature through the real dispatch).
    const key = PrivateKey.generate();
    const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
    const completerId = uid();
    expect((await db.getOrCreateUserByIdentityKey(pub, completerId, deps.now())).kind).toBe('ok');
    const completerToken = `fg-rec-${RUN}-${++seq}`;
    await db.createSession({ token: completerToken, userId: completerId, createdAt: deps.now(), expiresAt: nowS() + 400 * 86400 });
    expect(
      await db.putRecoveryPending({
        groupId,
        newUserId: completerId,
        deviceClass: 'tablet',
        claimKey,
        requestedAt: deps.now(),
        completesAt: nowS() + RECOVERY_DELAY_SECONDS,
        expiresAt: nowS() + RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
      }),
    ).toBe('created');
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 60) * 1000);
    const completeBody = async (): Promise<Record<string, string>> => {
      const challenge = Buffer.from(`fg-chal-${++seq}`.padEnd(32, '.')).toString('base64');
      await db.putAuthChallenge({ identityKeyPub: pub, challenge, expiresAt: nowS() + 120 });
      const pre = authSignedBytes(deps.apiOrigin, challenge);
      const buf = new Uint8Array(new ArrayBuffer(pre.length));
      buf.set(pre);
      return { groupId, challenge, signature: Buffer.from(key.sign(buf)).toString('base64') };
    };
    return {
      groupId,
      completer: { token: completerToken, userId: completerId },
      completeBody,
      cancelToken: founderToken,
    };
  }

  const completeRoute = authDispatch['POST /v1/recovery/complete']!;
  const cancelRoute = httpDispatch['POST /v1/recovery/cancel']!;
  const authed = (token: string, body: unknown): HttpEvent => ({
    method: 'POST',
    path: '/',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  });

  gated('THE DARK-WINDOW ANSWER ON THE SHARED RECOVERY LEGS, pinned as intended: master ON + phone flag ABSENT, an authenticated pristine caller — a PHONE-classed body answers the collapsed refusal while an EMAIL-classed body answers the uniform 200', async () => {
    // The shipping configuration for the whole dark window: email v1 live,
    // feature#accounts-phone absent. On the SHARED legs the phone-classed
    // request fails closed through the in-handler sub-flag read — so the
    // sub-flag's state IS readable off a shared route by any authenticated
    // caller. Pinned deliberately: that discloses deployment configuration
    // (which features are on), never an identifier — refusal uniformity governs
    // identifier-shaped answers and is not touched — and the class-blind
    // "phone miss ≡ email miss" claim is scoped to the flag-ON state (the
    // accounts-phone-recovery suite drives that one). Fail-open (answering
    // the uniform 200 and vendor-touching nothing) was refused: a dark leg
    // that half-runs is exactly what the kill switch exists to prevent.
    flagOn = true;
    const requestCodeRoute = httpDispatch['POST /v1/recovery/request-code']!;
    const verifyRoute = httpDispatch['POST /v1/recovery/verify']!;
    const callerId = uid();
    expect(
      (await db.getOrCreateUserByIdentityKey(`fg-dark-idkey-${callerId}`, callerId, deps.now()))
        .kind,
    ).toBe('ok');
    const callerToken = `fg-dark-tok-${RUN}-${++seq}`;
    await db.createSession({
      token: callerToken,
      userId: callerId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 400 * 86400,
    });
    const phoneBody = { phone: freshNumber() };
    const emailBody = { email: `fg-dark-${RUN}-${++seq}@example.com` };
    // PHONE-classed: the collapsed refusal, nothing minted, nothing sent.
    expect(await requestCodeRoute(authed(callerToken, phoneBody), deps)).toEqual(
      accountsRefusal(),
    );
    expect(
      await verifyRoute(authed(callerToken, { ...phoneBody, code: '123456', class: 'tablet' }), deps),
    ).toEqual(accountsRefusal());
    expect(deps.smsSent).toHaveLength(0);
    // EMAIL-classed from the same caller: the uniform 200 (a miss — sends
    // nothing, answers everything).
    const emailRes = await requestCodeRoute(authed(callerToken, emailBody), deps);
    expect(emailRes.statusCode).toBe(200);
    expect(emailRes.body).toBe('{}');
    expect(deps.emailsSent).toHaveLength(0);
  });

  gated('THE SHARED COMPLETION PATH, direction 1: a PHONE-class pending row refuses completion with the phone flag deleted — row intact, the member cancel still landing — through the real dispatch tables', async () => {
    flagOn = true;
    phoneFlagOn = true;
    const rig = await seedPendingRecovery('phone');
    // The birth record carries the claim-prefix-derived class.
    expect((await db.getRecoveryPending(rig.groupId))?.identifierClass).toBe('phone');
    // Flag pulled: a valid possession proof refuses with the collapsed
    // bytes; the row survives untouched.
    phoneFlagOn = false;
    expect(await completeRoute(authed(rig.completer.token, await rig.completeBody()), deps)).toEqual(
      accountsRefusal(),
    );
    const still = await db.getRecoveryPending(rig.groupId);
    expect(still?.newUserId).toBe(rig.completer.userId);
    expect(still?.canceled).toBeUndefined();
    // The safety-critical cancel lands WHILE the phone train is dark
    // (master-flag-only, on purpose) — through the real HttpFn dispatch.
    expect((await cancelRoute(authed(rig.cancelToken, {}), deps)).statusCode).toBe(200);
    expect((await db.getRecoveryPending(rig.groupId))?.canceled).toBe(true);
  });

  gated('THE SHARED COMPLETION PATH, direction 2: an EMAIL-class pending row completes with the phone flag absent throughout — and the phone-class refusal reverses when the flag returns', async () => {
    flagOn = true;
    // Email class first, phone flag ABSENT the whole way: completes.
    const emailRig = await seedPendingRecovery('email');
    expect((await db.getRecoveryPending(emailRig.groupId))?.identifierClass).toBe('email');
    const done = await completeRoute(
      authed(emailRig.completer.token, await emailRig.completeBody()),
      deps,
    );
    expect(done.statusCode).toBe(200);
    expect((await db.getUserById(emailRig.completer.userId))?.groupId).toBe(emailRig.groupId);
    // And the phone-class refusal is a GATE, not a tombstone: the same row
    // completes once the flag returns.
    phoneFlagOn = true;
    const phoneRig = await seedPendingRecovery('phone');
    phoneFlagOn = false;
    expect(
      await completeRoute(authed(phoneRig.completer.token, await phoneRig.completeBody()), deps),
    ).toEqual(accountsRefusal());
    phoneFlagOn = true;
    const phoneDone = await completeRoute(
      authed(phoneRig.completer.token, await phoneRig.completeBody()),
      deps,
    );
    expect(phoneDone.statusCode).toBe(200);
    expect((await db.getUserById(phoneRig.completer.userId))?.groupId).toBe(phoneRig.groupId);
  });
});
