/**
 * The quiesce and duress rules, on the arm that has never been tested: a
 * COLD START behind the lock screen.
 *
 * `App.lock.test.tsx` covers the same invariant but its `beforeEach` calls
 * `db.close()`, which latches the db module closed. That latch is a state a
 * freshly launched process is never in, and while it is set every db call in
 * `startCalling` throws into its own `.catch(() => undefined)` — so
 * `expect(sqlite.opened).toHaveLength(0)` passes there whether or not the
 * boot path would have opened a file on a real device. The latch also says
 * nothing at all about the network leg, which that file never asserts on.
 *
 * So this file refuses the two shortcuts:
 *
 *  1. NO `db.close()` ANYWHERE. Each case runs in a fresh module registry
 *     (`jest.resetModules()`), so `closedLatch`, the cached connection, the
 *     active workspace, `session.mode`, the latched `selfAccountId` and the
 *     mock recorders are all exactly what they are at process start. That is
 *     the only harness in which "no workspace opened before the verdict" is a
 *     claim about production rather than about the setup.
 *  2. THE WIRE IS WATCHED. `globalThis.fetch` is a recording mock, because
 *     the pre-verdict leak this file exists to pin is half SQLite and half
 *     `PUT /v1/push-token` carrying the real account's bearer token.
 *
 * The renderer is required inside the isolated registry too — a component
 * calling hooks from one copy of React while the renderer holds another is an
 * "Invalid hook call", not a test result.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    // Backgrounding a REAL session calls `messaging.pause()`, which suspends
    // rather than stops (a stop would clear the frame handlers). A mock
    // missing it turns the relock this file drives — the ONLY production path
    // back to the lock screen — into a TypeError inside an AppState listener.
    suspend: jest.fn(),
    adoptToken: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    suspend() {
      calls.suspend();
    }
    adoptToken(token: string) {
      calls.adoptToken(token);
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

import type ReactTestRenderer from 'react-test-renderer';
import type * as DbModule from '../src/db';
import type { session as SessionType } from '../src/session';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
interface FakeSqlite {
  opened: string[];
  instances: Map<string, FakeDb>;
  reset: () => void;
}
interface FakeCrypto {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
  hasIdentity: jest.Mock;
  /** Every Keychain/Keystore read. The fail-closed cases below make exactly
   * one key unreadable — `lock.enabled` — because that is the read whose
   * rejection used to be caught into "not locked" (the defect:
   * two fail-open lock windows, foreground-resume and cold boot). */
  getSecret: jest.Mock;
  /** The App Group file write behind `armPreviews` — the last awaited step on
   * the REAL unlock arm before it closes the database, and therefore the seam
   * a test parks that arm on. */
  writeSharedState: jest.Mock;
  /** The native call `databaseLocation()` makes before every open. It is the
   * one step on the unlock path that throws rather than swallowing — an App
   * Group container that cannot be prepared — which makes it the honest way
   * to drive `enterRealWorkspace` into its catch. */
  prepareDatabaseDirectory: jest.Mock;
}

/** One freshly booted process, plus the seams a test drives it through. */
interface Boot {
  renderer: typeof ReactTestRenderer;
  sqlite: FakeSqlite;
  crypto: FakeCrypto;
  ws: { calls: { start: jest.Mock } };
  fetchMock: jest.Mock;
  db: typeof DbModule;
  session: typeof SessionType;
  /** The native calling bridge, so a test can raise the press CallKit is
   * already holding — which on this file's arm is the whole point: the press
   * and the unlock overlap by construction. */
  call: { emit: (name: string, payload: unknown) => void };
  /** Be the OS: drive the app between background and foreground, which is the
   * only production path to a relock. */
  appState: (next: string) => Promise<void>;
  render: () => Promise<ReactTestRenderer.ReactTestRenderer>;
}

const realFetch = globalThis.fetch;
/** Trees are unmounted between cases: the landing cursor loops forever and a
 * leaked root keeps ticking into a torn-down environment. */
let live: { renderer: typeof ReactTestRenderer; tree: ReactTestRenderer.ReactTestRenderer }[] = [];

/**
 * Build a cold process. Nothing is required before `jest.resetModules()`, so
 * every module-level latch in the app starts at its declared initializer —
 * which is the whole point of the file.
 */
function coldStart(): Boot {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react') as typeof import('react');
  const renderer = require('react-test-renderer') as typeof ReactTestRenderer;
  const sqlite = (
    jest.requireMock('@op-engineering/op-sqlite') as { __sqlite: FakeSqlite }
  ).__sqlite;
  const crypto = jest.requireMock('tacendum-crypto') as unknown as FakeCrypto;
  const ws = (
    jest.requireMock('../src/ws') as { __ws: { calls: { start: jest.Mock } } }
  ).__ws;
  const call = (
    jest.requireMock('tacendum-call') as {
      __call: { emit: (n: string, p: unknown) => void; reset: () => void };
    }
  ).__call;
  // Subscriptions are per-registry: a listener left over from the previous
  // case would fire into a torn-down module graph.
  call.reset();
  const db = jest.requireActual('../src/db') as typeof DbModule;
  const session = (jest.requireActual('../src/session') as { session: typeof SessionType })
    .session;

  // A device with a real account behind the lock: the identity keys are
  // present and so is the bearer the push registration would spend.
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.__keychain.set('authToken', 'real-owner-token');

  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })) as unknown as jest.Mock;
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const RN = require('react-native') as typeof import('react-native');
  const appStateListeners: ((next: string) => void)[] = [];
  jest.spyOn(RN.AppState, 'addEventListener').mockImplementation(((
    _event: string,
    cb: (next: string) => void,
  ) => {
    appStateListeners.push(cb);
    return { remove: () => undefined };
  }) as unknown as typeof RN.AppState.addEventListener);
  const appState = async (next: string) => {
    await renderer.act(async () => {
      for (const cb of [...appStateListeners]) cb(next);
      for (let i = 0; i < 60; i++) await Promise.resolve();
    });
  };

  const render = async () => {
    const App = (require('../App') as { default: React.ComponentType }).default;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(App));
    });
    live.push({ renderer, tree });
    return tree;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  return {
    renderer,
    sqlite,
    crypto,
    ws,
    fetchMock,
    db,
    session,
    call,
    appState,
    render,
  };
}

async function press(
  boot: Boot,
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await boot.renderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

async function enterCode(
  boot: Boot,
  tree: ReactTestRenderer.ReactTestRenderer,
  digits: string[],
): Promise<void> {
  for (const key of digits) await press(boot, tree, `pin-key-${key}`);
  await press(boot, tree, 'pin-submit');
}

/** The rows a decoy (or real) workspace must answer with so `initSchema`'s
 * destructive-rebuild probe does not decide the file is an old shape and
 * recurse forever — a 4 GB hang rather than a red test. */
function seedWorkspace(
  sqlite: FakeSqlite,
  file: string,
  userId: string,
  /** A small-group call this device was in when it was killed — the row
   * `loadCallSession` answers a CallKit press from. Absent by default: only
   * the cases about a press in flight need one. */
  session?: {
    sid: string;
    roomId: string | null;
    starterId: string;
    roster: string;
    se: number;
    video: number;
    startedAt: number;
  },
  /** The held ring itself — the `call_offers` rows a killed device still has.
   * Without them a restore finds a session and no starter offer and releases
   * the CXCall anyway, which would make "the door reached the right file" and
   * "the call was answered" indistinguishable. */
  offers?: {
    cid: string;
    peerId: string;
    sdp: string;
    video: number;
    exp: number;
    serverTs: number;
    sid: string | null;
  }[],
): void {
  const profile = [
    { key: 'userId', value: userId },
    { key: 'registrationId', value: '7' },
    { key: 'displayName', value: 'Me' },
    { key: 'about', value: '' },
    { key: 'avatarB64', value: '' },
    { key: 'profileVersion', value: '1' },
  ];
  sqlite.instances.set(file, {
    name: file,
    execute: jest.fn(async (sql: string, params?: unknown) => {
      const s = String(sql);
      if (s.includes('FROM profile')) return { rows: profile };
      if (/^SELECT[\s\S]*FROM call_sessions/.test(s)) {
        return { rows: session ? [session] : [] };
      }
      // Keyed exactly as the two readers key it: `takeCallOffersForSession`
      // asks `WHERE sid = ?` and `takeCallOffer` asks `WHERE cid = ?`, so a
      // row seeded for one must not answer the other.
      if (/^SELECT[\s\S]*FROM call_offers/.test(s)) {
        const key = /WHERE sid = \?/.test(s) ? 'sid' : 'cid';
        const want = Array.isArray(params) ? String(params[0]) : '';
        return { rows: (offers ?? []).filter(o => String(o[key] ?? '') === want) };
      }
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  });
}

function pushTokenCalls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map(c => String(c[0]))
    .filter(u => u.includes('/v1/push-token'));
}

/** The three statements `adoptWorkspaceForCalling` runs against whichever
 * workspace was chosen: close out calls a crash left `active`, drop expired
 * offers (each of which is a stored SDP), drop stale session rows. Their
 * presence is how a test can tell the adoption phase actually reached a
 * file, and their ABSENCE on one arm is what a partial mirror looks like. */
function housekeeping(sqlite: FakeSqlite, file: string): string[] {
  const instance = sqlite.instances.get(file);
  if (!instance) return [];
  return instance.execute.mock.calls
    .map(c => String(c[0]))
    .filter(
      s =>
        // The reconcile is written across four lines in db.ts, so the match is
        // on the shape rather than on one line of it.
        (s.startsWith('UPDATE call_log') && s.includes("state = 'ended'")) ||
        s.startsWith('DELETE FROM call_offers') ||
        s.startsWith('DELETE FROM call_sessions'),
    );
}

/** Every statement a file has been asked to run, in order. */
function sqlAgainst(sqlite: FakeSqlite, file: string): string[] {
  const instance = sqlite.instances.get(file);
  if (!instance) return [];
  return instance.execute.mock.calls.map(c => String(c[0]));
}

/**
 * Park the decoy's FIRST statement and hand back the release.
 *
 * That statement is the `SELECT MAX(lastMessageAt)` inside
 * `refreshDecoyTimestamps`, i.e. the duress arm's own await window — the one a
 * lock-screen press lands in when somebody is handed a ringing phone and told
 * to unlock it. Suspending it is not a contrivance: on a populated decoy the
 * SELECT is followed by six UPDATEs, so the window is as wide in production as
 * it is here, and it is entered on EVERY duress unlock.
 */
function parkDecoyDrift(sqlite: FakeSqlite): () => void {
  const instance = sqlite.instances.get('tacendum-decoy.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    if (!held && /MAX\(lastMessageAt\)/.test(String(sql))) {
      held = true;
      await parked;
    }
    return base(sql, params);
  });
  return release;
}

/** Let every detached chain the press started run to completion. */
async function settle(boot: Boot): Promise<void> {
  await boot.renderer.act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  });
}

afterEach(async () => {
  for (const { renderer, tree } of live) {
    await renderer.act(async () => {
      tree.unmount();
    });
  }
  live = [];
  globalThis.fetch = realFetch;
});

test('a cold start behind the lock screen opens no workspace and says nothing on the wire', async () => {
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');

  const tree = await boot.render();

  // The verdict has not been given: the lock screen is what is on screen.
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  // Rule 14: no byte of either world before a verdict. Not merely "no file
  // was read" — the boot path used to run an UPDATE and two DELETEs against
  // the real workspace here, so an instance existing at all is the leak.
  expect(boot.sqlite.opened).toHaveLength(0);
  expect(boot.sqlite.instances.has('tacendum.sqlite')).toBe(false);
  // …and no byte of it on the wire either. `uploadPushTokens` spends the real
  // account's bearer token, so a PUT here is this device telling the server
  // who owns it before anyone has proved they are that person.
  expect(boot.fetchMock).not.toHaveBeenCalled();
});

test('a duress unlock from cold opens the decoy FIRST and never registers a push token', async () => {
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', 'DECOY-ULID');
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', 'REAL-ULID');

  const tree = await boot.render();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);

  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  // The ORDER is the assertion. A real file opened before the decoy is a real
  // file opened while someone was standing over the phone.
  expect(boot.sqlite.opened).not.toContain('tacendum.sqlite');
  expect(boot.sqlite.opened[0]).toBe('tacendum-decoy.sqlite');
  // Nothing was executed against the real file either — the open order alone
  // would not catch a statement run through a handle opened earlier.
  expect(boot.sqlite.instances.get('tacendum.sqlite')!.execute).not.toHaveBeenCalled();
  expect(boot.ws.calls.start).not.toHaveBeenCalled();
  // Rule 15, and the leg the latched harness never covered: network-silent
  // means silent for the whole session, including before the code was typed.
  expect(pushTokenCalls(boot.fetchMock)).toEqual([]);
  // THE TWIN. Withholding the push registration is the only thing this arm
  // withholds: the decoy still reconciles and prunes its OWN call rows, and
  // the same phase re-reads the decoy's own account id — which is what stops
  // the real owner's ULID, latched at boot with no production reset path, from
  // outliving the verdict and naming this device to a coerced session's
  // group-call coordinator. Skipping the phase on this arm would leave the
  // decoy permanently showing calls a crash left "in progress".
  expect(housekeeping(boot.sqlite, 'tacendum-decoy.sqlite')).toHaveLength(3);
});

test('a real unlock from cold opens the real workspace and registers only after the verdict', async () => {
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', 'REAL-ULID');

  const tree = await boot.render();
  // Nothing yet — asserted before the code so a later PUT cannot be mistaken
  // for this one.
  expect(pushTokenCalls(boot.fetchMock)).toEqual([]);

  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);

  expect(boot.session.mode).toBe('real');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(boot.sqlite.opened).toContain('tacendum.sqlite');
  expect(boot.sqlite.opened).not.toContain('tacendum-decoy.sqlite');
  // The registration is not suppressed — it is re-homed. A real session still
  // has to be reachable, or the phone stops ringing.
  expect(pushTokenCalls(boot.fetchMock).length).toBeGreaterThan(0);
  // And the workspace housekeeping still happens — it moved, it did not go.
  expect(housekeeping(boot.sqlite, 'tacendum.sqlite')).toHaveLength(3);
});

test('a real unlock that dies before the workspace still leaves the phone reachable', async () => {
  // PUSH REGISTRATION MUST NOT BE A SINGLE POINT OF FAILURE. `enterRealWorkspace`
  // runs eight or so awaited Keychain and file steps before it opens anything,
  // and any throw among them lands in the catch that heals accounts. Hang the
  // registration off the far side of those and one unrelated failure — a
  // container that will not prepare, exactly what is simulated here — leaves
  // this device with NO push token for the entire launch: no VoIP wake, so a
  // call to a backgrounded or locked phone never rings and nothing anywhere
  // reports an error. That is a denial of ring at one remove, and it is why
  // the verdict is told to the push path before the fallible half starts.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  boot.crypto.prepareDatabaseDirectory.mockImplementation(() => {
    throw new Error('database directory unavailable');
  });

  const tree = await boot.render();
  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);

  // The workspace half genuinely failed — this is not a test of a healthy boot.
  expect(boot.session.mode).toBe('real');
  expect(boot.sqlite.opened).toHaveLength(0);
  // …and the phone can still be woken.
  expect(pushTokenCalls(boot.fetchMock).length).toBeGreaterThan(0);
  // AND THE FAILED UNLOCK LEFT THE DOOR SHUT. `initDb()` clears the latch, and
  // the two directory preparations are the steps in it that throw — so
  // clearing first meant a unlock that FAILED left the module unlatched, and
  // the next db call from anywhere would lazily open a workspace nobody had
  // successfully chosen. The message matters: 'database is closed' is the
  // latch, anything else is the failure being re-raised past it.
  await expect(boot.db.loadProfile()).rejects.toThrow('database is closed');
});

test('a real unlock with the identity gone tells the coordinator nothing and prunes nothing', async () => {
  // THE ORDER OF TWO LINES. The workspace phase re-reads who this device is
  // and sweeps its call rows; the identity gate decides whether this device
  // has a usable account at all. Run the phase ABOVE the gate and a phone
  // whose identity keypair is gone announces itself to the small-group
  // coordinator as registered, and prunes rows out of a workspace, on its way
  // to a landing screen it is being sent to precisely because it can decrypt
  // nothing. The read this replaced sat below the gate; so does it.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', 'REAL-ULID');
  // A profile on disk with no identity keypair behind it.
  boot.crypto.hasIdentity.mockResolvedValue(false);

  const tree = await boot.render();
  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);

  // The gate fired: landing, not the chat list.
  expect(
    tree.root.findAllByProps({ testID: 'landing-get-started' }).length,
  ).toBeGreaterThan(0);
  expect(boot.ws.calls.start).not.toHaveBeenCalled();
  // The workspace opened — the gate needs the profile row to fire at all —
  // but the adoption phase behind it never ran.
  expect(boot.sqlite.opened).toContain('tacendum.sqlite');
  expect(housekeeping(boot.sqlite, 'tacendum.sqlite')).toEqual([]);
  // The push registration is NOT part of that ordering claim, and deliberately
  // is not moved with it: it happened at the verdict, as it did on every
  // launch before any of this existed, because a device that still holds a
  // bearer token must stay wakeable while its owner is being walked through a
  // heal. Withholding it here would trade a stale coordinator id for a phone
  // that stops ringing.
  expect(pushTokenCalls(boot.fetchMock).length).toBeGreaterThan(0);
});

/* REAL Crockford ULIDs (no I, L, O, U): the shipped zod schemas validate every
 * id, and a placeholder would exercise the rejection path instead of the arm
 * under test. */
const SID = '01HQ5E55N0000000000000AAAA';
const STARTER = '01HQ5TARTER00000000000000A';
const REAL_ULID = '01HQ5E1F00000000000000000A';
const DECOY_ULID = '01HQDEC0YW0RKSPACE0000000A';
const CID_1TO1 = '01HQ1T01CA11000000000000AA';
const PEER = '01HQPEER0000000000000000AA';
/** A CallKit press that names no call of ours — a synthetic push placeholder,
 * or somebody else's 1:1 cid. It still reaches `loadCallSession`. */
const OTHER_PRESS = '01HQ5THERPRESS000000000AAA';

/** The held ginvite that goes with `killedMidSession()`: without the STARTER's
 * own offer the restore releases the CXCall as `failed_media` whatever file it
 * read, and the test would pass for the wrong reason. */
function heldStarterOffer(): {
  cid: string;
  peerId: string;
  sdp: string;
  video: number;
  exp: number;
  serverTs: number;
  sid: string | null;
} {
  return {
    cid: '01HQ5TARTERLEG0000000000AA',
    peerId: STARTER,
    sdp: 'v=0\r\na=fingerprint:sha-256 AA\r\nOFFER',
    video: 0,
    exp: Date.now() + 60_000,
    serverTs: Date.now(),
    sid: SID,
  };
}

/** The 1:1 twin: one stored offer, keyed by its own cid. */
function heldOneToOneOffer(): ReturnType<typeof heldStarterOffer> {
  return {
    cid: CID_1TO1,
    peerId: PEER,
    sdp: 'v=0\r\na=fingerprint:sha-256 AA\r\nOFFER',
    video: 0,
    exp: Date.now() + 60_000,
    serverTs: Date.now(),
    sid: null,
  };
}

/** The bridge, as the RING sees it: what a press actually produced. */
function nativeCall(): { createAnswer: jest.Mock; endCall: jest.Mock } {
  return jest.requireMock('tacendum-call') as {
    createAnswer: jest.Mock;
    endCall: jest.Mock;
  };
}

/** The session a killed device left behind, as `call_sessions` holds it. */
function killedMidSession(): {
  sid: string;
  roomId: string | null;
  starterId: string;
  roster: string;
  se: number;
  video: number;
  startedAt: number;
} {
  return {
    sid: SID,
    roomId: null,
    starterId: STARTER,
    roster: JSON.stringify([STARTER, REAL_ULID]),
    se: 0,
    video: 0,
    startedAt: Date.now(),
  };
}

test('a press landing inside the duress arm cannot open, read or write the real workspace', async () => {
  // THE HANDOFF, WHICH NEEDS NO RACE TO ARRANGE: kill the app, ring it, hand
  // the ringing phone to someone and have them type the duress code. CallKit
  // is holding a press the whole time, and `flushPendingEvents` replays it
  // from a mount effect — so the press and the unlock overlap by construction.
  //
  // The duress arm awaits `refreshDecoyTimestamps()` while the db module sits
  // at `closedLatch === true, db === null, workspace === 'real'`. The
  // pre-verdict door checks the latch, passes (it is not a 'verdict' caller),
  // finds no handle and lazily opens `WORKSPACE_FILES[workspace]` — the REAL
  // file — while somebody is standing over the phone.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession());

  const tree = await boot.render();
  const release = parkDecoyDrift(boot.sqlite);

  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  // Parked mid-arm: past `db.close()`, short of the decoy being open.
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  release();
  await settle(boot);

  // Rule 14, at the only moment it has ever mattered. Not "no file was read":
  // an instance existing at all is the leak, because `open()` IS the disclosure
  // — the real workspace was unsealed while someone was watching.
  expect(boot.sqlite.opened).not.toContain('tacendum.sqlite');
  // …and nothing was run through a handle opened earlier, either. The session
  // row holds `roomId`, `starterId` and the FULL ROSTER of the last group
  // call; the `profile` read hands the coerced session the real owner's ULID;
  // and `takeCallOffersForSession` DELETEs, so the real workspace is WRITTEN.
  expect(sqlAgainst(boot.sqlite, 'tacendum.sqlite')).toEqual([]);
  // THE FOURTH CONSEQUENCE, which is the one the coerced person sees. A handle
  // open on the real file makes `db.setWorkspace('decoy')` throw ("close the
  // database before switching workspace"), the arm falls into its catch, and
  // the person holding the phone is shown "Get started" — a passcode that
  // visibly did something unusual is the whole failure mode the decoy exists
  // to avoid.
  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'landing-get-started' })).toHaveLength(0);
  // And the arm ran to the end, so the decoy got its own housekeeping — which
  // is also what re-reads who this device is (`adoptWorkspaceForCalling`).
  expect(housekeeping(boot.sqlite, 'tacendum-decoy.sqlite')).toHaveLength(3);
});

test('a press landing before the duress arm can close the database is no different', async () => {
  // THE DRIFT WINDOW IS NOT THE ONLY WINDOW, and this is the case that says
  // why the arm has to DECLARE its verdict rather than merely reorder its
  // steps. Everything above `db.close()` awaits too — `disarmPreviews`,
  // `retractSelfId`, `clearBadge` — and through all of it `workspace` still
  // reads 'real' with no handle open, which is exactly the state the
  // pre-verdict door lazily opens the REAL file from. No ordering fixes this:
  // these steps run before there is anything to switch, and `setWorkspace`
  // cannot be hoisted above the `close()` that makes it legal. Only
  // `db.beginUnlock('decoy')`, on the arm's first synchronous line, reaches
  // them. Parked on `clearBadge`, which is the last of the three.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession());
  const native = jest.requireMock('tacendum-call') as { setBadgeCount: jest.Mock };
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  native.setBadgeCount.mockImplementation(async () => {
    if (held) return undefined;
    held = true;
    await parked;
    return undefined;
  });

  const tree = await boot.render();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  release();
  await settle(boot);

  expect(boot.sqlite.opened).not.toContain('tacendum.sqlite');
  expect(sqlAgainst(boot.sqlite, 'tacendum.sqlite')).toEqual([]);
  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'landing-get-started' })).toHaveLength(0);
  expect(housekeeping(boot.sqlite, 'tacendum-decoy.sqlite')).toHaveLength(3);
});

test('a press INSIDE the real unlock arm after a duress session reaches the real workspace', async () => {
  // RENAMED, AND THE RENAME IS THE POINT. This case used to be called
  // "a real unlock after a duress session points the door back at the real
  // workspace", which names the state a DURESS SESSION LEAVES BEHIND — and it
  // never enters it: it presses only inside the real unlock arm's own await
  // window, which is a window an unlock has already declared itself in. The
  // window the name described is the LOCKED-IDLE one, where no unlock is in
  // flight at all because a CallKit answer does not unlock the phone, and
  // nothing here reached it. That window is now covered by "a lock-screen
  // answer after a DURESS session…" below, which is where the denial of ring
  // actually lived. This case keeps its own, narrower claim, under its own name.
  //
  // A duress session leaves `workspace === 'decoy'`. `relock()` puts it back to
  // 'real' (`relockWorkspace`), and the arm then declares 'real' again on its
  // first synchronous line — so a press landing in this arm's awaits is
  // serviced from the workspace the verdict just chose either way. Both are
  // asserted here; only the second is this case's subject.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession());

  const tree = await boot.render();
  // A coerced session first, so the module is left saying 'decoy'.
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  expect(boot.session.mode).toBe('duress');

  // Backgrounded and brought back: autolock defaults to 0 seconds, so this is
  // a relock, which is the only production path back to the lock screen.
  await boot.appState('background');
  await boot.appState('active');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);

  // Park the REAL arm on its last step before `db.close()`, and ring the phone
  // in that window.
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  const write = boot.crypto.writeSharedState.getMockImplementation()!;
  boot.crypto.writeSharedState.mockImplementation(async (name: string, value: string) => {
    if (!held && name === 'previews-armed') {
      held = true;
      await parked;
    }
    return write(name, value);
  });
  const decoyBefore = sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').length;
  const realBefore = sqlAgainst(boot.sqlite, 'tacendum.sqlite').length;

  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  release();
  await settle(boot);

  // The press was serviced against the REAL workspace, which is the one the
  // call was addressed to — not against the decoy the previous session left
  // the module pointed at.
  expect(
    sqlAgainst(boot.sqlite, 'tacendum.sqlite')
      .slice(realBefore)
      .some(s => /SELECT[\s\S]*FROM call_sessions/.test(s)),
  ).toBe(true);
  expect(
    sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite')
      .slice(decoyBefore)
      .some(s => /SELECT[\s\S]*FROM call_sessions/.test(s)),
  ).toBe(false);
});

test('a duress unlock still reaches the decoy when the freshness drift throws', async () => {
  // THE COSMETIC STEP MUST NOT BE ABLE TO STOP THE UNLOCK. Only the drift's
  // opening SELECT is guarded (`catch { return }` — "fresh file, no decoy
  // yet"); the six UPDATEs that follow it on a POPULATED decoy are not, and
  // they only run on a populated decoy, which is the only kind a duress unlock
  // is ever performed on. So the failure mode was: the decoy world exists, its
  // timestamps will not shift, and the person being coerced is shown "Get
  // started" — a passcode that visibly did something unusual, which is the one
  // outcome the whole feature exists to avoid. `disarmPreviews` and
  // `retractSelfId` above it are already swallowed for this exact reason.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID);
  const decoy = boot.sqlite.instances.get('tacendum-decoy.sqlite')!;
  const base = decoy.execute.getMockImplementation()!;
  decoy.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    const s = String(sql);
    // A decoy with conversations in it: the drift computes a positive delta
    // and enters the UPDATEs, which is the branch this case is about.
    if (/MAX\(lastMessageAt\)/.test(s)) return { rows: [{ newest: 1_000_000 }] };
    if (/^UPDATE messages SET ts/.test(s)) throw new Error('decoy drift failed');
    return base(sql, params);
  });

  const tree = await boot.render();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);

  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'landing-get-started' })).toHaveLength(0);
  expect(boot.sqlite.opened).not.toContain('tacendum.sqlite');
  expect(boot.sqlite.opened).toContain('tacendum-decoy.sqlite');
  expect(housekeeping(boot.sqlite, 'tacendum-decoy.sqlite')).toHaveLength(3);
});

test('a duress unlock that fails outright still forgets who the real owner is', async () => {
  // `selfAccountId` is a process-lifetime latch that the PRE-VERDICT door can
  // set (`learnSelfIdForRingService`), and the only thing that resets it is
  // `adoptWorkspaceForCalling` — which lives at the BOTTOM of the duress arm,
  // downstream of every throw source in it. So an arm that dies anywhere above
  // that line left the real owner's ULID naming this device to a coerced
  // session's group-call coordinator for the rest of the process.
  //
  // Observed the way production observes it: `learnSelfIdForRingService`
  // returns early while an id is latched and re-reads when it is not, so a
  // second press asking "who is this device" is a direct question about the
  // latch.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID, killedMidSession());
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession());

  const tree = await boot.render();
  // A LEGITIMATE pre-verdict press: nobody has typed anything, the ring is the
  // real account's, and the real file is the correct one to service it from.
  // This is the door working exactly as designed — and it latches REAL_ULID.
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  expect(sqlAgainst(boot.sqlite, 'tacendum.sqlite')).toContain(
    "SELECT value FROM profile WHERE key = 'userId'",
  );

  // Now the duress code, with the decoy's schema build failing outright.
  const decoy = boot.sqlite.instances.get('tacendum-decoy.sqlite')!;
  const base = decoy.execute.getMockImplementation()!;
  decoy.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    if (/CREATE TABLE IF NOT EXISTS profile/.test(String(sql))) {
      throw new Error('decoy schema unavailable');
    }
    return base(sql, params);
  });
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  expect(boot.session.mode).toBe('duress');

  // AND THE DEAD ARM LEFT THE MODULE LATCHED, which is what makes moving the
  // pointer back to 'real' safe. This arm died INSIDE `initDb()` — past the
  // line that unlatches, holding an open handle on the DECOY — so a catch that
  // moved `workspace` and nothing else would leave an unlatched module pointed
  // at the real file with a decoy handle standing: the next ordinary db call
  // (the "Get started" this screen is now showing runs one) would re-home that
  // handle onto `tacendum.sqlite` and WRITE it, with somebody standing over the
  // phone. The message matters — 'database is closed' is the latch, anything
  // else is a failure being re-raised past it.
  const beforeLatch = sqlAgainst(boot.sqlite, 'tacendum.sqlite').length;
  await expect(boot.db.loadProfile()).rejects.toThrow('database is closed');
  expect(sqlAgainst(boot.sqlite, 'tacendum.sqlite').slice(beforeLatch)).toEqual([]);

  // A second press. If the real owner's ULID were still latched this would ask
  // NOTHING — `learnSelfIdForRingService` returns early while an id is held —
  // so the question being asked at all is the assertion, and it is the same
  // question this case has always asked.
  //
  // IT ASKS THE REAL FILE NOW, AND THAT IS THE FIX RATHER THAN A CONCESSION.
  // This used to ask the decoy, because a dead arm left `pendingWorkspace ===
  // 'decoy'` standing with no session behind it — which is the leftover that
  // released every lock-screen answer in this window as `failed_media` (see "a
  // lock-screen answer after a duress unlock that DIED…"). The arm is dead:
  // nothing opened, no coerced session exists, "Get started" is on screen, and
  // the door is back where a cold process finds it. Rule 3 decides what that
  // means for a ring, and the decoy must not be read on its behalf either.
  const beforeReal = sqlAgainst(boot.sqlite, 'tacendum.sqlite').length;
  const beforeDecoy = sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').length;
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  expect(
    sqlAgainst(boot.sqlite, 'tacendum.sqlite')
      .slice(beforeReal)
      .filter(s => s === "SELECT value FROM profile WHERE key = 'userId'"),
  ).toHaveLength(1);
  expect(sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').slice(beforeDecoy)).toEqual([]);

  // AND THE RE-LEARNED ID STILL CANNOT REACH A COERCED SESSION, which is the
  // half the assertion above stopped carrying the moment the door went back to
  // the real file. The read just above latched REAL_ULID again; let the decoy's
  // schema build succeed, and type the code a second time — the retry a coerced
  // person gets when the first attempt visibly did nothing. The arm clears the
  // latch on its second synchronous line and re-reads its OWN id from the
  // workspace it opened, and touches no byte of the real file doing it.
  decoy.execute.mockImplementation(base);
  await relockThroughTheOs(boot, tree);
  const beforeRealRetry = sqlAgainst(boot.sqlite, 'tacendum.sqlite').length;
  const beforeDecoyRetry = sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').length;
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);

  expect(boot.session.mode).toBe('duress');
  expect(
    sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite')
      .slice(beforeDecoyRetry)
      .filter(s => /FROM profile/.test(s)).length,
  ).toBeGreaterThan(0);
  expect(sqlAgainst(boot.sqlite, 'tacendum.sqlite').slice(beforeRealRetry)).toEqual([]);
});

test('a cold process refuses to open a workspace for a caller that never asked for one', async () => {
  // DEFENCE IN DEPTH, and the piece that closes the whole class rather than
  // this one instance. `conn()` lazily opens `WORKSPACE_FILES[workspace]` for
  // whoever calls it first, and `workspace` defaults to 'real' — so before
  // this, ANY db call from ANY module reached before the lock verdict opened
  // the real file. The latch now starts SET, so a launched process behaves
  // exactly like a relocked one and only `initDb()` — which in production is
  // called from App.tsx's two post-verdict unlock arms and nowhere else — can
  // clear it.
  //
  // Asserted directly rather than through a boot, because the point is that it
  // holds for code that does not exist yet.
  const boot = coldStart();
  await expect(boot.db.loadProfile()).rejects.toThrow('database is closed');
  expect(boot.sqlite.opened).toHaveLength(0);

  await boot.db.initDb();
  expect(boot.sqlite.opened).toContain('tacendum.sqlite');
  await boot.db.close();
});

/**
 * A device whose decoy world has already been generated, locked, with the real
 * owner's small-group ring still held in `call_offers`.
 *
 * THE DECOY CARRIES THE REAL USERID, because that is what generation writes
 * into it (decoy.ts) — the decoy is the same person in an emptier world. It is
 * seeded that way here so `selfAccountId`, which a duress session legitimately
 * re-reads, is the SAME string on both sides and cannot be the variable. The
 * only thing that differs between the two files is which one holds the ring.
 */
function deviceWithAHeldRing(): Boot {
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', REAL_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession(), [
    heldStarterOffer(),
    heldOneToOneOffer(),
  ]);
  return boot;
}

/** Background → foreground with autolock at its 0 s default: the relock, and
 * the only production path back to the lock screen. */
async function relockThroughTheOs(
  boot: Boot,
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await boot.appState('background');
  await boot.appState('active');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);
}

/** What the door did with a press, from the two places that can prove it: the
 * files it touched, and what the RING got out of it. */
function ringProbe(boot: Boot) {
  const native = nativeCall();
  const marks = {
    real: sqlAgainst(boot.sqlite, 'tacendum.sqlite').length,
    decoy: sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').length,
    answers: native.createAnswer.mock.calls.length,
    ends: native.endCall.mock.calls.length,
  };
  return {
    realSql: () => sqlAgainst(boot.sqlite, 'tacendum.sqlite').slice(marks.real),
    decoySql: () => sqlAgainst(boot.sqlite, 'tacendum-decoy.sqlite').slice(marks.decoy),
    answers: () => native.createAnswer.mock.calls.length - marks.answers,
    ends: () => native.endCall.mock.calls.slice(marks.ends).map(c => [c[0], c[1]]),
  };
}

const READS_A_SESSION = /SELECT[\s\S]*FROM call_sessions/;

/*
 * THE DISCRIMINATING PAIR. Same device, same held ring, same press, in the
 * LOCKED-IDLE window — the lock screen is up and NOBODY IS UNLOCKING, because
 * answering a call from the lock screen does not unlock the phone. That window
 * is the entire premise of the pre-verdict door, and it is the one window the
 * declaration (`beginUnlock`) cannot reach: no unlock is in flight to declare
 * anything. The only difference between the two cases is which kind of session
 * ran before the relock.
 */

test('a lock-screen answer after a REAL session is serviced from the real workspace', async () => {
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);
  await settle(boot);
  expect(boot.session.mode).toBe('real');
  await relockThroughTheOs(boot, tree);

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: SID });
  await settle(boot);

  expect(probe.realSql().some(s => READS_A_SESSION.test(s))).toBe(true);
  expect(probe.decoySql().some(s => READS_A_SESSION.test(s))).toBe(false);
  // Rule 3, in the currency the ring is actually paid in.
  expect(probe.ends()).toEqual([]);
  expect(probe.answers()).toBe(1);
});

test('a lock-screen answer after a DURESS session is serviced from the real workspace too', async () => {
  // A DENIAL OF RING WITH NO RACE IN IT. A duress session
  // leaves `workspace === 'decoy'`; `initDb()` has cleared `pendingWorkspace`;
  // and `relock()` touches neither. Autolock defaults to 0 s, so EVERY
  // backgrounding after a coerced unlock lands the module in that state — and
  // no unlock arm ever runs in it, because answering from the lock screen does
  // not unlock the phone. So the declaration cannot help: the door resolves the
  // DECOY, `restoreLocked` finds no row in an empty file, and the real owner's
  // real incoming call is released as `failed_media`. The tapped answer is
  // discarded.
  //
  // The pointer has to be right in the locked-idle state itself, which is the
  // state a COLD process is in — that is what makes a relocked process
  // indistinguishable from a launched one, which is the invariant this module
  // already claims for its latch and did not keep for its workspace.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  expect(boot.session.mode).toBe('duress');
  await relockThroughTheOs(boot, tree);

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: SID });
  await settle(boot);

  // RULE 3 FIRST, because it is the consequence and not the mechanism: a
  // discarded answer shows up here as a released CXCall and no media.
  expect(probe.ends()).toEqual([]);
  expect(probe.answers()).toBe(1);
  expect(probe.realSql().some(s => READS_A_SESSION.test(s))).toBe(true);
  expect(probe.decoySql().some(s => READS_A_SESSION.test(s))).toBe(false);
});

/**
 * THE WINDOW THE RELOCK CANNOT REACH, which is where the previous round's fix
 * stopped and where its own test stepped over the gap.
 *
 * A duress arm that throws lands on 'landing', not 'locked'. `relock()` was the
 * only caller of `relockWorkspace()`, and `mustRelock` needs a
 * background→foreground cycle — so between a failed coercion and the next
 * foregrounding, `pendingWorkspace` still read 'decoy' with NO session behind
 * it and NO unlock in flight. Both cases below press in exactly that window:
 * no relock, no verdict, the phone showing "Get started" to whoever is standing
 * over it. The previous round's version of the group case relocked first, which
 * repaired the state before it looked at it — the harness fault this file's own
 * header is about.
 */

test('a lock-screen answer after a duress unlock that DIED reaches the real workspace', async () => {
  // THE OTHER ROUTE INTO THE SAME DENIAL OF RING, and the reason the leftover
  // has to be cleared where the attempt dies rather than only where it relocks.
  //
  // An unlock that dies before `initDb()` deliberately leaves `pendingWorkspace`
  // set — "the safe direction", because the door should follow the workspace
  // that unlock chose for as long as that attempt is what happened last. But
  // the attempt is over the moment it falls into its catch: nothing opened, no
  // messaging, no coordinator, and a landing screen. The declaration outlived
  // that, so a failed coercion left the door pointed at the EMPTY DECOY and
  // every lock-screen answer in that window was released as `failed_media` —
  // the same discarded answer as after a successful coercion, by the other
  // leftover, and a fix that reset only `workspace` would leave it standing.
  //
  // KILLED ON `db.close()`, which is the last step above the switch and the
  // only un-swallowed one in that stretch (`disarmPreviews`, `retractSelfId`
  // and `clearBadge` all catch their own). It needs a handle to close, which is
  // supplied by the same legitimate pre-verdict press the arm is racing — so
  // the failure and the leftover come from one ordinary sequence.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  // A press about SOMETHING ELSE — the door's admitted width: `loadCallSession`
  // is asked for every press there is and the sid is compared afterwards. It
  // opens the real handle, which is what this setup needs, and leaves the held
  // ring alone, which a decline for THIS sid would have consumed.
  boot.call.emit('callKitEnd', { cid: OTHER_PRESS });
  await settle(boot);
  boot.sqlite.instances.get('tacendum.sqlite')!.close.mockImplementation(() => {
    throw new Error('database would not close');
  });

  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  // The arm genuinely died: this is not a test of a healthy duress unlock.
  expect(boot.session.mode).toBe('duress');
  expect(
    tree.root.findAllByProps({ testID: 'landing-get-started' }).length,
  ).toBeGreaterThan(0);
  expect(boot.sqlite.opened).not.toContain('tacendum-decoy.sqlite');

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: SID });
  await settle(boot);

  expect(probe.ends()).toEqual([]);
  expect(probe.answers()).toBe(1);
  expect(probe.realSql().some(s => READS_A_SESSION.test(s))).toBe(true);
  expect(probe.decoySql().some(s => READS_A_SESSION.test(s))).toBe(false);
});

test('a 1:1 lock-screen answer after a duress unlock that DIED reaches the real workspace', async () => {
  // THE 1:1 HALF OF THE SAME WINDOW. A guard at one site and not its
  // twin is the shape this area keeps producing, and the two ring paths are
  // genuinely different code: a group press is classified by
  // `callKitNamesSession` and restored by the coordinator, while this one falls
  // through to the controller and `rehydrate`'s `call_offers WHERE cid = ?`.
  // Against the decoy that row does not exist and the CXCall is released as
  // `failed_media`, so the same leftover kills both, one file down.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  boot.call.emit('callKitEnd', { cid: OTHER_PRESS });
  await settle(boot);
  boot.sqlite.instances.get('tacendum.sqlite')!.close.mockImplementation(() => {
    throw new Error('database would not close');
  });

  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  expect(boot.session.mode).toBe('duress');
  expect(
    tree.root.findAllByProps({ testID: 'landing-get-started' }).length,
  ).toBeGreaterThan(0);
  expect(boot.sqlite.opened).not.toContain('tacendum-decoy.sqlite');

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: CID_1TO1 });
  await settle(boot);

  // Same reading as the 1:1 pair below: the socket is down between sessions, so
  // an answered 1:1 call loses its answer envelope and ends 'cancelled' on BOTH
  // arms — `failed_media` is emitted by exactly one thing here, `rehydrate`
  // finding no stored offer, which is the door having read the wrong file.
  expect(probe.ends().filter(e => e[1] === 'failed_media')).toEqual([]);
  expect(probe.answers()).toBe(1);
  const takes = /SELECT cid, peerId, sdp, video, exp, serverTs FROM call_offers WHERE cid = \?/;
  expect(probe.realSql().some(s => takes.test(s))).toBe(true);
  expect(probe.decoySql().some(s => takes.test(s))).toBe(false);
});

test('a 1:1 lock-screen answer after a REAL session is serviced from the real workspace', async () => {
  // The 1:1 half of the pair's control arm, for the same reason the group half
  // has one: an assertion about the DOOR has to be shown to hold when the door
  // is uncontested, or a red on the duress arm proves only that something in
  // the harness cannot answer a 1:1 call at all.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);
  await settle(boot);
  expect(boot.session.mode).toBe('real');
  await relockThroughTheOs(boot, tree);

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: CID_1TO1 });
  await settle(boot);

  // THE SIGNATURE OF A DISCARDED ANSWER, not "no end ever": a 1:1 answer given
  // at the lock screen goes on to lose its answer envelope, because the socket
  // is down between sessions, and the machine ends the unconnected call as
  // 'cancelled'. That happens IDENTICALLY on both arms of the pair below and
  // has nothing to do with which file was read (residual, noted in the
  // handover) — whereas `failed_media` is emitted by exactly one thing here:
  // `rehydrate` finding no stored offer, which is the door having read the
  // wrong workspace.
  expect(probe.ends().filter(e => e[1] === 'failed_media')).toEqual([]);
  expect(probe.answers()).toBe(1);
  const takes = /SELECT cid, peerId, sdp, video, exp, serverTs FROM call_offers WHERE cid = \?/;
  expect(probe.realSql().some(s => takes.test(s))).toBe(true);
  expect(probe.decoySql().some(s => takes.test(s))).toBe(false);
});

test('a 1:1 lock-screen answer after a duress session is serviced from the real workspace', async () => {
  // THE SAME WINDOW, THE OTHER SHAPE. A 1:1 press never reaches the
  // coordinator at all: `callKitNamesSession` finds a session row whose sid is
  // not this cid, the press falls through to the controller, and `rehydrate`
  // asks `call_offers WHERE cid = ?` through the same door. Against the decoy
  // that row does not exist and the CXCall is released as `failed_media` — the
  // group defect's twin, one file down.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  expect(boot.session.mode).toBe('duress');
  await relockThroughTheOs(boot, tree);

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: CID_1TO1 });
  await settle(boot);

  // Same reading as the control above: `failed_media` is the discarded answer.
  expect(probe.ends().filter(e => e[1] === 'failed_media')).toEqual([]);
  expect(probe.answers()).toBe(1);
  const takes = /SELECT cid, peerId, sdp, video, exp, serverTs FROM call_offers WHERE cid = \?/;
  expect(probe.realSql().some(s => takes.test(s))).toBe(true);
  expect(probe.decoySql().some(s => takes.test(s))).toBe(false);
});

test('a handle the door already opened does not survive the duress verdict', async () => {
  // THE FEATURE'S OWN SCENARIO IN THE FEATURE'S OWN
  // ORDER: the phone rings, the press happens, and THEN the coerced passcode is
  // typed ("handing a ringing phone to someone and telling them to unlock it is
  // the entire setup", db.ts). The first press is the door working exactly as
  // designed — no verdict exists, the ring is the real account's, the real file
  // is the correct one — and it leaves a HANDLE OPEN on `tacendum.sqlite`.
  //
  // `beginUnlock('decoy')` then declares the verdict, and the declaration is
  // consulted only on `conn()`'s lazy-open branch. With a handle already open
  // the whole arm above `db.close()` is still pointed at the real file, so a
  // second press in that window reads the last group call's roomId, starterId
  // and full ROSTER, re-reads the profile row (the arm has just cleared the id
  // latch, which is what makes it read again), and DELETEs the offer rows —
  // the real workspace written while somebody is standing over the phone.
  //
  // Parked on `clearBadge`, the last awaited step before `db.close()`.
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();

  // The legitimate pre-verdict press. It opens the real file, correctly.
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  expect(boot.sqlite.opened).toContain('tacendum.sqlite');

  const native = jest.requireMock('tacendum-call') as { setBadgeCount: jest.Mock };
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  native.setBadgeCount.mockImplementation(async () => {
    if (held) return undefined;
    held = true;
    await parked;
    return undefined;
  });

  const realHandle = boot.sqlite.instances.get('tacendum.sqlite')!;
  expect(realHandle.close).not.toHaveBeenCalled();

  const probe = ringProbe(boot);
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  // Parked inside the arm, past the declaration, short of the close.
  boot.call.emit('callKitEnd', { cid: SID });
  await settle(boot);
  release();
  await settle(boot);

  // Not one statement against the real file on the far side of the verdict.
  expect(probe.realSql()).toEqual([]);
  // AND THE HANDLE IS GONE, not merely unused. Steering the reads while leaving
  // the connection standing would leave `tacendum.sqlite` open across a whole
  // coerced session, still holding whatever SQLite has cached and still able to
  // be reached by any code that got hold of it — and the arm's own `db.close()`
  // closes the DECOY by then, so nothing else would ever close this one.
  expect(realHandle.close).toHaveBeenCalled();
  // AND THE POSITIVE HALF, so "nothing happened at all" cannot pass this: the
  // press was serviced, against the DECOY, which is where a declared duress
  // verdict points the door.
  expect(probe.decoySql().some(s => READS_A_SESSION.test(s))).toBe(true);
  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'landing-get-started' })).toHaveLength(0);
});

test('the door re-homes an already-open handle in BOTH directions', async () => {
  // The module-level statement of the same rule, both arms of the twin (rule
  // 1). Production reaches the real→decoy direction through the case above; the
  // decoy→real direction is defence in depth, and it is written down because a
  // guard that only steers one way is the exact shape of defect this area keeps
  // producing. Asserted directly, because the point is that it holds for code
  // that does not exist yet.
  const boot = coldStart();
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID, killedMidSession());
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', REAL_ULID);

  // No verdict: the door opens the real file, which is what the VoIP push that
  // rang this phone was addressed to.
  await boot.db.loadCallSession();
  expect(boot.sqlite.opened).toEqual(['tacendum.sqlite']);

  boot.db.beginUnlock('decoy');
  await boot.db.loadCallSession();
  expect(boot.sqlite.opened).toEqual(['tacendum.sqlite', 'tacendum-decoy.sqlite']);

  boot.db.beginUnlock('real');
  await boot.db.loadCallSession();
  expect(boot.sqlite.opened).toEqual([
    'tacendum.sqlite',
    'tacendum-decoy.sqlite',
    'tacendum.sqlite',
  ]);
  await boot.db.close();
});

/**
 * THE HAND-OVER WITH NOTHING RACING IT, end to end — the case that needs no
 * second press, no drift window and no parked unlock arm, only the feature's
 * own scenario: a ringing phone, a tapped ANSWER, and somebody typing the
 * duress passcode while the press is still being serviced.
 *
 * The door's read is not instantaneous. It is a statement in op-sqlite's
 * thread pool, and `enterDecoyWorkspace` runs `await db.close()` — which is
 * `sqlite3_interrupt(db)` first, then a drained pool, then the close
 * (`DBHostObject.cpp:298-316`). The interrupted step throws in `bridge.cpp`
 * and `utils.cpp`'s promisify rejects the promise the door is awaiting, so
 * `takeCallOffer…` unwinds, its caller's `.catch()` reads "nothing to
 * restore", and the CXCall somebody already answered is released as
 * `failed_media`. Every previous round's harness resolved that statement
 * instead, which is why four rounds of tests about this door never saw it.
 *
 * Both arms of the twin, because the two readers are different code
 * (`takeCallOffersForSession` by sid, `takeCallOffer` by cid) and only the
 * group one goes through the coordinator.
 */
function pressParkedOnItsOfferRead(
  boot: Boot,
  key: 'sid' | 'cid',
): () => void {
  const real = boot.sqlite.instances.get('tacendum.sqlite')!;
  const base = real.execute.getMockImplementation()! as (
    sql: unknown,
    params?: unknown,
  ) => Promise<unknown>;
  let release!: () => void;
  const parked = new Promise<void>(resolve => {
    release = resolve;
  });
  let held = false;
  const wanted =
    key === 'sid'
      ? /^SELECT[\s\S]*FROM call_offers[\s\S]*WHERE sid = \?/
      : /^SELECT[\s\S]*FROM call_offers[\s\S]*WHERE cid = \?/;
  real.execute.mockImplementation(async (sql: unknown, params?: unknown) => {
    // Held ONCE, and only the offer read: this is the statement CallKit's
    // press is waiting on, and the one the duress arm's close lands on.
    if (!held && wanted.test(String(sql))) {
      held = true;
      await parked;
    }
    return base(sql, params);
  });
  return release;
}

test('a duress unlock typed while a group press is mid-read still answers the ring', async () => {
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  const release = pressParkedOnItsOfferRead(boot, 'sid');

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: SID });
  await settle(boot);
  // The press is now suspended INSIDE its offer read — the state the whole
  // case is about, asserted rather than assumed, because a press that had
  // already finished would make the rest of this vacuous.
  expect(probe.answers()).toBe(0);
  expect(probe.ends()).toEqual([]);

  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  release();
  await settle(boot);

  // RULE 3, in the currency the ring is paid in: the answer survives the
  // verdict that landed on top of it.
  expect(probe.ends()).toEqual([]);
  expect(probe.answers()).toBe(1);
  // …and the verdict is still binding for everything that came AFTER it: the
  // decoy is what opened, and the coerced session is the one on screen.
  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'landing-get-started' })).toHaveLength(0);
});

test('a duress unlock typed while a 1:1 press is mid-read still answers the ring', async () => {
  const boot = deviceWithAHeldRing();
  const tree = await boot.render();
  const release = pressParkedOnItsOfferRead(boot, 'cid');

  const probe = ringProbe(boot);
  boot.call.emit('callKitAnswer', { cid: CID_1TO1 });
  await settle(boot);
  expect(probe.answers()).toBe(0);
  expect(probe.ends()).toEqual([]);

  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);
  release();
  await settle(boot);

  expect(probe.answers()).toBe(1);
  // NOT `ends() === []`, and the difference is stated rather than quietly
  // relaxed. This fixture's 1:1 cold answer already lands an
  // `endCall(cid, 'cancelled')` after its `createAnswer` — measured with two
  // controls, one with the read parked and NO duress unlock and one with a
  // plain unparked press, both of which produce it. That is a pre-existing
  // property of the 1:1 restore in this file's device, not something the
  // verdict or this round's fix does, and asserting an empty list here would
  // be asserting a state this app does not reach.
  //
  // What this case is about is the OTHER reason a lock-screen answer dies:
  // `failed_media`, which is what the callers produce when the door's read
  // rejects. The interrupted read makes that signature and nothing else does.
  expect(probe.ends().map(e => e[1])).not.toContain('failed_media');
  expect(boot.session.mode).toBe('duress');
});

/*
 * THE COLD-BOOT HALF OF THE FAIL-CLOSED RULE (a recorded
 * finding: "Two fail-open lock
 * windows. A lock.status() rejection read as 'not locked', bypassing an armed
 * lock at foreground-resume and again during cold boot").
 *
 * The foreground window is pinned by App.foreground.failclosed.test.tsx; the
 * three cases below pin the boot window, which no test drove directly — the
 * foreground file's rejections all arrive on the SECOND status read, so its
 * boots succeed by construction. Here the FIRST read of the process rejects.
 * Before the fix the boot effect's status read was unguarded (an armed lock
 * whose flag would not read stranded the app on 'loading' — and the launch
 * tail's own read was caught into `lockEnabled = false`, i.e. landing, with
 * the workspace-opening machinery already past the gate). Now every
 * rejection lands the same place: relock, 'locked', transport down.
 */

/** Seal exactly the enabled flag, and hand back the repair. Every other key
 * keeps answering — the failure under test is one unreadable value, not a
 * dead store. */
function sealLockEnabledRead(boot: Boot): { heal: () => void } {
  let sealed = true;
  boot.crypto.getSecret.mockImplementation(async (key: string) => {
    if (sealed && key === 'lock.enabled') throw new Error('keychain sealed');
    return boot.crypto.__keychain.get(key) ?? null;
  });
  return {
    heal: () => {
      sealed = false;
    },
  };
}

test('a cold boot whose lock.status read rejects lands LOCKED, opens nothing, and says nothing on the wire', async () => {
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID);
  const { heal } = sealLockEnabledRead(boot);

  const tree = await boot.render();
  await settle(boot);

  // Unknown reads as LOCKED. The pre-fix posture — "unknown status reads as
  // unlocked" — would put chats or landing here with the workspace open and
  // the push registration spent.
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(boot.sqlite.opened).toHaveLength(0);
  expect(boot.ws.calls.start).not.toHaveBeenCalled();
  expect(boot.fetchMock).not.toHaveBeenCalled();

  // And the stated cost is real: one lock-screen tap once the store answers
  // again. The lock screen's own verify re-reads the Keychain, so a healed
  // store needs no relaunch.
  heal();
  await enterCode(boot, tree, ['1', '2', '3', '4', '5', '6']);
  await settle(boot);
  expect(boot.session.mode).toBe('real');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(boot.sqlite.opened).toContain('tacendum.sqlite');
});

test('a duress unlock after a boot-time status rejection behaves exactly like any duress unlock', async () => {
  // Rule 16 across the fail-closed path: the relock a rejection forces must
  // hand the duress verdict the same door every other lock screen does —
  // decoy first, the real file untouched, network-silent. A duress arm that
  // worked from an ordinary locked boot but not from a rejection-relocked one
  // would be a behavioural tell about WHY the phone is locked.
  const boot = coldStart();
  boot.crypto.__keychain.set('lock.enabled', '1');
  boot.crypto.__keychain.set('lock.passcode', '123456');
  seedWorkspace(boot.sqlite, 'tacendum-decoy.sqlite', DECOY_ULID);
  seedWorkspace(boot.sqlite, 'tacendum.sqlite', REAL_ULID);
  const { heal } = sealLockEnabledRead(boot);

  const tree = await boot.render();
  await settle(boot);
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);

  heal();
  await enterCode(boot, tree, ['6', '5', '4', '3', '2', '1']);
  await settle(boot);

  // The same assertions the ordinary duress-from-cold case makes, verbatim in
  // meaning: same order, same silence, same housekeeping.
  expect(boot.session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(boot.sqlite.opened).not.toContain('tacendum.sqlite');
  expect(boot.sqlite.opened[0]).toBe('tacendum-decoy.sqlite');
  expect(
    boot.sqlite.instances.get('tacendum.sqlite')!.execute,
  ).not.toHaveBeenCalled();
  expect(boot.ws.calls.start).not.toHaveBeenCalled();
  expect(pushTokenCalls(boot.fetchMock)).toEqual([]);
  expect(housekeeping(boot.sqlite, 'tacendum-decoy.sqlite')).toHaveLength(3);
});

test('a launch that dies into its landing decision still fails closed when THAT status read rejects', async () => {
  // The launch tail (the 'lock-status-rejected' sentinel): an unlocked boot
  // whose workspace open fails lands in the catch that decides landing vs
  // locked, and the decision is one more lock.status read. Pre-fix that read
  // was caught into `lockEnabled = false` — landing, "Get started", on a
  // phone that could not prove its lock was off. The first read of the
  // process succeeds here (no lock armed), the deciding read rejects.
  const boot = coldStart();
  let enabledReads = 0;
  boot.crypto.getSecret.mockImplementation(async (key: string) => {
    if (key === 'lock.enabled') {
      enabledReads += 1;
      if (enabledReads >= 2) throw new Error('keychain sealed');
    }
    return boot.crypto.__keychain.get(key) ?? null;
  });
  // The open dies the way the reachability case above drives it: the
  // container will not prepare, so `enterRealWorkspace` falls into its catch
  // with nothing opened and nothing healable.
  boot.crypto.prepareDatabaseDirectory.mockImplementation(() => {
    throw new Error('database directory unavailable');
  });

  const tree = await boot.render();
  await settle(boot);

  expect(enabledReads).toBeGreaterThanOrEqual(2);
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: 'landing-get-started' }),
  ).toHaveLength(0);
  expect(boot.sqlite.opened).toHaveLength(0);
  expect(boot.ws.calls.start).not.toHaveBeenCalled();
  // The push registration fired at the verdict, before the open died — that
  // is the reachability rule ("a real unlock that dies before the workspace
  // still leaves the phone reachable"), and failing closed afterwards must
  // not claw it back.
  expect(pushTokenCalls(boot.fetchMock).length).toBeGreaterThan(0);
});
