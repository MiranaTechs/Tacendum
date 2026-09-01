/**
 * The approval pair, where the app meets it: the union, the carrier
 * classification, and the SILENCE — this phase registers the kinds and
 * nothing else, so the whole card surface is a later phase's and the only
 * observable behaviour here is that both kinds parse, encode, and show
 * nothing anywhere.
 *
 * The fixture is `packages/shared/approvalvectors.json`, parsed
 * byte-identically by the shared suite, this one, and the CLI's
 * `gate.approval-wire-silence.test.ts` — three clients agreeing on committed
 * bytes, not on prose (the `authvectors.json` pattern).
 */

import {
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  parseEnvelope,
  previewFor,
  EnvelopeRefusedError,
} from '../src/envelope';

interface VectorCase {
  name: string;
  kind: string;
  valid: boolean;
  note: string;
  body: string;
}

// The committed cross-client fixture, by relative path: the shared package's
// exports map has no subpath for it, and the bytes are the point.
const vectors = require('../../packages/shared/approvalvectors.json') as {
  cases: VectorCase[];
};

const vector = (name: string): VectorCase => {
  const found = vectors.cases.find(c => c.name === name);
  if (!found) throw new Error(`approvalvectors.json is missing the '${name}' case`);
  return found;
};

const RAW = '{"tcm":';

describe('the union accepts both kinds — from the committed fixture bytes', () => {
  it('the request parses', () => {
    const parsed = parseEnvelope(vector('request').body);
    expect(parsed).not.toBeNull();
    expect(parsed?.tcm).toBe('x.approval');
  });

  it('the answer parses', () => {
    const parsed = parseEnvelope(vector('answer').body);
    expect(parsed).not.toBeNull();
    expect(parsed?.tcm).toBe('x.approval.answer');
  });

  it('the unknown-verb cases parse — a verb is a bounded string, never an enum', () => {
    // Accepted by schema; the consumer rule (documented in the fixture and
    // enforced where verbs are applied): a verb this build does not
    // recognise renders no button and NEVER reads as approve.
    const req = parseEnvelope(vector('request-unknown-verb').body);
    expect(req?.tcm).toBe('x.approval');
    expect(req && 'a' in req ? req.a : null).toEqual(['approve', 'deny', 'escalate']);
    const ans = parseEnvelope(vector('answer-unknown-verb').body);
    expect(ans && 'v' in ans ? ans.v : null).toBe('escalate');
  });

  it('the invalid cases refuse at the parser — and STILL show nothing (the x. drop is the floor)', () => {
    for (const name of ['request-overcap', 'request-wrong-tag']) {
      const { body } = vector(name);
      expect(parseEnvelope(body)).toBeNull();
      // The generic prefix drop catches what the union refuses: silent,
      // never an "unsupported" row, never raw JSON.
      expect(isCarrierEnvelope(body)).toBe(true);
      expect(previewFor(body)).toBe('');
      expect(displayText(body)).toBe('');
    }
  });
});

describe('carriers by namespace — silence is pinned, per kind', () => {
  const bodies = ['request', 'answer'].map(name => vector(name).body);

  it.each(bodies)('is a carrier, routed on the prefix', body => {
    expect(isCarrierEnvelope(body)).toBe(true);
  });

  // The pinned absence: NO previewFor/displayText branch exists for these
  // kinds, and none is needed — the `x.` prefix already yields ''. If someone
  // adds a branch that renders anything, these fail first.
  it.each(bodies)('previews as nothing', body => {
    expect(previewFor(body)).toBe('');
  });

  it.each(bodies)('displays as nothing', body => {
    expect(displayText(body)).toBe('');
  });

  it.each(bodies)('survives the failed-bubble fallback without printing JSON', body => {
    // `previewFor(body) || body` is how raw {"tcm": has reached a screen
    // twice before; carriers take the '' arm.
    const shown = previewFor(body) || (isCarrierEnvelope(body) ? '' : body);
    expect(shown).not.toContain(RAW);
    expect(shown).toBe('');
  });
});

describe('the encode invariant — cannot-parse ⇒ cannot-encode', () => {
  it('what this build parses it can re-encode, and the wire bytes round-trip', () => {
    for (const name of ['request', 'answer']) {
      const parsed = parseEnvelope(vector(name).body);
      expect(parsed).not.toBeNull();
      const encoded = encodeEnvelope(parsed as never);
      // Not asserted byte-identical to the fixture (key order is the
      // schema's, not the fixture author's) — asserted to MEAN the same.
      expect(parseEnvelope(encoded)).toEqual(parsed);
    }
  });

  it('a request this build cannot parse is refused at compose, loudly', () => {
    expect(() =>
      encodeEnvelope({
        tcm: 'x.approval',
        q: 'not-a-ulid',
        k: 'exec',
        p: 'rm -rf /',
        x: 600,
        a: ['approve', 'deny'],
      } as never),
    ).toThrow(EnvelopeRefusedError);
    // The over-cap payload the CLI already refuses as an instant deny can
    // never be composed here either — one cap, both ends.
    expect(() =>
      encodeEnvelope({
        tcm: 'x.approval',
        q: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
        k: 'exec',
        p: 'x'.repeat(16 * 1024 + 1),
        x: 600,
        a: ['approve', 'deny'],
      } as never),
    ).toThrow(EnvelopeRefusedError);
  });

  it('an answer with a raw session id in s is refused at compose — the tag or nothing', () => {
    expect(() =>
      encodeEnvelope({
        tcm: 'x.approval.answer',
        q: '01J8MEAPPR0VAQ4X2C6TKN9RFV',
        v: 'approve',
        s: 'aaaaaaaa-1111-4111-8111-111111111111',
        n: 10,
      } as never),
    ).toThrow(EnvelopeRefusedError);
  });
});
