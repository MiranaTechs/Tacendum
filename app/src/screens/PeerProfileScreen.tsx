import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  // Core Clipboard remains available for copying public account addresses.
  Clipboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DEVICE_CLASSES, type DeviceClass, type ReportReason } from '@tacendum/shared';
import { REPORT_COPY, report } from '../reporting';
import {
  BLOCK_COPY as BLOCK,
  BLOCK_EXPLAINER,
  DISAPPEAR,
  DISAPPEAR_OPTIONS_PEER,
  blockStatusTone,
  disappearLabel,
} from '../blocking';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { useKeyboardInset } from '../keyboardInset';
import { messaging } from '../messaging';
import { alwaysRelayEnabled } from '../call';
import { personRef, sanitizeDisplayName, shortId } from '../person';
import { LINKING_COPY } from '../linkingCopy';
import {
  SAFETY_COPY,
  SAFETY_EXPLAINER,
  SAFETY_STATUS,
  aggregateSafetyStates,
  deviceAddedStateFor,
  safetyDate,
  safetyGroups,
  safetyStateFor,
  spokenSafetyNumber,
} from '../safety';
import { useTheme } from '../theme';
import { Avatar } from '../ui/Avatar';
import { apiCrewAdopt, apiIntegrationRevoke } from '../api';
import { MACHINE_COPY as MACHINE, machineFailureCopy } from '../machine';
import { currentToken } from '../reauth';
import {
  IdentityRow,
  InlineError,
  InlineNotice,
  OutlineButton,
  PrimaryButton,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import { QuietRoom } from '../ui/QuietRoom';
import { useCoalescedSubscribe } from '../ui/useCoalescedSubscribe';
import { VaultSection } from '../ui/VaultSection';

interface Props {
  peerId: string;
  me: db.ProfileRow;
  onBack: () => void;
}

/** Long enough for "Mum", "Sam from the allotment", or a full name. */
const NICKNAME_MAX = 40;

/** How long a copy or save confirmation holds — StartChatScreen's number. */
const NOTICE_MS = 3000;

const COPY = {
  title: 'Profile',
  sourceNote: (who: string) =>
    `This is the profile ${who} shared with you in this chat.`,
  noProfile: 'They haven’t shared a profile yet.',
  noAbout: 'They haven’t written anything about themselves yet.',
  sharedAs: (name: string) => `Shared with you as “${name}”.`,
  roomLabel: (ref: string) => `A private chat between you and ${ref}`,
  photoLabel: (name: string) => `Photo of ${name}`,
  idLabel: 'Tacendum ID',

  // The device is named in the
  // platform's own words via the token.
  nicknameLabel: `Name on this ${DEVICE_NOUN}`,
  nicknamePlaceholder: 'A name only you see',
  nicknamePrivacy: 'Only you see this. It is never sent to them.',
  save: 'Save',
  clear: 'Clear',
  /** Save's answer: `write()` swallows a failed record on purpose, so
   * the one moment worth a word is the one that stood — and where it
   * stood, since it is never sent to them. */
  nicknameSaved: `Saved on this ${DEVICE_NOUN}.`,
  copy: 'Copy',
  /** The bare id, for handing on to someone who should have it. Not the
   * own-id sentence: this is THEIR address, not one to read out in fours. */
  idCopied: (who: string) => `Copied ${who}’s ID.`,

  /**
   * How this chat started — one flat line, because it is CONTEXT and not a
   * warning. The warning shape for a server introduction is already taken by
   * the thread's provenance notice, and a second alarm for one fact teaches
   * people to ignore both.
   *
   * There is no sentence for "they wrote to you first": an inbound-created
   * row and a row that predates the column are both null here, and the
   * profile cannot tell them apart.
   */
  originQr: 'You started this chat by scanning their code.',
  originManual: 'You started this chat by typing their ID.',
  /** All discovery classes, including the bare `discovery` mark, use generic
   * server-introduction copy. The mark may represent email, phone, or another
   * lookup class, so naming a specific identifier would claim information
   * that the stored provenance does not contain. */
  originLookup: 'You found them by looking them up.',

  safetyTitle: 'Safety number',
  safetyHint:
    'Read these aloud and check every group matches on the other device',
  confirmQuestion: 'Did every group match?',
  confirmMatch: 'They match',
  confirmMismatch: 'They don’t match',
  confirmNotYet: 'Not yet',
  /** Why the timer chips are off on a blocked person: the timer is a
   * shared setting carried to them in a message, and a block sends
   * nothing — so the control is honest about being off, and about the
   * one way back. */
  timerWhileBlocked:
    'Nothing is sent to them while they’re blocked, so the timer can’t change. Unblock them first.',
} as const;

/**
 * Name QR and manual introductions directly. For any discovery class,
 * including the bare family marker, use the same `db.serverIntroduced`
 * predicate as the thread so the copy does not invent an identifier class.
 * Null, legacy rows without provenance, and unknown non-discovery values
 * produce no sentence because they cannot establish who introduced the peer.
 */
function originLineFor(kind: string | null | undefined): string | null {
  if (kind === 'qr') return COPY.originQr;
  if (kind === 'manual') return COPY.originManual;
  if (db.serverIntroduced(kind)) return COPY.originLookup;
  return null;
}

/**
 * Per-person relay preference is true, false, or null. Null preserves the
 * first-call default: relay until a call with this person connects, then allow
 * direct calls. `setPeerRelayPref` represents null by deleting the row, so a
 * two-state switch would lose a meaningful choice.
 *
 * The three chips order choices from most to least IP-address protection:
 * always relay, relay until a call connects, and allow direct calls now.
 */
const RELAY_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  value: boolean | null;
}> = [
  { id: 'always', label: 'Always relay', value: true },
  { id: 'default', label: 'Default', value: null },
  { id: 'direct', label: 'Allow direct', value: false },
];

const RELAY = {
  title: 'Calls',
  /**
   * What the NEXT call with this person will actually do — never what the
   * chips mean in the abstract. The default's own sentence changes once a call
   * has connected, because by then the default has stopped relaying and a row
   * still promising "your first call is relayed" would be describing the past.
   */
  status: {
    /** The app-wide relay switch overrides the per-person preference in
     * `relayForPeer`. Explain that override so the stored choice is not shown
     * as if it currently controlled the call. */
    global: `Every call from this ${DEVICE_NOUN} is relayed right now — “Relay every call” is on in Settings, and it decides this one. What you choose here waits until you turn that off.`,
    always: (who: string) =>
      `Calls with ${who} go through Tacendum’s relay, first one and every one after.`,
    direct: (who: string) =>
      `Calls with ${who} connect straight to their device whenever they can.`,
    firstCall: (who: string) =>
      `Your first connected call with ${who} goes through the relay. Calls after that connect directly.`,
    connected: (who: string) =>
      `You and ${who} have connected before, so calls connect directly.`,
  },
  /**
   * The price of each answer, in the open rather than behind an ⓘ. This screen
   * puts teaching copy behind a disclosure when it explains the LIMITS of
   * something already chosen (the machine section); the cost of a choice has
   * to be readable before the finger moves, which is the rule the Settings
   * relay note follows too.
   */
  explain: (who: string, whoCap: string): string[] => [
    `A direct call connects faster and sounds better. It also shows ${who}’s device your IP address — roughly, where you are.`,
    'Relayed, the call goes through Tacendum instead: slower to connect, and quality can suffer. Our relay carries the sound and the video, so it sees when you call and how much you send. It can hear none of it — the media is encrypted and the relay holds no key.',
    `Default relays until one call with ${who} has connected, then goes direct. After a connected call they have your address already, and relaying every call afterwards cannot take it back.`,
    `${whoCap} is never told what this says, and it changes nothing on their device. It does not hide you from Tacendum’s own machines either — they help set up nearly every call — only from the device at the other end.`,
  ],
  /** Shown only when the write itself failed, so the sentence is true. */
  failed: 'Tacendum couldn’t remember that. Try again.',
} as const;

/**
 * The per-device drill-down deck. Remote devices
 * speak the never-wrong generic — the remote platform is unknowable — and slot words reach glass only through
 * `LINKING_COPY.slotLabel`, the shared source of display labels.
 */
const PEER_DEVICES = {
  title: 'Their devices',
  intro: (who: string) =>
    `${who}’s account spans more than one device. Each one has its own key — and its own safety number with this one.`,
  // Use the shared device-class list so membership and display labels cannot
  // drift across screens.
  deviceLabel: (deviceClass: string): string =>
    (DEVICE_CLASSES as readonly string[]).includes(deviceClass)
      ? LINKING_COPY.slotLabel(deviceClass as DeviceClass)
      : 'device',
  /** Cross-signed: a device they already had vouched for it. */
  crossSigned: 'Vouched for by a device you already knew.',
  /** The block-and-warn hold: asserted, never proven. */
  unverified: 'Not vouched for — nothing sends or arrives until you review it.',
  /** A pair with no session yet has no number — stated, never blank. */
  noNumber: 'No safety number with this device yet — one appears once a message travels between you.',
  perPair:
    'Safety numbers are between two devices. Comparing one of theirs says nothing about the others — check each one you care about.',
  /* The per-PAIR match record:
   * "verified" becomes something a human can actually achieve
   * device-by-device, so each pair carries its own stamp and its own
   * two-outcome comparison — exactly the anchor pair's anatomy, one level
   * down. Neutral wording (no device noun): the remote platform is
   * unknowable, and the record is about the PAIR. */
  pairUnchecked: 'You haven’t checked this pair yet.',
  pairMatched: (date: string) => `You checked this pair and it matched on ${date}.`,
  pairMismatched:
    'This pair did not match when you compared it. Compare again in person before trusting this device.',
  pairMatch: 'They match',
  pairMismatch: 'Didn’t match',
  pairRecheck: 'Compare again',
} as const;

/**
 * A section's answer to the Android back button.
 * The two questions on this page that belong to sibling components publish
 * one of these into a ref the screen holds, so the screen's SINGLE back
 * handler can retire them in a stated order. `true` means this section had
 * something open and dealt with the press; `false` means it had nothing and
 * the press belongs to whatever is asked next.
 */
type SectionCloser = { current: () => boolean };

/** What a ref holds before a section has published anything, and after it
 * has gone: nothing is open here, so the press is not ours. */
const NOTHING_OPEN = (): boolean => false;

/**
 * Someone else's profile — strictly the card they chose to send inside this
 * chat, plus the name I filed them under here. There is no directory to
 * consult, so there is nothing to fetch: no phone number, no presence, no last
 * seen, no mutual anything. What the screen adds is the safety number, and this
 * device's private record of having compared it.
 */
export function PeerProfileScreen({ peerId, me, onBack }: Props) {
  const t = useTheme();
  const [chat, setChat] = useState<db.ChatRow | null>(null);
  const [safety, setSafety] = useState<string | null>(null);
  /**
   * An UNACCEPTED IDENTITY CHANGE — nothing to do with the person's own block.
   * This is the only value that may ever reach `safetyStateFor`, and the two
   * must never be OR-ed together: `blockedAt` below is the block.
   */
  const [blocked, setBlocked] = useState(messaging.isPeerBlocked(peerId));
  /** When this device blocked them, or null. Read from `blocked_peers`. */
  const [blockedAt, setBlockedAt] = useState<number | null>(null);
  /** Agreed disappearing-message timer in seconds; 0 = off. Shared setting. */
  const [disappearSec, setDisappearSec] = useState(0);
  const [disappearFailed, setDisappearFailed] = useState(false);
  /** Blocking is a two-step commitment, never a single tap. */
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const [blockFailed, setBlockFailed] = useState(false);
  /** A block is enforced in-app even when its lock-screen mirror write fails.
   * Read the durable stale-mirror flag so the warning survives a relaunch and
   * stays visible until reconciliation updates the extension's copy. */
  const [blockPartial, setBlockPartial] = useState(
    messaging.isBlockNotificationMirrorStale(),
  );
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Marking a match is a two-step commitment, never a single tap. */
  const [confirming, setConfirming] = useState(false);
  const [nickname, setNickname] = useState('');
  const [nickFocused, setNickFocused] = useState(false);
  /** Save's brief "saved" line; its timer clears on unmount and on a peer
   * change, so nothing writes at a surface that is gone. */
  const [nickSaved, setNickSaved] = useState(false);
  const nickSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The ID row's Copy confirmation; same lifetime rules. */
  const [idCopied, setIdCopied] = useState(false);
  const idCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Sequenced: the device pass in `refresh` is one native safety-number
   * read per listed device, so two refreshes can overlap and an OLDER pass
   * must not overwrite a newer one — nor land after the screen is gone.
   * Bumped on unmount for exactly that. */
  const refreshSeq = useRef(0);

  /** Read by the system-back handler, which is registered once and must see
   * what is open at the moment of the press, not at subscription. */
  const confirmingBlockRef = useRef(false);
  const confirmingSafetyRef = useRef(false);
  /** A write in flight — the block above all, which is a real network write
   * and not one of `write()`'s silent local records. */
  const busyRef = useRef(false);
  confirmingBlockRef.current = confirmingBlock;
  confirmingSafetyRef.current = confirming;
  busyRef.current = busy;
  /**
   * The two questions this file's SIBLING sections own — the report chooser
   * (`step`) and the machine adopt/revoke (`confirming`) — are state this
   * component cannot read. Each section publishes a closer here instead: a
   * function that shuts whatever it has open and says whether it did. That
   * keeps ONE listener on the screen, which is what lets the order below be
   * a decision rather than an accident of which component mounted last.
   */
  const closeReportRef = useRef<() => boolean>(NOTHING_OPEN);
  const closeMachineRef = useRef<() => boolean>(NOTHING_OPEN);

  useEffect(() => {
    // Android Back dismisses one confirmation before leaving this profile.
    // React Native asks the newest listener first; this screen mounts after
    // the router. One listener calls section-owned closers through refs so
    // priority does not depend on component effect or mount order.
    //
    // Several sections may be open. Close the report chooser first because
    // it holds only reselectable chips and has sent nothing; then the machine
    // pairing question, the safety comparison, and the relationship block.
    // This orders section-specific commitments before the broader ones.
    //
    // Each closer consumes Back while its own write is busy, matching its
    // disabled Cancel control. Safety and block confirmations use the same
    // rule. With no question open, return false even during a nickname save
    // so the router retains normal navigation. Dismissing a safety question
    // records neither a match nor a mismatch.
    //
    // Refs keep the once-registered handler current without resubscribing.
    // BackHandler is inert on iOS, so registration is unconditional.
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (closeReportRef.current()) return true;
        if (closeMachineRef.current()) return true;
        if (confirmingSafetyRef.current) {
          if (busyRef.current) return true;
          setConfirming(false);
          return true;
        }
        if (confirmingBlockRef.current) {
          if (busyRef.current) return true;
          setConfirmingBlock(false);
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, []);

  // The keyboard inset adds enough scroll space to keep the nickname field
  // and Save reachable below the identity section on short screens.
  const keyboardInset = useKeyboardInset();
  /** The stored nickname is loaded once per peer: a refresh triggered by an
   * arriving message must never overwrite what is being typed. */
  const seeded = useRef(false);
  /** The contact's OTHER devices as this device's TOFU record holds them
   * — 'linked' and 'pending' only: a removed or
   * revoked device has left the set, and its absence IS the record. */
  const [peerDeviceRows, setPeerDeviceRows] = useState<db.PeerDeviceDbRow[]>([]);
  /** Each device pair has its own safety number, or null until a session
   * exists. Render this per-pair value rather than repeating the anchor. */
  const [deviceSafety, setDeviceSafety] = useState<Map<string, string | null>>(
    new Map(),
  );
  /** Per-PAIR match records: this device's own
   * matched/mismatch stamp for each of the contact's OTHER devices. The
   * anchor pair's record stays on the chat row; these live beside it. */
  const [pairRecords, setPairRecords] = useState<Map<string, db.PeerPairSafetyRow>>(
    new Map(),
  );

  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    void db
      .getChat(peerId)
      .then(row => {
        setChat(row);
        if (row && !seeded.current) {
          seeded.current = true;
          setNickname(row.localName ?? '');
        }
        // The agreed timer is a property of the conversation, so it is read
        // from the same chat-row snapshot as the rest of the conversation.
        setDisappearSec(row?.disappearSec ?? 0);
      })
      .catch(() => {});
    void messaging
      .getSafetyNumber(peerId)
      .then(setSafety)
      .catch(() => setSafety(null));
    setBlocked(messaging.isPeerBlocked(peerId));
    // The database, not messaging's enforcement Set: the Set is empty in a
    // duress session, where the decoy workspace's own rows are the truth.
    void db.getBlockedAt(peerId).then(setBlockedAt, () => {});
    // Re-read on every notify, so the standing warning leaves the moment a
    // reconcile finally rewrites the mirror — and arrives if one fails.
    setBlockPartial(messaging.isBlockNotificationMirrorStale());
    // The device set: this device's own verified record, re-read on
    // every notify so a device added (or dropped by a signed notice) while
    // the screen is open surfaces without a reopen.
    void db.listPeerDevices(peerId).then(
      rows => {
        const shown = rows.filter(
          r => r.userId !== peerId && (r.state === 'linked' || r.state === 'pending'),
        );
        if (seq !== refreshSeq.current) return;
        setPeerDeviceRows(shown);
        // Read each listed pair's number once; null renders as "no number yet".
        void (async () => {
          const numbers = new Map<string, string | null>();
          const records = new Map<string, db.PeerPairSafetyRow>();
          for (const r of shown) {
            numbers.set(
              r.userId,
              await messaging.getSafetyNumber(r.userId).catch(() => null),
            );
            records.set(
              r.userId,
              await db
                .getPeerPairSafety(r.userId)
                .catch(() => ({ checkedAt: null, mismatchAt: null })),
            );
          }
          // A newer refresh has started, or the screen is gone: this pass
          // describes a moment already moved past.
          if (seq !== refreshSeq.current) return;
          setDeviceSafety(numbers);
          setPairRecords(records);
        })();
      },
      () => {},
    );
  }, [peerId]);

  useEffect(() => {
    seeded.current = false;
    setConfirming(false);
    setConfirmingBlock(false);
    setBlockFailed(false);
    setAccepted(false);
    setNickSaved(false);
    setIdCopied(false);
  }, [peerId]);

  // The two notices' timers go with the screen, or with the peer they were
  // about; and no device pass started for a gone screen may land on it.
  useEffect(
    () => () => {
      if (nickSavedTimer.current) clearTimeout(nickSavedTimer.current);
      if (idCopiedTimer.current) clearTimeout(idCopiedTimer.current);
      refreshSeq.current++;
    },
    [peerId],
  );

  // A card, an avatar blob, or an identity change can land while this screen
  // is open; the profile must never show a version the thread has moved
  // past. ONE coalesced re-read per notify burst: subscribed raw, every
  // receipt, frame and socket transition re-ran the reads above, a native
  // safety-number call per listed device among them.
  useCoalescedSubscribe(refresh);

  // Sanitized at the read: this hero is the largest render of a
  // peer-chosen card in the app, so it paints exactly the bytes personName
  // would — a bidi override or a zero-width run is not a name here either.
  const shared = sanitizeDisplayName(chat?.displayName);
  /**
   * The name I gave this person on this device. It outranks their card in every
   * label, but it is NOT evidence of who they are: it never suppresses an
   * identity-change warning, and it is never shown as verification. The safety
   * section below stays keyed on the account id and on this device's own
   * comparison record.
   */
  const local = sanitizeDisplayName(chat?.localName);
  const label = local || shared;
  const hasProfile = chat?.profileVersion != null;
  const about = (chat?.about ?? '').trim();

  /** Object position ("between you and them") — see `who` for the rest. */
  const ref = personRef(peerId, chat?.displayName, chat?.localName);
  /**
   * SAFETY_COPY interpolates its reference into subject and possessive
   * positions ("if X sets up a new phone", "X’s safety number changed", "X
   * isn’t told"), where `personRef`'s "them" would read as "them sets up" and
   * "them’s". A singular noun phrase is the only fallback that is grammatical
   * in all three, so prose there degrades to "this person" rather than to a
   * pronoun or an id fragment.
   */
  const who = label || 'this person';
  const whoCap = label || 'This person';

  /** How this chat started, or nothing at all — see `originLineFor`. */
  const originLine = originLineFor(chat?.introducedBy);

  // `blockedAt` is deliberately absent from this object and must stay absent.
  // `blocked` here means one thing only — an unaccepted identity change — and
  // feeding a block into it would paint "Needs review" and "Their safety
  // number changed" over a conversation where nothing about the keys happened.
  const anchorPairState = safetyStateFor({
    blocked,
    safety,
    checkedAt: chat?.safetyCheckedAt ?? null,
    mismatchAt: chat?.safetyMismatchAt ?? null,
  });
  /**
   * The header state is the
   * WORST across the peer's device pairs, never the anchor pair alone. A
   * 'pending' (unverifiable) device contributes 'changed' — exactly a key
   * change; a cross-signed one contributes the standing 'deviceAdded'
   * review item, which the drill-down below is the surface for.
   */
  const state = aggregateSafetyStates([
    anchorPairState,
    ...peerDeviceRows.flatMap(row => {
      const record = pairRecords.get(row.userId);
      // `deviceAdded` is a REVIEW ITEM, and reviewing it is exactly what
      // the per-pair record below records: a
      // cross-signed addition contributes the standing 'deviceAdded' only
      // while its pair carries NO record — once the human compared the
      // pair's own number (matched or mismatched), the pair's recorded
      // state speaks and the review item retires. An UN-cross-signed
      // ('pending') device contributes 'changed' unconditionally: no
      // earlier comparison can vouch for an unprovable key.
      const reviewed =
        row.state !== 'pending' &&
        (record?.checkedAt != null || record?.mismatchAt != null);
      return [
        ...(reviewed ? [] : [deviceAddedStateFor(row.state !== 'pending')]),
        // The pair's OWN match record: each pair
        // contributes its recorded state, and the header stays the WORST
        // across pairs under the one precedence machine. `blocked: false`
        // deliberately — an unaccepted identity change is the anchor
        // pair's fact, already carried above.
        safetyStateFor({
          blocked: false,
          safety: deviceSafety.get(row.userId) ?? null,
          checkedAt: record?.checkedAt ?? null,
          mismatchAt: record?.mismatchAt ?? null,
        }),
      ];
    }),
  ]);
  // Token keys resolved against the live theme — safety.ts names colours,
  // theme.ts owns their values.
  const tone = SAFETY_STATUS[state];
  const status = { rule: t.color[tone.rule], ink: t.color[tone.ink] };
  const copy = SAFETY_COPY[state];
  // Token keys again, from the block's own deck: slate for a setting that is
  // on, the neutral rule for one that is off. Never `danger` — a block is the
  // person's own settled decision, not a fault.
  const blockTone = blockStatusTone({ blockedAt });
  const checkedOn =
    chat?.safetyCheckedAt != null
      ? safetyDate(chat.safetyCheckedAt)
      : undefined;

  /**
   * Every safety and nickname record is a note this device keeps to itself, so
   * a failed write simply leaves the screen showing the database — which is
   * still the truth. There is no honest copy for "we could not remember that".
   */
  const write = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // Intentionally silent; see above.
    } finally {
      setBusy(false);
      refresh();
    }
  };

  /** Recorded ONLY behind a button whose label says the numbers matched. */
  const markMatched = () =>
    write(async () => {
      await db.setSafetyChecked(peerId, Date.now());
      // A newer, better answer must not leave the older, worse one outranking
      // it: `mismatched` sits above `matched` in the state order.
      await db.setSafetyMismatch(peerId, null);
      setConfirming(false);
    });

  /** Record a reported mismatch separately from an unchecked number. */
  const markMismatch = () =>
    write(async () => {
      await db.setSafetyMismatch(peerId, Date.now());
      await db.setSafetyChecked(peerId, null);
      setConfirming(false);
    });

  /** Returns to `unchecked` and re-offers the comparison. It clears the record
   * rather than stamping a new one — nothing here has been compared yet. */
  const compareAgain = () =>
    write(async () => {
      await db.setSafetyChecked(peerId, null);
      await db.setSafetyMismatch(peerId, null);
      setConfirming(false);
    });

  /* The per-PAIR stamps: same anatomy as the
   * anchor pair's three verbs, one level down. Each write is exclusive by
   * construction (the db helpers null the other column), and `write()`
   * refreshes, which re-reads the records. LOCAL to this device like every
   * verification record — never synced (a human act is not
   * propagated). */
  const markPairMatched = (deviceId: string) =>
    write(async () => {
      await db.setPeerPairChecked(deviceId, Date.now());
    });
  const markPairMismatched = (deviceId: string) =>
    write(async () => {
      await db.setPeerPairMismatch(deviceId, Date.now());
    });
  const clearPairRecord = (deviceId: string) =>
    write(async () => {
      await db.setPeerPairChecked(deviceId, null);
    });

  /** `acceptIdentityChange` clears stale comparison records before accepting
   * the new identity, keeping this screen and the thread consistent. */
  const acceptChange = () =>
    write(async () => {
      await messaging.acceptIdentityChange(peerId);
      setAccepted(true);
    });

  /**
   * Blocking does NOT go through `write()`. That helper swallows failures on
   * purpose, because a safety or nickname record that did not save leaves the
   * screen showing the database, which is still the truth. A block is
   * different: it changes what this device will send, so a silent failure would
   * leave someone believing they are covered when they are not.
   *
   * Writes go through messaging rather than straight to the database so the
   * enforcement Set and every open screen move together.
   */
  const runBlockWrite = async (work: () => Promise<void>) => {
    setBusy(true);
    setBlockFailed(false);
    // blockPartial is NOT reset here: it renders the
    // durable stale-mirror flag, which only a reconcile that rewrites the
    // file may clear — the refresh below re-reads whatever the write left.
    try {
      await work();
    } catch {
      setBlockFailed(true);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const blockPerson = () =>
    runBlockWrite(async () => {
      await messaging.blockPeer(peerId);
      // The block IS enforced in-app; if its notification mirror
      // could not be written the person must be told, or they will believe the
      // lock screen is covered when it is not.
      const partial = messaging.isBlockNotificationMirrorStale();
      setBlockPartial(partial);
      setConfirmingBlock(false);
      setBlockedAt(Date.now());
      AccessibilityInfo.announceForAccessibilityWithOptions(
        partial ? BLOCK.partialMirror : BLOCK.blockedAnnounce,
        { queue: true },
      );
    });

  const unblockPerson = () =>
    runBlockWrite(async () => {
      await messaging.unblockPeer(peerId);
      setBlockedAt(null);
      // unblockPeer awaits its mirror reconcile, so this
      // read is settled — and an unblock the lock screen has not heard about
      // is announced as exactly that, never as ordinary success.
      const partial = messaging.isBlockNotificationMirrorStale();
      setBlockPartial(partial);
      AccessibilityInfo.announceForAccessibilityWithOptions(
        partial ? BLOCK.partialUnblockMirror : BLOCK.unblockedAnnounce,
        { queue: true },
      );
    });

  const saveNickname = () =>
    write(async () => {
      // Sanitized at input — this is the device's own typed label, so
      // the stored bytes ARE the bytes every surface will render.
      const cleaned = sanitizeDisplayName(nickname);
      await db.setLocalName(peerId, cleaned);
      // Sibling sync 'name': siblings inherit the local name. Fire-and-
      // forget — the record is this device's, the sync a convenience.
      void messaging.syncLocalName(peerId, cleaned === '' ? null : cleaned);
      // Only a write that stood says so: `write()` swallows a failure on
      // purpose, and a "saved" over one would be a lie.
      setNickSaved(true);
      if (nickSavedTimer.current) clearTimeout(nickSavedTimer.current);
      nickSavedTimer.current = setTimeout(() => setNickSaved(false), NOTICE_MS);
    });

  /** The bare id, and no pasteboard expiry (contrast pasteboard.ts): an id
   * is an address, not a secret — the whole point is that it gets pasted.
   * Copying it lets the owner share the address with someone else. */
  const copyPeerId = () => {
    Clipboard.setString(peerId);
    setIdCopied(true);
    if (idCopiedTimer.current) clearTimeout(idCopiedTimer.current);
    idCopiedTimer.current = setTimeout(() => setIdCopied(false), NOTICE_MS);
  };

  const clearNickname = () =>
    write(async () => {
      setNickname('');
      await db.setLocalName(peerId, null);
      void messaging.syncLocalName(peerId, null);
    });

  const showFollowUp =
    accepted &&
    state !== 'changed' &&
    state !== 'matched' &&
    state !== 'mismatched';

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
      testID="peer-profile-root"
    >
      <ScreenHeader
        title={COPY.title}
        onBack={onBack}
        backLabel="Back"
        testIDBack="peer-profile-back"
        right={<View style={styles.headerSpacer} />}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: t.layout.gutter },
        ]}
        // So Save lands on the first tap while the nickname keyboard is open.
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          <View style={styles.hero}>
            <QuietRoom
              you={{
                peerId: me.userId,
                displayName: me.displayName,
                photoB64: me.avatarB64,
              }}
              them={{
                peerId,
                // The monogram follows the same precedence as the name below
                // it, so the disc and the label can never disagree.
                displayName: local || shared || null,
                photoB64: chat?.avatarB64,
              }}
              accessibilityLabel={COPY.roomLabel(ref)}
            />
            <View style={styles.heroAvatar}>
              <Avatar
                peerId={peerId}
                displayName={local || shared || null}
                photoB64={chat?.avatarB64}
                size={t.layout.avatar.hero}
                monogramSize={t.type.screenTitle.fontSize}
                // A shared photo is information; a monogram only restates the
                // name announced directly below it, so it stays decorative.
                {...(chat?.avatarB64
                  ? { accessibilityLabel: COPY.photoLabel(who) }
                  : {})}
              />
            </View>
            {/* Nobody is given a name they did not choose to share: without a
                card and without a name from me, this person is their id, set in
                the face that says so. */}
            <Text
              numberOfLines={2}
              style={[
                label ? t.type.screenTitle : t.type.utilityData,
                styles.heroName,
                { color: t.color.inkStrong },
              ]}
            >
              {label ? label : peerId}
            </Text>
            {/* Their own choice of name is never silently erased by mine. */}
            {local && shared ? (
              <Text
                style={[
                  t.type.compactBody,
                  styles.heroSharedAs,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.sharedAs(shared)}
              </Text>
            ) : null}
            <Text
              style={[
                t.type.body,
                styles.heroAbout,
                { color: about ? t.color.inkBody : t.color.inkMuted },
              ]}
            >
              {about ? about : hasProfile ? COPY.noAbout : COPY.noProfile}
            </Text>
            {hasProfile ? (
              <Text
                style={[
                  t.type.compactBody,
                  styles.heroSource,
                  { color: t.color.inkMuted },
                ]}
              >
                {/* Subject position, so an unnamed peer reads "they shared"
                    rather than an id fragment. */}
                {COPY.sourceNote(label || 'they')}
              </Text>
            ) : null}
          </View>

          <View style={styles.nickname}>
            <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
              {COPY.nicknameLabel}
            </Text>
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              onFocus={() => setNickFocused(true)}
              onBlur={() => setNickFocused(false)}
              editable={!busy}
              maxLength={NICKNAME_MAX}
              placeholder={COPY.nicknamePlaceholder}
              placeholderTextColor={t.color.inkMuted}
              keyboardAppearance={t.scheme}
              selectionColor={t.color.pine}
              accessibilityLabel={COPY.nicknameLabel}
              testID="peer-nickname-input"
              style={[
                t.type.input,
                styles.field,
                {
                  borderRadius: t.radius.button,
                  color: t.color.inkStrong,
                  backgroundColor: t.color.paperSheet,
                  borderColor: nickFocused ? t.color.pine : t.color.lineStrong,
                  borderWidth: nickFocused ? 2 : 1,
                },
              ]}
            />
            <View style={styles.nicknameActions}>
              {/* Off while nothing changed: a Save that writes
                  the bytes already stored has nothing to say. Compared on
                  the sanitized bytes, since those are what gets stored. */}
              <TextAction
                label={COPY.save}
                onPress={() => void saveNickname()}
                disabled={busy || sanitizeDisplayName(nickname) === local}
                testID="peer-nickname-save"
              />
              {local || nickname !== '' ? (
                <TextAction
                  label={COPY.clear}
                  onPress={() => void clearNickname()}
                  disabled={busy}
                  testID="peer-nickname-clear"
                />
              ) : null}
            </View>
            {nickSaved ? (
              <InlineNotice
                tone="pine"
                message={COPY.nicknameSaved}
                marginTop={0}
                testID="peer-nickname-saved"
              />
            ) : (
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                {COPY.nicknamePrivacy}
              </Text>
            )}
          </View>

          {/* Full-bleed sheet: the row keeps its own 16pt padding, so the
              label still lines up with the rest of the column. */}
          <View
            style={[
              styles.identity,
              {
                marginHorizontal: -t.layout.gutter,
                backgroundColor: t.color.paperSheet,
                borderColor: t.color.lineSoft,
                borderTopWidth: t.hairline,
                borderBottomWidth: t.hairline,
              },
            ]}
          >
            <IdentityRow
              label={COPY.idLabel}
              value={peerId}
              first
              valueTestID="peer-user-id"
              spellValue
              action={{
                label: COPY.copy,
                onPress: copyPeerId,
                testID: 'peer-copy-id',
              }}
            />
          </View>
          {idCopied ? (
            <InlineNotice
              tone="pine"
              message={COPY.idCopied(who)}
              testID="peer-id-copied"
            />
          ) : null}

          {/* How this chat started: under the identity sheet, above safety —
              the place a person is already deciding how much to trust this
              row. One line, never a section; this screen is long enough. */}
          {originLine !== null ? (
            <Text
              style={[t.type.compactBody, styles.originLine, { color: t.color.inkMuted }]}
              testID="peer-origin"
            >
              {originLine}
            </Text>
          ) : null}

          <View style={styles.safety}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {COPY.safetyTitle}
            </Text>

            <View style={styles.statusRow}>
              <View
                style={[styles.statusRule, { backgroundColor: status.rule }]}
              />
              <Text style={[t.type.utilityLabel, { color: status.ink }]}>
                {copy.label}
              </Text>
            </View>

            {state === 'changed' ? (
              <View
                style={[
                  styles.panel,
                  {
                    backgroundColor: t.color.dangerWash,
                    borderLeftColor: t.color.danger,
                  },
                ]}
              >
                {copy.title ? (
                  <Text style={[t.type.bodyStrong, { color: t.color.danger }]}>
                    {copy.title(whoCap)}
                  </Text>
                ) : null}
                <Text
                  style={[
                    t.type.compactBody,
                    styles.panelLine,
                    { color: t.color.inkBody },
                  ]}
                >
                  {copy.body(who)}
                </Text>
                {copy.blocked ? (
                  <Text
                    style={[
                      t.type.compactBody,
                      styles.panelLine,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {copy.blocked}
                  </Text>
                ) : null}
              </View>
            ) : (
              <>
                {safety !== null ? (
                  <SafetyGrid
                    number={safety}
                    hint={COPY.safetyHint}
                    testID="peer-safety-number"
                  />
                ) : null}
                <Text
                  style={[
                    t.type.compactBody,
                    // Without a number the body takes the number's place, and
                    // with it the section's gap under the status row.
                    { marginTop: safety === null ? 12 : 8 },
                    { color: t.color.inkBody },
                  ]}
                >
                  {copy.body(who, checkedOn)}
                </Text>
                {/* What the number is, why both phones show the same one, and
                    what a difference would mean before asking for a comparison. */}
                {SAFETY_EXPLAINER.map(line => (
                  <Text
                    key={line}
                    style={[
                      t.type.compactBody,
                      styles.explainerLine,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    {line}
                  </Text>
                ))}
                {copy.disclosure ? (
                  <Text
                    style={[
                      t.type.compactBody,
                      styles.explainerLine,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    {copy.disclosure(who)}
                  </Text>
                ) : null}
              </>
            )}

            {state === 'changed' && copy.action ? (
              <OutlineButton
                label={copy.action}
                tone="danger"
                onPress={() => void acceptChange()}
                disabled={busy}
                testID="peer-safety-accept"
                style={styles.action}
              />
            ) : null}

            {state === 'unchecked' && !confirming && copy.action ? (
              <PrimaryButton
                label={copy.action}
                onPress={() => setConfirming(true)}
                disabled={busy}
                testID="peer-safety-mark"
                style={styles.action}
              />
            ) : null}

            {state === 'unchecked' && confirming ? (
              <View style={styles.confirm}>
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  {COPY.confirmQuestion}
                </Text>
                <PrimaryButton
                  label={COPY.confirmMatch}
                  onPress={() => void markMatched()}
                  disabled={busy}
                  testID="peer-safety-match"
                  style={styles.action}
                />
                <OutlineButton
                  label={COPY.confirmMismatch}
                  tone="danger"
                  onPress={() => void markMismatch()}
                  disabled={busy}
                  testID="peer-safety-mismatch"
                  style={styles.action}
                />
                {/* A question with only two answers and no exit is a trap:
                    somebody who opened this before actually comparing must not
                    be made to record a finding either way. */}
                <View style={styles.confirmOut}>
                  <TextAction
                    label={COPY.confirmNotYet}
                    onPress={() => setConfirming(false)}
                    disabled={busy}
                    testID="peer-safety-cancel"
                  />
                </View>
              </View>
            ) : null}

            {(state === 'matched' || state === 'mismatched') && copy.action ? (
              <PrimaryButton
                label={copy.action}
                onPress={() => void compareAgain()}
                disabled={busy}
                testID="peer-safety-recheck"
                style={styles.action}
              />
            ) : null}

            {/* The change is accepted, so the state is no longer `changed` —
                the instruction that state left behind still applies. */}
            {showFollowUp && SAFETY_COPY.changed.followUp ? (
              <InlineNotice
                message={SAFETY_COPY.changed.followUp}
                tone="pine"
                marginTop={12}
              />
            ) : null}
          </View>

          {/* THEIR DEVICES: the per-device
              drill-down, first-class — when this contact's account spans
              devices, each is listed with its own standing, because a 2×3
              relationship is six fingerprints and the UI says so instead of
              presenting a fiction. The list is THIS device's own TOFU
              record (peer_devices), rendered from verified certificates —
              never the server's word. Absent entirely for the ordinary
              single-device contact. */}
          {peerDeviceRows.length > 0 ? (
            <View style={styles.blocking}>
              <Text
                accessibilityRole="header"
                style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
              >
                {PEER_DEVICES.title}
              </Text>
              <Text
                style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkBody }]}
              >
                {PEER_DEVICES.intro(who)}
              </Text>
              {peerDeviceRows.map(row => (
                <View
                  key={row.userId}
                  style={styles.deviceRow}
                  testID={`peer-device-${row.userId}`}
                >
                  <Text style={[t.type.compactBody, { color: t.color.inkStrong }]}>
                    {PEER_DEVICES.deviceLabel(row.class)} · {shortId(row.userId)}
                  </Text>
                  <Text
                    style={[t.type.compactBody, { color: row.state === 'pending' ? t.color.warningInk : t.color.inkMuted }]}
                    testID={`peer-device-state-${row.userId}`}
                  >
                    {row.state === 'pending'
                      ? PEER_DEVICES.unverified
                      : PEER_DEVICES.crossSigned}
                  </Text>
                  {/* The pair's OWN number (the drill-down): twelve
                      groups a human can actually
                      compare device-by-device, or the honest absence. */}
                  {deviceSafety.get(row.userId) ? (
                    <SafetyGrid
                      number={deviceSafety.get(row.userId)!}
                      testID={`peer-device-number-${row.userId}`}
                    />
                  ) : (
                    <Text
                      style={[t.type.compactBody, { color: t.color.inkMuted }]}
                      testID={`peer-device-number-${row.userId}`}
                    >
                      {PEER_DEVICES.noNumber}
                    </Text>
                  )}
                  {/* The pair's OWN match record:
                      the stamp, then the same two-outcome comparison the
                      anchor pair offers — per pair, because "verified" is a
                      per-pair human act and a 2×3 relationship is six
                      fingerprints. */}
                  {(() => {
                    const record = pairRecords.get(row.userId);
                    const mismatched = record?.mismatchAt != null;
                    const matched = !mismatched && record?.checkedAt != null;
                    return (
                      <>
                        <Text
                          style={[
                            t.type.compactBody,
                            {
                              color: mismatched
                                ? t.color.danger
                                : matched
                                  ? t.color.pine
                                  : t.color.inkMuted,
                            },
                          ]}
                          testID={`peer-device-record-${row.userId}`}
                        >
                          {mismatched
                            ? PEER_DEVICES.pairMismatched
                            : matched
                              ? PEER_DEVICES.pairMatched(safetyDate(record!.checkedAt!))
                              : PEER_DEVICES.pairUnchecked}
                        </Text>
                        {deviceSafety.get(row.userId) ? (
                          <View style={styles.pairActions}>
                            {matched || mismatched ? (
                              <TextAction
                                label={PEER_DEVICES.pairRecheck}
                                onPress={() => clearPairRecord(row.userId)}
                                testID={`peer-device-recheck-${row.userId}`}
                              />
                            ) : (
                              <>
                                <TextAction
                                  label={PEER_DEVICES.pairMatch}
                                  onPress={() => markPairMatched(row.userId)}
                                  testID={`peer-device-match-${row.userId}`}
                                />
                                <OutlineButton
                                  label={PEER_DEVICES.pairMismatch}
                                  tone="danger"
                                  onPress={() => markPairMismatched(row.userId)}
                                  testID={`peer-device-mismatch-${row.userId}`}
                                  style={styles.action}
                                />
                              </>
                            )}
                          </View>
                        ) : null}
                      </>
                    );
                  })()}
                </View>
              ))}
              <Text
                style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkMuted }]}
              >
                {PEER_DEVICES.perPair}
              </Text>
            </View>
          ) : null}

          {/* Calls, above the two SHARED settings that follow rather
              than among them. The timer and the vault are agreements with the
              other device; this is a memory kept on this device that they are
              never told about, like the nickname at the top and the block at
              the bottom, and reading it next to two settings that change
              things on their side would invite exactly the wrong inference. */}
          <RelaySection peerId={peerId} who={who} whoCap={whoCap} />

          {/* Blocking. Same anatomy as the safety section above — header,
              status rule, explanation, action — because it is the same kind of
              thing: a per-person setting this device keeps to itself. What it
              must never share is safetyStateFor's input; see the comment there. */}
          <View style={styles.blocking}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {DISAPPEAR.title}
            </Text>
            <Text
              style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkBody }]}
              testID="peer-disappear-status"
            >
              {disappearLabel(disappearSec) === null
                ? DISAPPEAR.notSet
                : DISAPPEAR.status(disappearLabel(disappearSec)!)}
            </Text>
            {/* The six chips wrap: the row has to hold '5 minutes'
                through '4 weeks' at every type size, so it is a wrapping row
                and not a scroller. */}
            <View style={styles.disappearRow} testID="peer-disappear-row">
              {DISAPPEAR_OPTIONS_PEER.map(option => {
                const active = option.seconds === disappearSec;
                // Off while they are blocked: the chips say so to
                // VoiceOver AND to the eye — a recessed surface with muted
                // ink, never opacity — and a line beneath says why. `busy`
                // disables the tap but keeps the live look: a write in
                // flight is not a reason the person needs telling.
                const locked = blockedAt != null;
                const disabled = busy || locked;
                return (
                  <Pressable
                    key={option.seconds}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled }}
                    accessibilityLabel={option.label}
                    testID={`peer-disappear-${option.seconds}`}
                    disabled={disabled}
                    onPress={() => {
                      setDisappearFailed(false);
                      const previous = disappearSec;
                      setDisappearSec(option.seconds);
                      void messaging
                        .setDisappearTimer(peerId, option.seconds)
                        .catch(() => {
                          // Put the control back where it was: a switch that
                          // stayed flipped after a failed write would claim a
                          // guarantee neither phone actually has.
                          setDisappearSec(previous);
                          setDisappearFailed(true);
                        });
                    }}
                    style={({ pressed }) => [
                      styles.disappearChip,
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
            {blockedAt != null ? (
              <Text
                style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkMuted }]}
                testID="peer-disappear-locked"
              >
                {COPY.timerWhileBlocked}
              </Text>
            ) : null}
            <Text
              style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkMuted }]}
            >
              {DISAPPEAR.shared}
            </Text>
            <Text
              style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkMuted }]}
            >
              {DISAPPEAR.limit}
            </Text>
            {disappearFailed ? (
              <InlineError message={DISAPPEAR.failed} testID="peer-disappear-error" />
            ) : null}
          </View>

          {/* The vault. Placed here rather than last because
              it is conversation-scoped like the timer above it, and because
              blocking should stay the terminal section: it is the one control
              on this page that ends the conversation, and burying it under the
              longest section on the screen would be the wrong emphasis.
              `me.userId` is the same value the send path uses as its writer id,
              which is what lets a contested value be labelled as yours. */}
          <VaultSection
            peerId={peerId}
            meUserId={me.userId}
            who={who}
            blockedAt={blockedAt}
          />

          {/* Machines (crew-chat). Between the vault and blocking on purpose:
              blocking stays the terminal section (the comment above records
              why), and this section is for a MINORITY of contacts — the app
              cannot know which, because the server refuses to enumerate a
              crew even to its owner, so the section says who it is for and
              lets the server's own refusals answer for everyone else. */}
          <MachineSection peerId={peerId} closerRef={closeMachineRef} />

          {/* Reporting, placed ABOVE blocking and never inside it. The two are
              different remedies and the order says which is which: blocking
              is immediate, local, and needs nobody's agreement; reporting asks
              a human and changes nothing by itself. Putting report second
              would read as the escalation, which is backwards. */}
          <ReportSection peerId={peerId} closerRef={closeReportRef} />

          <View style={styles.blocking}>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {BLOCK.title}
            </Text>

            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusRule,
                  { backgroundColor: t.color[blockTone.rule] },
                ]}
              />
              {/* The rule is decorative; the word carries the meaning. */}
              <Text
                style={[t.type.utilityLabel, { color: t.color[blockTone.ink] }]}
                testID="peer-block-status"
              >
                {blockedAt != null ? BLOCK.statusLabel : BLOCK.notBlockedLabel}
              </Text>
            </View>

            {blockedAt == null ? (
              <>
                {BLOCK_EXPLAINER.map(line => (
                  <Text
                    key={line}
                    style={[
                      t.type.compactBody,
                      styles.explainerLine,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    {line}
                  </Text>
                ))}
                {!confirmingBlock ? (
                  <OutlineButton
                    label={BLOCK.action}
                    tone="warning"
                    onPress={() => {
                      setBlockFailed(false);
                      setConfirmingBlock(true);
                    }}
                    disabled={busy}
                    testID="peer-block"
                    style={styles.action}
                  />
                ) : (
                  <View style={styles.confirm}>
                    <Text
                      style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
                    >
                      {BLOCK.confirmQuestion}
                    </Text>
                    <Text
                      style={[
                        t.type.compactBody,
                        styles.panelLine,
                        { color: t.color.inkBody },
                      ]}
                    >
                      {BLOCK.confirmBody}
                    </Text>
                    <OutlineButton
                      label={BLOCK.confirm}
                      tone="warning"
                      onPress={() => void blockPerson()}
                      disabled={busy}
                      testID="peer-block-confirm"
                      style={styles.action}
                    />
                    {/* Three controls, never two: a question with only two
                        answers and no exit is a trap. */}
                    <View style={styles.confirmOut}>
                      <TextAction
                        label={BLOCK.cancel}
                        onPress={() => setConfirmingBlock(false)}
                        disabled={busy}
                        testID="peer-block-cancel"
                      />
                    </View>
                  </View>
                )}
              </>
            ) : (
              <>
                <View
                  style={[
                    styles.panel,
                    {
                      backgroundColor: t.color.paperLayer,
                      borderLeftColor: t.color.warningMark,
                    },
                  ]}
                  testID="peer-blocked-panel"
                >
                  <Text
                    style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
                  >
                    {BLOCK.blockedTitle}
                  </Text>
                  <Text
                    style={[
                      t.type.compactBody,
                      styles.panelLine,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {BLOCK.blockedBody}
                  </Text>
                  <Text
                    style={[
                      t.type.compactBody,
                      styles.panelLine,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    {BLOCK.blockedQuiet}
                  </Text>
                </View>
                {/* One tap, no second confirm: the sentence naming what is lost
                    is read directly above the button, as `Compare again` is,
                    and this app does not nag. */}
                <PrimaryButton
                  label={BLOCK.unblock}
                  onPress={() => void unblockPerson()}
                  disabled={busy}
                  testID="peer-unblock"
                  style={styles.action}
                />
              </>
            )}

            {blockFailed ? (
              <InlineError message={BLOCK.failed} testID="peer-block-error" />
            ) : null}

            {blockPartial ? (
              // The STANDING form, direction-neutral (blocking.ts says why):
              // the durable marker records that the mirror file could not be
              // written, not which change it was carrying, and after a
              // relaunch nobody remembers. The action-moment announcements
              // above keep the directional sentences.
              <InlineError
                message={BLOCK.mirrorStale}
                testID="peer-block-partial"
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * A safety number, laid out as one: twelve five-digit groups, three to a
 * row, four rows at every width and every text size — a number two people
 * read to each other must not re-wrap into ragged half-groups. The anchor
 * pair's grid, extracted so a device pair's number is drawn the same way
 * rather than as a proportional-font run that wrapped wherever the width
 * fell — the exact thing safety.ts's grouping exists to prevent. */
function SafetyGrid({
  number,
  hint,
  testID,
}: {
  number: string;
  hint?: string;
  testID?: string;
}) {
  const t = useTheme();
  return (
    <View
      {...(testID ? { testID } : {})}
      accessible
      accessibilityLabel={spokenSafetyNumber(number)}
      {...(hint ? { accessibilityHint: hint } : {})}
      style={styles.grid}
    >
      {safetyGroups(number).map((group, i) => (
        <Text
          key={i}
          selectable
          // The grid carries the spoken number; without this VoiceOver would
          // read all twelve groups twice.
          importantForAccessibility="no-hide-descendants"
          adjustsFontSizeToFit
          numberOfLines={1}
          style={[t.type.safetyNumber, styles.cell, { color: t.color.pine }]}
        >
          {group}
        </Text>
      ))}
    </View>
  );
}

/**
 * The machine actions (adopt into crew / revoke), server-answered.
 *
 * Its own component with its own state, VaultSection-style: the main screen
 * needs to know nothing about crews. Both actions confirm first with three
 * controls (a question with only two answers and no exit is a trap — the
 * blocking section's rule), disable while in flight, and report EXACTLY what
 * the server answered: success copy keeps the server's adopted-or-already
 * collapse, failure copy keeps its refusal collapse, and the network-failure
 * sentence is deliberately identical to what a duress session's transport
 * guard produces.
 */
/**
 * Reporting.
 *
 * Reports contain an account and category by default. Message text requires
 * explicit selection by the sender because encrypted conversations are not
 * otherwise available to the service.
 *
 * THE SHAPE, AND WHY. Two steps, not one: picking a reason is a decision, and
 * a single tap that fires a report the instant it is touched gives no room to
 * change your mind. The consent sentence naming what is sent sits ABOVE the
 * submit control, the way `BLOCK.confirmBody` names discard-on-arrival above
 * its button — a consequence read after the fact is not consent.
 *
 * This chooser sends only an account identifier and a category. It has no
 * message-selection control, so its consent copy must say that no message
 * text is included even though the reporting protocol supports excerpts.
 */
function ReportSection({
  peerId,
  closerRef,
}: {
  peerId: string;
  closerRef: SectionCloser;
}) {
  const t = useTheme();
  const [step, setStep] = useState<'idle' | 'choosing'>('idle');
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Android Back is answered through the screen's one listener. Since
  // `step` belongs to this component, publish a
  // closer instead. Assigned during render, exactly as the screen mirrors
  // its own state into refs, so the press sees the last committed render.
  // It does what the chooser's own Cancel does — and refuses while a report
  // is being sent, where that Cancel is `disabled={busy}`.
  closerRef.current = () => {
    if (step !== 'choosing') return false;
    if (busy) return true;
    setStep('idle');
    setReason(null);
    return true;
  };
  useEffect(() => {
    const ref = closerRef;
    return () => {
      ref.current = NOTHING_OPEN;
    };
  }, [closerRef]);

  const send = useCallback(async () => {
    if (reason === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const id = await report(peerId, { reason });
      setSentId(id);
      setStep('idle');
      setReason(null);
      AccessibilityInfo.announceForAccessibility(REPORT_COPY.announceSent);
    } catch (err) {
      // The rate limit is the one failure with a specific remedy — wait —
      // so it gets its own sentence rather than the generic one.
      const limited =
        err instanceof Error && /rate|429|too many/i.test(err.message);
      setFailure(limited ? REPORT_COPY.tooMany : REPORT_COPY.failed);
    } finally {
      setBusy(false);
    }
  }, [peerId, reason]);

  return (
    <View style={styles.machine} testID="peer-report">
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {REPORT_COPY.title}
      </Text>

      {sentId !== null ? (
        <View
          style={[
            styles.panel,
            {
              backgroundColor: t.color.paperLayer,
              borderLeftColor: t.color.pineLine,
            },
          ]}
          testID="peer-report-sent"
        >
          <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
            {REPORT_COPY.sentTitle}
          </Text>
          <Text
            style={[
              t.type.compactBody,
              styles.panelLine,
              { color: t.color.inkBody },
            ]}
          >
            {REPORT_COPY.sentBody}
          </Text>
          {/* Reporting is not blocking, and someone who has just reported
              harassment is exactly the person who should be told so. */}
          <Text
            style={[
              t.type.compactBody,
              styles.panelLine,
              { color: t.color.inkMuted },
            ]}
          >
            {REPORT_COPY.sentBlockHint}
          </Text>
          <Text
            style={[t.type.timeStatus, styles.panelLine, { color: t.color.inkMuted }]}
            testID="peer-report-reference"
          >
            {REPORT_COPY.sentReference(sentId)}
          </Text>
        </View>
      ) : step === 'idle' ? (
        <>
          <Text
            style={[
              t.type.compactBody,
              styles.explainerLine,
              { color: t.color.inkMuted },
            ]}
          >
            {REPORT_COPY.intro}
          </Text>
          <TextAction
            label={REPORT_COPY.action}
            onPress={() => {
              setFailure(null);
              setStep('choosing');
            }}
            disabled={busy}
            testID="peer-report-start"
          />
        </>
      ) : (
        <View style={styles.confirm}>
          <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
            {REPORT_COPY.reasonQuestion}
          </Text>
          {/* The timer's and the relay's idiom: chips in a
              row, one selected — and SAID to be, so VoiceOver hears
              "selected" rather than a bullet read out as a word. */}
          <View style={styles.reasonRow}>
            {REPORT_COPY.reasons.map(option => {
              const active = reason === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: busy }}
                  accessibilityLabel={option.label}
                  testID={`peer-report-reason-${option.value}`}
                  disabled={busy}
                  onPress={() => setReason(option.value)}
                  style={({ pressed }) => [
                    styles.reasonChip,
                    {
                      minHeight: t.layout.touchTarget,
                      borderRadius: t.radius.button,
                      backgroundColor: active
                        ? t.color.pineWash
                        : pressed
                          ? t.color.paperInset
                          : t.color.paperSheet,
                      borderColor: active ? t.color.pineLine : t.color.lineSoft,
                    },
                  ]}
                >
                  <Text
                    style={[
                      t.type.compactStrong,
                      { color: active ? t.color.pine : t.color.inkBody },
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* The consent sentence, above the send control. Its first clause is
              the surprising fact — that nothing they wrote is included — since
              in an encrypted messenger the surprise is that anything could
              be. */}
          <Text
            style={[
              t.type.compactBody,
              styles.panelLine,
              { color: t.color.inkBody },
            ]}
            testID="peer-report-consent"
          >
            {REPORT_COPY.attachIntro}
          </Text>
          <Text
            style={[
              t.type.compactBody,
              styles.panelLine,
              { color: t.color.inkMuted },
            ]}
            testID="peer-report-attached"
          >
            {REPORT_COPY.attachNone}
          </Text>
          <PrimaryButton
            label={REPORT_COPY.submit}
            onPress={() => void send()}
            disabled={busy || reason === null}
            testID="peer-report-submit"
            style={styles.action}
          />
          {/* Three controls, never two — same rule as the block confirm. */}
          <View style={styles.confirmOut}>
            <TextAction
              label={REPORT_COPY.cancel}
              onPress={() => {
                setStep('idle');
                setReason(null);
              }}
              disabled={busy}
              testID="peer-report-cancel"
            />
          </View>
        </View>
      )}

      {failure !== null ? (
        <InlineError message={failure} testID="peer-report-error" />
      ) : null}
    </View>
  );
}

/**
 * The per-person relay control. Its own component with its own state,
 * MachineSection-style, so the screen's `refresh` — which re-runs on every
 * arriving envelope — has no way to stomp a choice mid-write.
 *
 * READ ONCE PER PEER, for that same reason. Nothing a message can carry
 * changes either value: the memory changes only here, and `hasConnectedCallWith`
 * only when a call connects, which cannot happen while this screen is open.
 *
 * BOTH READS FAIL QUIETLY, and that is the timer's precedent above rather than
 * an oversight — a failed read leaves the control showing the default, which
 * is what an absent memory means anyway. It is worth naming what that costs:
 * if the read failed while a real preference exists, the row understates it
 * until the screen is reopened. The alternative is an error banner on a
 * profile page for a database that will answer on the next read, and the
 * policy path does its own reads with its own fallbacks — the call itself is
 * never decided from this component's state.
 */
function RelaySection({
  peerId,
  who,
  whoCap,
}: {
  peerId: string;
  who: string;
  whoCap: string;
}) {
  const t = useTheme();
  /** The stored memory: true, false, or null for "nothing chosen". */
  const [choice, setChoice] = useState<boolean | null>(null);
  /** A CONNECTED call in the log — what makes the default's second half true. */
  const [connectedBefore, setConnectedBefore] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * Read during render rather than into state: it is a synchronous module
   * getter, and the one thing worse than this section being wrong about the
   * app-wide switch is it being STALE about it.
   */
  const globalRelay = alwaysRelayEnabled();

  useEffect(() => {
    let live = true;
    setChoice(null);
    setConnectedBefore(false);
    setFailed(false);
    void db.getPeerRelayPref(peerId).then(value => {
      if (live) setChoice(value);
    }, () => {});
    void db.hasConnectedCallWith(peerId).then(value => {
      if (live) setConnectedBefore(value);
    }, () => {});
    return () => {
      live = false;
    };
  }, [peerId]);

  const status = globalRelay
    ? RELAY.status.global
    : choice === true
      ? RELAY.status.always(who)
      : choice === false
        ? RELAY.status.direct(who)
        : connectedBefore
          ? RELAY.status.connected(who)
          : RELAY.status.firstCall(who);

  /**
   * Optimistic, and it puts the control BACK on a failed write — the timer
   * chips' rule. A chip that stayed selected after a failed write would be
   * claiming a memory the database does not hold, and the next call would be
   * decided by the value still on disk.
   *
   * `null` is passed through untouched so `setPeerRelayPref` takes its DELETE
   * branch. Collapsing it to false here would write a row that reads as "never
   * relay this person" and make the first-call default unreachable forever.
   */
  const choose = (next: boolean | null) => {
    setFailed(false);
    const previous = choice;
    setChoice(next);
    void db.setPeerRelayPref(peerId, next).catch(() => {
      setChoice(previous);
      setFailed(true);
    });
  };

  return (
    <View style={styles.calls} testID="peer-relay">
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {RELAY.title}
      </Text>
      <Text
        style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkBody }]}
        testID="peer-relay-status"
      >
        {status}
      </Text>
      <View style={styles.relayRow}>
        {RELAY_OPTIONS.map(option => {
          const active = choice === option.value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              testID={`peer-relay-${option.id}`}
              onPress={() => choose(option.value)}
              style={({ pressed }) => [
                styles.relayChip,
                {
                  minHeight: t.layout.touchTarget,
                  borderRadius: t.radius.button,
                  backgroundColor: active
                    ? t.color.pineWash
                    : pressed
                      ? t.color.paperInset
                      : t.color.paperSheet,
                  borderColor: active ? t.color.pineLine : t.color.lineSoft,
                },
              ]}
            >
              <Text
                style={[
                  t.type.compactStrong,
                  { color: active ? t.color.pine : t.color.inkBody },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {RELAY.explain(who, whoCap).map(line => (
        <Text
          key={line}
          style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkMuted }]}
        >
          {line}
        </Text>
      ))}
      {failed ? <InlineError message={RELAY.failed} testID="peer-relay-error" /> : null}
    </View>
  );
}

function MachineSection({
  peerId,
  closerRef,
}: {
  peerId: string;
  closerRef: SectionCloser;
}) {
  const t = useTheme();
  const [confirming, setConfirming] = useState<'adopt' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Same as ReportSection above: the adopt/revoke question is this
  // component's state, and the screen's single back handler reaches it
  // through this closer. Its own Cancel is `disabled={busy}` while the
  // server call is in flight, so the press is refused there too.
  closerRef.current = () => {
    if (confirming === null) return false;
    if (busy) return true;
    setConfirming(null);
    return true;
  };
  useEffect(() => {
    const ref = closerRef;
    return () => {
      ref.current = NOTHING_OPEN;
    };
  }, [closerRef]);

  const act = useCallback(
    async (which: 'adopt' | 'revoke') => {
      setBusy(true);
      setNote(null);
      try {
        const token = await currentToken();
        if (!token) throw new Error('no session');
        if (which === 'adopt') await apiCrewAdopt(token, peerId);
        else await apiIntegrationRevoke(token, peerId);
        // The one moment the app KNOWS (rule in machine.ts): a 204
        // from either owner-called route is the server confirming this peer
        // is a machine this account paired. Record it — the AI badge and the
        // roster attribution derive from this record and from nothing a peer
        // can send. Refusals never reach this line, so they record nothing.
        await db.recordMachinePeer(peerId, Date.now()).catch(() => {});
        // Sibling sync 'machines': siblings hear the machine roster moved —
        // what lets a surviving device name a revoked sibling's agents.
        void messaging.syncMachinePeers();
        setNote({ tone: 'ok', text: which === 'adopt' ? MACHINE.adopted : MACHINE.revoked });
        setConfirming(null);
      } catch (err) {
        setNote({ tone: 'err', text: machineFailureCopy(err) });
      } finally {
        setBusy(false);
      }
    },
    [peerId],
  );

  return (
    <View style={styles.machine} testID="peer-machine">
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {MACHINE.title}
      </Text>
      {/* Keep both data-sharing disclosures above the actions in the idle
          and confirmation states so they remain visible throughout adoption.
          Placing them inside the confirmation branch or below the buttons
          would let someone begin the action before reading what it shares. */}
      <Text
        style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkBody }]}
        testID="peer-machine-ai"
      >
        {MACHINE.agentIsAI}
      </Text>
      <Text
        style={[t.type.compactBody, styles.explainerLine, { color: t.color.inkBody }]}
        testID="peer-machine-disclosure"
      >
        {MACHINE.disclosure}
      </Text>
      <InfoDisclosure
        label={MACHINE.explainLabel}
        lines={MACHINE.explain}
        testID="peer-machine-info"
      />
      {confirming === null ? (
        <>
          <TextAction
            label={MACHINE.adopt}
            onPress={() => {
              setNote(null);
              setConfirming('adopt');
            }}
            disabled={busy}
            testID="peer-machine-adopt"
          />
          <OutlineButton
            label={MACHINE.revoke}
            tone="warning"
            onPress={() => {
              setNote(null);
              setConfirming('revoke');
            }}
            disabled={busy}
            testID="peer-machine-revoke"
            style={styles.action}
          />
        </>
      ) : (
        <View style={styles.confirm}>
          <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
            {confirming === 'adopt' ? MACHINE.adoptConfirmQuestion : MACHINE.revokeConfirmQuestion}
          </Text>
          {confirming === 'adopt' ? (
            <TextAction
              label={MACHINE.adoptConfirm}
              onPress={() => void act('adopt')}
              disabled={busy}
              testID="peer-machine-adopt-confirm"
            />
          ) : (
            <OutlineButton
              label={MACHINE.revokeConfirm}
              tone="warning"
              onPress={() => void act('revoke')}
              disabled={busy}
              testID="peer-machine-revoke-confirm"
              style={styles.action}
            />
          )}
          <View style={styles.confirmOut}>
            <TextAction
              label={MACHINE.cancel}
              onPress={() => setConfirming(null)}
              disabled={busy}
              testID="peer-machine-cancel"
            />
          </View>
        </View>
      )}
      {note !== null &&
        (note.tone === 'err' ? (
          <InlineError message={note.text} testID="peer-machine-error" />
        ) : (
          <Text
            style={[t.type.compactBody, { color: t.color.pine }]}
            testID="peer-machine-ok"
          >
            {note.text}
          </Text>
        ))}
    </View>
  );
}

// Shared action components keep button padding and disabled states consistent
// across screens.

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 32, alignItems: 'center' },
  column: { width: '100%' },
  headerSpacer: { width: 44, height: 44 },

  hero: { marginTop: 24, alignItems: 'center' },
  heroAvatar: { marginTop: 20 },
  heroName: { marginTop: 16, textAlign: 'center' },
  heroSharedAs: { marginTop: 6, maxWidth: 320, textAlign: 'center' },
  heroAbout: { marginTop: 6, maxWidth: 320, textAlign: 'center' },
  heroSource: { marginTop: 12, maxWidth: 320, textAlign: 'center' },

  nickname: { marginTop: 28 },
  field: { marginTop: 8, minHeight: 52, paddingHorizontal: 14 },
  nicknameActions: { flexDirection: 'row', marginLeft: -8, marginBottom: 4 },

  identity: { marginTop: 28 },

  safety: { marginTop: 28 },
  blocking: { marginTop: 28 },
  deviceRow: { marginTop: 12 },
  pairActions: { flexDirection: 'row', alignItems: 'center', marginLeft: -8 },
  machine: { marginTop: 28 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  statusRule: {
    width: 3,
    alignSelf: 'stretch',
    minHeight: 15,
    marginRight: 12,
  },
  grid: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.333%' },
  disappearRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  disappearChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
  },
  calls: { marginTop: 28 },
  // The timer chips' geometry, under its own name rather than shared with
  // them: three labels that are words rather than durations wrap at a
  // different width, and a shared token would make tuning one retune the
  // other. `flexWrap` earns its place here — "Always relay" and "Allow direct"
  // do not fit beside each other on a small phone at large text sizes.
  relayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  relayChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
  },
  explainerLine: { marginTop: 8 },
  /** Its own breathing room under the identity sheet — one line, no rule,
   * no heading; it is context, not a section. */
  originLine: { marginTop: 12 },
  panel: { marginTop: 12, borderLeftWidth: 3, padding: 12 },
  panelLine: { marginTop: 8 },
  action: { marginTop: 12 },
  confirm: { marginTop: 16 },
  // Negative margin keeps the label optically on the gutter despite the
  // pressable's own padding, as the shared inline actions do.
  confirmOut: { marginTop: 4, marginLeft: -8, alignSelf: 'flex-start' },
  // The report reasons' chip geometry, under its own name for the relay
  // row's reason: five labels that are phrases wrap at their own width,
  // and a shared token would make tuning one retune the others.
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  reasonChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
  },
});
