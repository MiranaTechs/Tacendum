import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ProfileRow } from '../db';
import { useKeyboardInset } from '../keyboardInset';
import { NAME_MAX, normalizeName, skipNaming, submitName } from '../naming';
import { NAMING_COPY } from '../namingCopy';
import { useTheme } from '../theme';
import { Avatar } from '../ui/Avatar';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import { InlineError, PrimaryButton, TextAction } from '../ui/primitives';

interface Props {
  profile: ProfileRow;
  /** The step is spent: the saved row when a name went in, null on Not now
   * — the caller keeps whatever it held. Called exactly once. */
  onDone: (saved: ProfileRow | null) => void;
}

/**
 * The naming moment: "What should people call you?",
 * asked once, right after a successful registration, and SKIPPABLE — a
 * person who would rather stay an id tail is allowed to, and the chat list
 * teaches how to reach someone either way.
 *
 * A first-run state of the home surface, not a route: the facts the
 * visible-surface module states for the chat list hold for it unchanged
 * (covered during capture — a typed name is on glass — workspace open, no
 * conversation content), and a process that dies here leaves the account
 * nameless and unsettled, which is exactly what the list's one-time nudge is
 * for.
 *
 * Nothing on this screen reaches the network: the name is written locally
 * through the existing card path and reaches peers lazily, over the existing
 * profile-card machinery, the next time each chat is touched.
 */
export function NamingScreen({ profile, onDone }: Props) {
  const t = useTheme();
  const keyboardInset = useKeyboardInset();
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = normalizeName(name) !== '';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Awaited for the same reason ProfileScreen awaits it: sharing is
      // swallowed inside, so the only thing the await can fail on is the
      // local write — the part the step depends on.
      const saved = await submitName(profile, name);
      if (!saved) throw new Error('profile missing after save');
      onDone(saved);
    } catch {
      setError(NAMING_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    // Best-effort: a failed marker write costs one more nudge later, and a
    // person who said "Not now" must not be held on this screen for it.
    await skipNaming().catch(() => undefined);
    onDone(null);
  };

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingHorizontal: t.layout.gutter },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* The monogram the name will replace: a live preview of what the
            people you chat with see, drawn from the field as it is typed. */}
        <View style={styles.hero}>
          <Avatar
            peerId={profile.userId}
            displayName={normalizeName(name)}
            photoB64={profile.avatarB64}
            size={72}
            monogramSize={t.type.screenTitle.fontSize}
          />
        </View>
        <Text
          accessibilityRole="header"
          style={[
            t.type.screenTitle,
            styles.title,
            { color: t.color.inkStrong },
          ]}
        >
          {NAMING_COPY.title}
        </Text>
        <Text style={[t.type.body, { color: t.color.inkBody }]}>
          {NAMING_COPY.lead}
        </Text>

        <TextInput
          value={name}
          onChangeText={setName}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={NAMING_COPY.placeholder}
          placeholderTextColor={t.color.inkMuted}
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          accessibilityLabel={NAMING_COPY.fieldLabel}
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={NAME_MAX}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (ready && !saving) void save();
          }}
          testID="naming-input"
          style={[
            t.type.input,
            styles.input,
            {
              minHeight: t.layout.buttonHeight,
              borderRadius: t.radius.button,
              backgroundColor: t.color.paperSheet,
              color: t.color.inkStrong,
              // The design input states, as ProfileScreen draws them.
              borderColor: focused ? t.color.pine : t.color.lineStrong,
              borderWidth: focused ? 2 : 1,
            },
          ]}
        />

        <InfoDisclosure
          label={NAMING_COPY.infoLabel}
          lines={NAMING_COPY.infoLines}
          testID="naming-info"
        />

        {error ? <InlineError message={error} testID="naming-error" /> : null}

        <PrimaryButton
          label={NAMING_COPY.continue}
          onPress={() => void save()}
          disabled={!ready}
          busy={saving}
          busyLabel={NAMING_COPY.saving}
          testID="naming-continue"
        />
        <View style={styles.skip}>
          <TextAction
            label={NAMING_COPY.skip}
            onPress={() => void skip()}
            disabled={saving}
            testID="naming-skip"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingTop: 32, paddingBottom: 48, gap: 14 },
  hero: { alignItems: 'center', marginBottom: 4 },
  title: { textAlign: 'center' },
  input: { paddingHorizontal: 14 },
  skip: { alignItems: 'center' },
});
