import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import type { SmsSender } from '../handlers/http.js';
import { log } from '../log.js';

/**
 * The SMS delivery lane — AWS End User
 * Messaging `SendTextMessage` on the SMS-Voice v2 API, the deps-seam
 * transport behind `Deps.sms`, exactly as SES sits behind `Deps.email`:
 * handlers never touch this SDK, tests fake the seam, and only the HTTP
 * function's role holds the `sms-voice:SendTextMessage` grant (scoped to the
 * one origination identity + the one Protect configuration, negotiated in
 * the open in the deployment's security tests).
 *
 * What touches the number, stated exactly: the number exists in EUM transit
 * at send time and in NO retained Tacendum log — every log line here carries
 * at most the error class; the caller's counter events carry the opaque
 * HMAC ref. NO configuration set is attached and NO event destination
 * exists (identifier-bearing vendor event logging OFF, at
 * full strength: EUM delivery events carry destination numbers, per-message
 * prices, and carrier metadata — the reason an SNS feedback pipe was
 * refused for email applies tenfold here). The vendor's SYNCHRONOUS
 * accept/refuse is the ONLY outcome v1 consumes; an opted-out destination
 * surfaces here as `suppressed`, and the CALLER records the Tacendum-side
 * `phonesupp#` shadow keyed by the HMAC ref, never the number.
 *
 * THE SPEND BRAKES RIDE EVERY SEND (a message-count bound
 * is not a spend bound), each named per command in the ses.test.ts
 * per-command precedent (posture on every command, never assumed from
 * account state):
 * - `MaxPrice` US$0.05/part on every SendTextMessage;
 * - the Protect configuration id on every command (country rules BLOCK for
 * every ISO country off the allowlist; ALSO set as the ACCOUNT
 * DEFAULT at the deploy lane, so a code path that forgot this parameter
 * still could not send outside it);
 * - the OTP body single-segment GSM-7 by construction (≤160 chars,
 * fixture-asserted in sms.test.ts);
 * - the destination-country allowlist prefix check — the handlers refuse
 * off-allowlist destinations BEFORE this seam is touched, and this seam
 * refuses them again before its client call (belt and braces: neither
 * layer trusts the other to have run);
 * - the vendor monthly spend limit (US$25, alarm at 50%) is an AWS
 * ACCOUNT-LEVEL attribute no code path can set — an operator
 * step, never assumed.
 */

/** release pins — release values the suites assert verbatim.
 * The allowlist is the launch set: US (`+1`) ONLY, widened
 * only by amending. Stated honestly: the `+1` prefix admits all NANP
 * destinations — the vendor-side Protect country rule is the sharp
 * per-country edge; this prefix check is the brake. */
export const SMS_ALLOWED_DESTINATION_PREFIXES = ['+1'] as const;
/** Per-message-part price ceiling, US dollars. */
export const SMS_MAX_PRICE_USD_PER_PART = '0.05';
/** Single-segment GSM-7 ceiling: the OTP body must fit ONE part. */
export const SMS_OTP_MAX_GSM7_CHARS = 160;
/** The vendor monthly spend limit + its alarm share — enacted at
 * the ACCOUNT level (SetTextMessageSpendLimitOverride, an operator-set
 * account control) and alarmed in CDK; pinned here so the suite
 * asserts the values the operator control and the alarm must carry. Stated
 * honestly: this wall, not the 200/day message ceiling, is
 * the binding spend bound — the ceiling admits 2.4-12× this figure per
 * month (the reconciliation note on PHONE_SEND_FLEET_DAILY_CEILING) — and
 * the override cannot exceed the AWS account's spend-limit MaxLimit, which
 * for accounts that never requested an increase defaults to US$1.00 and is
 * raised by an AWS quota/support request with its own lead time: the
 * operator must verify MaxLimit ≥ 25 before setting the override. */
export const SMS_MONTHLY_SPEND_LIMIT_USD = 25;
export const SMS_SPEND_ALARM_FRACTION = 0.5;

/** True iff the normalized E.164 destination is inside the launch
 * allowlist. ONE predicate for the handler brake and the seam's belt. */
export function smsDestinationAllowed(normalizedNumber: string): boolean {
  return SMS_ALLOWED_DESTINATION_PREFIXES.some((prefix) => normalizedNumber.startsWith(prefix));
}

/** The GSM-7 basic character set (plus the space/newline the OTP copy uses).
 * The OTP body is built from fixed ASCII copy + digits, all inside it — the
 * predicate exists so the fixture ASSERTS single-segment rather than
 * trusting the copy to stay short and plain. */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
export function isSingleSegmentGsm7(body: string): boolean {
  if (body.length > SMS_OTP_MAX_GSM7_CHARS) return false;
  for (const ch of body) if (!GSM7_BASIC.includes(ch)) return false;
  return true;
}

/** The OTP body — fixed copy + the code, nothing user-generated (this
 * channel can never become an injection surface), single-segment GSM-7 by
 * construction and pinned by the sms.test.ts fixture. */
export function smsOtpBody(code: string, purpose: 'attach' | 'recovery'): string {
  return (
    `${code} is your Tacendum ${purpose === 'recovery' ? 'recovery' : 'verification'} code. ` +
    'It expires in 5 minutes. If you did not request it, ignore this message.'
  );
}

/** EUM wiring from the environment — the origination identity (the
 * provisioned toll-free number or its ARN) and the Protect configuration id
 * are configuration, not secrets: public facts of the deployment, exactly
 * as the SES FROM address rides plain env. Absent = no sender, and the
 * phone routes fail closed.
 *
 * THE SHARP EDGE, NAMED: nothing at runtime asserts that
 * SMS_PROTECT_CONFIGURATION_ID names the CDK-built default-DENY
 * configuration — a stale/wrong id fails closed (ValidationException →
 * 'failed'), but a valid-yet-PERMISSIVE id would silently widen the
 * country scope to the whole `+1` prefix set (all of NANP — Caribbean A2P
 * rates included) with no code-side signal, because the server prefix
 * check is NANP-wide BY DESIGN (US-only lives in the vendor-side
 * country rules). A runtime DescribeProtectConfiguration assertion would
 * need a new IAM grant (census may only shrink — refused); the control is
 * an operator step verifying this env id equals the
 * stack's SmsProtectConfigurationId output. */
export function readSmsConfig(
  env: NodeJS.ProcessEnv = process.env,
): { originationIdentity: string; protectConfigurationId: string } | undefined {
  const originationIdentity = env.SMS_ORIGINATION_IDENTITY;
  const protectConfigurationId = env.SMS_PROTECT_CONFIGURATION_ID;
  if (!originationIdentity || !protectConfigurationId) return undefined;
  return { originationIdentity, protectConfigurationId };
}

/** Lazily built, cached per container — the SDK-client discipline every
 * other AWS transport here follows. */
let cachedClient: PinpointSMSVoiceV2Client | undefined;

export function makeEumSmsSender(
  config: { originationIdentity: string; protectConfigurationId: string },
  send?: (cmd: SendTextMessageCommand) => Promise<unknown>,
): SmsSender {
  const doSend =
    send ??
    ((cmd: SendTextMessageCommand) => {
      cachedClient ??= new PinpointSMSVoiceV2Client({});
      return cachedClient.send(cmd);
    });
  return {
    async sendCode({ number, code, purpose }) {
      // The belt (the handler already braked before this seam was
      // touched — neither layer trusts the other): an off-allowlist
      // destination NEVER reaches the client call. Error-class-only log.
      if (!smsDestinationAllowed(number)) {
        log.error('sms_send_refused_destination');
        return 'failed';
      }
      const body = smsOtpBody(code, purpose);
      try {
        await doSend(
          new SendTextMessageCommand({
            DestinationPhoneNumber: number,
            OriginationIdentity: config.originationIdentity,
            MessageBody: body,
            // TRANSACTIONAL: the OTP class — no promotional throttling lane.
            MessageType: 'TRANSACTIONAL',
            // The spend pins, per command (the ses.test.ts config-set
            // precedent): price ceiling and Protect config named on EVERY
            // send, never assumed from account defaults.
            MaxPrice: SMS_MAX_PRICE_USD_PER_PART,
            ProtectConfigurationId: config.protectConfigurationId,
          }),
        );
        return 'sent';
      } catch (err) {
        const name = err instanceof Error ? err.name : 'unknown';
        const reason =
          err instanceof Error ? (err as { Reason?: string }).Reason ?? '' : '';
        const message = err instanceof Error ? err.message : '';
        // The vendor's SYNCHRONOUS opted-out refusal (the STOP list — EUM
        // answers ConflictException with reason
        // DESTINATION_PHONE_NUMBER_OPTED_OUT): the one case the caller
        // records our HMAC-keyed phonesupp# shadow for. The ONLY delivery
        // outcome v1 consumes beyond accept — no DLR pipe.
        if (
          name === 'ConflictException' &&
          (reason === 'DESTINATION_PHONE_NUMBER_OPTED_OUT' || /opted.?out/i.test(message))
        ) {
          log.info('sms_send_suppressed');
          return 'suppressed';
        }
        // Error CLASS only — never the number, never the body.
        log.error('sms_send_failed', { error: name });
        return 'failed';
      }
    },
  };
}
