/**
 * Withdrawing this device's push tokens.
 *
 * THE GAP THIS CLOSES. iOS issues a PushKit token without asking. It is
 * independent of the notification prompt, the app registers for it at launch,
 * and it was uploaded with whatever else existed — so someone who DECLINED
 * notifications still had a VoIP token on the server, bound to their account
 * id, with no way to take it back short of deleting the account. The
 * published privacy policy admitted exactly that. App Store 5.1.1(ii) asks
 * for consent and an understandable withdrawal; this is the withdrawal.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE THIRD ONE BELOW. A withdrawal that
 * quietly undoes itself on the next launch is worse than no withdrawal at
 * all, because the person believes it held. Every path that could re-upload
 * — cold launch, foreground nudge, the armed alert retry — runs through
 * `uploadPushTokens`, so the guard lives there and this file proves it.
 */
import { apiDeletePushToken } from '../src/api';
import { adoptPushRegistration, uploadPushTokens } from '../src/call';
import {
  loadPushConsent,
  pushTokensAllowed,
  setPushTokensAllowed,
} from '../src/pushConsent';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [] })),
}));

beforeEach(async () => {
  keychain.clear();
  (apiDeletePushToken as jest.Mock).mockClear();
  await loadPushConsent();
});

describe('push-token consent', () => {
  it('defaults to allowed', async () => {
    // Deliberate: the token is what makes a locked phone ring, so defaulting
    // off would break calls for everyone to serve the minority who want no
    // token. The disclosure sits beside the switch instead.
    await loadPushConsent();
    expect(pushTokensAllowed()).toBe(true);
  });

  it('persists a withdrawal to the Keychain, not to memory', async () => {
    await setPushTokensAllowed(false);
    expect(pushTokensAllowed()).toBe(false);

    // Simulate a relaunch: the module's in-memory value is re-read from
    // storage. This is the assertion that makes the withdrawal survive.
    await loadPushConsent();
    expect(pushTokensAllowed()).toBe(false);
  });

  it('persists a restoration too', async () => {
    await setPushTokensAllowed(false);
    await setPushTokensAllowed(true);
    await loadPushConsent();
    expect(pushTokensAllowed()).toBe(true);
  });

  it('stores it OUTSIDE the message database', async () => {
    // Keychain, like read receipts and screen security, for two reasons: it
    // must survive a workspace wipe, and it must not live in the decoy
    // database where a duress session could read or change it.
    await setPushTokensAllowed(false);
    expect(keychain.has('tacendum.pushTokens')).toBe(true);
  });

  it('fails OPEN when the Keychain cannot be read', async () => {
    // A hiccup here must not silently stop calls ringing a locked phone —
    // that failure would be invisible, since the whole push path swallows its
    // own errors by design. Failing to the default is the lesser harm.
    const crypto = jest.requireMock('tacendum-crypto') as {
      getSecret: jest.Mock;
    };
    const original = crypto.getSecret;
    crypto.getSecret = jest.fn(async () => {
      throw new Error('keychain unavailable');
    });

    await loadPushConsent();
    expect(pushTokensAllowed()).toBe(true);

    crypto.getSecret = original;
  });
});

describe('uploadPushTokens respects the withdrawal', () => {
  it('sends nothing once tokens are turned off', async () => {
    // The load-bearing test. Cold launch, foreground nudge and the armed
    // alert retry all funnel through uploadPushTokens, so a guard here covers
    // every path that could resurrect the row the person just deleted.
    const { apiRegisterPushToken } = jest.requireMock('../src/api') as {
      apiRegisterPushToken: jest.Mock;
    };
    // A session must exist, or the upload exits at "no auth token" and the
    // assertion below passes without the guard ever running. Verified by
    // deleting the guard and watching this test go red.
    keychain.set('authToken', 'session-1');
    // And a VERDICT must exist, for the same reason and one guard earlier.
    // `uploadPushTokens` now refuses outright until an unlock has said which
    // world this is — the two PushKit listeners fire from a mount effect, so
    // without that refusal the real account's bearer went up on every launch,
    // duress launches included. Told here rather than mocked away, because a
    // test that skipped the verdict would exit above the consent guard and
    // pass without ever reaching it.
    adoptPushRegistration({ real: true });

    // Control first: with consent intact, this DOES upload. Without it the
    // test is indistinguishable from one that never reached the guard.
    apiRegisterPushToken.mockClear();
    await setPushTokensAllowed(true);
    await uploadPushTokens();
    expect(apiRegisterPushToken).toHaveBeenCalled();

    apiRegisterPushToken.mockClear();
    await setPushTokensAllowed(false);
    await uploadPushTokens();

    expect(apiRegisterPushToken).not.toHaveBeenCalled();
  });
});
