import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecoveryCodeRequest, RecoveryVerifyRequest } from '@tacendum/shared';
import { activeEmailClaimKeys } from '../src/opaque-ref.js';
import {
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../src/handlers/identifiers.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * THE PARALLEL-FIELD WIRE, STORE-BLIND HALF: the captured
 * pre-amendment recovery bodies parse to identical objects under the new
 * parallel-field schemas, replay byte-identically through the amended handlers
 * over the memory twin, and the `.strict()` narrowing is pinned as the one
 * deliberate change the replay is structurally blind to.
 *
 * WHY IT LIVES IN ITS OWN FILE. accounts-phone-recovery.test.ts opens
 * ListTables against DynamoDB Local in beforeAll and drives its cases
 * against the real store, so moved it to vitest.config.ts's `heavy` project.
 * CI runs only `--project fast` and nothing runs
 * `heavy`, so that move silently took these three cases off every PR — and
 * they are precisely the wire-compatibility pins the strict-zod client
 * depends on, the ones that must fail a PR that narrows or renames a landed
 * recovery field, since there is no OTA path to fix a shipped app.
 *
 * Nothing here touches :8000: the replay uses the memory twin and the
 * deterministic test deps, exactly as it did inside the heavy file. */

const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];

function post(token: string | undefined, body: unknown): HttpEvent {
  return {
    method: 'POST',
    path: '/',
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
    sourceIp: '127.0.0.1',
  };
}

describe('THE PARALLEL-FIELD WIRE: the landed {email} wire is untouched', () => {
  const fixture = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'recovery-wire-pre-acp1.fixture.json'),
      'utf8',
    ),
  ) as {
    requestCode: {
      body: string;
      parsed: unknown;
      response: { statusCode: number; body: string };
    };
    verify: {
      body: string;
      code: string;
      parsed: unknown;
      response: { statusCode: number; body: string };
    };
  };

  it('the CAPTURED pre-amendment request bodies parse to the IDENTICAL objects under the new parallel-field schemas', () => {
    expect(RecoveryCodeRequest.parse(JSON.parse(fixture.requestCode.body))).toEqual(
      fixture.requestCode.parsed,
    );
    const verifyParsed = RecoveryVerifyRequest.parse(JSON.parse(fixture.verify.body));
    expect(verifyParsed).toEqual(fixture.verify.parsed);
    // The device-slot `class` field KEEPS its landed meaning beside the new
    // optional phone field: it is the slot the fixture's client declared,
    // not an identifier discriminant, and no field named `class` carries
    // the identifier class anywhere on this wire.
    expect((verifyParsed as { class: string }).class).toBe('tablet');
    expect('phone' in (fixture.verify.parsed as Record<string, unknown>)).toBe(false);
  });

  it('the TRANSCRIBED pre-amendment flow replays byte-identically through the amended handlers — parsed objects AND answer bytes, for the captured shapes (see the fixture note for what this does and does not attest)', async () => {
    // The transcription rig (memory twin, deterministic deps, the fixture's
    // own seeded groupId + clock): what this pins is the CURRENT handlers'
    // key order, arithmetic, and bytes for the landed {email} field set —
    // honest scope; it is not an independent capture
    // of d1fe3f4's runtime.
    const memDb = makeMemoryDb();
    memDb.setAccountsFeatureEnabled(true);
    const deps = makeTestDeps(memDb);
    const mk = async (n: number): Promise<{ userId: string; token: string }> => {
      const userId = deps.newUserId();
      const token = `capture-token-${n}`;
      await memDb.createUser({ userId, createdAt: deps.now(), identityKeyPub: `idkey-${userId}` });
      await memDb.createSession({
        token,
        userId,
        createdAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 30 * 86400,
      });
      return { userId, token };
    };
    const owner = await mk(1);
    const email = 'capture.owner@example.com';
    const claimKey = activeEmailClaimKeys(KEYS, email)[0]!;
    await memDb.putEmailCode({
      userId: owner.userId,
      purpose: 'attach',
      claimKey,
      deviceClass: 'phone',
      code: '111111',
      attempts: 0,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 300,
    });
    expect(
      await memDb.attachIdentifier({
        userId: owner.userId,
        deviceClass: 'phone',
        newGroupId: '01CAPTUREGROUP0000000000A1',
        claimKey,
        nowMs: deps.now(),
      }),
    ).toBe('attached');
    const recoverer = await mk(2);
    const res1 = await recoveryRequestCodeRoute(
      post(recoverer.token, JSON.parse(fixture.requestCode.body)),
      deps,
    );
    expect(res1.statusCode).toBe(fixture.requestCode.response.statusCode);
    expect(res1.body).toBe(fixture.requestCode.response.body);
    // The minted code matches the capture (same deterministic mint), so the
    // captured verify body replays byte-for-byte.
    expect(deps.emailsSent.at(-1)!.code).toBe(fixture.verify.code);
    const res2 = await recoveryVerifyRoute(
      post(recoverer.token, JSON.parse(fixture.verify.body)),
      deps,
    );
    expect(res2.statusCode).toBe(fixture.verify.response.statusCode);
    expect(res2.body).toBe(fixture.verify.response.body);
  });

  it('.strict() is a REAL, DELIBERATE wire narrowing the captured replay cannot see: an extra unknown key — silently STRIPPED by the landed bare z.object schemas — is now REJECTED, and nothing else changed', () => {
    // The landed pre-amendment schemas were bare z.object (Zod strip mode): a
    // request carrying an extra field parsed fine and answered 200. The
    // amendment MANDATES `.strict()` (the strict-schema rule), so this
    // narrowing is spec, not drift — but the captured bodies carry no extra
    // key, so the
    // replay above is structurally blind to it. This case pins the change
    // AS INTENDED and scopes the compat claim honestly: byte-identical FOR
    // THE CAPTURED SHAPES; unknown-key tolerance deliberately withdrawn.
    expect(
      RecoveryCodeRequest.safeParse({ email: 'a@b.co', anythingElse: 1 }).success,
    ).toBe(false);
    expect(
      RecoveryVerifyRequest.safeParse({
        email: 'a@b.co',
        code: '123456',
        class: 'tablet',
        anythingElse: 1,
      }).success,
    ).toBe(false);
    // Without the extra key the same bodies parse: the narrowing is exactly
    // the unknown-key tolerance, nothing else.
    expect(RecoveryCodeRequest.safeParse({ email: 'a@b.co' }).success).toBe(true);
    expect(
      RecoveryVerifyRequest.safeParse({ email: 'a@b.co', code: '123456', class: 'tablet' })
        .success,
    ).toBe(true);
  });
});
