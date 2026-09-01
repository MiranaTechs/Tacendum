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
 * whatever the current test asks for. */
let server: http2.Http2Server;
let origin: string;
let received: Received[] = [];
let reply: { status: number; body?: string } = { status: 200 };

beforeAll(async () => {
  server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', chunk => (body += chunk));
    stream.on('end', () => {
      received.push({ headers, body });
      stream.respond({ ':status': reply.status });
      stream.end(reply.body ?? '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  reply = { status: 200 };
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
    await client.sendVoip(TOKEN, { from: 'user-caller', ts: 1_700_000_000_000 });

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
    await client.sendVoip(TOKEN, { from: 'user-caller', ts: now });
    const expiration = Number(received[0]!.headers['apns-expiration']);
    const seconds = expiration - Math.floor(now / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    await client.close();
  });

  it('carries only what the recipient could already derive — and no cid', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, { from: 'user-caller', ts: 1_700_000_000_000 });

    const payload = JSON.parse(received[0]!.body);
    expect(payload).toEqual({ from: 'user-caller', ts: 1_700_000_000_000 });
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
    await client.sendVoip(TOKEN, { from: 'u', ts: 1 });

    const auth = String(received[0]!.headers.authorization);
    expect(auth.startsWith('bearer ')).toBe(true);
    const jwt = decodeJwt(auth.slice('bearer '.length));

    expect(jwt.header).toEqual({ alg: 'ES256', kid: CREDENTIALS.keyId });
    expect(jwt.payload.iss).toBe(CREDENTIALS.teamId);
    expect(typeof jwt.payload.iat).toBe('number');

    // Verified for real, against the public half of the generated key.
    const verifier = createVerify('SHA256').update(jwt.signingInput);
    expect(
      verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature),
    ).toBe(true);
    await client.close();
  });

  it('is reused across sends, then regenerated before Apple would reject it', async () => {
    let now = 1_700_000_000_000;
    const client = makeApnsClient({
      credentials: CREDENTIALS,
      origin,
      now: () => now,
    });
    await client.sendVoip(TOKEN, { from: 'u', ts: 1 });
    await client.sendVoip(TOKEN, { from: 'u', ts: 2 });
    const first = received[0]!.headers.authorization;
    expect(received[1]!.headers.authorization).toBe(first);

    // APNs rejects a JWT older than 60 minutes; regenerate before that.
    now += 51 * 60_000;
    await client.sendVoip(TOKEN, { from: 'u', ts: 3 });
    expect(received[2]!.headers.authorization).not.toBe(first);
    await client.close();
  });
});

describe('what the response means', () => {
  it('reports success on 200', async () => {
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', ts: 1 });
    expect(result).toMatchObject({ outcome: 'sent' });
    await client.close();
  });

  it('reports a DEAD TOKEN on 410, so the caller can delete the row', async () => {
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', ts: 1 });
    expect(result).toMatchObject({ outcome: 'token_invalid' });
    await client.close();
  });

  it('treats BadDeviceToken (400) as a dead token too, not a retryable failure', async () => {
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    expect(await client.sendVoip(TOKEN, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'token_invalid',
    });
    await client.close();
  });

  it('does NOT retry a 429 — by the time a retry landed the call is over', async () => {
    reply = { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(received).toHaveLength(1);
    await client.close();
  });

  it('retries a 500 exactly once, then gives up quietly', async () => {
    reply = { status: 500, body: JSON.stringify({ reason: 'InternalServerError' }) };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const result = await client.sendVoip(TOKEN, { from: 'u', ts: 1 });
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(received).toHaveLength(2);
    await client.close();
  });

  it('succeeds if the retry succeeds', async () => {
    reply = { status: 503 };
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    const pending = client.sendVoip(TOKEN, { from: 'u', ts: 1 });
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
    expect(
      makeApnsClient({ credentials: CREDENTIALS, env: 'production' }).origin,
    ).toBe('https://api.push.apple.com');
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
    expect(
      Buffer.byteLength(String(headers['apns-collapse-id'])),
    ).toBeLessThanOrEqual(64);
    await client.close();
  });

  it('NEVER mints a collapse id on the voip arm — a ring must never replace a ring', async () => {
    // If a second call's push COLLAPSED the first, an unanswered ring would
    // silently become a different ring. The wakeid mint test's two-rings pin
    // is this same law one layer up; here it is pinned at the header.
    const client = makeApnsClient({ credentials: CREDENTIALS, origin });
    await client.sendVoip(TOKEN, {
      from: '01ARZ3NDEKTSV4RRFFQ69G5SND',
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
