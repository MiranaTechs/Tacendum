/**
 * BUILD 24 — the two field reports of build 23 on the client side:
 *
 *  1. "On the simulator it never succeeds": thirteen "try again later"s for
 *     names the server refused BY DESIGN (a different name after an unlink
 *     waits 30 days; then the day's claim budget). The wire never says why,
 *     so the claim form now says what THIS device can know BEFORE the tap —
 *     the account's age (from the server-minted ID), a verified email or
 *     phone number (from its own rows), and the cool-down of the unlink it
 *     performed (from its own memory) — each its own sentence, none a block.
 *
 *  2. "Where is find-by-username?": the Start a chat door said "Find by
 *     email", the room it opens defaulted to the Email chip, and the held
 *     name never said how anyone reaches it. Under the pin the door names
 *     both classes, a bare handle typed with no chip chosen runs the
 *     username lookup with the chip lit, and the held state names the door.
 *
 * Pin OFF stays byte-identical on every surface touched here.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ulid } from 'ulid';
import * as accounts from '../src/accounts';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as db from '../src/db';
import { AccountUsernameScreen } from '../src/screens/AccountUsernameScreen';
import { DiscoveryScreen } from '../src/screens/DiscoveryScreen';
import { StartChatScreen } from '../src/screens/StartChatScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

let mockUsernameUiEnabled = true;
jest.mock('../src/usernameUi', () => ({
  get USERNAME_UI_ENABLED() {
    return mockUsernameUiEnabled;
  },
}));

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = 1_756_000_000_000;
const ANCHOR = '01HQZZZZ00000000000000000A';
const HELD: db.UsernameIdentifierRow = { username: 'alice_7', claimedAt: 1, discoverable: true };
const EMAIL_ROW: db.AccountIdentifierRow = {
  email: 'alice@example.com',
  verifiedAt: 1,
  discoverable: false,
  pendingEmail: null,
  pendingRequestedAt: null,
  restoredAt: null,
};
/** A profile whose ID the server minted `ageMs` ago — the ULID's time half
 * IS the server's createdAt stamp, so the device can count from it. */
const profileAged = (ageMs: number): db.ProfileRow => ({
  userId: ulid(NOW_MS - ageMs),
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
});

async function render(el: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  text: string,
): Promise<void> {
  const input = tree.root
    .findAllByProps({ testID })
    .find(n => n.props.onChangeText !== undefined)!;
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText(text);
  });
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;

const rendered = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  JSON.stringify(tree.toJSON());

const chipSelected = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root
    .findAllByProps({ testID })
    .find(n => n.props.accessibilityState !== undefined)!.props.accessibilityState.selected;

function stubRows(opts: {
  row?: db.UsernameIdentifierRow | null;
  email?: db.AccountIdentifierRow | null;
  profile?: db.ProfileRow | null;
  unlink?: db.UsernameUnlinkRow | null;
}): void {
  jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => opts.row ?? null);
  jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
  jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => opts.email ?? null);
  jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
  jest.spyOn(db, 'loadProfile').mockImplementation(async () => opts.profile ?? null);
  jest.spyOn(db, 'loadUsernameUnlink').mockImplementation(async () => opts.unlink ?? null);
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  mockUsernameUiEnabled = true;
  jest.restoreAllMocks();
});

/* ── 1. the age gate, counted from the server-minted ID ─────────────── */

describe('the age gate is counted from the ID the server minted, and said before the tap', () => {
  it('the module: hours still to wait, 0 once the 72 h have passed, null for an ID that does not decode', () => {
    expect(accountsUsername.usernameClaimWaitHours(ulid(NOW_MS - HOUR_MS), NOW_MS)).toBe(71);
    expect(accountsUsername.usernameClaimWaitHours(ulid(NOW_MS - 71.5 * HOUR_MS), NOW_MS)).toBe(1);
    expect(accountsUsername.usernameClaimWaitHours(ulid(NOW_MS - 72 * HOUR_MS), NOW_MS)).toBe(0);
    expect(accountsUsername.usernameClaimWaitHours(ulid(NOW_MS - 400 * DAY_MS), NOW_MS)).toBe(0);
    expect(accountsUsername.usernameClaimWaitHours('01HQSELF000000000000000000', NOW_MS)).toBeNull();
    expect(accountsUsername.usernameClaimWaitHours('', NOW_MS)).toBeNull();
  });

  it('a young account sees the 3-day sentence with the wait — the form stays, the server is the gate', async () => {
    stubRows({ email: EMAIL_ROW, profile: profileAged(60 * HOUR_MS) });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-age')).toBe(true);
    const text = rendered(tree);
    expect(text).toContain('Your account needs to be 3 days old to claim a username.');
    expect(text).toContain('about 12 hours');
    // The identifier sentence is quiet: an email IS verified here.
    expect(has(tree, 'account-username-needs-identifier')).toBe(false);
    // Surfaced, never enforced.
    expect(has(tree, 'account-username-input')).toBe(true);
    tree.unmount();
  });

  it('the wait is said in rounded days past 48 h; an aged account and an undecodable ID are both quiet', async () => {
    expect(ACCOUNTS_USERNAME_COPY.needsAge(52)).toContain('about 2 days');
    expect(ACCOUNTS_USERNAME_COPY.needsAge(1)).toContain('about 1 hour.');
    // A CONDITION, never a promise (gate fix): the age is one of several
    // server gates, so the sentence says when the three days end and never
    // that a claim will land.
    expect(ACCOUNTS_USERNAME_COPY.needsAge(12)).toContain('the three days are up in about 12 hours.');
    expect(ACCOUNTS_USERNAME_COPY.needsAge(12)).not.toMatch(/will go through|will succeed|will land/);
    stubRows({ email: EMAIL_ROW, profile: profileAged(10 * HOUR_MS) });
    const young = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(young)).toContain('about 3 days');
    young.unmount();
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    stubRows({ email: EMAIL_ROW, profile: profileAged(4 * DAY_MS) });
    const aged = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(aged, 'account-username-needs-age')).toBe(false);
    aged.unmount();
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    stubRows({ email: EMAIL_ROW, profile: { ...profileAged(0), userId: '01HQSELF000000000000000000' } });
    const unknown = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(unknown, 'account-username-needs-age')).toBe(false);
    unknown.unmount();
  });

  it('no verified identifier: the sentence leads with the step to take, and still names the three days', async () => {
    stubRows({ profile: profileAged(4 * DAY_MS) });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-identifier')).toBe(true);
    expect(rendered(tree)).toContain('Link and verify an email address or phone number first');
    expect(rendered(tree)).toContain('three days old');
    tree.unmount();
  });
});

/* ── 2. the unlink memory ───────────────────────────────────────────── */

describe('the unlink memory: written by the module on a landed unlink, cleared by the next landed claim, read by the form', () => {
  function deps(held: db.UsernameIdentifierRow | null, claimStatus?: number) {
    const unlinks: db.UsernameUnlinkRow[] = [];
    const clears: number[] = [];
    return {
      unlinks,
      clears,
      deps: {
        api: {
          usernameClaim: async () => {
            if (claimStatus !== undefined) {
              const { ApiRequestError } = jest.requireActual('../src/api') as typeof import('../src/api');
              throw new ApiRequestError('x', claimStatus, 'accounts_refused');
            }
          },
          usernameRename: async () => undefined,
          usernameUnlink: async () => undefined,
          setUsernameDiscoverable: async () => undefined,
          discoveryLookupUsername: async () => ({ members: [], rosterVersion: 1 }),
        },
        db: {
          loadUsernameIdentifier: async () => held,
          saveUsernameIdentifier: async () => undefined,
          clearUsernameIdentifier: async () => undefined,
          saveUsernameUnlink: async (row: db.UsernameUnlinkRow) => {
            unlinks.push({ ...row });
          },
          clearUsernameUnlink: async () => {
            clears.push(1);
          },
        },
        token: async () => 'bearer',
        now: () => NOW_MS,
      },
    };
  }

  it('unlink records the name it let go and the moment; a landed claim clears the memory; a refused claim leaves it', async () => {
    const u = deps(HELD);
    expect(await accountsUsername.unlinkUsername(u.deps)).toBe('ok');
    expect(u.unlinks).toEqual([{ username: 'alice_7', unlinkedAt: NOW_MS }]);
    const c = deps(null);
    expect(await accountsUsername.claimUsername('alice_7', true, c.deps)).toBe('claimed');
    expect(c.clears).toEqual([1]);
    const r = deps(null, 403);
    expect(await accountsUsername.claimUsername('alice_9', true, r.deps)).toBe('refused');
    expect(r.clears).toEqual([]);
    expect(r.unlinks).toEqual([]);
  });

  it('an unlink with NO readable local row (claimed on a sibling, row wiped) still records the moment — with an empty name, since the wire never echoes one', async () => {
    const u = deps(null);
    expect(await accountsUsername.unlinkUsername(u.deps)).toBe('ok');
    expect(u.unlinks).toEqual([{ username: '', unlinkedAt: NOW_MS }]);
    // A refused unlink writes nothing, row or no row.
    const refused = deps(null);
    refused.deps.api.usernameUnlink = async () => {
      const { ApiRequestError } = jest.requireActual('../src/api') as typeof import('../src/api');
      throw new ApiRequestError('x', 403, 'accounts_refused');
    };
    expect(await accountsUsername.unlinkUsername(refused.deps)).toBe('refused');
    expect(refused.unlinks).toEqual([]);
  });

  it('the module: the cool-down holds for 30 days from the unlink and not a moment longer', () => {
    const row = { username: 'alice_7', unlinkedAt: NOW_MS - 29 * DAY_MS };
    expect(accountsUsername.unlinkCooldownActive(row, NOW_MS)).toBe(true);
    expect(accountsUsername.unlinkCooldownActive({ ...row, unlinkedAt: NOW_MS - 30 * DAY_MS }, NOW_MS)).toBe(false);
  });

  it('a later visit reads the persisted memory: the claim form warns, names the reclaimable name, and says 30 days', async () => {
    stubRows({ email: EMAIL_ROW, profile: profileAged(4 * DAY_MS), unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS } });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown')).toBe(true);
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink('alice_7'));
    expect(text).toContain('30 days');
    expect(text).toContain('alice_7 itself can be taken back');
    expect(has(tree, 'account-username-input')).toBe(true);
    tree.unmount();
  });

  it('a memory with an empty name still warns: the rule and the reclaim fact stand, no name is invented', async () => {
    stubRows({ email: EMAIL_ROW, profile: profileAged(4 * DAY_MS), unlink: { username: '', unlinkedAt: NOW_MS - DAY_MS } });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown')).toBe(true);
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink(''));
    expect(text).toContain('30 days');
    expect(text).toContain('Only the exact name you removed can be taken back');
    expect(text).not.toContain(' itself can be taken back');
    expect(text).not.toContain('You removed  ');
    expect(has(tree, 'account-username-input')).toBe(true);
    tree.unmount();
  });

  it('an unlink older than 30 days is silent, and a held name never shows the unlink warning', async () => {
    stubRows({ email: EMAIL_ROW, unlink: { username: 'alice_7', unlinkedAt: NOW_MS - 31 * DAY_MS } });
    const stale = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(stale, 'account-username-cooldown')).toBe(false);
    stale.unmount();
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    stubRows({ row: HELD, email: EMAIL_ROW, unlink: { username: 'bob', unlinkedAt: NOW_MS - DAY_MS } });
    const held = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(held, 'account-username-cooldown')).toBe(false);
    held.unmount();
  });

  it('a landed claim on the surface takes the warning down', async () => {
    stubRows({ email: EMAIL_ROW, profile: profileAged(4 * DAY_MS), unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS } });
    jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('claimed');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown')).toBe(true);
    await type(tree, 'account-username-input', 'alice_7');
    await press(tree, 'account-username-submit');
    expect(has(tree, 'account-username-cooldown')).toBe(false);
    tree.unmount();
  });
});

/* ── 3. the held state names the door ───────────────────────────────── */

describe('the held state says HOW others reach the name', () => {
  it('findable: the door is named; unfindable: the opposite sentence stands alone', async () => {
    stubRows({ row: HELD, email: EMAIL_ROW });
    const findable = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(findable, 'account-username-how-found')).toBe(true);
    expect(rendered(findable)).toContain(ACCOUNTS_USERNAME_COPY.howFound);
    expect(rendered(findable)).toContain('Find by email or username');
    findable.unmount();
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    stubRows({ row: { ...HELD, discoverable: false }, email: EMAIL_ROW });
    const hidden = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(hidden, 'account-username-how-found')).toBe(false);
    expect(has(hidden, 'account-username-unfindable')).toBe(true);
    hidden.unmount();
  });
});

/* ── 4. the Start a chat door ───────────────────────────────────────── */

describe('the Start a chat door names the class the room offers', () => {
  const PROFILE: db.ProfileRow = {
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    registrationId: 7,
    displayName: '',
    about: '',
    avatarB64: '',
    profileVersion: 0,
  };
  const screen = () => (
    <StartChatScreen profile={PROFILE} onBack={jest.fn()} onOpenChat={jest.fn()} onFindByEmail={jest.fn()} />
  );

  it('pin ON: the row, its helper and the no-directory sentence come from the deck; the door and its wiring are unchanged', async () => {
    const tree = await render(screen());
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.startChatFind);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.startChatFindHelper);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.startChatNoDirectory);
    expect(text).toContain('no public directory');
    expect(text.includes('"Find by email"')).toBe(false);
    const door = tree.root.findAllByProps({ testID: 'find-by-email' }).find(n => n.props.onPress !== undefined)!;
    expect(door.props.accessibilityLabel).toBe(ACCOUNTS_USERNAME_COPY.startChatFind);
    tree.unmount();
  });

  it('pin OFF: the landed sentences, and no username wording anywhere on the glass', async () => {
    mockUsernameUiEnabled = false;
    const tree = await render(screen());
    const text = rendered(tree);
    expect(text).toContain('Find by email');
    expect(text).toContain('Works only for someone who verified an email and turned findability on.');
    expect(text.toLowerCase().includes('username')).toBe(false);
    tree.unmount();
  });
});

/* ── 5. the preselect ───────────────────────────────────────────────── */

describe('the find flow: a bare handle typed with no chip chosen runs the username lookup, chip lit; a tapped chip is final', () => {
  function stubFinder() {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const byEmail = jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    const byName = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    return { byEmail, byName };
  }

  it('username-shaped → the username lookup, the Username chip lit and the header renamed before the card', async () => {
    const { byEmail, byName } = stubFinder();
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    expect(chipSelected(tree, 'discovery-class-email')).toBe(true);
    await type(tree, 'discovery-input', ' Alice_7 ');
    await press(tree, 'discovery-search');
    expect(byName).toHaveBeenCalledWith('Alice_7');
    expect(byEmail).not.toHaveBeenCalled();
    expect(chipSelected(tree, 'discovery-class-username')).toBe(true);
    expect(chipSelected(tree, 'discovery-class-email')).toBe(false);
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.findTitle);
    expect(text).toContain('Start a chat with Alice_7?');
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.findTofu);
    // Still no chip tapped: an email-shaped edit moves it back.
    await type(tree, 'discovery-input', 'bob@example.com');
    await press(tree, 'discovery-search');
    expect(byEmail).toHaveBeenCalledWith('bob@example.com');
    expect(chipSelected(tree, 'discovery-class-email')).toBe(true);
    tree.unmount();
  });

  it('a tapped Email chip is a decision: the same handle runs the email lookup and the chip stays', async () => {
    const { byEmail, byName } = stubFinder();
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    await press(tree, 'discovery-class-email');
    await type(tree, 'discovery-input', 'alice_7');
    await press(tree, 'discovery-search');
    expect(byEmail).toHaveBeenCalledWith('alice_7');
    expect(byName).not.toHaveBeenCalled();
    expect(chipSelected(tree, 'discovery-class-email')).toBe(true);
    tree.unmount();
  });

  it('pin OFF: nothing moves — the handle runs the email lookup and no chip row exists', async () => {
    mockUsernameUiEnabled = false;
    const { byEmail, byName } = stubFinder();
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    expect(has(tree, 'discovery-class-username')).toBe(false);
    await type(tree, 'discovery-input', 'alice_7');
    await press(tree, 'discovery-search');
    expect(byEmail).toHaveBeenCalledWith('alice_7');
    expect(byName).not.toHaveBeenCalled();
    expect(rendered(tree).toLowerCase().includes('username')).toBe(false);
    tree.unmount();
  });
});
