/**
 * The update wall.
 *
 * A ROUTE, not a modal, and this file is why that matters: there is no back
 * affordance, no dismissal, and nothing else on it, because there is nowhere
 * to go back to. A dismissible sheet would leave the person standing in a
 * workspace we have just said cannot connect.
 *
 * Nothing is running behind it on either path there. The boot path returns
 * from `enterRealWorkspace` before `messaging.start`, so the socket is never
 * opened; the foreground path arrives from a workspace that WAS open and
 * takes it down first (`quiesceForUpdateWall` in App.tsx). Without that
 * second half the screen said "This version can no longer connect" over a
 * build that was, at that moment, connected.
 *
 * The store button exists only when the policy carried a link. An operator
 * row is typed by hand and the link is optional in the DTO by design, so a
 * row written in a hurry must still produce a screen that tells someone what
 * to do — the sentence does that, and a button that opens nothing does not.
 */

import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { BrandMark } from '../ui/BrandMark';
import { PrimaryButton, TextAction } from '../ui/primitives';
import { UPDATE_COPY } from '../updateGateCopy';
import { usePaneWidth } from '../windowClass';

/**
 * What the recheck says when it settles unchanged. It lives here rather than
 * in `updateGateCopy`, which holds the vocabulary the wall SHARES with the
 * other update surfaces; nothing else in the app says this one. ("Checking…"
 * used to live here too, and moved to the deck when the landing screen's
 * "Get started" started saying it as well.)
 */
const STILL_OLD = 'Still the old version.';

interface Props {
  /** The store link from the policy, when it carried one. */
  url?: string;
  /** The operator's one extra line, when the row carried one. */
  message?: string;
  /** A recheck is in flight. */
  checking?: boolean;
  /** The last recheck came back blocked, i.e. nothing changed. */
  stillOld?: boolean;
  /** Ask the server again. The same controller the boot path used. */
  onCheckAgain: () => void;
}

export function UpdateRequiredScreen({
  url,
  message,
  checking = false,
  stillOld = false,
  onCheckAgain,
}: Props) {
  const t = useTheme();
  const width = usePaneWidth();
  const gutter =
    width <= t.layout.narrowWidth ? t.layout.gutterNarrow : t.layout.gutterWide;

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: gutter },
        ]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        testID="update-required"
      >
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel="Tacendum"
        >
          <BrandMark size={20} />
        </View>

        <Text
          accessibilityRole="header"
          style={[t.type.screenTitle, styles.title, { color: t.color.inkStrong }]}
        >
          {UPDATE_COPY.title}
        </Text>
        <Text style={[t.type.body, styles.body, { color: t.color.inkBody }]}>
          {UPDATE_COPY.body}
        </Text>
        {message ? (
          // The operator's own words, bounded to 200 characters by the DTO so
          // a row can never turn this screen into a billboard.
          <Text
            testID="update-message"
            style={[t.type.compactBody, styles.body, { color: t.color.inkBody }]}
          >
            {message}
          </Text>
        ) : null}

        {url ? (
          <PrimaryButton
            label={UPDATE_COPY.open}
            onPress={() => {
              // Best effort: a store link that will not open leaves the
              // sentence and "Check again" standing, which is the whole
              // reason both are here.
              void Linking.openURL(url).catch(() => undefined);
            }}
            testID="update-open-store"
            style={styles.cta}
          />
        ) : (
          <Text
            testID="update-where"
            style={[t.type.compactBody, styles.body, { color: t.color.inkMuted }]}
          >
            {UPDATE_COPY.where}
          </Text>
        )}

        <View style={styles.recheck}>
          {/* The only control on a screen with no way out, so it has to say
              what it is doing. Unlabelled and undisabled it read as dead:
              nothing moved while the request was out, and nothing moved
              when the answer came back the same. */}
          <TextAction
            label={checking ? UPDATE_COPY.checking : UPDATE_COPY.recheck}
            onPress={onCheckAgain}
            disabled={checking}
            testID="update-check-again"
          />
        </View>
        {stillOld && !checking ? (
          <Text
            testID="update-still-old"
            style={[t.type.compactBody, styles.settled, { color: t.color.inkMuted }]}
          >
            {STILL_OLD}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 20 },
  scroll: { flex: 1 },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 18,
  },
  title: { marginTop: 28, textAlign: 'center' },
  body: { marginTop: 12, textAlign: 'center' },
  cta: { marginTop: 28, alignSelf: 'stretch' },
  recheck: { marginTop: 18 },
  settled: { marginTop: 8, textAlign: 'center' },
});
