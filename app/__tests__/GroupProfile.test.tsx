/**
 * The room profile.
 *
 * The rules these pin:
 *  - Add and Remove exist for the owner and for NOBODY else, with the ⓘ
 *    explaining who can use them for everyone;
 *  - Leave exists for every member, always;
 *  - Delete room is local and keeps the anchor; Delete for everyone is
 *    owner-only and its confirm carries rule 22's sentence VERBATIM;
 *  - the worst-state summary never reads as all-checked while any member is
 *    unchecked — property-tested over the full state cross-product;
 *  - there is no Hand over, no frozen banner, and no owner-liveness state:
 *    deleted machinery, asserted absent rather than merely unbuilt;
 *  - the honest limits and the block residual are present, verbatim.
 *
 * Harness copied from ChatThread.attach.test.tsx.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { DISAPPEAR_OPTIONS_ROOM } from '../src/blocking';
import * as db from '../src/db';
import { encodeEnvelope } from '../src/envelope';
import { messaging } from '../src/messaging';
import {
  GroupProfileScreen,
  ROOM_COPY,
  ROOM_SAFETY_SUMMARY,
  worstSafetyState,
} from '../src/screens/GroupProfileScreen';
import type { SafetyState } from '../src/safety';
import { themeTokens } from '../src/theme';
import { Avatar } from '../src/ui/Avatar';
import { RoomMark } from '../src/ui/RoomMark';

const theme = themeTokens();

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

const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ANA = ulid('ANA'); // the owner
const BEN = ulid('BEN');
const CARA = ulid('CARA');
const FRAN = ulid('FRAN'); // a 1:1 contact, not in the room

const NUMBER = '1234567890'.repeat(6);

const profileOf = (userId: string) => ({
  userId,
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
});

type Row = Record<string, unknown>;

interface Fixture {
  /** chats rows, which also carry each member's comparison record. */
  chats?: Row[];
  memberSlots?: Row[];
  settingsSlots?: Row[];
}

const DEFAULT_CHATS: Row[] = [
  { peerId: ANA, displayName: 'Ana', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
  { peerId: BEN, displayName: 'Ben', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
  { peerId: CARA, displayName: 'Cara', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
  { peerId: FRAN, displayName: 'Fran', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
  { peerId: ROOM, displayName: null, localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
];

/** The owner's lane holds everyone `in` — the fold every phone computes. */
const DEFAULT_SLOTS: Row[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
  { memberId: CARA, writerId: ANA, seq: 1, state: 'in' },
];

function installRoomDb(fixture: Fixture = {}) {
  const chats = fixture.chats ?? DEFAULT_CHATS;
  const slots = fixture.memberSlots ?? DEFAULT_SLOTS;
  const settings = fixture.settingsSlots ?? [];
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) return { rows: slots };
      if (s.includes('FROM group_settings')) return { rows: settings };
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: chats };
      }
      if (s.includes('FROM chats') && s.includes('WHERE peerId')) {
        return {
          rows: chats.filter(c => c.peerId === params?.[0]),
        };
      }
      if (s.includes('group_counters')) return { rows: [{ seq: 9 }] };
      return base(sql, params);
    },
  );
  return instance;
}

async function renderProfile(
  meId: string,
  props: Partial<React.ComponentProps<typeof GroupProfileScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GroupProfileScreen
        groupId={ROOM}
        me={profileOf(meId)}
        onBack={jest.fn()}
        {...props}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID }).length > 0;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = tree.root.findAll(
    n => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => node.props.onPress());
  await ReactTestRenderer.act(async () => {});
}

/** Every INSERT/DELETE the fake engine saw, flattened for behaviour checks. */
function writesSeen(instance: FakeDb): { sql: string; params: unknown[] }[] {
  return instance.execute.mock.calls.map(([sql, params]) => ({
    sql: String(sql),
    params: (params ?? []) as unknown[],
  }));
}

let spyMsg = 0;
beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(NUMBER);
  // This suite renders against the recorded mock with no messaging session,
  // so the REAL fanOutMembership is replaced by a fake. The fake preserves
  // only the seam's CONTROL FLOW as the screen sees it: gates pass, the
  // local apply runs, a declined apply announces nothing. It does NOT
  // reproduce the seam's writes — the real announcement row is a plain
  // INSERT carrying authorId and sq inside the fan-out transaction, and this
  // fake's db.insertMessage (INSERT OR IGNORE, neither column) once let two
  // assertions here pin the FAKE's SQL as if it were the seam's — so nothing
  // in this file may assert the announcement row's shape. What these tests
  // keep proving is the SCREEN's pure-UI half: rendering, copy, control
  // visibility, and which apply each control runs. Screen-through-seam
  // behaviour (the seq lane, the real row, the legs, the pre-apply failure
  // copy) is proved on the real engine in GroupProfile.send.test.tsx.
  jest
    .spyOn(messaging, 'fanOutMembership')
    .mockImplementation(async (groupId, envelope, opts) => {
      const proceed = opts?.apply ? await opts.apply() : true;
      if (!proceed) return null;
      if (envelope.tcm === 'grp.del') {
        return { localMsgId: null, skipped: [], failed: [] };
      }
      const localMsgId = `FAKE.${++spyMsg}`;
      await db.insertMessage({
        msgId: localMsgId,
        peerId: groupId,
        direction: 'out',
        body: encodeEnvelope(envelope),
        ts: Date.now(),
        status: 'pending',
      });
      return { localMsgId, skipped: [], failed: [] };
    });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

// ---------------------------------------------------------------------------
// Roles: what the owner has, what a member has, and what everyone has.
// ---------------------------------------------------------------------------

test('the owner has Add, Remove and Delete for everyone; Leave and Delete room like anyone', async () => {
  installRoomDb();
  const tree = await renderProfile(ANA);

  expect(has(tree, 'room-add')).toBe(true);
  expect(has(tree, `member-remove-${BEN}`)).toBe(true);
  expect(has(tree, `member-remove-${CARA}`)).toBe(true);
  // Never a Remove on yourself — leaving is the self lane.
  expect(has(tree, `member-remove-${ANA}`)).toBe(false);
  expect(has(tree, 'room-delete-everyone')).toBe(true);
  expect(has(tree, 'room-leave')).toBe(true);
  expect(has(tree, 'room-delete')).toBe(true);
  expect(renderedText(tree)).toContain(ROOM_COPY.youRunIt);
});

test('a non-owner has NO Add, NO Remove, NO Delete for everyone — and the ⓘ explains instead of a control that silently fails', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);

  expect(has(tree, 'room-add')).toBe(false);
  expect(has(tree, `member-remove-${ANA}`)).toBe(false);
  expect(has(tree, `member-remove-${CARA}`)).toBe(false);
  expect(has(tree, 'room-delete-everyone')).toBe(false);
  // Leave is sovereign: every member, always.
  expect(has(tree, 'room-leave')).toBe(true);
  // Delete room is local and everyone's.
  expect(has(tree, 'room-delete')).toBe(true);
  // The owner is NAMED on the roster surface.
  expect(renderedText(tree)).toContain('Ana runs this room.');

  // The honest limit, behind ⓘ, the design — both halves. "Device", not "phone",
  // since the noun pass: the members' hardware is
  // unseen; the rule's substance is verbatim.
  await press(tree, 'room-roster-info');
  const text = renderedText(tree);
  expect(text).toContain(
    'Only the person who runs this room can add or remove people. Anyone can leave whenever they like.',
  );
  expect(text).toContain(
    'Removing someone tells everyone’s device to stop sending to them. It can’t stop their device from sending to yours — blocking is what does that.',
  );
});

test('the members surface says rooms send no read receipts, verbatim', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);
  expect(renderedText(tree)).toContain('Groups don’t send read receipts.');
});

test('a member row opens that member’s own profile — where their safety number lives', async () => {
  installRoomDb();
  const onOpenMember = jest.fn();
  const tree = await renderProfile(BEN, { onOpenMember });
  await press(tree, `member-open-${CARA}`);
  expect(onOpenMember).toHaveBeenCalledWith(CARA);
});

// ---------------------------------------------------------------------------
// The worst-state summary.
// ---------------------------------------------------------------------------

const STATES: readonly SafetyState[] = [
  'changed',
  'mismatched',
  'none',
  'matched',
  'unchecked',
];

test('worstSafetyState over the full cross-product: never all-checked while anyone is unchecked', () => {
  const sets: SafetyState[][] = [];
  for (const a of STATES) {
    sets.push([a]);
    for (const b of STATES) {
      sets.push([a, b]);
      for (const c of STATES) {
        sets.push([a, b, c]);
      }
    }
  }
  for (const states of sets) {
    const worst = worstSafetyState(states);
    // The summary is always one of the members' actual states.
    expect(states).toContain(worst);
    // THE rule: 'matched' is reachable only when EVERY member is matched —
    // in copy terms, the summary can never read as all-checked while any
    // member is unchecked (or worse).
    if (worst === 'matched') {
      expect(states.every(s => s === 'matched')).toBe(true);
    }
    if (states.every(s => s === 'matched')) {
      expect(worst).toBe('matched');
    }
    // The alarming states keep safety.ts's own precedence.
    if (states.includes('changed')) expect(worst).toBe('changed');
    else if (states.includes('mismatched')) expect(worst).toBe('mismatched');
    else if (states.includes('none')) expect(worst).toBe('none');
    else if (states.includes('unchecked')) expect(worst).toBe('unchecked');
  }
});

test('no summary sentence contains the word "verified" — a verified room stays impossible in copy too', () => {
  for (const state of STATES) {
    expect(ROOM_SAFETY_SUMMARY[state].toLowerCase()).not.toContain('verified');
  }
});

test('the rendered summary takes the worst member state: one unchecked member outranks a matched one', async () => {
  // Ben matched, Cara unchecked (number exists, never compared).
  installRoomDb({
    chats: DEFAULT_CHATS.map(c =>
      c.peerId === BEN ? { ...c, safetyCheckedAt: 111 } : c,
    ),
  });
  const tree = await renderProfile(ANA);
  expect(has(tree, 'room-safety-summary-unchecked')).toBe(true);
  expect(has(tree, 'room-safety-summary-matched')).toBe(false);
  const text = renderedText(tree);
  expect(text).toContain(ROOM_SAFETY_SUMMARY.unchecked);
  expect(text).not.toContain(ROOM_SAFETY_SUMMARY.matched);
  // And the per-member states stand beside the summary, not behind it.
  expect(has(tree, `member-state-${BEN}`)).toBe(true);
  expect(has(tree, `member-state-${CARA}`)).toBe(true);
});

test('all-matched is the ONLY way the summary reads as all-checked', async () => {
  installRoomDb({
    chats: DEFAULT_CHATS.map(c =>
      c.peerId === BEN || c.peerId === CARA
        ? { ...c, safetyCheckedAt: 111 }
        : c,
    ),
  });
  const tree = await renderProfile(ANA);
  expect(has(tree, 'room-safety-summary-matched')).toBe(true);
  expect(renderedText(tree)).toContain(ROOM_SAFETY_SUMMARY.matched);
});

// ---------------------------------------------------------------------------
// The deletes and rule 22's confirm.
// ---------------------------------------------------------------------------

test('Delete for everyone confirms with rule 22’s sentence', async () => {
  installRoomDb();
  const tree = await renderProfile(ANA);
  await press(tree, 'room-delete-everyone');
  const body = tree.root.findAll(
    n => n.props?.testID === 'room-delete-everyone-body',
  )[0]!;
  // The sentence itself, pinned letter for letter: it cannot promise more,
  // because someone who already has the messages can keep them. "Device",
  // not "phone", since the noun pass
  // promise is unchanged.
  expect(String(body.props.children)).toBe(
    'Deletes this room from everyone’s device. People keep anything they already saved, and a device that stays offline longer than a month keeps its copy.',
  );
});

test('Delete room is local: the conversation goes, the anchor stays, and the caller is told the room is gone', async () => {
  const instance = installRoomDb();
  const onRoomGone = jest.fn();
  const tree = await renderProfile(BEN, { onRoomGone });
  await press(tree, 'room-delete');
  await press(tree, 'room-delete-confirm');

  const writes = writesSeen(instance);
  expect(
    writes.some(
      w =>
        w.sql.includes('DELETE FROM messages WHERE peerId = ?') &&
        w.params[0] === ROOM,
    ),
  ).toBe(true);
  // The default (local) form leaves the anchor and slots so the room can
  // return on its next message.
  expect(writes.some(w => w.sql.includes('DELETE FROM groups'))).toBe(false);
  expect(onRoomGone).toHaveBeenCalled();
});

test('Delete for everyone runs the counted purge: the anchor goes too', async () => {
  const instance = installRoomDb();
  const onRoomGone = jest.fn();
  const tree = await renderProfile(ANA, { onRoomGone });
  await press(tree, 'room-delete-everyone');
  await press(tree, 'room-delete-everyone-confirm');

  const writes = writesSeen(instance);
  expect(
    writes.some(
      w =>
        w.sql.includes('DELETE FROM groups WHERE groupId = ?') &&
        w.params[0] === ROOM,
    ),
  ).toBe(true);
  expect(onRoomGone).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Leave and Remove run the shared apply layer.
// ---------------------------------------------------------------------------

test('Leave writes my own sovereign out — writer me, member me — through the slot store', async () => {
  const instance = installRoomDb();
  const tree = await renderProfile(BEN);
  await press(tree, 'room-leave');
  await press(tree, 'room-leave-confirm');

  const writes = writesSeen(instance);
  const slotWrite = writes.find(w =>
    w.sql.includes('INSERT OR REPLACE INTO group_members'),
  );
  expect(slotWrite).toBeDefined();
  // (groupId, memberId, writerId, seq, state, updatedAt)
  expect(slotWrite!.params[0]).toBe(ROOM);
  expect(slotWrite!.params[1]).toBe(BEN);
  expect(slotWrite!.params[2]).toBe(BEN);
  expect(slotWrite!.params[4]).toBe('out');
  // The announcement row is deliberately NOT asserted here: this harness's
  // fake writes it through db.insertMessage, whose SQL is nothing like the
  // real seam's (plain INSERT, authorId, sq) — an assertion on it pinned the
  // fake's shape, not the seam's. The real row a screen action writes is
  // read back off the real engine in GroupProfile.send.test.tsx.
});

/** The roster write a Remove produces, or undefined while none has. */
function rosterWrite(instance: FakeDb) {
  return writesSeen(instance).find(w =>
    w.sql.includes('INSERT OR REPLACE INTO group_members'),
  );
}

// Rewritten: Remove used to write on the first tap. It is as social and as
// announced as Leave and both deletes, so it now asks inline the way they
// do — one tap opens the question, the confirm writes, cancel writes
// nothing.
test('the owner’s Remove asks first: one tap writes nothing, the confirm writes the member out on the owner’s lane', async () => {
  const instance = installRoomDb();
  const tree = await renderProfile(ANA);
  await press(tree, `member-remove-${BEN}`);

  // The inline confirm, in the Leave/Delete shape: the question names the
  // person; the body says everyone's device is told and that Add re-invites
  // rather than restores.
  const asked = renderedText(tree);
  expect(asked).toContain(ROOM_COPY.removeConfirmTitle('Ben'));
  expect(asked).toContain(ROOM_COPY.removeConfirmBody);
  expect(has(tree, `member-remove-confirm-${BEN}`)).toBe(true);
  expect(rosterWrite(instance)).toBeUndefined();

  // Cancel closes the question and still writes nothing.
  await press(tree, `member-remove-cancel-${BEN}`);
  expect(has(tree, `member-remove-confirm-${BEN}`)).toBe(false);
  expect(rosterWrite(instance)).toBeUndefined();

  await press(tree, `member-remove-${BEN}`);
  await press(tree, `member-remove-confirm-${BEN}`);
  const slotWrite = rosterWrite(instance);
  expect(slotWrite).toBeDefined();
  expect(slotWrite!.params[1]).toBe(BEN); // member acted on
  expect(slotWrite!.params[2]).toBe(ANA); // the owner's lane
  expect(slotWrite!.params[4]).toBe('out');
});

// ---------------------------------------------------------------------------
// The apply stood but the send did not — the decided failure copy, pinned.
// ---------------------------------------------------------------------------

test('a send that fails AFTER the local apply shows the honest sendFailed line, never the "couldn’t do that" lie', async () => {
  installRoomDb();
  (messaging.fanOutMembership as jest.Mock).mockImplementation(
    async (_g: string, _e: unknown, opts?: { apply?: () => Promise<boolean> }) => {
      await opts?.apply?.(); // the roster changed on this iPhone…
      throw new Error('enqueue refused'); // …and the fan-out then failed
    },
  );
  const tree = await renderProfile(ANA);
  await press(tree, `member-remove-${BEN}`);
  await press(tree, `member-remove-confirm-${BEN}`);

  const text = renderedText(tree);
  expect(text).toContain(ROOM_COPY.sendFailed);
  expect(text).not.toContain(ROOM_COPY.failed);
});

test('Delete for everyone whose send fails after the purge says so — the room is gone HERE, other phones keep it — and still closes the room', async () => {
  installRoomDb();
  const onRoomGone = jest.fn();
  (messaging.fanOutMembership as jest.Mock).mockImplementation(
    async (_g: string, _e: unknown, opts?: { apply?: () => Promise<boolean> }) => {
      await opts?.apply?.(); // the purge ran; the roster no longer exists
      throw new Error('enqueue refused');
    },
  );
  const tree = await renderProfile(ANA, { onRoomGone });
  await press(tree, 'room-delete-everyone');
  await press(tree, 'room-delete-everyone-confirm');

  expect(renderedText(tree)).toContain(ROOM_COPY.deleteSendFailed);
  // The room IS gone from this iPhone — pretending otherwise would be worse.
  expect(onRoomGone).toHaveBeenCalled();
});

test('Add lists only people — not rooms, not members — and writes them in on the owner’s lane', async () => {
  const instance = installRoomDb();
  const tree = await renderProfile(ANA);
  await press(tree, 'room-add');

  // Fran is offered; Ben (already in) and the room's own chat row are not.
  expect(has(tree, `room-add-${FRAN}`)).toBe(true);
  expect(has(tree, `room-add-${BEN}`)).toBe(false);
  expect(has(tree, `room-add-${ROOM}`)).toBe(false);

  await press(tree, `room-add-${FRAN}`);
  const slotWrite = writesSeen(instance).find(w =>
    w.sql.includes('INSERT OR REPLACE INTO group_members'),
  );
  expect(slotWrite).toBeDefined();
  expect(slotWrite!.params[1]).toBe(FRAN);
  expect(slotWrite!.params[2]).toBe(ANA);
  expect(slotWrite!.params[4]).toBe('in');
});

// ---------------------------------------------------------------------------
// The timer and the block residual.
// ---------------------------------------------------------------------------

test('the timer shows the room’s folded minimum while my own chip shows my slot', async () => {
  // Cara constrains to 1 hour; my slot is unset (0 = no constraint), so the
  // room disappears after 1 hour while my selected chip is Off. A screen
  // reading my slot as the status would say "stays until deleted" — false.
  installRoomDb({
    settingsSlots: [{ writerId: CARA, seq: 1, disappearSec: 3600 }],
  });
  const tree = await renderProfile(BEN);
  const text = renderedText(tree);
  expect(text).toContain('Messages here disappear after 1 hour.');
  // The promise, verbatim.
  expect(text).toContain(
    'Anyone in this room can make messages disappear sooner. Nobody can make them last longer for anyone else.',
  );
  const offChip = tree.root.findAll(
    n =>
      n.props?.testID === 'room-timer-0' &&
      n.props?.accessibilityState !== undefined,
  )[0]!;
  expect(offChip.props.accessibilityState.selected).toBe(true);
});

test('choosing a timer writes MY settings slot through the shared apply layer', async () => {
  const instance = installRoomDb();
  const tree = await renderProfile(BEN);
  await press(tree, 'room-timer-3600');

  const writes = writesSeen(instance);
  const slot = writes.find(w =>
    w.sql.includes('INSERT OR REPLACE INTO group_settings'),
  );
  expect(slot).toBeDefined();
  expect(slot!.params[1]).toBe(BEN);
  expect(slot!.params[3]).toBe(3600);
  // The grp.set announcement row is NOT asserted here — the fake's
  // db.insertMessage shape is not the seam's (see the beforeEach note). The
  // real announced row, with authorId and sq, is proved on the real engine
  // in GroupProfile.send.test.tsx.
});

test('the block explainer’s group residual is present, verbatim, behind the ⓘ', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);
  await press(tree, 'room-block-info');
  expect(renderedText(tree)).toContain(
    'A block can’t make you invisible in a shared room. Other people quote you and react to you, and they read their copies.',
  );
});

// ---------------------------------------------------------------------------
// Deleted machinery, asserted absent (simplified deliberately).
// ---------------------------------------------------------------------------

test('no Hand over, no frozen banner, no owner-liveness state — for the owner and for a member', async () => {
  installRoomDb();
  for (const who of [ANA, BEN]) {
    const tree = await renderProfile(who);
    const text = renderedText(tree);
    // Ownership transfer was deleted whole (the grp.owner envelope, the
    // term, the chain, the seal): no surface may offer to hand a room over.
    expect(text).not.toMatch(/hand\s*over|transfer\s+ownership|make\s+owner|new\s+owner/i);
    // The freeze was deleted whole: no frozen state, banner, or copy.
    expect(text).not.toMatch(/frozen|freeze|read-?only room/i);
    // An absent owner is not a state this product models: nothing may claim
    // to know whether the owner is around.
    expect(text).not.toMatch(/last\s+seen|online|offline|inactive|away|active\s+now/i);
    tree.unmount();
  }
});

test('the deleted machinery is absent from the SOURCE, not merely unrendered', () => {
  // A control could hide behind a false conditional and pass the rendered
  // check forever. Strip comments (which legitimately narrate the deletion)
  // and assert the CODE carries none of the deleted vocabulary.
  // `fs`/`__dirname` are untyped here (app/tsconfig.json declares only the
  // jest types) — qr.test.ts's testPath idiom recovers the root.
  const fs = jest.requireActual<{
    readFileSync(path: string, encoding: string): string;
  }>('fs');
  const testPath = expect.getState().testPath ?? '';
  const root = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
  for (const file of [
    `${root}/src/screens/GroupProfileScreen.tsx`,
    `${root}/src/screens/ChatThreadScreen.tsx`,
  ]) {
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(code).not.toMatch(/hand\s?over|handOver/i);
    expect(code).not.toMatch(/frozen|freeze/i);
    expect(code).not.toMatch(/ownerLiveness|ownerAlive|lastSeen|ownerOnline/i);
    // The dead columns died with the machinery: a UI reading a term
    // or a held-write table is the pending apparatus growing back.
    expect(code).not.toMatch(/\bterm\b|group_owners|group_slots_held|held[-_]?write/i);
  }
});

// ---------------------------------------------------------------------------
// the room drawn as a room, and chips that say they are off.
// ---------------------------------------------------------------------------

/** The chip element itself — the composite carrying accessibilityState. */
function chip(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    n => n.props?.testID === testID && n.props?.accessibilityState !== undefined,
  )[0]!;
}

test('the hero is the RoomMark at hero size — a walled square, never a person’s disc', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);
  const mark = tree.root.findByType(RoomMark);
  expect(mark.props.roomId).toBe(ROOM);
  expect(mark.props.name).toBe('Kitchen');
  expect(mark.props.size).toBe(theme.layout.avatar.hero);
  // The discs on this screen are the members'; none of them is the room.
  expect(tree.root.findAllByType(Avatar).map(a => a.props.peerId)).not.toContain(
    ROOM,
  );
});

test('after leaving, the timer chips are disabled for VoiceOver and the eye, and one line says why', async () => {
  // Ben left on his own lane: a self `out` is sovereign over the owner's `in`.
  installRoomDb({
    memberSlots: [
      ...DEFAULT_SLOTS,
      { memberId: BEN, writerId: BEN, seq: 2, state: 'out' },
    ],
  });
  const tree = await renderProfile(BEN);
  expect(has(tree, 'room-left-note')).toBe(true); // the fixture reached `out`

  for (const option of DISAPPEAR_OPTIONS_ROOM) {
    const c = chip(tree, `room-timer-${option.seconds}`);
    expect(c.props.disabled).toBe(true);
    expect(c.props.accessibilityState.disabled).toBe(true);
    // White with its gray edge and muted ink, and the line below says why —
    // never opacity, and never a fill: a chip is white like a row.
    const style = StyleSheet.flatten(c.props.style({ pressed: false }));
    expect(style.backgroundColor).toBe(theme.color.paperSheet);
    expect(style.borderColor).toBe(theme.color.lineSoft);
    const label = c.findByType(Text);
    expect(StyleSheet.flatten(label.props.style).color).toBe(theme.color.inkMuted);
  }
  expect(has(tree, 'room-timer-locked')).toBe(true);
  expect(renderedText(tree)).toContain(ROOM_COPY.timerLeft);
});

test('while in the room the chips are live and the leaving line is absent', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);
  const c = chip(tree, 'room-timer-0');
  expect(c.props.disabled).toBe(false);
  expect(c.props.accessibilityState).toEqual({ selected: true, disabled: false });
  expect(has(tree, 'room-timer-locked')).toBe(false);
  expect(renderedText(tree)).not.toContain(ROOM_COPY.timerLeft);
});

// Build 27: the 1:1 list gained '4 weeks'; a room did NOT, because
// GroupSettingsEnvelope caps `s` at seven days and every shipped client
// refuses 2419200 on a strict parse. This test is the render-side half of
// that split — blocking.disappear.test.ts is the wire-side half.
test('five chips in a room, wrapping, and never a four-week one', async () => {
  installRoomDb();
  const tree = await renderProfile(BEN);

  expect(DISAPPEAR_OPTIONS_ROOM).toHaveLength(5);
  for (const option of DISAPPEAR_OPTIONS_ROOM) {
    expect(chip(tree, `room-timer-${option.seconds}`)).toBeDefined();
  }
  // The one the room wire refuses is not on the screen to press.
  expect(
    tree.root.findAll(n => n.props?.testID === 'room-timer-2419200'),
  ).toHaveLength(0);

  const row = tree.root.find(
    n => n.props?.testID === 'room-timer-row' && typeof n.type === 'string',
  );
  const style = StyleSheet.flatten(row.props.style);
  expect(style.flexDirection).toBe('row');
  // THE CONTRACT: the row wraps, so no type size can push a chip off the edge.
  expect(style.flexWrap).toBe('wrap');
});
