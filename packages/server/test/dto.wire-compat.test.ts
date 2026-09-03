import { describe, expect, it } from 'vitest';
import { AuthChallengeResponse, DiscoveryLookupResponse, WsTicketResponse } from '@tacendum/shared';

/**
 * The wire narrowing, server half. The app `.parse()`s every response DTO
 * strictly and has no OTA path, so a REQUIRED field the client never reads
 * is nothing but breakage surface: a server that ever dropped `expiresAt`
 * from the ticket response would stop every installed build from dialling.
 * The three client-unused fields are optional in the schema now. The server
 * keeps emitting them (its own tests pin that); what changes is only that
 * the shipped client's parse tolerates their absence from the next build
 * on. */

const TICKET = 'dGlja2V0LXRpY2tldC10aWNrZXQtdGlja2V0LXRpY2tldC0x';
const CHALLENGE = 'Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGxlbmc=';
const MEMBER = { userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', class: 'phone' as const };

describe('client-unused response fields are tolerated when absent', () => {
  it('WsTicketResponse parses with and without expiresAt', () => {
    expect(WsTicketResponse.parse({ ticket: TICKET, expiresAt: 1 })).toEqual({
      ticket: TICKET,
      expiresAt: 1,
    });
    expect(WsTicketResponse.parse({ ticket: TICKET })).toEqual({ ticket: TICKET });
    // Still a constraint when present.
    expect(() => WsTicketResponse.parse({ ticket: TICKET, expiresAt: 0 })).toThrow();
    expect(() => WsTicketResponse.parse({})).toThrow();
  });

  it('AuthChallengeResponse parses with and without expiresAt', () => {
    const withIt = AuthChallengeResponse.parse({ challenge: CHALLENGE, expiresAt: 5 });
    expect(withIt.challenge).toBe(CHALLENGE);
    expect(withIt.expiresAt).toBe(5);
    const without = AuthChallengeResponse.parse({ challenge: CHALLENGE });
    expect(without.challenge).toBe(CHALLENGE);
    expect(without.expiresAt).toBeUndefined();
    expect(() => AuthChallengeResponse.parse({ challenge: CHALLENGE, expiresAt: -1 })).toThrow();
  });

  it('DiscoveryLookupResponse parses with and without rosterVersion', () => {
    expect(DiscoveryLookupResponse.parse({ members: [MEMBER], rosterVersion: 1 }).rosterVersion).toBe(1);
    expect(DiscoveryLookupResponse.parse({ members: [MEMBER] }).rosterVersion).toBeUndefined();
    expect(() => DiscoveryLookupResponse.parse({ members: [] })).toThrow();
  });
});
