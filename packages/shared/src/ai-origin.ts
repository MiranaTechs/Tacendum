/**
 * The Art. 50 AI-origin marker — defined ONCE here so the app, the CLI and the tests share one copy,
 * on `approval-envelope.ts`'s exact terms: one schema, three consumers, zero
 * drift.
 *
 * WHAT THE MARKER IS, HONESTLY:
 * the frame is ratchet-authenticated to its sender, so the recipient knows
 * WHICH ACCOUNT claimed AI origin — trustworthy-as-sender-claimed. It is NOT
 * third-party-provable: the ratchet's authenticators are deliberately
 * deniable, and a modified client can lie — omit the marker, or a human can
 * set it falsely (self-harm: they get badged as AI). It rides INSIDE the
 * E2EE ciphertext, so the relay can neither read, strip, nor inject it. The
 * one claim wording marketing may use: "Messages from AI agents are
 * labeled by the sending client inside the encryption; the relay cannot see,
 * strip, or forge the label." Never "unforgeable proof of AI origin".
 *
 * WHERE IT RIDES: an optional `ai` field on the envelope kinds the CLI's
 * agent lane composes — the `grp.msg` room wrapper, the durable `edit` final,
 * the `x.edit` stream intermediate, the `x.approval` card, `x.typing`
 * chatter, and the `msg` kind below for bare text. On a KNOWN kind the field
 * is invisible to every shipped parser (plain zod objects strip unknown
 * keys), which is what makes ungated emission deployable against builds in
 * the field; `msg` is the one NEW kind and is therefore attestation-gated at
 * its only composer (the CLI's `--stream` posture).
 *
 * Purity: zod only. No `db`, no `react-native`, no node builtins — this file
 * is imported by Hermes and by Node alike.
 */

import { z } from 'zod';
// The ROUNDS detail field (§3.1). Imported rather than mirrored:
// it is a SCHEMA, and a second copy of a schema is a second thing to get
// wrong. `rounds.ts` is zod-only, so the purity note above still holds.
import { DETAIL_MAX, roundDetail, roundDetailStrict } from './rounds.js';

/**
 * The marker field. `.catch(undefined)` is the §5.5 receiver rule in one
 * combinator: a malformed marker (false, a string, a number) collapses to
 * "unmarked" instead of refusing the envelope — the marker costs itself,
 * never the message, because a parser refusal on a one-way ratchet is a
 * permanent loss. Only the literal `true` marks; there is deliberately no
 * `ai: false` on the wire (absence already says that, and a second way to
 * say it is a second thing to get wrong).
 */
export const aiOrigin = z.literal(true).optional().catch(undefined);

/**
 * True when a parsed envelope claims AI origin. One reader for every consumer
 * so "claims" means the same thing on every surface: the field present and
 * exactly `true` — never a truthy string, never derived from text.
 */
export function claimsAiOrigin(envelope: { ai?: true | undefined }): boolean {
  return envelope.ai === true;
}

/**
 * The sentinel a body must not begin with — `app/src/envelope.ts`'s constant,
 * duplicated on `group-envelope.ts`'s recorded terms: that file cannot be
 * imported here, and the string is part of the wire format rather than of
 * either module.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * The bare-text cap. MIRRORS `MAX_GROUP_BODY` (group-envelope.ts, 20 000)
 * deliberately WITHOUT importing it: group-envelope imports this module for
 * the marker fragment, and a back-import would be a cycle two module loaders
 * resolve differently. The mirror is pinned by test (ai-origin.test.ts) so
 * drift is visible — if one moves, both move in the same commit. The number
 * itself is the §5.6 plaintext ceiling: room for the envelope, the ratchet
 * header and base64's 4/3 expansion inside the frame cap.
 *
 * A ROUND ANSWER IS BOUNDED FAR BELOW THIS (§3.1). `BRIEF_MAX`
 * (280) and `DETAIL_MAX` (3 000) in `rounds.ts` carry their own written-out
 * byte budget against `send.ts:MAX_BODY_BYTES`, because a `msg` or `reply`
 * carrying `d` is wrapped twice and escaped twice before it meets the frame
 * cap. The two budgets live one import apart on purpose: this one bounds what
 * the KIND may hold, that one bounds what a ROUND may send.
 */
export const MAX_AGENT_TEXT = 20_000;

/** The one kind name, in one place (the `APPROVAL_TCMS` pattern). */
export const AGENT_TEXT_TCM = 'msg' as const;

/**
 * `msg` — bare text that needed an envelope. Plain text on this wire has no
 * field to carry the marker, so an agent's ordinary reply gains the smallest
 * wrapper that can: the words, plus `ai`.
 *
 * A CONVERSATIONAL kind, deliberately — not `x.*`: these are words a person
 * must see, and the carrier namespace's whole contract is invisibility. The
 * cost is stated where it is paid: a build that predates this kind renders
 * "Unsupported message — update Tacendum", which is why the CLI gates
 * emission on the operator's own app-build attestation and why the schema
 * here stays receive-permissive (the marker collapses rather than refuses;
 * unknown keys strip).
 */
export const AgentTextEnvelope = z.object({
  tcm: z.literal(AGENT_TEXT_TCM),
  /**
   * The words. Refuses a leading envelope sentinel for `bodyText`'s exact
   * reason (app/src/envelope.ts): this string becomes a rendered message
   * body, and a text that reads as structure everywhere is a forgery
   * primitive. Only the LEADING sentinel is refused, so prose that merely
   * quotes the format mid-sentence still sends.
   */
  text: z
    .string()
    .min(1)
    .max(MAX_AGENT_TEXT)
    .refine(value => !value.startsWith(ENVELOPE_SENTINEL), {
      message: 'text may not itself be an envelope',
    }),
  /**
   * THE ROUNDS DETAIL (§3.1). Optional, and on a kind build 25
   * already parses — the only widening this wire permits. When it is present
   * `text` IS the brief and this is the full answer behind a tap; when it is
   * absent nothing about the kind changes, which is what makes a build in the
   * field indifferent to it (unknown keys strip; §5.5's receiver rule collapses
   * a malformed one to "no detail" rather than costing the words).
   *
   * A round answer in a ROOM is composed as `reply` (`app/src/envelope.ts`)
   * inside the `ai`-marked `grp.msg` wrapper; this field is the 1:1 attend
   * path's half of the same wire.
   */
  d: roundDetail,
  ai: aiOrigin,
});

export type AgentTextEnvelope = z.infer<typeof AgentTextEnvelope>;

/**
 * Compose the wire bytes for one marked bare-text body. Strict on the way out
 * (the `composeStreamEdit` rule): a malformed frame of our own making is a
 * bug in this build and must be loud. ALWAYS marked — the kind exists FOR
 * the marker, and a composer that could omit it would be the one compose
 * path the marker invariant swears does not exist.
 *
 * `tcm` is serialized FIRST, explicitly: `parseEnvelope` routes on the
 * LITERAL prefix `{"tcm":` before parsing anything. The key order is pinned
 * by reconstruction here, not left to an upstream object's insertion order.
 */
export function composeAgentText(text: string, detail?: string): string {
  // THE DETAIL IS CHECKED HERE AND NOT BY THE SCHEMA ABOVE, and the reason is
  // the whole of R24: `d` is `.catch(undefined)` on the receive side, and
  // `.catch` SWALLOWS rather than throws — `AgentTextEnvelope.safeParse` of an
  // over-cap or sentinel-leading detail SUCCEEDS with `d` collapsed to
  // `undefined`, and this function would then emit a brief-only body with no
  // signal to anybody. That is the silent drop this feature must not have, and
  // it would make this function's own promise — strict on the way out, a
  // malformed frame of our own making is a bug in this build and must be loud
  // — false for the new field. `roundDetailStrict` is the same chain without
  // the `.catch`, so it can actually say no.
  if (detail !== undefined && !roundDetailStrict.safeParse(detail).success) {
    // The MESSAGE names the field and the bound, never the value: this string
    // is logged and rendered, and the detail is payload (rule 4).
    throw new Error(
      `refusing to compose a msg: detail must be 1..${DETAIL_MAX} characters and not itself an envelope`,
    );
  }
  const parsed = AgentTextEnvelope.safeParse({
    tcm: AGENT_TEXT_TCM,
    text,
    ...(detail === undefined ? {} : { d: detail }),
    ai: true,
  });
  if (!parsed.success) {
    throw new Error(
      `refusing to compose a msg: ${parsed.error.issues[0]?.message ?? 'malformed'}`,
    );
  }
  // `d` is omitted entirely when there is no detail, so a caller that predates
  // rounds gets BYTE-IDENTICAL output to before (pinned in ai-origin.test.ts).
  // Key order is reconstructed rather than inherited, as ever: `tcm` first.
  return JSON.stringify({
    tcm: AGENT_TEXT_TCM,
    text: parsed.data.text,
    ...(parsed.data.d === undefined ? {} : { d: parsed.data.d }),
    ai: true,
  });
}
