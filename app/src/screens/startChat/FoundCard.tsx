import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../ui/Avatar';
import { InfoDisclosure } from '../../ui/InfoDisclosure';
import { InlineError, PrimaryButton } from '../../ui/primitives';

/**
 * The person a Find answered, in place under Open a room's field.
 *
 * The card is labelled with what the person TYPED — never the account ID the
 * lookup resolved, which flows into the ordinary room-open path and never
 * reaches the glass. Its face is the shared Avatar, so it looks like every
 * other person in the app; the Avatar is lettered from that typed label
 * through `monogramOverride` and is handed no account ID, which this card
 * must never hold.
 *
 * When it appears it is announced (iOS: once per found person, so a failed
 * start re-rendering it says nothing twice; Android: the name line is a
 * polite live region), and screen-reader focus moves to the name line — not
 * the button — so "Is this really them?" is reached before Open room. The
 * Find button that held focus has just unmounted under the finger.
 *
 * A failure to open the room on this device stays here, under the button,
 * and the button then retries only that local start: a local failure is not
 * "could not reach Tacendum", and a retry must never spend another lookup.
 */

export interface FoundCardProps {
  label: string;
  devicesLine: string;
  existingLine: string | null;
  buttonLabel: string;
  buttonA11y: string;
  infoLabel: string;
  infoLines: readonly string[];
  onStart: () => void;
  /** Spoken on iOS when the card appears. */
  announce: string;
  /** Which found person this is: the announcement and the focus move happen
   * once per key, never again on a re-render. */
  focusKey: string;
  error?: { message: string; seq: number };
}

export function FoundCard({
  label,
  devicesLine,
  existingLine,
  buttonLabel,
  buttonA11y,
  infoLabel,
  infoLines,
  onStart,
  announce,
  focusKey,
  error,
}: FoundCardProps): React.JSX.Element {
  const t = useTheme();
  const whoRef = useRef<View>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(announce, { queue: true });
    }
    const tag = findNodeHandle(whoRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [announce, focusKey]);

  const initial = label.trim().charAt(0).toUpperCase() || '?';
  const whoLabel = [label, devicesLine, existingLine].filter(Boolean).join(', ');

  return (
    <View
      testID="discovery-result-card"
      style={[
        styles.card,
        {
          borderWidth: t.hairline,
          borderColor: t.color.lineSoft,
          borderRadius: t.radius.drawer,
          backgroundColor: t.color.paperSheet,
        },
      ]}
    >
      <View style={styles.row}>
        {/* The shared face, so the found person looks like every other
            person: its letter is geometry, frozen at every text size, and
            the name beside it scales. The one letter keeps the heading size
            the card's own disc drew it at; Avatar's default fraction of the
            disc is sized for two. Hidden from screen readers, so the name
            line starts with the name. */}
        <View
          testID="discovery-result-disc"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Avatar
            peerId=""
            displayName={label}
            monogramOverride={initial}
            size={40}
            monogramSize={t.type.sectionTitle.fontSize}
          />
        </View>
        <View
          ref={whoRef}
          testID="discovery-result-who"
          accessible
          accessibilityLabel={whoLabel}
          accessibilityLiveRegion="polite"
          style={styles.who}
        >
          <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>{label}</Text>
          <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
            {devicesLine}
          </Text>
          {existingLine ? (
            <Text style={[t.type.compactBody, styles.line, { color: t.color.inkBody }]}>
              {existingLine}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.info}>
        <InfoDisclosure label={infoLabel} lines={infoLines} testID="discovery-result-info" />
      </View>
      <PrimaryButton
        label={buttonLabel}
        accessibilityLabel={buttonA11y}
        onPress={onStart}
        testID="discovery-result"
        style={styles.start}
      />
      {error ? (
        <InlineError
          message={error.message}
          seq={error.seq}
          surface={t.color.paperSheet}
          testID="start-chat-error"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  who: { flex: 1 },
  line: { marginTop: 1 },
  info: { marginTop: 8 },
  start: { marginTop: 4 },
});
