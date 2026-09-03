import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
  RECOVERY_DELAY_SECONDS,
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  TABLES,
  authSignedBytes,
  type RecoveryVerifyResponse,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  emailCooldownKeyFromClaimKey,
  identifierClaimDiscoverable,
  makeTestOnlyDataLayer,
  phoneCooldownKeyFromClaimKey,
  recoveryRowKey,
  type TestOnlyDataLayer,
} from '../src/db/data.js';
import { activeEmailClaimKeys, activePhoneClaimKeys } from '../src/opaque-ref.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneUnlinkRoute,
  phoneVerifyRoute,
  recoveryCancelRoute,
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../src/handlers/identifiers.js';
import { recoveryCompleteRoute } from '../src/handlers/recovery-signed.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Recovery-by-phone against REAL DynamoDB and REAL libsignal signatures, on
 * the INJECTED clock throughout (never a frozen now beside advancing
 * timers). The edges by name: the class-blind collapse (a phone miss, an
 * email miss, and a linked-number hit answer identical bytes), THE
 * KILL-SWITCH DOMINANCE (identifierClass recorded at birth from the proving
 * claim PREFIX; a phone-class row refuses completion while
 * feature#accounts-phone is off, row intact, cancel still landing; an
 * email-class row is untouched), and delay/cancel/cool-down parity with the
 * phonecool# shadow arming the re-attach re-arm for the second class.
 *
 * THIS FILE IS `heavy` (vitest.config.ts) AND CI RUNS ONLY `fast`. THE
 * PARALLEL-FIELD WIRE's store-blind half (the captured pre-phone-amendment
 * {email} bodies parsing and replaying byte-identically through the amended
 * handlers, and the deliberate `.strict()` narrowing) therefore lives in
 * accounts-phone-recovery.wire.test.ts, which stays in `fast` and keeps
 * running on every PR: those are the wire-compat pins the strict-zod client
 * with no OTA path depends on. What remains under that
 * name here is the malformed-shape collapse, which needs the real store. */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: TestOnlyDataLayer;
let available = false;
let flagOn = true;
let phoneFlagOn = true;

const RUN = `${Date.now()}72`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
/** Per-run NANP numbers in this file's own `+1444` band (inside the
 * allowlist). The base is a random draw, NOT the clock (the
 * accounts-phone.test.ts lesson): `RUN.slice(-6)` was only Date.now mod
 * 10 000 beside the fixed '72' — a 10-second cycle — while the `phonehash#`
 * claim rows this suite mints persist in DynamoDB Local for as long as the
 * container lives, so a later run landing on the same clock digits met a
 * PERSISTED claim at a number it believed fresh. Every issued number is
 * recorded so `afterAll` can delete its claim rows. */
let numSeq = 0;
const NUMBER_BASE = randomInt(0, 10_000_000);
const issuedNumbers: string[] = [];
function freshNumber(): string {
  const number = `+1444${`${(NUMBER_BASE + ++numSeq) % 10_000_000}`.padStart(7, '0')}`;
  issuedNumbers.push(number);
  return number;
}

const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];

interface Acct {
  userId: string;
  token: string;
  pub: string;
  key: PrivateKey;
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
  expect(res).toEqual(accountsRefusal());
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  db = {
    ...base,
    isAccountsFeatureEnabled: async () => flagOn,
    isAccountsPhoneFeatureEnabled: async () => phoneFlagOn,
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
  flagOn = true;
  phoneFlagOn = true;
});

// The store outlives the run: every `phonehash#` claim row this suite minted
// at one of its fresh numbers is deleted, whatever the case's outcome, so no
// later run — or sibling suite — meets a stale claim at a number it believes
// fresh. Only the rows THIS run's numbers address.
afterAll(async () => {
  if (!available) return;
  for (const number of issuedNumbers) {
    for (const claimKey of activePhoneClaimKeys(KEYS, number)) {
      await doc.send(new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }));
    }
  }
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

async function mkAcct(deps: TestDeps): Promise<Acct> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `phrec-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 400 * 24 * 3600,
  });
  return { userId, token, pub, key };
}

/** A solo founder with a verified PHONE, built through the real routes (the
 * lazy solo group — the accounts-phone suite drives the two-member case). */
async function mkPhoneGroup(
  deps: TestDeps,
  number: string,
): Promise<{ owner: Acct; groupId: string; claimKey: string }> {
  const owner = await mkAcct(deps);
  expect(
    (await phoneRequestCodeRoute(post(owner.token, { phone: number, class: 'phone' }), deps))
      .statusCode,
  ).toBe(200);
  const code = deps.smsSent.at(-1)!.code;
  expect(
    (await phoneVerifyRoute(post(owner.token, { phone: number, code }), deps)).statusCode,
  ).toBe(200);
  const groupId = (await db.getUserById(owner.userId))!.groupId!;
  return { owner, groupId, claimKey: activePhoneClaimKeys(KEYS, number)[0]! };
}

async function openPhoneRecovery(
  deps: TestDeps,
  number: string,
  deviceClass: 'phone' | 'tablet' = 'phone',
): Promise<{ device: Acct; pending: RecoveryVerifyResponse }> {
  const device = await mkAcct(deps);
  deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
  expect(
    (await recoveryRequestCodeRoute(post(device.token, { phone: number }), deps)).statusCode,
  ).toBe(200);
  const code = deps.smsSent.at(-1)!.code;
  const res = await recoveryVerifyRoute(
    post(device.token, { phone: number, code, class: deviceClass }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return { device, pending: parseBody<RecoveryVerifyResponse>(res.body) };
}

async function possessionProof(
  deps: TestDeps,
  acct: Acct,
): Promise<{ challenge: string; signature: string }> {
  const challenge = Buffer.from(`phrec-chal-${++seq}`.padEnd(32, '.')).toString('base64');
  await db.putAuthChallenge({
    identityKeyPub: acct.pub,
    challenge,
    expiresAt: Math.floor(deps.now() / 1000) + 120,
  });
  const pre = authSignedBytes(deps.apiOrigin, challenge);
  const buf = new Uint8Array(new ArrayBuffer(pre.length));
  buf.set(pre);
  return { challenge, signature: Buffer.from(acct.key.sign(buf)).toString('base64') };
}

async function complete(deps: TestDeps, device: Acct, groupId: string): Promise<HttpResult> {
  const proof = await possessionProof(deps, device);
  return recoveryCompleteRoute(post(device.token, { groupId, ...proof }), deps);
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

describe('THE PARALLEL-FIELD WIRE: the malformed shapes collapse (the landed-wire replay pins live in accounts-phone-recovery.wire.test.ts, which stays in the fast project CI runs)', () => {
  gated('a both-populated {email, phone} payload and a neither-populated one are each MALFORMED and collapse — on both recovery legs', async () => {
    const deps = makeTestDeps(db);
    const caller = await mkAcct(deps);
    for (const body of [
      { email: `both-${RUN}@example.com`, phone: freshNumber() },
      {},
      { code: '123456', class: 'phone' },
      { email: `both2-${RUN}@example.com`, phone: freshNumber(), code: '123456', class: 'phone' },
    ]) {
      const isVerifyShape = 'code' in body;
      if (!isVerifyShape) {
        expectRefused(await recoveryRequestCodeRoute(post(caller.token, body), deps));
      } else {
        expectRefused(await recoveryVerifyRoute(post(caller.token, body), deps));
      }
    }
  });
});

describe('recovery-by-phone against real DynamoDB: the class-blind collapse and the full ceremony', () => {
  gated('recovery request-code answers BYTE-IDENTICAL for a linked number, an unknown number, AND an email-shaped miss — and only the linked number produces a send', async () => {
    const deps = makeTestDeps(db);
    const number = freshNumber();
    await mkPhoneGroup(deps, number);

    const prober = await mkAcct(deps);
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    const sendsBefore = deps.smsSent.length;
    const hit = await recoveryRequestCodeRoute(post(prober.token, { phone: number }), deps);
    expect(hit.statusCode).toBe(200);
    expect(deps.smsSent.length).toBe(sendsBefore + 1);

    const missTaker = await mkAcct(deps);
    const phoneMiss = await recoveryRequestCodeRoute(
      post(missTaker.token, { phone: freshNumber() }),
      deps,
    );
    expect(phoneMiss).toEqual(hit);

    const emailMissTaker = await mkAcct(deps);
    const emailMiss = await recoveryRequestCodeRoute(
      post(emailMissTaker.token, { email: `nobody-${RUN}@example.com` }),
      deps,
    );
    // CLASS-BLIND: which identifier field the caller populated teaches
    // nothing — the email-shaped miss answers the same bytes too.
    expect(emailMiss).toEqual(hit);
    expect(deps.smsSent.length).toBe(sendsBefore + 1);
    expect(deps.emailsSent.length).toBe(0);
  });

  gated('delay + member-cancel parity on the injected clock: inside the 72 h a valid proof refuses; a surviving member cancels WHILE THE PHONE FLAG IS OFF and the cancel wins', async () => {
    const deps = makeTestDeps(db);
    const number = freshNumber();
    const { owner, groupId } = await mkPhoneGroup(deps, number);
    const { device, pending } = await openPhoneRecovery(deps, number, 'tablet');
    expect(pending.groupId).toBe(groupId);
    expect(pending.completesAt).toBe(Math.floor(deps.now() / 1000) + RECOVERY_DELAY_SECONDS);

    // INSIDE the delay: a valid possession proof refuses (not_ready).
    deps.advanceMs((RECOVERY_DELAY_SECONDS - 3600) * 1000);
    expectRefused(await complete(deps, device, groupId));

    // THE CANCEL LEG STAYS MASTER-FLAG-ONLY: the surviving member's
    // safety-critical cancel lands even with the phone train dark.
    phoneFlagOn = false;
    expect((await recoveryCancelRoute(post(owner.token, {}), deps)).statusCode).toBe(200);
    phoneFlagOn = true;

    // The delay elapses fully — the cancel still wins.
    deps.advanceMs(2 * 3600 * 1000);
    expectRefused(await complete(deps, device, groupId));
    expect((await db.getUserById(device.userId))?.groupId).toBeUndefined();
  });

  gated('THE KILL-SWITCH DOMINANCE: the pending row records identifierClass=phone from the proving claim PREFIX; completion REFUSES with the flag deleted (row intact) then COMPLETES when it returns — and arms the cool-down on claim + group rows AND the phonecool# shadow, which a later unlink-then-re-attach RE-ARMS from', async () => {
    const deps = makeTestDeps(db);
    const number = freshNumber();
    const { groupId, claimKey } = await mkPhoneGroup(deps, number);
    const { device } = await openPhoneRecovery(deps, number, 'tablet');

    // The class was recorded AT BIRTH, derived from the claim-key prefix —
    // asserted on the RAW row (never a wire field: nothing on the wire
    // could have asserted it).
    const rawPending = await rawRow(SERVER_TABLES.users, { userId: recoveryRowKey(groupId) });
    expect(rawPending?.identifierClass).toBe('phone');
    expect(rawPending?.claimKey).toBe(claimKey);

    // Past the delay, with the phone flag DELETED: a valid possession proof
    // refuses with the collapsed bytes, and the row is INTACT (a refusal,
    // not a cancel).
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 60) * 1000);
    phoneFlagOn = false;
    expectRefused(await complete(deps, device, groupId));
    const stillPending = await db.getRecoveryPending(groupId);
    expect(stillPending?.newUserId).toBe(device.userId);
    expect(stillPending?.canceled).toBeUndefined();
    expect((await db.getUserById(device.userId))?.groupId).toBeUndefined();

    // The flag returns: the SAME row completes.
    phoneFlagOn = true;
    const done = await complete(deps, device, groupId);
    expect(done.statusCode).toBe(200);
    expect((await db.getUserById(device.userId))?.groupId).toBe(groupId);

    // COOL-DOWN parity (read-time rule, second class): stamped on the
    // claim row AND the group row AND the phonecool# number-keyed shadow.
    const nowS = Math.floor(deps.now() / 1000);
    const horizon = nowS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS;
    const claim = (await db.getIdentifierClaim(claimKey))!;
    expect(claim.discoverableAfter).toBe(horizon);
    expect(identifierClaimDiscoverable({ discoverable: true, discoverableAfter: claim.discoverableAfter! }, nowS)).toBe(false);
    expect((await db.getAccountGroup(groupId))?.discoverableAfter).toBe(horizon);
    const shadow = await rawRow(SERVER_TABLES.users, {
      userId: phoneCooldownKeyFromClaimKey(claimKey),
    });
    expect(shadow?.kind).toBe('phoneCooldown');
    expect(shadow?.discoverableAfter).toBe(horizon);

    // THE RE-ARM (f2, second class): unlink the phone, re-attach the
    // SAME number — the fresh claim row is born already carrying the
    // cool-down. HONESTY: this re-attach comes from a
    // MEMBER of the surviving group, so the group-row carrier answers
    // before the shadow is read — the shadow's OWN path (a brand-new
    // account, no group carrier in reach) is driven by the cross-class
    // carriers case below, for both classes.
    expect((await phoneUnlinkRoute(post(device.token, {}), deps)).statusCode).toBe(200);
    expect(await db.getIdentifierClaim(claimKey)).toBeUndefined();
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    // Next UTC day for the per-number send budget (3/day was spent by the
    // attach + recovery sends); the cool-down horizon is 7 days out, so it
    // is STILL live when the re-attach lands.
    deps.advanceMs(24 * 3600 * 1000);
    expect(
      (await phoneRequestCodeRoute(post(device.token, { phone: number, class: 'tablet' }), deps))
        .statusCode,
    ).toBe(200);
    const code = deps.smsSent.at(-1)!.code;
    expect(
      (await phoneVerifyRoute(post(device.token, { phone: number, code }), deps)).statusCode,
    ).toBe(200);
    const rearmed = (await db.getIdentifierClaim(claimKey))!;
    expect(rearmed.discoverableAfter).toBe(horizon);
  });

  gated('THE CROSS-CLASS COOL-DOWN CARRIERS: a PHONE-proved completion arms the shadow for BOTH classes, and each shadow re-arms a fresh-account re-attach of ITS identifier — the path no group-row carrier can reach', async () => {
    const deps = makeTestDeps(db);
    const number = freshNumber();
    const { owner, groupId, claimKey: phoneKey } = await mkPhoneGroup(deps, number);
    // One email BESIDE the phone (the coexist shape) — so the completion
    // must stamp a shadow for a class that did NOT prove the code.
    const email = `crossclass-${RUN}@example.com`;
    expect(
      (await emailRequestCodeRoute(post(owner.token, { email, class: 'phone' }), deps)).statusCode,
    ).toBe(200);
    const emailAttachCode = deps.emailsSent.at(-1)!.code;
    expect(
      (await emailVerifyRoute(post(owner.token, { email, code: emailAttachCode }), deps))
        .statusCode,
    ).toBe(200);
    const emailKey = activeEmailClaimKeys(KEYS, email)[0]!;

    // Recovery proved by PHONE; complete past the delay.
    const { device } = await openPhoneRecovery(deps, number, 'tablet');
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 60) * 1000);
    expect((await complete(deps, device, groupId)).statusCode).toBe(200);
    const horizon = Math.floor(deps.now() / 1000) + RECOVERY_DISCOVERY_COOLDOWN_SECONDS;

    // BOTH class shadows exist — the phone one (the proving class) AND the
    // email one (the class that proved nothing): previously only
    // the proving class's shadow was written, and the other class's
    // identifier could re-attach from a fresh account with a clean slate.
    const phoneShadow = await rawRow(SERVER_TABLES.users, {
      userId: phoneCooldownKeyFromClaimKey(phoneKey),
    });
    expect(phoneShadow?.kind).toBe('phoneCooldown');
    expect(phoneShadow?.discoverableAfter).toBe(horizon);
    const emailShadow = await rawRow(SERVER_TABLES.users, {
      userId: emailCooldownKeyFromClaimKey(emailKey),
    });
    expect(emailShadow?.kind).toBe('emailCooldown');
    expect(emailShadow?.discoverableAfter).toBe(horizon);

    // THE SHADOW'S OWN PATH, phone class (an honesty fix: the standing
    // unlink-then-re-attach case re-attached from a member of the SURVIVING
    // group, so the group-row carrier answered before the shadow was ever
    // read — deleting the shadow would not have failed it): unlink the
    // phone, then attach the SAME number from a BRAND-NEW pristine account.
    // No group row exists for that caller; only the phonecool# shadow can
    // carry the stamp — and the fresh claim is born with it.
    expect((await phoneUnlinkRoute(post(owner.token, {}), deps)).statusCode).toBe(200);
    expect(await db.getIdentifierClaim(phoneKey)).toBeUndefined();
    const freshPhoneAcct = await mkAcct(deps);
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(
      (
        await phoneRequestCodeRoute(
          post(freshPhoneAcct.token, { phone: number, class: 'phone' }),
          deps,
        )
      ).statusCode,
    ).toBe(200);
    const phoneCode = deps.smsSent.at(-1)!.code;
    expect(
      (await phoneVerifyRoute(post(freshPhoneAcct.token, { phone: number, code: phoneCode }), deps))
        .statusCode,
    ).toBe(200);
    expect((await db.getIdentifierClaim(phoneKey))!.discoverableAfter).toBe(horizon);

    // THE CROSS-CLASS ARM, email class — the reopened re-attach loop, now
    // closed: unlink the EMAIL from the surviving group, attach the same
    // address from ANOTHER brand-new account. The recovery was proved by
    // phone; only the emailcool# stamp can re-arm this claim.
    expect((await emailUnlinkRoute(post(owner.token, {}), deps)).statusCode).toBe(200);
    expect(await db.getIdentifierClaim(emailKey)).toBeUndefined();
    const freshEmailAcct = await mkAcct(deps);
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(
      (
        await emailRequestCodeRoute(
          post(freshEmailAcct.token, { email, class: 'phone' }),
          deps,
        )
      ).statusCode,
    ).toBe(200);
    const emailCode = deps.emailsSent.at(-1)!.code;
    expect(
      (await emailVerifyRoute(post(freshEmailAcct.token, { email, code: emailCode }), deps))
        .statusCode,
    ).toBe(200);
    expect((await db.getIdentifierClaim(emailKey))!.discoverableAfter).toBe(horizon);
  });

  gated('an EMAIL-class pending row completes with the phone flag ABSENT THROUGHOUT — the sub-flag darkens exactly one class', async () => {
    const deps = makeTestDeps(db);
    phoneFlagOn = false;
    const email = `emailclass-${RUN}@example.com`;
    const owner = await mkAcct(deps);
    expect(
      (await emailRequestCodeRoute(post(owner.token, { email, class: 'phone' }), deps)).statusCode,
    ).toBe(200);
    const attachCode = deps.emailsSent.at(-1)!.code;
    expect(
      (await emailVerifyRoute(post(owner.token, { email, code: attachCode }), deps)).statusCode,
    ).toBe(200);
    const groupId = (await db.getUserById(owner.userId))!.groupId!;

    const device = await mkAcct(deps);
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expect(
      (await recoveryRequestCodeRoute(post(device.token, { email }), deps)).statusCode,
    ).toBe(200);
    const code = deps.emailsSent.at(-1)!.code;
    expect(
      (
        await recoveryVerifyRoute(post(device.token, { email, code, class: 'tablet' }), deps)
      ).statusCode,
    ).toBe(200);
    // Born email-class (the prefix derivation, negative arm).
    expect((await db.getRecoveryPending(groupId))?.identifierClass).toBe('email');

    deps.advanceMs((RECOVERY_DELAY_SECONDS + 60) * 1000);
    // The phone flag has been ABSENT the whole way — the email-class row
    // completes regardless.
    const done = await complete(deps, device, groupId);
    expect(done.statusCode).toBe(200);
    expect((await db.getUserById(device.userId))?.groupId).toBe(groupId);
  });
});
