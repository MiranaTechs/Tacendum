/**
 * ROUNDS — the shared wire (§3.1).
 *
 * A **round** is one human turn plus the agents' answers to it. Each answer is
 * a **brief** (the thing a phone shows) and a **detail** (the full finding,
 * behind a tap, read in full by the sibling agents), written by the same model
 * in the same message, under one ratchet-authenticated sender. Nothing splits
 * them and nothing recombines them.
 *
 * The nouns are **brief**, **detail** and **full answer**. The word "summary"
 * is not utterable on this path (§2): on the fail-open path
 * the brief is a clipped first paragraph the model wrote, and calling that a
 * summary would claim a reading that never happened.
 *
 * WHAT IS ON THE WIRE: one optional field, `d`, on kinds build 25 already
 * parses (`msg` here, `reply` in `app/src/envelope.ts`). Never a new kind — a
 * build that predates a kind renders "Unsupported message — update Tacendum".
 * Never a required field. Compose-strict, parse-permissive (§6
 * rule 4). There is NO round id on the wire: the join key is the §5.3 reply
 * reference that already ships, because minting an id would be a second join
 * key that can disagree with the first.
 *
 * Purity, on `ai-origin.ts`'s exact terms: zod only. No `db`, no
 * `react-native`, no node builtins — this file is imported by Hermes and by
 * Node alike.
 */

import { z } from 'zod';

/**
 * The headline bound. 280 UTF-16 units — the notify-push cap's number
 * (`packages/cli/src/hooks.ts:HOOK_CHAT_CAP`) and a proven readable headline
 * length. The brief crosses `capChatHead(plainForChat(x), BRIEF_MAX)` — the
 * same funnel `ATTEND_REPLY_CAP` governs, at 280 instead of 2 000 (R14).
 * `ATTEND_REPLY_CAP` is unchanged and still governs every non-round reply;
 * this path is strictly tighter, which is the direction that needs no new
 * decision.
 *
 * THE BUDGET'S BRIEF TERM IS ENFORCED BY THE COMPOSER ALONE. Nothing on the
 * wire bounds a reply's brief — `app/src/envelope.ts:bodyText` is `.min(1)`
 * plus the sentinel refine and carries NO `.max()` — so the arithmetic below
 * holds only while the composer caps. The composer must cap with
 * `capChatHead(plainForChat(x), BRIEF_MAX)` AND keep R23's belt-and-braces
 * measurement of the fully composed wrapper, falling back to brief-only rather
 * than letting the answer die: at, say, 2 000 units of brief instead of 280
 * the worst case is (2 000 + 3 000) * 4 + 273 = 20 273 bytes against
 * `MAX_BODY_BYTES` = 16 384, and the send is refused INSIDE the fan-out, where
 * R23 says the refusal is misreported to the owner as `refused:'no-room'` for
 * a turn that was in fact answered.
 */
export const BRIEF_MAX = 280;

/**
 * The detail bound. 3 000 UTF-16 units. Truncation is VISIBLE
 * (`detailTruncationMarker`), never silent (R4). No attachments for detail in
 * v1 — `room-commands.ts:sendRoomMessage` refuses `--attach` together with
 * text and `inbound.ts` auto-fetches top-level `file` only, so a sibling agent
 * could not read a room attachment at all.
 */
export const DETAIL_MAX = 3_000;

/**
 * THE BYTE BUDGET, WRITTEN OUT, because a cap without its arithmetic rots.
 *
 * A room answer's wire body is a `grp.msg` wrapper whose `b` is a JSON-escaped
 * `reply` envelope carrying `text` (the brief) and `d` (the detail). Fixed
 * framing measured against the shipped schemas: the wrapper
 * (`packages/shared/src/group-envelope.ts:GroupMessageEnvelope` — `tcm`, `g`,
 * `m`, `rd`, `sq`, `b`, `ai`) is ~135 chars; the inner `reply` (`tcm`, `ref`
 * as the 53-char compound key, `ofs`, `text`, `d`) is ~116 chars, ~138 after
 * the wrapper escapes its quotes — ~273 chars of framing. The inner reply
 * carries NO `ai`: `app/src/envelope.ts:ReplyEnvelope` has no such field, so
 * an `ai: true` bolted onto it is silently stripped by zod before
 * `encodeEnvelope` stringifies `parsed.data` — the Art. 50 marker rides the
 * `grp.msg` WRAPPER, which does carry it. §3.1's prose lists `ai`
 * on the inner and computed the 273 with it; that makes the 273 conservative
 * by ~11 chars against >2 900 bytes of margin, and the number is kept as the
 * safe side of the drift.
 *
 * Worst case per content unit is **4 bytes, and only because `capDetail`
 * normalizes first (R23)**: a `"` is one UTF-16 unit that
 * becomes four characters (and four bytes) after the two escaping levels, and
 * that beats the 3-bytes-per-unit worst case of BMP U+0800..U+FFFF (an astral
 * pair is 4 bytes per TWO units, i.e. 2/unit). So
 * `(BRIEF_MAX + DETAIL_MAX) * 4 + 273 = 13 393` bytes against
 * `packages/cli/src/send.ts:MAX_BODY_BYTES` = 16 384 — ~3 000 bytes of margin
 * — and against `group-envelope.ts:MAX_GROUP_BODY` = 20 000 on the inner,
 * which the inner's ~3 400 chars clears by a factor of five. Base64's 4/3 on
 * 13 393 bytes is ~17 858 chars against the 30 000-char payload ceiling.
 *
 * THE 4 IS CONDITIONAL, AND THE CONDITION IS R23, WHICH HAS TWO CLASSES.
 * `JSON.stringify` escapes as a six-character `\uXXXX` sequence — seven wire
 * bytes once the wrapper re-escapes the backslash — every character it cannot
 * emit literally, and that is two classes, not one:
 *
 * (1) C0/C1 CONTROLS. A brief of 280 and a detail of 3 000 units of U+001B
 * gives an inner body of 19 796 chars — which PASSES `room-commands.ts`'s
 * `MAX_GROUP_BODY` check, so that guard catches nothing — and a wrapper body
 * of 23 275 bytes, 6 891 OVER `MAX_BODY_BYTES`. Roughly 30 % controls among
 * quote-dense text is enough to cross; model stdout carrying ANSI escapes, or
 * a hexdump pasted into an answer, is the realistic trigger.
 *
 * (2) UNPAIRED SURROGATES, at exactly the same price. Measured through this
 * module, the same 280/3 000 shape filled with U+D83D composes to 23 210
 * bytes — 6 826 over, the same magnitude as the control case — because a lone
 * half is also six characters inner and seven bytes on the wire (well-formed
 * `JSON.stringify`, ES2019). It is reachable the way a control is: the drivers
 * parse the model's JSON stdout and `JSON.parse('"\\ud83d"')` yields one, so a
 * model emitting a broken surrogate escape lands one in the detail. A
 * well-formed astral PAIR is NOT in this class and costs 2 bytes per unit.
 *
 * Nothing else on the reply path removes either: `hooks.ts`'s `plainForChat`
 * strips markdown only, and `mcp-notify.ts` and `mcp.ts` each strip C0 for
 * their OWN surface precisely because the wire path does not. Hence
 * `stripWireControls` below, which drops BOTH classes and so restores the
 * 4-bytes-per-unit case this arithmetic assumes.
 *
 * `packages/shared/test/rounds.test.ts` COMPUTES all of this from the real
 * constants — a hard-coded 13 393 in the test would be the drift the mirror
 * discipline exists to prevent (`ai-origin.ts:MAX_AGENT_TEXT`'s comment holds
 * the argument) — in all three worst cases: the all-quote payload, and the
 * all-U+001B and all-U+D83D payloads asserted OVER the cap raw and UNDER it
 * once `capDetail` has run. The latter two are the assertions that fail if
 * either half of the normalization is ever deleted; a budget test that only
 * measured quotes would compute the same wrong 4x and pass straight over the
 * overflow.
 */

/**
 * The sentinel a body must not begin with — `app/src/envelope.ts`'s constant,
 * duplicated on `group-envelope.ts`'s recorded terms: that file cannot be
 * imported here, and the string is part of the wire format rather than of
 * either module.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * The DETAIL field's shape, shared by the receive and compose fragments below
 * so the two can never disagree about what a well-formed detail is.
 *
 * `.min(1)` so an empty string is not a detail — a disclosure control over
 * nothing is a lie about there being more. The leading-sentinel refine is
 * `bodyText`'s, for `bodyText`'s reason: this string is rendered and could
 * otherwise be a forgery primitive. Only the LEADING sentinel is refused, so a
 * detail that merely quotes the format mid-sentence still sends.
 */
const roundDetailShape = z
  .string()
  .min(1)
  .max(DETAIL_MAX)
  .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
    message: 'detail may not itself be an envelope',
  });

/**
 * RECEIVE. `.optional().catch(undefined)` is §5.5's receiver rule in one
 * combinator, exactly as `aiOrigin` states it: a malformed detail collapses to
 * "no detail" instead of refusing the envelope, because a parser refusal on a
 * one-way ratchet is a permanent message loss. The detail costs itself, never
 * the words around it.
 *
 * Permissive BY CONSTRUCTION: `.catch` can never report failure, so this
 * fragment must never be used to ask whether a composer may send something.
 */
export const roundDetail = roundDetailShape.optional().catch(undefined);

/**
 * COMPOSE. The same chain WITHOUT `.catch`, so a composer can actually be told
 * no (R24). Two fragments and not one, because a single permissive fragment
 * silently collapses an over-cap or sentinel-leading `d` to `undefined` and
 * emits a brief-only body with NO signal to anybody — which is the exact
 * silent drop this feature must not have.
 *
 * Callers: `composeAgentText` (throws — `ai-origin.ts`'s "strict on the way
 * out" promise), `encodeEnvelope` (throws `EnvelopeRefusedError`), and the
 * CLI's fan-out, which checks `roundDetailStrict.safeParse(d).success` FIRST
 * and sends brief-only with a `detail-dropped` journal classification (R22) —
 * a throw inside the fan-out would lose the whole answer, which is worse than
 * losing the detail.
 */
export const roundDetailStrict = roundDetailShape.optional();

/**
 * The room content ref grammar: `${authorId}.${msgId}`, both Crockford base32
 * ULIDs. MIRRORS `packages/cli/src/room-commands.ts:ROOM_REF_RE` — same source
 * string, defined twice, never imported across the package boundary (R13, the
 * `MAX_AGENT_TEXT`/`MAX_GROUP_BODY` pinned-mirror precedent). The two packages
 * must not depend on each other at runtime; the mirror is what makes drift
 * visible, and `packages/cli/test/gate.rounds.test.ts` — the one test file that
 * can import both — compares the two `.source` strings.
 *
 * The distinction R13 draws on purpose: a shared CONSTANT's value is IMPORTED
 * so it cannot be mirrored wrong; a REGEX's source is mirrored deliberately and
 * pinned by test. Import the number; mirror the pattern.
 */
export const ROUND_KEY_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The AUTHOR component of a round key, or null when `ref` is not that exact
 * shape. Mirrors `room-commands.ts:roomRefAuthor`; the phone's round grouping
 * and the CLI's reply-once-per-round guard (R2b) both key on what this returns,
 * so "which human turn is this an answer to" cannot mean two things.
 */
export function roundKeyAuthor(ref: string): string | null {
  const match = ROUND_KEY_RE.exec(ref);
  return match === null ? null : match[1]!;
}

/**
 * Every C0 and C1 control except `\n` and `\t` — the same set as
 * `packages/cli/src/render.ts:CONTROL_CHARS`, mirrored here on the terms R13
 * sets for `ROUND_KEY_RE` (the two packages must not depend on each other).
 * NOT YET PINNED BY ANY TEST, unlike `ROUND_KEY_RE`: `CONTROL_CHARS` is
 * module-private in the CLI, so nothing can compare the two sources today.
 * The two were byte-identical when this was written (verified by reading
 * render.ts); the pin is owed — export `CONTROL_CHARS` and have
 * `packages/cli/test/gate.rounds.test.ts` compare `.source` for BOTH pairs,
 * alongside the `ROUND_KEY_RE`/`ROOM_REF_RE` comparison it already owes.
 *
 * TAB (09) and LF (0A) survive, because a multi-line finding has to stay
 * legible. Everything else in C0 (including ESC 1B and CR 0D), DEL (7F) and C1
 * (80-9F) goes.
 */
// eslint-disable-next-line no-control-regex
const WIRE_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * The SECOND class the strip removes: an UNPAIRED surrogate. Pair first, lone
 * half second, so a well-formed astral character is matched WHOLE and kept —
 * a length-2 match is by construction a real pair, a length-1 match is by
 * construction an orphan. Deliberately NOT a lookbehind: this file is loaded
 * by Hermes, and a lookbehind literal Hermes cannot compile is a startup
 * crash rather than a failed match. No `no-control-regex` disable is needed —
 * surrogates are not control characters.
 */
const SURROGATE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * R23's normalization, exported so the BRIEF funnel and the DETAIL cap share
 * ONE copy of the rule rather than forking it (§6 rule 5).
 *
 * TWO CLASSES GO, and they are one rule because they have one cost: every
 * C0/C1 control except `\n` and `\t`, and every UNPAIRED surrogate.
 * `JSON.stringify` escapes each of them as a six-character `\uXXXX` sequence
 * at the inner level and SEVEN wire bytes once the wrapper re-escapes the
 * backslash (well-formed stringify, ES2019). Measured through this module:
 * 3 000 units of U+D83D compose to 23 210 bytes against `MAX_BODY_BYTES`
 * = 16 384, the same magnitude of overflow as 3 000 units of U+001B. A
 * well-formed astral PAIR is untouched — 4 UTF-8 bytes for two units, the
 * cheapest content on the wire.
 *
 * Two reasons, and the second is the one specific to this wire.
 * (1) `render.ts:sanitizeForTerminal`'s: a control byte in a peer-chosen
 * string repaints a terminal line that has already been printed.
 * (2) The budget above: 7 wire bytes for 1 UTF-16 unit overflows
 * `MAX_BODY_BYTES` INSIDE the fan-out — where the refusal is mapped to
 * `refused:'no-room'` and the owner is told something false about a turn that
 * has already been ANSWERED. The strip is what makes the budget's 4 true.
 *
 * REACHABLE for both classes, not theoretical: the drivers parse the model's
 * JSON stdout, and `JSON.parse('"\\ud83d"')` yields a lone surrogate, so a
 * model emitting a broken surrogate escape lands one in the detail. Nothing
 * else on the path removes it (`hooks.ts:plainForChat` strips markdown only).
 *
 * Idempotent: the output contains none of either class it removes.
 */
export function stripWireControls(text: string): string {
  return text
    .replace(WIRE_CONTROL_CHARS, '')
    .replace(SURROGATE, match => (match.length === 2 ? match : ''));
}

/**
 * Appended, VISIBLY, when a detail is cut. Never silent (R4).
 *
 * Shaped so `hooks.ts:plainForChat` cannot rewrite it: a bracketed clause with
 * no link parentheses and no leading list or heading mark — the
 * `MID_TURN_MARKER` shape, pinned by the same byte-stability discipline. A
 * function rather than a constant so the bound it names can only ever be
 * `DETAIL_MAX` itself.
 */
export function detailTruncationMarker(): string {
  return `[detail truncated at ${DETAIL_MAX} characters]`;
}

/**
 * Normalize, THEN truncate to `DETAIL_MAX` INCLUDING the marker, so the
 * schema's own bound is never the thing that decides.
 *
 * ORDER MATTERS (R23). Normalizing after the cut would leave the marker
 * measuring a string that then shrinks, and would leave the byte budget
 * measuring a string that never existed.
 *
 * IDEMPOTENT — `plainForChat`'s own promise, for `plainForChat`'s reason: the
 * funnel's stages are each a fixed point, and a cap that is not one turns a
 * re-render into a second truncation marker. A capped result is at most
 * `DETAIL_MAX` units and holds no control characters, so a second call returns
 * it unchanged.
 *
 * This function does NOT decide whether the result may be sent: an
 * all-control input normalizes to `''`, which `roundDetailStrict` then
 * refuses. The caller asks, and sends brief-only when it is told no (R22).
 */
export function capDetail(text: string): string {
  const normalized = stripWireControls(text);
  if (normalized.length <= DETAIL_MAX) return normalized;
  const marker = detailTruncationMarker();
  let head = normalized.slice(0, DETAIL_MAX - marker.length);
  // Never end on a lone high surrogate: `JSON.stringify` escapes one as a
  // six-character sequence (well-formed stringify, ES2019), which is both
  // outside the budget's arithmetic and a broken character on screen. Dropping
  // it costs one unit and leaves the result at most DETAIL_MAX, so idempotence
  // holds.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head + marker;
}
