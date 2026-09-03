import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme, type Theme } from '../theme';
import { HANDSET_PATH } from './CallGlyph';

/**
 * The home-level tab rail: Rooms and Calls.
 *
 * Deliberately a plain two-item rail rather than a navigation library — the
 * app's router is a hand-rolled switch in App.tsx, and these are the only
 * two peers. Rendered by the routes themselves (chats, calls), inside the
 * SafeAreaView, so it needs no inset arithmetic of its own.
 *
 * The glyphs are vector art from the same kit as the call buttons rather
 * than the `▤`/`✆` characters (the `✆` was also the audio-redial mark, so
 * "Calls tab" read as "audio call"); the label takes a type role and a
 * Dynamic Type cap, because a rail is a fixed frame; and the chosen tab
 * carries a 2pt pine rule, so selection is not colour-only — the chat
 * list's own rule for its connection mark. */

export type HomeTab = 'chats' | 'calls';

interface Props {
  active: HomeTab;
  onSelect(tab: HomeTab): void;
}

interface GlyphProps {
  color: string;
}

/** Rendered size of the tab art; authored in the kit's 24-unit box. */
const GLYPH_SIZE = 22;
/** CallGlyph's own weight, in viewBox units, so the two tabs match the
 * thread's call buttons stroke for stroke. */
const STROKE = 1.9;
/** The selection rule: 2pt of pine under the chosen tab. */
const RULE_HEIGHT = 2;
const RULE_WIDTH = 28;
/** The label may grow with Dynamic Type, but past 1.5× an 13pt word would
 * push the rail taller than the content it sits under. */
const LABEL_MAX_SCALE = 1.5;

/**
 * A room: RoomMark's own geometry — four walls and an open threshold in the
 * top wall — so the tab says "rooms" with the same shape every room row
 * carries. Hidden from VoiceOver: the tab's label already names it.
 */
function RoomsGlyph({ color }: GlyphProps): React.JSX.Element {
  return (
    <Svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d="M9.5 4.5h-5v15h15v-15h-5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * The call log: the SAME handset the redial buttons draw, with a small
 * outgoing arrow beside it — history, not "place an audio call now". The
 * arrow is what keeps the tab distinct from the redial idiom.
 */
function CallsGlyph({ color }: GlyphProps): React.JSX.Element {
  return (
    <Svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d={HANDSET_PATH}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M15 9l5.5-5.5M16.5 3.5h4v4"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

const TABS: {
  key: HomeTab;
  label: string;
  Glyph: (props: GlyphProps) => React.JSX.Element;
}[] = [
  { key: 'chats', label: 'Rooms', Glyph: RoomsGlyph },
  { key: 'calls', label: 'Calls', Glyph: CallsGlyph },
];

export function TabBar({ active, onSelect }: Props): React.JSX.Element {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.rail} accessibilityRole="tablist">
      {TABS.map(({ key, label, Glyph }) => {
        const isActive = key === active;
        const ink = isActive ? t.color.pine : t.color.inkMuted;
        return (
          <Pressable
            key={key}
            style={styles.tab}
            onPress={() => onSelect(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={label}
          >
            <Glyph color={ink} />
            <Text
              style={[t.type.buttonCompact, { color: ink }]}
              maxFontSizeMultiplier={LABEL_MAX_SCALE}
              numberOfLines={1}
            >
              {label}
            </Text>
            {/* Always laid out, so the rail's height does not change with
                the selection; only the chosen tab's rule is painted. */}
            <View
              style={[
                styles.rule,
                { backgroundColor: isActive ? t.color.pine : 'transparent' },
              ]}
              testID={`tab-rule-${key}`}
            />
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
      paddingTop: t.space.s4,
      paddingBottom: t.space.s2,
      gap: t.space.s1,
    },
    rule: {
      width: RULE_WIDTH,
      height: RULE_HEIGHT,
      borderRadius: RULE_HEIGHT / 2,
      marginTop: t.space.s1,
    },
  });
}
