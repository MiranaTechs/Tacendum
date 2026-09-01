/**
 * The `x.edit` stream envelope, defined ONCE here
 * so the app, the CLI and the tests share one copy — the precedent
 * `approval-envelope.ts` records for the x.approval pair: one schema, three
 * consumers, zero drift.
 *
 * This is the RELAY-ONLY intermediate of an edit-streamed reply. The turn's
 * first chunk mints ONE durable anchor; intermediates then ride the existing
 * typing wire frame and its budget as sealed `x.edit` — no queue row, no
 * wake, memory-overlay only — and the turn's end owes the shipped durable
 * `{tcm:'edit'}` final (`app/src/envelope.ts` EditEnvelope), which heals
 * offline phones, missed relays, and old builds. The `x.` carrier namespace
 * is what makes this deployable: every shipped client routes the `x.` prefix
 * before parsing, so a build that predates this kind shows nothing and loses
 * nothing durable.
 *
 * FULL REPLACEMENT, NEVER A DELTA: `text` is the
 * whole snapshot of the anchor's body as of `seq`. That one choice buys three
 * properties at once — IDEMPOTENT (applying a snapshot twice changes
 * nothing), LOSS-TOLERANT (any later `seq` supersedes wholly, so a dropped
 * frame is healed by the next instead of corrupting a splice), and
 * CAP-CHECKABLE (each frame carries its entire rendered body, so the bound
 * is verified per frame with no accumulated state). A delta stream has none
 * of these on a lossy ephemeral lane.
 *
 * There is deliberately NO room field: v1 is codex app-server 1:1 only —
 * rooms are deferred BY NAME, and a field nothing produces is a promise
 * nothing keeps (the approval-envelope `r` precedent).
 *
 * Purity: zod only. No `db`, no `react-native`, no node builtins — this file
 * is imported by Hermes and by Node alike.
 */

import { z } from 'zod';
import { aiOrigin } from './ai-origin.js';

/**
 * How a structured body announces itself — `app/src/envelope.ts:30`'s
 * constant, which the CLI also carries; the duplication is recorded there as
 * a smell rather than fixed, and this copy inherits that record. It exists
 * here because `text` becomes a rendered message body: `parseEnvelope`
 * routes ANY body starting with this prefix as structure, so a snapshot that
 * begins with it would let a peer smuggle a carrier — a forged edit, a
 * tombstone, a screenshot notice — into a bubble the app swore was prose.
 * Refused at the schema, exactly as the app's `bodyText` refuses it for
 * durable edits. Only the LEADING sentinel is refused, so prose that merely
 * quotes the format mid-sentence still streams.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * The snapshot cap: 8 KiB. NOTE the honest unit: zod's `.max()` counts
 * UTF-16 code units, so this bound is exact for ASCII and PERMISSIVE for
 * multi-byte text — the byte-exact bound lives on the send path, where the
 * bytes are (the `MAX_APPROVAL_PAYLOAD_BYTES` convention). Half of C11's
 * 16 KiB frame body cap, so a whole snapshot plus envelope framing rides the
 * one typing-lane frame it is allowed; a reply that outgrows it stops
 * streaming intermediates and lets the durable final carry the rest — the
 * cap costs the overlay, never the reply.
 */
export const MAX_STREAM_EDIT_TEXT_CHARS = 8 * 1024;

/**
 * `x.edit` — one sealed intermediate snapshot of a streaming reply.
 *
 * Composed by the CLI at cadence (one per attend poll); applied by the app
 * as a memory overlay on the anchor row, later-`seq`-wins, and rendered with
 * the streaming cursor. Never journaled, never queued, never woken for.
 */
export const StreamEditEnvelope = z.object({
  tcm: z.literal('x.edit'),
  /**
   * msgId of the turn's durable anchor — the reply's only banner, minted by
   * the first chunk. The same shape as the durable `edit`'s ref: a bare
   * string, non-empty, because an overlay with no anchor overlays nothing.
   */
  ref: z.string().min(1),
  /**
   * THE SENDER'S OWN COUNTER FOR THIS ANCHOR, not a clock. Later wins;
   * equal or older is dropped. Gaps are legal and unobservable — that is
   * the loss-tolerance: a missing frame is healed wholly by the next
   * snapshot instead of stalling the bubble. Saturating bound on the
   * `VaultEnvelope.n` precedent: a hostile counter past the safe-integer
   * line cannot ride.
   */
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /**
   * The FULL replacement body as of `seq` — never a delta (see the header).
   * Empty is refused: a snapshot of nothing is not an update, and the
   * anchor already renders the typing state. A leading envelope sentinel is
   * refused because this string becomes a rendered message body (see
   * `ENVELOPE_SENTINEL`).
   */
  text: z
    .string()
    .min(1)
    .max(MAX_STREAM_EDIT_TEXT_CHARS)
    .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
      message: 'text may not itself be an envelope',
    }),
  /** The Art. 50 AI-origin marker. Optional so every pre-marker frame still parses; a
   *  malformed value collapses to unmarked rather than costing the overlay.
   *  Attend passes it on every frame it composes — an x.edit is only ever
   *  agent-authored. */
  ai: aiOrigin,
});

export type StreamEditEnvelope = z.infer<typeof StreamEditEnvelope>;

/**
 * Compose the wire bytes for one intermediate snapshot. Strict on the way
 * out (the `assertComposableRd` rule): a malformed frame of our own making
 * is a bug in this build and must be loud, whereas a peer's malformed frame
 * costs them only the overlay.
 *
 * `tcm` is serialized FIRST, explicitly: `parseEnvelope` routes on the
 * LITERAL prefix `{"tcm":` before parsing anything, so a composer that let
 * another key lead would emit frames every shipped build reads as ordinary
 * text. The key order is pinned by reconstruction here, not left to an
 * upstream object's insertion order.
 */
export function composeStreamEdit(input: {
  ref: string;
  seq: number;
  text: string;
  /** The AI-origin marker. Optional so every pre-marker caller keeps
   *  its shape and its bytes; attend passes `true` on every frame. */
  ai?: true;
}): string {
  const parsed = StreamEditEnvelope.safeParse({ tcm: 'x.edit', ...input });
  if (!parsed.success) {
    throw new Error(
      `refusing to compose an x.edit: ${parsed.error.issues[0]?.message ?? 'malformed'}`,
    );
  }
  // `parsed.data`, reconstructed: zod strips unknown keys, so what is
  // stringified is exactly what the receiver will reconstruct — and the
  // literal below is what makes tcm-first a property of this function
  // rather than of zod's internals.
  const { ref, seq, text, ai } = parsed.data;
  return JSON.stringify({ tcm: 'x.edit', ref, seq, text, ...(ai === true ? { ai } : {}) });
}

/**
 * The one kind, in one place so a switch that forgets it can be caught by a
 * test rather than by a peer (the `APPROVAL_TCMS` pattern).
 */
export const STREAM_TCMS = ['x.edit'] as const;

export type StreamTcm = (typeof STREAM_TCMS)[number];

export function isStreamTcm(value: string): value is StreamTcm {
  return (STREAM_TCMS as readonly string[]).includes(value);
}
