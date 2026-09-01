import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRANSPORT BEFORE RATCHET, FOR EVERY SENDER — the parity gate.
 *
 * The account-bricking order (encrypt, then connect: every failed attempt
 * durably advances the sender chain, libsignal 0.98.0 caps the receiver's
 * forward jump at 25,000 messages, `hasSession` blocks rebootstrap — so
 * enough offline retries make the peer permanently unreachable) was found by
 * a gate, fixed in `notify`'s deliver path, and SURVIVED VERBATIM in its two
 * twins: `tacendum run`'s sender and `cmdSend`. The fix that holds is the one
 * this suite pins: the sequence lives once, in `sendEncrypted` (send.ts), and
 * all three callers are driven THROUGH THEIR OWN ENTRY POINTS here — a test
 * that covered only one caller is exactly how the defect survived the first
 * round.
 *
 * Method mirrors hooks.test.ts's order suite: the REAL caller runs with the
 * protocol modules mocked (socket, libsignal, HTTP, auth), so the order of
 * operations is observable. `encryptCalls` counts sender-ratchet advances;
 * the property under test is that a refused socket costs ZERO of them, on
 * every path, and that each caller's own failure contract still holds (send
 * throws NETWORK; run returns the child's exit; notify queues and exits 0).
 */

const h = vi.hoisted(() => ({
  /** Behavior of WsClient.connect; tests script refusal or success. */
  connect: undefined as undefined | (() => Promise<void>),
  /** How many times encryptText ran — i.e. sender-ratchet advances. */
  encryptCalls: 0,
  /** How many times establishSession ran — bootstrap is ratchet work too. */
  establishCalls: 0,
  /** Every frame handed to WsClient.send. */
  sentFrames: [] as Record<string, unknown>[],
  /** Whether hasSession answers true (session exists) or false (bootstrap). */
  hasSession: true,
}));

vi.mock('../src/wsclient.js', () => ({
  WsClient: class {
    handlers: ((frame: unknown) => void)[] = [];
    async connect(): Promise<void> {
      if (!h.connect) throw new Error('test provided no connect behavior');
      return h.connect();
    }
    onFrame(handler: (frame: unknown) => void): void {
      this.handlers.push(handler);
    }
    send(frame: Record<string, unknown>): void {
      h.sentFrames.push(frame);
    }
    async waitFor(): Promise<Record<string, unknown>> {
      const last = h.sentFrames[h.sentFrames.length - 1];
      return { type: 'receipt', msgId: last?.msgId, state: 'sent' };
    }
    close(): void {}
  },
}));

vi.mock('../src/messaging.js', () => ({
  hasSession: async () => h.hasSession,
  establishSession: async () => {
    h.establishCalls += 1;
  },
  isIdentityChange: () => false,
  decryptEnvelope: async () => '',
  encryptText: async () => {
    h.encryptCalls += 1;
    return { msgType: 'ciphertext', payload: 'AAAA' };
  },
}));

vi.mock('../src/api.js', () => ({
  apiGetPrekeyBundle: async () => ({ lowPrekeyCount: false }),
}));

vi.mock('../src/session.js', () => ({
  AuthSession: class {
    readonly userId = '01HQXW0000000000000000TEST';
    constructor(_account: string, _stores: unknown) {}
  },
}));

import { cmdSend } from '../src/send.js';
import { cmdRun } from '../src/run.js';
import { notifyQueueDir, runNotify } from '../src/hooks.js';
import { CliError, EXIT } from '../src/exit.js';
import { Reporter } from '../src/output.js';
import { saveProfile } from '../src/profile.js';

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let home: string;
let report: Reporter;

function seedAccount(name: string): void {
  saveProfile({
    name,
    identityKey: 'test-key',
    userId: '01HQXW0000000000000000TEST',
    authToken: 'test-token',
    registrationId: 1,
    deviceId: 1,
    accountClass: 'integration',
    ownerUserId: OWNER,
  });
}

const refuse = (): Promise<void> => {
  throw new CliError(EXIT.NETWORK, 'websocket refused');
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-send-unify-'));
  process.env.TACENDUM_HOME = home;
  report = new Reporter({ json: false, plain: true });
  seedAccount('ci');
  h.connect = undefined;
  h.encryptCalls = 0;
  h.establishCalls = 0;
  h.sentFrames.length = 0;
  h.hasSession = true;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cmdSend: a refused socket costs zero ratchet advances', () => {
  it('refused connect → NETWORK error out, no encrypt, no bootstrap, no frame', async () => {
    h.connect = refuse;
    await expect(
      cmdSend('ci', OWNER, 'the build is green', { title: undefined, drain: false }, report),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && err.exitCode === EXIT.NETWORK,
    );
    expect(h.encryptCalls).toBe(0);
    expect(h.establishCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
  });

  it('refused connect with NO session: the bundle bootstrap is also never started', async () => {
    // Bootstrap consumes the peer's one-time prekey and writes a session —
    // ratchet work by any name. Connect-first must gate it too.
    h.hasSession = false;
    h.connect = refuse;
    await expect(
      cmdSend('ci', OWNER, 'x', { title: undefined, drain: false }, report),
    ).rejects.toSatisfy((err: unknown) => err instanceof CliError);
    expect(h.establishCalls).toBe(0);
    expect(h.encryptCalls).toBe(0);
  });

  it('live socket → exactly one encrypt, one frame, receipt reported', async () => {
    h.connect = async () => {};
    const emitted: Record<string, unknown>[] = [];
    vi.spyOn(report, 'emit').mockImplementation(((record: Record<string, unknown>) => {
      emitted.push(record);
    }) as typeof report.emit);
    await cmdSend('ci', OWNER, 'the build is green', { title: undefined, drain: false }, report);
    expect(h.encryptCalls).toBe(1);
    expect(h.sentFrames).toHaveLength(1);
    const frame = h.sentFrames[0] as { type: string; to: string; msgId: string };
    expect(frame.type).toBe('send');
    expect(frame.to).toBe(OWNER);
    expect(frame.msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The interactive contract survives the extraction: ok record, receipt
    // state, byte count.
    expect(emitted[0]).toMatchObject({ ok: true, to: OWNER, state: 'sent' });
    expect(emitted[0]?.bytes).toBe(Buffer.byteLength('the build is green', 'utf8'));
  });
});

describe("run: the wrapper's real sender (no injected notify) is connect-first", () => {
  it('refused connect → zero ratchet advances, and the child still owns the exit code', async () => {
    seedAccount('runner');
    h.connect = refuse;
    const code = await cmdRun(
      ['runner', '--', process.execPath, '-e', ''],
      report,
      // NO notify injected: deps.notify defaults to the real sendNotification,
      // which is the copy the last gate found still encrypt-first.
      {},
    );
    expect(code).toBe(0); // notification failure never changes the build's result
    expect(h.encryptCalls).toBe(0);
    expect(h.establishCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
  });

  it('live socket → the run notification encrypts once and sends to the owner', async () => {
    seedAccount('runner');
    h.connect = async () => {};
    const code = await cmdRun(['runner', '--', process.execPath, '-e', ''], report, {});
    expect(code).toBe(0);
    expect(h.encryptCalls).toBe(1);
    expect(h.sentFrames).toHaveLength(1);
    expect((h.sentFrames[0] as { to: string }).to).toBe(OWNER);
  });
});

describe('notify: the hook deliver path is connect-first (parity kept)', () => {
  const claudeStop = () =>
    JSON.stringify({
      hook_event_name: 'Stop',
      cwd: '/w/proj',
      last_assistant_message: 'done',
    });

  it('refused connect → zero ratchet advances, queued, exit 0', async () => {
    h.connect = refuse;
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    expect(h.encryptCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
    expect(existsSync(notifyQueueDir('ci'))).toBe(true);
    expect(readdirSync(notifyQueueDir('ci')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });

  it('live socket → one encrypt, one frame', async () => {
    h.connect = async () => {};
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    expect(h.encryptCalls).toBe(1);
    expect(h.sentFrames).toHaveLength(1);
  });
});
