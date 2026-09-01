import {
  EnvelopeRefusedError,
  MENTION_MARK,
  MentionEnvelope,
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  mentionSegments,
  parseEnvelope,
  previewFor,
  renderMentionText,
  rewriteBody,
} from '../src/envelope';

/**
 * @-MENTIONS ON THE WIRE (the mentions contract).
 *
 * The constraint that decides everything here: names in this app are LOCAL.
 * My name for someone outranks the name they chose, and the two are often
 * different — so a mention that travelled as text would render MY private
 * name for a person on eleven other phones, and the wrong name on every
 * phone that knows them differently. The wire carries ids; each phone
 * renders its own name through an INJECTED resolver.
 *
 * The second decision worth defending with tests rather than assuming:
 * compose-strict, parse-permissive. The same mark/id mismatch that is
 * REFUSED at compose must SURVIVE at parse, because on a one-way ratchet a
 * refused parse means the message is gone forever, and a mention is never
 * worth losing the words around it.
 */

const MARK = MENTION_MARK;

// Crockford-base32 ULIDs (no I, L, O, U), 26 characters each.
const ANA = `01${'ANA'.repeat(8)}`;
const BEK = `01${'BEK'.repeat(8)}`;
const STRANGER = `01${'STR'.repeat(8)}`;

const NAMES: Record<string, string> = { [ANA]: 'Ana', [BEK]: 'Bek' };
const resolve = (id: string) => NAMES[id] ?? null;

const MENTION = {
  tcm: 'mention' as const,
  text: `${MARK} lunch?`,
  who: [ANA],
};
const TWO = {
  tcm: 'mention' as const,
  text: `${MARK} owes ${MARK} ten birr`,
  who: [ANA, BEK],
};

// A room wrapper, the way the nse.preview contract test builds one — rooms
// are the only place mentions are composed, so the recursion matters.
const G = `01${'G'.repeat(24)}`;
const M = `01${'M'.repeat(24)}`;
const grpMsg = (b: string) =>
  JSON.stringify({ tcm: 'grp.msg', g: G, m: M, rd: 'M+TFhub/mmM', b });

describe('the wire shape', () => {
  it('round-trips losslessly, duplicates included', () => {
    for (const envelope of [
      MENTION,
      TWO,
      // Mentioning the same person twice is legal — the ordinal mapping
      // carries no uniqueness rule.
      { tcm: 'mention' as const, text: `${MARK} and ${MARK}`, who: [ANA, ANA] },
    ]) {
      expect(parseEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
    }
  });

  it('refuses on BOTH sides what is malformed on both sides', () => {
    // The strict half the two sides share — not the asymmetric count rule.
    // An id that is not a ULID, an empty roster, a roster above the room
    // ceiling, empty text, text that is itself an envelope: broken however
    // it arrives.
    for (const body of [
      { ...MENTION, who: [] },
      { ...MENTION, who: ['not-a-ulid'] },
      { ...MENTION, who: [ANA.toLowerCase()] },
      { tcm: 'mention', text: MARK.repeat(13), who: Array(13).fill(ANA) },
      { ...MENTION, text: '' },
      { ...MENTION, text: '{"tcm":"shot"}' },
    ]) {
      expect(parseEnvelope(JSON.stringify(body))).toBeNull();
      expect(() =>
        encodeEnvelope(body as Parameters<typeof encodeEnvelope>[0]),
      ).toThrow(EnvelopeRefusedError);
    }
  });
});

describe('a mention never carries a name', () => {
  it('the schema has exactly three keys — ids, words, kind — and nothing a name could hide in', () => {
    // THE test that fails when someone "helpfully" adds a name field. The
    // wire has ids; each phone renders its own name. A `name` or `names`
    // key here is the privacy leak the whole design exists to prevent.
    expect(Object.keys(MentionEnvelope.shape).sort()).toEqual([
      'tcm',
      'text',
      'who',
    ]);
  });

  it('a smuggled name is stripped at compose and ignored at parse', () => {
    const smuggled = encodeEnvelope({
      ...MENTION,
      name: 'MyPrivateNameForAna',
    } as unknown as Parameters<typeof encodeEnvelope>[0]);
    expect(smuggled).not.toContain('MyPrivateNameForAna');

    const wire = JSON.stringify({ ...MENTION, name: 'MyPrivateNameForAna' });
    expect(parseEnvelope(wire)).toEqual(MENTION);
  });

  it('the rendered name comes from the RESOLVER, never the bytes — same wire, different phone, different name', () => {
    // The falsifiable form of "the display name is not inlined into text":
    // identical wire bytes render under two phones' resolvers as two
    // different names. If the name rode the wire, these could not differ.
    const body = encodeEnvelope(MENTION);
    const myPhone = (id: string) => (id === ANA ? 'Ana' : null);
    const yourPhone = (id: string) => (id === ANA ? 'Dr T' : null);
    expect(previewFor(body, myPhone)).toBe('@Ana lunch?');
    expect(previewFor(body, yourPhone)).toBe('@Dr T lunch?');
    expect(body).not.toContain('Ana');
    expect(body).not.toContain('Dr T');
  });
});

describe('the ordinal mapping — the Nth mark is the Nth id', () => {
  it('two mentions of two people resolve in text order', () => {
    expect(renderMentionText(TWO.text, TWO.who, resolve)).toBe(
      '@Ana owes @Bek ten birr',
    );
  });

  it('swapping who changes who is named', () => {
    // The test that catches a reversed index, an off-by-one, or any
    // "helpful" sort: same text, reordered ids, different sentence.
    expect(renderMentionText(TWO.text, [BEK, ANA], resolve)).toBe(
      '@Bek owes @Ana ten birr',
    );
  });

  it('segments carry the same ordinal structure for the chip renderer', () => {
    expect(mentionSegments(`a${MARK}b${MARK}c`, [ANA, BEK])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'mention', id: ANA },
      { kind: 'text', text: 'b' },
      { kind: 'mention', id: BEK },
      { kind: 'text', text: 'c' },
    ]);
    // A mark past the end of `who` yields NO segment — dropped, not padded.
    expect(mentionSegments(`${MARK}${MARK}`, [ANA])).toEqual([
      { kind: 'mention', id: ANA },
    ]);
  });
});

describe('compose-strict, parse-permissive — the asymmetry itself', () => {
  // One list, asserted in BOTH directions, because the asymmetry is the
  // point: every one of these is refused at compose and survives at parse.
  const mismatched = [
    // more marks than ids
    { tcm: 'mention' as const, text: `${MARK} and ${MARK} run`, who: [ANA] },
    // more ids than marks
    { tcm: 'mention' as const, text: `${MARK} hey`, who: [ANA, BEK] },
    // no marks at all, yet ids
    { tcm: 'mention' as const, text: 'no marks here', who: [ANA] },
  ];

  it('compose REFUSES a mark/id count mismatch, loudly and locally', () => {
    for (const envelope of mismatched) {
      expect(() => encodeEnvelope(envelope)).toThrow(EnvelopeRefusedError);
    }
    try {
      encodeEnvelope(mismatched[0]);
      throw new Error('should have refused');
    } catch (err) {
      expect((err as EnvelopeRefusedError).name).toBe('EnvelopeRefusedError');
      expect((err as EnvelopeRefusedError).tcm).toBe('mention');
      expect((err as EnvelopeRefusedError).fields).toEqual(['text', 'who']);
    }
  });

  it('parse ACCEPTS the very same mismatches — a refused parse is a message gone forever', () => {
    // The one-way ratchet gives no second copy: the ack purges the server,
    // the key is consumed. A mention is never worth losing the words around
    // it, so the schema must not learn the count rule the composer enforces.
    for (const envelope of mismatched) {
      expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    }
  });

  it('renders a mismatch as best it can: extra marks drop, words survive', () => {
    expect(renderMentionText(`${MARK} and ${MARK} run`, [ANA], resolve)).toBe(
      '@Ana and  run',
    );
  });

  it('renders a mismatch as best it can: extra ids are ignored', () => {
    expect(renderMentionText(`${MARK} hey`, [ANA, BEK], resolve)).toBe(
      '@Ana hey',
    );
    expect(renderMentionText('no marks here', [ANA], resolve)).toBe(
      'no marks here',
    );
  });

  it('an id naming no one this phone knows drops, and never leaks as a ULID', () => {
    const out = renderMentionText(
      `${MARK} left the room`,
      [STRANGER],
      resolve,
    );
    expect(out).toBe(' left the room');
    expect(out).not.toContain(STRANGER);
  });
});

describe('previewFor and displayText — the strings that leave the thread', () => {
  const body = encodeEnvelope(MENTION);

  it('resolves names into the preview, 1:1 and through a room wrapper', () => {
    expect(previewFor(body, resolve)).toBe('@Ana lunch?');
    // Rooms are where mentions live; the resolver must ride the recursion
    // or the names are lost at exactly the surface they were resolved for.
    expect(previewFor(grpMsg(body), resolve)).toBe('@Ana lunch?');
    expect(displayText(body, resolve)).toBe('@Ana lunch?');
    expect(displayText(grpMsg(body), resolve)).toBe('@Ana lunch?');
  });

  it('never emits a ULID, a raw mark, or raw JSON — resolver or none', () => {
    for (const out of [
      previewFor(body),
      previewFor(body, resolve),
      previewFor(body, () => null),
      previewFor(grpMsg(body)),
      displayText(body),
      displayText(grpMsg(body)),
    ]) {
      expect(out).not.toContain(ANA);
      expect(out).not.toContain(MARK);
      expect(out.startsWith('{"tcm":')).toBe(false);
    }
  });

  it('without a resolver the marks drop and the words stand alone', () => {
    expect(previewFor(body)).toBe(' lunch?');
    expect(displayText(body)).toBe(' lunch?');
  });

  it('a mention that is ONLY marks previews as a constant, never as the empty string', () => {
    // The defect that has shipped twice: a kind previewing '' falls into the
    // failed-bubble's `previewFor(row.body) || row.body` fallback, which
    // prints the raw envelope on screen. "@Ana" with no other words — text
    // of one bare mark — is exactly that shape when nothing resolves.
    const bare = encodeEnvelope({ tcm: 'mention', text: MARK, who: [ANA] });
    expect(previewFor(bare)).toBe('Mention');
    expect(previewFor(bare, () => null)).toBe('Mention');
    // And when it CAN resolve, the name wins over the constant.
    expect(previewFor(bare, resolve)).toBe('@Ana');
  });

  it('a resolver that echoes the id back is treated as "cannot name" — the no-raw-id rule', () => {
    // The obvious failure mode of a name lookup is falling back to the id.
    // That fallback must not become a ULID on a lock screen.
    const echo = (id: string) => id;
    const out = previewFor(body, echo);
    expect(out).not.toContain(ANA);
    expect(out).toBe(' lunch?');
  });

  it('a name containing a mark cannot smuggle structure into the render', () => {
    const hostile = () => `An${MARK}a`;
    expect(renderMentionText(MENTION.text, MENTION.who, hostile)).toBe(
      '@Ana lunch?',
    );
  });
});

describe('classification and rewriting', () => {
  it('a mention is conversation, never a carrier — 1:1 and in a room', () => {
    // The point of the feature is that a row appears and gets noticed. A
    // carrier is filtered from the thread and never bumps a preview, which
    // would make the mention exactly as invisible as not sending it.
    const body = encodeEnvelope(MENTION);
    expect(isCarrierEnvelope(body)).toBe(false);
    expect(isCarrierEnvelope(grpMsg(body))).toBe(false);
  });

  it('editing a mention downgrades it to plain words rather than composing a mismatch', () => {
    // The edit wire carries only text — no `who` — so preserving the
    // envelope would pair marks the editor never saw with ids they never
    // chose, which is the mismatch this build refuses to encode. The calmer
    // words survive; the addressing does not.
    expect(rewriteBody(encodeEnvelope(MENTION), 'calmer words')).toBe(
      'calmer words',
    );
  });
});
