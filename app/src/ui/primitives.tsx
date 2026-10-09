import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { Avatar } from './Avatar';

/**
 * The small set of controls every screen shares, so a button, a header, and a
 * rule are identical everywhere. Depth is surface + outline only: nothing here
 * casts a shadow or floats above the page.
 */

/** Screen header: 56pt of content, a bottom hairline, centred title. */
export function ScreenHeader({
  title,
  titleRole = 'screenTitle',
  onBack,
  backLabel = 'Back',
  right,
  testIDBack,
}: {
  title?: React.ReactNode;
  titleRole?: 'screenTitle' | 'brandCompact';
  onBack?: () => void;
  backLabel?: string;
  right?: React.ReactNode;
  testIDBack?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.header,
        { borderBottomColor: t.color.lineSoft, borderBottomWidth: t.hairline },
      ]}
    >
      <View style={styles.headerSide}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            style={({ pressed }) => [
              styles.iconTarget,
              pressed && { backgroundColor: t.color.pineWash },
            ]}
            {...(testIDBack ? { testID: testIDBack } : {})}
          >
            <Text
              style={[
                t.type.iconGlyph,
                styles.backGlyph,
                { color: t.color.inkStrong },
              ]}
              // An icon, not text: its meaning is carried by
              // accessibilityLabel, so scaling it only breaks the 44pt target.
              allowFontScaling={false}
            >
              ‹
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.headerCenter}>
        {typeof title === 'string' ? (
          <Text
            style={[t.type[titleRole], { color: t.color.inkStrong }]}
            accessibilityRole="header"
            // Two lines and a 1.8x cap let a title grow into the header's
            // minHeight instead of being sliced at accessibility sizes.
            numberOfLines={2}
            maxFontSizeMultiplier={1.8}
          >
            {title}
          </Text>
        ) : (
          title
        )}
      </View>
      <View style={styles.headerSide}>{right}</View>
    </View>
  );
}

/**
 * The home tabs' header — Chats and Calls share it, so switching tabs changes
 * the word and nothing else: one title role, one height, and the same profile
 * door in the same corner (the two tabs drew three different headers, and
 * Profile/Settings were unreachable from Calls). Left-aligned, unlike the
 * pushed surfaces' centred ScreenHeader, because a root has no back control
 * to balance.
 *
 * `statusLine` is the optional second line under the title (the chat list's
 * connection state); it rides inside the same minHeight rather than adding to
 * it. The profile door renders only when both the person and the handler are
 * given — a surface that omits them must offer the door elsewhere. */
export function HomeHeader({
  title,
  statusLine,
  profile,
  onOpenProfile,
  profileLabel = 'Open your profile',
  testID,
}: {
  title: string;
  statusLine?: React.ReactNode;
  profile?: {
    userId: string;
    displayName?: string | null;
    avatarB64?: string | null;
  } | null;
  onOpenProfile?: () => void;
  profileLabel?: string;
  testID?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.homeHeader,
        { minHeight: t.layout.headerHeight, paddingHorizontal: t.layout.gutter },
      ]}
      {...(testID ? { testID } : {})}
    >
      <View style={styles.homeHeaderTitles}>
        <Text
          style={[t.type.screenTitle, { color: t.color.inkStrong }]}
          accessibilityRole="header"
          numberOfLines={2}
          maxFontSizeMultiplier={1.8}
        >
          {title}
        </Text>
        {statusLine ?? null}
      </View>
      {profile && onOpenProfile ? (
        <Pressable
          onPress={onOpenProfile}
          accessibilityRole="button"
          accessibilityLabel={profileLabel}
          testID="home-profile-door"
          style={({ pressed }) => [
            styles.iconTarget,
            {
              width: t.layout.touchTarget,
              height: t.layout.touchTarget,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Avatar
            peerId={profile.userId}
            displayName={profile.displayName}
            photoB64={profile.avatarB64}
            size={t.layout.avatar.header}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Full-bleed primary action. Disabled is a recessed surface, never opacity.
 *
 * Busy renders the busyLabel BESIDE the spinner, never instead of it (the
 * identity-redesign designer note: "Busy label: 'Creating your identity…'
 * with spinner, spinner suppressed under Reduce Motion" — a spinner alone
 * says only that something spins). VoiceOver announces the busy label too.
 *
 * The ref lands on the Pressable itself — an accessibility element — so a
 * caller restoring VoiceOver focus after a modal dismissal has a real target,
 * not a wrapper the traversal skips.
 *
 * `accessibilityLabel` is for a button whose words need their object to make
 * sense out loud ("Open room" says "Open room with Mira"); it is spoken only
 * while the button is not busy, so the busy label still announces the wait. */
export const PrimaryButton = React.forwardRef<
  View,
  {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    busyLabel?: string;
    reduceMotion?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    /** Why the button is dark, for a screen reader (the proof pass,
     * 2026-10-08): a disabled submit says nothing on its own, so the date a
     * cool-down ends rides here. */
    accessibilityHint?: string;
  }
>(function PrimaryButtonInner(
  {
    label,
    onPress,
    disabled,
    busy,
    busyLabel,
    reduceMotion,
    testID,
    style,
    accessibilityLabel,
    accessibilityHint,
  },
  ref,
) {
  const t = useTheme();
  const inactive = disabled || busy;
  const shown = busy ? (busyLabel ?? label) : label;
  const spoken = busy ? shown : (accessibilityLabel ?? shown);
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      {...(testID ? { testID } : {})}
      style={({ pressed }) => [
        styles.primaryButton,
        {
          minHeight: t.layout.buttonHeight,
          borderRadius: t.radius.button,
          backgroundColor: disabled
            ? t.color.paperInset
            : pressed
              ? t.color.pinePressed
              : t.color.pine,
          borderWidth: disabled ? 1 : 0,
          borderColor: t.color.lineSoft,
        },
        style,
      ]}
    >
      {busy && !reduceMotion ? (
        <ActivityIndicator color={t.color.onPine} />
      ) : null}
      <Text
        style={[
          t.type.button,
          { color: disabled ? t.color.inkMuted : t.color.onPine },
        ]}
      >
        {shown}
      </Text>
    </Pressable>
  );
});

/** A labelled horizontal rule: hairline, text, hairline. */
export function RuledLabel({
  label,
  marginTop = 0,
  marginBottom = 0,
  minHeight,
  height,
  role = 'utilityLabel',
  heading = false,
}: {
  label: string;
  marginTop?: number;
  marginBottom?: number;
  /** Row floor; defaults to the label's own line box (date dividers). */
  minHeight?: number;
  /** @deprecated Alias of minHeight — a ruled row must be able to grow. */
  height?: number;
  role?: 'utilityLabel' | 'timeStatus';
  /**
   * Offer this row to the VoiceOver rotor's Headings navigator — a section
   * label on a long scroll (Settings has eight, and reaching Appearance
   * otherwise means swiping past every row above it).
   *
   * It makes the row an accessibility ELEMENT as well as giving it the role,
   * and it has to: a View is not enumerable unless `accessible` says so, and
   * RN never derives that from the role (`View.js` maps `aria-*` and nothing
   * else). A header trait alone is a stop the rotor never offers and a node
   * TalkBack never focuses — it focuses the Text inside and says nothing
   * about a heading. Making the row the element is the shape the thread's
   * unread divider and round header already use, and the label VoiceOver
   * reads is composed from the Text within.
   *
   * Opt-in, and it must stay opt-in: this same component draws the thread's
   * date dividers and Register's consent labels, where a heading per day
   * would flood the rotor the prop exists to make useful. Each screen owner
   * passes it for its own sections.
   */
  heading?: boolean;
}) {
  const t = useTheme();
  const floor = minHeight ?? height;
  return (
    <View
      {...(heading
        ? ({ accessible: true, accessibilityRole: 'header' } as const)
        : {})}
      style={[
        styles.ruledRow,
        { marginTop, marginBottom },
        floor !== undefined && { minHeight: floor },
      ]}
    >
      <View style={[styles.rule, { backgroundColor: t.color.lineSoft }]} />
      <Text
        style={[t.type[role], styles.ruledText, { color: t.color.inkMuted }]}
      >
        {label}
      </Text>
      <View style={[styles.rule, { backgroundColor: t.color.lineSoft }]} />
    </View>
  );
}

/** A pine (or danger) text action sized to the 44pt target: Copy, Share,
 * Skip. The padding gives the pressed wash a shape; callers with a gutter to
 * respect wrap it and spend the overhang themselves.
 *
 * The ref lands on the Pressable itself (the PrimaryButton pattern): a share
 * site hands it to `shareWithAnchor` so the iPad popover points at the
 * control that was pressed rather than floating mid-window. */
export const TextAction = React.forwardRef<
  View,
  {
    label: string;
    onPress: () => void;
    testID?: string;
    tone?: 'pine' | 'danger';
    disabled?: boolean;
  }
>(function TextActionInner(
  { label, onPress, testID, tone = 'pine', disabled },
  ref,
) {
  const t = useTheme();
  const ink = tone === 'danger' ? t.color.danger : t.color.pine;
  const wash = tone === 'danger' ? t.color.dangerWash : t.color.pineWash;
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      {...(testID ? { testID } : {})}
      style={({ pressed }) => [
        styles.textAction,
        {
          minHeight: t.layout.touchTarget,
          borderRadius: t.radius.button,
          backgroundColor: pressed ? wash : 'transparent',
        },
      ]}
    >
      <Text
        style={[
          t.type.buttonCompact,
          { color: disabled ? t.color.inkMuted : ink },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
});

/**
 * The outlined action: a considered step, never a filled button. One shape
 * in three tones — danger for the irreversible (accepting an identity
 * change, recording a mismatch, a delete), warning for a person's own
 * settled decision (a block, a revoke — slate, never red, because safety.ts
 * already assigns warningMark to "a thing to do, not a thing gone wrong"),
 * pine for a plain secondary step — and two sizes: the 52pt button, and the
 * 44pt compact one a row's inline confirm uses beside a TextAction.
 *
 * The peer profile, the room profile and the chat list each drew this
 * button privately, with different paddings and different disabled logic,
 * each comment insisting locality would stop a third screen using it for
 * something alarming — by which point three screens already had. Disabled
 * is a recessed surface with muted ink (the house rule, never opacity), and
 * the pressed wash never paints on a disabled control.
 *
 * `leading` is an optional glyph before the label (Scan, Copy ID, Share ID).
 * Only when one is given does the button lay out as a row with a gap and let
 * the label shrink, so every button without one renders exactly as before.
 * The ref lands on the Pressable itself (the PrimaryButton pattern), so a
 * caller can move screen-reader focus to the button that just replaced
 * another one in place.
 */
export const OutlineButton = React.forwardRef<
  View,
  {
    label: string;
    tone?: 'pine' | 'danger' | 'warning';
    size?: 'regular' | 'compact';
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    leading?: React.ReactNode;
  }
>(function OutlineButtonInner(
  {
    label,
    tone = 'pine',
    size = 'regular',
    onPress,
    disabled,
    testID,
    style,
    leading,
  },
  ref,
) {
  const t = useTheme();
  const line =
    tone === 'danger'
      ? t.color.danger
      : tone === 'warning'
        ? t.color.warningMark
        : t.color.pineLine;
  const ink =
    tone === 'danger'
      ? t.color.danger
      : tone === 'warning'
        ? t.color.warningInk
        : t.color.pine;
  const wash =
    tone === 'danger'
      ? t.color.dangerWash
      : tone === 'warning'
        ? t.color.paperInset
        : t.color.pineWash;
  const compact = size === 'compact';
  const withLeading = leading !== undefined && leading !== null;
  const labelText = (
    <Text
      style={[
        compact ? t.type.buttonCompact : t.type.button,
        ...(withLeading ? [styles.outlineButtonLabelShrink] : []),
        { color: disabled ? t.color.inkMuted : ink },
      ]}
    >
      {label}
    </Text>
  );
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      {...(testID ? { testID } : {})}
      style={({ pressed }) => [
        compact ? styles.outlineButtonCompact : styles.outlineButton,
        // Spread, not `cond && style`: a button with no glyph keeps exactly
        // the style array it always had.
        ...(withLeading ? [styles.outlineButtonLeading] : []),
        {
          minHeight: compact ? t.layout.touchTarget : t.layout.buttonHeight,
          borderRadius: t.radius.button,
          borderWidth: 1,
          borderColor: disabled ? t.color.lineSoft : line,
          backgroundColor: disabled
            ? t.color.paperInset
            : pressed && !disabled
              ? wash
              : 'transparent',
        },
        style,
      ]}
    >
      {/* No glyph: the single label child the button always had. */}
      {withLeading ? (
        <>
          {leading}
          {labelText}
        </>
      ) : (
        labelText
      )}
    </Pressable>
  );
});

/** Inline error that occupies layout space and is announced. Never a toast. */
export function InlineError({
  message,
  testID,
  marginTop = 8,
  paddingHorizontal = 10,
  seq,
  surface,
}: {
  message: string;
  testID?: string;
  marginTop?: number;
  paddingHorizontal?: number;
  /** Bump to re-announce an identical repeated failure. */
  seq?: number;
  /**
   * Background override, for an error nested in a panel with its own
   * surface. The default is paperLayer, white in light: the danger rule and
   * the danger ink carry the error, never a tinted fill.
   */
  surface?: string;
}) {
  const t = useTheme();
  // accessibilityLiveRegion is Android-only; on iOS an appearing error is
  // silent unless it is announced explicitly. Queueing keeps the announcement
  // from being dropped when it lands during a route change or a keystroke.
  //
  // iOS ONLY, for the same reason: on Android the live region below already
  // reads this node to TalkBack, and RN maps the announce to
  // TYPE_ANNOUNCEMENT, so an ungated call is the same error spoken twice.
  // The app's own precedent, twice: PinPad.tsx's announceCount and
  // CallScreen.tsx both announce only on iOS, with this note beside them.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibilityWithOptions(message, {
      queue: true,
    });
  }, [message, seq]);

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      {...(testID ? { testID } : {})}
      style={[
        styles.inlineNotice,
        {
          marginTop,
          paddingHorizontal,
          borderLeftColor: t.color.danger,
          backgroundColor: surface ?? t.color.paperLayer,
        },
      ]}
    >
      <Text style={[t.type.compactBody, { color: t.color.danger }]}>
        {message}
      </Text>
    </View>
  );
}

/**
 * A text button attached to a notice or an identity row. Recovery lives next
 * to the thing that failed, never in a floating overlay.
 */
export interface InlineAction {
  label: string;
  onPress: () => void;
  testID?: string;
  /** Lands on the action's Pressable, so a Share action can anchor the iPad
   * popover to the control that was pressed. Wired by IdentityRow; other hosts may ignore it. */
  anchorRef?: React.Ref<View>;
}

/** Inline positive/neutral notice sharing the error's ruled anatomy. */
export function InlineNotice({
  message,
  tone = 'quiet',
  marginTop = 8,
  paddingHorizontal = 10,
  action,
  testID,
  seq,
  messageRef,
  announce = true,
}: {
  message: string;
  tone?: 'quiet' | 'pine';
  marginTop?: number;
  paddingHorizontal?: number;
  /** Optional recovery affordance rendered under the text. */
  action?: InlineAction;
  testID?: string;
  /** Bump to re-announce an identical repeated notice. */
  seq?: number;
  /** Lands on the message Text, so a caller can move screen-reader focus to
   * the sentence when the notice replaces the control that held focus. */
  messageRef?: React.Ref<Text>;
  /** False for a STATIC notice — a rule, a dated window, a standing fact
   * the screen renders on every open (the proof pass, 2026-10-08): it
   * reads in the rotor like any text and is never queued as an alert, so
   * opening a screen with three standing notices no longer speaks three
   * announcements before the person has moved. Default true: a notice that
   * ANSWERS something the person did is announced, as before. */
  announce?: boolean;
}) {
  const t = useTheme();
  // accessibilityLiveRegion is Android-only, so without this every notice in
  // the app is silent on iOS — and iOS is therefore the only platform that
  // should fire it. On Android the live region speaks this node already and
  // the announce (TYPE_ANNOUNCEMENT) would speak over it. Same gate, same
  // reason, as InlineError above and PinPad's announceCount.
  useEffect(() => {
    if (!announce || Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibilityWithOptions(message, {
      queue: true,
    });
  }, [message, seq, announce]);

  return (
    <View
      {...(announce ? { accessibilityLiveRegion: 'polite' as const, accessibilityRole: 'alert' as const } : {})}
      {...(testID ? { testID } : {})}
      style={[
        styles.inlineNotice,
        {
          marginTop,
          paddingHorizontal,
          borderLeftColor: tone === 'pine' ? t.color.pine : t.color.lineStrong,
          backgroundColor: t.color.paperLayer,
        },
      ]}
    >
      <Text ref={messageRef} style={[t.type.compactBody, { color: t.color.inkBody }]}>
        {message}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          {...(action.testID ? { testID: action.testID } : {})}
          style={({ pressed }) => [
            styles.inlineActionBlock,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Label + value row used by both profile screens. */
export function IdentityRow({
  label,
  value,
  first,
  valueTestID,
  spellValue,
  leadingAction,
  action,
}: {
  label: string;
  value: string;
  first?: boolean;
  valueTestID?: string;
  /** Spell the value in four-character chunks for VoiceOver (ULIDs, codes). */
  spellValue?: boolean;
  /** Optional second text button rendered BEFORE `action` — Copy beside
   * Share, in the order StartChatScreen's own-id row already uses. */
  leadingAction?: InlineAction;
  /** Optional right-aligned text button, e.g. Copy or Share. */
  action?: InlineAction;
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  // Below the first iOS accessibility size, so the switch happens before the
  // 104pt label column and a 26-character ULID collide, not after.
  const stacked = fontScale > 1.35;

  return (
    <View
      style={[
        styles.identityRow,
        {
          minHeight: t.layout.rowHeight,
          paddingHorizontal: t.layout.gutter,
          backgroundColor: t.color.paperSheet,
          borderTopWidth: first ? 0 : t.hairline,
          borderTopColor: t.color.lineSoft,
        },
        stacked && styles.identityRowStacked,
      ]}
    >
      <Text
        style={[
          t.type.utilityLabel,
          stacked ? null : styles.identityLabel,
          { color: t.color.inkMuted },
        ]}
      >
        {label}
      </Text>
      <Text
        selectable
        style={[
          t.type.utilityData,
          stacked ? styles.identityValueStacked : styles.identityValue,
          { color: t.color.inkStrong },
        ]}
        // A monospace ID is a data grid: 2x stays transcribable where 3.1x is
        // unreadable at any layout.
        maxFontSizeMultiplier={2}
        {...(spellValue ? { accessibilityLabel: spellOut(value) } : {})}
        {...(valueTestID ? { testID: valueTestID } : {})}
      >
        {value}
      </Text>
      {[leadingAction, action].map(item =>
        item ? (
          <Pressable
            key={item.label}
            ref={item.anchorRef}
            onPress={item.onPress}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            {...(item.testID ? { testID: item.testID } : {})}
            style={({ pressed }) => [
              styles.inlineActionInline,
              { borderRadius: t.radius.button },
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
              {item.label}
            </Text>
          </Pressable>
        ) : null,
      )}
    </View>
  );
}

/**
 * VoiceOver pronounces a bare ULID as a word. Grouping into fours and then
 * separating every character makes it dictatable one chunk at a time.
 */
function spellOut(value: string) {
  return value
    .replace(/(.{4})/g, '$1 ')
    .trim()
    .split('')
    .join(' ');
}

const styles = StyleSheet.create({
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerSide: { minWidth: 44, flexDirection: 'row', alignItems: 'center' },
  homeHeader: {
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  homeHeaderTitles: { flex: 1 },
  headerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconTarget: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  backGlyph: { fontSize: 24, lineHeight: 26, marginTop: -2 },
  // Row layout so the busy spinner sits beside the label, not in its place.
  primaryButton: {
    width: '100%',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  ruledRow: { flexDirection: 'row', alignItems: 'center', minHeight: 15 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  // flexShrink lets a long localised date shorten the rules rather than push
  // them off the row.
  ruledText: { marginHorizontal: 10, flexShrink: 1 },
  inlineNotice: {
    borderLeftWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  inlineActionBlock: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    marginLeft: -8,
  },
  inlineActionInline: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginRight: -8,
  },
  identityRow: { flexDirection: 'row', alignItems: 'center' },
  identityRowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    paddingVertical: 12,
  },
  identityLabel: { width: 104 },
  identityValue: { flex: 1 },
  identityValueStacked: { alignSelf: 'stretch' },
  textAction: { justifyContent: 'center', paddingHorizontal: 8 },
  outlineButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  outlineButtonCompact: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  // Only for a button given a leading glyph: the glyph beside the label.
  outlineButtonLeading: { flexDirection: 'row', gap: 8 },
  outlineButtonLabelShrink: { flexShrink: 1 },
});
