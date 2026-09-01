/**
 * The five room envelopes, where the app meets them: the union, the carrier
 * classification, and the previews.
 *
 * The rule this file exists to hold down has now shipped broken twice —
 * **no raw `{"tcm":` may ever reach a preview or the failed-bubble fallback.**
 * Both times it happened the same way: a new kind joined the union, nobody
 * gave it a `previewFor` branch, it fell through to the blank, and the
 * outgoing failed bubble's `previewFor(body) || body` fallback printed the
 * envelope on screen. There is one test per kind below for exactly that.
 */

import {
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  parseEnvelope,
  previewFor,
  EnvelopeRefusedError,
} from '../src/envelope';

const G = '01GGGGGGGGGGGGGGGGGGGGGGGG';
const M = '01MMMMMMMMMMMMMMMMMMMMMMMM';
const RD = 'M+TFhub/mmM'; // a real digest, and one that exercises + and /

const grpMsg = (body: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ tcm: 'grp.msg', g: G, m: M, rd: RD, b: body, ...over });

const RAW = '{"tcm":';

describe('the union accepts every announced kind', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['grp.msg', grpMsg('hello')],
    ['grp.new', JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 })],
    ['grp.roster', JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'in', n: 1 })],
    ['grp.del', JSON.stringify({ tcm: 'grp.del', g: G, n: 1 })],
    ['grp.set', JSON.stringify({ tcm: 'grp.set', g: G, s: 30, n: 1 })],
    ['grp.consent', JSON.stringify({ tcm: 'grp.consent', g: G, a: M, s: 'hold', n: 1 })],
  ];

  it.each(cases)('%s parses', (_kind, body) => {
    expect(parseEnvelope(body)).not.toBeNull();
  });

  // THE bug, once per kind. A preview that contains the sentinel is the raw
  // JSON reaching a chat row or a notification.
  it.each(cases)('%s never previews as raw JSON', (_kind, body) => {
    expect(previewFor(body)).not.toContain(RAW);
  });

  it.each(cases)('%s never displays as raw JSON', (_kind, body) => {
    expect(displayText(body)).not.toContain(RAW);
  });

  // The failed-bubble fallback is `previewFor(body) || body`, so a kind that
  // previews as '' AND is not a carrier prints its own JSON on screen. Every
  // room kind must therefore either preview non-empty or be a carrier.
  it.each(cases)('%s survives the failed-bubble fallback', (_kind, body) => {
    const shown = previewFor(body) || (isCarrierEnvelope(body) ? '' : body);
    expect(shown).not.toContain(RAW);
  });
});

describe('previews say the right thing', () => {
  it('a room message previews as WHATEVER IT WRAPS', () => {
    const image = JSON.stringify({ tcm: 'image', att: 'blob-1', key: 'a2V5', w: 100, h: 80 });
    expect(previewFor(grpMsg(image))).toBe('Photo');
    const voice = JSON.stringify({ tcm: 'voice', att: 'blob-2', key: 'a2V5', dur: 12 });
    expect(previewFor(grpMsg(voice))).toBe('Voice message');
    expect(previewFor(grpMsg('just words'))).toBe('just words');
  });

  it('the four announced kinds carry their own line, without names', () => {
    expect(previewFor(JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 }))).toBe(
      'New room',
    );
    // The room name is the chat row's own title; repeating it in the preview
    // would leak it into a notification for nothing.
    expect(
      previewFor(JSON.stringify({ tcm: 'grp.new', g: G, nm: 'Kitchen', ms: [M], n: 1 })),
    ).not.toContain('Kitchen');
    expect(previewFor(JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'out', n: 1 }))).toBe(
      'Members changed',
    );
    expect(previewFor(JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'out', n: 1 }))).not.toContain(
      M,
    );
    // The consent announcement previews without the member OR the agent —
    // WHO shares with WHICH agent is exactly the fact kept inside the
    // room, and this string reaches a lock screen.
    const consentBody = JSON.stringify({ tcm: 'grp.consent', g: G, a: M, s: 'hold', n: 1 });
    expect(previewFor(consentBody)).toBe('Sharing changed');
    expect(previewFor(consentBody)).not.toContain(M);
    expect(previewFor(JSON.stringify({ tcm: 'grp.del', g: G, n: 1 }))).toBe('Room deleted');
    expect(previewFor(JSON.stringify({ tcm: 'grp.set', g: G, s: 30, n: 1 }))).toBe(
      'Disappearing messages on',
    );
    expect(previewFor(JSON.stringify({ tcm: 'grp.set', g: G, s: 0, n: 1 }))).toBe(
      'Disappearing messages off',
    );
  });
});

describe('carrier classification', () => {
  it('a room message INHERITS — a reaction in a room is as invisible as one 1:1', () => {
    const react = JSON.stringify({ tcm: 'react', ref: M, ofs: false, emoji: '\u{1F44D}' });
    expect(isCarrierEnvelope(react)).toBe(true);
    expect(isCarrierEnvelope(grpMsg(react))).toBe(true);
    expect(previewFor(grpMsg(react))).toBe('');
  });

  it('a room message wrapping words is NOT a carrier', () => {
    expect(isCarrierEnvelope(grpMsg('hello'))).toBe(false);
  });

  it('the other four kinds are announced, not carried', () => {
    // A membership change leaves a row exactly as a timer change does; a room
    // deleted under you is a thing that happened to you.
    expect(isCarrierEnvelope(JSON.stringify({ tcm: 'grp.new', g: G, nm: 'K', ms: [M], n: 1 }))).toBe(
      false,
    );
    expect(isCarrierEnvelope(JSON.stringify({ tcm: 'grp.roster', g: G, m: M, s: 'in', n: 1 }))).toBe(
      false,
    );
    expect(isCarrierEnvelope(JSON.stringify({ tcm: 'grp.del', g: G, n: 1 }))).toBe(false);
    expect(isCarrierEnvelope(JSON.stringify({ tcm: 'grp.set', g: G, s: 30, n: 1 }))).toBe(false);
  });
});

describe('the x. reservation', () => {
  const unknown = '{"tcm":"x.ack","whatever":1}';

  it('is routed as a carrier BEFORE parsing — a shape this build has never seen', () => {
    expect(parseEnvelope(unknown)).toBeNull(); // genuinely unparseable here
    expect(isCarrierEnvelope(unknown)).toBe(true);
  });

  it('renders nothing at all — no row, no preview, no "unsupported" notice', () => {
    // Without the reservation this prints a visible `[unsupported message]`
    // row at exactly the rate any future x.* kind is emitted, in every build
    // that predates it. That is the whole reason to reserve it now.
    expect(previewFor(unknown)).toBe('');
    expect(displayText(unknown)).toBe('');
  });

  it('covers realistic extension names — digits and hyphens, not just letters and dots', () => {
    // The defect this pins shipped in both clients and was found only by the
    // CLI's three-client gate on a real wire: the declared-tcm pattern was
    // `[a-z][a-z.]{0,31}`, so a kind carrying a digit or a hyphen never
    // matched, never reached the namespace routing, and printed the visible
    // "unsupported message" row instead of nothing.
    //
    // Every existing test used a conformant name (`x.ack`, `x.task.handoff`),
    // which is exactly why it survived. A reservation whose names may only be
    // lowercase-and-dots is a trap that springs later and cannot be undone:
    // the first extension called `x.ack2` would be noisy on every build
    // already in the field, and those are the builds the reservation is FOR.
    for (const kind of ['x.ack2', 'x.task-handoff', 'x.e2e_probe', 'x.v2.ack']) {
      const body = `{"tcm":"${kind}","whatever":1}`;
      expect(isCarrierEnvelope(body)).toBe(true);
      expect(previewFor(body)).toBe('');
      expect(displayText(body)).toBe('');
    }
  });

  it('does not swallow an ordinary kind that merely starts with x', () => {
    // The prefix is `x.`, not `x` — a future `xray` kind must still be a
    // normal conversational unknown.
    const notReserved = '{"tcm":"xray","a":1}';
    expect(isCarrierEnvelope(notReserved)).toBe(false);
    expect(displayText(notReserved)).not.toBe('');
  });
});

describe('forward compatibility and the encode invariant', () => {
  it('an unknown grp.* kind reads as "unsupported", never as raw JSON', () => {
    // What a pre-rooms build does with a room message, and what THIS build does
    // with whatever comes next: a person is told their build is too old.
    const future = '{"tcm":"grp.future","g":"' + G + '"}';
    expect(displayText(future)).not.toContain(RAW);
    expect(displayText(future)).toBe(displayText('{"tcm":"grp.future","g":"x"}'));
    expect(displayText(future).length).toBeGreaterThan(0);
  });

  it('a grp.* this build cannot compose is refused, not silently mangled', () => {
    // The encode invariant: encodeEnvelope validates against the SAME schema
    // parseEnvelope reads, so a bad room message cannot reach the wire.
    expect(() =>
      encodeEnvelope({ tcm: 'grp.msg', g: 'not-a-ulid', m: M, rd: RD, b: 'hi' } as never),
    ).toThrow(EnvelopeRefusedError);
    expect(() => encodeEnvelope({ tcm: 'grp.msg', g: G, m: M, rd: RD, b: '' } as never)).toThrow(
      EnvelopeRefusedError,
    );
  });

  it('a malformed rd costs the digest and never the message', () => {
    // On a one-way ratchet a parser refusal is a permanent loss. The digest is
    // worth losing; the message is not.
    for (const rd of ['', 'AAA', 'A'.repeat(64), 'AAAA-AAA_AA', 'AAAAAAAAAAA=', 42]) {
      const parsed = parseEnvelope(grpMsg('still here', { rd }));
      expect(parsed).not.toBeNull();
      expect(parsed && 'b' in parsed ? parsed.b : null).toBe('still here');
    }
  });

  it('keeps a VALID digest — the permissive path must not disable detection', () => {
    const parsed = parseEnvelope(grpMsg('hi'));
    expect(parsed && 'rd' in parsed ? parsed.rd : null).toBe(RD);
  });
});

describe('no nesting, no laundering', () => {
  it('a room message may not wrap another room envelope', () => {
    expect(parseEnvelope(grpMsg(grpMsg('inner')))).toBeNull();
    expect(() =>
      encodeEnvelope({ tcm: 'grp.msg', g: G, m: M, rd: RD, b: grpMsg('inner') } as never),
    ).toThrow(EnvelopeRefusedError);
  });

  it('an author field a sender bolts on never survives encoding', () => {
    // zod strips unknown keys and encodeEnvelope stringifies the PARSED value,
    // so identity cannot ride the payload — it comes from frame.from.
    const encoded = encodeEnvelope({
      tcm: 'grp.msg',
      g: G,
      m: M,
      rd: RD,
      b: 'hi',
      authorId: '01XXXXXXXXXXXXXXXXXXXXXXXX',
    } as never);
    expect(encoded).not.toContain('authorId');
  });
});
