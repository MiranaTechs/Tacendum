/**
 * The room header's call buttons.
 *
 * Until this phase the gate here was `onStartCall && !isRoom`: a room offered
 * no call at all, because a button that dialled a room id would 404. A
 * small-group call dials the folded roster's LEGS instead, so the gate becomes
 * room-aware — and the two rules that replace it are the ones asserted below.
 *
 *  1. A room that FITS dials its folded roster, this device excluded. Never
 *     the room id, never a slot list.
 *  2. A room that does NOT fit opens the picker. The design is a refusal to choose
 *     people on someone's behalf, so "dial the first five" is the falsifying
 *     case, not the fallback.
 *
 * A third rule arrived with the launch cut ("v1 scope, cut to
 * the launch date"): group calls ship AUDIO ONLY. The mesh
 * video surface is cut to 1.1, so a room's header offers no video button at
 * all — the only cap it ever asks is audio's. The 1:1 thread, whose video is
 * real, keeps both buttons.
 *
 * Harness copied from ChatThread.room.test.tsx.
 */

import { foldRoster, type RosterSlot } from '@tacendum/shared/group-fold';
import {
  SMALL_GROUP_CALL_MAX_PARTICIPANTS,
  SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS,
} from '@tacendum/shared';
import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { shortId } from '../src/person';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { CALL_CAP_COPY } from '../src/screens/GroupCallScreen';
import { UNNAMED } from '../src/ui/CallTile';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ME = ulid('ME1');
const OWNER = ulid('ANA');
const PEER = ulid('PEER1');

/** Twelve names, so a room can be built at any size up to the room cap. */
const MEMBERS = [
  'BEN',
  'CARA',
  'DEE',
  'EVE',
  'FAY',
  'GEM',
  'HAN',
  'JAY',
  'KAT',
  'MAX',
  'NAT',
].map(ulid);
const NAME_OF = new Map<string, string>([
  [OWNER, 'Ana'],
  [PEER, 'Pia'],
  ...MEMBERS.map((id, i) => [id, `M${i}`] as [string, string]),
]);

/** A room whose folded roster is the owner, this device, and `extra` others. */
function roster(extra: number): { members: string[]; slots: RosterSlot[] } {
  const others = MEMBERS.slice(0, extra);
  const slots: RosterSlot[] = [
    { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
    { memberId: ME, writerId: OWNER, seq: 1, state: 'in' },
    ...others.map((id, i) => ({
      memberId: id,
      writerId: OWNER,
      seq: i + 2,
      state: 'in' as const,
    })),
    // One member admitted and then gone by their own sovereign write, so a
    // naive slot count and the fold's answer differ. A call placed against
    // the slot list would ring somebody who left.
    { memberId: ulid('ZED'), writerId: OWNER, seq: 99, state: 'in' },
    { memberId: ulid('ZED'), writerId: ulid('ZED'), seq: 1, state: 'out' },
  ];
  return { members: [...foldRoster(OWNER, slots).members], slots };
}

function installDb(opts: { room: boolean; slots?: RosterSlot[] }) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('FROM messages')) return { rows: [] };
    if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
      return opts.room && params?.[0] === ROOM
        ? { rows: [{ groupId: ROOM, ownerId: OWNER, name: 'Kitchen' }] }
        : { rows: [] };
    }
    if (s.includes('FROM group_members')) {
      return params?.[0] === ROOM ? { rows: opts.slots ?? [] } : { rows: [] };
    }
    if (s.includes('FROM chats') && s.includes('ORDER BY')) {
      return {
        rows: [...NAME_OF].map(([peerId, displayName]) => ({
          peerId,
          displayName,
          localName: null,
        })),
      };
    }
    if (s.includes('FROM profile')) {
      return {
        rows: [
          { key: 'userId', value: ME },
          { key: 'registrationId', value: '7' },
        ],
      };
    }
    return base(sql, params);
  });
}

async function renderThread(
  props: Partial<React.ComponentProps<typeof ChatThreadScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={ROOM}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        {...props}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

const press = (tree: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  ReactTestRenderer.act(() => {
    tree.root.findByProps({ testID }).props.onPress();
  });

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll(n => n.props.testID === testID).length > 0;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

describe('a room that fits in a call', () => {
  it('dials the FOLDED roster, this device excluded', async () => {
    const { members, slots } = roster(1);
    installDb({ room: true, slots });
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ onStartRoomCall });

    await press(tree, 'start-call-audio');

    expect(onStartRoomCall).toHaveBeenCalledTimes(1);
    const [others, kind] = onStartRoomCall.mock.calls[0]!;
    expect(kind).toBe('audio');
    // The fold's members, minus me — never the room id, and never the member
    // whose own `out` write left the slot list.
    expect([...others].sort()).toEqual(members.filter(id => id !== ME).sort());
    expect(others).not.toContain(ME);
    expect(others).not.toContain(ROOM);
    expect(others).not.toContain(ulid('ZED'));
  });

  it('offers NO video affordance in a room — audio is the only call a room can start', async () => {
    // THE APP REVIEW TEST. Group calls ship audio-only at v1: the mesh
    // video surface is cut to 1.1 ("v1 scope, cut to the
    // launch date"), so a room's video button would connect an
    // AUDIO call behind a camera glyph — a false capability claim made in a
    // button rather than a sentence, and the first thing a reviewer taps.
    // What this prevents: the room header quietly regrowing its second
    // button before mesh video actually draws a frame.
    //
    // FALSIFYING CASE: restore the video entry to the room header's array.
    // The button renders, and the room once again promises a picture it
    // cannot draw.
    installDb({ room: true, slots: roster(1).slots });
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ onStartRoomCall });

    // No video button and no video label, in a room that IS offered a call.
    expect(has(tree, 'start-call')).toBe(false);
    expect(
      tree.root.findAll(n =>
        String(n.props.accessibilityLabel ?? '').startsWith('Video call'),
      ),
    ).toHaveLength(0);
    // And the audio button still works, under its stable id, carrying its
    // kind through to the caller.
    await press(tree, 'start-call-audio');
    expect(onStartRoomCall).toHaveBeenCalledTimes(1);
    expect(onStartRoomCall.mock.calls[0]![1]).toBe('audio');
  });

  it('offers nothing when the caller wired nothing', async () => {
    // The onStartCall doctrine, unchanged: not offered beats does-nothing.
    installDb({ room: true, slots: roster(1).slots });
    const tree = await renderThread({});
    expect(has(tree, 'start-call')).toBe(false);
    expect(has(tree, 'start-call-audio')).toBe(false);
  });

  it('offers nothing until the roster has actually been folded', async () => {
    // An empty fold is a room this phone has not read. Dialling it would
    // place a call with no legs at all.
    installDb({ room: true, slots: [] });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    expect(has(tree, 'start-call-audio')).toBe(false);
  });
});

describe('a room bigger than a call', () => {
  it('opens the picker instead of dialling everyone', async () => {
    // The scripted-verify case: a twelve-member room's call button opens the
    // picker, never a twelve-way dial.
    const { members, slots } = roster(10);
    expect(members.length).toBeGreaterThan(SMALL_GROUP_CALL_MAX_PARTICIPANTS);
    installDb({ room: true, slots });
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ onStartRoomCall });

    await press(tree, 'start-call-audio');

    expect(onStartRoomCall).not.toHaveBeenCalled();
    expect(has(tree, 'call-picker')).toBe(true);
  });

  it('states the picker copy, verbatim, when the picker fills', async () => {
    const { slots } = roster(10);
    installDb({ room: true, slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    await press(tree, 'start-call-audio');

    // Five others fill an audio call of six.
    for (const id of MEMBERS.slice(0, SMALL_GROUP_CALL_MAX_PARTICIPANTS - 1)) {
      await press(tree, `call-picker-row-${id}`);
    }
    expect(renderedText(tree)).toContain(CALL_CAP_COPY);
    // A sixth other is refused rather than accepted and dropped.
    const extra = tree.root.findByProps({
      testID: `call-picker-row-${MEMBERS[SMALL_GROUP_CALL_MAX_PARTICIPANTS - 1]}`,
    });
    expect(extra.props.accessibilityState.disabled).toBe(true);
    expect(extra.props.accessibilityHint).toBe(CALL_CAP_COPY);
  });

  it('counts the seat this device occupies', async () => {
    // "5 of 6, including you" — the GroupCreateScreen lesson. A counter that
    // omitted this device would offer one seat too many.
    const { slots } = roster(10);
    installDb({ room: true, slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    await press(tree, 'start-call-audio');
    expect(renderedText(tree)).toContain(`1 of ${SMALL_GROUP_CALL_MAX_PARTICIPANTS}, including you`);
    await press(tree, `call-picker-row-${MEMBERS[0]}`);
    expect(renderedText(tree)).toContain(`2 of ${SMALL_GROUP_CALL_MAX_PARTICIPANTS}, including you`);
  });

  it('calls exactly the people who were picked', async () => {
    const { slots } = roster(10);
    installDb({ room: true, slots });
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ onStartRoomCall });
    await press(tree, 'start-call-audio');
    await press(tree, `call-picker-row-${MEMBERS[0]}`);
    await press(tree, `call-picker-row-${MEMBERS[3]}`);
    await press(tree, 'call-picker-start');

    expect(onStartRoomCall).toHaveBeenCalledWith([MEMBERS[0], MEMBERS[3]], 'audio');
    // The panel closes behind the call it started.
    expect(has(tree, 'call-picker')).toBe(false);
  });

  it('renders no room id and no member id in the picker', async () => {
    const { slots } = roster(10);
    installDb({ room: true, slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    await press(tree, 'start-call-audio');
    const text = renderedText(tree);
    expect(text).not.toContain(ROOM);
    for (const id of MEMBERS) expect(text).not.toContain(id);
    expect(text).toContain('M0');
  });

  it('renders the placeholder for a member this phone has no name for', async () => {
    // The thread's `nameFor` degrades to `personName`, whose own fallback is
    // the id FRAGMENT — honest in a chat list, forbidden on a call surface.
    // A room can hold someone this device has never chatted with, so the
    // fragment is not a hypothetical: it is what the picker showed.
    //
    // FALSIFYING CASE: render the candidate's name raw. "…RVN7X4Q" appears in
    // the list of who to call, and it is nobody's name.
    const STRANGER = ('0'.repeat(26) + 'RVN7X4Q').slice(-26);
    const { slots } = roster(10);
    installDb({
      room: true,
      slots: [...slots, { memberId: STRANGER, writerId: OWNER, seq: 2, state: 'in' }],
    });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    await press(tree, 'start-call-audio');

    const row = tree.root.findAll(
      n => n.props.testID === `call-picker-row-${STRANGER}`,
    );
    expect(row.length).toBeGreaterThan(0);
    for (const node of row) expect(node.props.accessibilityLabel).toBe(UNNAMED);
    const text = renderedText(tree);
    expect(text).toContain(UNNAMED);
    expect(text).not.toContain(STRANGER);
    expect(text).not.toContain(shortId(STRANGER));
    expect(text).not.toContain('RVN7X4Q');
    // The named rows are untouched: this is a rule, not a blanket.
    expect(text).toContain('M0');
  });
});

describe('the cap the room asks is AUDIO’s cap', () => {
  it('dials a full AUDIO call directly — six fits six', async () => {
    // A six-person room: audio holds six, video would hold five. The audio
    // button must ask the AUDIO cap — a header that minted a single number
    // from the stricter video arithmetic would open the picker for a call
    // that fits, which is what makes this the falsifying case.
    const { members, slots } = roster(SMALL_GROUP_CALL_MAX_PARTICIPANTS - 2);
    expect(members).toHaveLength(SMALL_GROUP_CALL_MAX_PARTICIPANTS);
    expect(members.length).toBeGreaterThan(SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS);
    installDb({ room: true, slots });
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ onStartRoomCall });

    await press(tree, 'start-call-audio');
    expect(onStartRoomCall).toHaveBeenCalledTimes(1);
    expect(has(tree, 'call-picker')).toBe(false);
    // The video half of the old per-kind pair is gone with the button: a
    // six-person room offers no video affordance to warn on at all.
    expect(has(tree, 'start-call')).toBe(false);
  });

  it('warns on the audio button before it is pressed, only past audio’s cap', async () => {
    // roster(10) folds to twelve — past even audio's six — so the hint says
    // what the press will do (open the picker) before it is pressed.
    const { slots } = roster(10);
    installDb({ room: true, slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    expect(
      tree.root.findByProps({ testID: 'start-call-audio' }).props.accessibilityHint,
    ).toBe(CALL_CAP_COPY);
  });

  it('carries no warning when the room fits its call', async () => {
    const { slots } = roster(SMALL_GROUP_CALL_MAX_PARTICIPANTS - 2);
    installDb({ room: true, slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    expect(
      tree.root.findByProps({ testID: 'start-call-audio' }).props.accessibilityHint,
    ).toBeUndefined();
  });
});

describe('the 1:1 thread is untouched', () => {
  it('still places a 1:1 call through onStartCall', async () => {
    installDb({ room: false });
    const onStartCall = jest.fn();
    const onStartRoomCall = jest.fn();
    const tree = await renderThread({ peerId: PEER, onStartCall, onStartRoomCall });
    await press(tree, 'start-call');
    expect(onStartCall).toHaveBeenCalledWith('video');
    expect(onStartRoomCall).not.toHaveBeenCalled();
    expect(has(tree, 'call-picker')).toBe(false);
  });

  it('still names the room in the room header’s call label', async () => {
    installDb({ room: true, slots: roster(1).slots });
    const tree = await renderThread({ onStartRoomCall: jest.fn() });
    expect(
      tree.root.findByProps({ testID: 'start-call-audio' }).props.accessibilityLabel,
    ).toBe('Call Kitchen');
  });
});
