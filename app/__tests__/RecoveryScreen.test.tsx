/**
 * A REQUESTED recovery code is remembered.
 *
 * Nothing local recorded that a recovery code had been asked for (the
 * attach flow writes `pendingEmail`; this flow wrote nothing), so with
 * autolock at "Right away" — the default — "tap Email me a code → open
 * Mail → return" relocked the app, the screen came back as an empty form,
 * and a re-request inside the resend minute quietly sent nothing while the
 * person waited for a code that never came. The screen now restores the
 * class, the address and the code field from a Keychain memo for the
 * code's own 5-minute life, and offers "I already have a code" for the
 * cases the memo cannot cover.
 *
 * The first test drives the REAL accounts module (api and token spied, the
 * jest Keychain in between): request on one mount, unmount (the relock),
 * mount again inside the window. Clock and timers move in lock-step. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as api from '../src/api';
import * as accounts from '../src/accounts';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as db from '../src/db';
import * as reauth from '../src/reauth';
import { RecoveryScreen } from '../src/screens/RecoveryScreen';
import { session } from '../src/session';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const NOW_MS = 1_756_000_000_000;
const SELF = '01HQSELF000000000000000000';
const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
  });
  return tree;
}

function node(tree: ReactTestRenderer.ReactTestRenderer, testID: string, prop: string) {
  return tree.root.findAllByProps({ testID }).find(n => n.props[prop] !== undefined);
}

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

/** Wall clock and timers together — never one without the other. */
async function elapse(ms: number) {
  await ReactTestRenderer.act(async () => {
    // Modern fake timers move Date.now() WITH the timers they run, so this
    // one call is the lock-step: a setSystemTime beside it would move the
    // wall clock twice (0:34 where 0:47 was due).
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
  jest.useFakeTimers({ now: NOW_MS });
  jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
  jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a requested code survives a relock inside its window: same address, code field back', async () => {
  const request = jest.spyOn(api, 'apiRecoveryRequestCode').mockResolvedValue(undefined);
  const first = await mount();
  expect(node(first, 'recovery-code-input', 'onChangeText')).toBeUndefined();
  await type(first, 'recovery-email-input', 'Alice@Example.com');
  await press(first, 'recovery-request-code');
  expect(request).toHaveBeenCalledTimes(1);
  expect(node(first, 'recovery-code-input', 'onChangeText')).toBeDefined();
  first.unmount(); // the relock

  await elapse(2 * 60_000);
  const second = await mount();
  expect(node(second, 'recovery-email-input', 'onChangeText')!.props.value).toBe(
    'alice@example.com',
  );
  expect(node(second, 'recovery-code-input', 'onChangeText')).toBeDefined();
  expect(JSON.stringify(second.toJSON())).toContain(
    ACCOUNTS_COPY.recoverCodeSent('alice@example.com'),
  );
  second.unmount();
});

test('past the window nothing is restored, and the memo is gone', async () => {
  jest.spyOn(api, 'apiRecoveryRequestCode').mockResolvedValue(undefined);
  const first = await mount();
  await type(first, 'recovery-email-input', 'alice@example.com');
  await press(first, 'recovery-request-code');
  first.unmount();

  await elapse(accounts.PENDING_CODE_TTL_MS + 1_000);
  const second = await mount();
  expect(node(second, 'recovery-email-input', 'onChangeText')!.props.value).toBe('');
  expect(node(second, 'recovery-code-input', 'onChangeText')).toBeUndefined();
  expect(keychain.has('recovery.request')).toBe(false);
  second.unmount();
});

test('a transport failure remembers nothing', async () => {
  jest
    .spyOn(api, 'apiRecoveryRequestCode')
    .mockRejectedValue(new TypeError('Network request failed'));
  const first = await mount();
  await type(first, 'recovery-email-input', 'alice@example.com');
  await press(first, 'recovery-request-code');
  expect(JSON.stringify(first.toJSON())).toContain(ACCOUNTS_COPY.failed);
  first.unmount();

  const second = await mount();
  expect(node(second, 'recovery-code-input', 'onChangeText')).toBeUndefined();
  expect(keychain.has('recovery.request')).toBe(false);
  second.unmount();
});

test('a duress session neither writes nor reads the memo (rule 16)', async () => {
  keychain.set(
    'recovery.request',
    JSON.stringify({ address: 'alice@example.com', kind: 'email', requestedAt: NOW_MS - 1_000 }),
  );
  session.setMode('duress');
  expect(await accounts.loadRecoveryRequest()).toBeNull();
  const tree = await mount();
  expect(node(tree, 'recovery-email-input', 'onChangeText')!.props.value).toBe('');
  tree.unmount();
});

test('"I already have a code" reveals the code field; verify waits for the address', async () => {
  const tree = await mount();
  expect(node(tree, 'recovery-code-input', 'onChangeText')).toBeUndefined();
  await press(tree, 'recovery-have-code');
  expect(node(tree, 'recovery-code-input', 'onChangeText')).toBeDefined();
  await type(tree, 'recovery-code-input', '123456');
  expect(node(tree, 'recovery-verify', 'onPress')!.props.disabled).toBe(true);
  await type(tree, 'recovery-email-input', 'alice@example.com');
  expect(node(tree, 'recovery-verify', 'onPress')!.props.disabled).toBe(false);
  tree.unmount();
});

test('proving the code forgets the memo', async () => {
  jest.spyOn(api, 'apiRecoveryRequestCode').mockResolvedValue(undefined);
  jest
    .spyOn(api, 'apiRecoveryVerify')
    .mockResolvedValue({ groupId: '01HQGGGG0000000000000000G0', completesAt: 1 });
  jest.spyOn(db, 'saveLocalRecovery').mockResolvedValue(undefined);
  const tree = await mount();
  await type(tree, 'recovery-email-input', 'alice@example.com');
  await press(tree, 'recovery-request-code');
  expect(keychain.has('recovery.request')).toBe(true);
  await type(tree, 'recovery-code-input', '123456');
  await press(tree, 'recovery-verify');
  expect(keychain.has('recovery.request')).toBe(false);
  tree.unmount();
});

/* ── the resend minute and the pending wait ──────── */

describe('the resend minute and the pending wait', () => {
  const request = (tree: ReactTestRenderer.ReactTestRenderer) =>
    node(tree, 'recovery-request-code', 'onPress')!;

  test('after a send the request button counts the minute down, and the memo restores it on remount', async () => {
    jest.spyOn(api, 'apiRecoveryRequestCode').mockResolvedValue(undefined);
    const first = await mount();
    await type(first, 'recovery-email-input', 'alice@example.com');
    await press(first, 'recovery-request-code');
    expect(request(first).props.disabled).toBe(true);
    expect(request(first).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('1:00'));
    await elapse(13_000);
    expect(request(first).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('0:47'));
    first.unmount(); // the relock

    const second = await mount();
    expect(request(second).props.disabled).toBe(true);
    expect(request(second).props.label).toBe(ACCOUNTS_COPY.requestAgainIn('0:47'));
    await elapse(47_000);
    expect(request(second).props.disabled).toBe(false);
    expect(request(second).props.label).toBe(ACCOUNTS_COPY.recoverRequest);
    second.unmount();
  });

  test('the pending state says how long is left, relatively, and that Tacendum brings you back here', async () => {
    const nowSec = Math.floor(NOW_MS / 1000);
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue({
      kind: db.EMAIL_KIND,
      value: 'alice@example.com',
      groupId: '01HQGGGG0000000000000000G0',
      completesAt: nowSec + 2 * 86_400 + 3 * 3_600 + 20 * 60,
      verifiedAt: nowSec,
    });
    const tree = await mount();
    const text = () => JSON.stringify(tree.toJSON());
    expect(text()).toContain(ACCOUNTS_COPY.recoverPendingIn('2 days 3 hours'));
    expect(text()).toContain(ACCOUNTS_COPY.recoverPendingReturn);
    // The wait keeps counting while the screen is open.
    await elapse(4 * 3_600_000);
    expect(text()).toContain(ACCOUNTS_COPY.recoverPendingIn('1 day 23 hours'));
    tree.unmount();
  });

  test('the wait label: days and hours, then hours, then minutes, then less than a minute', () => {
    expect(ACCOUNTS_COPY.waitLabel(2 * 86_400_000 + 3 * 3_600_000 + 59 * 60_000)).toBe('2 days 3 hours');
    expect(ACCOUNTS_COPY.waitLabel(86_400_000 + 3_600_000)).toBe('1 day 1 hour');
    expect(ACCOUNTS_COPY.waitLabel(2 * 86_400_000)).toBe('2 days');
    expect(ACCOUNTS_COPY.waitLabel(3 * 3_600_000 + 30 * 60_000)).toBe('3 hours');
    expect(ACCOUNTS_COPY.waitLabel(3_600_000)).toBe('1 hour');
    expect(ACCOUNTS_COPY.waitLabel(12 * 60_000 + 5_000)).toBe('12 minutes');
    expect(ACCOUNTS_COPY.waitLabel(60_000)).toBe('1 minute');
    expect(ACCOUNTS_COPY.waitLabel(20_000)).toBe('less than a minute');
    expect(ACCOUNTS_COPY.waitLabel(-5)).toBe('less than a minute');
  });
});
