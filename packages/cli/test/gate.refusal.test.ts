import { describe, expect, it } from 'vitest';
import { exitCodeForServerError } from '../src/wsclient.js';
import { EXIT } from '../src/exit.js';

/**
 * a server refusal is not a timeout.
 *
 * The mapping is asserted directly because the property that matters is which
 * NUMBER a wrapper sees: TIMEOUT (7) is documented as "retry may help", and
 * every one of these refusals is permanent for the arguments given. The full
 * socket path is exercised by scripts/e2e-cli.sh against the real server.
 */

describe('exitCodeForServerError', () => {
  it('maps every integration refusal to REFUSED, never TIMEOUT', () => {
    for (const code of [
      'integration_unbound',
      'integration_recipient_forbidden',
      'integration_urgent_forbidden',
      'integration_inbox_restricted',
    ]) {
      expect(exitCodeForServerError(code)).toBe(EXIT.REFUSED);
      expect(exitCodeForServerError(code)).not.toBe(EXIT.TIMEOUT);
    }
  });

  it('maps a deleted/revoked sender to AUTH — a human must re-pair', () => {
    expect(exitCodeForServerError('unknown_sender')).toBe(EXIT.AUTH);
  });

  it('maps the two codes that already had a meaning to it', () => {
    expect(exitCodeForServerError('unknown_recipient')).toBe(EXIT.RECIPIENT);
    expect(exitCodeForServerError('rate_limited')).toBe(EXIT.RATELIMIT);
  });

  it('does not invent a remedy for a code it has never seen', () => {
    expect(exitCodeForServerError('invalid_frame')).toBe(EXIT.ERROR);
    expect(exitCodeForServerError('something_a_newer_server_invented')).toBe(EXIT.ERROR);
  });

  it('never answers TIMEOUT for anything — a refusal is an answer', () => {
    for (const code of [
      'unknown_sender',
      'unknown_recipient',
      'rate_limited',
      'invalid_frame',
      'integration_unbound',
      'whatever',
    ]) {
      expect(exitCodeForServerError(code)).not.toBe(EXIT.TIMEOUT);
    }
  });
});
