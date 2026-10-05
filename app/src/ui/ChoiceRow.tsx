import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { InfoDisclosure } from './InfoDisclosure';
import { InlineError } from './primitives';

/**
 * A labelled row of exclusive chips — the Settings idiom: ten copies of the
 * same ~45-line Pressable block lived in SettingsScreen, and every review
 * of one had to be repeated on nine.
 *
 * What travels with the row, so the sheet reads as one unit per setting:
 *  - `note`: a consent-grade one-liner that stays VISIBLE under the chips
 *    (the cost of the switch, said before it is thrown);
 *  - `info`: the teaching paragraph, behind the house ⓘ —
 *    directly under its own row, never a wall of prose after the sheet;
 *  - `error`: the row's own inline error (a failed write).
 *
 * TestIDs are derived, and pinned by the Settings suites:
 * `${testIDPrefix}-${key}` per chip (booleans → `on`/`off`, everything else
 * → the value itself), `${testIDPrefix}-note`, `${testIDPrefix}-info`
 * (overridable) and `${testIDPrefix}-error`.
 *
 * Every visual is a theme token — a selected chip is white with a 1.5pt
 * forest outline, the others a gray hairline — and the 44pt effective
 * target comes from hitSlop over the choices' padding (RN hitSlop never
 * extends past the parent view, which is why the choices row pads
 * vertically instead of the row). */

export interface ChoiceOption<T> {
  label: string;
  value: T;
}

export interface ChoiceRowInfo {
  label: string;
  lines: readonly string[];
  testID?: string;
}

interface Props<T extends string | number | boolean> {
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Pass a boolean to expose `disabled` in every chip's accessibility
   * state (the push row does, while its network step runs); leave it out
   * and the state carries `selected` alone, as the other rows always did. */
  disabled?: boolean;
  testIDPrefix: string;
  note?: string;
  info?: ChoiceRowInfo;
  error?: string | null;
}

function chipKey(value: string | number | boolean): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/** A selected chip's forest outline. The others keep a hairline: at a
 * hairline the forest edge all but vanished, and the label's forest and the
 * muted gray are 1.04:1 apart, so the selection rested on hue alone. */
export const CHIP_SELECTED_EDGE = 1.5;
const CHIP_PAD_X = 14;
const CHIP_PAD_Y = 8;

export function ChoiceRow<T extends string | number | boolean>({
  label,
  options,
  value,
  onChange,
  disabled,
  testIDPrefix,
  note,
  info,
  error,
}: Props<T>) {
  const t = useTheme();
  return (
    <View style={[styles.row, { minHeight: t.layout.rowHeight }]}>
      <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>{label}</Text>
      <View style={styles.choices}>
        {options.map(option => {
          const selected = value === option.value;
          const key = chipKey(option.value);
          const edge = selected ? CHIP_SELECTED_EDGE : t.hairline;
          // The padding gives back what the heavier edge takes, so selecting
          // a chip never moves it or its neighbours.
          const giveBack = edge - t.hairline;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityState={
                disabled === undefined ? { selected } : { selected, disabled }
              }
              testID={`${testIDPrefix}-${key}`}
              // 44pt effective without enlarging the visual.
              hitSlop={{ top: 5, bottom: 5 }}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={[
                styles.chip,
                {
                  borderRadius: t.radius.button,
                  backgroundColor: 'transparent',
                  borderWidth: edge,
                  borderColor: selected ? t.color.pineLine : t.color.lineSoft,
                  paddingHorizontal: CHIP_PAD_X - giveBack,
                  paddingVertical: CHIP_PAD_Y - giveBack,
                },
              ]}
            >
              <Text
                style={[
                  t.type.buttonCompact,
                  { color: selected ? t.color.pine : t.color.inkMuted },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {note ? (
        <Text
          testID={`${testIDPrefix}-note`}
          style={[t.type.compactBody, styles.note, { color: t.color.inkMuted }]}
        >
          {note}
        </Text>
      ) : null}
      {info ? (
        <InfoDisclosure
          label={info.label}
          lines={info.lines}
          testID={info.testID ?? `${testIDPrefix}-info`}
        />
      ) : null}
      {error ? <InlineError message={error} testID={`${testIDPrefix}-error`} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 5,
    gap: 8,
  },
  // Vertical padding here (not on the row) so the chips' hitSlop has parent
  // bounds to land in — RN hitSlop never extends past the parent view.
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 5 },
  // Padding is set per chip (CHIP_PAD_X / CHIP_PAD_Y less the edge).
  chip: {
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: { marginTop: 2 },
});
