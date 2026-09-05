/**
 * Inbound room bodies: apply, then render.
 *
 * This module is the CLI's half of the bargain `rooms.ts` states: the store
 * holds no rules, so every decision about who may write what is made HERE by
 * calling `@tacendum/shared/group-fold` — the ONE implementation of the
 * roster rules both clients run. Nothing in this file compares a writer to an
 * owner itself; it asks the fold (`applyRosterWrite`, `applyGroupDel`,
 * `ownerOnlyPolicy`) and renders the fold's answer. Counted, declined, stale
 * and unknown-room are the fold's words, and the sentences below are just
 * those words in the app's own voice (`app/src/screens/ChatThreadScreen.tsx`
 * `roomEventSentence` — matched in meaning, not in pixels).
 *
 * WHY APPLY AND RENDER SHARE A FUNCTION: what a room event LOOKS like depends
 * on what it DID. A replayed roster write ('stale') announces nothing — the
 * announce-only-when-applied rule, which is what stops one old envelope
 * becoming an endless announcement stream — and a declined write announces
 * loudly, attributed, never silently (nothing is ever "not yet
 * decidable", and nothing counted-or-declined is ever dropped without a
 * trace). Deriving the sentence anywhere but at the apply would mean deriving
 * the classification twice.
 *
 * ONE CONTENT SWITCH: the inner body of a `grp.msg` — and of a
 * `grp.hist` transcript entry — is fed back through `renderBody`, so a photo
 * in a room is the SAME photo branch a 1:1 photo is. The room context adds a
 * label and a provenance frame around the result; it never re-implements a
 * content arm. Two copies pass tests and then drift; that has shipped twice
 * in this codebase, and the comment on the app's `applyContent` records it.
 */

import {
  applyGroupDel,
  applyGroupNew,
  applyRosterWrite,
  applySettingsWrite,
  foldRoster,
  noteRoomTraffic,
  ownerOnlyPolicy,
  unconditionalPolicy,
  verdictFor,
  Ulid,
  type RosterSlot,
  type SettingsSlot,
} from '@tacendum/shared/group-fold';
import {
  GroupConsentEnvelope,
  GroupDelEnvelope,
  GroupHistoryEnvelope,
  GroupMessageEnvelope,
  GroupNewEnvelope,
  GroupRosterEnvelope,
  GroupSettingsEnvelope,
  isGroupTcm,
} from '@tacendum/shared/group-envelope';
import { roomAiAuthorIds } from './msglog.js';
import {
  MENTION_NAME_MAX,
  UNSUPPORTED_TEXT,
  renderBody,
  sanitizeForTerminal,
  type GroupBodyRenderer,
  type MentionNames,
  type RenderedBody,
} from './render.js';
import { FileGroupStore } from './rooms.js';
import { FileStores } from './stores.js';
import { readProfile } from './profile.js';

/**
 * Inner kinds that are NOT conversation inside a room, mirrored from the
 * app's `handleGroupMessage` refusal list: the pairwise settings kinds have
 * room-native counterparts (`grp.set`; receipts are off in rooms) and
 * applying — or announcing — one here would bypass the room's own lattice
 * with a two-party rule. `call.*` and `x.*` need no entry: the namespace
 * routing in `renderBody` already renders them as silence, and a nested
 * `grp.*` is the laundering refusal, checked by prefix below so even a
 * future room kind cannot ride inside a wrapper.
 */
const NOT_CONVERSATION_IN_ROOMS = new Set(['timer', 'vault', 'profile', 'read']);

/** Show nothing, on either stream, and never spool. */
function silent(tcm: string): RenderedBody {
  return { tcm, carrier: true, text: '' };
}

/**
 * The per-frame mention resolution `renderBody` takes:
 * `@you` for this account, this client's OWN stored name for anyone else. The
 * names file is loaded lazily and at most once per frame — most bodies carry
 * no mark, and a mention with five marks must not read the file five times.
 * A store that cannot be read resolves nobody, which renders the placeholder:
 * a name is a nicety, never a ULID on the terminal.
 */
export function mentionNames(client: string, selfId: string): MentionNames {
  let map: Record<string, string> | undefined;
  return {
    selfId,
    nameFor: (id) => {
      if (map === undefined) {
        try {
          map = new FileStores(client).loadPeerNames();
        } catch {
          map = {};
        }
      }
      return map[id];
    },
  };
}

/** The conversational forward-compat line: visible, and never raw JSON. */
function unsupported(tcm: string): RenderedBody {
  return { tcm, carrier: false, text: `[${UNSUPPORTED_TEXT}]` };
}

/**
 * How a PERSON is named in a room sentence: `you` for this account, this
 * client's own stored name when it holds one, else the id itself — the same
 * resolution the mention arm already performs ("an id means nothing to a
 * human"), applied to the roster and history sentences that used to print
 * bare ULIDs beside it. The fallback stays the FULL id, deliberately: on
 * this surface the id is the operable token (`room remove`, `contacts`),
 * not the app's shortId nicety. Two stored labels are refused the slot: a
 * peer self-named "you" or "them" would forge the self signal these
 * sentences carry (the app's nameFor rule — the mention arm tolerates them
 * only behind its `@`). Sanitized AGAIN at display and bounded by the
 * mention arm's constant, on its reasoning: the names file is hand-editable,
 * and a file is an input too.
 */
export function personLabel(names: MentionNames, id: string): string {
  if (id === names.selfId) return 'you';
  const stored = names.nameFor(id);
  if (stored === undefined) return id;
  const clean = sanitizeForTerminal(stored).slice(0, MENTION_NAME_MAX).trim();
  return clean === '' || /^(you|them)$/i.test(clean) ? id : clean;
}

/**
 * The §5.3 message-id grammar — 26 characters of Crockford base32, the same
 * alphabet `room-commands.ts:ROOM_REF_RE` reads either half of a room content
 * ref in. Mirrored rather than imported on `ROOM_REF_RE`'s own terms (one
 * shape, two readers, drift made visible by test); `packages/cli/test/
 * gate.rounds.test.ts` compares this source against the shared mirror.
 */
const ROOM_M_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The room label every line leads with: the stored name when the room has
 * one, else the group id. The name is peer-chosen text bound for a terminal,
 * sanitized AGAIN at display even though the schema bounded it at accept,
 * because the room file is hand-editable and a file is an input too (the
 * peer-names precedent in stores.ts).
 */
export function roomLabel(store: FileGroupStore): string {
  const name = store.getName();
  if (name === null) return store.groupId;
  const clean = sanitizeForTerminal(name).slice(0, 80).trim();
  return clean === '' ? store.groupId : clean;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * THE AGENT-SIDE WALL: v1 agents ride ONLY in rooms their owner created —
 * "its CLI must room accept, which only its owner operates" — so a client
 * running AS a bound integration refuses to anchor a room from anyone but
 * that owner. Previously the server enforced this for free (no non-owner
 * frame could reach an agent's inbox at all); a consent edge now opens the
 * inbox, so the wall must be the client's own.
 *
 * The answer is who may anchor: the profile's `ownerUserId` when this
 * client IS an integration (`accountClass`, set at birth and recorded in
 * the profile — profile.ts), `null` for a human client (no wall — humans
 * accept invites from anyone, today's behaviour untouched). FAIL CLOSED
 * for the agent: an integration whose profile names no owner (unbound)
 * anchors NOTHING — an agent with no owner has no rooms. Residual, stated:
 * a profile that cannot be READ answers `null` (no wall) rather than
 * refusing, because the class question is unanswerable without it and
 * refusing would change human-client behaviour on the same failure — the
 * window is a profile that read fine when inbound started and tore before
 * this frame, local corruption the room file shares anyway.
 */
function roomAnchorAuthority(client: string): string | null | undefined {
  try {
    const read = readProfile(client);
    if (read.kind !== 'ok') return null;
    const p = read.profile as { accountClass?: unknown; ownerUserId?: unknown };
    if (p.accountClass !== 'integration') return null;
    return typeof p.ownerUserId === 'string' && p.ownerUserId !== ''
      ? p.ownerUserId
      : undefined;
  } catch {
    return null;
  }
}

/**
 * Build the per-frame renderer `renderBody` routes `grp.*` bodies to.
 *
 * `from` is the frame's AUTHENTICATED sender — the ratchet that decrypted the
 * body vouches for it — and it is the ONLY authorship input this module ever
 * uses: every lane a write lands in, every subject a
 * sentence attributes, derives from it. Payload fields contribute only the
 * OBJECT of a sentence (the member acted on, the claimed author of a relayed
 * entry — explicitly labelled as a claim), never its authorship.
 */
export function groupBodyRenderer(
  client: string,
  selfId: string,
  from: string,
): GroupBodyRenderer {
  const names = mentionNames(client, selfId);
  return (declared, body) => {
    try {
      return renderGroupBody(client, selfId, from, declared, body, names);
    } catch {
      // A store failure (a full disk failing the room file's persist) must
      // not escape the render boundary: upstream classifies a throw here as
      // a decrypt failure and would report a delivered message as poison.
      // Loud instead, with fixed prose — no path, no id, no errno text.
      // RESIDUAL, stated plainly: the frame is still acked upstream, so a
      // room write that could not persist is not retried; the divergence is
      // one client's, visible on the next counted change, and the owner's
      // next write about the same member restates the lane whole.
      return {
        tcm: declared,
        carrier: false,
        text: '[a room change arrived but could not be saved — room state on this client may be stale]',
      };
    }
  };
}

function renderGroupBody(
  client: string,
  selfId: string,
  from: string,
  declared: string,
  body: string,
  names: MentionNames,
): RenderedBody {
  // A room kind minted after this build: a human is told their build
  // is too old — the conversational forward-compat path — never raw JSON.
  if (!isGroupTcm(declared)) return unsupported(declared);

  // The sender id names the lane a write lands in and the file a room lives
  // in; one that is not a ULID can hold neither. Decrypt success makes this
  // near-impossible (the session is looked up by this id), so refusing
  // loudly-but-genericly costs nothing.
  if (!Ulid.safeParse(from).success) return unsupported(declared);

  const raw = parseJson(body);

  switch (declared) {
    case 'grp.msg': {
      // NO NESTING, checked BEFORE the schema: the shared schema
      // refuses a wrapped `grp.*` too, but a schema refusal renders as the
      // visible unsupported notice, and the rule for a nested wrapper is
      // "dropped quietly" — a laundering attempt earns silence, not a row.
      const innerBody = (raw as { b?: unknown } | null | undefined)?.b;
      if (typeof innerBody === 'string' && innerBody.startsWith('{"tcm":"grp.')) {
        return silent(declared);
      }
      const parsed = GroupMessageEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      return renderRoomMessage(client, selfId, from, parsed.data, names);
    }
    case 'grp.new': {
      const parsed = GroupNewEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      // THE AGENT-SIDE WALL (see roomAnchorAuthority): a client running
      // as a bound integration anchors rooms from its OWNER alone — a
      // consented stranger's grp.new must not build a room inside the
      // agent's client (v1: agents ride only in rooms their owner created).
      // Refused LOUDLY and attributed (the roster arm's declined shape,
      // never a silent drop): the refusal is the record the operator audits,
      // it spools nothing (maySpool admits no grp.new text), and it applies
      // nothing — an unanchored gid stays unanchored, so the sender's
      // follow-up grp.msg traffic renders as silence, not as a room.
      const anchorOwner = roomAnchorAuthority(client);
      if (anchorOwner !== null && from !== anchorOwner) {
        return {
          tcm: declared,
          carrier: false,
          text:
            '[tried to start a room on this agent — refused: this agent joins only ' +
            'rooms its owner starts]',
        };
      }
      const store = FileGroupStore.load(client, env.g);
      const result = applyGroupNew(
        store,
        selfId,
        {
          writerId: from,
          members: env.ms,
          seq: env.n,
          // The writer's class claims: stamped onto the
          // seed slots so THIS client's fold knows which members the owner's
          // records call machines — before any of them has spoken. Judged by
          // the fold (authority lane only), never here.
          ...(env.ic !== undefined ? { integrations: env.ic } : {}),
        },
        ownerOnlyPolicy,
      );
      // 'ignored' covers an exact replay AND a forged re-anchor from a second
      // writer: nothing moved, nothing persists, nothing announces.
      if (result.outcome === 'ignored') return silent(declared);
      // The accept path names the room from the envelope; a later duplicate
      // keeps the stored anchor's name (written once).
      if (store.getName() === null) store.setName(env.nm);
      store.persist();
      // 'merged' moved seed slots with no new surface row (the app's rule).
      if (result.outcome !== 'accepted') return silent(declared);
      // Being added to a room is a thing that happened to you. The
      // group id is stated because it is what `room accept`/`room show` take.
      return {
        tcm: declared,
        carrier: false,
        text: `[${roomLabel(store)}] [started this room — ${env.g}]`,
      };
    }
    case 'grp.roster': {
      const parsed = GroupRosterEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      const store = FileGroupStore.load(client, env.g);
      const write: RosterSlot = {
        // The writer is frame.from, NEVER a payload field.
        writerId: from,
        memberId: env.m,
        seq: env.n,
        state: env.s,
        // The class claim rides the slot verbatim;
        // whether it MEANS anything is the fold's call — only the owner's
        // authority lane classifies, so a non-owner's claim is stored inert.
        ...(env.c !== undefined ? { class: env.c } : {}),
      };
      const result = applyRosterWrite(store, selfId, write, ownerOnlyPolicy);
      if (result.outcome === 'unknown-room') return silent(declared);
      // Persist exactly what changed something: a counted write, a stored
      // pre-anchor self write, or a replay that recreated a hidden room.
      // A declined write stores nothing — there is nothing to persist.
      if (
        result.outcome === 'applied' ||
        result.outcome === 'self-preanchor' ||
        (result.outcome === 'stale' && result.recreated)
      ) {
        store.persist();
      }
      if (result.outcome === 'self-preanchor') return silent(declared);
      // 'stale' — a replay — announces NOTHING: the announce-only-when-
      // applied rule, which stops one old envelope becoming a stream.
      if (result.outcome === 'stale') return silent(declared);
      if (!store.isPresent()) return silent(declared);
      const label = roomLabel(store);
      const object = personLabel(names, env.m);
      if (result.outcome === 'declined') {
        // Provably dead the moment it arrived — and rendered loudly,
        // attributed to its authenticated writer by the caller's [from]
        // prefix, never silently dropped (the founding argument).
        const verb = env.s === 'in' ? 'add' : 'remove';
        return {
          tcm: declared,
          carrier: false,
          text: `[${label}] [tried to ${verb} ${object} — only the owner can change who is in this room]`,
        };
      }
      if (result.lane === 'self') {
        // The sovereign lane: nobody can write it but them.
        return {
          tcm: declared,
          carrier: false,
          text: env.s === 'out' ? `[${label}] [left this room]` : `[${label}] [joined this room]`,
        };
      }
      return {
        tcm: declared,
        carrier: false,
        text:
          env.s === 'in'
            ? `[${label}] [added ${object} to this room]`
            : `[${label}] [removed ${object} from this room]`,
      };
    }
    case 'grp.set': {
      const parsed = GroupSettingsEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      const store = FileGroupStore.load(client, env.g);
      const write: SettingsSlot = { writerId: from, seq: env.n, disappearSec: env.s };
      const result = applySettingsWrite(store, write, unconditionalPolicy);
      if (result === 'applied' || result === 'self-preanchor') store.persist();
      if (!store.isPresent()) return silent(declared);
      const label = roomLabel(store);
      if (result === 'declined') {
        // Unreachable under the production (unconditional) policy, kept for
        // the day a declining room class ships: the contract requires the declined-
        // not-silent shape here, the same as the roster's.
        return {
          tcm: declared,
          carrier: false,
          text: `[${label}] [tried to change disappearing messages — declined]`,
        };
      }
      // Announced ONLY when applied: 'stale' and 'self-preanchor'
      // say nothing, so a replayed envelope cannot become a notice stream.
      if (result !== 'applied') return silent(declared);
      return {
        tcm: declared,
        carrier: false,
        text:
          env.s > 0
            ? `[${label}] [set disappearing messages to ${env.s}s]`
            : `[${label}] [turned their disappearing-message timer off]`,
      };
    }
    case 'grp.del': {
      const parsed = GroupDelEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      const store = FileGroupStore.load(client, env.g);
      // Captured BEFORE the purge: a counted delete clears the name with
      // everything else, and the announcement still owes the operator which
      // room it was.
      const label = roomLabel(store);
      const presentBefore = store.isPresent();
      const result = applyGroupDel(store, { writerId: from, seq: env.n });
      // No tombstone, deliberately: a delete for a room this client
      // does not hold does nothing and says nothing.
      if (result === 'unknown-room') return silent(declared);
      if (result === 'purged') {
        store.persist(); // removes the room file — the full purge
        // The app renders nothing here only because the thread it would
        // announce into is gone; a stream has no such excuse, and a room
        // deleted under you is a thing that happened to you.
        return {
          tcm: declared,
          carrier: false,
          text: `[${label}] [deleted this room for everyone]`,
        };
      }
      // Declined: attributed and visible (the same copy), but only where there
      // is a room surface to show it on — the app's presentBefore rule.
      if (!presentBefore) return silent(declared);
      return {
        tcm: declared,
        carrier: false,
        text: `[${label}] [tried to delete this room for everyone — only the owner can]`,
      };
    }
    case 'grp.hist': {
      // The same quiet drop for a wrapped `grp.*` inside a transcript entry
      // (and the schema's own sharper argument: a relayed body is
      // already an unauthenticated claim, so a smuggled room write inside
      // one would launder membership under a third party's name).
      const entryBody = (raw as { e?: { b?: unknown } } | null | undefined)?.e?.b;
      if (typeof entryBody === 'string' && entryBody.startsWith('{"tcm":"grp.')) {
        return silent(declared);
      }
      const parsed = GroupHistoryEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      const store = FileGroupStore.load(client, env.g);
      const owner = store.getOwner();
      // Unanchored or ended room: discarded quietly. Straggler
      // history recreates nothing — mirrored from the app's handler.
      if (owner === undefined || !store.isPresent()) return silent(declared);
      // THE OWNER GATE IS THE WHOLE SECURITY PROPERTY (app messaging.ts,
      // handleGroupHistory): a relayed entry is an unauthenticated claim
      // about a third party's words, so the one thing that must hold is that
      // only the room's owner can make the claim at all. The predicate is
      // the fold's own, never an `===` minted here.
      const byOwner = ownerOnlyPolicy(from, owner);
      const label = roomLabel(store);
      if (byOwner && env.e !== undefined) {
        const entry = env.e;
        // The timer binds, checked against MY clock and not the relayer's:
        // a skewed or dishonest sender must not hand back a message the
        // timer already took, or the timer becomes a suggestion.
        if (entry.x !== undefined && entry.x <= Date.now()) return silent(declared);
        // The unwrap rule again: the entry's body was already a legal message body, so
        // it runs the SAME switch — a relayed photo is the photo branch, not
        // a second implementation and not an unsupported notice. The mention
        // resolution rides along: a relayed mention shows THIS client's
        // names, never ids — the relayer's names never travelled at all.
        const inner = renderBody(entry.b, undefined, names);
        if (
          inner.carrier ||
          inner.text === '' ||
          inner.tcm.startsWith('grp.') ||
          NOT_CONVERSATION_IN_ROOMS.has(inner.tcm)
        ) {
          // A relayed state-change claim is not conversation; only words and
          // pictures are worth relaying, and nothing else renders.
          return silent(declared);
        }
        // THE PROVENANCE FRAME IS NOT DECORATION. The ratchet authenticated
        // the RELAYER (`from`, the caller's [from] prefix) and says nothing
        // about `entry.a`, so a dishonest relayer could have written every
        // word. The app's sharedTag copy, matched in meaning: this line must
        // never read as if the claimed author sent it to you. Both people
        // resolve through the stored names exactly as the app's copy does —
        // the CLAIM framing is what carries the caveat, not the rawness of
        // the ids.
        // The possessive bends for the one label that isn't a name: a frame
        // this account relayed reads "your copy", not "you's". A peer
        // self-named "you" cannot reach this slot — personLabel already
        // refuses it the label.
        const relayer = personLabel(names, from);
        const whose = relayer === 'you' ? 'your' : `${relayer}’s`;
        // NO `detail` HERE, deliberately (covers `grp.msg`
        // only): a relayed entry is an unauthenticated claim about a third
        // party's words, and this arm answers it with ONE framed sentence
        // that carries the caveat. A detail is shown on its own, away from
        // that frame, so relaying one would strip the only thing making the
        // claim honest — and it would do it to the longest text on the path.
        return {
          tcm: declared,
          carrier: false,
          text: `[${label}] shared this — ${personLabel(names, entry.a)} wrote it, if ${whose} copy is right: ${inner.text}`,
        };
      }
      const object = personLabel(names, env.to);
      const count = env.c === 1 ? '1 earlier message' : `${env.c} earlier messages`;
      if (byOwner) {
        // Rule 3 of the history-share decision: the authors could not
        // consent — their words were already sent — so the one thing they
        // get is being TOLD, by name and by extent.
        return {
          tcm: declared,
          carrier: false,
          text: `[${label}] [shared ${count} with ${object}]`,
        };
      }
      return {
        tcm: declared,
        carrier: false,
        text: `[${label}] [tried to share ${count} with ${object} — only the owner can share this room’s history]`,
      };
    }
    case 'grp.consent': {
      // The member-consent announcement: a member
      // narrating their OWN sharing stance toward one agent, so a CLI reader
      // in a mixed room sees the sentence rather than an unsupported notice.
      // A SOVEREIGN self-statement — the subject is the authenticated writer,
      // carried by the caller's [from] prefix (the roster case's rule), never
      // a payload field. Rendered only where there is a room surface AND the
      // writer is a current member; a non-member cannot narrate a room they
      // are not in.
      const parsed = GroupConsentEnvelope.safeParse(raw);
      if (!parsed.success) return unsupported(declared);
      const env = parsed.data;
      const store = FileGroupStore.load(client, env.g);
      const owner = store.getOwner();
      if (owner === undefined || !store.isPresent()) return silent(declared);
      const fold = foldRoster(owner, store.listSlots(), ownerOnlyPolicy);
      if (verdictFor(fold, from) !== 'in') return silent(declared);
      // SUBJECT GATE — parity with the app's handleGroupConsent drop
      // (app/src/messaging.ts): a stance renders only when
      // `a` is an AGENT-CLASS member of this room, because a stance about a
      // non-agent account is meaningless and a spoof vector — a modified
      // client could otherwise name an arbitrary account and mint a
      // misleading line ("Mallory isn't sharing with Bob").
      //
      // Until the roster-class upgrade the CLI could enforce only co-membership (its
      // known residual: it held no room-scoped agent-class signal at this
      // seam, so a stance about a non-agent CO-MEMBER still rendered). The
      // roster-class upgrade closed that: the signal is now the same
      // marker-OR-class pair the app reads — the fold's `classes` (the
      // owner's authoritative roster write) ∨ the spool's AI-marked authors
      // (`roomAiAuthorIds`, the one reader of the msglog `ai` field).
      // Membership stays the floor beneath both.
      //
      // THE CLASS-LESS FALLBACK: the strict gate
      // applies only once the fold carries ANY class. In a room with no
      // class at all — a fresh-CLI or old-build owner who never emitted
      // `ic`/`c` — the agent pre-consent structurally cannot have spoken to
      // this client either (the server refuses those legs), so member ∧
      // (class ∨ marker) would silence EVERY legitimate stance: the consent
      // deadlock shape again, at the render seam. There the earlier
      // member-only ceiling stands instead. The tradeoff, plainly: such a
      // room keeps the old spoof surface (a stance naming a human co-member
      // renders) in exactly the rooms that always had it, and the first
      // class write the owner emits closes it for good. Liveness of a
      // load-bearing fact was ruled to outweigh a spoof the room's own
      // history already priced in.
      if (verdictFor(fold, env.a) !== 'in') return silent(declared);
      const anyClass = Object.values(fold.classes).some(
        cls => cls === 'integration',
      );
      if (
        anyClass &&
        fold.classes[env.a] !== 'integration' &&
        !roomAiAuthorIds(client, env.g).has(env.a)
      ) {
        return silent(declared);
      }
      const label = roomLabel(store);
      const agent = personLabel(names, env.a);
      return {
        tcm: declared,
        carrier: false,
        text:
          env.s === 'share'
            ? `[${label}] [is sharing with ${agent}]`
            : `[${label}] [isn’t sharing with ${agent}]`,
      };
    }
    default:
      return unsupported(declared);
  }
}

function renderRoomMessage(
  client: string,
  selfId: string,
  from: string,
  env: GroupMessageEnvelope,
  names: MentionNames,
): RenderedBody {
  const store = FileGroupStore.load(client, env.g);
  if (store.getOwner() === undefined) {
    // A room this client does not hold — never anchored, or ended by a
    // counted grp.del: decrypted and acked byte-identically upstream
    // (ratchet health), then discarded quietly.
    return silent('grp.msg');
  }
  // Counted room traffic recreates a locally hidden room iff this client's
  // OWN fold still says it is a member (deleteChat's precedent).
  if (noteRoomTraffic(store, selfId, ownerOnlyPolicy) === 'recreated') store.persist();
  if (!store.isPresent()) {
    // Left AND deleted: straggler traffic recreates nothing.
    return silent('grp.msg');
  }
  // THE UNWRAP: the inner body runs the ONE existing content switch.
  // No group renderer is passed to the recursion — a nested `grp.*` must not
  // apply anything, and the prefix check below drops it quietly (the schema
  // already refuses to compose one; this is the receive side's belt). The
  // mention resolution DOES ride along: a mention in a room is the same
  // mention branch a 1:1 mention is, resolved against the same names.
  const inner = renderBody(env.b, undefined, names);
  if (inner.tcm.startsWith('grp.') || NOT_CONVERSATION_IN_ROOMS.has(inner.tcm)) {
    return silent('grp.msg');
  }
  if (inner.text === '') {
    // Call signalling and the x. namespace inside a wrapper: silence in a
    // 1:1 is silence in a room.
    return { tcm: 'grp.msg', innerTcm: inner.tcm, carrier: true, text: '' };
  }
  // A sender my fold says is OUT still renders — visibly tagged and
  // attributed, never silently dropped. Removal is not simultaneous;
  // some of these are honest words from someone who does not yet know.
  // A sender never wanted again is what blocking is for, and blocked senders
  // are gated whole at the inbound seam, not here.
  const fold = foldRoster(store.getOwner()!, store.listSlots(), ownerOnlyPolicy);
  const outsider = verdictFor(fold, from) !== 'in';
  const tag = outsider ? ' (isn’t in this room)' : '';
  return {
    tcm: 'grp.msg',
    innerTcm: inner.tcm,
    carrier: inner.carrier,
    text: `[${roomLabel(store)}]${tag} ${inner.text}`,
    // The inner reply's route survives the wrapper.
    ...(inner.ref ? { ref: inner.ref } : {}),
    ...(inner.ofs ? { ofs: inner.ofs } : {}),
    //the inner answer's DETAIL rides the wrapper exactly as
    // its `ref` does, and for the same reason — the wrapper is where a room
    // message's inner fields go to die if nobody carries them up (the room
    // reply's accepted ref died here once already). Carried RAW: the room
    // label prefixes `text` because that is the line a terminal prints, and
    // prefixing the detail too would put the room's name inside a body that
    // is shown on its own, under the brief that already names the room.
    ...(inner.detail ? { detail: inner.detail } : {}),
    // The room trigger metadata: the room id, and the inner
    // mention's structured mentions-self flag riding the wrapper exactly as
    // the inner reply's ref does — this is the ONLY place env.g is in scope
    // at render time, so this is where the spool learns it.
    grp: env.g,
    //the room message id, the second half of the §5.3
    // compound row key `${from}.${env.m}`. Here for `grp`'s exact reason —
    // this is the only place `env.m` is in scope at render time — and
    // shape-checked HERE as well as at the schema: `GroupMessageEnvelope.m`
    // is `Ulid`, so this is a belt over the schema's braces, and the belt is
    // what makes the field's grammar true of the spool even if a future
    // caller renders a hand-built envelope. A malformed `m` yields no field,
    // and no field means the rounds composer falls back to bare text
    // (`ref-unavailable`) rather than composing a guessed ref.
    ...(ROOM_M_RE.test(env.m) ? { rm: env.m } : {}),
    ...(inner.men ? { men: true } : {}),
    // The Art. 50 marker rides the grp.msg WRAPPER (group-envelope.ts),
    // so an AI-marked wrapper names this author an agent of the room. The
    // spool records it (inbound.ts) as the marker half of the CLI's
    // agent-class signal — the other half, since the roster-class upgrade,
    // is the fold's `classes` — and the room send path reads
    // the union back to drop an unaddressed agent's leg.
    ...(env.ai === true ? { ai: true } : {}),
  };
}
