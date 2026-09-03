import React from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../theme';

/**
 * Shared passcode entry: a dot row and a 3×4 pad. Codes are
 * 4-10 digits, so the pad carries an explicit submit key instead of
 * auto-submitting at a known length — the lock screen must not disclose how
 * long the code is.
 */

const MAX_CODE_LENGTH = 10;
const KEY_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['del', '0', 'submit'],
] as const;

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** What the ⏎ key does, for VoiceOver — "Unlock" on the lock screen; a
   * pad that guards another verb (the account delete) names that verb
   * instead. */
  submitLabel?: string;
}

export function PinPad({ value, onChange, onSubmit, disabled, submitLabel }: Props) {
  const t = useTheme();
  const dotCount = Math.max(4, value.length);
  const canSubmit = !disabled && value.length >= 4;

  return (
    <View accessibilityLabel="Passcode keypad">
      <View
        style={styles.dots}
        accessibilityLabel={`${value.length} digits entered`}
        accessibilityLiveRegion="polite"
      >
        {Array.from({ length: dotCount }, (_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                borderRadius: t.radius.circle,
                borderWidth: 1,
                borderColor: t.color.lineStrong,
                backgroundColor:
                  i < value.length ? t.color.inkStrong : 'transparent',
              },
            ]}
          />
        ))}
      </View>
      {KEY_ROWS.map(row => (
        <View key={row.join()} style={styles.row}>
          {row.map(key => {
            const isDelete = key === 'del';
            const isSubmit = key === 'submit';
            const keyDisabled =
              disabled ||
              (isDelete && value.length === 0) ||
              (isSubmit && !canSubmit);
            return (
              <Pressable
                key={key}
                testID={isDelete ? 'pin-del' : isSubmit ? 'pin-submit' : `pin-key-${key}`}
                accessibilityRole="button"
                accessibilityLabel={
                  isDelete ? 'Delete digit' : isSubmit ? (submitLabel ?? 'Unlock') : key
                }
                accessibilityState={{ disabled: keyDisabled }}
                disabled={keyDisabled}
                onPress={() => {
                  if (isDelete) {
                    onChange(value.slice(0, -1));
                    announceCount(value.length - 1);
                  } else if (isSubmit) {
                    onSubmit();
                  } else if (value.length < MAX_CODE_LENGTH) {
                    onChange(value + key);
                    announceCount(value.length + 1);
                  }
                }}
                style={({ pressed }) => [
                  styles.key,
                  {
                    borderRadius: t.radius.button,
                    backgroundColor: pressed
                      ? t.color.paperInset
                      : isDelete || isSubmit
                        ? 'transparent'
                        : t.color.paperSheet,
                    borderWidth: isDelete || isSubmit ? 0 : t.hairline,
                    borderColor: t.color.lineSoft,
                  },
                ]}
              >
                <Text
                  style={[
                    t.type.verificationCode,
                    {
                      color: keyDisabled
                        ? t.color.inkMuted
                        : isSubmit
                          ? t.color.pine
                          : t.color.inkStrong,
                    },
                  ]}
                >
                  {isDelete ? '⌫' : isSubmit ? '⏎' : key}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** iOS has no live regions — VoiceOver reads the tapped key, and this adds
 * the running count the dot row shows sighted users. */
function announceCount(count: number): void {
  if (Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibility(
      `${Math.max(0, count)} digits entered`,
    );
  }
}

const styles = StyleSheet.create({
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 28,
    minHeight: 14,
  },
  dot: { width: 13, height: 13 },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 12,
  },
  key: {
    width: 84,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
