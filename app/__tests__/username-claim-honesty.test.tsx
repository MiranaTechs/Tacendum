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
import * as api from '../src/api';
import * as db from '../src/db';
import * as reauth from '../src/reauth';
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

/** The claim surface reads the caller-owned STATE (fix/username-discovery,
 * 2026-10-08); the find surfaces still read the legacy eligibility. Both
 * stubbed eligible, every sibling fact UNKNOWN (null) — the one-device
 * world of the cases above; section 8 stubs the facts it needs. */
const STATE_ELIGIBLE_DEFAULT: accountsUsername.IdentifierState = {
  source: 'state',
  eligibility: 'eligible',
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
};
beforeEach(() => {
  // The identifier-route pacing ledger is module state on a trailing minute;
  // with the clock pinned it never rolls, so every case starts it empty.
  accountsUsername.clearIdentifierRoutePacing();
  accountsUsername.invalidateIdentifierState();
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
  jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(STATE_ELIGIBLE_DEFAULT);
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
          loadUsernameCooldown: async () => null,
          saveUsernameCooldown: async () => undefined,
          clearUsernameCooldown: async () => undefined,
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
  it('missing group proof shows the verification door and withholds the claim form', async () => {
    // Re-cut 2026-10-08 (U6): the form used to render under a permanently
    // grey button; the reason and the door now stand alone.
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue({ ...STATE_ELIGIBLE_DEFAULT, eligibility: 'needs_verification' });
    stubRows({});
    const onOpenAccountEmail = jest.fn();
    const tree = await render(
      <AccountUsernameScreen onBack={jest.fn()} onOpenAccountEmail={onOpenAccountEmail} />,
    );
    expect(has(tree, 'account-username-needs-identifier')).toBe(true);
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(has(tree, 'account-username-submit')).toBe(false);
    await press(tree, 'account-username-link-email');
    expect(onOpenAccountEmail).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('without the door wired, the sentence stands alone', async () => {
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue({ ...STATE_ELIGIBLE_DEFAULT, eligibility: 'needs_verification' });
    stubRows({});
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-identifier')).toBe(true);
    expect(has(tree, 'account-username-link-email')).toBe(false);
    tree.unmount();
  });

  it('a failed state read says connection, keeps claim disabled, and Retry rechecks', async () => {
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValueOnce({ ...STATE_ELIGIBLE_DEFAULT, eligibility: 'failed' })
      .mockResolvedValue(STATE_ELIGIBLE_DEFAULT);
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
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue({ ...STATE_ELIGIBLE_DEFAULT, eligibility: 'needs_verification' });
    stubRows({ row: HELD });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-needs-identifier')).toBe(false);
    await press(tree, 'account-username-unlink');
    expect(has(tree, 'account-username-unlink-confirm')).toBe(true);
    tree.unmount();
  });
});

/* ── 8. fix/username-discovery (2026-10-08): U1 — the linked sibling ──── */

/**
 * THE FOUNDER'S REPORT (2026-10-08): on a linked sibling (the iPad, a
 * reinstalled phone) the screen read as if the account had never set a
 * name — the empty claim form, the held name refused as "try again later",
 * a different name silently RENAMING the account. The server never echoes
 * a name (§4.9) and the rows do not sync, so the only honest source of
 * "does this account hold a name" is the caller-owned state read.
 */
const STATE_ELIGIBLE: accountsUsername.IdentifierState = {
  source: 'state',
  eligibility: 'eligible',
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
};
const stateOf = (
  partial: Partial<accountsUsername.IdentifierState>,
): accountsUsername.IdentifierState => ({ ...STATE_ELIGIBLE, ...partial });

describe('U1: a linked sibling with no local row on a group that holds a name', () => {
  it('never renders the claim form and never sends /claim: the held-elsewhere state, Change = the rename form sent as /rename with the consent bit explicit', async () => {
    const device = { row: null as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'saveUsernameIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    jest.spyOn(db, 'clearUsernameUnlink').mockResolvedValue(undefined);
    jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockImplementation(async () =>
        stateOf({ holdsUsername: true, emailLinked: true, phoneLinked: false }),
      );
    const claim = jest.spyOn(api, 'apiClaimUsername').mockResolvedValue(undefined);
    const rename = jest.spyOn(api, 'apiRenameUsername').mockResolvedValue(undefined);

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldElsewhere);
    expect(rendered(tree)).toContain('another device');
    // Not the claim form, not a held name this device cannot know, and no
    // switch over a bit the state read did not carry (null here): the
    // fact is said instead (the proof pass — with the bit, the switch
    // renders; section 9 below).
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(has(tree, 'username-discoverable-toggle')).toBe(false);
    expect(has(tree, 'username-discoverable-toggle-elsewhere')).toBe(false);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldElsewhereFindabilityUnknown);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.claim);

    // Change opens the RENAME form: the consent box explicit (the claim
    // default, since this device cannot read the current bit), the submit
    // labelled as a change.
    await press(tree, 'account-username-rename');
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.renameSubmit);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.claim);
    const box = tree.root
      .findAllByProps({ testID: 'account-username-consent' })
      .find(n => n.props.accessibilityRole === 'checkbox')!;
    expect(box.props.accessibilityState.checked).toBe(true);
    await type(tree, 'account-username-input', 'zed_1');
    await press(tree, 'account-username-submit');
    expect(rename).toHaveBeenCalledWith('tok', 'zed_1', true);
    expect(claim).not.toHaveBeenCalled();
    // The name this device just sent is the one it now knows (no server
    // stamp yet: the next settled read adopts it — section 9).
    expect(device.row).toEqual({ username: 'zed_1', claimedAt: NOW_MS, discoverable: true });
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.held('zed_1'));
    expect(has(tree, 'account-username-held-elsewhere')).toBe(false);
    tree.unmount();
  });

  it('Remove on the held-elsewhere state is the unlink verb (no name rides the wire), and the claim form that follows carries the cool-down with no invented name', async () => {
    const group = { holds: true };
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'clearUsernameIdentifier').mockResolvedValue(undefined);
    const unlinkMemory = jest.spyOn(db, 'saveUsernameUnlink').mockResolvedValue(undefined);
    const cooldownMemory = jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    // The server's answer after the unlink carries the window the unlink
    // stamped — the one this screen shows (the gate pass).
    jest.spyOn(accountsUsername, 'getIdentifierState').mockImplementation(async () =>
      stateOf({
        holdsUsername: group.holds,
        cooldownUntil: group.holds ? null : NOW_MS + 30 * DAY_MS,
      }),
    );
    const unlink = jest.spyOn(api, 'apiUnlinkUsername').mockImplementation(async () => {
      group.holds = false;
    });
    const claim = jest.spyOn(api, 'apiClaimUsername');

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    await press(tree, 'account-username-unlink');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.unlinkConfirm);
    await press(tree, 'account-username-unlink-confirm');
    expect(unlink).toHaveBeenCalledWith('tok');
    expect(claim).not.toHaveBeenCalled();
    // This device performed the unlink without a readable row: the memory
    // records the moment with an EMPTY name, and the window's end.
    expect(unlinkMemory).toHaveBeenCalledWith({ username: '', unlinkedAt: NOW_MS });
    expect(cooldownMemory).toHaveBeenCalledWith({ until: NOW_MS + 30 * DAY_MS });
    // The group holds no name now: the CLAIM form, warned, naming nothing.
    expect(has(tree, 'account-username-held-elsewhere')).toBe(false);
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink(''));
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.claim);
    tree.unmount();
  });
});

describe('U1: a phantom local row — the group holds no name (a sibling removed it)', () => {
  it('is cleared on holdsUsername === false from the state route, with the changed-or-removed notice, and the claim form follows', async () => {
    const device = { row: HELD as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue(stateOf({ holdsUsername: false }));
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    expect(has(tree, 'account-username-phantom')).toBe(true);
    // RE-CUT 2026-10-08 (the proof pass): the notice says WHICH happened —
    // the group holds no name, so the name was REMOVED — never the hedge.
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.phantomRemoved);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.phantomCleared);
    expect(ACCOUNTS_USERNAME_COPY.phantomRemoved).toContain('removed from another device');
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(has(tree, 'username-discoverable-toggle')).toBe(false);
    tree.unmount();
  });

  it('is NEVER cleared on the legacy path (the fact is unknown there) nor on an unknown fact from a refused or failed read', async () => {
    for (const state of [
      stateOf({ source: 'legacy' }),
      stateOf({ source: 'state', eligibility: 'refused' }),
      stateOf({ source: 'state', eligibility: 'failed' }),
    ]) {
      jest.restoreAllMocks();
      jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      stubRows({ row: HELD, email: EMAIL_ROW });
      jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
      const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockResolvedValue(undefined);
      jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(state);
      const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
      expect([state.source, state.eligibility, clear.mock.calls.length]).toEqual([
        state.source,
        state.eligibility,
        0,
      ]);
      expect(has(tree, 'account-username-held')).toBe(true);
      expect(has(tree, 'account-username-phantom')).toBe(false);
      tree.unmount();
    }
  });
});

describe('U1: the legacy path (today’s production server has no state route)', () => {
  it('keeps the claim form, and a refused claim with no local row adds the stop-gap sentence under the generic retry', async () => {
    stubRows({ email: EMAIL_ROW });
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue(stateOf({ source: 'legacy' }));
    jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('refused');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(has(tree, 'account-username-held-elsewhere-hint')).toBe(false);
    await type(tree, 'account-username-input', 'alice_7');
    await press(tree, 'account-username-submit');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    expect(has(tree, 'account-username-held-elsewhere-hint')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldElsewhereStopGap);
    expect(ACCOUNTS_USERNAME_COPY.heldElsewhereStopGap).toContain('set on another device');
    tree.unmount();
  });

  it('the stop-gap never shows where the state route answered: a refused claim on a group that holds no name is the plain generic retry', async () => {
    stubRows({ email: EMAIL_ROW });
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest
      .spyOn(accountsUsername, 'getIdentifierState')
      .mockResolvedValue(stateOf({ holdsUsername: false }));
    jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('refused');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await type(tree, 'account-username-input', 'alice_7');
    await press(tree, 'account-username-submit');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    expect(has(tree, 'account-username-held-elsewhere-hint')).toBe(false);
    tree.unmount();
  });
});

/* ── 9. the gate pass (2026-10-08): the phantom after a sibling's RENAME,
 *      this device's own verbs, the server's bit, the offline re-read ── */

describe('the gate pass: a phantom row after a sibling’s RENAME (holdsUsername stays true; the live row is younger than this one)', () => {
  function stubMemories(): void {
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'saveUsernameUnlink').mockResolvedValue(undefined);
    jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(db, 'clearUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
  }

  it('the old name is cleared, the notice says so, the held-elsewhere state follows (no name, no switch), and Remove records the EMPTY name — never the old one', async () => {
    const device = {
      row: { username: 'alice_7', claimedAt: NOW_MS - 5 * DAY_MS, discoverable: true } as db.UsernameIdentifierRow | null,
    };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    stubMemories();
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    const unlinkMemory = jest.spyOn(db, 'saveUsernameUnlink').mockResolvedValue(undefined);
    // The iPad renamed the account a day ago: the group still HOLDS a name,
    // the live row was written yesterday, the window runs from then.
    const renamedAt = NOW_MS - DAY_MS;
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({
        holdsUsername: true,
        emailLinked: true,
        phoneLinked: false,
        cooldownUntil: renamedAt + 30 * DAY_MS,
        usernameSince: renamedAt,
        usernameFindable: false,
        emailFindable: null,
      }),
    );
    const unlink = jest.spyOn(api, 'apiUnlinkUsername').mockResolvedValue(undefined);

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(rendered(tree)).not.toContain('alice_7');
    expect(has(tree, 'username-discoverable-toggle')).toBe(false);
    expect(has(tree, 'account-username-phantom')).toBe(true);
    // RE-CUT 2026-10-08 (the proof pass): the name was CHANGED — the live
    // row is newer — and the notice says so, never the hedge.
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.phantomRenamed);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.phantomCleared);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    expect(has(tree, 'account-username-input')).toBe(false);
    // The window the sibling started is said with its date — and the
    // sibling's name is UNFINDABLE (the state carried the bit): the switch
    // on the held-elsewhere state shows it off (the proof pass).
    expect(has(tree, 'account-username-cooldown-until')).toBe(true);
    const sw = tree.root
      .findAllByProps({ testID: 'username-discoverable-toggle-elsewhere' })
      .find(n => n.props.onValueChange !== undefined)!;
    expect(sw.props.value).toBe(false);
    // Remove is the unlink verb, and the memory names NOTHING: this device
    // cannot know which name it removed.
    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlinkMemory).toHaveBeenCalledWith({ username: '', unlinkedAt: NOW_MS });
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink('alice_7'));
    tree.unmount();
  });

  it('this device’s OWN claim is never a phantom: a live row a few seconds younger than the local row (latency, skew) keeps the held state', async () => {
    const row: db.UsernameIdentifierRow = { username: 'alice_7', claimedAt: NOW_MS - 60_000, discoverable: true };
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(row);
    stubMemories();
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockResolvedValue(undefined);
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: NOW_MS - 58_000, usernameFindable: true, emailFindable: null }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(has(tree, 'account-username-held')).toBe(true);
    expect(has(tree, 'account-username-phantom')).toBe(false);
    // The allowance itself, pinned: five minutes either way is skew, more
    // than that behind this row is another device's write.
    expect(accountsUsername.STALE_ROW_SKEW_MS).toBe(5 * 60_000);
    expect(accountsUsername.localRowStale(NOW_MS, NOW_MS + 5 * 60_000)).toBe(false);
    expect(accountsUsername.localRowStale(NOW_MS, NOW_MS + 5 * 60_000 + 1)).toBe(true);
    expect(accountsUsername.localRowStale(NOW_MS, null)).toBe(false);
    // A row that carries the server's own stamp (the proof pass) is judged
    // by EXACT equality instead — the skew allowance plays no part: one
    // second's difference is a sibling's write; a slow clock is not.
    expect(accountsUsername.localRowStale(NOW_MS, NOW_MS + 60_000, NOW_MS + 60_000)).toBe(false);
    expect(accountsUsername.localRowStale(NOW_MS, NOW_MS + 61_000, NOW_MS + 60_000)).toBe(true);
    expect(accountsUsername.localRowStale(NOW_MS, NOW_MS - 1000, NOW_MS)).toBe(true);
    expect(accountsUsername.localRowStale(NOW_MS - 20 * 60_000, NOW_MS, NOW_MS)).toBe(false);
    expect(accountsUsername.localRowStale(NOW_MS, null, NOW_MS)).toBe(false);
    tree.unmount();
  });

  it('Change on the held-elsewhere state starts at the name’s CURRENT findability from the state route — an unfindable name stays unfindable unless the person ticks the box', async () => {
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(null);
    stubMemories();
    jest.spyOn(db, 'saveUsernameIdentifier').mockResolvedValue(undefined);
    jest.spyOn(db, 'clearUsernameUnlink').mockResolvedValue(undefined);
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, emailLinked: true, phoneLinked: false, usernameFindable: false, emailFindable: null }),
    );
    const rename = jest.spyOn(api, 'apiRenameUsername').mockResolvedValue(undefined);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(tree, 'account-username-rename');
    const box = tree.root
      .findAllByProps({ testID: 'account-username-consent' })
      .find(n => n.props.accessibilityRole === 'checkbox')!;
    expect(box.props.accessibilityState.checked).toBe(false);
    await type(tree, 'account-username-input', 'zed_1');
    await press(tree, 'account-username-submit');
    expect(rename).toHaveBeenCalledWith('tok', 'zed_1', false);
    tree.unmount();
  });
});

describe('the gate pass: this device’s own verbs never read as a sibling’s (the row moves in the same batch as the fact)', () => {
  /** A database that answers like op-sqlite: a few milliseconds later,
   * never inside the act() batch the verb resolves in. */
  const later = <T,>(value: () => T): Promise<T> =>
    new Promise(resolve => setTimeout(() => resolve(value()), 15));
  /** One database hop: the verb has landed, its re-read is still out. */
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(() => resolve(), ms));
  const oneHop = async (): Promise<void> => {
    await ReactTestRenderer.act(async () => {
      await sleep(22);
    });
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await ReactTestRenderer.act(async () => {
        await sleep(10);
      });
    }
  };
  /** These cases drive the REAL state read through the api spy — the
   * file's default module stub is lifted first. */
  const realModule = (): void => {
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  };

  it('after its own Remove: no "changed or removed from another device", the claim form with its own warning', async () => {
    realModule();
    // The row this device claimed yesterday, and the server's stamp for the
    // same write (a phantom would be a row OLDER than the live one).
    const device = {
      row: { username: 'alice_7', claimedAt: NOW_MS - DAY_MS, discoverable: true } as db.UsernameIdentifierRow | null,
      unlink: null as db.UsernameUnlinkRow | null,
      cooldown: null as db.UsernameCooldownRow | null,
    };
    const group = { holds: true };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(() => later(() => device.row));
    jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockImplementation(async () => device.unlink);
    jest.spyOn(db, 'saveUsernameUnlink').mockImplementation(async row => {
      device.unlink = row;
    });
    jest.spyOn(db, 'loadUsernameCooldown').mockImplementation(async () => device.cooldown);
    jest.spyOn(db, 'saveUsernameCooldown').mockImplementation(async row => {
      device.cooldown = row;
    });
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest.spyOn(api, 'apiIdentifierState').mockImplementation(async () => ({
      kind: 'state',
      value: {
        hasVerifiedIdentifier: true,
        emailLinked: true,
        phoneLinked: false,
        holdsUsername: group.holds,
        usernameCooldownUntil: group.holds ? null : Math.floor(NOW_MS / 1000) + 30 * 86_400,
        usernameSince: group.holds ? Math.floor(NOW_MS / 1000) - 86_400 : null,
        emailSince: Math.floor(NOW_MS / 1000) - 86_400,
        usernameFindable: group.holds ? true : null,
        emailFindable: null,
      },
    }));
    jest.spyOn(api, 'apiUnlinkUsername').mockImplementation(async () => {
      group.holds = false;
    });
    accountsUsername.invalidateIdentifierState();

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await settle();
    expect(has(tree, 'account-username-held')).toBe(true);
    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    // Right after the verb (its re-read still out), and after every later
    // read has landed.
    await oneHop();
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(has(tree, 'account-username-phantom')).toBe(false);
    await settle();
    expect(has(tree, 'account-username-phantom')).toBe(false);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.phantomCleared);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink('alice_7'));
    expect(has(tree, 'account-username-input')).toBe(true);
    tree.unmount();
  });

  it('after its own first claim: never "set on another device" — the held state from the first frame', async () => {
    realModule();
    const device = { row: null as db.UsernameIdentifierRow | null };
    const group = { holds: false };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(() => later(() => device.row));
    jest.spyOn(db, 'saveUsernameIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'clearUsernameUnlink').mockResolvedValue(undefined);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest.spyOn(api, 'apiIdentifierState').mockImplementation(async () => ({
      kind: 'state',
      value: {
        hasVerifiedIdentifier: true,
        emailLinked: true,
        phoneLinked: false,
        holdsUsername: group.holds,
        usernameCooldownUntil: null,
        usernameSince: group.holds ? Math.floor(NOW_MS / 1000) : null,
        emailSince: Math.floor(NOW_MS / 1000) - 86_400,
        usernameFindable: group.holds ? true : null,
        emailFindable: null,
      },
    }));
    jest.spyOn(api, 'apiClaimUsername').mockImplementation(async () => {
      group.holds = true;
    });
    accountsUsername.invalidateIdentifierState();

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await settle();
    await type(tree, 'account-username-input', 'alice_7');
    await press(tree, 'account-username-submit');
    await oneHop();
    expect(has(tree, 'account-username-held-elsewhere')).toBe(false);
    expect(has(tree, 'account-username-held')).toBe(true);
    await settle();
    expect(has(tree, 'account-username-held-elsewhere')).toBe(false);
    expect(has(tree, 'account-username-held')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    tree.unmount();
  });
});

describe('the gate pass: a refused or failed RE-read keeps the last landed facts', () => {
  it('a sibling on the held-elsewhere state taps Remove with the network gone: still held elsewhere, never the claim form', async () => {
    // The REAL state read, through the api spy (the file's module stub lifted).
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const net = { up: true };
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(api, 'apiIdentifierState').mockImplementation(async () => {
      if (!net.up) return { kind: 'failed' };
      return {
        kind: 'state',
        value: {
          hasVerifiedIdentifier: true,
          emailLinked: true,
          phoneLinked: false,
          holdsUsername: true,
          usernameCooldownUntil: null,
          usernameSince: Math.floor(NOW_MS / 1000) - 86_400,
          emailSince: Math.floor(NOW_MS / 1000) - 86_400,
          usernameFindable: true,
          emailFindable: null,
        },
      };
    });
    jest.spyOn(api, 'apiUnlinkUsername').mockRejectedValue(new TypeError('Network request failed'));
    accountsUsername.invalidateIdentifierState();
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    net.up = false;
    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.failed);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.claim);
    tree.unmount();
  });
});

/* ── 9. the proof pass (2026-10-08): the server's stamp on the row, the
 *       sibling's rename inside the skew window, and the switch on the
 *       held-elsewhere state ───────────────────────────────────────── */

describe('the proof pass: a local row carries the server’s own stamp, so a sibling’s rename inside five minutes is seen — and a slow clock is not a phantom', () => {
  function stubMemories(): void {
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(db, 'clearUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
  }

  it('a fresh row (no stamp) ADOPTS the live row’s stamp on the first settled read, and is persisted with it', async () => {
    const claimedAt = NOW_MS - 30_000;
    const liveSince = NOW_MS - 28_000; // the server's clock, 2 s later: latency, not a sibling
    const device = { row: { username: 'alice_7', claimedAt, discoverable: true } as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    stubMemories();
    const save = jest.spyOn(db, 'saveUsernameIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockResolvedValue(undefined);
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: liveSince, usernameFindable: true }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ username: 'alice_7', claimedAt, discoverable: true, since: liveSince });
    expect(device.row).toEqual({ username: 'alice_7', claimedAt, discoverable: true, since: liveSince });
    expect(has(tree, 'account-username-held')).toBe(true);
    // The module's rule, pinned: a stamped row adopts nothing more; an
    // unknown or a stale live row hands out no stamp.
    expect(
      accountsUsername.adoptableRowStamp({ stamp: claimedAt, since: liveSince }, stateOf({ holdsUsername: true, usernameSince: NOW_MS }), 'username'),
    ).toBeNull();
    expect(
      accountsUsername.adoptableRowStamp({ stamp: claimedAt }, stateOf({ holdsUsername: true, usernameSince: claimedAt + 6 * 60_000 }), 'username'),
    ).toBeNull();
    expect(
      accountsUsername.adoptableRowStamp({ stamp: claimedAt }, stateOf({ source: 'legacy', holdsUsername: null, usernameSince: null }), 'username'),
    ).toBeNull();
    tree.unmount();
  });

  it('claim on the phone, then a sibling renames within 60 s: the phone’s stamped row no longer matches the live stamp — cleared, said as a change, the held-elsewhere state follows', async () => {
    const claimedAt = NOW_MS - 90_000;
    const ownSince = NOW_MS - 89_000; // adopted after the claim landed
    const siblingSince = ownSince + 60_000; // the iPad's Change, 60 s later — inside the old skew window
    const device = {
      row: { username: 'alice_7', claimedAt, discoverable: true, since: ownSince } as db.UsernameIdentifierRow | null,
    };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    stubMemories();
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: siblingSince, usernameFindable: true }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(rendered(tree)).not.toContain('alice_7');
    expect(has(tree, 'account-username-phantom')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.phantomRenamed);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    tree.unmount();
  });

  it('a device whose clock runs ten minutes slow keeps its own stamped row: the live stamp equals the stored one, so nothing is cleared', async () => {
    const claimedAt = NOW_MS - 60_000; // this clock
    const since = NOW_MS + 9 * 60_000; // the server's clock, ten minutes ahead of this device
    const device = { row: { username: 'alice_7', claimedAt, discoverable: true, since } as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    stubMemories();
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockResolvedValue(undefined);
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: since, usernameFindable: true }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(has(tree, 'account-username-held')).toBe(true);
    expect(has(tree, 'account-username-phantom')).toBe(false);
    tree.unmount();
  });

  it('a row from an older build (no stamp) is still judged by the skew rule: a live row six minutes younger is a sibling’s', async () => {
    const claimedAt = NOW_MS - 20 * 60_000;
    const device = { row: { username: 'alice_7', claimedAt, discoverable: true } as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    stubMemories();
    const clear = jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: claimedAt + 6 * 60_000, usernameFindable: true }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    tree.unmount();
  });
});

describe('the proof pass: findability on the held-elsewhere state — the account’s bit, shown and movable from a sibling', () => {
  function stubSibling(findable: boolean | null): { state: { findable: boolean | null } } {
    const group = { findable };
    jest.spyOn(db, 'loadUsernameIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest.spyOn(accountsUsername, 'getIdentifierState').mockImplementation(async () =>
      stateOf({ holdsUsername: true, emailLinked: true, phoneLinked: false, usernameFindable: group.findable }),
    );
    return { state: group };
  }

  it('the switch shows the account’s current bit (on), and no local row is written for it', async () => {
    stubSibling(true);
    const save = jest.spyOn(db, 'saveUsernameIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    const sw = tree.root
      .findAllByProps({ testID: 'username-discoverable-toggle-elsewhere' })
      .find(n => n.props.onValueChange !== undefined)!;
    expect(sw.props.value).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.discoverableTitle);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldElsewhereFindability);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.heldElsewhereFindabilityUnknown);
    expect(has(tree, 'username-discoverable-toggle')).toBe(false);
    expect(save).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('flipping it sends the group-keyed consent write and the switch follows the server’s re-read — the claiming device may be lost, reinstalled or recovered; this one still governs it', async () => {
    const { state } = stubSibling(true);
    const toggle = jest.spyOn(api, 'apiSetUsernameDiscoverable').mockImplementation(async (_t, on) => {
      state.findable = on;
    });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const sw = () =>
      tree.root
        .findAllByProps({ testID: 'username-discoverable-toggle-elsewhere' })
        .find(n => n.props.onValueChange !== undefined)!;
    await ReactTestRenderer.act(async () => {
      sw().props.onValueChange(false);
    });
    expect(toggle).toHaveBeenCalledWith('tok', false);
    expect(sw().props.value).toBe(false);
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    tree.unmount();
  });

  it('an unreadable bit (null) draws no switch and says the fact instead', async () => {
    stubSibling(null);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'username-discoverable-toggle-elsewhere')).toBe(false);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldElsewhereFindabilityUnknown);
    tree.unmount();
  });

  it('after a sibling’s REMOVE inside a window, ONE notice carries the fact, the date and the exception — never two stacked hedges', async () => {
    const device = { row: HELD as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    jest.spyOn(db, 'clearUsernameIdentifier').mockImplementation(async () => {
      device.row = null;
    });
    const until = NOW_MS + 29 * DAY_MS;
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: false, cooldownUntil: until }),
    );
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const label = accountsUsername.cooldownEndLabel(until);
    expect(has(tree, 'account-username-phantom')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.phantomRemovedWindow(label));
    expect(has(tree, 'account-username-cooldown-elsewhere')).toBe(false);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.phantomCleared);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.cooldownElsewhere(label));
    // The claim form follows, its submit dark inside the window, with the
    // date on the control for a screen reader (the proof pass).
    const submit = tree.root
      .findAllByProps({ testID: 'account-username-submit' })
      .find(n => n.props.accessibilityState !== undefined);
    expect(submit).toBeDefined();
    tree.unmount();
  });
});

describe('the proof pass: the holder’s own row follows the account’s consent bit', () => {
  function stubHolder(bit: boolean | null): { device: { row: db.UsernameIdentifierRow | null } } {
    const device = { row: { username: 'alice_7', claimedAt: NOW_MS - DAY_MS, discoverable: true, since: NOW_MS - DAY_MS } as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => device.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(db, 'saveUsernameIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    jest.spyOn(accountsUsername, 'getIdentifierState').mockResolvedValue(
      stateOf({ holdsUsername: true, usernameSince: NOW_MS - DAY_MS, usernameFindable: bit }),
    );
    return { device };
  }

  it('a sibling switched findability off: the phone’s switch shows off on its next open, and its row is brought to the server’s bit', async () => {
    const { device } = stubHolder(false);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const sw = tree.root
      .findAllByProps({ testID: 'username-discoverable-toggle' })
      .find(n => n.props.onValueChange !== undefined)!;
    expect(sw.props.value).toBe(false);
    expect(device.row?.discoverable).toBe(false);
    expect(has(tree, 'account-username-unfindable')).toBe(true);
    tree.unmount();
  });

  it('an unreadable bit (null) changes nothing; a bit that agrees writes nothing', async () => {
    const { device } = stubHolder(null);
    const save = db.saveUsernameIdentifier as unknown as jest.Mock;
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(device.row?.discoverable).toBe(true);
    expect(save).not.toHaveBeenCalled();
    tree.unmount();
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const agreed = stubHolder(true);
    const save2 = db.saveUsernameIdentifier as unknown as jest.Mock;
    const again = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(agreed.device.row?.discoverable).toBe(true);
    expect(save2).not.toHaveBeenCalled();
    again.unmount();
  });
});
