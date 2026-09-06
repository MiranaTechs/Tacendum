/**
 * The list stops saying things that are not news.
 *
 * Three small dishonesties on the first screen a person sees:
 *
 * 1. `Connected` was permanent furniture under the title. A status line
 * that is right 99 % of the time teaches people not to read it — which
 * is exactly wrong for the 1 % where it says Offline. The mark and the
 * word now appear only while connecting or closed, and the WRAPPER
 * stays mounted with its `ws-<state>` testID as a stable test hook,
 * painting nothing while open.
 * 2. `stepTwo` named the second-best rail: the + screen
 * LEADS with scanning a code and demotes the typed field.
 * 3. `actionsHint` began "Later," — a dangle about a future state of a
 * screen being read now — and named a fixed pair of actions the drawer
 * no longer holds alone.
 *
 * The copy is asserted by IDENTITY, the house deck rule: a sentence retyped
 * slightly differently in a test is a sentence that has quietly diverged.
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { setAlwaysRelay, setSilenceUnknownCallers } from '../src/call';
import * as db from '../src/db';
import { FIELD_VALUES } from '../src/fieldMode';
import { FIELD_MODE_COPY } from '../src/fieldModeCopy';
import { messaging } from '../src/messaging';
import { setPreviewLevel } from '../src/previews';
import { screenSecurity } from '../src/screenSecurity';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { session } from '../src/session';

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
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const T0 = new Date('2026-09-01T09:00:00').getTime();
const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';

const PROFILE: db.ProfileRow = {
  userId: '01STADBSSDJSPC9J0E5N2AWMJ5',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

function chatRow(peerId: string) {
  return {
    peerId,
    displayName: 'Sam',
    lastMessageAt: T0,
    lastMessageText: 'see you',
    about: null,
    avatarB64: null,
    profileVersion: null,
    safetyCheckedAt: null,
    localName: null,
    createdAt: T0,
    lastOpenedAt: null,
    identityChangedAt: null,
    safetyMismatchAt: null,
    pinnedAt: null,
  };
}

const state = { chats: [chatRow(SAM)] as ReturnType<typeof chatRow>[] };

/** The socket state the screen reads at every refresh. */
function setWsState(next: 'open' | 'connecting' | 'closed'): void {
  (messaging as unknown as { wsState: string }).wsState = next;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  state.chats = [chatRow(SAM)];
  keychain.set('lockNudge.dismissed', '1');

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM chats ORDER BY')) return { rows: state.chats };
    return base(s, params);
  });
});

afterEach(async () => {
  setWsState('closed');
  session.setMode('real');
  await setPreviewLevel('full');
  await setAlwaysRelay(false);
  await setSilenceUnknownCallers(false);
  await screenSecurity.setBlankEnabled(false);
  keychain.clear();
  jest.restoreAllMocks();
  await db.close();
});

async function renderList(
  props: { onOpenSettings?: () => void } = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
        {...(props.onOpenSettings
          ? { onOpenSettings: props.onOpenSettings }
          : {})}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** Put the four mapped rows where Field Mode's conjunction wants them. */
async function turnFieldModeOn(): Promise<void> {
  await setPreviewLevel(FIELD_VALUES.previewLevel);
  await setAlwaysRelay(FIELD_VALUES.relayEveryCall);
  await setSilenceUnknownCallers(FIELD_VALUES.silenceUnknownCallers);
  await screenSecurity.setBlankEnabled(FIELD_VALUES.blankWhileCaptured);
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n => {
      const kids = n.props.children;
      return Array.isArray(kids)
        ? kids.map((c: unknown) => (typeof c === 'string' ? c : '')).join('')
        : typeof kids === 'string'
          ? kids
          : '';
    })
    .join('\n');
}

describe('the connection line speaks only when something is wrong', () => {
  test('open: the wrapper and its testID stay, and paint nothing', async () => {
    setWsState('open');
    const tree = await renderList();

    // The test hook survives: a test that keys on
    // ws-<state> still finds the node.
    const wrapper = byId(tree, 'ws-open');
    expect(wrapper.length).toBeGreaterThan(0);
    // Empty, and out of the way of assistive tech — there is no fact here.
    expect(wrapper[0]!.props.accessibilityElementsHidden).toBe(true);
    expect(texts(tree)).not.toContain('Connected');
    // The mark goes with the word: colour alone was never allowed to carry
    // this, and an unexplained pine dot is colour alone.
    expect(byId(tree, 'ws-mark').length).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('connecting and closed both speak, mark and word together', async () => {
    setWsState('connecting');
    const connecting = await renderList();
    expect(byId(connecting, 'ws-connecting').length).toBeGreaterThan(0);
    expect(texts(connecting)).toContain('Connecting…');
    expect(byId(connecting, 'ws-mark').length).toBeGreaterThan(0);
    await ReactTestRenderer.act(() => connecting.unmount());

    setWsState('closed');
    const closed = await renderList();
    expect(byId(closed, 'ws-closed').length).toBeGreaterThan(0);
    // The named consequence, not the state: nothing typed is lost.
    expect(texts(closed)).toContain('Offline — sends when you reconnect');
    expect(byId(closed, 'ws-mark').length).toBeGreaterThan(0);
    await ReactTestRenderer.act(() => closed.unmount());
  });
});

describe('the empty home teaches the flow that actually ships', () => {
  test('step two leads with the camera, and the hint stops dangling', async () => {
    state.chats = [];
    const tree = await renderList();

    // By identity — the house COPY-deck rule.
    expect(texts(tree)).toContain('Tap + to scan their code, or type their ID.');
    expect(texts(tree)).toContain(
      'The … beside a chat holds what you can do with it.',
    );

    // The two sentences that were wrong are gone, verbatim.
    expect(texts(tree)).not.toContain('Tap +, then enter theirs.');
    expect(texts(tree)).not.toContain('Later, the …');

    // Scanning is named before typing, so a future reordering of the +
    // screen breaks a test rather than the teaching.
    const step = texts(tree);
    expect(step.indexOf('scan their code')).toBeLessThan(
      step.indexOf('type their ID'),
    );
    // The hint no longer names a fixed pair of actions the drawer has since
    // outgrown.
    expect(texts(tree)).not.toContain('holds Block and Delete');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('step one is untouched', async () => {
    state.chats = [];
    const tree = await renderList();
    expect(texts(tree)).toContain('Send someone your ID.');
    await ReactTestRenderer.act(() => tree.unmount());
  });
});

/**
 * Field Mode, where a person can actually see it.
 *
 * Before this the word `fieldMode` appeared in exactly three files — the
 * module, its deck and the Settings screen. A setting somebody turned on
 * before walking somewhere, and then cannot find, is a setting they are
 * carrying blind.
 *
 * The precedence is the point, and each arm has its own case: a connection
 * problem outranks everything, then Field Mode, then nothing at all. The
 * line is in-app, carries the feature's own name and no protective
 * adjective, and reads Off in a coerced session by the same derivation the
 * Settings chip uses.
 */
describe('the Field Mode line on the home surface', () => {
  test('open and active: a pressable line into Settings', async () => {
    setWsState('open');
    await turnFieldModeOn();
    const onOpenSettings = jest.fn();
    const tree = await renderList({ onOpenSettings });

    const line = tree.root.find(
      n =>
        n.props.testID === 'home-fieldmode' &&
        typeof n.props.onPress === 'function',
    );
    expect(line.props.accessibilityRole).toBe('button');
    expect(line.props.accessibilityLabel).toBe(FIELD_MODE_COPY.homeAction);
    expect(texts(tree)).toContain(FIELD_MODE_COPY.homeLabel);
    // The feature's own name and nothing else: no protective adjective.
    expect(texts(tree)).not.toMatch(/protect|secure|safe|panic|emergency/i);

    await ReactTestRenderer.act(async () => {
      line.props.onPress();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a connection problem outranks it', async () => {
    setWsState('closed');
    await turnFieldModeOn();
    const tree = await renderList({ onOpenSettings: jest.fn() });

    expect(byId(tree, 'home-fieldmode').length).toBe(0);
    expect(texts(tree)).toContain('Offline — sends when you reconnect');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('open and inactive: the wrapper stays empty', async () => {
    setWsState('open');
    const tree = await renderList({ onOpenSettings: jest.fn() });
    expect(byId(tree, 'home-fieldmode').length).toBe(0);
    expect(byId(tree, 'ws-open').length).toBeGreaterThan(0);
    expect(texts(tree)).not.toContain(FIELD_MODE_COPY.homeLabel);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a duress session reads Off, so the line is not there either', async () => {
    setWsState('open');
    await turnFieldModeOn();
    // The decoy opens with the mapped rows back at their defaults, which is
    // what makes the derivation answer Off — the same answer the Settings
    // chip gives at the same moment. No new fact, so no discriminator.
    session.setMode('duress');
    await setPreviewLevel('full');
    await setAlwaysRelay(false);
    await setSilenceUnknownCallers(false);
    await screenSecurity.setBlankEnabled(false);

    const tree = await renderList({ onOpenSettings: jest.fn() });
    expect(byId(tree, 'home-fieldmode').length).toBe(0);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('with no route wired the words still show, and nothing claims a door', async () => {
    // The LockNudge precedent: no control may promise a route this screen
    // was not given.
    setWsState('open');
    await turnFieldModeOn();
    const tree = await renderList();

    expect(texts(tree)).toContain(FIELD_MODE_COPY.homeLabel);
    expect(
      tree.root.findAll(
        n =>
          n.props.testID === 'home-fieldmode' &&
          typeof n.props.onPress === 'function',
      ).length,
    ).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
