import {
  aiOriginOf,
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  parseEnvelope,
  previewFor,
  rewriteBody,
} from '../src/envelope';

/**
 * The Art. 50 AI-origin marker on the app's parse side. Four rules this file holds down:
 *
 *  1. `msg` — marked bare text — is CONVERSATION: it renders as its words,
 *     previews as its words, and is never a carrier. The CLI is its only
 *     composer; this side must read it or an agent's every reply becomes
 *     "Unsupported message" on the exact build that shipped the marker.
 *  2. The marker is READ, never trusted beyond its honest claim: `aiOriginOf`
 *     answers only "did this envelope carry ai:true" — a malformed marker
 *     collapses to unmarked and the words survive (the marker costs
 *     itself, never the message).
 *  3. The room wrapper carries the marker (grp.msg `ai`) so a bare-text `b`
 *     stays renderable on every pre-marker build.
 *  4. An edit applied to a marked `msg` row REWRITES THE WORDS AND KEEPS THE
 *     WRAPPER — an agent correcting itself must not shed its own disclosure.
 *
 * Plus the tolerance pin the whole phase stands on: a KNOWN kind carrying an
 * UNKNOWN field parses (zod strip mode) — the deployed-build fact that made
 * ungated envelope marking deployable. Pinned so a future `.strict()` is loud.
 */

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MSG = '{"tcm":"msg","text":"the build is green","ai":true}';

describe('the msg kind (marked bare text)', () => {
  it('parses with the marker; the words are the display text and the preview', () => {
    const env = parseEnvelope(MSG);
    expect(env?.tcm).toBe('msg');
    expect(aiOriginOf(env)).toBe(true);
    expect(displayText(MSG)).toBe('the build is green');
    expect(previewFor(MSG)).toBe('the build is green');
  });

  it('is conversation, never a carrier — a row appears, the preview moves', () => {
    expect(isCarrierEnvelope(MSG)).toBe(false);
  });

  it('parses unmarked too, and a malformed marker costs the marker, never the words', () => {
    const unmarked = parseEnvelope('{"tcm":"msg","text":"plain"}');
    expect(unmarked?.tcm).toBe('msg');
    expect(aiOriginOf(unmarked)).toBe(false);
    const malformed = parseEnvelope('{"tcm":"msg","text":"still here","ai":"yes"}');
    expect(malformed?.tcm).toBe('msg');
    expect(aiOriginOf(malformed)).toBe(false);
    expect(displayText('{"tcm":"msg","text":"still here","ai":"yes"}')).toBe('still here');
  });

  it('is encodable — the cannot-parse⇒cannot-encode invariant covers it', () => {
    const bytes = encodeEnvelope({ tcm: 'msg', text: 'ok', ai: true });
    expect(parseEnvelope(bytes)).toEqual({ tcm: 'msg', text: 'ok', ai: true });
  });

  it('through the room wrapper: displayText and previewFor reach the words', () => {
    const wrapped = JSON.stringify({
      tcm: 'grp.msg',
      g: ULID,
      m: ULID,
      rd: 'AAAAAAAAAAA',
      sq: 1,
      b: MSG,
    });
    expect(displayText(wrapped)).toBe('the build is green');
    expect(previewFor(wrapped)).toBe('the build is green');
  });
});

describe('the marker on the kinds the agent lane composes', () => {
  it('grp.msg retains the wrapper marker', () => {
    const wrapped = parseEnvelope(
      JSON.stringify({
        tcm: 'grp.msg',
        g: ULID,
        m: ULID,
        rd: 'AAAAAAAAAAA',
        sq: 1,
        b: 'bare words',
        ai: true,
      }),
    );
    expect(wrapped?.tcm).toBe('grp.msg');
    expect(aiOriginOf(wrapped)).toBe(true);
  });

  it('edit retains the marker; x.typing retains it; neither changes its behaviour', () => {
    const edit = parseEnvelope(
      JSON.stringify({ tcm: 'edit', ref: ULID, text: 'corrected', ai: true }),
    );
    expect(edit?.tcm).toBe('edit');
    expect(aiOriginOf(edit)).toBe(true);
    const typing = parseEnvelope(
      JSON.stringify({ tcm: 'x.typing', state: 'start', ai: true }),
    );
    expect(typing?.tcm).toBe('x.typing');
    expect(aiOriginOf(typing)).toBe(true);
    // Still a carrier by namespace — the marker never makes chatter visible.
    expect(isCarrierEnvelope('{"tcm":"x.typing","state":"start","ai":true}')).toBe(true);
  });

  it('a human envelope without the field reads unmarked — absence is the claim', () => {
    expect(aiOriginOf(parseEnvelope('{"tcm":"shot"}'))).toBe(false);
    expect(aiOriginOf(null)).toBe(false);
  });
});

describe('rewriteBody keeps the wrapper on a marked msg row', () => {
  it('an edit applied to a msg body rewrites the words inside the envelope, marker intact', () => {
    const rewritten = rewriteBody(MSG, 'the build is green, and deployed');
    const env = parseEnvelope(rewritten);
    expect(env).toEqual({ tcm: 'msg', text: 'the build is green, and deployed', ai: true });
  });

  it('an unmarked msg body keeps its envelope too — the wrapper is the kind, not the marker', () => {
    const rewritten = rewriteBody('{"tcm":"msg","text":"before"}', 'after');
    expect(parseEnvelope(rewritten)).toEqual({ tcm: 'msg', text: 'after' });
  });
});

describe('the deployed-parser tolerance pin', () => {
  it('a KNOWN kind carrying an unknown field parses and strips it — the fact ungated marking stands on', () => {
    const reply = parseEnvelope(
      JSON.stringify({ tcm: 'reply', ref: ULID, ofs: false, text: 'yes', zz: 'stowaway' }),
    );
    expect(reply?.tcm).toBe('reply');
    expect(reply).not.toHaveProperty('zz');
  });
});
