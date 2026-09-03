import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { clearMissedCallNotices, useCallState } from '../call';
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
import { PhoneGlyph, VideoGlyph } from '../ui/CallGlyph';
import { HomeHeader } from '../ui/primitives';

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
  /**
   * The profile door in the shared home header: the same disc, in the same
   * corner, as the Chats tab. Both optional so the shell can hand them over
   * on its own schedule — absent, the header renders without a door rather
   * than a door that does nothing. */
  profile?: Pick<db.ProfileRow, 'userId' | 'displayName' | 'avatarB64'> | null;
  onOpenProfile?(): void;
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

export function CallsScreen({
  onOpenChat,
  onCall,
  profile,
  onOpenProfile,
}: Props): React.JSX.Element {
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
  // Opening the tab ANSWERS the missed-call notices: the rows below are what
  // they pointed at, so the notices for every peer come down together the
  // moment the list is on screen.
  useEffect(() => {
    void clearMissedCallNotices(null);
  }, []);
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
            size={t.layout.avatar.row}
          />
          <View style={styles.rowBody}>
            <Text
              style={[t.type.rowTitle, styles.name, data.missed && styles.missedName]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
            <Text style={[t.type.compactBody, styles.detail]} numberOfLines={1}>
              <Text style={data.missed ? styles.missedGlyph : styles.glyph}>
                {callGlyph(data)}
              </Text>
              {'  '}
              {callLabel(data)}
              {duration ? ` · ${duration}` : ''}
            </Text>
          </View>
          <View style={styles.rowEnd}>
            <Text style={[t.type.timeStatus, styles.when]}>
              {timeLabel(item.row.startedAt)}
            </Text>
            {/* The glyph kit, not a typographic stand-in: the
                same camera and handset the thread's call buttons draw, in a
                full 44pt disc. */}
            <Pressable
              onPress={() => onCall(item.row.peerId, item.row.kind)}
              accessibilityRole="button"
              accessibilityLabel={`${
                item.row.kind === 'video' ? 'Video' : 'Audio'
              } call ${item.name}`}
              style={({ pressed }) => [styles.redial, pressed && styles.redialPressed]}
            >
              {item.row.kind === 'video' ? (
                <VideoGlyph size={20} color={t.color.pine} />
              ) : (
                <PhoneGlyph size={20} color={t.color.pine} />
              )}
            </Pressable>
          </View>
        </Pressable>
      );
    },
    [onCall, onOpenChat, styles, t],
  );

  return (
    <View style={styles.screen}>
      {/* The reading column: header and rows cap
          at contentMax together, so a medium/expanded pane hands this
          screen an honest width instead of stretching every row across the
          glass. Width only; on phones — and in the wide shell's list pane —
          the cap never engages. */}
      <View style={styles.clamp}>
        {/* The home header the Chats tab shares: the same title
            role, height and profile door, so a tab switch changes the word
            and nothing else. */}
        <HomeHeader
          title="Calls"
          profile={profile}
          onOpenProfile={onOpenProfile}
        />
      </View>
      {items.length === 0 ? (
        <View style={[styles.empty, styles.clamp]}>
          <Text style={[t.type.sectionTitle, styles.emptyTitle]}>No calls yet</Text>
          <Text style={[t.type.body, styles.emptyBody]}>
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
    listContent: { paddingBottom: t.space.s8 },
    // The chat list's row geometry: the row disc, the row height, and type
    // off the scale — so the two tabs' lists read as one.
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: t.layout.chatRowHeight,
      paddingHorizontal: t.layout.gutter,
      paddingVertical: t.space.s4,
      gap: t.space.s5,
    },
    rowPressed: { backgroundColor: t.color.pineWashFaint },
    rowBody: { flex: 1, minWidth: 0 },
    name: { color: t.color.inkStrong },
    missedName: { color: t.color.danger },
    detail: { color: t.color.inkMuted, marginTop: t.space.s1 },
    glyph: { color: t.color.pine },
    missedGlyph: { color: t.color.danger },
    rowEnd: { alignItems: 'flex-end', gap: t.space.s2 },
    when: { color: t.color.inkMuted },
    redial: {
      width: t.layout.touchTarget,
      height: t.layout.touchTarget,
      borderRadius: t.radius.circle,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.pineWash,
    },
    redialPressed: { backgroundColor: t.color.pineLine },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: t.space.s4 },
    emptyTitle: { color: t.color.inkStrong },
    emptyBody: { color: t.color.inkMuted, textAlign: 'center' },
  });
}
