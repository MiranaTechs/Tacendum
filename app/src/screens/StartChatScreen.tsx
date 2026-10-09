import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_PHONE_COPY } from '../accountsPhoneCopy';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { useKeyboardInset } from '../keyboardInset';
import { LINKING_COPY } from '../linkingCopy';
import { messaging } from '../messaging';
import {
  PickCancelled,
  PickDenied,
  PickTooLarge,
  pickImageFile,
} from '../media';
import { ID_LENGTH, idAttempt, idProblem } from '../peerId';
import { sanitizeDisplayName, spellId } from '../person';
import { PHONE_UI_ENABLED } from '../phoneUi';
import * as qr from '../qr';
import {
  classifyReach,
  groupId,
  groupIdLines,
  insertedRun,
  smartPastedIds,
  type Reach,
} from '../reachClassifier';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { usePaneWidth } from '../windowClass';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  InlineError,
  InlineNotice,
  OutlineButton,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { askCameraAgainAndroid, cameraAfterEmptyScan } from './startChat/cameraAccess';
import { FoundCard } from './startChat/FoundCard';
import { ClearGlyph, ScanGlyph } from './startChat/glyphs';
import { MyIdSection, type MyIdCopy } from './startChat/MyIdSection';
import { ReachHint, type ReachHintProps } from './startChat/ReachHint';
import { LOOKUPS_PER_DAY, useReachLookup, type FindPhase, type PreflightFailure } from './startChat/useReachLookup';

interface Props {
  profile: db.ProfileRow;
  onBack: () => void;
  onOpenChat: (peerId: string) => void;
  /** "Link an email" from a find answer. Receives the field's text, so the
   * way back can put it in the field again. */
  onOpenAccountEmail?: (draft: string) => void;
  /** The field's text, handed back after the Link-an-email detour. Seeds the
   * field once, as typed text; nothing is looked up until Find. */
  initialDraft?: string;
}

/**
 * Every pin-neutral string on this screen. (The username class's words live
 * in its own deck and are chosen at render time, only under its pin.)
 *
 * EXPORTED, and for one reason: `ProfileScreen` shows the same QR under the
 * same words, so it reads `qrShow` / `qrHide` from here rather than spelling
 * a second literal that matches until someone rewords one of them.
 */
export const COPY = {
  title: 'Open a room',
  reachHeading: 'Who do you want to reach?',
  // Short enough that the last word is never cut off at 360 dp or at larger
  // text; the field's accessible name below is the full sentence.
  fieldPlaceholder: 'Paste their ID or email',
  fieldLabel: 'Their Tacendum ID or email',
  fieldHint: 'Paste or type it. You can also scan their QR code.',
  clear: 'Clear',

  kindId: 'Tacendum ID',
  kindEmail: 'Email',
  kindSelf: 'That’s you',
  selfStatusId: 'Your ID',
  selfStatusEmail: 'Your email',
  idCounter: (n: number) => `${n} of ${ID_LENGTH}`,
  idCompleteA11y: 'complete',
  idTooLongA11y: 'too long',
  idHasU: 'An ID never has the letter U',
  emailUnfinished: 'Finish the address',
  unknownHint: 'Not an ID or email yet',
  existingChat: (name: string) => `You already have a room with ${name}`,
  existingRoom: (name: string | null) =>
    name ? `Your group “${name}”` : 'One of your groups',

  // Every action's accessible name opens with its visible label, unbroken,
  // so a person who says the words on the button ("Open room", "Find")
  // reaches it by voice.
  startButton: 'Open room',
  openChat: 'Open room',
  openChatA11y: (name: string) => `Open room with ${name}`,
  openRoom: 'Open room',
  openRoomA11y: (name: string | null) => (name ? `Open room ${name}` : 'Open room'),
  findButton: 'Find',
  findA11yEmail: 'Find this email',
  findBusy: 'Finding…',
  checkingBusy: 'Checking…',

  pasteFilled: 'Found one ID in what you pasted. Check it with them, then open the room.',
  qrFilled: 'Read from their QR code. Check the ID with them, then open the room.',
  pasteMultiple:
    'That text has more than one Tacendum ID. Tacendum won’t guess which one is theirs — paste a message with a single ID.',
  pasteNotAnId:
    'That’s a web link, not a Tacendum ID. An ID is never part of a link — ask them to send it on its own.',
  selfNotice: 'Ask them for theirs, or let them scan your QR code.',
  showMyId: 'Show my ID',

  errorOwnId: 'That’s your own ID. Ask them for theirs.',
  errorOwnEmail: 'That’s your own email. Ask them for theirs.',
  errorShort: (n: number) =>
    `That’s ${n} of ${ID_LENGTH} characters. Ask them for the whole ID.`,
  errorLong: (n: number) =>
    `That’s ${n} characters — a Tacendum ID is exactly ${ID_LENGTH}.`,
  errorU:
    'A Tacendum ID never contains the letter U. Check that character with them.',
  errorIncomplete: 'Enter the full ID exactly as it was shared with you.',
  errorLocal: 'We couldn’t open this room. Try again.',
  errorUnknown: 'That isn’t an ID or an email. Check what they sent you.',
  errorEmailShape: 'That email address isn’t complete. Check it with them.',

  // ── Reading their QR ────────────────────────────────────────
  or: 'or',
  qrScan: 'Scan their QR code',
  qrPick: 'Choose a photo of their QR code',
  qrNone:
    'There’s no QR code in that photo. Choose the picture they sent you, or type their ID instead.',
  qrMultiple:
    'That photo has more than one QR code. Tacendum won’t guess which one is theirs — choose a photo with a single code.',
  qrNotAnId:
    'That QR code isn’t a Tacendum ID. It might be a Wi-Fi code or a web link — check you picked the right picture.',
  qrOwnId: 'That’s your own QR code. Ask them for theirs.',
  qrTooBig: 'That photo is too large to read. Choose a smaller one.',
  // Byte-identical to ProfileScreen.tsx — the same iOS condition must never
  // get two different sentences.
  qrPhotosDenied:
    'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
  qrUnreadable: 'Tacendum couldn’t read that photo. Choose another one.',
  openSettings: 'Open Settings',
  // The Link-device sentence for the same condition, imported, never retyped.
  cameraFailed: LINKING_COPY.cameraFailed,
  cameraBroken: 'Tacendum couldn’t open the camera. Choose a photo of their QR code instead.',
  cameraRetry: 'Try again',

  // ── How people find each other (the ⓘ) ──────────────────────
  reachInfoLabel: 'How people find each other',
  infoNoDirectory:
    'Tacendum has no public directory. A room starts with a Tacendum ID one person hands the other — or with the email of someone who chose to be found.',
  reachInfoLine2: 'Their QR code is under My ID, on this screen in their app.',
  reachInfoLine3:
    'Scanning or pasting only fills in the field. Check the ID with them before you start — one wrong character reaches nobody, or someone else.',
  reachInfoScopeEmail:
    'An email finds only someone who verified it and chose to be found. Searches are limited each day.',

  // ── Find answers ────────────────────────────────────────────
  foundDevices: (n: number) => (n === 1 ? 'Found · 1 device' : `Found · ${n} devices`),
  foundStartA11y: (label: string) => `Open room with ${label}`,
  foundAnnounce: (label: string) => `Found ${label}`,
  foundInfoLabel: 'Is this really them?',
  foundInfoEmail: [
    'Finding someone by email shows that an account answers to that address. It doesn’t prove who is holding it.',
    'To be sure it’s them, compare safety numbers in person or on a call. Being found changes who you can reach, never how much they are trusted.',
  ],
  // The budget clause (D3, 2026-10-08): the day's searches are shared by
  // the account's linked devices and reset at midnight UTC, so fast testing
  // on two devices reads as what it is, not as "broken".
  missLine:
    'No match — or you’ve used today’s searches. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.',
  missLineEmail:
    'No match — or your account is under three days old, or today’s searches are used up. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.',
  /** The email miss when the account holds an email THIS device cannot
   * match the typed text against (a linked sibling — the proof pass,
   * 2026-10-08): the self case joins the visible line. The device that
   * linked the address catches its own before sending, so it never sees
   * this one. */
  missLineEmailMaybeSelf:
    'No match — or your account is under three days old, or today’s searches are used up, or it’s your own: your own email always shows no match. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.',
  /** One more lookup for the text that missed (D6). */
  searchAgain: 'Search again',
  /** The device's own brake, before the wire would refuse as a miss (D3):
   * the minute's lifts by itself, the day's waits for midnight UTC. */
  pacedMinute: 'Up to five searches a minute — wait a moment.',
  pacedDay: (n: number) =>
    `This device has sent today’s ${n} searches. Searches are shared by your linked devices and reset at midnight UTC.`,
  // The self clause (D1, 2026-10-08) is said by the shared email deck's
  // last line (ACCOUNTS_COPY.discoverExplain), which this sheet appends —
  // once, not twice (the gate pass: the lead carried it too and the sheet
  // read the same rule in two consecutive lines).
  missInfoLeadEmail:
    'A miss can mean the email isn’t on Tacendum, its owner hasn’t chosen to be found or is recovering their account — or your searches for today are used up.',
  needsOwnEmail: 'To search, verify an email on your account first.',
  linkEmail: 'Link an email',
  findOffline: ACCOUNTS_COPY.failed,
  retry: 'Try again',

  // ── My ID ───────────────────────────────────────────────────
  myIdTitle: 'My ID',
  myIdSubtitle: 'Let someone reach you',
  showOwnId: 'Show my ID',
  hideOwnId: 'Hide my ID',
  ownIdHint: 'Read this out to the person you want to reach.',
  copyId: 'Copy ID',
  shareId: 'Share ID',
  // Byte-identical on ProfileScreen and ChatListScreen — the same copy
  // action must never get two different sentences.
  copied:
    'Copied. Paste it into a text — or read it out loud, four letters at a time.',
  myIdInfoLabel: 'Who should have your ID',
  myIdInfo: [
    'Give your ID only to people you trust. Anyone who has it can open a room with you.',
    'Text it, read it out loud four letters at a time, or let them scan your QR code.',
  ],
  // The share text itself is `shareIdMessage` (peerId.ts): one helper, so
  // every surface sends the ID on a line of its own.

  nameLabel: 'Who is this?',
  // The device is named in the platform's own words via the token.
  namePlaceholder: `Their name on this ${DEVICE_NOUN}`,
  nameHelper: `Just a label on this ${DEVICE_NOUN}. They never see it.`,
  nameSave: 'Save and open',
  nameSkip: 'Skip',

  // ── Your QR (read by ProfileScreen) ─────────────────────────
  qrShow: 'Show QR code',
  qrHide: 'Hide QR code',
} as const;

const MY_ID_COPY: MyIdCopy = {
  title: COPY.myIdTitle,
  subtitle: COPY.myIdSubtitle,
  show: COPY.showOwnId,
  hide: COPY.hideOwnId,
  ownIdHint: COPY.ownIdHint,
  copyId: COPY.copyId,
  shareId: COPY.shareId,
  copied: COPY.copied,
  infoLabel: COPY.myIdInfoLabel,
  info: COPY.myIdInfo,
};

/** How long letter-led or unknown text must rest before the row names it:
 * typing an email must not be called a username from its first letter. */
const SETTLE_MS = 600;
/** Room above My ID when an opening scrolls it into view. */
const MY_ID_SCROLL_MARGIN = 16;
/** The clear button's square, and the field's right padding while it shows. */
const CLEAR_SIZE = 44;

/** The grouping `idProblem` ignores, so the count counts what it counts. */
const GROUPING = /[\s\-_.,:;/|()[\]]/g;

function typedLength(raw: string): number {
  return raw.replace(GROUPING, '').length;
}

/** Why an ID was refused, said specifically enough to act on. Judged on the
 * ID ATTEMPT, not the whole field: a sentence pasted around a short ID used
 * to earn "never contains the letter U" — for the U in Tacendum. */
function idError(raw: string): string {
  const attempt = idAttempt(raw);
  const n = typedLength(attempt);
  switch (idProblem(attempt)) {
    case 'u':
      return COPY.errorU;
    case 'short':
      return COPY.errorShort(n);
    case 'long':
      return COPY.errorLong(n);
    default:
      return COPY.errorIncomplete;
  }
}

/**
 * Every way reading a picture can fail, in our own words. The thrown text is
 * never shown — the class is the contract.
 */
function photoError(err: unknown): string {
  if (err instanceof PickDenied) return COPY.qrPhotosDenied;
  if (err instanceof PickTooLarge) return COPY.qrTooBig;
  if (err instanceof qr.QrNoCode) return COPY.qrNone;
  if (err instanceof qr.QrAmbiguous) return COPY.qrMultiple;
  if (err instanceof qr.QrNotAnId) return COPY.qrNotAnId;
  if (err instanceof qr.QrOwnId) return COPY.qrOwnId;
  return COPY.qrUnreadable;
}

/** The one message slot: a notice or an error at the field, a local find
 * refusal, or an error at the photo link with its button. A new one replaces
 * the old, so an error and a notice are never on screen together. */
type Answer =
  | { kind: 'notice'; message: string }
  | {
      kind: 'error';
      at: 'field' | 'photo';
      message: string;
      action?: 'photoSettings' | 'cameraSettings' | 'cameraRetry';
    }
  | { kind: 'invalid'; message: string };

/** What this device already holds for a complete ID, keyed to that ID so a
 * label can never outlive the text it was read for. */
type Existing =
  | { key: string; kind: 'chat'; name: string }
  | { key: string; kind: 'room'; name: string | null };

function selfHint(status: string): ReachHintProps {
  return {
    glyph: 'person',
    label: COPY.kindSelf,
    labelTone: 'strong',
    spoken: `${COPY.kindSelf}, ${status}`,
    status: { text: status, tone: 'muted' },
  };
}

/** The username deck with the sentence the preflight's REFUSED answer reads
 * (U3, 2026-10-08): `eligibilityRefused`, the neutral sentence for the frozen
 * 403 — the caller's budget or a dark flag, never a connection problem. It
 * lives in the deck, which another lane of the same train adds it to; until
 * that key exists this build keeps the connection sentence for both. */
type UsernameDeck = typeof ACCOUNTS_USERNAME_COPY & { readonly eligibilityRefused?: string };

function preflightSentence(reason: PreflightFailure): string {
  const deck: UsernameDeck = ACCOUNTS_USERNAME_COPY;
  if (reason === 'refused' && deck.eligibilityRefused !== undefined) {
    return deck.eligibilityRefused;
  }
  return deck.eligibilityUnavailable;
}

/** The hint row for what the field holds, or null when there is nothing to
 * name. Every string is chosen here; the row only draws it. */
function hintFor(
  reach: Reach,
  context: { focused: boolean; handlesLive: boolean; existing: Existing | null },
): ReachHintProps | null {
  switch (reach.kind) {
    case 'empty':
      return null;
    case 'unknown': {
      const sentence = context.handlesLive
        ? ACCOUNTS_USERNAME_COPY.startChatUnknown
        : COPY.unknownHint;
      return { glyph: null, label: sentence, labelTone: 'muted', spoken: sentence };
    }
    case 'id': {
      if (reach.self) return selfHint(COPY.selfStatusId);
      if (reach.id !== null) {
        const base = {
          glyph: 'id' as const,
          label: COPY.kindId,
          labelTone: 'strong' as const,
          spoken: `${COPY.kindId}, ${COPY.idCompleteA11y}`,
          readback: { text: groupIdLines(reach.id), spoken: spellId(reach.id) },
        };
        const known = context.existing;
        if (known) {
          return {
            ...base,
            status: {
              text:
                known.kind === 'chat'
                  ? COPY.existingChat(known.name)
                  : COPY.existingRoom(known.name),
              tone: 'muted',
            },
          };
        }
        return {
          ...base,
          counter: { text: COPY.idCounter(ID_LENGTH), tone: 'pine', check: true },
        };
      }
      if (reach.problem === 'u') {
        return {
          glyph: 'id',
          label: COPY.kindId,
          labelTone: 'strong',
          spoken: `${COPY.kindId}, ${COPY.idHasU}`,
          status: { text: COPY.idHasU, tone: 'danger' },
        };
      }
      if (reach.count > ID_LENGTH) {
        return {
          glyph: 'id',
          label: COPY.kindId,
          labelTone: 'strong',
          spoken: `${COPY.kindId}, ${COPY.idTooLongA11y}`,
          counter: { text: COPY.idCounter(reach.count), tone: 'danger', check: false },
        };
      }
      return {
        glyph: 'id',
        label: COPY.kindId,
        labelTone: 'strong',
        spoken: COPY.kindId,
        counter: { text: COPY.idCounter(reach.count), tone: 'muted', check: false },
      };
    }
    case 'email': {
      if (reach.self) return selfHint(COPY.selfStatusEmail);
      // "Finish the address" stays visible, but is not spoken while the
      // person is still typing it.
      const unfinished = !reach.valid;
      return {
        glyph: 'mail',
        label: COPY.kindEmail,
        labelTone: 'strong',
        spoken:
          unfinished && !context.focused
            ? `${COPY.kindEmail}, ${COPY.emailUnfinished}`
            : COPY.kindEmail,
        ...(unfinished ? { status: { text: COPY.emailUnfinished, tone: 'muted' as const } } : {}),
      };
    }
    case 'handle': {
      if (reach.self) return selfHint(ACCOUNTS_USERNAME_COPY.startChatSelfStatus);
      const rule = reach.normalized === null && reach.label.length >= 3;
      const label = ACCOUNTS_USERNAME_COPY.findClass;
      return {
        glyph: 'person',
        label,
        labelTone: 'strong',
        spoken: rule ? `${label}, ${ACCOUNTS_USERNAME_COPY.startChatHandleRule}` : label,
        ...(rule
          ? { status: { text: ACCOUNTS_USERNAME_COPY.startChatHandleRule, tone: 'muted' as const } }
          : {}),
      };
    }
  }
}

/**
 * Open a room: one question over one field that understands a Tacendum ID,
 * a username or an email, says which before anything happens, and offers the
 * one action that can succeed — Open room (spoken with the name of someone
 * you already have) or Find.
 * Scan their QR code sits under it; My ID waits, collapsed, at the bottom.
 *
 * The rules it keeps:
 *  - a scan, a photo or a paste only ever FILLS the field; the person
 *    commits, because there is no directory to catch a wrong ID;
 *  - nothing is looked up while typing or pasting, for yourself, or for
 *    malformed input — only Find or the go key, and never twice for someone
 *    already found on this visit;
 *  - the clipboard is never read: a paste is the shape of the change;
 *  - a button shows only when its press can succeed; the go key explains
 *    everything else;
 *  - no account ID is ever rendered on the find path: the card carries what
 *    the person typed.
 */
export function StartChatScreen({
  profile,
  onBack,
  onOpenChat,
  onOpenAccountEmail,
  initialDraft,
}: Props) {
  const t = useTheme();
  // THE keyboard mechanism (keyboardInset.ts): paddingBottom on the root,
  // because this screen renders inside a transformed route transition that
  // defeats an avoiding view's own-frame measurement.
  const keyboardInset = useKeyboardInset();
  const paneWidth = usePaneWidth();
  const reduceMotion = useReduceMotion();
  // Read at render time: the pin decides which words and which classes exist.
  const handlesLive = USERNAME_UI_ENABLED;
  /** Bumped with every new answer, so an identical repeated failure is
   * announced again (InlineError's effect keys on [message, seq]). */
  const [attempt, setAttempt] = useState(0);
  const bump = useCallback(() => setAttempt(n => n + 1), []);
  const {
    phase,
    selfKeys,
    selfKeysLoaded,
    handleShape,
    supersede,
    find: findTarget,
    retry: retryFind,
    retryEligibility,
    searchAgain,
    openFound,
  } = useReachLookup({ userId: profile.userId, onOpenChat, onOpenFailed: bump });

  /** The field, exactly as typed (never folded or stripped while typing). */
  const [draft, setDraft] = useState(initialDraft ?? '');
  /** Where the characters in the field came from: a code only ever fills the
   * field, so the rail is remembered here and recorded when the person
   * commits. Any change makes it 'manual' — a provenance that survived an
   * edit would vouch for characters nobody scanned. */
  const [draftSource, setDraftSource] = useState<'qr' | 'manual'>('manual');
  const [focused, setFocused] = useState(false);
  const [settled, setSettled] = useState(true);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the hint row's kind node said at the last settle (see `hint`). */
  const [settledSpoken, setSettledSpoken] = useState<string | null>(null);
  /** The kind iOS last heard, shared with every mount of the row, so a row
   * that comes back with the same words never says them twice. */
  const announcedKind = useRef<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [picking, setPicking] = useState(false);
  const cameraRefusals = useRef(0);
  const [cameraFocusRequest, setCameraFocusRequest] = useState(0);
  const [existing, setExisting] = useState<Existing | null>(null);
  const precheckSeq = useRef(0);
  const [naming, setNaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [myIdOpen, setMyIdOpen] = useState(false);
  const [scrollRequest, setScrollRequest] = useState(0);

  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  /** The lookup notice's sentence: focus lands here when it replaces Find. */
  const missRef = useRef<Text>(null);
  /** The button under the photo answer: focus moves to it when Try again
   * turns into Open Settings in place. */
  const cameraSlotRef = useRef<View>(null);
  const columnY = useRef(0);
  const sectionY = useRef(0);
  const reduceMotionRef = useRef(reduceMotion);
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
  }, [reduceMotion]);

  const reach = useMemo(
    () => classifyReach(draft, selfKeys, { handleShape: handlesLive ? handleShape : null }),
    [draft, selfKeys, handlesLive, handleShape],
  );
  const isSelf =
    (reach.kind === 'id' || reach.kind === 'email' || reach.kind === 'handle') && reach.self;
  // Letter-led text could still become an email ("alice" → "alice@…"), so
  // it is named only after the settle; @-led text and emails are named at
  // once.
  const letterLed = reach.kind === 'handle' && !draft.trim().startsWith('@');
  const pending = !settled && (reach.kind === 'unknown' || letterLed);

  const clearSettle = useCallback(() => {
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);
  const restartSettle = useCallback(() => {
    clearSettle();
    setSettled(false);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettled(true);
    }, SETTLE_MS);
  }, [clearSettle]);
  // Leaving clears the timer, so nothing writes to a screen that is gone.
  useEffect(() => clearSettle, [clearSettle]);

  // THE EXISTING-PERSON CHECK behind "Open room with …": a local read,
  // keyed to the ID it answers and sequence-guarded, so a slow answer can
  // never paint a label over different text. It never writes; the commit
  // path reads again, so a label can never change what the press does.
  const existingKey = reach.kind === 'id' && !reach.self ? reach.id : null;
  useEffect(() => {
    precheckSeq.current += 1;
    const seq = precheckSeq.current;
    if (existingKey === null) return;
    void (async () => {
      const room = await db.getGroup(existingKey).catch(() => null);
      if (precheckSeq.current !== seq) return;
      if (room) {
        setExisting({ key: existingKey, kind: 'room', name: room.name ?? null });
        return;
      }
      const chat = await db.getChat(existingKey).catch(() => null);
      if (precheckSeq.current !== seq) return;
      setExisting(
        chat?.localName ? { key: existingKey, kind: 'chat', name: chat.localName } : null,
      );
    })();
  }, [existingKey]);
  useEffect(
    () => () => {
      precheckSeq.current += 1;
    },
    [],
  );
  const existingNow = existing !== null && existing.key === existingKey ? existing : null;

  const showFieldError = useCallback(
    (message: string) => {
      setAnswer({ kind: 'error', at: 'field', message });
      bump();
    },
    [bump],
  );

  const changeDraft = useCallback(
    (next: string) => {
      // Any change is the person's: a pasted ID is theirs to check and
      // commit, the same as a typed one (a paste is not a scan). It is a new
      // attempt, so the last answer and any lookup about older text go.
      setDraftSource('manual');
      setAnswer(null);
      supersede();
      restartSettle();

      // A PASTE is more than one character arriving in one change, detected
      // from what the change inserted and nothing else: the clipboard is
      // never read (`Clipboard.getString` raises the iOS paste prompt, and
      // pasteboard.ts treats every read as a leak surface).
      if (insertedRun(draft, next).length > 1) {
        const pasted = smartPastedIds(next, profile.userId, handlesLive ? handleShape : null);
        if (pasted.ids.length === 1) {
          // The field, not the chat: the 26 characters have to be seen before
          // anything is sent. Grouped in fours, the way their My ID shows it.
          const id = pasted.ids[0]!;
          setDraft(groupId(id));
          // Your own ID gets the self notice instead (it renders on its own).
          if (id !== profile.userId) setAnswer({ kind: 'notice', message: COPY.pasteFilled });
          bump();
          return;
        }
        if (pasted.ids.length > 1 || pasted.inUriOnly) {
          // A refusal never leaves a half-filled field behind, and never
          // picks: taking the first of two is a silent guess, and an ID
          // inside a link is a slug.
          setDraft('');
          setAnswer({
            kind: 'error',
            at: 'field',
            message: pasted.ids.length > 1 ? COPY.pasteMultiple : COPY.pasteNotAnId,
          });
          bump();
          return;
        }
        if (pasted.fill !== null) {
          // No ID, but exactly one address: just that, and Find stays a press.
          setDraft(pasted.fill);
          return;
        }
        // Nothing to read in it: exactly what typing the same text does.
      }
      setDraft(next);
    },
    [draft, profile.userId, handlesLive, handleShape, supersede, restartSettle, bump],
  );

  const startChat = useCallback(() => {
    // The go key with nothing typed is not an attempt, so it is not an error.
    if (draft.trim() === '') return;
    // The classifier's ID, never a raw extract of the field: an entry with
    // one character too many must never be trimmed to somebody else's ID.
    if (reach.kind !== 'id' || reach.id === null) {
      showFieldError(idError(draft));
      return;
    }
    const peerId = reach.id;
    if (peerId === profile.userId) {
      showFieldError(COPY.errorOwnId);
      return;
    }
    void (async () => {
      try {
        // A ROOM FIRST. A room's conversation row IS its ULID, so an upsert
        // here would put a person-shaped row over a room and strand queued
        // fan-out legs. A room is opened, never created or named here.
        const room = await db.getGroup(peerId);
        if (room !== null) {
          setAnswer(null);
          onOpenChat(peerId);
          return;
        }
        // A PERSON ALREADY NAMED: asking "Who is this?" again is a question
        // with no useful answer. The upsert still runs: it fills a missing
        // provenance only (COALESCE) and never renames the row.
        const known = await db.getChat(peerId);
        if (known?.localName) {
          await db.upsertChat(peerId, undefined, draftSource);
          setAnswer(null);
          onOpenChat(peerId);
          return;
        }
        // Everyone else gets the naming step, prefilled with the name they
        // shared when there is one.
        await db.upsertChat(peerId, undefined, draftSource);
        setNameDraft(known?.displayName ?? '');
      } catch {
        showFieldError(COPY.errorLocal);
        return;
      }
      setAnswer(null);
      // Naming happens at the one moment the person knows who this ID is.
      setNaming(peerId);
    })();
  }, [draft, reach, profile.userId, draftSource, onOpenChat, showFieldError]);

  /** Find for the field's email or username, after the local shape checks:
   * a malformed one is refused here and never spends a lookup. Until this
   * device has read who "you" are, nothing is looked up at all: your own
   * address must never spend a search, nor read as a miss. */
  const findReach = useCallback(() => {
    if (!selfKeysLoaded) return;
    if (reach.kind === 'email') {
      if (!reach.valid) {
        setAnswer({ kind: 'invalid', message: COPY.errorEmailShape });
        bump();
        return;
      }
      findTarget({ kind: 'email', label: reach.label });
      return;
    }
    if (reach.kind === 'handle') {
      if (reach.normalized === null) {
        setAnswer({ kind: 'invalid', message: ACCOUNTS_USERNAME_COPY.invalid });
        bump();
        return;
      }
      findTarget({ kind: 'handle', label: reach.label });
    }
  }, [selfKeysLoaded, reach, findTarget, bump]);

  /** The go key and the hardware Return: the field's own action, or the
   * local explanation. It never presses a found card's button. */
  const submit = useCallback(() => {
    clearSettle();
    setSettled(true);
    if (reach.kind === 'empty') return;
    if (isSelf) {
      showFieldError(
        reach.kind === 'id'
          ? COPY.errorOwnId
          : reach.kind === 'email'
            ? COPY.errorOwnEmail
            : ACCOUNTS_USERNAME_COPY.startChatSelfError,
      );
      return;
    }
    if (reach.kind === 'unknown') {
      showFieldError(
        handlesLive ? ACCOUNTS_USERNAME_COPY.startChatErrorUnknown : COPY.errorUnknown,
      );
      return;
    }
    if (reach.kind === 'id') {
      startChat();
      return;
    }
    if (phase.name !== 'idle') return;
    findReach();
  }, [
    clearSettle,
    reach,
    isSelf,
    handlesLive,
    phase.name,
    startChat,
    findReach,
    showFieldError,
  ]);

  const readFromCamera = useCallback(() => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        const peerId = await qr.readIdFromCamera(profile.userId);
        // The field, not the chat — the 26 characters have to be seen before
        // anything is sent. A fill is the one camera outcome that drops a
        // lookup answer: the answer was about text that is gone.
        setDraft(groupId(peerId));
        setDraftSource('qr');
        setAnswer({ kind: 'notice', message: COPY.qrFilled });
        supersede();
        bump();
      } catch (err) {
        if (err instanceof qr.QrNoCode) {
          // Empty: a cancel, or a refused camera (both scanners report a
          // refusal as a cancel). Only now is the permission read.
          const reason = await cameraAfterEmptyScan();
          // A cancel is silent and changes nothing, a found card included.
          if (reason !== 'refused') return;
          cameraRefusals.current += 1;
          setAnswer({
            kind: 'error',
            at: 'photo',
            message: COPY.cameraFailed,
            action:
              Platform.OS === 'android' && cameraRefusals.current === 1
                ? 'cameraRetry'
                : 'cameraSettings',
          });
          bump();
          return;
        }
        if (err instanceof qr.QrImageUnreadable) {
          // The scanner module itself rejected (rare): not a photo problem.
          setAnswer({ kind: 'error', at: 'photo', message: COPY.cameraBroken });
          bump();
          return;
        }
        setAnswer({ kind: 'error', at: 'photo', message: photoError(err) });
        bump();
      } finally {
        setPicking(false);
      }
    })();
  }, [picking, profile.userId, supersede, bump]);

  /** Android Try again: ask the system directly, on the person's press. */
  const retryCamera = useCallback(() => {
    void (async () => {
      const outcome = await askCameraAgainAndroid();
      if (outcome === 'granted') {
        setAnswer(current =>
          current?.kind === 'error' && current.at === 'photo' ? null : current,
        );
        readFromCamera();
        return;
      }
      if (outcome === 'never') {
        // Android will not ask again: Settings, in place, without launching
        // a scanner that could only be refused.
        setAnswer(current =>
          current?.kind === 'error' && current.at === 'photo'
            ? { ...current, action: 'cameraSettings' }
            : current,
        );
        setCameraFocusRequest(n => n + 1);
      }
      // Still refused: Try again stays.
    })();
  }, [readFromCamera]);

  // The Try again button under the finger just turned into Open Settings:
  // move screen-reader focus to the new button once it has mounted.
  useEffect(() => {
    if (cameraFocusRequest === 0) return;
    const tag = findNodeHandle(cameraSlotRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [cameraFocusRequest]);

  const readFromPhoto = useCallback(() => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        const file = await pickImageFile('library');
        const peerId = await qr.readIdFromImage(file.uri, profile.userId);
        // The field, not the chat, under the camera's rules.
        setDraft(groupId(peerId));
        setDraftSource('qr');
        setAnswer({ kind: 'notice', message: COPY.qrFilled });
        supersede();
        bump();
      } catch (err) {
        // Backing out of the picker is not a new outcome: bumping here would
        // re-announce the previous answer for a pick that produced nothing.
        if (err instanceof PickCancelled) return;
        setAnswer({
          kind: 'error',
          at: 'photo',
          message: photoError(err),
          ...(err instanceof PickDenied ? { action: 'photoSettings' as const } : {}),
        });
        bump();
      } finally {
        setPicking(false);
      }
    })();
  }, [picking, profile.userId, supersede, bump]);

  const clearField = useCallback(() => {
    setDraft('');
    setDraftSource('manual');
    setAnswer(null);
    supersede();
    clearSettle();
    setSettled(true);
    // The button under the finger is gone: keep focus in the field.
    inputRef.current?.focus();
  }, [supersede, clearSettle]);

  const onFieldFocus = useCallback(() => setFocused(true), []);
  const onFieldBlur = useCallback(() => {
    setFocused(false);
    clearSettle();
    setSettled(true);
    // A complete ID is tidied into groups when the person leaves the field.
    // Display only: provenance, the answer and the lookup are untouched.
    if (reach.kind === 'id' && reach.id !== null) {
      const grouped = groupId(reach.id);
      if (draft !== grouped) setDraft(grouped);
    }
  }, [clearSettle, reach, draft]);

  // A lookup notice replaced the Find button that held focus: move focus to
  // the sentence once it has mounted (the found card moves its own).
  useEffect(() => {
    if (
      phase.name !== 'none' &&
      phase.name !== 'needsVerification' &&
      phase.name !== 'unavailable' &&
      phase.name !== 'error' &&
      phase.name !== 'paced'
    ) {
      return;
    }
    const tag = findNodeHandle(missRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [phase.name]);

  const openMyId = useCallback(() => {
    setMyIdOpen(true);
    setScrollRequest(n => n + 1);
  }, []);
  const toggleMyId = useCallback(() => {
    if (myIdOpen) setMyIdOpen(false);
    else openMyId();
  }, [myIdOpen, openMyId]);
  const showMyIdFromNotice = useCallback(() => {
    Keyboard.dismiss();
    openMyId();
  }, [openMyId]);

  // Every opening of My ID scrolls it into view on the next frame, once the
  // opened section has been laid out: on a small phone the chevron sits near
  // the bottom and the ID and QR would otherwise open below the fold.
  useEffect(() => {
    if (scrollRequest === 0) return undefined;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(0, columnY.current + sectionY.current - MY_ID_SCROLL_MARGIN),
        animated: !reduceMotionRef.current,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest]);

  const onSectionLayout = useCallback((y: number) => {
    sectionY.current = y;
  }, []);

  const saveName = useCallback(() => {
    const peerId = naming;
    if (peerId === null) return;
    // Sanitized at input: the typed label is stored as it will render.
    const name = sanitizeDisplayName(nameDraft);
    void (async () => {
      try {
        if (name !== '') {
          await db.setLocalName(peerId, name);
          // Siblings inherit the label. Best-effort.
          void messaging.syncLocalName(peerId, name);
        }
      } catch {
        // A label is a convenience; losing it must not block the chat.
      }
      onOpenChat(peerId);
    })();
  }, [naming, nameDraft, onOpenChat]);

  const skipName = useCallback(() => {
    if (naming === null) return;
    onOpenChat(naming);
  }, [naming, onOpenChat]);

  const fieldMessage =
    answer !== null && (answer.kind !== 'error' || answer.at === 'field') ? answer : null;
  const photoMessage =
    answer !== null && answer.kind === 'error' && answer.at === 'photo' ? answer : null;
  const fieldError = fieldMessage !== null && fieldMessage.kind !== 'notice';
  const isId = reach.kind === 'id';
  const showClear = draft !== '';
  // Mono only for an ID, sized from the pane so the 32 grouped characters
  // fit beside the clear button at 390 and wider; below that the read-back,
  // not the field, is what shows the whole ID.
  const monoSize = paneWidth >= 390 ? 15 : paneWidth >= 364 ? 14 : 13;
  // THE HINT ROW. Letter-led and unknown text is first named only after the
  // settle, so an email is never called a username from its first letter.
  // Once named, the row stays through every later wait in which the text
  // would still be named the same way: it used to vanish
  // on each keystroke and come back after each pause, so iOS announced the
  // kind again after nearly every letter, Android got a fresh live region
  // each time, and Find and the row below jumped. A wait that would change
  // the words still hides the row until the text settles.
  const named = hintFor(reach, { focused, handlesLive, existing: existingNow });
  const namedSpoken = named?.spoken ?? null;
  useEffect(() => {
    if (!pending) setSettledSpoken(namedSpoken);
  }, [pending, namedSpoken]);
  const hint = !pending || namedSpoken === settledSpoken ? named : null;
  // Emptying the field forgets the last kind iOS heard: a new entry is
  // announced afresh.
  useEffect(() => {
    if (reach.kind === 'empty') announcedKind.current = null;
  }, [reach.kind]);

  const canStart = reach.kind === 'id' && reach.id !== null && !reach.self;
  // Find, like the self notice, shows exactly while the row names the text;
  // and never before this device has read who "you" are.
  const findable =
    hint !== null &&
    !isSelf &&
    selfKeysLoaded &&
    ((reach.kind === 'email' && reach.valid) ||
      (reach.kind === 'handle' && reach.normalized !== null));
  const findBusy = phase.name === 'checking' || phase.name === 'searching';
  const showFind = findable && (phase.name === 'idle' || findBusy);
  const showSelfNotice =
    isSelf && hint !== null && answer === null && phase.name === 'idle';

  const reachInfo = handlesLive
    ? [
        ACCOUNTS_USERNAME_COPY.startChatNoDirectory,
        COPY.reachInfoLine2,
        COPY.reachInfoLine3,
        ACCOUNTS_USERNAME_COPY.startChatFindScope,
      ]
    : [COPY.infoNoDirectory, COPY.reachInfoLine2, COPY.reachInfoLine3, COPY.reachInfoScopeEmail];

  const renderLookup = (current: FindPhase): React.ReactNode => {
    switch (current.name) {
      case 'found':
        return (
          <FoundCard
            label={current.label}
            devicesLine={COPY.foundDevices(current.deviceCount)}
            existingLine={current.namedAs ? COPY.existingChat(current.namedAs) : null}
            buttonLabel={current.namedAs ? COPY.openChat : COPY.startButton}
            buttonA11y={
              current.namedAs
                ? COPY.openChatA11y(current.namedAs)
                : COPY.foundStartA11y(current.label)
            }
            infoLabel={COPY.foundInfoLabel}
            infoLines={
              current.kind === 'email'
                ? COPY.foundInfoEmail
                : ACCOUNTS_USERNAME_COPY.startChatFoundInfo
            }
            onStart={openFound}
            announce={COPY.foundAnnounce(current.label)}
            focusKey={`${current.kind}:${current.label}`}
            error={current.openFailed ? { message: COPY.errorLocal, seq: attempt } : undefined}
          />
        );
      case 'none':
        return (
          <>
            <InlineNotice
              tone="quiet"
              message={
                current.kind === 'email'
                  ? current.maybeSelf
                    ? COPY.missLineEmailMaybeSelf
                    : COPY.missLineEmail
                  : current.maybeSelf
                    ? ACCOUNTS_USERNAME_COPY.startChatMissLineMaybeSelf
                    : COPY.missLine
              }
              messageRef={missRef}
              action={{
                label: COPY.searchAgain,
                onPress: searchAgain,
                testID: 'discovery-search-again',
              }}
              testID="discovery-no-match"
            />
            <View style={styles.info}>
              <InfoDisclosure
                label={ACCOUNTS_COPY.discoverExplainLabel}
                lines={
                  current.kind === 'email'
                    ? [
                        COPY.missInfoLeadEmail,
                        ...(PHONE_UI_ENABLED
                          ? ACCOUNTS_PHONE_COPY.discoverExplainEmailBoth
                          : ACCOUNTS_COPY.discoverExplain),
                      ]
                    : [
                        ACCOUNTS_USERNAME_COPY.startChatMissInfoLead,
                        ...ACCOUNTS_USERNAME_COPY.findExplain,
                      ]
                }
                testID="discovery-info"
              />
            </View>
            {current.ownEmailHint ? (
              <InlineNotice
                tone="quiet"
                message={COPY.needsOwnEmail}
                action={
                  onOpenAccountEmail
                    ? {
                        label: COPY.linkEmail,
                        onPress: () => onOpenAccountEmail(draft),
                        testID: 'discovery-link-email',
                      }
                    : undefined
                }
                testID="discovery-needs-own-email"
              />
            ) : null}
          </>
        );
      case 'needsVerification':
        return (
          <>
            <InlineNotice
              tone="quiet"
              message={ACCOUNTS_USERNAME_COPY.startChatNeedsIdentifier}
              messageRef={missRef}
              action={
                onOpenAccountEmail
                  ? {
                      label: ACCOUNTS_USERNAME_COPY.needsIdentifierAction,
                      onPress: () => onOpenAccountEmail(draft),
                      testID: 'discovery-username-link-email',
                    }
                  : undefined
              }
              testID="discovery-username-needs-identifier"
            />
            <View style={styles.info}>
              <InfoDisclosure
                label={ACCOUNTS_USERNAME_COPY.startChatVerifyWhyLabel}
                lines={[ACCOUNTS_USERNAME_COPY.startChatVerifyWhy]}
                testID="discovery-info"
              />
            </View>
          </>
        );
      case 'unavailable':
        return (
          <InlineNotice
            tone="quiet"
            message={preflightSentence(current.reason)}
            messageRef={missRef}
            action={{
              label: ACCOUNTS_USERNAME_COPY.eligibilityRetry,
              onPress: retryEligibility,
              testID: 'discovery-username-eligibility-retry',
            }}
            testID="discovery-username-eligibility-unavailable"
          />
        );
      case 'error':
        return (
          <InlineNotice
            tone="quiet"
            message={COPY.findOffline}
            messageRef={missRef}
            action={{ label: COPY.retry, onPress: retryFind, testID: 'discovery-retry' }}
            testID="discovery-error"
          />
        );
      case 'paced':
        // No action: the minute's brake lifts itself and Find comes back;
        // the day's has nothing a press can change before midnight UTC.
        return (
          <InlineNotice
            tone="quiet"
            message={
              current.scope === 'minute' ? COPY.pacedMinute : COPY.pacedDay(LOOKUPS_PER_DAY)
            }
            messageRef={missRef}
            testID="discovery-paced"
          />
        );
      case 'invalid':
        return (
          <InlineError
            message={handlesLive ? ACCOUNTS_USERNAME_COPY.invalid : COPY.errorEmailShape}
            seq={attempt}
            testID="discovery-invalid"
          />
        );
      default:
        return null;
    }
  };

  const slotLabel = photoMessage?.action === 'cameraRetry' ? COPY.cameraRetry : COPY.openSettings;
  const slotTestID =
    photoMessage?.action === 'cameraRetry'
      ? 'start-chat-camera-retry'
      : photoMessage?.action === 'cameraSettings'
        ? 'start-chat-open-camera-settings'
        : 'start-chat-open-photo-settings';
  const onSlotPress = photoMessage?.action === 'cameraRetry'
    ? retryCamera
    : () => void Linking.openSettings();

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScreenHeader
        title={COPY.title}
        onBack={onBack}
        testIDBack="start-chat-back"
      />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: t.layout.gutter, paddingTop: t.space.s8 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* The reading column: sized against the pane it is handed, capped at
            contentMax, so a wide window never stretches the field. */}
        <View
          style={[styles.column, { maxWidth: t.layout.contentMax }]}
          onLayout={event => {
            columnY.current = event.nativeEvent.layout.y;
          }}
        >
          {naming === null ? (
            <>
              <Text
                testID="start-chat-heading"
                accessibilityRole="header"
                style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
              >
                {COPY.reachHeading}
              </Text>

              {/* The rest border lives on this container so the clear button
                  can sit inside it; focused is 2pt forest, an error danger. */}
              <View
                testID="new-peer-field"
                style={[
                  styles.field,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: t.color.paperSheet,
                    borderWidth: fieldError || focused ? 2 : 1,
                    borderColor: fieldError
                      ? t.color.danger
                      : focused
                        ? t.color.pine
                        : t.color.lineField,
                  },
                ]}
              >
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={changeDraft}
                  onFocus={onFieldFocus}
                  onBlur={onFieldBlur}
                  onSubmitEditing={submit}
                  placeholder={
                    handlesLive
                      ? ACCOUNTS_USERNAME_COPY.startChatFieldPlaceholder
                      : COPY.fieldPlaceholder
                  }
                  placeholderTextColor={t.color.inkMuted}
                  keyboardAppearance={t.scheme}
                  selectionColor={t.color.pine}
                  cursorColor={t.color.pine}
                  accessibilityLabel={
                    handlesLive ? ACCOUNTS_USERNAME_COPY.startChatFieldLabel : COPY.fieldLabel
                  }
                  accessibilityHint={COPY.fieldHint}
                  // `@` on the main layer; no suggestions, autocorrect or
                  // autofill, so a stranger's ID is not learned and your own
                  // email is never offered.
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  autoComplete="off"
                  textContentType="none"
                  importantForAutofill="no"
                  // No autoFocus: a keyboard on entry would cover Scan and My ID.
                  returnKeyType="go"
                  clearButtonMode="never"
                  maxFontSizeMultiplier={isId ? 2 : undefined}
                  testID="new-peer-input"
                  style={[
                    isId
                      ? {
                          fontFamily: t.mono,
                          fontSize: monoSize,
                          lineHeight: monoSize === 13 ? 18 : 20,
                          fontWeight: '400',
                        }
                      : t.type.input,
                    styles.input,
                    { color: t.color.inkStrong, paddingRight: showClear ? CLEAR_SIZE : 14 },
                  ]}
                />
                {showClear ? (
                  <Pressable
                    testID="new-peer-clear"
                    onPress={clearField}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.clear}
                    style={({ pressed }) => [
                      styles.clear,
                      { borderRadius: t.radius.button },
                      pressed && { backgroundColor: t.color.pineWash },
                    ]}
                  >
                    <ClearGlyph color={t.color.inkMuted} />
                  </Pressable>
                ) : null}
              </View>

              {hint ? <ReachHint {...hint} announced={announcedKind} /> : null}

              {/* ONE MESSAGE SLOT at the field: a notice, an error, or a local
                  find refusal; with none, the lookup's answer about this
                  text; with none of those, "That's you". */}
              {fieldMessage?.kind === 'notice' ? (
                <InlineNotice
                  tone="pine"
                  message={fieldMessage.message}
                  seq={attempt}
                  testID="start-chat-notice"
                />
              ) : null}
              {fieldMessage?.kind === 'error' ? (
                <InlineError
                  message={fieldMessage.message}
                  seq={attempt}
                  testID="start-chat-error"
                />
              ) : null}
              {fieldMessage?.kind === 'invalid' ? (
                <InlineError
                  message={fieldMessage.message}
                  seq={attempt}
                  testID="discovery-invalid"
                />
              ) : null}
              {fieldMessage === null ? renderLookup(phase) : null}
              {showSelfNotice ? (
                <InlineNotice
                  tone="quiet"
                  message={COPY.selfNotice}
                  seq={attempt}
                  action={{
                    label: COPY.showMyId,
                    onPress: showMyIdFromNotice,
                    testID: 'start-chat-show-my-id',
                  }}
                  testID="start-chat-self"
                />
              ) : null}

              {/* The action, only when its press can succeed. */}
              {canStart ? (
                <PrimaryButton
                  label={
                    existingNow?.kind === 'chat'
                      ? COPY.openChat
                      : existingNow?.kind === 'room'
                        ? COPY.openRoom
                        : COPY.startButton
                  }
                  accessibilityLabel={
                    existingNow?.kind === 'chat'
                      ? COPY.openChatA11y(existingNow.name)
                      : existingNow?.kind === 'room'
                        ? COPY.openRoomA11y(existingNow.name)
                        : COPY.startButton
                  }
                  onPress={startChat}
                  testID="start-chat"
                  style={styles.action}
                />
              ) : showFind ? (
                <PrimaryButton
                  label={COPY.findButton}
                  accessibilityLabel={
                    reach.kind === 'handle'
                      ? ACCOUNTS_USERNAME_COPY.startChatFindA11y
                      : COPY.findA11yEmail
                  }
                  onPress={findReach}
                  busy={findBusy}
                  busyLabel={phase.name === 'checking' ? COPY.checkingBusy : COPY.findBusy}
                  reduceMotion={reduceMotion}
                  testID="discovery-search"
                  style={styles.action}
                />
              ) : null}

              <RuledLabel label={COPY.or} marginTop={24} marginBottom={16} />
              {/* Scan is the strongest control on the empty screen: the QR
                  hand-off is the privacy-maximal way in. */}
              <OutlineButton
                testID="scan-qr-camera"
                label={COPY.qrScan}
                leading={<ScanGlyph color={picking ? t.color.inkMuted : t.color.pine} />}
                onPress={readFromCamera}
                disabled={picking}
              />
              <View style={styles.photoRow}>
                <TextAction
                  testID="scan-qr-photo"
                  label={COPY.qrPick}
                  onPress={readFromPhoto}
                  disabled={picking}
                />
              </View>

              {/* The photo anchor: a camera or photo answer renders where the
                  eye already is, and never drops the lookup's answer above. */}
              {photoMessage ? (
                <>
                  <InlineError
                    message={photoMessage.message}
                    seq={attempt}
                    testID="start-chat-error"
                  />
                  {photoMessage.action ? (
                    <OutlineButton
                      key={photoMessage.action}
                      ref={cameraSlotRef}
                      size="compact"
                      testID={slotTestID}
                      label={slotLabel}
                      onPress={onSlotPress}
                      style={styles.slot}
                    />
                  ) : null}
                </>
              ) : null}

              <View style={styles.info}>
                <InfoDisclosure
                  label={COPY.reachInfoLabel}
                  lines={reachInfo}
                  testID="start-chat-info"
                />
              </View>

              <MyIdSection
                id={profile.userId}
                open={myIdOpen}
                onToggle={toggleMyId}
                copy={MY_ID_COPY}
                onSectionLayout={onSectionLayout}
              />
            </>
          ) : (
            // On success everything above gives way to the naming step: one
            // thing to do, and nothing left that could start the same chat
            // again.
            <View>
              <Text
                accessibilityRole="header"
                style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
              >
                {COPY.nameLabel}
              </Text>
              <Text
                testID="start-chat-naming-id"
                accessibilityLabel={spellId(naming)}
                maxFontSizeMultiplier={2}
                style={[t.type.utilityData, styles.namingId, { color: t.color.inkMuted }]}
              >
                {groupId(naming)}
              </Text>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                onFocus={() => setNameFocused(true)}
                onBlur={() => setNameFocused(false)}
                onSubmitEditing={saveName}
                placeholder={COPY.namePlaceholder}
                placeholderTextColor={t.color.inkMuted}
                keyboardAppearance={t.scheme}
                selectionColor={t.color.pine}
                cursorColor={t.color.pine}
                accessibilityLabel={COPY.nameLabel}
                autoCapitalize="words"
                autoCorrect={false}
                autoFocus
                maxLength={40}
                returnKeyType="done"
                testID="peer-nickname-input"
                style={[
                  t.type.input,
                  styles.nameInput,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: t.color.paperSheet,
                    color: t.color.inkStrong,
                    borderWidth: nameFocused ? 2 : 1,
                    borderColor: nameFocused ? t.color.pine : t.color.lineField,
                  },
                ]}
              />
              <Text
                style={[
                  t.type.compactBody,
                  styles.nameHelper,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.nameHelper}
              </Text>
              <View style={styles.nameActions}>
                <Pressable
                  onPress={saveName}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.nameSave}
                  testID="peer-nickname-save"
                  style={({ pressed }) => [
                    styles.nameSave,
                    {
                      minHeight: t.layout.touchTarget,
                      borderRadius: t.radius.button,
                      backgroundColor: pressed
                        ? t.color.pinePressed
                        : t.color.pine,
                    },
                  ]}
                >
                  <Text style={[t.type.buttonCompact, { color: t.color.onPine }]}>
                    {COPY.nameSave}
                  </Text>
                </Pressable>
                <TextAction
                  label={COPY.nameSkip}
                  onPress={skipName}
                  testID="peer-nickname-skip"
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 48, alignItems: 'center' },
  /** Full width until contentMax caps it — the Register/Profile pattern. */
  column: { width: '100%' },
  field: { marginTop: 12, flexDirection: 'row', alignItems: 'stretch' },
  input: { flex: 1, paddingLeft: 14, paddingVertical: 0 },
  clear: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: CLEAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: { marginTop: 12 },
  photoRow: { alignItems: 'center', marginTop: 4 },
  slot: { alignSelf: 'flex-start', marginTop: 8 },
  info: { marginTop: 2 },
  namingId: { marginTop: 4 },
  nameInput: { marginTop: 12, paddingHorizontal: 14 },
  nameHelper: { marginTop: 6 },
  nameActions: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  nameSave: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginRight: 8,
  },
});
