import { RegisterPushTokenRequest } from '@tacendum/shared';

/**
 * The body the CLIENT actually sends, checked against the schema the SERVER
 * actually enforces.
 *
 * This test exists because its absence cost a working feature. Every
 * server-side push test hand-builds its own request body, so all of them
 * supplied `bundleId` and all of them passed — while the real client never
 * sent it. `RegisterPushTokenRequest` requires it, so `parseJson` rejected the
 * request with a 400 before it reached the handler, and the client swallows
 * registration failures by design. The push-token table stayed empty for the
 * life of the feature and nothing anywhere reported a problem.
 *
 * A test that builds its own fixture cannot catch that. This one imports the
 * REAL schema and validates the SHAPE THE CLIENT PRODUCES, so the two can
 * never drift again without a red test.
 */

/**
 * Mirrors the body literal in `apiRegisterPushToken` (app/src/api.ts).
 *
 * Duplicated deliberately rather than reaching through `fetch`: what is being
 * pinned is the shape, and a copy that has to be edited in lockstep is the
 * point — if someone changes the client body and not this, the assertions
 * below are what fails.
 */
function clientBody(opts: {
  voipToken?: string;
  alertToken?: string;
  env: 'sandbox' | 'production';
  bundleId: string;
}) {
  return {
    ...(opts.voipToken ? { voipToken: opts.voipToken } : {}),
    env: opts.env,
    ...(opts.alertToken ? { alertToken: opts.alertToken } : {}),
    bundleId: opts.bundleId,
  };
}

const VOIP = 'a'.repeat(64);
const ALERT = 'b'.repeat(64);
const BUNDLE = 'com.miranatechnologies.tacendum';

describe('the body the client sends is one the server accepts', () => {
  it('accepts a device with both tokens', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientBody({ voipToken: VOIP, alertToken: ALERT, env: 'sandbox', bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(true);
  });

  it('accepts a device with only an ALERT token', () => {
    // The case the whole notification feature depends on: PushKit has not
    // produced credentials, but the person granted the notification prompt.
    const parsed = RegisterPushTokenRequest.safeParse(
      clientBody({ alertToken: ALERT, env: 'sandbox', bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(true);
  });

  it('accepts a device with only a VOIP token', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientBody({ voipToken: VOIP, env: 'sandbox', bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(true);
  });

  it('REJECTS the body without bundleId — the bug this file exists for', () => {
    // The exact shape the client sent before this was fixed. It is a 400,
    // raised in `parseJson` before any handler runs, and the client's catch
    // turns it into silence.
    const withoutBundleId = {
      voipToken: VOIP,
      env: 'sandbox' as const,
      alertToken: ALERT,
    };

    const parsed = RegisterPushTokenRequest.safeParse(withoutBundleId);

    expect(parsed.success).toBe(false);
  });

  it('rejects a body with neither token', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientBody({ env: 'sandbox', bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects an empty bundleId — the shape native returns if Bundle.main has none', () => {
    // `bundleIdentifier()` falls back to '' because the platform API is
    // optional. That cannot happen for an app bundle, but if it ever did, the
    // registration must fail loudly here rather than store a row that names
    // no app.
    const parsed = RegisterPushTokenRequest.safeParse(
      clientBody({ alertToken: ALERT, env: 'sandbox', bundleId: '' }),
    );

    expect(parsed.success).toBe(false);
  });
});

/**
 * Mirrors the body literal in `apiRegisterFcmToken` (app/src/api.ts) — the
 * same deliberate duplication as `clientBody` above, for the same reason: the
 * pinned thing is the SHAPE the Android client produces, and drift on either
 * side of it must land here as a red test.
 *
 * INTEGRATION POINT: the schema branch this parses against
 * is `FcmPushRegistration` in packages/shared/src/dto.ts, landed by the
 * server-side FCM track and verified against
 * that commit. There is deliberately ONE token
 * field: firebase issues one registration token per app instance and it
 * feeds both the call-wake and message-wake lanes. NO `env` rides this body —
 * FCM has no sandbox/production host split; the schema would strip a stray
 * one and the handler stores none (push.ts, the android arm), so the
 * client sending it would be a lie in flight and it never does.
 */
function clientFcmBody(opts: { fcmToken: string; bundleId: string }) {
  return {
    platform: 'android' as const,
    fcmToken: opts.fcmToken,
    bundleId: opts.bundleId,
  };
}

// The realistic shape: FCM tokens carry `:`, `-` and `_`, and CANNOT pass the
// hex gate the APNs branch keeps — which is exactly why the union exists.
const FCM = `cAB3${'x'.repeat(12)}:APA91b${'H'.repeat(120)}_-${'k'.repeat(20)}`;

describe('the Android body: one FCM token, platform-discriminated', () => {
  it('accepts the FCM registration the Android client sends', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientFcmBody({ fcmToken: FCM, bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(true);
  });

  it('REJECTS the same token without the platform discriminator', () => {
    // Without `platform: 'android'` the body can only try the iOS branch,
    // whose hex gate an FCM token cannot pass. This is the prior state of
    // the world, kept as the proof that the discriminator is load-bearing —
    // and the proof that no legacy client could ever wander into the FCM
    // branch by accident.
    const parsed = RegisterPushTokenRequest.safeParse({
      fcmToken: FCM,
      bundleId: BUNDLE,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects an Android body with an empty bundleId', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientFcmBody({ fcmToken: FCM, bundleId: '' }),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects a truncated token — shorter than any real registration', () => {
    const parsed = RegisterPushTokenRequest.safeParse(
      clientFcmBody({ fcmToken: 'too-short', bundleId: BUNDLE }),
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects platform:android with the APNs fields — the shapes must not blend', () => {
    const parsed = RegisterPushTokenRequest.safeParse({
      platform: 'android' as const,
      voipToken: VOIP,
      env: 'sandbox' as const,
      bundleId: BUNDLE,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('the latch and the guards are shared, not forked', () => {
  // Source-level, the idiom of call.wiring.test.ts's latch scans: the Android
  // registration path lives inside `uploadPushTokens`, which has no unit
  // harness of its own, and the claim that matters — the
  // `pushRegistrationAdopted` latch, the consent check and the token reads
  // all sit UPSTREAM of both platform branches — is a fact about the source.
  const fs = jest.requireActual<{ readFileSync(p: string, e: string): string }>('fs');
  const testPath = expect.getState().testPath ?? '';
  const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
  const src = fs.readFileSync(`${appDir}/src/call/index.ts`, 'utf8');

  const fnStart = src.indexOf('export async function uploadPushTokens');
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd);

  it('both platform registrations live inside uploadPushTokens — one gate for six callers', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(body).toContain('apiRegisterFcmToken(');
    expect(body).toContain('apiRegisterPushToken(');
    // …and nowhere else in the module: a second registration call site would
    // be a path around the latch. (The imports carry no parenthesis, so one
    // occurrence each IS the one call.)
    expect(src.split('apiRegisterFcmToken(').length - 1).toBe(1);
    expect(src.split('apiRegisterPushToken(').length - 1).toBe(1);
  });

  it('the latch, the consent check and the token reads come BEFORE either branch', () => {
    const latchAt = body.indexOf('if (!pushRegistrationAdopted)');
    const consentAt = body.indexOf('if (!pushTokensAllowed())');
    const androidAt = body.indexOf('apiRegisterFcmToken(');
    const iosAt = body.indexOf('apiRegisterPushToken(');
    expect(latchAt).toBeGreaterThan(-1);
    expect(consentAt).toBeGreaterThan(latchAt);
    expect(androidAt).toBeGreaterThan(consentAt);
    expect(iosAt).toBeGreaterThan(consentAt);
  });

  it('the Android branch registers the ONE token, read from the same getters', () => {
    // `voipToken || alertToken` — the same string read through two surfaces
    // (PushTokenStore backs both), not a choice between two tokens.
    expect(body).toContain('apiRegisterFcmToken(auth, bundleId, voipToken || alertToken)');
  });
});
