import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ROOM FAN-OUT'S TRANSPORT CONTRACT (send.ts `sendEncryptedFanout`) —
 * gate.send-unify's sibling, for the fourth caller of the send sequence.
 *
 * Three properties, each of which has been a real defect class in this repo:
 *
 *  1. CONNECT BEFORE RATCHET, for all N legs at once: a refused socket costs
 *     ZERO sender-chain advances. The bricking arithmetic is worse here than
 *     for a 1:1 send — one refused fan-out to an 11-member room burns 11
 *     advances if the order is wrong, so the retry budget to a wedged chain
 *     divides by N.
 *  2. PER-LEG FAILURE IS SETTLED, NEVER AN ABORT: by the time leg k fails,
 *     legs 1..k-1 are delivered, and throwing away k+1.. would silently
 *     diverge this client's roster view from the members who did hear it.
 *  3. AN IDENTITY CHANGE MARKS THE PENDING RECORD AND SKIPS THAT MEMBER
 *     ONLY: the room does not pause, and `tacendum trust` has
 *     something to accept afterwards.
 *
 * Method mirrors gate.send-unify exactly: the real function runs with the
 * protocol modules mocked, so the order of operations is observable.
 */

const h = vi.hoisted(() => ({
  connect: undefined as undefined | (() => Promise<void>),
  connectCalls: 0,
  encryptCalls: 0,
  establishCalls: 0,
  sentFrames: [] as Record<string, unknown>[],
  /** Per-recipient scripted encrypt failures. */
  failEncryptFor: new Map<string, Error>(),
  hasSession: true,
}));

vi.mock('../src/wsclient.js', () => ({
  WsClient: class {
    async connect(): Promise<void> {
      h.connectCalls += 1;
      if (!h.connect) throw new Error('test provided no connect behavior');
      return h.connect();
    }
    onFrame(): void {}
    send(frame: Record<string, unknown>): void {
      h.sentFrames.push(frame);
    }
    async waitFor(): Promise<Record<string, unknown>> {
      const last = h.sentFrames[h.sentFrames.length - 1];
      return { type: 'receipt', msgId: last?.msgId, state: 'sent' };
    }
    close(): void {}
  },
}));

vi.mock('../src/messaging.js', () => ({
  hasSession: async () => h.hasSession,
  establishSession: async () => {
    h.establishCalls += 1;
  },
  isIdentityChange: (err: unknown) =>
    err instanceof Error && err.message === 'untrusted identity',
  decryptEnvelope: async () => '',
  encryptText: async (_stores: unknown, _self: string, to: string) => {
    h.encryptCalls += 1;
    const scripted = h.failEncryptFor.get(to);
    if (scripted) throw scripted;
    return { msgType: 'ciphertext', payload: 'AAAA' };
  },
}));

vi.mock('../src/api.js', () => ({
  apiGetPrekeyBundle: async () => ({ lowPrekeyCount: false }),
}));

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-order-'));
process.env.TACENDUM_HOME = home;

const { sendEncryptedFanout } = await import('../src/send.js');
const { FileStores } = await import('../src/stores.js');
const { AuthSession } = await import('../src/session.js');
const { saveProfile } = await import('../src/profile.js');
const { CliError, EXIT } = await import('../src/exit.js');

const SELF = '01ANAANAANAANAANAANAANAANA';
const BEN = '01BENBENBENBENBENBENBENBEN';
const CARA = '01CARACARACARACARACARACARA';
const DAN = '01DANDANDANDANDANDANDANDAN';

saveProfile({
  name: 'ana',
  identityKey: 'test-key',
  userId: SELF,
  authToken: 'test-token',
  registrationId: 1,
  deviceId: 1,
});

function legsOf(...tos: string[]): { to: string; body: string; msgId: string }[] {
  return tos.map((to, i) => ({
    to,
    body: '{"tcm":"grp.msg"}',
    msgId: `0TEST${String(i).padStart(21, '0')}`,
  }));
}

function harness(): { stores: InstanceType<typeof FileStores>; auth: InstanceType<typeof AuthSession> } {
  const stores = new FileStores('ana');
  const auth = new AuthSession('ana', stores);
  return { stores, auth };
}

beforeEach(() => {
  h.connect = undefined;
  h.connectCalls = 0;
  h.encryptCalls = 0;
  h.establishCalls = 0;
  h.sentFrames = [];
  h.failEncryptFor = new Map();
  h.hasSession = true;
});

describe('sendEncryptedFanout: transport before ratchet, for every leg at once', () => {
  it('a refused socket costs ZERO ratchet advances across the whole fan-out', async () => {
    h.connect = () => {
      throw new CliError(EXIT.NETWORK, 'websocket refused');
    };
    const { stores, auth } = harness();
    await expect(
      sendEncryptedFanout({ stores, auth, legs: legsOf(BEN, CARA, DAN) }),
    ).rejects.toMatchObject({ exitCode: EXIT.NETWORK });
    expect(h.encryptCalls).toBe(0);
    expect(h.establishCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
  });

  it('all N legs ride ONE connection, each as an ordinary send frame', async () => {
    h.connect = async () => {};
    const { stores, auth } = harness();
    const legs = legsOf(BEN, CARA, DAN);
    const outcomes = await sendEncryptedFanout({ stores, auth, legs });
    expect(h.connectCalls).toBe(1);
    expect(outcomes.map(o => o.state)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(h.sentFrames.map(f => f.to)).toEqual([BEN, CARA, DAN]);
    expect(h.sentFrames.map(f => f.msgId)).toEqual(legs.map(l => l.msgId));
    // The server must not be able to tell these from N ordinary messages:
    // plain send frames, no extra fields naming a room or a set.
    for (const frame of h.sentFrames) {
      expect(Object.keys(frame).sort()).toEqual(['msgId', 'msgType', 'payload', 'to', 'type']);
    }
  });

  it('a mid-fan-out failure settles THAT leg and the rest still go', async () => {
    h.connect = async () => {};
    h.failEncryptFor.set(CARA, new Error('message too large to send'));
    const { stores, auth } = harness();
    const outcomes = await sendEncryptedFanout({ stores, auth, legs: legsOf(BEN, CARA, DAN) });
    expect(outcomes.map(o => [o.to, o.state])).toEqual([
      [BEN, 'delivered'],
      [CARA, 'failed'],
      [DAN, 'delivered'],
    ]);
    // The failed leg's record carries a SLUG, never the message.
    expect(outcomes[1]?.reason).toBe('error');
    expect(h.sentFrames.map(f => f.to)).toEqual([BEN, DAN]);
  });

  it('an identity change marks the pending record and skips that member only', async () => {
    h.connect = async () => {};
    h.failEncryptFor.set(BEN, new Error('untrusted identity'));
    const { stores, auth } = harness();
    const outcomes = await sendEncryptedFanout({ stores, auth, legs: legsOf(BEN, CARA) });
    expect(outcomes.map(o => [o.to, o.state])).toEqual([
      [BEN, 'identity-changed'],
      [CARA, 'delivered'],
    ]);
    // `tacendum trust ana <BEN>` now has something to accept — the same
    // record cmdSend writes on its refusal path.
    expect(stores.hasIdentityChange(BEN)).toBe(true);
    expect(stores.hasIdentityChange(CARA)).toBe(false);
  });
});
