/**
 * THE ART. 50 AI-ORIGIN FUNNEL — the ONE place agent-authored bodies are marked, so
 * that "every agent-authored body carries the marker" is a property of a
 * single function rather than a discipline spread over compose sites.
 *
 * Who calls it, exhaustively (the coverage pin in gate.ai-origin.test.ts
 * holds the attend half on the wire): attend's send wrapper (final replies,
 * excuses, durable edit finals, approval cards — everything that leaves
 * attendPass durably), attend's typing channel (x.typing chatter; x.edit
 * frames are marked at their strict composer, `composeStreamEdit`), the room
 * reply (`realSendRoomReply` → `sendRoomMessage`'s `ai` option — the marker
 * rides the `grp.msg` WRAPPER and, per the amendment, ALSO inside
 * an envelope-shaped `b`; bare-text `b` stays bare — group-envelope.ts holds
 * the argument), the hook notify lane (`runNotify`, owner-addressed sends
 * only: the attestation speaks for no other device), and the MCP notify/ask
 * servers. NOT `cli send`/`room send` typed by an operator: agent-authored
 * means composed by the agent lane, not sent by an integration-class
 * account — a person typing at the machine's keyboard is a person.
 * NOT `review-peer`: its reply is a fixed rotation of canned sentences with
 * no model behind it, and
 * it attests nothing about any phone.
 *
 * TWO ARMS, TWO COMPATIBILITY POSTURES:
 *
 *  - ENVELOPE bodies gain `"ai":true` UNGATED. Every deployed parser is a
 *    plain zod object in strip mode (the one `.strict()` in the tree is a
 *    server DTO), so a KNOWN kind carrying the new field parses on every
 *    shipped build — the field is simply invisible until the build that
 *    reads it.
 *  - BARE TEXT wraps into the `msg` kind ONLY under the operator's own
 *    app-build attestation (`attend enable --marker <min-app-build>`, the
 *    same posture as the approval and stream attestations): `msg` is a NEW conversational kind, and
 *    a build that predates it renders "Unsupported message — update
 *    Tacendum" — a cost only the operator may accept, about their own
 *    device, because this wire has no capability negotiation to ask.
 *
 * MARKING NEVER COSTS A MESSAGE: every failure inside this function returns
 * the body unchanged. An unmarked body is a compliance gap the next build
 * closes; a lost reply is a lost reply.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeAgentText } from '@tacendum/shared';
import { clientDir } from './config.js';

/**
 * The wire sentinel — render.ts's constant, duplicated on its own recorded
 * terms: the string is part of the wire format, not of either module.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * THE CANONICAL AI-DISCLOSURE SENTENCE (docs/AI-DISCLOSURE.md §1) — the CLI's
 * one copy, quoted by `attend enable`'s read-back and by nothing else that
 * re-types it.
 *
 * It lives in this module because this module is the CLI's Art. 50 lane: the
 * marker below is what a body carries, this sentence is what the operator is
 * told, and the two are the same obligation seen from either end. The doc is
 * the home of the words — "no paraphrase, no per-surface variant", and page
 * copy in this repo has gone live false twice — so
 * test/gate.ai-origin.test.ts reads the doc and compares these bytes to it.
 *
 * The straight apostrophe in "Tacendum's" is the doc's, kept deliberately.
 * The app carries its own copy in app/src/machine.ts, pinned the same way:
 * the workspaces share no module, so they share the doc instead.
 */
export const AI_DISCLOSURE_SENTENCE =
  'Replies you send are delivered to the AI provider running on your own machine; ' +
  "Tacendum's servers relay ciphertext only.";

/**
 * The attestation's shape rule, in ONE place so the attend-side arm
 * (reading `cfg.markerMinAppBuild` it already holds) and the file-reading
 * arm below cannot drift: a positive integer, and anything else — absent, a
 * float, a string a hand edit left — reads as un-attested. Fail closed is
 * the path every build renders.
 */
export function markerShapeOk(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Whether this account's operator has attested a marker-capable phone.
 *
 * Read from attend.json (`markerMinAppBuild`, written by `attend enable
 * --marker`) because that file is the account's ONE statement about the
 * owner's device — the hook and MCP lanes read the same field rather than
 * growing a second attestation with its own drift. An account whose attend
 * was never enabled sends bare text unmarked, which is exactly what it sent
 * yesterday; the envelope arm above still marks everything that can carry a
 * field.
 */
export function markerAttested(account: string): boolean {
  try {
    const raw = readFileSync(join(clientDir(account), 'attend.json'), 'utf8');
    const cfg = JSON.parse(raw) as { markerMinAppBuild?: unknown };
    return markerShapeOk(cfg.markerMinAppBuild);
  } catch {
    return false;
  }
}

/**
 * THE FUNNEL. Envelope bodies gain `ai: true` (with `tcm` re-serialized
 * FIRST — parseEnvelope routes on the literal `{"tcm":` prefix, so the key
 * order is reconstructed here, never inherited); bare text wraps into the
 * marked `msg` kind iff `wrapText`. Idempotent, total, and silent: a body
 * this function cannot improve leaves exactly as it came.
 */
export function markAgentBody(body: string, wrapText: boolean): string {
  if (body.startsWith(ENVELOPE_SENTINEL)) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as { tcm?: unknown }).tcm !== 'string'
      ) {
        return body;
      }
      const { tcm, ...rest } = parsed as { tcm: string } & Record<string, unknown>;
      return JSON.stringify({ tcm, ...rest, ai: true });
    } catch {
      // Sentinel-shaped but not JSON: not an envelope this build composed —
      // pass it through untouched rather than guess.
      return body;
    }
  }
  if (!wrapText) return body;
  try {
    return composeAgentText(body);
  } catch {
    // The strict composer refused (empty, oversized). Nothing upstream of
    // the funnel should produce such a body, but if one arrives the words
    // outrank the marker — send them as they came.
    return body;
  }
}
