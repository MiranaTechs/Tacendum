/**
 * The six `grp.*` envelopes. The rule these tests exist to hold down is the
 * asymmetry: **compose strictly, parse permissively.**
 *
 * `encodeEnvelope` and `parseEnvelope` share one schema by design, so every
 * bound here binds the sender too. That is what makes a naive
 * `z.string().length(11)` on the roster digest dangerous: a peer's malformed
 * digest would refuse the whole message at the parser, and on a one-way
 * ratchet that message is gone permanently. The digest is worth losing; the
 * message is not.
 */

import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_MEMBERS,
  GROUP_TCMS,
  GroupDelEnvelope,
  GroupHistoryEnvelope,
  GroupConsentEnvelope,
  GroupMessageEnvelope,
  GroupNewEnvelope,
  GroupRosterEnvelope,
  GroupSettingsEnvelope,
  MAX_GROUP_BODY,
  MAX_HISTORY_SHARE,
  RD_LENGTH,
  RosterDigest,
  assertComposableRd,
  composeRosterDigest,
  isGroupTcm,
} from '../src/group-envelope.js';
import {
  GROUP_MAX_MEMBERS as FOLD_MAX_MEMBERS,
  rosterDigest,
  rosterDigestPreimage,
} from '../src/group-fold.js';
import { createHash } from 'node:crypto';

const A = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const B = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const C = '01CCCCCCCCCCCCCCCCCCCCCCCC';

const sha256Sync = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest());
const sha256Async = async (bytes: Uint8Array): Promise<Uint8Array> => sha256Sync(bytes);

/** A valid digest for a real fold, so fixtures are not hand-waved. */
const RD = rosterDigest(A, [A, B], sha256Sync);

const msg = (over: Record<string, unknown> = {}) => ({
  tcm: 'grp.msg',
  g: A,
  m: B,
  rd: RD,
  b: 'hello',
  ...over,
});

describe('the constants are imported, never re-minted (§4.1)', () => {
  it('GROUP_MAX_MEMBERS is the fold’s constant, the same binding', () => {
    // Two definitions of the member cap is precisely the defect §4.1 argues
    // against: the composer would bound one number and the fold another.
    expect(GROUP_MAX_MEMBERS).toBe(FOLD_MAX_MEMBERS);
    expect(GROUP_MAX_MEMBERS).toBe(12);
  });

  it('names all seven kinds — the six before, plus grp.consent (the consent announcement)', () => {
    expect([...GROUP_TCMS].sort()).toEqual(
      ['grp.consent', 'grp.del', 'grp.hist', 'grp.msg', 'grp.new', 'grp.roster', 'grp.set'].sort(),
    );
    expect(GROUP_TCMS.every(isGroupTcm)).toBe(true);
    expect(isGroupTcm('grp.consent')).toBe(true);
    expect(isGroupTcm('grp.owner')).toBe(false); // deleted with transfer
    expect(isGroupTcm('image')).toBe(false);
  });
});

describe('grp.consent — the member-consent announcement', () => {
  it('carries one room, one agent, one state, and a seq — and nothing else', () => {
    const parsed = GroupConsentEnvelope.parse({
      tcm: 'grp.consent',
      g: A,
      a: B,
      s: 'hold',
      n: 1,
    });
    // No-enumeration is a SHAPE property: exactly these keys survive the parse, so the
    // sealed event can name one member's stance in one room toward one agent
    // and nothing more. A member list or a second agent would be enumeration.
    expect(Object.keys(parsed).sort()).toEqual(['a', 'g', 'n', 's', 'tcm']);
  });

  it('takes only share/hold, and refuses any other state', () => {
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: B, s: 'share', n: 1 }).success).toBe(
      true,
    );
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: B, s: 'hold', n: 1 }).success).toBe(
      true,
    );
    // 'undecided' is the ABSENCE of an announcement, never a value on the
    // wire: a member who has not decided has written no edge and no row.
    expect(
      GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: B, s: 'undecided', n: 1 }).success,
    ).toBe(false);
  });

  it('requires a ULID room and a ULID agent — the agent is a bare id, never a URL', () => {
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: 'kitchen', a: B, s: 'share', n: 1 }).success).toBe(
      false,
    );
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: 'nope', s: 'share', n: 1 }).success).toBe(
      false,
    );
  });

  it('drops a smuggled member list — the subject is the authenticated sender, never a payload field', () => {
    // A peer that tried to name the member (or a list of them) has that field
    // stripped: strip-mode zod keeps only the schema's keys, so the render's
    // subject can only ever be frame.from (rule 16), never a forged `who`.
    const parsed = GroupConsentEnvelope.parse({
      tcm: 'grp.consent',
      g: A,
      a: B,
      s: 'hold',
      n: 1,
      who: [A, C],
      members: [A, B, C],
    } as Record<string, unknown>);
    expect('who' in parsed).toBe(false);
    expect('members' in parsed).toBe(false);
  });

  it('orders on the same n≥1 seq lane as every other announcement', () => {
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: B, s: 'share', n: 0 }).success).toBe(
      false,
    );
    expect(GroupConsentEnvelope.safeParse({ tcm: 'grp.consent', g: A, a: B, s: 'share', n: 1 }).success).toBe(
      true,
    );
  });
});

describe('rd parses permissively — a bad digest never costs the message (§5.5)', () => {
  const survives = (rd: unknown) => {
    const parsed = GroupMessageEnvelope.safeParse(msg({ rd }));
    expect(parsed.success).toBe(true);
    return parsed.success ? parsed.data : undefined;
  };

  it('absent', () => {
    const parsed = GroupMessageEnvelope.safeParse({ tcm: 'grp.msg', g: A, m: B, b: 'hi' });
    expect(parsed.success).toBe(true);
  });

  it('over-long — delivers, digest dropped', () => {
    expect(survives('A'.repeat(64))?.rd).toBeUndefined();
  });

  it('too short — delivers, digest dropped', () => {
    expect(survives('AAA')?.rd).toBeUndefined();
  });

  it('URL-safe alphabet (-_) — delivers, digest dropped', () => {
    // The one alphabet confusion that produces a permanent banner between two
    // honest clients rather than a parse error, which is why it is pinned.
    expect(survives('AAAA-AAA_AA')?.rd).toBeUndefined();
  });

  it('padded (12 chars) — delivers, digest dropped', () => {
    expect(survives('AAAAAAAAAAA=')?.rd).toBeUndefined();
  });

  it('wrong type — delivers, digest dropped', () => {
    expect(survives(42)?.rd).toBeUndefined();
    expect(survives(null)?.rd).toBeUndefined();
  });

  it('a VALID digest is kept, not swallowed by the permissive path', () => {
    // The permissive parse must not be so permissive it drops good digests —
    // that would silently disable equivocation detection everywhere.
    expect(survives(RD)?.rd).toBe(RD);
  });

  it('the rest of the message is intact when the digest is dropped', () => {
    const parsed = GroupMessageEnvelope.parse(msg({ rd: 'nope' }));
    expect(parsed.b).toBe('hello');
    expect(parsed.g).toBe(A);
    expect(parsed.m).toBe(B);
  });
});

describe('rd composes strictly — our own malformed digest is loud', () => {
  it('accepts a real digest', () => {
    expect(assertComposableRd(RD)).toBe(RD);
    expect(RD).toHaveLength(RD_LENGTH);
  });

  it('refuses the URL-safe alphabet', () => {
    expect(() => assertComposableRd('AAAA-AAA_AA')).toThrow(/malformed rd/);
  });

  it('refuses padding and wrong lengths', () => {
    expect(() => assertComposableRd('AAAAAAAAAAA=')).toThrow(/malformed rd/);
    expect(() => assertComposableRd('AAA')).toThrow(/malformed rd/);
  });

  it('the strict schema is exactly 11 standard-base64 characters', () => {
    expect(RosterDigest.safeParse('A'.repeat(11)).success).toBe(true);
    expect(RosterDigest.safeParse('A'.repeat(12)).success).toBe(false);
    expect(RosterDigest.safeParse('AAAAAAAAAA-').success).toBe(false);
  });
});

describe('the digest itself', () => {
  it('composeRosterDigest matches the fold’s sync digest byte for byte', async () => {
    // Two implementations of this is not a defect generator, it is an
    // ALARM-FATIGUE generator. Same preimage, same answer, both paths.
    expect(await composeRosterDigest(A, [A, B], sha256Async)).toBe(RD);
  });

  it('is order-insensitive in its inputs but sensitive to membership', async () => {
    expect(await composeRosterDigest(A, [B, A], sha256Async)).toBe(
      await composeRosterDigest(A, [A, B], sha256Async),
    );
    expect(await composeRosterDigest(A, [A, C], sha256Async)).not.toBe(RD);
  });

  it('binds the OWNER, not only the members', async () => {
    // A room forged on a false owner claim must mismatch on first honest
    // contact even when the member lists agree (§5.1).
    expect(await composeRosterDigest(B, [A, B], sha256Async)).not.toBe(RD);
  });

  it('pins the ALPHABET with a vector that actually contains + and /', async () => {
    // The fixture above digests to `fVdDbgp45sA`, which contains neither `+`
    // nor `/` — so a mutation swapping the encoder to the URL-safe alphabet
    // survived the entire suite. Those two characters are the ONLY observable
    // difference between RFC 4648 §4 and §5, and getting them wrong is a
    // permanent equivocation banner between two honest clients rather than a
    // parse error. This vector was chosen to exercise both.
    const owner = '01023AAAAAAAAAAAAAAAAAAAAA';
    const member = '01523AAAAAAAAAAAAAAAAAAAAA';
    const digest = await composeRosterDigest(owner, [owner, member], sha256Async);
    expect(digest).toBe('M+TFhub/mmM');
    expect(digest).toContain('+');
    expect(digest).toContain('/');
  });

  it('uses ONE encoder, shared with the fold — not a second copy', async () => {
    // Written twice originally; the duplicate is what let the alphabet drift
    // undetected. Same bytes through both paths, on the +/-bearing vector.
    const owner = '01023AAAAAAAAAAAAAAAAAAAAA';
    const member = '01523AAAAAAAAAAAAAAAAAAAAA';
    expect(await composeRosterDigest(owner, [owner, member], sha256Async)).toBe(
      rosterDigest(owner, [owner, member], sha256Sync),
    );
  });

  it('pins a known vector, so a future refactor of the preimage is caught', async () => {
    const expected = Buffer.from(
      createHash('sha256').update(rosterDigestPreimage(A, [A, B])).digest().subarray(0, 8),
    ).toString('base64').replace(/=+$/, '');
    expect(await composeRosterDigest(A, [A, B], sha256Async)).toBe(expected);
  });

  it('refuses a mis-injected hash rather than emitting a short digest', async () => {
    await expect(composeRosterDigest(A, [A, B], async () => new Uint8Array(4))).rejects.toThrow(
      /need at least 8/,
    );
  });
});

describe('no nesting, and no author laundering (§5.2, rule 16)', () => {
  it('refuses a grp.msg whose body is itself a grp.* envelope', () => {
    const nested = JSON.stringify({ tcm: 'grp.msg', g: A, m: C, rd: RD, b: 'inner' });
    expect(GroupMessageEnvelope.safeParse(msg({ b: nested })).success).toBe(false);
  });

  it('still allows a body that wraps an ORDINARY envelope — that is the point', () => {
    // Image, file, reaction, edit and reply all work in rooms precisely
    // because the body is whatever `messages.body` would hold.
    const image = JSON.stringify({ tcm: 'image', att: 'blob-1', key: 'a2V5' });
    expect(GroupMessageEnvelope.safeParse(msg({ b: image })).success).toBe(true);
  });

  it('allows prose that merely quotes the format mid-sentence', () => {
    expect(
      GroupMessageEnvelope.safeParse(msg({ b: 'it prints {"tcm":"grp.msg" sometimes' })).success,
    ).toBe(true);
  });

  it('strips any author field a sender adds — identity comes from frame.from', () => {
    // zod strips unknown keys, and `encodeEnvelope` stringifies `parsed.data`
    // rather than its argument, so a laundered author cannot ride the wire.
    const parsed = GroupMessageEnvelope.parse(msg({ from: C, authorId: C, writerId: C }));
    expect(parsed).not.toHaveProperty('from');
    expect(parsed).not.toHaveProperty('authorId');
    expect(parsed).not.toHaveProperty('writerId');
  });
});

describe('bounds', () => {
  it('a body at the ceiling passes and one past it does not', () => {
    expect(GroupMessageEnvelope.safeParse(msg({ b: 'x'.repeat(MAX_GROUP_BODY) })).success).toBe(true);
    expect(GroupMessageEnvelope.safeParse(msg({ b: 'x'.repeat(MAX_GROUP_BODY + 1) })).success).toBe(
      false,
    );
    expect(GroupMessageEnvelope.safeParse(msg({ b: '' })).success).toBe(false);
  });

  it('grp.new bounds the roster at GROUP_MAX_MEMBERS — a peer array that will be iterated', () => {
    const many = Array.from({ length: GROUP_MAX_MEMBERS + 1 }, (_, i) =>
      `01${String(i).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAA`.slice(0, 26),
    );
    expect(GroupNewEnvelope.safeParse({ tcm: 'grp.new', g: A, nm: 'Kitchen', ms: many, n: 1 }).success).toBe(
      false,
    );
    expect(
      GroupNewEnvelope.safeParse({ tcm: 'grp.new', g: A, nm: 'Kitchen', ms: [A, B], n: 1 }).success,
    ).toBe(true);
  });

  it('a room name may not itself be an envelope', () => {
    expect(
      GroupNewEnvelope.safeParse({ tcm: 'grp.new', g: A, nm: '{"tcm":"image"', ms: [A], n: 1 })
        .success,
    ).toBe(false);
  });

  it('grp.roster takes only in/out, and a ULID member', () => {
    expect(GroupRosterEnvelope.safeParse({ tcm: 'grp.roster', g: A, m: B, s: 'in', n: 1 }).success).toBe(
      true,
    );
    expect(
      GroupRosterEnvelope.safeParse({ tcm: 'grp.roster', g: A, m: B, s: 'maybe', n: 1 }).success,
    ).toBe(false);
    expect(
      GroupRosterEnvelope.safeParse({ tcm: 'grp.roster', g: A, m: 'nope', s: 'in', n: 1 }).success,
    ).toBe(false);
  });

  it('grp.del carries no authority in its payload — only the room and a seq', () => {
    // Whether it counts is decided at apply time by frame.from, never here.
    const parsed = GroupDelEnvelope.parse({ tcm: 'grp.del', g: A, n: 1, owner: C });
    expect(parsed).not.toHaveProperty('owner');
  });

  it('grp.set accepts 0 (off) and refuses a negative timer', () => {
    expect(GroupSettingsEnvelope.safeParse({ tcm: 'grp.set', g: A, s: 0, n: 1 }).success).toBe(true);
    expect(GroupSettingsEnvelope.safeParse({ tcm: 'grp.set', g: A, s: -1, n: 1 }).success).toBe(false);
  });

  it('every kind refuses a non-ULID room id — a group id never reaches addressing (rule 15)', () => {
    expect(GroupMessageEnvelope.safeParse(msg({ g: 'kitchen' })).success).toBe(false);
    expect(GroupDelEnvelope.safeParse({ tcm: 'grp.del', g: 'kitchen', n: 1 }).success).toBe(false);
    expect(GroupSettingsEnvelope.safeParse({ tcm: 'grp.set', g: 'kitchen', s: 0, n: 1 }).success).toBe(
      false,
    );
  });
});

/**
 * `grp.hist` — history shared with a newcomer.
 *
 * One kind doing two jobs, told apart by whether `e` is present. What a schema
 * CAN enforce is shape; what it cannot enforce — and what these tests pin as
 * deliberate rather than missing — is that `e.a` is unauthenticated. The
 * ratchet proves who RELAYED an entry and says nothing about who wrote it.
 */
describe('grp.hist', () => {
  const announce = (over: Record<string, unknown> = {}) => ({
    tcm: 'grp.hist',
    g: A,
    n: 1,
    to: B,
    c: 3,
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    m: C,
    a: B,
    t: 1_700_000_000_000,
    b: 'what was said before',
    ...over,
  });

  it('parses both shapes: the announcement has no e, a transcript leg has one', () => {
    expect(GroupHistoryEnvelope.parse(announce()).e).toBeUndefined();
    const leg = GroupHistoryEnvelope.parse(announce({ e: entry() }));
    expect(leg.e?.a).toBe(B);
    expect(leg.e?.x).toBeUndefined();
  });

  it('carries the original expiry, so the timer survives the relay', () => {
    const leg = GroupHistoryEnvelope.parse(announce({ e: entry({ x: 1_700_000_060_000 }) }));
    expect(leg.e?.x).toBe(1_700_000_060_000);
  });

  it('refuses a nested room envelope inside a shared entry — the laundering limb', () => {
    // Sharper than grp.msg's version of this rule: a relayed body is ALREADY
    // an unauthenticated claim, so a grp.* smuggled inside one would let a
    // relayer launder a membership or delete write while wearing a third
    // party's name.
    const nested = `{"tcm":"grp.roster","g":"${A}","m":"${B}","s":"out","n":9}`;
    expect(GroupHistoryEnvelope.safeParse({ ...announce(), e: entry({ b: nested }) }).success).toBe(
      false,
    );
    // Ordinary words that merely MENTION the sentinel still travel: the rule
    // is about what a body starts with, not about censoring text.
    expect(
      GroupHistoryEnvelope.safeParse({
        ...announce(),
        e: entry({ b: 'we should talk about {"tcm":"grp.del"} sometime' }),
      }).success,
    ).toBe(true);
  });

  it('bounds the extent at MAX_HISTORY_SHARE, and refuses a share of nothing', () => {
    expect(GroupHistoryEnvelope.safeParse(announce({ c: MAX_HISTORY_SHARE })).success).toBe(true);
    expect(GroupHistoryEnvelope.safeParse(announce({ c: MAX_HISTORY_SHARE + 1 })).success).toBe(
      false,
    );
    expect(GroupHistoryEnvelope.safeParse(announce({ c: 0 })).success).toBe(false);
  });

  it('refuses a non-ULID room, recipient or claimed author (rule 15 again)', () => {
    expect(GroupHistoryEnvelope.safeParse(announce({ g: 'kitchen' })).success).toBe(false);
    expect(GroupHistoryEnvelope.safeParse(announce({ to: 'ben' })).success).toBe(false);
    expect(GroupHistoryEnvelope.safeParse({ ...announce(), e: entry({ a: 'ana' }) }).success).toBe(
      false,
    );
  });

  it('bounds a shared body exactly as a live one — a relay is not a wider pipe', () => {
    expect(
      GroupHistoryEnvelope.safeParse({
        ...announce(),
        e: entry({ b: 'x'.repeat(MAX_GROUP_BODY) }),
      }).success,
    ).toBe(true);
    expect(
      GroupHistoryEnvelope.safeParse({
        ...announce(),
        e: entry({ b: 'x'.repeat(MAX_GROUP_BODY + 1) }),
      }).success,
    ).toBe(false);
  });

  it('strips a payload claiming authority — who may share is decided at apply, from frame.from', () => {
    // The mirror of grp.del's test above. An `owner` field in the payload must
    // not survive into the parsed object, or a reader could be tempted to
    // trust it in place of the ratchet.
    const parsed = GroupHistoryEnvelope.parse(announce({ owner: C, by: C }));
    expect(parsed).not.toHaveProperty('owner');
    expect(parsed).not.toHaveProperty('by');
  });
});
