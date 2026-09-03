/**
 * THE SERVER AHEAD OF THIS BUILD.
 *
 * Every response DTO is `.parse()`d strictly and there is no OTA path, so a
 * server that removes, renames or retypes a required field breaks every
 * shipped client at once — and it used to break them OPAQUELY: a zod error
 * out of the prekey fetch read as "could not send", one out of the ticket
 * mint as a failed dial. Driven through the REAL `request()` against a
 * scripted fetch, exactly as api.reauth.test.ts does, because the property
 * under test belongs to the transport: every DTO parse inherits it. */

jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import { API_BASE } from '../src/config';
import {
  ApiRequestError,
  ServerAheadError,
  apiGetPrekeyBundle,
  apiTurnCredentials,
  apiWsTicket,
} from '../src/api';

const FRIEND = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
/** A served bundle exactly as the shipped schema requires it. */
const BUNDLE = {
  userId: FRIEND,
  registrationId: 7,
  identityKey: 'QU5DSE9SS0VZ',
  signedPrekey: { keyId: 1, pub: 'U1BLUFVC', sig: 'U1BLU0lH' },
  kyberPrekey: { keyId: 2, pub: 'S1lCUFVC', sig: 'S1lCU0lH' },
};

let answers: Record<string, { status: number; body: unknown }>;

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  answers = {};
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string) => {
      const path = String(url).slice(API_BASE.length);
      const answer = answers[path] ?? { status: 404, body: {} };
      return json(answer.status, answer.body);
    },
  );
});

describe('a DTO that no longer parses is its own error', () => {
  test('the ticket mint: a renamed field surfaces as ServerAheadError naming the shape and the field — never the value', async () => {
    answers['/v1/ws-ticket'] = {
      status: 200,
      body: { token: 'dGlja2V0', expiresAt: 1_756_000_000 },
    };
    const failure = await apiWsTicket('tok').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ServerAheadError);
    const ahead = failure as ServerAheadError;
    expect(ahead.name).toBe('ServerAheadError');
    expect(ahead.dto).toBe('WsTicketResponse');
    expect(ahead.fields).toEqual(['ticket']);
    expect(ahead.message).toContain('update Tacendum');
    expect(ahead.message).not.toContain('dGlja2V0');
  });

  test('the prekey bundle: a retyped required field is ServerAheadError, and key material stays out of the message', async () => {
    answers[`/v1/keys/${FRIEND}`] = {
      status: 200,
      body: { ...BUNDLE, registrationId: 'seven' },
    };
    const failure = await apiGetPrekeyBundle('tok', FRIEND).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ServerAheadError);
    expect((failure as ServerAheadError).dto).toBe('PrekeyBundle');
    expect((failure as ServerAheadError).fields).toEqual(['registrationId']);
    expect((failure as Error).message).not.toContain(BUNDLE.identityKey);
  });

  test('a missing required field reads the same way', async () => {
    const withoutKyber = Object.fromEntries(
      Object.entries(BUNDLE).filter(([field]) => field !== 'kyberPrekey'),
    );
    answers[`/v1/keys/${FRIEND}`] = { status: 200, body: withoutKyber };
    await expect(apiGetPrekeyBundle('tok', FRIEND)).rejects.toMatchObject({
      name: 'ServerAheadError',
      dto: 'PrekeyBundle',
      fields: ['kyberPrekey'],
    });
  });
});

describe('what is NOT a server-ahead condition keeps its own shape', () => {
  test('an ADDED field is the compatible direction: unknown keys are stripped and the call succeeds', async () => {
    answers['/v1/ws-ticket'] = {
      status: 200,
      body: { ticket: 'dGlja2V0', expiresAt: 1_756_000_000, region: 'eu-west-1' },
    };
    await expect(apiWsTicket('tok')).resolves.toBe('dGlja2V0');
    answers[`/v1/keys/${FRIEND}`] = { status: 200, body: { ...BUNDLE, served: 'today' } };
    await expect(apiGetPrekeyBundle('tok', FRIEND)).resolves.toMatchObject({ userId: FRIEND });
  });

  test('a 5xx is still an ApiRequestError — "update Tacendum" is the wrong advice for an outage', async () => {
    answers['/v1/ws-ticket'] = { status: 503, body: { error: { code: 'internal', detail: 'busy' } } };
    const failure = await apiWsTicket('tok').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).not.toBeInstanceOf(ServerAheadError);
  });

  test('no network is still RN’s TypeError', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(apiWsTicket('tok')).rejects.toThrow(TypeError);
  });
});

describe('the TURN credentials answer (the parse that could never succeed)', () => {
  test('parses the BODY of the answer, not the Response object', async () => {
    answers['/v1/turn-credentials'] = {
      status: 200,
      body: { iceServers: [{ urls: ['turn:relay.example:3478'], username: 'u', credential: 'c' }], ttlSeconds: 600 },
    };
    await expect(apiTurnCredentials('tok')).resolves.toMatchObject({ ttlSeconds: 600 });
  });

  test('…and a reshaped one is ServerAheadError like every other DTO', async () => {
    answers['/v1/turn-credentials'] = { status: 200, body: { servers: [], ttlSeconds: 600 } };
    await expect(apiTurnCredentials('tok')).rejects.toMatchObject({
      name: 'ServerAheadError',
      dto: 'TurnCredentialsResponse',
    });
  });
});
