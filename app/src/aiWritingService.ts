import { deleteSecret, getSecret, setSecret } from 'tacendum-crypto';
import {
  AI_WRITING_MAX_OUTPUT_TOKENS,
  AI_WRITING_TIMEOUT_MS,
  ANTHROPIC_WRITING_MODEL,
  OPENAI_WRITING_MODEL,
  aiWritingInstructions,
  isAiWritingProvider,
  parseAnthropicWritingResponse,
  parseOpenAiWritingResponse,
  validateAiWritingRequest,
  type AiWritingClearResult,
  type AiWritingConnectionResult,
  type AiWritingConnectionState,
  type AiWritingProvider,
  type AiWritingRequest,
  type AiWritingResult,
} from './aiWriting';
import { session } from './session';

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const API_KEY_MAX = 512;

/** Fixed names let reinstall/account deletion erase every credential without
 * first reading account state. Both fit Android's native secret-name gate. */
const SECRET_NAMES: Record<AiWritingProvider, string> = {
  openai: 'aiWriting.openai',
  anthropic: 'aiWriting.anthropic',
};

interface StoredConnection {
  v: 1;
  ownerId: string;
  key: string;
  selected: boolean;
}

type StoredConnections = Record<AiWritingProvider, StoredConnection | null>;

interface AccessSnapshot {
  ownerId: string;
  revision: number;
}

let accessOwnerId: string | null = null;
let foreground = false;
let revision = 0;
let requestSequence = 0;
let activeRequest: { id: number; controller: AbortController } | null = null;

/** All reads and writes of our two records share one lane. A mutation invoked
 * later revokes earlier work synchronously, then queues behind any native call
 * already in flight, so its final write/delete is also the final state. */
let storageTail: Promise<void> = Promise.resolve();

function serializeStorage<T>(work: () => Promise<T>): Promise<T> {
  const result = storageTail.then(work, work);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function abortActive(): void {
  if (activeRequest !== null) {
    activeRequest.controller.abort();
    activeRequest = null;
  }
}

function revokePending(): void {
  revision += 1;
  abortActive();
}

function allowedSnapshot(): AccessSnapshot | null {
  return session.mode === 'real' && foreground && accessOwnerId !== null
    ? { ownerId: accessOwnerId, revision }
    : null;
}

function accessStillCurrent(snapshot: AccessSnapshot): boolean {
  return (
    session.mode === 'real' &&
    foreground &&
    accessOwnerId === snapshot.ownerId &&
    revision === snapshot.revision
  );
}

export function setWritingAccess(accountId: string | null): void {
  const next =
    typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  if (next === accessOwnerId) return;
  revokePending();
  accessOwnerId = next;
}

export function setWritingForeground(active: boolean): void {
  if (active === foreground) return;
  foreground = active;
  if (!active) revokePending();
}

/** Relock/workspace teardown. Foreground remains an independent AppState fact. */
export function invalidateWritingSession(): void {
  revokePending();
  accessOwnerId = null;
}

/** Synchronous token a composer review captures and rechecks before Use text. */
export function getWritingRevision(): number {
  return revision;
}

function normalizedApiKey(value: string): string | null {
  const key = value.trim();
  // Provider credentials are printable ASCII. This also prevents header
  // delimiter injection without trying to infer a provider's prefix format.
  return key.length > 0 && key.length <= API_KEY_MAX && /^[!-~]+$/.test(key)
    ? key
    : null;
}

function parseStoredConnection(
  raw: string,
  ownerId: string,
): StoredConnection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const candidate = parsed as Partial<StoredConnection>;
  if (
    candidate.v !== 1 ||
    candidate.ownerId !== ownerId ||
    typeof candidate.key !== 'string' ||
    normalizedApiKey(candidate.key) !== candidate.key ||
    typeof candidate.selected !== 'boolean'
  ) {
    return null;
  }
  return candidate as StoredConnection;
}

type ReadOneResult =
  | { status: 'completed'; connection: StoredConnection | null }
  | { status: 'failed'; reason: 'storage_unavailable' | 'stale' };

async function readOne(
  provider: AiWritingProvider,
  snapshot: AccessSnapshot,
  stillCurrent: () => boolean = () => accessStillCurrent(snapshot),
): Promise<ReadOneResult> {
  // Recheck before every native read as well as after it. A prior provider
  // read or a queued storage operation may have crossed a relock/revocation.
  if (!stillCurrent()) return { status: 'failed', reason: 'stale' };
  let raw: string | null;
  try {
    raw = await getSecret(SECRET_NAMES[provider]);
  } catch {
    return { status: 'failed', reason: 'storage_unavailable' };
  }
  if (!stillCurrent()) return { status: 'failed', reason: 'stale' };
  if (raw === null) return { status: 'completed', connection: null };
  const connection = parseStoredConnection(raw, snapshot.ownerId);
  if (connection !== null) return { status: 'completed', connection };

  // A malformed or differently owned record must never become configured for
  // this account. Best-effort removal prevents repeated stale reads; failure
  // is surfaced only as the local storage category, never with native text.
  try {
    await deleteSecret(SECRET_NAMES[provider]);
  } catch {
    return { status: 'failed', reason: 'storage_unavailable' };
  }
  if (!stillCurrent()) return { status: 'failed', reason: 'stale' };
  return { status: 'completed', connection: null };
}

type ReadBothResult =
  | { status: 'completed'; connections: StoredConnections }
  | { status: 'failed'; reason: 'storage_unavailable' | 'stale' };

async function readBoth(
  snapshot: AccessSnapshot,
  stillCurrent: () => boolean = () => accessStillCurrent(snapshot),
): Promise<ReadBothResult> {
  const openai = await readOne('openai', snapshot, stillCurrent);
  if (openai.status === 'failed') return openai;
  const anthropic = await readOne('anthropic', snapshot, stillCurrent);
  if (anthropic.status === 'failed') return anthropic;
  return {
    status: 'completed',
    connections: {
      openai: openai.connection,
      anthropic: anthropic.connection,
    },
  };
}

function selectedProvider(
  connections: StoredConnections,
): AiWritingProvider | null {
  const selected = (Object.keys(connections) as AiWritingProvider[]).filter(
    provider => connections[provider]?.selected === true,
  );
  return selected.length === 1 ? selected[0]! : null;
}

function publicState(connections: StoredConnections): AiWritingConnectionState {
  return {
    selected: selectedProvider(connections),
    providers: {
      openai: { configured: connections.openai !== null },
      anthropic: { configured: connections.anthropic !== null },
    },
  };
}

function connectionFailure(
  reason: 'storage_unavailable' | 'stale',
): AiWritingConnectionResult {
  return { status: 'failed', reason };
}

export function getWritingConnections(): Promise<AiWritingConnectionResult> {
  const snapshot = allowedSnapshot();
  if (snapshot === null) {
    return Promise.resolve({ status: 'failed', reason: 'not_allowed' });
  }
  return serializeStorage(async () => {
    if (!accessStillCurrent(snapshot))
      return { status: 'failed', reason: 'stale' };
    const read = await readBoth(snapshot);
    return read.status === 'failed'
      ? connectionFailure(read.reason)
      : { status: 'completed', state: publicState(read.connections) };
  });
}

async function writeConnection(
  provider: AiWritingProvider,
  connection: StoredConnection,
  snapshot: AccessSnapshot,
): Promise<'completed' | 'storage_unavailable' | 'stale'> {
  if (!accessStillCurrent(snapshot)) return 'stale';
  try {
    await setSecret(SECRET_NAMES[provider], JSON.stringify(connection));
  } catch {
    return 'storage_unavailable';
  }
  return accessStillCurrent(snapshot) ? 'completed' : 'stale';
}

function mutationSnapshot(): AccessSnapshot | null {
  if (allowedSnapshot() === null) return null;
  revokePending();
  return allowedSnapshot();
}

export function saveWritingConnection(
  provider: AiWritingProvider,
  apiKey: string,
): Promise<AiWritingConnectionResult> {
  const before = allowedSnapshot();
  if (before === null)
    return Promise.resolve({ status: 'failed', reason: 'not_allowed' });
  if (!isAiWritingProvider(provider)) {
    return Promise.resolve({ status: 'failed', reason: 'not_configured' });
  }
  const key = normalizedApiKey(apiKey);
  if (key === null)
    return Promise.resolve({ status: 'failed', reason: 'invalid_key' });
  const snapshot = mutationSnapshot()!;

  return serializeStorage(async () => {
    if (!accessStillCurrent(snapshot))
      return { status: 'failed', reason: 'stale' };
    const read = await readBoth(snapshot);
    if (read.status === 'failed') return connectionFailure(read.reason);
    const connections = read.connections;
    const other: AiWritingProvider =
      provider === 'openai' ? 'anthropic' : 'openai';
    const oldSelected = connections[other];
    if (oldSelected?.selected === true) {
      const deselected = { ...oldSelected, selected: false };
      const written = await writeConnection(other, deselected, snapshot);
      if (written !== 'completed') return connectionFailure(written);
      connections[other] = deselected;
    }
    const saved: StoredConnection = {
      v: 1,
      ownerId: snapshot.ownerId,
      key,
      selected: true,
    };
    const written = await writeConnection(provider, saved, snapshot);
    if (written !== 'completed') return connectionFailure(written);
    connections[provider] = saved;
    return { status: 'completed', state: publicState(connections) };
  });
}

export function removeWritingConnection(
  provider: AiWritingProvider,
): Promise<AiWritingConnectionResult> {
  if (allowedSnapshot() === null) {
    return Promise.resolve({ status: 'failed', reason: 'not_allowed' });
  }
  if (!isAiWritingProvider(provider)) {
    return Promise.resolve({ status: 'failed', reason: 'not_configured' });
  }
  const snapshot = mutationSnapshot()!;
  return serializeStorage(async () => {
    if (!accessStillCurrent(snapshot))
      return { status: 'failed', reason: 'stale' };
    const read = await readBoth(snapshot);
    if (read.status === 'failed') return connectionFailure(read.reason);
    try {
      await deleteSecret(SECRET_NAMES[provider]);
    } catch {
      return { status: 'failed', reason: 'storage_unavailable' };
    }
    if (!accessStillCurrent(snapshot))
      return { status: 'failed', reason: 'stale' };
    read.connections[provider] = null;
    return { status: 'completed', state: publicState(read.connections) };
  });
}

export function selectWritingProvider(
  provider: AiWritingProvider,
): Promise<AiWritingConnectionResult> {
  if (allowedSnapshot() === null) {
    return Promise.resolve({ status: 'failed', reason: 'not_allowed' });
  }
  if (!isAiWritingProvider(provider)) {
    return Promise.resolve({ status: 'failed', reason: 'not_configured' });
  }
  const snapshot = mutationSnapshot()!;
  return serializeStorage(async () => {
    if (!accessStillCurrent(snapshot))
      return { status: 'failed', reason: 'stale' };
    const read = await readBoth(snapshot);
    if (read.status === 'failed') return connectionFailure(read.reason);
    const connections = read.connections;
    const chosen = connections[provider];
    if (chosen === null) return { status: 'failed', reason: 'not_configured' };

    for (const candidate of Object.keys(connections) as AiWritingProvider[]) {
      if (candidate === provider) continue;
      const connection = connections[candidate];
      if (connection?.selected !== true) continue;
      const deselected = { ...connection, selected: false };
      const written = await writeConnection(candidate, deselected, snapshot);
      if (written !== 'completed') return connectionFailure(written);
      connections[candidate] = deselected;
    }
    if (!chosen.selected) {
      const selected = { ...chosen, selected: true };
      const written = await writeConnection(provider, selected, snapshot);
      if (written !== 'completed') return connectionFailure(written);
      connections[provider] = selected;
    }
    return { status: 'completed', state: publicState(connections) };
  });
}

/**
 * Lifecycle-only cleanup. It deliberately bypasses account/foreground access
 * so iOS reinstall cleanup can run before a workspace opens, but duress never
 * touches the real Keychain. Every fixed key is attempted even after failure.
 */
export function clearWritingConnections(): Promise<AiWritingClearResult> {
  invalidateWritingSession();
  if (session.mode === 'duress')
    return Promise.resolve({ status: 'completed' });
  return serializeStorage(async () => {
    let failed = false;
    for (const provider of ['openai', 'anthropic'] as const) {
      // A real-session cleanup can sit behind a native write. If the app has
      // entered duress while it waited, never begin another Keychain call.
      if (session.mode !== 'real') {
        failed = true;
        break;
      }
      try {
        await deleteSecret(SECRET_NAMES[provider]);
      } catch {
        failed = true;
      }
    }
    if (session.mode !== 'real') failed = true;
    return failed
      ? { status: 'failed', reason: 'storage_unavailable' }
      : { status: 'completed' };
  });
}

type ProviderOutcome =
  | { kind: 'response'; body: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'invalid' };

function providerRequest(
  provider: AiWritingProvider,
  key: string,
  request: AiWritingRequest,
  instructions: string,
  signal: AbortSignal,
): Promise<ProviderOutcome> {
  const openai = provider === 'openai';
  const url = openai ? OPENAI_URL : ANTHROPIC_URL;
  const headers: Record<string, string> = openai
    ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': key,
      };
  const body = openai
    ? {
        model: OPENAI_WRITING_MODEL,
        instructions,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: request.draft }],
          },
        ],
        max_output_tokens: AI_WRITING_MAX_OUTPUT_TOKENS,
        store: false,
      }
    : {
        model: ANTHROPIC_WRITING_MODEL,
        max_tokens: AI_WRITING_MAX_OUTPUT_TOKENS,
        system: instructions,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: request.draft }],
          },
        ],
      };

  return (async () => {
    const answer = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!answer.ok) return { kind: 'http', status: answer.status };
    try {
      return { kind: 'response', body: await answer.json() };
    } catch {
      // Headers arrived, so this is a malformed/truncated provider response,
      // not the offline/DNS category. Raw parser text remains quarantined.
      return { kind: 'invalid' };
    }
  })();
}

function httpFailure(status: number): AiWritingResult {
  if (status === 401 || status === 403) {
    return { status: 'failed', reason: 'authentication' };
  }
  if (status === 429) return { status: 'failed', reason: 'rate_limited' };
  if (status >= 500 && status <= 599) {
    return { status: 'failed', reason: 'provider_unavailable' };
  }
  return { status: 'failed', reason: 'invalid_response' };
}

type CredentialResult =
  | { status: 'completed'; provider: AiWritingProvider; key: string }
  | {
      status: 'failed';
      reason: 'not_configured' | 'storage_unavailable' | 'stale';
    };

async function selectedCredential(
  snapshot: AccessSnapshot,
  stillCurrent: () => boolean,
): Promise<CredentialResult> {
  const read = await readBoth(snapshot, stillCurrent);
  if (read.status === 'failed') return read;
  const provider = selectedProvider(read.connections);
  if (provider === null) return { status: 'failed', reason: 'not_configured' };
  return {
    status: 'completed',
    provider,
    key: read.connections[provider]!.key,
  };
}

function requestState(
  snapshot: AccessSnapshot,
  id: number,
  callerSignal?: AbortSignal,
): 'current' | 'stale' | 'cancelled' {
  if (!accessStillCurrent(snapshot)) return 'stale';
  if (id !== requestSequence || callerAborted(callerSignal)) return 'cancelled';
  return 'current';
}

function callerAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function generateWriting(
  request: AiWritingRequest,
  callerSignal?: AbortSignal,
): Promise<AiWritingResult> {
  const snapshot = allowedSnapshot();
  if (snapshot === null) return { status: 'failed', reason: 'not_allowed' };
  if (!validateAiWritingRequest(request)) {
    return { status: 'failed', reason: 'invalid_request' };
  }
  if (callerAborted(callerSignal))
    return { status: 'failed', reason: 'cancelled' };
  const instructions = aiWritingInstructions(request.action)!;

  const id = ++requestSequence;
  abortActive();
  const controller = new AbortController();
  activeRequest = { id, controller };
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerAborted(callerSignal)) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_WRITING_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  // Race the abort itself as well as passing its signal to fetch. React
  // Native fetch normally rejects on abort; the race also bounds a platform
  // response whose json() has started but stops settling.
  const ABORTED = Symbol('aborted');
  const aborted = new Promise<typeof ABORTED>(resolve => {
    if (controller.signal.aborted) {
      resolve(ABORTED);
      return;
    }
    controller.signal.addEventListener('abort', () => resolve(ABORTED), {
      once: true,
    });
  });

  try {
    const interrupted = (): AiWritingResult | null => {
      const state = requestState(snapshot, id, callerSignal);
      if (state !== 'current') return { status: 'failed', reason: state };
      if (timedOut) return { status: 'failed', reason: 'timeout' };
      if (controller.signal.aborted)
        return { status: 'failed', reason: 'cancelled' };
      return null;
    };
    const operationCurrent = (): boolean =>
      requestState(snapshot, id, callerSignal) === 'current' &&
      !controller.signal.aborted;
    const credentialPending = serializeStorage(async () => {
      if (!operationCurrent())
        return { status: 'failed', reason: 'stale' } as const;
      return selectedCredential(snapshot, operationCurrent);
    });
    const credentialOrAbort = await Promise.race([credentialPending, aborted]);
    if (credentialOrAbort === ABORTED) {
      return interrupted() ?? { status: 'failed', reason: 'cancelled' };
    }
    const credential = credentialOrAbort;
    const interruptedBeforeFetch = interrupted();
    if (interruptedBeforeFetch !== null) return interruptedBeforeFetch;
    if (credential.status === 'failed') {
      const state = requestState(snapshot, id, callerSignal);
      return {
        status: 'failed',
        reason: state === 'current' ? credential.reason : state,
      };
    }

    let outcome: ProviderOutcome | typeof ABORTED;
    try {
      outcome = await Promise.race([
        providerRequest(
          credential.provider,
          credential.key,
          request,
          instructions,
          controller.signal,
        ),
        aborted,
      ]);
    } catch {
      const stopped = interrupted();
      if (stopped !== null) return stopped;
      return { status: 'failed', reason: 'network' };
    }

    if (outcome === ABORTED) {
      return interrupted() ?? { status: 'failed', reason: 'cancelled' };
    }
    const stopped = interrupted();
    if (stopped !== null) return stopped;
    if (outcome.kind === 'http') return httpFailure(outcome.status);
    if (outcome.kind === 'invalid') {
      return { status: 'failed', reason: 'invalid_response' };
    }
    return credential.provider === 'openai'
      ? parseOpenAiWritingResponse(outcome.body)
      : parseAnthropicWritingResponse(outcome.body);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    if (activeRequest?.id === id) activeRequest = null;
    // Retire this operation so a native read that ignored cancellation cannot
    // progress to another secret read after it eventually settles.
    if (requestSequence === id) requestSequence += 1;
  }
}
