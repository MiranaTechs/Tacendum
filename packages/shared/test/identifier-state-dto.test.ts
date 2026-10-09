import { describe, expect, it } from 'vitest';
import {
  IdentifierStateResponse,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  UsernameEligibilityResponse,
} from '../src/dto.js';

/**
 * GET /v1/identifiers/state (fix/username-discovery, 2026-10-08): the
 * authenticated caller's OWN account-group facts — what a linked sibling
 * device, a reinstalled phone or a recovered account cannot learn from its
 * local rows, because the server never echoes a name (§4.9)
 * and identifier rows do not sync between siblings.
 *
 * Shape pins in the username-dto discipline: a strict object, five fields,
 * nothing about another party. And the landmine the route exists to step
 * around, pinned right beside it: `UsernameEligibilityResponse` stays
 * BYTE-IDENTICAL. Builds 31-33 parse it `.strict()` with no OTA path, so one
 * new field THERE turns every username claim and search in the fleet into
 * 'unavailable' on the day the server deploys.
 */

const FULL = {
  hasVerifiedIdentifier: true,
  emailLinked: true,
  phoneLinked: false,
  holdsUsername: true,
  usernameCooldownUntil: 1_760_000_000,
  usernameSince: 1_759_900_000,
  emailSince: 1_759_800_000,
  usernameFindable: true,
  emailFindable: false,
} as const;

const FACTS = ['hasVerifiedIdentifier', 'emailLinked', 'phoneLinked', 'holdsUsername'] as const;

describe('IdentifierStateResponse (GET /v1/identifiers/state: facts about the caller’s OWN group, nothing else)', () => {
  // RE-CUT 2026-10-08 (the gate pass, before the route ever shipped): the
  // five-key pin grew three caller-own facts — the live rows' birth stamps
  // (`usernameSince`, `emailSince`) and the held name's consent bit
  // (`usernameFindable`). Without the stamps a sibling's RENAME or a
  // replaced address left the acting device showing a phantom row whose
  // switch and Remove acted on a name it could not see; without the bit a
  // sibling's rename form started checked over an unfindable name. Every
  // one is about the caller's own group — a stamp or a bit, never a name.
  // RE-CUT 2026-10-08 (the proof pass, still before the route ever
  // shipped): a NINTH key, `emailFindable` — the linked email's consent bit
  // as the server holds it, or null. Without it the held-elsewhere Email
  // screen could neither show nor move findability by email, and a lost or
  // reinstalled linking device left no device able to switch it. The
  // caller's own group, a bit, never an address.
  it('parses the nine facts, and the key set is pinned in order — a tenth key is a plan amendment, not a tune', () => {
    expect(IdentifierStateResponse.parse(FULL)).toEqual(FULL);
    expect(Object.keys(IdentifierStateResponse.shape)).toEqual([
      'hasVerifiedIdentifier',
      'emailLinked',
      'phoneLinked',
      'holdsUsername',
      'usernameCooldownUntil',
      'usernameSince',
      'emailSince',
      'usernameFindable',
      'emailFindable',
    ]);
  });

  it('emailFindable is a boolean or null — REQUIRED, never absent, never retyped', () => {
    expect(IdentifierStateResponse.parse({ ...FULL, emailFindable: null }).emailFindable).toBeNull();
    expect(IdentifierStateResponse.parse({ ...FULL, emailFindable: true }).emailFindable).toBe(true);
    for (const bad of [1, 'yes', undefined]) {
      expect(IdentifierStateResponse.safeParse({ ...FULL, emailFindable: bad }).success, String(bad)).toBe(false);
    }
    const without: Record<string, unknown> = { ...FULL };
    delete without.emailFindable;
    expect(IdentifierStateResponse.safeParse(without).success).toBe(false);
  });

  it('usernameSince and emailSince are INTEGER unix seconds or null; usernameFindable is a boolean or null — each REQUIRED, never absent', () => {
    for (const key of ['usernameSince', 'emailSince'] as const) {
      expect(IdentifierStateResponse.parse({ ...FULL, [key]: null })[key]).toBeNull();
      expect(IdentifierStateResponse.parse({ ...FULL, [key]: 1_759_900_000 })[key]).toBe(1_759_900_000);
      for (const bad of [1.5, '1759900000', true, undefined, Number.NaN]) {
        expect(IdentifierStateResponse.safeParse({ ...FULL, [key]: bad }).success, `${key}=${String(bad)}`).toBe(false);
      }
    }
    expect(IdentifierStateResponse.parse({ ...FULL, usernameFindable: null }).usernameFindable).toBeNull();
    expect(IdentifierStateResponse.parse({ ...FULL, usernameFindable: false }).usernameFindable).toBe(false);
    for (const bad of [1, 'yes', undefined]) {
      expect(IdentifierStateResponse.safeParse({ ...FULL, usernameFindable: bad }).success, String(bad)).toBe(false);
    }
  });

  it('every fact is a REQUIRED boolean — a missing or retyped one is malformed', () => {
    for (const key of FACTS) {
      const without: Record<string, unknown> = { ...FULL };
      delete without[key];
      expect(IdentifierStateResponse.safeParse(without).success, `missing ${key}`).toBe(false);
      expect(IdentifierStateResponse.safeParse({ ...FULL, [key]: 'yes' }).success, key).toBe(false);
      expect(IdentifierStateResponse.safeParse({ ...FULL, [key]: 1 }).success, key).toBe(false);
      expect(IdentifierStateResponse.safeParse({ ...FULL, [key]: null }).success, key).toBe(false);
    }
  });

  it('usernameCooldownUntil is an INTEGER of UNIX EPOCH SECONDS or null — the group row’s own unit, never a float, a string, or absent', () => {
    expect(
      IdentifierStateResponse.parse({ ...FULL, usernameCooldownUntil: null }).usernameCooldownUntil,
    ).toBeNull();
    // The unit is the one the server already stores: `usernameRenamedAt` is
    // stamped in whole seconds (`Math.floor(now / 1000)`, data.ts), and the
    // wire carries `usernameRenamedAt + USERNAME_RENAME_COOLDOWN_SECONDS` in
    // that same unit. A seconds-scale sum is a legal value; the schema
    // cannot see units, so this vector documents the contract the server
    // and the app's ×1000 conversion both rest on.
    const renamedAtSeconds = 1_759_900_000;
    const until = renamedAtSeconds + USERNAME_RENAME_COOLDOWN_SECONDS;
    expect(
      IdentifierStateResponse.parse({ ...FULL, usernameCooldownUntil: until }).usernameCooldownUntil,
    ).toBe(until);
    for (const bad of [1.5, -0.5, '1760000000', true, undefined, Number.NaN]) {
      expect(
        IdentifierStateResponse.safeParse({ ...FULL, usernameCooldownUntil: bad }).success,
        String(bad),
      ).toBe(false);
    }
    const withoutUntil: Record<string, unknown> = { ...FULL };
    delete withoutUntil.usernameCooldownUntil;
    expect(IdentifierStateResponse.safeParse(withoutUntil).success).toBe(false);
  });

  it('.strict(): nothing about another party rides along — no name, identifier, target, reason, stamp, or rider', () => {
    for (const rider of [
      { username: 'alice' },
      { email: 'a@example.test' },
      { phone: '+15558675309' },
      { reason: 'cooldown' },
      { usernameRenamedAt: 1_759_900_000 },
      { groupId: '01HQGGGG0000000000000000G0' },
      { target: '01HQOTHR000000000000000000' },
      { ageHours: 72 },
    ]) {
      expect(
        IdentifierStateResponse.safeParse({ ...FULL, ...rider }).success,
        JSON.stringify(rider),
      ).toBe(false);
    }
  });
});

describe('UsernameEligibilityResponse stays BYTE-IDENTICAL (builds 31-33 parse it .strict() with no OTA)', () => {
  it('its key set is exactly [hasVerifiedIdentifier] and each answer serializes to the one pinned body', () => {
    expect(Object.keys(UsernameEligibilityResponse.shape)).toEqual(['hasVerifiedIdentifier']);
    expect(
      JSON.stringify(UsernameEligibilityResponse.parse({ hasVerifiedIdentifier: true })),
    ).toBe('{"hasVerifiedIdentifier":true}');
    expect(
      JSON.stringify(UsernameEligibilityResponse.parse({ hasVerifiedIdentifier: false })),
    ).toBe('{"hasVerifiedIdentifier":false}');
  });

  it('every state fact beyond the shared boolean is REFUSED on the eligibility wire — exactly the fields a widened route would have added', () => {
    for (const key of [
      'emailLinked',
      'phoneLinked',
      'holdsUsername',
      'usernameCooldownUntil',
      'usernameSince',
      'emailSince',
      'usernameFindable',
      'emailFindable',
    ] as const) {
      expect(
        UsernameEligibilityResponse.safeParse({ hasVerifiedIdentifier: true, [key]: FULL[key] })
          .success,
        key,
      ).toBe(false);
    }
    // The full state body never parses as an eligibility answer either.
    expect(UsernameEligibilityResponse.safeParse(FULL).success).toBe(false);
  });
});
