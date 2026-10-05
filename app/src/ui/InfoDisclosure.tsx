import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

/**
 * Teaching copy behind an ⓘ — the house pattern for honest limits. The label says what the
 * disclosure is ABOUT, the glyph says there is more, and the sentences appear
 * in place rather than in a floating sheet — nothing on a security surface
 * should hover.
 *
 * Deliberately dumb: no links, no actions, no per-line styling. A disclosure
 * that can carry controls stops being teaching copy and starts being a menu.
 */
export function InfoDisclosure({
  label,
  lines,
  testID,
}: {
  /** What the ⓘ explains, e.g. "Who can change this room". */
  label: string;
  /** The teaching copy, one sentence (or short paragraph) per line. */
  lines: readonly string[];
  testID?: string;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(v => !v)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        {...(testID ? { testID } : {})}
        style={({ pressed }) => [
          styles.toggle,
          {
            minHeight: t.layout.touchTarget,
            borderRadius: t.radius.button,
            backgroundColor: pressed ? t.color.pineWash : 'transparent',
          },
        ]}
      >
        <Text
          allowFontScaling={false}
          style={[t.type.iconGlyph, { color: t.color.inkMuted }]}
        >
          ⓘ
        </Text>
        <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
          {label}
        </Text>
      </Pressable>
      {open
        ? lines.map(line => (
            <Text
              key={line}
              style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}
            >
              {line}
            </Text>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    marginHorizontal: -8,
  },
  line: { marginTop: 8 },
});
