import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_NOTICE_KINDS,
  AccountsNotice,
  DiscoveryLookupRequest,
  RESERVED_USERNAMES,
  RESERVED_USERNAME_SKELETONS,
  RecoveryCodeRequest,
  RecoveryVerifyRequest,
  USERNAME_STRICT,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TAKEN_BODY,
  USERNAME_TAKEN_STATUS,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  UsernameClaimRequest,
  UsernameIdentifier,
  UsernameTakenResponse,
  UsernameUnlinkRequest,
  normalizeUsernameIdentifier,
  parseAccountsNoticeTolerant,
  usernameSkeleton,
} from '../src/dto.js';

/**
 * The username shared surface — DARK: no route
 * consumes any of this yet.
 *
 * These are fixture pins, not behavior tests (the accounts-dto.test.ts
 * discipline): the normalizer and the skeleton are BYTE-LOCKED once shipped —
 * a claim row written under one spelling and looked up under another is a
 * name that silently stopped resolving, and extending the skeleton map does
 * NOT retro-protect existing rows (§7 residual 1). Any drift here is a plan
 * amendment, not a tune.
 */

describe('normalizeUsernameIdentifier (§4.3: trim + case-fold, refuse-never-repair — the phone posture)', () => {
  it('byte fixtures: the exact outputs every usernamehash# claim key will be derived from', () => {
    // Pinned vectors. If any of these change, every usernamehash# claim row
    // ever written under the old normalization stops resolving — fixtures,
    // not examples.
    const vectors: Array<[string, string]> = [
      ['alice', 'alice'],
      ['  Alice  ', 'alice'],
      ['\tALICE_99\n', 'alice_99'],
      ['MiXeD_CaSe_007', 'mixed_case_007'],
    ];
    for (const [raw, want] of vectors) {
      expect(normalizeUsernameIdentifier(raw)).toBe(want);
    }
  });

  it('is idempotent — normalizing a normalized name is a no-op', () => {
    const once = normalizeUsernameIdentifier(' Bob_7 ');
    expect(normalizeUsernameIdentifier(once)).toBe(once);
  });

  it('Unicode that case-folds INTO the ASCII set collapses into the canonical name (U+212A Kelvin sign → k) — same claim bytes, same row, uniqueness-preserving', () => {
    const kelvin = String.fromCharCode(0x212a);
    const folded = normalizeUsernameIdentifier(`blac${kelvin}`);
    expect(folded).toBe('black');
    expect(USERNAME_STRICT.test(folded)).toBe(true);
  });

  it('USERNAME_STRICT is the pinned charset: 3-32 chars, starts with a letter, lowercase ASCII letters/digits/underscore only', () => {
    expect(USERNAME_STRICT.source).toBe('^[a-z][a-z0-9_]{2,31}$');
    for (const good of ['abc', 'alice', 'a00', 'a_b', `b${'x'.repeat(31)}`]) {
      expect(USERNAME_STRICT.test(good), good).toBe(true);
    }
    // Refused, never repaired: no NFKC, no transliteration, no trimming here.
    for (const bad of [
      'ab', // too short
      `b${'x'.repeat(32)}`, // too long
      '_alice', // must start with a letter
      '9lives', // must start with a letter
      'Alice', // uppercase never reaches the regex un-normalized
      'al ice', // inner whitespace
      'al-ice', // hyphen outside the charset
      'ålice', // non-ASCII that does not fold into the set
      'alice@example.com',
      '+15558675309',
    ]) {
      expect(USERNAME_STRICT.test(bad), bad).toBe(false);
    }
  });
});

describe('usernameSkeleton (§4.3: the pinned confusable fold — map, then string folds, then strip underscore, IN THAT ORDER)', () => {
  it('byte fixtures: the exact outputs every nameskel# claim key will be derived from', () => {
    const vectors: Array<[string, string]> = [
      // The per-character map {0→o, 1→l, i→l, 2→z, 3→e, 4→a, 5→s, 6→b,
      // 7→t, 8→b, 9→g} — digit 1 confuses with BOTH l and i, so folding
      // i→l collapses all three.
      ['al1ce', 'allce'],
      ['a1ice', 'allce'],
      ['alice', 'allce'],
      ['adm1n', 'admln'],
      ['admin', 'admln'],
      ['paypa1', 'paypal'],
      ['paypal', 'paypal'],
      ['m0derator', 'moderator'],
      ['z2o0', 'zzoo'],
      ['b4d5', 'bads'],
      ['a6789', 'abtbg'],
      ['x3lite', 'xellte'],
      // The string folds rn→m, vv→w, cl→d (multi-character confusables).
      ['rnirana', 'mlrana'],
      ['mirana', 'mlrana'],
      ['vvilliam', 'wllllam'],
      ['william', 'wllllam'],
      ['clara', 'dara'],
      ['dara', 'dara'],
      ['rnvvcl', 'mwd'],
      // Underscore stripped LAST.
      ['al_ice', 'allce'],
      ['a_b_c', 'abc'],
    ];
    for (const [normalized, want] of vectors) {
      expect(usernameSkeleton(normalized), normalized).toBe(want);
    }
  });

  it('the application ORDER is part of the pin: the map runs before the folds, and the underscore strip runs last', () => {
    // Map BEFORE folds: 1→l mints a 'cl' the fold must then see. Folds-first
    // would leave 'clara' (≠ 'dara') — the drift this vector detects.
    expect(usernameSkeleton('c1ara')).toBe('dara');
    // Strip LAST: the folds see 'r_n' (no 'rn' to fold), so the strip mints
    // 'rn' AFTER folding. Strip-first would yield 'm' — the other drift.
    expect(usernameSkeleton('r_n')).toBe('rn');
    expect(usernameSkeleton('v_v')).toBe('vv');
  });
});

describe('RESERVED_USERNAMES and its build-time skeletonized twin (§4.8 reserved denylist)', () => {
  it('the compiled-in list, pinned verbatim — additions are code deploys', () => {
    expect(RESERVED_USERNAMES).toEqual([
      'tacendum',
      'mirana',
      'admin',
      'administrator',
      'support',
      'help',
      'security',
      'official',
      'staff',
      'team',
      'moderator',
      'mod',
      'root',
      'system',
      'abuse',
      'billing',
      'info',
      'contact',
      'verify',
      'verified',
    ]);
    // Every reserved name is itself a legal normalized username — a reserved
    // spelling the charset refuses would be dead weight the check never hits.
    for (const name of RESERVED_USERNAMES) {
      expect(USERNAME_STRICT.test(name), name).toBe(true);
    }
  });

  it('the twin is skeleton-vs-SKELETON (§4.3): a plain skeleton-vs-name check would be broken by the i→l fold', () => {
    // The reason the twin exists: skeleton('admin') is 'admln', NOT 'admin' —
    // so 'adm1n' (skeleton 'admln') could never hit an UN-skeletonized list.
    expect(usernameSkeleton('admin')).toBe('admln');
    expect(RESERVED_USERNAME_SKELETONS.has('admln')).toBe(true);
    expect(RESERVED_USERNAME_SKELETONS.has('admin')).toBe(false);
    // The §4.3 vectors: each confusable variant's skeleton lands in the twin.
    for (const squat of ['adm1n', 'm0derator', 'rnirana', 'tacendurn', 'supp0rt', 'ver1fied']) {
      expect(RESERVED_USERNAME_SKELETONS.has(usernameSkeleton(squat)), squat).toBe(true);
    }
    // And the twin holds exactly the reserved names' skeletons, no more.
    expect(RESERVED_USERNAME_SKELETONS.size).toBeLessThanOrEqual(RESERVED_USERNAMES.length);
    for (const name of RESERVED_USERNAMES) {
      expect(RESERVED_USERNAME_SKELETONS.has(usernameSkeleton(name)), name).toBe(true);
    }
  });
});

describe('UsernameIdentifier (the wire shape: normalized form must match USERNAME_STRICT — refused, never repaired)', () => {
  it('admits raw spellings whose normalization is strict, exactly like the phone wire', () => {
    for (const raw of ['alice', ' Alice ', 'ALICE_99', `b${'x'.repeat(31)}`]) {
      expect(UsernameIdentifier.safeParse(raw).success, raw).toBe(true);
    }
  });

  it('refuses everything the strict charset refuses — no repair path exists', () => {
    for (const raw of ['ab', '_alice', '9lives', 'al ice', 'al-ice', 'ålice', 'alice@example.com', '+15558675309', '']) {
      expect(UsernameIdentifier.safeParse(raw).success, raw).toBe(false);
    }
  });
});

describe('claim/unlink wires (§4.5/§4.8 — the phone route-shape precedent: the ROUTE is the class, no discriminant field)', () => {
  it('UsernameClaimRequest carries the name and the EXPLICIT consent bit (§4.6) — nothing else, .strict()', () => {
    expect(
      UsernameClaimRequest.parse({ username: 'alice', discoverable: true }),
    ).toEqual({ username: 'alice', discoverable: true });
    // An unchecked claim is legal: name held but unfindable (§4.6).
    expect(
      UsernameClaimRequest.parse({ username: 'alice', discoverable: false }).discoverable,
    ).toBe(false);
    // The consent bit is EXPLICIT — an absent bit is malformed, never a
    // defaulted true (the claim row's structural default stays OFF).
    expect(UsernameClaimRequest.safeParse({ username: 'alice' }).success).toBe(false);
    // .strict(): no rider fields, and no discriminant ever.
    expect(
      UsernameClaimRequest.safeParse({ username: 'alice', discoverable: true, class: 'phone' })
        .success,
    ).toBe(false);
    expect(
      UsernameClaimRequest.safeParse({ username: 'alice', discoverable: true, email: 'a@b.co' })
        .success,
    ).toBe(false);
    expect(UsernameClaimRequest.safeParse({ username: '_bad', discoverable: true }).success).toBe(
      false,
    );
  });

  it('UsernameUnlinkRequest is the pinned EMPTY body — the route is the whole statement (the email/phone unlink posture), .strict()', () => {
    expect(UsernameUnlinkRequest.parse({})).toEqual({});
    expect(UsernameUnlinkRequest.safeParse({ username: 'alice' }).success).toBe(false);
    expect(UsernameUnlinkRequest.safeParse({ discoverable: false }).success).toBe(false);
  });
});

describe('the taken-409 shape (§4.5 carve-out: the ONE distinguishable identifier-keyed answer, one frozen bit)', () => {
  it('status 409, body exactly {"error":"taken"} — deliberately NOT the accountsRefusal bytes', () => {
    expect(USERNAME_TAKEN_STATUS).toBe(409);
    expect(USERNAME_TAKEN_BODY).toBe('{"error":"taken"}');
    // The frozen bytes parse under the schema, and the schema admits ONLY
    // them: reserved names, skeleton conflicts, and live tombstones all
    // answer these same bytes, so the one distinguishable answer stays one
    // bit — any extra field would widen it.
    const parsed = UsernameTakenResponse.parse(JSON.parse(USERNAME_TAKEN_BODY));
    expect(JSON.stringify(parsed)).toBe(USERNAME_TAKEN_BODY);
    expect(UsernameTakenResponse.safeParse({ error: 'taken', detail: 'x' }).success).toBe(false);
    expect(UsernameTakenResponse.safeParse({ error: 'reserved' }).success).toBe(false);
  });
});

describe('the lifecycle pins (30d/30d, RELEASE values asserted as themselves)', () => {
  it('tombstone TTL and rename cool-down are both 30 days, and equal by design', () => {
    // Both pins are 30d/30d by design. Loosening either is a plan
    // amendment: the tombstone bounds how fast a freed name recycles, the
    // cool-down bounds how fast one account churns the namespace.
    expect(USERNAME_TOMBSTONE_TTL_SECONDS).toBe(30 * 86400);
    expect(USERNAME_RENAME_COOLDOWN_SECONDS).toBe(30 * 86400);
    expect(USERNAME_RENAME_COOLDOWN_SECONDS).toBe(USERNAME_TOMBSTONE_TTL_SECONDS);
  });
});

describe('recovery exclusion (§4.8 — PINNED FOREVER)', () => {
  // PINNED FOREVER: a handle possesses nothing.
  // RecoveryCodeRequest and RecoveryVerifyRequest NEVER gain a `username`
  // field — their .strict() makes the key malformed today, and this test
  // exists so it stays malformed. If a future change makes either parse
  // succeed, that change reopened a deliberately refused surface (username as a
  // recovery channel) and must be reverted, not accommodated.
  it('RecoveryCodeRequest .strict() REFUSES a username key, alone or beside a real identifier', () => {
    expect(RecoveryCodeRequest.safeParse({ username: 'alice' }).success).toBe(false);
    expect(
      RecoveryCodeRequest.safeParse({ email: 'a@b.co', username: 'alice' }).success,
    ).toBe(false);
    expect(
      RecoveryCodeRequest.safeParse({ phone: '+15558675309', username: 'alice' }).success,
    ).toBe(false);
    // The wire it guards still works: the landed shapes parse unchanged.
    expect(RecoveryCodeRequest.safeParse({ email: 'a@b.co' }).success).toBe(true);
  });

  it('RecoveryVerifyRequest .strict() REFUSES a username key, alone or beside a real identifier', () => {
    const base = { code: '123456', class: 'phone' };
    expect(RecoveryVerifyRequest.safeParse({ ...base, username: 'alice' }).success).toBe(false);
    expect(
      RecoveryVerifyRequest.safeParse({ ...base, email: 'a@b.co', username: 'alice' }).success,
    ).toBe(false);
    expect(
      RecoveryVerifyRequest.safeParse({ ...base, phone: '+15558675309', username: 'alice' })
        .success,
    ).toBe(false);
    expect(RecoveryVerifyRequest.safeParse({ ...base, email: 'a@b.co' }).success).toBe(true);
  });
});

describe('DiscoveryLookupRequest: the THIRD parallel field (server-first; one-of-three)', () => {
  it('{username} parses alone — normalized on the way through the claim key, never repaired at the wire — and the landed {email}/{phone} wires parse to the IDENTICAL objects (no username key materializes)', () => {
    expect(DiscoveryLookupRequest.parse({ username: 'alice' })).toEqual({ username: 'alice' });
    // The wire carries the RAW spelling (the normalizer runs in the handler
    // before hashing); what must hold here is that it normalizes INTO the
    // strict charset — the phone posture.
    expect(DiscoveryLookupRequest.parse({ username: '  Alice_7 ' })).toEqual({
      username: '  Alice_7 ',
    });
    const email = DiscoveryLookupRequest.parse({ email: 'a@b.co' });
    expect(email).toEqual({ email: 'a@b.co' });
    expect('username' in email).toBe(false);
    const phone = DiscoveryLookupRequest.parse({ phone: '+15558675309' });
    expect(phone).toEqual({ phone: '+15558675309' });
    expect('username' in phone).toBe(false);
  });

  it('two or three populated fields, none, a batch shape, and a name outside USERNAME_STRICT are all MALFORMED (.strict() + exactly-one-of-three)', () => {
    for (const bad of [
      { email: 'a@b.co', username: 'alice' },
      { phone: '+15558675309', username: 'alice' },
      { email: 'a@b.co', phone: '+15558675309', username: 'alice' },
      {},
      { username: 'alice', usernames: ['alice'] },
      { username: 'ab' }, // too short
      { username: '_alice' }, // must start with a letter
      { username: 'al ice' }, // inner whitespace never repaired
      { username: 'alice@example.com' }, // an email is not a username
      { username: '+15558675309' }, // nor is a phone
      { username: 'ålice' }, // non-ASCII outside the fold
    ]) {
      expect(DiscoveryLookupRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('AccountsNotice usernameRevoked (the union member, reasonless on the wire)', () => {
  it('the member parses from kind alone and carries NOTHING else — no reason, no groupId, no holder', () => {
    const parsed = AccountsNotice.parse({ kind: 'usernameRevoked' });
    expect(parsed).toEqual({ kind: 'usernameRevoked' });
    expect(Object.keys(parsed)).toEqual(['kind']);
  });

  it('a reason riding the wire is STRIPPED, never surfaced — the reason class is recorded operator-side only', () => {
    const parsed = AccountsNotice.parse({ kind: 'usernameRevoked', reason: 'impersonation' });
    expect(parsed).toEqual({ kind: 'usernameRevoked' });
    expect('reason' in parsed).toBe(false);
  });

  it('the kind is in the derived known set beside every landed kind', () => {
    expect([...ACCOUNTS_NOTICE_KINDS].sort()).toEqual(
      [
        'linkOffer',
        'memberLinked',
        'memberUnlinked',
        'memberRevoked',
        'recoveryRequested',
        'recoveryCompleted',
        'recoveryCancelled',
        'usernameRevoked',
      ].sort(),
    );
  });
});

describe('parseAccountsNoticeTolerant (the tolerant-unknown-kind fallback)', () => {
  it('a known kind parses to the notice', () => {
    expect(parseAccountsNoticeTolerant({ kind: 'usernameRevoked' })).toEqual({
      outcome: 'notice',
      notice: { kind: 'usernameRevoked' },
    });
    expect(parseAccountsNoticeTolerant({ kind: 'recoveryCancelled', groupId: '01HQGGGG0000000000000000G0' })).toEqual({
      outcome: 'notice',
      notice: { kind: 'recoveryCancelled', groupId: '01HQGGGG0000000000000000G0' },
    });
  });

  it('a well-formed notice of a FUTURE kind is `unknown` — tolerated, its kind reported, never a parse failure', () => {
    expect(parseAccountsNoticeTolerant({ kind: 'somethingFromNextYear', groupId: 'x', extra: 1 })).toEqual({
      outcome: 'unknown',
      kind: 'somethingFromNextYear',
    });
  });

  it('a KNOWN kind with a malformed body stays `malformed` — a broken frame is not a future one', () => {
    // recoveryRequested without its horizon: known kind, bad body.
    expect(parseAccountsNoticeTolerant({ kind: 'recoveryRequested', groupId: '01HQGGGG0000000000000000G0' })).toEqual({
      outcome: 'malformed',
    });
  });

  it('no kind, an empty kind, a non-string kind, or a non-object are all `malformed`', () => {
    for (const bad of [{}, { kind: '' }, { kind: 7 }, null, 'usernameRevoked', 42, []]) {
      expect(parseAccountsNoticeTolerant(bad), JSON.stringify(bad)).toEqual({ outcome: 'malformed' });
    }
  });
});
