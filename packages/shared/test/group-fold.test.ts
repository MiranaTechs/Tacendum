import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_MEMBERS,
  GROUP_OWNER_LANE_CAP,
  GroupDelWrite,
  GroupNewWrite,
  RosterSlot,
  SettingsSlot,
  applyGroupDel,
  applyGroupNew,
  applyRosterWrite,
  applySettingsWrite,
  effectiveDisappearSec,
  foldRoster,
  localDeleteRoom,
  noteRoomTraffic,
  ownerOnlyPolicy,
  rosterBeats,
  rosterDigest,
  rosterDigestPreimage,
  settingsBeats,
  unconditionalPolicy,
  verdictFor,
  type GroupApplyPolicy,
  type GroupFold,
  type GroupSlotStore,
  type RosterState,
} from '../src/group-fold.js';

/**
 * Every adversarial fold case as a named test,
 * each proven by mutation to fail with its rule removed, plus
 * the order-independence property THROUGH the slot store with its cap active
 * and grp.del in the shuffled mix. The scenarios and their expectations are a
 * port of an executable reference model of the fold (33 named cases) —
 * where a test here disagrees with that model, the written design governs
 * and the disagreement is a finding, not a fix.
 *
 * The deleted machinery — epoch re-entry, cross-writer remove-wins, transfer
 * counting, the seal, the closing snapshot, either freeze predicate,
 * pending-before-its-transfer — must NOT appear in this suite: a test
 * asserting deleted semantics is how they come back.
 */

// --- the injected hash (node:crypto here; CryptoKit on the phone) -----------

const sha256 = (preimage: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(preimage).digest());

// --- a reference in-memory slot store ---------------------------------------

/**
 * The storage contract, smallest possible: winner per (memberId, writerId),
 * the anchor, presence, and the settings winners. The SQLite and file-backed
 * implementations must behave exactly like this.
 */
class MemoryStore implements GroupSlotStore {
  private owner: string | undefined;
  private slots = new Map<string, RosterSlot>();
  private settings = new Map<string, SettingsSlot>();
  private present = false;

  getOwner(): string | undefined {
    return this.owner;
  }
  setOwner(ownerId: string): void {
    this.owner = ownerId;
  }
  getSlot(memberId: string, writerId: string): RosterSlot | undefined {
    return this.slots.get(`${memberId}\u0000${writerId}`);
  }
  putSlot(slot: RosterSlot): void {
    this.slots.set(`${slot.memberId}\u0000${slot.writerId}`, slot);
  }
  deleteSlot(memberId: string, writerId: string): void {
    this.slots.delete(`${memberId}\u0000${writerId}`);
  }
  listSlots(): readonly RosterSlot[] {
    return [...this.slots.values()];
  }
  getSettingsSlot(writerId: string): SettingsSlot | undefined {
    return this.settings.get(writerId);
  }
  putSettingsSlot(slot: SettingsSlot): void {
    this.settings.set(slot.writerId, slot);
  }
  listSettingsSlots(): readonly SettingsSlot[] {
    return [...this.settings.values()];
  }
  isPresent(): boolean {
    return this.present;
  }
  setPresent(present: boolean): void {
    this.present = present;
  }
  clear(): void {
    this.owner = undefined;
    this.slots.clear();
    this.settings.clear();
    this.present = false;
  }
}

// --- one phone, driven by wire-shaped events --------------------------------

type Ev =
  | { t: 'new'; w: string; ms: string[]; seq: number }
  | { t: 'roster'; w: string; m: string; s: RosterState; seq: number }
  | { t: 'del'; w: string; seq: number }
  | { t: 'set'; w: string; sec: number; seq: number }
  | { t: 'msg'; w: string; seq: number }
  | { t: 'localdel' };

class Phone {
  readonly store = new MemoryStore();
  declined = 0;
  evicted: RosterSlot[] = [];

  constructor(
    readonly me: string,
    /** The ROSTER policy; production default when omitted. */
    readonly policy?: GroupApplyPolicy,
  ) {}

  apply(e: Ev): void {
    switch (e.t) {
      case 'new': {
        const r = applyGroupNew(
          this.store,
          this.me,
          { writerId: e.w, members: e.ms, seq: e.seq },
          this.policy,
        );
        if (r.outcome !== 'ignored') this.evicted.push(...r.evicted);
        return;
      }
      case 'roster': {
        const r = applyRosterWrite(
          this.store,
          this.me,
          { writerId: e.w, memberId: e.m, state: e.s, seq: e.seq },
          this.policy,
        );
        if (r.outcome === 'declined') this.declined += 1;
        if (r.outcome === 'applied') this.evicted.push(...r.evicted);
        return;
      }
      case 'del': {
        if (applyGroupDel(this.store, { writerId: e.w, seq: e.seq }) === 'declined') {
          this.declined += 1;
        }
        return;
      }
      case 'set': {
        applySettingsWrite(this.store, { writerId: e.w, seq: e.seq, disappearSec: e.sec });
        return;
      }
      case 'msg': {
        noteRoomTraffic(this.store, this.me, this.policy);
        return;
      }
      case 'localdel': {
        localDeleteRoom(this.store);
        return;
      }
    }
  }

  fold(): GroupFold {
    const owner = this.store.getOwner();
    if (owner === undefined) throw new Error('no room on this phone');
    return foldRoster(owner, this.store.listSlots(), this.policy);
  }

  /**
   * Everything required to converge, in one comparable string: the
   * verdicts, the owner, the rd digest, room presence — and, stronger than
   * §11.2 asks, the stored rows themselves, because winner-per-lane under a
   * content-only order makes the STORE convergent too, not just the fold.
   */
  state(): string {
    const owner = this.store.getOwner();
    if (owner === undefined) return 'ABSENT';
    const f = this.fold();
    return JSON.stringify({
      present: this.store.isPresent(),
      owner,
      members: f.members,
      rd: rosterDigest(owner, f.members, sha256),
      verdicts: Object.keys(f.verdicts)
        .sort()
        .map(id => `${id}=${f.verdicts[id]}`)
        .join(','),
      rows: this.store
        .listSlots()
        .map(s => `${s.memberId}/${s.writerId}/${s.seq}/${s.state}`)
        .sort()
        .join('|'),
      sets: this.store
        .listSettingsSlots()
        .map(s => `${s.writerId}/${s.seq}/${s.disappearSec}`)
        .sort()
        .join('|'),
      timer: effectiveDisappearSec(this.store.listSettingsSlots(), f),
    });
  }
}

// --- deterministic shuffling (a failure must be reproducible) ---------------

/** mulberry32: tiny, seeded, good enough to shuffle. Math.random is banned
 * here because a property failure under it can never be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

// --- scenario helpers -------------------------------------------------------

const A = 'ANA';
const B = 'BEN';
const C = 'CARA';
const D = 'DAVE';
const Z = 'ZED';
const M = 'MALLORY';

const anchor: Ev = { t: 'new', w: A, ms: [A, B, C], seq: 1 };

function run(me: string, events: readonly Ev[], policy?: GroupApplyPolicy): Phone {
  const p = new Phone(me, policy);
  for (const e of events) p.apply(e);
  return p;
}

/**
 * Runs `writes` after the anchor under EVERY arrival permutation (seeded
 * shuffles once the factorial explodes), asserts all orders land on the same
 * state, and returns the canonical phone for further assertions. Local acts
 * (localdel) are ordered by the phone that performs them and must not go
 * through here.
 *
 * Pass `anchor: []` and put the `grp.new` in `writes` to permute the anchor
 * itself — §6.5's pre-anchor cases. The default prefix exists for cases
 * about POST-anchor behaviour; it must never be mistaken for an ordering
 * guarantee the transport does not give (that mistake is how the pre-anchor
 * drop hid from 52 tests).
 */
function converged(
  me: string,
  writes: readonly Ev[],
  opts: { anchor?: readonly Ev[]; policy?: GroupApplyPolicy } = {},
): Phone {
  const pre = opts.anchor ?? [anchor];
  const orders =
    writes.length <= 6
      ? permutations(writes)
      : (() => {
          const rnd = mulberry32(0x7ac3);
          return [
            [...writes],
            ...Array.from({ length: 60 }, () => shuffled(writes, rnd)),
          ];
        })();
  const states = orders.map(order => run(me, [...pre, ...order], opts.policy).state());
  for (const s of states) expect(s).toBe(states[0]!);
  return run(me, [...pre, ...writes], opts.policy);
}

function expectVerdicts(p: Phone, want: Record<string, RosterState>): void {
  const f = p.fold();
  for (const [id, state] of Object.entries(want)) {
    expect(verdictFor(f, id), `verdict for ${id}`).toBe(state);
  }
}

// ============================================================================

describe('the content-only total order (§6.2 rule 1)', () => {
  it('orders by seq first, then out beats in at a same-seq tie', () => {
    expect(rosterBeats({ seq: 3, state: 'in' }, { seq: 2, state: 'out' })).toBe(true);
    expect(rosterBeats({ seq: 2, state: 'out' }, { seq: 3, state: 'in' })).toBe(false);
    expect(rosterBeats({ seq: 2, state: 'out' }, { seq: 2, state: 'in' })).toBe(true);
    expect(rosterBeats({ seq: 2, state: 'in' }, { seq: 2, state: 'out' })).toBe(false);
    // never reflexive: a copy of the winner does not beat the winner
    expect(rosterBeats({ seq: 2, state: 'out' }, { seq: 2, state: 'out' })).toBe(false);
  });
});

describe('the fold — two lanes, three rules (§6.2, §11.2)', () => {
  it('owner removes a member: out on every phone', () => {
    for (const me of [A, B, C]) {
      const p = converged(me, [{ t: 'roster', w: A, m: B, s: 'out', seq: 2 }]);
      expectVerdicts(p, { [A]: 'in', [B]: 'out', [C]: 'in' });
      expect(p.fold().ownerId).toBe(A);
    }
  });

  it('member leaves (self out): out on every phone — the self lane is never gated', () => {
    for (const me of [A, B, C]) {
      const p = converged(me, [{ t: 'roster', w: B, m: B, s: 'out', seq: 1 }]);
      expectVerdicts(p, { [B]: 'out', [A]: 'in', [C]: 'in' });
    }
  });

  it("owner re-adds a member who LEFT: an invitation — zero roster effect anywhere, the owner's own phone included", () => {
    for (const me of [A, B, C]) {
      const p = converged(me, [
        { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
        { t: 'roster', w: A, m: B, s: 'in', seq: 2 },
      ]);
      expectVerdicts(p, { [B]: 'out' });
      // the invitation is an APPLIED authority write with no fold effect —
      // not a declined one; declining it would erase the "Rejoin?" row
      expect(p.declined).toBe(0);
    }
  });

  it('the departed member accepts (their own in): returns them everywhere, the pair required in either arrival order', () => {
    const p = converged(C, [
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
      { t: 'roster', w: A, m: B, s: 'in', seq: 2 },
      { t: 'roster', w: B, m: B, s: 'in', seq: 2 },
    ]);
    expectVerdicts(p, { [B]: 'in' });
  });

  it('a member un-leaves themselves: an accidental Leave is reversible because the grp.new claim still stands', () => {
    const p = converged(C, [
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
      { t: 'roster', w: B, m: B, s: 'in', seq: 2 },
    ]);
    expectVerdicts(p, { [B]: 'in' });
  });

  it('owner re-adds a member the OWNER removed: returns them (later seq, one lane)', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'out', seq: 2 },
      { t: 'roster', w: A, m: B, s: 'in', seq: 3 },
    ]);
    expectVerdicts(p, { [B]: 'in' });
  });

  it('a non-owner remove is declined, attributed, stores nothing and moves no fold', () => {
    const p = converged(A, [{ t: 'roster', w: C, m: B, s: 'out', seq: 1 }]);
    expectVerdicts(p, { [B]: 'in' });
    expect(p.declined).toBe(1);
    // stores NOTHING: the room holds exactly the anchor's three owner rows
    expect(p.store.listSlots()).toHaveLength(3);
    expect(p.store.getSlot(B, C)).toBeUndefined();
  });

  it('a non-owner add is declined and admits nobody', () => {
    const p = converged(A, [{ t: 'roster', w: C, m: Z, s: 'in', seq: 1 }]);
    expectVerdicts(p, { [Z]: 'out' });
    expect(p.declined).toBe(1);
    expect(p.store.getSlot(Z, C)).toBeUndefined();
  });

  it("a spoofed writerId lands in the sender's own lane and, from a non-owner, declines (rule 16)", () => {
    // The payload cannot claim someone else's slot: there is no writer field
    // on the wire — writerId IS frame.from. Mallory sending "Ben is out"
    // arrives as HER write about Ben, which is provably dead.
    const p = converged(B, [{ t: 'roster', w: M, m: B, s: 'out', seq: 9 }]);
    expectVerdicts(p, { [B]: 'in' });
    expect(p.declined).toBe(1);
    expect(p.store.getSlot(B, M)).toBeUndefined();
    expect(p.store.getSlot(B, B)).toBeUndefined();
  });

  it('a replayed older seq loses, in any arrival order', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'out', seq: 3 },
      { t: 'roster', w: A, m: B, s: 'in', seq: 2 },
    ]);
    expectVerdicts(p, { [B]: 'out' });
  });

  it('a hostile same-seq pair resolves out, in both arrival orders', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'in', seq: 4 },
      { t: 'roster', w: A, m: B, s: 'out', seq: 4 },
    ]);
    expectVerdicts(p, { [B]: 'out' });
  });

  it('a third party cannot un-leave someone (sovereignty absolute)', () => {
    const p = converged(C, [
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
      { t: 'roster', w: C, m: B, s: 'in', seq: 2 },
    ]);
    expectVerdicts(p, { [B]: 'out' });
    expect(p.declined).toBe(1);
  });

  it('the creator folds in on every device from the grp.new alone', () => {
    for (const me of [A, B, C]) {
      const p = converged(me, []);
      expectVerdicts(p, { [A]: 'in', [B]: 'in', [C]: 'in' });
      expect(p.fold().ownerId).toBe(A);
    }
  });

  it('a grp.new whose ms omits its own sender still folds the sender in (the clamp, §5.1/§5.5)', () => {
    const p = converged(D, [], { anchor: [{ t: 'new', w: A, ms: [D], seq: 1 }] });
    expectVerdicts(p, { [A]: 'in', [D]: 'in' });
    expect(p.fold().ownerId).toBe(A);
  });

  it("the owner's remove and the member's own leave converge out in both orders", () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'out', seq: 2 },
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
    ]);
    expectVerdicts(p, { [B]: 'out' });
  });

  it('an owner add of a member this phone has never messaged folds them in (slots are self-describing, §6.5)', () => {
    const p = converged(C, [{ t: 'roster', w: A, m: D, s: 'in', seq: 2 }]);
    expectVerdicts(p, { [D]: 'in' });
  });

  it('a lone self in admits nobody: membership without an owner claim is impossible (§6.2 rule 3)', () => {
    const p = converged(C, [{ t: 'roster', w: Z, m: Z, s: 'in', seq: 1 }]);
    expectVerdicts(p, { [Z]: 'out' });
    // it is a SELF write — counted, stored, not declined — it just admits nothing
    expect(p.declined).toBe(0);
    expect(p.store.getSlot(Z, Z)).toBeDefined();
  });
});

describe('owner departure needs no machinery', () => {
  it('owner leaves: out like anyone else, the room carries on, and the fold emits NO freeze verdict of any kind', () => {
    const p = converged(C, [{ t: 'roster', w: A, m: A, s: 'out', seq: 2 }]);
    expectVerdicts(p, { [A]: 'out', [B]: 'in', [C]: 'in' });
    // Assert the ABSENCE of deleted semantics: the fold's whole
    // output is these four fields, and a verdict is only ever in or out —
    // no 'frozen', no banner state, no new output for an absent owner.
    // 'classes' joined later (the roster-class addition) — a CONSCIOUS
    // pin update: it is raise-only informational and moves no verdict, which
    // the group-class suite holds down.
    const f = p.fold();
    expect(Object.keys(f).sort()).toEqual(['classes', 'members', 'ownerId', 'verdicts']);
    for (const v of Object.values(f.verdicts)) expect(['in', 'out']).toContain(v);
  });

  it('owner leaves, then writes: still counts, attributed (no seal — rejoin-equivalence, §6.2 rule 2)', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: A, s: 'out', seq: 2 },
      { t: 'roster', w: A, m: Z, s: 'in', seq: 3 },
    ]);
    expectVerdicts(p, { [A]: 'out', [Z]: 'in' });
    expect(p.declined).toBe(0);
  });

  it('owner leaves; a member can still leave', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: A, s: 'out', seq: 2 },
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
    ]);
    expectVerdicts(p, { [A]: 'out', [B]: 'out', [C]: 'in' });
  });

  it('owner rejoins unilaterally, then acts: their own in returns them exactly as it returns anyone', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: A, s: 'out', seq: 2 },
      { t: 'roster', w: A, m: A, s: 'in', seq: 3 },
      { t: 'roster', w: A, m: Z, s: 'in', seq: 4 },
    ]);
    expectVerdicts(p, { [A]: 'in', [Z]: 'in' });
  });

  it('owner vanishes (writes nothing): no rule fires — non-owner writes decline, self writes count, nothing else changes', () => {
    const p = converged(C, [
      { t: 'roster', w: C, m: Z, s: 'in', seq: 1 },
      { t: 'roster', w: B, m: B, s: 'out', seq: 1 },
    ]);
    expectVerdicts(p, { [Z]: 'out', [B]: 'out', [A]: 'in', [C]: 'in' });
    expect(p.declined).toBe(1);
  });
});

describe('delete for everyone — grp.del (§6.4)', () => {
  it('owner deletes: the room ends absent under every arrival permutation, racing a message and a roster write', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'out', seq: 2 },
      { t: 'msg', w: B, seq: 1 },
      { t: 'del', w: A, seq: 3 },
    ]);
    expect(p.state()).toBe('ABSENT');
    expect(p.store.listSlots()).toHaveLength(0);
    expect(p.store.listSettingsSlots()).toHaveLength(0);
    expect(p.store.isPresent()).toBe(false);
  });

  it('a non-owner grp.del is declined, attributed, and changes nothing', () => {
    const p = converged(A, [{ t: 'del', w: C, seq: 1 }]);
    expect(p.store.isPresent()).toBe(true);
    expectVerdicts(p, { [A]: 'in', [B]: 'in', [C]: 'in' });
    expect(p.declined).toBe(1);
  });

  it("a grp.del racing the member's own leave: that phone ends without the room, in both orders", () => {
    const p = converged(C, [
      { t: 'roster', w: C, m: C, s: 'out', seq: 1 },
      { t: 'del', w: A, seq: 2 },
    ]);
    expect(p.state()).toBe('ABSENT');
  });

  it('an owner who left can still delete: the purge is not gated on their membership (a gate would be order-dependent)', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: A, s: 'out', seq: 2 },
      { t: 'del', w: A, seq: 3 },
    ]);
    expect(p.state()).toBe('ABSENT');
  });

  it('a grp.del for a room this phone never had is a no-op: nothing stored, no tombstone, not even a declined row', () => {
    const p = run(C, [{ t: 'del', w: A, seq: 1 }]);
    expect(p.state()).toBe('ABSENT');
    expect(p.store.listSlots()).toHaveLength(0);
    // quiet discard, NOT a declined row: with no anchor there is no owner to
    // attribute against, and no room for the row to render into
    expect(p.declined).toBe(0);
  });

  it('a delete racing an add of an existing member: absent in both orders', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: D, s: 'in', seq: 2 },
      { t: 'del', w: A, seq: 3 },
    ]);
    expect(p.state()).toBe('ABSENT');
  });

  it('a grp.del racing the grp.new of a brand-new member: THE one documented order-dependent edge (§6.4), asserted per order', () => {
    const invite: Ev = { t: 'new', w: A, ms: [A, B, Z], seq: 1 };
    const del: Ev = { t: 'del', w: A, seq: 2 };
    // new-then-del: the invitation existed, the delete purges it — absent.
    expect(run(Z, [invite, del]).state()).toBe('ABSENT');
    // del-then-new: the delete found no room (no tombstone, deliberately),
    // so the late invitation lands as a stillborn room on this one phone.
    // Everyone else has purged; it dies of silence until deleted by hand.
    const stillborn = run(Z, [del, invite]);
    expect(stillborn.store.getOwner()).toBe(A);
    expect(stillborn.store.isPresent()).toBe(true);
    expectVerdicts(stillborn, { [Z]: 'in' });
  });
});

describe('delete — local (deleteChat precedent, §6.4)', () => {
  // Local acts are ordered by the phone that performs them, so these run in
  // sequence rather than under permutation — an act outcome, not convergence.

  it('local delete, then new traffic: the room returns with the roster current', () => {
    const p = run(C, [anchor, { t: 'localdel' }, { t: 'msg', w: B, seq: 1 }]);
    expect(p.store.isPresent()).toBe(true);
    expectVerdicts(p, { [C]: 'in' });
  });

  it('traffic, then local delete: hidden from view but not absent — the anchor and slots survive the content', () => {
    const p = run(C, [anchor, { t: 'msg', w: B, seq: 1 }, { t: 'localdel' }]);
    expect(p.store.isPresent()).toBe(false);
    expect(p.store.getOwner()).toBe(A);
    expect(p.store.listSlots().length).toBeGreaterThan(0);
  });

  it('leave, then local delete, then a straggler message: stays gone — their own out folds them out', () => {
    const p = run(C, [
      anchor,
      { t: 'roster', w: C, m: C, s: 'out', seq: 1 },
      { t: 'localdel' },
      { t: 'msg', w: B, seq: 2 },
    ]);
    expect(p.store.isPresent()).toBe(false);
    expectVerdicts(p, { [C]: 'out' });
  });

  it('roster writes keep applying while the room is hidden, and counted traffic recreates it with that roster', () => {
    const p = run(C, [
      anchor,
      { t: 'localdel' },
      { t: 'roster', w: A, m: B, s: 'out', seq: 2 },
      { t: 'msg', w: B, seq: 3 },
    ]);
    expect(p.store.isPresent()).toBe(true);
    expectVerdicts(p, { [B]: 'out', [C]: 'in' });
  });

  it("the owner's own local delete is local only: the next message brings the room back", () => {
    const p = run(A, [anchor, { t: 'localdel' }, { t: 'msg', w: B, seq: 1 }]);
    expect(p.store.isPresent()).toBe(true);
  });
});

describe('the owner-lane cap (§6.4)', () => {
  it('a 300-member owner flood: capped at 64 keep-lowest, kept set identical across arrival orders, self rows exempt, evictions visible', () => {
    const flood: Ev[] = Array.from({ length: 300 }, (_, i) => ({
      t: 'roster',
      w: A,
      m: `V${String(i).padStart(3, '0')}`,
      s: 'in',
      seq: 10 + i,
    }));
    const leave: Ev = { t: 'roster', w: B, m: B, s: 'out', seq: 1 };
    const rnd = mulberry32(0xcafe);
    const keptSets = new Set<string>();
    for (let trial = 0; trial < 25; trial++) {
      const p = run(C, [anchor, ...shuffled([...flood, leave], rnd)]);
      const lane = p.store.listSlots().filter(s => s.writerId === A);
      expect(lane).toHaveLength(GROUP_OWNER_LANE_CAP);
      keptSets.add(
        lane
          .map(s => s.memberId)
          .sort()
          .join(','),
      );
      // the self row survives the flood: sovereignty is never storage-managed
      expectVerdicts(p, { [B]: 'out' });
      expect(p.store.getSlot(B, B)).toBeDefined();
      // every eviction surfaced as a visible row, never absorbed
      expect(p.evicted.length).toBeGreaterThan(0);
    }
    // content-keyed (keep-lowest memberId), so one kept set across all orders
    expect(keptSets.size).toBe(1);
    const expected = [A, B, C, ...Array.from({ length: 61 }, (_, i) => `V${String(i).padStart(3, '0')}`)]
      .sort()
      .join(',');
    expect([...keptSets][0]).toBe(expected);
  });

  it("the cap never evicts the owner's own sovereign row, even when it sorts highest", () => {
    // ZED owns a room and floods it with ids that sort BELOW 'ZED': keeping
    // the lowest 64 would evict the owner's own (ZED, ZED) row — which is
    // their grp.new claim AND their sovereign self row under §6.6's flat
    // key. Evicting it could fold the owner out of their own room.
    const flood: Ev[] = Array.from({ length: 100 }, (_, i) => ({
      t: 'roster',
      w: Z,
      m: `V${String(i).padStart(3, '0')}`,
      s: 'in',
      seq: 10 + i,
    }));
    const p = run(Z, [{ t: 'new', w: Z, ms: [Z], seq: 1 }, ...flood]);
    const lane = p.store.listSlots().filter(s => s.writerId === Z);
    expect(lane).toHaveLength(GROUP_OWNER_LANE_CAP);
    expect(p.store.getSlot(Z, Z)).toBeDefined();
    expectVerdicts(p, { [Z]: 'in' });
  });
});

describe('the apply policy seam (§6.3) — live, not ceremonial', () => {
  it('the same non-owner writes that decline under the owner rule take effect under the unconditional policy', () => {
    // The non-vacuity proof, as a permanent test: swap the policy
    // and the non-owner cases MUST flip. If this test ever passes with the
    // production policy hard-coded past the parameter, the seam died.
    const remove: Ev = { t: 'roster', w: C, m: B, s: 'out', seq: 1 };
    const add: Ev = { t: 'roster', w: C, m: Z, s: 'in', seq: 2 };

    const production = run(A, [anchor, remove, add]);
    expectVerdicts(production, { [B]: 'in', [Z]: 'out' });
    expect(production.declined).toBe(2);

    const unconditional = run(A, [anchor, remove, add], unconditionalPolicy);
    expectVerdicts(unconditional, { [B]: 'out', [Z]: 'in' });
    expect(unconditional.declined).toBe(0);
  });

  it("grp.set runs the unconditional default: any member's timer write counts (§10.3)", () => {
    const p = run(C, [anchor]);
    expect(
      applySettingsWrite(p.store, { writerId: B, seq: 1, disappearSec: 30 }),
    ).toBe('applied');
    expect(
      applySettingsWrite(p.store, { writerId: A, seq: 1, disappearSec: 300 }),
    ).toBe('applied');
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(30);
  });

  it('grp.set consults the SAME parameter: an owner-only policy declines a non-owner timer write', () => {
    const p = run(C, [anchor]);
    expect(
      applySettingsWrite(p.store, { writerId: B, seq: 1, disappearSec: 30 }, ownerOnlyPolicy),
    ).toBe('declined');
    expect(p.store.getSettingsSlot(B)).toBeUndefined();
    expect(
      applySettingsWrite(p.store, { writerId: A, seq: 1, disappearSec: 300 }, ownerOnlyPolicy),
    ).toBe('applied');
  });

  it("a removed member's timer slot stops counting, and counts again if they return (§10.3)", () => {
    const p = run(C, [anchor]);
    applySettingsWrite(p.store, { writerId: A, seq: 2, disappearSec: 300 });
    applySettingsWrite(p.store, { writerId: B, seq: 1, disappearSec: 30 });
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(30);
    // the departing griefer: removed, their 30-second pin comes off
    p.apply({ t: 'roster', w: A, m: B, s: 'out', seq: 3 });
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(300);
    // re-admitted (owner removed them, so the owner's later in returns them)
    p.apply({ t: 'roster', w: A, m: B, s: 'in', seq: 4 });
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(30);
  });

  it('a same-seq settings tie resolves to the lower value, in both arrival orders (§6.2 rule 1, §10.3)', () => {
    for (const order of [
      [30, 300],
      [300, 30],
    ]) {
      const p = run(C, [anchor]);
      for (const sec of order) {
        applySettingsWrite(p.store, { writerId: A, seq: 5, disappearSec: sec });
      }
      expect(p.store.getSettingsSlot(A)?.disappearSec).toBe(30);
    }
    expect(settingsBeats({ seq: 5, disappearSec: 30 }, { seq: 5, disappearSec: 300 })).toBe(true);
    expect(settingsBeats({ seq: 5, disappearSec: 300 }, { seq: 5, disappearSec: 30 })).toBe(false);
  });

  it('a constraining value beats 0 at the same seq, in both arrival orders — the §10.3 tie-break fails CLOSED', () => {
    // The named test §10.3 promises. Ranking 0 lowest — the naive reading
    // of "lower wins" — would make an equivocating writer's (seq 5, 0) /
    // (seq 5, 30) pair resolve toward OFF for the whole room: fail-open in
    // the one place the mechanism exists to fail closed. 0 is not a shorter
    // timer; it is the absence of one, and it must lose this tie.
    expect(settingsBeats({ seq: 5, disappearSec: 0 }, { seq: 5, disappearSec: 30 })).toBe(false);
    expect(settingsBeats({ seq: 5, disappearSec: 30 }, { seq: 5, disappearSec: 0 })).toBe(true);
    // never reflexive, so the per-writer max stays idempotent
    expect(settingsBeats({ seq: 5, disappearSec: 0 }, { seq: 5, disappearSec: 0 })).toBe(false);
    // a LATER 0 still wins outright: switching your own timer off remains
    // an ordinary write at the next seq — the tie-break bites ties only
    expect(settingsBeats({ seq: 6, disappearSec: 0 }, { seq: 5, disappearSec: 30 })).toBe(true);

    for (const order of [
      [0, 30],
      [30, 0],
    ]) {
      const p = run(C, [anchor]);
      for (const sec of order) {
        applySettingsWrite(p.store, { writerId: A, seq: 5, disappearSec: sec });
      }
      expect(p.store.getSettingsSlot(A)?.disappearSec, `order ${order.join(',')}`).toBe(30);
      // and 0 stays excluded from the minimum on the way out
      expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(30);
    }
  });

  it("a timer of 0 is 'off', not 'shorter': it removes only the writer's own constraint (§10.3's copy, made true)", () => {
    // If 0 competed in the minimum, switching your timer OFF would drag the
    // whole room to "never disappear" — lengthening everyone else's copies,
    // the exact thing §10.3 promises cannot happen.
    const p = run(C, [anchor]);
    applySettingsWrite(p.store, { writerId: A, seq: 1, disappearSec: 300 });
    applySettingsWrite(p.store, { writerId: B, seq: 1, disappearSec: 0 });
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(300);
    // the last constraint holder withdraws: the room's timer is off
    applySettingsWrite(p.store, { writerId: A, seq: 2, disappearSec: 0 });
    expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold())).toBe(0);
  });
});

describe('the rd digest (§5.1, §6.2a)', () => {
  const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const M1 = '01BX5ZZKBKACTAV9WEVGEMMVRY';
  const M2 = '01BX5ZZKBKACTAV9WEVGEMMVS0';

  it('matches the byte-exact vector: owner then members, U+001F-joined, UTF-8, SHA-256, first 8 bytes, 11 unpadded base64 chars', () => {
    // computed independently (python hashlib), not by this implementation
    expect(rosterDigest(OWNER, [M1, M2], sha256)).toBe('IbnK9KpeOHE');
    expect(rosterDigest(OWNER, [OWNER], sha256)).toBe('U/KXSbBXWRo');
  });

  it('sorts members by code unit itself, so input order cannot mint a banner', () => {
    expect(rosterDigest(OWNER, [M2, M1], sha256)).toBe(rosterDigest(OWNER, [M1, M2], sha256));
  });

  it('the owner lives inside the preimage: same members, different owner, different digest', () => {
    // a room forged on a false owner claim mismatches even when the member
    // lists agree — the reason ownership is in the preimage, not a 2nd field
    expect(rosterDigest(M1, [M1, M2], sha256)).not.toBe(rosterDigest(OWNER, [M1, M2], sha256));
  });

  it('joins with U+001F exactly — the separator is what makes the encoding unambiguous', () => {
    expect([...rosterDigestPreimage('X', ['Z', 'Y'])]).toEqual([
      0x58, 0x1f, 0x59, 0x1f, 0x5a,
    ]);
  });

  it('is always exactly 11 characters of the standard alphabet, never padded', () => {
    for (const members of [[M1], [M1, M2], [OWNER, M1, M2]]) {
      expect(rosterDigest(OWNER, members, sha256)).toMatch(/^[A-Za-z0-9+/]{11}$/);
    }
  });

  it('a mis-injected hash fails loudly instead of minting a short digest', () => {
    const broken = () => new Uint8Array(4);
    expect(() => rosterDigest(OWNER, [M1], broken)).toThrow(/8/);
  });

  it('rejects an id containing the U+001F separator: the digest defends its own injectivity', () => {
    // Without this check preimage(['A\u001fB']) is byte-identical to
    // preimage(['A','B']) and the anti-equivocation alarm is unambiguous
    // only by grace of ULID validation two layers away.
    expect(() => rosterDigestPreimage('X\u001fY', ['Z'])).toThrow(/U\+001F/);
    expect(() => rosterDigestPreimage('X', ['Z\u001f', 'Y'])).toThrow(/U\+001F/);
    expect(() => rosterDigestPreimage('O', ['A\u001fB'])).toThrow(/U\+001F/);
    expect(() => rosterDigest('O', ['A\u001fB'], sha256)).toThrow(/U\+001F/);
    // the two lists the collision would have conflated stay distinct
    expect([...rosterDigestPreimage('O', ['A', 'B'])]).toEqual([0x4f, 0x1f, 0x41, 0x1f, 0x42]);
  });
});

describe('the persisted-row schemas police the boundary for store implementations', () => {
  it('accepts a real row and refuses a malformed one', () => {
    const good = {
      memberId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      writerId: '01BX5ZZKBKACTAV9WEVGEMMVRY',
      seq: 3,
      state: 'in',
    };
    expect(RosterSlot.safeParse(good).success).toBe(true);
    expect(RosterSlot.safeParse({ ...good, memberId: 'not-a-ulid' }).success).toBe(false);
    expect(RosterSlot.safeParse({ ...good, seq: 0 }).success).toBe(false);
    expect(RosterSlot.safeParse({ ...good, state: 'frozen' }).success).toBe(false);
    expect(
      GroupNewWrite.safeParse({ writerId: good.writerId, members: [], seq: 1 }).success,
    ).toBe(false);
    expect(GroupDelWrite.safeParse({ writerId: good.writerId, seq: 1 }).success).toBe(true);
    expect(
      SettingsSlot.safeParse({ writerId: good.writerId, seq: 1, disappearSec: -1 }).success,
    ).toBe(false);
  });
});

describe('the anchor inside the shuffle — pre-anchor writes (§6.5)', () => {
  // §3.2's random wire msgIds mean the server drains an offline queue in an
  // order unrelated to composition, and cross-sender ordering does not exist
  // at all — so a phone offline at room creation routinely receives roster
  // writes BEFORE the room's grp.new. These cases were a real, reproduced
  // divergence; 52 tests missed them because both converged() and the
  // property pinned the anchor as an unshuffled prefix.

  it("a member's own departure that outruns the grp.new is stored, not dropped: both orders fold the same roster (the gate repro)", () => {
    const invite: Ev = { t: 'new', w: A, ms: [B, C], seq: 1 };
    const leave: Ev = { t: 'roster', w: C, m: C, s: 'out', seq: 1 };
    // the anchor itself is inside the permutation here
    const p = converged(B, [invite, leave], { anchor: [] });
    expectVerdicts(p, { [A]: 'in', [B]: 'in', [C]: 'out' });
    expect(p.fold().members).toEqual([A, B].sort());
    // the departure is sovereign even against the seed's same-seq 'in':
    // out beats in at the tie, so the invite cannot resurrect the leaver
    expect(p.store.getSlot(C, C)?.state).toBe('out');
  });

  it("a pre-anchor authority write is dropped — and heals on the owner's next write about that member (§6.5)", () => {
    const remove: RosterSlot = { writerId: A, memberId: B, state: 'out', seq: 2 };
    // the phone that drained the remove first: the write cannot even be
    // classified (no owner to compare against), so it is unknown-room —
    // holding it would re-grow the deleted pending/held apparatus
    const early = new Phone(C);
    expect(applyRosterWrite(early.store, C, remove)).toEqual({ outcome: 'unknown-room' });
    expect(early.store.listSlots()).toHaveLength(0);
    early.apply(anchor);
    // honest divergence, stated: this phone still folds B in...
    expectVerdicts(early, { [B]: 'in' });
    const late = run(C, [anchor, { t: 'roster', w: A, m: B, s: 'out', seq: 2 }]);
    expectVerdicts(late, { [B]: 'out' });
    // ...until the owner restates B's truth in the one lane that counts,
    // which converges the two phones whole
    const restate: Ev = { t: 'roster', w: A, m: B, s: 'out', seq: 3 };
    early.apply(restate);
    late.apply(restate);
    expect(early.state()).toBe(late.state());
    expectVerdicts(early, { [B]: 'out' });
  });

  it('a grp.set that outruns the grp.new is stored: the timer cannot fail open by arrival order', () => {
    // A settings slot is its writer's own — nobody else could restate it —
    // and dropping it fails OPEN (fewer constraints, longer retention).
    for (const first of [true, false]) {
      const set: Ev = { t: 'set', w: B, sec: 30, seq: 1 };
      const events: Ev[] = first ? [set, anchor] : [anchor, set];
      const p = run(C, events);
      expect(effectiveDisappearSec(p.store.listSettingsSlots(), p.fold()), first ? 'set-first' : 'anchor-first').toBe(30);
    }
  });

  it('a stored pre-anchor slot is inert if the room never anchors, and cannot admit anyone if it does', () => {
    const bare = new MemoryStore();
    applyRosterWrite(bare, C, { writerId: Z, memberId: Z, state: 'in', seq: 1 });
    // no anchor: no fold, no verdict, one bounded orphan row
    expect(bare.getOwner()).toBeUndefined();
    expect(bare.listSlots()).toHaveLength(1);
    // anchor arrives without Z: the stray self 'in' admits nobody (§6.2
    // rule 3 — foldRoster re-applies the policy and the verdict at fold time)
    applyGroupNew(bare, C, { writerId: A, members: [A, B, C], seq: 1 });
    expect(verdictFor(foldRoster(A, bare.listSlots()), Z)).toBe('out');
  });

  it('600 seeded scenarios × 8 shuffles WITH the anchor in the shuffle: the owner, every sovereign row, every settings row and every sovereign out agree — and one owner restatement per member converges the rest whole', () => {
    const people = [A, B, C, D, M, Z];
    for (let scenario = 0; scenario < 600; scenario++) {
      const rnd = mulberry32(50_000 + scenario);
      const writes: Ev[] = [];
      const seqs = new Map<string, number>(people.map(id => [id, 1]));
      const n = 3 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const w = people[Math.floor(rnd() * people.length)]!;
        seqs.set(w, seqs.get(w)! + (rnd() < 0.66 ? 1 : 0));
        const seq = seqs.get(w)!;
        const k = rnd();
        if (k < 0.35) {
          writes.push({ t: 'roster', w, m: w, s: rnd() < 0.5 ? 'in' : 'out', seq });
        } else if (k < 0.75) {
          const m = people[Math.floor(rnd() * people.length)]!;
          writes.push({ t: 'roster', w, m, s: rnd() < 0.5 ? 'in' : 'out', seq });
        } else {
          const sec = [0, 30, 300][Math.floor(rnd() * 3)]!;
          writes.push({ t: 'set', w, sec, seq });
        }
      }

      // The sovereign winners, computed OUTSIDE the store from content alone.
      const selfWinner = new Map<string, RosterSlot>();
      const keepSelf = (s: RosterSlot) => {
        const cur = selfWinner.get(s.memberId);
        if (cur === undefined || rosterBeats(s, cur)) selfWinner.set(s.memberId, s);
      };
      keepSelf({ memberId: A, writerId: A, seq: 1, state: 'in' }); // the anchor's own seed
      for (const e of writes) {
        if (e.t === 'roster' && e.w === e.m) {
          keepSelf({ memberId: e.m, writerId: e.w, seq: e.seq, state: e.s });
        }
      }

      // Canonical: anchor first, so nothing pre-anchor drops. Its owner-lane
      // winners are what an honest owner would restate (§6.5's healing).
      const canonical = run(C, [anchor, ...writes]);
      const restate: Ev[] = canonical.store
        .listSlots()
        .filter(s => s.writerId === A)
        .sort((a, b) => (a.memberId < b.memberId ? -1 : 1))
        .map((s, i) => ({ t: 'roster', w: A, m: s.memberId, s: s.state, seq: 5_000 + i }) as Ev);
      const healedReference = run(C, [anchor, ...writes, ...restate]).state();

      const all: Ev[] = [anchor, ...writes];
      for (let shuffle = 0; shuffle < 8; shuffle++) {
        const order = shuffle === 0 ? all : shuffled(all, rnd);
        const p = run(C, order);
        const f = p.fold();
        const tag = `scenario ${scenario} shuffle ${shuffle}`;
        expect(p.store.getOwner(), tag).toBe(A);
        for (const [id, want] of selfWinner) {
          // the sovereign row survives EVERY arrival order (the P1-2 class)
          expect(p.store.getSlot(id, id), `${tag}: self row for ${id}`).toEqual(want);
          if (want.state === 'out') {
            expect(verdictFor(f, id), `${tag}: sovereign out for ${id} is absolute`).toBe('out');
          }
        }
        // settings rows converge unconditionally: stored pre-anchor too
        const sets = (ph: Phone) =>
          ph.store
            .listSettingsSlots()
            .map(s => `${s.writerId}/${s.seq}/${s.disappearSec}`)
            .sort()
            .join('|');
        expect(sets(p), `${tag}: settings rows`).toBe(sets(canonical));
        // healing: the owner restating each member once converges the state
        // whole — §6.5's amended claim, exactly
        expect(run(C, [...order, ...restate]).state(), `${tag}: healed`).toBe(healedReference);
      }
    }
  });
});

describe('duplicate grp.new — content where sound, trust root where not (§6.2a, §6.6)', () => {
  it("an equivocating composer's two grp.new fold to the union in both arrival orders — not first-arrival-wins", () => {
    // Same writer, so the seeds are just more owner-lane writes (§5.1: the
    // invite IS authority writes) and merge under the ordinary content
    // order. The anchor row itself never changes.
    const one: Ev = { t: 'new', w: A, ms: [A, B], seq: 1 };
    const two: Ev = { t: 'new', w: A, ms: [A, C], seq: 2 };
    const p = converged(B, [one, two], { anchor: [] });
    expect(p.fold().ownerId).toBe(A);
    expect(p.fold().members).toEqual([A, B, C].sort());
  });

  it('a duplicate grp.new cannot resurrect a removal: its stale seeds lose to the later write', () => {
    const p = converged(C, [
      { t: 'roster', w: A, m: B, s: 'out', seq: 3 },
      { t: 'new', w: A, ms: [A, B, C], seq: 1 }, // the replayed invite
    ]);
    expectVerdicts(p, { [B]: 'out' });
  });

  it('a grp.new from a DIFFERENT writer never re-anchors: the anchor is written once (§6.6), and a forger cannot steal a room', () => {
    const ana: Ev = { t: 'new', w: A, ms: [A, B], seq: 1 };
    const mal: Ev = { t: 'new', w: M, ms: [M, B], seq: 9 };
    const honest = run(B, [ana, mal]);
    expect(honest.fold().ownerId).toBe(A);
    // Mallory's grp.new was ignored WHOLE: no owner change, no seed rows
    expect(honest.store.getSlot(M, M)).toBeUndefined();
    expect(honest.store.getSlot(B, M)).toBeUndefined();
    // The reverse order is the §6.2a late-joiner residual, asserted per
    // order rather than papered over: a phone that accepted the forgery
    // first anchors on it, and rd discloses the split on first honest
    // contact. No content order can fix this without letting a low-sorting
    // forger steal every existing room — which is why arrival IS the trust
    // root for the anchor, and only for the anchor.
    const fooled = run(B, [mal, ana]);
    expect(fooled.fold().ownerId).toBe(M);
  });
});

describe("the apply outcome contract — §10.3's announce-only-when-applied keys off it", () => {
  const slot = (w: string, m: string, s: RosterState, seq: number): RosterSlot => ({
    writerId: w,
    memberId: m,
    state: s,
    seq,
  });

  it('applied names its lane; a replayed envelope reports stale, never applied — the endless-announcement guard', () => {
    const p = run(C, [anchor]);
    expect(applyRosterWrite(p.store, C, slot(B, B, 'out', 1))).toEqual({
      outcome: 'applied',
      lane: 'self',
      evicted: [],
      recreated: false,
    });
    // the SAME envelope again — same seq, same state — must be stale:
    // 'applied' here is one replayed frame becoming an announcement stream
    expect(applyRosterWrite(p.store, C, slot(B, B, 'out', 1))).toEqual({
      outcome: 'stale',
      lane: 'self',
      recreated: false,
    });
    expect(applyRosterWrite(p.store, C, slot(A, D, 'in', 5))).toEqual({
      outcome: 'applied',
      lane: 'authority',
      evicted: [],
      recreated: false,
    });
    // an older replay in the same lane: stale, store keeps the winner
    expect(applyRosterWrite(p.store, C, slot(A, D, 'in', 4))).toEqual({
      outcome: 'stale',
      lane: 'authority',
      recreated: false,
    });
    expect(p.store.getSlot(D, A)?.seq).toBe(5);
  });

  it('declined, unknown-room and self-preanchor complete the roster contract', () => {
    const anchored = run(C, [anchor]);
    expect(applyRosterWrite(anchored.store, C, slot(M, B, 'out', 1))).toEqual({
      outcome: 'declined',
    });
    const bare = new MemoryStore();
    expect(applyRosterWrite(bare, C, slot(A, B, 'out', 2))).toEqual({ outcome: 'unknown-room' });
    expect(bare.listSlots()).toHaveLength(0);
    expect(applyRosterWrite(bare, C, slot(B, B, 'out', 1))).toEqual({ outcome: 'self-preanchor' });
    expect(bare.getSlot(B, B)).toEqual(slot(B, B, 'out', 1));
    // a losing pre-anchor replay stays quiet and does not regress the winner
    expect(applyRosterWrite(bare, C, slot(B, B, 'in', 1))).toEqual({ outcome: 'self-preanchor' });
    expect(bare.getSlot(B, B)?.state).toBe('out');
  });

  it('recreated is true exactly when a counted write brings a hidden room back', () => {
    const p = run(C, [anchor, { t: 'localdel' }]);
    expect(applyRosterWrite(p.store, C, slot(A, D, 'in', 2))).toEqual({
      outcome: 'applied',
      lane: 'authority',
      evicted: [],
      recreated: true,
    });
    // already present: the next write must not report a second recreation
    expect(applyRosterWrite(p.store, C, slot(A, D, 'out', 3))).toEqual({
      outcome: 'applied',
      lane: 'authority',
      evicted: [],
      recreated: false,
    });
  });

  it('noteRoomTraffic reports recreated, then noop, and unknown-room off-anchor', () => {
    const p = run(C, [anchor, { t: 'localdel' }]);
    expect(noteRoomTraffic(p.store, C)).toBe('recreated');
    expect(noteRoomTraffic(p.store, C)).toBe('noop');
    expect(noteRoomTraffic(new MemoryStore(), C)).toBe('unknown-room');
  });

  it('the settings contract: applied, stale on replay, declined under a declining policy, self-preanchor off-anchor', () => {
    const p = run(C, [anchor]);
    expect(applySettingsWrite(p.store, { writerId: B, seq: 2, disappearSec: 30 })).toBe('applied');
    expect(applySettingsWrite(p.store, { writerId: B, seq: 2, disappearSec: 30 })).toBe('stale');
    expect(applySettingsWrite(p.store, { writerId: B, seq: 1, disappearSec: 300 })).toBe('stale');
    expect(p.store.getSettingsSlot(B)?.disappearSec).toBe(30);
    expect(
      applySettingsWrite(p.store, { writerId: B, seq: 3, disappearSec: 0 }, ownerOnlyPolicy),
    ).toBe('declined');
    const bare = new MemoryStore();
    expect(applySettingsWrite(bare, { writerId: B, seq: 1, disappearSec: 30 })).toBe(
      'self-preanchor',
    );
    expect(bare.getSettingsSlot(B)?.disappearSec).toBe(30);
  });

  it('the grp.new contract: accepted, ignored on exact replay, merged on an equivocating duplicate, ignored from a forger', () => {
    const store = new MemoryStore();
    expect(applyGroupNew(store, C, { writerId: A, members: [A, B], seq: 1 }).outcome).toBe(
      'accepted',
    );
    const rows = store
      .listSlots()
      .map(s => `${s.memberId}/${s.writerId}/${s.seq}/${s.state}`)
      .sort()
      .join('|');
    expect(applyGroupNew(store, C, { writerId: A, members: [A, B], seq: 1 }).outcome).toBe(
      'ignored',
    );
    expect(
      store
        .listSlots()
        .map(s => `${s.memberId}/${s.writerId}/${s.seq}/${s.state}`)
        .sort()
        .join('|'),
    ).toBe(rows);
    expect(applyGroupNew(store, C, { writerId: A, members: [A, C], seq: 2 }).outcome).toBe(
      'merged',
    );
    expect(applyGroupNew(store, C, { writerId: M, members: [M], seq: 9 }).outcome).toBe('ignored');
  });

  it('the grp.del contract: purged, declined, unknown-room — and the documented replay limit, pinned', () => {
    const p = run(C, [anchor]);
    expect(applyGroupDel(p.store, { writerId: B, seq: 1 })).toBe('declined');
    expect(applyGroupDel(p.store, { writerId: A, seq: 2 })).toBe('purged');
    expect(applyGroupDel(p.store, { writerId: A, seq: 2 })).toBe('unknown-room');
    // The KNOWN LIMIT at the applyGroupDel call site, pinned as documented:
    // the classifier is memoryless (no tombstone, deliberately), so a
    // replayed genuine delete purges a room re-anchored under the same id.
    // Transport-level de-dup is the intended backstop and the transport layer owns it; if
    // this assertion ever flips, the comment there must flip with it.
    applyGroupNew(p.store, C, { writerId: A, members: [A, B, C], seq: 3 });
    expect(applyGroupDel(p.store, { writerId: A, seq: 2 })).toBe('purged');
  });
});

describe('bounded inputs (§6.4: bound where iterated)', () => {
  it('GroupNewWrite refuses a member list beyond GROUP_MAX_MEMBERS, and applyGroupNew refuses to iterate one', () => {
    const ulid = (i: number) => `01ARZ3NDEKTSV4RRFFQ69G5F${String.fromCharCode(65 + Math.floor(i / 10))}${i % 10}`;
    const twelve = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) => ulid(i));
    const thirteen = Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) => ulid(i));
    expect(
      GroupNewWrite.safeParse({ writerId: twelve[0], members: twelve, seq: 1 }).success,
    ).toBe(true);
    expect(
      GroupNewWrite.safeParse({ writerId: twelve[0], members: thirteen, seq: 1 }).success,
    ).toBe(false);
    // and the loop itself is guarded, so a caller that skipped validation
    // cannot drive thousands of slot writes before the lane cap trims them
    const store = new MemoryStore();
    expect(() => applyGroupNew(store, C, { writerId: A, members: thirteen, seq: 1 })).toThrow(
      /GROUP_MAX_MEMBERS/,
    );
    expect(store.getOwner()).toBeUndefined(); // refused whole, stored nothing
    expect(
      applyGroupNew(store, C, { writerId: A, members: twelve, seq: 1 }).outcome,
    ).toBe('accepted');
  });
});

describe('order independence — the property', () => {
  it('1000 seeded scenarios × 8 shuffles converge through the slot store, its cap, and grp.del', () => {
    const people = [A, B, C, D, M, Z];
    for (let scenario = 0; scenario < 1000; scenario++) {
      const rnd = mulberry32(1_000 + scenario);
      const writes: Ev[] = [];
      const seqs = new Map<string, number>(people.map(id => [id, 1]));
      const n = 3 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const w = people[Math.floor(rnd() * people.length)]!;
        seqs.set(w, seqs.get(w)! + (rnd() < 0.66 ? 1 : 0));
        const seq = seqs.get(w)!;
        const k = rnd();
        if (k < 0.3) {
          writes.push({ t: 'roster', w, m: w, s: rnd() < 0.5 ? 'in' : 'out', seq });
        } else if (k < 0.7) {
          const m = people[Math.floor(rnd() * people.length)]!;
          writes.push({ t: 'roster', w, m, s: rnd() < 0.5 ? 'in' : 'out', seq });
        } else if (k < 0.8) {
          const sec = [0, 30, 300, 86_400][Math.floor(rnd() * 4)]!;
          writes.push({ t: 'set', w, sec, seq });
        } else {
          writes.push({ t: 'msg', w, seq });
        }
      }
      if (rnd() < 0.1) {
        // press the cap inside the property, not only in its own test: 80
        // minted ids sorting ABOVE every churn id ('ZZ...' > 'ZED'), each
        // written once, so eviction stays content-keyed under every order
        for (let i = 0; i < 80; i++) {
          writes.push({
            t: 'roster',
            w: A,
            m: `ZZ${String(i).padStart(3, '0')}`,
            s: 'in',
            seq: 100 + i,
          });
        }
      }
      const tailRoll = rnd();
      if (tailRoll < 0.25) {
        writes.push({ t: 'del', w: A, seq: 999 });
      } else if (tailRoll < 0.45) {
        // an equivocating composer's SECOND grp.new rides the ordinary
        // shuffle: same writer, so its seeds are just more owner-lane
        // writes and full-state convergence must survive it. Mutually
        // exclusive with grp.del — re-anchoring after a purge is the
        // documented order edge, not a convergence claim.
        writes.push({
          t: 'new',
          w: A,
          ms: [A, people[Math.floor(rnd() * people.length)]!],
          seq: 1 + Math.floor(rnd() * 5),
        });
      }

      let reference: string | undefined;
      for (let shuffle = 0; shuffle < 8; shuffle++) {
        const order = shuffle === 0 ? writes : shuffled(writes, rnd);
        const state = run(C, [anchor, ...order]).state();
        if (reference === undefined) reference = state;
        else if (state !== reference) {
          // fail with the seed so the exact divergence is reproducible
          expect.fail(
            `scenario ${scenario} diverged:\n${reference}\nvs\n${state}\nwrites=${JSON.stringify(writes)}`,
          );
        }
      }
    }
  });
});

describe('purity', () => {
  it('imports zod and nothing else — no db, no react-native, no node builtins, no other shared modules, no clock', () => {
    const src = readFileSync(new URL('../src/group-fold.ts', import.meta.url), 'utf8');
    const imports = src.match(/^import\b.*$/gm) ?? [];
    expect(imports).toEqual(["import { z } from 'zod';"]);
    expect(src).not.toMatch(/require\s*\(/);
    // no wall clock in an ordering claim
    expect(src).not.toMatch(/Date\.now|new Date\(/);
  });
});
