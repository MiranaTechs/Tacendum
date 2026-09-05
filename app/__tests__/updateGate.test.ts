/**
 * The update gate's decision and its controller.
 *
 * Three things are proved here and nowhere else: the decision itself is a
 * pure function of one build number and one policy, so the boundaries can be
 * pinned exactly; a failed check falls back to the LAST STORED policy rather
 * than to "allow", so a blocked phone stays blocked in airplane mode; and a
 * duress session never dials the route at all — not "dials it and ignores the
 * answer", not at all, because rule 15 is that a coerced phone is
 * network-silent and a blocked decoy would announce that this is the decoy.
 */

jest.mock('../src/api', () => ({ apiClientPolicy: jest.fn() }));

import type { ClientPolicyResponse } from '@tacendum/shared';
import { apiClientPolicy } from '../src/api';
import { session } from '../src/session';
import {
  GATE_REQUEST_TIMEOUT_MS,
  type UpdateDecision,
  decide,
  dismissSoftUpdate,
  isSoftUpdateDismissed,
  updateGate,
} from '../src/updateGate';

const policyApi = apiClientPolicy as jest.MockedFunction<typeof apiClientPolicy>;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
};

/** A policy with the same floor on both stores unless a case says otherwise. */
function policy(
  ios: ClientPolicyResponse['ios'],
  android: ClientPolicyResponse['android'] = ios,
  message?: string,
): ClientPolicyResponse {
  return message === undefined
    ? { ios, android }
    : { ios, android, message };
}

beforeEach(() => {
  crypto.__keychain.clear();
  policyApi.mockReset();
  session.setMode('real');
  updateGate.resetForTests();
});

// --- the decision ------------------------------------------------------------

test('the floor is inclusive: the minimum build itself is allowed', () => {
  expect(decide({ build: 25, policy: policy({ minBuild: 25 }) })).toBe('ok');
});

test('one build below the floor is blocked', () => {
  expect(decide({ build: 24, policy: policy({ minBuild: 25 }) })).toBe(
    'blocked',
  );
});

test('no policy is no gate', () => {
  expect(decide({ build: 25, policy: undefined })).toBe('ok');
});

test("the other store's floor is not this device's", () => {
  const mixed = policy({ minBuild: 99 }, { minBuild: 1 });
  expect(decide({ build: 25, policy: mixed, platform: 'android' })).toBe('ok');
  expect(decide({ build: 25, policy: mixed, platform: 'ios' })).toBe('blocked');
});

test('a newer build on the store is a soft nudge, not a block', () => {
  expect(
    decide({ build: 25, policy: policy({ minBuild: 20, latestBuild: 26 }) }),
  ).toBe('soft');
});

test('a latest build that is not newer, or absent, is not a nudge', () => {
  expect(
    decide({ build: 25, policy: policy({ minBuild: 20, latestBuild: 25 }) }),
  ).toBe('ok');
  expect(decide({ build: 25, policy: policy({ minBuild: 20 }) })).toBe('ok');
});

test('the floor outranks the nudge', () => {
  expect(
    decide({ build: 24, policy: policy({ minBuild: 25, latestBuild: 26 }) }),
  ).toBe('blocked');
});

// --- the controller ----------------------------------------------------------

test('a blocked answer is remembered, and keeps blocking while the next check fails', async () => {
  policyApi.mockResolvedValueOnce(policy({ minBuild: 999 }));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('blocked');

  // A second process: nothing in memory, and the network is gone.
  updateGate.resetForTests();
  policyApi.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('blocked');
});

test('a failed check with nothing stored allows', async () => {
  policyApi.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('ok');
});

test('a server ahead of this build is unknown, never blocked', async () => {
  // What `parseDto` throws when the server answers a shape this build cannot
  // read (api.ts ServerAheadError). The gate does not classify failures — a
  // refusal it cannot parse is exactly as unknown as no network — so this
  // asserts the posture through the shape the seam actually produces.
  const ahead = new Error('update Tacendum: ClientPolicyResponse');
  ahead.name = 'ServerAheadError';
  policyApi.mockRejectedValueOnce(ahead);
  expect(await updateGate.checkNow('enterWorkspace')).toBe('ok');
});

test('a duress session never dials the route', async () => {
  // A real session stored a blocking policy first: the decoy must not
  // inherit it, and must not go looking for a fresher one either.
  policyApi.mockResolvedValueOnce(policy({ minBuild: 999 }));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('blocked');

  updateGate.resetForTests();
  session.setMode('duress');
  policyApi.mockClear();
  expect(await updateGate.checkNow('enterWorkspace')).toBe('ok');
  expect(policyApi).not.toHaveBeenCalled();
});

test('the foreground check asks at most once per six hours; an explicit re-check always asks', async () => {
  const start = 1_800_000_000_000;
  const now = jest.spyOn(Date, 'now').mockReturnValue(start);
  try {
    policyApi.mockResolvedValue(policy({ minBuild: 1 }));
    await updateGate.checkNow('foreground');
    expect(policyApi).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 6 * 60 * 60 * 1000 - 1);
    await updateGate.checkNow('foreground');
    expect(policyApi).toHaveBeenCalledTimes(1);

    // The person asking is never throttled.
    await updateGate.checkNow('recheck');
    expect(policyApi).toHaveBeenCalledTimes(2);

    now.mockReturnValue(start + 12 * 60 * 60 * 1000);
    await updateGate.checkNow('foreground');
    expect(policyApi).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
  }
});

test('the reason a check is happening reaches the request', async () => {
  // The controller is the only thing that knows WHY it is asking, and the
  // URL the request builds depends on it: the two waited-on reasons must not
  // be answerable from the five minute cache the route serves
  // (api.clientpolicy.test.ts pins the URLs themselves). Passing the reason
  // through is the half that can silently stop happening.
  policyApi.mockResolvedValue(policy({ minBuild: 1 }));
  await updateGate.checkNow('enterWorkspace');
  expect(policyApi).toHaveBeenLastCalledWith('enterWorkspace');

  await updateGate.checkNow('recheck');
  expect(policyApi).toHaveBeenLastCalledWith('recheck');

  await updateGate.checkNow('getStarted');
  expect(policyApi).toHaveBeenLastCalledWith('getStarted');
});

test('subscribers hear a decision change once', async () => {
  const heard = jest.fn();
  const off = updateGate.subscribe(heard);
  policyApi.mockResolvedValueOnce(policy({ minBuild: 999 }));
  await updateGate.checkNow('enterWorkspace');
  expect(heard).toHaveBeenCalledTimes(1);
  expect(updateGate.lastDecision).toBe('blocked');
  off();
});

test('the soft card is dismissed per store build, so the next release asks again', async () => {
  expect(await isSoftUpdateDismissed(26)).toBe(false);
  await dismissSoftUpdate(26);
  expect(await isSoftUpdateDismissed(26)).toBe(true);
  expect(await isSoftUpdateDismissed(27)).toBe(false);
});

test('a stored blob this build cannot read is ignored rather than obeyed', async () => {
  crypto.__keychain.set('updateGate.policy', '{"ios":{"minBuild":"twenty"}}');
  policyApi.mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('ok');
});

// --- the gate's own deadline -------------------------------------------------

test('a policy fetch that never answers is abandoned at the gate deadline', async () => {
  // The REST client's own twenty second deadline is the wrong budget for a
  // check three of whose four callers sit in front of a door; a network that
  // accepts the connection and never replies used to hold the workspace shut
  // for all twenty of them.
  crypto.__keychain.set(
    'updateGate.policy',
    JSON.stringify(policy({ minBuild: 999 })),
  );
  policyApi.mockReturnValue(new Promise<never>(() => undefined));
  jest.useFakeTimers();
  try {
    const asked = updateGate.checkNow('enterWorkspace');
    let settled: UpdateDecision | 'pending' = 'pending';
    void asked.then(d => {
      settled = d;
    });
    await Promise.resolve();
    expect(settled).toBe('pending');

    jest.advanceTimersByTime(GATE_REQUEST_TIMEOUT_MS);
    // And the timeout is a NON-ANSWER, not an allow: the stored policy is
    // what stands, exactly as it does for a rejection.
    await expect(asked).resolves.toBe('blocked');
  } finally {
    jest.useRealTimers();
  }
});

// --- whose answer it is ------------------------------------------------------

test('a session that is not the real one is told nothing the real one learned', async () => {
  policyApi.mockResolvedValueOnce(policy({ minBuild: 1, latestBuild: 999 }));
  expect(await updateGate.checkNow('enterWorkspace')).toBe('soft');
  expect(updateGate.softLatestBuild).toBe(999);

  // Relock, then a coerced unlock, inside one process. The gate is a module
  // singleton, so without a guard on the readers the decoy chat list read
  // the real session's answer straight out of it and raised its card.
  session.setMode('duress');
  expect(updateGate.softLatestBuild).toBeUndefined();
  expect(updateGate.policy).toBeUndefined();
  expect(updateGate.lastDecision).toBe('ok');
});

test('relocking forgets the answer and keeps the throttle', async () => {
  policyApi.mockResolvedValue(policy({ minBuild: 1, latestBuild: 999 }));
  const heard = jest.fn();
  const off = updateGate.subscribe(heard);
  await updateGate.checkNow('foreground');
  expect(updateGate.lastDecision).toBe('soft');

  updateGate.forgetSession();
  expect(updateGate.lastDecision).toBe('ok');
  expect(updateGate.policy).toBeUndefined();
  expect(updateGate.softLatestBuild).toBeUndefined();
  // A chat list already mounted has to be told, or it keeps painting a card
  // raised by a session that is over.
  expect(heard).toHaveBeenCalledTimes(2);
  off();

  // The throttle is this device's rate limit on an anonymous, fleet-wide
  // route rather than an answer, so locking and unlocking must not spend it.
  policyApi.mockClear();
  await updateGate.checkNow('foreground');
  expect(policyApi).not.toHaveBeenCalled();
});
