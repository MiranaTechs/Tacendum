import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as native from 'tacendum-call';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { SettingsScreen } from '../src/screens/SettingsScreen';

/**
 * SILENCE UNKNOWN CALLERS, PERSISTED AND ADJUSTABLE.
 *
 * `decideRing` was written, documented and unit-tested; `mayRing` consulted
 * it; the behaviour worked. `setSilenceUnknownCallers` was called from NO
 * screen and wrote to NO storage, so the setting reset to its default on every
 * launch and there was no way to change it — while the published pages say it
 * is "on by default", a sentence that only means anything if it can be turned
 * off. A default nobody can change is not a default, it is a hard-coded rule
 * with a friendly description.
 *
 * THE FAIL-SAFE DIRECTION IS THE POINT OF THIS FILE, and it is the OPPOSITE of
 * the relay switch's. `loadAlwaysRelay` tests `=== '1'` so an unreadable
 * Keychain lands on OFF; this one tests `!== '0'` so an unreadable Keychain
 * lands on ON. `decideRing`'s docblock is the argument: a wrongly silenced
 * call leaves a missed-call row the person can see and return at a time they
 * choose, while a wrongly rung one is a stranger who holds an id making a
 * phone go off at 3am. The first is recoverable; the second cannot be undone.
 * When storage cannot say what was chosen, the phone stays quiet.
 *
 * FALSIFIERS, each run at authoring time, each restored, each recorded with
 * what actually went red:
 *  - flip `loadSilenceUnknownCallers` to `=== '1'` — the relay switch's fail
 *    direction copied across without re-arguing it: 4 of 12 fail, including
 *    "an unknown caller does not ring the phone", because with nothing stored
 *    yet the phone rings for everyone on first launch.
 *  - drop the `setSecret` from `setSilenceUnknownCallers` — THE SHIPPED
 *    DEFECT, restored: 4 fail, both relaunch cases among them, while every
 *    chip in Settings still moves under the finger.
 *  - remove the Settings row's testIDs, i.e. no row at all — the OTHER half
 *    of the shipped defect: 5 fail.
 *  - have `resetSilenceUnknownCallersForDuress` do nothing: 1 fails — a real
 *    session's "off" inherited by a coerced unlock.
 *  - hard-code `silenceUnknownCallers: true` in the `mayRing` dep: 1 fails —
 *    the setting turned off and the phone still refusing to ring, which is
 *    the same class of lie pointing the other way.
 */

const SELF = '01HQ5E1F00000000000000000A';
const STRANGER = '01HQ57RANGER0000000000000A';
const OFFER_CID = '01HQ0FFERC1D00000000000000';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const callEvents = (
  native as unknown as { __call: { emit: (n: string, p: unknown) => void } }
).__call;

/** Peers with a chat row carrying a message — the only thing that makes a
 * caller "known" to `decideRing`. Empty means every caller is a stranger. */
const known = new Set<string>();

function installTables(): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    const text = String(sql);
    const args = (params ?? []) as unknown[];
    if (/FROM chats WHERE peerId/.test(text)) {
      return {
        rows: known.has(String(args[0]))
          ? [{ peerId: args[0], displayName: 'Ana', localName: null, lastMessageAt: 1 }]
          : [],
      };
    }
    return base(sql, params);
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let teardown: (() => void) | undefined;
type EnvelopeListener = Parameters<typeof messaging.onEnvelope>[0];
let listener: EnvelopeListener | null = null;

function deliverOffer(peerId: string): void {
  listener?.(
    peerId,
    { tcm: 'call.offer', cid: OFFER_CID, sdp: SDP, vid: false, exp: Date.now() + 45_000 },
    { msgId: '01HQMSG0000000000000000001', ts: Date.now() },
  );
}

beforeEach(async () => {
  keychain.clear();
  known.clear();
  calling.resetCallingForTests();
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installTables();
  await setSecret(AUTH_TOKEN_KEY, 'auth-token');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(false);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  listener = null;
  jest.spyOn(messaging, 'onEnvelope').mockImplementation(fn => {
    listener = fn;
    return () => {
      listener = null;
    };
  });
  teardown = await calling.startCalling();
  calling.setSelfAccountId(SELF);
  await calling.loadSilenceUnknownCallers();
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

/** Open a row's ⓘ: the testID lands on the disclosure composite first, so
 * the press names the node that actually carries onPress. */
async function openInfo(tree: ReactTestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen
      onBack={() => {}}
      onOpenLinkedDevices={() => {}}
      onOpenAccountEmail={() => {}}
    />);
    await flush();
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
    await flush();
  });
}

function selected(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return tree.root.findByProps({ testID }).props.accessibilityState
    .selected as boolean;
}

describe('Settings → CALLS → silence unknown callers', () => {
  it('offers the row, starting from the loaded preference — on', async () => {
    const tree = await render();
    expect(selected(tree, 'settings-silence-on')).toBe(true);
    expect(selected(tree, 'settings-silence-off')).toBe(false);
  });

  it('turning it off changes what the call module will actually do', async () => {
    // Not that a chip is highlighted: that the module `mayRing` reads on the
    // path of an incoming call now says the phone may ring for anyone.
    const tree = await render();
    await press(tree, 'settings-silence-off');

    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
    expect(selected(tree, 'settings-silence-off')).toBe(true);
  });

  it('persists the choice past a relaunch', async () => {
    const tree = await render();
    await press(tree, 'settings-silence-off');

    // The process ends; the module's in-memory value goes with it.
    calling.resetCallingForTests();
    expect(calling.silenceUnknownCallersEnabled()).toBe(true);
    await calling.loadSilenceUnknownCallers();

    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
    expect(keychain.get('tacendum.silenceUnknownCallers')).toBe('0');
  });

  it('turns back on, and that persists too', async () => {
    const tree = await render();
    await press(tree, 'settings-silence-off');
    await press(tree, 'settings-silence-on');

    calling.resetCallingForTests();
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(true);
    expect(keychain.get('tacendum.silenceUnknownCallers')).toBe('1');
  });

  it('says what "unknown" means and what turning it off costs', async () => {
    // "Unknown caller" is not self-explanatory and the wrong guess is the
    // dangerous one: someone who scanned a code an hour ago is still unknown
    // here, and someone who reads this row as a stranger-detector will turn it
    // off to fix a problem it does not have.
    const tree = await render();
    // Behind the row's ⓘ: closed until opened, under its row.
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/never exchanged a message/);
    await openInfo(tree, 'settings-silence-info');
    const note = JSON.stringify(tree.toJSON());

    expect(note).toMatch(/never exchanged a message/);
    expect(note).toMatch(/missed call you can return/);
    expect(note).toMatch(/Scanning someone’s code is not enough/);
    expect(note).toMatch(/at any hour/);
  });
});

describe('the fail-safe direction', () => {
  it('an unreadable Keychain leaves the phone QUIET, not ringing', async () => {
    // The asymmetry, pinned. `loadAlwaysRelay` fails to OFF because a stuck
    // relay degrades every call with no visible cause; this one fails to ON
    // because the failure it is guarding is not comparable — a stranger
    // ringing a phone at 3am cannot be taken back, and a silenced call leaves
    // a row that can.
    await calling.setSilenceUnknownCallers(false);
    calling.resetCallingForTests();

    // The implementation is swapped and put back by hand rather than with
    // `jest.spyOn`: a spy over a manual module mock is not restored by
    // `restoreAllMocks`, and a Keychain left throwing would silently make
    // every later test in this file read as "storage unavailable" — which is
    // the state this very test claims is safe, so the leak would hide itself.
    const crypto = jest.requireMock('tacendum-crypto') as { getSecret: jest.Mock };
    const real = crypto.getSecret.getMockImplementation()!;
    crypto.getSecret.mockImplementation(async () => {
      throw new Error('keychain unavailable');
    });
    await calling.loadSilenceUnknownCallers();
    crypto.getSecret.mockImplementation(real);

    expect(calling.silenceUnknownCallersEnabled()).toBe(true);
    // And the swap really was in force — otherwise this test passes on the
    // default and proves nothing.
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
  });

  it('an absent value is ON, and only an explicit "off" is off', async () => {
    // `!== '0'`, not `=== '1'`: a value that was never written, a truncated
    // read and a garbage string all have to land on quiet. Only a deliberate
    // "0" — which nothing but `setSilenceUnknownCallers(false)` writes — may
    // open the phone up.
    keychain.clear();
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(true);

    keychain.set('tacendum.silenceUnknownCallers', 'yes please');
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(true);

    keychain.set('tacendum.silenceUnknownCallers', '0');
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
  });

  it('shows the DEFAULT under duress, never the owner’s choice', async () => {
    await calling.setSilenceUnknownCallers(false);

    calling.resetSilenceUnknownCallersForDuress();
    expect(calling.silenceUnknownCallersEnabled()).toBe(true);

    // And the real value is untouched on disk — a coerced unlock cannot erase
    // a preference by being opened.
    await calling.loadSilenceUnknownCallers();
    expect(calling.silenceUnknownCallersEnabled()).toBe(false);
  });
});

describe('what the setting does to an arriving call', () => {
  it('an unknown caller does not ring the phone while it is on', async () => {
    // The end of the wire, driven through the real controller: no
    // `reportIncomingCall`, so CallKit never presents anything and the phone
    // makes no sound.
    deliverOffer(STRANGER);
    await calling.callController().whenIdle();

    expect(native.reportIncomingCall).not.toHaveBeenCalled();
  });

  it('the same caller rings once the setting is turned off in Settings', async () => {
    const tree = await render();
    await press(tree, 'settings-silence-off');

    deliverOffer(STRANGER);
    await calling.callController().whenIdle();

    expect(native.reportIncomingCall).toHaveBeenCalled();
  });

  it('someone you have messaged rings either way', async () => {
    // The setting is about history, not about strangers in the abstract — and
    // a test that only ever silences would pass against a module that never
    // rings at all.
    known.add(STRANGER);

    deliverOffer(STRANGER);
    await calling.callController().whenIdle();

    expect(native.reportIncomingCall).toHaveBeenCalled();
  });

  it('a silenced call still leaves a missed-call row to return', async () => {
    // The whole basis of failing toward quiet: silencing costs a delayed call
    // back, not a lost one. If this row stopped being written, the fail-safe
    // argument above would no longer hold and the direction would have to be
    // re-argued.
    deliverOffer(STRANGER);
    await calling.callController().whenIdle();
    await flush();

    const writes = (sqlite.instances.get('tacendum.sqlite')?.execute.mock.calls ?? [])
      .map(c => ({ sql: String(c[0]), params: (c[1] ?? []) as unknown[] }));
    const opened = writes.filter(w => /INSERT INTO call_log/.test(w.sql));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.params).toContain(STRANGER);
    // Closed as MISSED — `missed = 1` is the column CallLogRow reads first to
    // draw "Missed audio", ahead of the reason. And the reason is 'decline',
    // not 'blocked': the device declined under a policy its owner set, and
    // the row a person reads must not accuse them of blocking someone.
    // `endCallLog`'s UPDATE specifically — startup sweeps a stale 'active' row
    // to 'failed_media' with no parameters at all, and that is not this call.
    const closed = writes.filter(w => /UPDATE call_log/.test(w.sql) && /missed = \?/.test(w.sql));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.sql).toMatch(/missed = \?/);
    expect(closed[0]!.params[0]).toBe('decline');
    expect(closed[0]!.params[4]).toBe(1);
    expect(closed[0]!.params[5]).toBe(OFFER_CID);
    expect(callEvents).toBeDefined();
  });
});
