import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useCallState } from '../call';
import {
  callDuration,
  callGlyph,
  callLabel,
  type CallLogRowData,
} from '../components/CallLogRow';
import * as db from '../db';
import { personName, sanitizeDisplayName } from '../person';
import { useTheme, type Theme } from '../theme';
import { timeLabel } from '../time';
import { Avatar } from '../ui/Avatar';

/**
 * Every call, across every conversation — the second tab.
 *
 * The rows are LOCAL, like the per-thread call chips: each side derives its
 * own history from its own state machine and the two never exchange log
 * data, so a peer cannot forge a call into this list or delete one out of
 * it. Names and pictures come from the chats table at render time, so a
 * rename or new photo applies to history retroactively — the list shows who
 * the person IS, not who they were when they called.
 */

interface Props {
  onOpenChat(peerId: string): void;
  onCall(peerId: string, kind: 'audio' | 'video'): void;
}

interface CallListItem {
  row: db.CallLogRow;
  name: string;
  /**
   * The raw stored name for the disc, kept separate from the resolved `name`:
   * personName's id-fragment fallback is a label, not a name, and a monogram
   * sliced from "…KX7A9QZ2" reads "…K" where the disc's documented nameless
   * fallback is the id tail.
   */
  rawName: string | null;
  avatarB64: string | null;
}

function toRowData(r: db.CallLogRow): CallLogRowData {
  return {
    cid: r.cid,
    direction: r.direction,
    kind: r.kind,
    reason: r.reason,
    connectedAt: r.connectedAt,
    endedAt: r.endedAt,
    missed: r.missed === 1,
  };
}

export function CallsScreen({ onOpenChat, onCall }: Props): React.JSX.Element {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [items, setItems] = useState<CallListItem[]>([]);
  const call = useCallState();

  const refreshSeq = React.useRef(0);
  const refresh = useCallback(() => {
    // Sequenced: mount and the idle-transition effect both fire on first
    // render, and an OLDER snapshot resolving last must not erase the newest
    // call from the list.
    const seq = ++refreshSeq.current;
    void (async () => {
      try {
        const [rows, chats] = await Promise.all([db.listAllCalls(), db.listChats()]);
        if (seq !== refreshSeq.current) return;
        const byPeer = new Map(chats.map(c => [c.peerId, c]));
        setItems(
          rows.map(row => {
            const chat = byPeer.get(row.peerId);
            return {
              row,
              name: personName(row.peerId, chat?.displayName, chat?.localName),
              // personName's own precedence, trims included: an empty-string
              // localName must not shadow a real card name off the disc.
              rawName:
                sanitizeDisplayName(chat?.localName) ||
                sanitizeDisplayName(chat?.displayName) ||
                null,
              avatarB64: chat?.avatarB64 ?? null,
            };
          }),
        );
      } catch {
        // A closed database (mid-relock) leaves the previous list standing;
        // the next focus or call-end refreshes it.
      }
    })();
  }, []);

  useEffect(refresh, [refresh]);
  // A call that just ended is this screen's newest row.
  const callName = call.name;
  useEffect(() => {
    if (callName === 'idle') refresh();
  }, [callName, refresh]);

  const renderItem = useCallback(
    ({ item }: { item: CallListItem }) => {
      const data = toRowData(item.row);
      const duration = callDuration(data);
      return (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => onOpenChat(item.row.peerId)}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${callLabel(data)}${
            duration ? `, ${duration}` : ''
          }`}
        >
          <Avatar
            peerId={item.row.peerId}
            displayName={item.rawName}
            photoB64={item.avatarB64}
            size={44}
          />
          <View style={styles.rowBody}>
            <Text
              style={[styles.name, data.missed && styles.missedName]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            <Text style={styles.detail} numberOfLines={1}>
              <Text style={data.missed ? styles.missedGlyph : styles.glyph}>
                {callGlyph(data)}
              </Text>
              {'  '}
              {callLabel(data)}
              {duration ? ` · ${duration}` : ''}
            </Text>
          </View>
          <View style={styles.rowEnd}>
            <Text style={styles.when}>{timeLabel(item.row.startedAt)}</Text>
            <Pressable
              onPress={() => onCall(item.row.peerId, item.row.kind)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${
                item.row.kind === 'video' ? 'Video' : 'Audio'
              } call ${item.name}`}
              style={({ pressed }) => [styles.redial, pressed && styles.redialPressed]}
            >
              <Text style={styles.redialGlyph}>
                {item.row.kind === 'video' ? '⧉' : '✆'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      );
    },
    [onCall, onOpenChat, styles],
  );

  return (
    <View style={styles.screen}>
      {/* The reading column: header and rows cap
          at contentMax together, so a medium/expanded pane hands this
          screen an honest width instead of stretching every row across the
          glass. Width only; on phones — and in the wide shell's list pane —
          the cap never engages. */}
      <View
        style={[styles.header, styles.clamp, { paddingHorizontal: t.layout.gutter }]}
      >
        <Text style={styles.title} accessibilityRole="header">
          Calls
        </Text>
      </View>
      {items.length === 0 ? (
        <View style={[styles.empty, styles.clamp]}>
          <Text style={styles.emptyTitle}>No calls yet</Text>
          <Text style={styles.emptyBody}>
            Calls you make and receive stay on this device — nobody else holds
            this list, so nobody else can rewrite it.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.row.cid}
          renderItem={renderItem}
          style={styles.clamp}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.paperGround },
    /** Full width until contentMax caps it — the Register/Profile pattern. */
    clamp: { width: '100%', maxWidth: t.layout.contentMax, alignSelf: 'center' },
    header: { paddingTop: 12, paddingBottom: 8 },
    title: { color: t.color.inkStrong, fontSize: 28, fontWeight: '700' },
    listContent: { paddingBottom: 24 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.layout.gutter,
      paddingVertical: 10,
      gap: 12,
    },
    rowPressed: { backgroundColor: t.color.pineWashFaint },
    rowBody: { flex: 1, minWidth: 0 },
    name: { color: t.color.inkStrong, fontSize: 16, fontWeight: '600' },
    missedName: { color: t.color.danger },
    detail: { color: t.color.inkMuted, fontSize: 13, marginTop: 2 },
    glyph: { color: t.color.pine },
    missedGlyph: { color: t.color.danger },
    rowEnd: { alignItems: 'flex-end', gap: 6 },
    when: { color: t.color.inkMuted, fontSize: 12 },
    redial: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.pineWash,
    },
    redialPressed: { backgroundColor: t.color.pineLine },
    redialGlyph: { color: t.color.pine, fontSize: 16 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
    emptyTitle: { color: t.color.inkStrong, fontSize: 17, fontWeight: '600' },
    emptyBody: { color: t.color.inkMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  });
}
