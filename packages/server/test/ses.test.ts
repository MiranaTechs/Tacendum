import { describe, expect, it, vi } from 'vitest';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { makeSesEmailSender, readSesConfig } from '../src/email/ses.js';

/**
 * The SES transport's send-shape contract. One fact here is load-bearing for
 * the DEPLOY posture, not just the code: the tacendum.com email identity
 * pre-exists account-globally (TacendumWebStack created it; TacendumStack
 * only references it by ARN), so there is NO identity-level default
 * configuration-set association. The TLS-REQUIRE + suppression posture of
 * EmailConfigurationSet reaches SES ONLY because every SendEmailCommand
 * names the set explicitly — which is exactly what this file pins.
 */
describe('email/ses', () => {
  const config = { fromAddress: 'no-reply@tacendum.com', configurationSet: 'tacendum-config-set' };

  it('names the configuration set and FROM address explicitly on every send, both purposes', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sender = makeSesEmailSender(config, send);

    const attach = await sender.sendCode({
      address: 'a@example.com',
      code: '123456',
      ref: 'ref-a',
      purpose: 'attach',
    });
    const recovery = await sender.sendCode({
      address: 'b@example.com',
      code: '654321',
      ref: 'ref-b',
      purpose: 'recovery',
    });

    expect(attach).toBe('sent');
    expect(recovery).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    for (const [cmd] of send.mock.calls as [SendEmailCommand][]) {
      // No identity default exists to fall back on (pre-existing identity,
      // referenced not created) — the set MUST ride the command itself.
      expect(cmd.input.ConfigurationSetName).toBe('tacendum-config-set');
      expect(cmd.input.FromEmailAddress).toBe('no-reply@tacendum.com');
    }
  });

  it('classifies a suppression-list MessageRejected as `suppressed`', async () => {
    const err = Object.assign(new Error('Email address is on the suppression list'), {
      name: 'MessageRejected',
    });
    const sender = makeSesEmailSender(config, vi.fn().mockRejectedValue(err));
    await expect(
      sender.sendCode({ address: 'c@example.com', code: '111111', ref: 'r', purpose: 'attach' }),
    ).resolves.toBe('suppressed');
  });

  it('answers `failed` (never throws) on any other transport error', async () => {
    const sender = makeSesEmailSender(
      config,
      vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'ServiceFailure' })),
    );
    await expect(
      sender.sendCode({ address: 'd@example.com', code: '222222', ref: 'r', purpose: 'recovery' }),
    ).resolves.toBe('failed');
  });

  it('readSesConfig fails closed unless BOTH env vars are present', () => {
    expect(readSesConfig({})).toBeUndefined();
    expect(readSesConfig({ SES_FROM_ADDRESS: 'x@y.z' })).toBeUndefined();
    expect(readSesConfig({ SES_CONFIGURATION_SET: 'set' })).toBeUndefined();
    expect(
      readSesConfig({ SES_FROM_ADDRESS: 'x@y.z', SES_CONFIGURATION_SET: 'set' }),
    ).toEqual({ fromAddress: 'x@y.z', configurationSet: 'set' });
  });
});
