/**
 * ANDROID SYSTEM BACK, SCREEN BY SCREEN.
 *
 * `back.contract.test.ts` proves every screen holding an overlay REGISTERS a
 * `hardwareBackPress` listener. It cannot prove the listener is any good —
 * a handler that always returns `false` satisfies it. This file is the other
 * half: per screen, open the overlay, fire the handler RN would fire, and
 * assert the overlay closed and the press was consumed; then fire it with
 * nothing open and assert it was yielded, so the router still pops.
 *
 * The two assertions are equally load-bearing. Consuming a press with
 * nothing open would trap a person on a screen with no way out on a device
 * whose only global back is this gesture — the failure mode that is worse
 * than the one being fixed.
 *
 * PLATFORM. `BackHandler` is inert on iOS: `addEventListener` returns a
 * subscription nothing ever calls. So the screens register unconditionally —
 * a `Platform.OS === 'android'` guard around the effect would be a branch
 * that buys nothing and can rot — and this suite mounts under a mocked
 * Android platform because Android is where the gesture exists. The
 * registrations themselves are platform-blind, and `back.contract.test.ts`
 * asserts them without any platform mock at all.
 *
 * HOW THE PRESS IS FIRED. `BackHandler.addEventListener` is spied on and
 * every registration recorded in order; `pressBack()` then walks that list
 * the way the platform does — NEWEST subscriber first, stopping at the first
 * `true` (`Libraries/Utilities/BackHandler.android.js`). It would be shorter
 * to call the last registration and be done, and that shortcut is wrong the
 * moment a screen registers more than once or a child component registers at
 * all: React runs a child's effects BEFORE its parent's, so the newest
 * subscriber is the parent, not the child. Modelling the dispatch instead of
 * guessing which entry answers is what keeps this file true as the tree
 * changes under it.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

// The phone surface is build-pinned dark (phoneUi.ts). Its hooks — this
// handler included — run either way, but the overlay it closes is only
// REACHABLE with the pin on, so the suite drives the enabled build, exactly
// as AccountPhoneScreen.test.tsx does.
jest.mock('../src/phoneUi', () => ({ PHONE_UI_ENABLED: true }));
jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
  deleteAccount: jest.fn(),
}));
// ProfileScreen reaches the photo picker through `../src/media`; the pod is
// not in the jest environment and nothing here presses Choose photo.
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { BackHandler } from 'react-native';
import * as db from '../src/db';
import * as lock from '../src/lock';
import { session } from '../src/session';
import { AccountEmailScreen } from '../src/screens/AccountEmailScreen';
import { AccountPhoneScreen } from '../src/screens/AccountPhoneScreen';
import { AccountUsernameScreen } from '../src/screens/AccountUsernameScreen';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { GroupProfileScreen } from '../src/screens/GroupProfileScreen';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { RegisterScreen } from '../src/screens/RegisterScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { messaging } from '../src/messaging';

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

// --------------------------------------------------------------- harness

/** Every `hardwareBackPress` handler registered while a test ran, in order,
 * with the `remove` each was handed. */
let handlers: Array<{ handler: () => boolean; remove: jest.Mock }>;

beforeEach(() => {
  handlers = [];
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, handler) => {
      expect(event).toBe('hardwareBackPress');
      const remove = jest.fn();
      handlers.push({ handler: handler as () => boolean, remove });
      return { remove };
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The platform's dispatch: newest subscriber first, stopping at the first
 * handler that says it consumed the press. */
function dispatch(): boolean {
  expect(handlers.length).toBeGreaterThan(0);
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    if (handlers[i]!.handler()) return true;
  }
  return false;
}

/** Fire the press the way RN does, inside `act` so the state it sets
 * flushes before the next assertion reads the tree. */
async function pressBack(): Promise<boolean> {
  let consumed = false;
  await ReactTestRenderer.act(async () => {
    consumed = dispatch();
  });
  return consumed;
}

async function mount(
  el: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return tree.root.findAllByProps({ testID: id }).length > 0;
}

/** Unmount inside `act`, so the passive-effect cleanup that removes the
 * subscription runs where React expects it to. */
async function unmount(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  const node = tree.root
    .findAllByProps({ testID: id })
    .find(n => typeof n.props.onPress === 'function');
  if (!node) throw new Error(`no pressable node with testID ${id}`);
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
}

// ----------------------------------------------------------- the screens

describe('AccountEmailScreen', () => {
  const VERIFIED: db.AccountIdentifierRow = {
    email: 'ana@example.com',
    verifiedAt: 1_756_000_000_000,
    discoverable: false,
    pendingEmail: null,
    pendingRequestedAt: null,
    restoredAt: null,
  };

  async function render() {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED);
    return mount(<AccountEmailScreen onBack={jest.fn()} />);
  }

  it('closes the unlink question, then the downgrade question, one per press', async () => {
    const tree = await render();

    // Nothing open: the router pops, exactly as it did before this handler.
    expect(await pressBack()).toBe(false);

    // Both questions open at once — they are separate sections of one page,
    // not layers, so this is reachable and the order is a decision.
    await press(tree, 'account-email-unlink');
    await press(tree, 'account-downgrade');
    expect(has(tree, 'account-email-unlink-confirm')).toBe(true);
    expect(has(tree, 'account-downgrade-confirm')).toBe(true);

    // Narrowest first: one address before the whole account.
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'account-email-unlink-confirm')).toBe(false);
    expect(has(tree, 'account-downgrade-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'account-downgrade-confirm')).toBe(false);

    // And back to yielding, so the person can still leave.
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('leaves with the screen', async () => {
    const tree = await render();
    const registration = handlers[handlers.length - 1]!;
    // Inside act: the passive-effect cleanup that removes the subscription
    // is what is being asserted.
    await unmount(tree);
    expect(registration.remove).toHaveBeenCalled();
  });
});

describe('AccountPhoneScreen', () => {
  const VERIFIED: db.PhoneIdentifierRow = {
    phone: '+15555550100',
    verifiedAt: 1_756_000_000_000,
    discoverable: false,
    pendingPhone: null,
    pendingRequestedAt: null,
    restoredAt: null,
  };

  it('closes the unlink question and yields when there is none', async () => {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(VERIFIED);
    const tree = await mount(<AccountPhoneScreen onBack={jest.fn()} />);

    expect(await pressBack()).toBe(false);

    await press(tree, 'account-number-unlink');
    expect(has(tree, 'account-number-unlink-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'account-number-unlink-confirm')).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });
});

describe('AccountUsernameScreen', () => {
  const HELD: db.UsernameIdentifierRow = {
    username: 'ana',
    claimedAt: 1_756_000_000_000,
    discoverable: true,
  };

  /** The screen's first read is a `Promise.all` of five, and only three of
   * them carry their own catch — so the two that do not are answered here,
   * or the whole read rejects and the screen renders as if no name is held. */
  function heldName(): void {
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(HELD);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
  }

  it('closes the unlink question and yields when there is none', async () => {
    heldName();
    const tree = await mount(<AccountUsernameScreen onBack={jest.fn()} />);

    expect(await pressBack()).toBe(false);

    await press(tree, 'account-username-unlink');
    expect(has(tree, 'account-username-unlink-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'account-username-unlink-confirm')).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('does not discard the rename draft: that press still belongs to the router', async () => {
    // The rename FORM holds a typed name and a consent box. Discarding a
    // draft is a different decision from retiring a confirmation, and this
    // handler does not make it — the behaviour is unchanged from before the
    // sweep, and pinned here so the next person changes it on purpose.
    heldName();
    const tree = await mount(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(tree, 'account-username-rename');
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });
});

describe('ChatListScreen', () => {
  const T0 = new Date('2026-07-23T09:00:00').getTime();
  const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
  const PROFILE: db.ProfileRow = {
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    registrationId: 7,
    displayName: '',
    about: '',
    avatarB64: '',
    profileVersion: 0,
  };
  const CHAT = {
    peerId: SAM,
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
  };

  // The fake op-sqlite from jest.setup.js answers by SQL fragment, so the
  // screen exercises the real db module (ChatList.blocking.test.tsx's
  // harness, which is where this row shape comes from).
  beforeEach(async () => {
    await db.close();
    sqlite.reset();
    db.setWorkspace('real');
    await db.initDb();
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(
      async (sql: string, params?: unknown) => {
        const s = String(sql);
        if (s.includes('FROM blocked_peers')) return { rows: [] };
        if (s.includes('FROM chats')) return { rows: [CHAT] };
        return base(s, params);
      },
    );
  });

  afterEach(async () => {
    await db.close();
  });

  async function render() {
    return mount(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
      />,
    );
  }

  it('closes the row drawer, and the question inside it, in one press each way', async () => {
    const tree = await render();

    // Nothing open: the press belongs to the router, which on the home
    // route means leaving the app. Consuming it here would trap a person.
    expect(await pressBack()).toBe(false);

    await press(tree, `chat-more-${SAM}`);
    expect(has(tree, `chat-drawer-${SAM}`)).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, `chat-drawer-${SAM}`)).toBe(false);
    expect(await pressBack()).toBe(false);

    // From the delete question, one press closes the drawer entirely — the
    // same place its own "Keep" goes, not back to the actions row.
    await press(tree, `chat-more-${SAM}`);
    await press(tree, `chat-delete-${SAM}`);
    expect(has(tree, `chat-delete-confirm-${SAM}`)).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, `chat-delete-confirm-${SAM}`)).toBe(false);
    expect(has(tree, `chat-drawer-${SAM}`)).toBe(false);

    await unmount(tree);
  });

  it('closes the block question the same way', async () => {
    const tree = await render();
    await press(tree, `chat-more-${SAM}`);
    await press(tree, `chat-block-${SAM}`);
    expect(has(tree, `chat-block-panel-${SAM}`)).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, `chat-block-panel-${SAM}`)).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });
});

describe('ProfileScreen', () => {
  const PROFILE: db.ProfileRow = {
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    registrationId: 7,
    displayName: 'Ana',
    about: '',
    avatarB64: '',
    profileVersion: 1,
  };

  async function render() {
    return mount(
      <ProfileScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onProfileChanged={jest.fn()}
        onOpenSettings={jest.fn()}
        onSignedOut={jest.fn()}
      />,
    );
  }

  it('cancels the edit form, which is the only exit the header still offers', async () => {
    // While editing, the header's Back is REPLACED by Cancel: the system
    // button is the person's only other way out, and it used to leave the
    // profile altogether.
    const tree = await render();
    expect(await pressBack()).toBe(false);

    await press(tree, 'profile-edit');
    expect(has(tree, 'profile-cancel')).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'profile-cancel')).toBe(false);
    expect(has(tree, 'profile-edit')).toBe(true);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('closes the sign-out question', async () => {
    const tree = await render();
    await press(tree, 'profile-sign-out');
    expect(has(tree, 'profile-sign-out-confirm')).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'profile-sign-out-confirm')).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('refuses the press in the very tick the delete starts', async () => {
    // WHY THE MID-FLIGHT GUARD READS A REF AND NOT THE STATE MIRROR.
    // `confirmSignOut` sets its synchronous latch and only then asks React
    // for a render. A press landing between the two — one tick, and the tick
    // a real thumb can hit — must see the latch. Reading the state mirror
    // instead closes the panel while `deleteAccount` is already running, and
    // the router pops the route out from under it.
    jest
      .spyOn(lock, 'status')
      .mockResolvedValue({ enabled: false, autolockSec: 0 });
    const { deleteAccount } = jest.requireMock('../src/registration') as {
      deleteAccount: jest.Mock;
    };
    deleteAccount.mockImplementation(() => new Promise<void>(() => {}));

    const tree = await render();
    await press(tree, 'profile-sign-out');
    const confirm = tree.root
      .findAllByProps({ testID: 'profile-sign-out-confirm' })
      .find(n => typeof n.props.onPress === 'function');
    if (!confirm) throw new Error('no sign-out confirm');

    let consumed = false;
    await ReactTestRenderer.act(async () => {
      confirm.props.onPress();
      consumed = dispatch();
    });

    expect(deleteAccount).toHaveBeenCalled();
    expect(consumed).toBe(true);
    expect(has(tree, 'profile-sign-out-confirm')).toBe(true);
    await unmount(tree);
    deleteAccount.mockReset();
  });
});

describe('SettingsScreen', () => {
  beforeEach(() => {
    keychain.clear();
    session.setMode('real');
  });

  async function render() {
    return mount(
      <SettingsScreen
        onBack={jest.fn()}
        onOpenLinkedDevices={jest.fn()}
        onOpenAccountEmail={jest.fn()}
      />,
    );
  }

  it('returns the App Lock ceremony to its menu instead of discarding it', async () => {
    // THE WORST CASE THIS SWEEP CLOSES. One digit into a new passcode, the
    // press that means "undo this step" used to pop the route and land the
    // person on Profile with the whole ceremony gone.
    const tree = await render();
    expect(await pressBack()).toBe(false);

    await press(tree, 'settings-lock-enable');
    await press(tree, 'pin-key-1');
    expect(has(tree, 'settings-pin-cancel')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'settings-pin-cancel')).toBe(false);
    expect(has(tree, 'settings-lock-enable')).toBe(true);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('returns the licences page to the menu, the way its own Done does', async () => {
    const tree = await render();
    await press(tree, 'settings-licenses');
    expect(has(tree, 'settings-licenses-body')).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'settings-licenses-body')).toBe(false);
    expect(has(tree, 'settings-licenses')).toBe(true);
    await unmount(tree);
  });
});

describe('PeerProfileScreen', () => {
  const T0 = new Date('2026-07-23T09:00:00').getTime();
  const PEER = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
  /** Twelve five-digit groups, so the safety section has a real state. */
  const SAFETY = '4'.repeat(60);
  const ME: db.ProfileRow = {
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    registrationId: 7,
    displayName: 'Nat',
    about: '',
    avatarB64: '',
    profileVersion: 1,
  };
  const CHAT = {
    peerId: PEER,
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
  };

  // PeerProfile.blocking.test.tsx's harness: the fake engine answers by SQL
  // fragment, so the screen runs the real db module.
  beforeEach(async () => {
    await db.close();
    sqlite.reset();
    db.setWorkspace('real');
    await db.initDb();
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(
      async (sql: string, params?: unknown) => {
        const s = String(sql);
        if (s.includes('FROM blocked_peers')) return { rows: [] };
        if (s.includes('FROM chats')) return { rows: [CHAT] };
        return base(s, params);
      },
    );
    jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(SAFETY);
    jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  });

  afterEach(async () => {
    await db.close();
  });

  async function render() {
    return mount(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={jest.fn()} />,
    );
  }

  it('closes the safety question, then the block question, one per press', async () => {
    const tree = await render();
    expect(await pressBack()).toBe(false);

    // Both stand open at once — separate sections of one page, not layers.
    await press(tree, 'peer-safety-mark');
    await press(tree, 'peer-block');
    expect(has(tree, 'peer-safety-cancel')).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    // Narrowest first: one comparison before the whole relationship.
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-safety-cancel')).toBe(false);
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('swallows the press while the block is being written, as its own Cancel does', async () => {
    // Both visible exits on this screen — `peer-safety-cancel` and
    // `peer-block-cancel` — are `disabled={busy}`, and `busy` covers the real
    // network write. The system button has to refuse the same way
    //: yielding here would pop the
    // route out from under a block that is still running, with no in-flight
    // indicator anywhere outside the panel that just vanished.
    let settle!: () => void;
    jest.spyOn(messaging, 'blockPeer').mockReturnValue(
      new Promise<void>(resolve => {
        settle = resolve;
      }),
    );
    const tree = await render();
    await press(tree, 'peer-block');
    await press(tree, 'peer-block-confirm');
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    await ReactTestRenderer.act(async () => {
      settle();
    });
    await unmount(tree);
  });

  it('closes the report chooser, which lives in a section of its own', async () => {
    // `step` in `ReportSection` also needs to close on Back.
    // It is the state of a SIBLING component, so the screen's single listener
    // cannot read it: the section hands the screen a closer instead.
    const tree = await render();
    expect(await pressBack()).toBe(false);

    await press(tree, 'peer-report-start');
    expect(has(tree, 'peer-report-cancel')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-report-cancel')).toBe(false);
    expect(has(tree, 'peer-report-start')).toBe(true);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('closes the machine question the same way', async () => {
    const tree = await render();

    await press(tree, 'peer-machine-adopt');
    expect(has(tree, 'peer-machine-cancel')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-machine-cancel')).toBe(false);
    expect(has(tree, 'peer-machine-adopt')).toBe(true);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('retires the section question before the one about the whole relationship', async () => {
    // ONE listener is what makes this an ordering decision rather than an
    // accident of mount order: with two registrations the press would reach
    // whichever component happened to subscribe last.
    const tree = await render();
    await press(tree, 'peer-report-start');
    await press(tree, 'peer-block');
    expect(has(tree, 'peer-report-cancel')).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-report-cancel')).toBe(false);
    expect(has(tree, 'peer-block-confirm')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(false);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });
});

describe('GroupProfileScreen', () => {
  const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
  const ROOM = ulid('R00MK7CHN');
  const ANA = ulid('ANA');
  const BEN = ulid('BEN');
  const NUMBER = '1234567890'.repeat(6);

  const chats = [
    { peerId: ANA, displayName: 'Ana', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
    { peerId: BEN, displayName: 'Ben', localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
    { peerId: ROOM, displayName: null, localName: null, safetyCheckedAt: null, safetyMismatchAt: null },
  ];
  const slots = [
    { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
    { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
  ];

  // GroupProfile.test.tsx's harness, trimmed to the reads this screen makes
  // before anything is pressed.
  beforeEach(async () => {
    await db.close();
    sqlite.reset();
    db.setWorkspace('real');
    await db.initDb();
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
        if (s.includes('FROM group_settings')) return { rows: [] };
        if (s.includes('FROM chats') && s.includes('ORDER BY')) {
          return { rows: chats };
        }
        if (s.includes('FROM chats') && s.includes('WHERE peerId')) {
          return { rows: chats.filter(c => c.peerId === params?.[0]) };
        }
        if (s.includes('group_counters')) return { rows: [{ seq: 9 }] };
        return base(sql, params);
      },
    );
    jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(NUMBER);
  });

  afterEach(async () => {
    await db.close();
  });

  const profileOf = (userId: string): db.ProfileRow => ({
    userId,
    registrationId: 7,
    displayName: '',
    about: '',
    avatarB64: '',
    profileVersion: 0,
  });

  it('closes the leave question and yields when there is none', async () => {
    // BEN is not the owner, so Leave is the question on offer to him.
    const tree = await mount(
      <GroupProfileScreen
        groupId={ROOM}
        me={profileOf(BEN)}
        onBack={jest.fn()}
      />,
    );
    expect(await pressBack()).toBe(false);

    await press(tree, 'room-leave');
    expect(has(tree, 'room-leave-confirm')).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'room-leave-confirm')).toBe(false);
    expect(has(tree, 'room-leave')).toBe(true);
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });

  it('closes the local-delete question the same way', async () => {
    const tree = await mount(
      <GroupProfileScreen
        groupId={ROOM}
        me={profileOf(BEN)}
        onBack={jest.fn()}
      />,
    );
    await press(tree, 'room-delete');
    expect(has(tree, 'room-delete-confirm')).toBe(true);
    expect(await pressBack()).toBe(true);
    expect(has(tree, 'room-delete-confirm')).toBe(false);
    await unmount(tree);
  });
});

describe('RegisterScreen — the amendment, not a ninth registration', () => {
  // This screen already answered the press: it refused while the create call
  // was in flight and yielded otherwise, which meant the consent
  // sheet — a hovering surface with a scrim and a "Not yet" of its own — was
  // one of the overlays back popped straight through, to the landing screen.
  // The existing handler grows the case it lacked.
  async function render() {
    return mount(
      <RegisterScreen onRegistered={jest.fn()} onBack={jest.fn()} />,
    );
  }

  it('dismisses the consent sheet instead of leaving for the landing screen', async () => {
    const tree = await render();
    expect(await pressBack()).toBe(false);

    await press(tree, 'register-consent');
    await press(tree, 'create-identity');
    expect(has(tree, 'register-sheet')).toBe(true);

    expect(await pressBack()).toBe(true);
    expect(has(tree, 'register-sheet')).toBe(false);
    // The consent is not undone by walking out of the sheet — the checkbox
    // stays ticked, which is what "Not yet" has always done.
    expect(await pressBack()).toBe(false);
    await unmount(tree);
  });
});
