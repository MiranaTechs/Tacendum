/**
 * THE USERNAME SURFACES, DARK BEHIND THE BUILD PIN — the phase Verify's surface-level properties, each against
 * the real screens and the real state machine (the phone-ux discipline; the
 * plumbing half lives in username-plumbing.test.tsx):
 *
 *  1. PIN OFF (the shipped value): the claim surface renders NULL even
 *     entered programmatically, Settings shows no username row, the find
 *     flow shows no username chip and no username wording — and the api
 *     spy shows ZERO username calls across all three surfaces.
 *
 *  2. THE CLAIM SURFACE (pin ON): live LOCAL pre-checks with their own
 *     sentences (shape, denylist exact and skeleton) before any wire call;
 *     the consent box DEFAULT CHECKED, the bit sent exactly as shown,
 *     an unchecked claim legal and shown honestly; the claim gate's
 *     precondition surfaced up front from this device's rows; the honesty
 *     copy behind the ⓘ and nothing near the class claiming server
 *     blindness.
 *
 *  3. THE REFUSAL RENDER: 409 → the taken sentence, 403 (fleet
 *     ceiling, budget, gate, cool-down alike) → the generic retry that
 *     never says why, transport → the connection sentence — three distinct
 *     renders from three distinct outcomes, taken and retry distinguishable
 *     by status alone.
 *
 *  4. THE HELD STATE: the name from this device's own row (no @ sigil, no
 *     ULID); the per-class toggle reflecting the row and driving the module;
 *     held-but-unfindable said honestly; rename through the same form with
 *     the box starting at the CURRENT findability; unlink as a two-step
 *     confirm with a keep verb.
 *
 *  5. THE REVOCATION NOTICE, end to end: a `usernameRevoked` frame through
 *     the REAL parser clears the row, stores the notice, and the mounted
 *     surface re-renders the FIXED reasonless copy; an unknown future kind
 *     is ignored and the surface is untouched; dismiss clears the notice.
 *
 *  6. FIND BY USERNAME: the chip is SHOWN and chosen; the typed handle rides
 *     to the card VERBATIM and never a ULID; tapping the card opens the chat
 *     marked 'discovery-username' and syncs the
 *     typed text as the localName; a malformed handle is refused locally
 *     with the class's own sentence; every server refusal is the one miss.
 *
 *  7. SETTINGS + APP WIRING: the row is labeled from the deck, fires its own
 *     callback only, and navigates the real router to accountUsername.
 *
 *  8. DURESS: a claim in a duress session answers the connection sentence
 *     (the api chokepoint's transport-shaped throw), reaches no fetch, and
 *     every row read or written lands in the DECOY file only.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { USERNAME_TAKEN_STATUS, type AccountsNoticeFrame } from '@tacendum/shared';
import App from '../App';
import * as api from '../src/api';
import { ApiRequestError } from '../src/api';
import * as accounts from '../src/accounts';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_PHONE_COPY } from '../src/accountsPhoneCopy';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as db from '../src/db';
import { handleAccountsNoticeFrame, type LinkingDeps } from '../src/linking';
import { messaging } from '../src/messaging';
import * as reauth from '../src/reauth';
import { session } from '../src/session';
import { AccountUsernameScreen } from '../src/screens/AccountUsernameScreen';
import { DiscoveryScreen } from '../src/screens/DiscoveryScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';

jest.mock('../src/registration', () => ({
  hasPendingAccountDeletion: jest.fn(async () => false),
  clearStaleInstallationCredentials: jest.fn(async () => true),
  createOrRestoreAccount: jest.fn(),
}));

/** The build pin, flipped per test: a getter so every render reads the
 * CURRENT value — exactly what the shipped constant would be at build time.
 * Default ON in this suite (the dark half sets it false explicitly): the
 * enabled state is what the pin-flip train ships, and the OFF state is what every
 * release binary holds until then. */
let mockUsernameUiEnabled = true;
jest.mock('../src/usernameUi', () => ({
  get USERNAME_UI_ENABLED() {
    return mockUsernameUiEnabled;
  },
}));

/** The Crockford ULID shape — what must never appear in the rendered tree. */
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;
const FORBIDDEN_BLINDNESS = /server never sees|server-blind|never sees (it|your|the)|server cannot see|blind to your/i;

const ANCHOR = '01HQZZZZ00000000000000000A';
const SELF = '01HQSELF000000000000000000';
const OTHER = '01HQOTHR000000000000000000';
const NOW_MS = 1_756_000_000_000;
const HELD: db.UsernameIdentifierRow = { username: 'alice_7', claimedAt: 1, discoverable: true };
const EMAIL_ROW: db.AccountIdentifierRow = {
  email: 'alice@example.com',
  verifiedAt: 1,
  discoverable: false,
  pendingEmail: null,
  pendingRequestedAt: null,
  restoredAt: null,
};

/* ── helpers ────────────────────────────────────────────────────────── */

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

const submitDisabled = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  tree.root
    .findAllByProps({ testID: 'account-username-submit' })
    .find(n => n.props.disabled !== undefined)!.props.disabled === true;

const consentChecked = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  tree.root
    .findAllByProps({ testID: 'account-username-consent' })
    .find(n => n.props.accessibilityRole === 'checkbox')!.props.accessibilityState.checked;

/** The screen's own reads, stubbed per test: the row, the notice, and the
 * two possession-class rows the precondition hint reads. */
function stubRows(opts: {
  row?: db.UsernameIdentifierRow | null;
  notice?: db.UsernameNoticeRow | null;
  email?: db.AccountIdentifierRow | null;
}): void {
  jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => opts.row ?? null);
  jest.spyOn(db, 'loadUsernameNotice').mockImplementation(async () => opts.notice ?? null);
  jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => opts.email ?? null);
  jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
}

function b64(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    out += Number.isNaN(b) ? '=' : alphabet[(n >> 6) & 63]!;
    out += Number.isNaN(c) ? '=' : alphabet[n & 63]!;
  }
  return out;
}

const frame = (payload: object): AccountsNoticeFrame => ({
  type: 'accounts',
  msgId: '01HQMSGZ00000000000000000M',
  from: OTHER,
  payload: b64(JSON.stringify(payload)),
  ts: NOW_MS,
});

beforeEach(() => {
  jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
});

afterEach(() => {
  mockUsernameUiEnabled = true;
  session.setMode('real');
  jest.restoreAllMocks();
});

/* ── 1. PIN OFF: nothing renders, nothing is called ─────────────────── */

describe('with USERNAME_UI_ENABLED off (the shipped value), the username surfaces render NOTHING', () => {
  it('AccountUsernameScreen renders null — even entered programmatically', async () => {
    mockUsernameUiEnabled = false;
    stubRows({ row: HELD, notice: { receivedAt: 5 } });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
    tree.unmount();
  });

  it('Settings shows no username row and no username wording', async () => {
    mockUsernameUiEnabled = false;
    const tree = await render(
      <SettingsScreen
        onBack={jest.fn()}
        onOpenLinkedDevices={jest.fn()}
        onOpenAccountEmail={jest.fn()}
        onOpenAccountUsername={jest.fn()}
      />,
    );
    expect(has(tree, 'settings-account-username')).toBe(false);
    expect(has(tree, 'settings-account-email')).toBe(true);
    expect(rendered(tree).toLowerCase().includes('username')).toBe(false);
    tree.unmount();
  });

  it('the find flow shows no username chip and no username wording', async () => {
    mockUsernameUiEnabled = false;
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    expect(has(tree, 'discovery-class-username')).toBe(false);
    expect(rendered(tree).toLowerCase().includes('username')).toBe(false);
    tree.unmount();
  });

  it('the api spy shows ZERO username calls across all three surfaces, driven end to end', async () => {
    mockUsernameUiEnabled = false;
    const spies = [
      jest.spyOn(api, 'apiClaimUsername'),
      jest.spyOn(api, 'apiRenameUsername'),
      jest.spyOn(api, 'apiUnlinkUsername'),
      jest.spyOn(api, 'apiSetUsernameDiscoverable'),
      jest.spyOn(api, 'apiDiscoveryLookupUsername'),
      jest.spyOn(api, 'apiUsernameEligibility'),
    ];
    const paths: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async (url: unknown) => {
      paths.push(String(url));
      return { ok: false, status: 403, json: async () => ({ error: { code: 'accounts_refused', detail: 'x' } }) };
    }) as unknown as typeof fetch;
    stubRows({ row: HELD, notice: { receivedAt: 5 } });
    jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    try {
      const settings = await render(
        <SettingsScreen onBack={jest.fn()} onOpenLinkedDevices={jest.fn()} onOpenAccountEmail={jest.fn()} />,
      );
      settings.unmount();
      const screen = await render(<AccountUsernameScreen onBack={jest.fn()} />);
      expect(screen.toJSON()).toBeNull();
      screen.unmount();
      const find = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
      await type(find, 'discovery-input', 'alice_7');
      await press(find, 'discovery-search');
      find.unmount();
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(paths.filter(p => p.includes('/username'))).toEqual([]);
  });
});

/* ── 2. the claim surface ───────────────────────────────────────────── */

describe('the claim surface (pin ON): local pre-checks, consent-at-claim, the precondition, the ⓘ', () => {
  it('the consent box is CHECKED by default and the claim is dark until a valid name is typed', async () => {
    stubRows({ email: EMAIL_ROW });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(consentChecked(tree)).toBe(true);
    expect(submitDisabled(tree)).toBe(true);
    expect(has(tree, 'account-username-local')).toBe(false);
    await type(tree, 'account-username-input', 'alice_7');
    expect(submitDisabled(tree)).toBe(false);
    expect(has(tree, 'account-username-local')).toBe(false);
    tree.unmount();
  });

  it('live LOCAL refusals with their own sentences — shape, denylist exact, denylist skeleton — and the claim stays dark', async () => {
    stubRows({ email: EMAIL_ROW });
    const claim = jest.spyOn(accountsUsername, 'claimUsername');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    for (const [typed, sentence] of [
      ['ab', ACCOUNTS_USERNAME_COPY.invalid],
      ['_alice', ACCOUNTS_USERNAME_COPY.invalid],
      ['al ice', ACCOUNTS_USERNAME_COPY.invalid],
      ['admin', ACCOUNTS_USERNAME_COPY.reserved],
      ['adm1n', ACCOUNTS_USERNAME_COPY.reserved],
      ['rnirana', ACCOUNTS_USERNAME_COPY.reserved],
    ] as const) {
      await type(tree, 'account-username-input', typed);
      expect([typed, rendered(tree).includes(sentence)]).toEqual([typed, true]);
      expect([typed, submitDisabled(tree)]).toEqual([typed, true]);
    }
    // Never a wire call for a local refusal.
    expect(claim).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('a claim sends the box exactly as shown: checked → true; unchecked → false, said honestly as a claim with findability off', async () => {
    stubRows({ email: EMAIL_ROW });
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('claimed');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await type(tree, 'account-username-input', 'Alice_7');
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenLastCalledWith('Alice_7', true);
    // Uncheck: the honest line appears beside the box, and the bit follows.
    // On the CLAIM form that line speaks of a name not yet held (this test
    // pinned the held sentence here before).
    await type(tree, 'account-username-input', 'bob');
    await press(tree, 'account-username-consent');
    expect(consentChecked(tree)).toBe(false);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.claimUnfindable);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.heldUnfindable);
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenLastCalledWith('bob', false);
    tree.unmount();
  });

  it('the authoritative group proof gate disables claim and offers verification; a linked sibling proof enables it despite empty local rows', async () => {
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    stubRows({});
    const openEmail = jest.fn();
    const claim = jest.spyOn(accountsUsername, 'claimUsername');
    const none = await render(
      <AccountUsernameScreen onBack={jest.fn()} onOpenAccountEmail={openEmail} />,
    );
    expect(has(none, 'account-username-needs-identifier')).toBe(true);
    expect(has(none, 'account-username-input')).toBe(true);
    await type(none, 'account-username-input', 'alice_7');
    expect(submitDisabled(none)).toBe(true);
    await press(none, 'account-username-link-email');
    expect(openEmail).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    none.unmount();

    jest.restoreAllMocks();
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
    stubRows({});
    const some = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(some, 'account-username-needs-identifier')).toBe(false);
    await type(some, 'account-username-input', 'alice_7');
    expect(submitDisabled(some)).toBe(false);
    some.unmount();
  });

  it('the honesty copy sits behind the ⓘ — collapsed by default, the three sentences on press — and nothing on the glass claims server blindness', async () => {
    stubRows({ email: EMAIL_ROW });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.infoLabel);
    expect(rendered(tree)).not.toContain('Treat your username as public information.');
    await press(tree, 'account-username-info');
    for (const line of ACCOUNTS_USERNAME_COPY.infoLines) expect(rendered(tree)).toContain(line);
    expect(rendered(tree)).not.toMatch(FORBIDDEN_BLINDNESS);
    // The design: no @ sigil anywhere on this glass.
    expect(rendered(tree).includes('@')).toBe(false);
    tree.unmount();
  });
});

/* ── 3. the refusal render ───────────────────────────────────── */

describe('the refusal render: taken, the generic retry, and the connection sentence are three distinct renders', () => {
  async function claimWith(outcome: accountsUsername.UsernameClaimOutcome): Promise<string> {
    jest.restoreAllMocks();
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('eligible');
    stubRows({ email: EMAIL_ROW });
    jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue(outcome);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await type(tree, 'account-username-input', 'alice_7');
    await press(tree, 'account-username-submit');
    const node = tree.root.findAllByProps({ testID: 'account-username-error' });
    const text = node.length > 0 ? rendered(tree) : '';
    tree.unmount();
    return text;
  }

  it('409 → the taken sentence', async () => {
    expect(await claimWith('taken')).toContain(ACCOUNTS_USERNAME_COPY.taken);
  });

  it('403 (the frozen refusal — fleet ceiling, budget, gate, cool-down alike) → the generic retry that never says why', async () => {
    const text = await claimWith('refused');
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    expect(text).not.toContain(ACCOUNTS_USERNAME_COPY.taken);
    expect(text.toLowerCase()).not.toMatch(/limit|budget|too many|quota|ceiling|cool/);
  });

  it('a transport failure → the connection sentence, and the three sentences are pairwise distinct', async () => {
    expect(await claimWith('failed')).toContain(ACCOUNTS_USERNAME_COPY.failed);
    const three = [ACCOUNTS_USERNAME_COPY.taken, ACCOUNTS_USERNAME_COPY.tryLater, ACCOUNTS_USERNAME_COPY.failed];
    expect(new Set(three).size).toBe(3);
  });

  it('the module maps the REAL statuses: 409 → taken, 403 → refused — the screen never reads a body', async () => {
    const make = (status: number) => ({
      api: {
        usernameClaim: async () => {
          throw new ApiRequestError('x', status, status === 403 ? 'accounts_refused' : undefined);
        },
        usernameRename: async () => undefined,
        usernameUnlink: async () => undefined,
        setUsernameDiscoverable: async () => undefined,
        discoveryLookupUsername: async () => ({ members: [], rosterVersion: 1 }),
      },
      db: {
        loadUsernameIdentifier: async () => null,
        saveUsernameIdentifier: async () => undefined,
        clearUsernameIdentifier: async () => undefined,
        saveUsernameUnlink: async () => undefined,
        clearUsernameUnlink: async () => undefined,
      },
      token: async () => 'bearer',
      now: () => NOW_MS,
    });
    expect(await accountsUsername.claimUsername('alice_7', true, make(USERNAME_TAKEN_STATUS))).toBe('taken');
    expect(await accountsUsername.claimUsername('alice_7', true, make(403))).toBe('refused');
  });
});

/* ── 4. the held state ──────────────────────────────────────────────── */

describe('the held state: the name from this device\'s row, the toggle, rename, and the two-step unlink', () => {
  it('renders the held name from the local row — no @ sigil, no ULID — with the toggle at the row\'s value', async () => {
    stubRows({ row: HELD, email: EMAIL_ROW });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    expect(rendered(tree).includes('@')).toBe(false);
    expect(ULID_RE.test(rendered(tree))).toBe(false);
    const toggle = tree.root
      .findAllByProps({ testID: 'username-discoverable-toggle' })
      .find(n => n.props.value !== undefined)!;
    expect(toggle.props.value).toBe(true);
    expect(has(tree, 'account-username-unfindable')).toBe(false);
    // The form is not on the glass while a name is held and no rename is
    // under way.
    expect(has(tree, 'account-username-input')).toBe(false);
    // The cool-down is surfaced.
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownNote);
    tree.unmount();
  });

  it('held-but-unfindable is said honestly when the row\'s bit is off; the toggle drives the module', async () => {
    stubRows({ row: { ...HELD, discoverable: false }, email: EMAIL_ROW });
    const set = jest.spyOn(accountsUsername, 'setUsernameDiscoverable').mockResolvedValue('ok');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-unfindable')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.heldUnfindable);
    const toggle = tree.root
      .findAllByProps({ testID: 'username-discoverable-toggle' })
      .find(n => n.props.value !== undefined)!;
    expect(toggle.props.value).toBe(false);
    await ReactTestRenderer.act(async () => {
      toggle.props.onValueChange(true);
    });
    expect(set).toHaveBeenCalledWith(true);
    tree.unmount();
  });

  it('a refused toggle renders the generic retry; a transport failure the connection sentence', async () => {
    stubRows({ row: HELD, email: EMAIL_ROW });
    const set = jest.spyOn(accountsUsername, 'setUsernameDiscoverable').mockResolvedValue('refused');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const toggle = () =>
      tree.root
        .findAllByProps({ testID: 'username-discoverable-toggle' })
        .find(n => n.props.value !== undefined)!;
    await ReactTestRenderer.act(async () => {
      toggle().props.onValueChange(false);
    });
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    set.mockResolvedValue('failed');
    await ReactTestRenderer.act(async () => {
      toggle().props.onValueChange(false);
    });
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.failed);
    tree.unmount();
  });

  it('rename rides the same form: the box starts at the CURRENT findability, the module spells the route, keep cancels', async () => {
    stubRows({ row: { ...HELD, discoverable: false }, email: EMAIL_ROW });
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('renamed');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(tree, 'account-username-rename');
    expect(has(tree, 'account-username-input')).toBe(true);
    // A rename must not flip consent on its own: the box mirrors the row.
    expect(consentChecked(tree)).toBe(false);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.renameSubmit);
    await type(tree, 'account-username-input', 'alice_8');
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_8', false);
    // The form closes on success.
    expect(has(tree, 'account-username-input')).toBe(false);
    // Keep: the form leaves without a call.
    await press(tree, 'account-username-rename');
    await press(tree, 'account-username-rename-cancel');
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('the claim default SURVIVES a rename of an unfindable name: rename → keep → unlink → the claim form opens CHECKED and the claim carries true', async () => {
    // A mutable row: unlink clears it the way the module's own write would,
    // and the screen's refresh re-reads it.
    const state = { row: { ...HELD, discoverable: false } as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => state.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(accountsUsername, 'unlinkUsername').mockImplementation(async () => {
      state.row = null;
      return 'ok';
    });
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('claimed');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    // The rename seeds the box from the row: unchecked.
    await press(tree, 'account-username-rename');
    expect(consentChecked(tree)).toBe(false);
    // Keep, then remove the name: the form that follows is a CLAIM.
    await press(tree, 'account-username-rename-cancel');
    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.claim);
    // The default is back — not the renamed row's old bit inherited.
    expect(consentChecked(tree)).toBe(true);
    await type(tree, 'account-username-input', 'alice_9');
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_9', true);
    tree.unmount();
  });

  it('the claim default also returns when a revocation lands MID-RENAME of an unfindable name: the form falls back to a claim, checked, and the claim carries true', async () => {
    const state = {
      row: { ...HELD, discoverable: false } as db.UsernameIdentifierRow | null,
      notice: null as db.UsernameNoticeRow | null,
    };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => state.row);
    jest.spyOn(db, 'loadUsernameNotice').mockImplementation(async () => state.notice);
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('claimed');
    const deps = linkingFake(state);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    await press(tree, 'account-username-rename');
    expect(consentChecked(tree)).toBe(false);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.renameSubmit);
    // The revocation, through the REAL parser, while the rename form is up.
    await ReactTestRenderer.act(async () => {
      await handleAccountsNoticeFrame(frame({ kind: 'usernameRevoked' }), deps);
    });
    expect(state.row).toBeNull();
    expect(has(tree, 'account-username-revoked')).toBe(true);
    // A CLAIM form now — the claim verb, the claim default — never the
    // revoked row's old bit.
    expect(has(tree, 'account-username-input')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.claim);
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.renameSubmit);
    expect(consentChecked(tree)).toBe(true);
    await type(tree, 'account-username-input', 'alice_9');
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_9', true);
    tree.unmount();
  });

  it('unlink is a two-step confirm: the sentence names the 30-day reclaim, keep backs out, confirm calls the module once', async () => {
    stubRows({ row: HELD, email: EMAIL_ROW });
    const unlink = jest.spyOn(accountsUsername, 'unlinkUsername').mockResolvedValue('ok');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-unlink-confirm')).toBe(false);
    await press(tree, 'account-username-unlink');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.unlinkConfirm);
    expect(rendered(tree)).toContain('30 days');
    await press(tree, 'account-username-unlink-cancel');
    expect(has(tree, 'account-username-unlink-confirm')).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    expect(unlink).toHaveBeenCalledTimes(1);
    tree.unmount();
  });
});

/* ── 5. the revocation notice, end to end ───────────────────────────── */

function linkingFake(state: {
  row: db.UsernameIdentifierRow | null;
  notice: db.UsernameNoticeRow | null;
}): LinkingDeps {
  return {
    api: {
      getPrekeyBundle: async () => {
        throw new Error('not in this suite');
      },
      linkOfferInit: async () => {
        throw new Error('not in this suite');
      },
      linkOfferSubmit: async () => undefined,
      linkAccept: async () => undefined,
      rosterMutation: async () => undefined,
    },
    crypto: {
      processPreKeyBundle: async () => undefined,
      safetyNumber: async () => null,
      signLinkOp: async () => 'sig',
      verifyLinkOp: async () => true,
      identityPublicKey: async () => 'OWNKEY',
    },
    db: {
      loadLinkGroup: async () => null,
      saveLinkGroup: async () => undefined,
      upsertLinkedDevice: async () => undefined,
      markLinkedDeviceState: async () => undefined,
      listLinkedDevices: async () => [],
      clearLinkGroup: async () => undefined,
      savePendingLinkOffer: async () => undefined,
      loadPendingLinkOffer: async () => null,
      deletePendingLinkOffer: async () => undefined,
      savePendingLinkCeremony: async () => undefined,
      loadPendingLinkCeremony: async () => null,
      deletePendingLinkCeremony: async () => undefined,
      pristineForLink: async () => true,
      savePendingLinkMutation: async () => undefined,
      listPendingLinkMutations: async () => [],
      deletePendingLinkMutation: async () => undefined,
      listSiblingAgents: async () => [],
      saveRecoveryNotice: async () => undefined,
      loadRecoveryNotice: async () => null,
      clearUsernameIdentifier: async () => {
        state.row = null;
      },
      saveUsernameNotice: async row => {
        state.notice = { ...row };
      },
    },
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
    freshNonce: () => '01HQNNNN00000000000000000N',
  };
}

describe('the revocation notice: a usernameRevoked frame through the REAL parser re-renders the mounted surface with the FIXED copy', () => {
  it('unknown future kind → ignored, surface untouched; usernameRevoked → the row goes, the notice renders reasonless; dismiss clears it', async () => {
    const state = { row: HELD as db.UsernameIdentifierRow | null, notice: null as db.UsernameNoticeRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => state.row);
    jest.spyOn(db, 'loadUsernameNotice').mockImplementation(async () => state.notice);
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const clearNotice = jest.spyOn(db, 'clearUsernameNotice').mockImplementation(async () => {
      state.notice = null;
    });
    const deps = linkingFake(state);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    expect(has(tree, 'account-username-revoked')).toBe(false);

    // A well-formed notice of a kind this binary does not know: acked as
    // ignored, and the surface does not move.
    let outcome: string | undefined;
    await ReactTestRenderer.act(async () => {
      outcome = await handleAccountsNoticeFrame(frame({ kind: 'somethingFromNextYear', extra: 1 }), deps);
    });
    expect(outcome).toBe('ignored');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    expect(has(tree, 'account-username-revoked')).toBe(false);

    // The revocation — a rider reason on the wire never surfaces.
    await ReactTestRenderer.act(async () => {
      outcome = await handleAccountsNoticeFrame(frame({ kind: 'usernameRevoked', reason: 'impersonation' }), deps);
    });
    expect(outcome).toBe('stored');
    expect(state.row).toBeNull();
    expect(state.notice).toEqual({ receivedAt: NOW_MS });
    const text = rendered(tree);
    expect(has(tree, 'account-username-revoked')).toBe(true);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.revokedTitle);
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.revokedBody);
    expect(text).not.toContain('impersonation');
    expect(text.toLowerCase()).not.toMatch(/because|reason|violat/);
    // The name is gone from the glass; the claim form is back.
    expect(text).not.toContain(ACCOUNTS_USERNAME_COPY.held('alice_7'));
    expect(has(tree, 'account-username-input')).toBe(true);

    // Dismiss clears the notice row and the render.
    await press(tree, 'account-username-revoked-dismiss');
    expect(clearNotice).toHaveBeenCalledTimes(1);
    expect(has(tree, 'account-username-revoked')).toBe(false);
    tree.unmount();
  });
});

/* ── 6. find by username ────────────────────────────────────────────── */

describe('find by username: the chip is shown and chosen, the typed handle rides to the card, the chat is marked discovery-username', () => {
  it('checks caller proof before a target query; missing proof shows the email door and never becomes a no-match', async () => {
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    const lookup = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const openEmail = jest.fn();
    const tree = await render(
      <DiscoveryScreen
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        onOpenAccountEmail={openEmail}
      />,
    );
    await type(tree, 'discovery-input', 'alice_7');
    await press(tree, 'discovery-search');
    expect(accountsUsername.getUsernameEligibility).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(has(tree, 'discovery-username-needs-identifier')).toBe(true);
    expect(has(tree, 'discovery-no-match')).toBe(false);
    await press(tree, 'discovery-username-link-email');
    expect(openEmail).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('leaving while the proof check is pending never starts the target lookup afterward', async () => {
    let resolveEligibility!: (value: accountsUsername.UsernameEligibilityOutcome) => void;
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockImplementation(
      () =>
        new Promise(resolve => {
          resolveEligibility = resolve;
        }),
    );
    const lookup = jest.spyOn(accountsUsername, 'discoverySearchByUsername');
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    await type(tree, 'discovery-input', 'alice_7');
    await press(tree, 'discovery-search');
    tree.unmount();
    await ReactTestRenderer.act(async () => {
      resolveEligibility('eligible');
      await Promise.resolve();
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('the result card carries the handle VERBATIM (case and spacing included) and never a ULID; the header names the class', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const search = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 2 });
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    expect(has(tree, 'discovery-class-email')).toBe(true);
    await press(tree, 'discovery-class-username');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.findTitle);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.findNote);
    await type(tree, 'discovery-input', ' Alice_7 ');
    await press(tree, 'discovery-search');
    expect(search).toHaveBeenCalledWith('Alice_7');
    const text = rendered(tree);
    expect(text).toContain('Start a chat with Alice_7?');
    expect(text).toContain('This account answers on 2 devices.');
    expect(text).toContain(ACCOUNTS_USERNAME_COPY.findTofu);
    expect(ULID_RE.test(text)).toBe(false);
    expect(text.includes('@')).toBe(false);
    tree.unmount();
  });

  it('tapping the card opens the chat marked discovery-username (the banner predicate) with the typed text as the localName', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const start = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    const sync = jest.spyOn(messaging, 'syncLocalName').mockResolvedValue(undefined);
    const onOpenChat = jest.fn();
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={onOpenChat} />);
    await press(tree, 'discovery-class-username');
    await type(tree, 'discovery-input', 'Alice_7');
    await press(tree, 'discovery-search');
    await press(tree, 'discovery-result');
    expect(start).toHaveBeenCalledWith('Alice_7', ANCHOR, undefined, db.DISCOVERY_USERNAME_INTRODUCED);
    expect(db.serverIntroduced(start.mock.calls[0]![3] as string)).toBe(true);
    expect(sync).toHaveBeenCalledWith(ANCHOR, 'Alice_7');
    expect(onOpenChat).toHaveBeenCalledWith(ANCHOR);
    tree.unmount();
  });

  it('the shipped classes keep their discovery mark — the email leg is byte-unchanged', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accounts, 'discoverySearch')
      .mockResolvedValue({ outcome: 'found', anchor: ANCHOR, deviceCount: 1 });
    const start = jest.spyOn(accounts, 'startDiscoveredChat').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'syncLocalName').mockResolvedValue(undefined);
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    await type(tree, 'discovery-input', 'alice@example.com');
    await press(tree, 'discovery-search');
    await press(tree, 'discovery-result');
    expect(start).toHaveBeenCalledWith('alice@example.com', ANCHOR, undefined, 'discovery');
    tree.unmount();
  });

  it('the class is CHOSEN, never inferred: an email-shaped text under the username chip dispatches the username lookup only', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    const emailSearch = jest.spyOn(accounts, 'discoverySearch').mockResolvedValue({ outcome: 'no_match' });
    const nameSearch = jest
      .spyOn(accountsUsername, 'discoverySearchByUsername')
      .mockResolvedValue({ outcome: 'invalid' });
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    await press(tree, 'discovery-class-username');
    await type(tree, 'discovery-input', 'alice@example.com');
    await press(tree, 'discovery-search');
    expect(nameSearch).toHaveBeenCalledWith('alice@example.com');
    expect(emailSearch).not.toHaveBeenCalled();
    // The LOCAL refusal renders the class's own sentence.
    expect(has(tree, 'discovery-invalid')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.invalid);
    tree.unmount();
  });

  it('every server refusal is the one miss, rendered with the class\'s honesty sentence and the explainer', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(accountsUsername, 'discoverySearchByUsername').mockResolvedValue({ outcome: 'no_match' });
    const tree = await render(<DiscoveryScreen onBack={jest.fn()} onOpenChat={jest.fn()} />);
    await press(tree, 'discovery-class-username');
    await type(tree, 'discovery-input', 'alice_7');
    await press(tree, 'discovery-search');
    expect(has(tree, 'discovery-no-match')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.findNoMatch);
    expect(rendered(tree)).not.toContain(ACCOUNTS_COPY.discoverNeedsOwnEmail);
    expect(rendered(tree)).not.toContain(ACCOUNTS_PHONE_COPY.discoverNeedsOwnIdentifier);
    expect(has(tree, 'discovery-username-needs-identifier')).toBe(false);
    await press(tree, 'discovery-info');
    for (const line of ACCOUNTS_USERNAME_COPY.findExplain) expect(rendered(tree)).toContain(line);
    // The design: a username never buys search rights — the explainer says so.
    expect(rendered(tree)).toContain('holding a username is not enough');
    tree.unmount();
  });
});

/* ── 7. Settings + App wiring ───────────────────────────────────────── */

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () => (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;
const devRoute = () => (globalThis as unknown as Record<string, unknown>).TacendumDevRoute as string;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe('Settings → ACCOUNT: the username row (pin ON) is labeled from the deck and fires its own callback only', () => {
  it('screen level', async () => {
    const onOpenAccountUsername = jest.fn();
    const onOpenAccountEmail = jest.fn();
    const onOpenLinkedDevices = jest.fn();
    const tree = await render(
      <SettingsScreen
        onBack={jest.fn()}
        onOpenLinkedDevices={onOpenLinkedDevices}
        onOpenAccountEmail={onOpenAccountEmail}
        onOpenAccountUsername={onOpenAccountUsername}
      />,
    );
    const row = tree.root.findByProps({ testID: 'settings-account-username' });
    expect(row.props.label).toBe(ACCOUNTS_USERNAME_COPY.settingsRow);
    await press(tree, 'settings-account-username');
    expect(onOpenAccountUsername).toHaveBeenCalledTimes(1);
    expect(onOpenAccountEmail).not.toHaveBeenCalled();
    expect(onOpenLinkedDevices).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('App wiring: settings → accountUsername, and back lands on settings', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
    });
    await ReactTestRenderer.act(async () => {
      await flush();
    });
    ReactTestRenderer.act(() => {
      devNav()({ name: 'settings' });
    });
    expect(devRoute()).toBe('settings');
    await press(tree, 'settings-account-username');
    expect(devRoute()).toBe('accountUsername');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('App wiring, pin OFF: the settings surface carries no username row', async () => {
    mockUsernameUiEnabled = false;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
    });
    await ReactTestRenderer.act(async () => {
      await flush();
    });
    ReactTestRenderer.act(() => {
      devNav()({ name: 'settings' });
    });
    expect(devRoute()).toBe('settings');
    expect(has(tree, 'settings-account-username')).toBe(false);
    expect(has(tree, 'settings-account-email')).toBe(true);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it("App wiring: the claim form's 'Link an email' door lands on the email surface", async () => {
    // The username surface renders only over a loaded profile, so this case
    // boots a real workspace holding a finished account (back.android's
    // fixture) instead of driving the router over an empty one.
    const crypto = jest.requireMock('tacendum-crypto') as {
      __keychain: Map<string, string>;
      hasIdentity: jest.Mock;
      identityPublicKey: jest.Mock;
    };
    messaging.stop();
    await db.close();
    sqlite.__sqlite.reset();
    db.setWorkspace('real');
    crypto.__keychain.clear();
    crypto.__keychain.set('authToken', 'token-for-this-test');
    crypto.hasIdentity.mockResolvedValue(true);
    crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
    sqlite.__sqlite.instances.set('tacendum.sqlite', {
      name: 'tacendum.sqlite',
      execute: jest.fn(async (sql: string) => {
        const s = String(sql);
        if (s.includes('FROM profile')) {
          return {
            rows: [
              { key: 'userId', value: ANCHOR },
              { key: 'registrationId', value: '7' },
              { key: 'displayName', value: 'Me' },
              { key: 'about', value: '' },
              { key: 'avatarB64', value: '' },
              { key: 'profileVersion', value: '3' },
            ],
          };
        }
        if (s.includes('PRAGMA table_info(attachments')) return { rows: [{ name: 'direction' }] };
        if (s.includes('PRAGMA table_info(reactions')) {
          return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
        }
        if (s.includes('PRAGMA table_info(pending_revisions')) return { rows: [{ name: 'writerId' }] };
        return { rows: [] };
      }),
      close: jest.fn(),
    });
    // No verified identifier of either class: the sentence carries the door.
    stubRows({});
    jest.spyOn(accountsUsername, 'getUsernameEligibility').mockResolvedValue('needs_verification');
    // The boot now ASKS THE SERVER what build it still talks to, before the
    // socket. Left to the environment's real
    // `fetch`, that request is an outbound connection this suite never
    // wanted and the opening waits on its 20 s deadline, so the route never
    // leaves 'loading'. An empty answer is refused by the DTO parse, which
    // the gate reads as unknown — the fail-open posture — and the boot
    // carries on exactly as it did.
    const realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    })) as unknown as typeof fetch;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    try {
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(<App />);
      });
      await ReactTestRenderer.act(async () => {
        await flush();
      });
      expect(devRoute()).toBe('chats');
      await ReactTestRenderer.act(async () => {
        devNav()({ name: 'accountUsername' });
        await flush();
      });
      expect(devRoute()).toBe('accountUsername');
      expect(has(tree, 'account-username-link-email')).toBe(true);
      await press(tree, 'account-username-link-email');
      expect(devRoute()).toBe('accountEmail');
      expect(has(tree, 'account-email-back')).toBe(true);
    } finally {
      await ReactTestRenderer.act(async () => {
        tree?.unmount();
      });
      globalThis.fetch = realFetch;
      crypto.hasIdentity.mockResolvedValue(false);
      crypto.identityPublicKey.mockResolvedValue(null);
      crypto.__keychain.clear();
      messaging.stop();
      await db.close();
    }
  });
});

/* ── 8. duress ──────────────────────────────────────────────────────── */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  __sqlite: { opened: string[]; instances: Map<string, FakeDb>; reset: () => void };
};

describe('duress: a claim from the surface in a duress session touches the decoy file only and never the wire', () => {
  it('answers the connection sentence, reaches no fetch, writes no row, and every statement ran against the DECOY file', async () => {
    const realFetch = globalThis.fetch;
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    try {
      await db.close();
      sqlite.__sqlite.reset();
      db.setWorkspace('decoy');
      await db.initDb();
      session.setMode('duress');
      const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
      await type(tree, 'account-username-input', 'alice_7');
      await press(tree, 'account-username-submit');
      expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.failed);
      expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.taken);
      tree.unmount();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sqlite.__sqlite.opened).toEqual(['tacendum-decoy.sqlite']);
      expect(sqlite.__sqlite.instances.has('tacendum.sqlite')).toBe(false);
      const sqls = sqlite.__sqlite.instances
        .get('tacendum-decoy.sqlite')!
        .execute.mock.calls.map(c => String(c[0]));
      // The surface READ its rows from the decoy file (so the screen is a
      // real screen there) and WROTE nothing.
      expect(sqls.some(s => s.includes('FROM account_identifier'))).toBe(true);
      expect(sqls.some(s => s.includes('INSERT OR REPLACE INTO account_identifier'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      session.setMode('real');
      await db.close();
      db.setWorkspace('real');
    }
  });
});
