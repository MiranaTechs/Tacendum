import React, { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  applyGroupDel,
  applyRosterWrite,
  applySettingsWrite,
  effectiveDisappearSec,
  foldRoster,
  ownerOnlyPolicy,
  unconditionalPolicy,
  verdictFor,
  GROUP_MAX_MEMBERS,
} from '@tacendum/shared/group-fold';
import { DISAPPEAR, DISAPPEAR_OPTIONS, disappearLabel } from '../blocking';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { messaging } from '../messaging';
import { personName, sanitizeDisplayName, shortId } from '../person';
import {
  SAFETY_COPY,
  SAFETY_STATUS,
  safetyStateFor,
  type SafetyState,
} from '../safety';
import { AGENT_COPY, AI_DISCLOSURE_SENTENCE } from '../machine';
import { useTheme } from '../theme';
import { AgentBadge } from '../ui/AgentBadge';
import { Avatar } from '../ui/Avatar';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  InlineError,
  OutlineButton,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { RoomMark } from '../ui/RoomMark';
import { useCoalescedSubscribe } from '../ui/useCoalescedSubscribe';

interface Props {
  groupId: string;
  me: db.ProfileRow;
  onBack: () => void;
  /** Open one member's profile — their safety number and block control live
   * there. Optional like the thread's onStartCall: absent, rows inform. */
  onOpenMember?: (peerId: string) => void;
  /** The room is gone from this device (local delete, or delete for
   * everyone). The thread behind this screen no longer exists. */
  onRoomGone?: () => void;
}

/**
 * The room summary takes the WORST member state, under
 * safety.ts's precedence for the alarming states — changed > mismatched >
 * none — with ONE deliberate inversion at the bottom: `unchecked` outranks
 * `matched` here, although safety.ts ranks them the other way around for a
 * single conversation. That inversion is the rule itself: a summary
 * that read as all-checked while one member was unchecked would be the
 * "verified room" badge this section exists to make impossible. `matched` is
 * reachable only when EVERY member is matched.
 */
export function worstSafetyState(
  states: readonly SafetyState[],
): SafetyState {
  const severity: readonly SafetyState[] = [
    'changed',
    'mismatched',
    'none',
    'unchecked',
    'matched',
  ];
  for (const state of severity) {
    if (states.includes(state)) return state;
  }
  // An empty room summarises as "nothing has been checked", never as matched.
  return 'unchecked';
}

/** The summary sentence per worst state. None of these may ever say
 * "verified" — a safety number is between two people. */
export const ROOM_SAFETY_SUMMARY: Record<SafetyState, string> = {
  changed:
    'Someone’s safety number changed. Nothing sends to them until you review it.',
  // A roster finding, not a pair state — the
  // room's per-pair summary never mints it today, but the record must stay
  // total so the new state cannot render as a missing sentence.
  deviceAdded: 'Someone here added a device. Its safety number is new.',
  mismatched: 'A safety number here didn’t match when it was compared.',
  none: 'You don’t have a safety number with everyone here yet.',
  unchecked: 'You haven’t checked everyone here yet.',
  matched: 'You’ve compared safety numbers with everyone in this room.',
};

/** People-facing copy. The quoted sentences are contractual: the honest-limit
 * pair, the block residual, and the timer
 * line are design-verbatim, and the delete-for-everyone confirm body
 * cannot promise more, because
 * someone who already has the messages can keep them. Where the designed
 * sentence says "phone" for a device this copy cannot see, the device-noun
 * pass renders "device"; the substance is verbatim. */
export const ROOM_COPY = {
  title: 'Room',
  people: (n: number) => (n === 1 ? 'Just you' : `${n} people`),
  runBy: (name: string) => `${name} runs this room.`,
  youRunIt: 'You run this room.',
  ownerBadge: 'Runs this room',
  youBadge: 'You',

  membersTitle: 'Members',
  memberRowLabel: (name: string, state: string) => `${name}. ${state}`,

  /** The share-history offer. Sharing NOTHING is
   * the effortless path: it is the first action, it needs no decision, and
   * dismissing the panel shares nothing. Rule 2 — sharing is a deliberate act
   * with a stated extent, never a consequence of adding someone. */
  shareTitle: (name: string) => `Send ${name} some of what was said before?`,
  /** Says the cost plainly, because the people whose words move cannot be
   * asked. No ⓘ: this is a warning, not teaching copy. */
  shareBody:
    'They can’t see anything from before you added them unless you send it. Everyone in the room will see that you did, and what you chose.',
  shareNone: 'Send nothing',
  shareSome: 'Send the last 50',
  shareMore: 'Send the last 200',
  shareDone: (n: number, name: string) =>
    n === 1 ? `Sent 1 message to ${name}.` : `Sent ${n} messages to ${name}.`,
  shareEmpty: 'There was nothing left to send — messages already gone stay gone.',

  rosterInfoLabel: 'Who can change this room',
  honestLimit:
    'Only the person who runs this room can add or remove people. Anyone can leave whenever they like.',
  honestLimitInfo:
    'Removing someone tells everyone’s device to stop sending to them. It can’t stop their device from sending to yours — blocking is what does that.',
  noReadReceipts: 'Rooms don’t send read receipts.',

  safetyInfoLabel: 'Why there is no room number',
  safetyInfo:
    'A safety number is between two people, so a room can never have one and there is no such thing as a room that checks out as a whole. Open each person to compare yours with theirs.',

  add: 'Add someone',
  addNobody: 'Everyone you talk to is already here.',
  addFull: (max: number) =>
    `This room is full — it holds ${max} people at most.`,
  remove: 'Remove',
  /** The inline confirm: a Remove is as social and as
   * announced as Leave — everyone's device is told, the removed person's
   * included — so it asks the way Leave and both deletes do. Add
   * afterwards is a fresh invitation, never a restore,
   * and the body says so. */
  removeConfirmTitle: (name: string) => `Remove ${name} from this room?`,
  removeConfirmBody: 'Everyone’s device is told to stop sending to them, theirs included. Adding them again sends a new invitation — it doesn’t bring back what they missed.',
  removeConfirm: 'Remove',
  removeFailed: 'Tacendum couldn’t change that. Try again.',

  leave: 'Leave this room',
  leaveConfirmTitle: 'Leave this room?',
  // The device is named in the platform's
  // own words via the token, here and in the five room-copy strings below.
  leaveConfirmBody: `Your ${DEVICE_NOUN} stops sending here and the others see that you left. The room stays on this ${DEVICE_NOUN} until you delete it — and if you’re invited back, it arrives as an invitation only you can accept.`,
  leaveConfirm: 'Leave',
  cancel: 'Cancel',
  leftAnnounce: 'You left this room.',

  deleteLocal: 'Delete room',
  deleteLocalInfoLabel: 'What deleting here does',
  deleteLocalInfo: `This deletes the room from this ${DEVICE_NOUN} only — nobody else is told, and you don’t have to leave first. If the room stays alive and you’re still in it, it comes back with its next message.`,
  deleteLocalConfirmTitle: `Delete this room from this ${DEVICE_NOUN}?`,
  deleteLocalConfirm: 'Delete',

  deleteEveryone: 'Delete for everyone',
  deleteEveryoneConfirmTitle: 'Delete this room for everyone?',
  /** The confirm copy, noun-neutralized. */
  deleteEveryoneConfirmBody:
    'Deletes this room from everyone’s device. People keep anything they already saved, and a device that stays offline longer than a month keeps its copy.',
  deleteEveryoneConfirm: 'Delete for everyone',

  timerTitle: 'Disappearing messages',
  /** verbatim. */
  timerRule:
    'Anyone in this room can make messages disappear sooner. Nobody can make them last longer for anyone else.',
  timerStatus: (label: string) =>
    `Messages here disappear after ${label.toLowerCase()}.`,
  timerOff: 'Messages here stay until someone deletes them.',
  timerYours: 'Your own timer. The room uses the shortest one anyone set.',
  /**
   * Why the chips are off once you have left: a disabled control must
   * say so, in words, not merely refuse the tap. */
  timerLeft: 'You’re no longer in this room, so its timer isn’t yours to set.',

  blockTitle: 'Blocking',
  blockLead:
    'Blocking is per person, not per room. Open someone’s profile to block them — a room that contains someone you blocked goes read-only for you.',
  blockInfoLabel: 'What a block can’t do here',
  /** The residual, verbatim. */
  blockResidual:
    'A block can’t make you invisible in a shared room. Other people quote you and react to you, and they read their copies.',

  failed: 'Tacendum couldn’t do that. Try again.',
  /** The apply stood, the fan-out did not (a relock or a database refusal
   * between them). "Couldn't do that" would be a lie — it DID happen on this
   * device — so this says what is true and how to repair it: redoing the
   * change is a fresh write in the same lane, which applies and sends. */
  sendFailed: `That change was made on this ${DEVICE_NOUN} but couldn’t be sent to the room. Make the change again so everyone gets it.`,
  /** Same split for Delete for everyone, where there is no redo: the room —
   * roster included — is already gone from this device, so the delete
   * cannot be recomposed. Best-effort was already the button's promise. */
  deleteSendFailed: `The room is gone from this ${DEVICE_NOUN}, but the delete couldn’t be sent — other people’s devices keep the room.`,

  /** The member-consent surface. Teaching sits
   * behind the ⓘ; the honest limits are load-bearing and stated plainly, not
   * paraphrased — "refusal gates delivery, not display" and "the room is
   * told" are the two facts the rule turns on. */
  consentTitle: 'Sharing with agents',
  consentLead:
    'An agent in a room only hears the people who choose to share with it. This is your choice, and every person here can see it.',
  /** The disclosure sentence, QUOTED — the surface this
   * screen gained. The original wording assumed adoption was the only permission-first moment;
   * a non-owner human never adopts anything, so THIS is theirs: the instant
   * they decide to let someone else's agent hear them. Rendered above the
   * Share action, never beside the outcome. */
  consentDisclosure: AI_DISCLOSURE_SENTENCE,
  consentInfoLabel: 'What sharing does',
  consentInfo: [
    'Sharing lets this agent send and receive your messages in this room. Not sharing means it never hears you and you never see its messages here — the server enforces that, it isn’t just hidden on your screen.',
    'Every person in the room is told your choice, because whether the agent can hear you is something they deserve to know before they type. When you stop sharing, the agent itself learns when the server refuses its next frame.',
    'You can change your mind any time. Changing it here tells the room again.',
    // The limit the disclosure sentence would otherwise imply away:
    // the provider side belongs to whoever runs
    // the agent, and this screen must not characterise it.
    'Once your words reach that machine, what happens to them is between whoever runs the agent and their AI provider. We don’t see that and can’t speak for it.',
  ],
  consentShared:
    'You’re sharing. This agent can send and receive your messages here.',
  consentRefused:
    'You’re not sharing. This agent can’t hear you, and you won’t see its messages here.',
  consentUndecided:
    'You haven’t chosen yet. Until you share, this agent can’t hear you and you won’t see its messages here.',
  consentShare: 'Share',
  consentStopSharing: 'Don’t share',
  /** Surfaced from THIS device's own count of what it has shared, never from
   * the server (the route answers the same whether an edge stored or was
   * dropped over the cap, and there is no route to ask). Hedged on purpose. */
  consentCap:
    'You may have reached your sharing limit — your newest choice might not have taken. Stop sharing with an agent you no longer need, then try again.',
  /** The edge stood and this device recorded it; only the room wasn’t told
   * (a blocked member makes a room read-only, or a leg didn’t send). */
  consentNotAnnounced: `Saved on this ${DEVICE_NOUN}. The room couldn’t be told just now — make the change again so everyone sees it.`,
  /** Revoke-first fork: the edge is already gone and local state is refused;
   * only the best-effort human announcement failed. */
  consentHoldNotAnnounced:
    'Sharing stopped, but the people in the room couldn’t be told. Try again so they see it.',
  /** The DELETE itself failed. Revoke-first means no local refusal and no
   * announcement happened. The prior state may be consented OR undecided,
   * so this must not claim either that the room was told or that sharing was
   * known to be active. */
  consentHoldFailed:
    'That sharing change didn’t take. Nothing changed or was announced. Try again.',
} as const;

/** Which inline question is open. Remove carries the member it is about, so
 * two Remove controls can never share one open question. */
type Confirming =
  | 'none'
  | 'leave'
  | 'deleteLocal'
  | 'deleteEveryone'
  | { kind: 'remove'; id: string };

/**
 * A room's roster surface: the member list with
 * per-member safety state, the worst-state summary, the named owner, the
 * owner-only Add/Remove, Leave for everyone, both deletes, the timer, and
 * the block explainer's group variant.
 *
 * There is deliberately NO Hand over control, NO frozen banner and NO
 * owner-liveness indicator of any kind (simplified deliberately): an absent
 * owner is not a state this product models — the room carries on, and only
 * add/remove stop happening, because the one writer they count from has
 * stopped writing. Tests assert the absence; a control growing back here is
 * deleted machinery returning.
 *
 * THE WIRE SEAM, stated rather than implied: every roster/settings action
 * here runs the SHARED APPLY LAYER ("transitions in the shared apply
 * layer, not screen handlers") against this phone's own store, handed as the
 * closure to `messaging.fanOutMembership`, which gates it (block before
 * apply), applies it, and then writes the exact wire envelope as the
 * thread's announcement row together with one outbox leg per folded member
 * in one transaction. The screen composes the envelope and the apply; the
 * seam owns the row, the legs, the ledger and the pacing.
 */
export function GroupProfileScreen({
  groupId,
  me,
  onBack,
  onOpenMember,
  onRoomGone,
}: Props) {
  const t = useTheme();
  const [group, setGroup] = useState<db.GroupRow | null>(null);
  const [chat, setChat] = useState<db.ChatRow | null>(null);
  const [slots, setSlots] = useState<db.GroupMemberSlotRow[]>([]);
  const [settings, setSettings] = useState<db.GroupSettingsSlotRow[]>([]);
  const [chats, setChats] = useState<Map<string, db.ChatRow>>(new Map());
  /** The machine record: members the server confirmed as this
   * account's machines, for the roster attribution. */
  const [machines, setMachines] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The marker half of "the roster signal the badge uses":
   * room members from whom this phone has received an AI-marked
   * message. This is how a NON-owner — whose `machines` never names someone
   * else's agent — still learns a member is an agent once it has spoken, so
   * the consent choice can be offered to the very person it is for. Local and
   * marker-derived: it never asks the server anything. */
  const [markerAgents, setMarkerAgents] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** This user's own consent decision per agent member — 'undecided' until made. */
  const [consentStates, setConsentStates] = useState<
    Map<string, db.AgentConsentState>
  >(new Map());
  /** The agent whose consent write is in flight, so its buttons disable. */
  const [consentBusy, setConsentBusy] = useState<string | null>(null);
  /** The one advisory line after a decision — the cap surface (from local
   * count alone) or the room-not-told note. Never an error the decision took. */
  const [consentNote, setConsentNote] = useState<string | null>(null);
  /** memberId -> safety number, null while none exists. */
  const [numbers, setNumbers] = useState<Map<string, string | null>>(new Map());
  const [confirming, setConfirming] = useState<Confirming>('none');
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** Who was just added and is being offered history, or null. Cleared by
   * every exit including "Send nothing", so the offer cannot linger and be
   * answered later against a roster that has moved on. */
  const [sharePrompt, setSharePrompt] = useState<string | null>(null);
  /** The outcome of a share, stated rather than assumed. */
  const [shared, setShared] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      const [g, c, s, cfg, all, machineIds, markerIds] = await Promise.all([
        db.getGroup(groupId),
        db.getChat(groupId),
        db.listGroupMemberSlots(groupId),
        db.listGroupSettingsSlots(groupId),
        db.listChats(),
        // The machine record: which members are this account's
        // machines, for the roster attribution. Server-confirmed answers
        // only — see machine.ts for the rule.
        db.listMachinePeers(),
        // The marker-derived agent authors in THIS room: who has sent
        // an AI-marked message here. Lifts "marker-OR-record" to the roster
        // so a second human can be offered the consent choice about an agent they
        // do not own. Local — never a server query.
        db.listRoomAgentAuthorIds(groupId),
      ]);
      setGroup(g);
      setChat(c);
      setSlots(s);
      setSettings(cfg);
      setChats(new Map(all.map(row => [row.peerId, row])));
      setMachines(new Set(machineIds));
      setMarkerAgents(new Set(markerIds));
    })().catch(() => {});
  }, [groupId]);

  // ONE coalesced re-read per notify burst: subscribed raw, every receipt,
  // frame and socket transition re-ran the seven reads above while a
  // backlog drained.
  useCoalescedSubscribe(refresh);

  const fold = group
    ? foldRoster(group.ownerId, slots, ownerOnlyPolicy)
    : null;
  const members = fold ? [...fold.members] : [];
  const isOwner = group !== null && group.ownerId === me.userId;
  const amIn = fold !== null && verdictFor(fold, me.userId) === 'in';
  const others = members.filter(id => id !== me.userId);
  /** The ROSTER-WRITE class: the room owner's
   * authoritative slot named this member a machine. The third signal beside
   * `machines` and `markerAgents`, and the one that reaches a stranger's
   * phone BEFORE the agent has ever spoken — the consent-bootstrap fix. */
  const rosterAgent = (id: string): boolean =>
    fold?.classes[id] === 'integration';
  /** The attribution for an agent row — each form says only what its signal
   * can honestly carry:
   *  - machine_peers → second person ("your AI agent"), the covered case;
   *  - ROSTER-CLASSED → owner-named ("Claude — Ana's AI agent"): the class is
   *    the OWNER's claim (the fold's authority writer), so the owner is named
   *    as the claimant. When that claimant is this account, second person
   *    again — "You’s AI agent" is a sentence nobody wrote — and a peer
   *    display-named "You"/"them" cannot forge the self signal in the
   *    possessive (ChatThreadScreen's nameFor rule): the short id takes the
   *    slot instead;
   *  - MARKER-only → neutral ("AI agent (self-labeled)"): the set admitted it
   *    from its OWN marked speech; the owner claimed nothing, so nobody
   *    else is named. */
  const agentAttributed = (id: string, name: string): string => {
    if (machines.has(id)) return AGENT_COPY.attributed(name);
    if (group !== null && rosterAgent(id)) {
      if (group.ownerId === me.userId) return AGENT_COPY.attributed(name);
      const label = nameFor(group.ownerId);
      const owner = /^(you|them)$/i.test(label.trim())
        ? shortId(group.ownerId)
        : label;
      return AGENT_COPY.foreignAttributed(name, owner);
    }
    return AGENT_COPY.selfLabeled(name);
  };

  // Per-member safety numbers, so `none` versus `unchecked` is honest. Keyed
  // on the joined ids so a roster change reloads exactly once.
  const othersKey = others.join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      const next = new Map<string, string | null>();
      for (const id of othersKey === '' ? [] : othersKey.split(',')) {
        next.set(
          id,
          await messaging.getSafetyNumber(id).catch(() => null),
        );
      }
      if (live) setNumbers(next);
    })();
    return () => {
      live = false;
    };
  }, [othersKey]);

  // The agent members this consent surface offers a CHOICE about: an agent this
  // phone can NAME — the roster class (`rosterAgent`, the owner's
  // authoritative write) OR the marker (`markerAgents` —
  // it has sent an AI-marked message here) — that this account does NOT own
  // (`!machines`). The class half is THE consent-bootstrap fix: a runtime
  // test proved the marker alone could never reach a second human (the
  // agent's pre-consent frames are refused, correctly, so no ai row can
  // exist), leaving this surface unreachable for its entire intended
  // audience. The choice now appears the moment the stranger opens the room,
  // BEFORE the agent speaks. This account's OWN agent (`machines` — the
  // machine_peers this phone paired) is admitted by the owner clause
  // unconditionally and needs no edge, so offering it a share /
  // don't-share choice would be a lie: "Share" burns a cap slot on a row no
  // predicate reads, and "Don't share" announces a hold the delivery never
  // honours. `machines` still feeds row attribution/badges below — just never
  // the choice. Self is never an agent.
  const agentMembers = members.filter(
    id =>
      id !== me.userId &&
      (rosterAgent(id) || markerAgents.has(id)) &&
      !machines.has(id),
  );

  // This user's own decision per agent member, reloaded when the set changes.
  const agentKey = agentMembers.join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      const next = new Map<string, db.AgentConsentState>();
      for (const id of agentKey === '' ? [] : agentKey.split(',')) {
        next.set(id, await db.getAgentConsent(id).catch(() => 'undecided' as const));
      }
      if (live) setConsentStates(next);
    })();
    return () => {
      live = false;
    };
  }, [agentKey]);

  /**
   * Make (or change) the consent decision about one agent. `messaging.setRoomConsent`
   * writes the global edge (share) or deletes it (hold), records this client's
   * own act locally, and announces the state into the room — see its doc
   * comment for the ruled order. The busy row covers the whole call. There is
   * deliberately no UI-only deadline: setRoomConsent's REST/prekey work is
   * not cancellable, so Promise.race would re-enable the actions while an
   * abandoned privacy mutation could still finish and race the retry. A real
   * bound requires abort + generation ownership inside messaging/API; until
   * then a stalled dependency can keep this row busy. Outcomes stay exact:
   * DELETE failure means nothing changed; announcement failure after DELETE
   * means sharing stopped but the humans were not told.
   */
  const decideConsent = (agentId: string, share: boolean) => {
    setConsentBusy(agentId);
    setConsentNote(null);
    void (async () => {
      try {
        const { atCap, announced } = await messaging.setRoomConsent(
          groupId,
          agentId,
          share,
        );
        if (share && atCap) setConsentNote(ROOM_COPY.consentCap);
        else if (!announced) {
          setConsentNote(
            share
              ? ROOM_COPY.consentNotAnnounced
              : ROOM_COPY.consentHoldNotAnnounced,
          );
        }
      } catch {
        setConsentNote(share ? ROOM_COPY.failed : ROOM_COPY.consentHoldFailed);
      } finally {
        setConsentBusy(null);
        // Reload this agent's decision without waiting on the set-keyed effect
        // (the member set has not changed, so that effect will not re-run).
        void db
          .getAgentConsent(agentId)
          .then(s => setConsentStates(prev => new Map(prev).set(agentId, s)))
          .catch(() => {});
      }
    })();
  };

  const nameFor = useCallback(
    (id: string): string => {
      if (id === me.userId) return 'You';
      const row = chats.get(id);
      return personName(id, row?.displayName, row?.localName);
    },
    [chats, me.userId],
  );

  const stateFor = useCallback(
    (id: string): SafetyState =>
      safetyStateFor({
        blocked: messaging.isPeerBlocked(id),
        safety: numbers.get(id) ?? null,
        checkedAt: chats.get(id)?.safetyCheckedAt ?? null,
        mismatchAt: chats.get(id)?.safetyMismatchAt ?? null,
      }),
    [chats, numbers],
  );

  const memberStates = others.map(stateFor);
  const summaryState = worstSafetyState(memberStates);
  const summaryTone = SAFETY_STATUS[summaryState];

  // The anchor's name is peer-chosen free text like a card: sanitized
  // per layer, so a name that is nothing but marks falls to the noun.
  const roomName =
    sanitizeDisplayName(chat?.localName) ||
    sanitizeDisplayName(group?.name) ||
    'This room';
  const ownerName = group ? nameFor(group.ownerId) : '';

  /** A destructive or roster write must fail loudly, never silently — the
   * peer profile's block-write contract, not its note-keeping one. */
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(null);
    void (async () => {
      try {
        await work();
      } catch {
        setFailed(ROOM_COPY.failed);
      } finally {
        setBusy(false);
        refresh();
      }
    })();
  };

  /**
   * One roster transition: `fanOutMembership` runs its gates (block above
   * everything, BEFORE the apply — a write it refuses must not fork this
   * phone's roster from everyone else's), then the shared apply layer
   * against this phone's store via the closure, then writes the thread's
   * announcement row — direction 'out', MY authenticated id as authorId —
   * together with one outbox leg per folded member in ONE transaction. A
   * declined or stale apply returns false and nothing is announced or sent
   * (messaging:2370's rule, unchanged).
   *
   * WHEN THE APPLY SUCCEEDS AND THE SEND STILL FAILS, the user is told, in
   * two different shapes because the truths differ:
   *  - a PER-MEMBER failure never throws — it settles as a failed ledger
   *    leg behind the announcement row, and the thread screen renders the
   *    ledger's "Not delivered to N of M" line for BOTH row shapes: under
   *    a room out-bubble, and as the compact danger line inside the
   *    announcement's own event row (the batched `listFanoutFailures`
   *    read — this prose twice claimed a surface before it existed;
   *    a roster announcement is an EVENT row, and the event-row branch now
   *    renders the notice, testID `fanout-notice-*`). An identity-change
   *    skip raises the room banner naming them;
   *  - the whole enqueue failing (a relock mid-action, a database refusal)
   *    throws AFTER the local change stood, so the generic "couldn't do
   *    that" would be a lie — ROOM_COPY.sendFailed says exactly what
   *    happened and that redoing the change re-sends it (a redo is a fresh
   *    seq in the same lane: it applies and fans again).
   */
  const writeRoster = async (memberId: string, state: 'in' | 'out') => {
    const seq = await db.reserveGroupSeq(groupId, 'writer');
    // THE CLASS CLAIM, owner-only: an OWNER's add of a
    // member their own machine record names carries `c: 'integration'`, so
    // the other members' devices — a future stranger's included — can offer
    // the consent choice before the agent ever speaks. Never emitted by a
    // non-owner (their lane never counts, and the class is the owner's
    // statement or nobody's); never guessed — machine_peers is the server's
    // own answers, and a member it cannot name simply gets no field.
    const classed =
      isOwner &&
      state === 'in' &&
      (await db.listMachinePeers().catch(() => [] as string[])).includes(
        memberId,
      );
    const cls = classed ? { c: 'integration' as const } : {};
    let appliedLocally = false;
    try {
      await messaging.fanOutMembership(
        groupId,
        { tcm: 'grp.roster', g: groupId, m: memberId, s: state, n: seq, ...cls },
        {
          apply: async () => {
            const store = await db.loadGroupStore(groupId);
            const applied = applyRosterWrite(
              store,
              me.userId,
              {
                writerId: me.userId,
                memberId,
                seq,
                state,
                ...(classed ? { class: 'integration' as const } : {}),
              },
              ownerOnlyPolicy,
            );
            await store.persist();
            appliedLocally = applied.outcome === 'applied';
            return appliedLocally;
          },
        },
      );
    } catch (err) {
      if (appliedLocally) {
        setFailed(ROOM_COPY.sendFailed);
        return;
      }
      throw err;
    }
  };

  const leave = () =>
    run(async () => {
      await writeRoster(me.userId, 'out');
      setConfirming('none');
      AccessibilityInfo.announceForAccessibilityWithOptions(
        ROOM_COPY.leftAnnounce,
        { queue: true },
      );
    });

  const removeMember = (memberId: string) =>
    run(async () => {
      await writeRoster(memberId, 'out');
      // Only a write that stood closes the question (Leave's own posture):
      // a failure leaves it open beside the error, so the person can retry
      // or step back without re-finding the row.
      setConfirming('none');
    });

  const addMember = (memberId: string) =>
    run(async () => {
      if (members.length >= GROUP_MAX_MEMBERS) {
        setFailed(ROOM_COPY.addFull(GROUP_MAX_MEMBERS));
        return;
      }
      await writeRoster(memberId, 'in');
      setAdding(false);
      // Only AFTER the add lands, so the offer never implies a membership
      // write that failed.
      //
      // The `isOwner` test is belt-and-braces and is UNREACHABLE today: the
      // Add affordance is itself owner-only, so a non-owner never arrives
      // here. Stated because a mutation deleting it survives the suite, and a
      // surviving mutation with no explanation reads as an untested rule. The
      // enforcement point is `messaging.shareHistory`, which refuses a
      // non-owner outright and IS tested — a screen is not a security
      // boundary.
      if (isOwner) setSharePrompt(memberId);
    });

  /**
   * Relay history to someone just added (a stated extent, chosen).
   * Failure is reported, never swallowed: the room has already been told the
   * share was happening, so a silent stall would leave everyone believing the
   * newcomer can see words they cannot.
   */
  const shareHistory = (memberId: string, extent: number) =>
    run(async () => {
      setSharePrompt(null);
      const result = await messaging.shareHistory(groupId, memberId, extent);
      setShared(
        result.shared === 0
          ? ROOM_COPY.shareEmpty
          : ROOM_COPY.shareDone(result.shared, nameFor(memberId)),
      );
    });

  const openAdd = () =>
    run(async () => {
      const all = await db.listChats();
      const ids: string[] = [];
      for (const row of all) {
        if (row.peerId === groupId) continue;
        if (members.includes(row.peerId)) continue;
        // A person, not a room: rooms have an anchor, people never do.
        if ((await db.getGroup(row.peerId)) !== null) continue;
        ids.push(row.peerId);
      }
      setCandidates(ids);
      setAdding(true);
    });

  const deleteLocal = () =>
    run(async () => {
      // deleteChat's precedent exactly: the conversation goes, the
      // anchor and slots stay, so the room can return on its next message.
      await db.deleteGroup(groupId);
      setConfirming('none');
      onRoomGone?.();
    });

  const deleteEveryone = () =>
    run(async () => {
      // The owner's own counted grp.del through the shared apply layer:
      // 'purged' clears the store, and persist() runs the full purge —
      // anchor, slots, counters, conversation — and never the blocks.
      // The send rides fanOutMembership, which snapshots the folded
      // membership BEFORE the closure purges it and parents the legs outside
      // the room, so the purge cannot eat the very frames announcing it. A
      // counted grp.del renders nothing locally, so there is no
      // announcement row and no thread ledger to point at — which is why a
      // send failure here gets its own copy: the room is gone from this
      // device either way, and pretending otherwise would be worse.
      const seq = await db.reserveGroupSeq(groupId, 'writer');
      let purged = false;
      try {
        await messaging.fanOutMembership(
          groupId,
          { tcm: 'grp.del', g: groupId, n: seq },
          {
            apply: async () => {
              const store = await db.loadGroupStore(groupId);
              const result = applyGroupDel(store, {
                writerId: me.userId,
                seq,
              });
              if (result !== 'purged') return false;
              await store.persist();
              purged = true;
              return true;
            },
          },
        );
      } catch (err) {
        if (purged) {
          setFailed(ROOM_COPY.deleteSendFailed);
          setConfirming('none');
          onRoomGone?.();
          return;
        }
        throw err;
      }
      if (!purged) {
        setFailed(ROOM_COPY.failed);
        return;
      }
      setConfirming('none');
      onRoomGone?.();
    });

  const mySlotSeconds =
    settings.find(s => s.writerId === me.userId)?.disappearSec ?? 0;
  const effectiveSeconds = fold
    ? effectiveDisappearSec(settings, fold, unconditionalPolicy)
    : 0;
  const effectiveLabel = disappearLabel(effectiveSeconds);

  const setTimer = (seconds: number) =>
    run(async () => {
      // Announced only when actually applied — messaging.ts:2370's rule —
      // which is exactly what the closure returning false enforces. The same
      // apply-succeeded-but-send-failed split as writeRoster.
      const seq = await db.reserveGroupSeq(groupId, 'writer');
      let appliedLocally = false;
      try {
        await messaging.fanOutMembership(
          groupId,
          { tcm: 'grp.set', g: groupId, s: seconds, n: seq },
          {
            apply: async () => {
              const store = await db.loadGroupStore(groupId);
              const applied = applySettingsWrite(
                store,
                { writerId: me.userId, seq, disappearSec: seconds },
                unconditionalPolicy,
              );
              await store.persist();
              appliedLocally = applied === 'applied';
              return appliedLocally;
            },
          },
        );
      } catch (err) {
        if (appliedLocally) {
          setFailed(ROOM_COPY.sendFailed);
          return;
        }
        throw err;
      }
    });

  // Owner first, then me, then everyone else by label — the owner is roster
  // state, so the roster surface is where they are named.
  const ordered = [...members].sort((a, b) => {
    const rank = (id: string) =>
      id === group?.ownerId ? 0 : id === me.userId ? 1 : 2;
    return rank(a) - rank(b) || nameFor(a).localeCompare(nameFor(b));
  });

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader
        title={ROOM_COPY.title}
        onBack={onBack}
        backLabel="Back"
        testIDBack="group-profile-back"
        right={<View style={styles.headerSpacer} />}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: t.layout.gutter },
        ]}
      >
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          <View style={styles.hero}>
            {/* THE room signal at hero size: a person is a
                circle, a room is a walled square — the same mark the chat
                list row and the thread header draw, so the identity does
                not flip between the list and the one screen that is about
                the room. Hidden from VoiceOver like the disc it replaces:
                the name beneath it, and the header's "Room", carry the
                words. */}
            <RoomMark
              roomId={groupId}
              name={roomName}
              size={t.layout.avatar.hero}
              monogramSize={t.type.screenTitle.fontSize}
              testID="room-hero-mark"
            />
            <Text
              numberOfLines={2}
              style={[
                t.type.screenTitle,
                styles.heroName,
                { color: t.color.inkStrong },
              ]}
              testID="room-name"
            >
              {roomName}
            </Text>
            <Text
              style={[t.type.compactBody, styles.heroLine, { color: t.color.inkMuted }]}
            >
              {ROOM_COPY.people(members.length)}
            </Text>
            {group ? (
              <Text
                style={[
                  t.type.compactBody,
                  styles.heroLine,
                  { color: t.color.inkBody },
                ]}
                testID="room-owner-line"
              >
                {isOwner ? ROOM_COPY.youRunIt : ROOM_COPY.runBy(ownerName)}
              </Text>
            ) : null}
          </View>

          {/* Members: summary first, then each person with their own state.
              The ⓘ explains who can use Add and Remove — shown to EVERYONE,
              because a control that silently fails for non-owners would be
              the worst of both models. */}
          <View style={styles.section}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {ROOM_COPY.membersTitle}
            </Text>

            {others.length > 0 ? (
              <View style={styles.statusRow}>
                <View
                  style={[
                    styles.statusRule,
                    { backgroundColor: t.color[summaryTone.rule] },
                  ]}
                />
                <Text
                  style={[
                    t.type.compactBody,
                    { flexShrink: 1, color: t.color[summaryTone.ink] },
                  ]}
                  testID={`room-safety-summary-${summaryState}`}
                >
                  {ROOM_SAFETY_SUMMARY[summaryState]}
                </Text>
              </View>
            ) : null}

            {ordered.map(id => {
              const isMe = id === me.userId;
              const state = isMe ? null : stateFor(id);
              const tone = state ? SAFETY_STATUS[state] : null;
              const stateLabel = state ? SAFETY_COPY[state].label : '';
              const removing =
                typeof confirming === 'object' &&
                confirming.kind === 'remove' &&
                confirming.id === id;
              return (
                <React.Fragment key={id}>
                <View style={styles.memberRow} testID={`member-${id}`}>
                  <Pressable
                    onPress={
                      !isMe && onOpenMember ? () => onOpenMember(id) : undefined
                    }
                    disabled={isMe || !onOpenMember}
                    testID={`member-open-${id}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isMe
                        ? 'You'
                        : ROOM_COPY.memberRowLabel(
                            // The attribution rides the spoken name:
                            // "Claude · laptop — your AI agent. Not checked
                            // yet" — derived from the id in the machine
                            // record OR the fold's roster class (owner-named
                            // for a foreign agent),
                            // never from the name's own shape.
                            machines.has(id) || rosterAgent(id)
                              ? agentAttributed(id, nameFor(id))
                              : nameFor(id),
                            stateLabel,
                          )
                    }
                    style={({ pressed }) => [
                      styles.memberBody,
                      { borderRadius: t.radius.button },
                      pressed && { backgroundColor: t.color.pineWash },
                    ]}
                  >
                    <Avatar
                      peerId={id}
                      displayName={
                        isMe
                          ? me.displayName
                          : chats.get(id)?.localName ||
                            chats.get(id)?.displayName ||
                            null
                      }
                      photoB64={isMe ? me.avatarB64 : chats.get(id)?.avatarB64}
                      size={t.layout.avatar.header}
                    />
                    <View style={styles.memberText}>
                      <View style={styles.memberNameRow}>
                        <Text
                          numberOfLines={1}
                          style={[t.type.rowTitle, { flexShrink: 1, color: t.color.inkStrong }]}
                        >
                          {nameFor(id)}
                        </Text>
                        {id === group?.ownerId ? (
                          <Text
                            style={[
                              t.type.utilityLabel,
                              styles.ownerBadge,
                              {
                                color: t.color.pine,
                                borderColor: t.color.pineLine,
                                borderRadius: t.radius.small,
                              },
                            ]}
                            testID={`owner-badge-${id}`}
                          >
                            {ROOM_COPY.ownerBadge}
                          </Text>
                        ) : null}
                        {machines.has(id) || rosterAgent(id) ? (
                          // The roster attribution (widened by the
                          // roster-class rule): the stored name
                          // stays the name; the tag says what it is. From
                          // the machine record OR the fold's authority-lane
                          // class and the id alone — a member whose DISPLAY
                          // NAME merely looks agent-shaped gets no tag. The
                          // second-person label stays reserved for machines
                          // this account itself paired.
                          <AgentBadge
                            label={
                              machines.has(id)
                                ? AGENT_COPY.rosterBadge
                                : AGENT_COPY.foreignRosterBadge
                            }
                            testID={`agent-badge-${id}`}
                          />
                        ) : null}
                      </View>
                      {!isMe && tone ? (
                        <Text
                          style={[
                            t.type.timeStatus,
                            { color: t.color[tone.ink] },
                          ]}
                          testID={`member-state-${id}`}
                        >
                          {stateLabel}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  {isOwner && !isMe ? (
                    <TextAction
                      label={ROOM_COPY.remove}
                      onPress={() => setConfirming({ kind: 'remove', id })}
                      disabled={busy || removing}
                      testID={`member-remove-${id}`}
                    />
                  ) : null}
                </View>
                {/* The Remove question, in Leave's inline shape,
                    under the row it is about. Only the confirm writes the
                    roster; the first tap opened this and nothing else. */}
                {removing ? (
                  <View
                    style={styles.removeConfirm}
                    testID={`member-remove-question-${id}`}
                  >
                    <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                      {ROOM_COPY.removeConfirmTitle(nameFor(id))}
                    </Text>
                    <Text
                      style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                    >
                      {ROOM_COPY.removeConfirmBody}
                    </Text>
                    <View style={styles.confirmRow}>
                      <TextAction
                        label={ROOM_COPY.removeConfirm}
                        tone="danger"
                        onPress={() => removeMember(id)}
                        disabled={busy}
                        testID={`member-remove-confirm-${id}`}
                      />
                      <TextAction
                        label={ROOM_COPY.cancel}
                        onPress={() => setConfirming('none')}
                        disabled={busy}
                        testID={`member-remove-cancel-${id}`}
                      />
                    </View>
                  </View>
                ) : null}
                </React.Fragment>
              );
            })}

            {/* The share-history offer. Owner only,
                because only the owner can share; shown after the add lands,
                so it never implies a roster write that failed. Sending
                nothing is FIRST and needs no decision — sharing is the
                deliberate act, not the default. */}
            {sharePrompt !== null && isOwner ? (
              <View style={styles.addList} testID="room-share-prompt">
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {ROOM_COPY.shareTitle(nameFor(sharePrompt))}
                </Text>
                <Text
                  style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                >
                  {ROOM_COPY.shareBody}
                </Text>
                <View style={styles.confirmRow}>
                  <TextAction
                    label={ROOM_COPY.shareNone}
                    onPress={() => setSharePrompt(null)}
                    disabled={busy}
                    testID="room-share-none"
                  />
                  <TextAction
                    label={ROOM_COPY.shareSome}
                    onPress={() => shareHistory(sharePrompt, 50)}
                    disabled={busy}
                    testID="room-share-50"
                  />
                  <TextAction
                    label={ROOM_COPY.shareMore}
                    onPress={() => shareHistory(sharePrompt, 200)}
                    disabled={busy}
                    testID="room-share-200"
                  />
                </View>
              </View>
            ) : null}
            {shared !== null ? (
              <Text
                testID="room-share-result"
                style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
              >
                {shared}
              </Text>
            ) : null}

            {isOwner && amIn ? (
              !adding ? (
                <TextAction
                  label={ROOM_COPY.add}
                  onPress={openAdd}
                  disabled={busy}
                  testID="room-add"
                />
              ) : (
                <View style={styles.addList}>
                  {candidates.length === 0 ? (
                    <Text
                      style={[t.type.compactBody, { color: t.color.inkMuted }]}
                    >
                      {ROOM_COPY.addNobody}
                    </Text>
                  ) : (
                    candidates.map(id => (
                      <View key={id} style={styles.memberRow}>
                        <View style={styles.memberBody}>
                          <Avatar
                            peerId={id}
                            displayName={
                              chats.get(id)?.localName ||
                              chats.get(id)?.displayName ||
                              null
                            }
                            photoB64={chats.get(id)?.avatarB64}
                            size={t.layout.avatar.header}
                          />
                          <Text
                            numberOfLines={1}
                            style={[
                              t.type.rowTitle,
                              styles.memberText,
                              { color: t.color.inkStrong },
                            ]}
                          >
                            {nameFor(id)}
                          </Text>
                        </View>
                        <TextAction
                          label="Add"
                          onPress={() => addMember(id)}
                          disabled={busy}
                          testID={`room-add-${id}`}
                        />
                      </View>
                    ))
                  )}
                  <TextAction
                    label={ROOM_COPY.cancel}
                    onPress={() => setAdding(false)}
                    disabled={busy}
                    testID="room-add-cancel"
                  />
                </View>
              )
            ) : null}

            <InfoDisclosure
              label={ROOM_COPY.rosterInfoLabel}
              lines={[
                ROOM_COPY.honestLimit,
                ROOM_COPY.honestLimitInfo,
                // Teaching copy for the AI tag, only when the roster
                // actually wears one — the ⓘ teaches what is on screen. The
                // foreign variant teaches the
                // owner-added tag with the sanctioned consent sentence.
                ...(members.some(id => machines.has(id))
                  ? [AGENT_COPY.rosterInfo]
                  : []),
                ...(members.some(id => !machines.has(id) && rosterAgent(id))
                  ? [AGENT_COPY.foreignRosterInfo]
                  : []),
              ]}
              testID="room-roster-info"
            />
            <InfoDisclosure
              label={ROOM_COPY.safetyInfoLabel}
              lines={[ROOM_COPY.safetyInfo]}
              testID="room-safety-info"
            />
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
            >
              {ROOM_COPY.noReadReceipts}
            </Text>
          </View>

          {/* The member-consent surface. Shown ONLY when
              the room actually contains an agent this phone can name — the
              choice is meaningless otherwise, and the teaching ⓘ would be
              teaching about nothing. Each agent gets its own decision: share
              (write the global edge, let it hear you) or don't (delete it).
              The choice is announced to the room by messaging.setRoomConsent. */}
          {agentMembers.length > 0 ? (
            <View style={styles.section} testID="room-consent-section">
              <Text
                accessibilityRole="header"
                style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
              >
                {ROOM_COPY.consentTitle}
              </Text>
              <Text
                style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
              >
                {ROOM_COPY.consentLead}
              </Text>
              {/* The 5.1.2(i) sentence, above every Share button in the
                  section — permission first, for the human who never adopted
                  anything and for whom this is the only such moment. */}
              <Text
                style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                testID="room-consent-disclosure"
              >
                {ROOM_COPY.consentDisclosure}
              </Text>
              <InfoDisclosure
                label={ROOM_COPY.consentInfoLabel}
                lines={[...ROOM_COPY.consentInfo]}
                testID="room-consent-info"
              />
              {agentMembers.map(id => {
                const state = consentStates.get(id) ?? 'undecided';
                const stateLine =
                  state === 'consented'
                    ? ROOM_COPY.consentShared
                    : state === 'refused'
                      ? ROOM_COPY.consentRefused
                      : ROOM_COPY.consentUndecided;
                const rowBusy = consentBusy === id;
                return (
                  <View key={id} style={styles.consentRow} testID={`consent-${id}`}>
                    <Text
                      numberOfLines={1}
                      style={[t.type.rowTitle, { color: t.color.inkStrong }]}
                    >
                      {/* Every row here is an agent by construction (the
                          choice-set), so the title always carries the
                          attribution — owner-named for the foreign case the
                          surface exists for, never an
                          anonymous ULID. */}
                      {agentAttributed(id, nameFor(id))}
                    </Text>
                    <Text
                      style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                      testID={`consent-state-${id}`}
                    >
                      {stateLine}
                    </Text>
                    <View style={styles.confirmRow}>
                      {/* undecided shows both; consented shows only "Don't
                          share"; refused shows only "Share". */}
                      {state !== 'consented' ? (
                        <TextAction
                          label={ROOM_COPY.consentShare}
                          onPress={() => decideConsent(id, true)}
                          disabled={rowBusy}
                          testID={`consent-share-${id}`}
                        />
                      ) : null}
                      {state !== 'refused' ? (
                        <TextAction
                          label={ROOM_COPY.consentStopSharing}
                          onPress={() => decideConsent(id, false)}
                          disabled={rowBusy}
                          testID={`consent-stop-${id}`}
                        />
                      ) : null}
                    </View>
                  </View>
                );
              })}
              {consentNote !== null ? (
                <Text
                  style={[t.type.compactBody, styles.sectionLine, { color: t.color.warningInk }]}
                  testID="room-consent-note"
                >
                  {consentNote}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* The timer: MY slot is the control, the MINIMUM is the room. */}
          <View style={styles.section}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {ROOM_COPY.timerTitle}
            </Text>
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
              testID="room-timer-status"
            >
              {effectiveLabel === null
                ? ROOM_COPY.timerOff
                : ROOM_COPY.timerStatus(effectiveLabel)}
            </Text>
            <View style={styles.timerRow}>
              {DISAPPEAR_OPTIONS.map(option => {
                const active = option.seconds === mySlotSeconds;
                // Off for good once I have left: the chips say so to
                // VoiceOver AND to the eye — a recessed surface with muted
                // ink, never opacity — and a line beneath says why. `busy`
                // disables the tap but keeps the live look: a write in
                // flight is not a reason the person needs telling.
                const locked = !amIn;
                const disabled = busy || locked;
                return (
                  <Pressable
                    key={option.seconds}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled }}
                    accessibilityLabel={option.label}
                    testID={`room-timer-${option.seconds}`}
                    disabled={disabled}
                    onPress={() => setTimer(option.seconds)}
                    style={({ pressed }) => [
                      styles.timerChip,
                      {
                        minHeight: t.layout.touchTarget,
                        borderRadius: t.radius.button,
                        backgroundColor: locked
                          ? t.color.paperInset
                          : active
                            ? t.color.pineWash
                            : pressed
                              ? t.color.paperInset
                              : t.color.paperSheet,
                        borderColor:
                          active && !locked ? t.color.pineLine : t.color.lineSoft,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        t.type.compactStrong,
                        {
                          color: locked
                            ? t.color.inkMuted
                            : active
                              ? t.color.pine
                              : t.color.inkBody,
                        },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {!amIn ? (
              <Text
                style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
                testID="room-timer-locked"
              >
                {ROOM_COPY.timerLeft}
              </Text>
            ) : null}
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
            >
              {ROOM_COPY.timerYours}
            </Text>
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
            >
              {ROOM_COPY.timerRule}
            </Text>
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
            >
              {DISAPPEAR.limit}
            </Text>
          </View>

          {/* Blocking, said honestly for a shared room. */}
          <View style={styles.section}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {ROOM_COPY.blockTitle}
            </Text>
            <Text
              style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
            >
              {ROOM_COPY.blockLead}
            </Text>
            <InfoDisclosure
              label={ROOM_COPY.blockInfoLabel}
              lines={[ROOM_COPY.blockResidual]}
              testID="room-block-info"
            />
          </View>

          {/* Leaving and deleting. Leave is sovereign — every member, always,
              owner included; nothing can gate it. */}
          <View style={styles.section}>
            {amIn ? (
              confirming === 'leave' ? (
                <View>
                  <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                    {ROOM_COPY.leaveConfirmTitle}
                  </Text>
                  <Text
                    style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                  >
                    {ROOM_COPY.leaveConfirmBody}
                  </Text>
                  <View style={styles.confirmRow}>
                    <TextAction
                      label={ROOM_COPY.leaveConfirm}
                      tone="danger"
                      onPress={leave}
                      disabled={busy}
                      testID="room-leave-confirm"
                    />
                    <TextAction
                      label={ROOM_COPY.cancel}
                      onPress={() => setConfirming('none')}
                      disabled={busy}
                      testID="room-leave-cancel"
                    />
                  </View>
                </View>
              ) : (
                <OutlineButton
                  label={ROOM_COPY.leave}
                  tone="warning"
                  onPress={() => setConfirming('leave')}
                  disabled={busy}
                  testID="room-leave"
                  style={styles.outlineAction}
                />
              )
            ) : (
              <Text
                style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkMuted }]}
                testID="room-left-note"
              >
                You’re no longer in this room. It stays here until you delete
                it.
              </Text>
            )}

            {confirming === 'deleteLocal' ? (
              <View style={styles.confirmBlock}>
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {ROOM_COPY.deleteLocalConfirmTitle}
                </Text>
                <Text
                  style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                >
                  {ROOM_COPY.deleteLocalInfo}
                </Text>
                <View style={styles.confirmRow}>
                  <TextAction
                    label={ROOM_COPY.deleteLocalConfirm}
                    tone="danger"
                    onPress={deleteLocal}
                    disabled={busy}
                    testID="room-delete-confirm"
                  />
                  <TextAction
                    label={ROOM_COPY.cancel}
                    onPress={() => setConfirming('none')}
                    disabled={busy}
                    testID="room-delete-cancel"
                  />
                </View>
              </View>
            ) : (
              <OutlineButton
                label={ROOM_COPY.deleteLocal}
                tone="danger"
                onPress={() => setConfirming('deleteLocal')}
                disabled={busy}
                testID="room-delete"
                style={styles.outlineAction}
              />
            )}
            <InfoDisclosure
              label={ROOM_COPY.deleteLocalInfoLabel}
              lines={[ROOM_COPY.deleteLocalInfo]}
              testID="room-delete-info"
            />

            {isOwner ? (
              confirming === 'deleteEveryone' ? (
                <View style={styles.confirmBlock}>
                  <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                    {ROOM_COPY.deleteEveryoneConfirmTitle}
                  </Text>
                  {/* Rule 22's sentence, verbatim: best-effort on other
                      people's devices, never a guarantee. */}
                  <Text
                    style={[t.type.compactBody, styles.sectionLine, { color: t.color.inkBody }]}
                    testID="room-delete-everyone-body"
                  >
                    {ROOM_COPY.deleteEveryoneConfirmBody}
                  </Text>
                  <View style={styles.confirmRow}>
                    <TextAction
                      label={ROOM_COPY.deleteEveryoneConfirm}
                      tone="danger"
                      onPress={deleteEveryone}
                      disabled={busy}
                      testID="room-delete-everyone-confirm"
                    />
                    <TextAction
                      label={ROOM_COPY.cancel}
                      onPress={() => setConfirming('none')}
                      disabled={busy}
                      testID="room-delete-everyone-cancel"
                    />
                  </View>
                </View>
              ) : (
                <OutlineButton
                  label={ROOM_COPY.deleteEveryone}
                  tone="danger"
                  onPress={() => setConfirming('deleteEveryone')}
                  disabled={busy}
                  testID="room-delete-everyone"
                  style={styles.outlineAction}
                />
              )
            ) : null}

            {failed ? (
              <InlineError message={failed} testID="room-action-error" />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// The outlined action this file used to draw privately is the kit's
// OutlineButton now.

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 32, alignItems: 'center' },
  column: { width: '100%' },
  headerSpacer: { width: 44, height: 44 },

  hero: { marginTop: 24, alignItems: 'center' },
  heroName: { marginTop: 16, textAlign: 'center' },
  heroLine: { marginTop: 6, maxWidth: 320, textAlign: 'center' },

  section: { marginTop: 28 },
  sectionLine: { marginTop: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  statusRule: {
    width: 3,
    alignSelf: 'stretch',
    minHeight: 15,
    marginRight: 12,
  },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  memberBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
  },
  memberText: { flex: 1, minWidth: 0 },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ownerBadge: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  addList: { marginTop: 4 },
  consentRow: { marginTop: 16 },

  timerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  timerChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
  },

  confirmRow: { flexDirection: 'row', gap: 16, marginTop: 4 },
  confirmBlock: { marginTop: 16 },
  /** The Remove question sits inside the roster, so it takes the row's
   * rhythm rather than a section's. */
  removeConfirm: { marginTop: 8, marginBottom: 8 },
  /** The kit's OutlineButton: only the gap above it is this screen's. */
  outlineAction: { marginTop: 12 },
});
