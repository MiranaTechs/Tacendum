/**
 * ROUNDS — the shared wire (§3.1). Five things this
 * file exists to hold down:
 *
 * 1. **The two fragments are not one fragment (R24).** `roundDetail` is the
 *    receive side and COLLAPSES; `roundDetailStrict` is the compose side and
 *    FAILS. The pair is tested against the same inputs in the same block,
 *    because the whole defect this design avoids is a refusal expressed inside
 *    a `.catch`-ed schema — which can never report failure, and so is not a
 *    refusal at all.
 *
 * 2. **The detail costs itself, never the message.** Over-cap, empty,
 *    sentinel-leading, wrong-typed: every one of them parses to "no detail"
 *    rather than refusing the envelope, because a parser refusal on a one-way
 *    ratchet is a permanent message loss (§5.5).
 *
 * 3. **Truncation is visible (R4).** `capDetail` fits its marker INSIDE
 *    `DETAIL_MAX` and is a fixed point, so a re-render cannot stack a second
 *    marker on a string that already carries one.
 *
 * 4. **The normalization is load-bearing, not hygiene (R23), and it has TWO
 *    classes.** The byte budget's 4-bytes-per-unit worst case is only true
 *    because C0/C1 controls AND unpaired surrogates are gone before
 *    `JSON.stringify` sees them; either one costs 7 wire bytes per UTF-16 unit
 *    and overflows `MAX_BODY_BYTES` INSIDE the fan-out, where the refusal is
 *    misreported to the owner as "no room" for a turn that was in fact
 *    answered. Both classes are asserted OVER the cap raw and UNDER it capped,
 *    and a well-formed astral pair is asserted to survive untouched — it is
 *    the cheapest content on the wire, not a thing to strip.
 *
 * 5. **The budget is COMPUTED from the real constants.** `MAX_BODY_BYTES` and
 *    `MAX_GROUP_BODY` are imported, never mirrored: a hard-coded 13 393 here
 *    would be exactly the drift the mirror discipline exists to prevent
 *    (`ai-origin.ts:MAX_AGENT_TEXT`'s comment holds the argument). R13 draws
 *    the line on purpose — import the number, mirror the pattern.
 *
 * `MAX_BODY_BYTES` is READ OUT OF the CLI's source rather than imported from
 * it, which is the precedent this suite already sets for reaching across a
 * package (`group-fold.test.ts`, `recovery.test.ts`, `call-session.test.ts`
 * all `readFileSync` a sibling's source). §3.1's requirement is that the
 * budget be COMPUTED and never quoted, and a read satisfies it; a runtime
 * `import` of `packages/cli/src/send.js` does not, because it drags the CLI's
 * whole send graph in with the number. Measured: `send.ts` reaches `config.ts`,
 * which runs `resolveEndpoints(process.env)` at import time and THROWS for any
 * `TACENDUM_ENV` that is not `local`/`aws` — so `TACENDUM_ENV=staging` made
 * this pure schema file fail to COLLECT for a reason with nothing to do with
 * the thing under test — and `loadEnvFileIfPresent(findRepoEnvFile(...))`,
 * which MUTATES `process.env` from the checkout's `.env` inside the shared
 * worker, and it printed an endpoint banner into a previously silent suite.
 * The read throws a named error if the declaration's form ever changes, so the
 * mirror cannot rot quietly.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX,
  DETAIL_MAX,
  ROUND_KEY_RE,
  capDetail,
  detailTruncationMarker,
  roundDetail,
  roundDetailStrict,
  roundKeyAuthor,
  stripWireControls,
} from '../src/rounds.js';
import { MAX_GROUP_BODY } from '../src/group-envelope.js';
import { MAX_PAYLOAD_B64_LENGTH } from '../src/frames.js';

/**
 * `packages/cli/src/send.ts:MAX_BODY_BYTES`, read out of the source for the
 * reason the header gives. Computed from the declaration's own factors, so a
 * changed cap changes this number; a changed FORM throws by name here instead
 * of silently mirroring a stale value.
 */
const MAX_BODY_BYTES = (() => {
  const source = readFileSync(new URL('../../cli/src/send.ts', import.meta.url), 'utf8');
  const match = /export const MAX_BODY_BYTES = (\d+) \* (\d+);/.exec(source);
  if (match === null) {
    throw new Error(
      'packages/cli/src/send.ts no longer declares MAX_BODY_BYTES as `a * b`; ' +
        'update this read so the byte budget stays computed rather than quoted',
    );
  }
  return Number(match[1]) * Number(match[2]);
})();

const ULID_A = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
const ULID_B = '01J8MEB0X4KQZ7Y9W2N5H3T8DC';
/** The §5.3 room content ref: `${authorId}.${msgId}`, 53 characters. */
const ROUND_KEY = `${ULID_A}.${ULID_B}`;

/** Every input the receive side must swallow and the compose side must refuse. */
const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
  ['one unit over the cap', 'a'.repeat(DETAIL_MAX + 1)],
  ['the empty string', ''],
  ['a leading envelope sentinel', '{"tcm":"del","ref":"01ABC"}'],
  ['null', null],
  ['a number', 42],
  ['an object', { d: 'nice try' }],
  ['an array', ['nice try']],
  ['a boolean', true],
];

describe('the caps', () => {
  it('are the ruled numbers, in one place', () => {
    expect(BRIEF_MAX).toBe(280);
    expect(DETAIL_MAX).toBe(3_000);
  });

  it('leave the brief strictly tighter than the reply budget it rides inside (R14)', () => {
    // ATTEND_REPLY_CAP is 2 000 and is NOT imported: it lives in the CLI's
    // attend path and this assertion is about DIRECTION, not about its value.
    // Tightening a ruled reading budget needs no new ruling; loosening it does.
    expect(BRIEF_MAX).toBeLessThan(2_000);
  });
});

describe('roundDetail — the RECEIVE fragment', () => {
  it('accepts a detail at exactly the cap, and one below it', () => {
    const at = 'a'.repeat(DETAIL_MAX);
    expect(roundDetail.parse(at)).toBe(at);
    expect(roundDetail.parse('a finding, in full')).toBe('a finding, in full');
  });

  it('accepts absence — the field is optional and always was', () => {
    expect(roundDetail.parse(undefined)).toBeUndefined();
  });

  it('accepts a sentinel quoted mid-sentence — only the LEADING one is a forgery', () => {
    const prose = 'bodies that start with {"tcm": are refused, which is the point';
    expect(roundDetail.parse(prose)).toBe(prose);
  });

  for (const [label, value] of REFUSED) {
    it(`collapses ${label} to "no detail" instead of throwing`, () => {
      expect(roundDetail.parse(value)).toBeUndefined();
      // The distinction that matters: it did not throw, so the WORDS around it
      // would still have landed.
      expect(() => roundDetail.parse(value)).not.toThrow();
    });
  }
});

describe('roundDetailStrict — the COMPOSE fragment (R24)', () => {
  it('accepts exactly what the receive side accepts', () => {
    const at = 'a'.repeat(DETAIL_MAX);
    expect(roundDetailStrict.safeParse(at).success).toBe(true);
    expect(roundDetailStrict.safeParse(undefined).success).toBe(true);
  });

  for (const [label, value] of REFUSED) {
    it(`FAILS on ${label}, where the receive fragment collapses`, () => {
      // The pair, in one assertion block: this is what makes R24 visible. A
      // single permissive fragment would report success here and silently emit
      // a brief-only body, with no signal to anybody.
      expect(roundDetailStrict.safeParse(value).success).toBe(false);
      expect(roundDetail.parse(value)).toBeUndefined();
    });
  }
});

describe('stripWireControls (R23)', () => {
  it('drops every C0 and C1 control, DEL included', () => {
    expect(stripWireControls('a\u0000b\u0008c\u001Bd\u001Fe\u007Ff\u009Fg')).toBe(
      'abcdefg',
    );
    expect(stripWireControls('carriage\u000Dreturn')).toBe('carriagereturn');
  });

  it('keeps newline and tab — a multi-line finding has to stay legible', () => {
    expect(stripWireControls('one\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  it('leaves ordinary text, including astral characters, untouched', () => {
    expect(stripWireControls('résumé — 🛰 ok')).toBe('résumé — 🛰 ok');
  });

  it('drops an UNPAIRED surrogate while a real pair survives whole', () => {
    // The second class the strip removes, and the reason it is one rule: a
    // lone half is six characters after the inner stringify and SEVEN wire
    // bytes after the wrapper re-escapes the backslash — the identical price
    // to a C0 control. A well-formed pair costs 4 bytes for TWO units and must
    // not be touched, which is why the regex alternates pair-first.
    expect(stripWireControls('a\uD83Db')).toBe('ab');
    expect(stripWireControls('a\uDC00b')).toBe('ab');
    expect(stripWireControls('sat 🛰 ok')).toBe('sat 🛰 ok');
    expect([...stripWireControls('🛰')]).toHaveLength(1);
    // A pair with an extra half on either side keeps the pair and loses the
    // orphan, which is what pair-first alternation buys.
    expect(stripWireControls('\uD83D🛰\uDC00')).toBe('🛰');
  });

  it('is idempotent: its output holds none of the class it removes', () => {
    const once = stripWireControls('a\u001B[31mred\u001B[0m');
    expect(stripWireControls(once)).toBe(once);
  });
});

describe('capDetail', () => {
  it('returns a short detail unchanged', () => {
    expect(capDetail('a finding, in full')).toBe('a finding, in full');
  });

  it('normalizes controls before it measures anything (R23)', () => {
    expect(capDetail('a\u001Bb\nc\td')).toBe('ab\nc\td');
    // An all-control detail normalizes to nothing, which the STRICT fragment
    // then refuses — the cap does not decide sendability, the caller asks.
    expect(capDetail('\u001B'.repeat(DETAIL_MAX))).toBe('');
    expect(roundDetailStrict.safeParse(capDetail('\u001B'.repeat(10))).success).toBe(
      false,
    );
  });

  it('pins the ORDER: normalize, THEN cut (R23)', () => {
    // Every other control case in this file is at or under DETAIL_MAX after
    // stripping, and every other truncation case is control-free, so swapping
    // the two lines in capDetail would leave them all green. This one is BOTH
    // control-bearing and over-cap after normalization: 8 000 units in, 4 000
    // of them controls, so the correct order cuts a 4 000-unit string to
    // exactly DETAIL_MAX. Cutting first would slice at 2 963 units, strip to
    // ~1 481, and stamp the marker on a half-length string.
    const mixed = `a${String.fromCharCode(0x1b)}`.repeat(4_000);
    const capped = capDetail(mixed);
    expect(capped.length).toBe(DETAIL_MAX);
    expect(capped.endsWith(detailTruncationMarker())).toBe(true);
    expect(capped.startsWith('aaaa')).toBe(true);
    expect(capped).not.toContain(String.fromCharCode(0x1b));
  });

  it('fits the truncation marker INSIDE the cap, visibly (R4)', () => {
    const capped = capDetail('a'.repeat(DETAIL_MAX + 5_000));
    expect(capped.length).toBe(DETAIL_MAX);
    expect(capped.endsWith(detailTruncationMarker())).toBe(true);
    // The schema's own bound is never the thing that decides: what came out is
    // sendable as-is.
    expect(roundDetailStrict.safeParse(capped).success).toBe(true);
  });

  it('names the real bound in the marker, so the two cannot drift', () => {
    expect(detailTruncationMarker()).toContain(String(DETAIL_MAX));
    // MID_TURN_MARKER's shape: a bracketed clause with no link parentheses and
    // no leading list or heading mark, so plainForChat cannot rewrite it.
    expect(detailTruncationMarker().startsWith('[')).toBe(true);
    expect(detailTruncationMarker()).not.toContain('(');
  });

  it('is a fixed point — a re-render cannot stack a second marker', () => {
    const once = capDetail('a'.repeat(DETAIL_MAX + 5_000));
    const twice = capDetail(once);
    expect(twice).toBe(once);
    expect(twice.split('[detail truncated').length - 1).toBe(1);
  });

  it('never cuts in the middle of an astral character', () => {
    // A satellite emoji is a surrogate PAIR: a naive slice at DETAIL_MAX can
    // land between the halves, and JSON.stringify then escapes the orphan as a
    // six-character sequence — outside the budget's arithmetic and broken on
    // screen.
    const marker = detailTruncationMarker();
    // The cut lands one unit INTO the first pair: head is one short of the
    // slice point, and the tail is long enough to force a truncation.
    const head = 'a'.repeat(DETAIL_MAX - marker.length - 1);
    const capped = capDetail(`${head}${'🛰'.repeat(50)}`);
    expect(capped.endsWith(marker)).toBe(true);
    expect(capped.length).toBe(DETAIL_MAX - 1);
    expect([...capped].some(ch => ch === '�')).toBe(false);
    const lone = capped.slice(0, capped.length - marker.length);
    expect(/[\uD800-\uDBFF]$/.test(lone)).toBe(false);
  });
});

describe('ROUND_KEY_RE and roundKeyAuthor', () => {
  it('accepts the §5.3 compound ref and returns its AUTHOR half', () => {
    expect(ROUND_KEY_RE.test(ROUND_KEY)).toBe(true);
    expect(roundKeyAuthor(ROUND_KEY)).toBe(ULID_A);
    expect(ROUND_KEY.length).toBe(53);
  });

  it('refuses a bare ULID, a lowercase one, a three-part key and the empty string', () => {
    expect(ROUND_KEY_RE.test(ULID_A)).toBe(false);
    expect(ROUND_KEY_RE.test(ROUND_KEY.toLowerCase())).toBe(false);
    expect(ROUND_KEY_RE.test(`${ROUND_KEY}.${ULID_A}`)).toBe(false);
    expect(ROUND_KEY_RE.test('')).toBe(false);
    for (const bad of [ULID_A, ROUND_KEY.toLowerCase(), `${ROUND_KEY}.${ULID_A}`, '']) {
      expect(roundKeyAuthor(bad)).toBeNull();
    }
  });

  it('refuses the excluded Crockford letters (I, L, O, U) in either half', () => {
    expect(ROUND_KEY_RE.test(`${'I'.repeat(26)}.${ULID_B}`)).toBe(false);
    expect(ROUND_KEY_RE.test(`${ULID_A}.${'U'.repeat(26)}`)).toBe(false);
  });

  it('is anchored at both ends — a key with a tail is not a key', () => {
    expect(ROUND_KEY_RE.test(` ${ROUND_KEY}`)).toBe(false);
    expect(ROUND_KEY_RE.test(`${ROUND_KEY} `)).toBe(false);
    expect(ROUND_KEY_RE.test(`${ROUND_KEY}X`)).toBe(false);
  });

  it('is stateless between calls — no /g, so `.test` cannot skip a match', () => {
    expect(ROUND_KEY_RE.flags).toBe('');
    expect(ROUND_KEY_RE.test(ROUND_KEY)).toBe(true);
    expect(ROUND_KEY_RE.test(ROUND_KEY)).toBe(true);
  });
});

/**
 * THE BYTE BUDGET, computed rather than quoted (§3.1).
 *
 * `composeWorstCase` builds the real two-level shape a room answer has on the
 * wire — a `grp.msg` wrapper whose `b` is a JSON-escaped `reply` — with
 * `JSON.stringify`, which is the same function the composers use. Nothing here
 * is a transcription of an arithmetic done elsewhere.
 */
const composeWorstCase = (brief: string, detail: string) => {
  const inner = JSON.stringify({
    tcm: 'reply',
    ref: ROUND_KEY,
    ofs: false,
    text: brief,
    d: detail,
  });
  const wrapper = JSON.stringify({
    tcm: 'grp.msg',
    g: ULID_A,
    m: ULID_B,
    rd: 'AAAAAAAAAAA',
    sq: 1,
    b: inner,
    ai: true,
  });
  return { inner, wrapper, bytes: Buffer.byteLength(wrapper, 'utf8') };
};

describe('the byte budget, computed from the real constants', () => {
  it('clears MAX_BODY_BYTES with margin in the 4-bytes-per-unit worst case', () => {
    // A quote is one UTF-16 unit that becomes four characters after the two
    // escaping levels — the most expensive unit there is once controls are
    // gone, beating BMP U+0800..U+FFFF (3 bytes/unit) and astral pairs
    // (2 bytes/unit).
    const { inner, bytes } = composeWorstCase(
      '"'.repeat(BRIEF_MAX),
      '"'.repeat(DETAIL_MAX),
    );
    expect(bytes).toBeLessThan(MAX_BODY_BYTES);
    expect(MAX_BODY_BYTES - bytes).toBeGreaterThan(2_000);
    expect(inner.length).toBeLessThanOrEqual(MAX_GROUP_BODY);
  });

  it('clears it for a 3-bytes-per-unit BMP payload and for astral text too', () => {
    const bmp = composeWorstCase('ࠀ'.repeat(BRIEF_MAX), 'ࠀ'.repeat(DETAIL_MAX));
    expect(bmp.bytes).toBeLessThan(MAX_BODY_BYTES);
    const astral = composeWorstCase('🛰'.repeat(BRIEF_MAX / 2), '🛰'.repeat(DETAIL_MAX / 2));
    expect(astral.bytes).toBeLessThan(MAX_BODY_BYTES);
  });

  it('OVERFLOWS by thousands of bytes if the control normalization is deleted (R23)', () => {
    // This is the assertion the plan says catches the deletion. A control is
    // six characters after the inner stringify and SEVEN after the wrapper
    // re-escapes the backslash: 7 wire bytes for 1 UTF-16 unit.
    const raw = composeWorstCase('\u001B'.repeat(BRIEF_MAX), '\u001B'.repeat(DETAIL_MAX));
    expect(raw.bytes).toBeGreaterThan(MAX_BODY_BYTES);
    // And it clears MAX_GROUP_BODY on the inner, which is why the room send
    // path's own guard catches nothing here: the failure lands later, in the
    // fan-out, where it is misreported as "no room".
    expect(raw.inner.length).toBeLessThanOrEqual(MAX_GROUP_BODY);
  });

  it('OVERFLOWS the same way on UNPAIRED SURROGATES, and is closed the same way', () => {
    // The second class R23 removes, priced identically to a control: measured
    // here, the same 280/3 000 shape filled with lone high surrogates composes
    // to ~23 210 bytes against MAX_BODY_BYTES = 16 384. A budget block that
    // only measured controls would compute the same wrong 4x and pass straight
    // over this one.
    const raw = composeWorstCase('\uD83D'.repeat(BRIEF_MAX), '\uD83D'.repeat(DETAIL_MAX));
    expect(raw.bytes).toBeGreaterThan(MAX_BODY_BYTES);
    expect(raw.inner.length).toBeLessThanOrEqual(MAX_GROUP_BODY);
    const capped = composeWorstCase(
      stripWireControls('\uD83D'.repeat(BRIEF_MAX)),
      capDetail('\uD83D'.repeat(DETAIL_MAX)),
    );
    expect(capped.bytes).toBeLessThan(MAX_BODY_BYTES);
    // Well-formed astral text is NOT in this class — it is the cheapest
    // content on the wire and must survive the same funnel intact.
    const pairs = composeWorstCase(
      stripWireControls('🛰'.repeat(BRIEF_MAX / 2)),
      capDetail('🛰'.repeat(DETAIL_MAX / 2)),
    );
    expect(pairs.bytes).toBeLessThan(MAX_BODY_BYTES);
    expect([...capDetail('🛰'.repeat(DETAIL_MAX / 2))]).toHaveLength(DETAIL_MAX / 2);
  });

  it('clears MAX_BODY_BYTES once capDetail has run, which is what makes the 4 true', () => {
    const capped = composeWorstCase(
      stripWireControls('\u001B'.repeat(BRIEF_MAX)),
      capDetail('\u001B'.repeat(DETAIL_MAX)),
    );
    expect(capped.bytes).toBeLessThan(MAX_BODY_BYTES);
  });

  it('clears it for the realistic mix: control-dense text among quotes', () => {
    // ~50 % controls in quote-dense prose — past the ~30 % the plan measures as
    // enough to cross, and the shape model stdout with ANSI escapes actually
    // has.
    const mix = (units: number) => '"\u001B'.repeat(units / 2);
    const rawMix = composeWorstCase(mix(BRIEF_MAX), mix(DETAIL_MAX));
    expect(rawMix.bytes).toBeGreaterThan(MAX_BODY_BYTES);
    const cappedMix = composeWorstCase(
      stripWireControls(mix(BRIEF_MAX)),
      capDetail(mix(DETAIL_MAX)),
    );
    expect(cappedMix.bytes).toBeLessThan(MAX_BODY_BYTES);
  });

  it('leaves the base64 expansion inside the payload ceiling', () => {
    // 4/3 on the worst case, against the payload ceiling the frame cap allows
    // — IMPORTED from `frames.ts`, in this same package, because the one
    // number this block used to quote is the one that could drift.
    const { bytes } = composeWorstCase('"'.repeat(BRIEF_MAX), '"'.repeat(DETAIL_MAX));
    expect(Math.ceil(bytes / 3) * 4).toBeLessThan(MAX_PAYLOAD_B64_LENGTH);
  });
});
