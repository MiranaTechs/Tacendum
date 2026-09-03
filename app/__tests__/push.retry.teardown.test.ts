/**
 * THE ALERT RETRY MUST DIE WITH THE SESSION THAT ARMED IT.
 *
 * `startCalling`'s teardown already calls `clearAlertRetry()`, and the comment
 * beside it states the rule for the metric heartbeat one line down: "a timer
 * outliving its teardown reaches whatever workspace the next verdict
 * declares". The alert retry had a hole in exactly that rule.
 *
 * THE RACE. `uploadPushTokens` is fire-and-forget at all six of its call
 * sites (`void uploadPushTokens()`), and its catch arms a retry — deliberately
 * so, because a PUT that dies on a phone falling off Wi-Fi mid-launch used to
 * leave the device unreachable until the next launch. But the catch runs when
 * the network answers, which can be after the session ended. Sequence:
 *
 *   1. the verdict lands → `adoptPushRegistration({real:true})` → PUT on the wire
 *   2. the calling session tears down → `clearAlertRetry()` clears the timer
 *   3. the PUT fails → the catch calls `armAlertRetry()` → a NEW 5s timer,
 *      armed into a session that no longer exists, with five more behind it
 *
 * `clearAlertRetry` cleared the pending timer but left `alertRetriesLeft` at
 * its full budget, and `armAlertRetry` is gated on that budget alone — so
 * step 3 sailed through and the retry chain outlived the teardown, six PUTs
 * over thirty seconds with the previous session's bearer token, against
 * whatever workspace the next verdict had since declared.
 *
 * It also made the app suite exit 1 with zero failing tests: the leaked timer
 * fires after jest tears the environment down, `uploadPushTokens` resumes,
 * reads `Platform.OS` through react-native's lazy index getter, and throws an
 * unhandled "You are trying to `import` a file after the Jest environment has
 * been torn down" — which is a red CI check with nothing red in it.
 *
 * The fix is one line in `clearAlertRetry`: zero the budget too, so the
 * teardown's intent ("no more retries") cannot be undone by a promise that
 * had not settled yet. Every legitimate re-arm restores the budget first —
 * `adoptPushRegistration` (a fresh verdict), `nudgePushRegistration`
 * (foregrounding) and `restorePushTokens` (consent restored) all set it
 * before they upload.
 */
import { adoptPushRegistration, resetCallingForTests, startCalling } from '../src/call';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterFcmToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 60 })),
  onApiAuthRenewed: jest.fn(() => () => undefined),
}));

const api = jest.requireMock('../src/api') as { apiRegisterPushToken: jest.Mock };
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

beforeEach(() => {
  jest.useFakeTimers();
  keychain.clear();
  // A session, or the upload exits at "no auth token" and never reaches the
  // catch this file is about.
  keychain.set('authToken', 'session-1');
  api.apiRegisterPushToken.mockReset();
});

afterEach(() => {
  resetCallingForTests();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** The failure the retry exists for: the PUT dies on a flapping network. */
function uploadsFail(): void {
  api.apiRegisterPushToken.mockRejectedValue(new Error('network unreachable'));
}

describe('the armed alert retry', () => {
  it('CONTROL: a failed upload inside a live session arms a retry that fires', async () => {
    // Without this the test below cannot tell "the fix worked" from "the
    // retry never existed".
    uploadsFail();
    adoptPushRegistration({ real: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(2);
  });

  it('cannot be re-armed by an upload that fails AFTER calling stopped', async () => {
    uploadsFail();
    const stopCalling = await startCalling();

    // The production shape exactly: the verdict fires `void uploadPushTokens()`
    // and the PUT is still on the wire when the session ends — a relock, or
    // App unmounting the effect that owns `startCalling`.
    adoptPushRegistration({ real: true });
    stopCalling();

    // Now the PUT answers, and its catch reaches for `armAlertRetry`.
    await jest.advanceTimersByTimeAsync(0);
    const afterTeardown = api.apiRegisterPushToken.mock.calls.length;
    expect(afterTeardown).toBe(1);

    // Six retries, five seconds apart, is the whole budget: advancing past it
    // proves the chain is gone rather than merely slow. Pre-fix this was 7 —
    // the ended session's bearer, six more times, thirty seconds after it died.
    await jest.advanceTimersByTimeAsync(60_000);

    expect(api.apiRegisterPushToken.mock.calls.length).toBe(afterTeardown);
  });

  it('a fresh verdict after a teardown still registers and still retries', async () => {
    // The budget-zeroing must not be permanent: the next real unlock has to
    // get its six retries back, or one teardown would cost the device its
    // token race for the rest of the process.
    uploadsFail();
    const stopCalling = await startCalling();
    stopCalling();

    adoptPushRegistration({ real: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(2);
  });
});
