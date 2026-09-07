import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cameraAvailableForAnswer } from '../call';
import { Avatar } from '../ui/Avatar';
import { tileName, UNNAMED } from '../ui/CallTile';
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
  peerId: string;
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
  peerId,
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
  const { fontScale } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // The module's answer, when the prop leaves it to the screen. Read once
  // per ring and only for a video invite — an audio invite offers no video
  // answer whatever the camera says. Unknown stays unknown on glass: only a
  // successful status read may advertise video, while Decline and audio
  // answer stay usable and the tap remains the only permission request.
  const [cameraRead, setCameraRead] = useState<boolean | null>(null);
  useEffect(() => {
    if (cameraAvailableProp !== undefined || !withVideo) return undefined;
    let live = true;
    void cameraAvailableForAnswer()
      .then(ok => {
        if (live) setCameraRead(ok);
      })
      .catch(() => {
        if (live) setCameraRead(false);
      });
    return () => {
      live = false;
    };
  }, [cameraAvailableProp, withVideo]);
  const cameraPending =
    withVideo && cameraAvailableProp === undefined && cameraRead === null;
  const cameraAvailable = (cameraAvailableProp ?? cameraRead) === true;
  const shownName = tileName(peerId, peerName);
  const unnamed = shownName === UNNAMED;

  // Offered only when it adds something: on an audio call it is the same
  // action as Accept, and two buttons that do the same thing is a worse
  // screen, not a more capable one.
  const offerAudioOnly = withVideo && (cameraPending || cameraAvailable);

  return (
    <View
      style={styles.root}
      accessibilityViewIsModal
      accessibilityLabel={`Incoming ${
        withVideo ? 'video' : 'audio'
      } call from ${shownName}`}
    >
      <StatusBar barStyle="light-content" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 },
        ]}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Avatar
              peerId={peerId}
              displayName={shownName}
              {...(unnamed ? { monogramOverride: '?' } : {})}
              photoB64={peerAvatarB64}
              size={120}
              accessibilityLabel={`${shownName}'s picture`}
            />
          </View>
          <Text
            style={styles.peer}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {shownName}
          </Text>
          <Text style={styles.kind}>
            {withVideo ? 'Incoming video call' : 'Incoming call'}
          </Text>
          {withVideo && !cameraPending && !cameraAvailable && (
            // Said plainly rather than by omission: a person who denied camera
            // access should learn that here, not by wondering why the video
            // button vanished.
            <Text style={styles.note}>
              Video isn’t available right now, so this will connect as audio.
            </Text>
          )}
        </View>

        <View style={styles.actions}>
          <AnswerButton
            label={
              cameraPending
                ? 'Checking camera…'
                : withVideo && cameraAvailable
                ? 'Answer with video'
                : 'Answer'
            }
            tone="accept"
            onPress={
              withVideo && cameraAvailable ? onAccept : onAcceptAudioOnly
            }
            disabled={cameraPending}
            theme={theme}
          />
          <View style={styles.secondaryActions}>
            <AnswerButton
              label="Decline"
              tone="danger"
              onPress={onDecline}
              basis={150 * fontScale}
              theme={theme}
            />
            {offerAudioOnly && (
              <AnswerButton
                label="Answer without video"
                tone="neutral"
                onPress={onAcceptAudioOnly}
                basis={150 * fontScale}
                theme={theme}
              />
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function AnswerButton({
  label,
  tone,
  onPress,
  disabled = false,
  basis,
  theme,
}: {
  label: string;
  tone: 'accept' | 'decline' | 'danger' | 'neutral';
  onPress(): void;
  disabled?: boolean;
  basis?: number;
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
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        {
          minHeight: 56,
          minWidth: 44,
          flexBasis: basis,
          flexGrow: basis === undefined ? 0 : 1,
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 28,
          paddingHorizontal: 12,
          paddingVertical: 16,
          backgroundColor: background,
          opacity: disabled ? 0.55 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={{
          color:
            tone === 'accept' || tone === 'danger'
              ? theme.color.onPine
              : theme.color.mediaInk,
          fontSize: 15,
          fontWeight: '600',
          textAlign: 'center',
        }}
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
    },
    scroll: { flex: 1 },
    content: {
      flexGrow: 1,
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      gap: 32,
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
    peer: { color: theme.color.mediaInk, fontSize: 24, fontWeight: '600' },
    kind: { color: theme.color.mediaInkMuted, fontSize: 15 },
    note: {
      color: theme.color.mediaInkMuted,
      fontSize: 13,
      textAlign: 'center',
    },
    actions: { gap: 12 },
    secondaryActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
      alignItems: 'stretch',
    },
  });
}
