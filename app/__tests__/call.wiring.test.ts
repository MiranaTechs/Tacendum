import * as native from 'tacendum-call';
import * as calling from '../src/call';
import * as db from '../src/db';
import { callMetricLifecycle } from '../src/call/metrics';
import { messaging } from '../src/messaging';

/**
 * THE WIRING (`src/call/index.ts`), which is where a correct coordinator and a
 * correct controller can still add up to a broken phone.
 *
 * Every case below was a live defect that every unit test passed through:
 * the cold-launch answer that could not reach the restore it was written for,
 * the account id read once on a launch that had no account, the CallKit mute
 * button pointed at a session id as though it were a leg cid, the coordinator
 * nothing ever disposed, and the native adapter that turned every resolved
 * promise into "applied". They share one shape — the piece works, and nothing
 * connects it — which is exactly the shape a harness that builds its own
 * coordinator cannot see.
 *
 * Driven through `startCalling()` and real SQLite-shaped answers, because the
 * subscriptions, the singleton and the database reads under test all live
 * there.
 */

/** REAL 26-character Crockford ULIDs (no I, L, O or U): the shipped zod
 * schemas validate every id, and a placeholder would exercise the rejection
 * path instead of the wiring this file means to check. */
const SELF = '01HQ5E1F00000000000000000A';
const STARTER = '01HQ5TARTER00000000000000A';
const B = '01HQBBBB00000000000000000A';
const SID = '01HQ5E55N0000000000000AAAA';
const OFFER_CID = '01HQ0FFERC1D00000000000000';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, { execute: jest.Mock }>; reset: () => void };
  }
).__sqlite;

/**
 * Answer one query shape with rows, leaving every other query alone.
 *
 * The read goes through the REAL `db.ts` — its SQL, its column mapping, its
 * JSON roster parse — so a restore that stopped selecting `sid` would fail
 * here rather than pass against a hand-built object.
 */
function answerWith(match: RegExp, rows: unknown[]): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    if (match.test(String(sql))) return { rows };
    return base(sql, params);
  });
}

/**
 * A profile on disk — answered for BOTH of the reads that ask for one.
 *
 * `loadProfile` takes the whole projection and is latched behind the unlock
 * verdict; `loadSelfAccountIdForRing` takes the single `userId` row and is one
 * of the four reads the pre-verdict door admits, because the small-group
 * restore refuses to rebuild without knowing which member of the persisted
 * roster is this phone. They are deliberately different queries against the
 * same table, so a helper that seeded only the first would model a device
 * whose profile exists for an unlocked app and not for a locked one — which is
 * not a device.
 */
function withProfile(): void {
  answerWith(/SELECT key, value FROM profile/, [
    { key: 'userId', value: SELF },
    { key: 'registrationId', value: '42' },
  ]);
  answerWith(/SELECT value FROM profile WHERE key = 'userId'/, [{ value: SELF }]);
}

/**
 * Answer one query shape ONCE, then with nothing.
 *
 * `takeCallOffersForSession` is a SELECT followed by a DELETE, so the second
 * reader of the same session sees an empty table. A mock that answers every
 * time cannot show that, and it is the whole of the cold-flush race.
 */
function answerOnceWith(match: RegExp, rows: unknown[]): void {
  let served = false;
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    if (match.test(String(sql))) {
      if (served) return { rows: [] };
      served = true;
      return { rows };
    }
    return base(sql, params);
  });
}

/** A session and its starter's offer, as a killed process leaves them. */
function withPersistedSession(): void {
  answerWith(/FROM call_sessions ORDER BY startedAt DESC/, [
    {
      sid: SID,
      roomId: null,
      starterId: STARTER,
      roster: JSON.stringify([STARTER, SELF]),
      se: 0,
      video: 0,
      startedAt: Date.now(),
    },
  ]);
  answerWith(/FROM call_offers\s*\n?\s*WHERE sid = \?/, [
    {
      cid: OFFER_CID,
      peerId: STARTER,
      sdp: SDP,
      video: 0,
      exp: Date.now() + 60_000,
      serverTs: Date.now(),
      sid: SID,
    },
  ]);
}

const callEvents = (
  native as unknown as {
    __call: {
      emit: (n: string, p: unknown) => void;
      /** A VoIP push WITH native's own `alreadyRinging` bookkeeping, so the
       * `ringCid` it publishes is the one CallKitCenter would publish. */
      voipPush: (cid: string, from: string) => void;
      /** The modelled placeholder still up, or null — a stuck ring is
       * assertable, not merely absent. */
      pendingRing: () => { cid: string; from: string } | null;
    };
  }
).__call;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let teardown: (() => void) | undefined;

/**
 * Production's startup, both phases — for a phone somebody has UNLOCKED.
 *
 * `startCalling()` is the RING half and runs from a mount effect, before the
 * lock screen has a verdict, so it deliberately opens no workspace and tells
 * the server nothing. Everything that needs a chosen world (the reconcile, the
 * two prunes, the profile read that answers "who is this device") lives in
 * `adoptWorkspaceForCalling`, which App.tsx calls from each unlock arm.
 *
 * USE THIS ONLY FOR CASES THAT ARE ABOUT AN UNLOCKED, RUNNING APP. The
 * lock-screen-answer suite below must NOT: substituting this into it is
 * exactly the harness-in-a-state-production-never-reaches move that hid a
 * denial-of-ring for a whole round — a suite named for a locked phone, run
 * against an unlocked one.
 */
async function startCallingUnlocked(): Promise<() => void> {
  const stop = await calling.startCalling();
  await calling.adoptWorkspaceForCalling();
  return stop;
}

/**
 * PRODUCTION'S COLD START, which is the only state the four cases below mean
 * anything in.
 *
 * A device killed mid-ring has the file on disk with its schema — that is what
 * the `beforeEach`'s `initDb()` builds here — but the PROCESS that the owner's
 * press launches has run no `initDb()` at all, because in production the only
 * callers of it are App.tsx's two post-verdict unlock arms, and the CallKit
 * flush happens at MOUNT, above and before them. `close()` puts src/db.ts back
 * into exactly that state: latched, no handle, workspace still 'real'.
 *
 * So: no verdict, no self id, no open workspace — and a green button already
 * pressed. If a fix makes these four go red, the fix has taken the call out of
 * the owner's hand, whatever else it closed.
 */
async function coldStartBehindTheLockScreen(): Promise<() => void> {
  await db.close();
  return calling.startCalling();
}

beforeEach(async () => {
  calling.resetCallingForTests();
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'sendGroupCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(false);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

/** Start a live 3-way-shaped session and return the cid its B leg dialled. */
async function liveSession(): Promise<{ sid: string; legCid: string }> {
  withProfile();
  teardown = await startCallingUnlocked();
  const sid = await calling.startGroupCall([B], false);
  await calling.groupCall().whenIdle();
  const sent = messaging.sendGroupCallEnvelope as jest.Mock;
  const ginvite = sent.mock.calls.find(c => c[1]?.tcm === 'call.ginvite');
  return { sid, legCid: ginvite![1].cid as string };
}

describe('a lock-screen answer after the app was killed', () => {
  it('routes a SESSION sid to the coordinator, not to the 1:1 lookup', async () => {
    // THE PATH THE RESTORE EXISTS FOR, and the one it could not reach. On a
    // cold launch there is no in-memory session, so the sid matched nothing
    // and went to the 1:1 controller — which looked for a `call_offers` row
    // keyed by the sid, found none (legs carry their own cids) and released
    // the CXCall as `failed_media`. Every restore test passed; the feature
    // was unreachable in production.
    withProfile();
    withPersistedSession();
    teardown = await coldStartBehindTheLockScreen();

    callEvents.emit('callKitAnswer', { cid: SID });
    await flush();
    // The restore now runs INSIDE the coordinator's own queue (two cold
    // CallKit events from one native flush used to race the select-and-delete
    // of the session's stored offers), so settling it means settling the
    // queue — microtasks alone stop one hop short.
    await calling.groupCall().whenIdle();

    // The starter's stored offer was answered — the restore ran.
    expect(native.createAnswer).toHaveBeenCalledWith(OFFER_CID, SDP, false);
    // And the 1:1 fallback never took the CXCall away.
    expect(native.endCall).not.toHaveBeenCalledWith(SID, 'failed_media');
    expect(calling.groupCallView()?.sid).toBe(SID);
  });

  it('routes a cold CallKit END the same way, so nothing is left behind', async () => {
    withProfile();
    withPersistedSession();
    teardown = await coldStartBehindTheLockScreen();

    callEvents.emit('callKitEnd', { cid: SID });
    await flush();
    await calling.groupCall().whenIdle();

    // Declined to the caller through the restored leg, not swallowed.
    const sent = (messaging.sendCallEnvelope as jest.Mock).mock.calls;
    expect(sent.some(c => c[1]?.tcm === 'call.end' && c[1]?.r === 'decline')).toBe(true);
    expect(calling.groupCallView()).toBeNull();
  });

  it('survives TWO events from one native flush without releasing the call', async () => {
    // Pinned at the seam it actually lives on.
    // `flushPendingEvents` hands JS everything CallKit raised before the
    // process existed, synchronously, and each subscriber here starts its own
    // detached async task. Nothing serialized them, and `restore()` set no
    // state until several awaits in — so both tasks saw a null session and
    // both entered the SELECT-then-DELETE of the session's stored offers. The
    // loser came back holding an empty list and released the CXCall the
    // winner had just answered as `failed_media`.
    withProfile();
    answerWith(/FROM call_sessions ORDER BY startedAt DESC/, [
      {
        sid: SID,
        roomId: null,
        starterId: STARTER,
        roster: JSON.stringify([STARTER, SELF]),
        se: 0,
        video: 0,
        startedAt: Date.now(),
      },
    ]);
    // The real select-then-delete: served once, empty afterwards.
    answerOnceWith(/FROM call_offers\s*\n?\s*WHERE sid = \?/, [
      {
        cid: OFFER_CID,
        peerId: STARTER,
        sdp: SDP,
        video: 0,
        exp: Date.now() + 60_000,
        serverTs: Date.now(),
        sid: SID,
      },
    ]);
    teardown = await coldStartBehindTheLockScreen();

    // Both raised before JS existed; both delivered in one flush.
    callEvents.emit('callKitAnswer', { cid: SID });
    callEvents.emit('callKitAnswer', { cid: SID });
    await flush();
    await calling.groupCall().whenIdle();

    expect(native.endCall).not.toHaveBeenCalledWith(SID, 'failed_media');
    expect(
      (native.createAnswer as jest.Mock).mock.calls.filter(c => c[0] === OFFER_CID),
    ).toHaveLength(1);
    expect(calling.groupCallView()?.sid).toBe(SID);
  });

  it('leaves an ordinary 1:1 cid to the 1:1 controller', async () => {
    // The other half of the same routing decision: a cid that names no
    // session must not be handed to the coordinator, whose restore would
    // release a CXCall the 1:1 rehydrate could have answered.
    withProfile();
    teardown = await coldStartBehindTheLockScreen();

    callEvents.emit('callKitAnswer', { cid: OFFER_CID });
    await flush();

    expect(calling.groupCallView()).toBeNull();
    // The 1:1 rehydrate found no stored offer and released it — its own
    // doctrine, unchanged.
    expect(native.endCall).toHaveBeenCalledWith(OFFER_CID, 'failed_media');
  });

  it('opens exactly as wide as the sentence on `conn` claims, for a DECLINE that names nothing', async () => {
    // THE DOOR, ENUMERATED — because the one-sentence boundary comment on
    // `conn` was materially narrower than the code, in two ways this case
    // pins so neither can drift back into being implied:
    //
    //  1. IT IS NOT "AN ANSWER". The same subscription pair serves
    //     `callKitEnd`, so the RED button walks the same door. That is
    //     correct and must stay correct — a decline after a kill still has to
    //     reach the leg that tells the caller no — but it belongs in the
    //     sentence, and it was not in it.
    //  2. IT IS NOT "THE ROWS FOR THE CALL BEING ANSWERED".
    //     `callKitNamesSession` asks for the NEWEST session row and compares
    //     the sid afterwards, so this press — a synthetic push placeholder,
    //     naming no session of this device's — still reads the roomId, the
    //     starterId and the full ROSTER of the last small-group call.
    //
    // Asserted as an EXACT LIST rather than a set of absences: a new read
    // added to this path, by anyone, for any reason, turns this red and has to
    // be argued for in the sentence before it can ship.
    withProfile();
    withPersistedSession();
    teardown = await coldStartBehindTheLockScreen();
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const before = instance.execute.mock.calls.length;

    callEvents.emit('callKitEnd', { cid: OFFER_CID });
    await flush();

    expect(
      instance.execute.mock.calls
        .slice(before)
        .map(c => String(c[0]).replace(/\s+/g, ' ')),
    ).toEqual([
      'SELECT sid, roomId, starterId, roster, se, video, startedAt FROM call_sessions ORDER BY startedAt DESC LIMIT 1',
    ]);
    // In particular: no profile row. `learnSelfIdForRingService` sits behind
    // the sid match, and a press naming nothing must not learn who this device
    // is — that is the one part of the old sentence that WAS true.
  });

  it('answers a stored 1:1 offer with nobody having typed the passcode', async () => {
    // THE SCENARIO IN ONE LINE: phone killed, VoIP push rings it, the owner
    // presses Answer on the lock screen. The offer IS in `call_offers` — that
    // is the whole reason the design persists it — and the process servicing the
    // press has no verdict, so it has no workspace either. The answer path is
    // pure SQLite: if the db module refuses it, `takeOffer` yields null,
    // `rehydrate` releases the CXCall as `failed_media`, and the call dies in
    // the owner's hand with nothing anywhere that would replay it after an
    // unlock. Rule 3 outranks the boundary here, and this is where it is said.
    withProfile();
    answerWith(/FROM call_offers WHERE cid = \?/, [
      {
        cid: OFFER_CID,
        peerId: STARTER,
        sdp: SDP,
        video: 0,
        exp: Date.now() + 60_000,
        serverTs: Date.now(),
      },
    ]);
    teardown = await coldStartBehindTheLockScreen();

    callEvents.emit('callKitAnswer', { cid: OFFER_CID });
    await flush();

    expect(native.createAnswer).toHaveBeenCalledWith(OFFER_CID, SDP, false);
    expect(native.endCall).not.toHaveBeenCalledWith(OFFER_CID, 'failed_media');
  });

  it('services the ring without unlatching the rest of the workspace', async () => {
    // THE BOUNDARY, STATED AS A TEST. Servicing an in-flight press is allowed
    // to reach the offer and session rows that press is about, and nothing
    // else: a general read still refuses, so the housekeeping writes, the
    // profile projection, the message history and the chat list stay shut
    // until a verdict exists. What a pre-verdict holder of the phone gets out
    // of this door is the call CallKit was already offering them.
    withProfile();
    withPersistedSession();
    teardown = await coldStartBehindTheLockScreen();

    callEvents.emit('callKitAnswer', { cid: SID });
    await flush();
    await calling.groupCall().whenIdle();
    expect(native.createAnswer).toHaveBeenCalledWith(OFFER_CID, SDP, false);

    await expect(db.loadProfile()).rejects.toThrow('database is closed');
    await expect(db.listChats()).rejects.toThrow('database is closed');
    await expect(db.reconcileActiveCalls(Date.now())).rejects.toThrow(
      'database is closed',
    );
  });
});

describe('who this device is', () => {
  it('is re-read when the account is created after calling started', async () => {
    // `startCalling` runs once per process, on a component that never
    // remounts. On the launch that CREATES an account it runs while there is
    // no profile at all, so the id it read was permanently null: outbound
    // small-group calls failed `not_registered` for the life of the process
    // and every inbound ginvite returned before admission or dismissal.
    teardown = await calling.startCalling();
    await expect(calling.startGroupCall([B], false)).rejects.toThrow('not_registered');

    withProfile();
    await calling.refreshSelfAccountId();

    await expect(calling.startGroupCall([B], false)).resolves.toMatch(/^01/);
    await calling.groupCall().whenIdle();
    expect(messaging.sendGroupCallEnvelope).toHaveBeenCalled();
  });

  it('is known BEFORE messaging starts delivering, at every seam that starts it', () => {
    // Both seams that learn this device's identity — account
    // creation and a real unlock — fired the refresh with `void` and then
    // started messaging. `refreshSelfAccountId` is a database read; the
    // socket comes up while it is still in flight, and an invite delivered in
    // that window hits `if (!selfId) return` in `handleInvite`: dropped
    // before admission, before the placeholder is dismissed, before anything
    // is written down. Nobody is told and nothing retries.
    //
    // THE FIX IS ORDERING, not a retry loop, so ordering is what is checked.
    // Source-level for the same reason the quiesce scan below is: these two
    // seams live in `App.tsx`, which has no unit harness, and a rule with no
    // check is a preference.
    //
    // TWO SPELLINGS COUNT, and they are the same read. Registration calls
    // `refreshSelfAccountId` directly. A real unlock calls
    // `adoptWorkspaceForCalling`, which is the post-verdict half of calling
    // startup and whose profile read IS `await refreshSelfAccountId()` (see
    // src/call/index.ts). That indirection exists because the read cannot
    // happen at mount any more — the workspace it would read is not chosen
    // until the lock screen has an answer — so the scan follows it rather than
    // insisting on the old spelling.
    const fs = jest.requireActual<{ readFileSync(p: string, e: string): string }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const lines = fs.readFileSync(`${appDir}/App.tsx`, 'utf8').split('\n');
    const SEAM = '(refreshSelfAccountId|adoptWorkspaceForCalling)';

    // 1. Never fired and forgotten — either spelling.
    const fired = lines
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => new RegExp(`(^|[^.\\w])void\\s+${SEAM}\\s*\\(`).test(text));
    expect(fired.map(f => `App.tsx:${f.line}`)).toEqual([]);

    // 2. Every start of messaging has an awaited refresh in front of it. The
    //    call is written `messaging\n.start(...)` at one of the two seams, so
    //    the whole file is matched rather than one line.
    const starts = lines
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /\.start\(\s*(existing|p)\.userId/.test(text));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const unordered = starts.filter(({ line }) => {
      const before = lines.slice(Math.max(0, line - 1 - 30), line - 1).join('\n');
      return !new RegExp(`await\\s+${SEAM}\\s*\\(`).test(before);
    });
    expect(unordered.map(s => `App.tsx:${s.line}`)).toEqual([]);
  });

  it('the unlock seam reads the id through the phase that owns the workspace', () => {
    // The indirection the scan above now allows is only sound while it is
    // true, so it is checked rather than assumed: `adoptWorkspaceForCalling`
    // must actually await the read. If someone drops that line, the scan
    // above would keep passing on a seam that no longer knows who this device
    // is — the exact silent failure it was written to catch.
    const fs = jest.requireActual<{ readFileSync(p: string, e: string): string }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const src = fs.readFileSync(`${appDir}/src/call/index.ts`, 'utf8');
    const body = src.slice(src.indexOf('export async function adoptWorkspaceForCalling'));
    expect(body).toMatch(/await\s+refreshSelfAccountId\s*\(/);
  });
});

describe('an invite from someone this phone has never heard of', () => {
  /**
   * The design REACHING THE SESSION SHAPE, which is a wiring fact and not a
   * coordinator one: the rule, the setting and the database read all shipped,
   * and the coordinator was simply never handed them — `handles()` routes a
   * `call.ginvite` past the 1:1 offer branch that consults `mayRing`, so a
   * stranger who put you in a roster made the phone ring at any hour. A
   * harness that builds its own coordinator cannot see that; this can.
   *
   * The default is the phone's own: `resetCallingForTests` restores silence
   * to ON, exactly as a launch that has read nothing does.
   *
   * FALSIFIER, run: delete the `mayRing` line from the coordinator's deps in
   * `index.ts` — every coordinator test still passes and the first test below
   * goes red, which is the whole reason it lives here and not there.
   * Restored.
   */
  function deliverInvite(): Promise<void> {
    const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as (
      peerId: string,
      envelope: unknown,
      meta: { msgId: string; ts: number },
    ) => void;
    listener(
      STARTER,
      {
        tcm: 'call.ginvite',
        sid: SID,
        cid: OFFER_CID,
        r: [STARTER, SELF],
        sdp: SDP,
        vid: false,
        exp: Date.now() + 60_000,
      },
      { msgId: '01HQMSG000000000000000000A', ts: Date.now() },
    );
    return flush();
  }

  beforeEach(() => {
    jest.spyOn(messaging, 'onEnvelope');
  });

  it('does not ring, dismisses the push, and leaves a row to call back', async () => {
    withProfile();
    teardown = await startCallingUnlocked();

    await deliverInvite();
    await calling.groupCall().whenIdle();

    expect(native.reportIncomingCall).not.toHaveBeenCalled();
    expect(calling.groupCallView()).toBeNull();
    // Three arguments: the dismissal NAMES the placeholder it is ending. ''
    // here because no VoIP push rang in this test, which is also the
    // caller-keyed match a binary predating the cid degrades to.
    expect(native.dismissPendingIncomingCall).toHaveBeenCalledWith(STARTER, 'declined', '');
    // The row goes through the REAL `db.ts` — its SQL, its columns — so a
    // silenced call the person could never see or return would fail here.
    const execute = sqlite.instances.get('tacendum.sqlite')!.execute;
    const inserted = execute.mock.calls.filter(c => /INSERT INTO call_log/.test(String(c[0])));
    expect(inserted).toHaveLength(1);
    expect(inserted[0][1]).toEqual(expect.arrayContaining([STARTER, 'in', SID]));
    // And nothing went back to the inviter: a silenced invite is
    // indistinguishable from a phone that was off.
    expect(messaging.sendCallEnvelope).not.toHaveBeenCalled();
    expect(messaging.sendGroupCallEnvelope).not.toHaveBeenCalled();
  });

  it('carries the RINGING placeholder’s cid from the push into the dismissal', async () => {
    // THE WIRING TWIN. `ringCid` crosses three seams before it can matter —
    // native publishes it on `voipPush`, `index.ts` hands it to
    // `notePushRing`, and the coordinator reads it back through `ringCidFor`
    // — and every one of them is a place the tag can be silently dropped for
    // `''`, which is a revert to the caller-keyed match with no failing test.
    // Driven through `__call.voipPush`, which models CallKitCenter's own
    // bookkeeping rather than emitting a hand-written payload.
    withProfile();
    teardown = await startCallingUnlocked();

    callEvents.voipPush('01HQPUSH00000000000000000A', STARTER);
    await flush();
    await deliverInvite();
    await calling.groupCall().whenIdle();

    expect(native.reportIncomingCall).not.toHaveBeenCalled();
    expect(native.dismissPendingIncomingCall).toHaveBeenCalledWith(
      STARTER,
      'declined',
      '01HQPUSH00000000000000000A',
    );
    // And the modelled native guard accepted it: the placeholder is gone
    // rather than stuck to the 75-second watchdog.
    expect(callEvents.pendingRing()).toBeNull();
  });

  it('rings when the chats row says a message was exchanged', async () => {
    // The same invite from the same account, with the ONE fact that decides
    // it changed — so the test above measures the policy and not a wiring
    // that stopped ringing for everybody. `lastMessageAt` is what production
    // reads as history (`index.ts`'s `mayRing`), and nothing else is.
    withProfile();
    answerWith(/FROM chats WHERE peerId = \?/, [
      { peerId: STARTER, displayName: 'Ana', lastMessageAt: Date.now() },
    ]);
    teardown = await startCallingUnlocked();

    await deliverInvite();
    await calling.groupCall().whenIdle();

    expect(native.reportIncomingCall).toHaveBeenCalled();
    expect(calling.groupCallView()?.sid).toBe(SID);
  });
});

describe('the system mute button during a session', () => {
  it('mutes every LEG, not a cid that does not exist', async () => {
    // A session's CXCall is keyed by its sid (departure 8). Handing that to
    // `setAudioEnabled` addressed no peer connection at all: CallKit, the
    // dynamic island and this module's own state all showed muted while every
    // leg kept transmitting — the worst version of this bug, which is why it
    // is a privacy fix and not a UI one.
    const { sid, legCid } = await liveSession();
    (native.setAudioEnabled as jest.Mock).mockClear();

    callEvents.emit('callKitMute', { cid: sid, muted: true });
    await flush();
    // The paced send chain spends REAL time between frames (the bucket), so
    // microtasks alone do not settle a session's outbound traffic.
    await calling.groupCall().whenIdle();

    expect(native.setAudioEnabled).toHaveBeenCalledWith(legCid, false);
    expect(
      (native.setAudioEnabled as jest.Mock).mock.calls.some(c => c[0] === sid),
    ).toBe(false);
    expect(calling.groupCallView()!.muted).toBe(true);
  });

  it('closes a leg the native side says it could not silence', async () => {
    // THE ADAPTER, END TO END. It used to convert every resolved promise into
    // `true` — including the shipped silent no-op — so all-or-close-the-leg
    // existed only in the fake native. With the verdict passed through, a leg
    // that reports `false` twice is closed rather than left open behind a
    // muted button.
    const { sid, legCid } = await liveSession();
    (native.setAudioEnabled as jest.Mock).mockResolvedValue(false);

    callEvents.emit('callKitMute', { cid: sid, muted: true });
    await flush();
    // The paced send chain spends REAL time between frames (the bucket), so
    // microtasks alone do not settle a session's outbound traffic.
    await calling.groupCall().whenIdle();

    const sent = (messaging.sendCallEnvelope as jest.Mock).mock.calls;
    expect(
      sent.some(c => c[1]?.tcm === 'call.end' && c[1]?.cid === legCid && c[1]?.r === 'failed_media'),
    ).toBe(true);
  });
});

describe('the loudspeaker during a session', () => {
  it('reaches the bridge ONCE, on the sid, and publishes what it took', async () => {
    // THE WIRE FROM THE BUTTON TO THE AUDIO ROUTE, through the real module.
    // Group calls ship audio only, so a five-person call with no way off the
    // earpiece is the feature reading as broken — and the pieces either side
    // of this seam (the screen's press, the coordinator's bridge call) can
    // both be right while nothing connects them.
    //
    // ADDRESSED WITH THE SID, deliberately, and the inverse of the mute bug
    // one describe up: a mute keyed on the sid reached no peer connection,
    // because mute is per leg. The output route is not — native discards the
    // cid and overrides one process-wide `RTCAudioSession` — so the session's
    // own CallKit handle is the honest thing to name, and N leg-addressed
    // calls would be N writes to the same global.
    //
    // FALSIFYING CASE, run at authoring time: have `toggleGroupSpeaker` pass
    // `view.speakerOn` instead of its negation. The first press then asks for
    // the route it is already on and `speakerOn` never becomes true.
    const { sid, legCid } = await liveSession();
    (native.setSpeaker as jest.Mock).mockClear();

    await calling.toggleGroupSpeaker();
    await calling.groupCall().whenIdle();

    expect(native.setSpeaker).toHaveBeenCalledTimes(1);
    expect(native.setSpeaker).toHaveBeenCalledWith(sid, true);
    expect((native.setSpeaker as jest.Mock).mock.calls.some(c => c[0] === legCid)).toBe(false);
    expect(calling.groupCallView()!.speakerOn).toBe(true);

    // And back off, from the published state rather than from a local guess.
    await calling.toggleGroupSpeaker();
    await calling.groupCall().whenIdle();
    expect(native.setSpeaker).toHaveBeenLastCalledWith(sid, false);
    expect(calling.groupCallView()!.speakerOn).toBe(false);
  });

  it('is a no-op with no session, and never moves an idle phone’s audio', async () => {
    // Nothing is playing this app's audio when no call is up, so overriding
    // the output port would move a route the app does not own.
    withProfile();
    teardown = await startCallingUnlocked();
    (native.setSpeaker as jest.Mock).mockClear();

    await calling.toggleGroupSpeaker();

    expect(native.setSpeaker).not.toHaveBeenCalled();
    expect(calling.groupCallView()).toBeNull();
  });
});

describe('quiescing', () => {
  it('EVERY seam that stops messaging also disposes the coordinator', async () => {
    // The rule, encoded rather than remembered: relock, account deletion and
    // the duress variant of it all quiesce by stopping the socket, and a
    // small-group session is exactly as live and exactly as workspace-bound
    // as that socket. Source-level (the `db.groups.test.ts` idiom) because
    // these seams live in `App.tsx` and `registration.ts`, which have no unit
    // harness of their own — and a rule with no check is a preference.
    const fs = jest.requireActual<{
      readdirSync(
        path: string,
        opts: { withFileTypes: true },
      ): { name: string; isDirectory(): boolean }[];
      readFileSync(path: string, encoding: string): string;
    }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const files: string[] = [`${appDir}/App.tsx`];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(`${appDir}/src`);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        // A STATEMENT, not a mention: a comment line cannot match this.
        if (!/^\s*messaging\.stop\(\);\s*$/.test(text)) return;
        const window = lines.slice(i, i + 12).join('\n');
        if (!window.includes('disposeGroupCall()')) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // And the scan is not vacuous: those seams exist.
    expect(
      files.filter(f => /^\s*messaging\.stop\(\);\s*$/m.test(fs.readFileSync(f, 'utf8'))).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('every seam that ENDS a real session also closes the push gate it opened', () => {
    // `pushRegistrationAdopted` is a process-lifetime latch, so the two seams
    // that take a real session away have to put it back — otherwise a phone
    // sitting on its lock screen still has an open gate, and an APNs token
    // rotation (which arrives whether or not anybody is holding the phone)
    // registers the real account from behind the lock, including through the
    // whole window before a DURESS unlock, where the decoy arm's own reset
    // arrives far too late to have stopped it.
    //
    // Source-level, the idiom of the two scans around this one: both seams
    // live in `App.tsx`, which has no unit harness, and a rule with no check
    // is a preference.
    const fs = jest.requireActual<{ readFileSync(p: string, e: string): string }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const src = fs.readFileSync(`${appDir}/App.tsx`, 'utf8');

    const bodyOf = (declaration: string): string => {
      const at = src.indexOf(declaration);
      expect(at).toBeGreaterThan(-1);
      const end = src.indexOf('}, []);', at);
      expect(end).toBeGreaterThan(at);
      return src.slice(at, end);
    };
    const CLOSED = /adoptPushRegistration\(\{\s*real:\s*false\s*\}\)/;
    expect(bodyOf('const relock = useCallback(')).toMatch(CLOSED);
    expect(bodyOf('const enterDecoyWorkspace = useCallback(')).toMatch(CLOSED);
    // A real unlock and a newly created real account are the two openings.
    const opens = src
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /adoptPushRegistration\(\{\s*real:\s*true\s*\}\)/.test(text));
    expect(opens).toHaveLength(2);
    expect(bodyOf('const enterRealWorkspace = useCallback(')).toContain(
      'adoptPushRegistration({ real: true })',
    );
  });

  it('registration tells the call module who this device became', () => {
    // `startCalling` reads the profile once, and on the launch that CREATES
    // an account there is none to read. The account-creating surface is the
    // one place that knows the moment it changes.
    const fs = jest.requireActual<{ readFileSync(p: string, e: string): string }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
    const app = fs.readFileSync(`${appDir}/App.tsx`, 'utf8');
    expect(app).toContain('refreshSelfAccountId()');
  });

  it('disposes the coordinator when calling stops', async () => {
    // Disposal existed only in the test reset, so relock, account deletion
    // and a workspace switch all left the real session roster, its leg
    // services, its paced send chain and its armed re-offer timers alive —
    // a timer able to fire after a duress unlock, and a later real account
    // inheriting stale busy state.
    await liveSession();
    expect(calling.groupCall().liveSessionBusy()).toBe(true);

    teardown!();
    teardown = undefined;

    expect(calling.groupCall().liveSessionBusy()).toBe(false);
    expect(calling.groupCallView()).toBeNull();
  });

  it('stops the authoritative call-metric heartbeat when calling stops', async () => {
    callMetricLifecycle.deactivate();
    jest.useFakeTimers();
    try {
      teardown = await calling.startCalling();
      await callMetricLifecycle.open({
        reportId: '01HQMETR1C0000000000000000',
        localId: 'active-at-process-stop',
        scope: 'direct',
        media: 'audio',
        startedAt: Date.now(),
      });
      expect(jest.getTimerCount()).toBe(1);

      teardown();
      teardown = undefined;

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      callMetricLifecycle.deactivate();
      jest.useRealTimers();
    }
  });
});
