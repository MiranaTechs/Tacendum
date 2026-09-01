/**
 * Re-auth: the four rules that make a silent renewal safe.
 *
 * Every test here is about a way this can go wrong rather than a way it goes
 * right, because the happy path is three calls anyone would write. What is not
 * obvious is that a second mint DESTROYS the first (`POST /v1/auth` revokes
 * every prior session for the user), that the comparison which prevents it has
 * to be against the bearer that actually FAILED, that two of the answers are
 * terminal, and that a coerced session must produce none of this at all.
 *
 * The module is reloaded per test: its state — the in-flight lock, the
 * account-gone latch, the last token minted — is deliberately process-wide,
 * which is exactly what a shared registry between tests would smear.
 */

jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiProbeSession: jest.fn(),
}));

// reauth reads the profile for ONE reason: to refuse a userId that moved. The
// mock keeps that assertion about the rule rather than about whichever
// workspace some earlier suite happened to leave open.
jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

type Reauth = typeof import('../src/reauth');
type SessionModule = typeof import('../src/session');

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const IDENTITY_KEY = 'BQ0IDENTITYKEYBASE64';
const CHALLENGE = 'Q0hBTExFTkdF';
/** The 30-day-old bearer every caller in these tests is holding. */
const STALE = 'stale-token';

let reauth: Reauth;
let session: SessionModule['session'];
let api: {
  apiAuthChallenge: jest.Mock;
  apiAuth: jest.Mock;
  apiProbeSession: jest.Mock;
};
let db: { loadProfile: jest.Mock };
let crypto: {
  __keychain: Map<string, string>;
  identityPublicKey: jest.Mock;
  signAuthChallenge: jest.Mock;
  getSecret: jest.Mock;
  setSecret: jest.Mock;
};
let minted: number;

/** An ApiRequestError as `request()` throws it — matched by `name`, which is
 * exactly how reauth.ts classifies it (a mock that omitted the class would
 * otherwise turn the check into a TypeError inside a catch block). */
function apiError(status: number, code: string): Error {
  const err = new Error(code) as Error & { status: number; code: string };
  err.name = 'ApiRequestError';
  err.status = status;
  err.code = code;
  return err;
}

beforeEach(() => {
  jest.resetModules();
  api = jest.requireMock('../src/api');
  db = jest.requireMock('../src/db');
  crypto = jest.requireMock('tacendum-crypto');
  session = (jest.requireActual('../src/session') as SessionModule).session;
  reauth = jest.requireActual('../src/reauth') as Reauth;

  session.setMode('real');
  minted = 0;
  crypto.__keychain.clear();
  crypto.__keychain.set(reauth.AUTH_TOKEN_KEY, STALE);
  crypto.identityPublicKey.mockResolvedValue(IDENTITY_KEY);
  api.apiAuthChallenge.mockResolvedValue({ challenge: CHALLENGE, expiresAt: 0 });
  api.apiAuth.mockImplementation(async () => ({
    userId: USER_ID,
    authToken: `fresh-${++minted}`,
  }));
  db.loadProfile.mockResolvedValue(null);
});

test('five simultaneous 401s mint exactly one session', async () => {
  const results = await Promise.all([
    reauth.reauthenticate(STALE),
    reauth.reauthenticate(STALE),
    reauth.reauthenticate(STALE),
    reauth.reauthenticate(STALE),
    reauth.reauthenticate(STALE),
  ]);

  // All five callers get an answer — none is starved, and none is told "gone".
  expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  // …off ONE challenge and ONE auth. Five would have left four of these
  // callers holding tokens the fifth had already revoked.
  expect(api.apiAuthChallenge).toHaveBeenCalledTimes(1);
  expect(api.apiAuth).toHaveBeenCalledTimes(1);
  const writes = crypto.setSecret.mock.calls.filter(
    (c: unknown[]) => c[0] === reauth.AUTH_TOKEN_KEY,
  );
  expect(writes).toHaveLength(1);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe('fresh-1');
});

test('a 401 on a bearer that has since been replaced retries and mints nothing', async () => {
  // The staggered case — the one a naive single-flight misses, because by the
  // time the second caller looks there is no flight to join any more. Found in
  // another implementation of this same pattern.
  expect(await reauth.reauthenticate(STALE)).toBe('ok');
  expect(api.apiAuth).toHaveBeenCalledTimes(1);

  // A request that was already in flight when the renewal landed now answers
  // 401 — carrying the OLD bearer, because that is what it presented.
  expect(await reauth.reauthenticate(STALE)).toBe('ok');

  expect(api.apiAuth).toHaveBeenCalledTimes(1);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe('fresh-1');
});

test('a token another writer put in the Keychain is adopted, not raced', async () => {
  // App.tsx's boot heal and createOrRestoreAccount() write this key too and
  // never come through this module, so the in-memory "last minted" is null
  // here: only the Keychain knows the credential moved.
  await crypto.setSecret(reauth.AUTH_TOKEN_KEY, 'healed-by-boot');

  expect(await reauth.reauthenticate(STALE)).toBe('ok');

  expect(api.apiAuthChallenge).not.toHaveBeenCalled();
  expect(api.apiAuth).not.toHaveBeenCalled();
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe('healed-by-boot');
});

test('403 identity_tombstoned is terminal: no further attempt, ever', async () => {
  api.apiAuth.mockRejectedValue(apiError(403, 'identity_tombstoned'));
  const surfaced = jest.fn();
  reauth.onAccountGone(surfaced);

  expect(await reauth.reauthenticate(STALE)).toBe('gone');
  expect(reauth.accountGone()).toBe(true);
  expect(surfaced).toHaveBeenCalledTimes(1);

  // Even if the server would now answer — it will not, but the point is that
  // nothing asks. A deleted account 401s forever; retrying it on a timer is
  // the infinite loop this rule exists to stop.
  api.apiAuth.mockResolvedValue({ userId: USER_ID, authToken: 'never' });
  for (let i = 0; i < 5; i++) {
    expect(await reauth.reauthenticate(`bearer-${i}`)).toBe('gone');
  }
  expect(api.apiAuthChallenge).toHaveBeenCalledTimes(1);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
});

test('409 account_conflict is terminal too', async () => {
  api.apiAuth.mockRejectedValue(apiError(409, 'account_conflict'));

  expect(await reauth.reauthenticate(STALE)).toBe('gone');
  expect(await reauth.reauthenticate(STALE)).toBe('gone');

  expect(api.apiAuth).toHaveBeenCalledTimes(1);
  expect(reauth.accountGone()).toBe(true);
});

test('a userId that moved is account-gone, and the token is NOT adopted', async () => {
  db.loadProfile.mockResolvedValue({
    userId: USER_ID,
    registrationId: 7,
    displayName: 'Me',
    about: '',
    avatarB64: '',
    profileVersion: 3,
  });
  // What DELETE /v1/account leaves behind: the claim row is gone, so the next
  // auth CREATES an account for the same key. Signed in, as a stranger.
  api.apiAuth.mockResolvedValue({
    userId: '01OTHERACCOUNTOTHERACCOUN',
    authToken: 'stranger',
  });

  expect(await reauth.reauthenticate(STALE)).toBe('gone');

  // Every ratchet session and pinned identity is keyed by the OLD userId, so
  // adopting this token would address all of them to somebody else.
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
  expect(reauth.accountGone()).toBe(true);
});

test('a duress session re-auths without a single packet', async () => {
  session.setMode('duress');

  expect(await reauth.reauthenticate(STALE)).toBe('silent');
  expect(await reauth.probeAndHeal(STALE)).toEqual({ verdict: 'blip' });

  // The duress rule. Not one request, and not even a Keychain read — the
  // guard is the first line, ahead of everything, exactly as `refuseInDuress`
  // is the first line of createOrRestoreAccount.
  expect(api.apiAuthChallenge).not.toHaveBeenCalled();
  expect(api.apiAuth).not.toHaveBeenCalled();
  expect(api.apiProbeSession).not.toHaveBeenCalled();
  expect(crypto.getSecret).not.toHaveBeenCalled();
  expect(crypto.setSecret).not.toHaveBeenCalled();
  // And a coerced session is NOT an account problem: surfacing "this account
  // no longer exists" to a person under duress would be a statement about the
  // real workspace, made in the decoy.
  expect(reauth.accountGone()).toBe(false);
});

test('a transient failure is not terminal and does not pin the flight', async () => {
  api.apiAuthChallenge.mockRejectedValueOnce(new Error('offline'));

  expect(await reauth.reauthenticate(STALE)).toBe('error');
  expect(reauth.accountGone()).toBe(false);

  // The next caller gets a real attempt. A flight cleared on success only
  // would have answered every later caller with this same failure forever.
  expect(await reauth.reauthenticate(STALE)).toBe('ok');
  expect(api.apiAuth).toHaveBeenCalledTimes(1);
});

test('an unreadable identity is transient, never "gone"', async () => {
  // What a Keychain that has not been unlocked since boot looks like. Latching
  // a dead account over a read that would work five seconds later is the one
  // mistake this module must never make.
  crypto.identityPublicKey.mockResolvedValue(null);

  expect(await reauth.reauthenticate(STALE)).toBe('error');
  expect(reauth.accountGone()).toBe(false);
  expect(api.apiAuthChallenge).not.toHaveBeenCalled();
});

test('the probe treats a live credential as a blip and mints nothing', async () => {
  api.apiProbeSession.mockResolvedValue(200);

  // `conclusive` is the load-bearing half: the server answered, so this blip is
  // evidence and the socket may spend its one probe on it. An unanswered probe
  // returns the same verdict WITHOUT the flag and is refunded instead — the
  // other two `probeAndHeal` blips in this file are exactly that case.
  expect(await reauth.probeAndHeal(STALE)).toEqual({ verdict: 'blip', conclusive: true });
  expect(api.apiAuth).not.toHaveBeenCalled();
});

test('the probe treats an unreachable server as a blip', async () => {
  api.apiProbeSession.mockRejectedValue(new Error('network down'));

  expect(await reauth.probeAndHeal(STALE)).toEqual({ verdict: 'blip' });
  expect(api.apiAuth).not.toHaveBeenCalled();
});

test('the probe hands the socket a fresh token on 401', async () => {
  api.apiProbeSession.mockResolvedValue(401);

  expect(await reauth.probeAndHeal(STALE)).toEqual({
    verdict: 'reauthed',
    token: 'fresh-1',
  });
});

test('the probe stops the socket on a tombstoned account', async () => {
  api.apiProbeSession.mockResolvedValue(401);
  api.apiAuth.mockRejectedValue(apiError(403, 'identity_tombstoned'));

  expect(await reauth.probeAndHeal(STALE)).toEqual({ verdict: 'gone' });
});

test('subscribers learn the new bearer, and stop when they unsubscribe', async () => {
  // Messaging keeps its own copy of the token for every REST call it makes; a
  // renewal that did not reach it would leave each of those 401ing forever.
  const seen: string[] = [];
  const off = reauth.subscribeToken(token => seen.push(token));

  await reauth.reauthenticate(STALE);
  expect(seen).toEqual(['fresh-1']);

  off();
  await reauth.reauthenticate('fresh-1');
  expect(seen).toEqual(['fresh-1']);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe('fresh-2');
});

test('a 403 that is not identity_tombstoned is transient, not terminal', async () => {
  // A WAF rule, an API Gateway resource policy, a proxy having an opinion:
  // all of them answer 403, none of them mean the account is gone. Matching on
  // the status alone mounted the no-exit "this account no longer exists" screen
  // over a network appliance, permanently, for the life of the process.
  api.apiAuth.mockRejectedValue(apiError(403, 'forbidden'));
  const surfaced = jest.fn();
  reauth.onAccountGone(surfaced);

  expect(await reauth.reauthenticate(STALE)).toBe('error');
  expect(reauth.accountGone()).toBe(false);
  expect(surfaced).not.toHaveBeenCalled();

  // And the next attempt is still allowed to happen, which is the whole
  // difference between transient and terminal.
  api.apiAuth.mockResolvedValue({ userId: USER_ID, authToken: 'fresh-1' });
  expect(await reauth.reauthenticate(STALE)).toBe('ok');
});

test('a 409 that is not account_conflict is transient too', async () => {
  api.apiAuth.mockRejectedValue(apiError(409, 'some_other_conflict'));

  expect(await reauth.reauthenticate(STALE)).toBe('error');
  expect(reauth.accountGone()).toBe(false);
});

test('duress that begins MID-mint stops before the next packet', async () => {
  // The entry guard only covers a session that was already coerced. This is the
  // other half: a real session starts a renewal, the phone is taken, the user
  // duress-unlocks — and the continuation is still holding a live identity key
  // and a challenge. A coerced phone that emits POST /v1/auth because a real
  // session asked thirty seconds ago is exactly as compromised as one with no
  // guard at all.
  api.apiAuthChallenge.mockImplementation(async () => {
    session.setMode('duress');
    return { challenge: CHALLENGE, expiresAt: 0 };
  });

  expect(await reauth.reauthenticate(STALE)).toBe('silent');
  expect(api.apiAuth).not.toHaveBeenCalled();
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
});

test('a suspended re-auth is silent: deletion is when a 401 is the point', async () => {
  reauth.suspendReauth();

  expect(await reauth.reauthenticate(STALE)).toBe('silent');
  expect(api.apiAuthChallenge).not.toHaveBeenCalled();
  expect(api.apiAuth).not.toHaveBeenCalled();

  // Without this, an in-flight request 401ing after DELETE /v1/account would be
  // "healed" into a brand-new server-side account for the same identity key —
  // an orphan the device can never reach, under a terminal screen the user
  // cannot dismiss.
  reauth.resumeReauth();
  api.apiAuth.mockResolvedValue({ userId: USER_ID, authToken: 'fresh-1' });
  expect(await reauth.reauthenticate(STALE)).toBe('ok');
});

test('a profile that cannot be read fails CLOSED, adopting nothing', async () => {
  // The database is shut behind the lock screen, so the userId continuity check
  // cannot run. Accepting the token anyway — the first draft's behaviour — puts
  // a stranger's session on this device precisely during the relock that races
  // a server-side deletion, which is the sequence the check exists to catch.
  db.loadProfile.mockRejectedValue(new Error('database is closed'));
  api.apiAuth.mockResolvedValue({ userId: 'someone-else', authToken: 'fresh-1' });

  expect(await reauth.reauthenticate(STALE)).toBe('error');
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
  expect(reauth.accountGone()).toBe(false);
});

test('a probe with no bearer at all is refunded, and sends nothing', async () => {
  // The state App.tsx's boot heal exists for: profile present, token ABSENT —
  // or simply a Keychain that has not been unlocked since boot and answers
  // null. Re-auth is not what this socket is missing, and minting here would
  // race the boot heal that is already fixing it. The load-bearing half is the
  // MISSING `conclusive`: nothing was asked, so nothing was answered, and a
  // blip that claimed otherwise would spend the socket's one probe on a
  // question that never left the phone — leaving the refusal that follows the
  // heal unexamined.
  crypto.__keychain.clear();

  expect(await reauth.probeAndHeal(null)).toEqual({ verdict: 'blip' });

  expect(api.apiProbeSession).not.toHaveBeenCalled();
  expect(api.apiAuthChallenge).not.toHaveBeenCalled();
  expect(api.apiAuth).not.toHaveBeenCalled();
});

test('a probe whose heal fails transiently is refunded too', async () => {
  // The 401 DID answer the probe's question — but the renewal it triggered
  // went nowhere: offline mid-heal, a 429, a Keychain that would not read.
  // Scoring this episode `conclusive` would spend the socket's probe on a heal
  // that healed nothing; the next refusal would go unprobed, and the client
  // would back off blindly on a token everyone now agrees is dead — the
  // day-31 strand again, reachable through any transient failure inside the
  // mint. Inconclusive means the retry re-asks AND re-heals.
  api.apiProbeSession.mockResolvedValue(401);
  api.apiAuthChallenge.mockRejectedValue(new Error('offline'));

  expect(await reauth.probeAndHeal(STALE)).toEqual({ verdict: 'blip' });

  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
  expect(reauth.accountGone()).toBe(false);
});

test('duress beginning between the auth answer and the token write keeps the old token', async () => {
  // The finest slice of defect #1's fix. The MID-mint test above stops before
  // the next PACKET; this one is about the write. By the time the phone
  // changes hands the last packet has already left and the server has already
  // answered — minted, revoked the old session, handed back a live bearer.
  // What must not happen is the ADOPTION: no Keychain write, nothing published
  // to the caches. A coerced session whose token quietly went fresh is a
  // coerced session that goes back online — and the cover story, the only
  // protection the duress screen offers, is that this phone is offline.
  const seen: string[] = [];
  reauth.subscribeToken(token => seen.push(token));
  api.apiAuth.mockImplementation(async () => {
    session.setMode('duress');
    return { userId: USER_ID, authToken: 'minted-under-duress' };
  });

  expect(await reauth.reauthenticate(STALE)).toBe('silent');

  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
  expect(seen).toEqual([]);
});
