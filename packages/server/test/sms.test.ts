import { describe, expect, it, vi } from 'vitest';
import type { SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import {
  SMS_ALLOWED_DESTINATION_PREFIXES,
  SMS_MAX_PRICE_USD_PER_PART,
  SMS_MONTHLY_SPEND_LIMIT_USD,
  SMS_OTP_MAX_GSM7_CHARS,
  SMS_SPEND_ALARM_FRACTION,
  isSingleSegmentGsm7,
  makeEumSmsSender,
  readSmsConfig,
  smsDestinationAllowed,
  smsOtpBody,
} from '../src/sms/eum.js';

/**
 * The EUM transport's send-shape contract (/) — the ses.test.ts per-command precedent: every spend brake
 * is NAMED on every SendTextMessage command, never assumed from account
 * state, because the account-default Protect association and the monthly
 * spend limit are operator steps a code path must not lean on.
 */
describe('sms/eum', () => {
  const config = {
    originationIdentity: 'arn:aws:sms-voice:us-east-1:111111111111:phone-number/phone-test',
    protectConfigurationId: 'protect-test-id',
  };

  it('release pins, asserted verbatim as release values', () => {
    expect(SMS_ALLOWED_DESTINATION_PREFIXES).toEqual(['+1']);
    expect(SMS_MAX_PRICE_USD_PER_PART).toBe('0.05');
    expect(SMS_OTP_MAX_GSM7_CHARS).toBe(160);
    expect(SMS_MONTHLY_SPEND_LIMIT_USD).toBe(25);
    expect(SMS_SPEND_ALARM_FRACTION).toBe(0.5);
  });

  it('EVERY SendTextMessage carries MaxPrice US$0.05, the origination identity, the Protect configuration id, and the TRANSACTIONAL type — both purposes', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sender = makeEumSmsSender(config, send);

    const attach = await sender.sendCode({
      number: '+15550001111',
      code: '123456',
      ref: 'ref-a',
      purpose: 'attach',
    });
    const recovery = await sender.sendCode({
      number: '+15550002222',
      code: '654321',
      ref: 'ref-b',
      purpose: 'recovery',
    });

    expect(attach).toBe('sent');
    expect(recovery).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    for (const [cmd] of send.mock.calls as [SendTextMessageCommand][]) {
      // The per-command posture (the ses.test.ts config-set precedent): the
      // price ceiling and the Protect config ride the COMMAND — the
      // account-default association is a belt, never the reliance.
      expect(cmd.input.MaxPrice).toBe('0.05');
      expect(cmd.input.ProtectConfigurationId).toBe('protect-test-id');
      expect(cmd.input.OriginationIdentity).toBe(config.originationIdentity);
      expect(cmd.input.MessageType).toBe('TRANSACTIONAL');
      // No configuration set and no feedback: the posture —
      // nothing on the command can route an event pipe.
      expect(cmd.input.ConfigurationSetName).toBeUndefined();
      expect(cmd.input.MessageFeedbackEnabled).toBeUndefined();
    }
  });

  it('the OTP body is single-segment GSM-7 (≤160, every char in the basic set) — the fixture, both purposes, all code shapes', () => {
    for (const purpose of ['attach', 'recovery'] as const) {
      for (const code of ['000000', '123456', '999999']) {
        const body = smsOtpBody(code, purpose);
        expect(body).toContain(code);
        expect(body.length).toBeLessThanOrEqual(SMS_OTP_MAX_GSM7_CHARS);
        expect(isSingleSegmentGsm7(body)).toBe(true);
      }
    }
    // The predicate itself is honest: an over-length or non-GSM-7 body fails.
    expect(isSingleSegmentGsm7('a'.repeat(161))).toBe(false);
    expect(isSingleSegmentGsm7('emoji \u{1F600} body')).toBe(false);
  });

  it('an off-allowlist destination NEVER reaches the client call — the belt inside the seam itself', async () => {
    const send = vi.fn().mockResolvedValue({});
    const sender = makeEumSmsSender(config, send);
    for (const number of ['+447911123456', '+8615500001111', '+2125550100'.replace('+2', '+9')]) {
      expect(smsDestinationAllowed(number)).toBe(false);
      const outcome = await sender.sendCode({ number, code: '123456', ref: 'r', purpose: 'attach' });
      expect(outcome).toBe('failed');
    }
    expect(send).not.toHaveBeenCalled();
    // The honest boundary, stated: +1 admits all NANP destinations — the
    // vendor-side Protect country rule is the sharp per-country edge.
    expect(smsDestinationAllowed('+15550001111')).toBe(true);
  });

  it("classifies the vendor's SYNCHRONOUS opted-out refusal as `suppressed` — the ONLY delivery outcome beyond accept that v1 consumes", async () => {
    const err = Object.assign(new Error('Destination phone number is opted out'), {
      name: 'ConflictException',
      Reason: 'DESTINATION_PHONE_NUMBER_OPTED_OUT',
    });
    const sender = makeEumSmsSender(config, vi.fn().mockRejectedValue(err));
    await expect(
      sender.sendCode({ number: '+15550003333', code: '111111', ref: 'r', purpose: 'attach' }),
    ).resolves.toBe('suppressed');
  });

  it('answers `failed` (never throws) on any other transport error', async () => {
    const sender = makeEumSmsSender(
      config,
      vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'ThrottlingException' })),
    );
    await expect(
      sender.sendCode({ number: '+15550004444', code: '222222', ref: 'r', purpose: 'recovery' }),
    ).resolves.toBe('failed');
  });

  it('readSmsConfig fails closed unless BOTH env vars are present', () => {
    expect(readSmsConfig({})).toBeUndefined();
    expect(readSmsConfig({ SMS_ORIGINATION_IDENTITY: 'arn:x' })).toBeUndefined();
    expect(readSmsConfig({ SMS_PROTECT_CONFIGURATION_ID: 'p' })).toBeUndefined();
    expect(
      readSmsConfig({ SMS_ORIGINATION_IDENTITY: 'arn:x', SMS_PROTECT_CONFIGURATION_ID: 'p' }),
    ).toEqual({ originationIdentity: 'arn:x', protectConfigurationId: 'p' });
  });
});
