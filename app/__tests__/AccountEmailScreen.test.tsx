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
import * as db from '../src/db';
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
