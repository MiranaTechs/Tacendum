import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { GROUP_MAX_MEMBERS } from '@tacendum/shared/group-envelope';
import { applyGroupNew, ownerOnlyPolicy } from '@tacendum/shared/group-fold';
import * as db from '../db';
import { encodeEnvelope } from '../envelope';
import { messaging } from '../messaging';
import { nextMsgId } from '../msgid';
import { personName, sanitizeDisplayName } from '../person';
import { useTheme } from '../theme';
import { Avatar } from '../ui/Avatar';
import { InlineError, PrimaryButton, ScreenHeader, TextAction } from '../ui/primitives';

interface Props {
  profile: db.ProfileRow;
  onBack: () => void;
  /** Open the room's thread once it exists. */
  onOpenRoom: (groupId: string) => void;
}

const COPY = {
  title: 'New room',
  intro:
    'A room is one conversation for the people you choose. Everyone in it sees everything said in it.',

  nameLabel: 'Room name',
  namePlaceholder: 'What to call it',

  membersLabel: 'Members',
  /** The cap counts YOU (`ms` includes the creator), and the counter
   * says so rather than letting 11 read as a full room of 11. */
  seatCount: (taken: number) =>
    `${taken} of ${GROUP_MAX_MEMBERS}, including you`,
  capReached: `A room holds ${GROUP_MAX_MEMBERS} people, including you.`,
  identityChanged:
    'Safety number changed — review it in their chat before adding them.',
  noContacts:
    'A room is made from people you already talk to. Start a chat first — the + on the chat list.',

  create: 'Create room',
  creating: 'Creating…',

  aboutToggle: 'About rooms',
  // What the UI says must be exactly what the
  // design does. Two facts, behind the ⓘ, in the vault tone.
  aboutAuthority:
    'Only you will ever be able to add or remove people here — a room stays ' +
    'with its maker. Anyone can leave whenever they like.',
  // The framing, which must not be softened: the room — name, roster,
  // contents — is hidden from the server; the fan-out is not, and an
  // operator who wants the member list gets it. Never claim more or less.
  aboutServer:
    'A room hides its name, its member list and everything said in it from ' +
    'Tacendum’s server — each message travels encrypted, one copy to each ' +
    'member. It does not hide the sending itself: the server sees who each ' +
    'copy goes to, so a server operator who wants the member list gets it.',

  nameNeeded: 'Give the room a name first.',
  memberNeeded: 'Pick at least one person.',
  createFailed: 'Tacendum couldn’t create this room. Try again.',
  inviteFailed: (names: string) =>
    `The room was made, but the invitation to ${names} couldn’t be sent.`,
  openAnyway: 'Open the room',
} as const;

/** One picked-or-pickable person, resolved once at load. */
interface Candidate {
  chat: db.ChatRow;
  /** A changed safety number keeps the seat empty until it is reviewed —
   * fanOut would only skip their legs loudly anyway, so the
   * honest place to stop is before they are on the roster at all. */
  identityChanged: boolean;
}

export interface RoomCreateResult {
  groupId: string;
  /** Members whose invitation could not be sent. They are on the roster —
   * the roster is the owner's claim — but nothing reached their phone. */
  failed: { peerId: string; reason: string }[];
}

/**
 * Make a room: mint its id, anchor it with MYSELF as owner, seed the roster,
 * and send each member the `grp.new` — all through machinery that already
 * exists, composed here rather than re-implemented.
 *
 *  - The id is a fresh ULID from the platform RNG (`nextMsgId`). Never in
 *    `SendFrame.to`: it only ever rides inside ciphertext.
 *  - The anchor + roster + chats row land through the SAME apply path a
 *    receiver runs (`applyGroupNew` over `loadGroupStore`), so the creator's
 *    phone holds exactly what every member's phone will hold — one code
 *    path, not a creator-shaped copy of it. The apply rides INSIDE
 *    `fanOutMembership`'s gates→apply→compose order, so a refused room is
 *    refused before anything is anchored.
 *  - The invitations are ONE room-scoped fan-out (`fanOutMembership`): one
 *    announcement row in the room itself, one outbox leg per member, one
 *    transaction. The previous seam — the encoded `grp.new` pushed through
 *    `messaging.sendText` per member — was honest but wrong in exactly the
 *    way its own comment predicted: each invitation was a 1:1-scoped
 *    envelope, so every member's PRIVATE thread on this phone grew an
 *    out-row and a "New room" preview, and those legs survived
 *    `deleteGroup` because nothing tied them to the room. The room-scoped
 *    fan-out leaves no row in any 1:1 thread, its legs die with the room,
 *    and the legs share the pacing budget instead of bursting.
 *
 * Gate order mirrors `fanOut`: the block check runs before ANY
 * allocation — nothing minted, nothing written, for a room that would
 * contain someone this device blocks. Read from `blocked_peers`, not from
 * messaging's enforcement Set, so a duress session answers from the decoy
 * workspace's own truth.
 */
export async function createRoom(
  selfId: string,
  name: string,
  memberIds: string[],
): Promise<RoomCreateResult> {
  const nm = name.trim();
  const members = [...new Set(memberIds)].filter(id => id !== selfId);
  if (nm === '') throw new Error(COPY.nameNeeded);
  if (members.length === 0) throw new Error(COPY.memberNeeded);
  // GROUP_MAX_MEMBERS in the composer, not only the schema:
  // the schema bounds what a peer's grp.new may carry; this bounds what
  // THIS phone will mint. The +1 is me — `ms` includes the creator.
  if (members.length + 1 > GROUP_MAX_MEMBERS) {
    throw new Error(COPY.capReached);
  }
  for (const memberId of members) {
    if ((await db.getBlockedAt(memberId)) !== null) {
      // Same refusal class as fanOut's gate 2: a room containing
      // someone you blocked is read-only from birth, so it is never made.
      throw new Error(COPY.createFailed);
    }
  }

  const groupId = await nextMsgId();
  const roster = [selfId, ...members];
  // The class claims (the consent-bootstrap
  // fix): which of the seats this phone's OWN machine record names. Riding
  // the grp.new, every invitee's device can offer the consent choice
  // before the agent ever speaks. From `machine_peers` alone — the server's
  // own adopt answers — never a guess (machine.ts's rule); a member the
  // record cannot name simply gets no entry, absent being the safe default.
  const machines = new Set(await db.listMachinePeers().catch(() => []));
  const integrations = roster.filter(id => machines.has(id)).sort();
  const ic = integrations.length > 0 ? { ic: integrations } : {};
  // Compose-time validation BEFORE any write (envelope.ts's invariant: an
  // envelope this build cannot parse must never be encodable). A refused
  // name or roster throws here, with the database untouched.
  encodeEnvelope({ tcm: 'grp.new', g: groupId, nm, ms: roster, n: 1, ...ic });

  const seq = await db.reserveGroupSeq(groupId, 'writer');

  // One room-scoped fan-out: the seam runs its gates, then the apply below
  // (anchor + roster + presence through the receiver's own apply path), then
  // writes the room's own first row — the same attributed grp.new row a
  // member's phone writes at accept, so the thread opens on "New
  // room" — together with every invitation leg in ONE transaction. A member
  // whose invitation cannot be composed becomes a settled failed leg, never
  // a stranded fan-out (the skip rule), and the roster keeps their seat:
  // the roster is the owner's claim, and silently shrinking it would be
  // The exact omission.
  const result = await messaging.fanOutMembership(
    groupId,
    { tcm: 'grp.new', g: groupId, nm, ms: roster, n: seq, ...ic },
    {
      apply: async () => {
        const store = await db.loadGroupStore(groupId);
        store.anchorName = nm;
        applyGroupNew(
          store,
          selfId,
          {
            writerId: selfId,
            members: roster,
            seq,
            ...(integrations.length > 0 ? { integrations } : {}),
          },
          ownerOnlyPolicy,
        );
        await store.persist();
        return true;
      },
    },
  );

  const failed: RoomCreateResult['failed'] = [
    ...(result?.skipped ?? []).map(peerId => ({
      peerId,
      reason: COPY.identityChanged,
    })),
    ...(result?.failed ?? []).map(peerId => ({
      peerId,
      reason: 'not sent',
    })),
  ];
  return { groupId, failed };
}

/**
 * Name the room, pick its people, create it.
 * The pick list is the chat list minus rooms (a room cannot join a room) and
 * minus anyone this device blocks; a changed safety number shows, disabled,
 * with its reason — a seat that silently failed would be the exact tell.
 */
export function GroupCreateScreen({ profile, onBack, onOpenRoom }: Props) {
  const t = useTheme();
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the room exists but some invitation could not be sent, so the
   * error can offer the room instead of stranding the person here. */
  const [createdId, setCreatedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      const [chats, blocked] = await Promise.all([
        db.listChats(),
        db.listBlockedPeers().catch(() => [] as string[]),
      ]);
      const blockedSet = new Set(blocked);
      const rows: Candidate[] = [];
      for (const chat of chats) {
        if (blockedSet.has(chat.peerId)) continue;
        // A room is not a person: rows with an anchor never appear here.
        if ((await db.getGroup(chat.peerId).catch(() => null)) !== null) {
          continue;
        }
        rows.push({
          chat,
          identityChanged: chat.identityChangedAt !== null,
        });
      }
      setCandidates(rows);
    })();
  }, []);

  useEffect(() => {
    refresh();
    return messaging.subscribe(refresh);
  }, [refresh]);

  // The composer's half of the bound: at the cap, unpicked rows close.
  const seatsTaken = picked.size + 1;
  const full = seatsTaken >= GROUP_MAX_MEMBERS;

  const toggle = useCallback(
    (peerId: string) => {
      setError(null);
      setPicked(current => {
        const next = new Set(current);
        if (next.has(peerId)) {
          next.delete(peerId);
        } else {
          if (next.size + 1 >= GROUP_MAX_MEMBERS) return current;
          next.add(peerId);
        }
        return next;
      });
    },
    [],
  );

  const nameFor = useCallback(
    (peerId: string) => {
      const row = candidates.find(c => c.chat.peerId === peerId);
      return row
        ? personName(peerId, row.chat.displayName, row.chat.localName)
        : personName(peerId);
    },
    [candidates],
  );

  const create = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      let result: RoomCreateResult;
      try {
        result = await createRoom(profile.userId, name, [...picked]);
      } catch (err) {
        setBusy(false);
        setError(err instanceof Error ? err.message : COPY.createFailed);
        return;
      }
      if (result.failed.length > 0) {
        // The room exists; the failure is named, never absorbed.
        setBusy(false);
        setCreatedId(result.groupId);
        setError(
          COPY.inviteFailed(
            result.failed.map(f => nameFor(f.peerId)).join(', '),
          ),
        );
        return;
      }
      onOpenRoom(result.groupId);
    })();
  }, [busy, name, nameFor, onOpenRoom, picked, profile.userId]);

  const header = useMemo(
    () => (
      <View>
        <Text
          style={[t.type.compactBody, { color: t.color.inkBody }]}
        >
          {COPY.intro}
        </Text>
        <Pressable
          onPress={() => setAbout(open => !open)}
          accessibilityRole="button"
          accessibilityLabel={COPY.aboutToggle}
          accessibilityState={{ expanded: about }}
          testID="room-about"
          style={({ pressed }) => [
            styles.aboutToggle,
            {
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.button,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
            {COPY.aboutToggle}
          </Text>
        </Pressable>
        {about ? (
          <View testID="room-about-body">
            {[COPY.aboutAuthority, COPY.aboutServer].map(line => (
              <Text
                key={line}
                style={[
                  t.type.compactBody,
                  styles.aboutLine,
                  { color: t.color.inkMuted },
                ]}
              >
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        <Text
          style={[
            t.type.utilityLabel,
            styles.nameLabel,
            { color: t.color.inkMuted },
          ]}
        >
          {COPY.nameLabel}
        </Text>
        <TextInput
          value={name}
          onChangeText={next => {
            setName(next);
            setError(current => (current === null ? current : null));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={COPY.namePlaceholder}
          placeholderTextColor={t.color.inkMuted}
          accessibilityLabel={COPY.nameLabel}
          autoCorrect={false}
          // The wire bound (group-envelope's name schema), enforced where
          // the typing happens rather than discovered at encode time.
          maxLength={80}
          returnKeyType="done"
          testID="room-name-input"
          style={[
            t.type.input,
            styles.nameInput,
            {
              minHeight: t.layout.buttonHeight,
              borderRadius: t.radius.button,
              backgroundColor: t.color.paperSheet,
              color: t.color.inkStrong,
              borderWidth: focused ? 2 : 1,
              borderColor: focused ? t.color.pine : t.color.lineStrong,
            },
          ]}
        />

        <View style={styles.membersRow}>
          <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
            {COPY.membersLabel}
          </Text>
          <Text
            style={[t.type.counter, { color: full ? t.color.pine : t.color.inkMuted }]}
            testID="room-seat-count"
          >
            {COPY.seatCount(seatsTaken)}
          </Text>
        </View>
        {full ? (
          <Text
            style={[
              t.type.compactBody,
              styles.capNote,
              { color: t.color.inkMuted },
            ]}
            testID="room-cap-note"
          >
            {COPY.capReached}
          </Text>
        ) : null}
      </View>
    ),
    [about, focused, full, name, seatsTaken, t],
  );

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      <ScreenHeader title={COPY.title} onBack={onBack} testIDBack="room-back" />
      <FlatList
        data={candidates}
        extraData={{ picked, full }}
        keyExtractor={row => row.chat.peerId}
        keyboardShouldPersistTaps="handled"
        // The reading column: the list and its
        // footer cap at contentMax like Register/Profile, so a
        // medium/expanded pane hands this screen an honest width. Width
        // only — the main axis is untouched; on phones the cap never
        // engages.
        style={[styles.clamp, { maxWidth: t.layout.contentMax }]}
        // First paint carries at least a full room's worth of rows: the cap
        // is 12, and a pick list whose 11th row only mounts on scroll would
        // make the cap unreachable-looking on short lists.
        initialNumToRender={GROUP_MAX_MEMBERS}
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: 12,
          paddingHorizontal: t.layout.gutter,
        }}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => (
          <View
            style={{
              marginLeft: t.layout.separatorInset - t.layout.gutter,
              height: t.hairline,
              backgroundColor: t.color.lineSoft,
            }}
          />
        )}
        ListEmptyComponent={
          <Text
            style={[
              t.type.compactBody,
              styles.noContacts,
              { color: t.color.inkMuted },
            ]}
          >
            {COPY.noContacts}
          </Text>
        }
        renderItem={({ item }) => {
          const selected = picked.has(item.chat.peerId);
          const closed = item.identityChanged || (full && !selected);
          return (
            <View>
              <Pressable
                onPress={() => toggle(item.chat.peerId)}
                disabled={closed}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: closed }}
                accessibilityLabel={personName(
                  item.chat.peerId,
                  item.chat.displayName,
                  item.chat.localName,
                )}
                testID={`room-pick-${item.chat.peerId}`}
                style={({ pressed }) => [
                  styles.candidate,
                  {
                    minHeight: t.layout.rowHeight,
                    backgroundColor: pressed
                      ? t.color.pineWash
                      : 'transparent',
                  },
                ]}
              >
                <Avatar
                  peerId={item.chat.peerId}
                  displayName={item.chat.localName ?? item.chat.displayName}
                  photoB64={item.chat.avatarB64}
                  size={t.layout.avatar.header}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    // Agrees with the personName label below it: a
                    // card that sanitizes away is set in the id face.
                    sanitizeDisplayName(item.chat.localName) ||
                    sanitizeDisplayName(item.chat.displayName)
                      ? t.type.rowTitle
                      : t.type.utilityData,
                    styles.candidateName,
                    {
                      color: closed && !selected
                        ? t.color.inkMuted
                        : t.color.inkStrong,
                    },
                  ]}
                >
                  {personName(
                    item.chat.peerId,
                    item.chat.displayName,
                    item.chat.localName,
                  )}
                </Text>
                {/* Selection mark in the Quiet Room's own vocabulary: an
                    outlined place, filled with a pine dot once taken. */}
                <View
                  style={[
                    styles.seat,
                    {
                      borderRadius: t.radius.circle,
                      borderColor: selected
                        ? t.color.pine
                        : t.color.pineLine,
                      backgroundColor: selected
                        ? t.color.pineWash
                        : 'transparent',
                    },
                  ]}
                  {...(selected
                    ? { testID: `room-picked-${item.chat.peerId}` }
                    : {})}
                >
                  {selected ? (
                    <View
                      style={[
                        styles.seatDot,
                        { backgroundColor: t.color.pine },
                      ]}
                    />
                  ) : null}
                </View>
              </Pressable>
              {item.identityChanged ? (
                <Text
                  style={[
                    t.type.compactBody,
                    styles.identityNote,
                    { color: t.color.warningInk },
                  ]}
                >
                  {COPY.identityChanged}
                </Text>
              ) : null}
            </View>
          );
        }}
      />
      <View
        style={[
          styles.footer,
          styles.clamp,
          { maxWidth: t.layout.contentMax, paddingHorizontal: t.layout.gutter },
        ]}
      >
        {error ? (
          <InlineError message={error} testID="room-create-error" />
        ) : null}
        {createdId !== null ? (
          <TextAction
            label={COPY.openAnyway}
            onPress={() => onOpenRoom(createdId)}
            testID="room-open-anyway"
          />
        ) : null}
        <PrimaryButton
          label={COPY.create}
          busyLabel={COPY.creating}
          onPress={create}
          busy={busy}
          disabled={name.trim() === '' || picked.size === 0 || createdId !== null}
          testID="room-create"
          style={styles.createButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  /** Full width until contentMax caps it — the Register/Profile pattern. */
  clamp: { width: '100%', alignSelf: 'center' },
  aboutToggle: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginLeft: -8,
  },
  aboutLine: { marginBottom: 8 },
  nameLabel: { marginTop: 12 },
  nameInput: { marginTop: 6, paddingHorizontal: 14 },
  membersRow: {
    marginTop: 20,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  capNote: { marginBottom: 8 },
  candidate: { flexDirection: 'row', alignItems: 'center' },
  candidateName: { flex: 1, marginLeft: 12 },
  seat: {
    width: 24,
    height: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  seatDot: { width: 10, height: 10, borderRadius: 5 },
  identityNote: { marginBottom: 8, marginLeft: 48 },
  noContacts: { marginTop: 12 },
  footer: { paddingTop: 8, paddingBottom: 12 },
  createButton: { marginTop: 8 },
});
