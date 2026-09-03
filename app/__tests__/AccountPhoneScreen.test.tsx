/**
 * The resend minute for the PHONE class, pin ON: after a text is requested,
 * "Send another code" waits out the server's per-number minute visibly —
 * a tap inside it sends nothing and answers the same, so the button says
 * how long the wait is instead of inviting it. Derived from the durable
 * row, so it survives a remount. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as accountsPhone from '../src/accountsPhone';
import { ACCOUNTS_PHONE_COPY } from '../src/accountsPhoneCopy';
import * as db from '../src/db';
import { AccountPhoneScreen } from '../src/screens/AccountPhoneScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));
jest.mock('../src/phoneUi', () => ({ PHONE_UI_ENABLED: true }));

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

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  await ReactTestRenderer.act(async () => {
    node(tree, testID, 'onPress')!.props.onPress();
  });
}

/** Wall clock and timers together — never one without the other. */
async function elapse(ms: number) {
  await ReactTestRenderer.act(async () => {
    // Modern fake timers move Date.now() WITH the timers they run, so this
    // one call is the lock-step: a setSystemTime beside it would move the
    // wall clock twice (0:34 where 0:47 was due).
    jest.advanceTimersByTime(ms);
  });
}

function pendingRow(requestedAt: number): db.PhoneIdentifierRow {
  return {
    phone: null,
    verifiedAt: null,
    discoverable: false,
    pendingPhone: '+15555550100',
    pendingRequestedAt: requestedAt,
    restoredAt: null,
  };
}

const request = (tree: ReactTestRenderer.ReactTestRenderer) =>
  node(tree, 'account-number-request', 'onPress')!;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW_MS });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('after a text is requested the button counts the minute down, then re-arms', async () => {
  jest
    .spyOn(db, 'loadPhoneIdentifier')
    .mockResolvedValueOnce(null)
    .mockResolvedValue(pendingRow(NOW_MS));
  jest.spyOn(accountsPhone, 'requestPhoneAttachCode').mockResolvedValue('sent');
  const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
  await ReactTestRenderer.act(async () => {
    node(tree, 'account-number-input', 'onChangeText')!.props.onChangeText('+15555550100');
  });
  await press(tree, 'account-number-sms-consent');
  await press(tree, 'account-number-request');
  expect(request(tree).props.disabled).toBe(true);
  expect(request(tree).props.label).toBe(ACCOUNTS_PHONE_COPY.numberRequestAgainIn('1:00'));
  await elapse(13_000);
  expect(request(tree).props.label).toBe(ACCOUNTS_PHONE_COPY.numberRequestAgainIn('0:47'));
  await elapse(47_000);
  expect(request(tree).props.disabled).toBe(false);
  expect(request(tree).props.label).toBe(ACCOUNTS_PHONE_COPY.numberRequestAgain);
  tree.unmount();
});

test('the countdown survives a remount, from the row', async () => {
  jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(pendingRow(NOW_MS - 13_000));
  const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
  await press(tree, 'account-number-sms-consent');
  expect(request(tree).props.disabled).toBe(true);
  expect(request(tree).props.label).toBe(ACCOUNTS_PHONE_COPY.numberRequestAgainIn('0:47'));
  tree.unmount();
});
