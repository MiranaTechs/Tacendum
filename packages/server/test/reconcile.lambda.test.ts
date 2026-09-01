import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';

/**
 * The quota-ledger reconcile WORKER: the durable
 * out-of-band half of the repair the refusal path now only schedules. One
 * leased, budgeted slice per invocation via db.reconcileQueueLedger, and a
 * self-invoked continuation while work remains — hop-capped so a chain can
 * never become unbounded invoke amplification.
 */

const { reconcileMock, lambdaSendMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(),
  lambdaSendMock: vi.fn(),
}));

// The worker builds its data layer directly (doc client + makeDataLayer);
// mock the factory so the slice outcome is scriptable and no client dials.
vi.mock('../src/db/data.js', () => ({
  makeDataLayer: (): unknown => ({ reconcileQueueLedger: reconcileMock }),
}));
vi.mock('../src/db/client.js', () => ({ makeDocClient: (): unknown => ({}) }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    readonly input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array };
    constructor(input: {
      FunctionName?: string;
      InvocationType?: string;
      Payload?: Uint8Array;
    }) {
      this.input = input;
    }
  },
}));

import { handler, RECONCILE_MAX_HOPS, type LedgerReconcileEvent } from '../src/aws/reconcile.lambda.js';

function continuationPayload(): Record<string, unknown> | undefined {
  const cmd = lambdaSendMock.mock.calls.at(-1)?.[0] as
    | { input?: { Payload?: Uint8Array } }
    | undefined;
  if (!cmd?.input?.Payload) return undefined;
  return JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8')) as Record<string, unknown>;
}

const pairEvent: LedgerReconcileEvent = {
  recipientId: 'R',
  target: { kind: 'pair', senderId: 'S' },
};

beforeEach(() => {
  vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'ReconcileFn-test');
  reconcileMock.mockReset();
  lambdaSendMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reconcile worker', () => {
  it('runs one slice for the event target and stops when the repair completed', async () => {
    reconcileMock.mockResolvedValue('complete');
    await handler(pairEvent);
    expect(reconcileMock).toHaveBeenCalledWith('R', { kind: 'pair', senderId: 'S' });
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('stands down without a continuation when another reconciler holds the lease', async () => {
    reconcileMock.mockResolvedValue('stood_down');
    await handler(pairEvent);
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('self-invokes the next slice while work remains, carrying the hop count', async () => {
    reconcileMock.mockResolvedValue('continue');
    await handler(pairEvent);
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const cmd = lambdaSendMock.mock.calls[0]![0] as {
      input: { FunctionName?: string; InvocationType?: string };
    };
    expect(cmd.input.FunctionName).toBe('ReconcileFn-test');
    expect(cmd.input.InvocationType).toBe('Event');
    expect(continuationPayload()).toEqual({
      recipientId: 'R',
      target: { kind: 'pair', senderId: 'S' },
      hop: 1,
    });

    // The stranger target continues identically.
    lambdaSendMock.mockClear();
    await handler({ recipientId: 'R', target: { kind: 'stranger' }, hop: 3 });
    expect(continuationPayload()).toEqual({
      recipientId: 'R',
      target: { kind: 'stranger' },
      hop: 4,
    });
  });

  it('clamps a hop count that is not a whole number at or above zero', async () => {
    // HARDENING, not a live defect — and the distinction is worth writing
    // down. `ReconcileFn` is invocable by exactly two principals: the WS
    // execution role, whose payload is minted as `{recipientId, target}` with
    // no `hop` at all, and the function itself, which always computes an
    // integer. JSON cannot transport NaN or Infinity, so the only hostile
    // values are negatives and fractions, and minting one requires already
    // holding those roles' credentials.
    //
    // The arithmetic accepted them verbatim anyway: `hop: -1e9` would need a
    // billion continuations to reach the cap, and a fraction never lands on
    // it exactly. Cheap to make structurally impossible, so it is.
    reconcileMock.mockResolvedValue('continue');

    await handler({ ...pairEvent, hop: -1_000 });
    expect(continuationPayload()).toMatchObject({ hop: 1 });

    lambdaSendMock.mockClear();
    await handler({ ...pairEvent, hop: 2.5 });
    expect(continuationPayload()).toMatchObject({ hop: 1 });
  });

  it('caps the continuation chain and logs loudly instead of self-invoking forever', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    reconcileMock.mockResolvedValue('continue');
    await handler({ ...pairEvent, hop: RECONCILE_MAX_HOPS - 1 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('ledger_reconcile_hops_exhausted', {
      hops: RECONCILE_MAX_HOPS,
    });
  });

  it('drops a malformed event without touching the data layer', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await handler({} as LedgerReconcileEvent);
    await handler({ recipientId: 'R', target: { kind: 'pair' } } as never);
    await handler({ recipientId: '', target: { kind: 'stranger' } });
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('ledger_reconcile_bad_event', {});
  });

  it('lets a failed slice throw, so the async-invoke retry re-runs it', async () => {
    reconcileMock.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'Throttling' }));
    await expect(handler(pairEvent)).rejects.toThrow('throttled');
  });

  it('logs a failed continuation loudly and rethrows (the posture)', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    reconcileMock.mockResolvedValue('continue');
    lambdaSendMock.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    await expect(handler(pairEvent)).rejects.toThrow('denied');
    expect(errorSpy).toHaveBeenCalledWith('ledger_reconcile_continuation_failed', {
      error: 'AccessDeniedException',
    });
  });

  it('outside Lambda (no function name) a continuation is a silent no-op, not a failure', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    reconcileMock.mockResolvedValue('continue');
    await expect(handler(pairEvent)).resolves.toBeUndefined();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});
