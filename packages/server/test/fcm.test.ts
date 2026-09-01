import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeFcmClient, type FcmCredentials } from '../src/push/fcm.js';

/**
 * The FCM push client tested against a REAL local HTTP
 * server rather than a mocked transport, for the same reason apns.test.ts is:
 * the things most likely to be wrong (the OAuth exchange, the JWT shape, the
 * v1 message envelope, status handling) are exactly the things a hand-written
 * mock would get wrong in the same way twice.
 *
 * The signing key is a throwaway RSA keypair minted in-process; none of this ever touches a Google-issued key.
 */

/** Google service-account keys are RSA; RS256 signs with one exactly like it. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One stand-in for BOTH Google endpoints — the token exchange and
 * messages:send — telling them apart by path, exactly as the client does. */
let server: Server;
let origin: string;
let credentials: FcmCredentials;
let received: Received[] = [];
let tokenReply: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ access_token: 'ya29.test-access-token', expires_in: 3600 }),
};
let sendReply: { status: number; body?: string } = { status: 200 };

const TOKEN_PATH = '/token';
const SEND_PATH = '/v1/projects/tacendum-test/messages:send';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const reply = req.url === TOKEN_PATH ? tokenReply : sendReply;
      res.statusCode = reply.status;
      res.end(reply.body ?? '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  credentials = {
    projectId: 'tacendum-test',
    clientEmail: 'push@tacendum-test.iam.gserviceaccount.com',
    privateKeyPem: PEM,
    tokenUri: `${origin}${TOKEN_PATH}`,
  };
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  tokenReply = {
    status: 200,
    body: JSON.stringify({ access_token: 'ya29.test-access-token', expires_in: 3600 }),
  };
  sendReply = { status: 200 };
});

const DEVICE = `device-instance-id:APA91b${'x'.repeat(120)}`;
const sends = () => received.filter(r => r.path === SEND_PATH);
const tokenMints = () => received.filter(r => r.path === TOKEN_PATH);

function decodeJwt(assertion: string) {
  const [h, p, s] = assertion.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(p!, 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}

describe('the request FCM receives', () => {
  it('posts a data-only, high-priority message to the project send path', async () => {
    const client = makeFcmClient({ credentials, origin });
    await client.sendCallWake(DEVICE, { from: 'user-caller', ts: 1_700_000_000_000 });

    expect(sends()).toHaveLength(1);
    const send = sends()[0]!;
    expect(send.headers.authorization).toBe('Bearer ya29.test-access-token');
    const body = JSON.parse(send.body) as {
      message: Record<string, unknown> & { android: Record<string, unknown> };
    };
    expect(body.message.token).toBe(DEVICE);
    // Data-only: a `notification` block would hand rendering to the system
    // tray with none of the app's preview gates consulted.
    expect(Object.keys(body.message).sort()).toEqual(['android', 'data', 'token']);
    // High priority is the point: the push exists to wake a Doze-idle process.
    expect(body.message.android.priority).toBe('HIGH');
  });

  it('expires a CALL wake in 45 seconds — a stale ring is worse than none', async () => {
    // FCM's default is four WEEKS; unset, a phone coming out of a pocket
    // days later would ring for a call that ended.
    const client = makeFcmClient({ credentials, origin });
    await client.sendCallWake(DEVICE, { from: 'user-caller', ts: 1 });
    const body = JSON.parse(sends()[0]!.body) as {
      message: { android: { ttl: string } };
    };
    expect(body.message.android.ttl).toBe('45s');
  });

  it('gives a MESSAGE wake a day, exactly as the APNs alert arm reasons', async () => {
    const client = makeFcmClient({ credentials, origin });
    await client.sendMessageWake(DEVICE, {
      from: 'user-sender',
      ts: 1,
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
    });
    const body = JSON.parse(sends()[0]!.body) as {
      message: { android: { ttl: string } };
    };
    expect(body.message.android.ttl).toBe('86400s');
  });

  it('the call wake carries only what the recipient could already derive — and no cid', async () => {
    const client = makeFcmClient({ credentials, origin });
    await client.sendCallWake(DEVICE, { from: 'user-caller', ts: 1_700_000_000_000 });

    const body = JSON.parse(sends()[0]!.body) as {
      message: { data: Record<string, string> };
    };
    // FCM data values must be strings; ts is stringified at the one pinned
    // place (fcm.ts), and the field set is EXACT — nothing may ride along.
    expect(body.message.data).toEqual({
      kind: 'call',
      fromUser: 'user-caller',
      ts: '1700000000000',
    });
    // `from` is an FCM RESERVED data key (Google refuses the send with 400
    // "Invalid data payload key: from" — measured live at activation),
    // so its absence from the wire is load-bearing, not style.
    expect(Object.keys(body.message.data)).not.toContain('from');
    expect(sends()[0]!.body).not.toMatch(/cid/i);
    expect(sends()[0]!.body).not.toMatch(/name|phone|video/i);
  });

  it('the message wake carries routing facts and NEVER the ciphertext', async () => {
    // THE divergence from the APNs alert arm, pinned on the wire: iOS ships
    // the queued ciphertext for its notification extension to decrypt;
    // Android has no extension — the woken app drains over the socket — so
    // no content-shaped field exists here at all.
    const client = makeFcmClient({ credentials, origin });
    await client.sendMessageWake(DEVICE, {
      from: 'user-sender',
      ts: 1_700_000_000_000,
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
    });

    const body = JSON.parse(sends()[0]!.body) as {
      message: { data: Record<string, string> };
    };
    expect(Object.keys(body.message.data).sort()).toEqual([
      'fromUser',
      'kind',
      'msgId',
      'msgType',
      'ts',
    ]);
    expect(sends()[0]!.body).not.toContain('payload');
  });

  it('mints NO collapse key on either lane', async () => {
    // Call lane: a ring must never replace a ring — the APNs law verbatim.
    // Message lane: the iOS collapse id coalesces BANNERS, and on Android
    // the banner is drawn by the app after decrypt, not by this push.
    const client = makeFcmClient({ credentials, origin });
    await client.sendCallWake(DEVICE, { from: 'u', ts: 1 });
    await client.sendMessageWake(DEVICE, {
      from: 'u',
      ts: 1,
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
    });
    for (const send of sends()) {
      expect(send.body).not.toMatch(/collapse/i);
    }
  });
});

describe('the authentication exchange', () => {
  it('signs an RS256 JWT that verifies against the service-account key', async () => {
    const client = makeFcmClient({ credentials, origin });
    await client.sendCallWake(DEVICE, { from: 'u', ts: 1 });

    const mint = tokenMints()[0]!;
    expect(mint.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(mint.body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const jwt = decodeJwt(params.get('assertion')!);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.claims.iss).toBe(credentials.clientEmail);
    expect(jwt.claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(jwt.claims.aud).toBe(credentials.tokenUri);
    expect(jwt.claims.exp - jwt.claims.iat).toBe(3600);

    // Verified for real, against the public half of the throwaway key.
    const verifier = createVerify('RSA-SHA256').update(jwt.signingInput);
    expect(verifier.verify(publicKey, jwt.signature)).toBe(true);
  });

  it('reuses the access token across sends, then re-mints before Google would reject it', async () => {
    let now = 1_700_000_000_000;
    const client = makeFcmClient({ credentials, origin, now: () => now });
    await client.sendCallWake(DEVICE, { from: 'u', ts: 1 });
    await client.sendCallWake(DEVICE, { from: 'u', ts: 2 });
    expect(tokenMints()).toHaveLength(1);
    expect(sends()).toHaveLength(2);

    // Access tokens live 3600 s; re-mint with room to spare.
    now += 51 * 60_000;
    await client.sendCallWake(DEVICE, { from: 'u', ts: 3 });
    expect(tokenMints()).toHaveLength(2);
  });

  it('a failed exchange is `failed`, not cached, and the next send retries it', async () => {
    tokenReply = { status: 503, body: '' };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'failed',
    });
    expect(sends()).toHaveLength(0); // nothing was sent without a bearer

    tokenReply = {
      status: 200,
      body: JSON.stringify({ access_token: 'ya29.recovered', expires_in: 3600 }),
    };
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 2 })).toMatchObject({
      outcome: 'sent',
    });
    expect(sends()[0]!.headers.authorization).toBe('Bearer ya29.recovered');
  });
});

/** Google's v1 error envelope, as the real endpoint shapes it. */
function fcmError(code: number, status: string, errorCode?: string): string {
  return JSON.stringify({
    error: {
      code,
      message: 'test',
      status,
      ...(errorCode
        ? {
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode,
              },
            ],
          }
        : {}),
    },
  });
}

describe('what the response means', () => {
  it('reports success on 200', async () => {
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'sent',
    });
  });

  it('reports a DEAD TOKEN on 404 UNREGISTERED, so the caller can prune the row', async () => {
    sendReply = { status: 404, body: fcmError(404, 'NOT_FOUND', 'UNREGISTERED') };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'token_invalid',
      reason: 'UNREGISTERED',
    });
  });

  it('treats SENDER_ID_MISMATCH as a dead token too — never deliverable from our project', async () => {
    sendReply = {
      status: 403,
      body: fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'),
    };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'token_invalid',
    });
  });

  it('a 400 INVALID_ARGUMENT is `failed`, NOT a dead token — a bad message must not delete a live registration', async () => {
    sendReply = {
      status: 400,
      body: fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
    };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'failed',
    });
  });

  it('does NOT retry a 429 — by the time a backed-off retry landed the call is over', async () => {
    sendReply = {
      status: 429,
      body: fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'),
    };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'failed',
    });
    expect(sends()).toHaveLength(1);
  });

  it('retries a 500 exactly once, then gives up quietly', async () => {
    sendReply = { status: 500, body: fcmError(500, 'INTERNAL', 'INTERNAL') };
    const client = makeFcmClient({ credentials, origin });
    expect(await client.sendCallWake(DEVICE, { from: 'u', ts: 1 })).toMatchObject({
      outcome: 'failed',
    });
    expect(sends()).toHaveLength(2);
  });
});

describe('host selection', () => {
  it('targets the real FCM host when no origin overrides it', () => {
    expect(makeFcmClient({ credentials }).origin).toBe('https://fcm.googleapis.com');
  });
});
