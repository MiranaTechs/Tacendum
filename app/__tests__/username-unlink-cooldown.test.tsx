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

    // And the refusal of a different name renders the generic sentence
    // only — by design — so the warning above is the ONLY place the
    // person can learn why.
    await type(tree, 'account-username-input', 'alice_9');
    await press(tree, 'account-username-submit');
    expect(claim).toHaveBeenCalledWith('alice_9', true);
    expect(rendered(tree)).toContain(ACCOUNTS_USERNAME_COPY.tryLater);
    tree.unmount();
  });
});
