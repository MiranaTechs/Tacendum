import type { AiWritingProvider } from '../src/aiWriting';

type WritingService = typeof import('../src/aiWritingService');
type SessionModule = typeof import('../src/session');

const OWNER = '01KYWRITINGOWNER00000000001';
const OTHER_OWNER = '01KYWRITINGOWNER00000000002';
const OPENAI_KEY_NAME = 'aiWriting.openai';
const ANTHROPIC_KEY_NAME = 'aiWriting.anthropic';
const OPENAI_KEY = 'sk-openai-example';
const ANTHROPIC_KEY = 'sk-ant-example';

interface CryptoMock {
  __keychain: Map<string, string>;
  getSecret: jest.Mock;
  setSecret: jest.Mock;
  deleteSecret: jest.Mock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function openAiAnswer(text = 'Clearer words.'): unknown {
  return {
    id: 'resp_example',
    object: 'response',
    status: 'completed',
    output: [
      {
        id: 'msg_example',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  };
}

function anthropicAnswer(text = 'Warmer words.'): unknown {
  return {
    id: 'msg_example',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 12, output_tokens: 8 },
  };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function record(ownerId: string, key: string, selected: boolean): string {
  return JSON.stringify({ v: 1, ownerId, key, selected });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not become true');
}

let service: WritingService;
let session: SessionModule['session'];
let crypto: CryptoMock;
let fetchMock: jest.Mock;

function installFetch(mock: jest.Mock): void {
  fetchMock = mock;
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
}

function arm(): void {
  service.setWritingForeground(true);
  service.setWritingAccess(OWNER);
}

async function save(provider: AiWritingProvider, key: string): Promise<void> {
  expect(await service.saveWritingConnection(provider, key)).toMatchObject({
    status: 'completed',
  });
}

beforeEach(() => {
  jest.resetModules();
  crypto = jest.requireMock('tacendum-crypto') as CryptoMock;
  crypto.__keychain.clear();
  crypto.getSecret
    .mockReset()
    .mockImplementation(
      async (key: string) => crypto.__keychain.get(key) ?? null,
    );
  crypto.setSecret
    .mockReset()
    .mockImplementation(async (key: string, value: string) => {
      crypto.__keychain.set(key, value);
    });
  crypto.deleteSecret.mockReset().mockImplementation(async (key: string) => {
    crypto.__keychain.delete(key);
  });
  session = (jest.requireActual('../src/session') as SessionModule).session;
  session.setMode('real');
  service = jest.requireActual('../src/aiWritingService') as WritingService;
  installFetch(jest.fn());
});

afterEach(() => {
  jest.useRealTimers();
});

describe('writing access and connection storage', () => {
  it('starts denied without touching secure storage or the network', async () => {
    await expect(service.getWritingConnections()).resolves.toEqual({
      status: 'failed',
      reason: 'not_allowed',
    });
    await expect(
      service.saveWritingConnection('openai', OPENAI_KEY),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'not_allowed',
    });
    await expect(
      service.generateWriting({ draft: 'hello', action: { kind: 'improve' } }),
    ).resolves.toEqual({ status: 'failed', reason: 'not_allowed' });
    expect(crypto.getSecret).not.toHaveBeenCalled();
    expect(crypto.setSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires both foreground and a real session before reading a key', async () => {
    service.setWritingAccess(OWNER);
    await expect(service.getWritingConnections()).resolves.toEqual({
      status: 'failed',
      reason: 'not_allowed',
    });
    service.setWritingForeground(true);
    session.setMode('duress');
    await expect(service.getWritingConnections()).resolves.toEqual({
      status: 'failed',
      reason: 'not_allowed',
    });
    await expect(
      service.generateWriting({ draft: 'hello', action: { kind: 'improve' } }),
    ).resolves.toEqual({ status: 'failed', reason: 'not_allowed' });
    expect(crypto.getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves an owner-bound key, selects it, and returns presence only', async () => {
    arm();
    const before = service.getWritingRevision();
    const pending = service.saveWritingConnection(
      'openai',
      `  ${OPENAI_KEY}\n`,
    );
    expect(service.getWritingRevision()).toBe(before + 1);

    const result = await pending;
    expect(result).toEqual({
      status: 'completed',
      state: {
        selected: 'openai',
        providers: {
          openai: { configured: true },
          anthropic: { configured: false },
        },
      },
    });
    expect(JSON.parse(crypto.__keychain.get(OPENAI_KEY_NAME)!)).toEqual({
      v: 1,
      ownerId: OWNER,
      key: OPENAI_KEY,
      selected: true,
    });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid key before revoking or touching storage', async () => {
    arm();
    const before = service.getWritingRevision();
    await expect(
      service.saveWritingConnection('openai', ' \n '),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_key',
    });
    expect(service.getWritingRevision()).toBe(before);
    expect(crypto.getSecret).not.toHaveBeenCalled();
    expect(crypto.setSecret).not.toHaveBeenCalled();
  });

  it('does not expose or use a record owned by another account', async () => {
    crypto.__keychain.set(
      OPENAI_KEY_NAME,
      record(OTHER_OWNER, 'sk-other-owner', true),
    );
    arm();

    const state = await service.getWritingConnections();
    expect(state).toEqual({
      status: 'completed',
      state: {
        selected: null,
        providers: {
          openai: { configured: false },
          anthropic: { configured: false },
        },
      },
    });
    expect(crypto.deleteSecret).toHaveBeenCalledWith(OPENAI_KEY_NAME);
    await expect(
      service.generateWriting({ draft: 'hello', action: { kind: 'improve' } }),
    ).resolves.toEqual({ status: 'failed', reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when both records claim to be selected', async () => {
    crypto.__keychain.set(OPENAI_KEY_NAME, record(OWNER, OPENAI_KEY, true));
    crypto.__keychain.set(
      ANTHROPIC_KEY_NAME,
      record(OWNER, ANTHROPIC_KEY, true),
    );
    arm();

    await expect(service.getWritingConnections()).resolves.toMatchObject({
      status: 'completed',
      state: { selected: null },
    });
    await expect(
      service.generateWriting({ draft: 'hello', action: { kind: 'improve' } }),
    ).resolves.toEqual({ status: 'failed', reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deselects the old provider before selecting the new one', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    await save('anthropic', ANTHROPIC_KEY);
    crypto.setSecret.mockClear();

    const result = await service.selectWritingProvider('openai');

    expect(result).toMatchObject({
      status: 'completed',
      state: { selected: 'openai' },
    });
    expect(crypto.setSecret).toHaveBeenCalledTimes(2);
    expect(JSON.parse(crypto.setSecret.mock.calls[0]![1])).toMatchObject({
      ownerId: OWNER,
      selected: false,
    });
    expect(JSON.parse(crypto.setSecret.mock.calls[1]![1])).toMatchObject({
      ownerId: OWNER,
      selected: true,
    });
  });

  it('leaves no selected provider when the final selection write fails', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    await save('anthropic', ANTHROPIC_KEY);
    let writes = 0;
    crypto.setSecret.mockImplementation(async (key: string, value: string) => {
      writes += 1;
      if (writes === 2) throw new Error(`must not surface ${OPENAI_KEY}`);
      crypto.__keychain.set(key, value);
    });

    await expect(service.selectWritingProvider('openai')).resolves.toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    crypto.setSecret.mockImplementation(async (key: string, value: string) => {
      crypto.__keychain.set(key, value);
    });
    await expect(service.getWritingConnections()).resolves.toMatchObject({
      status: 'completed',
      state: { selected: null },
    });
  });

  it('maps secure-store failures to a fixed local reason', async () => {
    arm();
    crypto.getSecret.mockRejectedValueOnce(new Error(`raw ${OPENAI_KEY}`));
    const result = await service.getWritingConnections();
    expect(result).toEqual({ status: 'failed', reason: 'storage_unavailable' });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it('clears both fixed keys before access exists, even if one deletion fails', async () => {
    crypto.__keychain.set(OPENAI_KEY_NAME, record(OWNER, OPENAI_KEY, true));
    crypto.__keychain.set(
      ANTHROPIC_KEY_NAME,
      record(OWNER, ANTHROPIC_KEY, false),
    );
    crypto.deleteSecret.mockImplementation(async (key: string) => {
      if (key === OPENAI_KEY_NAME) throw new Error(`raw ${OPENAI_KEY}`);
      crypto.__keychain.delete(key);
    });

    const result = await service.clearWritingConnections();

    expect(result).toEqual({ status: 'failed', reason: 'storage_unavailable' });
    expect(crypto.deleteSecret).toHaveBeenCalledWith(OPENAI_KEY_NAME);
    expect(crypto.deleteSecret).toHaveBeenCalledWith(ANTHROPIC_KEY_NAME);
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it('makes lifecycle cleanup a storage no-op in duress', async () => {
    session.setMode('duress');
    await expect(service.clearWritingConnections()).resolves.toEqual({
      status: 'completed',
    });
    expect(crypto.deleteSecret).not.toHaveBeenCalled();
    expect(crypto.getSecret).not.toHaveBeenCalled();
  });

  it('clear revokes account access synchronously while preserving foreground state', async () => {
    arm();
    const before = service.getWritingRevision();

    const clearing = service.clearWritingConnections();

    expect(service.getWritingRevision()).toBe(before + 1);
    await expect(
      service.saveWritingConnection('openai', OPENAI_KEY),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'not_allowed',
    });
    await expect(clearing).resolves.toEqual({ status: 'completed' });
    service.setWritingAccess(OWNER);
    await expect(service.getWritingConnections()).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('does not begin a queued Keychain deletion after the session becomes duress', async () => {
    arm();
    const held = deferred<void>();
    crypto.setSecret.mockImplementationOnce(
      async (key: string, value: string) => {
        await held.promise;
        crypto.__keychain.set(key, value);
      },
    );
    const saving = service.saveWritingConnection('openai', OPENAI_KEY);
    await until(() => crypto.setSecret.mock.calls.length === 1);
    const clearing = service.clearWritingConnections();

    session.setMode('duress');
    held.resolve(undefined);

    await expect(saving).resolves.toEqual({
      status: 'failed',
      reason: 'stale',
    });
    await expect(clearing).resolves.toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    expect(crypto.deleteSecret).not.toHaveBeenCalled();
  });

  it('stops clear before its next deletion if duress begins during an earlier native delete', async () => {
    const first = deferred<void>();
    crypto.deleteSecret.mockImplementationOnce(() => first.promise);
    const clearing = service.clearWritingConnections();
    await until(() => crypto.deleteSecret.mock.calls.length === 1);

    session.setMode('duress');
    first.resolve(undefined);

    await expect(clearing).resolves.toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    expect(crypto.deleteSecret).toHaveBeenCalledTimes(1);
  });
});

describe('provider requests', () => {
  it('sends only the masked draft and fixed writing fields to OpenAI', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    installFetch(jest.fn(async () => response(200, openAiAnswer())));

    await expect(
      service.generateWriting({
        draft: 'Hi [[TACENDUM_MENTION_0_0]], can we meet?',
        action: { kind: 'shorter' },
      }),
    ).resolves.toEqual({ status: 'completed', text: 'Clearer words.' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-4.1-mini-2025-04-14',
      instructions: expect.stringContaining('Make the draft shorter'),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Hi [[TACENDUM_MENTION_0_0]], can we meet?',
            },
          ],
        },
      ],
      max_output_tokens: 4096,
      store: false,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the fixed Anthropic endpoint and completes only an end-turn text', async () => {
    arm();
    await save('anthropic', ANTHROPIC_KEY);
    installFetch(jest.fn(async () => response(200, anthropicAnswer())));

    await expect(
      service.generateWriting({
        draft: 'Thank you for your patience.',
        action: { kind: 'translate', language: 'fr' },
      }),
    ).resolves.toEqual({ status: 'completed', text: 'Warmer words.' });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': ANTHROPIC_KEY,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: expect.stringContaining('Translate the draft into French'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Thank you for your patience.' }],
        },
      ],
    });
  });

  it.each([
    [401, 'authentication'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ])(
    'maps HTTP %i without reading or surfacing the provider body',
    async (status, reason) => {
      arm();
      await save('openai', OPENAI_KEY);
      const raw = response(status, { error: `contains ${OPENAI_KEY}` });
      installFetch(jest.fn(async () => raw));

      const result = await service.generateWriting({
        draft: 'hello',
        action: { kind: 'improve' },
      });

      expect(result).toEqual({ status: 'failed', reason });
      expect(raw.json).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
    },
  );

  it('maps a raw network rejection to a fixed reason without logging it', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    installFetch(
      jest.fn(async () => {
        throw new Error(`draft and ${OPENAI_KEY}`);
      }),
    );

    const result = await service.generateWriting({
      draft: 'private draft',
      action: { kind: 'improve' },
    });

    expect(result).toEqual({ status: 'failed', reason: 'network' });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('maps an unreadable success body to invalid response rather than a raw network error', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    installFetch(
      jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error(`unparseable body containing ${OPENAI_KEY}`);
        },
      })),
    );

    const result = await service.generateWriting({
      draft: 'private draft',
      action: { kind: 'improve' },
    });

    expect(result).toEqual({ status: 'failed', reason: 'invalid_response' });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it('rejects an invalid request before reading the selected key', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    crypto.getSecret.mockClear();

    await expect(
      service.generateWriting({ draft: '', action: { kind: 'improve' } }),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_request' });
    await expect(
      service.generateWriting({
        draft: 'hello',
        action: { kind: 'translate', language: 'invented language' },
      } as never),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_request' });
    expect(crypto.getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a stalled provider request at the 30-second deadline', async () => {
    jest.useFakeTimers();
    arm();
    await save('openai', OPENAI_KEY);
    installFetch(
      jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      ),
    );
    let settled = false;
    const call = service
      .generateWriting({ draft: 'hello', action: { kind: 'improve' } })
      .finally(() => {
        settled = true;
      });
    await until(() => fetchMock.mock.calls.length === 1);

    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(call).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
    });
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('maps caller cancellation separately from a deadline', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    installFetch(
      jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const call = service.generateWriting(
      { draft: 'hello', action: { kind: 'improve' } },
      controller.signal,
    );
    await until(() => fetchMock.mock.calls.length === 1);

    controller.abort();

    await expect(call).resolves.toEqual({
      status: 'failed',
      reason: 'cancelled',
    });
  });

  it('caller cancellation returns while a native key read remains pending', async () => {
    crypto.__keychain.set(OPENAI_KEY_NAME, record(OWNER, OPENAI_KEY, true));
    arm();
    const held = deferred<string | null>();
    crypto.getSecret.mockImplementationOnce(() => held.promise);
    const controller = new AbortController();
    const call = service.generateWriting(
      { draft: 'hello', action: { kind: 'improve' } },
      controller.signal,
    );
    await until(() => crypto.getSecret.mock.calls.length === 1);

    controller.abort();
    const observed = await Promise.race([
      call,
      new Promise<'still-pending'>(resolve =>
        setTimeout(() => resolve('still-pending'), 10),
      ),
    ]);
    held.resolve(record(OWNER, OPENAI_KEY, true));
    await call;

    expect(observed).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the 30-second deadline includes a pending native key read', async () => {
    jest.useFakeTimers();
    crypto.__keychain.set(OPENAI_KEY_NAME, record(OWNER, OPENAI_KEY, true));
    arm();
    const held = deferred<string | null>();
    crypto.getSecret.mockImplementationOnce(() => held.promise);
    let atDeadline: unknown;
    const call = service.generateWriting({
      draft: 'hello',
      action: { kind: 'improve' },
    });
    void call.then(result => {
      atDeadline = result;
    });
    await until(() => crypto.getSecret.mock.calls.length === 1);

    await jest.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    const captured = atDeadline;
    held.resolve(record(OWNER, OPENAI_KEY, true));
    service.invalidateWritingSession();
    await call;

    expect(captured).toEqual({ status: 'failed', reason: 'timeout' });
    expect(crypto.getSecret).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('lifecycle and mutation races', () => {
  it('drops a key returned after the account was invalidated', async () => {
    crypto.__keychain.set(OPENAI_KEY_NAME, record(OWNER, OPENAI_KEY, true));
    arm();
    const held = deferred<string | null>();
    crypto.getSecret.mockImplementationOnce(() => held.promise);
    const call = service.generateWriting({
      draft: 'hello',
      action: { kind: 'improve' },
    });
    await until(() => crypto.getSecret.mock.calls.length === 1);

    service.invalidateWritingSession();
    held.resolve(record(OWNER, OPENAI_KEY, true));

    await expect(call).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a provider response that completes after backgrounding', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    const held = deferred<Response>();
    installFetch(jest.fn(() => held.promise));
    const call = service.generateWriting({
      draft: 'hello',
      action: { kind: 'improve' },
    });
    await until(() => fetchMock.mock.calls.length === 1);
    const revision = service.getWritingRevision();

    service.setWritingForeground(false);
    expect(service.getWritingRevision()).toBe(revision + 1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(
      true,
    );
    held.resolve(response(200, openAiAnswer('must never apply')));

    await expect(call).resolves.toEqual({ status: 'failed', reason: 'stale' });
  });

  it('lets a later request supersede an earlier completion', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    const first = deferred<Response>();
    installFetch(
      jest
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(response(200, openAiAnswer('second result'))),
    );
    const oldCall = service.generateWriting({
      draft: 'old',
      action: { kind: 'improve' },
    });
    await until(() => fetchMock.mock.calls.length === 1);

    const newCall = service.generateWriting({
      draft: 'new',
      action: { kind: 'warmer' },
    });
    await until(() => fetchMock.mock.calls.length === 2);
    first.resolve(response(200, openAiAnswer('old result')));

    await expect(oldCall).resolves.toEqual({
      status: 'failed',
      reason: 'cancelled',
    });
    await expect(newCall).resolves.toEqual({
      status: 'completed',
      text: 'second result',
    });
  });

  it('serializes a delayed save before lifecycle clear so the key ends absent', async () => {
    arm();
    const held = deferred<void>();
    crypto.setSecret.mockImplementationOnce(
      async (key: string, value: string) => {
        await held.promise;
        crypto.__keychain.set(key, value);
      },
    );
    const saving = service.saveWritingConnection('openai', OPENAI_KEY);
    await until(() => crypto.setSecret.mock.calls.length === 1);

    service.invalidateWritingSession();
    const clearing = service.clearWritingConnections();
    held.resolve(undefined);

    await expect(saving).resolves.toEqual({
      status: 'failed',
      reason: 'stale',
    });
    await expect(clearing).resolves.toEqual({ status: 'completed' });
    expect(crypto.__keychain.has(OPENAI_KEY_NAME)).toBe(false);
    expect(crypto.__keychain.has(ANTHROPIC_KEY_NAME)).toBe(false);
  });

  it('serializes a delayed save before remove so the key cannot resurrect', async () => {
    arm();
    const held = deferred<void>();
    crypto.setSecret.mockImplementationOnce(
      async (key: string, value: string) => {
        await held.promise;
        crypto.__keychain.set(key, value);
      },
    );
    const saving = service.saveWritingConnection('openai', OPENAI_KEY);
    await until(() => crypto.setSecret.mock.calls.length === 1);
    const removing = service.removeWritingConnection('openai');
    held.resolve(undefined);

    await expect(saving).resolves.toEqual({
      status: 'failed',
      reason: 'stale',
    });
    await expect(removing).resolves.toMatchObject({
      status: 'completed',
      state: { providers: { openai: { configured: false } } },
    });
    expect(crypto.__keychain.has(OPENAI_KEY_NAME)).toBe(false);
  });

  it('credential rotation aborts an active request before storage settles', async () => {
    arm();
    await save('openai', OPENAI_KEY);
    installFetch(
      jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      ),
    );
    const call = service.generateWriting({
      draft: 'hello',
      action: { kind: 'improve' },
    });
    await until(() => fetchMock.mock.calls.length === 1);
    const storage = deferred<void>();
    crypto.setSecret.mockImplementationOnce(() => storage.promise);
    const before = service.getWritingRevision();

    const rotating = service.saveWritingConnection(
      'openai',
      'sk-openai-rotated',
    );

    expect(service.getWritingRevision()).toBe(before + 1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(
      true,
    );
    await expect(call).resolves.toEqual({ status: 'failed', reason: 'stale' });
    storage.resolve(undefined);
    await expect(rotating).resolves.toMatchObject({ status: 'completed' });
  });
});
