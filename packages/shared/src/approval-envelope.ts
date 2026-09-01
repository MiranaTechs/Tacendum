/**
 * The two `x.approval*` wire envelopes, defined ONCE here
 * so the app, the CLI and the tests share one copy — the precedent
 * `app/src/envelope.ts` records for call signalling and `group-envelope.ts`
 * repeats for rooms: one schema, three consumers, zero drift.
 *
 * Both kinds live in the reserved `x.` carrier namespace, which is what makes
 * them deployable at all: every shipped client routes the `x.` prefix BEFORE
 * parsing — the app to its durable drop, the CLI to `{carrier: true, text: ''}`,
 * the NSE to silence — so a build that predates these kinds shows nothing and
 * loses nothing durable. The committed fixture
 * (`packages/shared/approvalvectors.json`, the `authvectors.json` pattern) is
 * the cross-client agreement artifact: all three suites parse the SAME bytes.
 *
 * THE BINDING IS STRUCTURAL, AND THE HASH IS REFUSED (settled — do not
 * re-litigate without new facts): `q` is a single-use CSPRNG
 * request id minted by the CLI (`ApprovalRow.requestId`), the CLI's journal is
 * append-once per field, and what executes is what is stored under the id.
 * There is deliberately NO payload digest, NO absolute timestamp (nothing on
 * the wire is a clock — the CLI's clock decides, the phone's countdown is
 * display only), NO `d` (cwd is folded into the verbatim payload by the one
 * producer, `codex-appserver.ts`'s `commandPayload` — splitting it back out
 * would make two renderings of one authorized thing), and NO `r` agent prose
 * (dropped until a producer exists — a schema field
 * nothing produces is a promise nothing keeps).
 *
 * Purity: zod plus `./group-fold.js`. No `db`, no `react-native`, no node
 * builtins — this file is imported by Hermes and by Node alike.
 */

import { z } from 'zod';
import { aiOrigin } from './ai-origin.js';
import { Ulid } from './group-fold.js';

/**
 * The payload cap, C11's reuse of the CLI send path's `MAX_BODY_BYTES`
 * (16 * 1024, `send.ts:118`) rather than a second number that would drift: a
 * request whose payload cannot ride one frame cannot be asked at all, and the
 * shipped CLI already refuses over-cap asks as an instant deny (`via:
 * 'overcap'`) before anything reaches the wire. NOTE the honest unit: zod's
 * `.max()` counts UTF-16 code units, so this bound is exact for the ASCII
 * command lines and diffs the producers emit and PERMISSIVE for multi-byte
 * text — the byte-exact refusal lives on the CLI's send path, where the bytes
 * are. The receiver stays at least as permissive as the sender (§5.5).
 */
export const MAX_APPROVAL_PAYLOAD_BYTES = 16 * 1024;

/**
 * TTL bounds, in SECONDS on the wire (a small integer instead of a wide one —
 * every byte is paid for), MIRRORING attend.ts's millisecond clamp:
 * `APPROVAL_TTL_MIN_MS = 30_000` and `APPROVAL_TTL_MAX_MS = 3_600_000`. The
 * mirror is stated here and pinned by a CLI-side test so drift is visible —
 * if attend's clamp moves, these move in the same commit. The floor is a
 * wake-cap fact (an approval whose TTL is shorter than a queued push's delay
 * cannot honestly be answered from a phone); the ceiling is the hour past
 * which the host's parked turn is very likely gone. All deadlines run on the
 * CLI's clock; the app's countdown is DISPLAY ONLY.
 */
export const APPROVAL_TTL_MIN_SEC = 30;
export const APPROVAL_TTL_MAX_SEC = 3_600;

/**
 * A verb, as the wire carries one: a bounded string, deliberately NOT an
 * enum. A future verb this build has never seen must cost THE ANSWER, never
 * the frame — an enum here would make a peer's `edit` refuse the whole
 * envelope at the parser, and on a one-way ratchet that loss is permanent
 * (the `rd` lesson, §5.5). The safety lives at apply time instead: a verb is
 * honoured only if it is one the consumer recognises, and an unknown verb
 * NEVER reads as approve (attend.ts's `ApprovalDecision` fails closed).
 */
const wireVerb = z.string().min(1).max(16);

/**
 * The session reference is the `sessionTag` — `s-` plus four hex of SHA-256
 * (hooks.ts) — NEVER the raw host session id. The raw key on the wire would
 * break the very rule-4 guard the tag exists to enforce: it reaches a card,
 * a screenshot, a shoulder. Four hex chars is a display space, not an
 * identity; routing is by `q` and by reply-ref, never by tag.
 */
const sessionTagRef = z.string().regex(/^s-[0-9a-f]{4}$/);

/**
 * `x.approval` — the CLI asks the phone to approve ONE action.
 *
 * Composed by the CLI from its journal row at ask time; rendered by the app
 * as the approval card. The card renders `p` VERBATIM in a monospace block —
 * never transformed, never trimmed, never markdown — because the payload IS
 * the feature: the machine runs only the exact bytes shown.
 */
export const ApprovalRequestEnvelope = z.object({
  tcm: z.literal('x.approval'),
  /**
   * THE BINDING, single-use: `ApprovalRow.requestId`, minted by the CLI's
   * CSPRNG-seeded ULID factory (rule 1 item 8 covers the entropy; no new
   * crypto call site here). Never reused, never re-bound to a second
   * payload; a settled or lapsed id is burned and a late answer to it must
   * never re-bind.
   */
  q: Ulid,
  /**
   * Which request family is asking — the app renders the fixed label ("Run a
   * command" / "Change files" / "Requested action"), nothing else. `.catch`
   * rather than refuse: a future family this build has never seen degrades
   * to the generic label, and the card still shows the verbatim payload —
   * the kind is worth losing, the request is not (§5.5).
   */
  k: z.enum(['exec', 'file', 'other']).catch('other'),
  /**
   * The payload, VERBATIM: the exact bytes the host will execute
   * (`ApprovalAsk.payload` — for a command, `commandPayload`'s
   * `${command}\ncwd: ${cwd}`; for a file change, the joined per-file
   * diffs). The app renders it monospace and untransformed; the CLI journals
   * these bytes and byte-compares at settlement.
   */
  p: z.string().min(1).max(MAX_APPROVAL_PAYLOAD_BYTES),
  /**
   * TTL in seconds, already clamped by the sender (the supervisor's clamp is
   * the authority — see the constants above). The app's countdown from it is
   * DISPLAY ONLY: expiry is decided on the CLI's clock as `deny, via:'ttl'`,
   * and a card that greys out locally is honest without ever learning the
   * machine-side settlement.
   */
  x: z.number().int().min(APPROVAL_TTL_MIN_SEC).max(APPROVAL_TTL_MAX_SEC),
  /** The asking session's tag, when the driver knew one — optional because
   * `ApprovalAsk.sessionKey` is. */
  s: sessionTagRef.optional(),
  /**
   * The admissible verbs, declared by the asker — `['approve','deny']` today
   * (`edit:`/`respond:` are operator verbs that resolve to deny at
   * the seam; they join this array only when a driver can honour them). The
   * app renders ONLY these buttons, and only verbs it recognises: an
   * unknown member renders no button and can never be sent back as an
   * answer it would not survive.
   */
  a: z.array(wireVerb).min(1).max(8),
  /** Outstanding-count ("approval k of this turn") — a later addition;
   * optional so pre-count wires still parse. */
  n: z.number().int().min(1).max(64).optional(),
  /** The Art. 50 AI-origin marker. A card is agent-lane by construction, so the CLI marks
   * every one it composes; optional so every pre-marker card still parses,
   * and a malformed value collapses to unmarked rather than costing the
   * request. */
  ai: aiOrigin,
});

/**
 * `x.approval.answer` — the phone's structured answer.
 *
 * REGISTERED NOW, CONSUMED LATER (ADOPTED decision 1): the shipped answer
 * channel is an ordinary reply (`{tcm:'reply', ref, text:'approve'|'deny'}`),
 * because an `x.*` carrier never reaches the spool the parked pass polls —
 * `maySpool` refuses it, and the silence gate pins that. This kind exists in
 * schemas and fixtures so both clients already agree on its bytes when
 * `edit`/`respond` force a structured channel.
 */
export const ApprovalAnswerEnvelope = z.object({
  /** The echoed request id — the ONLY routing key. */
  tcm: z.literal('x.approval.answer'),
  q: Ulid,
  /**
   * The verb. A bounded string, NOT an enum — a verb costs the answer,
   * never the frame (see `wireVerb`). Applied only if it is in the request's
   * recorded `a` AND the consumer recognises it; an unknown verb NEVER
   * reads as approve.
   */
  v: wireVerb,
  /** `edit` replacement payload — owner-authored, same cap as the
   * request's. */
  p: z.string().min(1).max(MAX_APPROVAL_PAYLOAD_BYTES).optional(),
  /** `respond` prose. Never argv: it re-presents as an ordinary
   * message, routed home by ref. */
  m: z.string().min(1).max(2_000).optional(),
  /** The tag the card showed, echoed. */
  s: sessionTagRef.optional(),
  /**
   * The byte length of the payload AS THE CARD RENDERED IT — a BUG DETECTOR,
   * not a security control (the binding is `q` plus the CLI's append-once
   * journal; byte equality is checked there, against stored bytes). A
   * mismatch here means a client transformed what it swore it rendered
   * verbatim — disclosure to a human, never an authorization decision.
   */
  n: z.number().int().nonnegative().max(MAX_APPROVAL_PAYLOAD_BYTES),
});

export type ApprovalRequestEnvelope = z.infer<typeof ApprovalRequestEnvelope>;
export type ApprovalAnswerEnvelope = z.infer<typeof ApprovalAnswerEnvelope>;

/**
 * The two kinds, in one place so a switch that forgets one can be caught by a
 * test rather than by a peer (the `GROUP_TCMS` pattern).
 */
export const APPROVAL_TCMS = ['x.approval', 'x.approval.answer'] as const;

export type ApprovalTcm = (typeof APPROVAL_TCMS)[number];

export function isApprovalTcm(value: string): value is ApprovalTcm {
  return (APPROVAL_TCMS as readonly string[]).includes(value);
}
