import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import {
  AccountsNotice,
  authSignedBytes,
  EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
  RECOVERY_DELAY_SECONDS,
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  TABLES,
  type RecoveryVerifyResponse,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  emailCooldownKeyFromClaimKey,
  groupRowKey,
  identifierClaimDiscoverable,
  makeDataLayer,
  recoveryRowKey,
  type DataLayer,
} from '../src/db/data.js';
import {
  activeEmailClaimKeys,
  identifierClaimHash,
  usernameClaimKey,
} from '../src/opaque-ref.js';
import { accountsRefusal } from '../src/handlers/devices.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  recoveryCancelRoute,
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../src/handlers/identifiers.js';
import { recoveryCompleteRoute } from '../src/handlers/recovery-signed.js';
import type { HttpEvent, HttpResult } from '../src/handlers/http.js';
import { allQueued, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Recovery against REAL DynamoDB and REAL libsignal
 * signatures, on the INJECTED clock throughout — never a frozen now beside
 * advancing timers (a frozen now beside advancing timers hides deadline
 * defects under a green suite). Every delay and cool-down below is crossed
 * by advancing THE clock the handlers and the transaction conditions read.
 *
 * The three pins: a pending recovery is cancellable by a surviving
 * member and the CANCEL WINS (driven in both serialization orders, plus the
 * inside-the-delay case); the recovered device's ULID is a brand-new ULID —
 * never any prior member's; and discoverability returns ONLY after the
 * 7-day cool-down, as the read-time rule.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;
let flagOn = true;

const RUN = `${Date.now()}62`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
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
  const base = makeDataLayer(doc);
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

async function mkAcct(deps: TestDeps): Promise<Acct> {
  const key = PrivateKey.generate();
  const pub = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const userId = uid();
  const res = await db.getOrCreateUserByIdentityKey(pub, userId, deps.now());
  expect(res.kind).toBe('ok');
  const token = `rec-tok-${RUN}-${++seq}`;
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    // Long-lived: this suite advances the clock past 72 h twice.
    expiresAt: Math.floor(deps.now() / 1000) + 400 * 24 * 3600,
  });
  return { userId, token, pub, key };
}

/** A phone+tablet group with a verified email, built through the REAL attach
 * routes (the ceremony half at the data layer, the suite's split). */
async function mkRecoverableGroup(
  deps: TestDeps,
  email: string,
): Promise<{ phone: Acct; tablet: Acct; groupId: string; claimKey: string }> {
  const phone = await mkAcct(deps);
  const tablet = await mkAcct(deps);
  const groupId = uid();
  const offerNonce = `nonce-rec-${RUN}-${++seq}`;
  const nowS = Math.floor(deps.now() / 1000);
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: tablet.userId,
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
  expect(
    (
      await emailRequestCodeRoute(post(phone.token, { email, class: 'phone' }), deps)
    ).statusCode,
  ).toBe(200);
  const code = deps.emailsSent.at(-1)!.code;
  expect((await emailVerifyRoute(post(phone.token, { email, code }), deps)).statusCode).toBe(200);
  return { phone, tablet, groupId, claimKey: activeEmailClaimKeys(KEYS, email)[0]! };
}

/** Open a pending recovery for `email` as a FRESH device, through the real
 * routes: request-code, then verify. Returns the device and the pending
 * facts. Steps past the address's resend cool-down first. */
async function openRecovery(
  deps: TestDeps,
  email: string,
  deviceClass: 'phone' | 'tablet' = 'phone',
): Promise<{ device: Acct; pending: RecoveryVerifyResponse }> {
  const device = await mkAcct(deps);
  deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
  expect((await recoveryRequestCodeRoute(post(device.token, { email }), deps)).statusCode).toBe(
    200,
  );
  const code = deps.emailsSent.at(-1)!.code;
  const res = await recoveryVerifyRoute(
    post(device.token, { email, code, class: deviceClass }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return { device, pending: parseBody<RecoveryVerifyResponse>(res.body) };
}

/** A LIVE possession proof for the caller's registered identity key: a
 * pending v2 challenge row plus the caller's REAL libsignal signature over
 * `authSignedBytes(origin, challenge)` — the machinery the completion route
 * verifies with the auth path's own verify. */
async function possessionProof(
  deps: TestDeps,
  acct: Acct,
): Promise<{ challenge: string; signature: string }> {
  const challenge = Buffer.from(`rec-chal-${++seq}`.padEnd(32, '.')).toString('base64');
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

async function complete(
  deps: TestDeps,
  device: Acct,
  groupId: string,
): Promise<HttpResult> {
  const proof = await possessionProof(deps, device);
  return recoveryCompleteRoute(post(device.token, { groupId, ...proof }), deps);
}

describe('recovery-attach: delay, member cancel, cool-down — all against the real clock injection', () => {
  gated('the pending recovery notifies EVERY member; inside the delay window completion refuses, a surviving member cancels, and the CANCEL WINS — even after the delay has elapsed', async () => {
    const deps = makeTestDeps(db);
    const email = `cancelwins-${RUN}@example.com`;
    const { phone, tablet, groupId } = await mkRecoverableGroup(deps, email);
    const { device, pending } = await openRecovery(deps, email);
    expect(pending.groupId).toBe(groupId);
    expect(pending.completesAt).toBe(Math.floor(deps.now() / 1000) + RECOVERY_DELAY_SECONDS);

    //EVERY member device is notified — both queues carry the
    // recoveryRequested notice with the declared class and the deadline.
    for (const member of [phone, tablet]) {
      const queued = await allQueued(db, member.userId);
      const notices = queued
        .filter((m) => m.type === 'accounts')
        .map((m) => AccountsNotice.parse(JSON.parse(Buffer.from(m.payload, 'base64').toString())));
      expect(notices).toContainEqual({
        kind: 'recoveryRequested',
        groupId,
        class: 'phone',
        completesAt: pending.completesAt,
      });
    }

    // INSIDE the delay: a valid possession proof changes nothing — the
    // transaction's completesAt condition refuses (not_ready, collapsed).
    deps.advanceMs((RECOVERY_DELAY_SECONDS - 3600) * 1000);
    expectRefused(await complete(deps, device, groupId));
    expect(await db.getUserById(device.userId).then((u) => u?.groupId)).toBeUndefined();

    // The surviving tablet cancels — inside the window, bearer-authorized
    // (cancel is the refusal verb; its failure direction is safety).
    expect((await recoveryCancelRoute(post(tablet.token, {}), deps)).statusCode).toBe(200);
    // The phone (the incumbent itself — every member can cancel) learns.
    const phoneNotices = (await allQueued(db, phone.userId))
      .filter((m) => m.type === 'accounts')
      .map((m) => AccountsNotice.parse(JSON.parse(Buffer.from(m.payload, 'base64').toString())));
    expect(phoneNotices).toContainEqual({ kind: 'recoveryCancelled', groupId });

    // The delay elapses fully — and the cancel STILL WINS: the completion
    // transaction's attribute_not_exists(canceled) condition refuses, and
    // the refusal is byte-indistinguishable from "no such recovery".
    deps.advanceMs(2 * 3600 * 1000);
    expectRefused(await complete(deps, device, groupId));
    // Nothing moved: roster intact, device still solo, epoch unchanged.
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => m.userId).sort()).toEqual(
      [phone.userId, tablet.userId].sort(),
    );
    expect((await db.getUserById(device.userId))?.groupId).toBeUndefined();
    expect(await db.isUserTombstoned(phone.userId)).toBe(false);
  });

  gated('a stolen bearer alone cannot complete: garbage and wrong-key signatures refuse; the delay expiring uncancelled completes as the replace — the recovered ULID is BRAND NEW, the incumbent tombstones, TOFU fires by construction', async () => {
    const deps = makeTestDeps(db);
    const email = `replace-${RUN}@example.com`;
    const { phone, tablet, groupId, claimKey } = await mkRecoverableGroup(deps, email);
    const priorMembers = [phone.userId, tablet.userId];
    const { device, pending } = await openRecovery(deps, email);
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 1) * 1000);

    // Bearer + a garbage signature: refused (the property held for
    // this verb — bearer theft is never identity ownership).
    const { challenge } = await possessionProof(deps, device);
    expectRefused(
      await recoveryCompleteRoute(
        post(device.token, {
          groupId,
          challenge,
          signature: Buffer.from('forged-signature-bytes-goooooooooooooooo').toString('base64'),
        }),
        deps,
      ),
    );
    // Bearer + a signature by a DIFFERENT key over the right bytes: refused
    // (verification binds the CALLER's registered key).
    const interloper = await mkAcct(deps);
    const wrongKeyProof = await possessionProof(deps, {
      ...device,
      key: interloper.key,
    });
    expectRefused(
      await recoveryCompleteRoute(post(device.token, { groupId, ...wrongKeyProof }), deps),
    );

    // The genuine completion: ONE TransactWrite — incumbent revoked with
    // tombstone + the recovered device attached (the incumbent case is
    // the replace shape).
    const completionNowS = Math.floor(deps.now() / 1000);
    const res = await complete(deps, device, groupId);
    expect(res.statusCode).toBe(200);

    // THE VERIFY PIN: the recovered device's ULID is none of the prior
    // member ULIDs — a brand-new keypair account joined; nothing rebound.
    expect(priorMembers).not.toContain(device.userId);
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(2);
    expect(group?.members.map((m) => [m.userId, m.class]).sort()).toEqual(
      [
        [device.userId, 'phone'],
        [tablet.userId, 'tablet'],
      ].sort(),
    );
    // The recovered member is honestly CERTLESS: no ceremony ran, peers and
    // siblings owe it the full TOFU treatment.
    expect(group?.members.find((m) => m.userId === device.userId)?.certs).toBeUndefined();
    // The incumbent is dead the way a revoke leaves it: row tombstoned with
    // the forwarding hint, identity key tombstoned (never re-auths), its
    // sessions/socket/push torn down as re-drivable cleanup.
    expect(await db.isUserTombstoned(phone.userId)).toBe(true);
    const phoneRow = await doc.send(
      new GetCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: phone.userId },
        ConsistentRead: true,
      }),
    );
    expect(phoneRow.Item?.formerGroupId).toBe(groupId);
    expect(phoneRow.Item?.groupId).toBeUndefined();
    expect(await db.getOrCreateUserByIdentityKey(phone.pub, uid(), deps.now())).toEqual({
      kind: 'tombstoned',
    });
    // The new device row joined and its reverse pointer cleared.
    const newRow = await db.getUserById(device.userId);
    expect(newRow?.groupId).toBe(groupId);
    expect(newRow?.recoveryGroupId).toBeUndefined();
    // The pending row is consumed; a survivor's late cancel — the OTHER
    // serialization order of the race — finds nothing and refuses: of the
    // racing pair exactly one committed.
    expect(await db.getRecoveryPending(groupId)).toBeUndefined();
    expectRefused(await recoveryCancelRoute(post(tablet.token, {}), deps));
    // The survivor learned, in-band.
    const tabletNotices = (await allQueued(db, tablet.userId))
      .filter((m) => m.type === 'accounts')
      .map((m) => AccountsNotice.parse(JSON.parse(Buffer.from(m.payload, 'base64').toString())));
    expect(tabletNotices).toContainEqual({
      kind: 'recoveryCompleted',
      groupId,
      userId: device.userId,
      class: 'phone',
      rosterEpoch: 2,
    });

    // THE COOL-DOWN PIN (read-time rule, real clock): consent ON, yet the
    // claim resolves as NOT discoverable until 7 days pass — then it does,
    // with no scheduler having run anything.
    expect(await db.setIdentifierDiscoverable(claimKey, groupId, tablet.userId, true)).toBe('set');
    const before = await db.getIdentifierClaim(claimKey);
    expect(before?.discoverable).toBe(true);
    // Stamped at COMPLETION time (never at request or verify): the
    // cool-down runs from the moment the roster actually moved. The
    // completion could only commit once completesAt had passed, so the
    // stamp necessarily sits at-or-after completesAt + cool-down.
    expect(before?.discoverableAfter).toBe(completionNowS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS);
    expect(before!.discoverableAfter!).toBeGreaterThanOrEqual(
      pending.completesAt + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
    );
    expect(identifierClaimDiscoverable(before!, Math.floor(deps.now() / 1000))).toBe(false);
    deps.advanceMs((RECOVERY_DISCOVERY_COOLDOWN_SECONDS + 1) * 1000);
    const after = await db.getIdentifierClaim(claimKey);
    expect(identifierClaimDiscoverable(after!, Math.floor(deps.now() / 1000))).toBe(true);
  });

  gated('a cancelled recovery does not lock the account out: a FRESH recovery replaces the cancelled row and completes', async () => {
    const deps = makeTestDeps(db);
    const email = `retry-${RUN}@example.com`;
    const { tablet, groupId } = await mkRecoverableGroup(deps, email);
    const first = await openRecovery(deps, email);
    expect((await recoveryCancelRoute(post(tablet.token, {}), deps)).statusCode).toBe(200);
    // The cancelled row still stands (readable refusal state)...
    expect((await db.getRecoveryPending(groupId))?.canceled).toBe(true);
    // ...and a legitimate second attempt replaces it rather than being
    // locked out until the TTL reaper happens by.
    const second = await openRecovery(deps, email, 'tablet');
    expect(second.device.userId).not.toBe(first.device.userId);
    expect((await db.getRecoveryPending(groupId))?.canceled).toBeUndefined();
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 1) * 1000);
    expect((await complete(deps, second.device, groupId)).statusCode).toBe(200);
    const group = await db.getAccountGroup(groupId);
    // The tablet slot was the declared class this time: the incumbent tablet
    // was replaced; the phone survives.
    expect(group?.members.map((m) => m.userId)).toContain(second.device.userId);
    expect(group?.members.map((m) => m.userId)).not.toContain(tablet.userId);
    expect(await db.isUserTombstoned(tablet.userId)).toBe(true);
    // The recovery row is gone with completion (raw check — the sweep
    // discipline: nothing pending survives its own success).
    const raw = await doc.send(
      new GetCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: recoveryRowKey(groupId) },
        ConsistentRead: true,
      }),
    );
    expect(raw.Item).toBeUndefined();
  });

  gated('a grouped (non-pristine) device can neither request nor hold a recovery, and a recovery for a group whose identifier was unlinked refuses at verify', async () => {
    const deps = makeTestDeps(db);
    const email = `pristine-${RUN}@example.com`;
    const { phone, tablet } = await mkRecoverableGroup(deps, email);
    void tablet;
    // A grouped caller is refused at request-code (pristine only).
    deps.advanceMs((EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    expectRefused(await recoveryRequestCodeRoute(post(phone.token, { email }), deps));
    // A pristine device that verifies AFTER the identifier is unlinked is
    // refused: the claim re-resolves at verify time.
    const device = await mkAcct(deps);
    expect((await recoveryRequestCodeRoute(post(device.token, { email }), deps)).statusCode).toBe(
      200,
    );
    const code = deps.emailsSent.at(-1)!.code;
    expect((await emailUnlinkRoute(post(phone.token, {}), deps)).statusCode).toBe(200);
    expectRefused(
      await recoveryVerifyRoute(post(device.token, { email, code, class: 'phone' }), deps),
    );
  });

  gated('a pending recovery goes STALE past its window: completion long after the notice scrolled off is refused, roster untouched (gate fix)', async () => {
    const deps = makeTestDeps(db);
    const email = `stale-${RUN}@example.com`;
    const { phone, tablet, groupId } = await mkRecoverableGroup(deps, email);
    const { device } = await openRecovery(deps, email);
    // Advance PAST the completion window — the 72 h delay plus the pending
    // row's TTL horizon (completesAt + the 7 d cool-down). DDB Local never
    // reaps, so the row is STILL PRESENT; the refusal is the explicit
    // expiresAt clock check, never a reaper (the read-is-the-reaper class, on the
    // one row class where the users table has no TTL attribute at all).
    deps.advanceMs(
      (RECOVERY_DELAY_SECONDS + RECOVERY_DISCOVERY_COOLDOWN_SECONDS + 3600) * 1000,
    );
    const raw = await db.getRecoveryPending(groupId);
    expect(raw).toBeDefined();
    expect(raw!.expiresAt).toBeLessThan(Math.floor(deps.now() / 1000));
    expectRefused(await complete(deps, device, groupId));
    // Nothing moved: roster intact, incumbent alive, recovering device still solo.
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => m.userId).sort()).toEqual(
      [phone.userId, tablet.userId].sort(),
    );
    expect(await db.isUserTombstoned(phone.userId)).toBe(false);
    expect((await db.getUserById(device.userId))?.groupId).toBeUndefined();
  });

  gated('unlink DURING the 72 h window kills the pending recovery: completion refuses once the identifier that proved it is gone (gate fix)', async () => {
    const deps = makeTestDeps(db);
    const email = `unlinkwin-${RUN}@example.com`;
    const { phone, tablet, groupId } = await mkRecoverableGroup(deps, email);
    const { device } = await openRecovery(deps, email);
    // A surviving member cuts the email off — the intuitive "kill the email"
    // reaction, distinct from pressing cancel. The claim row and the group's
    // identifierRef both go.
    expect((await emailUnlinkRoute(post(tablet.token, {}), deps)).statusCode).toBe(200);
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([]);
    // The delay elapses in full — and completion STILL refuses: the proving
    // claim no longer names the group, so the recovery's basis is gone.
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 1) * 1000);
    expectRefused(await complete(deps, device, groupId));
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members.map((m) => m.userId).sort()).toEqual(
      [phone.userId, tablet.userId].sort(),
    );
    expect(await db.isUserTombstoned(phone.userId)).toBe(false);
  });
});

describe('a username ref on the group never bricks an email- or phone-proved completion', () => {
  gated('a group holding a usernamehash# ref (planted in the shape the claim transaction will write) COMPLETES an email-proved recovery, arms the emailcool# shadow only, and mints no shadow of any spelling for the handle', async () => {
    const deps = makeTestDeps(db);
    const email = `handle-holder-${RUN}@example.com`;
    const { groupId, claimKey } = await mkRecoverableGroup(deps, email);

    // The DARK class, planted by hand (no route writes it before): the
    // claim row under the same never-a-user, kind-checked discipline as the
    // email row, and the ref appended to the group's identifierRefs — the
    // two writes the claim TransactWrite will make. The completion's
    // per-ref stamp leg conditions on `groupId =:g`, so the row must name
    // the group exactly as a real claim would.
    const handleHash = identifierClaimHash(KEYS[0]!.key, `handle${RUN}`);
    const usernameRef = usernameClaimKey(1, handleHash);
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: {
          userId: usernameRef,
          kind: 'identifierClaim',
          groupId,
          createdAt: deps.now(),
          verifiedAt: deps.now(),
          discoverable: false,
        },
      }),
    );
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: groupRowKey(groupId) },
        UpdateExpression: 'SET identifierRefs = list_append(identifierRefs, :r)',
        ExpressionAttributeValues: { ':r': [usernameRef] },
      }),
    );
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([claimKey, usernameRef]);

    // An EMAIL-proved recovery, completed past the delay. Before the fix
    // the cross-class shadow walk mapped the username ref through the
    // by-name throw and this completion 500'd — recovery bricked for every
    // group holding a handle.
    const { device } = await openRecovery(deps, email, 'tablet');
    deps.advanceMs((RECOVERY_DELAY_SECONDS + 60) * 1000);
    const done = await complete(deps, device, groupId);
    expect(done.statusCode).toBe(200);
    expect((await db.getUserById(device.userId))?.groupId).toBe(groupId);
    const horizon = Math.floor(deps.now() / 1000) + RECOVERY_DISCOVERY_COOLDOWN_SECONDS;

    // The email shadow armed exactly as before the third class existed…
    const emailShadow = (
      await doc.send(
        new GetCommand({
          TableName: SERVER_TABLES.users,
          Key: { userId: emailCooldownKeyFromClaimKey(claimKey) },
          ConsistentRead: true,
        }),
      )
    ).Item;
    expect(emailShadow?.kind).toBe('emailCooldown');
    expect(emailShadow?.discoverableAfter).toBe(horizon);
    // …the group still holds both refs (a completion moves no membership)
    // and the handle's claim row carries the read-time cool-down like
    // every other claim the group holds…
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([claimKey, usernameRef]);
    expect((await db.getIdentifierClaim(usernameRef))?.discoverableAfter).toBe(horizon);
    // …and NO shadow of ANY spelling was minted for the handle: the only row
    // on the table carrying its hash is its own claim row. (A naive fall-
    // through to the email mapping would have Put an `emailcool#ash#v1#…`
    // row; this scan is what would catch it.)
    // Paged: the local users table outgrows one scan page across runs.
    const carrying: string[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await doc.send(
        new ScanCommand({
          TableName: SERVER_TABLES.users,
          FilterExpression: 'contains(userId, :h)',
          ExpressionAttributeValues: { ':h': handleHash },
          ProjectionExpression: 'userId',
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of page.Items ?? []) carrying.push(item.userId as string);
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    expect(carrying).toEqual([usernameRef]);
  });
});
