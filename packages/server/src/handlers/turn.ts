import { createHmac } from 'node:crypto';
import type { IceServer } from '@tacendum/shared';
import { opaqueUserRef } from '../opaque-ref.js';
import { LIMITS } from '../ratelimit.js';
import {
  errorResult,
  json,
  rateLimitedResult,
  type AuthedHandler,
  type TurnConfig,
} from './http.js';

/**
 * POST /v1/turn-credentials.
 *
 * coturn's `use-auth-secret` scheme (RFC 5766 the "TURN REST API"):
 *
 * username = "<unix_expiry>:<opaque_user_ref>"
 * credential = base64(HMAC_SHA1(static_auth_secret, username))
 *
 * The relay validates this offline with the shared secret, so minting costs no
 * round trip and a compromised relay cannot mint credentials for anyone else.
 *
 * **Crypto-inventory note:** server-side `crypto.createHmac`
 * lives in exactly two files, and both computations are recorded. (An
 * earlier version of this note described this file as one HMAC; it credited
 * the credential and omitted the user ref. Both then lived here; the user
 * ref has since moved.)
 * (a) The credential, HERE: HMAC-SHA1 authorizes relay *access*; it protects
 * no user content and is invisible to the security of the media, which is
 * DTLS-SRTP keyed on the devices. SHA-1 is not our choice — it is what
 * coturn computes, and both sides must compute the same thing.
 * (b) The user ref, in `src/opaque-ref.ts` (moved there, crypto unchanged —
 * the lifecycle log events and the
 * activity actor key pseudonymize with the same primitive): HMAC-SHA256 over
 * the userId with a server-held salt — a keyed pseudonymization, not an
 * authenticator. The relay sees this salted hash, never the userId, so relay
 * logs — which do record IP pairs — cannot be joined to the messaging tables
 * without the salt. That unlinkability is the privacy-relevant property of
 * this handler.
 */

/** 12 h: long enough that a client refetches roughly daily, short enough that
 * a leaked credential is not a standing relay grant. */
const DEFAULT_TTL_SECONDS = 12 * 3600;

/** What coturn will independently compute for this username. */
function credentialFor(username: string, authSecret: string): string {
  return createHmac('sha1', authSecret).update(username).digest('base64');
}

/** Split the configured URLs into the entries WebRTC expects: STUN needs no
 * credential, every TURN/TURNS entry carries the same ephemeral pair. */
function buildIceServers(config: TurnConfig, username: string): IceServer[] {
  const credential = credentialFor(username, config.authSecret);
  return config.urls.map(url =>
    url.startsWith('stun:')
      ? { urls: [url] }
      : { urls: [url], username, credential },
  );
}

export const turnCredentialsHandler: AuthedHandler = async (event, deps, auth) => {
  // Each mint is a relay capability, so it is bounded per user. Taken before
  // the availability check so a client cannot probe configuration for free.
  const retry = await deps.rateLimit.take(`turn:${auth.userId}`, LIMITS.turnCredentials);
  if (retry > 0) return rateLimitedResult(retry);

  const config = deps.turn;
  if (!config || config.urls.length === 0) {
    // Say so plainly rather than returning an empty set the client would read
    // as "relays exist but none are reachable": with no TURN the client can
    // still place a direct call, and it should know that is what it is doing.
    return errorResult(503, 'turn_unavailable', 'no relay is configured');
  }

  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiry = Math.floor(deps.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${opaqueUserRef(auth.userId, config.userSalt)}`;

  // Count only. No userId (it would join relay logs to messaging), no username
  // (it contains the ref), no credential, no secret, no salt.
  deps.log('turn_credentials_minted', { ttlSeconds, servers: config.urls.length });

  return json(200, { iceServers: buildIceServers(config, username), ttlSeconds });
};
