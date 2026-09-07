import React, { useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { AiWorkUsage } from '@tacendum/shared';
import { isCurrentLocalTurnLimitExhausted, usageDisplayRows } from '../aiUsage';
import { useTheme, type Theme } from '../theme';

export interface AiUsagePanelProps {
  usage: AiWorkUsage[] | null;
  receivedAt: number | null;
  now: number;
  compact?: boolean;
}

/** A read-only usage ledger. It draws no progress bar because rows may carry
 * only `used`, only `remaining`, or no limit, and converting those different
 * facts into one percentage would invent a shared denominator. */
export function AiUsagePanel({
  usage,
  receivedAt,
  now,
  compact = false,
}: AiUsagePanelProps): React.JSX.Element {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.35;
  const rows = usageDisplayRows(usage, receivedAt, now);
  const exhausted = isCurrentLocalTurnLimitExhausted(usage, receivedAt, now);

  return (
    <View
      testID="ai-usage-panel"
      accessibilityLabel={`${rows.length} reported usage item${
        rows.length === 1 ? '' : 's'
      }`}
      style={[styles.panel, compact && styles.panelCompact]}
    >
      <View
        testID="ai-usage-heading"
        style={[styles.headingRow, stacked && styles.stacked]}
      >
        <Text
          accessibilityRole="header"
          style={[
            t.type.sectionTitle,
            styles.headingTitle,
            stacked && styles.stackedHeadingTitle,
            { color: t.color.inkStrong },
          ]}
        >
          Usage and limits
        </Text>
        {exhausted ? (
          <View
            accessible
            accessibilityLabel="Current local turn limit reached"
            style={[
              styles.limitMark,
              stacked && styles.stackedMark,
              { borderColor: t.color.danger },
            ]}
          >
            <Text style={[t.type.utilityLabel, { color: t.color.danger }]}>
              Limit reached
            </Text>
          </View>
        ) : null}
      </View>

      {rows.length === 0 ? (
        <View
          accessible
          accessibilityLabel="Usage unavailable. This agent has not reported usage or limits."
          testID="ai-usage-empty"
          style={styles.empty}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkStrong }]}>
            Usage unavailable
          </Text>
          <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
            This agent has not reported usage or limits.
          </Text>
        </View>
      ) : (
        <View style={[styles.ledger, { borderColor: t.color.lineSoft }]}>
          {rows.map((row, index) => (
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.title}. ${row.value}. ${
                row.sourceLabel
              }. ${row.freshnessLabel}.${
                row.exhausted ? ' Limit reached.' : ''
              }`}
              testID={`ai-usage-row-${index}`}
              style={[
                styles.row,
                index > 0 && {
                  borderTopColor: t.color.lineSoft,
                  borderTopWidth: t.hairline,
                },
              ]}
            >
              <View
                testID={`ai-usage-main-${index}`}
                style={[styles.rowTop, stacked && styles.stacked]}
              >
                <Text
                  style={[
                    t.type.compactStrong,
                    styles.rowTitle,
                    { color: t.color.inkStrong },
                  ]}
                >
                  {row.title}
                </Text>
                <Text
                  style={[
                    t.type.utilityData,
                    styles.value,
                    stacked && styles.stackedValue,
                    {
                      color: row.exhausted ? t.color.danger : t.color.inkStrong,
                    },
                  ]}
                >
                  {row.value}
                </Text>
              </View>
              <View
                testID={`ai-usage-meta-${index}`}
                style={[styles.rowMeta, stacked && styles.stacked]}
              >
                <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                  {row.sourceLabel}
                </Text>
                <Text
                  style={[
                    t.type.timeStatus,
                    styles.freshness,
                    stacked && styles.stackedValue,
                    {
                      color:
                        row.freshness === 'current'
                          ? t.color.pine
                          : t.color.warningInk,
                    },
                  ]}
                >
                  {row.freshnessLabel}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {!compact && rows.length > 0 ? (
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          Only a current local turn limit can pause a new task. Older reports
          stay visible as stale.
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    panel: {
      alignSelf: 'stretch',
      padding: t.space.s5,
      gap: t.space.s4,
      borderRadius: t.radius.drawer,
      borderWidth: t.hairline,
      borderColor: t.color.lineSoft,
      backgroundColor: t.color.paperLayer,
    },
    panelCompact: {
      padding: t.space.s4,
      gap: t.space.s3,
    },
    headingRow: {
      minHeight: t.layout.touchTarget,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.s4,
    },
    headingTitle: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 140,
    },
    stackedHeadingTitle: {
      alignSelf: 'stretch',
      flexGrow: 0,
      minWidth: 0,
    },
    limitMark: {
      minHeight: 28,
      justifyContent: 'center',
      paddingHorizontal: t.space.s3,
      borderWidth: t.hairline,
      borderRadius: t.radius.small,
      backgroundColor: t.color.dangerWash,
    },
    stackedMark: {
      alignSelf: 'flex-start',
    },
    empty: {
      minHeight: t.layout.touchTarget,
      justifyContent: 'center',
      gap: t.space.s1,
    },
    ledger: {
      borderTopWidth: t.hairline,
      borderBottomWidth: t.hairline,
    },
    row: {
      paddingVertical: t.space.s4,
      gap: t.space.s2,
    },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.s4,
    },
    rowTitle: { flexShrink: 1 },
    value: {
      flexGrow: 1,
      flexShrink: 1,
      textAlign: 'right',
      fontVariant: ['tabular-nums'],
    },
    rowMeta: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: t.space.s4,
    },
    freshness: {
      flexGrow: 1,
      flexShrink: 1,
      textAlign: 'right',
    },
    stacked: {
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: t.space.s1,
    },
    stackedValue: {
      alignSelf: 'stretch',
      flexGrow: 0,
      textAlign: 'left',
    },
  });
}
