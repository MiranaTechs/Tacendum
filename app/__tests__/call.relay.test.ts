import * as native from 'tacendum-call';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';

/**
 * ALWAYS-RELAY, WIRED.
 *
 * `relayForPeer` in `call/policy.ts` was written, documented and unit-tested,
 * and had ZERO runtime call sites: nothing consulted it when a call was placed
 * and nothing consulted it when one was answered. `setAlwaysRelay` was called
 * from no screen. Four published pages — terms, privacy, security and the home
 * page — promised in the product's own voice that "the first call with someone
 * new is relayed by default, then remembered per person", plus an app-wide
 * switch. Every unit test passed. A first call to a stranger went direct and
 * handed over the caller's IP address.
 *
 * So this file is deliberately NOT a controller harness with an injected
 * decision. It drives `startCalling()` — the real singleton, the real SQL, the
 * real policy function — and asserts on the ONE argument that decides the
 * matter: the `relayOnly` flag `configure` hands the native module, which
 * becomes `RTCConfiguration.iceTransportPolicy` and therefore whether a host
 * candidate is ever offered. A harness that builds its own controller can pass
 * every case here while nothing is connected, which is exactly what happened.
 *
 * FALSIFIERS, each run at authoring time, each restored, each recorded with
 * what actually went red:
 *  - rename the `relayForPeer` dep in `call/index.ts` so nothing consults the
 *    policy — THE ORIGINAL DEFECT, restored exactly: 6 of 19 fail, including
 *    both first-call cases and both answering cases.
 *  - delete `decideRelayFor` from `placeCall`: 4 fail — every outbound case
 *    whose verdict is not simply the app-wide switch.
 *  - delete `decideRelayFor` from `onEnvelope`: 1 fails — "relays a first call
 *    from someone who has never had this address". Nothing else moves, which
 *    is the point: the outbound half can be perfect while the answering half
 *    hands out the address.
 *  - delete `pushRelayPolicy` from `placeCall`: 1 fails — the remembered
 *    choice in the SECOND call of a session, the only case here where the
 *    credential is already cached and `configure` is therefore not reached by
 *    a refresh. That single case is the whole reason the push exists: in
 *    production the credential is cached for twelve hours.
 *  - drop `&& this.credentials !== null` from `effectiveRelayOnly`: 1 fails —
 *    the no-relay case, i.e. a first call configured `.relay` with no relay to
 *    use, which gathers no candidates and can never connect.
 *  - delete `decideRelayFor` from `rehydrate`: 1 fails — the lock-screen
 *    answer after a kill.
 */

/** REAL 26-character Crockford ULIDs: the shipped zod schemas validate every
 * id, and a placeholder would exercise the rejection path instead. */
const SELF = '01HQ5E1F00000000000000000A';
const STRANGER = '01HQ57RANGER0000000000000A';
const CID_A = '01HQ0000000000000000000AAA';
const CID_B = '01HQ0000000000000000000BBB';
const OFFER_CID = '01HQ0FFERC1D00000000000000';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';
/** The small-group cast. FRIEND and FRIEND2 are people this phone has
 * CONNECTED with before; STARTER invites; LATE arrives mid-call. */
const FRIEND = '01HQFR1END0000000000000000';
const FRIEND2 = '01HQFR1END2000000000000000';
const STARTER = '01HQ5TARTER00000000000000A';
const LATE = '01HQ1ATEJ0NER00000000000AA';
const SID_A = '01HQ5E5510N000000000000000';
const GINV_CID = '01HQ0000000000000000000CCC';

/** `mock`-prefixed so the hoisted factory below may see it (jest's rule). */
const mockTurn = { fails: false };

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => {
    if (mockTurn.fails) throw new Error('no relay configured');
    return {
      iceServers: [
        { urls: ['stun:turn.tacendum.com:3478'] },
        {
          urls: ['turn:turn.tacendum.com:3478?transport=udp'],
          username: 'u',
          credential: 'c',
        },
      ],
      ttlSeconds: 12 * 3600,
    };
  }),
}));

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, { execute: jest.Mock }>; reset: () => void };
  }
).__sqlite;

/**
 * A tiny honest SQLite for the two tables this decision reads.
 *
 * Stateful on purpose: the per-person memory has to survive a relaunch, and a
 * stub that answered a SELECT from a fixture could not tell a value that was
 * WRITTEN from one that was hard-coded. Every write below goes through the
 * real `db.setPeerRelayPref` SQL and every read through the real
 * `db.getPeerRelayPref` SQL; this only plays the file.
 */
const stored = {
  /** peerId → 0/1, the `call_relay_prefs` rows. */
  prefs: new Map<string, number>(),
  /** peers with a CONNECTED call in `call_log`. */
  connected: new Set<string>(),
  /** peers with a chat row carrying a message, so the phone may ring. */
  known: new Set<string>(),
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
    if (/FROM chats WHERE peerId/.test(text)) {
      return {
        rows: stored.known.has(String(args[0]))
          ? [{ peerId: args[0], displayName: 'Ana', localName: null, lastMessageAt: 1 }]
          : [],
      };
    }
    return base(sql, params);
  });
}

/** Every `configure` call, as (relayOnly, serverCount). */
function configured(): { relay: boolean; servers: number }[] {
  return (native.configure as jest.Mock).mock.calls.map(c => ({
    relay: c[1] as boolean,
    servers: (c[0] as unknown[]).length,
  }));
}

/** The policy the module is holding right now — what the NEXT peer connection
 * will be built with. */
function policyNow(): { relay: boolean; servers: number } | undefined {
  return configured().at(-1);
}

/**
 * WHETHER THE LEG ON `cid` WAS BUILT UNDER `.relay`.
 *
 * `policyNow` answers about the module; this answers about ONE PEER
 * CONNECTION, which is the only thing that can disclose an address. The native
 * module stores what `configure` last said (`TacendumCallImpl.swift`:
 * `configuration`) and reads it in `makeCall`, when `createOffer` or
 * `createAnswer` builds the connection — so the policy in force for a leg is
 * the last `configure` before that leg's negotiation call, and nothing after
 * it can change what that connection already gathered.
 *
 * A session is N legs to N people, so the session-wide `policyNow` cannot
 * distinguish "everyone was relayed" from "the last leg was". This can.
 */
function legPolicy(cid: string): boolean | undefined {
  const startedAt = (mock: jest.Mock): number | undefined => {
    const index = mock.mock.calls.findIndex(c => c[0] === cid);
    return index < 0 ? undefined : mock.mock.invocationCallOrder[index];
  };
  const builtAt =
    startedAt(native.createOffer as jest.Mock) ?? startedAt(native.createAnswer as jest.Mock);
  if (builtAt === undefined) return undefined;
  const cfg = native.configure as jest.Mock;
  let relay: boolean | undefined;
  cfg.mock.invocationCallOrder.forEach((order, i) => {
    if (order < builtAt) relay = cfg.mock.calls[i]![1] as boolean;
  });
  return relay;
}

/** Every cid this device dialled, in order. */
function dialled(): string[] {
  return (native.createOffer as jest.Mock).mock.calls.map(c => c[0] as string);
}

const callEvents = (
  native as unknown as { __call: { emit: (n: string, p: unknown) => void } }
).__call;

/**
 * A FIXED TICK BUDGET, WITH THE MEASUREMENT WRITTEN DOWN — it was 40, which
 * was exactly what the cold-launch answer below needed and not one tick more,
 * so the first honest thing the sqlite mock did (modelling `sqlite3_interrupt`,
 * which costs a parked statement two microtask hops) turned a green suite red
 * for a reason that had nothing to do with relaying. Re-measured this round
 * with the door's handle gate in place: the lock-screen case still settles at
 * exactly 42, so the gate itself costs nothing — it hands back the driver's own
 * promise. Anything below 42 fails; the rest is deliberate slack, and shrinking
 * it back buys nothing.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

let teardown: (() => void) | undefined;
/** The controller's own envelope listener, captured from the subscription it
 * makes inside `startCalling()` — so an offer arrives by the same route a
 * decrypted one does. */
type EnvelopeListener = Parameters<typeof messaging.onEnvelope>[0];
let listener: EnvelopeListener | null = null;

function deliver(
  peerId: string,
  envelope: Parameters<EnvelopeListener>[1],
  ts = Date.now(),
): void {
  listener?.(peerId, envelope, { msgId: '01HQMSG0000000000000000001', ts });
}

beforeEach(async () => {
  mockTurn.fails = false;
  stored.prefs.clear();
  stored.connected.clear();
  stored.known.clear();
  calling.resetCallingForTests();
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installTables();
  await setSecret(AUTH_TOKEN_KEY, 'auth-token');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'sendGroupCallEnvelope').mockResolvedValue(undefined);
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
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

/** An inbound offer that is inside every window the reducer checks. */
function offer(cid = OFFER_CID) {
  return {
    tcm: 'call.offer' as const,
    cid,
    sdp: SDP,
    vid: false,
    exp: Date.now() + 45_000,
  };
}

describe('placing a call', () => {
  it('relays the FIRST call with someone new — the promise on four pages', async () => {
    // THE DEFECT, stated as a test. `relayForPeer` existed and said this;
    // nothing asked it, so this call went direct and handed a stranger the
    // caller's home IP address.
    await calling.callController().placeCall(STRANGER, CID_A, false);

    expect(policyNow()).toEqual({ relay: true, servers: 2 });
    // And it was decided BEFORE the offer was built: after `createOffer` the
    // candidates are already being gathered and the policy cannot be changed.
    const configureAt = (native.configure as jest.Mock).mock.invocationCallOrder[0]!;
    const offerAt = (native.createOffer as jest.Mock).mock.invocationCallOrder[0]!;
    expect(configureAt).toBeLessThan(offerAt);
  });

  it('goes direct on the SECOND call to the same person', async () => {
    // The other half of the default, and the reason it is a default rather
    // than a policy: paying a relay hop forever for someone you speak to
    // daily buys nothing — they already have your address.
    stored.connected.add(STRANGER);

    await calling.callController().placeCall(STRANGER, CID_A, false);

    expect(policyNow()).toEqual({ relay: false, servers: 2 });
  });

  it('relays every call when the app-wide switch is on, whatever the history', async () => {
    stored.connected.add(STRANGER);
    await calling.setAlwaysRelay(true);

    await calling.callController().placeCall(STRANGER, CID_A, false);

    expect(policyNow()!.relay).toBe(true);
  });

  it('takes effect on the NEXT call, not the next launch', async () => {
    // `relayOnly: () => alwaysRelay` is read per call rather than captured,
    // and `pushRelayPolicy` is what makes that reach the native module: the
    // credential is cached for hours, so without it the switch would change
    // nothing until the next refresh. Someone who turns this on because of
    // who they are about to call must not have to relaunch the app.
    stored.connected.add(STRANGER);
    await calling.callController().placeCall(STRANGER, CID_A, false);
    expect(policyNow()!.relay).toBe(false);
    await calling.callController().hangup();
    await flush();

    await calling.setAlwaysRelay(true);
    await calling.callController().placeCall(STRANGER, CID_B, false);

    expect(policyNow()!.relay).toBe(true);
    // Not vacuous: the hangup really did reach idle and the SECOND call
    // really was placed, rather than the reducer quietly refusing it while
    // this asserted on the first call's policy.
    expect((native.createOffer as jest.Mock).mock.calls.map(c => c[0])).toEqual([
      CID_A,
      CID_B,
    ]);
  });

  it('lets a remembered choice beat the first-call default, in both directions', async () => {
    // "then remembered per person". A person who said "never relay this one"
    // is not overridden by the default on their first call…
    await db.setPeerRelayPref(STRANGER, false);
    await calling.callController().placeCall(STRANGER, CID_A, false);
    expect(policyNow()!.relay).toBe(false);

    // …and one who said "always relay this one" is not overridden by history.
    await calling.callController().hangup();
    await flush();
    stored.connected.add(STRANGER);
    await db.setPeerRelayPref(STRANGER, true);
    await calling.callController().placeCall(STRANGER, CID_B, false);
    expect(policyNow()!.relay).toBe(true);
  });

  it('keeps the remembered choice across a relaunch', async () => {
    // The whole point of a memory. Written through the real INSERT, read back
    // through the real SELECT, across a module reset and a reopened database
    // — the closest this harness gets to killing the process.
    await db.setPeerRelayPref(STRANGER, true);
    stored.connected.add(STRANGER);

    teardown?.();
    calling.resetCallingForTests();
    await db.close();
    await db.initDb();
    teardown = await calling.startCalling();

    await calling.callController().placeCall(STRANGER, CID_A, false);
    expect(policyNow()!.relay).toBe(true);
  });

  it('forgetting a choice restores the default rather than freezing it', async () => {
    await db.setPeerRelayPref(STRANGER, false);
    await db.setPeerRelayPref(STRANGER, null);

    await calling.callController().placeCall(STRANGER, CID_A, false);

    expect(policyNow()!.relay).toBe(true);
  });

  it('degrades to a direct call when there is no relay to route through', async () => {
    // `.relay` with an empty ICE server list gathers no candidates at all, so
    // honouring the default here would not protect an address — it would ring
    // a phone that can never connect. The published policy names this case:
    // with no relay configured the app places a direct call. The app-wide
    // switch keeps the harder answer (`placeCall` throws), which
    // `call.controller.test.ts` pins.
    mockTurn.fails = true;

    await calling.callController().placeCall(STRANGER, CID_A, false);

    expect(policyNow()).toEqual({ relay: false, servers: 0 });
  });
});

describe('answering a call', () => {
  it('relays a first call from someone who has never had this address', async () => {
    // BOTH DIRECTIONS DISCLOSE. An answer built with `.all` offers this
    // phone's host candidates to whoever called, so a rule enforced only on
    // the outbound side protects the caller from the callee and nobody from
    // anybody else.
    stored.known.add(STRANGER); // messaged before, never called: the phone rings

    deliver(STRANGER, offer());
    await calling.callController().whenIdle();

    expect(policyNow()!.relay).toBe(true);
    // Settled before the phone rang, because `createAnswer` runs whenever the
    // person taps — which can be forty-five seconds later.
    const configureAt = (native.configure as jest.Mock).mock.invocationCallOrder[0]!;
    const ringAt = (native.reportIncomingCall as jest.Mock).mock.invocationCallOrder[0]!;
    expect(configureAt).toBeLessThan(ringAt);
  });

  it('goes direct answering someone this phone has already connected with', async () => {
    stored.known.add(STRANGER);
    stored.connected.add(STRANGER);

    deliver(STRANGER, offer());
    await calling.callController().whenIdle();

    expect(policyNow()!.relay).toBe(false);
  });

  it('decides a LOCK-SCREEN answer after the app was killed', async () => {
    // The cold-launch path rebuilds the whole call from a stored offer —
    // offer to answer, inside `rehydrate`. A decision made only in
    // `onEnvelope` would be missing from every answer given after a kill,
    // which is a large share of the answers a phone actually gives.
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
      if (/FROM call_offers\s+WHERE cid = \?/.test(String(sql))) {
        return {
          rows: [
            {
              cid: OFFER_CID,
              peerId: STRANGER,
              sdp: SDP,
              video: 0,
              exp: Date.now() + 45_000,
              serverTs: Date.now(),
              sid: null,
            },
          ],
        };
      }
      return base(sql, params);
    });

    callEvents.emit('callKitAnswer', { cid: OFFER_CID });
    await flush();

    expect(native.createAnswer).toHaveBeenCalledWith(OFFER_CID, SDP, false);
    const configureAt = (native.configure as jest.Mock).mock.invocationCallOrder[0]!;
    const answerAt = (native.createAnswer as jest.Mock).mock.invocationCallOrder[0]!;
    expect(configureAt).toBeLessThan(answerAt);
    expect(policyNow()!.relay).toBe(true);
  });
});

describe('the app-wide switch', () => {
  it('persists to the Keychain, not to memory', async () => {
    await calling.setAlwaysRelay(true);
    expect(calling.alwaysRelayEnabled()).toBe(true);

    // A relaunch: the in-memory value is dropped and re-read from storage.
    calling.resetCallingForTests();
    expect(calling.alwaysRelayEnabled()).toBe(false);
    await calling.loadAlwaysRelay();

    expect(calling.alwaysRelayEnabled()).toBe(true);
  });

  it('stores it OUTSIDE the message database', async () => {
    // Like read receipts and push consent: it must survive a workspace wipe
    // and must not sit in the decoy file where a duress session could read or
    // change it. The per-PEER memory goes the other way, deliberately — it
    // names people, so it belongs inside the workspace that gets wiped.
    await calling.setAlwaysRelay(true);
    const writes = (sqlite.instances.get('tacendum.sqlite')?.execute.mock.calls ?? [])
      .map(c => String(c[0]))
      .join('\n');
    expect(writes).not.toMatch(/alwaysRelay/i);
    const keychain = (
      jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
    ).__keychain;
    expect(keychain.get('tacendum.alwaysRelay')).toBe('1');
  });

  it('reaches the native module immediately, not at the next credential refresh', async () => {
    // A privacy control that appears to work and does nothing is the worst
    // kind. The credential is cached for hours, so without an immediate
    // apply the switch would be on and host candidates would keep being
    // offered until it lapsed.
    await calling.callController().ensureCredentials();
    (native.configure as jest.Mock).mockClear();

    await calling.setAlwaysRelay(true);
    await flush();

    expect(policyNow()!.relay).toBe(true);
  });

  it('shows the DEFAULT under duress, never the owner’s choice', async () => {
    await calling.setAlwaysRelay(true);
    calling.resetAlwaysRelayForDuress();
    expect(calling.alwaysRelayEnabled()).toBe(false);
    // And the real value is untouched on disk — a duress session cannot
    // erase a preference by being opened.
    await calling.loadAlwaysRelay();
    expect(calling.alwaysRelayEnabled()).toBe(true);
  });
});

describe('what counts as having called someone before', () => {
  it('is a CONNECTED call, never a row', async () => {
    // The attack this closes: a call_log row is opened for every attempt,
    // including one a stranger causes by ringing a phone that never answers.
    // If existence counted, an unknown caller could flip the next call to
    // direct — turning the protection off from the outside.
    await db.hasConnectedCallWith(STRANGER);
    const sql = (sqlite.instances.get('tacendum.sqlite')?.execute.mock.calls ?? [])
      .map(c => String(c[0]))
      .find(s => /FROM call_log/.test(s) && /LIMIT 1/.test(s))!;
    expect(sql).toMatch(/connectedAt IS NOT NULL/);
  });

  it('answers false for a peer with no connected call, true for one with', async () => {
    await expect(db.hasConnectedCallWith(STRANGER)).resolves.toBe(false);
    stored.connected.add(STRANGER);
    await expect(db.hasConnectedCallWith(STRANGER)).resolves.toBe(true);
  });

  it('remembers nothing until a choice is made about a person', async () => {
    // null is not false: absent memory is what makes the first-call default
    // reachable, and collapsing the two would freeze every peer to whichever
    // value the column defaulted to.
    await expect(db.getPeerRelayPref(STRANGER)).resolves.toBeNull();
    await db.setPeerRelayPref(STRANGER, false);
    await expect(db.getPeerRelayPref(STRANGER)).resolves.toBe(false);
  });

  it('keeps the per-person memory out of a decoy workspace', () => {
    // A table outside DB_TABLES survives sign-out and is inherited by the
    // decoy — here that is a list of who this phone has called, handed to a
    // coerced unlock.
    expect(db.DB_TABLES).toContain('call_relay_prefs');
  });
});

/**
 * SMALL-GROUP CALLS.
 *
 * THE DEFECT THIS BLOCK EXISTS AGAINST, stated plainly: `group.ts` owned no
 * `configure` of its own. It called `ensureCredentials()` and inherited
 * whatever ICE policy the module was last given, with `relayForThisCall` reset
 * to `false` at idle — so the APP-WIDE SWITCH reached a session (it is read on
 * every `configure`) while the FIRST-CALL DEFAULT and the PER-PERSON MEMORY
 * did not. A first small-group call with someone this phone had never called
 * went direct and handed them a home IP address, which is the one thing the
 * published sentence promises cannot happen. Every 1:1 case above passed
 * throughout.
 *
 * ONE KNOB, N LEGS. `configure` sets one `RTCConfiguration` for the whole
 * native module (`TacendumCallImpl.swift:241`, read by `makeCall` when a peer
 * connection is built); there is no per-connection seam. So a session's policy
 * is the OR over its participants — any peer who warrants a relay relays the
 * whole session — and it only ever ratchets up while the session lives. These
 * tests assert per LEG (`legPolicy`) rather than on the module, because "the
 * session ended up relayed" is not the same claim as "every connection in it
 * was built relayed".
 *
 * FALSIFIERS, each run at authoring time, each restored, each recorded with
 * what actually went red (of the 16 cases in this block):
 *  - remove `applyRelayPolicy`/`releaseRelayPolicy` from `call/index.ts`'s
 *    coordinator deps — THE SHIPPED DEFECT, restored exactly: 9 fail. The
 *    survivors are the cases whose answer is direct anyway, the app-wide
 *    switch (which reached sessions before any of this existed), and the two
 *    guard tests — which is the shape of the defect: everything that was
 *    already true stayed true while the first-call default and the per-person
 *    memory silently did not apply.
 *  - delete `applyRelayPolicy` from `startGroupCall`: 3 fail, and precisely
 *    the ones that assert on EVERY leg. The dial-site ratchet still saves the
 *    stranger's own leg; the leg dialled ahead of theirs is built direct,
 *    which is what the whole-roster question at the start exists to prevent.
 *  - delete `applyRelayPolicy` from `handleInvite`: 2 fail — both answering
 *    cases, and nothing else moves. The starting half can be perfect while
 *    the receiving half hands out the address.
 *  - delete `applyRelayPolicy` from `openLegDial`: 1 fails — the mid-call
 *    join, the only case whose peer was not known when the session began.
 *  - delete `applyRelayPolicy` from `restoreLocked`: 1 fails — the
 *    lock-screen answer to a session after a kill.
 *  - delete `releaseRelayPolicy` from `step`'s `ended` branch: 2 fail — both
 *    leak cases, into the next 1:1 call and into the next session.
 *  - delete `releaseRelayPolicy` from `dispose()`: 1 fails — the demolition
 *    case, which no reducer ever sees.
 *  - make the verdict an ASSIGNMENT rather than a ratchet in
 *    `relayForSession` (drop the `if (this.relayForThisSession) break`):
 *    4 fail — all three OR cases and the monotonicity one.
 *  - pass `others` to `applyRelayPolicy` unfiltered, so this device's own id
 *    is asked about: 1 fails, and it is the only thing that could ever catch
 *    it — every other case would go green while relaying everything.
 */
describe('a small-group call', () => {
  /** A session's inputs run on the coordinator's queue and its legs run on
   * their own services; both have to drain before a policy is settled. */
  async function settle(): Promise<void> {
    await calling.callController().whenIdle();
    await calling.groupCall().whenIdle();
    await flush();
  }

  /**
   * A `call.g*` frame, delivered by the same route a decrypted one takes.
   *
   * Cast because `messaging.onEnvelope`'s listener is typed to the 1:1
   * envelope union; the session kinds ride that same channel and the
   * coordinator re-parses the body itself, which is exactly the seam these
   * tests need to exercise rather than bypass.
   */
  function deliverGroup(peerId: string, envelope: object): void {
    deliver(peerId, envelope as Parameters<typeof deliver>[1]);
  }

  /** An inbound session invite, inside every window the reducer checks. */
  function ginvite(roster: string[], cid = GINV_CID, sid = SID_A) {
    return {
      tcm: 'call.ginvite' as const,
      sid,
      cid,
      r: roster,
      sdp: SDP,
      vid: false,
      exp: Date.now() + 45_000,
    };
  }

  describe('starting one', () => {
    it('relays EVERY leg when any one participant is new to this phone', async () => {
      // THE DEFECT, stated as a test: this session went direct, on both legs,
      // and STRANGER — who has never had this address — was handed it.
      //
      // And the answer is the whole session, not the one leg that needed it,
      // because there is one knob for N connections. FRIEND pays a relay hop
      // they did not need; STRANGER does not learn where this phone is. That
      // is the trade, and it is the safe direction: it discloses nothing to
      // anyone.
      stored.connected.add(FRIEND);

      await calling.groupCall().startGroupCall([FRIEND, STRANGER], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      for (const cid of legs) expect(legPolicy(cid)).toBe(true);
      // Settled BEFORE the first leg existed: after `createOffer` the
      // candidates are already being gathered and no `configure` can help.
      const configureAt = (native.configure as jest.Mock).mock.invocationCallOrder[0]!;
      const offerAt = (native.createOffer as jest.Mock).mock.invocationCallOrder[0]!;
      expect(configureAt).toBeLessThan(offerAt);
    });

    it('goes direct when every participant has connected with this phone before', async () => {
      // The other half of the default, and the proof that the rule above is a
      // DECISION rather than "sessions are always relayed": a room of people
      // who already have your address buys nothing by paying for a hop.
      stored.connected.add(FRIEND);
      stored.connected.add(FRIEND2);

      await calling.groupCall().startGroupCall([FRIEND, FRIEND2], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      for (const cid of legs) expect(legPolicy(cid)).toBe(false);
    });

    it('lets ONE remembered "always relay" carry the whole session', async () => {
      // "then remembered per person" — and a session is N people, so the
      // person who asked for it must get it even though nobody else did. This
      // is the OR at its narrowest: one `true` among peers who would all
      // otherwise be direct.
      stored.connected.add(FRIEND);
      stored.connected.add(FRIEND2);
      await db.setPeerRelayPref(FRIEND2, true);

      await calling.groupCall().startGroupCall([FRIEND, FRIEND2], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      for (const cid of legs) expect(legPolicy(cid)).toBe(true);
    });

    it('does not let one participant’s "never relay" weaken a stranger’s leg', async () => {
      // The OR, from the other side. A verdict that simply took the LAST
      // peer's answer — or the first — would pass the test above and fail
      // this one, and the failure would be the disclosure: FRIEND's stored
      // preference is about FRIEND, and it has nothing to say about a person
      // who has never had this address.
      stored.connected.add(FRIEND);
      await db.setPeerRelayPref(FRIEND, false);

      await calling.groupCall().startGroupCall([FRIEND, STRANGER], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      for (const cid of legs) expect(legPolicy(cid)).toBe(true);
    });

    it('relays the session when the app-wide switch is on, whatever the history', async () => {
      // The switch is a DEMAND and it wins everywhere. It reached sessions
      // even before this wiring existed — `configure` reads it on every
      // credential refresh — so this is the case that must NOT have moved.
      stored.connected.add(FRIEND);
      stored.connected.add(FRIEND2);
      await calling.setAlwaysRelay(true);

      await calling.groupCall().startGroupCall([FRIEND, FRIEND2], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      for (const cid of legs) expect(legPolicy(cid)).toBe(true);
    });

    it('never asks the policy about this device itself', async () => {
      // A trap with one symptom and no error message: "have I called myself
      // before?" is always no, so a roster that included self would answer
      // `true` for every session ever started and the default would look like
      // it worked. FRIEND has connected before and is the only other party, so
      // the honest answer is direct — and only a run that filtered self can
      // give it.
      stored.connected.add(FRIEND);

      await calling.groupCall().startGroupCall([FRIEND, SELF], false);
      await settle();

      expect(dialled()).toHaveLength(1);
      expect(legPolicy(dialled()[0]!)).toBe(false);
    });
  });

  describe('answering one', () => {
    it('relays when the person inviting has never had this address', async () => {
      // BOTH DIRECTIONS DISCLOSE, in a session exactly as in a 1:1 call. The
      // invite is answered with `createAnswer` and, the moment the human
      // answers, every lower-index incumbent is dialled — so a rule enforced
      // only when this device STARTS a session protects nobody on the side
      // that receives one.
      stored.known.add(STARTER); // messaged before, so the phone may ring

      deliverGroup(STARTER, ginvite([STARTER, SELF]));
      await settle();

      expect(policyNow()!.relay).toBe(true);
      // Settled before the phone rang, because the human may tap forty-five
      // seconds later and `createAnswer` runs when they do.
      const configureAt = (native.configure as jest.Mock).mock.invocationCallOrder[0]!;
      const ringAt = (native.reportIncomingCall as jest.Mock).mock.invocationCallOrder[0]!;
      expect(configureAt).toBeLessThan(ringAt);
    });

    it('goes direct answering a session whose every member has connected before', async () => {
      stored.known.add(STARTER);
      stored.connected.add(STARTER);
      stored.connected.add(FRIEND);

      deliverGroup(STARTER, ginvite([STARTER, SELF, FRIEND]));
      await settle();

      expect(native.reportIncomingCall).toHaveBeenCalled();
      expect(policyNow()!.relay).toBe(false);
    });

    it('relays when a stranger is merely NAMED in the roster', async () => {
      // The roster is payload and cannot be trusted — the ring gate refuses to
      // read it for exactly that reason. It is read HERE because the two rules
      // fail in opposite directions: a forged id can only add to the OR, and
      // adding to the OR can only produce MORE relaying. The forgery's only
      // reward is making this phone pay for a relay hop.
      stored.known.add(STARTER);
      stored.connected.add(STARTER);

      deliverGroup(STARTER, ginvite([STARTER, SELF, STRANGER]));
      await settle();

      expect(native.reportIncomingCall).toHaveBeenCalled();
      expect(policyNow()!.relay).toBe(true);
    });

    it('decides a LOCK-SCREEN answer to a SESSION after the app was killed', async () => {
      // The cold path rebuilds the whole session from SQLite — the ring, the
      // starter's offer, every held offer — and everything after it
      // (`createAnswer`, then the answer-time offers to lower-index incumbents) builds
      // media. A verdict decided only when a live invite decrypts would be
      // missing from every lock-screen answer a killed app gives, which is a
      // large share of the answers a phone gives at all. STARTER is new to
      // this phone, so the honest answer is relay.
      const instance = sqlite.instances.get('tacendum.sqlite')!;
      const base = instance.execute.getMockImplementation()!;
      instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
        const text = String(sql);
        if (/FROM call_sessions/.test(text)) {
          return {
            rows: [
              {
                sid: SID_A,
                roomId: null,
                starterId: STARTER,
                roster: JSON.stringify([STARTER, SELF]),
                se: 0,
                video: 0,
                startedAt: Date.now(),
              },
            ],
          };
        }
        if (/FROM call_offers\s+WHERE sid = \?/.test(text)) {
          return {
            rows: [
              {
                cid: GINV_CID,
                peerId: STARTER,
                sdp: SDP,
                video: 0,
                exp: Date.now() + 45_000,
                serverTs: Date.now(),
                sid: SID_A,
              },
            ],
          };
        }
        return base(sql, params);
      });

      callEvents.emit('callKitAnswer', { cid: SID_A });
      await settle();

      // Not vacuous: the session really was rebuilt and really was answered.
      expect(native.createAnswer).toHaveBeenCalledWith(GINV_CID, SDP, false);
      expect(legPolicy(GINV_CID)).toBe(true);
    });

    it('does not resurrect an invite the phone silenced', async () => {
      // The relay decision sits BELOW the `mayRing` gate, and it must stay
      // there: it reads rows and calls `configure`, so putting it above would
      // be harmless to the policy and fatal to the silence. A silenced invite
      // tells the inviter nothing — no ring, no decline, no `call.ringing` —
      // or the silence announces itself and becomes a way to probe for it.
      // STARTER is unknown here (no chat row) and silencing defaults ON.
      deliverGroup(STARTER, ginvite([STARTER, SELF]));
      await settle();

      expect(native.reportIncomingCall).not.toHaveBeenCalled();
      expect(messaging.sendGroupCallEnvelope).not.toHaveBeenCalled();
      expect(messaging.sendCallEnvelope).not.toHaveBeenCalled();
      expect(native.createAnswer).not.toHaveBeenCalled();
    });
  });

  describe('a session that grows', () => {
    it('relays the newcomer’s leg without rebuilding the incumbents’', async () => {
      // THE MID-CALL JOIN, and the reason it can be answered at all with a
      // process-wide knob: `configure` does not touch a live
      // `RTCPeerConnection` — the module stores the policy and `makeCall`
      // reads it when a connection is BUILT. So raising the session's answer
      // at the dial site relays the leg about to be built, while the
      // incumbents keep the policy theirs were built under. That is the right
      // split: FRIEND already has whatever address they were going to get, and
      // LATE never does.
      stored.connected.add(FRIEND);

      await calling.groupCall().startGroupCall([FRIEND], false);
      await settle();
      expect(dialled()).toHaveLength(1);
      expect(legPolicy(dialled()[0]!)).toBe(false);

      await calling.groupCall().addParticipant(LATE); // never called
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(2);
      expect(legPolicy(legs[1]!)).toBe(true);
      // The incumbent's connection was built once, under the old answer, and
      // nothing re-negotiated it — an assertion that would go red if the
      // ratchet were ever implemented by tearing legs down and re-dialling.
      expect(legPolicy(legs[0]!)).toBe(false);
    });

    it('does not lower the session’s answer when the person who raised it leaves', async () => {
      // MONOTONE. Recomputing the OR over the CURRENT roster would answer
      // `false` once STRANGER is gone, and the next connection built — a
      // re-offer, a second newcomer — would be direct under a session that had
      // already decided to protect. LATE arrives after STRANGER has left and
      // has connected before, so only a ratchet keeps their leg relayed.
      stored.connected.add(FRIEND);
      stored.connected.add(LATE);

      await calling.groupCall().startGroupCall([FRIEND, STRANGER], false);
      await settle();
      expect(policyNow()!.relay).toBe(true);

      deliverGroup(STRANGER, {
        tcm: 'call.gleave' as const,
        sid: (calling.groupCallView() as { sid: string }).sid,
        a: STRANGER,
      });
      await settle();

      await calling.groupCall().addParticipant(LATE);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(3);
      expect(legPolicy(legs[2]!)).toBe(true);
    });
  });

  describe('when the session is over', () => {
    it('does not leak its verdict into the NEXT call', async () => {
      // The property `relayForThisCall`'s idle reset gives the 1:1 path, owed
      // to the session path as well — and it cannot be got the same way,
      // because a session's end is invisible to the 1:1 machine: no state
      // change of that reducer's ever fires for it. Left standing, a stranger
      // on one group call would quietly relay every call afterwards.
      await calling.groupCall().startGroupCall([STRANGER], false);
      await settle();
      expect(policyNow()!.relay).toBe(true);

      await calling.groupCall().hangup();
      await settle();

      stored.connected.add(FRIEND);
      await calling.callController().placeCall(FRIEND, CID_A, false);

      expect(policyNow()!.relay).toBe(false);
      // Not vacuous: the session really ended and the 1:1 call really was
      // placed, rather than the coordinator refusing it as busy.
      expect(dialled().at(-1)).toBe(CID_A);
    });

    it('drops it when the session is DEMOLISHED rather than ended', async () => {
      // A relock, a sign-out, a workspace teardown: the reducer never runs, so
      // the ordinary end never happens and `step`'s release is never reached.
      // `disposeGroupCall()` is the seam the app actually uses, and it takes
      // the coordinator down without touching the controller — which is
      // exactly the object holding the verdict.
      await calling.groupCall().startGroupCall([STRANGER], false);
      await settle();
      expect(policyNow()!.relay).toBe(true);

      calling.disposeGroupCall();
      await settle();

      stored.connected.add(FRIEND);
      await calling.callController().placeCall(FRIEND, CID_A, false);

      expect(policyNow()!.relay).toBe(false);
      expect(dialled().at(-1)).toBe(CID_A);
    });

    it('does not leak it into the next SESSION either', async () => {
      await calling.groupCall().startGroupCall([STRANGER], false);
      await settle();
      expect(policyNow()!.relay).toBe(true);
      await calling.groupCall().hangup();
      await settle();

      stored.connected.add(FRIEND);
      stored.connected.add(FRIEND2);
      await calling.groupCall().startGroupCall([FRIEND, FRIEND2], false);
      await settle();

      const legs = dialled();
      expect(legs).toHaveLength(3);
      for (const cid of legs.slice(1)) expect(legPolicy(cid)).toBe(false);
    });
  });
});
