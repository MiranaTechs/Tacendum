import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { CloseGlyph } from './AttachGlyph';

export interface ReactionDetailPerson {
  /** Stable local key only. It is never rendered or spoken. */
  key: string;
  label: string;
}

interface Props {
  msgId: string;
  emoji: string;
  people: ReactionDetailPerson[];
  includesMine: boolean;
  disabled: boolean;
  onClose: () => void;
  onChange: () => void;
  onRemove: () => void;
}

/** A compact surface attached to the reaction summary it explains. */
export function ReactionDetails({
  msgId,
  emoji,
  people,
  includesMine,
  disabled,
  onClose,
  onChange,
  onRemove,
}: Props) {
  const t = useTheme();
  const count = people.length;
  return (
    <View
      testID={`reaction-details-${msgId}`}
      style={[
        styles.panel,
        {
          backgroundColor: t.color.paperLayer,
          borderColor: t.color.lineSoft,
          borderRadius: t.radius.drawer,
        },
      ]}
    >
      <View style={styles.header}>
        <Text
          style={[
            t.type.compactStrong,
            styles.heading,
            { color: t.color.inkStrong },
          ]}
        >
          {emoji} {count} {count === 1 ? 'reaction' : 'reactions'}
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close reaction details"
          testID={`reaction-close-${msgId}`}
          hitSlop={8}
          style={({ pressed }) => [
            styles.close,
            { borderRadius: t.radius.circle },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <CloseGlyph size={16} color={t.color.inkMuted} />
        </Pressable>
      </View>
      <ScrollView nestedScrollEnabled style={styles.peopleScroll} contentContainerStyle={styles.people}>
        {people.map(person => (
          <Text
            key={person.key}
            style={[t.type.compactBody, { color: t.color.inkBody }]}
          >
            {person.label}
          </Text>
        ))}
      </ScrollView>
      <View style={[styles.actions, { borderTopColor: t.color.lineSoft }]}>
        <DetailAction
          label={includesMine ? 'Change' : 'Add reaction'}
          testID={
            includesMine ? `reaction-change-${msgId}` : `reaction-add-${msgId}`
          }
          disabled={disabled}
          onPress={onChange}
        />
        {includesMine ? (
          <DetailAction
            label="Remove"
            testID={`reaction-remove-${msgId}`}
            disabled={disabled}
            onPress={onRemove}
          />
        ) : null}
      </View>
    </View>
  );
}

function DetailAction({
  label,
  testID,
  disabled,
  onPress,
}: {
  label: string;
  testID: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.action,
        { borderRadius: t.radius.button },
        pressed && { backgroundColor: t.color.pineWash },
      ]}
    >
      <Text
        style={[
          t.type.compactStrong,
          { color: disabled ? t.color.inkMuted : t.color.pine },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    width: 228,
    maxWidth: '92%',
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  heading: { flex: 1, flexShrink: 1 },
  close: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  peopleScroll: { maxHeight: 220 },
  people: { gap: 5, paddingBottom: 10 },
  actions: {
    minHeight: 45,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  action: {
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
