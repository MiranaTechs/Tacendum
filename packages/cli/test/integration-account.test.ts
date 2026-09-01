/**
 * Integration accounts as the CLI sees them.
 *
 * The property these support is not enforced here and cannot be: the server
 * refuses any frame from an integration addressed anywhere but its bound owner
 * (`handlers/ws.ts` — `integration_unbound`, `integration_recipient_forbidden`).
 * That refusal is what makes it safe to hand an assistant a send capability at
 * all, because it holds no matter which binary the assistant runs.
 *
 * What the CLI owns is the part that decides whether the capability can be
 * OFFERED — the class recorded at birth, and the binding recorded once — and
 * getting either wrong means offering a tool that always fails or withholding
 * one that would work.
 */
import { describe, expect, it } from 'vitest';
import { AuthRequest } from '@tacendum/shared';

describe('the wire contract the CLI has to honour', () => {
  it('accepts an integration class, and nothing else', () => {
    const base = {
      identityKey: 'BQ0IDENTITYKEYBASE64',
      challenge: 'Q0hBTExFTkdF',
      signature: 'c2ln',
    };

    expect(AuthRequest.safeParse({ ...base, accountClass: 'integration' }).success).toBe(true);
    // Absent means human. The server defaults it, so the CLI must send NOTHING
    // rather than an explicit 'human' it would then have to keep in step.
    expect(AuthRequest.safeParse(base).success).toBe(true);
    // A typo must not quietly create an ordinary account that an operator then
    // believes is restricted.
    expect(AuthRequest.safeParse({ ...base, accountClass: 'human' }).success).toBe(false);
    expect(AuthRequest.safeParse({ ...base, accountClass: 'Integration' }).success).toBe(false);
  });
});

describe('what the profile has to remember', () => {
  // The server tells the CLI nothing about class or binding — `GET /v1/me`
  // returns a userId and stops — so this is local bookkeeping whose only job is
  // deciding what to OFFER. The server stays the authority on what is
  // permitted, including after an owner revokes a binding this file still
  // claims exists.
  //
  // The rule that matters is directional: the record may understate what an
  // account can do, never overstate it. An operator who reads `class:
  // integration` hands the credential to an assistant believing the server
  // confines it to one recipient.
  it('carries a class forward only when the account is genuinely the same', () => {
    const carry = (
      returning: boolean,
      asIntegration: boolean,
      previous: { userId: string; accountClass?: 'integration' } | null,
      userId: string,
    ) => {
      const inherited = previous?.userId === userId ? previous : null;
      return returning ? Boolean(inherited?.accountClass) : asIntegration;
    };

    // A first registration honours the flag.
    expect(carry(false, true, null, 'U1')).toBe(true);
    expect(carry(false, false, null, 'U1')).toBe(false);

    // A returning sign-in does NOT: the class is fixed at creation server-side,
    // so honouring --integration here would print a restriction that does not
    // exist. This is the case that made whoami lie.
    expect(carry(true, true, { userId: 'U1' }, 'U1')).toBe(false);

    // A returning integration keeps what it was, or the MCP server would stop
    // offering a tool that still works.
    expect(carry(true, false, { userId: 'U1', accountClass: 'integration' }, 'U1')).toBe(true);

    // A profile that outlived its account donates nothing. Re-registering after
    // a wipe mints a NEW userId, and inheriting the dead account's class would
    // claim a binding the server has never heard of.
    expect(carry(true, false, { userId: 'OLD', accountClass: 'integration' }, 'NEW')).toBe(false);
  });
});
