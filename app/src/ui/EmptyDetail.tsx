import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type * as db from '../db';
import { useTheme } from '../theme';
import { QuietRoom } from './QuietRoom';

const COPY = {
  line: 'Select a room',
};

interface Props {
  /** Fills the room's left place with the owner, exactly as the empty chat
   * list does; the right place stays the quiet dot — nothing is open. Null
   * renders both places empty (the projection only mounts this with a
   * profile, but the type does not know that). */
  profile: db.ProfileRow | null;
}

/**
 * The wide shell's empty DETAIL pane: what the right
 * pane shows when the route is a home surface — chats or calls — and no
 * conversation is open beside the list. Seeded from the QuietRoom signature
 * and deliberately quiet beyond it: the empty
 * LIST already teaches how to reach someone, so this surface holds one
 * instruction and no second lesson.
 *
 * This surface shows NO routed content, which is a security fact, not just
 * a visual one: it contributes no entry to the visible-surface list
 * (`wideVisibleSurface(list, null, …)`), so a screenshot taken over it
 * disclosed nothing and no notice is manufactured.
 */
export function EmptyDetail({ profile }: Props) {
  const t = useTheme();
  return (
    <View
      style={[styles.root, { backgroundColor: t.color.paperGround }]}
      testID="empty-detail"
    >
      {/* Decorative here (no accessibilityLabel): the line below is the
          surface's whole sentence, and VoiceOver should hear it once. */}
      <QuietRoom
        you={
          profile
            ? {
                peerId: profile.userId,
                displayName: profile.displayName,
                photoB64: profile.avatarB64,
              }
            : undefined
        }
        caption={null}
      />
      <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
        {COPY.line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  line: { marginTop: 16, textAlign: 'center' },
});
