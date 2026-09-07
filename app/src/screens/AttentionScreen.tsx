import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ATTENTION_EVENT_COPY,
  ATTENTION_KIND_COPY,
  attentionDeadlineLabel,
  buildAttentionSections,
  buildWorkAttentionSections,
  type AttentionSection,
} from '../attention';
import * as db from '../db';
import { timeLabel } from '../time';
import { useTheme, type Theme } from '../theme';
import { InlineError, ScreenHeader, TextAction } from '../ui/primitives';
import { useCoalescedSubscribe } from '../ui/useCoalescedSubscribe';

interface Props {
  onBack: () => void;
  onOpenApproval: (peerId: string, q: string) => void;
  onOpenConversation: (peerId: string) => void;
}

const COPY = {
  title: 'Needs attention',
  intro: (count: number) =>
    `${count} ${count === 1 ? 'request is' : 'requests are'} waiting for your decision.`,
  loading: 'Loading requests that need attention',
  error: 'Requests couldn’t be loaded. Try again.',
  retry: 'Retry',
  caughtUpTitle: 'You’re caught up',
  caughtUpBody: 'No approval requests are waiting on this device.',
  recentTitle: 'Recent agent reports',
  recentBody:
    'These are timestamped reports from agents. Open the conversation for the full message.',
  setupTitle: 'Set up an AI connection',
  setupBody: 'On the computer that runs your agent, choose a supported setup:',
  setupClaude: 'tacendum setup claude-code --name "Claude Code"',
  setupCodex: 'tacendum setup codex --name "Codex"',
  setupFoot:
    'Notifications and interactive approvals are separate capabilities. Run tacendum doctor <account> on that computer to check what is configured.',
} as const;

type Phase = 'loading' | 'ready' | 'error';

/**
 * A payload-free index over durable approval rows. It never decides, marks
 * read, or infers workflow state; tapping a row opens ApprovalCard, which is
 * still the only authorisation surface.
 */
export function AttentionScreen({
  onBack,
  onOpenApproval,
  onOpenConversation,
}: Props): React.JSX.Element {
  const t = useTheme();
  const styles = stylesFor(t);
  const [phase, setPhase] = useState<Phase>('loading');
  const [rows, setRows] = useState<db.PendingApprovalSummaryRow[]>([]);
  const [events, setEvents] = useState<db.AiWorkEventRow[]>([]);
  const [agentStates, setAgentStates] = useState<db.AiAgentStateRow[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const refreshSeq = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    // Effects can be torn down and replayed by StrictMode/Fast Refresh while
    // the component instance remains. Re-arm before installing the cleanup.
    live.current = true;
    return () => {
      live.current = false;
      refreshSeq.current += 1;
    };
  }, []);

  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    const current = () => live.current && seq === refreshSeq.current;
    setPhase('loading');
    // Clear first: a failed/closed-workspace read must not leave source names
    // from an older answer painted under an error.
    setRows([]);
    setEvents([]);
    setAgentStates([]);
    const readAt = Date.now();
    void (async () => {
      // Sequential because each read owns bounded maintenance on the same
      // SQLite connection; parallel writes would turn loading into a race.
      const pending = await db.listPendingApprovalSummaries(readAt);
      const recent = await db.listRecentAiWorkEvents(readAt);
      const states = await db.listAiAgentStates(readAt);
      return { pending, recent, states };
    })().then(
      ({ pending, recent, states }) => {
        if (!current()) return;
        setRows(pending);
        setEvents(recent);
        setAgentStates(states);
        setNow(Date.now());
        setPhase('ready');
      },
      () => {
        if (!current()) return;
        setRows([]);
        setEvents([]);
        setAgentStates([]);
        setPhase('error');
      },
    );
  }, []);

  useCoalescedSubscribe(refresh);

  useEffect(() => {
    if (rows.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rows.length]);

  // A countdown reaching zero removes the row immediately, before the next
  // database answer. The deadline timer then runs the durable maintenance
  // pass so it also leaves future refreshes and the chat-list count.
  const liveRows = useMemo(
    () => rows.filter(row => row.deadline > now),
    [now, rows],
  );
  useEffect(() => {
    if (rows.length === 0) return;
    const next = Math.min(...rows.map(row => row.deadline));
    const delay = Math.max(0, next - Date.now() + 10);
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [refresh, rows]);

  const sections = useMemo(() => buildAttentionSections(liveRows), [liveRows]);
  const workSections = useMemo(
    () => buildWorkAttentionSections(events, liveRows),
    [events, liveRows],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: AttentionSection }) => (
      <View
        accessible
        accessibilityRole="header"
        style={[
          styles.sectionHeader,
          {
            backgroundColor: t.color.paperGround,
            borderBottomColor: t.color.lineSoft,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[t.type.rowTitle, styles.sectionName, { color: t.color.inkStrong }]}
        >
          {section.title}
        </Text>
        <Text
          numberOfLines={1}
          testID={`attention-source-${section.peerId}`}
          style={[t.type.utilityLabel, { color: t.color.inkMuted }]}
        >
          {section.sourceLabel}
        </Text>
      </View>
    ),
    [styles, t],
  );

  const renderItem = useCallback(
    ({
      item,
      section,
    }: {
      item: db.PendingApprovalSummaryRow;
      section: AttentionSection;
    }) => {
      const kind = ATTENTION_KIND_COPY[item.kind];
      const due = attentionDeadlineLabel(item.deadline, now);
      return (
        <Pressable
          onPress={() => onOpenApproval(item.peerId, item.q)}
          accessibilityRole="button"
          accessibilityLabel={`${kind}, from ${section.spokenTitle}, ${due}`}
          accessibilityHint="Opens this exact approval request"
          testID={`attention-${item.peerId}-${item.q}`}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed
                ? t.color.pineWash
                : t.color.paperSheet,
              borderBottomColor: t.color.lineSoft,
              borderLeftColor: t.color.warningMark,
            },
          ]}
        >
          <View style={styles.rowCopy}>
            <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
              {kind}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              Waiting for a decision
            </Text>
          </View>
          <Text
            style={[
              t.type.timeStatus,
              styles.due,
              { color: t.color.warningInk },
            ]}
          >
            {due}
          </Text>
          <Text
            allowFontScaling={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
            style={[t.type.iconGlyph, { color: t.color.pine }]}
          >
            ›
          </Text>
        </Pressable>
      );
    },
    [now, onOpenApproval, styles, t],
  );

  const workFeed = workSections.length > 0 ? (
    <View style={styles.workFeed} testID="attention-work-feed">
      <View style={styles.workIntro}>
        <Text
          accessibilityRole="header"
          style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
        >
          {COPY.recentTitle}
        </Text>
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {COPY.recentBody}
        </Text>
      </View>
      {workSections.map(section => (
        <View key={section.key}>
          <View
            style={[
              styles.workSectionHeader,
              { borderBottomColor: t.color.lineSoft },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[t.type.rowTitle, { color: t.color.inkStrong }]}
            >
              {section.title}
            </Text>
            <Text
              numberOfLines={1}
              style={[t.type.utilityLabel, { color: t.color.inkMuted }]}
              testID={`attention-work-source-${section.key}`}
            >
              {section.sourceLabel}
            </Text>
          </View>
          {section.data.map(event => {
            const summary =
              event.context && event.context.availability !== 'unavailable'
                ? event.context.resultSummary
                : undefined;
            const at = timeLabel(event.displayAt);
            return (
              <Pressable
                key={event.eventId}
                onPress={() => onOpenConversation(event.peerId)}
                accessibilityRole="button"
                accessibilityLabel={`${ATTENTION_EVENT_COPY[event.event]}, from ${section.spokenTitle}, reported ${at}`}
                accessibilityHint="Opens the source conversation"
                testID={`attention-work-${event.peerId}-${event.eventId}`}
                style={({ pressed }) => [
                  styles.workRow,
                  {
                    backgroundColor: pressed
                      ? t.color.pineWash
                      : t.color.paperSheet,
                    borderBottomColor: t.color.lineSoft,
                  },
                ]}
              >
                <View style={styles.rowCopy}>
                  <View style={styles.workTitleLine}>
                    <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                      {ATTENTION_EVENT_COPY[event.event]}
                    </Text>
                    {event.runTag ? (
                      <Text style={[t.type.utilityData, { color: t.color.inkMuted }]}>
                        {event.runTag}
                      </Text>
                    ) : null}
                  </View>
                  {summary ? (
                    <Text
                      numberOfLines={2}
                      style={[t.type.compactBody, { color: t.color.inkBody }]}
                    >
                      {`Agent report · ${summary}`}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.workTime}>
                  <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                    {at}
                  </Text>
                  {!event.timeTrusted ? (
                    <Text style={[t.type.utilityLabel, { color: t.color.warningInk }]}>
                      SOURCE TIME UNTRUSTED
                    </Text>
                  ) : null}
                </View>
                <Text
                  allowFontScaling={false}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                  style={[t.type.iconGlyph, { color: t.color.pine }]}
                >
                  ›
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  ) : null;

  const knownCapabilities = agentStates
    .map(state => state.capabilities)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const notificationsOnly =
    knownCapabilities.length > 0 &&
    knownCapabilities.every(
      capabilities =>
        capabilities.notifications &&
        !capabilities.approvals &&
        !capabilities.tasks,
    );

  const empty = (
    <View style={styles.empty} testID="attention-empty">
        <Text
          accessibilityRole="header"
          style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
        >
          {COPY.caughtUpTitle}
        </Text>
        <Text
          style={[t.type.body, styles.emptyBody, { color: t.color.inkMuted }]}
        >
          {COPY.caughtUpBody}
        </Text>
        <View style={[styles.emptyRule, { backgroundColor: t.color.lineSoft }]} />
        {agentStates.length === 0 ? (
          <>
            <Text
              accessibilityRole="header"
              style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
            >
              {COPY.setupTitle}
            </Text>
            <Text style={[t.type.body, styles.emptyBody, { color: t.color.inkBody }]}>
              {COPY.setupBody}
            </Text>
            <View
              style={[
                styles.commandBlock,
                { backgroundColor: t.color.paperInset, borderColor: t.color.lineSoft },
              ]}
            >
              <Text selectable style={[t.type.utilityData, { color: t.color.inkBody }]}>
                {COPY.setupClaude}
              </Text>
              <Text selectable style={[t.type.utilityData, { color: t.color.inkBody }]}>
                {COPY.setupCodex}
              </Text>
            </View>
          </>
        ) : (
          <Text style={[t.type.body, styles.emptyBody, { color: t.color.inkBody }]}>
            {notificationsOnly
              ? 'Your configured connection can report updates. Interactive approvals and tasks are not configured.'
              : knownCapabilities.length === 0
                ? 'Capability details are unavailable for this connection.'
                : 'Configured capability details were reported by your agent.'}
          </Text>
        )}
        <Text
          style={[
            t.type.compactBody,
            styles.emptyFoot,
            { color: t.color.inkMuted },
          ]}
        >
          {COPY.setupFoot}
        </Text>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader
        title={COPY.title}
        onBack={onBack}
        testIDBack="attention-back"
      />
      {phase === 'loading' ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={COPY.loading}
          testID="attention-loading"
          style={styles.center}
        >
          <ActivityIndicator color={t.color.pine} />
          <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
            {COPY.loading}
          </Text>
        </View>
      ) : phase === 'error' ? (
        <View style={styles.center} testID="attention-error">
          <InlineError message={COPY.error} />
          <TextAction
            label={COPY.retry}
            onPress={refresh}
            testID="attention-retry"
          />
        </View>
      ) : (
        <SectionList
          testID="attention-list"
          style={[styles.list, { maxWidth: t.layout.contentMax }]}
          contentContainerStyle={[
            styles.content,
            liveRows.length === 0 && workSections.length === 0 && styles.emptyContent,
          ]}
          sections={sections}
          keyExtractor={item => `${item.peerId}:${item.q}`}
          renderSectionHeader={renderSectionHeader}
          renderItem={renderItem}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            liveRows.length > 0 ? (
              <Text
                style={[t.type.compactBody, styles.intro, { color: t.color.inkMuted }]}
              >
                {COPY.intro(liveRows.length)}
              </Text>
            ) : null
          }
          ListEmptyComponent={workSections.length === 0 ? empty : null}
          ListFooterComponent={workFeed}
        />
      )}
    </View>
  );
}

function stylesFor(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1 },
    list: { width: '100%', alignSelf: 'center' },
    content: { paddingBottom: t.space.s10 },
    emptyContent: { flexGrow: 1 },
    intro: {
      paddingHorizontal: t.layout.gutter,
      paddingTop: t.space.s6,
      paddingBottom: t.space.s5,
    },
    workFeed: { paddingTop: t.space.s7 },
    workIntro: {
      paddingHorizontal: t.layout.gutter,
      paddingBottom: t.space.s5,
      gap: t.space.s2,
    },
    workSectionHeader: {
      minHeight: t.layout.touchTarget,
      paddingHorizontal: t.layout.gutter,
      paddingTop: t.space.s5,
      paddingBottom: t.space.s4,
      borderBottomWidth: t.hairline,
      gap: t.space.s1,
    },
    workRow: {
      minHeight: 76,
      borderBottomWidth: t.hairline,
      paddingHorizontal: t.layout.gutter,
      paddingVertical: t.space.s4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
    },
    workTitleLine: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: t.space.s3,
      flexWrap: 'wrap',
    },
    workTime: { alignItems: 'flex-end', gap: t.space.s1 },
    sectionHeader: {
      minHeight: t.layout.touchTarget,
      paddingHorizontal: t.layout.gutter,
      paddingTop: t.space.s5,
      paddingBottom: t.space.s4,
      borderBottomWidth: t.hairline,
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: t.space.s1,
    },
    sectionName: { flexShrink: 1 },
    row: {
      minHeight: 70,
      borderBottomWidth: t.hairline,
      borderLeftWidth: 3,
      paddingLeft: t.layout.gutter - 3,
      paddingRight: t.space.s5,
      paddingVertical: t.space.s5,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.s4,
    },
    rowCopy: { flex: 1, gap: t.space.s1 },
    due: { flexShrink: 0 },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.s5,
      paddingHorizontal: t.layout.gutterWide,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.layout.gutterWide,
      paddingVertical: t.space.s10,
    },
    emptyBody: {
      textAlign: 'center',
      marginTop: t.space.s4,
      maxWidth: 360,
    },
    emptyRule: {
      height: t.hairline,
      alignSelf: 'stretch',
      marginVertical: t.space.s9,
    },
    commandBlock: {
      alignSelf: 'stretch',
      borderWidth: t.hairline,
      borderRadius: t.radius.room,
      marginTop: t.space.s6,
      padding: t.space.s5,
      gap: t.space.s4,
    },
    emptyFoot: {
      textAlign: 'center',
      marginTop: t.space.s6,
      maxWidth: 420,
    },
  });
}
