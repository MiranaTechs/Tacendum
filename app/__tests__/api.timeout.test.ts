/**
 * EVERY FETCH HAS A DEADLINE.
 *
 * React Native's `fetch` never times out on its own (`ws.ts` measured it on
 * the device for the ticket mint). Driven through the REAL `request()`,
 * `uploadBlob` and `downloadBlob` against a scripted `fetch` that models RN's
 * one relevant behaviour: it honours the AbortSignal it is handed, and
 * otherwise never answers.
 *
 * Modern fake timers: the deadline timers and `Date.now` advance together,
 * and the assertion is on the deadline itself — pending one millisecond
 * before it, rejected at it — not on a count. */

jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import {
  ApiTimeoutError,
  REQUEST_TIMEOUT_MS,
  apiWsTicket,
  blobTimeoutMs,
  downloadBlob,
  uploadBlob,
} from '../src/api';

type FetchInit = { signal?: AbortSignal } | undefined;

/** A fetch that never answers but aborts the way RN's does. */
function stalledFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init?: FetchInit) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

function answering(body: unknown): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => String(body),
  }));
}

let fetchMock: jest.Mock;
function installFetch(mock: jest.Mock): void {
  fetchMock = mock;
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Settle a rejection at the deadline without an unhandled-rejection warning. */
function watched<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { promise: p, settled: () => done };
}

test('a REST call that never answers rejects with ApiTimeoutError at the deadline — not before', async () => {
  installFetch(stalledFetch());
  const call = watched(apiWsTicket('tok'));

  await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
  expect(call.settled()).toBe(false);

  await jest.advanceTimersByTimeAsync(1);
  await expect(call.promise).rejects.toBeInstanceOf(ApiTimeoutError);
  // The signal actually reached fetch — the abort is what ends the request
  // on the device, not a promise race that leaves the socket open.
  expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
});

test('an abandoned request cannot hold a Node process open: the deadline timer is unref\'d and still fires', async () => {
  // Real timers, deliberately: this is about the handle Node hands back,
  // which fake timers do not model. On the device timers are numbers and
  // the unref is a no-op — the deadline itself is proved above.
  jest.useRealTimers();
  const handles: Array<{ hasRef?: () => boolean }> = [];
  const spy = jest.spyOn(globalThis, 'setTimeout');
  spy.mockImplementation(((fn: () => void, ms?: number) => {
    const handle = (spy.getMockImplementation() && jest.requireActual('timers').setTimeout(fn, ms)) as {
      hasRef?: () => boolean;
    };
    handles.push(handle);
    return handle;
  }) as unknown as typeof setTimeout);
  try {
    installFetch(stalledFetch());
    const call = watched(apiWsTicket('tok'));
    expect(handles).toHaveLength(1);
    expect(handles[0]!.hasRef?.()).toBe(false);
    // Fires anyway (a short deadline would be the same code path; the real
    // one is 20 s, so cancel it here rather than wait it out).
    expect(call.settled()).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test('a REST call that answers leaves no timer behind', async () => {
  // A well-formed ticket response: `expiresAt` is a positive epoch-ms in
  // the DTO, and the strict parse refuses 0.
  installFetch(answering({ ticket: 'tkt', expiresAt: 1_756_000_000_000 }));
  await expect(apiWsTicket('tok')).resolves.toBe('tkt');
  expect(jest.getTimerCount()).toBe(0);
});

test('a blob download budgets for a maximum-size blob and still ends', async () => {
  installFetch(stalledFetch());
  const call = watched(downloadBlob('https://blobs/get'));
  const deadline = blobTimeoutMs(Math.ceil((10 * 1024 * 1024 * 4) / 3));
  // Longer than a REST call's — a 10 MiB photo on a bad link is not a stall.
  expect(deadline).toBeGreaterThan(REQUEST_TIMEOUT_MS);

  await jest.advanceTimersByTimeAsync(deadline - 1);
  expect(call.settled()).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await expect(call.promise).rejects.toBeInstanceOf(ApiTimeoutError);
});

test('a blob upload scales its deadline with the body it is pushing', async () => {
  installFetch(stalledFetch());
  const body = 'x'.repeat(3 * 1024 * 1024);
  const call = watched(uploadBlob('https://blobs/put', body));
  const deadline = blobTimeoutMs(body.length);
  expect(deadline).toBe(30_000 + 3 * 10_000);

  await jest.advanceTimersByTimeAsync(deadline - 1);
  expect(call.settled()).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await expect(call.promise).rejects.toBeInstanceOf(ApiTimeoutError);
});

test('a blob download whose BODY stalls after the headers still ends', async () => {
  // The bytes are the request: a fetch that resolves its headers and then
  // never delivers `text()` is the common shape of a dying link.
  installFetch(
    jest.fn((_url: string, init?: FetchInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            );
          }),
      }),
    ),
  );
  const call = watched(downloadBlob('https://blobs/get', 1024));
  await jest.advanceTimersByTimeAsync(blobTimeoutMs(1024));
  await expect(call.promise).rejects.toBeInstanceOf(ApiTimeoutError);
});
