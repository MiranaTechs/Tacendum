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
import { callSurface, PressShade } from '../components/CallControls';
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
 *
 * An app screen, not a media one: nothing here ever shows video, so it sits
 * on the app's own ground (white in light, charcoal in dark). The answer and
 * decline discs are the forest and red every call surface uses.
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
  const surface = callSurface(theme, false);
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
      {/* The app ground's bar: dark glyphs on white, light on charcoal, and
          on Android the bar takes the same ground. */}
      <StatusBar
        barStyle={surface.barStyle}
        backgroundColor={surface.barBackground}
      />
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
  const surface = callSurface(theme, false);
  // Answer and decline are the call actions every call surface shares: one
  // forest disc and one red, each under a white label, in both appearances.
  // Anything else is the neutral control: a white disc inside a gray ring.
  //
  // No state here is drawn with opacity. This screen sits on the white app
  // ground, where a dimmed disc lets the page through: the pending answer
  // (every incoming video call opens on "Checking camera…") was mint under
  // a white label at 2.5:1, and a pressed one 3.8:1. So a button that cannot
  // act is the house's disabled button, the gray inset with a muted label;
  // a finger on the forest or red disc darkens it (PressShade); a finger on
  // the neutral disc fills it with the gray pressed fill.
  const action = (tone === 'accept' || tone === 'danger') && !disabled;
  const background = disabled
    ? theme.color.paperInset
    : tone === 'danger'
      ? surface.endDisc
      : tone === 'accept'
        ? surface.answerDisc
        : surface.idleDisc;
  const ring = action ? null : disabled ? surface.disabledRing : surface.idleRing;
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
          backgroundColor:
            pressed && !action && !disabled ? theme.color.paperInset : background,
          ...(ring === null ? null : { borderWidth: 1, borderColor: ring }),
        },
      ]}
    >
      {({ pressed }) => (
        <>
          {pressed && action ? <PressShade radius={28} theme={theme} /> : null}
          <Text
            style={{
              color: disabled
                ? surface.disabledGlyph
                : action
                  ? surface.actionGlyph
                  : surface.idleGlyph,
              fontSize: 15,
              fontWeight: '600',
              textAlign: 'center',
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  const surface = callSurface(theme, false);
  return StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: surface.ground,
    },
    scroll: { flex: 1 },
    content: {
      flexGrow: 1,
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      gap: 32,
    },
    identity: { alignItems: 'center', gap: 12 },
    /** Placement only: the `Avatar` inside draws the whole face, the app's
     * one face for a person — the photo in its hairline ring, or white
     * letters on the solid forest disc in both appearances. */
    avatar: {
      width: 112,
      height: 112,
      borderRadius: 56,
      alignItems: 'center',
      justifyContent: 'center',
    },
    peer: { color: surface.ink, fontSize: 24, fontWeight: '600' },
    kind: { color: surface.inkMuted, fontSize: 15 },
    note: {
      color: surface.inkMuted,
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
