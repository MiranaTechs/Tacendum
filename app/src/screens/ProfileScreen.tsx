import React, { useEffect, useRef, useState } from 'react';
import {
  // Deprecated in core but still shipped (the StartChatScreen trade): a
  // paste target is the whole point of an id.
  Clipboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ProfileRow } from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { useKeyboardInset } from '../keyboardInset';
import {
  AVATAR_PHOTO,
  PickCancelled,
  PickDenied,
  PickUnavailable,
  pickImage,
  type PickSource,
} from '../media';
import { messaging } from '../messaging';
import { shareIdMessage } from '../peerId';
import { deleteAccount } from '../registration';
import { useTheme } from '../theme';
import { Avatar } from '../ui/Avatar';
import {
  IdentityRow,
  InlineError,
  InlineNotice,
  ScreenHeader,
} from '../ui/primitives';
import { shareWithAnchor } from '../ui/shareWithAnchor';

interface Props {
  profile: ProfileRow;
  onBack: () => void;
  onProfileChanged: (profile: ProfileRow) => void;
  onOpenSettings: () => void;
  onSignedOut: () => void;
}

const NAME_MAX = 40;
const ABOUT_MAX = 140;

/** How long the save confirmation holds the page before it clears itself. */
const NOTICE_MS = 3000;

/**
 * Every visible string, in one place. A profile is the surface where "no
 * directory, no public account" has to be said in plain words rather than
 * implied, so the copy is as load-bearing as the layout.
 */
const COPY = {
  title: 'Your profile',
  edit: 'Edit',
  noName: 'Add a name',
  // "About line" is the field's implementation name; nobody says it.
  noAbout: 'Say something about yourself',
  sharing:
    'Only the people you chat with can see this. There is no profile page and no way to look you up.',
  // There is no Phone row any more: an account is a keypair, not a number, so the ID is the only identifier this screen
  // has to show — and the only one there is to hand anybody.
  idLabel: 'Tacendum ID',
  copyId: 'Copy',
  shareId: 'Share',
  // Byte-identical to StartChatScreen.tsx — the same copy action must never
  // get two different sentences.
  copied:
    'Copied. Paste it into a text — or read it out loud, four letters at a time.',
  settings: 'Settings',
  signOut: 'Delete account',
  // There is no sign-out: chats exist only on this phone, so a "log out and
  // come back" promise is one the architecture cannot keep. Deletion is the
  // honest exit, and the copy owns every consequence.
  // The device is named in the
  // platform's own words via the token, here and twice below.
  signOutConfirm: `Deleting your account erases your chats, photos, and profile from this ${DEVICE_NOUN}, and retires your Tacendum ID — nobody can reach it again. There is no backup. If you come back, you’ll register fresh with a new ID.`,
  confirmSignOut: 'Delete my account',
  keepSignedIn: 'Keep my account',
  editTitle: 'Edit profile',
  cancel: 'Cancel',
  save: 'Save',
  choosePhoto: 'Choose photo',
  takePhoto: 'Take photo',
  removePhoto: 'Remove photo',
  nameLabel: 'Name',
  namePlaceholder: 'How people know you',
  aboutLabel: 'About',
  aboutPlaceholder: 'A short line about you',
  privacy:
    'Tacendum can’t see any of this. When you save, your name, photo, and about go out privately to everyone you already chat with.',
  saved: 'Saved. Sending it to your chats now.',
  photoUnreadable: 'Tacendum couldn’t read that photo. Choose another one.',
  photosDenied:
    'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
  cameraDenied:
    'Tacendum doesn’t have access to your camera. You can turn it on in Settings.',
  cameraUnavailable: `This ${DEVICE_NOUN} doesn’t have a camera available.`,
  openSettings: 'Open Settings',
  saveFailed: 'Your profile wasn’t saved. Try again.',
  savedOffline: `Saved on this ${DEVICE_NOUN}. Your chats get the update when you’re back on.`,
  // Server-first contract: if the server was never reached, nothing local was
  // destroyed either — the account is exactly as it was.
  signOutFailed:
    'Tacendum couldn’t reach the server, so nothing was deleted. Try again when you’re back on.',
} as const;

/**
 * What a peer will actually receive: one line, no leading or trailing space.
 * A pasted paragraph or a run of returns is a formatting accident, not a
 * choice, and every surface that renders a name gives it a single line.
 */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Your profile, and the inline edit state that lives inside it. Editing is not
 * a second screen and not a modal: the same page swaps its header actions and
 * grows fields, so nothing ever floats above the paper.
 */
export function ProfileScreen({
  profile,
  onBack,
  onProfileChanged,
  onOpenSettings,
  onSignedOut,
}: Props) {
  const t = useTheme();
  // THE keyboard mechanism: the
  // avoiding-view component this screen carried measured its own frame
  // through the transformed RouteTransition it renders inside, which defeats
  // that measurement — the same reason the thread dropped its own. One
  // mechanism, applied as paddingBottom on the root.
  const keyboardInset = useKeyboardInset();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.displayName);
  const [about, setAbout] = useState(profile.about);
  const [avatarB64, setAvatarB64] = useState(profile.avatarB64);
  const [focused, setFocused] = useState<'name' | 'about' | null>(null);
  const [saving, setSaving] = useState(false);
  // A permission denial carries an action; an unreadable file does not, so the
  // two cannot share a bare string.
  const [photoError, setPhotoError] = useState<{
    message: string;
    settings?: boolean;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // InlineNotice announces itself, so announcing here as well says it twice.
  const showNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  /** The Share action's Pressable, so the iPad popover points at it. */
  const shareAnchor = useRef<View>(null);

  const shareId = async () => {
    try {
      // The system activity sheet is OS UI, not app content in a Modal. It
      // rejects when the sheet is dismissed, which is not a failure.
      // `message` only, never a `url`: the id is a bare ULID everywhere.
      await shareWithAnchor(
        { message: shareIdMessage(profile.userId) },
        shareAnchor,
      );
    } catch {
      // Dismissed: nothing to report and nothing to recover.
    }
  };

  const copyId = () => {
    // The bare id, and no pasteboard expiry (contrast pasteboard.ts): an id
    // is an address, not a secret — the whole point is that it gets pasted.
    Clipboard.setString(profile.userId);
    showNotice(COPY.copied);
  };

  const openEdit = () => {
    setName(profile.displayName);
    setAbout(profile.about);
    setAvatarB64(profile.avatarB64);
    setPhotoError(null);
    setSaveError(null);
    setNotice(null);
    setConfirmingSignOut(false);
    setSignOutError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setPhotoError(null);
    setSaveError(null);
    setFocused(null);
  };

  const choosePhoto = async (source: PickSource) => {
    try {
      const picked = await pickImage(source, AVATAR_PHOTO);
      setAvatarB64(picked.base64);
      setPhotoError(null);
    } catch (err) {
      // Backing out of the picker is not a failure. Anything else is reported
      // in our own words: the picker's message names files and formats.
      if (err instanceof PickCancelled) return;
      // A denial has to be told apart from a bad file: "choose another one"
      // when the person was never shown anything to choose sends them nowhere.
      if (err instanceof PickDenied) {
        setPhotoError({
          message:
            err.source === 'camera' ? COPY.cameraDenied : COPY.photosDenied,
          settings: true,
        });
        return;
      }
      if (err instanceof PickUnavailable) {
        setPhotoError({ message: COPY.cameraUnavailable });
        return;
      }
      setPhotoError({ message: COPY.photoUnreadable });
    }
  };

  const nextName = normalize(name);
  const nextAbout = normalize(about);
  const dirty =
    nextName !== profile.displayName ||
    nextAbout !== profile.about ||
    avatarB64 !== profile.avatarB64;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    // Read before the await: this is the connection the card ships over, and
    // by the time saveProfile resolves the socket may have moved on.
    const offline = messaging.wsState !== 'open';
    try {
      // saveProfile persists locally first and then shares the card with every
      // conversation, swallowing sharing failures (a profile must never block
      // a message). Awaiting the whole call is therefore the only way to learn
      // whether the local write — the part edit mode depends on — succeeded.
      const saved = await messaging.saveProfile({
        displayName: nextName,
        about: nextAbout,
        avatarB64,
      });
      if (!saved) throw new Error('profile missing after save');
      setName(saved.displayName);
      setAbout(saved.about);
      setAvatarB64(saved.avatarB64);
      setEditing(false);
      setFocused(null);
      onProfileChanged(saved);
      showNotice(offline ? COPY.savedOffline : COPY.saved);
    } catch {
      setSaveError(COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const confirmSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await deleteAccount();
      onSignedOut();
    } catch {
      // Server-first: reaching here means the server was never told, so the
      // account — and everything local — is still intact. Say so plainly.
      setSignOutError(COPY.signOutFailed);
      setSigningOut(false);
    }
  };

  const hasName = profile.displayName !== '';
  const hasAbout = profile.about !== '';

  // Collapsing the hero text into one button would otherwise silence the name
  // and the about line, so both are spoken before the action.
  const heroLabel = hasName
    ? `${profile.displayName}. ${hasAbout ? `${profile.about}. ` : ''}Edit your profile`
    : 'Add your name and a line about you';

  /** The design input states, in one place so both fields cannot drift apart. */
  const fieldSurface = (field: 'name' | 'about') => ({
    backgroundColor: t.color.paperSheet,
    borderColor: focused === field ? t.color.pine : t.color.lineStrong,
    borderWidth: focused === field ? 2 : 1,
  });

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      {editing ? (
        <View
          style={[
            styles.editHeader,
            {
              // minHeight, not height: at an accessibility text size the
              // Cancel/Save labels grow and a fixed 56pt box clips them.
              minHeight: t.layout.headerHeight,
              borderBottomWidth: t.hairline,
              borderBottomColor: t.color.lineSoft,
            },
          ]}
        >
          <HeaderAction
            label={COPY.cancel}
            width={64}
            onPress={cancelEdit}
            disabled={saving}
            testID="profile-cancel"
          />
          <View style={styles.editHeaderCenter}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={[t.type.screenTitle, { color: t.color.inkStrong }]}
            >
              {COPY.editTitle}
            </Text>
          </View>
          <HeaderAction
            label={COPY.save}
            width={56}
            onPress={() => void save()}
            disabled={!dirty || saving}
            busy={saving}
            testID="profile-save"
          />
        </View>
      ) : (
        <ScreenHeader
          title={COPY.title}
          onBack={onBack}
          backLabel="Back"
          testIDBack="profile-back"
          right={
            <HeaderAction
              label={COPY.edit}
              width={52}
              onPress={openEdit}
              testID="profile-edit"
            />
          }
        />
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: t.layout.gutter },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          {editing ? (
            <>
              <View style={styles.hero}>
                <Avatar
                  peerId={profile.userId}
                  displayName={name}
                  photoB64={avatarB64}
                  size={104}
                  monogramSize={t.type.screenTitle.fontSize}
                />
                <View style={styles.photoActions}>
                  <PhotoAction
                    label={COPY.choosePhoto}
                    onPress={() => void choosePhoto('library')}
                    testID="profile-choose-photo"
                  />
                  <View style={styles.actionGap} />
                  <PhotoAction
                    label={COPY.takePhoto}
                    onPress={() => void choosePhoto('camera')}
                    testID="profile-take-photo"
                  />
                </View>
                {avatarB64 !== '' ? (
                  <Pressable
                    onPress={() => {
                      setAvatarB64('');
                      setPhotoError(null);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.removePhoto}
                    testID="profile-remove-photo"
                    style={({ pressed }) => [
                      styles.removePhoto,
                      {
                        minHeight: t.layout.touchTarget,
                        borderRadius: t.radius.button,
                        backgroundColor: pressed
                          ? t.color.dangerWash
                          : 'transparent',
                      },
                    ]}
                  >
                    <Text
                      style={[t.type.buttonCompact, { color: t.color.danger }]}
                    >
                      {COPY.removePhoto}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {photoError ? (
                <>
                  <InlineError
                    message={photoError.message}
                    testID="profile-photo-error"
                  />
                  {photoError.settings ? (
                    <Pressable
                      onPress={() => void Linking.openSettings()}
                      accessibilityRole="button"
                      accessibilityLabel={COPY.openSettings}
                      testID="profile-open-photo-settings"
                      style={({ pressed }) => [
                        styles.settingsLink,
                        {
                          minHeight: t.layout.touchTarget,
                          borderRadius: t.radius.button,
                          backgroundColor: pressed
                            ? t.color.pineWash
                            : 'transparent',
                        },
                      ]}
                    >
                      <Text
                        style={[t.type.buttonCompact, { color: t.color.pine }]}
                      >
                        {COPY.openSettings}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}

              <View style={styles.fields}>
                <FieldLabel
                  label={COPY.nameLabel}
                  count={`${name.length}/${NAME_MAX}`}
                />
                <TextInput
                  value={name}
                  onChangeText={setName}
                  onFocus={() => setFocused('name')}
                  onBlur={() => setFocused(null)}
                  editable={!saving}
                  maxLength={NAME_MAX}
                  placeholder={COPY.namePlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  accessibilityLabel={COPY.nameLabel}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  testID="profile-name-input"
                  style={[
                    t.type.input,
                    styles.field,
                    styles.nameField,
                    {
                      borderRadius: t.radius.button,
                      color: t.color.inkStrong,
                    },
                    fieldSurface('name'),
                  ]}
                />

                <FieldLabel
                  label={COPY.aboutLabel}
                  count={`${about.length}/${ABOUT_MAX}`}
                  marginTop={20}
                />
                <TextInput
                  value={about}
                  onChangeText={setAbout}
                  onFocus={() => setFocused('about')}
                  onBlur={() => setFocused(null)}
                  editable={!saving}
                  maxLength={ABOUT_MAX}
                  multiline
                  numberOfLines={3}
                  placeholder={COPY.aboutPlaceholder}
                  placeholderTextColor={t.color.inkMuted}
                  accessibilityLabel={COPY.aboutLabel}
                  testID="profile-about-input"
                  style={[
                    t.type.input,
                    styles.field,
                    styles.aboutField,
                    {
                      borderRadius: t.radius.button,
                      color: t.color.inkStrong,
                    },
                    fieldSurface('about'),
                  ]}
                />
              </View>

              <View
                style={[
                  styles.privacy,
                  {
                    backgroundColor: t.color.paperLayer,
                    borderLeftColor: t.color.pine,
                  },
                ]}
              >
                <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
                  {COPY.privacy}
                </Text>
              </View>

              {saveError ? (
                <InlineError message={saveError} testID="profile-error" />
              ) : null}
            </>
          ) : (
            <>
              <View style={styles.hero}>
                <Pressable
                  onPress={openEdit}
                  accessibilityRole="button"
                  accessibilityLabel="Edit your profile"
                  style={({ pressed }) => [
                    styles.avatarTarget,
                    {
                      borderRadius: t.radius.circle,
                      backgroundColor: pressed
                        ? t.color.pineWash
                        : 'transparent',
                    },
                  ]}
                >
                  <Avatar
                    peerId={profile.userId}
                    displayName={profile.displayName}
                    photoB64={profile.avatarB64}
                    size={104}
                    monogramSize={t.type.screenTitle.fontSize}
                  />
                </Pressable>
                {/* `Add a name` is an imperative verb in the placeholder
                    treatment iOS uses for tappable empty states, so the whole
                    block is the control rather than only the avatar above it.
                    The sharing note is deliberately outside the label: it is
                    reference text, not something to hear on every focus. */}
                <Pressable
                  onPress={openEdit}
                  accessibilityRole="button"
                  accessibilityLabel={heroLabel}
                  testID="profile-edit-hero"
                  style={({ pressed }) => [
                    styles.heroText,
                    {
                      marginHorizontal: -t.layout.gutter,
                      paddingHorizontal: t.layout.gutter,
                      borderRadius: t.radius.button,
                      backgroundColor: pressed
                        ? t.color.pineWash
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    numberOfLines={2}
                    style={[
                      t.type.screenTitle,
                      styles.heroName,
                      {
                        color: hasName ? t.color.inkStrong : t.color.inkMuted,
                      },
                    ]}
                  >
                    {hasName ? profile.displayName : COPY.noName}
                  </Text>
                  <Text
                    numberOfLines={3}
                    style={[
                      t.type.body,
                      styles.heroAbout,
                      { color: hasAbout ? t.color.inkBody : t.color.inkMuted },
                    ]}
                  >
                    {hasAbout ? profile.about : COPY.noAbout}
                  </Text>
                  <Text
                    style={[
                      t.type.compactBody,
                      styles.heroSharing,
                      { color: t.color.inkMuted },
                    ]}
                  >
                    {COPY.sharing}
                  </Text>
                </Pressable>
              </View>

              {notice ? (
                <InlineNotice message={notice} tone="pine" marginTop={16} />
              ) : null}

              {/* Full-bleed sheet: each row keeps its own 16pt padding, so
                  the labels still line up with the rest of the column. */}
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
                {/* An ID nobody can look up has to be handed over somehow, and
                    reading 26 characters aloud is not it. */}
                <IdentityRow
                  label={COPY.idLabel}
                  value={profile.userId}
                  first
                  valueTestID="profile-user-id"
                  spellValue
                  leadingAction={{
                    label: COPY.copyId,
                    onPress: copyId,
                    testID: 'copy-profile-user-id',
                  }}
                  action={{
                    label: COPY.shareId,
                    onPress: () => void shareId(),
                    testID: 'share-profile-user-id',
                    anchorRef: shareAnchor,
                  }}
                />
              </View>

              {/* Settings entry: the same full-bleed sheet idiom as the
                  identity block above it. */}
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
                <Pressable
                  onPress={onOpenSettings}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.settings}
                  testID="profile-open-settings"
                  style={({ pressed }) => [
                    styles.settingsRow,
                    {
                      minHeight: t.layout.rowHeight,
                      paddingHorizontal: t.layout.gutter,
                      backgroundColor: pressed
                        ? t.color.paperInset
                        : 'transparent',
                    },
                  ]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.settings}
                  </Text>
                  <Text style={[t.type.iconGlyph, { color: t.color.inkMuted }]}>
                    ›
                  </Text>
                </Pressable>
              </View>

              <View
                style={[
                  styles.signOut,
                  {
                    borderTopWidth: t.hairline,
                    borderTopColor: t.color.lineSoft,
                  },
                ]}
              >
                <Pressable
                  onPress={() => setConfirmingSignOut(true)}
                  disabled={confirmingSignOut}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.signOut}
                  accessibilityState={{ expanded: confirmingSignOut }}
                  testID="profile-sign-out"
                  style={({ pressed }) => [
                    styles.signOutAction,
                    {
                      minHeight: t.layout.buttonHeight,
                      borderRadius: t.radius.button,
                      // Destructive controls take the danger wash rather than
                      // the pine one; the press must not read as reassurance.
                      backgroundColor: pressed
                        ? t.color.dangerWash
                        : 'transparent',
                    },
                  ]}
                >
                  <Text style={[t.type.button, { color: t.color.danger }]}>
                    {COPY.signOut}
                  </Text>
                </Pressable>

                {confirmingSignOut ? (
                  <View
                    style={[
                      styles.confirm,
                      {
                        backgroundColor: t.color.dangerWash,
                        borderLeftColor: t.color.danger,
                      },
                    ]}
                  >
                    <Text
                      style={[t.type.compactBody, { color: t.color.inkBody }]}
                    >
                      {COPY.signOutConfirm}
                    </Text>
                    <View style={styles.confirmActions}>
                      <Pressable
                        onPress={() => {
                          setConfirmingSignOut(false);
                          setSignOutError(null);
                        }}
                        disabled={signingOut}
                        accessibilityRole="button"
                        accessibilityLabel={COPY.keepSignedIn}
                        testID="profile-keep-signed-in"
                        style={({ pressed }) => [
                          styles.confirmAction,
                          {
                            minHeight: t.layout.touchTarget,
                            borderRadius: t.radius.button,
                            backgroundColor: pressed
                              ? t.color.pineWash
                              : 'transparent',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            t.type.buttonCompact,
                            {
                              color: signingOut
                                ? t.color.inkMuted
                                : t.color.pine,
                            },
                          ]}
                        >
                          {COPY.keepSignedIn}
                        </Text>
                      </Pressable>
                      <View style={styles.actionGap} />
                      <Pressable
                        onPress={() => void confirmSignOut()}
                        disabled={signingOut}
                        accessibilityRole="button"
                        // Not the same word as the control that opened this
                        // panel: a confirmation has to name its consequence.
                        accessibilityLabel={COPY.confirmSignOut}
                        accessibilityState={{ disabled: signingOut }}
                        testID="profile-sign-out-confirm"
                        style={({ pressed }) => [
                          styles.confirmAction,
                          {
                            minHeight: t.layout.touchTarget,
                            borderRadius: t.radius.button,
                            borderWidth: 1,
                            borderColor: signingOut
                              ? t.color.lineSoft
                              : t.color.danger,
                            backgroundColor: signingOut
                              ? t.color.paperInset
                              : pressed
                                ? t.color.dangerWash
                                : 'transparent',
                          },
                        ]}
                      >
                        <Text
                          style={[
                            t.type.buttonCompact,
                            {
                              color: signingOut
                                ? t.color.inkMuted
                                : t.color.danger,
                            },
                          ]}
                        >
                          {COPY.confirmSignOut}
                        </Text>
                      </Pressable>
                    </View>
                    {signOutError ? (
                      <InlineError
                        message={signOutError}
                        testID="sign-out-error"
                        // Danger wash on danger wash measures 4.33:1, under AA.
                        surface={t.color.paperSheet}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** Header text action. Disabled is muted ink on the same paper, never fade. */
function HeaderAction({
  label,
  width,
  onPress,
  disabled,
  busy,
  testID,
}: {
  label: string;
  width: number;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      testID={testID}
      style={({ pressed }) => [
        styles.headerAction,
        {
          width,
          minHeight: t.layout.touchTarget,
          borderRadius: t.radius.button,
          backgroundColor:
            pressed && !disabled ? t.color.pineWash : 'transparent',
        },
      ]}
    >
      <Text
        style={[
          t.type.buttonCompact,
          styles.centerText,
          { color: disabled ? t.color.inkMuted : t.color.pine },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One of the two equal photo-source actions. Outline, not fill: neither one
 * is the page's primary action — Save is. */
function PhotoAction({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.photoAction,
        {
          minHeight: t.layout.touchTarget,
          borderRadius: t.radius.button,
          borderWidth: 1,
          borderColor: pressed ? t.color.pineLine : t.color.lineStrong,
          backgroundColor: pressed ? t.color.pineWash : t.color.paperSheet,
        },
      ]}
    >
      <Text
        style={[
          t.type.buttonCompact,
          styles.centerText,
          { color: t.color.pine },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Field label on the left, character count on the right, on one baseline. */
function FieldLabel({
  label,
  count,
  marginTop = 0,
}: {
  label: string;
  count: string;
  marginTop?: number;
}) {
  const t = useTheme();
  return (
    <View style={[styles.fieldLabelRow, { marginTop }]}>
      <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
        {label}
      </Text>
      {/* Decorative: VoiceOver reads the field's own value and limit. */}
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[t.type.counter, { color: t.color.inkMuted }]}
      >
        {count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 32, alignItems: 'center' },
  column: { width: '100%' },

  editHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  editHeaderCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerAction: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },

  hero: { marginTop: 24, alignItems: 'center' },
  avatarTarget: {
    width: 112,
    height: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The 16pt gap under the avatar is split across the margin and the padding so
  // the pressed wash starts below the avatar's own target rather than at it.
  heroText: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 8,
  },
  heroName: { textAlign: 'center' },
  heroAbout: { marginTop: 6, maxWidth: 320, textAlign: 'center' },
  heroSharing: { marginTop: 12, maxWidth: 320, textAlign: 'center' },
  settingsLink: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 8,
    // Keeps the label optically on the gutter despite its own hit padding.
    marginLeft: -8,
  },

  // The two actions sit 24 from the screen edge; the column already holds 16.
  photoActions: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    marginTop: 12,
    marginHorizontal: 8,
  },
  photoAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionGap: { width: 8 },
  removePhoto: {
    marginTop: 8,
    minWidth: 120,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },

  fields: { marginTop: 28 },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  field: { marginTop: 8, paddingHorizontal: 14 },
  nameField: { minHeight: 52 },
  aboutField: {
    minHeight: 92,
    maxHeight: 120,
    paddingTop: 14,
    paddingBottom: 12,
  },

  privacy: { marginTop: 20, borderLeftWidth: 2, padding: 12 },

  identity: { marginTop: 28 },

  signOut: { marginTop: 32 },
  signOutAction: { alignItems: 'center', justifyContent: 'center' },
  confirm: { borderLeftWidth: 3, padding: 12 },
  confirmActions: { flexDirection: 'row', marginTop: 10 },
  confirmAction: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
