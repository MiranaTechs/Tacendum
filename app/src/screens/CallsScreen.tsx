import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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
import { HomeHeader, InlineError } from '../ui/primitives';

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
  /**
   * Resolve with a `callRefusalCopy` sentence when a call is refused, or with
   * nothing when the call succeeds.
   *
   * The shell owns the refusal contract: it is the side that holds
   * `ensurePermissions`' answer and catches `placeCall`'s
   * `CallRefusedError`. This screen only decides where the sentence lands.
   * `void` is still an acceptable return, so a caller that has nothing to
   * report — a test, a surface with no notice — stays valid.
   */
  onCall(
    peerId: string,
    kind: 'audio' | 'video',
  ): void | Promise<string | null | void>;
  /**
   * The profile door in the shared home header: the same disc, in the same
   * corner, as the Chats tab. Both are optional; when absent, the header omits the
   * control so it cannot expose an action that does nothing. */
  profile?: Pick<db.ProfileRow, 'userId' | 'displayName' | 'avatarB64'> | null;
  onOpenProfile?(): void;
}

/** The rotor action's name, and the label a screen reader speaks for it. */
const CALL_BACK_ACTION = 'call-back';
const CALL_ROW_ACTIONS = [{ name: CALL_BACK_ACTION, label: 'Call back' }];

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
  /**
   * Why the last call did not happen, and a counter beside it.
   *
   * The counter is what re-announces an IDENTICAL repeated refusal: press a
   * blocked peer's button twice and the message never changes, so
   * `InlineError`'s effect would not fire again and the second press would be
   * silent.
   */
  const [refusal, setRefusal] = useState<{ message: string; seq: number } | null>(
    null,
  );
  const refusalSeq = React.useRef(0);
  const placeCall = useCallback(
    (peerId: string, kind: 'audio' | 'video') => {
      // Cleared at the tap, not at the answer: the old sentence must not sit
      // under the header describing an attempt that is already over.
      setRefusal(null);
      void Promise.resolve(onCall(peerId, kind))
        .then(reason => {
          if (!reason) return;
          refusalSeq.current += 1;
          setRefusal({ message: reason, seq: refusalSeq.current });
        })
        .catch(() => {
          // The shell RESOLVES refusals; a thrown one is a defect, and an
          // Error's message is written for a log ('peer is blocked'), never
          // for a person. Nothing is shown rather than something wrong.
        });
    },
    [onCall],
  );

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
  /**
   * A REFUSAL DOES NOT SURVIVE THE TRIP IT ASKED FOR.
   *
   * 'Microphone access is off. Turn it on in Settings to make calls.' sends
   * somebody out of the app. They grant it and come back — and without this,
   * the sentence is still sitting under the header saying the opposite of
   * what is now true, for exactly as long as they are acting on it. The next
   * tap clears it, but the next tap is the thing they are deciding whether
   * to make.
   *
   * A tab switch already unmounts this screen, so that path was never the
   * hole; backgrounding was. Only the 'active' transition clears — a
   * notification shade or a pocketed phone leaves the sentence standing,
   * because nothing about the refusal changed while it was down there.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') setRefusal(null);
    });
    return () => sub.remove();
  }, []);
  // Opening this list answers all missed-call notices because their target
  // rows are now visible. Clear notices for every peer together.
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
        // Keep redial beside the row: iOS merges an accessible container's
        // subtree into one element, so nesting the redial Pressable inside
        // the labeled row would hide the call action from VoiceOver.
        <View style={styles.rowWrap}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => onOpenChat(item.row.peerId)}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${callLabel(data)}${
              duration ? `, ${duration}` : ''
            }`}
            // …AND the row offers the same call as a rotor action, so both
            // navigation styles reach it: swiping right to the next element
            // finds the button, and someone who never leaves the row finds
            // "Call back" in the actions rotor.
            accessibilityActions={CALL_ROW_ACTIONS}
            onAccessibilityAction={e => {
              // The system passes activate/magicTap and friends through this
              // same prop; anything that is not ours is ignored (the pip's
              // rule, pipCornerForAction).
              if (e.nativeEvent.actionName === CALL_BACK_ACTION) {
                placeCall(item.row.peerId, item.row.kind);
              }
            }}
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
            {/* One line, like the chat list's own timestamp: this Text is a
                flex child of the row beside the name column, and at large
                Dynamic Type a relative time long enough to be measured
                against the space left over wraps to two and drags the row
                open. */}
            <Text style={[t.type.timeStatus, styles.when]} numberOfLines={1}>
              {timeLabel(item.row.startedAt)}
            </Text>
          </Pressable>
          {/* The glyph kit, not a typographic stand-in: the
              same camera and handset the thread's call buttons draw, in a
              full 44pt disc. */}
          <Pressable
            onPress={() => placeCall(item.row.peerId, item.row.kind)}
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
      );
    },
    [onOpenChat, placeCall, styles, t],
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
        {/* Refusal copy stays below the header in layout, moving the list
            down. Persistent text remains available to VoiceOver readers
            instead of disappearing before they can reach it. */}
        {refusal && (
          <View style={styles.noticeWrap}>
            <InlineError
              message={refusal.message}
              seq={refusal.seq}
              testID="calls-refusal"
            />
          </View>
        )}
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
    /** The refusal notice sits on the rows' own gutter, not the screen edge. */
    noticeWrap: { paddingHorizontal: t.layout.gutter },
    /** Row and redial side by side, one gutter around the pair. The wrapper
     * carries NO accessibility props of its own — it is a box, and a box
     * that spoke would put the two elements back inside one. */
    rowWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: t.layout.gutter,
      gap: t.space.s2,
    },
    // The chat list's row geometry: the row disc, the row
    // height, and type off the scale — so the two tabs' lists read as one.
    row: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: t.layout.chatRowHeight,
      paddingLeft: t.layout.gutter,
      paddingRight: t.space.s4,
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
    /** flexShrink written down rather than left to Yoga's default: it is 0
     * here, not the 1 a reader coming from CSS expects, and the time giving
     * up width to the name column would be the wrong trade. */
    when: { color: t.color.inkMuted, flexShrink: 0 },
    /** The row's one action: a white disc with a hairline edge, so it stands
     * off the white row, and the forest glyph inside it says it acts. A
     * press moves the disc to the gray fill, away from the page. */
    redial: {
      width: t.layout.touchTarget,
      height: t.layout.touchTarget,
      borderRadius: t.radius.circle,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.paperSheet,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.color.lineSoft,
    },
    redialPressed: { backgroundColor: t.color.paperInset },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: t.space.s4 },
    emptyTitle: { color: t.color.inkStrong },
    emptyBody: { color: t.color.inkMuted, textAlign: 'center' },
  });
}
