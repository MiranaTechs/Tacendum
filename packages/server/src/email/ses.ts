import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { EmailSender } from '../handlers/http.js';
import { log } from '../log.js';

/**
 * The SES delivery lane — the deps-seam transport
 * behind `Deps.email`, exactly as APNs/FCM sit behind `Deps.push`: handlers
 * never touch this SDK, tests fake the seam, and only the HTTP function's
 * role holds the `ses:SendEmail` grant (scoped to the one identity + one
 * configuration set, negotiated in the open in the deployment's security tests).
 *
 * What touches the address, stated exactly: the address exists in SES
 * transit at send time and in NO retained Tacendum log — every log line
 * here carries at most the error class; the caller's counter events carry
 * the opaque HMAC ref. The configuration set is created with NO event
 * destinations (identifier-bearing event logging OFF) and SES
 * account-level suppression ON for bounces/complaints; a suppression
 * rejection surfaces here as `suppressed`, and the CALLER records the
 * Tacendum-side shadow keyed by the HMAC ref, never the address.
 */

/** SES wiring from the environment — identity/addresses are configuration,
 * not secrets: the FROM address and configuration-set NAME are public facts
 * of the deployment (the secret-shaped thing, K_id, rides Secrets Manager
 * via aws/deps.ts). Absent = no sender, and the routes fail closed. */
export function readSesConfig(
  env: NodeJS.ProcessEnv = process.env,
): { fromAddress: string; configurationSet: string } | undefined {
  const fromAddress = env.SES_FROM_ADDRESS;
  const configurationSet = env.SES_CONFIGURATION_SET;
  if (!fromAddress || !configurationSet) return undefined;
  return { fromAddress, configurationSet };
}

/** Lazily built, cached per container — the SDK-client discipline every
 * other AWS transport here follows. */
let cachedClient: SESv2Client | undefined;

export function makeSesEmailSender(
  config: { fromAddress: string; configurationSet: string },
  send?: (cmd: SendEmailCommand) => Promise<unknown>,
): EmailSender {
  const doSend =
    send ??
    ((cmd: SendEmailCommand) => {
      cachedClient ??= new SESv2Client({});
      return cachedClient.send(cmd);
    });
  return {
    async sendCode({ address, code, purpose }) {
      const subject =
        purpose === 'recovery' ? 'Your Tacendum recovery code' : 'Your Tacendum verification code';
      // Plain text, code + fixed copy only: nothing user-generated rides an
      // email, so this channel can never become an injection surface.
      const body =
        `${code} is your Tacendum ${purpose === 'recovery' ? 'recovery' : 'verification'} code. ` +
        'It expires in 5 minutes. If you did not request it, ignore this message.';
      try {
        await doSend(
          new SendEmailCommand({
            FromEmailAddress: config.fromAddress,
            Destination: { ToAddresses: [address] },
            ConfigurationSetName: config.configurationSet,
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: { Text: { Data: body, Charset: 'UTF-8' } },
              },
            },
          }),
        );
        return 'sent';
      } catch (err) {
        const name = err instanceof Error ? err.name : 'unknown';
        const message = err instanceof Error ? err.message : '';
        // SES answers MessageRejected with a suppression sentence when the
        // account-level suppression list holds the address — the one case
        // the caller records our HMAC-keyed shadow for.
        if (name === 'MessageRejected' && /suppress/i.test(message)) {
          log.info('email_send_suppressed');
          return 'suppressed';
        }
        // Error CLASS only — never the address, never the body.
        log.error('email_send_failed', { error: name });
        return 'failed';
      }
    },
  };
}
