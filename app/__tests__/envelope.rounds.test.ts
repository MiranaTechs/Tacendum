/**
 * ROUNDS on the app's wire (§3.1).
 *
 * A round answer is a BRIEF and a DETAIL written by one model, in one message,
 * under one ratchet-authenticated sender. On this side that is one optional
 * field — `d` — on kinds this build already parses, plus ONE new reader for
 * it. The four rules this file holds down:
 *
 * 1. **The brief is the words, and nothing else changed.** `displayText` and
 *    `previewFor` return the brief and only the brief for a body carrying a
 *    detail. What `previewFor` returns becomes `chats.lastMessageText` and the
 *    lock-screen line; the two blank-preview incidents that file records are
 *    why nothing new may reach it.
 *
 * 2. **`detailText` mirrors the words reader's unwrap arms and nothing else.**
 *    A room wrapper and a device leg reach through; every other kind is null.
 *    Two switches that disagree about what a body is would be the defect §5.2
 *    exists to prevent.
 *
 * 3. **Build 25 is in the field with no OTA.** An unknown key on a `reply`
 *    strips rather than refuses, which is the whole basis for shipping a new
 *    field at all — a build that predates `d` renders the brief and loses
 *    nothing else. Pinned here, so a future `.strict()` cannot quietly turn
 *    the detail into a message-killer for phones already out there.
 *
 * 4. **The compose-side refusal is OBSERVABLE (R24).** `d` is
 *    `.optional().catch(undefined)` so the receive side can never refuse a
 *    message over it — and `.catch` swallows rather than throws, so a refusal
 *    written inside the schema would be no refusal at all: `encodeEnvelope`
 *    would succeed with `d` collapsed and emit a brief-only body with no
 *    signal to anybody. These cases assert a THROW; a test written as "the
 *    body comes back brief-only" would pass against the broken design too.
 */

import {
  EnvelopeRefusedError,
  detailText,
  displayText,
  encodeEnvelope,
  parseEnvelope,
  previewFor,
} from '../src/envelope';
import { DETAIL_MAX } from '@tacendum/shared/rounds';

const G = '01GGGGGGGGGGGGGGGGGGGGGGGG';
const M = '01MMMMMMMMMMMMMMMMMMMMMMMM';
const RD = 'M+TFhub/mmM';
/** The §5.3 room content ref an agent answers a human turn with. */
const REF = `${'01AAAAAAAAAAAAAAAAAAAAAAAA'}.${M}`;

const BRIEF = 'Two of the three suites are green; the third needs a decision.';
const DETAIL =
  'The failing case is the deadline arithmetic under a moving clock.\n' +
  'It has two possible readings and only the owner can pick one.';

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ tcm: 'reply', ref: REF, ofs: false, text: BRIEF, ...over });

const grpMsg = (body: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ tcm: 'grp.msg', g: G, m: M, rd: RD, b: body, ...over });

const devMsg = (body: string) =>
  JSON.stringify({ tcm: 'dev.msg', m: M, b: body });

describe('a reply carrying a detail', () => {
  it('parses, and detailText returns the detail', () => {
    const body = reply({ d: DETAIL });
    const parsed = parseEnvelope(body);
    expect(parsed?.tcm).toBe('reply');
    expect(detailText(body)).toBe(DETAIL);
  });

  it('shows ONLY the brief in the words and in the preview', () => {
    const body = reply({ d: DETAIL });
    expect(displayText(body)).toBe(BRIEF);
    expect(previewFor(body)).toBe(BRIEF);
    // Said as a fact about the bytes as well as the strings: the detail is not
    // hiding at the end of either one.
    expect(displayText(body)).not.toContain('deadline arithmetic');
    expect(previewFor(body)).not.toContain('deadline arithmetic');
  });

  it('reads as an ordinary reply when there is no detail', () => {
    const body = reply();
    expect(displayText(body)).toBe(BRIEF);
    expect(previewFor(body)).toBe(BRIEF);
    expect(detailText(body)).toBeNull();
  });
});

describe('a msg carrying a detail (the 1:1 attend path)', () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ tcm: 'msg', text: BRIEF, ai: true, ...over });

  it('shows the brief and yields the detail', () => {
    expect(displayText(body({ d: DETAIL }))).toBe(BRIEF);
    expect(previewFor(body({ d: DETAIL }))).toBe(BRIEF);
    expect(detailText(body({ d: DETAIL }))).toBe(DETAIL);
  });

  it('is unchanged without one', () => {
    expect(detailText(body())).toBeNull();
    expect(displayText(body())).toBe(BRIEF);
  });
});

describe('the room wrapper and the device leg reach through', () => {
  it('a grp.msg wrapping a reply-with-detail unwraps on all three readers', () => {
    const body = grpMsg(reply({ d: DETAIL }), { ai: true });
    expect(displayText(body)).toBe(BRIEF);
    expect(previewFor(body)).toBe(BRIEF);
    expect(detailText(body)).toBe(DETAIL);
  });

  it('a dev.msg wrapping one does too (§2.4)', () => {
    const body = devMsg(reply({ d: DETAIL }));
    expect(displayText(body)).toBe(BRIEF);
    expect(detailText(body)).toBe(DETAIL);
  });

  it('a wrapper around a detail-free body has no detail', () => {
    expect(detailText(grpMsg(reply()))).toBeNull();
    expect(detailText(grpMsg('plain words'))).toBeNull();
  });
});

describe('detailText is null for everything that has no detail', () => {
  it.each([
    ['plain text', 'just words'],
    ['an edit', JSON.stringify({ tcm: 'edit', ref: M, text: 'meant tomorrow' })],
    ['a delete', JSON.stringify({ tcm: 'del', ref: M })],
    ['a screenshot notice', JSON.stringify({ tcm: 'shot' })],
    ['a kind this build cannot read', '{"tcm":"zz.future","x":1}'],
    ['a body that only looks like JSON', '{"not":"an envelope"}'],
    ['the empty string', ''],
  ])('%s', (_label, body) => {
    expect(detailText(body)).toBeNull();
  });

  it('never returns the empty string — a control over nothing is a lie', () => {
    // The shared fragment refuses `''`, so it collapses like any other
    // malformed detail rather than arriving as a detail of zero length.
    expect(detailText(reply({ d: '' }))).toBeNull();
  });
});

describe('build 25 in the field, and the receive side that protects it', () => {
  it('an unknown extra key on a reply round-trips to brief-only', () => {
    // The strip proof: a phone that predates `d` parses this body, renders the
    // brief, and loses only what it never knew about.
    const body = reply({ zz: 'a field from a later build' });
    expect(displayText(body)).toBe(BRIEF);
    expect(detailText(body)).toBeNull();
    expect(parseEnvelope(body)).not.toHaveProperty('zz');
  });

  it('a detail that is not a string collapses, and the message still parses', () => {
    for (const d of [42, null, true, { d: 'nice try' }, ['nice try']]) {
      const body = reply({ d });
      expect(parseEnvelope(body)).not.toBeNull();
      expect(displayText(body)).toBe(BRIEF);
      expect(detailText(body)).toBeNull();
    }
  });

  it('an over-cap or sentinel-leading detail costs itself and never the words', () => {
    for (const d of ['a'.repeat(DETAIL_MAX + 1), '{"tcm":"del","ref":"01ABC"}']) {
      const body = reply({ d });
      expect(displayText(body)).toBe(BRIEF);
      expect(previewFor(body)).toBe(BRIEF);
      expect(detailText(body)).toBeNull();
    }
  });
});

describe('encodeEnvelope refuses a detail it could not honestly carry (R24)', () => {
  it('THROWS on an over-cap detail rather than emitting brief-only', () => {
    expect(() =>
      encodeEnvelope({
        tcm: 'reply',
        ref: REF,
        ofs: false,
        text: BRIEF,
        d: 'a'.repeat(DETAIL_MAX + 1),
      }),
    ).toThrow(EnvelopeRefusedError);
  });

  it('THROWS on a sentinel-leading detail — a rendered string that reads as structure', () => {
    expect(() =>
      encodeEnvelope({
        tcm: 'reply',
        ref: REF,
        ofs: false,
        text: BRIEF,
        d: '{"tcm":"del","ref":"01ABC"}',
      }),
    ).toThrow(EnvelopeRefusedError);
  });

  it('THROWS on an empty detail, and on one that is not a string at all', () => {
    expect(() =>
      encodeEnvelope({ tcm: 'reply', ref: REF, ofs: false, text: BRIEF, d: '' }),
    ).toThrow(EnvelopeRefusedError);
    expect(() =>
      encodeEnvelope({
        tcm: 'reply',
        ref: REF,
        ofs: false,
        text: BRIEF,
        d: 42,
      } as never),
    ).toThrow(EnvelopeRefusedError);
  });

  it('names the FIELD in the refusal and never the detail itself', () => {
    // An error string is logged, rendered and sometimes copied, and the detail
    // is payload (rule 4).
    try {
      encodeEnvelope({
        tcm: 'reply',
        ref: REF,
        ofs: false,
        text: BRIEF,
        d: `${'z'.repeat(DETAIL_MAX)} the door code is not for the logs`,
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as EnvelopeRefusedError).name).toBe('EnvelopeRefusedError');
      expect((err as EnvelopeRefusedError).fields).toEqual(['d']);
      expect((err as Error).message).not.toContain('door code');
      expect((err as Error).message).not.toContain('zzzz');
    }
  });

  it('encodes a well-formed detail, and the bytes round-trip through all three readers', () => {
    const bytes = encodeEnvelope({
      tcm: 'reply',
      ref: REF,
      ofs: false,
      text: BRIEF,
      d: DETAIL,
    });
    expect(displayText(bytes)).toBe(BRIEF);
    expect(previewFor(bytes)).toBe(BRIEF);
    expect(detailText(bytes)).toBe(DETAIL);
  });

  it('leaves a detail-free reply byte-identical to what this build sent before', () => {
    const bytes = encodeEnvelope({ tcm: 'reply', ref: REF, ofs: false, text: BRIEF });
    expect(bytes).toBe(
      JSON.stringify({ tcm: 'reply', ref: REF, ofs: false, text: BRIEF }),
    );
    expect(bytes).not.toContain('"d"');
  });

  it('a msg with a bad detail is refused on the same terms', () => {
    expect(() =>
      encodeEnvelope({
        tcm: 'msg',
        text: BRIEF,
        ai: true,
        d: 'a'.repeat(DETAIL_MAX + 1),
      }),
    ).toThrow(EnvelopeRefusedError);
  });
});
