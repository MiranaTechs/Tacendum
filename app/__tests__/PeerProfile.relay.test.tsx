import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import * as native from 'tacendum-call';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';

/**
 * THE PER-PERSON RELAY CONTROL.
 *
 * `call_relay_prefs`, `getPeerRelayPref`, `setPeerRelayPref` and
 * `relayForPeer` all shipped, all tested, all correct — and NO SCREEN WROTE
 * THE VALUE. `remembered` was therefore permanently null in production while
 * the published terms and privacy policy said a relay choice is "remembered
 * per person" and that the app "follows whatever was chosen for that person".
 * Every unit test passed. The claim was false for every user.
 *
 * So this file refuses to stop at the screen. It drives the real chips, the
 * real SQL, the real `startCalling()` singleton and the real policy, and its
 * central assertion is the same one `call.relay.test.ts` makes: the `relayOnly`
 * argument `configure` hands the native module, which becomes
 * `RTCConfiguration.iceTransportPolicy` and therefore decides whether this
 * phone ever offers a host candidate. A test that asserted a chip is
 * highlighted would pass against the exact defect that shipped.
 *
 * FALSIFIERS, each run at authoring time, each restored, each recorded with
 * what actually went red:
 *  - have `choose` set React state and NOT call `db.setPeerRelayPref` — THE
 *    SHIPPED DEFECT, restored exactly: 7 of 10 fail, including both
 *    directions of the "reaches configure" case, while every chip still moves
 *    under the finger.
 *  - collapse null to false in `choose` (`next ?? false`) — the two-state
 *    switch this control was designed not to be: 2 fail, and the one that
 *    matters is "Default restores the first-call default", where a stranger's
 *    first call then goes DIRECT and hands over the address.
 *  - delete the `globalRelay` branch from the status line: 1 fails — the
 *    app-wide switch on, and the row still describing the per-peer choice as
 *    though it decided anything.
 *  - delete the `getPeerRelayPref` read from the load effect: 1 fails —
 *    re-opening the profile shows "Default" over a stored choice, which is
 *    also the state in which the next tap silently rewrites it.
 *  - drop the `explain` block from the section: 1 fails, the disclosure.
 */

/** REAL 26-character Crockford ULIDs — the shipped zod schemas validate ids. */
const PEER = '01HQ57RANGER0000000000000A';
const SELF = '01HQ5E1F00000000000000000A';
const CID_A = '01HQ0000000000000000000AAA';
const CID_B = '01HQ0000000000000000000BBB';

jest.mock('../src/api', () => {
  const actual = jest.requireActual('../src/api');
  return {
    ...actual,
    apiDeletePushToken: jest.fn(async () => undefined),
    apiRegisterPushToken: jest.fn(async () => undefined),
    apiTurnCredentials: jest.fn(async () => ({
      iceServers: [
        { urls: ['stun:turn.tacendum.com:3478'] },
        {
          urls: ['turn:turn.tacendum.com:3478?transport=udp'],
          username: 'u',
          credential: 'c',
        },
      ],
      ttlSeconds: 12 * 3600,
    })),
  };
});

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

const ME: db.ProfileRow = {
  userId: SELF,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

/**
 * A tiny honest SQLite for the two tables this decision reads — the
 * `call.relay.test.ts` harness. Stateful on purpose: the whole feature is a
 * memory, and a stub answering SELECTs from a fixture could not tell a value
 * that was WRITTEN by the screen from one that was hard-coded here. Every
 * write goes through the real `setPeerRelayPref` SQL and every read through
 * the real `getPeerRelayPref` SQL; this only plays the file.
 */
const stored = {
  /** peerId → 0/1, the `call_relay_prefs` rows. */
  prefs: new Map<string, number>(),
  /** peers with a CONNECTED call in `call_log`. */
  connected: new Set<string>(),
};

const CHAT = {
  peerId: PEER,
  displayName: 'Ana',
  localName: null,
  lastMessageAt: 1,
  lastMessageText: 'hello',
  about: null,
  avatarB64: null,
  profileVersion: null,
  safetyCheckedAt: null,
  createdAt: 1,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
};

function installTables(): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    const text = String(sql);
    const args = (params ?? []) as unknown[];
    if (/SELECT relay FROM call_relay_prefs/.test(text)) {
      const value = stored.prefs.get(String(args[0]));
      return { rows: value === undefined ? [] : [{ relay: value }] };
    }
    if (/INSERT INTO call_relay_prefs/.test(text)) {
      stored.prefs.set(String(args[0]), Number(args[1]));
      return { rows: [] };
    }
    if (/DELETE FROM call_relay_prefs/.test(text)) {
      stored.prefs.delete(String(args[0]));
      return { rows: [] };
    }
    if (/FROM call_log[\s\S]*connectedAt IS NOT NULL/.test(text)) {
      return { rows: stored.connected.has(String(args[0])) ? [{ present: 1 }] : [] };
    }
    if (/FROM blocked_peers/.test(text)) return { rows: [] };
    if (/FROM chats WHERE peerId/.test(text)) {
      return { rows: String(args[0]) === PEER ? [CHAT] : [] };
    }
    return base(sql, params);
  });
}

/** Every write this feature made, reads excluded — so a DELETE can be told
 * from an INSERT of 0, which is the distinction the whole control turns on. */
function relayWrites(): { sql: string; params: unknown[] }[] {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  return instance.execute.mock.calls
    .map(c => ({ sql: String(c[0]).trim(), params: (c[1] ?? []) as unknown[] }))
    .filter(w => /call_relay_prefs/.test(w.sql) && /^(INSERT|DELETE)/.test(w.sql));
}

/** The policy the module is holding right now — what the NEXT peer connection
 * will be built with. */
function policyNow(): { relay: boolean; servers: number } | undefined {
  return (native.configure as jest.Mock).mock.calls
    .map(c => ({ relay: c[1] as boolean, servers: (c[0] as unknown[]).length }))
    .at(-1);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let teardown: (() => void) | undefined;

beforeEach(async () => {
  stored.prefs.clear();
  stored.connected.clear();
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
  jest.spyOn(messaging, 'onEnvelope').mockImplementation(() => () => {});
  teardown = await calling.startCalling();
  calling.setSelfAccountId(SELF);
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={() => {}} />,
    );
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

function sectionText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findByProps({ testID: 'peer-relay' })
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat()
    .join(' ');
}

describe('the three states reach the database', () => {
  it('stores “Always relay” as a memory of true', async () => {
    const tree = await mount();
    await press(tree, 'peer-relay-always');

    expect(relayWrites()).toEqual([
      expect.objectContaining({ params: expect.arrayContaining([PEER, 1]) }),
    ]);
    await expect(db.getPeerRelayPref(PEER)).resolves.toBe(true);
  });

  it('stores “Allow direct” as a memory of false', async () => {
    const tree = await mount();
    await press(tree, 'peer-relay-direct');

    expect(relayWrites()).toEqual([
      expect.objectContaining({ params: expect.arrayContaining([PEER, 0]) }),
    ]);
    await expect(db.getPeerRelayPref(PEER)).resolves.toBe(false);
  });

  it('“Default” DELETES the row — it does not write false', async () => {
    // THE LOAD-BEARING CASE, and the reason this control has three chips
    // rather than a switch. A two-state control has nowhere to put "nothing
    // chosen", so it writes the falsy one; that row then beats the first-call
    // default forever, and a stranger's first call goes direct.
    const tree = await mount();
    await press(tree, 'peer-relay-always');
    await press(tree, 'peer-relay-default');

    const writes = relayWrites();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.sql).toMatch(/^DELETE FROM call_relay_prefs/);
    // Not merely "a DELETE was issued": no write in the whole sequence stored
    // a zero, which is what collapsing null to false would have produced.
    expect(writes.some(w => /^INSERT/.test(w.sql) && w.params[1] === 0)).toBe(false);
    await expect(db.getPeerRelayPref(PEER)).resolves.toBeNull();
  });
});

describe('what the stored choice does to an actual call', () => {
  it('“Always relay” beats a history of connected calls', async () => {
    // Without the memory the default would send this direct: they have
    // connected before, so the address is already out.
    stored.connected.add(PEER);
    const tree = await mount();
    await press(tree, 'peer-relay-always');

    await calling.callController().placeCall(PEER, CID_A, false);

    expect(policyNow()).toEqual({ relay: true, servers: 2 });
  });

  it('“Allow direct” beats the first-call default', async () => {
    // The other direction, and the one a person reaches for deliberately:
    // this peer has never been called, so the default would relay.
    const tree = await mount();
    await press(tree, 'peer-relay-direct');

    await calling.callController().placeCall(PEER, CID_A, false);

    expect(policyNow()).toEqual({ relay: false, servers: 2 });
  });

  it('“Default” restores the first-call default rather than freezing it', async () => {
    // The end-to-end proof that null is not false. Choose direct, change your
    // mind back to the default, and the very next call to a peer you have
    // never connected with is RELAYED again.
    const tree = await mount();
    await press(tree, 'peer-relay-direct');
    await press(tree, 'peer-relay-default');

    await calling.callController().placeCall(PEER, CID_A, false);

    expect(policyNow()!.relay).toBe(true);
  });

  it('the app-wide switch overrides a per-peer “Allow direct”, and the row says so', async () => {
    // `relayForPeer` returns true on `global` BEFORE it consults the memory:
    // the switch is a demand, not a default. A control that kept claiming to
    // decide would be the same lie in a smaller box.
    const tree = await mount();
    await press(tree, 'peer-relay-direct');
    await calling.setAlwaysRelay(true);

    await calling.callController().placeCall(PEER, CID_A, false);
    expect(policyNow()!.relay).toBe(true);

    // Re-opened with the switch on, the section states the truth rather than
    // its own chip's meaning.
    const reopened = await mount();
    expect(
      reopened.root.findByProps({ testID: 'peer-relay-status' }).props.children,
    ).toMatch(/Relay every call” is on in Settings/);
    // And the memory is untouched: turning the switch off must restore it.
    await expect(db.getPeerRelayPref(PEER)).resolves.toBe(false);
    await calling.setAlwaysRelay(false);
    await calling.callController().hangup();
    await flush();
    await calling.callController().placeCall(PEER, CID_B, false);
    expect(policyNow()!.relay).toBe(false);
  });
});

describe('the control reflects what is stored', () => {
  it('shows the stored choice when the profile is opened again', async () => {
    const first = await mount();
    await press(first, 'peer-relay-always');
    await ReactTestRenderer.act(async () => {
      first.unmount();
    });

    const second = await mount();
    expect(selected(second, 'peer-relay-always')).toBe(true);
    expect(selected(second, 'peer-relay-default')).toBe(false);
    expect(selected(second, 'peer-relay-direct')).toBe(false);
  });

  it('starts on Default when nothing has ever been chosen', async () => {
    const tree = await mount();
    expect(selected(tree, 'peer-relay-default')).toBe(true);
    expect(selected(tree, 'peer-relay-always')).toBe(false);
    expect(selected(tree, 'peer-relay-direct')).toBe(false);
  });

  it('states both costs and the default’s behaviour before anything is tapped', async () => {
    // Each of these is a claim the Privacy Policy also makes; a control that
    // moved an address-disclosure setting without naming the cost would be
    // asking for consent to something unstated.
    const text = sectionText(await mount());

    expect(text).toMatch(/IP address/);
    expect(text).toMatch(/roughly, where you are/);
    expect(text).toMatch(/slower to connect/);
    expect(text).toMatch(/how much you send/);
    expect(text).toMatch(/hear none of it/);
    expect(text).toMatch(/relay holds no key/);
    // The default, said in full: relayed until one call connects, direct after.
    expect(text).toMatch(/relays until one call with Ana has connected/);
    // And that this is local — a per-person control that read as a shared
    // setting would be a claim about the other phone.
    expect(text).toMatch(/never told what this says/);
  });
});
