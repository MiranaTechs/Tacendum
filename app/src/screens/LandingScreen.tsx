import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { BrandLockup } from '../ui/BrandMark';
import { PrimaryButton, TextAction } from '../ui/primitives';
import { usePaneWidth } from '../windowClass';

interface Props {
  onGetStarted: () => void;
  /** "Recover my account grouping" — BESIDE
   * registration, never in it: its own door on this surface, its own
   * screen, and the register flow stays identifier-free. */
  onRecover: () => void;
}

/**
 * The promise that separates Tacendum from every messenger already on the
 * phone, said once. It belongs here rather than at the phone field: by the
 * time someone is asked for their number, the assumption that it will be used
 * to build a contact graph has already been made.
 *
 * This was three boxed claims. Three stacked panels read as a form to fill in
 * rather than a welcome, and two of them repeated the line above.
 */
const PROMISE = 'No feed. No directory. No contacts uploaded.';

/**
 * Pre-auth welcome. The wordmark and the Quiet Room carry the whole identity
 * here — the site's ambient glyph field is deliberately absent, so the first
 * screen is already as quiet as the product it promises.
 */
export function LandingScreen({ onGetStarted, onRecover }: Props) {
  const t = useTheme();
  // The PANE's width. Landing is a full-window route at
  // every width (a pinned fact), so this answers the window today — the point
  // is that content sizing reads the pane axis, uniformly, everywhere.
  const width = usePaneWidth();
  const gutter =
    width <= t.layout.narrowWidth ? t.layout.gutterNarrow : t.layout.gutterWide;

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      {/* flexGrow + justifyContent centre reproduce the fixed layout exactly at
          default text size; at an accessibility size the page scrolls instead
          of pushing Get started off a screen with no gesture to recover it. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: gutter },
        ]}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.hero}>
          {/* Unequal spacers instead of centring: the block sits a quarter of
              the free height above centre, so the empty paper collects between
              it and the button rather than above the name. */}
          <View style={styles.spacerAbove} />
          {/* Sized by the wordmark; the lockup is a fixed-width object, so it
              steps down where the gutters leave it no room. */}
          <BrandLockup size={width <= t.layout.narrowWidth ? 30 : 36} animate />
          <View style={styles.spacerMiddle} />
          <Text style={[t.type.body, styles.blurb, { color: t.color.inkBody }]}>
            Message the people who matter — one chat at a time.
          </Text>
          <Text
            style={[
              t.type.compactBody,
              styles.promise,
              { color: t.color.inkMuted },
            ]}
          >
            {PROMISE}
          </Text>
          <View style={styles.spacerBelow} />
        </View>

        <PrimaryButton
          label="Get started"
          onPress={onGetStarted}
          testID="landing-get-started"
          style={styles.cta}
        />

        {/* Recovery sits beside the create door:
            a quiet text action, because the common case is a fresh start —
            and the recover screen leads with what recovery does NOT restore
            before it asks for anything. */}
        <View style={styles.recover}>
          <TextAction
            label="Recover my account grouping"
            onPress={onRecover}
            testID="landing-recover"
          />
        </View>

        <Text
          style={[
            t.type.utilityData,
            styles.footer,
            { color: t.color.inkMuted },
          ]}
        >
          End-to-end encrypted.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 20 },
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 18,
  },
  // flexGrow rather than flex, so the hero keeps its content height as its
  // flex basis: `flex: 1` would let it shrink below its content and hide the
  // overflow outside the scrollable extent at large text sizes.
  // flexGrow holds the three blocks together in the optical centre while the
  // button settles at the foot of the screen rather than trailing the text.
  hero: {
    flexGrow: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  // The three weights sum to 2, so the 0.5 above always leaves the lockup at
  // 25% of the free height. Splitting the remaining 1.5 evenly moves the two
  // lines of copy down to meet the button instead of stranding them mid-screen.
  spacerAbove: { flex: 0.5 },
  spacerMiddle: { flex: 0.75 },
  spacerBelow: { flex: 0.75 },
  // Each block is a separate thing to read: the name, what it does, what it
  // refuses to do. The space between them is what makes them three.
  blurb: { marginTop: 0, maxWidth: 330, textAlign: 'center' },
  promise: { marginTop: 36, maxWidth: 330, textAlign: 'center' },
  cta: { alignSelf: 'stretch', maxWidth: 342, marginTop: 32 },
  recover: { marginTop: 8, alignItems: 'center' },
  footer: { marginTop: 24, textAlign: 'center' },
});
