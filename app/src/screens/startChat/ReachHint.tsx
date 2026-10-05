import React, { useEffect } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { CheckGlyph, IdGlyph, MailGlyph, PersonGlyph } from './glyphs';

/**
 * The row under Open a room's field that says what the field was given —
 * "Tacendum ID · 26 of 26", "Email", "That’s you · Your ID" — and, for a
 * complete ID that is not yours, reads it back in two lines of groups.
 *
 * Presentational: the screen computes every string. Three rules this row
 * keeps for screen readers:
 *  - the kind node holds ONLY the kind label, so the Android live region
 *    speaks a kind change and nothing else;
 *  - the counter is hidden: a count spoken on every keystroke is chatter,
 *    and the go key gives the count in words when it matters;
 *  - on iOS a kind change is announced once, 400 ms after it settles, and a
 *    newer change (or leaving) cancels a pending one. The screen hands down
 *    `announced`, the last words iOS heard, so a row that unmounts and comes
 *    back with the same words stays quiet.
 *
 * Grey glyph and charcoal label; forest only for the complete count and its
 * tick, because forest means an action or a selection everywhere else.
 */

export interface ReachHintProps {
  glyph: 'id' | 'person' | 'mail' | null;
  label: string;
  labelTone: 'strong' | 'muted';
  /** What the kind node says to a screen reader. */
  spoken: string;
  counter?: { text: string; tone: 'muted' | 'pine' | 'danger'; check: boolean };
  status?: { text: string; tone: 'muted' | 'danger' };
  /** A complete ID that is not yours, in two lines of groups. */
  readback?: { text: string; spoken: string };
  /** The last kind announced on iOS, kept by the screen across mounts. */
  announced?: { current: string | null };
}

/** How long a kind must hold before iOS hears it. */
const ANNOUNCE_MS = 400;

export function ReachHint({
  glyph,
  label,
  labelTone,
  spoken,
  counter,
  status,
  readback,
  announced,
}: ReachHintProps): React.JSX.Element {
  const t = useTheme();

  useEffect(() => {
    // Android's live region below already speaks the kind node; announcing
    // there too would say it twice.
    if (Platform.OS !== 'ios') return undefined;
    if (announced?.current === spoken) return undefined;
    const timer = setTimeout(() => {
      if (announced) announced.current = spoken;
      AccessibilityInfo.announceForAccessibilityWithOptions(spoken, { queue: true });
    }, ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [spoken, announced]);

  const toneColor = (tone: 'muted' | 'pine' | 'danger'): string =>
    tone === 'danger' ? t.color.danger : tone === 'pine' ? t.color.pine : t.color.inkMuted;

  return (
    <View>
      <View style={styles.row}>
        <View
          testID="reach-kind"
          accessible
          accessibilityLabel={spoken}
          accessibilityLiveRegion="polite"
          style={styles.kind}
        >
          {glyph === 'id' ? <IdGlyph color={t.color.inkMuted} /> : null}
          {glyph === 'person' ? <PersonGlyph color={t.color.inkMuted} /> : null}
          {glyph === 'mail' ? <MailGlyph color={t.color.inkMuted} /> : null}
          <Text
            style={[
              t.type.compactStrong,
              { color: labelTone === 'muted' ? t.color.inkMuted : t.color.inkStrong },
            ]}
          >
            {label}
          </Text>
        </View>
        {counter || status ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>·</Text>
          </View>
        ) : null}
        {counter ? (
          <View
            style={styles.counter}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text testID="reach-counter" style={[t.type.counter, { color: toneColor(counter.tone) }]}>
              {counter.text}
            </Text>
            {counter.check ? <CheckGlyph color={t.color.pine} /> : null}
          </View>
        ) : null}
        {status ? (
          <Text
            testID="reach-status"
            style={[t.type.compactBody, styles.status, { color: toneColor(status.tone) }]}
          >
            {status.text}
          </Text>
        ) : null}
      </View>
      {readback ? (
        <Text
          testID="reach-id-readback"
          accessibilityLabel={readback.spoken}
          maxFontSizeMultiplier={2}
          style={[styles.readback, { fontFamily: t.mono, color: t.color.inkStrong }]}
        >
          {readback.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 4,
    minHeight: 24,
    marginTop: 8,
  },
  kind: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { flexShrink: 1 },
  // Mono 15/20: the other person's My ID, line for line, at any width.
  readback: { fontSize: 15, lineHeight: 20, fontWeight: '400', marginTop: 4 },
});
