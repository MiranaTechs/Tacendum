// The room-event sentence, lifted out of ChatThreadScreen.tsx verbatim
// as one pure function over an envelope and
// four facts about who wrote it — no state, no theme, no render.
//
// The screen still re-exports it under its own name, because
// ChatThread.agentbadge.test.tsx imports it from there and this split is
// held to zero test edits.
//
// Import direction is one-way: nothing here comes from `../screens/`.
import { disappearLabel } from '../blocking';
import { type Envelope } from '../envelope';
import { AGENT_COPY } from '../machine';

/**
 * The sentence for one room event row.
 *
 * EVERY subject here derives from the AUTHENTICATED author — `row.authorId`
 * for an inbound row, this phone for an outbound one — never from a payload
 * field and never from bubble position. Counted versus declined is decided
 * the same way the receive path decided it: against the anchor's owner, a
 * constant, so the classification is deterministic forever. The one payload
 * field a sentence may name is the OBJECT (`m`, the member acted on), which
 * is the write's content, not its authorship.
 */
export function roomEventSentence(args: {
  envelope: Envelope;
  out: boolean;
  authorId: string | null | undefined;
  ownerId: string | null;
  selfId: string | null;
  nameFor: (id: string) => string;
  /** Whether an id is a recorded machine — grp.roster sentences name
   * an agent WITH its attribution ("Claude — your AI agent"), because the
   * agent's join is the group-visible Art. 50 roster event. Derived from the
   * machine record like every badge; the sentence's SUBJECT still comes from
   * the authenticated author and its OBJECT from `m`, unchanged. */
  isAgentId?: (id: string) => boolean;
}): string | null {
  const { envelope, out, ownerId, selfId, nameFor } = args;
  const isAgent = args.isAgentId ?? (() => false);
  const writer = out ? selfId : (args.authorId ?? null);
  const subject = out ? 'You' : writer ? nameFor(writer) : 'Someone';
  const ownerName = ownerId
    ? ownerId === selfId
      ? 'you'
      : nameFor(ownerId)
    : 'the person who runs this room';
  if (envelope.tcm === 'grp.new') {
    return `${subject} started this room.`;
  }
  if (envelope.tcm === 'grp.roster') {
    const object =
      envelope.m === selfId
        ? 'you'
        : isAgent(envelope.m)
          ? AGENT_COPY.attributed(nameFor(envelope.m))
          : nameFor(envelope.m);
    if (writer !== null && writer === envelope.m) {
      // The sovereign self lane: nobody can write it but them.
      // An agent's own join/leave carries the attribution mid-sentence:
      // "Claude — your AI agent — joined."
      const self =
        !out && isAgent(writer) ? `${AGENT_COPY.attributed(subject)} —` : subject;
      return envelope.s === 'out'
        ? `${self} left.`
        : `${self} joined.`;
    }
    if (writer !== null && ownerId !== null && writer === ownerId) {
      return envelope.s === 'in'
        ? `${subject} added ${object}.`
        : `${subject} removed ${object}.`;
    }
    // Declined, attributed, never silent: dead the moment it arrived.
    return envelope.s === 'in'
      ? `${subject} tried to add ${object}. Only ${ownerName} can change who’s in this room.`
      : `${subject} tried to remove ${object}. Only ${ownerName} can change who’s in this room.`;
  }
  if (envelope.tcm === 'grp.consent') {
    // The member-consent announcement. The SUBJECT is
    // the authenticated writer (a member narrating their OWN stance — there
    // is no subject on the wire to forge); the OBJECT is the one agent the
    // payload names, a room co-member. The agent wears its attribution only
    // where the machine record names it (the agent's own owner); a second
    // human, whose record does not, sees the plain name — honest, because it
    // is not their agent. The refusal is the load-bearing line ("Bob isn't
    // sharing with Claude"): a member the agent cannot hear is a fact every
    // author deserves before typing.
    const agent = isAgent(envelope.a)
      ? AGENT_COPY.attributed(nameFor(envelope.a))
      : nameFor(envelope.a);
    return envelope.s === 'share'
      ? out
        ? `You’re sharing with ${agent}.`
        : `${subject} is sharing with ${agent}.`
      : out
        ? `You’re not sharing with ${agent}.`
        : `${subject} isn’t sharing with ${agent}.`;
  }
  if (envelope.tcm === 'grp.hist') {
    // Rule 3 of the history-share decision, rendered. The authors could not
    // consent — their words were already sent — so the one thing they get is
    // being told, by name and by extent. Counted versus declined is derived
    // here exactly as the roster's is, from the writer against the anchor's
    // owner, which is a constant.
    const object = envelope.to === selfId ? 'you' : nameFor(envelope.to);
    const count =
      envelope.c === 1 ? '1 earlier message' : `${envelope.c} earlier messages`;
    if (writer !== null && ownerId !== null && writer === ownerId) {
      return `${subject} shared ${count} with ${object}.`;
    }
    return `${subject} tried to share ${count} with ${object}. Only ${ownerName} can share this room’s history.`;
  }
  if (envelope.tcm === 'grp.set') {
    const label = disappearLabel(envelope.s);
    // `0` asserts no constraint  — it never drags the room to "off",
    // so the sentence claims only the writer's own slot.
    return label === null
      ? `${subject} turned their disappearing-message timer off.`
      : `${subject} set disappearing messages to ${label}.`;
  }
  if (envelope.tcm === 'grp.del') {
    // Only a DECLINED grp.del ever persists as a row — a counted one purges
    // the room it would have announced into.
    return `${subject} tried to delete this room for everyone. Only ${ownerName} can do that.`;
  }
  return null;
}
