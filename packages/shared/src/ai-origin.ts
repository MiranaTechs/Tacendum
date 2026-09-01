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
export function composeAgentText(text: string): string {
  const parsed = AgentTextEnvelope.safeParse({ tcm: AGENT_TEXT_TCM, text, ai: true });
  if (!parsed.success) {
    throw new Error(
      `refusing to compose a msg: ${parsed.error.issues[0]?.message ?? 'malformed'}`,
    );
  }
  return JSON.stringify({ tcm: AGENT_TEXT_TCM, text: parsed.data.text, ai: true });
}
