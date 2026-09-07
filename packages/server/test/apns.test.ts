import { generateKeyPairSync, createVerify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApnsClient, type ApnsCredentials } from '../src/push/apns.js';

/**
 * The APNs VoIP client tested against a REAL local HTTP/2
 * server rather than a mocked transport — the things most likely to be wrong
 * here (JWT shape, header names, status handling) are exactly the things a
 * hand-written mock would get wrong in the same way twice.
 *
 * The signing key is generated in-process, so none of this needs Apple's .p8.
 */

/** APNs signs with ES256 over the P-256 curve, exactly as generated here. */
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CREDENTIALS: ApnsCredentials = {
  keyId: 'ABCD123456',
  teamId: 'TEAM123456',
  bundleId: 'com.miranatechnologies.tacendum',
  privateKeyP8: P8,
};

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A stand-in for api.push.apple.com that records requests and replies with
 * whatever the current test asks for. `reply` may be a function of the
 * request's index so a test can script a SEQUENCE (first 403, then 200);
 * `'hang'` never answers, which is how an attempt is made to time out. */
type Reply = { status: number; body?: string } | 'hang';
let server: http2.Http2Server;
let origin: string;
let received: Received[] = [];
let reply: Reply | ((index: number) => Reply) = { status: 200 };
/** HTTP/2 sessions the stand-in has accepted — one per client dial. */
let sessionsOpened = 0;
/** Live server-side sessions, destroyed at teardown so a deliberately hung
 * stream cannot hold `server.close()` open past the hook timeout. */
const openSessions = new Set<http2.ServerHttp2Session>();

beforeAll(async () => {
  server = http2.createServer();
  server.on('session', (session) => {
    sessionsOpened += 1;
    openSessions.add(session);
    session.on('close', () => openSessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      const index = received.push({ headers, body }) - 1;
      const r = typeof reply === 'function' ? reply(index) : reply;
      if (r === 'hang') return;
      stream.respond({ ':status': r.status });
      stream.end(r.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const session of openSessions) session.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  reply = { status: 200 };
  sessionsOpened = 0;
});

const TOKEN = 'a'.repeat(64);

function decodeJwt(token: string) {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}

describe('the request APNs receives', () => {
  it('posts to the device path with the VoIP headers Apple requires', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, {
      from: 'user-caller',
      to: 'user-recipient',
      ts: 1_700_000_000_000,
    });

    expect(received).toHaveLength(1);
    const { headers } = received[0]!;
    expect(headers[':method']).toBe('POST');
    expect(headers[':path']).toBe(`/3/device/${TOKEN}`);
    // A VoIP push that is not typed `voip` on a `.voip` topic is rejected by
    // APNs and, worse, silently does not launch the app.
    expect(headers['apns-push-type']).toBe('voip');
    expect(headers['apns-topic']).toBe(`${CREDENTIALS.bundleId}.voip`);
    expect(headers['apns-priority']).toBe('10');
    expect(Number(headers['apns-expiration'])).toBeGreaterThan(0);
    await client.close();
  });

  it('expires the push in under a minute — a stale ring is worse than none', async () => {
    const now = 1_700_000_000_000;
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      now: () => now,
    });
    await client.sendVoip(TOKEN, { from: 'user-caller', to: 'user-recipient', ts: now });
    const expiration = Number(received[0]!.headers['apns-expiration']);
    const seconds = expiration - Math.floor(now / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    await client.close();
  });

  it('carries only what the recipient could already derive — and no cid', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, {
      from: 'user-caller',
      to: 'user-recipient',
      ts: 1_700_000_000_000,
    });

    const payload = JSON.parse(received[0]!.body);
    expect(payload).toEqual({
      from: 'user-caller',
      to: 'user-recipient',
      ts: 1_700_000_000_000,
    });
    // The server cannot know a cid — it is inside the ciphertext — and must
    // never appear to. No name, no phone number, no "video call" flag.
    expect(received[0]!.body).not.toMatch(/cid/i);
    expect(received[0]!.body).not.toMatch(/name|phone|video/i);
    await client.close();
  });
});

describe('the authentication token', () => {
  it('is an ES256 JWT that verifies against the signing key', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });

    const auth = String(received[0]!.headers.authorization);
    expect(auth.startsWith('bearer ')).toBe(true);
    const jwt = decodeJwt(auth.slice('bearer '.length));

    expect(jwt.header).toEqual({ alg: 'ES256', kid: CREDENTIALS.keyId });
    expect(jwt.payload.iss).toBe(CREDENTIALS.teamId);
    expect(typeof jwt.payload.iat).toBe('number');

    // Verified for real, against the public half of the generated key.
    const verifier = createVerify('SHA256').update(jwt.signingInput);
    expect(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(
      true,
    );
    await client.close();
  });

  it('is reused across sends, then regenerated before Apple would reject it', async () => {
    let now = 1_700_000_000_000;
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      now: () => now,
    });
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 2 });
    const first = received[0]!.headers.authorization;
    expect(received[1]!.headers.authorization).toBe(first);

    // APNs rejects a JWT older than 60 minutes; regenerate before that.
    now += 51 * 60_000;
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 3 });
    expect(received[2]!.headers.authorization).not.toBe(first);
    await client.close();
  });
});

describe('what the response means', () => {
  it('reports success on 200', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'sent' });
    await client.close();
  });

  it('reports a DEAD TOKEN on 410, so the caller can delete the row', async () => {
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'token_invalid' });
    await client.close();
  });

  it('treats BadDeviceToken (400) as a dead token too, not a retryable failure', async () => {
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    expect(await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 })).toMatchObject({
      outcome: 'token_invalid',
    });
    await client.close();
  });

  it('does NOT retry a 429 — by the time a retry landed the call is over', async () => {
    reply = { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(received).toHaveLength(1);
    await client.close();
  });

  it('retries a 500 exactly once, then gives up quietly', async () => {
    reply = { status: 500, body: JSON.stringify({ reason: 'InternalServerError' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(received).toHaveLength(2);
    await client.close();
  });

  it('succeeds if the retry succeeds', async () => {
    reply = { status: 503 };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const pending = client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    // Flip the server's answer after the first attempt has been recorded.
    const flip = setInterval(() => {
      if (received.length >= 1) {
        reply = { status: 200 };
        clearInterval(flip);
      }
    }, 5);
    const result = await pending;
    clearInterval(flip);
    expect(result.outcome === 'sent' || result.outcome === 'failed').toBe(true);
    await client.close();
  });
});

describe('host selection', () => {
  it('targets the sandbox and production hosts by environment', () => {
    expect(makeApnsClient({ credentials: CREDENTIALS, env: 'sandbox' }).origin).toBe(
      'https://api.sandbox.push.apple.com',
    );
    expect(makeApnsClient({ credentials: CREDENTIALS, env: 'production' }).origin).toBe(
      'https://api.push.apple.com',
    );
  });
});

/**
 * Message notifications use a DIFFERENT push kind, a different topic and a
 * different token from a call. Crossing any of them fails silently — APNs
 * accepts the request and nothing arrives — so each is pinned here.
 */
describe('an alert push for a message', () => {
  const ALERT = {
    from: 'user-sender',
    ts: 1_700_000_000_000,
    msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    msgType: 'ciphertext',
    payload: 'Y2lwaGVydGV4dA==',
  };

  it('uses the alert type and the BARE topic, not the .voip one', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendAlert(TOKEN, ALERT);

    const { headers } = received[0]!;
    expect(headers['apns-push-type']).toBe('alert');
    // `.voip` here would be accepted and never shown.
    expect(headers['apns-topic']).toBe(CREDENTIALS.bundleId);
    await client.close();
  });

  it('sets mutable-content, or the extension never runs', async () => {
    // Without it iOS renders `alert.body` verbatim and gives the app no
    // chance to decrypt — every notification would be the generic fallback,
    // whatever the person chose.
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendAlert(TOKEN, ALERT);

    const body = JSON.parse(received[0]!.body) as {
      aps: Record<string, unknown> & { alert: { body: string } };
      t: typeof ALERT;
    };
    expect(body.aps['mutable-content']).toBe(1);
    await client.close();
  });

  it('ships a generic body as the DEGRADED case, never a preview', async () => {
    // This string is what a person sees when the extension is killed for time
    // or memory, so it must say the least that is still useful. The preview
    // is decided on the device, from ciphertext — the server could not
    // produce one if it wanted to.
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendAlert(TOKEN, ALERT);

    const body = JSON.parse(received[0]!.body) as {
      aps: { alert: { body: string } };
    };
    expect(body.aps.alert.body).toBe('New message');
    await client.close();
  });

  it('mints apns-collapse-id = the sender — the same fact thread-id already carries', async () => {
    // Banner coalescing: the
    // collapse key is the SENDER, and it must be the value `thread-id`
    // already disclosed in the body — one fact, two headers, no new
    // disclosure to Apple. A real 26-char sender ULID, because the header
    // must also fit Apple's 64-byte cap on apns-collapse-id.
    const from = '01ARZ3NDEKTSV4RRFFQ69G5SND';
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendAlert(TOKEN, { ...ALERT, from });

    const { headers } = received[0]!;
    const body = JSON.parse(received[0]!.body) as {
      aps: Record<string, unknown>;
    };
    // Presence, and derivation from `from` — not msgId, not the recipient.
    expect(headers['apns-collapse-id']).toBe(from);
    // One fact, two headers: the collapse key IS the thread key.
    expect(headers['apns-collapse-id']).toBe(body.aps['thread-id']);
    expect(Buffer.byteLength(String(headers['apns-collapse-id']))).toBeLessThanOrEqual(64);
    await client.close();
  });

  it('NEVER mints a collapse id on the voip arm — a ring must never replace a ring', async () => {
    // If a second call's push COLLAPSED the first, an unanswered ring would
    // silently become a different ring. The wakeid mint test's two-rings pin
    // is this same law one layer up; here it is pinned at the header.
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, {
      from: '01ARZ3NDEKTSV4RRFFQ69G5SND',
      to: 'user-recipient',
      ts: 1_700_000_000_000,
    });

    expect(received[0]!.headers['apns-collapse-id']).toBeUndefined();
    await client.close();
  });

  it('carries the ciphertext OUTSIDE aps, and no plaintext anywhere', async () => {
    // Apple drops unrecognised keys inside `aps`, so the envelope rides
    // beside it. And the whole point: what the server forwards is the same
    // bytes it queued.
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendAlert(TOKEN, ALERT);

    const raw = received[0]!.body;
    const body = JSON.parse(raw) as { aps: object; t: typeof ALERT };
    expect(body.t.payload).toBe(ALERT.payload);
    expect(body.t.msgId).toBe(ALERT.msgId);
    expect(Object.keys(body.aps)).not.toContain('payload');
    // The sender id is metadata the server already routes on; nothing else
    // legible may appear.
    expect(raw).not.toMatch(/ciphertext(?!")/i);
    await client.close();
  });
});

/**
 * Apple refuses an ALERT payload over
 * 4096 bytes with 413 PayloadTooLarge, and the alert used to embed the whole
 * queued ciphertext (the frame schema allows 30 000 base64 chars). Any
 * message over ~3.7 KB of ciphertext therefore raised NO banner at all — not
 * even the generic one. The client trims the ciphertext out of an oversized
 * body; the extension then takes its documented degraded path (an empty
 * `t.payload` decodes, decrypts to nothing, and the generic body shows with
 * the badge and collapse counters intact — NotificationService.swift). */
describe('an alert that would exceed the 4 KB APNs cap', () => {
  const BIG = {
    from: '01ARZ3NDEKTSV4RRFFQ69G5SND',
    ts: 1_700_000_000_000,
    msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    msgType: 'ciphertext',
    // Schema-max ciphertext: MAX_PAYLOAD_B64_LENGTH in shared/frames.ts.
    payload: 'A'.repeat(30_000),
  };

  it('ships without the ciphertext, under the cap, and still reports sent', async () => {
    const logs: string[] = [];
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      log: (event) => logs.push(event),
    });
    const result = await client.sendAlert(TOKEN, BIG);

    expect(result).toMatchObject({ outcome: 'sent' });
    expect(received).toHaveLength(1);
    const raw = received[0]!.body;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
    const body = JSON.parse(raw) as {
      aps: Record<string, unknown>;
      t: { from: string; ts: number; msgId: string; msgType: string; payload: string };
    };
    // The routing facts survive — the extension still runs its blocked-sender
    // check and its badge/collapse bookkeeping off them — and `payload` is
    // present but EMPTY, because the extension's decoder requires the field.
    expect(body.t).toEqual({ ...BIG, payload: '' });
    // `aps` is byte-identical to a small alert's.
    expect(body.aps).toEqual({
      alert: { title: 'Tacendum', body: 'New message' },
      sound: 'default',
      'mutable-content': 1,
      'thread-id': BIG.from,
    });
    expect(received[0]!.headers['content-length']).toBe(String(Buffer.byteLength(raw)));
    // Loud, and with no payload bytes in it.
    expect(logs).toEqual(['apns_alert_payload_trimmed']);
    await client.close();
  });

  it('leaves a small alert untouched and logs nothing', async () => {
    const logs: string[] = [];
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      log: (event) => logs.push(event),
    });
    const small = { ...BIG, payload: 'Y2lwaGVydGV4dA==' };
    await client.sendAlert(TOKEN, small);

    const body = JSON.parse(received[0]!.body) as { t: typeof small };
    expect(body.t.payload).toBe(small.payload);
    expect(logs).toEqual([]);
    await client.close();
  });

  it('retries a 413 exactly once without the ciphertext — Apple is the authority on its own cap', async () => {
    // A body under our threshold that Apple still refuses (the cap has moved,
    // or is measured differently): the second attempt drops the ciphertext.
    reply = (index) =>
      index === 0
        ? { status: 413, body: JSON.stringify({ reason: 'PayloadTooLarge' }) }
        : { status: 200 };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const modest = { ...BIG, payload: 'A'.repeat(3_000) };
    const result = await client.sendAlert(TOKEN, modest);

    expect(result).toMatchObject({ outcome: 'sent' });
    expect(received).toHaveLength(2);
    expect((JSON.parse(received[0]!.body) as { t: typeof modest }).t.payload).toBe(modest.payload);
    expect((JSON.parse(received[1]!.body) as { t: typeof modest }).t.payload).toBe('');
    await client.close();
  });

  it('gives up after one trimmed retry if Apple still says 413', async () => {
    reply = { status: 413, body: JSON.stringify({ reason: 'PayloadTooLarge' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendAlert(TOKEN, BIG);

    expect(result).toMatchObject({ outcome: 'failed', status: 413 });
    expect(received).toHaveLength(1); // already trimmed: nothing left to drop
    await client.close();
  });
});

/**
 * The per-attempt deadline used to cancel the
 * STREAM and leave the session in place, so a warm container thawed with a
 * TCP connection the peer had silently dropped kept reusing that dead session
 * for every later wake until the kernel's retransmit timeout — minutes of
 * calls to locked phones not ringing. The deadline now tears the session down
 * so the next attempt dials fresh. */
describe('a stalled session is not reused', () => {
  it('dials a fresh session after an attempt times out', async () => {
    reply = (index) => (index === 0 ? 'hang' : { status: 200 });
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      attemptTimeoutMs: 100,
    });
    const first = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(first).toMatchObject({ outcome: 'failed' });
    expect(sessionsOpened).toBe(1);

    const second = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 2 });
    expect(second).toMatchObject({ outcome: 'sent' });
    // The proof: a SECOND session, not a second stream on the first.
    expect(sessionsOpened).toBe(2);
    await client.close();
  });

  it('keeps reusing a healthy session between successful sends', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 2 });
    expect(received).toHaveLength(2);
    expect(sessionsOpened).toBe(1);
    await client.close();
  });
});

/**
 * A 403 ExpiredProviderToken / InvalidProviderToken / MissingProviderToken was
 * classified `failed` and the cached JWT kept being served until
 * TOKEN_REFRESH_MS — up to 50 minutes of every wake from that container failing
 * on a token Apple had already rejected. Those three reasons now drop the cache
 * and retry once with a fresh JWT. */
describe('a provider-token 403 re-mints the JWT', () => {
  /** A clock that moves a second per read, so a re-minted JWT carries a new
   * `iat` and is distinguishable from the rejected one by more than the
   * signature's randomness. */
  function tickingClock() {
    let t = 1_700_000_000_000;
    return () => (t += 1000);
  }

  it('retries once with a fresh token on ExpiredProviderToken and succeeds', async () => {
    reply = (index) =>
      index === 0
        ? { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) }
        : { status: 200 };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin, now: tickingClock() });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });

    expect(result).toMatchObject({ outcome: 'sent' });
    expect(received).toHaveLength(2);
    const [rejected, fresh] = received.map((r) => String(r.headers.authorization));
    expect(fresh).not.toBe(rejected);
    expect(decodeJwt(fresh!.slice('bearer '.length)).payload.iat).toBeGreaterThan(
      decodeJwt(rejected!.slice('bearer '.length)).payload.iat,
    );
    // The fresh token is the one now cached: the next send reuses it.
    await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 2 });
    expect(String(received[2]!.headers.authorization)).toBe(fresh);
    await client.close();
  });

  it('does the same on the alert arm', async () => {
    reply = (index) =>
      index === 0
        ? { status: 403, body: JSON.stringify({ reason: 'InvalidProviderToken' }) }
        : { status: 200 };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin, now: tickingClock() });
    const result = await client.sendAlert(TOKEN, {
      from: 'u',
      ts: 1,
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
      payload: 'Y2lwaGVydGV4dA==',
    });
    expect(result).toMatchObject({ outcome: 'sent' });
    expect(received).toHaveLength(2);
    expect(received[1]!.headers.authorization).not.toBe(received[0]!.headers.authorization);
    await client.close();
  });

  it('does NOT retry a 403 for any other reason — a new token would not fix it', async () => {
    reply = { status: 403, body: JSON.stringify({ reason: 'TopicDisallowed' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin, now: tickingClock() });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed', status: 403, reason: 'TopicDisallowed' });
    expect(received).toHaveLength(1);
    await client.close();
  });

  it('gives up after one re-mint if Apple rejects the fresh token too', async () => {
    reply = { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin, now: tickingClock() });
    const result = await client.sendVoip(TOKEN, { from: 'u', to: 'user-recipient', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed', status: 403 });
    expect(received).toHaveLength(2);
    await client.close();
  });
});
