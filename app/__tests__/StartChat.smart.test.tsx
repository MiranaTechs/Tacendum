/**
 * START A CHAT: ONE SMART FIELD (build 33).
 *
 * This screen is meant to be "easy and smart". One field takes
 * a Tacendum ID, a username or an email, says which before anything happens,
 * and offers only an action whose press can succeed:
 *
 *  - your own ID, verified email or username is caught on the device ("That’s
 *    you"), never on the wire;
 *  - a malformed email or username is refused locally, so it never spends one
 *    of the day's searches;
 *  - nothing is looked up while typing or pasting — only Find or the go key;
 *  - letter-led text waits for a 600 ms settle before it is called a username,
 *    so typing an email is never announced as one first;
 *  - the clipboard is never READ: a paste is the shape of the change.
 *
 * The 400 ms announce and the 600 ms settle are plain timers, so the timing
 * tests advance jest's fake timers and never spy the clock.
 *
 * Harness: the real db over the recorded op-sqlite fake (an INSERT is
 * evidence, and so is its absence), the lookup modules spied per test, and
 * the username pin mocked with a getter so each test reads the current value.
 */

import React from 'react';
import { AccessibilityInfo, Clipboard, Platform, StyleSheet } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import * as accounts from '../src/accounts';
import * as accountsPhone from '../src/accountsPhone';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as db from '../src/db';
import { spellId } from '../src/person';
import { StartChatScreen } from '../src/screens/StartChatScreen';
import { themeTokens } from '../src/theme';
import { PaneWidthProvider } from '../src/windowClass';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

/** The build pin, read through a getter so every render sees the current
 * value (the username-ux pattern). Default ON, the shipped value. */
let mockUsernameUiEnabled = true;
jest.mock('../src/usernameUi', () => ({
  get USERNAME_UI_ENABLED() {
    return mockUsernameUiEnabled;
  },
}));

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      reset: () => void;
      instances: Map<string, { execute: jest.Mock }>;
    };
  }
).__sqlite;

const theme = themeTokens();

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};
const SELF = PROFILE.userId;
const SELF_GROUPED = '01KY DBSS DJSP C9J0 E5N2 AWMJ 5Y';
const PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const GROUPED = '01BX 5ZZK BKAC TAV9 WEVG EMMV RZ';
const READBACK = '01BX 5ZZK BKAC TAV9\nWEVG EMMV RZ';
const ANCHOR = '01HQZZZZ00000000000000000A';
const SHARED = `My Tacendum ID:\n${PEER}\nAdd me in Tacendum → Open a room.`;

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

/** Every `INSERT INTO chats` the screen issued, with its parameters. */
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
});

afterEach(async () => {
  jest.useRealTimers();
  setPlatform(REAL_OS);
  mockUsernameUiEnabled = true;
  jest.restoreAllMocks();
  await db.close();
});

async function render(opts: { width?: number } = {}): Promise<Tree> {
  const screen = (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={jest.fn()}
      onOpenAccountEmail={jest.fn()}
    />
  );
  let tree!: Tree;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      opts.width === undefined ? (
        screen
      ) : (
        <PaneWidthProvider width={opts.width}>{screen}</PaneWidthProvider>
      ),
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** Host nodes only: a testID on a composite also lands on the host it renders. */
function hosts(tree: Tree, id: string): ReactTestInstance[] {
  return tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');
}

function has(tree: Tree, id: string): boolean {
  return hosts(tree, id).length > 0;
}

/** The control itself. PrimaryButton, OutlineButton, TextAction and
 * InfoDisclosure put testID and onPress on the composite AND its Pressable,
 * so the first match is taken rather than a `find` that sees two. */
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

/** Keystrokes: one character per change, so nothing reads as a paste. */
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

async function focus(tree: Tree): Promise<void> {
  await ReactTestRenderer.act(async () => {
    input(tree).props.onFocus();
  });
}

async function blur(tree: Tree): Promise<void> {
  await ReactTestRenderer.act(async () => {
    input(tree).props.onBlur();
  });
}

async function advance(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** A screen-reader user's typing: one character every `perKeyMs`, the clock
 * stepped in 100 ms slices so React renders between timer firings (a row that
 * mounts inside one long advance never gets to start its own 400 ms
 * announce). `each` runs after every keystroke and every slice. */
async function typeSlowly(
  tree: Tree,
  text: string,
  each: () => void = () => undefined,
  perKeyMs = 1200,
): Promise<void> {
  for (const ch of text) {
    await type(tree, `${input(tree).props.value ?? ''}${ch}`);
    each();
    for (let done = 0; done < perKeyMs; done += 100) {
      await advance(100);
      each();
    }
  }
}

/** A promise the test settles by hand: a slow local read or a lookup held
 * open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Every string child under a node, in order. */
function textIn(node: ReactTestInstance): string {
  return node
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => React.Children.toArray(n.props.children))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** The kind label the hint row shows, or null when there is no row. */
function kind(tree: Tree): string | null {
  const node = hosts(tree, 'reach-kind')[0];
  return node ? textIn(node) : null;
}

function messageOf(tree: Tree, id: string): string {
  const node = hosts(tree, id)[0];
  if (!node) throw new Error(`nothing with testID ${id} is on screen`);
  return textIn(node);
}

function rendered(tree: Tree): string {
  return JSON.stringify(tree.toJSON());
}

/* ── That's you ─────────────────────────────────────────────────────── */

describe('your own ID, email or name is caught before anything is sent', () => {
  test('your own ID typed: the self notice offers Show my ID, there is no action button and no write; the go key explains', async () => {
    const tree = await render();
    await typeEach(tree, SELF);

    expect(kind(tree)).toBe('That’s you');
    expect(has(tree, 'start-chat-self')).toBe(true);
    expect(has(tree, 'start-chat-show-my-id')).toBe(true);
    expect(has(tree, 'start-chat')).toBe(false);

    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe('That’s your own ID. Ask them for theirs.');
    // One message at a time: the error replaces the notice.
    expect(has(tree, 'start-chat-self')).toBe(false);
    expect(chatWrites()).toEqual([]);
  });

  test('your own ID inside the pasted message: the self notice, never "Found one ID", and the field in groups', async () => {
    const tree = await render();
    await type(tree, `My Tacendum ID:\n${SELF}\nAdd me in Tacendum → Open a room.`);

    expect(input(tree).props.value).toBe(SELF_GROUPED);
    expect(has(tree, 'start-chat-self')).toBe(true);
    expect(has(tree, 'start-chat-notice')).toBe(false);
  });

  test('your own verified email: the self notice, no Find, the go key explains, and the lookup is never called', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED);
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, 'Me@Example.com');

    expect(kind(tree)).toBe('That’s you');
    expect(has(tree, 'start-chat-self')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That’s your own email. Ask them for theirs.',
    );
    expect(search).not.toHaveBeenCalled();

    // Positive control: somebody else's address reaches the lookup once.
    await type(tree, 'mira@x.com');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('your own username: the self notice, and neither the preflight nor the lookup is called', async () => {
    jest
      .spyOn(db, 'loadUsernameIdentifier')
      .mockResolvedValue({ username: 'alice_7', claimedAt: 1, discoverable: true });
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@Alice_7');

    expect(has(tree, 'start-chat-self')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      ACCOUNTS_USERNAME_COPY.startChatSelfError,
    );
    expect(messageOf(tree, 'start-chat-error')).toContain('your own username');
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();

    // Positive control: another name runs the preflight and the lookup once.
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(byName).toHaveBeenCalledTimes(1);
  });

  test('a pending, unverified email is not yours yet: it is findable like any other', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue({
      ...VERIFIED,
      email: null,
      verifiedAt: null,
      pendingEmail: 'me@example.com',
      pendingRequestedAt: 1,
    });
    const tree = await render();
    await type(tree, 'me@example.com');

    expect(has(tree, 'start-chat-self')).toBe(false);
    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('Show my ID in the self notice opens My ID', async () => {
    const tree = await render();
    await typeEach(tree, SELF);
    await press(tree, 'start-chat-show-my-id');

    expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(true);
    expect(has(tree, 'self-user-id')).toBe(true);
  });

  // Added for build 33: who "you" are is a read on mount. Until it is
  // back, your own email is just an email, so Find used to show and its
  // press spent one of the day's searches on yourself, shown as a miss.
  test('your own email typed before the device has read who you are: no Find, the go key looks nothing up, then That’s you', async () => {
    const own = deferred<db.AccountIdentifierRow | null>();
    jest.spyOn(db, 'loadAccountIdentifier').mockReturnValueOnce(own.promise);
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, 'me@example.com');

    // Not known to be yours yet, so it is named as an email, and nothing that
    // could reach the wire is offered or run.
    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(search).not.toHaveBeenCalled();
    expect(has(tree, 'discovery-no-match')).toBe(false);

    // The read lands: it was yours.
    await ReactTestRenderer.act(async () => {
      own.resolve(VERIFIED);
    });
    expect(kind(tree)).toBe('That’s you');
    expect(has(tree, 'start-chat-self')).toBe(true);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That’s your own email. Ask them for theirs.',
    );
    expect(search).not.toHaveBeenCalled();

    // Positive control: somebody else's address reaches the lookup once.
    await type(tree, 'mira@x.com');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('your own username typed before the claimed name is read: neither the preflight nor the lookup runs', async () => {
    const named = deferred<db.UsernameIdentifierRow | null>();
    jest.spyOn(db, 'loadUsernameIdentifier').mockReturnValueOnce(named.promise);
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@Alice_7');

    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      named.resolve({ username: 'alice_7', claimedAt: 1, discoverable: true });
    });
    expect(kind(tree)).toBe('That’s you');
    expect(has(tree, 'start-chat-self')).toBe(true);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(ACCOUNTS_USERNAME_COPY.startChatSelfError);
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();
  });
});

/* ── detection ──────────────────────────────────────────────────────── */

describe('the field says what it was given before anything happens', () => {
  test('an email reads Email and offers Find', async () => {
    const tree = await render();
    await type(tree, 'mira@x.com');

    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'discovery-search')).toBe(true);
    expect(has(tree, 'start-chat')).toBe(false);
  });

  test('a username reads Username and offers Find only after the settle', async () => {
    jest.useFakeTimers();
    const tree = await render();
    await type(tree, 'mira_k');

    expect(kind(tree)).toBeNull();
    expect(has(tree, 'discovery-search')).toBe(false);
    await advance(600);
    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('pin OFF: no Find for a name and no "username" anywhere on the glass', async () => {
    mockUsernameUiEnabled = false;
    const tree = await render();
    await type(tree, 'mira_k');
    await blur(tree);

    // The positive control first: the pin-OFF sentence is on screen, so the
    // absence below is about a hint that rendered, not one that never did.
    expect(kind(tree)).toBe('Not an ID or email yet');
    expect(has(tree, 'discovery-search')).toBe(false);
    expect(rendered(tree).toLowerCase()).not.toContain('username');
  });

  test('a pasted long email stays as pasted and reads Email; a pasted 27-letter name stays and reads Username — no made-up ID', async () => {
    const tree = await render();
    await type(tree, 'christophermontgomerysmith@example.com');
    expect(input(tree).props.value).toBe('christophermontgomerysmith@example.com');
    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'start-chat-notice')).toBe(false);

    await type(tree, '');
    await type(tree, 'alexandermaximiliandavidson');
    expect(input(tree).props.value).toBe('alexandermaximiliandavidson');
    await blur(tree);
    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'start-chat-notice')).toBe(false);
  });

  test('@Alice_7 and Find: the preflight first, then the lookup with the sigil dropped', async () => {
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, '@Alice_7');

    // @-led text is a username at once, no settle.
    expect(kind(tree)).toBe('Username');
    await press(tree, 'discovery-search');
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(byName).toHaveBeenCalledWith('Alice_7');
    expect(eligibility.mock.invocationCallOrder[0]!).toBeLessThan(
      byName.mock.invocationCallOrder[0]!,
    );
  });

  test('an ID shows its count of 26', async () => {
    const tree = await render();
    await type(tree, '01JA 7Q4M 9X');

    expect(kind(tree)).toBe('Tacendum ID');
    expect(
      tree.root.findAll(n => typeof n.type === 'string' && n.props.children === '10 of 26'),
    ).toHaveLength(1);
  });

  test('unknown text shows no action; a blur shows the hint; the go key explains (pin ON)', async () => {
    const tree = await render();
    await type(tree, 'see you soon');

    expect(input(tree).props.value).toBe('see you soon');
    expect(has(tree, 'start-chat')).toBe(false);
    expect(has(tree, 'discovery-search')).toBe(false);
    expect(kind(tree)).toBeNull();
    await blur(tree);
    expect(kind(tree)).toBe(ACCOUNTS_USERNAME_COPY.startChatUnknown);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      ACCOUNTS_USERNAME_COPY.startChatErrorUnknown,
    );
  });

  test('unknown text, pin OFF: the sentences that never name the class', async () => {
    mockUsernameUiEnabled = false;
    const tree = await render();
    await type(tree, 'see you soon');
    await blur(tree);

    expect(kind(tree)).toBe('Not an ID or email yet');
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That isn’t an ID or an email. Check what they sent you.',
    );
    expect(rendered(tree).toLowerCase()).not.toContain('username');
  });

  test('with the phone class dark, a + number is unknown and reaches no phone lookup', async () => {
    const byPhone = jest.spyOn(accountsPhone, 'discoverySearchByPhone');
    const tree = await render();
    await type(tree, '+15551234567');
    await blur(tree);

    expect(kind(tree)).toBe(ACCOUNTS_USERNAME_COPY.startChatUnknown);
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(byPhone).not.toHaveBeenCalled();
  });
});

/* ── invariants ─────────────────────────────────────────────────────── */

describe('invariants: no lookup while typing, for yourself, or for malformed input', () => {
  test('typing a whole email and a whole name keystroke by keystroke calls nothing; Find calls exactly once', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await typeEach(tree, 'lena@studio.co');
    await type(tree, '');
    await typeEach(tree, '@mira_k');
    expect(search).not.toHaveBeenCalled();
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();

    // Positive controls, one per class.
    await press(tree, 'discovery-search');
    expect(eligibility).toHaveBeenCalledTimes(1);
    expect(byName).toHaveBeenCalledTimes(1);
    await type(tree, 'lena@studio.co');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('a malformed email or name never reaches the wire: there is no Find, and the go key refuses locally', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await type(tree, 'mira@');
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'discovery-invalid')).toBe(
      'That email address isn’t complete. Check it with them.',
    );

    await type(tree, '@a');
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'discovery-invalid')).toBe(ACCOUNTS_USERNAME_COPY.invalid);

    expect(search).not.toHaveBeenCalled();
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();

    // Positive control: the finished address is one lookup.
    await type(tree, 'mira@x');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('the clipboard is never read: not while typing, pasting, copying or opening My ID', async () => {
    const read = jest.spyOn(Clipboard, 'getString');
    read.mockClear();
    const write = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    write.mockClear();
    const tree = await render();

    await typeEach(tree, '01BX');
    await type(tree, SHARED);
    await press(tree, 'show-self-id');
    await press(tree, 'copy-self-id');

    expect(read).not.toHaveBeenCalled();
    // Positive control: the one clipboard call this screen makes is Copy ID.
    expect(write).toHaveBeenCalledWith(SELF);
  });

  test('a typed complete ID regroups on blur and is still recorded as typed (manual)', async () => {
    const tree = await render();
    await typeEach(tree, PEER);
    expect(input(tree).props.value).toBe(PEER);

    await blur(tree);
    expect(input(tree).props.value).toBe(GROUPED);
    await press(tree, 'start-chat');
    await ReactTestRenderer.act(async () => {});

    const writes = chatWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]![1][3]).toBe('manual');
  });

  test('27 characters typed show a red 27 of 26 and no button; the go key explains and writes nothing', async () => {
    const tree = await render();
    await typeEach(tree, `${PEER}X`);

    const counter = hosts(tree, 'reach-counter')[0]!;
    expect(counter.props.children).toBe('27 of 26');
    expect(StyleSheet.flatten(counter.props.style).color).toBe(theme.color.danger);
    expect(has(tree, 'start-chat')).toBe(false);

    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That’s 27 characters — a Tacendum ID is exactly 26.',
    );
    expect(chatWrites()).toEqual([]);
  });

  test('a paste one character too long fills nothing: X+ID reads as a name, ID+X as too long', async () => {
    jest.useFakeTimers();
    const tree = await render();

    await type(tree, `X${PEER}`);
    expect(input(tree).props.value).toBe(`X${PEER}`);
    expect(has(tree, 'start-chat-notice')).toBe(false);
    await advance(600);
    expect(kind(tree)).toBe('Username');

    await type(tree, '');
    await type(tree, `${PEER}X`);
    expect(input(tree).props.value).toBe(`${PEER}X`);
    expect(has(tree, 'start-chat-notice')).toBe(false);
    expect(hosts(tree, 'reach-counter')[0]!.props.children).toBe('27 of 26');
  });
});

/* ── only what can succeed ─────────────────────────────────────────── */

describe('an action appears only when its press can succeed', () => {
  test('an incomplete ID has no button; the go key gives the count; the 26th character brings Open room', async () => {
    const tree = await render();
    await typeEach(tree, PEER.slice(0, 25));

    expect(has(tree, 'start-chat')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'That’s 25 of 26 characters. Ask them for the whole ID.',
    );

    await typeEach(tree, PEER.slice(25));
    expect(has(tree, 'start-chat')).toBe(true);
    expect(has(tree, 'start-chat-error')).toBe(false);
  });

  test('@al has no Find and @ali does; mira@ has none (the go key refuses locally) and mira@x does', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();

    await type(tree, '@al');
    expect(has(tree, 'discovery-search')).toBe(false);
    await type(tree, '@ali');
    expect(has(tree, 'discovery-search')).toBe(true);

    await type(tree, 'mira@');
    expect(has(tree, 'discovery-search')).toBe(false);
    await submit(tree);
    expect(messageOf(tree, 'discovery-invalid')).toBe(
      'That email address isn’t complete. Check it with them.',
    );
    expect(search).not.toHaveBeenCalled();

    await type(tree, 'mira@x');
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  // Added for build 33: the states of the screen's table that had an
  // implementation and no test, one each.
  test('an ID with the letter U: the red rule in the row, no button, and the go key explains it, writing nothing', async () => {
    const tree = await render();
    await type(tree, `${PEER.slice(0, 25)}U`);

    expect(kind(tree)).toBe('Tacendum ID');
    const status = hosts(tree, 'reach-status')[0]!;
    expect(textIn(status)).toBe('An ID never has the letter U');
    expect(StyleSheet.flatten(status.props.style).color).toBe(theme.color.danger);
    expect(hosts(tree, 'reach-kind')[0]!.props.accessibilityLabel).toBe(
      'Tacendum ID, An ID never has the letter U',
    );
    expect(has(tree, 'start-chat')).toBe(false);

    await submit(tree);
    expect(messageOf(tree, 'start-chat-error')).toBe(
      'A Tacendum ID never contains the letter U. Check that character with them.',
    );
    expect(chatWrites()).toEqual([]);
  });

  test('a malformed username shows the rule under the field, offers no Find, and the go key refuses it with no call', async () => {
    const eligibility = jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValue('eligible');
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    // Typed, not pasted: a paste would keep just its one well-formed @name.
    await typeEach(tree, '@abc!');

    expect(kind(tree)).toBe('Username');
    expect(messageOf(tree, 'reach-status')).toBe(ACCOUNTS_USERNAME_COPY.startChatHandleRule);
    expect(messageOf(tree, 'reach-status')).toContain('3 to 32 letters');
    expect(hosts(tree, 'reach-kind')[0]!.props.accessibilityLabel).toBe(
      `Username, ${ACCOUNTS_USERNAME_COPY.startChatHandleRule}`,
    );
    expect(has(tree, 'discovery-search')).toBe(false);

    await submit(tree);
    expect(messageOf(tree, 'discovery-invalid')).toBe(ACCOUNTS_USERNAME_COPY.invalid);
    expect(eligibility).not.toHaveBeenCalled();
    expect(byName).not.toHaveBeenCalled();
  });

  test('Find says what it is doing: Checking… during the preflight, Finding… during the lookup, busy throughout', async () => {
    const preflight = deferred<accountsUsername.UsernameEligibilityOutcome>();
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockReturnValue(preflight.promise);
    const lookup = deferred<Awaited<ReturnType<typeof accountsUsername.discoverySearchByUsername>>>();
    jest.spyOn(accountsUsername, 'discoverySearchByUsername').mockReturnValue(lookup.promise);
    const tree = await render();
    await type(tree, '@mira_k');
    await press(tree, 'discovery-search');

    const checking = hosts(tree, 'discovery-search')[0]!;
    expect(textIn(checking)).toBe('Checking…');
    expect(checking.props.accessibilityState).toEqual({ disabled: true, busy: true });

    await ReactTestRenderer.act(async () => {
      preflight.resolve('eligible');
    });
    const finding = hosts(tree, 'discovery-search')[0]!;
    expect(textIn(finding)).toBe('Finding…');
    expect(finding.props.accessibilityState).toEqual({ disabled: true, busy: true });

    await ReactTestRenderer.act(async () => {
      lookup.resolve({ outcome: 'no_match' });
    });
    expect(has(tree, 'discovery-search')).toBe(false);
    expect(has(tree, 'discovery-no-match')).toBe(true);
  });

  test('Open room failing on this device: the local sentence at the field, no naming step, and Open room stays', async () => {
    jest.spyOn(db, 'upsertChat').mockRejectedValue(new Error('disk full'));
    const tree = await render();
    await typeEach(tree, PEER);
    await press(tree, 'start-chat');
    await ReactTestRenderer.act(async () => {});

    expect(messageOf(tree, 'start-chat-error')).toBe('We couldn’t open this room. Try again.');
    // At the field: the field's own edge turns to the error.
    expect(StyleSheet.flatten(hosts(tree, 'new-peer-field')[0]!.props.style).borderColor).toBe(
      theme.color.danger,
    );
    expect(has(tree, 'peer-nickname-input')).toBe(false);
    expect(has(tree, 'start-chat')).toBe(true);
  });
});

/* ── the settle ─────────────────────────────────────────────────────── */

describe('the settle before letter-led or unknown text is named', () => {
  test('letter-led text waits 600 ms, or a blur, before it says Username and offers Find', async () => {
    jest.useFakeTimers();
    const tree = await render();
    await focus(tree);
    await type(tree, 'alice');

    expect(kind(tree)).toBeNull();
    expect(has(tree, 'discovery-search')).toBe(false);
    await advance(599);
    expect(kind(tree)).toBeNull();
    await advance(1);
    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'discovery-search')).toBe(true);

    // RE-CUT for build 33: an edit that keeps the name keeps the row
    // and its Find. The row used to vanish here and come back after the next
    // pause, which re-announced "Username" after nearly every letter.
    await type(tree, 'alicia');
    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'discovery-search')).toBe(true);

    // An edit that would rename it restarts the wait; a blur ends it at once.
    await type(tree, 'alicia.');
    expect(kind(tree)).toBeNull();
    expect(has(tree, 'discovery-search')).toBe(false);
    await blur(tree);
    expect(kind(tree)).toBe(ACCOUNTS_USERNAME_COPY.startChatUnknown);
  });

  test('@-led text is a username at once', async () => {
    jest.useFakeTimers();
    const tree = await render();
    await type(tree, '@alice');

    expect(kind(tree)).toBe('Username');
    expect(has(tree, 'discovery-search')).toBe(true);
  });

  test('typing an email keystroke by keystroke never shows or announces Username', async () => {
    jest.useFakeTimers();
    setPlatform('ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await focus(tree);

    for (const ch of 'alice@studio.co') {
      await type(tree, `${input(tree).props.value ?? ''}${ch}`);
      const typed = input(tree).props.value as string;
      expect([typed, kind(tree)]).not.toEqual([typed, 'Username']);
      await advance(100);
    }
    await advance(400);

    expect(announce.mock.calls.map(call => call[0])).toEqual(['Email']);
  });
});

/* ── kind announcements ─────────────────────────────────────────────── */

describe('a kind is announced once, and a count never', () => {
  test('iOS: an ID being typed is announced once, 400 ms after the kind appears, and its count never', async () => {
    jest.useFakeTimers();
    setPlatform('ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await focus(tree);

    await typeEach(tree, '01JA7Q4M');
    await advance(399);
    expect(announce).not.toHaveBeenCalled();
    await advance(1);
    expect(announce.mock.calls).toEqual([['Tacendum ID', { queue: true }]]);

    await typeEach(tree, '9XYZ');
    await advance(1000);
    expect(announce.mock.calls.some(([message]) => String(message).includes('of 26'))).toBe(
      false,
    );
    expect(announce).toHaveBeenCalledTimes(1);
  });

  test('while the field is focused an unfinished email is spoken as Email, and the visible hint still says Finish the address', async () => {
    const tree = await render();
    await focus(tree);
    await type(tree, 'mira@');

    expect(hosts(tree, 'reach-kind')[0]!.props.accessibilityLabel).toBe('Email');
    expect(messageOf(tree, 'reach-status')).toBe('Finish the address');
    await blur(tree);
    expect(hosts(tree, 'reach-kind')[0]!.props.accessibilityLabel).toBe(
      'Email, Finish the address',
    );
  });

  test('Android: the kind node is a polite live region that holds only the kind label', async () => {
    setPlatform('android');
    const tree = await render();
    await type(tree, SHARED);

    const node = hosts(tree, 'reach-kind')[0]!;
    expect(node.props.accessibilityLiveRegion).toBe('polite');
    expect(textIn(node)).toBe('Tacendum ID');
    expect(node.props.accessibilityLabel).toBe('Tacendum ID, complete');
  });

  // Added for build 33. The tests above type a key every 100 ms, faster
  // than the 600 ms settle, so they never saw what a screen-reader user
  // types like: a key every second or two. At that speed the row unmounted
  // on every keystroke and mounted again after every pause, and each mount
  // spoke again.
  test('iOS, a key every 1.2 s: each kind is announced once, never again after each pause', async () => {
    jest.useFakeTimers();
    setPlatform('ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await focus(tree);

    await typeSlowly(tree, 'lena@studio.co');

    // The first settled letters are a name (the settle's own rule), then the
    // @ makes it an email: two kinds, two announcements. It used to be
    // ["Username", "Username", "Username", "Username", "Email"].
    expect(announce.mock.calls.map(call => call[0])).toEqual(['Username', 'Email']);
  });

  test('iOS, pin OFF, a key every 1.2 s: the unknown sentence once, then Email', async () => {
    jest.useFakeTimers();
    mockUsernameUiEnabled = false;
    setPlatform('ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await focus(tree);

    await typeSlowly(tree, 'lena@studio.co');

    expect(announce.mock.calls.map(call => call[0])).toEqual([
      'Not an ID or email yet',
      'Email',
    ]);
  });

  test('iOS: a row that comes back with the same words stays quiet; emptying the field starts afresh', async () => {
    jest.useFakeTimers();
    setPlatform('ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    announce.mockClear();
    const tree = await render();
    await focus(tree);

    await typeSlowly(tree, 'lena');
    expect(announce.mock.calls.map(call => call[0])).toEqual(['Username']);
    // A dot hides the row (the text would be renamed), and deleting it
    // inside the wait brings the same row back: nothing new to hear.
    await type(tree, 'lena.');
    await type(tree, 'lena');
    for (let done = 0; done < 1200; done += 100) await advance(100);
    expect(kind(tree)).toBe('Username');
    expect(announce.mock.calls.map(call => call[0])).toEqual(['Username']);

    // A new entry after the field is emptied is announced again.
    await type(tree, '');
    await typeSlowly(tree, 'm');
    expect(announce.mock.calls.map(call => call[0])).toEqual(['Username', 'Username']);
  });

  test('Android, a key every 1.2 s: the kind node stays mounted while the kind holds, one live region throughout', async () => {
    jest.useFakeTimers();
    setPlatform('android');
    const tree = await render();
    await focus(tree);

    await typeSlowly(tree, 'l');
    const node = hosts(tree, 'reach-kind')[0];
    expect(node?.props.accessibilityLabel).toBe('Username');

    // From here until the @, the same node, never unmounted: checked after
    // every keystroke and every 100 ms of every pause.
    const seen: string[] = [];
    await typeSlowly(tree, 'ena', () => {
      const now = hosts(tree, 'reach-kind');
      seen.push(now.length === 1 && now[0] === node ? 'same' : 'remounted');
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(state => state === 'same')).toBe(true);

    // The kind changes: the label in the live region says so.
    await type(tree, 'lena@');
    expect(hosts(tree, 'reach-kind')[0]!.props.accessibilityLabel).toBe('Email');
  });
});

/* ── pane sizing ────────────────────────────────────────────────────── */

describe('the mono size follows the pane', () => {
  test.each([
    [390, 15],
    [375, 14],
    [360, 13],
  ])('at a %ipt pane an ID is mono %i, and an email keeps the input role', async (width, size) => {
    const tree = await render({ width });
    await type(tree, SHARED);
    const idStyle = StyleSheet.flatten(input(tree).props.style);
    expect(idStyle.fontSize).toBe(size);
    expect(idStyle.fontFamily).toBe(theme.mono);

    await type(tree, 'mira@x.com');
    const emailStyle = StyleSheet.flatten(input(tree).props.style);
    expect(emailStyle.fontSize).toBe(theme.type.input.fontSize);
    expect(emailStyle.fontFamily).toBeUndefined();
  });
});

/* ── the read-back ──────────────────────────────────────────────────── */

describe('a complete ID is read back in two lines of groups', () => {
  test('after the shared message is pasted, the read-back holds the ID four groups, a break, three, spelled for VoiceOver', async () => {
    const tree = await render();
    await type(tree, SHARED);

    const node = hosts(tree, 'reach-id-readback')[0]!;
    expect(node.props.children).toBe(READBACK);
    expect(node.props.accessibilityLabel).toBe(spellId(PEER));
    expect(node.props.maxFontSizeMultiplier).toBe(2);
  });

  test('no read-back for an incomplete ID, your own ID, an email, a name or unknown text', async () => {
    const tree = await render();
    for (const text of [PEER.slice(0, 20), SELF, 'mira@x.com', '@mira_k', 'see you soon']) {
      await type(tree, '');
      await type(tree, text);
      await blur(tree);
      expect([text, has(tree, 'reach-id-readback')]).toEqual([text, false]);
    }
  });
});

/* ── clear ──────────────────────────────────────────────────────────── */

describe('the field’s own clear button', () => {
  test('absent while empty, present after one character', async () => {
    const tree = await render();
    expect(has(tree, 'new-peer-clear')).toBe(false);
    await type(tree, 'a');
    expect(has(tree, 'new-peer-clear')).toBe(true);
  });

  test('Clear empties the field, every answer and a found card, and puts focus back in the field', async () => {
    jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const tree = await render();
    const field = tree.root.findAll(
      n =>
        n.props.testID === 'new-peer-input' &&
        n.instance != null &&
        typeof n.instance.focus === 'function',
    )[0]!;
    const focusSpy = jest.fn();
    field.instance.focus = focusSpy;

    await type(tree, 'lena@studio.co');
    await press(tree, 'discovery-search');
    expect(has(tree, 'discovery-result-card')).toBe(true);

    await press(tree, 'new-peer-clear');
    expect(input(tree).props.value).toBe('');
    expect(has(tree, 'discovery-result-card')).toBe(false);
    expect(has(tree, 'new-peer-clear')).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // An answer goes with it too.
    await type(tree, SHARED);
    expect(has(tree, 'start-chat-notice')).toBe(true);
    await press(tree, 'new-peer-clear');
    expect(has(tree, 'start-chat-notice')).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });
});

/* ── paste fill ─────────────────────────────────────────────────────── */

describe('a paste with no ID fills its one address', () => {
  test('"Email: lena@studio.co" leaves just the address, reads Email with Find, and calls nothing', async () => {
    const search = jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'no_match' });
    const tree = await render();
    await type(tree, 'Email: lena@studio.co');

    expect(input(tree).props.value).toBe('lena@studio.co');
    expect(kind(tree)).toBe('Email');
    expect(has(tree, 'discovery-search')).toBe(true);
    expect(has(tree, 'start-chat-notice')).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  test('your own ID beside one other fills the other, in groups, with the check-it notice', async () => {
    const tree = await render();
    await type(tree, `Mine: ${SELF} theirs: ${PEER}`);

    expect(input(tree).props.value).toBe(GROUPED);
    expect(messageOf(tree, 'start-chat-notice')).toBe(
      'Found one ID in what you pasted. Check it with them, then open the room.',
    );
  });
});
