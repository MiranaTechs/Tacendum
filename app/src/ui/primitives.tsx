import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';

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
                { color: t.color.pine },
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

/** Full-bleed primary action. Disabled is a recessed surface, never opacity.
 *
 * Busy renders the busyLabel BESIDE the spinner, never instead of it (the
 * identity-redesign designer note: "Busy label: 'Creating your identity…'
 * with spinner, spinner suppressed under Reduce Motion" — a spinner alone
 * says only that something spins). VoiceOver announces the busy label too.
 *
 * The ref lands on the Pressable itself — an accessibility element — so a
 * caller restoring VoiceOver focus after a modal dismissal has a real target,
 * not a wrapper the traversal skips. */
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
  }
>(function PrimaryButtonInner(
  { label, onPress, disabled, busy, busyLabel, reduceMotion, testID, style },
  ref,
) {
  const t = useTheme();
  const inactive = disabled || busy;
  const shown = busy ? (busyLabel ?? label) : label;
  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={shown}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
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
}: {
  label: string;
  marginTop?: number;
  marginBottom?: number;
  /** Row floor; defaults to the label's own line box (date dividers). */
  minHeight?: number;
  /** @deprecated Alias of minHeight — a ruled row must be able to grow. */
  height?: number;
  role?: 'utilityLabel' | 'timeStatus';
}) {
  const t = useTheme();
  const floor = minHeight ?? height;
  return (
    <View
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
   * Background override. Pass the host panel's own surface when nesting an
   * error inside dangerWash — wash on wash measures 4.33:1, under AA.
   */
  surface?: string;
}) {
  const t = useTheme();
  // accessibilityLiveRegion is Android-only; on iOS an appearing error is
  // silent unless it is announced explicitly. Queueing keeps the announcement
  // from being dropped when it lands during a route change or a keystroke.
  useEffect(() => {
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
          backgroundColor: surface ?? t.color.dangerWash,
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
}) {
  const t = useTheme();
  // accessibilityLiveRegion is Android-only, so without this every notice in
  // the app is silent on iOS.
  useEffect(() => {
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
          borderLeftColor: tone === 'pine' ? t.color.pine : t.color.lineStrong,
          backgroundColor: t.color.paperLayer,
        },
      ]}
    >
      <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
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
});
