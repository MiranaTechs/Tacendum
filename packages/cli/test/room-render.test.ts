import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-render-'));
process.env.TACENDUM_HOME = home;

const { renderBody, maySpool, UNSUPPORTED_TEXT } = await import('../src/render.js');
const { groupBodyRenderer } = await import('../src/room-render.js');
const { FileGroupStore } = await import('../src/rooms.js');
const { FileStores } = await import('../src/stores.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { foldRoster, ownerOnlyPolicy, verdictFor } = await import(
  '@tacendum/shared/group-fold'
);

// Crockford base32 (no I, L, O, U) so the ids survive every ULID guard and
// the tests assert about the rules, not about the filters.
const ROOM = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC'; // the owner in every scenario
const BEN = '01DDDDDDDDDDDDDDDDDDDDDDDD'; // "this client" in every scenario
const CARA = '01EEEEEEEEEEEEEEEEEEEEEEEE';
const DAVE = '01FFFFFFFFFFFFFFFFFFFFFFFF';

/** Render one body as `client` (self = BEN), authenticated sender `from`. */
function render(client: string, from: string, body: string) {
  return renderBody(body, groupBodyRenderer(client, BEN, from));
}

const newRoom = JSON.stringify({
  tcm: 'grp.new',
  g: ROOM,
  nm: 'Kitchen',
  ms: [ANA, BEN, CARA],
  n: 1,
});

/** Anchor the standard room on a fresh client, through the real path. */
function anchor(client: string): void {
  render(client, ANA, newRoom);
}

const groupMsg = (b: string, m = MSG) =>
  JSON.stringify({ tcm: 'grp.msg', g: ROOM, m, b });

/**
 * the design plan: render parity. Every sentence here is the fold's
 * classification in the app's voice; every test is one rule that must not
 * silently stop holding. The renderer under test also APPLIES state, so
 * several tests assert on the room file the same event left behind — the
 * two must agree or the CLI shows a room it does not hold.
 */
describe('grp.msg — the wrapper unwrap', () => {
  it('renders the inner body through the SAME switch a 1:1 body uses', () => {
    const c = 'unwrap';
    anchor(c);
    // Text is text…
    const text = render(c, ANA, groupMsg('hello room'));
    expect(text.carrier).toBe(false);
    expect(text.text).toBe('[Kitchen] hello room');
    expect(text.innerTcm).toBe('');
    // …and an image inside a room is the SAME image branch a 1:1 image is:
    // the announcement, with the blob id and AES key withheld — if a second
    // copy of the switch ever grows here, this is the assertion that drifts.
    const img = render(
      c,
      ANA,
      groupMsg('{"tcm":"image","att":"ATT-ID","key":"AES-KEY","w":800,"h":600}'),
    );
    expect(img.text).toBe('[Kitchen] [photo 800x600]');
    expect(img.text).not.toContain('ATT-ID');
    expect(img.text).not.toContain('AES-KEY');
    expect(img.innerTcm).toBe('image');
    // A reply is its text, exactly as in 1:1.
    const reply = render(
      c,
      ANA,
      groupMsg('{"tcm":"reply","ref":"x","ofs":false,"text":"on my way"}'),
    );
    expect(reply.text).toBe('[Kitchen] on my way');
  });

  it('a mention in a room resolves against THIS client’s names: @you for self, never a ULID', () => {
    // Mention resolution, through the real inbound seam: the wire carries
    // ids (one U+FFFC mark per name), and this client — BEN — renders its
    // OWN names for them. Ana is named in the peer store; Cara is not, so
    // she is a placeholder rather than an id a terminal would memorise.
    const c = 'unwrap-mention';
    anchor(c);
    new FileStores(c).setPeerName(ANA, 'Ana');
    const mention = JSON.stringify({
      tcm: 'mention',
      text: '￼ and ￼ — standup is moved, ask ￼',
      who: [BEN, CARA, ANA],
    });
    const r = render(c, ANA, groupMsg(mention));
    expect(r.carrier).toBe(false);
    expect(r.text).toBe('[Kitchen] @you and @someone — standup is moved, ask @Ana');
    for (const id of [BEN, CARA, ANA]) expect(r.text).not.toContain(id);
    // A mention is conversation someone pointedly said: it spools, exactly
    // as plain words in a room do.
    expect(r.innerTcm).toBe('mention');
    expect(maySpool(r)).toBe(true);
  });

  it('an inner carrier stays a carrier: a room reaction is not a line of stdout', () => {
    const c = 'unwrap-carrier';
    anchor(c);
    const r = render(c, ANA, groupMsg('{"tcm":"react","ref":"x","ofs":false,"emoji":"+1"}'));
    expect(r.carrier).toBe(true);
    expect(r.text).toContain('reaction');
  });

  it('kinds with room-native counterparts are dropped quietly inside a wrapper', () => {
    const c = 'unwrap-native';
    anchor(c);
    // timer/vault/profile/read bypass the room lattice with a two-party
    // rule; the app refuses them at apply and so does this renderer.
    for (const inner of [
      '{"tcm":"timer","s":60,"v":1}',
      '{"tcm":"vault","op":"set","id":"x","title":"t","body":"hunter2","n":1,"k":0}',
      '{"tcm":"profile","n":"Mallory","a":"","v":1}',
      '{"tcm":"read","ids":["a"]}',
    ]) {
      const r = render(c, ANA, groupMsg(inner));
      expect(r.text).toBe('');
      expect(r.carrier).toBe(true);
    }
  });

  it('a nested grp.* is the laundering refusal: dropped, applying nothing', () => {
    const c = 'unwrap-nested';
    anchor(c);
    // Composed by hand because the schema refuses to compose one — the
    // receive side must hold on its own.
    const nested = `{"tcm":"grp.msg","g":"${ROOM}","m":"${MSG}","b":"{\\"tcm\\":\\"grp.roster\\",\\"g\\":\\"${ROOM}\\",\\"m\\":\\"${BEN}\\",\\"s\\":\\"out\\",\\"n\\":9}"}`;
    const r = render(c, CARA, nested);
    expect(r.text).toBe('');
    // The smuggled roster write must not have touched the fold.
    const store = FileGroupStore.load(c, ROOM);
    const fold = foldRoster(ANA, store.listSlots(), ownerOnlyPolicy);
    expect(verdictFor(fold, BEN)).toBe('in');
  });

  it('a message from a sender the fold says is OUT renders tagged, never silently dropped', () => {
    const c = 'outsider';
    anchor(c);
    // Dave was never admitted; his words still render, visibly tagged —
    // Removal is not simultaneous, and silent omission is the tell.
    const r = render(c, DAVE, groupMsg('am I still in here?'));
    expect(r.carrier).toBe(false);
    expect(r.text).toBe('[Kitchen] (isn’t in this room) am I still in here?');
  });

  it('a message for a room this client does not hold is discarded quietly', () => {
    const r = render('no-such-room', ANA, groupMsg('hello?'));
    expect(r.text).toBe('');
  });
});

describe('grp.new / grp.roster / grp.set / grp.del — room events in the app’s voice', () => {
  it('an accepted grp.new anchors the room and announces it, with the id the room commands take', () => {
    const c = 'anchor';
    const r = render(c, ANA, newRoom);
    expect(r.carrier).toBe(false);
    expect(r.text).toBe(`[Kitchen] [started this room — ${ROOM}]`);
    const store = FileGroupStore.load(c, ROOM);
    expect(store.getOwner()).toBe(ANA); // frame.from, never a payload field
    expect(store.getName()).toBe('Kitchen');
    // An exact replay announces nothing a second time.
    expect(render(c, ANA, newRoom).text).toBe('');
    // A forged re-anchor from a different writer is ignored whole.
    expect(render(c, CARA, newRoom).text).toBe('');
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBe(ANA);
  });

  it('counted roster writes render as the change they made; the sovereign lane speaks for itself', () => {
    const c = 'roster';
    anchor(c);
    const add = render(
      c,
      ANA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2 }),
    );
    expect(add.text).toBe(`[Kitchen] [added ${DAVE} to this room]`);
    const left = render(
      c,
      CARA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CARA, s: 'out', n: 1 }),
    );
    expect(left.text).toBe('[Kitchen] [left this room]');
    const removed = render(
      c,
      ANA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'out', n: 3 }),
    );
    expect(removed.text).toBe('[Kitchen] [removed you from this room]');
    // And the file agrees with every sentence above.
    const fold = foldRoster(
      ANA,
      FileGroupStore.load(c, ROOM).listSlots(),
      ownerOnlyPolicy,
    );
    expect(verdictFor(fold, DAVE)).toBe('in');
    expect(verdictFor(fold, CARA)).toBe('out');
    expect(verdictFor(fold, BEN)).toBe('out');
  });

  it('a NON-owner roster write renders as a declined, attributed row — never silently dropped', () => {
    const c = 'declined';
    anchor(c);
    const r = render(
      c,
      CARA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'out', n: 9 }),
    );
    // Provably dead the moment it arrived, and VISIBLE — nothing is
    // ever "not yet decidable", and nothing declined is ever swallowed.
    expect(r.carrier).toBe(false);
    expect(r.text).toBe(
      `[Kitchen] [tried to remove you — only the owner can change who is in this room]`,
    );
    // Declined stores no slot: Ben is still in.
    const fold = foldRoster(
      ANA,
      FileGroupStore.load(c, ROOM).listSlots(),
      ownerOnlyPolicy,
    );
    expect(verdictFor(fold, BEN)).toBe('in');
  });

  it('a replayed roster write announces NOTHING', () => {
    const c = 'stale';
    anchor(c);
    const body = JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2 });
    expect(render(c, ANA, body).text).not.toBe('');
    // The announce-only-when-applied rule: one old envelope must not become
    // an endless announcement stream.
    expect(render(c, ANA, body).text).toBe('');
  });

  it('grp.set announces only when applied, and 0 is "off", not a shorter timer', () => {
    const c = 'settings';
    anchor(c);
    const on = render(c, CARA, JSON.stringify({ tcm: 'grp.set', g: ROOM, s: 3600, n: 1 }));
    expect(on.text).toBe('[Kitchen] [set disappearing messages to 3600s]');
    expect(render(c, CARA, JSON.stringify({ tcm: 'grp.set', g: ROOM, s: 3600, n: 1 })).text).toBe(
      '',
    ); // replay: silence
    const off = render(c, CARA, JSON.stringify({ tcm: 'grp.set', g: ROOM, s: 0, n: 2 }));
    expect(off.text).toBe('[Kitchen] [turned their disappearing-message timer off]');
  });

  it('a NON-owner grp.del renders declined and changes nothing; the owner’s purges the room', () => {
    const c = 'del';
    anchor(c);
    const declined = render(c, CARA, JSON.stringify({ tcm: 'grp.del', g: ROOM, n: 5 }));
    expect(declined.carrier).toBe(false);
    expect(declined.text).toBe(
      '[Kitchen] [tried to delete this room for everyone — only the owner can]',
    );
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBe(ANA); // intact
    const purged = render(c, ANA, JSON.stringify({ tcm: 'grp.del', g: ROOM, n: 6 }));
    expect(purged.text).toBe('[Kitchen] [deleted this room for everyone]');
    // The full purge: the client no longer holds the room…
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBeUndefined();
    // …and later traffic for its groupId is discarded quietly.
    expect(render(c, ANA, groupMsg('anyone?')).text).toBe('');
  });
});

describe('grp.hist — announcements are room events; transcript entries are CLAIMS', () => {
  const announcement = JSON.stringify({ tcm: 'grp.hist', g: ROOM, n: 4, to: BEN, c: 50 });
  const entry = (b: string, x?: number) =>
    JSON.stringify({
      tcm: 'grp.hist',
      g: ROOM,
      n: 4,
      to: BEN,
      c: 50,
      e: { m: MSG, a: CARA, t: 1234, ...(x === undefined ? {} : { x }), b },
    });

  it('the owner’s announcement renders counted; a non-owner’s renders declined', () => {
    const c = 'hist-ann';
    anchor(c);
    expect(render(c, ANA, announcement).text).toBe(
      '[Kitchen] [shared 50 earlier messages with you]',
    );
    expect(render(c, CARA, announcement).text).toBe(
      '[Kitchen] [tried to share 50 earlier messages with you — only the owner can share this room’s history]',
    );
  });

  it('a transcript entry NEVER renders as if the claimed author sent it', () => {
    const c = 'hist-entry';
    anchor(c);
    const r = render(c, ANA, entry('the deal is at 9'));
    expect(r.carrier).toBe(false);
    // The ratchet authenticated ANA (the relayer) and says NOTHING about
    // CARA (the claim). The line must say whose account this is — the app's
    // sharedTag framing, matched in meaning: a dishonest relayer could have
    // written every word.
    expect(r.text).toBe(
      `[Kitchen] shared this — ${CARA} wrote it, if ${ANA}’s copy is right: the deal is at 9`,
    );
    // The words must not stand alone as a plain attributed message.
    expect(r.text).not.toBe('[Kitchen] the deal is at 9');
  });

  it('a relayed photo runs the same photo branch — never the unsupported notice', () => {
    const c = 'hist-photo';
    anchor(c);
    const r = render(c, ANA, entry('{"tcm":"image","att":"A","key":"K","w":4,"h":3}'));
    // The app shipped exactly this defect once: relayed non-text rendered as
    // "update Tacendum" once per photo. The unwrap recursion is the fix.
    expect(r.text).toContain('[photo 4x3]');
    expect(r.text).not.toContain(UNSUPPORTED_TEXT);
    expect(r.text).not.toContain('"K"');
  });

  it('a transcript entry from a NON-owner renders as a declined share, and its words render nowhere', () => {
    const c = 'hist-forge';
    anchor(c);
    const r = render(c, CARA, entry('forged history'));
    expect(r.text).toContain('tried to share');
    expect(r.text).not.toContain('forged history');
  });

  it('an entry the timer already took stays gone — checked against MY clock', () => {
    const c = 'hist-expired';
    anchor(c);
    const r = render(c, ANA, entry('should have burned', Date.now() - 1));
    expect(r.text).toBe('');
    // An unexpired one still renders.
    expect(render(c, ANA, entry('still alive', Date.now() + 60_000)).text).toContain(
      'still alive',
    );
  });
});

describe('grp.consent — the member-consent announcement', () => {
  const consent = (a: string, s: 'share' | 'hold', n = 1) =>
    JSON.stringify({ tcm: 'grp.consent', g: ROOM, a, s, n });
  // The subject `a` is an AGENT-CLASS room co-member. Since the roster-class
  // ruling the CLI holds the same marker-OR-class signal the
  // app's handleGroupConsent reads, so the old member-only ceiling — the
  // recorded residual under which a stance about a NON-agent co-member still
  // rendered — is closed: the subject must be a member AND (fold-classed
  // 'integration' OR heard AI-marked here). Scenarios therefore admit the
  // agent WITH the owner's class claim.
  const admit = (c: string, id: string, n = 2, cls?: 'integration') =>
    render(
      c,
      ANA,
      JSON.stringify({
        tcm: 'grp.roster',
        g: ROOM,
        m: id,
        s: 'in',
        n,
        ...(cls !== undefined ? { c: cls } : {}),
      }),
    );

  it('a member’s own stance about a CLASS-marked agent member renders as the sentence', () => {
    const c = 'consent';
    anchor(c); // room [ANA, BEN, CARA], owner ANA
    admit(c, DAVE, 2, 'integration'); // the owner's write says what DAVE is
    // CARA (a member) shares with, then holds back from, DAVE (the agent). The
    // subject is the authenticated writer, carried by the caller's [from]
    // prefix (the roster case's rule), so the sentence is object-focused.
    expect(render(c, CARA, consent(DAVE, 'share')).text).toBe(
      `[Kitchen] [is sharing with ${DAVE}]`,
    );
    expect(render(c, CARA, consent(DAVE, 'hold', 2)).text).toBe(
      `[Kitchen] [isn’t sharing with ${DAVE}]`,
    );
  });

  it('a stance about a MARKER-heard agent member renders too — pre-field rooms keep their sentence', () => {
    const c = 'consent-marker';
    anchor(c);
    admit(c, DAVE); // unclassed roster (an old-build owner)…
    new FileStores(c); // ensure the client dir exists for the spool
    // …but this client HAS heard DAVE speak AI-marked in this room.
    new MessageLog(c).append({
      id: '01AGENTROWAAAAAAAAAAAAAA01',
      dir: 'in',
      peer: DAVE,
      ts: Date.now(),
      tcm: 'grp.msg',
      text: 'hi',
      read: true,
      grp: ROOM,
      ai: true,
    });
    expect(render(c, CARA, consent(DAVE, 'share')).text).toBe(
      `[Kitchen] [is sharing with ${DAVE}]`,
    );
  });

  it('once ANY class exists, a stance about a NON-AGENT co-member renders NOTHING — the ceiling is closed', () => {
    const c = 'consent-nonagent';
    anchor(c);
    admit(c, DAVE, 2, 'integration'); // the room HAS a classed agent…
    // …so the strict gate applies: CARA and BEN are genuine members, but a
    // stance naming the un-classed, never-marked BEN is meaningless and a
    // spoof vector ("Mallory isn't sharing with Bob") — dropped, as the app
    // drops it. Remove the strict gate and this reddens.
    expect(render(c, CARA, consent(BEN, 'hold')).text).toBe('');
    expect(render(c, CARA, consent(BEN, 'share')).text).toBe('');
  });

  it('a room whose fold carries NO class keeps the member-only ceiling — the legitimate stance still renders', () => {
    const c = 'consent-classless';
    anchor(c);
    admit(c, DAVE); // an old-build or fresh-CLI owner: no class was ever written
    // No marker either: pre-consent the agent structurally CANNOT have spoken
    // to this client (the server refuses those legs), so member ∧ (class ∨
    // marker) would render NOTHING legitimate in this room — the deadlock
    // shape again, at the render seam. The fallback keeps the pre-ruling
    // member-only ceiling until the owner's first class write arrives.
    // Delete the class-less fallback and this reddens.
    expect(render(c, CARA, consent(DAVE, 'share')).text).toBe(
      `[Kitchen] [is sharing with ${DAVE}]`,
    );
    expect(render(c, CARA, consent(DAVE, 'hold', 2)).text).toBe(
      `[Kitchen] [isn’t sharing with ${DAVE}]`,
    );
  });

  it('a stance about a subject who is NOT a room member is DROPPED — a spoofed line about an arbitrary account renders nothing', () => {
    const c = 'consent-spoof';
    anchor(c); // DAVE is NOT admitted
    // CARA is a genuine member, but the SUBJECT — DAVE — is not in
    // [ANA, BEN, CARA]. Membership is still the floor: a class or marker for
    // a non-member could not save the line, and none exists anyway.
    expect(render(c, CARA, consent(DAVE, 'hold')).text).toBe('');
    expect(render(c, CARA, consent(DAVE, 'share')).text).toBe('');
  });

  it('a NON-member cannot narrate the room’s sharing — nothing renders', () => {
    const c = 'consent-nonmember';
    anchor(c);
    admit(c, DAVE, 2, 'integration'); // a genuine agent member as the subject
    // The WRITER is the outsider here: a stranger who learned the gid.
    const STRANGER = '01GGGGGGGGGGGGGGGGGGGGGGGG';
    expect(render(c, STRANGER, consent(DAVE, 'hold')).text).toBe('');
  });

  it('an unanchored room says nothing — no surface to announce into', () => {
    expect(render('consent-unknown', CARA, consent(DAVE, 'share')).text).toBe('');
  });

  it('is not spooled and is not a carrier — an announcement, never conversation', () => {
    const c = 'consent-spool';
    anchor(c);
    admit(c, DAVE, 2, 'integration'); // a genuine agent member, so the line renders
    const r = render(c, CARA, consent(DAVE, 'hold'));
    expect(r.carrier).toBe(false);
    expect(maySpool(r)).toBe(false);
  });
});

describe('the roster class rides the apply — grp.new ic and grp.roster c (ruling)', () => {
  it('a grp.new carrying ic classes the seed slots this client folds', () => {
    const c = 'class-new';
    render(
      c,
      ANA,
      JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [ANA, BEN, CARA], n: 1, ic: [CARA] }),
    );
    const fold = foldRoster(ANA, FileGroupStore.load(c, ROOM).listSlots(), ownerOnlyPolicy);
    expect(fold.classes[CARA]).toBe('integration');
    expect(fold.classes[BEN]).toBeUndefined();
  });

  it('an OWNER grp.roster carrying c classes the added member', () => {
    const c = 'class-roster';
    anchor(c);
    render(
      c,
      ANA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2, c: 'integration' }),
    );
    const fold = foldRoster(ANA, FileGroupStore.load(c, ROOM).listSlots(), ownerOnlyPolicy);
    expect(fold.classes[DAVE]).toBe('integration');
  });

  it('a NON-owner write carrying c moves no class — the fold ignores every non-authority claim', () => {
    const c = 'class-selfclaim';
    anchor(c);
    // CARA's own sovereign rejoin, self-classed: the slot may store, the
    // class must never surface — nobody classes themselves (or anyone) but
    // the owner.
    render(
      c,
      CARA,
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CARA, s: 'in', n: 5, c: 'integration' }),
    );
    const fold = foldRoster(ANA, FileGroupStore.load(c, ROOM).listSlots(), ownerOnlyPolicy);
    expect(fold.classes[CARA]).toBeUndefined();
  });
});

describe('the CLI never prints a raw envelope', () => {
  it('no room body — valid, malformed, unknown, or future-shaped — ever renders its JSON', () => {
    const c = 'no-raw';
    anchor(c);
    const bodies = [
      newRoom,
      groupMsg('hello'),
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2 }),
      JSON.stringify({ tcm: 'grp.set', g: ROOM, s: 60, n: 3 }),
      JSON.stringify({ tcm: 'grp.hist', g: ROOM, n: 4, to: BEN, c: 1 }),
      JSON.stringify({ tcm: 'grp.del', g: ROOM, n: 5 }),
      '{"tcm":"grp.msg","g":"not-a-ulid","m":1}', // malformed
      '{"tcm":"grp.msg","g":', // truncated
      `{"tcm":"grp.future","g":"${ROOM}","payload":"SECRET-SHAPE"}`, // future kind
    ];
    for (const body of bodies) {
      const r = render(c, ANA, body);
      expect(r.text).not.toContain('{"tcm"');
      expect(r.text).not.toContain('SECRET-SHAPE');
    }
  });

  it('a future room kind renders the visible unsupported notice, not silence and not JSON', () => {
    const c = 'future-kind';
    anchor(c);
    const r = render(c, ANA, `{"tcm":"grp.future","g":"${ROOM}"}`);
    expect(r.text).toBe(`[${UNSUPPORTED_TEXT}]`);
  });

  it('a surface with no room context still never dumps JSON for a room kind', () => {
    // renderBody with NO injected renderer: the no-context degradation path,
    // which must stay a notice, never raw JSON.
    const r = renderBody(groupMsg('hello'));
    expect(r.text).toBe(`[${UNSUPPORTED_TEXT}]`);
    expect(r.text).not.toContain('{"tcm"');
  });
});

describe('what reaches the durable spool', () => {
  it('room TEXT spools; room events, carriers and transcript claims do not', () => {
    const c = 'spool';
    anchor(c);
    expect(maySpool(render(c, ANA, groupMsg('hello room')))).toBe(true);
    expect(maySpool(render(c, ANA, newRoom))).toBe(false);
    expect(
      maySpool(
        render(c, ANA, JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAVE, s: 'in', n: 2 })),
      ),
    ).toBe(false);
    expect(
      maySpool(render(c, ANA, groupMsg('{"tcm":"react","ref":"x","ofs":false,"emoji":"+1"}'))),
    ).toBe(false);
    // A transcript entry is an UNAUTHENTICATED claim; the spool has no
    // provenance column, so the claim never reaches it.
    expect(
      maySpool(
        render(
          c,
          ANA,
          JSON.stringify({
            tcm: 'grp.hist',
            g: ROOM,
            n: 4,
            to: BEN,
            c: 1,
            e: { m: MSG, a: CARA, t: 1, b: 'claimed words' },
          }),
        ),
      ),
    ).toBe(false);
  });
});

describe('PEOPLE in room sentences resolve through the stored names', () => {
  // The mention arm's rule ("an id means nothing to a human"), applied to
  // the roster and history sentences that used to print bare ULIDs beside
  // it. The id remains the fallback — on this surface it is the operable
  // token — so every earlier test in this file, whose fixtures store no
  // names, pins that fallback unchanged.
  const rosterAdd = JSON.stringify({
    tcm: 'grp.roster',
    g: ROOM,
    m: DAVE,
    s: 'in',
    n: 2,
  });
  const histEntry = JSON.stringify({
    tcm: 'grp.hist',
    g: ROOM,
    n: 4,
    to: BEN,
    c: 50,
    e: { m: MSG, a: CARA, t: 1234, b: 'the deal is at 9' },
  });

  it('a stored name replaces the ULID in roster sentences', () => {
    const c = 'names-roster';
    anchor(c);
    new FileStores(c).setPeerName(DAVE, 'Dave Okafor');
    const add = render(c, ANA, rosterAdd);
    expect(add.text).toBe('[Kitchen] [added Dave Okafor to this room]');
    expect(add.text).not.toContain(DAVE);
  });

  it('history lines name the claimed author, the relayer, and the share target', () => {
    const c = 'names-hist';
    anchor(c);
    const s = new FileStores(c);
    s.setPeerName(ANA, 'Ana');
    s.setPeerName(CARA, 'Cara');
    // The claim FRAMING survives resolution — the caveat is the sentence
    // shape, not the rawness of the ids.
    const r = render(c, ANA, histEntry);
    expect(r.text).toBe(
      '[Kitchen] shared this — Cara wrote it, if Ana’s copy is right: the deal is at 9',
    );
    const ann = render(
      c,
      ANA,
      JSON.stringify({ tcm: 'grp.hist', g: ROOM, n: 5, to: CARA, c: 3 }),
    );
    expect(ann.text).toBe('[Kitchen] [shared 3 earlier messages with Cara]');
  });

  it('a peer self-named "you" is refused the slot — the id is at least honestly nobody’s name', () => {
    // In these sentences a bare "you" IS the self signal: "[added you to
    // this room]" must not be forgeable by a profile card. The mention arm
    // tolerates such a name only behind its @.
    const c = 'names-forged';
    anchor(c);
    new FileStores(c).setPeerName(DAVE, 'you');
    const add = render(c, ANA, rosterAdd);
    expect(add.text).toBe(`[Kitchen] [added ${DAVE} to this room]`);
  });
});

describe('the agent-side wall — a bound integration anchors rooms from its OWNER alone (the consent remediation)', () => {
  function saveAgentProfile(name: string, ownerUserId?: string): void {
    saveProfile({
      name, identityKey: 'AAAA', userId: BEN,
      deviceId: 1, authToken: 'tok', registrationId: 1,
      accountClass: 'integration',
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
    });
  }

  it('a grp.new from a NON-owner is refused loudly and anchors NOTHING — a consented stranger cannot build a room inside the agent', () => {
    const c = 'agent-wall';
    saveAgentProfile(c, ANA); // bound to ANA
    const r = render(c, CARA, newRoom); // CARA is not the agent's owner
    expect(r.carrier).toBe(false);
    expect(r.text).toContain('refused');
    expect(r.text).toContain('joins only');
    // Nothing applied: the gid stays unanchored, so the stranger's
    // follow-up room traffic renders as silence, not as a room.
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBeUndefined();
    expect(render(c, CARA, groupMsg('into the void')).text).toBe('');
    // And the refusal is a room EVENT, never spooled conversation.
    expect(maySpool(r)).toBe(false);
  });

  it('the OWNER’s grp.new anchors exactly as before — the wall gates senders, not the feature', () => {
    const c = 'agent-owner-ok';
    saveAgentProfile(c, ANA);
    const r = render(c, ANA, newRoom);
    expect(r.text).toBe(`[Kitchen] [started this room — ${ROOM}]`);
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBe(ANA);
  });

  it('an UNBOUND integration anchors nothing from anyone (fail closed: no owner, no rooms)', () => {
    const c = 'agent-unbound';
    saveAgentProfile(c); // integration class, no ownerUserId
    const r = render(c, ANA, newRoom);
    expect(r.text).toContain('refused');
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBeUndefined();
  });

  it('a HUMAN client is untouched: anyone may still invite a human (today’s behaviour, byte-identical)', () => {
    const c = 'human-unwalled';
    saveProfile({
      name: c, identityKey: 'AAAA', userId: BEN,
      deviceId: 1, authToken: 'tok', registrationId: 1,
    });
    const r = render(c, CARA, JSON.stringify({
      tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [CARA, BEN], n: 1,
    }));
    expect(r.text).toBe(`[Kitchen] [started this room — ${ROOM}]`);
    expect(FileGroupStore.load(c, ROOM).getOwner()).toBe(CARA);
  });
});
