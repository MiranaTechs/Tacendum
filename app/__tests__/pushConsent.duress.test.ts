/**
 * The push-consent row under coercion.
 *
 * THREE FAULTS, ONE TAP. Before this, a coerced tap on the push row:
 * 1. showed the OWNER'S real value in the decoy, so a coercer could read a
 * withdrawal straight off the screen;
 * 2. wrote `'0'` to the Keychain before it reached the network, permanently
 * withdrawing the owner's real consent — after which their phone silently
 * stopped being wakeable and nothing ever told them;
 * 3. rendered `COPY.pushFailed` every single time, because `api.ts:248-250`
 * throws for every request made in a duress session while the same tap in
 * a real session succeeds silently. One tap, one deterministic
 * discriminator, on the very screen whose Field Mode row is documented as
 * needing this protection (rule 16).
 *
 * (3) IS THE ONE THAT MATTERS MOST, and it is why the fix is not simply "do
 * not write". A guard that stopped the write but let the network step run
 * would keep the error, and the error is the tell. The row must move, say
 * nothing, and look exactly like the owner's own session.
 *
 * WHY THIS FILE RENDERS THROUGH `React.createElement`. The rendered half of
 * the claim belongs beside the module half — the tell is only visible where
 * the two meet — and this cluster's test file for it is a `.ts`. The screen
 * itself is imported unchanged.
 *
 * FALSIFIERS, run at authoring time and restored (CONTRIBUTING.md:76-80):
 * - drop the duress guard from `withdrawPushTokens`, or move it BELOW the
 * delete: 2 of 5 fail either way — the network case and the rendered
 * comparison, which is the shipped tell reappearing verbatim. The
 * durability case stays green, because the Keychain half is already held
 * by the guard inside `setPushTokensAllowed`; two guards, two claims;
 * - drop the duress guard from `restorePushTokens`: 1 of 5 fails, the case
 * that leaves the registration verdict stale, and it fails by putting the
 * owner's real bearer token on the wire out of a coerced session;
 * - drop the duress guard from `loadPushConsent`: 1 of 6 fails, the coerced
 * load, and it fails by snapping the row back to On under the coercer's
 * hand. That case was written red against exactly that.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as crypto from 'tacendum-crypto';
import {
  adoptPushRegistration,
  resetCallingForTests,
  restorePushTokens,
  withdrawPushTokens,
} from '../src/call';
import {
  loadPushConsent,
  pushTokensAllowed,
  resetPushConsentForDuress,
  setPushTokensAllowed,
} from '../src/pushConsent';
import { session } from '../src/session';
import { SettingsScreen } from '../src/screens/SettingsScreen';

/**
 * `api.ts` is mocked here as it is in every Settings suite, so its own duress
 * refusal (`:248-250`, a `TypeError('Network request failed')` chosen to be
 * indistinguishable from being offline) is modelled rather than imported.
 * `refuseAsDuressWould` turns it on for the cases that need to prove the tell
 * is gone: after the fix nothing reaches these functions from a coerced
 * session at all, which is why the flag can be left armed and change nothing.
 */
const mockNet = { refuseAsDuressWould: false };
jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => {
    if (mockNet.refuseAsDuressWould) throw new TypeError('Network request failed');
  }),
  apiRegisterPushToken: jest.fn(async () => {
    if (mockNet.refuseAsDuressWould) throw new TypeError('Network request failed');
  }),
  apiRegisterFcmToken: jest.fn(async () => {
    if (mockNet.refuseAsDuressWould) throw new TypeError('Network request failed');
  }),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
  onApiAuthRenewed: jest.fn(() => () => {}),
}));

const api = jest.requireMock('../src/api') as {
  apiDeletePushToken: jest.Mock;
  apiRegisterPushToken: jest.Mock;
};

const keychain = (crypto as unknown as { __keychain: Map<string, string> })
  .__keychain;

beforeEach(() => {
  keychain.clear();
  mockNet.refuseAsDuressWould = false;
  session.setMode('real');
  resetCallingForTests();
  resetPushConsentForDuress();
  api.apiDeletePushToken.mockClear();
  api.apiRegisterPushToken.mockClear();
});

afterEach(() => {
  session.setMode('real');
  resetCallingForTests();
  jest.restoreAllMocks();
});

describe('what the decoy shows', () => {
  it('shows the DEFAULT, never the owner’s withdrawal', async () => {
    keychain.set('tacendum.pushTokens', '0');
    await loadPushConsent();
    expect(pushTokensAllowed()).toBe(false);

    session.setMode('duress');

    // Off in this row says "this phone deleted the token that wakes it" —
    // a fact about the owner, readable in one glance by whoever is holding
    // the phone. The decoy answers with the shipped default instead.
    expect(pushTokensAllowed()).toBe(true);
  });

  it('a load reached from a coerced session reads nothing and resets nothing', async () => {
    // `loadPushConsent` is called only on App.tsx's REAL unlock arm today, so
    // this guards the NEXT caller rather than a live defect — which is
    // precisely the history `loadMessageSound` has: it grew the same line
    // when `messaging.start()` became its caller. Without it, a load reached
    // from a coerced session snaps the row from the coercer's Off back to On
    // in front of them — a tell — and resets the shadow the decoy stands on.
    keychain.set('tacendum.pushTokens', '1');
    await loadPushConsent();

    session.setMode('duress');
    await setPushTokensAllowed(false); // the coercer turns the row off
    await loadPushConsent();

    expect(pushTokensAllowed()).toBe(false); // the row stayed where they left it

    session.setMode('real');
    expect(pushTokensAllowed()).toBe(true); // and the owner's value is intact
  });

  it('gives the owner’s value straight back when the real session returns', async () => {
    keychain.set('tacendum.pushTokens', '0');
    await loadPushConsent();
    session.setMode('duress');
    await setPushTokensAllowed(true); // a coerced tap, moving the shadow
    session.setMode('real');

    expect(pushTokensAllowed()).toBe(false);
  });
});

describe('a coerced tap never reaches the network', () => {
  it('withdrawPushTokens deletes nothing and keeps the owner’s consent', async () => {
    keychain.set('authToken', 'owner-bearer');
    keychain.set('tacendum.pushTokens', '1');
    await loadPushConsent();

    session.setMode('duress');
    await withdrawPushTokens();

    // The three claims in the order they matter: the owner's stored consent
    // is untouched, no bearer of theirs went out, and the row still moved.
    expect(keychain.get('tacendum.pushTokens')).toBe('1');
    expect(api.apiDeletePushToken).not.toHaveBeenCalled();
    expect(pushTokensAllowed()).toBe(false);

    session.setMode('real');
    expect(pushTokensAllowed()).toBe(true);
  });

  it('restorePushTokens uploads nothing, even with a stale real verdict', async () => {
    // Belt over braces, and the belt is the one that matters: App.tsx calls
    // `adoptPushRegistration({ real: false })` on the way into a duress
    // session, but on a RELOCK the latch is still true from the real session
    // that just ended. This case leaves it true on purpose.
    keychain.set('authToken', 'owner-bearer');
    adoptPushRegistration({ real: true });
    api.apiRegisterPushToken.mockClear();

    session.setMode('duress');
    await restorePushTokens();

    expect(api.apiRegisterPushToken).not.toHaveBeenCalled();
    expect(keychain.get('tacendum.pushTokens')).toBeUndefined();
  });
});

// --- the row, rendered ------------------------------------------------------

/** What the push row is showing: the two chips' state and every string in it.
 * Not the whole screen — the claim is about this row. */
interface PushRowState {
  on: unknown;
  off: unknown;
  error: string | null;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function renderSettings(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      React.createElement(SettingsScreen, {
        initialSection: 'notifications',
        onBack: () => {},
        onOpenLinkedDevices: () => {},
        onOpenAccountEmail: () => {},
      }),
    );
    await flush();
  });
  return tree;
}

function pushRow(tree: ReactTestRenderer.ReactTestRenderer): PushRowState {
  const errors = tree.root.findAllByProps({ testID: 'settings-push-error' });
  return {
    on: tree.root.findByProps({ testID: 'settings-push-on' }).props
      .accessibilityState,
    off: tree.root.findByProps({ testID: 'settings-push-off' }).props
      .accessibilityState,
    error: errors.length
      ? String(errors[0].props.message ?? errors[0].props.children)
      : null,
  };
}

async function tapOff(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID: 'settings-push-off' }).props.onPress();
    await flush();
  });
}

describe('the tap looks the same in both sessions', () => {
  it('renders no error in a coerced session, exactly as in a real one', async () => {
    keychain.set('authToken', 'owner-bearer');
    keychain.set('tacendum.pushTokens', '1');
    await loadPushConsent();

    const real = await renderSettings();
    await tapOff(real);
    const realState = pushRow(real);
    await ReactTestRenderer.act(async () => real.unmount());

    session.setMode('duress');
    resetPushConsentForDuress();
    // The network refuses everything from here, as it does on the device.
    mockNet.refuseAsDuressWould = true;

    const coerced = await renderSettings();
    await tapOff(coerced);
    const coercedState = pushRow(coerced);
    await ReactTestRenderer.act(async () => coerced.unmount());

    // The row that used to carry 'The token was not deleted…' in one session
    // and nothing in the other.
    expect(coercedState.error).toBeNull();
    expect(realState.error).toBeNull();
    expect(coercedState).toEqual(realState);
  });
});
