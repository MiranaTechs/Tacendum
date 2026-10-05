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
import * as db from '../src/db';
import { LINKING_COPY } from '../src/linkingCopy';
import { messaging } from '../src/messaging';
import * as reauth from '../src/reauth';
import { COPY, StartChatScreen } from '../src/screens/StartChatScreen';
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
const MISS_EMAIL =
  'No match — or your account is under three days old, or today’s searches are used up. Tacendum cannot tell you which, by design.';
const MISS_NAME =
  'No match — or you’ve used today’s searches. Tacendum cannot tell you which, by design.';

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
});

afterEach(async () => {
  setPlatform(REAL_OS);
  mockUsernameUiEnabled = true;
  session.setMode('real');
  jest.restoreAllMocks();
  await db.close();
});

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
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
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
    let resolveEligibility!: (value: accountsUsername.UsernameEligibilityOutcome) => void;
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockReturnValue(
      new Promise(resolve => {
        resolveEligibility = resolve;
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
      resolveEligibility('eligible');
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
      session.setMode('real');
      const ordinary = await render();
      await findEmail(ordinary, 'lena@studio.co');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
      session.setMode('real');
    }
  });
});

/* ── misses ─────────────────────────────────────────────────────────── */

describe('every miss looks the same, and the copy says so', () => {
  test('after a miss Find is hidden and the go key calls nothing; an edit brings Find back', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await findEmail(tree, 'lena@studio.co');

    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(search).toHaveBeenCalledTimes(1);

    await typeEach(tree, 'x');
    expect(has(tree, 'discovery-no-match')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('a miss, not findable, a recovery pause and a spent budget are one miss on screen', async () => {
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
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
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await findEmail(tree, 'lena@studio.co');
    expect(messageOf(tree, 'discovery-no-match')).toBe(MISS_EMAIL);
    expect(messageOf(tree, 'discovery-no-match')).toContain('under three days old');

    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    expect(messageOf(tree, 'discovery-no-match')).toBe(MISS_NAME);
    expect(messageOf(tree, 'discovery-no-match')).not.toContain('three days');
  });

  test('the miss ⓘ: the email lead and its explainer; the username lead and its explainer', async () => {
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
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

  test('an email miss with no verified email here offers Link an email, which carries the draft; a username miss never does', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const onOpenAccountEmail = jest.fn();
    const tree = await render({ onOpenAccountEmail });

    await findEmail(tree, 'lena@studio.co');
    expect(messageOf(tree, 'discovery-needs-own-email')).toContain(
      'To search, verify an email on your account first.',
    );
    expect(messageOf(tree, 'discovery-needs-own-email')).not.toContain('round-trip');
    await press(tree, 'discovery-link-email');
    expect(onOpenAccountEmail).toHaveBeenCalledWith('lena@studio.co');

    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(has(tree, 'discovery-needs-own-email')).toBe(false);
  });
});

/* ── eligibility ────────────────────────────────────────────────────── */

describe('the username preflight', () => {
  test('needs verification: the deck door and Link an email, the reason behind its ⓘ, never a miss and no lookup', async () => {
    jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('needs_verification');
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

  test('unavailable: Try again forces a fresh read, then looks up', async () => {
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');

    expect(has(tree, 'discovery-username-eligibility-unavailable')).toBe(true);
    expect(byName).not.toHaveBeenCalled();
    await press(tree, 'discovery-username-eligibility-retry');
    expect(eligibility).toHaveBeenCalledTimes(2);
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
    const byName = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const ownName = jest.spyOn(db, 'loadUsernameIdentifier');
    const tree = await render();
    await type(tree, 'alice_7');
    await submit(tree);

    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That isn’t an ID or an email. Check what they sent you.',
    );
    expect(eligibility).not.toHaveBeenCalled();
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
