import { describe, expect, it } from 'vitest';
import {
  ApiErrorCode,
  MAX_FCM_TOKEN_LENGTH,
  MAX_VOIP_TOKEN_LENGTH,
  RegisterPushTokenRequest,
  SendFrame,
  TABLES,
  TABLE_ENV_VARS,
  TurnCredentialsResponse,
} from '../src/index.js';

/**
 * The transport additions calls need from the server:
 * the `urgent` hint that lets a sleeping phone be woken, the push-token
 * endpoints, and the TURN credential response.
 */

const VALID_SEND = {
  type: 'send' as const,
  to: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  msgType: 'ciphertext' as const,
  payload: 'QUJD',
};

describe('SendFrame.urgent (§5.3)', () => {
  it('is optional, so every existing client keeps working unchanged', () => {
    const parsed = SendFrame.safeParse(VALID_SEND);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.urgent).toBeUndefined();
  });

  it('is accepted when set', () => {
    const parsed = SendFrame.safeParse({ ...VALID_SEND, urgent: true });
    expect(parsed.success && parsed.data.urgent).toBe(true);
  });

  it('is a boolean and nothing else — no truthy strings or numbers', () => {
    for (const urgent of ['true', 1, 'yes', {}]) {
      expect(SendFrame.safeParse({ ...VALID_SEND, urgent }).success).toBe(false);
    }
  });
});

describe('push token registration (§9.2)', () => {
  const VALID = {
    voipToken: 'a'.repeat(64),
    env: 'sandbox' as const,
    bundleId: 'com.miranatechnologies.tacendum',
  };

  it('accepts a well-formed registration', () => {
    expect(RegisterPushTokenRequest.safeParse(VALID).success).toBe(true);
  });

  it('requires a hex APNs token of a plausible length', () => {
    for (const voipToken of [
      '',
      'not-hex-at-all!!',
      'AB'.repeat(4), // too short to be a device token
      'z'.repeat(64), // right length, not hex
      'a'.repeat(MAX_VOIP_TOKEN_LENGTH + 2),
    ]) {
      expect(RegisterPushTokenRequest.safeParse({ ...VALID, voipToken }).success).toBe(
        false,
      );
    }
  });

  it('closes the environment enum — a typo must not silently target the wrong APNs host', () => {
    expect(
      RegisterPushTokenRequest.safeParse({ ...VALID, env: 'production' }).success,
    ).toBe(true);
    expect(
      RegisterPushTokenRequest.safeParse({ ...VALID, env: 'prod' }).success,
    ).toBe(false);
  });

  it('bounds the bundle id', () => {
    expect(
      RegisterPushTokenRequest.safeParse({ ...VALID, bundleId: '' }).success,
    ).toBe(false);
    expect(
      RegisterPushTokenRequest.safeParse({
        ...VALID,
        bundleId: 'x'.repeat(256),
      }).success,
    ).toBe(false);
  });

  it('accepts an explicit platform: ios, and only ios, on the APNs shape', () => {
    expect(
      RegisterPushTokenRequest.safeParse({ ...VALID, platform: 'ios' }).success,
    ).toBe(true);
    // 'android' on the APNs shape is not a spelling of the Android branch —
    // that branch requires fcmToken and carries no env.
    expect(
      RegisterPushTokenRequest.safeParse({ ...VALID, platform: 'android' }).success,
    ).toBe(false);
  });
});

describe('push token registration — Android', () => {
  // A realistic FCM registration token shape: instance id, colon, long
  // URL-safe blob. NOT hex — that is the whole reason the branch exists.
  const FCM_TOKEN = `dGhpcy1pcy1hbi1pbnN0YW5jZTppZA:APA91b${'x'.repeat(120)}_-`;
  const VALID_ANDROID = {
    platform: 'android' as const,
    fcmToken: FCM_TOKEN,
    bundleId: 'com.miranatechnologies.tacendum',
  };

  it('accepts one FCM token under an explicit platform discriminator', () => {
    const parsed = RegisterPushTokenRequest.safeParse(VALID_ANDROID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.platform).toBe('android');
  });

  it('carries NO env — FCM has no sandbox/production host to name', () => {
    // Tolerated-and-stripped, not stored: an unknown key is dropped by the
    // schema, so nothing downstream can appear to route on it.
    const parsed = RegisterPushTokenRequest.safeParse({
      ...VALID_ANDROID,
      env: 'production',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'env' in parsed.data).toBe(false);
  });

  it('requires the discriminator — an FCM token cannot ride the legacy shape', () => {
    // Without platform the request falls to the iOS branch, where a
    // non-hex token has never validated. The iOS branch's hex validation
    // still holds for every iOS field.
    const { platform: _platform, ...withoutPlatform } = VALID_ANDROID;
    expect(RegisterPushTokenRequest.safeParse(withoutPlatform).success).toBe(false);
    expect(
      RegisterPushTokenRequest.safeParse({
        voipToken: FCM_TOKEN,
        env: 'sandbox',
        bundleId: VALID_ANDROID.bundleId,
      }).success,
    ).toBe(false);
  });

  it('bounds and constrains the token — opaque is not unvalidated', () => {
    for (const fcmToken of [
      '',
      'short',
      `${'a'.repeat(40)}!payload`, // charset violation
      'a'.repeat(MAX_FCM_TOKEN_LENGTH + 1),
    ]) {
      expect(
        RegisterPushTokenRequest.safeParse({ ...VALID_ANDROID, fcmToken }).success,
      ).toBe(false);
    }
  });

  it('requires the token — a platform marker alone stores nothing', () => {
    const { fcmToken: _fcmToken, ...withoutToken } = VALID_ANDROID;
    expect(RegisterPushTokenRequest.safeParse(withoutToken).success).toBe(false);
  });

  it('keeps every earlier iOS registration validating byte-for-byte', () => {
    // The compatibility pin for the union itself: the exact body a shipped
    // iOS build sends today — no platform field — still parses, and parses
    // into the APNs branch.
    const legacy = {
      voipToken: 'a'.repeat(64),
      alertToken: 'b'.repeat(64),
      env: 'production' as const,
      bundleId: 'com.miranatechnologies.tacendum',
    };
    const parsed = RegisterPushTokenRequest.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.platform).toBeUndefined();
    expect(parsed.success && 'env' in parsed.data && parsed.data.env).toBe('production');
  });
});

describe('TURN credentials (§5.2)', () => {
  it('round-trips a credential set', () => {
    const response = {
      iceServers: [
        { urls: ['stun:turn.tacendum.com:3478'] },
        {
          urls: ['turn:turn.tacendum.com:3478?transport=udp'],
          username: '1700000000:abc',
          credential: 'base64hmac',
        },
      ],
      ttlSeconds: 43_200,
    };
    expect(TurnCredentialsResponse.parse(response)).toEqual(response);
  });

  it('requires at least one server and a positive ttl', () => {
    expect(
      TurnCredentialsResponse.safeParse({ iceServers: [], ttlSeconds: 100 }).success,
    ).toBe(false);
    expect(
      TurnCredentialsResponse.safeParse({
        iceServers: [{ urls: ['stun:x'] }],
        ttlSeconds: 0,
      }).success,
    ).toBe(false);
  });
});

describe('the push_tokens table joins the canonical set', () => {
  it('has a name and an env var like every other table', () => {
    expect(TABLES.pushTokens).toBe('tacendum_push_tokens');
    expect(TABLE_ENV_VARS.pushTokens).toBe('TACENDUM_TABLE_PUSH_TOKENS');
  });

  it('keeps names and env vars in lockstep, so a new table cannot be half-added', () => {
    expect(Object.keys(TABLE_ENV_VARS).sort()).toEqual(Object.keys(TABLES).sort());
  });
});

describe('new error codes (§5.2)', () => {
  it('are part of the closed set clients switch on', () => {
    expect(ApiErrorCode.safeParse('turn_unavailable').success).toBe(true);
    expect(ApiErrorCode.safeParse('push_token_invalid').success).toBe(true);
    expect(ApiErrorCode.safeParse('made_up_code').success).toBe(false);
  });
});
