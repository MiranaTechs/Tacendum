import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '../theme';

/**
 * The home-level tab rail: Rooms and Calls.
 *
 * Deliberately a plain two-item rail rather than a navigation library — the
 * app's router is a hand-rolled switch in App.tsx, and these are the only
 * two peers. Rendered by the routes themselves (chats, calls), inside the
 * SafeAreaView, so it needs no inset arithmetic of its own.
 */

export type HomeTab = 'chats' | 'calls';

interface Props {
  active: HomeTab;
  onSelect(tab: HomeTab): void;
}

const TABS: { key: HomeTab; label: string; glyph: string }[] = [
  { key: 'chats', label: 'Rooms', glyph: '▤' },
  { key: 'calls', label: 'Calls', glyph: '✆' },
];

export function TabBar({ active, onSelect }: Props): React.JSX.Element {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.rail} accessibilityRole="tablist">
      {TABS.map(tab => {
        const isActive = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            style={styles.tab}
            onPress={() => onSelect(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
          >
            <Text style={[styles.glyph, isActive && styles.activeInk]}>{tab.glyph}</Text>
            <Text style={[styles.label, isActive && styles.activeInk]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    rail: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.color.lineSoft,
      backgroundColor: t.color.paperGround,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      paddingTop: 8,
      paddingBottom: 6,
      gap: 2,
    },
    glyph: { color: t.color.inkMuted, fontSize: 18 },
    label: { color: t.color.inkMuted, fontSize: 11, fontWeight: '600' },
    activeInk: { color: t.color.pine },
  });
}
