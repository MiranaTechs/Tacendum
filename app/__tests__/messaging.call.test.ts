/**
 * The seam between messaging and calling. `messaging.ts`
 * must not import anything call-related: it hands decrypted envelopes to
 * whoever registered, and the CallService is just a subscriber. This keeps the
 * two subsystems independently testable and keeps a 24 KB file from growing a
 * second protocol inside it.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
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
    stop() {}
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return true;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

import type { CallEnvelope } from '@tacendum/shared';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

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
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  decryptEnvelope: jest.Mock;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
    };
  }
).__ws;

const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const OFFER: CallEnvelope = {
  tcm: 'call.offer',
  cid: CID,
  sdp: 'v=0\r\na=fingerprint:sha-256 AA',
  vid: true,
  exp: 2_000_000_000_000,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Only statements that CHANGE data — schema DDL mentions column names like
 * `lastMessageText` and would make every "did not write" assertion vacuous. */
function writes(name = 'tacendum.sqlite'): string[] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? [])
    .map(c => String(c[0]))
    .filter(s => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s));
}

async function deliver(body: string): Promise<void> {
  crypto.decryptEnvelope.mockResolvedValueOnce(body);
  ws.handlers.frame?.({
    type: 'msg',
    from: PEER,
    msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  sqlite.reset();
  crypto.decryptEnvelope.mockReset();
  crypto.encryptText.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.hasSession.mockResolvedValue(true);
  ws.calls.send.mockClear();
  await db.initDb();
  await messaging.start('me-user');
  await flush();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
});

describe('inbound call signalling (onEnvelope)', () => {
  it('hands a call envelope to subscribers and acks it', async () => {
    const seen: Array<{ peerId: string; envelope: CallEnvelope }> = [];
    const off = messaging.onEnvelope((peerId, envelope) => {
      if (envelope.tcm.startsWith('call.')) {
        seen.push({ peerId, envelope: envelope as CallEnvelope });
      }
    });

    await deliver(JSON.stringify(OFFER));

    expect(seen).toHaveLength(1);
    expect(seen[0].peerId).toBe(PEER);
    expect(seen[0].envelope).toEqual(OFFER);
    expect(
      ws.calls.send.mock.calls.some(c => (c[0] as { type: string }).type === 'ack'),
    ).toBe(true);
    off();
  });

  it('writes no message row and no chat preview for call signalling', async () => {
    const off = messaging.onEnvelope(() => {});
    await deliver(JSON.stringify(OFFER));

    const sql = writes().join('\n');
    expect(sql).not.toMatch(/INTO messages/);
    expect(sql).not.toMatch(/lastMessageText/);
    // The seen-set and the ack are the ONLY durable traces call signalling
    // may leave in the messaging tables.
    expect(sql).toMatch(/INTO seen/);
    off();
  });

  it('stops delivering after unsubscribe, without breaking the ack path', async () => {
    let count = 0;
    const off = messaging.onEnvelope(() => {
      count++;
    });
    off();
    await deliver(JSON.stringify(OFFER));

    expect(count).toBe(0);
    expect(
      ws.calls.send.mock.calls.some(c => (c[0] as { type: string }).type === 'ack'),
    ).toBe(true);
  });

  it('a throwing subscriber cannot break message handling for everyone else', async () => {
    const good = jest.fn();
    const offBad = messaging.onEnvelope(() => {
      throw new Error('subscriber exploded');
    });
    const offGood = messaging.onEnvelope(good);

    await deliver(JSON.stringify(OFFER));

    expect(good).toHaveBeenCalled();
    expect(
      ws.calls.send.mock.calls.some(c => (c[0] as { type: string }).type === 'ack'),
    ).toBe(true);
    offBad();
    offGood();
  });

  it('does not hand call signalling to a DURESS session', async () => {
    // A duress session never starts messaging, but defense in depth: nothing
    // about a real call may surface in the decoy world.
    const seen = jest.fn();
    const off = messaging.onEnvelope(seen);
    session.setMode('duress');
    await deliver(JSON.stringify(OFFER));
    session.setMode('real');
    expect(seen).not.toHaveBeenCalled();
    off();
  });
});

describe('outbound call signalling (sendCallEnvelope)', () => {
  it('encrypts through the ratchet and queues at call priority', async () => {
    await messaging.sendCallEnvelope(PEER, OFFER, { urgent: true });

    expect(crypto.encryptText).toHaveBeenCalled();
    // The SDP goes through the ratchet, never the wire in the clear.
    const plaintext = crypto.encryptText.mock.calls[0][2] as string;
    expect(plaintext).toContain('call.offer');
    expect(plaintext).toContain('a=fingerprint');

    const insert = (sqlite.instances.get('tacendum.sqlite')!.execute.mock.calls
      .find(c => String(c[0]).includes('INSERT OR IGNORE INTO outbox')))!;
    expect(insert[1]).toContain(1); // priority 1
  });

  it('never touches the chat preview or creates a visible row', async () => {
    await messaging.sendCallEnvelope(PEER, OFFER, { urgent: true });
    const sql = writes().join('\n');
    expect(sql).not.toMatch(/lastMessageText/);
  });

  it('refuses to signal a peer whose safety number changed', async () => {
    const identityError = Object.assign(new Error('identity_changed'), {
      code: 'identity_changed',
    });
    crypto.encryptText.mockRejectedValueOnce(identityError);
    (
      jest.requireMock('tacendum-crypto') as { isIdentityChangeError: jest.Mock }
    ).isIdentityChangeError.mockReturnValueOnce(true);

    await expect(
      messaging.sendCallEnvelope(PEER, OFFER, { urgent: true }),
    ).rejects.toThrow(/safety number/i);
    // Ringing a phone for an identity we cannot verify is the one thing a
    // secure messenger must not do.
    expect(messaging.isPeerBlocked(PEER)).toBe(true);
  });

  it('is refused outright in a duress session', async () => {
    session.setMode('duress');
    await expect(
      messaging.sendCallEnvelope(PEER, OFFER, { urgent: true }),
    ).rejects.toThrow();
    session.setMode('real');
    expect(ws.calls.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Small-group calls: the routing hook.
// ---------------------------------------------------------------------------

// A REAL ULID: Crockford base32 excludes I, L, O and U, and the shipped
// schema validates every id — a friendly-looking 'SESSION' would silently
// exercise the parser's rejection path instead of the routing under test.
const SID = '01SESSN00000000000000000ZA';
const GINVITE = {
  tcm: 'call.ginvite',
  sid: SID,
  cid: CID,
  r: [PEER, '01MEZ3NDEKTSV4RRFFQ69G5FAV'],
  sdp: 'v=0\r\na=fingerprint:sha-256 AA',
  vid: false,
  exp: 2_000_000_000_000,
};

describe('inbound SMALL-GROUP call signalling', () => {
  it('hands a ginvite to subscribers, acks it, and writes no message row', async () => {
    // `call.g*` is deliberately NOT in the 1:1 `Envelope` union — that union
    // is byte-for-byte what an already-shipped build parses with — so it
    // needs its own branch. WITHOUT one it falls through to applyContent and
    // is persisted as a (carrier-classified, invisible) message row per
    // frame: a session's worth of rows holding SDPs. That is the falsifying
    // case, run at authoring time by deleting the branch; the
    // `not.toMatch(/INTO messages/)` below went red. Restored.
    const seen: { peerId: string; tcm: string; sid?: string }[] = [];
    const off = messaging.onEnvelope((peerId, envelope) => {
      const e = envelope as { tcm: string; sid?: string };
      if (e.tcm.startsWith('call.g')) seen.push({ peerId, tcm: e.tcm, sid: e.sid });
    });

    await deliver(JSON.stringify(GINVITE));

    expect(seen).toEqual([{ peerId: PEER, tcm: 'call.ginvite', sid: SID }]);
    expect(
      ws.calls.send.mock.calls.some(c => (c[0] as { type: string }).type === 'ack'),
    ).toBe(true);
    const sql = writes().join('\n');
    expect(sql).not.toMatch(/INTO messages/);
    expect(sql).not.toMatch(/lastMessageText/);
    off();
  });

  it('a MALFORMED group frame acks byte-identically and reaches nobody', async () => {
    // Receiver-permissive: a parser-shaped refusal costs the message,
    // and on a one-way ratchet that loss is permanent.
    const seen: unknown[] = [];
    const off = messaging.onEnvelope((_p, e) => {
      if ((e as { tcm: string }).tcm?.startsWith('call.g')) seen.push(e);
    });
    await deliver(JSON.stringify({ tcm: 'call.gjoin', sid: 'not-a-ulid', m: 1 }));
    expect(seen).toEqual([]);
    expect(
      ws.calls.send.mock.calls.some(c => (c[0] as { type: string }).type === 'ack'),
    ).toBe(true);
    expect(writes().join('\n')).not.toMatch(/INTO messages/);
    off();
  });

  it('a DURESS session never sees a ginvite — nothing about a real call surfaces', async () => {
    const seen: unknown[] = [];
    const off = messaging.onEnvelope((_p, e) => {
      if ((e as { tcm: string }).tcm?.startsWith('call.g')) seen.push(e);
    });
    session.setMode('duress');
    await deliver(JSON.stringify(GINVITE));
    expect(seen).toEqual([]);
    session.setMode('real');
    off();
  });

  it('sendGroupCallEnvelope encrypts the GROUP encoding and queues at call priority', async () => {
    await messaging.sendGroupCallEnvelope(PEER, GINVITE as never, { urgent: true });
    await flush();
    // The plaintext handed to the ratchet is the group encoder's output — the
    // session binding and the roster travel INSIDE the ciphertext, never
    // beside it.
    const plaintext = String(crypto.encryptText.mock.calls[0][2]);
    expect(plaintext).toContain('"tcm":"call.ginvite"');
    expect(plaintext).toContain(`"sid":"${SID}"`);
    const inserts = (sqlite.instances.get('tacendum.sqlite')?.execute.mock.calls ?? []).filter(
      c => /INTO outbox/.test(String(c[0])),
    );
    expect(inserts.length).toBe(1);
    const args = inserts[0][1] as unknown[];
    // priority 1 (a ringing phone never waits behind a 10 MB upload) and
    // urgent 1 (a ginvite is what wakes a sleeping device).
    expect(args[4]).toBe(1);
    expect(args[5]).toBe(1);
  });
});
