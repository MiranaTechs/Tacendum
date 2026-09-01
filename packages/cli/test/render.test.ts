import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_TEXT,
  maySpool,
  prefixLines,
  renderBody,
  sanitizeForTerminal,
  sanitizeServerField,
  type MentionNames,
} from '../src/render.js';

/**
 * the design plan The defect being fixed is one line of output:
 *
 *   [01J8...] {"tcm":"react","ref":"01J8...","ofs":false,"emoji":"..."}
 *
 * so every assertion here is about what a body LOOKS like, and about the two
 * kinds of thing that must never reach a terminal — raw envelope JSON, and a
 * secret a peer put in a vault item.
 */
describe('inbound body rendering', () => {
  it('leaves ordinary text exactly as it is', () => {
    // The e2e gates grep for the literal message text; this is that contract.
    const r = renderBody('hello bob — first contact 4211');
    expect(r).toEqual({ tcm: '', carrier: false, text: 'hello bob — first contact 4211' });
  });

  it('keeps a multi-line body legible', () => {
    // `--title` plus a piped build log is the entire premise of the product.
    const r = renderBody('build failed\nmake: *** [all] Error 1');
    expect(r.text).toBe('build failed\nmake: *** [all] Error 1');
  });

  it('renders conversation envelopes as something a human can read', () => {
    expect(renderBody('{"tcm":"image","att":"a","key":"k","w":800,"h":600}')).toMatchObject({
      carrier: false,
      text: '[photo 800x600]',
    });
    expect(renderBody('{"tcm":"shot"}')).toMatchObject({ carrier: false, text: '[screenshot]' });
    expect(renderBody('{"tcm":"timer","s":86400,"v":1}')).toMatchObject({
      carrier: false,
      text: '[disappearing messages on (86400s)]',
    });
    expect(renderBody('{"tcm":"timer","s":0,"v":2}')).toMatchObject({
      carrier: false,
      text: '[disappearing messages off]',
    });
    expect(renderBody('{"tcm":"reply","ref":"x","ofs":false,"text":"on my way"}')).toMatchObject({
      carrier: false,
      text: 'on my way',
    });
  });

  it('never prints an image blob id or its AES key', () => {
    const r = renderBody('{"tcm":"image","att":"ATT-ID","key":"AES-KEY","w":1,"h":1}');
    expect(r.text).not.toContain('ATT-ID');
    expect(r.text).not.toContain('AES-KEY');
  });

  it('never prints a vault title or body', () => {
    // A vault item is a door code or an SSH key. The app already keeps the
    // title out of previews because the title is itself the disclosure; a CI
    // log is a preview surface with a much longer memory.
    const body =
      '{"tcm":"vault","op":"set","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV",' +
      '"title":"Divorce lawyer login","body":"hunter2","n":1,"k":0}';
    const r = renderBody(body);
    expect(r.text).toBe('[vault item saved]');
    expect(r.text).not.toContain('Divorce');
    expect(r.text).not.toContain('hunter2');
    expect(renderBody('{"tcm":"vault","op":"del","id":"x","n":2,"k":0}').text).toBe(
      '[vault item removed]',
    );
  });

  it('classifies carriers as transport, not conversation', () => {
    // Mirrors app/src/envelope.ts isCarrierEnvelope: two clients on one
    // protocol must agree on what counts as a message.
    for (const body of [
      '{"tcm":"react","ref":"x","ofs":false,"emoji":"+1"}',
      '{"tcm":"profile","n":"CI — api-server","a":"","v":1}',
      '{"tcm":"edit","ref":"x","text":"fixed"}',
      '{"tcm":"del","ref":"x"}',
      '{"tcm":"read","ids":["a","b"]}',
    ]) {
      expect(renderBody(body).carrier).toBe(true);
      expect(renderBody(body).text).not.toContain('{"tcm"');
    }
    expect(renderBody('{"tcm":"profile","n":"CI — api-server","a":"","v":1}').text).toContain(
      'CI — api-server',
    );
    expect(renderBody('{"tcm":"read","ids":["a","b"]}').text).toBe('read receipt (2)');
  });

  it('says nothing at all for call signalling, parseable or not', () => {
    // Routed on the namespace BEFORE parsing, so a newer peer placing a call
    // cannot fill an older peer's terminal.
    expect(renderBody('{"tcm":"call.offer","cid":"C","sdp":"v=0"}')).toEqual({
      tcm: 'call.offer',
      carrier: true,
      text: '',
    });
    expect(renderBody('{"tcm":"call.future","cid":"C"').text).toBe('');
  });

  it('says NOTHING AT ALL for the reserved x. namespace, parseable or not', () => {
    // the design plan: `x.` is the machine-carrier namespace, reserved so a
    // future non-conversational kind is invisible to builds that predate it
    // instead of noisy in them. Routed on the prefix BEFORE parse — like
    // `call.` — because a carrier decided after parsing turns noisy the day
    // the shape changes.
    expect(renderBody('{"tcm":"x.ack","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}')).toEqual({
      tcm: 'x.ack',
      carrier: true,
      text: '',
    });
    // Truncated beyond parsing: still silence, which only pre-parse routing
    // can promise.
    expect(renderBody('{"tcm":"x.task.handoff","payload":').text).toBe('');
    // And carrier=true keeps it off the durable spool too.
    expect(renderBody('{"tcm":"x.ack","n":1}').carrier).toBe(true);

    // Realistic extension names — the defect the three-client gate found on a
    // real wire. The pattern gating this route was [a-z][a-z.]{0,31}, so a
    // kind with a digit or a hyphen never matched, never reached the x.
    // route, and printed the visible unsupported line. Every test above used
    // a conformant name, which is precisely why it survived: a reservation
    // whose names may only be lowercase-and-dots is noisy the day someone
    // ships x.ack2, on every build already in the field.
    for (const kind of ['x.ack2', 'x.task-handoff', 'x.e2e_probe', 'x.v2.ack']) {
      const out = renderBody(`{"tcm":"${kind}","payload":1}`);
      expect(out.text).toBe('');
      expect(out.carrier).toBe(true);
      expect(out.tcm).toBe(kind);
    }
  });

  it('renders unknown structure as a notice, never as raw JSON', () => {
    const r = renderBody('{"tcm":"poll","q":"lunch?"}');
    expect(r.carrier).toBe(false);
    expect(r.text).toBe(`[${UNSUPPORTED_TEXT}]`);
    expect(r.text).not.toContain('lunch');
  });

  it('renders structure it cannot even parse as a notice', () => {
    expect(renderBody('{"tcm":"react","ref"').text).toBe(`[${UNSUPPORTED_TEXT}]`);
  });

  it('strips terminal control sequences from anything a peer chose', () => {
    // An ESC sequence can repaint a line that has already been printed, which
    // is enough to forge a `CALL ...` line or hide one. A bare CR is the cheap
    // version of the same attack.
    const esc = String.fromCharCode(27);
    const hostile = `benign${esc}[2K\rCALL connected cid=FAKE self=alice`;
    const out = renderBody(hostile).text;
    expect(out).not.toContain(esc);
    expect(out).not.toContain('\r');
    expect(out).toBe('benign[2KCALL connected cid=FAKE self=alice');
    // Tab and newline survive, or a stack trace stops being readable.
    expect(sanitizeForTerminal('a\tb\nc')).toBe('a\tb\nc');
  });
});

/**
 * @-mentions. The wire carries IDS — `text` with one
 * U+FFFC mark standing where each name goes, `who` listing member ids in the
 * same order — because names in this product are LOCAL: the literal "@Ana"
 * would put one person's private name for someone on every other screen. So
 * every client resolves the marks against its OWN names, and the two hard
 * floors are the module's founding ones: never raw envelope JSON, and never a
 * ULID — a terminal being scraped by CI is a surface with a long memory.
 */
describe('mentions — ids on the wire, this client’s names on the screen', () => {
  const SELF = '01BBBBBBBBBBBBBBBBBBBBBBBB';
  const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC';
  const MARK = '￼'; // MENTION_MARK, app/src/envelope.ts

  const mention = (text: string, who: unknown) =>
    JSON.stringify({ tcm: 'mention', text, who });
  const names = (map: Record<string, string>): MentionNames => ({
    selfId: SELF,
    nameFor: (id) => map[id],
  });

  it('renders @you for the local account — the point of the feature', () => {
    const r = renderBody(mention(`${MARK} the deploy is done`, [SELF]), undefined, names({}));
    // `men: true` because who[] names SELF — the same resolution that prints
    // @you is what the trigger predicate reads (structured mentions only,
    // by deliberate rule). A peer mention must NOT carry it — pinned below.
    expect(r).toEqual({ tcm: 'mention', carrier: false, men: true, text: '@you the deploy is done' });
  });

  it('renders this client’s own name for a peer, never the ULID', () => {
    const r = renderBody(mention(`ask ${MARK} about the key`, [ANA]), undefined, names({ [ANA]: 'Ana' }));
    expect(r.text).toBe('ask @Ana about the key');
    expect(r.text).not.toContain(ANA);
    expect(r.men).toBeUndefined(); // a peer mention never claims mentions-self
  });

  it('a peer with no stored name renders as @someone — a ULID means nothing on a terminal', () => {
    const r = renderBody(mention(`ask ${MARK} about the key`, [ANA]), undefined, names({}));
    expect(r.text).toBe('ask @someone about the key');
    expect(r.text).not.toContain(ANA);
  });

  it('without any name context a mention still renders, and nobody becomes a ULID', () => {
    // The permissive floor with NOTHING injected: a surface that passes no
    // name context still never prints an id or the raw envelope.
    const r = renderBody(mention(`${MARK} ping`, [ANA]));
    expect(r.text).toBe('@someone ping');
    expect(r.text).not.toContain(ANA);
  });

  it('more marks than ids: the orphan mark drops, the words survive', () => {
    const r = renderBody(mention(`${MARK} and ${MARK} take a look`, [SELF]), undefined, names({}));
    expect(r.text).toBe('@you and  take a look');
    expect(r.text).not.toContain(MARK);
  });

  it('more ids than marks: the extras are never printed, in any form', () => {
    const r = renderBody(mention(`${MARK} take a look`, [SELF, ANA]), undefined, names({ [ANA]: 'Ana' }));
    expect(r.text).toBe('@you take a look');
    expect(r.text).not.toContain('Ana');
    expect(r.text).not.toContain(ANA);
  });

  it('an id that is not even a string drops its mark rather than inventing a person', () => {
    const r = renderBody(mention(`${MARK} hello`, [42]), undefined, names({}));
    expect(r.text).toBe(' hello');
    expect(r.text).not.toContain('42');
  });

  it('a mention with no readable words is a notice, never raw JSON and never silence', () => {
    for (const body of [
      JSON.stringify({ tcm: 'mention', who: [SELF] }),
      JSON.stringify({ tcm: 'mention', text: 42, who: [SELF] }),
      JSON.stringify({ tcm: 'mention', text: '', who: [SELF] }),
    ]) {
      const r = renderBody(body, undefined, names({}));
      expect(r.carrier).toBe(false);
      expect(r.text).toBe(`[${UNSUPPORTED_TEXT}]`);
      expect(r.text).not.toContain('{"tcm"');
    }
  });

  it('a stored name is stripped and bounded at display — the names file is an input too', () => {
    const esc = String.fromCharCode(27);
    const r = renderBody(
      mention(`${MARK} hi`, [ANA]),
      undefined,
      names({ [ANA]: `A${esc}[2K\rna${'x'.repeat(200)}` }),
    );
    expect(r.text).not.toContain(esc);
    expect(r.text).not.toContain('\r');
    expect(r.text.length).toBeLessThan(60);
  });

  it('a name that strips to nothing falls back to @someone, not to @', () => {
    const esc = String.fromCharCode(27);
    const r = renderBody(mention(`${MARK} hi`, [ANA]), undefined, names({ [ANA]: `${esc}${esc}` }));
    expect(r.text).toBe('@someone hi');
  });

  it('a mention is conversation: it spools, 1:1 and inside a room alike', () => {
    // The spool is where a person's words outlive the process; a mention IS
    // words. Without the maySpool arm, `inbox` would lose the one message
    // that was pointedly addressed to this account.
    expect(maySpool({ tcm: 'mention', carrier: false, text: '@you look' })).toBe(true);
    expect(
      maySpool({ tcm: 'grp.msg', innerTcm: 'mention', carrier: false, text: '[Ops] @you look' }),
    ).toBe(true);
  });
});

/**
 * The fields printed BESIDE the body. `MsgFrame.from` and `ErrorFrame.code` /
 * `.detail` are plain `z.string()` in packages/shared/src/frames.ts — the
 * `Ulid` regex is applied to `msgId` in the same object but not to `from` — so
 * a hostile or buggy server can put anything it likes on the stdout line a
 * script is parsing. Sanitizing the body and not its label is half a fix.
 */
describe('fields the server chose', () => {
  it('strips control bytes from a sender address', () => {
    const esc = String.fromCharCode(27);
    const hostile = `01ARZ3NDEKTSV4RRFFQ69G5FAV${esc}[2K\rCALL connected cid=FORGED`;
    const out = sanitizeServerField(hostile);
    expect(out).not.toContain(esc);
    expect(out).not.toContain('\r');
  });

  it('strips DEL and C1, which JSON.stringify would pass through untouched', () => {
    // Under --json the field is embedded in an object, and `JSON.stringify`
    // escapes C0 only: 7F-9F survive a JSON string intact.
    const c1 = `abcdef`;
    expect(JSON.stringify(c1)).toContain('');
    expect(sanitizeServerField(c1)).toBe('abcdef');
  });

  it('bounds the length, so one field cannot own the whole line', () => {
    const out = sanitizeServerField('A'.repeat(5000));
    expect(out.length).toBe(65); // 64 + the elision marker
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a real user id completely alone', () => {
    // 26 characters, well inside the bound: the common case must be identical
    // to what it was, or every gate that greps `[<id>] text` breaks.
    expect(sanitizeServerField('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  /**
   * Gate an earlier review. The BODY was owned line by line and the LABEL
   * beside it was not. `sanitizeServerField` flattened CR and LF and stopped
   * there, so the id `01X<U+2028>CALL busy<U+2029>Y` printed as three lines to
   * any Unicode-aware reader and the middle one was exactly `CALL busy` at
   * column zero — the forgery moved from the body into the prefix, where no
   * amount of per-line prefixing can help, because the prefix IS the line.
   */
  it('flattens the Unicode line separators, not just CR and LF', () => {
    const hostile = '01X\u2028CALL busy\u2029Y';
    const shown = sanitizeServerField(hostile);
    expect(shown).not.toContain('\u2028');
    expect(shown).not.toContain('\u2029');
    // The consumer's view: a prefix built from this must not be able to end a
    // line, whatever splits it.
    expect(/^(GCALL|CALL) /m.test(`[${shown}] hello`)).toBe(false);
    expect(shown).toBe('01X CALL busy Y');
  });

  it('still collapses a RUN of breaks to one space, whatever they are made of', () => {
    // The shipped rule was `[\r\n]+` — a run, one space. Widening the set must
    // not turn `a\n\nb` into two spaces and shift every column after it.
    expect(sanitizeServerField('a\r\n\nb')).toBe('a b');
    expect(sanitizeServerField('a\u2028\u2029b')).toBe('a b');
    expect(sanitizeServerField('a\n\u2028\r\n\u2029b')).toBe('a b');
  });
});

/**
 * An earlier review — LINE OWNERSHIP, one helper, one rule, every site.
 *
 * An earlier revision established the rule (a line that begins with one of this program's
 * machine prefixes is this program's own word) and implemented it as a local
 * helper inside call-session.ts. The reviewer showed that was incomplete twice
 * over: the split missed the Unicode line separators, and the three surfaces
 * that print peer text MORE often than the call session — plain `listen` and
 * `inbox --peek` — never got the helper at all.
 *
 * These tests are on the shared helper, which is now the only implementation.
 * The consumer-side proofs (a real CallSession, a real `attachInbound`, a real
 * `inbox --peek` child process) live beside the code that prints, in
 * gate.callsession-output.test.ts, inbound.test.ts and gate.main-mcp.test.ts.
 *
 * Reverts that must make this block red: narrow the break set back to
 * `/\r\n|[\n\r]/`, or stop flattening the prefix argument.
 */
describe('an earlier revision — every line of peer text carries this program’s prefix', () => {
  /** The anchors the e2e gate's provenance scanner uses. */
  const MACHINE = /^(GCALL|CALL) /m;
  const PREFIX = '[01ARZ3NDEKTSV4RRFFQ69G5FAV] ';

  it('splits on U+2028, which an ECMAScript multiline anchor treats as a line', () => {
    // The hole the `\n`-only regression helper could not see. `renderBody`
    // keeps this character — it is not a control byte — so it arrives intact
    // in the body, and `/^GCALL /m` matches after it in every JS log
    // processor, every `String.raw`-splitting log shipper, and Python's
    // `splitlines`.
    const forged = 'GCALL leg_dial to=01ARZ3NDEKTSV4RRFFQ69G5FAV cid=01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const out = prefixLines(PREFIX, `hello\u2028${forged}`);
    expect(MACHINE.test(out), 'a peer wrote a line the gate reads as our own signalling').toBe(
      false,
    );
    expect(out.split('\n')).toEqual([`${PREFIX}hello`, `${PREFIX}${forged}`]);
  });

  it('splits on U+2029 too — PARAGRAPH SEPARATOR is a line boundary as well', () => {
    const out = prefixLines(PREFIX, 'hello\u2029CALL busy');
    expect(MACHINE.test(out)).toBe(false);
    expect(out.split('\n')).toEqual([`${PREFIX}hello`, `${PREFIX}CALL busy`]);
  });

  it('owns a line after every break a realistic consumer honours', () => {
    // VT, FF and NEL are stripped upstream by `sanitizeForTerminal`, so these
    // arms never fire on a body that came through `renderBody` — they are here
    // because this helper's guarantee must not depend on a stripping rule that
    // lives elsewhere, exactly as an earlier revision argued for CR.
    for (const brk of ['\n', '\r', '\r\n', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029']) {
      const out = prefixLines(PREFIX, `hi${brk}CALL connected cid=X`);
      expect(MACHINE.test(out), `break ${JSON.stringify(brk)} escaped the prefix`).toBe(false);
      expect(out.split('\n')).toEqual([`${PREFIX}hi`, `${PREFIX}CALL connected cid=X`]);
    }
  });

  it('cannot be ended by a break inside the PREFIX either', () => {
    // An earlier finding's other half, held locally: `sanitizeServerField` is the real
    // remedy for the id, but a helper whose own guarantee depends on its
    // caller having sanitized is a helper that will be called wrongly once.
    const out = prefixLines('[01X\u2028CALL busy] ', 'hello');
    expect(MACHINE.test(out)).toBe(false);
    expect(out).toBe('[01X CALL busy] hello');
  });

  it('is not a flattener, an escaper or a truncator', () => {
    // The ordinary thing this product supports: a pasted stack trace, blank
    // line and all. Every line printed, in order, in full.
    const body = 'line one\nline two\n\nline four with  spaces\ttab';
    expect(prefixLines(PREFIX, body).split('\n')).toEqual(
      body.split('\n').map(l => `${PREFIX}${l}`),
    );
  });

  it('leaves a single-line message byte-identical to what it always was', () => {
    // Every gate that greps `[<id>] <text>` reads this.
    expect(prefixLines(PREFIX, 'hello there')).toBe(`${PREFIX}hello there`);
    expect(prefixLines(PREFIX, '')).toBe(PREFIX);
  });

  it('does not mangle emoji, RTL text or combining marks', () => {
    // Nothing here is a code-unit walk, and no bound is applied: a surrogate
    // pair, a bidi run and a decomposed grapheme must survive byte-exact.
    const body = '👩🏽‍🚀 هذه رسالة ‫عربية‬ ȩ́ 🇯🇵';
    expect(prefixLines(PREFIX, body)).toBe(`${PREFIX}${body}`);
    const multi = `👩🏽‍🚀 first\nثانية ȩ́`;
    expect(prefixLines(PREFIX, multi).split('\n')).toEqual([
      `${PREFIX}👩🏽‍🚀 first`,
      `${PREFIX}ثانية ȩ́`,
    ]);
  });
});
