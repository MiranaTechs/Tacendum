import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as db from '../db';
import { messaging } from '../messaging';
import { sanitizeDisplayName, shortId } from '../person';
import { useTheme } from '../theme';
import { clockLabel, dayLabel } from '../time';
import { useReduceMotion } from '../useReduceMotion';
import { usePaneWidth } from '../windowClass';

interface Props {
  msgId: string;
  direction: 'in' | 'out';
  /**
   * Whose chat this photo belongs to, so the context bar can name the sender.
   * Optional: the message row carries the same id, so the bar is correct
   * whether or not the route passes it.
   */
  peerId?: string;
  /**
   * This device's own account id, for the one row `direction` cannot
   * classify: a room photo I authored, relayed back as shared history —
   * direction 'in', authorId mine. The thread's nameFor says "You" for it;
   * without this the bar would say "…MYIDTAIL" about my own photo.
   */
  selfId?: string;
  onClose: () => void;
}

/** Two taps closer together than this are one double tap. */
const DOUBLE_TAP_MS = 300;
/** Zoom scales drift by fractions, so "not zoomed" needs a tolerance. */
const UNZOOMED = 1.01;
/** Drag further than this, or flick faster, and the viewer closes. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.8;
/** Drag distance at which the photo reaches its faintest. */
const FADE_SPAN = 400;

/**
 * A photo, full screen. This is a destination with its own route — not a
 * floating modal over the conversation — which is why it can own the only
 * dark surface in the app without turning anything else dark.
 *
 * Every gesture here is react-native core: pinch and pan come from the
 * underlying UIScrollView, dismiss from a PanResponder. No gesture library
 * and no new pod.
 */
export function PhotoViewerScreen({
  msgId,
  direction,
  peerId,
  selfId,
  onClose,
}: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  // The PANE's width. The photoViewer is a full-window
  // route at every width (a pinned fact — it is never projected into a pane),
  // so this answers the window today; the height read stays the window's,
  // which is every pane's height under this shell.
  const vw = usePaneWidth();
  const { height: vh } = useWindowDimensions();

  const [photo, setPhoto] = useState<db.AttachmentRow | null>(null);
  const [message, setMessage] = useState<db.MessageRow | null>(null);
  const [chat, setChat] = useState<db.ChatRow | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [quarter, setQuarter] = useState(0);

  const scrollRef = useRef<ScrollView>(null);
  const zoomScale = useRef(1);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const chromeFade = useRef(new Animated.Value(1)).current;

  // A photo can land while its viewer is already open (an attachment left
  // 'pending' by a previous launch re-downloads on boot), so this follows the
  // row rather than reading it once. The identity guard matters: notify fires
  // on every receipt and reaction, and a fresh dataB64 string would make RN
  // re-decode the image each time.
  useEffect(() => {
    const read = () => {
      void db
        .getAttachment(msgId, direction)
        .then(next =>
          setPhoto(prev =>
            prev?.state === next?.state && prev?.dataB64 === next?.dataB64
              ? prev
              : next,
          ),
        )
        .catch(() => undefined); // db closed behind the lock screen
    };
    read();
    return messaging.subscribe(read);
  }, [msgId, direction]);

  useEffect(() => {
    let live = true;
    void db
      .getMessage(msgId, direction)
      .then(async row => {
        if (!live) return;
        setMessage(row);
        // The AUTHOR outranks the route id: in a room thread the route
        // carries the ROOM's id, and a room's chats row names the room, not
        // whoever took the photo. `authorId` is the authenticated writer; a 1:1 row has none, and there the thread id IS
        // the author.
        const who = row?.authorId ?? peerId ?? row?.peerId;
        if (!who) return;
        const found = await db.getChat(who);
        if (live) setChat(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [msgId, direction, peerId]);

  // Named only once the row is loaded: the route's peerId is the THREAD id,
  // which in a room is the room's ULID — naming from it before the row
  // resolves would flash a room id fragment in the sender slot. Until
  // then the bar says "Photo", the same answer it gives a rowless open.
  const author = message
    ? message.authorId ?? peerId ?? message.peerId ?? ''
    : '';
  // Two labels are refused the sender slot (the thread's nameFor rule): a
  // person self-named "You" would forge this screen's own 'You', and "them"
  // is prose, not a label — both fall back to the id fragment. The id
  // fallback is the AUTHOR's, never the room's.
  // Sanitized per layer, so a card that is nothing but marks falls
  // through to the id fragment exactly as personName would drop it.
  const shared = author
    ? sanitizeDisplayName(chat?.localName) || sanitizeDisplayName(chat?.displayName)
    : '';
  const safeShared = /^(you|them)$/i.test(shared) ? '' : shared;
  // A history-shared copy of my own photo: direction 'in', author me. The
  // genuine 'You' — the guard above blocks only impostors, never the owner.
  const mine = author !== '' && author === selfId;
  const name = author ? (mine ? 'You' : safeShared || shortId(author)) : '';
  const ts = message?.ts ?? null;
  const when = ts === null ? '' : `${dayLabel(ts)} at ${clockLabel(ts)}`;
  const w = photo?.w ?? null;
  const h = photo?.h ?? null;
  const context = [when, w && h ? `${w} × ${h}` : null]
    .filter(Boolean)
    .join(' · ');
  const photoLabel = [
    // Prose refers to a person by name or pronoun, never an id fragment
    // (person.ts's labels-vs-prose rule).
    direction === 'out'
      ? 'Photo you sent'
      : `Photo from ${mine ? 'you' : safeShared || 'them'}`,
    when,
  ]
    .filter(Boolean)
    .join(', ');

  const state = photo?.state ?? null;
  // A row with no bytes cannot be rendered whatever it claims about itself.
  const ready = state === 'ready' && !!photo?.dataB64;
  const failed = state === 'failed' || (state === 'ready' && !photo?.dataB64);
  const loading = !ready && !failed;

  useEffect(() => {
    AccessibilityInfo.announceForAccessibilityWithOptions(
      'Photo, full screen',
      { queue: true },
    );
  }, []);

  // Announce only a CHANGE of state, so the mount announcement above is not
  // immediately followed by a redundant one for a photo that was already here.
  const announced = useRef<db.AttachmentState | null>(null);
  useEffect(() => {
    if (state === null || state === announced.current) return;
    const first = announced.current === null;
    announced.current = state;
    if (first) return;
    if (state === 'ready') {
      AccessibilityInfo.announceForAccessibilityWithOptions('Photo ready', {
        queue: true,
      });
    } else if (state === 'failed') {
      AccessibilityInfo.announceForAccessibilityWithOptions(
        'Photo couldn’t load.',
        { queue: true },
      );
    }
  }, [state]);

  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
    },
    [],
  );

  const close = useCallback(() => {
    // Reset the transform before the route changes: the next photo opened
    // must not inherit this one's rotation or drag offset.
    setQuarter(0);
    spin.setValue(0);
    dragY.setValue(0);
    onClose();
  }, [dragY, onClose, spin]);

  const settle = useCallback(() => {
    if (reduceMotion) {
      dragY.setValue(0);
      return;
    }
    Animated.timing(dragY, {
      toValue: 0,
      duration: t.motion.surface,
      easing: t.motion.easing,
      useNativeDriver: false,
    }).start();
  }, [dragY, reduceMotion, t.motion]);

  // The dismiss drag and the ScrollView's own pan must stay disjoint: this
  // only claims the gesture at 1x, past 12pt, and only when it is clearly
  // vertical — so panning a zoomed photo pans instead of closing.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          zoomScale.current <= UNZOOMED &&
          Math.abs(g.dy) > 12 &&
          Math.abs(g.dy) > Math.abs(g.dx) * 1.6,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => {
          if (!reduceMotion) dragY.setValue(g.dy);
        },
        onPanResponderRelease: (_, g) => {
          if (
            Math.abs(g.dy) > DISMISS_DISTANCE ||
            Math.abs(g.vy) > DISMISS_VELOCITY
          ) {
            close();
            return;
          }
          settle();
        },
        onPanResponderTerminate: settle,
      }),
    [close, dragY, reduceMotion, settle],
  );

  const onTap = useCallback(
    (e: GestureResponderEvent) => {
      const { locationX, locationY } = e.nativeEvent;
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        if (tapTimer.current) {
          clearTimeout(tapTimer.current);
          tapTimer.current = null;
        }
        const animated = !reduceMotion;
        scrollRef.current?.scrollResponderZoomTo(
          zoomScale.current > UNZOOMED
            ? { x: 0, y: 0, width: vw, height: vh, animated }
            : {
                x: locationX - vw / 6,
                y: locationY - vh / 6,
                width: vw / 3,
                height: vh / 3,
                animated,
              },
        );
        return;
      }
      lastTap.current = now;
      // The chrome only toggles once this tap is known not to be the first
      // half of a double tap — otherwise zooming also flashes the bars.
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        setChromeVisible(visible => !visible);
      }, DOUBLE_TAP_MS);
    },
    [reduceMotion, vh, vw],
  );

  useEffect(() => {
    const to = chromeVisible ? 1 : 0;
    if (reduceMotion) {
      chromeFade.setValue(to);
      return;
    }
    Animated.timing(chromeFade, {
      toValue: to,
      duration: t.motion.micro,
      easing: t.motion.easing,
      useNativeDriver: true,
    }).start();
  }, [chromeFade, chromeVisible, reduceMotion, t.motion]);

  // Rotating in place, because the phone is locked to portrait and every
  // paper screen is designed for it. A quarter turn only fits if the photo is
  // rescaled to the sideways fit; even quarters are the untouched fit.
  const oddScale = useMemo(() => {
    if (!w || !h) return 1;
    const upright = Math.min(vw / w, vh / h);
    const sideways = Math.min(vw / h, vh / w);
    return upright > 0 ? sideways / upright : 1;
  }, [h, vh, vw, w]);

  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(quarter);
      return;
    }
    Animated.timing(spin, {
      toValue: quarter,
      duration: t.motion.surface,
      easing: t.motion.easing,
      useNativeDriver: true,
    }).start();
  }, [quarter, reduceMotion, spin, t.motion]);

  const rotate = useMemo(
    () =>
      spin.interpolate({
        inputRange: [0, 1, 2, 3],
        outputRange: ['0deg', '90deg', '180deg', '270deg'],
      }),
    [spin],
  );
  const rotateScale = useMemo(
    () =>
      spin.interpolate({
        inputRange: [0, 1, 2, 3],
        outputRange: [1, oddScale, 1, oddScale],
      }),
    [oddScale, spin],
  );
  const dragOpacity = useMemo(
    () =>
      dragY.interpolate({
        inputRange: [-FADE_SPAN, 0, FADE_SPAN],
        outputRange: [0.4, 1, 0.4],
        extrapolate: 'clamp',
      }),
    [dragY],
  );

  const retry = useCallback(() => {
    // The same call the bubble makes. In a duress session there is no token,
    // so this resolves without touching the network.
    void db
      .getMessage(msgId, direction)
      .then(row =>
        row ? messaging.retryAttachment(msgId, direction, row.body) : undefined,
      )
      .catch(() => undefined);
  }, [direction, msgId]);

  const barHeight = t.layout.headerHeight;
  const chromeStyle = {
    opacity: chromeFade,
    backgroundColor: t.color.mediaBlack,
  };
  // The image carries the fade, never a scrim over content: this wrapper holds
  // nothing but the photo. It also keeps the JS-driven drag off the same view
  // as the natively driven rotation, so the two drivers never meet on one node.
  const dragStyle = reduceMotion
    ? null
    : { transform: [{ translateY: dragY }], opacity: dragOpacity };

  return (
    <View
      style={[styles.root, { backgroundColor: t.color.mediaBlack }]}
      {...pan.panHandlers}
    >
      {/* RN's StatusBar is a stack of mounted declarations: this one wins while
          the viewer is mounted and unmounting reverts to App.tsx's dark ink.
          Without it the clock is black on the black ground. Android also
          paints the bar itself, so it takes the viewer's black too, rather
          than leaving the app's white bar above a black photo. */}
      <StatusBar
        barStyle="light-content"
        backgroundColor={t.color.mediaBlack}
        animated={false}
      />

      <Animated.View style={[styles.fill, dragStyle]}>
        <ScrollView
          ref={scrollRef}
          style={styles.fill}
          contentContainerStyle={styles.fill}
          minimumZoomScale={1}
          maximumZoomScale={4}
          bouncesZoom
          // No vertical rubber band at 1x: it would swallow the drag the
          // dismiss gesture is watching for.
          bounces={false}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={e => {
            zoomScale.current = e.nativeEvent.zoomScale;
          }}
        >
          {ready && photo?.dataB64 ? (
            <Pressable onPress={onTap} style={styles.fill}>
              <Animated.Image
                source={{ uri: `data:image/jpeg;base64,${photo.dataB64}` }}
                style={[
                  styles.fill,
                  { transform: [{ rotate }, { scale: rotateScale }] },
                ]}
                resizeMode="contain"
                accessible
                accessibilityRole="image"
                accessibilityLabel={photoLabel}
              />
            </Pressable>
          ) : null}

          {loading ? (
            <View style={styles.center}>
              {reduceMotion ? (
                <Text
                  style={[t.type.timeStatus, { color: t.color.mediaInkMuted }]}
                >
                  Loading photo…
                </Text>
              ) : (
                <ActivityIndicator color={t.color.mediaInk} />
              )}
            </View>
          ) : null}

          {failed ? (
            <View style={styles.center}>
              <View
                style={[
                  styles.alertSquare,
                  { borderColor: t.color.dangerOnMedia },
                ]}
              >
                <Text
                  style={[
                    t.type.utilityLabel,
                    { color: t.color.dangerOnMedia },
                  ]}
                >
                  !
                </Text>
              </View>
              <Text
                style={[
                  t.type.compactBody,
                  styles.failedText,
                  { color: t.color.mediaInk },
                ]}
              >
                Photo couldn’t load.
              </Text>
              <Pressable
                onPress={retry}
                accessibilityRole="button"
                testID="photo-retry"
                style={styles.action}
              >
                <Text
                  style={[t.type.buttonCompact, { color: t.color.mediaInk }]}
                >
                  Try again
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </Animated.View>

      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        accessibilityElementsHidden={!chromeVisible}
        importantForAccessibility={
          chromeVisible ? 'auto' : 'no-hide-descendants'
        }
        style={[
          styles.topBar,
          chromeStyle,
          {
            height: barHeight + insets.top,
            paddingTop: insets.top,
            paddingLeft: insets.left + 8,
            paddingRight: insets.right + 8,
            borderBottomWidth: t.hairline,
            borderBottomColor: t.color.mediaLine,
          },
        ]}
      >
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          accessibilityHint="Returns to the room"
          testID="photo-close"
          style={styles.target}
        >
          <Text
            allowFontScaling={false}
            style={[
              t.type.iconGlyph,
              styles.closeGlyph,
              { color: t.color.mediaInk },
            ]}
          >
            ×
          </Text>
        </Pressable>

        <View style={styles.context} testID="photo-context">
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.6}
            style={[t.type.compactStrong, { color: t.color.mediaInk }]}
          >
            {direction === 'out' ? 'You' : name || 'Photo'}
          </Text>
          {context ? (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.6}
              style={[t.type.timeStatus, { color: t.color.mediaInkMuted }]}
            >
              {context}
            </Text>
          ) : null}
        </View>

        {/* Balances the close control so the context stays optically centred. */}
        <View style={styles.target} />
      </Animated.View>

      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        accessibilityElementsHidden={!chromeVisible}
        importantForAccessibility={
          chromeVisible ? 'auto' : 'no-hide-descendants'
        }
        style={[
          styles.bottomBar,
          chromeStyle,
          {
            height: barHeight + insets.bottom,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left + 8,
            paddingRight: insets.right + 8,
            borderTopWidth: t.hairline,
            borderTopColor: t.color.mediaLine,
          },
        ]}
      >
        {/* Nothing to turn until there is an image; the bar keeps its place so
            the layout does not jump when the photo lands. */}
        {ready ? (
          <Pressable
            onPress={() => setQuarter(q => (q + 1) % 4)}
            accessibilityRole="button"
            accessibilityLabel="Rotate photo"
            testID="photo-rotate"
            style={styles.action}
          >
            <Text style={[t.type.buttonCompact, { color: t.color.mediaInk }]}>
              Rotate
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  alertSquare: {
    width: 24,
    height: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failedText: { textAlign: 'center' },
  target: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  closeGlyph: { fontSize: 26, lineHeight: 28 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  context: { flex: 1, alignItems: 'center' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
});
