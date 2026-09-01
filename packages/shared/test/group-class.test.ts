/**
 * The roster-write member class (the consent
 * bootstrap fix). A runtime test proved the Sharing surface UNREACHABLE for
 * every app-only second human: the agent's frames are (correctly) refused
 * pre-consent, and the surface only appeared after hearing an AI-marked
 * message — a closed loop. The fix: the OWNER's roster write carries what the
 * owner's own records already know — `class: 'integration'` — so the
 * stranger's device learns an agent is present at the natural authority point,
 * BEFORE the agent ever speaks.
 *
 * The three laws these tests hold down:
 *   1. RAISE-ONLY INFORMATIONAL — class NEVER admits anyone and never moves a
 *      verdict; membership stays exactly §6.2's three rules.
 *   2. OWNER-AUTHORITATIVE — the fold surfaces class from the AUTHORITY lane
 *      alone; a class on a non-authoritative writer's slot is ignored.
 *   3. COMPAT-FREE — the field rides known kinds in strip-mode parsers (the
 *      additive-field compat precedent): an old build parses a class-carrying write
 *      with the field silently dropped, and a malformed class collapses to
 *      absent rather than costing the message (§5.5).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GROUP_MAX_MEMBERS,
  GroupNewWrite,
  RosterSlot,
  applyGroupNew,
  applyRosterWrite,
  foldRoster,
  ownerOnlyPolicy,
  verdictFor,
  type GroupSlotStore,
  type SettingsSlot,
} from '../src/group-fold.js';
import {
  GroupNewEnvelope,
  GroupRosterEnvelope,
} from '../src/group-envelope.js';

const OWNER = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const HUMAN = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const AGENT = '01CCCCCCCCCCCCCCCCCCCCCCCC';

class MemoryStore implements GroupSlotStore {
  private owner: string | undefined;
  private slots = new Map<string, RosterSlot>();
  private settings = new Map<string, SettingsSlot>();
  private present = false;
  getOwner() {
    return this.owner;
  }
  setOwner(ownerId: string) {
    this.owner = ownerId;
  }
  getSlot(memberId: string, writerId: string) {
    return this.slots.get(`${memberId}\0${writerId}`);
  }
  putSlot(slot: RosterSlot) {
    this.slots.set(`${slot.memberId}\0${slot.writerId}`, slot);
  }
  deleteSlot(memberId: string, writerId: string) {
    this.slots.delete(`${memberId}\0${writerId}`);
  }
  listSlots() {
    return [...this.slots.values()];
  }
  getSettingsSlot(writerId: string) {
    return this.settings.get(writerId);
  }
  putSettingsSlot(slot: SettingsSlot) {
    this.settings.set(slot.writerId, slot);
  }
  listSettingsSlots() {
    return [...this.settings.values()];
  }
  isPresent() {
    return this.present;
  }
  setPresent(present: boolean) {
    this.present = present;
  }
  clear() {
    this.owner = undefined;
    this.slots.clear();
    this.settings.clear();
    this.present = false;
  }
}

describe('the fold surfaces class from the OWNER’s authoritative slot alone', () => {
  it('preserves class through the fold when the owner’s winning slot carries it', () => {
    const fold = foldRoster(OWNER, [
      { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: OWNER, seq: 1, state: 'in', class: 'integration' },
      { memberId: HUMAN, writerId: OWNER, seq: 1, state: 'in' },
    ]);
    expect(fold.classes[AGENT]).toBe('integration');
    expect(fold.classes[HUMAN]).toBeUndefined();
    expect(fold.classes[OWNER]).toBeUndefined();
  });

  it('IGNORES a class on a non-authoritative writer’s slot — sovereign lanes carry no class', () => {
    // A member cannot class-mark themselves (or anyone): only the owner's
    // roster authority — the lane that admits — is the lane that classifies.
    const fold = foldRoster(OWNER, [
      { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: AGENT, seq: 5, state: 'in', class: 'integration' },
      { memberId: HUMAN, writerId: HUMAN, seq: 3, state: 'in', class: 'integration' },
    ]);
    expect(fold.classes[AGENT]).toBeUndefined();
    expect(fold.classes[HUMAN]).toBeUndefined();
  });

  it('class NEVER admits: a class-carrying slot moves no verdict', () => {
    // Raise-only informational. Same slots with and without class fold to the
    // same membership — delete the class field everywhere and the members
    // array is byte-identical.
    const withClass = foldRoster(OWNER, [
      { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: OWNER, seq: 2, state: 'out', class: 'integration' },
      { memberId: HUMAN, writerId: OWNER, seq: 1, state: 'in', class: 'integration' },
    ]);
    const without = foldRoster(OWNER, [
      { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: OWNER, seq: 2, state: 'out' },
      { memberId: HUMAN, writerId: OWNER, seq: 1, state: 'in' },
    ]);
    expect(withClass.members).toEqual(without.members);
    expect(verdictFor(withClass, AGENT)).toBe('out');
    // An OUT member's class is still readable off the authority slot (it is
    // informational), but it admits nothing.
    expect(withClass.members.includes(AGENT)).toBe(false);
  });

  it('the winner’s class is the stored class: a later owner write without it clears it', () => {
    // Content-only order governs (rosterBeats); class rides whichever write
    // wins. Absent = unknown, the safe default — never sticky.
    const fold = foldRoster(OWNER, [
      { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
      { memberId: AGENT, writerId: OWNER, seq: 1, state: 'in', class: 'integration' },
      { memberId: AGENT, writerId: OWNER, seq: 2, state: 'in' },
    ]);
    // With a real store only the winner is held; over raw history the fold
    // must read the WINNER's class, not any slot's.
    expect(fold.classes[AGENT]).toBeUndefined();
  });
});

describe('applyGroupNew stamps class on the seed slots the owner named as integrations', () => {
  it('a grp.new with integrations classes exactly those seed slots', () => {
    const store = new MemoryStore();
    applyGroupNew(store, HUMAN, {
      writerId: OWNER,
      members: [OWNER, HUMAN, AGENT],
      seq: 1,
      integrations: [AGENT],
    });
    expect(store.getSlot(AGENT, OWNER)?.class).toBe('integration');
    expect(store.getSlot(HUMAN, OWNER)?.class).toBeUndefined();
    expect(store.getSlot(OWNER, OWNER)?.class).toBeUndefined();
    const fold = foldRoster(OWNER, store.listSlots(), ownerOnlyPolicy);
    expect(fold.classes[AGENT]).toBe('integration');
    expect(fold.members).toEqual([OWNER, HUMAN, AGENT].sort());
  });

  it('an integrations id not in ms stamps nothing — the list classifies, it never invites', () => {
    const store = new MemoryStore();
    applyGroupNew(store, HUMAN, {
      writerId: OWNER,
      members: [OWNER, HUMAN],
      seq: 1,
      integrations: [AGENT],
    });
    expect(store.getSlot(AGENT, OWNER)).toBeUndefined();
    const fold = foldRoster(OWNER, store.listSlots(), ownerOnlyPolicy);
    expect(verdictFor(fold, AGENT)).toBe('out');
    expect(fold.classes[AGENT]).toBeUndefined();
  });

  it('GroupNewWrite bounds integrations like members — a peer array that will be iterated', () => {
    const many = Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) =>
      `01${String(i).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAA`.slice(0, 26),
    );
    expect(
      GroupNewWrite.safeParse({ writerId: OWNER, members: [OWNER], seq: 1, integrations: many })
        .success,
    ).toBe(false);
    expect(
      GroupNewWrite.safeParse({ writerId: OWNER, members: [OWNER], seq: 1, integrations: [AGENT] })
        .success,
    ).toBe(true);
  });
});

describe('applyRosterWrite stores the class the write carries — verbatim, judged by the fold', () => {
  it('an owner add carrying class lands classed; the fold reads it', () => {
    const store = new MemoryStore();
    applyGroupNew(store, HUMAN, { writerId: OWNER, members: [OWNER, HUMAN], seq: 1 });
    const applied = applyRosterWrite(store, HUMAN, {
      memberId: AGENT,
      writerId: OWNER,
      seq: 2,
      state: 'in',
      class: 'integration',
    });
    expect(applied.outcome).toBe('applied');
    const fold = foldRoster(OWNER, store.listSlots(), ownerOnlyPolicy);
    expect(fold.classes[AGENT]).toBe('integration');
  });

  it('a NON-owner write carrying class stores its slot but the fold surfaces no class', () => {
    const store = new MemoryStore();
    applyGroupNew(store, HUMAN, { writerId: OWNER, members: [OWNER, HUMAN, AGENT], seq: 1 });
    // AGENT's own sovereign write, self-classed: sovereignty stands (rule 1),
    // the class does not (law 2).
    const applied = applyRosterWrite(store, HUMAN, {
      memberId: AGENT,
      writerId: AGENT,
      seq: 1,
      state: 'in',
      class: 'integration',
    });
    expect(applied.outcome).toBe('applied');
    const fold = foldRoster(OWNER, store.listSlots(), ownerOnlyPolicy);
    expect(fold.classes[AGENT]).toBeUndefined();
  });
});

describe('the wire: grp.roster `c` and grp.new `ic` — optional, malformed collapses (§5.5)', () => {
  it('grp.roster parses with c and keeps it', () => {
    const parsed = GroupRosterEnvelope.parse({
      tcm: 'grp.roster',
      g: OWNER,
      m: AGENT,
      s: 'in',
      n: 2,
      c: 'integration',
    });
    expect(parsed.c).toBe('integration');
  });

  it('a malformed c collapses to absent — the class costs itself, never the message', () => {
    for (const c of ['human', true, 42, {}, ['integration']]) {
      const parsed = GroupRosterEnvelope.safeParse({
        tcm: 'grp.roster',
        g: OWNER,
        m: AGENT,
        s: 'in',
        n: 2,
        c,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data.c : 'kept').toBeUndefined();
    }
  });

  it('grp.new parses with ic and keeps it; malformed ic collapses whole', () => {
    const parsed = GroupNewEnvelope.parse({
      tcm: 'grp.new',
      g: OWNER,
      nm: 'Kitchen',
      ms: [OWNER, HUMAN, AGENT],
      n: 1,
      ic: [AGENT],
    });
    expect(parsed.ic).toEqual([AGENT]);
    for (const ic of ['integration', [AGENT, 'nope'], 42, {}]) {
      const bad = GroupNewEnvelope.safeParse({
        tcm: 'grp.new',
        g: OWNER,
        nm: 'Kitchen',
        ms: [OWNER, HUMAN],
        n: 1,
        ic,
      });
      expect(bad.success).toBe(true);
      expect(bad.success ? bad.data.ic : 'kept').toBeUndefined();
    }
  });

  it('ic is bounded at GROUP_MAX_MEMBERS — over-long collapses rather than refusing', () => {
    const many = Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) =>
      `01${String(i).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAA`.slice(0, 26),
    );
    const parsed = GroupNewEnvelope.safeParse({
      tcm: 'grp.new',
      g: OWNER,
      nm: 'Kitchen',
      ms: [OWNER, HUMAN],
      n: 1,
      ic: many,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.ic : 'kept').toBeUndefined();
  });
});

describe('THE COMPAT PIN: an old-build strip-mode parser accepts a class-carrying write', () => {
  // These schemas are the PRE-CLASS shapes verbatim (group-envelope.ts as
  // shipped through build 14) — a stand-in for every parser in the field.
  // Plain zod objects run in STRIP mode, so the new fields vanish silently and
  // the write applies exactly as an unclassed one. If either shared schema
  // ever turns `.strict()`, the mirror pins in the shipped suites go loud —
  // this one proves the OLD side of the compat contract.
  const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  const OldRoster = z.object({
    tcm: z.literal('grp.roster'),
    g: Ulid,
    m: Ulid,
    s: z.enum(['in', 'out']),
    n: z.number().int().min(1),
  });
  const OldNew = z.object({
    tcm: z.literal('grp.new'),
    g: Ulid,
    nm: z.string().min(1).max(80),
    ms: z.array(Ulid).min(1).max(GROUP_MAX_MEMBERS),
    n: z.number().int().min(1),
  });

  it('a class-carrying grp.roster parses on the old build with c dropped', () => {
    const wire = JSON.stringify({
      tcm: 'grp.roster',
      g: OWNER,
      m: AGENT,
      s: 'in',
      n: 2,
      c: 'integration',
    });
    const parsed = OldRoster.safeParse(JSON.parse(wire));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? 'c' in parsed.data : true).toBe(false);
  });

  it('an ic-carrying grp.new parses on the old build with ic dropped', () => {
    const wire = JSON.stringify({
      tcm: 'grp.new',
      g: OWNER,
      nm: 'Kitchen',
      ms: [OWNER, HUMAN, AGENT],
      n: 1,
      ic: [AGENT],
    });
    const parsed = OldNew.safeParse(JSON.parse(wire));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? 'ic' in parsed.data : true).toBe(false);
  });

  it('a hand-mangled stored slot with a garbage class still parses — the slot survives, the class does not', () => {
    // The CLI room file is hand-editable JSON parsed through RosterSlot;
    // a corrupt class must cost the nicety, never the slot (rooms.ts's
    // permissive-at-the-slot-level policy applies INSIDE the slot too).
    const parsed = RosterSlot.safeParse({
      memberId: AGENT,
      writerId: OWNER,
      seq: 3,
      state: 'in',
      class: 'robot',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.class : 'kept').toBeUndefined();
  });
});
