import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme';

/**
 * The compact AI marker (the Art. 50 in-conversation
 * marker). One anatomy for both surfaces — the thread's per-message tag and
 * the roster's attribution — copied from the roster's owner badge
 * (GroupProfileScreen `ownerBadge`): utilityLabel face, pine ink, pineLine
 * outline, the small radius. Outlined, never filled: a filled pill would sit
 * heavier than the owner badge beside it and start reading as a status.
 *
 * WHERE THE TRUTH COMES FROM is the caller's contract, stated here because
 * this component must never grow a second path: render this ONLY from the
 * `machine_peers` lookup of an AUTHENTICATED id (row.authorId in rooms, the
 * thread's peer in a 1:1) — never from message text, a shared display name,
 * or anything else a peer composes. The badge is words, not colour alone,
 * and it is attribution, not verification: it may never say "verified".
 *
 * Visual-only by default (`accessibilityElementsHidden`): each surface
 * carries the spoken attribution in its own label (the bubble's
 * accessibilityLabel, the member row's), where it reads in order — a marker
 * spoken after the words is a disclosure that came too late.
 */
export function AgentBadge({
  label,
  testID,
}: {
  label: string;
  testID?: string;
}) {
  const t = useTheme();
  return (
    <Text
      {...(testID ? { testID } : {})}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      numberOfLines={1}
      style={[
        t.type.utilityLabel,
        styles.badge,
        {
          color: t.color.pine,
          borderColor: t.color.pineLine,
          borderRadius: t.radius.small,
        },
      ]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'center',
    flexShrink: 0,
  },
});
