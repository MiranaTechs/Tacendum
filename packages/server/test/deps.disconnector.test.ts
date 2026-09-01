import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import { readWsDisconnector } from '../src/aws/deps.js';
import { revokeConnectionForSessions } from '../src/handlers/session-revoke.js';
import type { Deps } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * THE PROACTIVE DISCONNECT MUST BE AUDITABLE, AND ITS ABSENCE LOUD.
 *
 * The HTTP and Auth functions can only hang up a revoked session's socket if
 * infra hands them `WS_API_DOMAIN` + `WS_API_STAGE` and the
 * `execute-api:ManageConnections` (DELETE) grant — wiring that lives in
 * infra/, which is NOT part of the public source release. A deployment that
 * loses it used to degrade in perfect silence: `readWsDisconnector` returned
 * undefined, every `deps.disconnectSocket?.()` no-opped, and no line anywhere
 * said so. These tests pin the two halves of the fix:
 *
 *  1. `WS_DISCONNECT_REQUIRED=1` (set by infra on exactly the two functions
 *     that owe the capability) makes a missing endpoint a REFUSAL TO RUN —
 *     a cold-start throw naming the missing variables — instead of a silent
 *     downgrade. Without the flag (local dev, unit tests, the Lambdas that
 *     never revoke), absence stays a quiet, legitimate degrade.
 *  2. Whatever the host, a revocation that actually NEEDED the hang-up and
 *     had no disconnector logs `ws_disconnector_unwired` naming the missing
 *     variables — first-use loudness, auditable from the public tree.
 */

const WIRED = {
  WS_API_DOMAIN: 'abc123.execute-api.us-east-1.amazonaws.com',
  WS_API_STAGE: 'prod',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readWsDisconnector — production absence is loud', () => {
  it('returns a disconnector when both variables are present', () => {
    expect(typeof readWsDisconnector({ ...WIRED })).toBe('function');
  });

  it('REFUSES TO RUN under WS_DISCONNECT_REQUIRED=1 with the wiring absent, naming what is missing', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    expect(() => readWsDisconnector({ WS_DISCONNECT_REQUIRED: '1' })).toThrow(
      /WS_API_DOMAIN.*WS_API_STAGE|WS_API_DOMAIN,WS_API_STAGE/,
    );
    expect(errorSpy).toHaveBeenCalledWith('ws_disconnector_unwired', {
      missing: 'WS_API_DOMAIN,WS_API_STAGE',
    });

    // Half-wired is still unwired — and the error names only the absent half.
    expect(() =>
      readWsDisconnector({ WS_DISCONNECT_REQUIRED: '1', WS_API_DOMAIN: WIRED.WS_API_DOMAIN }),
    ).toThrow(/WS_API_STAGE/);
    expect(errorSpy).toHaveBeenLastCalledWith('ws_disconnector_unwired', {
      missing: 'WS_API_STAGE',
    });
  });

  it('stays a quiet degrade without the flag — the local/dev and non-revoking-Lambda case', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    expect(readWsDisconnector({})).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('the flag changes nothing when the wiring IS present', () => {
    expect(typeof readWsDisconnector({ ...WIRED, WS_DISCONNECT_REQUIRED: '1' })).toBe('function');
  });
});

describe('revocation without a disconnector says so', () => {
  it('logs ws_disconnector_unwired when a revoke tears a socket down with no transport hang-up available', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    // A host with no management channel: the test double's disconnectSocket
    // is removed, exactly the shape aws/deps.ts produces when the env is
    // absent and the flag is not set.
    const { disconnectSocket: _omit, ...bare } = deps;
    void _omit;

    await db.putConnection({
      userId: 'user-unwired',
      connectionId: 'conn-unwired',
      connectedAt: deps.now(),
      sessionDigest: 'digest-unwired',
    });

    await revokeConnectionForSessions(bare as Deps, 'user-unwired');

    // The routing half still enforced…
    expect(await db.getConnection('user-unwired')).toBeUndefined();
    // …and the missing transport half is now VISIBLE, naming the wiring.
    const unwired = deps.logs.find((l) => l.event === 'ws_disconnector_unwired');
    expect(unwired).toBeDefined();
    expect(JSON.stringify(unwired?.fields)).toContain('WS_API_DOMAIN');
  });

  it('does NOT log ws_disconnector_unwired when the disconnector exists', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    await db.putConnection({
      userId: 'user-wired',
      connectionId: 'conn-wired',
      connectedAt: deps.now(),
      sessionDigest: 'digest-wired',
    });

    await revokeConnectionForSessions(deps, 'user-wired');

    expect(deps.disconnected).toContain('conn-wired');
    expect(deps.logs.find((l) => l.event === 'ws_disconnector_unwired')).toBeUndefined();
  });
});
