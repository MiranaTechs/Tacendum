/**
 * The pending-code state is DURABLE — the attach request writes
 * `pendingEmail` + `pendingRequestedAt` — but the screen only ever read
 * `pendingEmail` as a boolean. After a relaunch the person met an empty
 * address field, a "Send another code" button they could not press, and a
 * bare 6-digit field for a code that had expired days ago. The screen now
 * restores its context from the row: the address is prefilled, the
 * code-sent notice names it, and a code older than the server's 5-minute
 * window is treated as expired (the code field goes, the request stays
 * available). */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as accounts from '../src/accounts';
import { PENDING_CODE_TTL_MS } from '../src/accounts';
import { invalidateIdentifierState, type IdentifierState } from '../src/accountsUsername';
import * as api from '../src/api';
import { ApiRequestError } from '../src/api';
import * as db from '../src/db';
import { LINKING_COPY } from '../src/linkingCopy';
import * as reauth from '../src/reauth';
import { AccountEmailScreen } from '../src/screens/AccountEmailScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

const NOW_MS = 1_756_000_000_000;

async function render(el: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

function node(tree: ReactTestRenderer.ReactTestRenderer, testID: string, prop: string) {
  return tree.root.findAllByProps({ testID }).find(n => n.props[prop] !== undefined);
}

function pendingRow(requestedAt: number): db.AccountIdentifierRow {
  return {
    email: null,
    verifiedAt: null,
    discoverable: false,
    pendingEmail: 'alice@example.com',
    pendingRequestedAt: requestedAt,
    restoredAt: null,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW_MS });
  // The identifier-route pacing ledger (shared with the email legs since
  // the gate pass) is module state on a trailing minute: every case starts
  // it empty, as it starts the state read's memory.
  accounts.clearIdentifierRoutePacing();
  invalidateIdentifierState();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a fresh pending row restores the address, the notice and the code field after a remount', async () => {
  jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 60_000));
  const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
  expect(node(tree, 'account-email-input', 'onChangeText')!.props.value).toBe('alice@example.com');
  expect(tree.root.findAllByProps({ testID: 'account-email-notice' }).length).toBeGreaterThan(0);
  expect(JSON.stringify(tree.toJSON())).toContain(
    ACCOUNTS_COPY.emailCodeSent('alice@example.com'),
  );
  expect(node(tree, 'account-email-code', 'onChangeText')).toBeDefined();
  // The prefilled address arms the resend without retyping.
  expect(node(tree, 'account-email-request', 'onPress')!.props.disabled).toBe(false);
  tree.unmount();
});

test('a pending row older than the code window is expired: no code field, resend still offered', async () => {
  jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(
    pendingRow(NOW_MS - PENDING_CODE_TTL_MS - 60_000),
  );
  const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
  expect(node(tree, 'account-email-code', 'onChangeText')).toBeUndefined();
  expect(tree.root.findAllByProps({ testID: 'account-email-notice' })).toHaveLength(0);
  const request = node(tree, 'account-email-request', 'onPress')!;
  expect(request.props.disabled).toBe(false);
  expect(request.props.label).toBe(ACCOUNTS_COPY.emailRequestAgain);
  tree.unmount();
});

test('the code field leaves on its own when the window closes while the screen is open', async () => {
  jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 60_000));
  const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
  expect(node(tree, 'account-email-code', 'onChangeText')).toBeDefined();
  await ReactTestRenderer.act(async () => {
    // Lock-step: the wall clock AND the timers move together.
    jest.setSystemTime(NOW_MS + PENDING_CODE_TTL_MS);
    jest.advanceTimersByTime(PENDING_CODE_TTL_MS);
  });
  expect(node(tree, 'account-email-code', 'onChangeText')).toBeUndefined();
  tree.unmount();
});

test('a typed address is never overwritten by the row', async () => {
  jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 60_000));
  const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
  await ReactTestRenderer.act(async () => {
    node(tree, 'account-email-input', 'onChangeText')!.props.onChangeText('bob@example.com');
  });
  // A refresh (what every handler runs in its finally) keeps the draft.
  await ReactTestRenderer.act(async () => {
    node(tree, 'account-email-input', 'onChangeText')!.props.onChangeText('bob@example.co');
  });
  expect(node(tree, 'account-email-input', 'onChangeText')!.props.value).toBe('bob@example.co');
  tree.unmount();
});

/* ──"Send another code" waits out the server's minute ───── */

/** Wall clock and timers together — never one without the other. */
async function elapse(ms: number) {
  await ReactTestRenderer.act(async () => {
    // Modern fake timers move Date.now() WITH the timers they run, so this
    // one call is the lock-step: a setSystemTime beside it would move the
    // wall clock twice (0:34 where 0:47 was due).
    jest.advanceTimersByTime(ms);
  });
}

describe('the resend button counts the server’s minute down instead of inviting a silent tap', () => {
  const request = (tree: ReactTestRenderer.ReactTestRenderer) =>
    node(tree, 'account-email-request', 'onPress')!;

  test('after a send: disabled with the countdown, re-armed when the minute is up', async () => {
    jest
      .spyOn(db, 'loadAccountIdentifier')
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pendingRow(NOW_MS));
    jest.spyOn(accounts, 'requestAttachCode').mockResolvedValue('sent');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    await ReactTestRenderer.act(async () => {
      node(tree, 'account-email-input', 'onChangeText')!.props.onChangeText('alice@example.com');
    });
    await ReactTestRenderer.act(async () => {
      request(tree).props.onPress();
    });
    expect(request(tree).props.disabled).toBe(true);
    expect(request(tree).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('1:00'));
    await elapse(13_000);
    expect(request(tree).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('0:47'));
    await elapse(47_000);
    expect(request(tree).props.disabled).toBe(false);
    expect(request(tree).props.label).toBe(ACCOUNTS_COPY.emailRequestAgain);
    tree.unmount();
  });

  test('the countdown survives a remount: derived from the row, not from this mount', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 13_000));
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(request(tree).props.disabled).toBe(true);
    expect(request(tree).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('0:47'));
    tree.unmount();
  });

  test('the module: the wait is the minute less the age, never negative, and a clock that moved backwards locks nothing', () => {
    expect(accounts.resendWaitMs(null, NOW_MS)).toBe(0);
    expect(accounts.resendWaitMs(NOW_MS, NOW_MS)).toBe(60_000);
    expect(accounts.resendWaitMs(NOW_MS - 13_000, NOW_MS)).toBe(47_000);
    expect(accounts.resendWaitMs(NOW_MS - 60_000, NOW_MS)).toBe(0);
    expect(accounts.resendWaitMs(NOW_MS + 5_000, NOW_MS)).toBe(0);
    expect(accounts.formatResendClock(60_000)).toBe('1:00');
    expect(accounts.formatResendClock(47_000)).toBe('0:47');
    expect(accounts.formatResendClock(46_400)).toBe('0:47');
    expect(accounts.formatResendClock(500)).toBe('0:01');
  });
});

/* ── D2 (fix/username-discovery, 2026-10-08): the linked sibling ───────── */

/**
 * The field report, on the iPad of an account whose email was verified
 * on the phone: Email & discovery showed the empty attach form (no linked
 * address, no switch, no Remove) and answered the own address with "the
 * code may be wrong or expired" before any code existed. Two causes, two
 * halves:
 *
 *  - the screen rendered only this device's local row, which only this
 *    device's own attach ever writes — the GROUP's facts now come from the
 *    caller-owned state read (accounts.loadIdentifierState, the screen's
 *    door to accountsUsername.getIdentifierState): with
 *    `emailLinked: true` and no local row the screen says the email is held
 *    on another device and offers Remove (the unlink route carries no
 *    address) — never the attach form;
 *  - the request step rendered the VERIFY step's sentence for every http
 *    refusal: the request's own 403 (the group already holds its one email
 *    — including one a sibling linked) and its self-keyed 429 (the route
 *    burst, the per-group daily attach allowance) now each get a sentence
 *    about what they are. The verify-step sentence keeps its bytes.
 */

const stateOf = (over: Partial<IdentifierState> = {}): IdentifierState => ({
  source: 'state',
  eligibility: 'eligible',
  holdsUsername: false,
  emailLinked: false,
  phoneLinked: false,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
  ...over,
});

const LEGACY_UNKNOWN: Partial<IdentifierState> = {
  source: 'legacy',
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
};

const VERIFIED_ROW: db.AccountIdentifierRow = {
  email: 'alice@example.com',
  verifiedAt: NOW_MS - 3_600_000,
  discoverable: true,
  pendingEmail: null,
  pendingRequestedAt: null,
  restoredAt: null,
};

async function type(tree: ReactTestRenderer.ReactTestRenderer, testID: string, text: string) {
  await ReactTestRenderer.act(async () => {
    node(tree, testID, 'onChangeText')!.props.onChangeText(text);
  });
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  await ReactTestRenderer.act(async () => {
    node(tree, testID, 'onPress')!.props.onPress();
  });
}

/** The InlineError / InlineNotice sentence under `testID`, or null. */
function messageAt(tree: ReactTestRenderer.ReactTestRenderer, testID: string): string | null {
  const found = tree.root.findAllByProps({ testID }).find(n => n.props.message !== undefined);
  return found ? (found.props.message as string) : null;
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;

describe('the linked sibling (D2): the Email screen reads the account, not only this device', () => {
  beforeEach(() => {
    invalidateIdentifierState();
  });

  describe('the request step says what the server answered', () => {
    async function requestFrom(state: IdentifierState, answer: Error) {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(state);
      const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
      jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
      // The REAL accounts.requestAttachCode and the real api error mapping;
      // only the wire function and the token are stubbed.
      const wire = jest.spyOn(api, 'apiEmailRequestCode').mockRejectedValue(answer);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      await type(tree, 'account-email-input', 'owner@example.test');
      await press(tree, 'account-email-request');
      expect(wire).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      return tree;
    }

    it('a 403 before any code exists: the request-step sentence, never "the code may be wrong or expired"', async () => {
      const tree = await requestFrom(
        stateOf(),
        new ApiRequestError('not available', 403, 'accounts_refused'),
      );
      expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.emailRequestRefused);
      expect(ACCOUNTS_COPY.emailRequestRefused).not.toBe(ACCOUNTS_COPY.emailRefused);
      expect(JSON.stringify(tree.toJSON())).not.toContain('The code may be wrong or expired');
      // No code field appears for a code that was never sent.
      expect(node(tree, 'account-email-code', 'onChangeText')).toBeUndefined();
      tree.unmount();
    });

    it('a 429 (this device’s route burst, or the account’s daily attach allowance): the rate-limited sentence', async () => {
      const tree = await requestFrom(
        stateOf(),
        new ApiRequestError('too many requests; slow down', 429, 'rate_limited'),
      );
      expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.emailRequestRateLimited);
      expect(ACCOUNTS_COPY.emailRequestRateLimited).not.toBe(ACCOUNTS_COPY.emailRequestRefused);
      expect(JSON.stringify(tree.toJSON())).not.toContain('The code may be wrong or expired');
      tree.unmount();
    });

    it('a transport failure on the request still renders the connection sentence', async () => {
      const tree = await requestFrom(stateOf(), new TypeError('Network request failed'));
      expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.failed);
      tree.unmount();
    });

    it('the VERIFY step keeps its own sentence on a 403 — the split did not leak', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 30_000));
      jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf());
      jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
      const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
      jest
        .spyOn(api, 'apiEmailVerify')
        .mockRejectedValue(new ApiRequestError('refused', 403, 'accounts_refused'));
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      await type(tree, 'account-email-code', '123456');
      await press(tree, 'account-email-verify');
      expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.emailRefused);
      expect(save).not.toHaveBeenCalled();
      tree.unmount();
    });
  });

  describe('the held-elsewhere state (emailLinked is a FACT from the state route)', () => {
    it('no local row + emailLinked: no input, no switch — the sentence, Remove and Downgrade; zero local writes', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      const read = jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ emailLinked: true, emailFindable: false }));
      const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
      const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(read).toHaveBeenCalled();
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeUndefined();
      expect(has(tree, 'account-email-request')).toBe(false);
      // Not THIS device's switch (no row of its own) — the account's, from
      // the state read's bit (the proof pass, 2026-10-08).
      expect(has(tree, 'discoverable-toggle')).toBe(false);
      expect(has(tree, 'discoverable-toggle-elsewhere')).toBe(true);
      expect(has(tree, 'account-email-verified')).toBe(false);
      const rendered = JSON.stringify(tree.toJSON());
      expect(rendered).toContain(ACCOUNTS_COPY.emailHeldElsewhere);
      expect(rendered).toContain(ACCOUNTS_COPY.emailHeldElsewhereFindability);
      expect(ACCOUNTS_COPY.emailHeldElsewhere).toContain('linked from another device');
      expect(has(tree, 'account-email-unlink')).toBe(true);
      expect(has(tree, 'account-downgrade')).toBe(true);
      expect(save).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      tree.unmount();
    });

    it('Remove works without an address (the unlink route carries none): confirm, unlink, then the form', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValueOnce(stateOf({ emailLinked: true }))
        .mockResolvedValue(stateOf({ emailLinked: false }));
      const unlink = jest.spyOn(accounts, 'unlinkIdentifier').mockResolvedValue('ok');
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      await press(tree, 'account-email-unlink');
      // The question names no address — this device does not know it.
      const rendered = JSON.stringify(tree.toJSON());
      expect(rendered).toContain(ACCOUNTS_COPY.emailHeldElsewhereUnlinkConfirm);
      expect(rendered).not.toContain('Remove undefined');
      expect(rendered).not.toContain('Remove null');
      await press(tree, 'account-email-unlink-confirm');
      expect(unlink).toHaveBeenCalledTimes(1);
      // The group no longer holds an email: the attach form is honest now.
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
      expect(JSON.stringify(tree.toJSON())).not.toContain(ACCOUNTS_COPY.emailHeldElsewhere);
      tree.unmount();
    });

    it('a refused Remove keeps the held-elsewhere state and says the unlink did not work', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ emailLinked: true }));
      jest.spyOn(accounts, 'unlinkIdentifier').mockResolvedValue('refused');
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      await press(tree, 'account-email-unlink');
      await press(tree, 'account-email-unlink-confirm');
      expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.emailUnlinkRefused);
      expect(JSON.stringify(tree.toJSON())).toContain(ACCOUNTS_COPY.emailHeldElsewhere);
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeUndefined();
      tree.unmount();
    });

    it('a verified local row wins over the group fact: the ordinary verified surface renders', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED_ROW);
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ emailLinked: true }));
      const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(has(tree, 'account-email-verified')).toBe(true);
      expect(has(tree, 'discoverable-toggle')).toBe(true);
      expect(JSON.stringify(tree.toJSON())).not.toContain(ACCOUNTS_COPY.emailHeldElsewhere);
      expect(clear).not.toHaveBeenCalled();
      tree.unmount();
    });
  });

  describe('the phantom row (emailLinked false is a FACT: the email was removed from another device)', () => {
    it('a verified local row with no email on the group is cleared once, and the screen says so', async () => {
      jest
        .spyOn(db, 'loadAccountIdentifier')
        .mockResolvedValueOnce(VERIFIED_ROW)
        .mockResolvedValue(null);
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ emailLinked: false }));
      const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(clear).toHaveBeenCalledTimes(1);
      expect(has(tree, 'account-email-verified')).toBe(false);
      expect(has(tree, 'discoverable-toggle')).toBe(false);
      expect(messageAt(tree, 'account-email-notice')).toBe(ACCOUNTS_COPY.emailRemovedElsewhere);
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
      tree.unmount();
    });

    it('a PENDING row is not a phantom: the code flow stands while the group holds no email yet', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 30_000));
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ emailLinked: false }));
      const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(clear).not.toHaveBeenCalled();
      expect(node(tree, 'account-email-code', 'onChangeText')).toBeDefined();
      tree.unmount();
    });

    it('null is UNKNOWN, never false: the legacy read, a refusal and a failure clear nothing', async () => {
      for (const state of [
        stateOf(LEGACY_UNKNOWN),
        stateOf({ eligibility: 'refused', holdsUsername: null, emailLinked: null, phoneLinked: null }),
        stateOf({ eligibility: 'failed', holdsUsername: null, emailLinked: null, phoneLinked: null }),
      ]) {
        jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED_ROW);
        jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(state);
        const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
        const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
        expect(clear).not.toHaveBeenCalled();
        expect(has(tree, 'account-email-verified')).toBe(true);
        expect(has(tree, 'discoverable-toggle')).toBe(true);
        tree.unmount();
        jest.restoreAllMocks();
        invalidateIdentifierState();
      }
    });
  });

  describe('the legacy read (the server before the deploy, or a server ahead of this build)', () => {
    it('eligible with no local row: the form stays, with the stop-gap sentence about another device', async () => {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest
        .spyOn(accounts, 'loadIdentifierState')
        .mockResolvedValue(stateOf({ ...LEGACY_UNKNOWN, eligibility: 'eligible' }));
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
      expect(messageAt(tree, 'account-email-maybe-elsewhere')).toBe(
        ACCOUNTS_COPY.emailMaybeHeldElsewhere,
      );
      expect(JSON.stringify(tree.toJSON())).not.toContain(ACCOUNTS_COPY.emailHeldElsewhere);
      tree.unmount();
    });

    it('needs_verification, a refusal or a failure: the plain form, no stop-gap, no held-elsewhere', async () => {
      for (const state of [
        stateOf({ ...LEGACY_UNKNOWN, eligibility: 'needs_verification' }),
        stateOf({ eligibility: 'refused', holdsUsername: null, emailLinked: null, phoneLinked: null }),
        stateOf({ eligibility: 'failed', holdsUsername: null, emailLinked: null, phoneLinked: null }),
      ]) {
        jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
        jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(state);
        const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
        expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
        expect(has(tree, 'account-email-maybe-elsewhere')).toBe(false);
        expect(JSON.stringify(tree.toJSON())).not.toContain(ACCOUNTS_COPY.emailHeldElsewhere);
        tree.unmount();
        jest.restoreAllMocks();
        invalidateIdentifierState();
      }
    });
  });

  it('the state read is taken on mount and again after every write the screen makes', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED_ROW);
    const read = jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true }));
    jest.spyOn(accounts, 'setDiscoverable').mockResolvedValue('ok');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(read).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => {
      node(tree, 'discoverable-toggle', 'onValueChange')!.props.onValueChange(false);
    });
    expect(read).toHaveBeenCalledTimes(2);
    tree.unmount();
  });
});

/* ── the gate pass (2026-10-08) ─────────────────────────────────────── */

describe('the gate pass: the Email screen waits for the account, reads a replaced address, keeps its facts offline, checks the address and paces itself', () => {
  beforeEach(() => {
    invalidateIdentifierState();
  });

  it('the attach form waits for the first state answer: a checking line meanwhile, never a form a sibling could use, and the form once it lands', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    let land!: (state: IdentifierState) => void;
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockReturnValue(new Promise<IdentifierState>(resolve => (land = resolve)));
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeUndefined();
    expect(has(tree, 'account-email-request')).toBe(false);
    expect(messageAt(tree, 'account-email-checking')).toBe(ACCOUNTS_COPY.emailChecking);
    await ReactTestRenderer.act(async () => {
      land(stateOf({ emailLinked: false }));
    });
    expect(has(tree, 'account-email-checking')).toBe(false);
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
    tree.unmount();
  });

  it('a refused or failed first answer falls through to the form (the legacy and the offline cases keep their surface)', async () => {
    for (const state of [
      stateOf({ eligibility: 'refused', holdsUsername: null, emailLinked: null, phoneLinked: null }),
      stateOf({ eligibility: 'failed', holdsUsername: null, emailLinked: null, phoneLinked: null }),
    ]) {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(state);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
      expect(has(tree, 'account-email-checking')).toBe(false);
      tree.unmount();
      jest.restoreAllMocks();
      invalidateIdentifierState();
    }
  });

  it('this device’s own pending code shows at once, state answer or not', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 30_000));
    jest.spyOn(accounts, 'loadIdentifierState').mockReturnValue(new Promise<IdentifierState>(() => undefined));
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(tree, 'account-email-code', 'onChangeText')).toBeDefined();
    expect(has(tree, 'account-email-checking')).toBe(false);
    tree.unmount();
  });

  it('a REPLACED address is a phantom: the live email is younger than this row — cleared once, said, and the held-elsewhere state follows (no switch over the sibling’s address)', async () => {
    const old: db.AccountIdentifierRow = { ...VERIFIED_ROW, email: 'alice@old.example', verifiedAt: NOW_MS - 10 * 86_400_000 };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValueOnce(old).mockResolvedValue(null);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: NOW_MS - 86_400_000 }));
    const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
    const toggle = jest.spyOn(api, 'apiSetDiscoverable').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).not.toContain('alice@old.example');
    expect(has(tree, 'discoverable-toggle')).toBe(false);
    expect(messageAt(tree, 'account-email-notice')).toBe(ACCOUNTS_COPY.emailChangedElsewhere);
    expect(has(tree, 'account-email-held-elsewhere')).toBe(true);
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeUndefined();
    expect(toggle).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('this device’s own address is never a phantom: a live row a few seconds younger (latency, skew) keeps the verified surface', async () => {
    const own: db.AccountIdentifierRow = { ...VERIFIED_ROW, verifiedAt: NOW_MS - 60_000 };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(own);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: NOW_MS - 58_000 }));
    const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(has(tree, 'account-email-verified')).toBe(true);
    expect(has(tree, 'discoverable-toggle')).toBe(true);
    tree.unmount();
  });

  it('a refused RE-read keeps the last landed facts: Remove refused offline leaves the held-elsewhere state, never the form', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValueOnce(stateOf({ emailLinked: true }))
      .mockResolvedValue(stateOf({ eligibility: 'failed', holdsUsername: null, emailLinked: null, phoneLinked: null }));
    jest.spyOn(accounts, 'unlinkIdentifier').mockResolvedValue('failed');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(has(tree, 'account-email-held-elsewhere')).toBe(true);
    await press(tree, 'account-email-unlink');
    await press(tree, 'account-email-unlink-confirm');
    expect(has(tree, 'account-email-held-elsewhere')).toBe(true);
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeUndefined();
    tree.unmount();
  });

  it('an incomplete address never reaches the wire: the button stays dark with "Finish the address"; a complete one lights it', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf());
    const request = jest.spyOn(accounts, 'requestAttachCode').mockResolvedValue('sent');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    for (const draft of ['alice', 'alice @example.com', 'alice@']) {
      await type(tree, 'account-email-input', draft);
      expect([draft, node(tree, 'account-email-request', 'onPress')!.props.disabled]).toEqual([draft, true]);
      expect([draft, JSON.stringify(tree.toJSON()).includes(ACCOUNTS_COPY.emailUnfinished)]).toEqual([draft, true]);
      await press(tree, 'account-email-request');
      expect(request).not.toHaveBeenCalled();
    }
    await type(tree, 'account-email-input', 'alice@example.com');
    expect(node(tree, 'account-email-request', 'onPress')!.props.disabled).toBe(false);
    expect(has(tree, 'account-email-unfinished')).toBe(false);
    await press(tree, 'account-email-request');
    expect(request).toHaveBeenCalledWith('alice@example.com');
    tree.unmount();
  });

  it('a 429 with an HOURS-long Retry-After is the day’s allowance, not the minute: the sentence names the reset; a seconds-long one keeps "wait a minute"', async () => {
    const cases: Array<[number | null, string]> = [
      [7_200, ACCOUNTS_COPY.emailRequestRateLimitedToday],
      [30, ACCOUNTS_COPY.emailRequestRateLimited],
      [null, ACCOUNTS_COPY.emailRequestRateLimited],
    ];
    for (const [retryAfter, sentence] of cases) {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf());
      jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
      jest
        .spyOn(api, 'apiEmailRequestCode')
        .mockRejectedValue(new ApiRequestError('too many requests', 429, 'rate_limited', retryAfter));
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      await type(tree, 'account-email-input', 'owner@example.test');
      await press(tree, 'account-email-request');
      expect([retryAfter, messageAt(tree, 'account-email-error')]).toEqual([retryAfter, sentence]);
      tree.unmount();
      jest.restoreAllMocks();
      invalidateIdentifierState();
      accounts.clearIdentifierRoutePacing();
    }
    expect(ACCOUNTS_COPY.emailRequestRateLimitedToday).toContain('midnight UTC');
    expect(ACCOUNTS_COPY.emailRequestRateLimitedToday).not.toContain('minute');
  });

  it('this device paces its own identifier-route calls on the email legs too: the eleventh tap in a minute says the wait and sends nothing', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(VERIFIED_ROW);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf({ emailLinked: true }));
    const toggle = jest.spyOn(accounts, 'setDiscoverable').mockResolvedValue('ok');
    for (let n = 0; n < 10; n += 1) accounts.noteIdentifierRouteCall(NOW_MS);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    await ReactTestRenderer.act(async () => {
      node(tree, 'discoverable-toggle', 'onValueChange')!.props.onValueChange(false);
    });
    expect(toggle).not.toHaveBeenCalled();
    expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.paced(60));
    tree.unmount();
  });
});

/* ── the unlinked second device (2026-10-08 follow-up) ──────────────── */

/**
 * The reported second device, read from production: a separate account
 * that never linked and holds no verified identifier. Here it met the attach
 * form, typed the address its other account already holds, received a real
 * code, and was refused at the verify step with the uniform 403 — a loop
 * ("request a fresh code") that spends the address's daily sends and never
 * points at the thing that would work: joining the other account, started
 * FROM the other device, while this one is still a fresh install and a
 * different kind of device. The pointer now sits beside the form, before
 * and after the refusal, on two LOCAL facts plus the state read already in
 * hand: no group row (never linked) and the fresh-install check that
 * chooses the sentence. The form stays — a different address is still a
 * legal choice. An unknown renders nothing. `emailRefused` keeps its bytes.
 */
describe('the unlinked device (2026-10-08 follow-up): the attach form on an unverified, ungrouped device points to linking', () => {
  const NEEDS = stateOf({ eligibility: 'needs_verification' });
  const GROUP: db.LinkGroupRow = { groupId: '01HQGRPZ00000000000000000G', rosterEpoch: 1 };

  function local(over: {
    group?: db.LinkGroupRow | null;
    pristine?: boolean;
    rejectGroup?: boolean;
    rejectPristine?: boolean;
  }): void {
    const group = jest.spyOn(db, 'loadLinkGroup');
    if (over.rejectGroup) group.mockRejectedValue(new Error('no db'));
    else group.mockResolvedValue(over.group ?? null);
    const pristine = jest.spyOn(db, 'pristineForLink');
    if (over.rejectPristine) pristine.mockRejectedValue(new Error('no db'));
    else pristine.mockResolvedValue(over.pristine ?? true);
  }

  beforeEach(() => {
    invalidateIdentifierState();
  });

  it('no row, needs_verification, no group, fresh → the fresh-install notice above the field; the field and "Email me a code" stay', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
    local({});
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(messageAt(tree, 'account-email-join-existing')).toBe(LINKING_COPY.joinExistingAccount);
    expect(has(tree, 'account-email-join-existing-info')).toBe(true);
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
    expect(has(tree, 'account-email-request')).toBe(true);
    expect(has(tree, 'account-email-maybe-elsewhere')).toBe(false);
    expect(has(tree, 'account-email-held-elsewhere')).toBe(false);
    // The notice never borrows the code-sent notice's slot (that count is
    // pinned to zero in the expired-code case).
    expect(tree.root.findAllByProps({ testID: 'account-email-notice' })).toHaveLength(0);
    // The teaching copy is collapsed until asked for, then complete: every
    // ⓘ line, the pinned history sentence by reference, no start-over line.
    expect(JSON.stringify(tree.toJSON())).not.toContain(LINKING_COPY.joinExistingAccountInfo[0]);
    await press(tree, 'account-email-join-existing-info');
    const open = JSON.stringify(tree.toJSON());
    for (const line of LINKING_COPY.joinExistingAccountInfo) expect(open).toContain(line);
    expect(open).toContain(LINKING_COPY.historyStance);
    expect(open).not.toContain(LINKING_COPY.joinExistingAccountStartOver);
    tree.unmount();
  });

  it('lived-in → the lived-in notice; the ⓘ includes the start-over line and the pinned history sentence', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
    local({ pristine: false });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(messageAt(tree, 'account-email-join-existing')).toBe(
      LINKING_COPY.joinExistingAccountLivedIn,
    );
    expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
    await press(tree, 'account-email-join-existing-info');
    const open = JSON.stringify(tree.toJSON());
    for (const line of LINKING_COPY.joinExistingAccountInfo) expect(open).toContain(line);
    expect(open).toContain(LINKING_COPY.historyStance);
    expect(open).toContain(LINKING_COPY.joinExistingAccountStartOver);
    tree.unmount();
  });

  it('a pending code (the person already asked) keeps the guidance visible beside the code field', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 30_000));
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
    local({});
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(tree, 'account-email-code', 'onChangeText')).toBeDefined();
    expect(messageAt(tree, 'account-email-join-existing')).toBe(LINKING_COPY.joinExistingAccount);
    tree.unmount();
  });

  it('a refused VERIFY keeps emailRefused’s exact bytes AND the guidance stays on the glass beside it', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(pendingRow(NOW_MS - 30_000));
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
    local({});
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
    jest
      .spyOn(api, 'apiEmailVerify')
      .mockRejectedValue(new ApiRequestError('refused', 403, 'accounts_refused'));
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    await type(tree, 'account-email-code', '123456');
    await press(tree, 'account-email-verify');
    expect(messageAt(tree, 'account-email-error')).toBe(ACCOUNTS_COPY.emailRefused);
    expect(ACCOUNTS_COPY.emailRefused).toBe(
      'That did not work. The code may be wrong or expired, or this address may already be linked elsewhere — the server deliberately does not say which. Request a fresh code to try again.',
    );
    expect(messageAt(tree, 'account-email-join-existing')).toBe(LINKING_COPY.joinExistingAccount);
    expect(has(tree, 'account-email-join-existing-info')).toBe(true);
    expect(save).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('grouped (a loadLinkGroup row) → no guidance; eligible → no guidance; held elsewhere → the D2 state renders instead', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
    local({ group: GROUP });
    const grouped = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(grouped, 'account-email-input', 'onChangeText')).toBeDefined();
    expect(has(grouped, 'account-email-join-existing')).toBe(false);
    expect(has(grouped, 'account-email-join-existing-info')).toBe(false);
    grouped.unmount();

    jest.restoreAllMocks();
    invalidateIdentifierState();
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf());
    local({});
    const eligible = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(eligible, 'account-email-input', 'onChangeText')).toBeDefined();
    expect(has(eligible, 'account-email-join-existing')).toBe(false);
    eligible.unmount();

    jest.restoreAllMocks();
    invalidateIdentifierState();
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf({ emailLinked: true }));
    local({});
    const elsewhere = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(has(elsewhere, 'account-email-held-elsewhere')).toBe(true);
    expect(node(elsewhere, 'account-email-input', 'onChangeText')).toBeUndefined();
    expect(has(elsewhere, 'account-email-join-existing')).toBe(false);
    elsewhere.unmount();
  });

  it('the legacy read (today’s production server) with needs_verification shows it too', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ ...LEGACY_UNKNOWN, eligibility: 'needs_verification' }));
    local({});
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(messageAt(tree, 'account-email-join-existing')).toBe(LINKING_COPY.joinExistingAccount);
    expect(has(tree, 'account-email-maybe-elsewhere')).toBe(false);
    tree.unmount();
  });

  it('a failed local read renders nothing extra; zero local writes either way', async () => {
    for (const failure of [{ rejectGroup: true }, { rejectPristine: true }]) {
      jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
      jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(NEEDS);
      local(failure);
      const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
      const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
      const saveGroup = jest.spyOn(db, 'saveLinkGroup').mockResolvedValue(undefined);
      const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
      expect(node(tree, 'account-email-input', 'onChangeText')).toBeDefined();
      expect(has(tree, 'account-email-join-existing')).toBe(false);
      expect(has(tree, 'account-email-join-existing-info')).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(saveGroup).not.toHaveBeenCalled();
      tree.unmount();
      jest.restoreAllMocks();
      invalidateIdentifierState();
    }
  });
});

/* ── the proof pass (2026-10-08): the switch on the held-elsewhere state,
 *    the server's stamp on the row, and a sibling's replacement inside
 *    the skew window ──────────────────────────────────────────────── */

describe('the proof pass: findability by email on a sibling — the account’s bit, shown and movable; the stamp on the row', () => {
  it('the held-elsewhere switch shows the account’s bit and flipping it sends the group-keyed consent write; the switch follows the re-read', async () => {
    const group = { findable: true };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockImplementation(async () => stateOf({ emailLinked: true, emailFindable: group.findable }));
    const write = jest.spyOn(api, 'apiSetDiscoverable').mockImplementation(async (_t, on) => {
      group.findable = on;
    });
    const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    const sw = () => node(tree, 'discoverable-toggle-elsewhere', 'onValueChange')!;
    expect(sw().props.value).toBe(true);
    await ReactTestRenderer.act(async () => {
      sw().props.onValueChange(false);
    });
    expect(write).toHaveBeenCalledWith('tok', false);
    expect(sw().props.value).toBe(false);
    expect(has(tree, 'account-email-held-elsewhere')).toBe(true);
    // No row of its own is invented for a bit that is the account's.
    expect(save).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('the linking device is gone (lost, reinstalled, recovered): the remaining device still reads the bit and can switch it off', async () => {
    const group = { findable: true };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('tok');
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockImplementation(async () => stateOf({ emailLinked: true, emailFindable: group.findable }));
    const write = jest.spyOn(api, 'apiSetDiscoverable').mockImplementation(async (_t, on) => {
      group.findable = on;
    });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    await ReactTestRenderer.act(async () => {
      node(tree, 'discoverable-toggle-elsewhere', 'onValueChange')!.props.onValueChange(false);
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(node(tree, 'discoverable-toggle-elsewhere', 'onValueChange')!.props.value).toBe(false);
    // The findability sentence no longer sends the person to the linking
    // device (the address sentence still says, truthfully, that the
    // address itself is readable only there).
    expect(ACCOUNTS_COPY.emailHeldElsewhereFindability).not.toContain('the device that linked it');
    tree.unmount();
  });

  it('an unreadable bit (null) draws no switch and says the fact', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf({ emailLinked: true, emailFindable: null }));
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(has(tree, 'discoverable-toggle-elsewhere')).toBe(false);
    expect(JSON.stringify(tree.toJSON())).toContain(ACCOUNTS_COPY.emailHeldElsewhereFindabilityUnknown);
    tree.unmount();
  });

  it('a fresh verified row (no stamp) ADOPTS the live email row’s stamp on the first settled read, persisted', async () => {
    const own: db.AccountIdentifierRow = { ...VERIFIED_ROW, verifiedAt: NOW_MS - 60_000 };
    const device = { row: own as db.AccountIdentifierRow | null };
    jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => device.row);
    const liveSince = NOW_MS - 58_000;
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: liveSince, emailFindable: true }));
    const save = jest.spyOn(db, 'saveAccountIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ ...own, since: liveSince });
    expect(has(tree, 'account-email-verified')).toBe(true);
    tree.unmount();
  });

  it('attach on the phone, then a sibling replaces the address within 60 s: the stamped row no longer matches — cleared once, said as a change, held elsewhere', async () => {
    const ownSince = NOW_MS - 89_000;
    const own: db.AccountIdentifierRow = { ...VERIFIED_ROW, verifiedAt: NOW_MS - 90_000, since: ownSince };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValueOnce(own).mockResolvedValue(null);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: ownSince + 60_000, emailFindable: false }));
    const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tree.toJSON())).not.toContain('alice@example.com');
    expect(messageAt(tree, 'account-email-notice')).toBe(ACCOUNTS_COPY.emailChangedElsewhere);
    expect(has(tree, 'account-email-held-elsewhere')).toBe(true);
    tree.unmount();
  });

  it('a clock ten minutes slow keeps its stamped row: the live stamp equals the stored one', async () => {
    const since = NOW_MS + 9 * 60_000;
    const own: db.AccountIdentifierRow = { ...VERIFIED_ROW, verifiedAt: NOW_MS - 60_000, since };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(own);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: since, emailFindable: true }));
    const clear = jest.spyOn(db, 'clearAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(clear).not.toHaveBeenCalled();
    expect(has(tree, 'account-email-verified')).toBe(true);
    tree.unmount();
  });
});

describe('the proof pass: the linking device’s own row follows the account’s consent bit', () => {
  it('a sibling switched findability off: the row is brought to the server’s bit and the switch shows off', async () => {
    const device = { row: { ...VERIFIED_ROW, discoverable: true, since: NOW_MS - 3_600_000 } as db.AccountIdentifierRow | null };
    jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => device.row);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: NOW_MS - 3_600_000, emailFindable: false }));
    jest.spyOn(db, 'saveAccountIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(tree, 'discoverable-toggle', 'onValueChange')!.props.value).toBe(false);
    expect(device.row?.discoverable).toBe(false);
    tree.unmount();
  });

  it('a RESTORED placeholder settles from the readable bit: the switch shows the account’s setting and the placeholder notice is gone', async () => {
    const device = {
      row: { ...VERIFIED_ROW, discoverable: false, restoredAt: NOW_MS - 60_000, since: null } as db.AccountIdentifierRow | null,
    };
    jest.spyOn(db, 'loadAccountIdentifier').mockImplementation(async () => device.row);
    jest
      .spyOn(accounts, 'loadIdentifierState')
      .mockResolvedValue(stateOf({ emailLinked: true, emailSince: NOW_MS - 3_600_000, emailFindable: true }));
    jest.spyOn(db, 'saveAccountIdentifier').mockImplementation(async row => {
      device.row = { ...row };
    });
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(node(tree, 'discoverable-toggle', 'onValueChange')!.props.value).toBe(true);
    expect(device.row?.restoredAt).toBeNull();
    expect(has(tree, 'discoverable-restored')).toBe(false);
    tree.unmount();
  });

  it('the legacy read (no bit) leaves the row and the placeholder alone', async () => {
    const restored: db.AccountIdentifierRow = { ...VERIFIED_ROW, discoverable: false, restoredAt: NOW_MS - 60_000 };
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(restored);
    jest.spyOn(accounts, 'loadIdentifierState').mockResolvedValue(stateOf({ ...LEGACY_UNKNOWN }));
    const save = jest.spyOn(db, 'saveAccountIdentifier').mockResolvedValue(undefined);
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    expect(has(tree, 'discoverable-restored')).toBe(true);
    expect(save).not.toHaveBeenCalled();
    tree.unmount();
  });
});
