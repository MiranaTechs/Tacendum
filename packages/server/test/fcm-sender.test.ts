import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFcmPushSender } from '../src/push/fcm-sender.js';
import { makePlatformPushSender } from '../src/push/route.js';
import type { PushSender } from '../src/handlers/http.js';
import type { PushTokenRecord } from '../src/db/data.js';

const { sendCallWakeMock, sendMessageWakeMock } = vi.hoisted(() => ({
  sendCallWakeMock: vi.fn(),
  sendMessageWakeMock: vi.fn(),
}));

vi.mock('../src/push/fcm.js', () => ({
  makeFcmClient: () => ({
    sendCallWake: sendCallWakeMock,
    sendMessageWake: sendMessageWakeMock,
  }),
}));

/**
 * The wiring between a token row and FCM — the mirror of push-sender.test.ts,
 * holding the same failing-safely contract: a missing key must not break
 * message delivery, a dead token must be reported so the row can be pruned,
 * and nothing sensitive may reach a log line. Plus the two facts this lane
 * alone owns: the platform router hands it EVERY android row and NO ios row,
 * and the ciphertext stops at its boundary.
 *
 * How the credentials are OBTAINED is fcm.secrets.test.ts's subject; this
 * file takes them as given.
 */

const FCM_TOKEN = `device-instance-id:APA91b${'x'.repeat(120)}`;

const ANDROID_TOKEN: PushTokenRecord = {
  userId: 'user-recipient',
  platform: 'android',
  fcmToken: FCM_TOKEN,
  bundleId: 'com.miranatechnologies.tacendum',
  updatedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000,
};

const CREDENTIALS = {
  projectId: 'tacendum-test',
  clientEmail: 'push@tacendum-test.iam.gserviceaccount.com',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  tokenUri: 'https://oauth2.googleapis.com/token',
};

const ALERT = {
  from: 'user-sender',
  ts: 1_700_000_000_000,
  msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  msgType: 'ciphertext',
  payload: 'Y2lwaGVydGV4dA==',
};

let logs: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
const log = (event: string, fields?: Record<string, string | number | boolean>) => {
  logs.push({ event, fields });
};

beforeEach(() => {
  logs = [];
  sendCallWakeMock.mockReset();
  sendMessageWakeMock.mockReset();
});

describe('sending', () => {
  it('degrades to `failed` when unconfigured, rather than throwing', async () => {
    const sender = makeFcmPushSender({ credentials: null, log });
    await expect(sender.wake(ANDROID_TOKEN, 'user-caller')).resolves.toBe('failed');
  });

  it('warns about being unconfigured ONCE, not once per call', async () => {
    const sender = makeFcmPushSender({ credentials: null, log });
    await sender.wake(ANDROID_TOKEN, 'user-caller');
    await sender.notify(ANDROID_TOKEN, ALERT);
    await sender.wake(ANDROID_TOKEN, 'user-caller');
    expect(logs.filter(l => l.event === 'fcm_unconfigured')).toHaveLength(1);
  });

  it('never logs the key material or the device token', async () => {
    sendCallWakeMock.mockResolvedValue({ outcome: 'failed', status: 500, reason: 'INTERNAL' });
    const sender = makeFcmPushSender({ credentials: CREDENTIALS, log });
    await sender.wake(ANDROID_TOKEN, 'user-caller');
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('PRIVATE KEY');
    expect(dump).not.toContain(FCM_TOKEN);
  });

  it('returns `no_token` for a row with no FCM token before checking credentials', async () => {
    let credentialReads = 0;
    const sender = makeFcmPushSender({
      get credentials() {
        credentialReads += 1;
        return null;
      },
      log,
    });
    const rowWithout: PushTokenRecord = { ...ANDROID_TOKEN };
    delete rowWithout.fcmToken;

    await expect(sender.wake(rowWithout, 'user-caller')).resolves.toBe('no_token');
    await expect(sender.notify(rowWithout, ALERT)).resolves.toBe('no_token');
    expect(logs.map(({ event }) => event)).toEqual([
      'push_skipped_no_fcm_token',
      'push_skipped_no_fcm_token',
    ]);
    expect(credentialReads).toBe(0);
  });

  it.each(['sent', 'token_invalid', 'failed'] as const)(
    'returns FCM outcome `%s` unchanged, on both lanes',
    async (outcome) => {
      sendCallWakeMock.mockResolvedValue({ outcome });
      sendMessageWakeMock.mockResolvedValue({ outcome });
      const sender = makeFcmPushSender({ credentials: CREDENTIALS, log });

      await expect(sender.wake(ANDROID_TOKEN, 'user-caller')).resolves.toBe(outcome);
      await expect(sender.notify(ANDROID_TOKEN, ALERT)).resolves.toBe(outcome);
    },
  );

  it('returns `failed` when the transport throws', async () => {
    sendCallWakeMock.mockRejectedValue(new Error('transport unavailable'));
    const sender = makeFcmPushSender({ credentials: CREDENTIALS, log });
    await expect(sender.wake(ANDROID_TOKEN, 'user-caller')).resolves.toBe('failed');
  });

  it('hands the client the routing facts of an alert and NEVER its ciphertext', async () => {
    // The property the whole lane is built around, pinned at the seam the
    // ciphertext would have to cross: the AlertPayload arrives here carrying
    // `payload` (the PushSender contract is shared with APNs, whose
    // extension needs it), and what reaches the FCM client has no such
    // field. fcm.test.ts pins the same property on the wire.
    sendMessageWakeMock.mockResolvedValue({ outcome: 'sent' });
    const sender = makeFcmPushSender({ credentials: CREDENTIALS, log });
    await sender.notify(ANDROID_TOKEN, ALERT);

    expect(sendMessageWakeMock).toHaveBeenCalledWith(FCM_TOKEN, {
      from: ALERT.from,
      ts: ALERT.ts,
      msgId: ALERT.msgId,
      msgType: ALERT.msgType,
    });
    expect(JSON.stringify(sendMessageWakeMock.mock.calls)).not.toContain(ALERT.payload);
  });

  it('logs a refusal with status and reason, never the token', async () => {
    sendMessageWakeMock.mockResolvedValue({
      outcome: 'token_invalid',
      status: 404,
      reason: 'UNREGISTERED',
    });
    const sender = makeFcmPushSender({ credentials: CREDENTIALS, log });
    await sender.notify(ANDROID_TOKEN, ALERT);

    const refusal = logs.find(l => l.event === 'fcm_refused');
    expect(refusal?.fields).toEqual({ kind: 'message', status: 404, reason: 'UNREGISTERED' });
    expect(JSON.stringify(logs)).not.toContain(FCM_TOKEN);
  });
});

describe('the platform router', () => {
  const IOS_TOKEN: PushTokenRecord = {
    userId: 'user-recipient',
    voipToken: 'a'.repeat(64),
    alertToken: 'b'.repeat(64),
    env: 'production',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_000,
  };

  function recordingLane(name: string, calls: string[]): PushSender {
    return {
      wake: async () => {
        calls.push(`${name}.wake`);
        return 'sent';
      },
      notify: async () => {
        calls.push(`${name}.notify`);
        return 'sent';
      },
    };
  }

  it('routes an android row to the FCM lane, on both send kinds', async () => {
    const calls: string[] = [];
    const router = makePlatformPushSender({
      apns: recordingLane('apns', calls),
      fcm: recordingLane('fcm', calls),
    });
    await router.wake(ANDROID_TOKEN, 'user-caller');
    await router.notify(ANDROID_TOKEN, ALERT);
    expect(calls).toEqual(['fcm.wake', 'fcm.notify']);
  });

  it('routes an iOS row to APNs — and a LEGACY row with no platform field the same way', async () => {
    // The compatibility rule, exercised: every row written before has no
    // `platform` attribute, and absence means iOS forever.
    const calls: string[] = [];
    const router = makePlatformPushSender({
      apns: recordingLane('apns', calls),
      fcm: recordingLane('fcm', calls),
    });
    await router.wake(IOS_TOKEN, 'user-caller');
    const legacy: PushTokenRecord = { ...IOS_TOKEN };
    delete legacy.platform;
    await router.notify(legacy, ALERT);
    expect(calls).toEqual(['apns.wake', 'apns.notify']);
  });
});
