/**
 * A TRANSPORT failure is not a server refusal. accounts.ts distinguishes
 * 'failed' (offline, DNS, a dead socket — and every call in a duress
 * session, api.ts:101) from 'refused' (the collapsed 403), and the
 * username screen already renders the two apart. The email, phone and
 * recovery screens folded 'failed' into the refusal sentence ("the code
 * may be wrong or expired…"), which lies about what happened and breaks
 * the duress offline cover story (rule 15) on these three surfaces. Each
 * handler must render the connection sentence for a 'failed' outcome and
 * NOT the refusal sentence.
 *
 * One more thing rides along: the three 6-digit code fields carry the
 * one-time-code autofill hints. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as accounts from '../src/accounts';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as accountsPhone from '../src/accountsPhone';
import { ACCOUNTS_PHONE_COPY } from '../src/accountsPhoneCopy';
import * as db from '../src/db';
import { AccountEmailScreen } from '../src/screens/AccountEmailScreen';
import { AccountPhoneScreen } from '../src/screens/AccountPhoneScreen';
import { RecoveryScreen } from '../src/screens/RecoveryScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

// The phone surfaces are dark behind the build pin; this suite reads them
// with the pin ON (the state the phone train will ship in), exactly as
// phone-ux.test.tsx does.
jest.mock('../src/phoneUi', () => ({ PHONE_UI_ENABLED: true }));

const NOW_MS = 1_756_000_000_000;
const SELF = '01HQSELF000000000000000000';

async function render(el: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

function node(tree: ReactTestRenderer.ReactTestRenderer, testID: string, prop: string) {
  return tree.root
    .findAllByProps({ testID })
    .find(n => n.props[prop] !== undefined)!;
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, testID: string, text: string) {
  await ReactTestRenderer.act(async () => {
    node(tree, testID, 'onChangeText').props.onChangeText(text);
  });
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  await ReactTestRenderer.act(async () => {
    node(tree, testID, 'onPress').props.onPress();
  });
}

function errorText(tree: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  const rendered = JSON.stringify(tree.toJSON());
  const shown = tree.root.findAllByProps({ testID });
  expect(shown.length).toBeGreaterThan(0);
  return rendered;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW_MS });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('AccountEmailScreen renders a transport failure as a connection problem', () => {
  it('on the code request', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue(null);
    jest.spyOn(accounts, 'requestAttachCode').mockResolvedValue('failed');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    await type(tree, 'account-email-input', 'alice@example.com');
    await press(tree, 'account-email-request');
    const rendered = errorText(tree, 'account-email-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.emailRefused);
    tree.unmount();
  });

  it('on the verify', async () => {
    jest.spyOn(db, 'loadAccountIdentifier').mockResolvedValue({
      email: null,
      verifiedAt: null,
      discoverable: false,
      pendingEmail: 'alice@example.com',
      pendingRequestedAt: NOW_MS - 30_000,
      restoredAt: null,
    });
    jest.spyOn(accounts, 'confirmAttach').mockResolvedValue('failed');
    const tree = await render(<AccountEmailScreen onBack={jest.fn()} />);
    // The code field carries the one-time-code autofill hints.
    const code = node(tree, 'account-email-code', 'onChangeText');
    expect(code.props.autoComplete).toBe('one-time-code');
    expect(code.props.textContentType).toBe('oneTimeCode');
    await type(tree, 'account-email-code', '123456');
    await press(tree, 'account-email-verify');
    const rendered = errorText(tree, 'account-email-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.emailRefused);
    tree.unmount();
  });
});

describe('AccountPhoneScreen renders a transport failure as a connection problem', () => {
  it('on the code request', async () => {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue(null);
    jest.spyOn(accountsPhone, 'requestPhoneAttachCode').mockResolvedValue('failed');
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    await type(tree, 'account-number-input', '+15555550100');
    await press(tree, 'account-number-sms-consent');
    await press(tree, 'account-number-request');
    const rendered = errorText(tree, 'account-number-error');
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_PHONE_COPY.numberRefused);
    tree.unmount();
  });

  it('on the verify', async () => {
    jest.spyOn(db, 'loadPhoneIdentifier').mockResolvedValue({
      phone: null,
      verifiedAt: null,
      discoverable: false,
      pendingPhone: '+15555550100',
      pendingRequestedAt: NOW_MS - 30_000,
      restoredAt: null,
    });
    jest.spyOn(accountsPhone, 'confirmPhoneAttach').mockResolvedValue('failed');
    const tree = await render(<AccountPhoneScreen onBack={jest.fn()} />);
    const code = node(tree, 'account-number-code', 'onChangeText');
    expect(code.props.autoComplete).toBe('one-time-code');
    expect(code.props.textContentType).toBe('oneTimeCode');
    await type(tree, 'account-number-code', '123456');
    await press(tree, 'account-number-verify');
    const rendered = errorText(tree, 'account-number-error');
    expect(rendered).toContain(ACCOUNTS_PHONE_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_PHONE_COPY.numberRefused);
    tree.unmount();
  });
});

describe('RecoveryScreen renders a transport failure as a connection problem', () => {
  const profile = { userId: SELF, registrationId: 7 } as unknown as db.ProfileRow;

  function mount() {
    return render(
      <RecoveryScreen
        profile={profile}
        onBack={jest.fn()}
        onCreateIdentity={jest.fn()}
        onDone={jest.fn()}
      />,
    );
  }

  it('on the code request (email class)', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadRecoveryRequest').mockResolvedValue(null);
    jest.spyOn(accounts, 'requestRecoveryCode').mockResolvedValue('failed');
    const tree = await mount();
    await type(tree, 'recovery-email-input', 'alice@example.com');
    await press(tree, 'recovery-request-code');
    const rendered = errorText(tree, 'recovery-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.recoverRefused);
    tree.unmount();
  });

  it('on the code request (phone class)', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadRecoveryRequest').mockResolvedValue(null);
    jest.spyOn(accounts, 'requestRecoveryCodeByPhone').mockResolvedValue('failed');
    const tree = await mount();
    await press(tree, 'recovery-class-number');
    await type(tree, 'recovery-email-input', '+15555550100');
    await press(tree, 'recovery-request-code');
    const rendered = errorText(tree, 'recovery-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.recoverRefused);
    tree.unmount();
  });

  it('on the verify', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue(null);
    jest.spyOn(accounts, 'loadRecoveryRequest').mockResolvedValue(null);
    jest.spyOn(accounts, 'requestRecoveryCode').mockResolvedValue('sent');
    jest.spyOn(accounts, 'confirmRecoveryCode').mockResolvedValue({ outcome: 'failed' });
    const tree = await mount();
    await type(tree, 'recovery-email-input', 'alice@example.com');
    await press(tree, 'recovery-request-code');
    const code = node(tree, 'recovery-code-input', 'onChangeText');
    expect(code.props.autoComplete).toBe('one-time-code');
    expect(code.props.textContentType).toBe('oneTimeCode');
    await type(tree, 'recovery-code-input', '123456');
    await press(tree, 'recovery-verify');
    const rendered = errorText(tree, 'recovery-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.recoverRefused);
    tree.unmount();
  });

  it('on the completion', async () => {
    jest.spyOn(db, 'loadLocalRecovery').mockResolvedValue({
      kind: db.EMAIL_KIND,
      value: 'alice@example.com',
      groupId: '01HQGGGG0000000000000000G0',
      completesAt: Math.floor(NOW_MS / 1000) - 1,
      verifiedAt: NOW_MS - 3 * 24 * 3_600_000,
    });
    jest.spyOn(accounts, 'loadRecoveryRequest').mockResolvedValue(null);
    jest.spyOn(accounts, 'completeRecovery').mockResolvedValue('failed');
    const tree = await mount();
    await press(tree, 'recovery-complete');
    const rendered = errorText(tree, 'recovery-error');
    expect(rendered).toContain(ACCOUNTS_COPY.failed);
    expect(rendered).not.toContain(ACCOUNTS_COPY.recoverCompleteRefused);
    tree.unmount();
  });
});
