import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DETAIL_MAX } from '@tacendum/shared/rounds';

const home = mkdtempSync(join(tmpdir(), 'tacendum-render-rounds-'));
process.env.TACENDUM_HOME = home;

const { renderBody, maySpool } = await import('../src/render.js');
const { groupBodyRenderer } = await import('../src/room-render.js');
// The reader that PAYS for a bad cut: mcp.ts withholds a whole message whose
// text holds a lone surrogate. Asserting with its own regex, rather than a
// second copy of the range, is why this test can fail for the real reason.
const { LONE_SURROGATE } = await import('../src/mcp.js');

/**
 * task 1-2: the DETAIL crosses `render.ts`'s `msg` and
 * `reply` arms and rides the `grp.msg` wrapper up like `ref`/`ofs`.
 *
 * The property under test is a SPLIT, not a string: `text` stays the brief on
 * every surface and the detail is a separate field, because the alternative —
 * concatenating them here — would make the display string a wire format and
 * force every reader downstream to re-parse it back apart (`peerName`'s
 * argument, applied to the longest text on the path).
 */

// Crockford base32 (no I, L, O, U), so these survive every ULID guard and the
// tests assert about the rules rather than about the filters.
const ROOM = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const REF = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC'; // the room owner
const BEN = '01DDDDDDDDDDDDDDDDDDDDDDDD'; // "this client"

const reply = (fields: Record<string, unknown>) =>
  JSON.stringify({ tcm: 'reply', ref: REF, ofs: false, ...fields });
const msg = (fields: Record<string, unknown>) => JSON.stringify({ tcm: 'msg', ...fields });

describe('the detail crosses the renderer as its own field', () => {
  it('reads `d` on the reply arm and leaves `text` the brief', () => {
    const r = renderBody(reply({ text: 'the token refresh is the fault', d: 'Full finding:\n\nthe refresh runs on the request thread.' }));
    expect(r.tcm).toBe('reply');
    expect(r.carrier).toBe(false);
    // The brief is UNCHANGED — not the brief plus the detail, not a joined
    // string a reader would have to split.
    expect(r.text).toBe('the token refresh is the fault');
    expect(r.detail).toBe('Full finding:\n\nthe refresh runs on the request thread.');
    // …and the routing the reply already carried is untouched by the new field.
    expect(r.ref).toBe(REF);
    expect(r.ofs).toBeUndefined();
  });

  it('reads `d` on the msg arm — a 1:1 attend answer keeps its kind (R3)', () => {
    const r = renderBody(msg({ text: 'build is green', d: 'ran 412 tests, 0 failures', ai: true }));
    expect(r.tcm).toBe('msg');
    expect(r.text).toBe('build is green');
    expect(r.detail).toBe('ran 412 tests, 0 failures');
  });

  it('never cuts an astral character in half at the DETAIL_MAX bound', () => {
    // The pair straddles the bound: 2 999 units of filler, then U+1F600 (two
    // units, at indices 2999 and 3000), then more. A plain `slice(0, 3000)`
    // keeps the HIGH half alone — and the invalid sequence is then OURS, not
    // the sender's, while mcp.ts's rejection would blame the sender for it
    // and withhold the whole message as `invalid_utf8`. `capDetail` trims the
    // orphan on the compose side; this is the same trim on the read side, for
    // every peer that did not cap.
    const straddling = 'a'.repeat(DETAIL_MAX - 1) + '\u{1F600}' + 'tail';
    const r = renderBody(msg({ text: 'brief', d: straddling }));
    const detail = r.detail as string;
    expect(detail.length).toBe(DETAIL_MAX - 1);
    expect(LONE_SURROGATE.test(detail)).toBe(false);
    // Nothing else moved: the brief is untouched and the whole detail is the
    // filler that fit, with no half-character on the end.
    expect(r.text).toBe('brief');
    expect(detail).toBe('a'.repeat(DETAIL_MAX - 1));

    // A pair that ENDS exactly on the bound is kept whole — the guard trims
    // an orphan, it does not shorten every capped detail by one.
    const aligned = 'b'.repeat(DETAIL_MAX - 2) + '\u{1F600}' + 'tail';
    const kept = renderBody(msg({ text: 'brief', d: aligned })).detail as string;
    expect(kept.length).toBe(DETAIL_MAX);
    expect(kept.endsWith('\u{1F600}')).toBe(true);
    expect(LONE_SURROGATE.test(kept)).toBe(false);
  });

  it('sets NO field at all when there is no detail to disclose', () => {
    // Absent, empty, non-string and control-only each mean the same thing on
    // this side of `roundDetail`'s `.min(1)`: there is no more to show. The
    // key must be ABSENT rather than '' — a disclosure control over nothing
    // is a lie about there being more, and `'detail' in r` is what a spool
    // literal and an MCP body both key on.
    for (const body of [
      reply({ text: 'no detail here' }),
      reply({ text: 'no detail here', d: '' }),
      reply({ text: 'no detail here', d: 42 }),
      reply({ text: 'no detail here', d: { nested: 'object' } }),
      // A detail of nothing but control characters sanitizes to '', and
      // '' is no detail — the same answer by a different route.
      reply({ text: 'no detail here', d: '\u0000\u001b\u009f' }),
      msg({ text: 'no detail here' }),
      msg({ text: 'no detail here', d: '' }),
      msg({ text: 'no detail here', d: null }),
    ]) {
      const r = renderBody(body);
      expect(r.text).toBe('no detail here');
      expect('detail' in r).toBe(false);
    }
  });

  it('cuts at DETAIL_MAX — the shared number, not `str`’s 4096 and not 80', () => {
    // A 3 000-unit detail is legal on the wire, so it must arrive WHOLE: a
    // reader cutting shorter than the composer's own schema would disagree
    // with the writer about what a legal detail is.
    const exact = 'y'.repeat(DETAIL_MAX);
    expect(renderBody(reply({ text: 'b', d: exact })).detail).toBe(exact);
    expect(renderBody(msg({ text: 'b', d: exact })).detail).toBe(exact);

    // …and one unit longer loses its tail HERE rather than downstream.
    const over = 'z'.repeat(DETAIL_MAX + 500);
    const cut = renderBody(reply({ text: 'b', d: over })).detail;
    expect(cut?.length).toBe(DETAIL_MAX);
    // Pinned against the two bounds this could have been written with by
    // accident: `str`'s default 80 and its text-field 4096.
    expect(cut?.length).not.toBe(80);
    expect(cut?.length).not.toBe(4096);
  });

  it('sanitizes the detail exactly as it sanitizes the brief', () => {
    // The detail reaches a terminal (`inbox --detail`) and an MCP body, so a
    // peer's ESC must not survive it any more than it survives `text` — while
    // the newlines and tabs a finding is written in DO survive, because prose
    // has lines and that is the whole premise of a detail.
    const r = renderBody(
      reply({ text: 'brief', d: 'line one\n\tindented\u001b[2Jline two\u009f end' }),
    );
    expect(r.detail).toBe('line one\n\tindented[2Jline two end');
    expect(r.detail).not.toContain('\u001b');
    expect(r.detail).not.toContain('\u009f');
    expect(r.detail).toContain('\n');
    expect(r.detail).toContain('\t');
  });

  it('never lets a detail resurrect a message with no words', () => {
    // An empty `text` is still the unsupported notice, detail or no detail: a
    // body with nothing said in it is not made into conversation by carrying
    // a second field, and `maySpool` refuses it either way.
    const r = renderBody(reply({ text: '', d: 'a detail with no brief' }));
    expect(r.text).not.toBe('');
    expect('detail' in r).toBe(false);
    expect(maySpool(r)).toBe(true); // the visible notice is still a reply row
    expect(r.text).not.toContain('a detail with no brief');
  });
});

describe('the grp.msg wrapper carries the detail up', () => {
  /** Render one body as `client` (self = BEN), authenticated sender `from`. */
  const render = (client: string, from: string, body: string) =>
    renderBody(body, groupBodyRenderer(client, BEN, from));

  const newRoom = JSON.stringify({
    tcm: 'grp.new',
    g: ROOM,
    nm: 'Kitchen',
    ms: [ANA, BEN],
    n: 1,
  });
  const wrap = (b: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: MSG, b, ...extra });

  it('passes the inner detail up beside ref/ofs/grp/rm/ai — unprefixed', () => {
    const c = 'wrapper';
    render(c, ANA, newRoom); // anchor the room through the real path

    const r = render(
      c,
      ANA,
      wrap(reply({ text: 'the retry storm is ours', d: 'Full finding:\nthe backoff resets on 429.' }), {
        ai: true,
      }),
    );
    // The room label prefixes the LINE a terminal prints…
    expect(r.text).toBe('[Kitchen] the retry storm is ours');
    // …and does not prefix the detail, which is shown on its own under a
    // brief that already names the room.
    expect(r.detail).toBe('Full finding:\nthe backoff resets on 429.');
    expect(r.detail?.startsWith('[Kitchen]')).toBe(false);
    // The fields that already rode the wrapper still ride it.
    expect(r.grp).toBe(ROOM);
    expect(r.rm).toBe(MSG);
    expect(r.ai).toBe(true);
    expect(r.ref).toBe(REF);
    expect(maySpool(r)).toBe(true);
  });

  it('carries no detail when the inner body has none', () => {
    const c = 'wrapper-none';
    render(c, ANA, newRoom);
    const r = render(c, ANA, wrap(reply({ text: 'just words' })));
    expect(r.text).toBe('[Kitchen] just words');
    expect('detail' in r).toBe(false);
  });

  it('does NOT relay a detail out of a shared history entry', () => {
    // A relayed entry is an unauthenticated claim about a third party's
    // words, answered by ONE framed sentence that carries the caveat. A
    // detail is shown away from that frame, so relaying one would strip the
    // only thing keeping the claim honest — and would do it to the longest
    // text on the path.
    const c = 'hist';
    render(c, ANA, newRoom);
    const r = render(
      c,
      ANA,
      JSON.stringify({
        tcm: 'grp.hist',
        g: ROOM,
        n: 1,
        to: BEN,
        c: 1,
        e: {
          m: MSG,
          a: ANA,
          t: 1,
          b: reply({ text: 'earlier words', d: 'the whole earlier finding' }),
        },
      }),
    );
    expect(r.text).toContain('earlier words');
    expect(r.text).not.toContain('the whole earlier finding');
    expect('detail' in r).toBe(false);
  });
});
