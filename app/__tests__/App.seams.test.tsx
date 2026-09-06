/**
 * The two ordinary verbs, against the real App.
 *
 * Both halves of each seam shipped in build 27 in different commits by
 * different hands: the SCREEN declares an optional prop and renders its
 * control only when the prop arrives, and App.tsx — one file, one owner —
 * passes it. That split is deliberate (a door that is present but does
 * nothing is the same defect as a door that lies about where it goes), and
 * it is also exactly the shape of defect that ships green: every screen
 * unit test passes with the prop supplied by the test itself, and the
 * shipped app hands down nothing. These integration tests exercise that
 * connection instead of relying on screen fixtures.
 *
 * So nothing here is asserted through a prop this test supplies. The app is
 * mounted whole and driven by its own controls:
 *
 * ITEM 7 — the Field Mode line on the home surface is PRESSABLE, and the
 * press lands on Settings. `ChatListScreen` renders the line's onPress,
 * its `accessibilityRole` and its "open Settings" label only when the
 * host passed `onOpenSettings`, so a control with all three IS the seam.
 *
 * ITEM 6 — the Lock now row exists on Settings at all. `SettingsScreen`
 * renders that row only when the host passed `onLockNow`, so its presence
 * IS the seam, and pressing it must run App.tsx's own relock teardown.
 *
 * And both are checked for the second half of their contract, the `from`
 * origin: the way out has to be the way in. Settings entered from the Field
 * Mode line pops to Chats; the same screen entered from Profile pops to
 * Profile. A seam wired as a bare `{ name: 'settings' }` would open the
 * right screen and then strand a person on a Profile they never asked for
 * — which is the drift `backDestination`'s own suite proves the table can
 * express, and this one proves the push sites actually use.
 *
 * Harness: App.callsprofile.test.tsx (the ws mock, the finished-account
 * fixture, the dev route probe) plus ChatList.status.test.tsx's Field Mode
 * fixture (`setWsState` and the four mapped settings).
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { calls } };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import {
  resetCallingForTests,
  setAlwaysRelay,
  setSilenceUnknownCallers,
} from '../src/call';
import * as db from '../src/db';
import { FIELD_VALUES } from '../src/fieldMode';
import { FIELD_MODE_COPY } from '../src/fieldModeCopy';
import { messaging } from '../src/messaging';
import { setPreviewLevel } from '../src/previews';
import { screenSecurity } from '../src/screenSecurity';
import { session } from '../src/session';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

/** A real workspace holding a finished account (App.callsprofile's fixture). */
function seedRealWorkspaceWithProfile(): void {
  const instance: FakeDb = {
    name: 'tacendum.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: USER_ID },
            { key: 'registrationId', value: '7' },
            { key: 'displayName', value: 'Me' },
            { key: 'about', value: '' },
            { key: 'avatarB64', value: '' },
            { key: 'profileVersion', value: '3' },
          ],
        };
      }
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  };
  sqlite.instances.set('tacendum.sqlite', instance);
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

function currentRoute(): string {
  return (globalThis as Record<string, unknown>).TacendumDevRoute as string;
}

/** Every node carrying this testID that also carries a live press handler. */
function pressable(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance[] {
  return tree.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  );
}

async function press(node: ReactTestRenderer.ReactTestInstance): Promise<void> {
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

/** The socket state ChatListScreen reads at mount and at every refresh. */
function setWsState(next: 'open' | 'connecting' | 'closed'): void {
  (messaging as unknown as { wsState: string }).wsState = next;
}

/**
 * Field Mode is DERIVED, never stored, so it is turned on the only way it
 * can be: by putting the four mapped settings at their field values. App
 * Lock is off in this fixture, which is why the auto-lock term is absent —
 * `fieldMode.ts` drops it from the conjunction there.
 */
async function turnFieldModeOn(): Promise<void> {
  await setPreviewLevel(FIELD_VALUES.previewLevel);
  await setAlwaysRelay(FIELD_VALUES.relayEveryCall);
  await setSilenceUnknownCallers(FIELD_VALUES.silenceUnknownCallers);
  await screenSecurity.setBlankEnabled(FIELD_VALUES.blankWhileCaptured);
}

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}));

beforeEach(async () => {
  messaging.stop();
  resetCallingForTests();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'token-for-this-test');
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
  sqlite.reset();
  seedRealWorkspaceWithProfile();
  setWsState('closed');
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  setWsState('closed');
  session.setMode('real');
  await setPreviewLevel('full');
  await setAlwaysRelay(false);
  await setSilenceUnknownCallers(false);
  await screenSecurity.setBlankEnabled(false);
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** chats -> the profile disc -> Profile's Settings row. The other door. */
async function openSettingsFromProfile(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await press(pressable(tree, 'home-profile-door')[0]!);
  expect(currentRoute()).toBe('profile');
  await press(pressable(tree, 'profile-open-settings')[0]!);
  expect(currentRoute()).toBe('settings');
}

describe('item 7 — the Field Mode line is a door (the seventh push site)', () => {
  test('the line on the home surface is pressable, and the press opens Settings', async () => {
    setWsState('open');
    await turnFieldModeOn();
    const tree = await renderApp();
    expect(currentRoute()).toBe('chats');

    // ChatListScreen attaches onPress, accessibilityRole and the action
    // label ONLY when the host passed onOpenSettings, so a line carrying
    // all three is the seam itself and not a prop this test supplied.
    const lines = pressable(tree, 'home-fieldmode');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.props.accessibilityRole).toBe('button');
    expect(lines[0]!.props.accessibilityLabel).toBe(FIELD_MODE_COPY.homeAction);

    await press(lines[0]!);
    expect(currentRoute()).toBe('settings');
  });

  test('and Back from there returns to Chats, because the door carried its origin', async () => {
    // The push site passes `from: 'chats'`. Wired as a bare
    // `{ name: 'settings' }` the screen would still open — and Back would
    // land on a Profile screen the person never asked for.
    setWsState('open');
    await turnFieldModeOn();
    const tree = await renderApp();

    await press(pressable(tree, 'home-fieldmode')[0]!);
    expect(currentRoute()).toBe('settings');

    await press(pressable(tree, 'settings-back')[0]!);
    expect(currentRoute()).toBe('chats');
  });

  test('the SAME screen entered from Profile still pops to Profile — the falsifier', async () => {
    // Without this, a push site hard-coded to 'chats' would pass the test
    // above while breaking the door that always worked.
    setWsState('open');
    const tree = await renderApp();
    await openSettingsFromProfile(tree);

    await press(pressable(tree, 'settings-back')[0]!);
    expect(currentRoute()).toBe('profile');
  });

  test('with Field Mode off there is no line at all, so the door claims nothing', async () => {
    setWsState('open');
    const tree = await renderApp();
    expect(currentRoute()).toBe('chats');
    expect(tree.root.findAll(n => n.props.testID === 'home-fieldmode')).toHaveLength(0);
  });
});

describe('item 6 — Lock now (the App Lock seam)', () => {
  /**
   * The row lives in the lock section's ENABLED arm, which is the only
   * state it could live in: with App Lock off there is no code to come
   * back with, so a Lock now row would be a door out of the app. The
   * fixture therefore boots a locked app and unlocks it the real way
   * (App.relockcall's) rather than faking `session.lockUi` — the round
   * trip below ends where this one began, which is the point.
   */
  async function bootUnlocked(): Promise<ReactTestRenderer.ReactTestRenderer> {
    crypto.__keychain.set('lock.enabled', '1');
    crypto.__keychain.set('lock.passcode', '123456');
    const tree = await renderApp();
    expect(currentRoute()).toBe('locked');
    for (const key of ['1', '2', '3', '4', '5', '6']) {
      await press(pressable(tree, `pin-key-${key}`)[0]!);
    }
    await press(pressable(tree, 'pin-submit')[0]!);
    expect(currentRoute()).toBe('chats');
    return tree;
  }

  test('the row is on the shipped Settings screen, and it runs the real relock', async () => {
    const tree = await bootUnlocked();
    await openSettingsFromProfile(tree);

    // SettingsScreen renders this row ONLY when the host passed onLockNow,
    // so its presence here IS the seam. Presence, not a count: `MenuRow`
    // forwards its testID to the Pressable it renders, so both carry the
    // handler and an exact number here would pin another file's internals.
    // The row's own shape is `Settings.locknow.test.tsx`'s subject.
    const rows = pressable(tree, 'settings-lock-now');
    expect(rows.length).toBeGreaterThan(0);
    // Its note renders with it, so the row is never a bare verb.
    expect(
      tree.root.findAll(n => n.props.testID === 'settings-lock-now-note').length,
    ).toBeGreaterThan(0);

    // THE DISTINCTION this pins: `relock()`, not a bare route change. A row
    // that only moved the route would leave the socket up and the database
    // open behind a lock screen — every byte of the teardown skipped, and
    // nothing on the glass to say so.
    const stop = jest.spyOn(messaging, 'stop');
    await press(rows[0]!);

    expect(stop).toHaveBeenCalled();
    expect(currentRoute()).toBe('locked');
    // And the app is really behind the lock: the code that opened this
    // session is what opens the next one.
    expect(
      tree.root.findAll(n => n.props.testID === 'lock-screen').length,
    ).toBeGreaterThan(0);
  });

  test('with App Lock off the row is absent, and that is the screen, not a missing seam', async () => {
    // Stated so a future reader does not "fix" the gate: the prop is passed
    // in both cases — SettingsScreen is what declines to render a door out
    // of an app that has no code to come back with.
    const tree = await renderApp();
    await openSettingsFromProfile(tree);
    expect(
      tree.root.findAll(n => n.props.testID === 'settings-lock-now'),
    ).toHaveLength(0);
    expect(
      tree.root.findAll(n => n.props.testID === 'settings-lock-enable').length,
    ).toBeGreaterThan(0);
  });
});
