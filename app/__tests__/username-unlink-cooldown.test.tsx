/**
 * FIELD REPORT (build 23): "on the iOS simulator it never
 * succeeds." The server logs for that device (opaque ref w7oHG…) read:
 * claim 200 at 23:46:59Z, unlink 200 at 23:52:22Z, then THIRTEEN claim
 * 403s in 60 s — nine admitted-then-refused by the non-holder cool-down
 * (a DIFFERENT name after an unlink is a rename in two verbs and waits 30
 * days; only the exact unlinked name is reclaimable), then four refused
 * pre-admission by the exhausted 10/day group budget. Every one rendered
 * the same sentence: "That did not go through. Try again later."
 *
 * The refusal collapse is by design: the screen must never learn
 * WHY from the wire. But this device KNOWS it just unlinked — it pressed
 * the button and cleared its own row — and the 30-day rule is printed on
 * this very screen in the HELD state (`cooldownNote`). The claim form that
 * follows an unlink says nothing: no note that a different name waits 30
 * days, nothing that the same name comes straight back. The person types a
 * new name, is refused, reads "try again later", and tries again until the
 * budget is gone.
 *
 * This case pins the gap: after an unlink on this device, the claim form
 * carries the cool-down warning BEFORE the tap.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as accountsUsername from '../src/accountsUsername';
import { ACCOUNTS_USERNAME_COPY } from '../src/accountsUsernameCopy';
import * as db from '../src/db';
import { AccountUsernameScreen } from '../src/screens/AccountUsernameScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));
jest.mock('../src/usernameUi', () => ({
  USERNAME_UI_ENABLED: true,
}));

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

beforeEach(() => {
  // The identifier-route pacing ledger is module state on a trailing minute;
  // with the clock pinned it never rolls, so every case starts it empty.
  accountsUsername.clearIdentifierRoutePacing();
  accountsUsername.invalidateIdentifierState();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the claim form after an unlink on THIS device (the simulator report: thirteen refusals, one sentence)', () => {
  it('warns about the 30-day wait for a DIFFERENT name before the tap — the person is not left to learn it from "try again later"', async () => {
    const state = { row: HELD as db.UsernameIdentifierRow | null };
    jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => state.row);
    jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameUnlink').mockResolvedValue(null);
    jest.spyOn(db, 'loadUsernameCooldown').mockResolvedValue(null);
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    // The group's facts follow the row, as the server's own answer does
    // once the unlink lands (the module invalidates its memory first): the
    // slot empty, and the window the unlink STAMPED — the server's
    // word is the window this screen shows and enforces (the gate pass).
    jest.spyOn(accountsUsername, 'getIdentifierState').mockImplementation(async () => ({
      ...STATE_ELIGIBLE,
      holdsUsername: state.row !== null,
      cooldownUntil: state.row === null ? NOW_MS + 30 * DAY_MS : null,
    }));
    jest.spyOn(accountsUsername, 'unlinkUsername').mockImplementation(async () => {
      state.row = null;
      return 'ok';
    });
    // The server's answer to a different name inside the cool-down: the
    // frozen 403, which the module maps to 'refused' (pinned elsewhere).
    const claim = jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('refused');

    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    // The held state prints the rule.
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownNote);

    await press(tree, 'account-username-unlink');
    await press(tree, 'account-username-unlink-confirm');
    expect(has(tree, 'account-username-held')).toBe(false);
    expect(has(tree, 'account-username-input')).toBe(true);

    // THE GAP: the claim form that follows the unlink carries NO cool-down
    // warning — not the held-state note, not a 30-day sentence of its own,
    // and no reclaim hint — although this device just performed the unlink.
    const glass = rendered(tree);
    expect({
      cooldownWarningOnClaimForm: has(tree, 'account-username-cooldown'),
      thirtyDaysMentioned: /30 days/.test(glass),
    }).toEqual({ cooldownWarningOnClaimForm: true, thirtyDaysMentioned: true });

    // Re-cut 2026-10-08 (U2): the wire still never says why (§4.5), but
    // this device KNOWS — it pressed Remove — so a different name is no
    // longer sent to be refused: the tap is dark, the window's end is
    // named in plain words, and the exact removed name stays live.
    const label = accountsUsername.cooldownEndLabel(NOW_MS + 30 * 24 * 3_600_000);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(label));
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(true);
    await press(tree, 'account-username-submit');
    expect(claim).not.toHaveBeenCalled();
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    await type(tree, 'account-username-input', 'alice_7');
    expect(submitDisabled(tree)).toBe(false);
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_7', true);
    // A refusal that still arrives inside the known window is said with
    // the date, never as the generic retry.
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(label));
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    tree.unmount();
  });
});

/* ── fix/username-discovery (2026-10-08): U2 — the dated cool-down ───── */

/**
 * U2: the 30-day refusal was explained ONLY on the device that pressed
 * Remove. After a rename, after a take-back, on every sibling and after a
 * reinstall it was a bare "Try again later" — and each tap on a sibling
 * spent one of the group's ten daily claim attempts. The window is a group
 * fact the wire never explains, so the device remembers EVERY verb
 * that stamps it (rename and unlink), reads the end from the state route
 * where it answers, names the date in plain words, and darkens the tap it
 * knows would be refused — keeping the exact removed name reclaimable.
 */

const DAY_MS = 24 * 3_600_000;
const NOW_MS = 1_791_475_895_000; // 2026-10-08 16:11:35Z, the A-20 capture moment
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

function stubDevice(opts: {
  row?: db.UsernameIdentifierRow | null;
  unlink?: db.UsernameUnlinkRow | null;
  cooldown?: db.UsernameCooldownRow | null;
  state?: Partial<accountsUsername.IdentifierState>;
}): void {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  jest.spyOn(db, 'loadUsernameIdentifier').mockImplementation(async () => opts.row ?? null);
  jest.spyOn(db, 'loadUsernameNotice').mockResolvedValue(null);
  jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(EMAIL_ROW);
  jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
  jest.spyOn(db, 'loadUsernameUnlink').mockImplementation(async () => opts.unlink ?? null);
  jest.spyOn(db, 'loadUsernameCooldown').mockImplementation(async () => opts.cooldown ?? null);
  jest
    .spyOn(accountsUsername, 'getIdentifierState')
    .mockResolvedValue(stateOf(opts.state ?? {}));
}

const submitDisabled = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  tree.root
    .findAllByProps({ testID: 'account-username-submit' })
    .find(n => n.props.disabled !== undefined)!.props.disabled === true;

describe('U2: the date is named, in plain words, wherever the window is known', () => {
  it('the label is a plain date AND time in the device’s locale — never an ISO stamp, never a number of seconds', () => {
    // RE-CUT 2026-10-08 (the gate pass): the day alone read as false for
    // most of the window's last day ("again on November 7" beside a button
    // still dark at 10:00 that morning); the end is named to the minute,
    // the recovery and linked-devices deadlines' way.
    const until = NOW_MS + 29 * DAY_MS;
    const label = accountsUsername.cooldownEndLabel(until);
    expect(label).toBe(
      new Date(until).toLocaleString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(label).toContain('2026');
    expect(label).toMatch(/\d:\d\d/);
    expect(label).not.toMatch(/T\d\d:|Z$|^\d{10,}$/);
    expect(ACCOUNTS_USERNAME_COPY.cooldownUntil(label)).toContain(label);
    expect(ACCOUNTS_USERNAME_COPY.cooldownUntil(label)).toMatch(/^You can change your username again on /);
  });

  // RE-CUT 2026-10-08 (the proof pass): inside a known window the holder's
  // "Change my username" is WITHHELD — the server refuses every rename by a
  // holder there, so the form it opened could never submit (the dead form
  // U6 removed elsewhere) — and the one way back is said: Remove, then
  // claim the old name. The dated sentence stands; nothing is sent.
  it('P1 — the holder inside the window (this device renamed): the dated sentence, no Change door, the way back said, nothing sent, no "try again later"', async () => {
    const until = NOW_MS + 29 * DAY_MS;
    // The server stamped the rename this device made: its state answer
    // carries the same window the device remembered (the gate pass: the
    // server's answer is the window; the memory is the offline fallback).
    stubDevice({ row: HELD, cooldown: { until }, state: { holdsUsername: true, cooldownUntil: until } });
    const claim = jest.spyOn(accountsUsername, 'claimUsername');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const sentence = ACCOUNTS_USERNAME_COPY.cooldownUntil(accountsUsername.cooldownEndLabel(until));
    expect(has(tree, 'account-username-cooldown-until')).toBe(true);
    expect(rendered(tree)).toContain(sentence);
    expect(has(tree, 'account-username-rename')).toBe(false);
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(has(tree, 'account-username-take-back')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.takeBackNow);
    expect(ACCOUNTS_USERNAME_COPY.takeBackNow).toContain('remove this one and claim it again');
    // Remove stays: the take-back route the sentence names.
    expect(has(tree, 'account-username-unlink')).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    tree.unmount();
  });

  it('P2 — a sibling or a reinstall with NO memory reads the window’s end from the state route: the held-elsewhere state says the date, withholds Change and says the way back', async () => {
    const until = NOW_MS + 20 * DAY_MS;
    stubDevice({ row: null, state: { holdsUsername: true, cooldownUntil: until } });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const sentence = ACCOUNTS_USERNAME_COPY.cooldownUntil(accountsUsername.cooldownEndLabel(until));
    expect(has(tree, 'account-username-held-elsewhere')).toBe(true);
    expect(rendered(tree)).toContain(sentence);
    expect(has(tree, 'account-username-rename')).toBe(false);
    expect(has(tree, 'account-username-input')).toBe(false);
    expect(has(tree, 'account-username-take-back')).toBe(true);
    tree.unmount();
  });

  it('P2 — a sibling whose group holds no name inside the window (removed elsewhere) sees the dated claim sentence; the tap stays live because this device cannot know the reclaimable name, and a 403 answers the date, not "try again later"', async () => {
    const until = NOW_MS + 20 * DAY_MS;
    stubDevice({ row: null, state: { holdsUsername: false, cooldownUntil: until } });
    jest.spyOn(accountsUsername, 'claimUsername').mockResolvedValue('refused');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const label = accountsUsername.cooldownEndLabel(until);
    expect(has(tree, 'account-username-cooldown-elsewhere')).toBe(true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownElsewhere(label));
    expect(rendered(tree)).toContain('Only the exact name that was removed can be taken back');
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(false);
    await press(tree, 'account-username-submit');
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(label));
    expect(rendered(tree)).not.toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    tree.unmount();
  });

  it('P3 — the device that pressed Remove: a different name is dark with the dated sentence; the exact removed name stays live', async () => {
    const until = NOW_MS + 29 * DAY_MS;
    stubDevice({
      row: null,
      unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS },
      cooldown: { until },
      // The server stamped the unlink this device made (the gate pass).
      state: { holdsUsername: false, cooldownUntil: until },
    });
    const claim = jest.spyOn(accountsUsername, 'claimUsername');
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const label = accountsUsername.cooldownEndLabel(until);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownAfterUnlink('alice_7'));
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(label));
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(true);
    await press(tree, 'account-username-submit');
    expect(claim).not.toHaveBeenCalled();
    await type(tree, 'account-username-input', 'Alice_7');
    expect(submitDisabled(tree)).toBe(false);
    tree.unmount();
  });

  it('a memory the OLD build left (the unlink row alone, no window row) still darkens a different name — the window is derived from the unlink moment', async () => {
    stubDevice({
      row: null,
      unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS },
      state: { source: 'legacy' },
    });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    const label = accountsUsername.cooldownEndLabel(NOW_MS - DAY_MS + 30 * DAY_MS);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.cooldownUntilClaim(label));
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(true);
    tree.unmount();
  });

  it('an expired window darkens nothing and names no date', async () => {
    stubDevice({
      row: HELD,
      cooldown: { until: NOW_MS - 1 },
      state: { holdsUsername: true, cooldownUntil: NOW_MS - 1000 },
    });
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown-until')).toBe(false);
    await press(tree, 'account-username-rename');
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(false);
    tree.unmount();
  });
});

describe('U2/P4 — the module’s memory of every stamping verb', () => {
  function deps(held: db.UsernameIdentifierRow | null, cooldown: db.UsernameCooldownRow | null) {
    const calls: string[] = [];
    const saved: db.UsernameCooldownRow[] = [];
    return {
      calls,
      saved,
      deps: {
        api: {
          usernameClaim: async () => {
            calls.push('wire /claim');
          },
          usernameRename: async () => {
            calls.push('wire /rename');
          },
          usernameUnlink: async () => {
            calls.push('wire /unlink');
          },
          setUsernameDiscoverable: async () => undefined,
          discoveryLookupUsername: async () => ({ members: [], rosterVersion: 1 }),
        },
        db: {
          loadUsernameIdentifier: async () => held,
          saveUsernameIdentifier: async () => undefined,
          clearUsernameIdentifier: async () => undefined,
          saveUsernameUnlink: async () => undefined,
          clearUsernameUnlink: async () => undefined,
          loadUsernameCooldown: async () => cooldown,
          saveUsernameCooldown: async (row: db.UsernameCooldownRow) => {
            calls.push('saveUsernameCooldown');
            saved.push({ ...row });
          },
          clearUsernameCooldown: async () => {
            calls.push('clearUsernameCooldown');
          },
        },
        token: async () => 'bearer',
        now: () => NOW_MS,
      },
    };
  }

  it('a landed rename stamps now + 30 days; a landed unlink stamps the same; a refused verb stamps nothing', async () => {
    const renamed = deps(HELD, null);
    expect(await accountsUsername.claimUsername('alice_8', true, renamed.deps)).toBe('renamed');
    expect(renamed.saved).toEqual([{ until: NOW_MS + 30 * DAY_MS }]);
    const unlinked = deps(HELD, null);
    expect(await accountsUsername.unlinkUsername(unlinked.deps)).toBe('ok');
    expect(unlinked.saved).toEqual([{ until: NOW_MS + 30 * DAY_MS }]);
    const refused = deps(HELD, null);
    refused.deps.api.usernameRename = async () => {
      const { ApiRequestError } = jest.requireActual('../src/api') as typeof import('../src/api');
      throw new ApiRequestError('x', 403, 'accounts_refused');
    };
    expect(await accountsUsername.claimUsername('alice_8', true, refused.deps)).toBe('refused');
    expect(refused.calls).toEqual([]);
  });

  it('a take-back keeps the stamp (the server’s window runs on); a claim landing outside any window clears the memory', async () => {
    const takeBack = deps(null, { until: NOW_MS + 29 * DAY_MS });
    expect(await accountsUsername.claimUsername('alice_7', true, takeBack.deps)).toBe('claimed');
    expect(takeBack.calls).toEqual(['wire /claim']);
    const fresh = deps(null, { until: NOW_MS - 1 });
    expect(await accountsUsername.claimUsername('alice_7', true, fresh.deps)).toBe('claimed');
    expect(fresh.calls).toEqual(['wire /claim', 'clearUsernameCooldown']);
    const none = deps(null, null);
    expect(await accountsUsername.claimUsername('alice_7', true, none.deps)).toBe('claimed');
    expect(none.calls).toEqual(['wire /claim']);
  });

  it('the window’s end is the latest of what is known — the state route, the window row, the unlink moment — and null once every source has passed', () => {
    const end = accountsUsername.cooldownWindowEnd;
    expect(end([null, null, null], NOW_MS)).toBeNull();
    expect(end([NOW_MS + 5, null, NOW_MS + 9], NOW_MS)).toBe(NOW_MS + 9);
    expect(end([NOW_MS + 5, NOW_MS + 20, null], NOW_MS)).toBe(NOW_MS + 20);
    expect(end([NOW_MS, NOW_MS - 1], NOW_MS)).toBeNull();
    expect(end([undefined, NOW_MS + 1], NOW_MS)).toBe(NOW_MS + 1);
  });
});

/* ── V2 — the cool-down sentences say what the server does ───────────── */

describe('V2: Remove is always accepted and starts the window; only a DIFFERENT name waits', () => {
  it('the held-state note no longer claims removal is limited; it says removing counts as a change', () => {
    expect(ACCOUNTS_USERNAME_COPY.cooldownNote).toBe(
      'A username can change once every 30 days, and removing it counts as a change: after either, a different name has to wait 30 days. Your old name is held for you for 30 days, then freed for anyone.',
    );
    expect(ACCOUNTS_USERNAME_COPY.cooldownNote).not.toContain('change or remove your username once');
  });

  it('the unlink confirmation says the next different name waits', () => {
    expect(ACCOUNTS_USERNAME_COPY.unlinkConfirm).toContain('A different name will have to wait 30 days.');
    expect(ACCOUNTS_USERNAME_COPY.unlinkConfirm).toContain('You can take the same name back within 30 days');
  });
});

/* ── the gate pass (2026-10-08): the server's window is THE window ─────── */

describe('the gate pass: where the state route answered, its window governs — null included', () => {
  it('state null beside a stale local memory: no window, no "a different name has to wait", Change enabled, and the memory the server contradicts is cleared', async () => {
    stubDevice({
      row: null,
      unlink: { username: 'alice_7', unlinkedAt: NOW_MS - DAY_MS },
      cooldown: { until: NOW_MS + 20 * DAY_MS },
      state: { holdsUsername: false, cooldownUntil: null },
    });
    const clearWindow = jest.spyOn(db, 'clearUsernameCooldown').mockResolvedValue(undefined);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown')).toBe(false);
    expect(has(tree, 'account-username-cooldown-claim')).toBe(false);
    expect(has(tree, 'account-username-cooldown-elsewhere')).toBe(false);
    expect(rendered(tree)).not.toContain('a different name has to wait');
    await type(tree, 'account-username-input', 'bob_99');
    expect(submitDisabled(tree)).toBe(false);
    expect(clearWindow).toHaveBeenCalled();
    tree.unmount();
  });

  it('the holder: a local window row the server contradicts does not darken Change', async () => {
    stubDevice({
      row: HELD,
      cooldown: { until: NOW_MS + 20 * DAY_MS },
      state: { holdsUsername: true, cooldownUntil: null },
    });
    jest.spyOn(db, 'clearUsernameCooldown').mockResolvedValue(undefined);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-username-cooldown-until')).toBe(false);
    await press(tree, 'account-username-rename');
    await type(tree, 'account-username-input', 'alice_9');
    expect(submitDisabled(tree)).toBe(false);
    tree.unmount();
  });

  it('the window row follows the server: a landed end the row does not hold is recorded, from the server, not this clock', async () => {
    const until = NOW_MS + 12 * DAY_MS;
    stubDevice({ row: HELD, cooldown: null, state: { holdsUsername: true, cooldownUntil: until } });
    const save = jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
    const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
    expect(save).toHaveBeenCalledWith({ until });
    expect(rendered(tree)).toContain(
      ACCOUNTS_USERNAME_COPY.cooldownUntil(accountsUsername.cooldownEndLabel(until)),
    );
    tree.unmount();
  });

  it('the local memories still govern where the server could not answer: the legacy read, a refused read, a failed read', async () => {
    for (const state of [
      { source: 'legacy' as const },
      { source: 'state' as const, eligibility: 'refused' as const },
      { source: 'state' as const, eligibility: 'failed' as const },
    ]) {
      jest.restoreAllMocks();
      jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      const until = NOW_MS + 20 * DAY_MS;
      stubDevice({ row: HELD, cooldown: { until }, state });
      const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
      expect([state, has(tree, 'account-username-cooldown-until')]).toEqual([state, true]);
      tree.unmount();
    }
  });

  it('the module: knownCooldownEnd takes the state route’s answer alone where it carries facts, and the local candidates otherwise', () => {
    const facts = stateOf({ holdsUsername: true, cooldownUntil: NOW_MS + 5 });
    expect(accountsUsername.knownCooldownEnd(facts, [NOW_MS + 20], NOW_MS)).toBe(NOW_MS + 5);
    expect(
      accountsUsername.knownCooldownEnd(stateOf({ holdsUsername: true, cooldownUntil: null }), [NOW_MS + 20], NOW_MS),
    ).toBeNull();
    expect(
      accountsUsername.knownCooldownEnd(stateOf({ holdsUsername: true, cooldownUntil: NOW_MS - 1 }), [NOW_MS + 20], NOW_MS),
    ).toBeNull();
    for (const noFacts of [
      null,
      stateOf({ source: 'legacy' }),
      stateOf({ source: 'state', eligibility: 'refused' }),
      stateOf({ source: 'state', eligibility: 'failed' }),
      stateOf({ holdsUsername: null }),
    ]) {
      expect(accountsUsername.knownCooldownEnd(noFacts, [NOW_MS + 20, NOW_MS + 9], NOW_MS)).toBe(NOW_MS + 20);
    }
    expect(accountsUsername.stateHasFacts(facts)).toBe(true);
    expect(accountsUsername.stateHasFacts(stateOf({ source: 'legacy' }))).toBe(false);
  });

  it('an open screen re-enables Change when the window ends — no tap needed', async () => {
    jest.useFakeTimers({ now: NOW_MS });
    try {
      const until = NOW_MS + 3_000;
      stubDevice({ row: HELD, cooldown: null, state: { holdsUsername: true, cooldownUntil: until } });
      // The wall clock and the timers move together (the frozen-clock
      // landmine on record): stubDevice pins Date.now, so it is re-pinned
      // to a clock this test advances beside the timers.
      const clock = { now: NOW_MS };
      jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
      jest.spyOn(db, 'saveUsernameCooldown').mockResolvedValue(undefined);
      jest.spyOn(db, 'clearUsernameCooldown').mockResolvedValue(undefined);
      const tree = await render(<AccountUsernameScreen onBack={jest.fn()} />);
      expect(has(tree, 'account-username-cooldown-until')).toBe(true);
      // Inside the window there is no Change door (the proof pass); the
      // way back is said instead.
      expect(has(tree, 'account-username-rename')).toBe(false);
      expect(has(tree, 'account-username-take-back')).toBe(true);
      await ReactTestRenderer.act(async () => {
        clock.now += 4_000;
        jest.advanceTimersByTime(4_000);
      });
      expect(has(tree, 'account-username-cooldown-until')).toBe(false);
      expect(has(tree, 'account-username-take-back')).toBe(false);
      // The window passed: Change is back, and the form submits.
      await press(tree, 'account-username-rename');
      await type(tree, 'account-username-input', 'alice_9');
      expect(submitDisabled(tree)).toBe(false);
      tree.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});
