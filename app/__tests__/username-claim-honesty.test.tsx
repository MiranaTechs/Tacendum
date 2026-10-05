/**
 * BUILD 24 — the two field reports of build 23 on the client side:
 *
 *  1. "On the simulator it never succeeds": thirteen "try again later"s for
 *     names the server refused BY DESIGN (a different name after an unlink
 *     waits 30 days; then the day's claim budget). The wire never says why,
 *     so the claim form now says what can be known BEFORE the tap — the
 *     caller group's authoritative verified email/phone eligibility and the
 *     cool-down of the unlink this device performed.
 *
 *  2. "Where is find-by-username?": the Start a chat door said "Find by
 *     email", the room it opens defaulted to the Email chip, and the held
 *     name never said how anyone reaches it. Under the pin the door named
 *     both classes, a bare handle typed with no chip chosen runs the
 *     username lookup with the chip lit, and the held state names the door.
 *     Build 33 replaced the door with Start a chat's one smart field: under
 *     the pin its placeholder and ⓘ name both classes; pin OFF they name
 *     neither.
 *
 * Pin OFF stays byte-identical on every surface touched here.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
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

const DAY_MS = 24 * 3_600_000;
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
  unlink?: db.UsernameUnlinkRow | null;
}): void {
  jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => opts.row ?? null);
  jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
  jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => opts.email ?? null);
  jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
  jest.spyOn(db, 'loadUsernameUnlink').mockImplementation(async () => opts.unlink ?? null);
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
});

afterEach(() => {
  mockUsernameUiEnabled = true;
  jest.restoreAllMocks();
});

/* ── 1. authoritative group-level eligibility ─────────────────────── */

describe('the caller-owned eligibility read', () => {
  it('maps only an explicit proof boolean to an eligible answer; token and wire failures stay unavailable', async () => {
    jest.restoreAllMocks();
    const deps = (answer: boolean): accountsUsername.UsernameEligibilityDeps => ({
      api: { usernameEligibility: async () => ({ hasVerifiedIdentifier: answer }) },
      token: async () => 'bearer',
    });
    expect(await accountsUsername.getUsernameEligibility(deps(true))).toBe('eligible');
    expect(await accountsUsername.getUsernameEligibility(deps(false))).toBe('needs_verification');
    expect(
      await accountsUsername.getUsernameEligibility({
        api: { usernameEligibility: async () => ({ hasVerifiedIdentifier: true }) },
        token: async () => null,
      }),
    ).toBe('unavailable');
    expect(
      await accountsUsername.getUsernameEligibility({
        api: { usernameEligibility: async () => { throw new Error('offline'); } },
        token: async () => 'bearer',
      }),
    ).toBe('unavailable');
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
    stubRows({ email: EMAIL_ROW, unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS } });
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
    stubRows({ email: EMAIL_ROW, unlink: { username: '', unlinkedAt: NOW_MS - DAY_MS } });
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
    stubRows({ email: EMAIL_ROW, unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS } });
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
    // Reworded for build 33: the door is gone, the field itself finds names.
    expect(ACCOUNTS_USERNAME_COPY.howFound).toContain('open a room');
    expect(ACCOUNTS_USERNAME_COPY.howFound).not.toContain('→');
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

/* ── 4. the Start a chat field ──────────────────────────────────────── */

// Rewritten for build 33: the "Find by email or username" door is replaced
// by the smart field. Its words come from the deck under the pin, and the
// pin-OFF byte guarantee is kept with a positive control.
describe('the Start a chat field names the classes this binary can find', () => {
  const PROFILE: db.ProfileRow = {
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    registrationId: 7,
    displayName: '',
    about: '',
    avatarB64: '',
    profileVersion: 0,
  };
  const screen = () => (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={jest.fn()}
      onOpenAccountEmail={jest.fn()}
    />
  );
  const field = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByProps({ testID: 'new-peer-input' })
      .find(n => n.props.onChangeText !== undefined)!;

  it('pin ON: the placeholder and the field’s name come from the deck; the ⓘ names both classes; there is no door', async () => {
    const tree = await render(screen());
    expect(field(tree).props.placeholder).toBe('Paste their ID, username or email');
    expect(field(tree).props.placeholder).toBe(ACCOUNTS_USERNAME_COPY.startChatFieldPlaceholder);
    expect(field(tree).props.accessibilityLabel).toBe(ACCOUNTS_USERNAME_COPY.startChatFieldLabel);
    expect(has(tree, 'find-by-email')).toBe(false);

    await press(tree, 'start-chat-info');
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.startChatNoDirectory);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.startChatFindScope);
    expect(text).toContain('no public directory');
    tree.unmount();
  });

  it('pin OFF: the email-only sentences, and no username wording anywhere — the ⓘ open, after typing and blurring, and after the go key', async () => {
    mockUsernameUiEnabled = false;
    const tree = await render(screen());
    expect(field(tree).props.placeholder).toBe('Paste their ID or email');

    await press(tree, 'start-chat-info');
    let text = rendered(tree);
    expect(text).toContain('Tacendum has no public directory. A room starts with a Tacendum ID one person hands the other — or with the email of someone who chose to be found.');
    expect(text).toContain('An email finds only someone who verified it and chose to be found. Searches are limited each day.');
    expect(text.toLowerCase().includes('username')).toBe(false);

    await type(tree, 'new-peer-input', 'alice_7');
    await ReactTestRenderer.act(async () => {
      field(tree).props.onBlur();
    });
    text = rendered(tree);
    // The positive control: the pin-OFF hint IS on screen, so the absence
    // below is about a sentence that rendered, not one that never did.
    expect(text).toContain('Not an ID or email yet');
    expect(text.toLowerCase().includes('username')).toBe(false);

    await ReactTestRenderer.act(async () => {
      field(tree).props.onSubmitEditing();
    });
    text = rendered(tree);
    expect(text).toContain('That isn’t an ID or an email. Check what they sent you.');
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
    expect(text).toContain('Open a room with Alice_7?');
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

/* ── 6. the consent box on the CLAIM form ── */

describe('unchecking consent on the CLAIM form says what a claim with findability off means', () => {
  it('never "You hold this name" before the name is held', async () => {
    stubRows({ email: EMAIL_ROW });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.claimUnfindable);
    await press(tree, 'account-username-consent');
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.claimUnfindable);
    expect(text).not.toContain('You hold this name');
    tree.unmount();
  });

  it('the held state keeps its own sentence, on the surface and on the rename form', async () => {
    stubRows({ row: { ...HELD, discoverable: false }, email: EMAIL_ROW });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldUnfindable);
    // A rename seeds the box from the row (unfindable → unchecked): the
    // sentence under it is still about the name that IS held.
    await press(tree, 'account-username-rename');
    const text = rendered(tree);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.heldUnfindable);
    expect(text).not.toContain(ACCOUNTS_USERNAME_COPY.claimUnfindable);
    tree.unmount();
  });
});

/* ── 7. the proof precondition stops inviting a doomed tap ─────────── */

describe('the authoritative claim precondition', () => {
  it('missing group proof shows the verification door and disables claim', async () => {
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    stubRows({});
    const onOpenAccountEmail = jest.fn();
    const tree = await render(
      <AccountUsernameScreen onBack={jest.fn()} onOpenAccountEmail={onOpenAccountEmail} />,
    );
    expect(has(tree, 'account-username-needs-identifier')).toBe(true);
    expect(has(tree, 'account-username-input')).toBe(true);
    await type(tree, 'account-username-input', 'alice_7');
    const submit = tree.root
      .findAllByProps({ testID: 'account-username-submit' })
      .find(n => n.props.disabled !== undefined)!;
    expect(submit.props.disabled).toBe(true);
    await press(tree, 'account-username-link-email');
    expect(onOpenAccountEmail).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('without the door wired, the sentence stands alone', async () => {
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    stubRows({});
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-identifier')).toBe(true);
    expect(has(tree, 'account-username-link-email')).toBe(false);
    tree.unmount();
  });

  it('an unavailable eligibility read says connection, keeps claim disabled, and Retry rechecks', async () => {
    jest
      .spyOn(accountsUsername, 'getUsernameEligibility')
      .mockResolvedValueOnce('unavailable')
      .mockResolvedValue('eligible');
    stubRows({});
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await type(tree, 'account-username-input', 'alice_7');
    expect(has(tree, 'account-username-eligibility-unavailable')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.eligibilityUnavailable);
    const submit = () =>
      tree.root.findAllByProps({ testID: 'account-username-submit' }).find(n => n.props.disabled !== undefined)!;
    expect(submit().props.disabled).toBe(true);
    await press(tree, 'account-username-eligibility-retry');
    expect(has(tree, 'account-username-eligibility-unavailable')).toBe(false);
    expect(submit().props.disabled).toBe(false);
    tree.unmount();
  });

  it('proof removal never disables consent or unlink cleanup for a held name', async () => {
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    stubRows({ row: HELD });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-identifier')).toBe(false);
    await press(tree, 'account-username-unlink');
    expect(has(tree, 'account-username-unlink-confirm')).toBe(true);
    tree.unmount();
  });
});
