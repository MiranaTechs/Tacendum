import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApnsPushSender } from '../src/push/sender.js';
import type { PushTokenRecord } from '../src/db/data.js';

const { sendVoipMock, sendAlertMock } = vi.hoisted(() => ({
  sendVoipMock: vi.fn(),
  sendAlertMock: vi.fn(),
}));

vi.mock('../src/push/apns.js', () => ({
  makeApnsClient: () => ({
    sendVoip: sendVoipMock,
    sendAlert: sendAlertMock,
  }),
}));

/**
 * The wiring between a token row and APNs. The behaviours that matter are all
 * about failing safely: a missing key must not break message delivery, a dead
 * token must be reported so the row can be pruned, and nothing sensitive may
 * reach a log line.
 *
 * How the credentials are OBTAINED — the runtime Secrets Manager fetch behind
 * `readApnsCredentials` — is push.secrets.test.ts's subject, the way
 * turn.secrets.test.ts covers the relay's. This file takes them as given.
 */

const TOKEN: PushTokenRecord = {
  userId: 'user-recipient',
  voipToken: 'a'.repeat(64),
  env: 'sandbox',
  bundleId: 'com.miranatechnologies.tacendum',
  updatedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000,
};

const CREDENTIALS = {
  keyId: 'KEY123',
  teamId: 'TEAM123',
  bundleId: 'com.miranatechnologies.tacendum',
  privateKeyP8: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
};

let logs: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
const log = (event: string, fields?: Record<string, string | number | boolean>) => {
  logs.push({ event, fields });
};

beforeEach(() => {
  logs = [];
  sendVoipMock.mockReset();
  sendAlertMock.mockReset();
});

describe('sending', () => {
  it('degrades to `failed` when unconfigured, rather than throwing', async () => {
    // A push channel that throws would turn a missing key into FAILED MESSAGE
    // DELIVERY, which is far worse than a call that rings late.
    const sender = makeApnsPushSender({ credentials: null, log });
    await expect(sender.wake(TOKEN, 'user-caller')).resolves.toBe('failed');
  });

  it('warns about being unconfigured ONCE, not once per call', async () => {
    const sender = makeApnsPushSender({ credentials: null, log });
    await sender.wake(TOKEN, 'user-caller');
    await sender.wake(TOKEN, 'user-caller');
    await sender.wake(TOKEN, 'user-caller');
    expect(logs.filter(l => l.event === 'apns_unconfigured')).toHaveLength(1);
  });

  it('never logs the key material or the device token', async () => {
    const sender = makeApnsPushSender({ credentials: null, log });
    await sender.wake(TOKEN, 'user-caller');
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('PRIVATE KEY');
    expect(dump).not.toContain(TOKEN.voipToken);
  });

  it('returns `no_token` for a row with no VoIP token before checking credentials', async () => {
    let credentialReads = 0;
    const sender = makeApnsPushSender({
      get credentials() {
        credentialReads += 1;
        return null;
      },
      log,
    });

    await expect(
      sender.wake(
        {
          userId: TOKEN.userId,
          alertToken: 'b'.repeat(64),
          env: 'sandbox',
          bundleId: TOKEN.bundleId,
          updatedAt: TOKEN.updatedAt,
          expiresAt: TOKEN.expiresAt,
        },
        'user-caller',
      ),
    ).resolves.toBe('no_token');

    expect(logs.map(({ event }) => event)).toEqual(['push_skipped_no_voip_token']);
    expect(credentialReads).toBe(0);
  });

  it('returns `no_token` for a row with no alert token before checking credentials', async () => {
    let credentialReads = 0;
    const sender = makeApnsPushSender({
      get credentials() {
        credentialReads += 1;
        return null;
      },
      log,
    });

    await expect(
      sender.notify(TOKEN, {
        from: 'user-caller',
        ts: 1_700_000_000_000,
        msgId: 'message-1',
        msgType: 'ciphertext',
        payload: 'QUJD',
      }),
    ).resolves.toBe('no_token');

    expect(logs.map(({ event }) => event)).toEqual(['push_skipped_no_alert_token']);
    expect(credentialReads).toBe(0);
  });

  it.each(['sent', 'token_invalid', 'failed'] as const)(
    'returns APNs outcome `%s` unchanged',
    async (outcome) => {
      sendVoipMock.mockResolvedValue({ outcome });
      const sender = makeApnsPushSender({ credentials: CREDENTIALS, log });

      await expect(sender.wake(TOKEN, 'user-caller')).resolves.toBe(outcome);
    },
  );

  it('returns `failed` when APNs throws', async () => {
    sendVoipMock.mockRejectedValue(new Error('transport unavailable'));
    const sender = makeApnsPushSender({ credentials: CREDENTIALS, log });

    await expect(sender.wake(TOKEN, 'user-caller')).resolves.toBe('failed');
  });

  it('refuses a row with no APNs env — a misrouted Android row must fail loudly, not dial Apple', async () => {
    // `env` became optional with (an Android row has no APNs host to
    // name); only the platform router should ever decide which network a row
    // belongs to, so a row arriving here without one is a wiring defect.
    sendVoipMock.mockResolvedValue({ outcome: 'sent' });
    const sender = makeApnsPushSender({ credentials: CREDENTIALS, log });
    const rowWithoutEnv: typeof TOKEN = { ...TOKEN, alertToken: 'b'.repeat(64) };
    delete rowWithoutEnv.env;

    await expect(sender.wake(rowWithoutEnv, 'user-caller')).resolves.toBe('failed');
    await expect(
      sender.notify(rowWithoutEnv, {
        from: 'user-caller',
        ts: 1_700_000_000_000,
        msgId: 'message-1',
        msgType: 'ciphertext',
        payload: 'QUJD',
      }),
    ).resolves.toBe('failed');

    expect(logs.filter(l => l.event === 'apns_row_missing_env')).toHaveLength(2);
    expect(sendVoipMock).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });
});
