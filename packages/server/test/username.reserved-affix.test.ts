import { describe, expect, it } from 'vitest';
import {
  RESERVED_USERNAMES,
  RESERVED_USERNAME_AFFIXES,
  hasReservedUsernameAffix,
  normalizeUsernameIdentifier,
} from '@tacendum/shared';

/**
 * The compiled-in denylist was exact / skeleton only, so `tacendum_support`,
 * `mirana_official`, `admin_alice` and `security_team` were all claimable. The
 * affix rule refuses an operator or brand word as the FIRST or LAST
 * `_`-separated segment of a name — exact, or through the same confusable
 * skeleton the denylist uses — and nothing else: it is a small, pinned list,
 * not a substring ban. */
describe('reserved-username affix rule', () => {
  it('is a small pinned subset of the denylist', () => {
    expect([...RESERVED_USERNAME_AFFIXES]).toEqual([
      'tacendum',
      'mirana',
      'admin',
      'support',
      'security',
      'official',
      'staff',
      'team',
    ]);
    for (const affix of RESERVED_USERNAME_AFFIXES) {
      expect(RESERVED_USERNAMES as readonly string[]).toContain(affix);
    }
  });

  it('refuses an operator/brand word as the first or last segment', () => {
    for (const name of [
      'tacendum_support',
      'mirana_official',
      'admin_alice',
      'security_team',
      'alice_admin',
      'x_staff',
      'team_9',
      'staff__alice',
      'official_alice_x',
    ]) {
      expect(hasReservedUsernameAffix(normalizeUsernameIdentifier(name)), name).toBe(true);
    }
  });

  it('refuses through the confusable skeleton, segment by segment', () => {
    for (const name of ['adm1n_bob', 'rnirana_help', 'bob_tacendurn', 'securlty_ops', '5taff_a']) {
      expect(hasReservedUsernameAffix(name), name).toBe(true);
    }
  });

  it('allows ordinary names, names that merely contain an affix, and inner segments', () => {
    for (const name of ['alice_smith', 'teamster', 'adminsky', 'alice_team_x', 'tacendumfan', 'alice', 'support']) {
      expect(hasReservedUsernameAffix(name), name).toBe(false);
    }
  });
});
