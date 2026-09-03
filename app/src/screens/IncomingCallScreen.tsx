import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cameraAvailableForAnswer } from '../call';
import { Avatar } from '../ui/Avatar';
import { useTheme } from '../theme';

/**
 * The incoming-call screen.
 *
 * Used ONLY when the app is already in the foreground. CallKit owns the
 * backgrounded and locked cases entirely — it draws the system call UI, and
 * drawing our own there would either be ignored or produce two rings.
 *
 * Three answers rather than two. "Accept as audio" exists because a video
 * invite arriving at a bad moment is a real and frequent situation, and the
 * alternative — decline, then call back voice-only — costs both people a
 * round trip. It is also the honest fallback when the camera permission is
 * denied, which is a first-class state rather than an error.
 */

export interface IncomingCallScreenProps {
  peerName: string;
  /** The caller's profile picture, when the database holds one. */
  peerAvatarB64?: string | null;
  /** The caller opened with video. A hint for what to offer, not a promise. */
  withVideo: boolean;
  /**
   * Camera denied: video answers are impossible, so do not offer them.
   * Omitted, the screen asks the module itself while it rings — the prop
   * used to default to `true`, so a person who had refused the camera was
   * offered "Answer with video", the answer said `vid:true`, and the caller
   * stared at black. */
  cameraAvailable?: boolean;
  onAccept(): void;
  onAcceptAudioOnly(): void;
  onDecline(): void;
}

export function IncomingCallScreen({
  peerName,
  peerAvatarB64,
  withVideo,
  cameraAvailable: cameraAvailableProp,
  onAccept,
  onAcceptAudioOnly,
  onDecline,
}: IncomingCallScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // The module's answer, when the prop leaves it to the screen. Read once
  // per ring and only for a video invite — an audio invite offers no video
  // answer whatever the camera says. Optimistic until it lands (a status
  // read, not a prompt) so the buttons do not flicker in from nothing.
  const [cameraRead, setCameraRead] = useState<boolean | null>(null);
  useEffect(() => {
    if (cameraAvailableProp !== undefined || !withVideo) return undefined;
    let live = true;
    void cameraAvailableForAnswer().then(ok => {
      if (live) setCameraRead(ok);
    });
    return () => {
      live = false;
    };
  }, [cameraAvailableProp, withVideo]);
  const cameraAvailable = cameraAvailableProp ?? cameraRead ?? true;

  // Offered only when it adds something: on an audio call it is the same
  // action as Accept, and two buttons that do the same thing is a worse
  // screen, not a more capable one.
  const offerAudioOnly = withVideo && cameraAvailable;

  return (
    <View
      style={[styles.root, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}
      accessibilityViewIsModal
      accessibilityLabel={`Incoming ${withVideo ? 'video' : 'audio'} call from ${peerName}`}
    >
      <StatusBar barStyle="light-content" />

      <View style={styles.identity}>
        <View style={styles.avatar}>
          {peerAvatarB64 ? (
            <Avatar
              peerId=""
              displayName={peerName}
              photoB64={peerAvatarB64}
              size={120}
              accessibilityLabel={`${peerName}'s picture`}
            />
          ) : (
            <Text style={styles.avatarLetter}>{peerName.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <Text style={styles.peer} numberOfLines={1} accessibilityRole="header">
          {peerName}
        </Text>
        <Text style={styles.kind}>
          {withVideo ? 'Incoming video call' : 'Incoming call'}
        </Text>
        {withVideo && !cameraAvailable && (
          // Said plainly rather than by omission: a person who denied camera
          // access should learn that here, not by wondering why the video
          // button vanished.
          <Text style={styles.note}>
            Camera access is off, so this will connect as audio.
          </Text>
        )}
      </View>

      <View style={styles.actions}>
        <AnswerButton
          label="Decline"
          tone="danger"
          onPress={onDecline}
          theme={theme}
        />
        {offerAudioOnly && (
          <AnswerButton
            label="Answer without video"
            tone="neutral"
            onPress={onAcceptAudioOnly}
            theme={theme}
          />
        )}
        <AnswerButton
          label={withVideo && cameraAvailable ? 'Answer with video' : 'Answer'}
          tone="accept"
          onPress={withVideo && cameraAvailable ? onAccept : onAcceptAudioOnly}
          theme={theme}
        />
      </View>
    </View>
  );
}

function AnswerButton({
  label,
  tone,
  onPress,
  theme,
}: {
  label: string;
  tone: 'accept' | 'decline' | 'danger' | 'neutral';
  onPress(): void;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
  const background =
    tone === 'danger'
      ? theme.color.danger
      : tone === 'accept'
        ? theme.color.pine
        : theme.color.mediaLine;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          minHeight: 56,
          minWidth: 44,
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 28,
          paddingHorizontal: 12,
          backgroundColor: background,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={{ color: theme.color.onPine, fontSize: 15, fontWeight: '600' }}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.color.mediaBlack,
      justifyContent: 'space-between',
      paddingHorizontal: 20,
    },
    identity: { alignItems: 'center', gap: 12 },
    avatar: {
      width: 112,
      height: 112,
      borderRadius: 56,
      backgroundColor: theme.color.pineWash,
      borderWidth: 1,
      borderColor: theme.color.pineLine,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarLetter: { color: theme.color.mediaInk, fontSize: 40, fontWeight: '600' },
    peer: { color: theme.color.mediaInk, fontSize: 24, fontWeight: '600' },
    kind: { color: theme.color.mediaInkMuted, fontSize: 15 },
    note: { color: theme.color.mediaInkMuted, fontSize: 13, textAlign: 'center' },
    actions: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
  });
}
