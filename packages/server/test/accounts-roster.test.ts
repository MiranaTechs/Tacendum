import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { PrekeyBundle, RevokedKeysHint, TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../src/handlers/keys.js';
import { errorResult, type HttpEvent } from '../src/handlers/http.js';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/**
 * the roster in the bundle response, against REAL
 * DynamoDB (heavy project; skips only when DDB Local is down and
 * TACENDUM_REQUIRE_DDB is unset — set it so a skipped run
 * can never read as a pass).
 *
 * The four pinned properties:
 * 1. SOLO target ⇒ the response is BYTE-IDENTICAL to the legacy shape —
 * asserted against a CAPTURED fixture (prekey-bundle-legacy.fixture.json,
 * captured from the previous handler), never by
 * field-presence: old clients see NOTHING new.
 * 2. GROUPED target ⇒ `rosterVersion` + `siblings` (certs included) ride
 * the bundle, appended after every legacy field.
 * 3. A REVOKED member never appears in ANY response after the revoke
 * transaction commits — not in a survivor's sibling list, and its own
 * ULID serves no bundle (enforcement, NOT flag-gated) while the
 * forwarding hint (surviving roster + certs) IS flag-gated disclosure.
 * 4. Flag OFF — or DELETED after a prior enablement — ⇒ a GROUPED target
 * still gets the byte-identical legacy response and no forwarding hint:
 * the kill switch restores the shipped surface.
 *
 * The flag is injected process-locally (the accounts-flag-gate.test.ts
 * pattern): the production row is a store-wide singleton the suite
 * already drives; two suites toggling it under the heavy project's parallel
 * files would race each other into flakes.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prekey-bundle-legacy.fixture.json'), 'utf8'),
) as {
  userId: string;
  registrationId: number;
  identityKeySeed: number;
  signedPrekeyKeyId: number;
  kyberPrekeyKeyId: number;
  result: { statusCode: number; headers: Record<string, string>; body: string };
};

let db: DataLayer;
let available = false;
let flagOn = false;
let deps: TestDeps;

/** Run-unique valid ULIDs (digits are valid Crockford base32). */
const RUN = `${Date.now()}`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

const NOW_S = Math.floor(Date.now() / 1000);
const b64 = (s: string): string => Buffer.from(s).toString('base64');

/** A run-unique, canonical, 0x05-prefixed 33-byte identity key. Run-unique
 * (unlike the fixture's deliberately deterministic key) because the idkey
 * claim is store-global: a rerun reusing a seed would resolve the PREVIOUS
 * run's account instead of minting this run's user. */
function runIdentityKey(n: number): string {
  const bytes = Buffer.alloc(33);
  bytes[0] = 0x05;
  bytes.write(`${RUN}:${n}`, 1);
  return bytes.toString('base64');
}

beforeAll(async () => {
  const client = makeDynamoClient();
  const base = makeDataLayer(makeDocClient(client));
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
  flagOn = false; // the shipped default, restored before every test
  deps = makeTestDeps(db);
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

/** Create an account with published keys, exactly as a registered client
 * leaves it: idkey-claimed row + registrationId + signed/kyber prekeys and
 * an EMPTY one-time pool (deterministic: bundles are signed-prekey-only with
 * `lowPrekeyCount`, so repeated fetches serve identical bytes). */
async function mkKeyedUser(seed: number, userId = uid()): Promise<string> {
  const idKey = runIdentityKey(seed);
  const res = await db.getOrCreateUserByIdentityKey(idKey, userId, Date.now());
  expect(res.kind).toBe('ok');
  const upload = {
    registrationId: 1000 + seed,
    identityKey: idKey,
    signedPrekey: { keyId: 1, pub: idKey, sig: idKey },
    kyberPrekey: { keyId: 2, pub: idKey, sig: idKey },
    oneTimePrekeys: [],
  };
  const up = await uploadKeysHandler(
    { method: 'PUT', path: '/', headers: {}, body: JSON.stringify(upload) },
    deps,
    { userId: res.kind === 'ok' ? res.user.userId : userId },
  );
  expect(up.statusCode).toBe(204);
  return userId;
}

/** Link two keyed users into a fresh phone+tablet group via the REAL link
 * transaction (base64 sigs so the served certs stay zod-clean on the wire). */
async function mkGroup(
  offererUserId: string,
  acceptorUserId: string,
): Promise<{ groupId: string; offerSig: string; acceptSig: string }> {
  const groupId = uid();
  const offerNonce = `nonce-${RUN}-${++seq}`;
  const offerSig = b64(`offer-${offerNonce}`);
  const acceptSig = b64(`accept-${offerNonce}`);
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId,
      offererUserId,
      acceptorUserId,
      acceptorClass: 'tablet',
      offererClass: 'phone',
      rosterEpoch: 0,
      expiresAt: NOW_S + 600,
      offerSig,
    }),
  ).toBe('created');
  expect(
    await db.linkDeviceToGroup({
      offerNonce,
      acceptSig,
      nowSeconds: NOW_S,
      linkedAtMs: Date.now(),
    }),
  ).toBe('linked');
  return { groupId, offerSig, acceptSig };
}

function bundleEvent(userId: string): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId } };
}

/** The EXPECTED legacy body for a keyed user with an empty one-time pool —
 * built in the handler's exact field order from the user's OWN stored row
 * (nested key order therefore matches what the handler serializes), and
 * proven to BE the legacy order by the captured-fixture test below. */
async function legacyBodyFor(userId: string): Promise<string> {
  const row = await db.getUserById(userId);
  expect(row?.registrationId).toBeDefined();
  return JSON.stringify({
    userId,
    registrationId: row!.registrationId,
    identityKey: row!.identityKeyPub,
    signedPrekey: row!.signedPrekey,
    kyberPrekey: row!.kyberPrekey,
    lowPrekeyCount: true,
  });
}

describe('solo target: byte-identical to the CAPTURED legacy fixture', () => {
  gated('the live handler reproduces the previous capture exactly — status, headers, body bytes — with the flag ON and OFF', async () => {
    // Recreate the fixture's deterministic state (idempotent: the same
    // identity key resolves the same account on reruns; the re-upload
    // replaces the pool with the same empty pool).
    const idKey = testIdentityKey(FIXTURE.identityKeySeed);
    const res = await db.getOrCreateUserByIdentityKey(idKey, FIXTURE.userId, 1_700_000_000_000);
    expect(res.kind).toBe('ok');
    const target = res.kind === 'ok' ? res.user.userId : FIXTURE.userId;
    expect(target).toBe(FIXTURE.userId);
    const up = await uploadKeysHandler(
      {
        method: 'PUT',
        path: '/',
        headers: {},
        body: JSON.stringify({
          registrationId: FIXTURE.registrationId,
          identityKey: idKey,
          signedPrekey: { keyId: FIXTURE.signedPrekeyKeyId, pub: idKey, sig: idKey },
          kyberPrekey: { keyId: FIXTURE.kyberPrekeyKeyId, pub: idKey, sig: idKey },
          oneTimePrekeys: [],
        }),
      },
      deps,
      { userId: FIXTURE.userId },
    );
    expect(up.statusCode).toBe(204);

    for (const on of [false, true]) {
      flagOn = on;
      const got = await getPrekeyBundleHandler(bundleEvent(FIXTURE.userId), deps, { userId: uid() });
      expect(got.statusCode, `flag ${on}`).toBe(FIXTURE.result.statusCode);
      expect(got.headers, `flag ${on}`).toEqual(FIXTURE.result.headers);
      // THE assertion: the exact captured bytes, not field-presence.
      expect(got.body, `flag ${on}`).toBe(FIXTURE.result.body);
    }
  });
});

describe('grouped target: siblings + roster version; kill switch restores legacy bytes', () => {
  gated('flag ON serves rosterVersion + siblings with certs; flag OFF (deleted after enablement) serves the byte-identical legacy response', async () => {
    const a = await mkKeyedUser(31);
    const c = await mkKeyedUser(32);
    const { groupId, offerSig, acceptSig } = await mkGroup(a, c);

    // Deleted-after-enablement ORDER matters: enable first, observe the new
    // surface, then delete — the kill-switch case.
    flagOn = true;
    const grouped = await getPrekeyBundleHandler(bundleEvent(c), deps, { userId: uid() });
    expect(grouped.statusCode).toBe(200);
    const parsed = PrekeyBundle.parse(JSON.parse(grouped.body ?? ''));
    expect(parsed.rosterVersion).toBe(1);
    expect(parsed.siblings?.map((s) => s.userId)).toEqual([a]);
    expect(parsed.siblings?.[0]?.class).toBe('phone');
    // The certificates ride the sibling entry (availability copy).
    expect(parsed.siblings?.[0]?.certs!.offerSig).toBe(offerSig);
    expect(parsed.siblings?.[0]?.certs!.acceptSig).toBe(acceptSig);
    expect(parsed.siblings?.[0]?.certs!.groupId).toBe(groupId);
    // The legacy fields still lead the body unchanged: the additive rule.
    const legacy = await legacyBodyFor(c);
    expect(grouped.body?.startsWith(legacy.slice(0, -1))).toBe(true);

    flagOn = false; // one operator delete later (absent = OFF, the pin)
    const dark = await getPrekeyBundleHandler(bundleEvent(c), deps, { userId: uid() });
    expect(dark.statusCode).toBe(200);
    expect(dark.body).toBe(legacy); // byte-identical, no siblings, no version
  });
});

describe('a revoked member never appears; the forwarding hint is flag-gated disclosure', () => {
  gated('after revoke: gone from the survivor’s siblings; its own ULID serves the hint with flag ON and plain legacy not_found with flag OFF; sends to it refuse with the stale-roster error', async () => {
    const a = await mkKeyedUser(41);
    const c = await mkKeyedUser(42);
    const { groupId } = await mkGroup(a, c);
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: a,
        targetUserId: c,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');

    flagOn = true;
    // 1. The survivor's roster: the revoked member NEVER appears.
    const survivor = await getPrekeyBundleHandler(bundleEvent(a), deps, { userId: uid() });
    expect(survivor.statusCode).toBe(200);
    const parsedSurvivor = PrekeyBundle.parse(JSON.parse(survivor.body ?? ''));
    expect(parsedSurvivor.rosterVersion).toBe(2); // the revoke bumped the epoch
    expect(parsedSurvivor.siblings).toEqual([]);

    // 2. The dead ULID: no bundle, but the forwarding hint — surviving
    // roster + certs, ApiError-shaped so old clients read a plain 404.
    const hint = await getPrekeyBundleHandler(bundleEvent(c), deps, { userId: uid() });
    expect(hint.statusCode).toBe(404);
    const parsedHint = RevokedKeysHint.parse(JSON.parse(hint.body ?? ''));
    expect(parsedHint.error.code).toBe('recipient_revoked');
    expect(parsedHint.rosterVersion).toBe(2);
    expect(parsedHint.siblings.map((s) => s.userId)).toEqual([a]);
    expect(parsedHint.siblings.some((s) => s.userId === c)).toBe(false);

    // 3. Kill switch: the hint is DISCLOSURE and disappears with the flag —
    // but the bundle stays refused (enforcement is never flag-gated): the
    // response is the byte-identical legacy not_found.
    flagOn = false;
    const dark = await getPrekeyBundleHandler(bundleEvent(c), deps, { userId: uid() });
    expect(dark).toEqual(errorResult(404, 'not_found', 'no key bundle for this user'));

    // 4. — sends targeting the revoked member refuse with the
    // stale-roster error at enqueue and an unknown member 404s.
    const posted: Array<{ frame: unknown }> = [];
    const wsDeps: WsDeps = {
      ...deps,
      sender: {
        post: async (_connectionId, frame) => {
          posted.push({ frame });
          return true;
        },
      },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const send = (to: string) =>
      wsDefaultHandler(
        {
          routeKey: '$default' as const,
          connectionId: 'conn-a',
          senderUserId: a,
          body: JSON.stringify({
            type: 'send',
            to,
            msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
            msgType: 'ciphertext',
            payload: 'QUJD',
          }),
        },
        wsDeps,
      );
    const revoked = await send(c);
    expect(revoked.statusCode).toBe(403);
    expect((posted.at(-1)?.frame as { code?: string }).code).toBe('recipient_revoked');
    const unknown = await send(uid());
    expect(unknown.statusCode).toBe(404);
    expect((posted.at(-1)?.frame as { code?: string }).code).toBe('unknown_recipient');
  });
});
