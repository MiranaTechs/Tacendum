import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import { makeReconcileScheduler } from '../src/aws/deps.js';

/**
 * The DURABLE quota-repair handoff: the hook the
 * AWS host injects into the data layer. Its contract:
 *  - an async (Event) invoke of the reconcile worker, carrying ONLY the
 *    request discriminator (ids + kind, never a key or filter);
 *  - a missing function name is LOUD and thrown — a deployment that lost the
 *    wiring must announce itself on every refusal, not silently downgrade to
 *    the floating promise this design replaces;
 *  - an invoke failure is logged (error CLASS only) and
 *    rethrown; the data layer catches it, so the sender's 429 stands.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const req = { recipientId: 'R', target: { kind: 'pair', senderId: 'S' } } as const;

describe('makeReconcileScheduler', () => {
  it('async-invokes the reconcile worker with the serialized request', async () => {
    const sent: Array<{ FunctionName?: string; InvocationType?: string; Payload?: Uint8Array }> =
      [];
    const scheduler = makeReconcileScheduler(
      { RECONCILE_FUNCTION_NAME: 'ReconcileFn-abc' } as NodeJS.ProcessEnv,
      async (cmd) => {
        sent.push((cmd as unknown as { input: (typeof sent)[number] }).input);
        return {};
      },
    );
    await scheduler(req);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.FunctionName).toBe('ReconcileFn-abc');
    expect(sent[0]!.InvocationType).toBe('Event');
    expect(JSON.parse(Buffer.from(sent[0]!.Payload!).toString('utf8'))).toEqual(req);
  });

  it('a missing RECONCILE_FUNCTION_NAME is loud and thrown, never a silent downgrade', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const scheduler = makeReconcileScheduler({} as NodeJS.ProcessEnv, async () => ({}));
    await expect(scheduler(req)).rejects.toThrow('RECONCILE_FUNCTION_NAME');
    expect(errorSpy).toHaveBeenCalledWith('ledger_reconcile_unwired', {
      missing: 'RECONCILE_FUNCTION_NAME',
    });
  });

  it('logs an invoke failure by error class only, then rethrows', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const scheduler = makeReconcileScheduler(
      { RECONCILE_FUNCTION_NAME: 'ReconcileFn-abc' } as NodeJS.ProcessEnv,
      async () => {
        throw Object.assign(new Error('nope'), { name: 'ThrottlingException' });
      },
    );
    await expect(scheduler(req)).rejects.toThrow('nope');
    expect(errorSpy).toHaveBeenCalledWith('ledger_reconcile_schedule_failed', {
      error: 'ThrottlingException',
    });
  });
});
