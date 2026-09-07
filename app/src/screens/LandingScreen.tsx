import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { BrandLockup } from '../ui/BrandMark';
import { PrimaryButton, TextAction } from '../ui/primitives';
import { UPDATE_COPY } from '../updateGateCopy';
import { usePaneWidth } from '../windowClass';

interface Props {
  onGetStarted: () => void;
  /**
   * The update check this door runs before registration begins
   * (check point 1) is out.
   *
   * It can take seconds — a slow link spends the gate's whole three second
   * ceiling — and for every one of them the button used to sit there looking
   * pressable and doing nothing, which is how a person ends up pressing it
   * twice. Busy is the same treatment the wall's "Check again" already gets,
   * for the same reason: the only control on the screen has to say what it
   * is doing.
   */
  checkingUpdate?: boolean;
  /** "Recover my account grouping" (item 3) — BESIDE
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
export function LandingScreen({
  onGetStarted,
  checkingUpdate = false,
  onRecover,
}: Props) {
  const t = useTheme();
  // The PANE's width. Landing is a full-window route at
  // every width (a pinned fact), so this answers the window today — the point
  // is that content sizing reads the pane axis, uniformly, everywhere.
  const width = usePaneWidth();
  const gutter =
    width <= t.layout.narrowWidth ? t.layout.gutterNarrow : t.layout.gutterWide;

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      {/* Content keeps its natural height at accessibility sizes, so the
          welcome and its actions stay reachable by scrolling. */}
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
          {/* Sized by the wordmark; the lockup is a fixed-width object, so it
              steps down where the gutters leave it no room. */}
          <BrandLockup size={width <= t.layout.narrowWidth ? 30 : 36} animate />
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
        </View>

        <PrimaryButton
          label="Get started"
          onPress={onGetStarted}
          busy={checkingUpdate}
          busyLabel={UPDATE_COPY.checking}
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
            t.type.compactBody,
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
  // Keep the welcome together on a tablet and preserve its intrinsic height
  // when larger accessibility text needs the ScrollView to grow.
  hero: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 480,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
  },
  blurb: { marginTop: 32, maxWidth: 330, textAlign: 'center' },
  promise: { marginTop: 18, maxWidth: 330, textAlign: 'center' },
  // A capped, stretched child starts at the left gutter on wide panes.
  // Explicit width plus center alignment keeps the action under the lockup.
  cta: { width: '100%', alignSelf: 'center', maxWidth: 342, marginTop: 24 },
  recover: { marginTop: 8, alignItems: 'center' },
  footer: { marginTop: 24, textAlign: 'center' },
});
