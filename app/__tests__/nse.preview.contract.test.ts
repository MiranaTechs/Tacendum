import {
  MENTION_MARK,
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  previewFor,
  parseEnvelope,
  UNSUPPORTED_TEXT,
} from '../src/envelope';
import * as crypto from 'tacendum-crypto';
import { clearBadge, syncBadge } from '../src/badge';
import * as db from '../src/db';

jest.mock('../src/db', () => ({ unreadCounts: jest.fn() }));

// `require` rather than `import`, exactly as nse.blocked.suppress.test.ts and
// privacy.manifest.test.ts pin ios/ artifacts: the app's tsconfig carries
// `types: ["jest"]` only, so node's modules are absent from the type
// environment even though they exist at runtime under Jest.
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };
declare const __dirname: string;
const artifact = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

/**
 * THE LOCK-SCREEN CONTRACT.
 *
 * `NotificationService.swift` cannot run under jest, and `previewFor` cannot
 * run inside the extension, so the agreement between them cannot be executed
 * in one place. What CAN be executed is the TypeScript half: the table below
 * is a transcript of the Swift `classify` switch — every outcome that file
 * can produce, keyed by the body that produces it — and each row is asserted
 * against `envelope.ts` as the oracle. An app-side change that would make the
 * lock screen say MORE than the thread (a renamed constant, a kind leaving
 * the carrier set, a schema loosened under the Swift guard) fails here and
 * names the Swift file, instead of shipping as a silent disagreement.
 *
 * WHAT THIS DOES AND DOES NOT PROVE, plainly: it proves `envelope.ts` still
 * honours every claim the Swift switch was written against. It cannot prove
 * the Swift still matches its own transcript — that half needs a device (the row "Group banner attribution from a real push"). Keeping the table
 * literal is what makes the device check a comparison rather than an
 * investigation.
 *
 * The Swift's five outcomes:
 *   silent    transport — no banner may carry it (delivered as the untouched
 *             server fallback). The oracle must agree exactly: carrier, and
 *             an empty preview.
 *   constant  a FIXED string at level .full. The oracle must agree exactly.
 *   text      a plain 1:1 body shown verbatim. The oracle must agree exactly.
 *   generic   the server's generic body — the extension shows nothing. The
 *             one always-permitted direction; the oracle owes only the shared
 *             floor (no raw envelope JSON).
 *   mention   the FIXED constant "Mentioned you", produced only when the
 *             body's `who` contains the id the device decrypts as
 *             (`classify(_:depth:selfId:)` — the mentions contract), and only
 *             surfaced at level .full. The app previews the mention's WORDS
 *             with names resolved, so this is a divergence in the permitted
 *             direction: the extension names the fact, the app shows the
 *             words. The oracle owes a real conversation preview — non-empty
 *             and not the unsupported notice, or the extension would be
 *             saying MORE than the app — with no ULID and no surviving mark.
 *   words     the `msg` wrapper's OWN text, shown verbatim at level .full
 *             (a remediation): the agent's bare words gained an
 *             envelope for the AI marker, and the owner who attested
 *             `--marker` must not lose the lock-screen words the un-attested
 *             posture shows. 1:1 and depth 0 only — in a room the
 *             fixed-constants rule holds and the row is `generic`.
 *             The oracle owes byte-exact agreement: the app previews the
 *             same words.
 */

const G = '01GGGGGGGGGGGGGGGGGGGGGGGG';
const M = '01MMMMMMMMMMMMMMMMMMMMMMMM';
const RD = 'M+TFhub/mmM';
const RAW = '{"tcm":';

const grpMsg = (b: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ tcm: 'grp.msg', g: G, m: M, rd: RD, b, ...over });

/** Bodies built through encodeEnvelope are bodies the app itself would
 * compose — validity is the schema's own claim, not this file's. */
const image = encodeEnvelope({ tcm: 'image', att: 'a', key: 'k', w: 4, h: 3 });
const file = encodeEnvelope({
  tcm: 'file',
  att: 'a',
  key: 'k',
  name: 'lease.pdf',
  size: 1024,
  mime: 'application/pdf',
});
const loc = encodeEnvelope({ tcm: 'loc', lat: 9.03, lng: 38.74 });
const react = encodeEnvelope({ tcm: 'react', ref: 'm1', ofs: false, emoji: '👍' });
const edit = encodeEnvelope({ tcm: 'edit', ref: 'm1', text: 'better words' });
const del = encodeEnvelope({ tcm: 'del', ref: 'm1' });
const read = encodeEnvelope({ tcm: 'read', ids: ['m1'] });
const profile = encodeEnvelope({ tcm: 'profile', n: 'Ana', a: '', v: 1 });
const vault = encodeEnvelope({ tcm: 'vault', op: 'del', id: M, n: 1, k: 0 });
const reply = encodeEnvelope({ tcm: 'reply', ref: 'm1', ofs: false, text: 'yes' });

/** The id the device decrypts as (`PreviewPolicy.selfUserId`). The Swift's
 * mention rows are keyed by `classify(body, selfId: SELF)`: the SAME body is
 * `mention` when `who` names SELF and `generic` when it names someone else,
 * which is the whole meaning of the kind. */
const SELF = '01SSSSSSSSSSSSSSSSSSSSSSSS';
const mentionOfMe = encodeEnvelope({
  tcm: 'mention',
  text: `${MENTION_MARK} take a look at this`,
  who: [SELF],
});
const mentionOfOther = encodeEnvelope({
  tcm: 'mention',
  text: `${MENTION_MARK} take a look at this`,
  who: [M],
});
/** The agent-text wrapper — the marked bare words. */
const agentMsg = encodeEnvelope({ tcm: 'msg', text: 'the build is green', ai: true });

type Row = readonly [
  name: string,
  body: string,
  swift:
    | { outcome: 'silent' }
    | { outcome: 'constant'; shown: string }
    | { outcome: 'text' }
    | { outcome: 'generic' }
    | { outcome: 'mention' }
    | { outcome: 'words'; shown: string },
];

/** The transcript. One row per branch of `classify` — 1:1 and room. */
const TABLE: readonly Row[] = [
  // -- plain text passes through, in a 1:1 -------------------------------
  ['a plain text', 'coffee at nine?', { outcome: 'text' }],
  [
    'a text QUOTING the format mid-sentence is a text, not an unwrap',
    'the app sent me {"tcm":"grp.msg"} once',
    { outcome: 'text' },
  ],
  // -- fixed constants, 1:1 ----------------------------------------------
  ['an image', image, { outcome: 'constant', shown: 'Photo' }],
  ['a file', file, { outcome: 'constant', shown: 'Document' }],
  ['a location', loc, { outcome: 'constant', shown: 'Location' }],
  // -- the carrier set, 1:1 -------------------------------------------
  ['a reaction', react, { outcome: 'silent' }],
  ['an edit', edit, { outcome: 'silent' }],
  ['a retraction', del, { outcome: 'silent' }],
  ['a read receipt', read, { outcome: 'silent' }],
  ['a profile card', profile, { outcome: 'silent' }],
  // -- transport namespaces, routed on the prefix BEFORE parsing ---------
  ['call signalling, truncated', '{"tcm":"call.offer","sdp":"x', { outcome: 'silent' }],
  ['x., a shape no build has seen', '{"tcm":"x.handoff","p":{"deep', { outcome: 'silent' }],
  ['x., well-formed', '{"tcm":"x.ack"}', { outcome: 'silent' }],
  // -- rooms: a grp.msg previews as what it wraps ------------------------
  ['a photo in a room', grpMsg(image), { outcome: 'constant', shown: 'Photo' }],
  ['a document in a room', grpMsg(file), { outcome: 'constant', shown: 'Document' }],
  ['a location in a room', grpMsg(loc), { outcome: 'constant', shown: 'Location' }],
  // -- rooms: carriers stay carriers (the recursion) ------------------
  ['a reaction in a room', grpMsg(react), { outcome: 'silent' }],
  ['an edit in a room', grpMsg(edit), { outcome: 'silent' }],
  ['a retraction in a room', grpMsg(del), { outcome: 'silent' }],
  ['a read receipt in a room', grpMsg(read), { outcome: 'silent' }],
  ['x. inside a room', grpMsg('{"tcm":"x.ack"}'), { outcome: 'silent' }],
  ['call. inside a room', grpMsg('{"tcm":"call.end"}'), { outcome: 'silent' }],
  // -- rooms: the deliberate divergences, both in the permitted direction -
  // Plain words in a room: the app previews the words; the extension shows
  // the generic body, because it cannot re-run the schema that decides
  // whether the app will ("never the body"). Asserted as `generic`
  // plus the explicit oracle check below that the app DOES show the words —
  // pinning that the divergence points the allowed way (extension < app).
  ['words in a room', grpMsg('see you at nine'), { outcome: 'generic' }],
  ['a voice note in a room', grpMsg(encodeEnvelope({ tcm: 'voice', att: 'a', key: 'k', dur: 3 })), { outcome: 'generic' }],
  ['a reply in a room', grpMsg(reply), { outcome: 'generic' }],
  ['a vault change in a room', grpMsg(vault), { outcome: 'generic' }],
  // The four announced room kinds: the app shows their fixed lines, the
  // extension shows the generic body — less, never more.
  ['a new room', JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 }), { outcome: 'generic' }],
  ['a roster change', JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'in', n: 1 }), { outcome: 'generic' }],
  ['a room deletion', JSON.stringify({ tcm: 'grp.del', g: G, n: 1 }), { outcome: 'generic' }],
  ['a room timer', JSON.stringify({ tcm: 'grp.set', g: G, s: 30, n: 1 }), { outcome: 'generic' }],
  // -- structure the extension never names --------------------------------
  ['a vault change 1:1', vault, { outcome: 'generic' }],
  ['a reply 1:1', reply, { outcome: 'generic' }],
  ['an unknown kind', '{"tcm":"xylophone"}', { outcome: 'generic' }],
  // -- mentions (the mentions contract): the reason the kind exists is the
  // banner. Keyed by `classify(body, selfId: SELF)`: the SAME words are
  // `mention` when `who` names this device's owner and `generic` when they
  // name somebody else — the extension never spends a word on other
  // people's mentions, exactly as it never shows other content bits.
  ['a mention of ME, 1:1', mentionOfMe, { outcome: 'mention' }],
  ['a mention of ME in a room', grpMsg(mentionOfMe), { outcome: 'mention' }],
  ['a mention of somebody else, 1:1', mentionOfOther, { outcome: 'generic' }],
  ['a mention of somebody else in a room', grpMsg(mentionOfOther), { outcome: 'generic' }],
  // -- the agent-text wrapper (a remediation) ----------------
  // 1:1 at .full the WORDS show — attesting --marker must not strip the
  // lock-screen words bare text shows today. In a room the design
  // fixed-constants rule holds: generic, exactly like bare words in a room.
  ['an agent msg, 1:1', agentMsg, { outcome: 'words', shown: 'the build is green' }],
  ['an agent msg in a room', grpMsg(agentMsg), { outcome: 'generic' }],
];

describe('the transcript agrees with envelope.ts, row by row', () => {
  it.each(TABLE.map(r => [r[0], r[1], r[2]] as const))(
    '%s',
    (_name, body, swift) => {
      switch (swift.outcome) {
        case 'silent':
          // The app renders nothing for transport — no row, no preview — so
          // a banner would be the extension inventing what the app withheld.
          expect(isCarrierEnvelope(body)).toBe(true);
          expect(previewFor(body)).toBe('');
          expect(displayText(body)).toBe('');
          break;
        case 'constant':
          // Byte-exact: the lock screen and the chat list must use one word.
          expect(previewFor(body)).toBe(swift.shown);
          break;
        case 'text':
          // Only a body with no sentinel prefix may pass through, and the
          // app must preview exactly the same bytes.
          expect(body.startsWith(RAW)).toBe(false);
          expect(previewFor(body)).toBe(body);
          break;
        case 'generic':
          // The always-permitted direction — the extension shows nothing.
          // The oracle owes only the shared floor, asserted for every row
          // below: no raw envelope JSON anywhere.
          break;
        case 'words':
          // Byte-exact, the constant rule applied to words: the lock screen
          // and the chat list must show the same text, and displayText (the
          // thread's own rendering) must agree — the extension may never say
          // what the app will not.
          expect(previewFor(body)).toBe(swift.shown);
          expect(displayText(body)).toBe(swift.shown);
          expect(parseEnvelope(body)).not.toBeNull();
          break;
        case 'mention': {
          // The Swift shows the FIXED constant "Mentioned you" — surfaced
          // only at .full, where the render step may compose it with the
          // app-mirror's name for the AUTHENTICATED sender ("Ana mentioned
          // you"): mirror bytes plus a constant, never a payload byte. The
          // app previews the WORDS with names resolved, so the divergence
          // points the permitted way. The oracle owes: a real, non-empty
          // conversation preview (an envelope the app refused would make
          // "Mentioned you" say MORE than the thread), with no ULID and no
          // surviving mark on the line.
          const p = previewFor(body);
          expect(parseEnvelope(body)).not.toBeNull();
          expect(isCarrierEnvelope(body)).toBe(false);
          expect(p).not.toBe('');
          expect(p).not.toBe(UNSUPPORTED_TEXT);
          expect(p.includes(SELF)).toBe(false);
          expect(p.includes(MENTION_MARK)).toBe(false);
          break;
        }
      }
      // The floor every outcome shares, and the bug that has shipped twice:
      // no raw {"tcm": may ever open a preview line, whatever else happens.
      expect(previewFor(body).startsWith(RAW)).toBe(false);
      expect(displayText(body).startsWith(RAW)).toBe(false);
    },
  );

  it('the divergent room rows diverge in the PERMITTED direction — the app shows at least as much', () => {
    // Precondition-first (the vacuous-fixture trap): these must be rows the
    // app really does preview, or "the extension shows less" proves nothing.
    expect(previewFor(grpMsg('see you at nine'))).toBe('see you at nine');
    expect(previewFor(JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 }))).toBe(
      'New group',
    );
    expect(previewFor(JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'in', n: 1 }))).toBe(
      'Members changed',
    );
    expect(previewFor(JSON.stringify({ tcm: 'grp.del', g: G, n: 1 }))).toBe('Room deleted');
  });
});

describe('the strict half of the wire schema, as the Swift guard mirrors it', () => {
  // Each of these is refused WHOLE by the app's parser, so the Swift guard
  // refuses it a room title: the thread will say "Unsupported message" and a
  // lock screen that had said "Photo" — or shown the room's name — would
  // have said more than the app. One row per clause of the guard.
  const refused: ReadonlyArray<[string, string]> = [
    ['a short g', grpMsg(image, { g: '01SHORT' })],
    ['a short m', grpMsg(image, { m: '01SHORT' })],
    ['a missing m', grpMsg(image, { m: undefined })],
    ['an empty body', grpMsg('')],
    ['an oversized body', grpMsg('a'.repeat(20_001))],
    ['a nested room envelope', grpMsg(grpMsg('inner'))],
    ['a negative sq', grpMsg(image, { sq: -1 })],
    ['a fractional sq', grpMsg(image, { sq: 1.5 })],
    ['a boolean sq', grpMsg(image, { sq: true })],
    // The mention guard's clauses (the mentions contract), one row each:
    // every one of these is refused WHOLE by `MentionEnvelope`, so the
    // thread will say "Unsupported message" and a lock screen that said
    // "Mentioned you" about it would have said more than the app.
    [
      'a mention of nobody',
      JSON.stringify({ tcm: 'mention', text: `${MENTION_MARK} hi`, who: [] }),
    ],
    [
      'a mention of a crowd (13 > GROUP_MAX_MEMBERS)',
      JSON.stringify({
        tcm: 'mention',
        text: `${MENTION_MARK} hi`,
        who: Array.from({ length: 13 }, (_, i) => `01${'A'.repeat(23)}${'0123456789ABC'[i]}`),
      }),
    ],
    [
      'a mention whose id is not an id',
      JSON.stringify({ tcm: 'mention', text: `${MENTION_MARK} hi`, who: ['not-a-ulid'] }),
    ],
    [
      'a mention whose who is not even a list',
      JSON.stringify({ tcm: 'mention', text: `${MENTION_MARK} hi`, who: SELF }),
    ],
    ['a mention with no words', JSON.stringify({ tcm: 'mention', text: '', who: [SELF] })],
    [
      'a mention whose words are an envelope',
      JSON.stringify({ tcm: 'mention', text: '{"tcm":"shot"}', who: [SELF] }),
    ],
    // The msg guard's clauses (mirroring AgentTextEnvelope's strict
    // half), one row each — refused WHOLE by the app's parser, so the Swift
    // guard must show the generic body, never the words.
    ['a msg with no words', JSON.stringify({ tcm: 'msg', text: '', ai: true })],
    [
      'a msg whose words are an envelope',
      JSON.stringify({ tcm: 'msg', text: '{"tcm":"shot"}', ai: true }),
    ],
    [
      'an oversized msg (20 001 > MAX_AGENT_TEXT)',
      JSON.stringify({ tcm: 'msg', text: 'a'.repeat(20_001), ai: true }),
    ],
  ];

  it.each(refused)('%s refuses the whole envelope on both sides', (_name, body) => {
    expect(parseEnvelope(body)).toBeNull();
    expect(previewFor(body)).toBe(UNSUPPORTED_TEXT);
  });

  it('rd never refuses — the clamp the Swift guard must NOT tighten', () => {
    // The receive side treats a malformed or missing digest as "no digest",
    // never as a lost message (WireRosterDigest's .catch). The Swift guard
    // deliberately does not examine rd, so a clamped digest still previews
    // its fixed constant on BOTH surfaces. If this ever starts failing, the
    // schema grew strict and the Swift's no-check now shows more than the
    // app: change NotificationService.swift with it.
    for (const rd of ['AAA', 42, undefined]) {
      const body = grpMsg(image, { rd });
      expect(parseEnvelope(body)).not.toBeNull();
      expect(previewFor(body)).toBe('Photo');
    }
  });

  it('a group id never reaches a preview line', () => {
    for (const body of [
      grpMsg(image),
      grpMsg('see you at nine'),
      JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 }),
      JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'in', n: 1 }),
    ]) {
      expect(previewFor(body).includes(G)).toBe(false);
    }
  });

  it("a grp.new's payload name never reaches a preview line — the mirror is the only name source", () => {
    const body = JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Divorce support', ms: [M], n: 1 });
    expect(parseEnvelope(body)).not.toBeNull(); // precondition: a real invite
    expect(previewFor(body).includes('Divorce support')).toBe(false);
  });

  it('a mention never puts a ULID, a mark, or raw JSON within reach of a banner', () => {
    // The mentions contract's notification path has now LANDED: classify()
    // carries a `mention` arm keyed by `selfId`, and the TABLE above holds
    // its transcript rows (`mention` when `who` names the owner, `generic`
    // otherwise). This block predates that switch and stays as written: it
    // is the oracle's half — the floor any compliant classify must build
    // on, whatever string it chooses to show.
    const resolve = (id: string) => (id === M ? 'Ana' : null);
    const mention = encodeEnvelope({
      tcm: 'mention',
      text: `${MENTION_MARK} the lease is signed`,
      who: [M],
    });
    // A mention is NOT a carrier, in either wrapping: a carrier may never be
    // bannered, so if this ever flips, "silent" becomes the only lawful
    // outcome and the feature's entire point — being noticed — is gone.
    expect(isCarrierEnvelope(mention)).toBe(false);
    expect(isCarrierEnvelope(grpMsg(mention))).toBe(false);
    // The precondition the permitted direction rests on: the app really does
    // preview a mention, names resolved, so an extension showing less — or a
    // future banner naming only the SENDER from the mirror — never says MORE
    // than the thread.
    expect(previewFor(grpMsg(mention), resolve)).toBe('@Ana the lease is signed');
    for (const line of [
      previewFor(mention),
      previewFor(grpMsg(mention)),
      previewFor(grpMsg(mention), resolve),
      displayText(mention),
      displayText(grpMsg(mention)),
    ]) {
      // The shared floor, which no level and no listed outcome may breach:
      // no raw envelope, no member id (the rule for the room id, same
      // reasoning), no bare object-replacement mark on any surface.
      expect(line.startsWith(RAW)).toBe(false);
      expect(line.includes(M)).toBe(false);
      expect(line.includes(MENTION_MARK)).toBe(false);
    }
    // And never '', even for a mention that is ONLY marks: the failed-bubble
    // fallback `previewFor(body) || body` has printed raw JSON twice; a
    // blank mention preview would be the third shipping of the same bug.
    const bare = encodeEnvelope({ tcm: 'mention', text: MENTION_MARK, who: [M] });
    expect(previewFor(bare)).toBe('Mention');
    expect(previewFor(grpMsg(bare))).toBe('Mention');
  });

  it('the unparseable-sentinel residual: the app shows the bytes, the extension does not', () => {
    // '{"tcm":"broken — sentinel prefix, unterminated JSON, no declarable
    // kind. envelope.ts documents this as indistinguishable-by-design from a
    // handcrafted text, so the APP previews it verbatim (the residual). The
    // extension cannot distinguish it either, and answers with the generic
    // body — less than the app, the permitted direction. Pinned so that if
    // the app ever closes the residual, this fails and the Swift transcript
    // is re-read rather than silently drifting; and so nobody "fixes" the
    // extension into matching the app's verbatim path, which WOULD put raw
    // {"tcm": on a lock screen.
    const body = '{"tcm":"broken';
    expect(parseEnvelope(body)).toBeNull();
    expect(previewFor(body)).toBe(body);
  });
});

/**
 * THE COALESCED BANNER.
 *
 * The server folds one sender's alert banners into one on the device
 * (`apns-collapse-id` = the sender, minted in packages/server/src/push/apns.ts
 * on the alert arm — one fact, two headers, beside `thread-id`), so of a burst
 * only the LAST banner survives. The DEVICE — the only party with plaintext —
 * makes the survivor honest: a per-sender counter in the shared container, and
 * a continuation body "N new messages" at preview level `.full` ONLY.
 *
 * The rules these pins hold in place:
 *   Coalescence counts at `.full` only — `.sender` and every degraded level keep
 *       today's EXACT rendering; the level's promise text is untouched.
 *   One-directional rule — the continuation body is a fixed constant composed
 *       with an Int; a payload byte cannot reach a coalesced banner.
 *   Spool-before-render — the counter shapes PRESENTATION only; the mint is a
 *       plain `let` and nothing about it gates the spool.
 *   Reset — the app owns the truth: foregrounding deletes the counts file on
 *       BadgeCounter's exact reset path (app/src/badge.ts).
 *
 * As everywhere in this file, the Swift cannot run under jest, so these are
 * pins on the artifact itself (the nse.blocked.suppress.test.ts idiom): the
 * literal shape of the continuation branches, and the byte-identity of the
 * arms the rule froze. The Swift half of the behavior is provable only on
 * hardware — the gate's demo IS the device check.
 */
describe('the coalesced banner: the continuation constants', () => {
  let swift = '';
  let counter = '';
  beforeAll(() => {
    swift = artifact('../ios/TacendumNSE/NotificationService.swift');
    counter = artifact('../ios/TacendumNSE/CollapseCounter.swift');
  });

  it('the continuation body is a fixed constant composed with an Int — a payload byte cannot even be OFFERED', () => {
    // The whole one-directional rule in one signature: the helper takes an
    // Int and nothing else, and its body is the pinned constant. Mutation
    // (i) — any payload byte reaching a coalesced body — lands here first:
    // widening the signature or interpolating anything but `n` breaks the
    // exact match.
    expect(swift).toContain(
      'static func continuationBody(_ n: Int) -> String { "\\(n) new messages" }',
    );
  });

  it('both continuation branches are jailed to .full on their own condition line, and contain no payload byte and no string literal', () => {
    // The .full jail as a fact of the LINE, not of surrounding context: each
    // continuation branch restates `level == .full` in its own condition so
    // this pin cannot be satisfied by a branch that moved somewhere else.
    const jails = swift.match(
      /if level == \.full, let n = coalesced, n > 1 \{\n[\s\S]*?\n\s*\}/g,
    ) ?? [];
    expect(jails).toHaveLength(2);
    for (const jail of jails) {
      // The burst buzzes once, not N times (mutation (iii) lands here: a
      // jail without its mute fails this containment).
      expect(jail).toContain('content.sound = nil');
      // The body override goes through the typed helper above and only when
      // a mention of the owner has not already won the body.
      expect(jail).toContain(
        'if !rendered.mentioned { content.body = Self.continuationBody(n) }',
      );
      // No payload byte and no string literal AT ALL inside a jail: not the
      // push, not the decrypted `shown`, not an inline interpolation. A
      // quote character appearing here is a rendering the helper did not
      // type-check (mutation (i), second landing site).
      expect(jail).not.toMatch(/push\./);
      expect(jail).not.toMatch(/shown/);
      expect(jail).not.toContain('"');
    }
    // And the mute exists in exactly ONE other place: the owner's
    // "Message sounds" preference, applied once, before the
    // badge and every preview decision, and pinned by its own suite
    // (nse.sound.test.ts). Beyond those three, `.sender` and every degraded
    // level keep the server's default sound byte-identically.
    expect(swift.match(/content\.sound/g)).toHaveLength(3);
    expect(swift.split('if !PreviewPolicy.messageSound() {')).toHaveLength(2);
  });

  it('`coalesced` is minted once, as a plain let, and consumed ONLY inside the two jails', () => {
    expect(swift).toContain(
      'let coalesced = CollapseCounter.incrementedCount(for: push.from)',
    );
    // Never a guard: an unknowable count must render as a first message,
    // not kill the run (and nothing about the counter may gate the spool).
    expect(swift).not.toContain('guard let coalesced');
    // Strip comment lines, then count code uses: the mint plus the two jail
    // condition lines. A third consumer is a rendering the rule does not allow.
    const code = swift
      .split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code.match(/\bcoalesced\b/g)).toHaveLength(3);
  });

  it('the order of operations is untouched: blocked, badge, count, spool, render', () => {
    const blockedAt = swift.indexOf('PreviewPolicy.blocked()');
    const badgeAt = swift.indexOf('BadgeCounter.incrementedBadge()');
    const mintAt = swift.indexOf('CollapseCounter.incrementedCount');
    const spoolAt = swift.indexOf('decryptAndSpool(push');
    const renderAt = swift.indexOf('Self.classify(body');
    for (const at of [blockedAt, badgeAt, mintAt, spoolAt, renderAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    // A blocked sender still earns NOTHING on their behalf — the count mint
    // sits with the badge, after the blocked verdict; and the spool still
    // precedes the render, so the counter only ever shaped presentation.
    expect(blockedAt).toBeLessThan(badgeAt);
    expect(badgeAt).toBeLessThan(mintAt);
    expect(mintAt).toBeLessThan(spoolAt);
    expect(spoolAt).toBeLessThan(renderAt);
  });

  it('`.sender` keeps today\'s exact rendering, byte for byte', () => {
    // The room `.sender` arm, as it stands today. Mutation (ii) — a count
    // rendered at `.sender` — cannot be written without breaking this text.
    expect(swift).toContain(
      '      if level == .sender {\n' +
        '        content.title = Self.senderTitle(push.from)\n' +
        '        content.threadIdentifier = push.from\n' +
        '      }',
    );
    // The 1:1 tail: the only body assignment outside a jail is gated on
    // `.full` exactly as today, so `.sender` still shows who and never what.
    expect(swift).toContain(
      '    content.title = Self.senderTitle(push.from)\n' +
        '    if level == .full, let shown = rendered.shown {\n' +
        '      content.body = shown\n' +
        '    }',
    );
  });

  it('the counter file follows BadgeCounter\'s pattern and trust class', () => {
    // Same shared container, same protection class, same own-flock with the
    // inode recheck against the app's reset-by-unlink — the same pattern,
    // held by the same literals BadgeCounter carries.
    expect(counter).toContain('SharedContainer.sharedStateRoot()');
    expect(counter).toContain(
      'FileProtectionType.completeUntilFirstUserAuthentication',
    );
    expect(counter).toContain('flock(fd, LOCK_EX)');
    expect(counter).toContain('st_ino');
    // The key must LOOK like an id before it becomes a line in a
    // line-oriented file: a key with a space or newline could inflate
    // another sender's count, and a wrong count is the one lie this feature
    // exists to end.
    expect(counter).toContain('sender.count == 26');
  });

  it('the new Swift file is registered with the extension target', () => {
    // A file on disk but absent from the pbxproj compiles nothing: every pin
    // above would then be about dead code.
    const pbxproj = artifact('../ios/Tacendum.xcodeproj/project.pbxproj');
    expect(pbxproj).toContain('CollapseCounter.swift in Sources');
  });
});

describe('the coalesced banner: the counter-reset lifecycle', () => {
  // The runnable half: the app-side reset is TypeScript and executes here.
  // The app owns the truth exactly as it does for the badge — foregrounding
  // deletes the counts file, so the next push from any sender is message 1
  // of a new absence, rendered as today.
  const COUNTS = 'coalesce-counts';
  const unreadCounts = db.unreadCounts as jest.MockedFunction<
    typeof db.unreadCounts
  >;
  const shared = (crypto as unknown as { __sharedState: Map<string, string> })
    .__sharedState;

  beforeEach(() => {
    jest.clearAllMocks();
    shared.clear();
  });

  it('syncBadge deletes the counts file — the foreground reset, on BadgeCounter\'s exact path', () => {
    // syncBadge is what start() and resume() call — the cold launch and the
    // return to foreground — and it already owns "the app takes the truth
    // back" for badge-extra. The counts ride the same moment.
    unreadCounts.mockResolvedValue({ 'peer-a': 2 });
    shared.set(COUNTS, '01SSSSSSSSSSSSSSSSSSSSSSSS 4');

    return syncBadge().then(() => {
      expect(shared.has(COUNTS)).toBe(false);
      // And the badge files still behave exactly as before — riding along
      // must not have reordered or broken the existing reset.
      expect(shared.get('badge-base')).toBe('2');
      expect(shared.has('badge-extra')).toBe(false);
    });
  });

  it('clearBadge deletes it too — a wipe or lock leaves no stale continuation behind', () => {
    shared.set(COUNTS, '01SSSSSSSSSSSSSSSSSSSSSSSS 4');

    return clearBadge().then(() => {
      expect(shared.has(COUNTS)).toBe(false);
    });
  });

  it('a failed counts delete does not fail the badge itself', () => {
    unreadCounts.mockResolvedValue({ 'peer-a': 1 });
    (crypto.deleteSharedState as jest.Mock).mockRejectedValue(
      new Error('container unavailable'),
    );

    return expect(syncBadge()).resolves.toBeUndefined();
  });

  it('the app only ever DELETES the counts — it never writes one', () => {
    // The extension is the only writer; the app resetting by unlink is what
    // the counter's inode recheck exists for. An app-side WRITE would be a
    // second author of the count, and the file format has exactly one.
    const badgeTs = artifact('../src/badge.ts');
    expect(badgeTs.match(/deleteSharedState\(COALESCE_COUNTS\)/g)).toHaveLength(2);
    expect(badgeTs).not.toMatch(/writeSharedState\(COALESCE_COUNTS/);
    // The name is one fact in two languages — Swift writes it, TS deletes it.
    expect(badgeTs).toContain("'coalesce-counts'");
    expect(
      artifact('../ios/TacendumNSE/CollapseCounter.swift'),
    ).toContain('"coalesce-counts"');
  });

  it('resume() really is the foreground moment that syncs the badge — the reset\'s ride is real', () => {
    // The lifecycle claim above rests on syncBadge running at foreground; pin
    // the ride so a refactor that drops it from resume() is named here.
    const messagingTs = artifact('../src/messaging.ts');
    const resume = messagingTs.match(
      /async resume\(\): Promise<void> \{[\s\S]*?this\.ws\.start\(/,
    );
    expect(resume).not.toBeNull();
    expect(resume![0]).toContain('syncBadge()');
  });
});

/**
 * THE APPROVAL BANNER.
 *
 * An `x.approval` push renders the fixed constant "Approval requested" at
 * preview level `.full` and NOTHING anywhere else: `.sender` and every
 * degraded level keep the silence every x.* got yesterday, byte for byte —
 * a pending command ask is a fact about what is happening on the owner's
 * machine, exactly the class of fact the degraded levels promise to
 * withhold. The rules these pins hold in place:
 *
 *   - The .full jail discipline, reused per line: the approval render restates
 *     `level == .full` on its own condition line, so the pin reads the jail,
 *     not the context.
 *   - The one-directional rule, by the emptiest signature yet: where
 *     `continuationBody` takes an Int, `approvalBody()` takes NOTHING.
 *   - An approval never takes the coalesced continuation body even when the burst
 *     coalesced — the branch returns before both jails and never consults
 *     the counter. An approval deserves its own words.
 *   - The banner-action VERDICT (the adopted design): NO answer actions,
 *     ever — device unlock cannot distinguish the duress passcode, because
 *     that comparison exists only inside lock.ts. The category scan lives in
 *     push.tapnav.test.ts beside the tap plumbing it protects.
 *   - The who-never-what floor: the constant is earned only by an envelope
 *     the app will actually card. The app drops a malformed `x.approval`
 *     invisibly (messaging.ts routes the declared tcm above the generic x.
 *     drop only when the union parses), so a banner announcing one would say
 *     MORE than the thread. The Swift guard approximates the schema's
 *     refusing half; its transcript below runs against the committed
 *     cross-client vectors, the same bytes the shared, app and CLI suites
 *     parse.
 */
describe('the approval banner: the fixed constant at .full only', () => {
  let swift = '';
  beforeAll(() => {
    swift = artifact('../ios/TacendumNSE/NotificationService.swift');
  });

  it('the approval body is a fixed constant from an EMPTY signature — not even a number can ride the line', () => {
    expect(swift).toContain(
      'static func approvalBody() -> String { "Approval requested" }',
    );
  });

  it('the approval render is jailed to .full on its own line and delivers the untouched fallback everywhere else', () => {
    // The whole branch, byte for byte (the `.sender` byte-identity
    // technique): every content mutation sits under the restated
    // `level == .full`, the degraded levels reach `deliver(content)` with
    // the fallback untouched — the exact silence every x.* rendered
    // yesterday — and the branch returns before the room and 1:1 arms so
    // neither can restyle it. Mutation (i) — the approval body rendered at
    // `.sender` — cannot be written without breaking this text.
    expect(swift).toContain(
      '    if rendered.approval {\n' +
        '      if level == .full {\n' +
        '        content.title = Self.senderTitle(push.from)\n' +
        '        content.body = Self.approvalBody()\n' +
        '        content.threadIdentifier = push.from\n' +
        '      }\n' +
        '      deliver(content)\n' +
        '      return\n' +
        '    }',
    );
  });

  it('the approval branch returns before both continuation jails and never consults the counter — an approval keeps its own words', () => {
    // Mutation (iii) — an approval push taking the coalesced continuation body —
    // needs either the branch moved past a jail or the counter consulted
    // inside it; both land here.
    const approvalAt = swift.indexOf('if rendered.approval {');
    const firstJailAt = swift.indexOf('if level == .full, let n = coalesced');
    expect(approvalAt).toBeGreaterThan(-1);
    expect(firstJailAt).toBeGreaterThan(-1);
    expect(approvalAt).toBeLessThan(firstJailAt);

    const branch = swift.slice(
      approvalAt,
      swift.indexOf('\n    }', approvalAt) + '\n    }'.length,
    );
    expect(branch).not.toMatch(/coalesced/);
    expect(branch).not.toMatch(/continuationBody/);
    // No decrypted text and no string literal inside the branch: the title
    // is the mirror's name for the authenticated sender, the body is the
    // typed helper, and nothing else may be composed here.
    expect(branch).not.toMatch(/shown/);
    expect(branch).not.toContain('"');
    expect(branch).not.toMatch(/content\.sound/);
  });

  it('the carve-out is by EXACT discriminator at depth 0; the rest of the namespace keeps today\'s pre-parse silence', () => {
    // Depth 0 only, stated in the condition itself: inside a room the app
    // has no approval consumer, so a room banner naming one would announce
    // a card no thread will render.
    expect(swift).toContain('if depth == 0, Self.plausibleApproval(body) {');
    // The prefix routing survives for everything else — `call.` and the
    // `x.` namespace still fall silent before parsing.
    expect(swift).toContain('if body.hasPrefix("{\\"tcm\\":\\"call.") {');
    expect(swift).toContain('if body.hasPrefix("{\\"tcm\\":\\"x.") {');
    // The discriminator is the exact JSON member, never a lexical prefix.
    expect(swift).toContain('map["tcm"] as? String == "x.approval"');
  });

  it('the Swift guard restates the schema\'s refusing half, literal by literal', () => {
    // Each bound that refuses the WHOLE envelope at the app's parser
    // (@tacendum/shared approval-envelope.ts), held by the same literals so
    // the transcript below and the Swift cannot drift silently. `k` is
    // deliberately unchecked — the schema `.catch`es it to 'other'.
    expect(swift).toContain('let q = map["q"] as? String, q.count == 26');
    expect(swift).toContain('p.utf16.count <= 16_384');
    expect(swift).toContain('Self.plausibleInt(map["x"], min: 30, max: 3_600)');
    expect(swift).toContain('(1...8).contains(verbs.count)');
    expect(swift).toContain('verbs.allSatisfy({ (1...16).contains($0.count) })');
    expect(swift).toContain('tag.count == 6, tag.hasPrefix("s-")');
    expect(swift).toContain('Self.plausibleInt(n, min: 1, max: 64)');
  });
});

describe('the approval banner: the guard transcript against the committed vectors', () => {
  /**
   * `plausibleApproval`, transcribed (the TABLE discipline): the same
   * refusals in TypeScript, run against `approvalvectors.json` — the bytes
   * the shared, app and CLI suites already agree on. JS `.length` counts
   * UTF-16 code units, the unit Swift's `p.utf16.count` counts and the unit
   * zod's `.max()` counts, so the three agree on the one bound where the
   * unit matters. (Swift's `q.count`/verb `.count` are grapheme counts —
   * identical for the ASCII these fields carry; the residual is the guards'
   * own, stated at the Swift.)
   */
  const plausibleInt = (v: unknown, min: number, max: number): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const plausibleApproval = (body: string): boolean => {
    let map: Record<string, unknown>;
    try {
      map = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return false;
    }
    if (map.tcm !== 'x.approval') return false;
    const q = map.q;
    if (typeof q !== 'string' || q.length !== 26) return false;
    const p = map.p;
    if (typeof p !== 'string' || p.length === 0 || p.length > 16_384) {
      return false;
    }
    if (!plausibleInt(map.x, 30, 3_600)) return false;
    const verbs = map.a;
    if (!Array.isArray(verbs) || verbs.length < 1 || verbs.length > 8) {
      return false;
    }
    if (
      !verbs.every(
        v => typeof v === 'string' && v.length >= 1 && v.length <= 16,
      )
    ) {
      return false;
    }
    if (map.s !== undefined) {
      const s = map.s;
      if (typeof s !== 'string' || s.length !== 6 || !s.startsWith('s-')) {
        return false;
      }
    }
    if (map.n !== undefined && !plausibleInt(map.n, 1, 64)) return false;
    return true;
  };

  interface VectorCase {
    name: string;
    kind: string;
    valid: boolean;
    body: string;
  }
  // By relative path exactly as envelope.approval.test.ts reads it: the
  // shared package's exports map has no subpath for the fixture, and the
  // bytes are the point.
  const vectors = require('../../packages/shared/approvalvectors.json') as {
    cases: VectorCase[];
  };
  const requests = vectors.cases.filter(c => c.kind === 'x.approval');

  it('the committed request vector earns the constant — the carve-out is not vacuously dead', () => {
    const req = vectors.cases.find(c => c.name === 'request');
    expect(req).toBeDefined();
    expect(plausibleApproval(req!.body)).toBe(true);
    // And a future verb still cards (a verb costs the answer, never the
    // frame): the unknown-verb vector is schema-valid and guard-plausible.
    const unknownVerb = vectors.cases.find(c => c.name === 'request-unknown-verb');
    expect(unknownVerb).toBeDefined();
    expect(plausibleApproval(unknownVerb!.body)).toBe(true);
  });

  it('whatever the guard accepts, the app cards: transcript-accepted implies schema-accepted, on every committed vector', () => {
    // The one-directional floor: a banner may announce ONLY what the thread
    // will render. The inverse is permitted (the guard may refuse what the
    // schema takes — showing less), so only this direction is asserted.
    const { ApprovalRequestEnvelope } = require('@tacendum/shared') as {
      ApprovalRequestEnvelope: {
        safeParse: (v: unknown) => { success: boolean };
      };
    };
    expect(requests.length).toBeGreaterThan(0);
    for (const c of requests) {
      if (plausibleApproval(c.body)) {
        expect(
          ApprovalRequestEnvelope.safeParse(JSON.parse(c.body)).success,
        ).toBe(true);
      }
    }
  });

  it('what the schema refuses stays today\'s silence: no broken vector earns the constant', () => {
    const broken = requests.filter(c => !c.valid);
    expect(broken.length).toBeGreaterThan(0);
    for (const c of broken) {
      expect(plausibleApproval(c.body)).toBe(false);
    }
  });

  it('the rest of the namespace keeps today\'s silence: the answer, typing, near-miss discriminators', () => {
    const answer = vectors.cases.find(c => c.name === 'answer');
    expect(answer).toBeDefined();
    expect(plausibleApproval(answer!.body)).toBe(false);
    expect(plausibleApproval('{"tcm":"x.typing","on":true}')).toBe(false);
    // The discriminator is exact: a namespace neighbour and a prefix
    // extension both stay silent.
    expect(plausibleApproval('{"tcm":"x.approval.close","q":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}')).toBe(false);
    const req = vectors.cases.find(c => c.name === 'request')!;
    expect(plausibleApproval(req.body.replace('"x.approval"', '"x.approvalx"'))).toBe(false);
  });
});
