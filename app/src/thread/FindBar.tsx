// Find replaces the conversation header so the controls still fit at narrow
// widths and large text sizes. Copy is supplied by ChatThreadScreen, keeping
// platform-specific wording in the screen's copy deck.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '../theme';
import { CloseGlyph } from '../ui/AttachGlyph';
import { InfoDisclosure } from '../ui/InfoDisclosure';

/**
 * Everything the bar says, handed in from the thread's own deck.
 *
 * The keys are the DECK'S OWN key names, so the screen passes its `COPY`
 * object straight through and there is no projection object in the middle
 * to fall out of step with it.
 */
export interface FindCopy {
  /** The field's placeholder. */
  findPlaceholder: string;
  /** The close control's spoken label. */
  findClose: string;
  /** The step-back-through-time control's spoken label. */
  findNext: string;
  /** The step-toward-the-newest control's spoken label. */
  findPrevious: string;
  /** "3 of 12" — one-based, because the reading is for a person. */
  findCount: (i: number, n: number) => string;
  /** Said when the query is good and nothing matched it. */
  findNone: string;
  /** Said below the floor: fewer than two letters. */
  findTooShort: string;
  /** The ⓘ's label — what the disclosure is ABOUT. */
  findAboutLabel: string;
  /** The teaching copy behind it. */
  findAbout: readonly string[];
}

/**
 * The magnifier that opens find, for the header's trailing group.
 *
 * DRAWN, not typed. It began as the character `⌕` (U+2315) in the mono
 * face; Roboto Mono has no such glyph, so on any device whose fallback
 * chain misses it the release's headline affordance is an empty box — and
 * no jest run can see that, because the test renderer has no fonts. This is
 * the house pattern instead (`AttachGlyph`, `CallGlyph`): stroked line art
 * in a 24×24 box, taking its colour from the caller, hidden from VoiceOver
 * because the button around it already carries the label.
 *
 * A FIXED `size` avoids font scaling entirely: a drawing has no font to scale
 * with, so the control cannot grow out of its 44pt target at any text size.
 * That is what keeps a three-target header from clipping at XXL — the
 * glyphs are fixed and the title, which wraps under a 1.8× cap, compresses.
 */
export function FindGlyph({
  size = 22,
  color,
}: {
  size?: number;
  color: string;
}): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle cx="10.6" cy="10.6" r="6.35" stroke={color} strokeWidth={1.9} fill="none" />
      <Path
        d="m15.35 15.35 4.4 4.4"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export function FindBar({
  copy,
  value,
  onChange,
  onClose,
  onNext,
  onPrevious,
  cursor,
  total,
  ready,
  settled,
}: {
  copy: FindCopy;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  /** Step BACK through the conversation — matches arrive newest first. */
  onNext: () => void;
  /** Step toward the newest match. */
  onPrevious: () => void;
  /** Which match is showing, zero-based. */
  cursor: number;
  total: number;
  /** Whether the query has reached the two-letter floor. */
  ready: boolean;
  /**
   * Whether `total` answers for the query IN THE FIELD, rather than for an
   * older one (or for nothing at all).
   *
   * `ready` flips on the second character; the matches cannot answer until
   * the debounce has fired and the read has come back. Without this the bar
   * says "No message here matches that." about every query for its first
   * 400 ms, and answers a refined query with the old query's count.
   */
  settled: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  // Unsettled is treated as "nowhere to step": the reading is hidden while
  // an answer is in flight, and a stepper that still walked the PREVIOUS
  // query's rows would scroll the list to a match with no count to explain
  // it. Both ends go disabled together, as they do on an empty result.
  const atNewest = !settled || cursor <= 0;
  const atOldest = !settled || total === 0 || cursor >= total - 1;
  return (
    <View
      testID="thread-find-bar"
      style={[
        styles.bar,
        {
          paddingHorizontal: t.layout.gutter,
          paddingVertical: t.space.s4,
          gap: t.space.s4,
          borderBottomColor: t.color.lineSoft,
          borderBottomWidth: t.hairline,
        },
      ]}
    >
      <View style={[styles.row, { gap: t.space.s5 }]}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={copy.findClose}
          testID="thread-find-close"
          style={({ pressed }) => [
            styles.target,
            {
              minWidth: t.layout.touchTarget,
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.circle,
            },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <CloseGlyph size={20} color={t.color.inkStrong} />
        </Pressable>

        <TextInput
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={copy.findPlaceholder}
          placeholderTextColor={t.color.inkMuted}
          accessibilityLabel={copy.findPlaceholder}
          // The lookup field's hygiene: nothing here is a sentence, so
          // autocorrect and a capital first letter would only fight the
          // person. `returnKeyType` is the keyboard's own word — the COPY
          // never says "search".
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoFocus
          // The system keyboard follows the palette, the selection is pine,
          // and the placeholder is muted ink — the three theming props every
          // field in this app carries. The caret is named too: left alone,
          // Android draws it from the system's day or night accent rather
          // than the palette chosen in the app.
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          cursorColor={t.color.pine}
          testID="thread-find-field"
          style={[
            t.type.input,
            styles.field,
            {
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.button,
              backgroundColor: t.color.paperSheet,
              color: t.color.inkStrong,
              borderWidth: focused ? 2 : 1,
              borderColor: focused ? t.color.pine : t.color.lineField,
            },
          ]}
        />

        {settled && total > 0 ? (
          <Text
            testID="thread-find-count"
            // The reading is a count, not a sentence, and it must not push
            // the steppers off a narrow header when the text size grows.
            numberOfLines={1}
            maxFontSizeMultiplier={1.4}
            style={[t.type.timeStatus, { color: t.color.inkMuted }]}
          >
            {copy.findCount(cursor + 1, total)}
          </Text>
        ) : null}

        {/* Matches arrive newest first, so "next" walks BACK through the
            conversation — which on screen is upward. The arrows say where
            the view goes; the labels say where the count goes. */}
        <Pressable
          onPress={onNext}
          disabled={atOldest}
          accessibilityRole="button"
          accessibilityLabel={copy.findNext}
          accessibilityState={{ disabled: atOldest }}
          testID="thread-find-next"
          style={({ pressed }) => [
            styles.target,
            {
              minWidth: t.layout.touchTarget,
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.circle,
            },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[
              t.type.iconGlyph,
              { color: atOldest ? t.color.inkMuted : t.color.inkStrong },
            ]}
          >
            ↑
          </Text>
        </Pressable>
        <Pressable
          onPress={onPrevious}
          disabled={atNewest}
          accessibilityRole="button"
          accessibilityLabel={copy.findPrevious}
          accessibilityState={{ disabled: atNewest }}
          testID="thread-find-previous"
          style={({ pressed }) => [
            styles.target,
            {
              minWidth: t.layout.touchTarget,
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.circle,
            },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[
              t.type.iconGlyph,
              { color: atNewest ? t.color.inkMuted : t.color.inkStrong },
            ]}
          >
            ↓
          </Text>
        </Pressable>
      </View>

      {/* One line of state, then the ⓘ. The teaching copy stays behind the
          disclosure (the house pattern): a person who already knows this
          reads it once and never again.

          NOTHING IS SAID ABOUT A QUERY NOTHING HAS ANSWERED YET: below the
          floor the bar names the floor, and once an answer for THIS query
          is in it reports what came back. In between — the debounce and the
          read — it is silent, because "No message here matches that." would
          be a false negative on every first query of every find session. */}
      {!ready ? (
        <Text
          testID="thread-find-too-short"
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {copy.findTooShort}
        </Text>
      ) : settled && total === 0 ? (
        <Text
          testID="thread-find-none"
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {copy.findNone}
        </Text>
      ) : null}

      <InfoDisclosure
        label={copy.findAboutLabel}
        lines={copy.findAbout}
        testID="thread-find-about"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Never shorter than the header it replaces (`ScreenHeader`'s own
  // `minHeight`), so opening and closing find does not shift the list up
  // and down under the eye of someone trying to read a match.
  bar: { flexDirection: 'column', minHeight: 56 },
  row: { flexDirection: 'row', alignItems: 'center' },
  target: { alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
});
