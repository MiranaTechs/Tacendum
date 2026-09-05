import { ApiRequestError } from './api';
import { DEVICE_NOUN } from './deviceNoun';

/**
 * THE CANONICAL AI-DISCLOSURE SENTENCE — the app's
 * one copy of it, quoted by every surface that owes it.
 *
 * The doc is the sentence's home and says why it is a single string: "a family
 * of almost-identical sentences is how a claim drifts until one of its copies
 * is false (page copy has gone live false twice in this repo's history)." So
 * no surface re-types it, no surface adapts it, and no surface wraps it in a
 * template — it appears as these bytes or it does not appear.
 *
 * TWO DELIBERATE ODDITIES, both because verbatim outranks house style:
 *  - a STRAIGHT apostrophe in "Tacendum's", where every other string in this
 *    file uses the typographic one. The doc writes it straight, and the drift
 *    test (app/__tests__/AiDisclosure.test.ts) compares bytes against the doc
 *    itself, so matching it is the whole point.
 *  - no trailing context and no lead-in. Anything a surface needs to say
 *    around it is that surface's own copy, kept next to it — never spliced
 *    into it.
 *
 * Why it must be shown BEFORE, not after: Apple 5.1.2(i) (in force
 * 2026-06-08) asks for disclosure of sharing with third-party AI *with
 * permission first*, and EU AI Act Art. 50 (in force 2026-08-02) for the
 * interaction disclosure. Both are placement claims. The surfaces are named
 * in the disclosure doc's surface table.
 *
 * The CLI keeps its own copy in packages/cli/src/ai-origin.ts, pinned against
 * the same doc by the same kind of test — the two workspaces do not share a
 * module, so they share a source of truth instead.
 */
export const AI_DISCLOSURE_SENTENCE =
  'Replies you send are delivered to the AI provider through a client running on your machine; ' +
  "Tacendum's servers relay message ciphertext, not plaintext.";

/**
 * The machine section on a peer's profile (crew-chat spec; server contract in
 * handlers/crew.ts and handlers/integrations.ts).
 *
 * The app cannot know whether a contact IS one of its machines by ASKING —
 * the server deliberately exposes no list (enumeration is refused even to the
 * owner), and a local guess would be an oracle the server declined to be. So
 * the section exists on every profile, says who it is for, and lets the
 * SERVER answer: both actions are owner-called routes that refuse cleanly for
 * anything that is not a machine this account paired. The refusal copy keeps
 * the server's collapse — one answer for not-a-machine, someone-else's, and
 * someone-else's-crew — because a screen that distinguished them would leak
 * what the route was built not to.
 *
 * What the app MAY hold (the Art. 50 labeling layer): the server's
 * own POSITIVE answers. A 204 on adopt or revoke is the server telling this
 * owner, about this one id, "yes — this is a machine you paired". Remembering
 * that answer is not enumeration and not a guess; it is memory of a
 * disclosure the server already made to the one party entitled to it. The
 * record lives in db.ts (`machine_peers`), is written ONLY on those two
 * answers, and is append-only — a class is never acquired, shed, or spoofed
 * after birth (the server's own rule, dto.ts AuthRequest), so a revoked
 * machine's history keeps its marker. The refusals stay unrecorded and
 * uncollapsed exactly as before.
 */
export const MACHINE_COPY = {
  title: 'If this is one of your machines',
  /** The Art. 50 interaction disclosure, said plainly and said FIRST — this
   * is the screen where a human takes an AI agent into their crew, and the
   * disclosure doc asks for the plain statement alongside the
   * data-flow sentence. Framed conditionally to match the section title: the
   * section shows on every profile because the server refuses to enumerate a
   * crew, so this may not assert that THIS peer is an agent. */
  agentIsAI:
    'A machine you adopt here is an AI agent: it answers by itself, on the computer you set it up on.',
  /** The disclosure sentence, quoted. Rendered above the adopt action and
   * left on screen through the confirm step, because 5.1.2(i) asks for
   * permission FIRST and disclosure after the 204 is disclosure after the
   * fact. */
  disclosure: AI_DISCLOSURE_SENTENCE,
  explainLabel: 'What these do',
  explain: [
    'A machine you set up with the CLI can only ever message you.',
    'Adopting it into your crew also lets it message the other machines you adopt — never anyone else.',
    `To watch them work together, put your machines in a room with you. Crew machines can also message each other directly, and those messages don’t pass through your ${DEVICE_NOUN}.`,
    'Revoking retires its key permanently — that machine can never sign in or send again.',
    'Both are checked by the server: they refuse for anyone who is not a machine you paired.',
    // The two honest limits the disclosure would otherwise imply away
    // (the disclosure doc's honest limits). Behind the ⓘ per the house pattern —
    // and stated, not softened: "disclosure buys an informed operator, not a
    // safe agent", and "ciphertext only" without the metadata sentence would
    // be the overclaim this repo's privacy answers already refuse to make.
    'The agent runs through the AI provider you signed in to yourself. Once your words reach it, what happens to them is governed by your own agreement with that provider — we don’t see it and can’t speak for it.',
    'Encryption hides what you say, not that you said it: the relay still sees who messaged whom, when, and how large the ciphertext was.',
  ],
  adopt: 'Adopt into crew',
  adoptConfirmQuestion: 'Let this machine message your other crew machines?',
  adoptConfirm: 'Adopt',
  revoke: 'Revoke this machine',
  revokeConfirmQuestion: 'Retire this machine’s key for good?',
  revokeConfirm: 'Revoke',
  cancel: 'Not now',
  adopted: 'Adopted — it can now message you and its crew-mates.',
  revoked: 'Revoked — the key is retired for good.',
} as const;

/**
 * The AI marker's copy (the in-conversation half of the
 * Article 50 position), in one place so every surface quotes it rather
 * than paraphrasing.
 *
 * THE KNOWLEDGE-SOURCE DECISION, pinned here because this is the module the
 * next reader opens: the badge derives from the message's AUTHENTICATED
 * sender id looked up in `machine_peers` — the app's memory of the server's
 * positive adopt/revoke answers (see the module comment above) — and from
 * NOTHING a message carries. No roster or profile payload discloses a peer's
 * account class (dto.ts carries `accountClass` only on the SELF sign-in
 * response), so the own-record is the only server-anchored source the app
 * has. It covers v1: the server's send/invite predicates (handlers/ws.ts)
 * confine a crew room's roster to {the owner, integrations the
 * owner ADOPTED}, and adoption is exactly the recorded moment — so in any
 * crew room this app can sit in, every integration present is one this
 * record names. The attribution is therefore always second person ("your"):
 * the only agents in reach are the viewer's own. Multi-human rooms
 * break that assumption and owe the in-envelope AI-origin marker
 * recorded as the design intent.
 *
 * The first half of that debt is PAID: the in-envelope marker
 * now rides every agent-authored body (`ai: true`, @tacendum/shared
 * ai-origin.ts), is recorded at arrival on the message row (`messages.ai`),
 * and the badge derives marker-OR-record — the record still wins against a
 * lying client that omits the marker, and the marker badges where no record
 * exists (the paired-never-adopted 1:1; later, a stranger's phone in a
 * shared room). The marker is sender-claimed and relay-invisible, never
 * proof — its honesty limits bind every surface that renders it.
 */
export const AGENT_COPY = {
  /** The compact in-thread marker. Words, not colour: the distinction must
   * survive VoiceOver, monochrome, and every theme. */
  badge: 'AI',
  /** The roster badge — attribution, not verification. It may never borrow
   * the safety vocabulary ("verified", "checked"): a safety number is
   * between two people, and this tag is about WHAT speaks, not whether the
   * key matched. */
  rosterBadge: 'Your AI agent',
  /** The spoken clause VoiceOver inserts after the speaker's name. */
  spokenClause: 'your AI agent',
  /** "Claude · laptop — your AI agent" — the owner-attributed
   * shape ("Claude — Ana's agent"), second person for v1 (see above). */
  attributed: (name: string) => `${name} — your AI agent`,
  /** Teaching copy behind the roster ⓘ, shown only when an agent is in the
   * room. */
  rosterInfo:
    'The AI tag marks a machine you paired to this account. It says what is speaking — it isn’t a safety check, and their safety number works like anyone’s.',

  /**
   * THE FOREIGN AGENT.
   * Multi-human rooms broke the second-person assumption above: a second human now sits in
   * rooms with SOMEONE ELSE'S agent, known not from machine_peers (the
   * server discloses classes only to the owner) but from the room OWNER's
   * roster write carrying `class: 'integration'` — sender-claimed, exactly
   * like the message marker, and read off the fold's authority lane
   * alone. The attribution therefore names the owner — the
   * "Claude — Ana's agent" anatomy, finally in third person — because the
   * one thing the class provably says is WHO added it.
   */
  /** The compact roster badge for an agent this account does not own. */
  foreignRosterBadge: 'AI agent',
  /** "Claude · laptop — Ana’s AI agent": the owner-attributed third-person
   * form. `owner` is the room owner's display name — the fold's authority
   * writer, the one party whose claim this is. Used ONLY for a
   * ROSTER-CLASSED member: the class is the owner's write, so the owner may
   * be named as the claimant. A marker-only agent gets `selfLabeled` below —
   * the owner claimed nothing about it. */
  foreignAttributed: (name: string, owner: string) =>
    `${name} — ${owner}’s AI agent`,
  /** "Claude · laptop — AI agent (self-labeled)": a MARKER-only agent, in
   * the set because IT sent a marker-carrying body here — no roster class exists,
   * so no owner made any claim and none is named (a remediation:
   * "Ana's AI agent" on a marker-only row put a claim in the owner's mouth).
   * The one thing this copy asserts is exactly what the marker is: the
   * member's own label on its own speech. */
  selfLabeled: (name: string) => `${name} — AI agent (self-labeled)`,
  /** Teaching copy behind the roster ⓘ for a foreign agent. The second
   * sentence is the sanctioned claim, verbatim — never
   * paraphrased, never strengthened. */
  foreignRosterInfo:
    'The AI tag can also mark an agent added by the person who runs the room — their own records say what it is. An agent can only reach room members who chose to share with it — the server refuses everything else.',
} as const;

/**
 * One failure sentence per outcome, and only outcomes the server actually
 * has. Two rules enforced here:
 *
 *  - "Nothing changed" may be said ONLY where the server decides before it
 *    mutates — the coded refusals below, all of which precede the write.
 *    A network failure, or a 5xx, can arrive AFTER the change landed
 *    (revoke tombstones the key before its later cleanup steps), so those
 *    sentences leave the outcome explicitly open and say that a repeat is
 *    safe — both routes answer a repeat idempotently.
 *  - The default for an unreached server is the offline sentence, which is
 *    deliberately also the duress session's sentence: the transport guard
 *    throws exactly what a dead network throws, and the copy must not tell
 *    those apart.
 */
export function machineFailureCopy(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'not_integration_owner':
        return 'Not a machine you paired — nothing changed.';
      case 'cap_reached':
        return 'Your crew is full (8 machines). Revoke one to free a slot.';
      case 'crew_contended':
        return 'The server is mid-change on your crew — try again in a moment.';
      case 'not_found':
        return 'No such account on the server.';
      case 'invalid_request':
        return 'That can’t be adopted.';
      default:
        return 'The server hit a problem mid-change — it may or may not have taken. Trying again is safe.';
    }
  }
  return 'Couldn’t reach the server — this may not have gone through. Trying again is safe.';
}
