import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CALL_CAP_COPY } from '../screens/GroupCallScreen';
import { tileName } from './CallTile';
import { useTheme, type Theme } from '../theme';
import { InfoDisclosure } from './InfoDisclosure';
import { PrimaryButton, TextAction } from './primitives';

/**
 * Who to call, when a room is bigger than a call.
 *
 * A twelve-person room's call button may not place a twelve-way call, and it
 * may not silently take the first four names either — so it opens this, with
 * the room's members pre-listed and a hard ceiling of `cap` seats INCLUDING
 * this device. The sentence is the reason, shown at the moment it starts
 * to bite rather than after a refusal.
 *
 * An inline panel on the paper ground, the SafetyPanel idiom, not a floating
 * sheet: nothing on a security surface should hover. The teaching copy sits
 * behind ⓘ, which is where this app has always put honest limits — and it
 * lives here rather than on the in-call screen because the ⓘ pattern is drawn
 * in pine on porcelain, and the in-call surface is mediaBlack.
 */

export const CALL_PICKER_COPY = {
  title: 'Who to call',
  /** Says the ceiling INCLUDES you, the GroupCreateScreen seat-counter
   * lesson: "4 of 5" otherwise reads as room for four more. */
  seats: (taken: number, cap: number) => `${taken} of ${cap}, including you`,
  cap: CALL_CAP_COPY,
  aboutLabel: 'Why a call is smaller than a room',
  aboutLines: [
    CALL_CAP_COPY,
    // Rule 22: what the UI says is what the design does. A mesh is N(N−1)/2
    // connections carried by the devices themselves, and saying so is the
    // honest version of "for technical reasons".
    'A call connects every device to every other device directly, so each ' +
      'one carries every other person. That is what keeps a call end-to-end ' +
      'encrypted with no server in the middle, and it is also why the number ' +
      'is small.',
  ],
  start: 'Start call',
  cancel: 'Cancel',
  none: 'Pick at least one person.',
} as const;

export interface CallPickerCandidate {
  peerId: string;
  /**
   * The name THIS phone holds, or null when it holds none.
   *
   * NULL IS ALLOWED BECAUSE THE RULE LIVES HERE. This used to promise that
   * the caller had already applied `tileName`'s rule, and both call sites got
   * it wrong in different ways: one handed over `personName`'s id FRAGMENT,
   * the other a label that can echo an account id. A rule enforced by comment
   * is not enforced — so the component that renders owns it, every surface
   * below goes through `tileName`, and a call site can no longer get it wrong
   * by passing a name it happens to have.
   */
  name: string | null;
}

export function CallPicker({
  candidates,
  cap,
  seatsTaken = 1,
  maxHeight,
  startLabel = CALL_PICKER_COPY.start,
  onCancel,
  onStart,
}: {
  candidates: readonly CallPickerCandidate[];
  /** Participants INCLUDING this device, from
   * `smallGroupCallParticipantCap` — never a number minted here. */
  cap: number;
  /**
   * Seats already occupied before anyone is picked. One — this device — when
   * a call is being assembled; the LIVE ROSTER's size when someone is being
   * added to a call already in progress. Getting this wrong is the whole bug
   * class the counter exists against: an Add picker that counted only itself
   * would offer four more seats to a call that already holds four.
   */
  seatsTaken?: number;
  maxHeight: number;
  startLabel?: string;
  onCancel(): void;
  onStart(others: string[]): void;
}): React.JSX.Element {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [picked, setPicked] = useState<string[]>([]);
  const taken = picked.length + seatsTaken;
  const full = taken >= cap;

  return (
    <View style={styles.panel} testID="call-picker">
      <View style={styles.top}>
        <Text accessibilityRole="header" style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
          {CALL_PICKER_COPY.title}
        </Text>
        <TextAction label={CALL_PICKER_COPY.cancel} onPress={onCancel} testID="call-picker-cancel" />
      </View>

      <Text style={[t.type.counter, { color: t.color.inkMuted }]} testID="call-picker-seats">
        {CALL_PICKER_COPY.seats(taken, cap)}
      </Text>

      <ScrollView style={{ maxHeight }} keyboardShouldPersistTaps="handled">
        {candidates.map(c => {
          const on = picked.includes(c.peerId);
          // ONE NAME, ONE RULE, applied where it renders: a picker row is a
          // call surface, and the design forbids a call surface from ever showing an
          // id — including to a screen reader, which is the surface a sighted
          // reviewer never checks.
          const shown = tileName(c.peerId, c.name);
          // Full means full: an unpicked row stops responding rather than
          // accepting a tap and dropping it. Disabled is the honest state.
          const disabled = !on && full;
          return (
            <Pressable
              key={c.peerId}
              testID={`call-picker-row-${c.peerId}`}
              onPress={() =>
                setPicked(prev =>
                  prev.includes(c.peerId)
                    ? prev.filter(id => id !== c.peerId)
                    : [...prev, c.peerId],
                )
              }
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled }}
              accessibilityLabel={shown}
              {...(disabled ? { accessibilityHint: CALL_PICKER_COPY.cap } : {})}
              style={({ pressed }) => [
                styles.row,
                { minHeight: t.layout.rowHeight, opacity: disabled ? 0.45 : 1 },
                pressed && { backgroundColor: t.color.pineWash },
              ]}
            >
              <View
                style={[
                  styles.box,
                  {
                    borderColor: on ? t.color.pine : t.color.lineStrong,
                    backgroundColor: on ? t.color.pine : 'transparent',
                  },
                ]}
              >
                <Text
                  allowFontScaling={false}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={{ color: t.color.onPine, fontSize: 13 }}
                >
                  {on ? '✓' : ''}
                </Text>
              </View>
              <Text numberOfLines={1} style={[t.type.body, { color: t.color.inkBody, flexShrink: 1 }]}>
                {shown}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {full && (
        <Text
          testID="call-picker-cap"
          accessibilityLiveRegion="polite"
          style={[t.type.compactBody, { color: t.color.inkMuted, marginTop: t.space.s4 }]}
        >
          {CALL_PICKER_COPY.cap}
        </Text>
      )}

      <InfoDisclosure
        label={CALL_PICKER_COPY.aboutLabel}
        lines={CALL_PICKER_COPY.aboutLines}
        testID="call-picker-about"
      />

      <PrimaryButton
        label={startLabel}
        disabled={picked.length === 0}
        onPress={() => onStart(picked)}
        testID="call-picker-start"
        style={{ marginTop: t.space.s5 }}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    panel: {
      paddingHorizontal: t.layout.gutter,
      paddingBottom: t.space.s6,
      backgroundColor: t.color.paperLayer,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.color.lineSoft,
    },
    top: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: t.space.s5,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.s5 },
    box: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
