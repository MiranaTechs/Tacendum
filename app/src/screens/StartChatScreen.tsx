import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  // Same trade as the chat list made before this screen existed: Clipboard is
  // deprecated in core but still shipped, and a paste target is the whole
  // point of an id.
  Clipboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { useKeyboardInset } from '../keyboardInset';
import { messaging } from '../messaging';
import {
  PickCancelled,
  PickDenied,
  PickTooLarge,
  pickImageFile,
} from '../media';
import {
  extractId,
  fold,
  ID_LENGTH,
  idAttempt,
  idProblem,
  idsInPastedText,
  shareIdMessage,
} from '../peerId';
import { sanitizeDisplayName, spellId } from '../person';
import * as qr from '../qr';
import { useTheme } from '../theme';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { usePaneWidth } from '../windowClass';
import { QrPanel } from '../ui/QrPanel';
import {
  InlineError,
  InlineNotice,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';
import { shareWithAnchor } from '../ui/shareWithAnchor';

interface Props {
  profile: db.ProfileRow;
  onBack: () => void;
  onOpenChat: (peerId: string) => void;
  /** The typed-single-identifier flow — its own
   * surface; this screen only holds the door. QR stays the lead rail. */
  onFindByEmail: () => void;
}

/**
 * Every visible string on this screen.
 *
 * EXPORTED, and for one reason: `ProfileScreen` shows the same QR under
 * the same words. The same action must never get two different sentences,
 * so the other screen reads THIS property rather than spelling a second
 * literal that matches until someone rewords one of them.
 */
export const COPY = {
  title: 'Start a chat',
  // Reworded with the code that changed the fact: find-by-email exists now — typed, single, consent-gated —
  // so "no search" would be a lie on the very screen that offers it. The
  // QR/ID hand-off stays the lead rail, and there is still no
  // directory to browse and no address book read, ever.
  infoNoDirectory:
    'Tacendum has no public directory. A chat starts with a Tacendum ID one person hands the other — or with the email of someone who chose to be found.',
  findByEmail: 'Find by email',
  findByEmailHelper:
    'Works only for someone who verified an email and turned findability on.',
  idLabel: 'Their Tacendum ID',
  /** The field's heading once the scanner leads: typing is the second
   * way in, said as such. The field's own accessible name stays
   * `idLabel` — VoiceOver names the thing, not its rank. */
  idTypeLabel: 'Or type their Tacendum ID',
  idPlaceholder: 'Enter their ID',
  idCounter: (n: number) => `${n} of ${ID_LENGTH}`,
  startButton: 'Start chat',

  ownIdLabel: 'Your Tacendum ID',
  ownIdHint: 'Read this out to the person you want to reach.',
  ownIdHelper:
    'Give your ID only to someone you trust — text it, or read it out loud. It is the only way anyone can reach you here.',
  /**
   * The own-ID block's door: this screen is for reaching THEM, so your
   * own id waits behind one tap rather than a scroll. */
  showOwnId: 'Show my ID',
  hideOwnId: 'Hide my ID',
  copy: 'Copy',
  share: 'Share',
  // Byte-identical on ProfileScreen and ChatListScreen — the same copy
  // action must never get two different sentences.
  copied:
    'Copied. Paste it into a text — or read it out loud, four letters at a time.',
  // The share text itself is `shareIdMessage` (peerId.ts): one helper, so
  // every surface sends the id on a line of its own.

  nameLabel: 'Who is this?',
  // The device is named in the
  // platform's own words via the token.
  namePlaceholder: `Their name on this ${DEVICE_NOUN}`,
  nameHelper: `Just a label on this ${DEVICE_NOUN}. They never see it.`,
  nameSave: 'Save and open',
  nameSkip: 'Skip',

  errorOwnId: 'That’s your own ID. Ask them for theirs — yours is just below.',
  errorShort: (n: number) =>
    `That’s ${n} of ${ID_LENGTH} characters. Ask them for the whole ID.`,
  errorLong: (n: number) =>
    `That’s ${n} characters — a Tacendum ID is exactly ${ID_LENGTH}.`,
  errorU:
    'A Tacendum ID never contains the letter U. Check that character with them.',
  errorIncomplete: 'Enter the full ID exactly as it was shared with you.',
  errorLocal: 'We couldn’t start this chat. Try again.',

  // ── Reading their QR ────────────────────────────────────────
  qrScan: 'Scan their QR code',
  qrPick: 'Choose a photo of their QR code',
  qrRead: 'Read their ID from the picture. Check it before you start the chat.',
  qrFilled: 'Read from the picture. Check the ID above, then start the chat.',
  qrNone:
    'There’s no QR code in that photo. Choose the picture they sent you, or type their ID instead.',
  qrMultiple:
    'That photo has more than one QR code. Tacendum won’t guess which one is theirs — choose a photo with a single code.',
  qrNotAnId:
    'That QR code isn’t a Tacendum ID. It might be a Wi-Fi code or a web link — check you picked the right picture.',
  qrOwnId:
    'That’s your own QR code. Ask them for theirs — yours is just below.',
  qrTooBig: 'That photo is too large to read. Choose a smaller one.',
  // Byte-identical to ProfileScreen.tsx — the same iOS condition must never
  // get two different sentences.
  qrPhotosDenied:
    'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
  qrUnreadable: 'Tacendum couldn’t read that photo. Choose another one.',
  openSettings: 'Open Settings',

  // ── Pasting their ID ────────────────────────────────────────
  // Each sentence mirrors its photo twin above: a paste is the third way to
  // fill the same field, under the same rules.
  pasteFilled: 'Pasted. Check the ID above, then start the chat.',
  pasteMultiple:
    'That text has more than one Tacendum ID. Tacendum won’t guess which one is theirs — paste a message with a single ID.',
  pasteNotAnId:
    'That’s a web link, not a Tacendum ID. An ID is never part of a link — ask them to send it on its own.',

  // ── Your QR ─────────────────────────────────────────────────
  qrShow: 'Show QR code',
  qrHide: 'Hide QR code',
} as const;

/** The discovery label must describe the identifier classes offered by
 * its destination. Select the username-enabled copy with the same feature
 * flag as the destination, keeping the disabled variant unchanged. */
function findDoorCopy(): { label: string; helper: string; noDirectory: string } {
  return USERNAME_UI_ENABLED
    ? {
        label: ACCOUNTS_USERNAME_COPY.startChatFind,
        helper: ACCOUNTS_USERNAME_COPY.startChatFindHelper,
        noDirectory: ACCOUNTS_USERNAME_COPY.startChatNoDirectory,
      }
    : {
        label: COPY.findByEmail,
        helper: COPY.findByEmailHelper,
        noDirectory: COPY.infoNoDirectory,
      };
}

/** How long the copy confirmation holds before the helper line returns. */
const COPY_NOTICE_MS = 3000;

/** What can never be part of an id (see peerId.fold for the O/I/L mapping);
 * grouping characters stay so a pasted, spaced id survives intact. */
const NOT_TYPEABLE = /[^0-9A-HJKMNP-Z\s\-_.,:;/|()[\]]/g;

/** The grouping `idProblem` ignores, so the counter counts what it counts. */
const GROUPING = /[\s\-_.,:;/|()[\]]/g;

function typedLength(raw: string): number {
  return raw.replace(GROUPING, '').length;
}

/** An id in fours, the way one person reads it to another. */
function groupId(id: string): string {
  return id.match(/.{1,4}/g)?.join(' ') ?? id;
}

/** Why an id was refused, said specifically enough to act on. Judged on the
 * id ATTEMPT, not the whole field: a sentence pasted around a short id used
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

/**
 * Reaching someone new, on its own surface. The chat list used to carry this
 * as permanent furniture; behind the + it can afford to explain itself — the
 * no-directory sentence sits in the open instead of behind an ⓘ.
 */
export function StartChatScreen({ profile, onBack, onOpenChat, onFindByEmail }: Props) {
  const t = useTheme();
  // The PANE's width: below narrowWidth the Start chat
  // button drops under the field — a 26-character mono field and a button
  // cannot share 340pt without one of them giving way.
  const stacked = usePaneWidth() <= t.layout.narrowWidth;
  // THE keyboard mechanism: the
  // avoiding-view component this screen carried sat inside the transformed
  // RouteTransition that defeats its own-frame measurement. One
  // mechanism, applied as paddingBottom on the root.
  const keyboardInset = useKeyboardInset();
  const findDoor = findDoorCopy();
  const [draftId, setDraftId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [focused, setFocused] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  /** The own-ID block's door: closed on entry. */
  const [ownIdOpen, setOwnIdOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorSettings, setErrorSettings] = useState(false);
  /** Bumped on every decode attempt so an identical repeated failure is
   *  announced again — InlineError's effect keys on [message, seq]. */
  const [attempt, setAttempt] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Copy → Back inside the notice's 3 s must not fire a state write on a
  // screen that is gone (the chat list's EmptyChats clears its own the
  // same way).
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  /** Where the 26 characters in the field came from:
   *  a code only ever fills the field, so the rail is remembered here and
   *  recorded when the person commits. Any keystroke makes it 'manual' —
   *  a provenance that survived an edit would vouch for characters nobody
   *  scanned. */
  const [draftSource, setDraftSource] = useState<'qr' | 'manual'>('manual');

  const changeDraft = useCallback(
    (next: string) => {
      // Any change is the person's: a pasted id is theirs to check and
      // commit, the same as a typed one (a paste is not a scan).
      setDraftSource(current => (current === 'manual' ? current : 'manual'));
      setErrorSettings(current => (current ? false : current));

      // A PASTE is many characters arriving in one change. Detected from
      // the shape of the change and nothing else: the clipboard is never
      // read (`Clipboard.getString` raises the iOS paste prompt, and
      // pasteboard.ts treats every read as a leak surface), and there is no
      // Paste button for the same reason. Autocomplete inserting a word
      // trips this too, and lands in the "nothing found" branch below —
      // which is exactly what typing does.
      if (next.length - draftId.length > 1) {
        const found = idsInPastedText(next);
        if (found.ids.length === 1) {
          // The field, not the chat — the photo path's rule, for the photo
          // path's reason: there is no directory, so the 26 characters have
          // to be seen before anything is sent. The human still presses
          // Start chat.
          setDraftId(found.ids[0]!);
          setError(null);
          setNotice(COPY.pasteFilled);
          setAttempt(n => n + 1);
          return;
        }
        if (found.ids.length > 1 || found.inUriOnly) {
          // A refusal never leaves a half-filled field behind, and never
          // picks: taking the first of two is a silent guess about which
          // person the sender meant, and an id inside a link is a slug.
          setDraftId('');
          setNotice(null);
          setError(found.ids.length > 1 ? COPY.pasteMultiple : COPY.pasteNotAnId);
          setAttempt(n => n + 1);
          return;
        }
        // Nothing id-shaped in it: exactly what typing the same text does.
      }

      // Folding is length-preserving and the strip only ever removes the
      // character just typed, so the cursor cannot jump under the person.
      setDraftId(fold(next).replace(NOT_TYPEABLE, ''));
      setError(current => (current === null ? current : null));
      // Typing is a fresh attempt: neither the last photo's failure nor its
      // "check this ID" notice is about what is in the field now.
      setNotice(current => (current === null ? current : null));
    },
    [draftId],
  );

  const startChat = useCallback(() => {
    // The keyboard's go key fires this with the button still disabled:
    // nothing typed is not an attempt, so it is not an error either — "0
    // of 26 characters" was the disabled button's own promise broken from
    // the other side.
    if (draftId.trim() === '') return;
    const peerId = extractId(draftId);
    if (peerId === null) {
      setError(idError(draftId));
      return;
    }
    if (peerId === profile.userId) {
      setError(COPY.errorOwnId);
      return;
    }
    void (async () => {
      try {
        // TWO READS BEFORE THE WRITE, because this screen's most likely
        // repeat use is scanning someone you already have.
        //
        // A ROOM FIRST. A room's conversation row IS its ULID (pushnav.ts),
        // so an upsert here would put a person-shaped row over a room — the
        // shape the chat list already routes around when it deletes, because
        // it strands queued fan-out legs. A room is opened, never created,
        // and never named on this screen.
        const room = await db.getGroup(peerId);
        if (room !== null) {
          setError(null);
          onOpenChat(peerId);
          return;
        }
        // A PERSON I HAVE ALREADY NAMED. Asking "Who is this?" with an empty
        // field about someone named months ago is a question with no useful
        // answer; `saveName` would have written nothing anyway.
        const existing = await db.getChat(peerId);
        if (existing?.localName) {
          // The upsert still runs, and it is not a formality. A row an
          // inbound message opened — or one that predates the column —
          // carries no provenance at all, and `db.upsertChat` COALESCEs the
          // column so this "fills in only where nothing was recorded" (its
          // own words). Skipping it here would leave scanning the only way to
          // record a mark and never let a scan record one, on the release
          // where the peer profile started SAYING how a chat began. No
          // display name is offered, so the row's own name is untouched, and
          // an origin already on disk cannot be restated.
          await db.upsertChat(peerId, undefined, draftSource);
          setError(null);
          onOpenChat(peerId);
          return;
        }
        // Everything else is the old path: an unnamed row still gets the
        // naming step, because that is the case where asking helps. The
        // upsert is harmless on a row that exists (introducedBy is COALESCEd,
        // so a re-scan can never restate a discovery origin).
        await db.upsertChat(peerId, undefined, draftSource);
        // Prefilled with the name they shared, when they have shared one:
        // the answer is usually "yes, that one", and typing it again is work
        // this screen can do for the person.
        setNameDraft(existing?.displayName ?? '');
      } catch {
        setError(COPY.errorLocal);
        return;
      }
      setError(null);
      // Naming happens here, at the one moment the person knows who this id
      // belongs to — a bare ULID in the list is unrecognisable a week later.
      setNaming(peerId);
    })();
  }, [draftId, draftSource, onOpenChat, profile.userId]);

  const readFromCamera = useCallback(() => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        const peerId = await qr.readIdFromCamera(profile.userId);
        // The field, not the chat — identical to the photo path, and for the
        // same reason: there is no directory, so the 26 characters have to be
        // seen before anything is sent.
        setDraftId(peerId);
        setDraftSource('qr');
        setError(null);
        setErrorSettings(false);
        setNotice(COPY.qrFilled);
        setAttempt(n => n + 1);
      } catch (err) {
        // Cancelling reads as QrNoCode, which is also what pointing the camera
        // at a wall gives. Announcing an error for a deliberate cancel would
        // be noise, so it is silent — the screen is unchanged and the person
        // knows why.
        if (err instanceof qr.QrNoCode) return;
        setNotice(null);
        setError(photoError(err));
        setAttempt(n => n + 1);
      } finally {
        setPicking(false);
      }
    })();
  }, [picking, profile.userId]);

  const readFromPhoto = useCallback(() => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        const file = await pickImageFile('library');
        const peerId = await qr.readIdFromImage(file.uri, profile.userId);
        // The field, not the chat. There is no directory: a wrong id addresses
        // the wrong person or nobody, so the person has to see the 26
        // characters before committing. The counter, `complete`, and the
        // Start chat button are the confirmation, and they already exist.
        setDraftId(peerId);
        setDraftSource('qr');
        setError(null);
        setErrorSettings(false);
        setNotice(COPY.qrFilled);
        setAttempt(n => n + 1);
      } catch (err) {
        // Backing out of the picker is not a failure, and it is not a new
        // outcome either: bumping `attempt` here would re-announce the
        // *previous* photo's error to VoiceOver for a pick that produced
        // nothing. Only the two branches that actually change what is on
        // screen move the counter.
        if (err instanceof PickCancelled) return;
        setNotice(null);
        setErrorSettings(err instanceof PickDenied);
        setError(photoError(err));
        setAttempt(n => n + 1);
      } finally {
        setPicking(false);
      }
    })();
  }, [picking, profile.userId]);

  const saveName = useCallback(() => {
    const peerId = naming;
    if (peerId === null) return;
    // Sanitized at input — the typed label is stored as it will render.
    const name = sanitizeDisplayName(nameDraft);
    void (async () => {
      try {
        if (name !== '') {
          await db.setLocalName(peerId, name);
          // Sibling sync 'name': siblings inherit the label. Best-effort.
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

  const copySelfId = useCallback(() => {
    // The bare id, and no pasteboard expiry (contrast pasteboard.ts): an id
    // is an address, not a secret — the whole point is that it gets pasted.
    Clipboard.setString(profile.userId);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), COPY_NOTICE_MS);
  }, [profile.userId]);

  /** The Share button, so the iPad popover points at it. */
  const shareAnchor = useRef<View>(null);

  const shareSelfId = useCallback(() => {
    void (async () => {
      try {
        // `message` only: adding a `url` makes iOS rank Safari above Messages,
        // and this id is meant for one person, not a post.
        await shareWithAnchor(
          { message: shareIdMessage(profile.userId) },
          shareAnchor,
        );
      } catch {
        // Dismissing the sheet is not a failure.
      }
    })();
  }, [profile.userId]);

  const empty = draftId.trim() === '';
  const complete = extractId(draftId) !== null;
  const count = complete ? ID_LENGTH : typedLength(draftId);

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
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: t.layout.gutter },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* The reading column: this screen sizes
            against the honest width its pane hands it, capped at contentMax
            like Register/Profile — uncapped, a medium window stretched the
            field row across the whole glass. Width-only; on phones the cap
            never engages. */}
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          <Text
            style={[t.type.compactBody, styles.info, { color: t.color.inkBody }]}
          >
            {findDoor.noDirectory}
          </Text>

          {naming === null ? (
            <>
              {/* THE SCANNER LEADS: the QR
                  hand-off is the lead rail, so reading their code is the
                  first thing on the page; the field below — no longer focused
                  on entry — is the second way in, and says so.
                  Same height, radius, fill and border weight as that field, so
                  a picture reads as the other way to fill the same box. */}
              <Pressable
                onPress={readFromCamera}
                disabled={picking}
                accessibilityRole="button"
                accessibilityLabel={COPY.qrScan}
                accessibilityState={{ disabled: picking }}
                testID="scan-qr-camera"
                style={({ pressed }) => [
                  styles.photoAction,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: pressed ? t.color.pineWash : t.color.paperSheet,
                    borderWidth: 1,
                    borderColor: pressed ? t.color.pineLine : t.color.lineStrong,
                  },
                ]}
              >
                <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                  {COPY.qrScan}
                </Text>
              </Pressable>

              <Pressable
                onPress={readFromPhoto}
                disabled={picking}
                accessibilityRole="button"
                accessibilityLabel={COPY.qrPick}
                accessibilityState={{ disabled: picking }}
                testID="scan-qr-photo"
                style={({ pressed }) => [
                  styles.photoAction,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: pressed ? t.color.pineWash : t.color.paperSheet,
                    borderWidth: 1,
                    borderColor: pressed ? t.color.pineLine : t.color.lineStrong,
                  },
                ]}
              >
                <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                  {COPY.qrPick}
                </Text>
              </Pressable>
              <Text
                style={[
                  t.type.compactBody,
                  styles.qrPickHelper,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.qrRead}
              </Text>

              <View style={[styles.labelRow, styles.idLabelRow]}>
                <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
                  {COPY.idTypeLabel}
                </Text>
                {!empty ? (
                  <Text
                    style={[
                      t.type.counter,
                      { color: complete ? t.color.pine : t.color.inkMuted },
                    ]}
                    // Progress for the eye; VoiceOver already hears the field.
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                  >
                    {COPY.idCounter(count)}
                  </Text>
                ) : null}
              </View>

              <View
                style={[styles.panelRow, stacked && styles.panelStacked]}
                testID="start-chat-panel"
              >
                <TextInput
                  value={draftId}
                  onChangeText={changeDraft}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onSubmitEditing={startChat}
                  placeholder={COPY.idPlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  keyboardAppearance={t.scheme}
                  selectionColor={t.color.pine}
                  accessibilityLabel={COPY.idLabel}
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect={false}
                  // No autoFocus: QR is the lead rail, and a keyboard on
                  // entry covered the scanner, the photo door, Find by email
                  // and the person's own ID.
                  clearButtonMode="while-editing"
                  returnKeyType="go"
                  spellCheck={false}
                  textContentType="none"
                  testID="new-peer-input"
                  style={[
                    t.type.utilityData,
                    styles.panelInput,
                    {
                      minHeight: t.layout.buttonHeight,
                      borderRadius: t.radius.button,
                      backgroundColor: t.color.paperSheet,
                      color: t.color.inkStrong,
                      borderWidth: error || focused ? 2 : 1,
                      borderColor: error
                        ? t.color.danger
                        : focused
                          ? t.color.pine
                          : t.color.lineStrong,
                    },
                  ]}
                />
                <Pressable
                  onPress={startChat}
                  disabled={empty}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.startButton}
                  accessibilityState={{ disabled: empty }}
                  testID="start-chat"
                  style={({ pressed }) => [
                    styles.panelButton,
                    stacked ? styles.panelButtonStacked : styles.panelButtonBeside,
                    {
                      minHeight: t.layout.buttonHeight,
                      paddingHorizontal: t.space.s6,
                      borderRadius: t.radius.button,
                      // Disabled is a recessed surface, never a dimmed one.
                      backgroundColor: empty
                        ? t.color.paperInset
                        : pressed
                          ? t.color.pinePressed
                          : t.color.pine,
                      borderWidth: empty ? 1 : 0,
                      borderColor: t.color.lineSoft,
                    },
                  ]}
                >
                  <Text
                    style={[
                      t.type.button,
                      styles.panelButtonLabel,
                      { color: empty ? t.color.inkMuted : t.color.onPine },
                    ]}
                  >
                    {COPY.startButton}
                  </Text>
                </Pressable>
              </View>

              {/* Find by email: BELOW the QR/ID rails —
                  the privacy-maximal hand-off keeps the lead — and honestly
                  scoped: only opted-in people can be found. */}
              <Pressable
                onPress={onFindByEmail}
                accessibilityRole="button"
                accessibilityLabel={findDoor.label}
                testID="find-by-email"
                style={({ pressed }) => [
                  styles.photoAction,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: pressed ? t.color.pineWash : t.color.paperSheet,
                    borderWidth: 1,
                    borderColor: pressed ? t.color.pineLine : t.color.lineStrong,
                  },
                ]}
              >
                <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                  {findDoor.label}
                </Text>
              </Pressable>
              <Text
                style={[
                  t.type.compactBody,
                  styles.qrPickHelper,
                  { color: t.color.inkMuted },
                ]}
              >
                {findDoor.helper}
              </Text>

              {/* One region for both the typed id and the picture, so two errors can
                  never stack and the layout stays where the eye left it. */}
              {error ? (
                <>
                  <InlineError
                    message={error}
                    seq={attempt}
                    testID="start-chat-error"
                  />
                  {errorSettings ? (
                    <Pressable
                      onPress={() => void Linking.openSettings()}
                      accessibilityRole="button"
                      accessibilityLabel={COPY.openSettings}
                      testID="start-chat-open-photo-settings"
                      style={({ pressed }) => [
                        styles.settingsLink,
                        {
                          minHeight: t.layout.touchTarget,
                          borderRadius: t.radius.button,
                          backgroundColor: pressed ? t.color.pineWash : 'transparent',
                        },
                      ]}
                    >
                      <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                        {COPY.openSettings}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : notice ? (
                <InlineNotice
                  tone="pine"
                  message={notice}
                  seq={attempt}
                  testID="start-chat-notice"
                />
              ) : null}
            </>
          ) : null}

          {/* On success the ID panel and the rails give way to the naming
              step: one thing to do, and nothing left above it
              that could start the same chat again. */}
          {naming !== null ? (
            <View style={styles.naming}>
              <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
                {COPY.nameLabel}
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
                    borderColor: nameFocused ? t.color.pine : t.color.lineStrong,
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
          ) : null}

          {naming === null ? (
            <View style={styles.ownId}>
              {/* Collapsed: this screen is for
                  reaching THEM. The chat list's empty state and the profile
                  hand out your own id in the open; here it waits behind one
                  tap, so the scanner, the field and the find door are what
                  the page is about. */}
              <Pressable
                onPress={() => setOwnIdOpen(open => !open)}
                accessibilityRole="button"
                accessibilityLabel={ownIdOpen ? COPY.hideOwnId : COPY.showOwnId}
                accessibilityState={{ expanded: ownIdOpen }}
                testID="show-self-id"
                style={({ pressed }) => [
                  styles.settingsLink,
                  {
                    minHeight: t.layout.touchTarget,
                    borderRadius: t.radius.button,
                    backgroundColor: pressed ? t.color.pineWash : 'transparent',
                  },
                ]}
              >
                <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                  {ownIdOpen ? COPY.hideOwnId : COPY.showOwnId}
                </Text>
              </Pressable>
              {ownIdOpen ? (
                <>
                  <View style={styles.labelRow}>
                    <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
                      {COPY.ownIdLabel}
                    </Text>
                    <View style={styles.inlineActions}>
                      <TextAction
                        label={COPY.copy}
                        onPress={copySelfId}
                        testID="copy-self-id"
                      />
                      <TextAction
                        ref={shareAnchor}
                        label={COPY.share}
                        onPress={shareSelfId}
                        testID="share-self-id"
                      />
                    </View>
                  </View>
                  {/* Grouped in fours because the job is transferring it to a person,
                      by voice or by eye — not reading it as one word. */}
                  <Text
                    selectable
                    testID="self-user-id"
                    accessibilityLabel={spellId(profile.userId)}
                    accessibilityHint={COPY.ownIdHint}
                    style={[
                      t.type.utilityData,
                      styles.ownIdValue,
                      { color: t.color.inkStrong },
                    ]}
                  >
                    {groupId(profile.userId)}
                  </Text>
                  {copied ? (
                    <InlineNotice
                      tone="pine"
                      message={COPY.copied}
                      testID="self-id-copied"
                    />
                  ) : (
                    <Text
                      style={[
                        t.type.compactBody,
                        styles.ownIdHelper,
                        { color: t.color.inkMuted },
                      ]}
                    >
                      {COPY.ownIdHelper}
                    </Text>
                  )}
                  {/* After the helper, never before it: the sentence about who should
                      have your ID is the one to read before exposing the picture. */}
                  <Pressable
                    onPress={() => setQrOpen(open => !open)}
                    accessibilityRole="button"
                    accessibilityLabel={qrOpen ? COPY.qrHide : COPY.qrShow}
                    accessibilityState={{ expanded: qrOpen }}
                    testID="show-self-qr"
                    style={({ pressed }) => [
                      styles.settingsLink,
                      {
                        minHeight: t.layout.touchTarget,
                        borderRadius: t.radius.button,
                        backgroundColor: pressed ? t.color.pineWash : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                      {qrOpen ? COPY.qrHide : COPY.qrShow}
                    </Text>
                  </Pressable>
                  {qrOpen ? <QrPanel id={profile.userId} /> : null}
                </>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingTop: 8, paddingBottom: 48, alignItems: 'center' },
  /** Full width until contentMax caps it — the Register/Profile pattern. */
  column: { width: '100%' },
  info: {},
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  idLabelRow: { marginTop: 20 },
  panelRow: { flexDirection: 'row', marginTop: 6 },
  /** Below layout.narrowWidth: the button under the field. */
  panelStacked: { flexDirection: 'column' },
  panelInput: { flex: 1, paddingHorizontal: 14 },
  panelButton: {
    // A floor, not a fixed width: the label grows with Dynamic Type
    // instead of wrapping to two lines inside a 112pt box.
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelButtonBeside: { marginLeft: 8 },
  panelButtonStacked: { marginTop: 8, alignSelf: 'stretch' },
  panelButtonLabel: { textAlign: 'center' },
  inlineActions: { flexDirection: 'row', marginRight: -8 },
  naming: { marginTop: 14 },
  nameInput: { marginTop: 4, paddingHorizontal: 14 },
  nameHelper: { marginTop: 6 },
  nameActions: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  nameSave: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    marginRight: 8,
  },
  ownId: { marginTop: 32 },
  ownIdValue: { marginTop: 4 },
  ownIdHelper: { marginTop: 8 },
  photoAction: {
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  qrPickHelper: { marginTop: 6 },
  settingsLink: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 8,
    // Keeps the label optically on the gutter despite its own hit padding.
    marginLeft: -8,
    marginTop: 4,
  },
});
