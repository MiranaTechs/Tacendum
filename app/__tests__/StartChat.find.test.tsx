/**
 * FIND HAPPENS IN PLACE (Start a chat, build 33).
 *
 * Start a chat no longer opens a second screen to find someone by email or
 * username: the result card appears under the field. The discovery contracts
 * move with it, ported in intent from the DiscoveryScreen suites
 * (discovery-ux, username-ux), which stay green against that untouched file:
 *
 *  - NO ULID IS EVER RENDERED on the found path: the card is labelled with
 *    what the person TYPED (trimmed, case kept, the @ dropped for a
 *    username), and that same text becomes the nickname;
 *  - EVERY MISS LOOKS THE SAME, and the copy says so;
 *  - one lookup at a time, a superseded answer is dropped, the username
 *    preflight runs before any lookup, and leaving mid-preflight starts none;
 *  - a duress session is network-silent.
 *
 * New on this screen: a found result is remembered for the visit (finding
 * the same target again costs no lookup), a cancelled scan or a photo error
 * never drops the card, a local failure to start stays on the card, and the
 * card is announced and takes screen-reader focus on its name line.
 */

import React from 'react';
import { AccessibilityInfo, Platform, StyleSheet } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import * as accounts from '../src/accounts';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as api from '../src/api';
import { ApiRequestError } from '../src/api';
import { API_BASE } from '../src/config';
import * as db from '../src/db';
import { LINKING_COPY } from '../src/linkingCopy';
import { messaging } from '../src/messaging';
import * as reauth from '../src/reauth';
import { COPY, StartChatScreen } from '../src/screens/StartChatScreen';
import {
  LOOKUPS_PER_DAY,
  LOOKUPS_PER_MINUTE,
  resetLookupPacing,
} from '../src/screens/startChat/useReachLookup';
import { session } from '../src/session';
import { ThemeProvider, themeTokens } from '../src/theme';
import { Avatar } from '../src/ui/Avatar';
import { InfoDisclosure } from '../src/ui/InfoDisclosure';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
const picker = jest.requireMock('react-native-image-picker') as {
  launchImageLibrary: jest.Mock;
  launchCamera: jest.Mock;
};

/** The build pin, read through a getter so every render sees the current
 * value (the username-ux pattern). Default ON, the shipped value. */
let mockUsernameUiEnabled = true;
jest.mock('../src/usernameUi', () => ({
  get USERNAME_UI_ENABLED() {
    return mockUsernameUiEnabled;
  },
}));

const nativeQr = jest.requireMock('tacendum-qr') as {
  scanWithCamera: jest.Mock;
  decodeFile: jest.Mock;
  __qr: { state: { payloads: string[] }; reset: () => void };
};

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      reset: () => void;
      instances: Map<string, { execute: jest.Mock }>;
    };
  }
).__sqlite;

/** The raw module object, not Babel's `import *` copy: redefining
 * `findNodeHandle` must land on the object the screen reads from. */
const RN: typeof import('react-native') = require('react-native');

/** The Crockford ULID shape: what must never reach the glass on this path. */
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};
const PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const ANCHOR = '01HQZZZZ00000000000000000A';
const PHOTO = 'file:///tmp/picked/IMG_0042.HEIC';
// RE-CUT (D3, fix/username-discovery 2026-10-08): the miss now says how the
// day's searches work — shared by the account's linked devices, reset at
// midnight UTC — where it used to name "today's searches" and nothing else.
const MISS_EMAIL =
  'No match — or your account is under three days old, or today’s searches are used up. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.';
const MISS_NAME =
  'No match — or you’ve used today’s searches. Tacendum cannot tell you which, by design. Searches are shared by your linked devices and reset at midnight UTC.';

const VERIFIED: db.AccountIdentifierRow = {
  email: 'me@example.com',
  verifiedAt: 1,
  discoverable: false,
  pendingEmail: null,
  pendingRequestedAt: null,
  restoredAt: null,
};

const REAL_OS = Platform.OS;
function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

type Tree = ReactTestRenderer.ReactTestRenderer;

function chatWrites(): Array<[string, unknown[]]> {
  const out: Array<[string, unknown[]]> = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) out.push([sql, (call[1] ?? []) as unknown[]]);
    }
  }
  return out;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  nativeQr.__qr.reset();
  nativeQr.scanWithCamera.mockClear();
  picker.launchImageLibrary.mockReset();
  // The state read keeps a landed answer for a moment: never across tests.
  accountsUsername.invalidateIdentifierState();
  // The lookup ledger is the DEVICE's, per process (the gate pass): every
  // test starts its day and minute empty.
  resetLookupPacing();
});

afterEach(async () => {
  jest.useRealTimers();
  setPlatform(REAL_OS);
  mockUsernameUiEnabled = true;
  session.setMode('real');
  jest.restoreAllMocks();
  await db.close();
});

/** The clock, stepped under fake timers (the pacing tests). */
async function advance(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function render(
  opts: {
    onOpenChat?: jest.Mock;
    onOpenAccountEmail?: jest.Mock;
    initialDraft?: string;
    mode?: 'light' | 'dark';
    createNodeMock?: (element: React.ReactElement<{ testID?: string; children?: unknown }>) => unknown;
  } = {},
): Promise<Tree> {
  const screen = (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={opts.onOpenChat ?? jest.fn()}
      onOpenAccountEmail={opts.onOpenAccountEmail ?? jest.fn()}
      initialDraft={opts.initialDraft}
    />
  );
  let tree!: Tree;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      opts.mode ? <ThemeProvider mode={opts.mode}>{screen}</ThemeProvider> : screen,
      opts.createNodeMock ? { createNodeMock: opts.createNodeMock } : undefined,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function hosts(tree: Tree, id: string): ReactTestInstance[] {
  return tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');
}

function has(tree: Tree, id: string): boolean {
  return hosts(tree, id).length > 0;
}

/** The control itself (composite and Pressable both carry testID + onPress;
 * the first, outermost match is taken). */
function control(tree: Tree, id: string): ReactTestInstance {
  const node = tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no control with testID ${id}`);
  return node;
}

async function press(tree: Tree, id: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function input(tree: Tree): ReactTestInstance {
  return hosts(tree, 'new-peer-input')[0]!;
}

async function type(tree: Tree, text: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    input(tree).props.onChangeText(text);
  });
}

async function typeEach(tree: Tree, text: string): Promise<void> {
  for (const ch of text) {
    await type(tree, `${input(tree).props.value ?? ''}${ch}`);
  }
}

async function submit(tree: Tree): Promise<void> {
  await ReactTestRenderer.act(async () => {
    input(tree).props.onSubmitEditing();
  });
}

function textIn(node: ReactTestInstance): string {
  return node
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => React.Children.toArray(n.props.children))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function kind(tree: Tree): string | null {
  const node = hosts(tree, 'reach-kind')[0];
  return node ? textIn(node) : null;
}

function messageOf(tree: Tree, id: string): string {
  const node = hosts(tree, id)[0];
  if (!node) throw new Error(`nothing with testID ${id} is on screen`);
  return textIn(node);
}

/** A notice's sentence alone — the first text node under it — where
 * `messageOf` would also read the label of the action beneath it. */
function sentenceOf(tree: Tree, id: string): string {
  const node = hosts(tree, id)[0];
  if (!node) throw new Error(`nothing with testID ${id} is on screen`);
  const text = node.findAll(
    n => typeof n.type === 'string' && typeof n.props.children === 'string',
  )[0];
  if (!text) throw new Error(`no sentence under ${id}`);
  return text.props.children as string;
}

function card(tree: Tree): ReactTestInstance {
  const node = hosts(tree, 'discovery-result-card')[0];
  if (!node) throw new Error('no found card on screen');
  return node;
}

function info(tree: Tree, id: string): ReactTestInstance {
  const node = tree.root.findAll(n => n.type === InfoDisclosure && n.props.testID === id)[0];
  if (!node) throw new Error(`no ⓘ with testID ${id}`);
  return node;
}

function rendered(tree: Tree): string {
  return JSON.stringify(tree.toJSON());
}

function foundBy(deviceCount = 1) {
  return jest
    .spyOn(accounts, 'discoverySearch')
    .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount });
}

/** The caller-owned state read (fix/username-discovery, 2026-10-08): the ONE
 * group-level answer the username preflight and the own-email door read.
 * A 'state' answer carries the three facts; 'legacy' (today's production
 * server, no state route) and every refusal or failure carry null = unknown. */
type StateAnswer = accountsUsername.IdentifierState;
function stateOf(
  eligibility: accountsUsername.IdentifierStateEligibility,
  source: accountsUsername.IdentifierStateSource = 'state',
): StateAnswer {
  const landed = eligibility === 'eligible' || eligibility === 'needs_verification';
  const known = source === 'state' && landed;
  return {
    source,
    eligibility,
    holdsUsername: known ? false : null,
    emailLinked: known ? eligibility === 'eligible' : null,
    phoneLinked: known ? false : null,
    cooldownUntil: null,
    usernameSince: null,
    emailSince: null,
    usernameFindable: null,
    emailFindable: null,
  };
}
/** The state read answers these in turn, then the last one for ever. */
function stateReads(...answers: StateAnswer[]): jest.SpyInstance {
  const spy = jest.spyOn(accountsUsername, 'getIdentifierState');
  for (const answer of answers) spy.mockResolvedValueOnce(answer);
  return spy.mockResolvedValue(answers[answers.length - 1] ?? stateOf('eligible'));
}

async function findEmail(tree: Tree, email: string): Promise<void> {
  await type(tree, email);
  await press(tree, 'discovery-search');
}

/* ── found and commit ───────────────────────────────────────────────── */

describe('found: the typed text, never an ID, and the tap opens the chat', () => {
  test('the card carries the typed address verbatim (trimmed, case kept) and the device count; no ID reaches the glass', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED);
    foundBy(2);
    const started = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    const tree = await render();
    await findEmail(tree, '  Alice@Example.com ');

    expect(textIn(card(tree))).toContain('Alice@Example.com');
    expect(textIn(card(tree))).toContain('Found · 2 devices');
    // The central assertion of the found path, My ID collapsed.
    expect(ULID_RE.test(rendered(tree))).toBe(false);
    // The name opens with the visible label, unbroken (WCAG 2.5.3 Label in
    // Name), so "Tap Open room" reaches it by voice. It once said "Start a
    // chat with …", which did not contain the words on the button.
    expect(textIn(control(tree, 'discovery-result'))).toBe('Open room');
    expect(control(tree, 'discovery-result').props.accessibilityLabel).toBe(
      'Open room with Alice@Example.com',
    );

    await press(tree, 'discovery-result');
    expect(started).toHaveBeenCalledWith('Alice@Example.com', ANCHOR, undefined, 'discovery');
  });

  test('the tap opens the chat at the resolved anchor, and the typed label rides to the other devices', async () => {
    foundBy();
    const started = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    const sync = jest.spyOn(messaging, 'syncLocalName').mockResolvedValue(undefined);
    const onOpenChat = jest.fn();
    const tree = await render({ onOpenChat });
    await findEmail(tree, 'alice@example.com');
    await press(tree, 'discovery-result');

    expect(started).toHaveBeenCalledWith('alice@example.com', ANCHOR, undefined, 'discovery');
    expect(sync).toHaveBeenCalledWith(ANCHOR, 'alice@example.com');
    expect(onOpenChat).toHaveBeenCalledWith(ANCHOR);
  });

  test('found by username: marked as a server introduction, and the card never shows the @', async () => {
    stateReads(stateOf('eligible'));
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const started = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    const tree = await render();
    await type(tree, '@Alice_7');
    await press(tree, 'discovery-search');

    expect(textIn(card(tree))).toContain('Alice_7');
    const cardStrings = JSON.stringify(
      card(tree)
        .findAll(n => typeof n.type === 'string')
        .map(n => [n.props.accessibilityLabel ?? null, textIn(n)]),
    );
    expect(cardStrings).not.toContain('@');

    await press(tree, 'discovery-result');
    expect(started).toHaveBeenCalledWith(
      'Alice_7',
      ANCHOR,
      undefined,
      db.DISCOVERY_USERNAME_INTRODUCED,
    );
    expect(db.serverIntroduced(started.mock.calls[0]![3])).toBe(true);
  });

  test('someone you already named: the card says so and offers Open room, and the tap renames nothing', async () => {
    foundBy();
    jest
      .spyOn(db, 'getChat')
      .mockImplementation(async id =>
        id === ANCHOR
          ? ({ peerId: ANCHOR, localName: 'Mira', displayName: null } as unknown as db.ChatRow)
          : null,
      );
    const upsert = jest.spyOn(db, 'upsertChat').mockResolvedValue(undefined);
    const started = jest.spyOn(accounts, 'startDiscoveredChat');
    const renamed = jest.spyOn(db, 'setLocalName');
    const onOpenChat = jest.fn();
    const tree = await render({ onOpenChat });
    await findEmail(tree, 'mira@x.com');

    expect(textIn(card(tree))).toContain('You already have a room with Mira');
    expect(control(tree, 'discovery-result').props.label).toBe('Open room');
    expect(control(tree, 'discovery-result').props.accessibilityLabel).toBe(
      'Open room with Mira',
    );

    await press(tree, 'discovery-result');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(ANCHOR, undefined, 'discovery');
    expect(started).not.toHaveBeenCalled();
    expect(renamed).not.toHaveBeenCalled();
    expect(onOpenChat).toHaveBeenCalledWith(ANCHOR);
  });
});

/* ── announced and focused ──────────────────────────────────────────── */

describe('the card is announced and takes focus on its name line', () => {
  test('iOS: announced once as "Found <label>", and not again when a failed start re-renders it', async () => {
    setPlatform('ios');
    foundBy();
    jest.spyOn(accounts, 'startDiscoveredChat').mockRejectedValue(new Error('disk full'));
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await findEmail(tree, 'Alice@Example.com');

    const foundAnnouncements = () =>
      announce.mock.calls.filter(([message]) => String(message).startsWith('Found '));
    expect(foundAnnouncements()).toEqual([['Found Alice@Example.com', { queue: true }]]);

    await press(tree, 'discovery-result');
    expect(has(tree, 'start-chat-error')).toBe(true);
    expect(foundAnnouncements()).toHaveLength(1);
    // The failure itself: once for the first, and again for an identical
    // second one (the seq moves with each failure, never a render later).
    const failures = () =>
      announce.mock.calls.filter(([message]) => message === COPY.errorLocal);
    expect(failures()).toHaveLength(1);
    await press(tree, 'discovery-result');
    expect(failures()).toHaveLength(2);
    expect(foundAnnouncements()).toHaveLength(1);
  });

  test('Android: the name line is a polite live region', async () => {
    setPlatform('android');
    foundBy();
    const tree = await render();
    await findEmail(tree, 'alice@example.com');

    expect(hosts(tree, 'discovery-result-who')[0]!.props.accessibilityLiveRegion).toBe('polite');
  });

  test('focus lands on the name line, never the button; a miss moves it to the miss sentence', async () => {
    const focusSpy = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus');
    focusSpy.mockClear();
    // The test renderer has no native views: a findNodeHandle that maps a
    // ref's testID or text to a tag is what lets this assert WHERE focus
    // went rather than the null check (the RegisterScreen technique). The
    // preset's View and Text are mock classes, so a ref holds the instance
    // (testID on its props); a host ref holds the node mock below.
    const handle = jest.fn((node: unknown) => {
      const n = node as {
        testID?: string;
        children?: unknown;
        props?: { testID?: string; children?: unknown };
      } | null;
      const testID = n?.props?.testID ?? n?.testID;
      const children = n?.props?.children ?? n?.children;
      if (testID === 'discovery-result-who') return 11;
      if (testID === 'discovery-result') return 22;
      if (children === MISS_EMAIL) return 33;
      return null;
    });
    const original = Object.getOwnPropertyDescriptor(RN, 'findNodeHandle')!;
    Object.defineProperty(RN, 'findNodeHandle', { configurable: true, get: () => handle });
    try {
      jest
        .spyOn(accounts, 'discoverySearch')
        .mockResolvedValueOnce({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 })
        .mockResolvedValueOnce({ outcome: 'no_match' });
      const tree = await render({
        createNodeMock: element => ({
          testID: element.props.testID,
          children: element.props.children,
        }),
      });
      await findEmail(tree, 'alice@example.com');
      expect(focusSpy).toHaveBeenCalledWith(11);
      expect(focusSpy).not.toHaveBeenCalledWith(22);

      await findEmail(tree, 'lena@studio.co');
      expect(focusSpy).toHaveBeenLastCalledWith(33);
    } finally {
      Object.defineProperty(RN, 'findNodeHandle', original);
    }
  });
});

/* ── sequencing ─────────────────────────────────────────────────────── */

describe('one lookup at a time; a superseded answer is dropped', () => {
  test('an edit while a lookup is in flight drops its answer', async () => {
    let resolveFirst!: (value: accounts.DiscoveryOutcome) => void;
    jest.spyOn(accounts, 'discoverySearch').mockReturnValueOnce(
      new Promise<accounts.DiscoveryOutcome>(resolve => {
        resolveFirst = resolve;
      }),
    );
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');
    await typeEach(tree, 'm');
    await ReactTestRenderer.act(async () => {
      resolveFirst({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    });

    expect(has(tree, 'discovery-result-card')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('pressing Find twice makes one call', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, 'lena@studio.co');
    await ReactTestRenderer.act(async () => {
      control(tree, 'discovery-search').props.onPress();
      control(tree, 'discovery-search').props.onPress();
    });

    expect(search).toHaveBeenCalledTimes(1);
  });

  test('leaving mid-preflight never starts a lookup', async () => {
    let resolveState!: (value: StateAnswer) => void;
    jest.spyOn(accountsUsername, 'getIdentifierState').mockReturnValue(
      new Promise(resolve => {
        resolveState = resolve;
      }),
    );
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
    await ReactTestRenderer.act(async () => {
      resolveState(stateOf('eligible'));
    });

    expect(byName).not.toHaveBeenCalled();
  });
});

/* ── the card survives what does not change the text ────────────────── */

describe('the card belongs to the field’s text, so nothing that leaves the text alone drops it', () => {
  test('a cancelled scan leaves the card and costs no second lookup', async () => {
    const search = foundBy();
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');
    expect(has(tree, 'discovery-result-card')).toBe(true);

    // The scanner hands back nothing and the camera is allowed: a cancel.
    nativeQr.__qr.state.payloads = [];
    await press(tree, 'scan-qr-camera');

    expect(has(tree, 'discovery-result-card')).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('a photo error stays at the photo and the card stays above it', async () => {
    const search = foundBy();
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: PHOTO, width: 3024, height: 4032, fileSize: 2_400_000 }],
    });
    nativeQr.__qr.state.payloads = [];
    await press(tree, 'scan-qr-photo');

    const order = tree.root
      .findAll(
        n =>
          typeof n.type === 'string' &&
          (n.props.testID === 'discovery-result-card' || n.props.testID === 'start-chat-error'),
      )
      .map(n => n.props.testID);
    expect(order).toEqual(['discovery-result-card', 'start-chat-error']);
    expect(messageOf(tree, 'start-chat-error')).toContain('There’s no QR code');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('found, edited, edited back: Find shows the card again from memory with the text as typed now; a miss is never remembered', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValueOnce({ outcome: 'found', anchor: ANCHOR, deviceCount: 3 })
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await findEmail(tree, 'Lena@Studio.co');
    expect(has(tree, 'discovery-result-card')).toBe(true);

    await typeEach(tree, 'x');
    expect(has(tree, 'discovery-result-card')).toBe(false);
    await type(tree, 'lena@studio.co');
    await press(tree, 'discovery-search');

    expect(textIn(card(tree))).toContain('lena@studio.co');
    expect(textIn(card(tree))).toContain('Found · 3 devices');
    expect(search).toHaveBeenCalledTimes(1);

    // A miss is asked again: the person may have just turned findability on.
    await findEmail(tree, 'mira@x.com');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    await typeEach(tree, 'x');
    await type(tree, 'mira@x.com');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(3);
  });

  test('in the found state the go key never presses the card’s button', async () => {
    foundBy();
    const started = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    const upsert = jest.spyOn(db, 'upsertChat');
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');
    await submit(tree);

    expect(has(tree, 'discovery-result-card')).toBe(true);
    expect(started).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

/* ── a local failure stays local ────────────────────────────────────── */

describe('a failure to start on this device stays on the card', () => {
  test('errorLocal under the card’s button; no lookup; the button retries only the start', async () => {
    const search = foundBy();
    const started = jest
      .spyOn(accounts, 'startDiscoveredChat')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const onOpenChat = jest.fn();
    const tree = await render({ onOpenChat });
    await findEmail(tree, 'lena@studio.co');
    await press(tree, 'discovery-result');

    const error = card(tree).findAll(
      n => n.props.testID === 'start-chat-error' && typeof n.type === 'string',
    )[0]!;
    expect(textIn(error)).toBe('We couldn’t open this room. Try again.');
    expect(textIn(error)).toBe(COPY.errorLocal);
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);

    await press(tree, 'discovery-result');
    expect(started).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(onOpenChat).toHaveBeenCalledWith(ANCHOR);
  });
});

/* ── duress ─────────────────────────────────────────────────────────── */

describe('a duress session is network-silent', () => {
  test('Find in duress shows the offline sentence and reaches no fetch; outside duress the same steps fetch once', async () => {
    const realFetch = globalThis.fetch;
    const fetchSpy = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    try {
      session.setMode('duress');
      const coerced = await render();
      await findEmail(coerced, 'lena@studio.co');
      expect(messageOf(coerced, 'discovery-error')).toContain(ACCOUNTS_COPY.failed);
      expect(fetchSpy).not.toHaveBeenCalled();
      await ReactTestRenderer.act(async () => {
        coerced.unmount();
      });

      // The positive control: the guard, not the harness, kept fetch silent.
      // Outside duress an email Find reaches the wire twice — the lookup,
      // and the caller-owned state read that drives the own-email door
      // (fix/username-discovery, 2026-10-08) — each exactly once.
      session.setMode('real');
      const ordinary = await render();
      await findEmail(ordinary, 'lena@studio.co');
      const paths = (fetchSpy.mock.calls as unknown as Array<[unknown]>).map(([url]) =>
        String(url).slice(API_BASE.length),
      );
      expect(paths.sort()).toEqual(['/v1/discovery/lookup', '/v1/identifiers/state']);
    } finally {
      globalThis.fetch = realFetch;
      session.setMode('real');
    }
  });
});

/* ── misses ─────────────────────────────────────────────────────────── */

describe('every miss looks the same, and the copy says so', () => {
  // AMENDED (D6, fix/username-discovery 2026-10-08): Find stays hidden and
  // the go key still calls nothing after a miss; the miss now carries a
  // quiet Search again — exactly one more lookup — because a person waiting
  // for a friend to turn findability on, or suspecting a budget, had to
  // change the text and change it back to ask again.
  test('after a miss Find is hidden and the go key calls nothing; Search again sends exactly one more lookup; an edit brings Find back', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValueOnce({ outcome: 'no_match' })
      .mockResolvedValueOnce({ outcome: 'no_match' })
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');

    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(search).toHaveBeenCalledTimes(1);

    // Search again: the same text, one more lookup, and the answer renders.
    expect(textIn(control(tree, 'discovery-search-again'))).toBe('Search again');
    expect(control(tree, 'discovery-search-again').props.accessibilityLabel).toBe('Search again');
    await press(tree, 'discovery-search-again');
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith('lena@studio.co');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    // Twice in one frame is still one lookup; a found answer shows the card.
    await ReactTestRenderer.act(async () => {
      control(tree, 'discovery-search-again').props.onPress();
      control(tree, 'discovery-search-again').props.onPress();
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(has(tree, 'discovery-result-card')).toBe(true);
    expect(has(tree, 'discovery-search-again')).toBe(false);

    await typeEach(tree, 'x');
    expect(has(tree, 'discovery-result-card')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('Search again on a username miss runs the lookup again from the visit’s one state answer: no second preflight read', async () => {
    const state = stateReads(stateOf('eligible'));
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    expect(has(tree, 'discovery-no-match')).toBe(true);

    await press(tree, 'discovery-search-again');
    expect(byName).toHaveBeenCalledTimes(2);
    expect(byName).toHaveBeenLastCalledWith('mira_k');
    expect(state).toHaveBeenCalledTimes(1);
    expect(has(tree, 'discovery-no-match')).toBe(true);
  });

  test('a miss, not findable, a recovery pause and a spent budget are one miss on screen', async () => {
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    stateReads(stateOf('eligible'));
    // The wire answers every refused case with ONE collapsed 403.
    const lookup = jest.spyOn(api, 'apiDiscoveryLookup');
    const tree = await render();
    const seen: string[] = [];
    for (const target of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) {
      lookup.mockRejectedValueOnce(new ApiRequestError('refused', 403, 'accounts_refused'));
      await findEmail(tree, target);
      seen.push(messageOf(tree, 'discovery-no-match'));
    }

    expect(lookup).toHaveBeenCalledTimes(4);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toContain('Tacendum cannot tell you which, by design.');
  });

  test('an email miss names the three-day rule; a username miss never does', async () => {
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    // The device that verified the address holds its row: it catches its
    // own email before sending, so the miss line never adds the self case
    // here (the proof pass — the sibling's line does; see D1 below).
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED);
    stateReads(stateOf('eligible'));
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await findEmail(tree, 'lena@studio.co');
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(MISS_EMAIL);
    expect(messageOf(tree, 'discovery-no-match')).toContain('under three days old');
    // The only other words in the notice are its action's.
    expect(messageOf(tree, 'discovery-no-match')).toBe(`${MISS_EMAIL} ${COPY.searchAgain}`);

    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(MISS_NAME);
    expect(messageOf(tree, 'discovery-no-match')).not.toContain('three days');

    // D3: both say how the day's searches work — shared across the
    // account's linked devices, reset at midnight UTC — so fast testing on
    // two devices no longer reads as "broken".
    for (const line of [COPY.missLine, COPY.missLineEmail]) {
      expect(line).toContain('shared by your linked devices');
      expect(line).toContain('reset at midnight UTC');
      expect(line).toContain('Tacendum cannot tell you which, by design.');
    }
  });

  test('the miss ⓘ: the email lead and its explainer; the username lead and its explainer', async () => {
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    stateReads(stateOf('eligible'));
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await findEmail(tree, 'lena@studio.co');
    const emailLines = info(tree, 'discovery-info').props.lines as string[];
    expect(info(tree, 'discovery-info').props.label).toBe(ACCOUNTS_COPY.discoverExplainLabel);
    expect(emailLines).toEqual([COPY.missInfoLeadEmail, ...ACCOUNTS_COPY.discoverExplain]);
    expect(emailLines[0]).toContain('is recovering their account');
    expect(emailLines.join(' ')).not.toContain('recovery pause');
    await press(tree, 'discovery-info');
    expect(textIn(info(tree, 'discovery-info'))).toContain('is recovering their account');

    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    const nameLines = info(tree, 'discovery-info').props.lines as string[];
    expect(nameLines).toEqual([
      ACCOUNTS_USERNAME_COPY.startChatMissInfoLead,
      ...ACCOUNTS_USERNAME_COPY.findExplain,
    ]);
    expect(nameLines.join(' ')).toContain('holding a username is not enough');
  });

  // RE-CUT (D1, fix/username-discovery 2026-10-08): the door used to hang
  // on THIS DEVICE's email row, so every linked sibling — no row of its
  // own, the account verified on the phone — got "verify an email first"
  // on every email miss. It now hangs on the account group's own answer:
  // the state read says the account holds no verified email or phone.
  test('an email miss on an account with no verified email or phone offers Link an email, which carries the draft', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    stateReads(stateOf('needs_verification'));
    const onOpenAccountEmail = jest.fn();
    const tree = await render({ onOpenAccountEmail });

    await findEmail(tree, 'lena@studio.co');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(messageOf(tree, 'discovery-needs-own-email')).toContain(
      'To search, verify an email on your account first.',
    );
    expect(messageOf(tree, 'discovery-needs-own-email')).not.toContain('round-trip');
    await press(tree, 'discovery-link-email');
    expect(onOpenAccountEmail).toHaveBeenCalledWith('lena@studio.co');
  });
});

/* ── D1: a linked sibling, and the own-email door (2026-10-08) ─────────── */

describe('D1: your own email or name from a linked sibling — no local rows, the account verified on another device', () => {
  const OWN_EMAIL = 'me@example.com';
  const OWN_NAME = 'me_name';
  /** The sibling: nothing attached or claimed on THIS device. */
  function sibling(): void {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(null);
  }
  /** The server's self-miss (discovery.ts, keyed on the account group). */
  function misses() {
    return {
      byEmail: jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' }),
      byName: jest
        .spyOn(accountsUsername, 'discoverySearchByUsername')
        .mockResolvedValue({ outcome: 'no_match' }),
    };
  }
  const SELF_SENTENCE =
    'Searching for your own email or username, from any of your devices, always shows no match.';

  test('an own-email miss gets NO “verify an email first” door — the account is verified — and the miss ⓘ says a self search always misses', async () => {
    sibling();
    const { byEmail } = misses();
    stateReads({
      source: 'state',
      eligibility: 'eligible',
      holdsUsername: true,
      emailLinked: true,
      phoneLinked: false,
      cooldownUntil: null,
      usernameSince: null,
      emailSince: null,
      usernameFindable: null,
      emailFindable: null,
    });
    const tree = await render();
    await findEmail(tree, OWN_EMAIL);

    // The sibling cannot match the text (names never travel), so the
    // search is sent and misses — that part is ruled. The false door is not.
    expect(byEmail).toHaveBeenCalledWith(OWN_EMAIL);
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-needs-own-email')).toBe(false);
    expect(has(tree, 'discovery-link-email')).toBe(false);
    const lines = info(tree, 'discovery-info').props.lines as string[];
    expect(lines[0]).toBe(COPY.missInfoLeadEmail);
    // RE-CUT 2026-10-08 (the gate pass): the self rule is said ONCE in this
    // sheet — by the shared email deck's line the sheet appends — no longer
    // also at the end of the lead (the sheet read the same rule twice).
    expect(lines.filter(line => line.endsWith('from any of your devices, always shows no match.'))).toHaveLength(1);
    expect(lines.join(' ')).toContain('from any of your devices');
    expect(COPY.missInfoLeadEmail).not.toContain(SELF_SENTENCE);
    expect(COPY.missInfoLeadEmail).not.toContain('from any of your devices');
  });

  test('the proof pass: on a sibling the VISIBLE miss line says the self case too — the account holds an email or a name this device cannot match', async () => {
    sibling();
    misses();
    stateReads({
      source: 'state',
      eligibility: 'eligible',
      holdsUsername: true,
      emailLinked: true,
      phoneLinked: false,
      cooldownUntil: null,
      usernameSince: null,
      emailSince: null,
      usernameFindable: true,
      emailFindable: false,
    });
    const tree = await render();
    await findEmail(tree, OWN_EMAIL);
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(COPY.missLineEmailMaybeSelf);
    expect(COPY.missLineEmailMaybeSelf).toContain('your own email always shows no match');
    expect(COPY.missLineEmailMaybeSelf).toContain('Tacendum cannot tell you which, by design.');
    expect(COPY.missLineEmailMaybeSelf).toContain('reset at midnight UTC');

    await type(tree, OWN_NAME);
    await ReactTestRenderer.act(async () => {
      input(tree).props.onBlur();
    });
    await press(tree, 'discovery-search');
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(ACCOUNTS_USERNAME_COPY.startChatMissLineMaybeSelf);
    expect(ACCOUNTS_USERNAME_COPY.startChatMissLineMaybeSelf).toContain('your own username always shows no match');
  });

  test('the proof pass: the self case is said only where the account holds that class — a sibling of a name-less account gets the plain line', async () => {
    sibling();
    misses();
    stateReads(stateOf('eligible')); // emailLinked true, holdsUsername false
    const tree = await render();
    await type(tree, OWN_NAME);
    await ReactTestRenderer.act(async () => {
      input(tree).props.onBlur();
    });
    await press(tree, 'discovery-search');
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(MISS_NAME);
    await findEmail(tree, OWN_EMAIL);
    expect(sentenceOf(tree, 'discovery-no-match')).toBe(COPY.missLineEmailMaybeSelf);
  });

  test('an own-username miss: the state read is the preflight (never the uncached legacy read), and no door either', async () => {
    sibling();
    const { byName } = misses();
    const legacy = jest.spyOn(accountsUsername, 'getUsernameEligibility');
    const state = stateReads(stateOf('eligible'));
    const tree = await render();
    await type(tree, OWN_NAME);
    // A bare name is named after the settle, or at once on leaving the field.
    await ReactTestRenderer.act(async () => {
      input(tree).props.onBlur();
    });
    expect(kind(tree)).toBe('Username');
    await press(tree, 'discovery-search');

    expect(byName).toHaveBeenCalledWith(OWN_NAME);
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-needs-own-email')).toBe(false);
    expect(state).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  test('the door hangs on the FACT that the account holds no verified email or phone, from either source; unknown (refused, failed) shows none', async () => {
    const cases: Array<[StateAnswer, boolean]> = [
      [stateOf('needs_verification', 'state'), true],
      [stateOf('needs_verification', 'legacy'), true],
      [stateOf('eligible', 'state'), false],
      [stateOf('eligible', 'legacy'), false],
      [stateOf('refused', 'state'), false],
      [stateOf('refused', 'legacy'), false],
      [stateOf('failed', 'state'), false],
      [stateOf('failed', 'legacy'), false],
    ];
    for (const [answer, door] of cases) {
      sibling();
      misses();
      stateReads(answer);
      // The DEVICE's lookup ledger (the gate pass) counts across these
      // screens exactly as across remounts; this case is about the door,
      // so each screen starts its minute empty.
      resetLookupPacing();
      const tree = await render();
      await findEmail(tree, 'lena@studio.co');
      expect([answer.source, answer.eligibility, has(tree, 'discovery-no-match')]).toEqual([
        answer.source,
        answer.eligibility,
        true,
      ]);
      expect([answer.source, answer.eligibility, has(tree, 'discovery-needs-own-email')]).toEqual([
        answer.source,
        answer.eligibility,
        door,
      ]);
      await ReactTestRenderer.act(async () => {
        tree.unmount();
      });
      jest.restoreAllMocks();
    }
  });

  test('one state read per visit: an email miss, a username Find and another email miss read it once; a refused or failed read is asked again', async () => {
    sibling();
    misses();
    const state = stateReads(stateOf('eligible'));
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    await findEmail(tree, 'lena@studio.co');
    expect(state).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });

    jest.restoreAllMocks();
    sibling();
    misses();
    const refused = stateReads(stateOf('refused'), stateOf('refused'), stateOf('eligible'));
    // The device's ledger counted the first screen's lookups (the gate
    // pass); this case is about the state read, so the minute starts empty.
    resetLookupPacing();
    const again = await render();
    await findEmail(again, 'lena@studio.co');
    await findEmail(again, 'mira@x.com');
    expect(refused).toHaveBeenCalledTimes(2);
    // Once an answer lands, it is kept for the visit.
    await findEmail(again, 'lena@studio.co');
    await findEmail(again, 'mira@x.com');
    expect(refused).toHaveBeenCalledTimes(3);
  });
});

/* ── U3 (the consumer side): a refused read is not a connection problem ── */

describe('U3: the username preflight tells a refused read from a failed one', () => {
  /** The neutral sentence lives in the username deck as `eligibilityRefused`
   * (lane 1's key, fix/username-discovery 2026-10-08). Until that lands in
   * this checkout the test installs it, so the screen's wiring is proved
   * either way; with the real key present nothing is touched. */
  const NEUTRAL = 'Tacendum could not check username access right now. Try again in a minute.';
  function withRefusedSentence(): { sentence: string; restore: () => void } {
    const deck = ACCOUNTS_USERNAME_COPY as unknown as Record<string, unknown>;
    const existing = deck.eligibilityRefused;
    if (typeof existing === 'string') return { sentence: existing, restore: () => undefined };
    Object.defineProperty(deck, 'eligibilityRefused', {
      value: NEUTRAL,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return {
      sentence: NEUTRAL,
      restore: () => {
        delete deck.eligibilityRefused;
      },
    };
  }

  test('REFUSED (the frozen 403: the caller’s budget or a dark flag): the neutral sentence, never “Check your connection”; Try again reads again, then looks up', async () => {
    const installed = withRefusedSentence();
    try {
      const state = stateReads(stateOf('refused'), stateOf('eligible'));
      const byName = jest
        .spyOn(accountsUsername, 'discoverySearchByUsername')
        .mockResolvedValue({ outcome: 'no_match' });
      const tree = await render();
      await type(tree, '@mira_k');
      await press(tree, 'discovery-search');

      const notice = messageOf(tree, 'discovery-username-eligibility-unavailable');
      expect(notice).toContain(installed.sentence);
      expect(notice).not.toContain('Check your connection');
      expect(byName).not.toHaveBeenCalled();

      await press(tree, 'discovery-username-eligibility-retry');
      expect(state).toHaveBeenCalledTimes(2);
      expect(byName).toHaveBeenCalledTimes(1);
      expect(has(tree, 'discovery-no-match')).toBe(true);
    } finally {
      installed.restore();
    }
  });

  test('FAILED (no network, the deadline, duress): the connection sentence stays', async () => {
    stateReads(stateOf('failed'));
    const byName = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');

    expect(messageOf(tree, 'discovery-username-eligibility-unavailable')).toContain(
      ACCOUNTS_USERNAME_COPY.eligibilityUnavailable,
    );
    expect(messageOf(tree, 'discovery-username-eligibility-unavailable')).toContain(
      'Check your connection',
    );
    expect(byName).not.toHaveBeenCalled();
  });
});

/* ── eligibility ────────────────────────────────────────────────────── */

describe('the username preflight', () => {
  test('needs verification: the deck door and Link an email, the reason behind its ⓘ, never a miss and no lookup', async () => {
    stateReads(stateOf('needs_verification'));
    const byName = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const onOpenAccountEmail = jest.fn();
    const tree = await render({ onOpenAccountEmail });
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');

    const door = messageOf(tree, 'discovery-username-needs-identifier');
    expect(door).toContain(ACCOUNTS_USERNAME_COPY.startChatNeedsIdentifier);
    expect(door).not.toContain('bulk');
    expect(has(tree, 'discovery-no-match')).toBe(false);
    expect(byName).not.toHaveBeenCalled();
    expect(info(tree, 'discovery-info').props.label).toBe(
      ACCOUNTS_USERNAME_COPY.startChatVerifyWhyLabel,
    );
    expect(info(tree, 'discovery-info').props.lines).toEqual([
      ACCOUNTS_USERNAME_COPY.startChatVerifyWhy,
    ]);

    await press(tree, 'discovery-username-link-email');
    expect(onOpenAccountEmail).toHaveBeenCalledWith('@mira_k');
  });

  test('unavailable (a failed read): Try again is a fresh read, then the lookup', async () => {
    const state = stateReads(stateOf('failed'), stateOf('eligible'));
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');

    expect(has(tree, 'discovery-username-eligibility-unavailable')).toBe(true);
    expect(byName).not.toHaveBeenCalled();
    await press(tree, 'discovery-username-eligibility-retry');
    expect(state).toHaveBeenCalledTimes(2);
    expect(byName).toHaveBeenCalledTimes(1);
  });
});

/* ── the draft survives the detour ──────────────────────────────────── */

describe('the typed text survives the Link-an-email detour', () => {
  test('a handed-back draft fills the field: Email and Find show, and nothing is looked up until Find', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render({ initialDraft: 'lena@studio.co' });

    expect(input(tree).props.value).toBe('lena@studio.co');
    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'discovery-search')).toBe(true);
    expect(search).not.toHaveBeenCalled();
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('a handed-back ID is the person’s typed text: started, it is recorded as manual', async () => {
    const tree = await render({ initialDraft: PEER });
    await press(tree, 'start-chat');
    await ReactTestRenderer.act(async () => {});

    const writes = chatWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]![1][3]).toBe('manual');
  });
});

/* ── palette and the disc ───────────────────────────────────────────── */

describe('the card on white, and in the charcoal option', () => {
  test('a soft hairline edge; the face is the shared Avatar, lettered from the typed label; hidden, so the name line starts with the name', async () => {
    foundBy();
    const light = await render();
    await findEmail(light, 'Alice@Example.com');
    const lightEdge = StyleSheet.flatten(card(light).props.style);
    expect(lightEdge.borderColor).toBe(themeTokens('light').color.lineSoft);
    expect(lightEdge.borderWidth).toBe(themeTokens('light').hairline);
    await ReactTestRenderer.act(async () => {
      light.unmount();
    });

    const dark = await render({ mode: 'dark' });
    await findEmail(dark, 'Alice@Example.com');
    expect(StyleSheet.flatten(card(dark).props.style).borderColor).toBe(
      themeTokens('dark').color.lineSoft,
    );
    const disc = hosts(dark, 'discovery-result-disc')[0]!;
    // The found person wears every person's face: the shared Avatar, never a
    // disc of the card's own, so the card follows whatever a monogram looks
    // like everywhere else. It is lettered from what was TYPED and handed no
    // account ID: the resolved ID must never reach the card.
    const faces = card(dark).findAllByType(Avatar);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.props).toMatchObject({ peerId: '', monogramOverride: 'A', size: 40 });
    expect(ULID_RE.test(JSON.stringify(faces[0]!.props))).toBe(false);
    // In the charcoal option too, that face is the forest disc (2026-10-05),
    // never the card's old white disc in a gray ring.
    const face = disc.findAll(
      n => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.width === 40,
    )[0]!;
    expect(StyleSheet.flatten(face.props.style).backgroundColor).toBe('#0E6B45');
    expect(disc.props.accessibilityElementsHidden).toBe(true);
    expect(disc.props.importantForAccessibility).toBe('no-hide-descendants');
    // The letter is geometry, frozen like every monogram: at the largest
    // text sizes a scaling letter outgrew its fixed 40pt ring.
    const letter = disc.findAll(n => typeof n.type === 'string' && n.props.children === 'A')[0]!;
    expect(letter.props.allowFontScaling).toBe(false);
    expect(StyleSheet.flatten(letter.props.style).color).toBe('#FFFFFF');
    // One letter, at the card's heading size, as the card's own disc drew it:
    // Avatar's default fraction of the disc is sized for two.
    expect(StyleSheet.flatten(letter.props.style).fontSize).toBe(
      themeTokens('dark').type.sectionTitle.fontSize,
    );
    expect(
      String(hosts(dark, 'discovery-result-who')[0]!.props.accessibilityLabel).startsWith(
        'Alice@Example.com',
      ),
    ).toBe(true);
  });
});

/* ── transport ──────────────────────────────────────────────────────── */

describe('offline is the one distinguishable answer', () => {
  test('the shared offline sentence, and Try again is exactly one new lookup', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');

    expect(messageOf(tree, 'discovery-error')).toContain(
      'Could not reach Tacendum. Check your connection and try again.',
    );
    expect(search).toHaveBeenCalledTimes(1);
    await press(tree, 'discovery-retry');
    expect(search).toHaveBeenCalledTimes(2);
    expect(has(tree, 'discovery-no-match')).toBe(true);
  });
});

/* ── pin OFF ────────────────────────────────────────────────────────── */

describe('with the username pin OFF', () => {
  test('zero username calls end to end, and the own-name row is never read', async () => {
    mockUsernameUiEnabled = false;
    const eligibility = jest.spyOn(accountsUsername, 'getUsernameEligibility');
    const state = jest.spyOn(accountsUsername, 'getIdentifierState');
    const byName = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const ownName = jest.spyOn(db, 'loadUsernameIdentifier');
    const tree = await render();
    await type(tree, 'alice_7');
    await submit(tree);

    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That isn’t an ID or an email. Check what they sent you.',
    );
    expect(eligibility).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();
    expect(ownName).not.toHaveBeenCalled();
  });
});

/* ── shared sentences ───────────────────────────────────────────────── */

describe('one condition, one sentence (byte equality)', () => {
  test('the trust ⓘ second lines match; needsIdentifier ends with the reason now behind Why verify first; offline is the shared sentence', () => {
    expect(ACCOUNTS_USERNAME_COPY.startChatFoundInfo[1]).toBe(COPY.foundInfoEmail[1]);
    expect(
      ACCOUNTS_USERNAME_COPY.needsIdentifier.endsWith(
        ` ${ACCOUNTS_USERNAME_COPY.startChatVerifyWhy}`,
      ),
    ).toBe(true);
    expect(COPY.findOffline).toBe(ACCOUNTS_COPY.failed);
    expect(ACCOUNTS_COPY.failed).toBe(LINKING_COPY.transportFailed);
  });
});

/* ── D3: the lookup budgets, paced on the device (2026-10-08) ─────────── */

describe('D3: the lookup budgets are paced here before the wire refuses them as a miss', () => {
  // The server keeps 5 lookups per clock minute per device and 20 per UTC
  // day (per device and per account group), fixed windows aligned to the
  // clock, every refusal the uniform miss. Nothing paced on the device, so
  // six quick presses turned a real, consented target into "No match".
  const MINUTE = 60_000;
  const MINUTE_SENTENCE = 'Up to five searches a minute — wait a moment.';
  const DAY_SENTENCE =
    'This device has sent today’s 20 searches. Searches are shared by your linked devices and reset at midnight UTC.';

  function startClock(iso = '2026-10-08T15:00:00.000Z'): void {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(iso));
  }

  test('the constants are the server’s: 5 a minute, 20 a day', () => {
    expect(LOOKUPS_PER_MINUTE).toBe(5);
    expect(LOOKUPS_PER_DAY).toBe(20);
  });

  test('the sixth lookup inside one clock minute is refused here with no wire call; when the minute rolls Find returns and the next press goes through', async () => {
    startClock();
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    for (let n = 1; n <= 5; n += 1) {
      await findEmail(tree, `p${n}@x.com`);
      expect(search).toHaveBeenCalledTimes(n);
      expect(has(tree, 'discovery-no-match')).toBe(true);
    }

    await findEmail(tree, 'p6@x.com');
    expect(search).toHaveBeenCalledTimes(5);
    expect(messageOf(tree, 'discovery-paced')).toBe(MINUTE_SENTENCE);
    expect(messageOf(tree, 'discovery-paced')).toBe(COPY.pacedMinute);
    expect(has(tree, 'discovery-no-match')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(false);
    // The go key sends nothing either.
    await submit(tree);
    expect(search).toHaveBeenCalledTimes(5);

    // 59 s in: still the brake. The minute rolls: Find is back on its own.
    await advance(MINUTE - 1);
    expect(has(tree, 'discovery-paced')).toBe(true);
    await advance(1);
    expect(has(tree, 'discovery-paced')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(true);
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(6);
    expect(has(tree, 'discovery-no-match')).toBe(true);
  });

  test('the brake is clock-aligned like the server’s window: lookups late in one minute and early in the next are two windows', async () => {
    startClock('2026-10-08T15:00:50.000Z');
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    for (let n = 1; n <= 5; n += 1) await findEmail(tree, `p${n}@x.com`);
    await advance(10_000);
    for (let n = 6; n <= 10; n += 1) {
      await findEmail(tree, `p${n}@x.com`);
      expect(search).toHaveBeenCalledTimes(n);
    }
    await findEmail(tree, 'p11@x.com');
    expect(search).toHaveBeenCalledTimes(10);
    expect(has(tree, 'discovery-paced')).toBe(true);
  });

  test('only lookups the server answered count: a transport failure, a locally refused shape and a remembered found answer spend nothing', async () => {
    startClock();
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValueOnce({ outcome: 'error' })
      .mockResolvedValueOnce({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 })
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    // Five transport failures: the server never saw them.
    for (let n = 1; n <= 5; n += 1) {
      await findEmail(tree, `p${n}@x.com`);
      expect(has(tree, 'discovery-error')).toBe(true);
    }
    // A malformed address is refused on the device.
    await type(tree, 'mira@');
    await submit(tree);
    expect(has(tree, 'discovery-invalid')).toBe(true);
    // One found, then the same person again and again from memory.
    await findEmail(tree, 'lena@studio.co');
    expect(has(tree, 'discovery-result-card')).toBe(true);
    for (let n = 0; n < 6; n += 1) {
      await typeEach(tree, 'x');
      await findEmail(tree, 'lena@studio.co');
      expect(has(tree, 'discovery-result-card')).toBe(true);
    }
    expect(search).toHaveBeenCalledTimes(6);
    // The first miss of the minute is still sent: one answered lookup so far.
    await findEmail(tree, 'mira@x.com');
    expect(search).toHaveBeenCalledTimes(7);
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-paced')).toBe(false);
  });

  test('the twenty-first lookup of a UTC day is refused here with the day sentence; it does not return with the minute, and a fresh Find meets it again', async () => {
    startClock();
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    for (let n = 1; n <= 20; n += 1) {
      if (n > 1 && (n - 1) % 5 === 0) await advance(MINUTE);
      await findEmail(tree, `p${n}@x.com`);
      expect(search).toHaveBeenCalledTimes(n);
    }
    await advance(MINUTE);
    await findEmail(tree, 'p21@x.com');
    expect(search).toHaveBeenCalledTimes(20);
    expect(messageOf(tree, 'discovery-paced')).toBe(DAY_SENTENCE);
    expect(messageOf(tree, 'discovery-paced')).toBe(COPY.pacedDay(LOOKUPS_PER_DAY));
    expect(has(tree, 'discovery-search')).toBe(false);

    await advance(MINUTE);
    expect(has(tree, 'discovery-paced')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    // An edit brings Find back; its press meets the day's brake again.
    await typeEach(tree, 'x');
    expect(has(tree, 'discovery-search')).toBe(true);
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(20);
    expect(messageOf(tree, 'discovery-paced')).toBe(DAY_SENTENCE);
  });

  test('the brake notice takes screen-reader focus like a miss', async () => {
    startClock();
    const focusSpy = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus');
    const handle = jest.fn((node: unknown) => {
      const n = node as { children?: unknown; props?: { children?: unknown } } | null;
      const children = n?.props?.children ?? n?.children;
      return children === COPY.pacedMinute ? 44 : null;
    });
    const original = Object.getOwnPropertyDescriptor(RN, 'findNodeHandle')!;
    Object.defineProperty(RN, 'findNodeHandle', { configurable: true, get: () => handle });
    try {
      jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
      const tree = await render({
        createNodeMock: element => ({ children: element.props.children }),
      });
      for (let n = 1; n <= 6; n += 1) await findEmail(tree, `p${n}@x.com`);
      expect(has(tree, 'discovery-paced')).toBe(true);
      expect(focusSpy).toHaveBeenLastCalledWith(44);
    } finally {
      Object.defineProperty(RN, 'findNodeHandle', original);
    }
  });
});

/* ── the gate pass (2026-10-08): the ledger is the device’s, not the visit’s ── */

describe('the gate pass: the lookup ledger survives a remount of Open a room', () => {
  test('five lookups, leave, come back: the sixth press in the same minute is refused here with no wire call', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T15:00:00.000Z'));
    const search = jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    const first = await render();
    for (let n = 1; n <= 5; n += 1) await findEmail(first, `p${n}@x.com`);
    expect(search).toHaveBeenCalledTimes(5);
    await ReactTestRenderer.act(async () => {
      first.unmount();
    });
    // Opening a found room, the Link-an-email door or Back unmounts the
    // screen; the day's and the minute's counts are the device's.
    const again = await render();
    await findEmail(again, 'p6@x.com');
    expect(search).toHaveBeenCalledTimes(5);
    expect(messageOf(again, 'discovery-paced')).toBe(COPY.pacedMinute);
    // The minute rolls: the brake lifts on its own, here too.
    await advance(60_000);
    expect(has(again, 'discovery-paced')).toBe(false);
  });

  test('the day’s brake lifts itself at midnight UTC, the minute’s at the minute', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T23:54:30.000Z'));
    const search = jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    // Four clock minutes of five (23:54, 23:55, 23:56, 23:57).
    for (let n = 1; n <= 20; n += 1) {
      if (n > 1 && (n - 1) % 5 === 0) await advance(60_000);
      await findEmail(tree, `p${n}@x.com`);
    }
    expect(search).toHaveBeenCalledTimes(20);
    await findEmail(tree, 'p21@x.com');
    expect(messageOf(tree, 'discovery-paced')).toBe(COPY.pacedDay(LOOKUPS_PER_DAY));
    // 00:00:00Z is 150 s away: the brake lifts without a press, exactly then.
    await advance(150_000 - 1);
    expect(has(tree, 'discovery-paced')).toBe(true);
    await advance(1);
    expect(has(tree, 'discovery-paced')).toBe(false);
    await findEmail(tree, 'p22@x.com');
    expect(search).toHaveBeenCalledTimes(21);
  });
});
