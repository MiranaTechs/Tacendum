import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real `deliverNotification` path is exercised with the protocol modules
 * mocked (socket, libsignal, HTTP, auth) so the ORDER of operations is
 * observable: the ratchet-advance-before-transport defect was invisible to
 * every test that injected `deliver`. State lives in `h` (hoisted — vi.mock
 * factories run before imports); each mock only consults it.
 */
const h = vi.hoisted(() => ({
  /** Behavior of WsClient.connect for tests that use the real deliver path. */
  connect: undefined as undefined | (() => Promise<void>),
  /** How many times encryptText ran — i.e. sender-ratchet advances. */
  encryptCalls: 0,
  /** Every frame handed to WsClient.send. */
  sentFrames: [] as Record<string, unknown>[],
  /** Every writeFileAtomic call: target path and requested durability. */
  atomicWrites: [] as { target: string; durability: string | undefined }[],
}));

vi.mock('../src/wsclient.js', () => ({
  WsClient: class {
    async connect(): Promise<void> {
      if (!h.connect) throw new Error('test provided no connect behavior');
      return h.connect();
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
  hasSession: async () => true,
  establishSession: async () => {},
  isIdentityChange: () => false,
  encryptText: async () => {
    h.encryptCalls += 1;
    return { msgType: 'ciphertext', payload: 'AAAA' };
  },
}));

vi.mock('../src/api.js', () => ({
  apiGetPrekeyBundle: async () => ({}),
}));

vi.mock('../src/session.js', () => ({
  AuthSession: class {
    readonly userId = '01HQXW0000000000000000TEST';
    constructor(_account: string, _stores: unknown) {}
  },
}));

// Delegating wrapper, not a stub: every test still writes real files, and the
// recorded (target, durability) pairs let the durability contract be asserted.
vi.mock('../src/stores.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/stores.js')>();
  return {
    ...mod,
    writeFileAtomic: (
      target: string,
      data: string | Uint8Array,
      mode?: { mode: number },
      durability?: 'durable' | 'crash-consistent' | 'durable-verified',
    ) => {
      h.atomicWrites.push({ target, durability });
      return mod.writeFileAtomic(target, data, mode, durability);
    },
  };
});

import {
  HOOK_CHAT_CAP,
  NOTIFY_MAX_BODY_BYTES,
  boundBodyTail,
  cacheCursorText,
  cursorCacheDir,
  enqueueNotification,
  notifyQueueDir,
  readHookStdin,
  runNotify,
  takeCursorText,
  type DeliverFn,
} from '../src/hooks.js';
import { CliError, EXIT } from '../src/exit.js';
import { Reporter } from '../src/output.js';
import { saveProfile } from '../src/profile.js';

/**
 * `tacendum notify --hook <host>` — the one funnel for every agent surface.
 *
 * The properties under test are the ones the research doc calls load-bearing:
 * the command NEVER blocks (any failure = queue + exit 0, bounded deadline,
 * bounded stdin), never exits 2, never advances the sender ratchet for a
 * transport that failed, and each host parser is only a field-name shim over
 * one core.
 */

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

let home: string;
let report: Reporter;

function seedAccount(name: string, ownerUserId?: string): void {
  saveProfile({
    name,
    identityKey: 'test-key',
    userId: '01HQXW0000000000000000TEST',
    authToken: 'test-token',
    registrationId: 1,
    deviceId: 1,
    accountClass: 'integration',
    ...(ownerUserId ? { ownerUserId } : {}),
  });
}

/** A deliver double that records calls and succeeds. */
function recordingDeliver(): {
  calls: { to: string; body: string; msgId: string }[];
  fn: DeliverFn;
} {
  const calls: { to: string; body: string; msgId: string }[] = [];
  const fn: DeliverFn = async ({ to, body, msgId }) => {
    calls.push({ to, body, msgId });
    return { msgId, state: 'sent' };
  };
  return { calls, fn };
}

const stdinOf = (payload: unknown) => () => JSON.stringify(payload);
const neverStdin = () => {
  throw new Error('stdin must not be read for this host');
};
const claudeStop = stdinOf({
  hook_event_name: 'Stop',
  cwd: '/w/proj',
  last_assistant_message: 'the build is green',
});

const queueJsonEntries = (account: string): string[] => {
  if (!existsSync(notifyQueueDir(account))) return []; // nothing ever queued
  return readdirSync(notifyQueueDir(account))
    .filter((n) => n.endsWith('.json'))
    .sort();
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-hooks-'));
  process.env.TACENDUM_HOME = home;
  report = new Reporter({ json: false, plain: true });
  seedAccount('ci', OWNER);
  h.connect = undefined;
  h.encryptCalls = 0;
  h.sentFrames.length = 0;
  h.atomicWrites.length = 0;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('host parsers feed one core (field-name shims only)', () => {
  it('claude Stop: stdin JSON, body from last_assistant_message, tag from cwd', async () => {
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'Stop',
        cwd: '/Users/x/projects/api-server',
        last_assistant_message: 'All 42 tests pass.',
      }),
    });
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(OWNER);
    expect(calls[0]?.body).toBe('api-server: agent finished\nAll 42 tests pass.');
  });

  it('claude Notification: body from message, "needs attention" title', async () => {
    const { calls, fn } = recordingDeliver();
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'Notification',
        cwd: '/w/proj',
        message: 'Claude needs your permission to use Bash',
      }),
    });
    expect(calls[0]?.body).toBe(
      'proj: agent needs attention\nClaude needs your permission to use Bash',
    );
  });

  it('claude: an event this command does not notify on is ignored, exit 0', async () => {
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stdinOf({ hook_event_name: 'PreToolUse', cwd: '/w/p' }),
    });
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(0);
  });

  it('codex: payload is the FINAL ARGV argument, kebab-case; stdin untouched', async () => {
    const { calls, fn } = recordingDeliver();
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'turn-id': '12345',
      cwd: '/Users/x/projects/renamer',
      'input-messages': ['Rename foo to bar'],
      'last-assistant-message': 'Rename complete.',
    });
    const code = await runNotify(
      ['--hook', 'codex', '--account', 'ci', payload],
      report,
      { deliver: fn, readStdin: neverStdin },
    );
    expect(code).toBe(EXIT.OK);
    expect(calls[0]?.body).toBe('renamer: agent finished\nRename complete.');
  });

  it('gemini AfterAgent: stdin JSON, body from prompt_response', async () => {
    const { calls, fn } = recordingDeliver();
    await runNotify(['--hook', 'gemini', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'AfterAgent',
        cwd: '/w/gem',
        prompt_response: 'Done: wrote the migration.',
      }),
    });
    expect(calls[0]?.body).toBe('gem: agent finished\nDone: wrote the migration.');
  });
});

describe('cursor: the two-hook dance', () => {
  const CONV_A = 'a1b2c3d4-0000-1111-2222-333344445555';
  const CONV_B = 'ffff9999-0000-1111-2222-333344445555';

  const afterResponse = (conv: string, text: string) =>
    stdinOf({ hook_event_name: 'afterAgentResponse', conversation_id: conv, text });
  const stop = (conv: string) =>
    stdinOf({
      hook_event_name: 'stop',
      conversation_id: conv,
      status: 'completed',
      workspace_roots: ['/Users/x/projects/webapp'],
    });

  it('afterAgentResponse caches (0600, no send); stop sends it and consumes the file', async () => {
    const { calls, fn } = recordingDeliver();
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: afterResponse(CONV_A, 'Refactor finished; 3 files changed.'),
    });
    expect(calls).toHaveLength(0); // not the finish event — nothing sent yet

    const cacheFiles = readdirSync(cursorCacheDir('ci'));
    expect(cacheFiles).toHaveLength(1);
    const cachePath = join(cursorCacheDir('ci'), cacheFiles[0] as string);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);

    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stop(CONV_A),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe('webapp · s-9191: agent finished\nRefactor finished; 3 files changed.');
    // Consumed: the plaintext does not linger once it has been sent — neither
    // the cache entry nor the delivery claim.
    expect(existsSync(cachePath)).toBe(false);
    expect(readdirSync(cursorCacheDir('ci'))).toHaveLength(0);
  });

  it('two concurrent sessions cannot read each other’s cache', async () => {
    const { calls, fn } = recordingDeliver();
    const opts = { deliver: fn };
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      ...opts, readStdin: afterResponse(CONV_A, 'text for session A'),
    });
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      ...opts, readStdin: afterResponse(CONV_B, 'text for session B'),
    });
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      ...opts, readStdin: stop(CONV_A),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('text for session A');
    expect(calls[0]?.body).not.toContain('text for session B');
    // B's cache is untouched, awaiting B's own stop.
    expect(readdirSync(cursorCacheDir('ci'))).toHaveLength(1);
  });

  it('distinct conversation ids never share a cache file (the key is injective)', () => {
    // The old strip-and-truncate key mapped 'session/a' and 'sessiona' to the
    // SAME file, so stopping one conversation sent — and consumed — the
    // other's plaintext.
    expect(cacheCursorText('ci', 'session/a', 'TEXT_A')).toBe(true);
    expect(cacheCursorText('ci', 'sessiona', 'TEXT_B')).toBe(true);
    expect(readdirSync(cursorCacheDir('ci'))).toHaveLength(2);
    const a = takeCursorText('ci', 'session/a');
    expect(a.text).toBe('TEXT_A');
    a.commit();
    const b = takeCursorText('ci', 'sessiona');
    expect(b.text).toBe('TEXT_B');
    b.commit();
  });

  it('a long response is truncated ONCE, at compose — the cache stays raw', async () => {
    const { calls, fn } = recordingDeliver();
    const long = `OUTCOME: the head the owner must see. ${'y'.repeat(7000)}`;
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: afterResponse(CONV_A, long),
    });
    // The cache holds the UNTRUNCATED text (far below the cache's own byte
    // bound): the truncation rule has exactly one owner (composeHookBody).
    // A cap applied here too was the two-call-site defect — stop's second
    // pass would then clip an already-clipped body.
    const cacheFiles = readdirSync(cursorCacheDir('ci'));
    expect(readFileSync(join(cursorCacheDir('ci'), cacheFiles[0] as string), 'utf8')).toBe(long);

    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stop(CONV_A),
    });
    const body = calls[0]?.body ?? '';
    const [title, ...bodyLines] = body.split('\n');
    expect(title).toBe('webapp · s-9191: agent finished');
    const afterTitle = bodyLines.join('\n');
    // The chat cap (crew-chat spec) fires at compose: HEAD kept — prose
    // starts with its outcome — within the chat budget, ellipsis appended,
    // and the old omission-marker path never engages for a capped body.
    expect(afterTitle.startsWith('OUTCOME: the head the owner must see.')).toBe(true);
    expect(afterTitle.endsWith('…')).toBe(true);
    expect(afterTitle.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    expect(afterTitle).not.toMatch(/\[…\d+ earlier byte\(s\) omitted\]/);
    expect(Buffer.byteLength(afterTitle, 'utf8')).toBeLessThanOrEqual(NOTIFY_MAX_BODY_BYTES);
  });

  it('a crashed run cannot strand plaintext forever: stale cache is swept', async () => {
    const { calls, fn } = recordingDeliver();
    cacheCursorText('ci', CONV_A, 'orphaned plaintext from a crashed session');
    const cachePath = join(
      cursorCacheDir('ci'),
      readdirSync(cursorCacheDir('ci'))[0] as string,
    );
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(cachePath, dayAgo, dayAgo);

    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stop(CONV_A),
    });
    // The finish still notifies — title only, the stale text is gone.
    expect(calls[0]?.body).toBe('webapp · s-9191: agent finished');
    expect(existsSync(cachePath)).toBe(false);
  });

  it('the sweep does not depend on cursor ever firing again: any host’s notify runs it', async () => {
    cacheCursorText('ci', CONV_A, 'final response of a retired cursor session');
    const cachePath = join(
      cursorCacheDir('ci'),
      readdirSync(cursorCacheDir('ci'))[0] as string,
    );
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(cachePath, dayAgo, dayAgo);

    const { fn } = recordingDeliver();
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: claudeStop,
    });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('a take is a CLAIM: atomic, and the text stays on disk until commit', () => {
    cacheCursorText('ci', CONV_A, 'the only copy of the response');
    const dir = cursorCacheDir('ci');

    const taken = takeCursorText('ci', CONV_A);
    expect(taken.text).toBe('the only copy of the response');
    // A second taker (the both-read-before-either-unlinked race) gets nothing:
    // the rename consumed the entry for exactly one winner.
    expect(takeCursorText('ci', CONV_A).text).toBe('');
    // But the text is NOT gone — a process killed here (after the old
    // read+unlink, before delivery or queueing) used to take the only copy
    // with it. The claim file holds it until the taker commits.
    const claim = readdirSync(dir).find((n) => n.includes('.taking.'));
    expect(claim).toBeDefined();
    expect(readFileSync(join(dir, claim as string), 'utf8')).toBe('the only copy of the response');

    taken.commit();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('a stop whose send fails commits the text into the queue, not the void', async () => {
    cacheCursorText('ci', CONV_A, 'must survive the failed send');
    const failing: DeliverFn = async () => {
      throw new CliError(EXIT.NETWORK, 'down');
    };
    await runNotify(['--hook', 'cursor', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: stdinOf({
        hook_event_name: 'stop',
        conversation_id: CONV_A,
        workspace_roots: ['/w/webapp'],
      }),
    });
    const entries = queueJsonEntries('ci');
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(
      readFileSync(join(notifyQueueDir('ci'), entries[0] as string), 'utf8'),
    ) as { body: string };
    expect(entry.body).toContain('must survive the failed send');
    // Queued durably, so the claim is committed — no second copy lingers.
    expect(readdirSync(cursorCacheDir('ci'))).toHaveLength(0);
  });

  it('a cache entry is bounded in bytes, HEAD kept — the outcome sentence must reach compose', () => {
    // An earlier review: a tail-keeping ceiling in front of the head-keeping
    // chat cap handed compose the END of a megabyte response, and the
    // opening outcome line was gone before the cap ever ran.
    const CAP = 1024 * 1024;
    const big = `OUTCOME_HEAD_MUST_SURVIVE. ${'a'.repeat(2 * CAP)}`;
    cacheCursorText('ci', CONV_A, big);
    const dir = cursorCacheDir('ci');
    const name = readdirSync(dir)[0] as string;
    const stored = readFileSync(join(dir, name), 'utf8');
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(stored.startsWith('OUTCOME_HEAD_MUST_SURVIVE.')).toBe(true);
  });

  it('the cache spool is capped: at most 100 conversations, oldest evicted', () => {
    for (let i = 0; i < 105; i++) {
      cacheCursorText('ci', `conv-${i}`, `text ${i}`);
    }
    expect(readdirSync(cursorCacheDir('ci')).length).toBeLessThanOrEqual(100);
    // The newest write always survives its own eviction pass.
    expect(takeCursorText('ci', 'conv-104').text).toBe('text 104');
  });
});

describe('never block the agent: queue-and-exit-0 on every failure', () => {
  it('a network failure queues the notification and exits 0 — never 2, never nonzero', async () => {
    const failing: DeliverFn = async () => {
      throw new CliError(EXIT.NETWORK, 'websocket handshake failed');
    };
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);

    const entries = queueJsonEntries('ci');
    expect(entries).toHaveLength(1);
    const path = join(notifyQueueDir('ci'), entries[0] as string);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const entry = JSON.parse(readFileSync(path, 'utf8')) as { to: string; body: string };
    expect(entry.to).toBe(OWNER);
    expect(entry.body).toBe('proj: agent finished\nthe build is green');
  });

  it('the queue write is DURABLE: "queued" must survive the power cut that follows it', async () => {
    const failing: DeliverFn = async () => {
      throw new CliError(EXIT.NETWORK, 'down');
    };
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: claudeStop,
    });
    const queueWrites = h.atomicWrites.filter(
      (w) => w.target.includes('notify-queue') && w.target.endsWith('.json'),
    );
    expect(queueWrites.length).toBeGreaterThan(0);
    for (const w of queueWrites) {
      // undefined selects writeFileAtomic's default, which is 'durable'.
      // 'crash-consistent' skips the data fsync, and cmdNotify hard-exits
      // right after — a page-cache-only entry is a notification reported
      // kept and silently gone.
      expect(w.durability).not.toBe('crash-consistent');
    }
  });

  it('the next successful run flushes the queue oldest-first, then the live event', async () => {
    enqueueNotification('ci', OTHER, 'first queued');
    enqueueNotification('ci', OWNER, 'second queued');
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    expect(calls.map((c) => c.body)).toEqual([
      'first queued',
      'second queued',
      'proj: agent finished\nthe build is green',
    ]);
    // Each entry delivered to the recipient it was queued FOR, not today's.
    expect(calls[0]?.to).toBe(OTHER);
    // COMPLETELY empty — not merely no `.json` entries. A `.claim.<pid>` file
    // surviving a successful send is a delayed duplicate: the stale-claim
    // sweep would restore it as a live entry ten minutes later.
    expect(readdirSync(notifyQueueDir('ci'))).toHaveLength(0);
  });

  it('one msgId per notification: minted once, queued with the entry, reused on retry', async () => {
    // The defect: every attempt minted a fresh id, so a frame the server
    // accepted whose receipt arrived late was retried under a NEW id — two
    // distinct messages on the phone from one notification. The server row
    // (keyed recipient+msgId) and both receivers' seen-stores dedupe on
    // msgId, which only helps if retries reuse it.
    const attempted: string[] = [];
    const failing: DeliverFn = async ({ msgId }) => {
      attempted.push(msgId);
      throw new CliError(EXIT.TIMEOUT, 'receipt after deadline');
    };
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: claudeStop,
    });
    expect(attempted).toHaveLength(1);
    const entries = queueJsonEntries('ci');
    const entry = JSON.parse(
      readFileSync(join(notifyQueueDir('ci'), entries[0] as string), 'utf8'),
    ) as { msgId: string };
    expect(entry.msgId).toBe(attempted[0]);

    const { calls, fn } = recordingDeliver();
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: claudeStop,
    });
    // The flushed retry carries the ORIGINAL id, not a fresh mint.
    expect(calls[0]?.msgId).toBe(attempted[0]);
  });

  it('a failed flush restores the entry and queues the live event too', async () => {
    enqueueNotification('ci', OWNER, 'still undeliverable');
    const failing: DeliverFn = async () => {
      throw new CliError(EXIT.NETWORK, 'still down');
    };
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    const entries = queueJsonEntries('ci');
    expect(entries).toHaveLength(2); // the restored entry + the new event
    const bodies = entries
      .map((n) => (JSON.parse(readFileSync(join(notifyQueueDir('ci'), n), 'utf8')) as { body: string }).body)
      .sort();
    expect(bodies).toEqual(['proj: agent finished\nthe build is green', 'still undeliverable'].sort());
  });

  it('a claim is FRESH at birth: an old entry cannot be judged stale mid-delivery', async () => {
    // rename() preserves the source's mtime, and staleness is judged from the
    // claim file's mtime — so claiming an 11-minute-old entry used to produce
    // a claim already past CLAIM_STALE_MS: any concurrent queue touch
    // restored it while its claimer was mid-send, and both delivered.
    enqueueNotification('ci', OWNER, 'queued eleven minutes ago');
    const dir = notifyQueueDir('ci');
    const entryName = readdirSync(dir).find((n) => n.endsWith('.json')) as string;
    const elevenMinAgo = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(join(dir, entryName), elevenMinAgo, elevenMinAgo);

    let inspected = false;
    let claimAgeMs = Number.POSITIVE_INFINITY;
    let restoredDuringDelivery = true;
    const fn: DeliverFn = async ({ msgId }) => {
      if (!inspected) {
        inspected = true;
        const claim = readdirSync(dir).find((n) => n.includes('.claim.'));
        expect(claim).toBeDefined();
        claimAgeMs = Date.now() - statSync(join(dir, claim as string)).mtimeMs;
        // A rival process touches the queue mid-delivery (every touch prunes,
        // and the prune is what restores "stale" claims):
        enqueueNotification('ci', OWNER, 'rival queue touch');
        restoredDuringDelivery = readdirSync(dir).includes(entryName);
      }
      return { msgId, state: 'sent' };
    };
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: claudeStop,
    });
    expect(claimAgeMs).toBeLessThan(60_000);
    expect(restoredDuringDelivery).toBe(false);
  });

  it('a hung send hits the internal deadline, queues, and returns — it does not hang', async () => {
    const hung: DeliverFn = () => new Promise(() => {}); // never settles
    const started = Date.now();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: hung,
      readStdin: claudeStop,
      deadlineMs: 600,
    });
    expect(code).toBe(EXIT.OK);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(queueJsonEntries('ci')).toHaveLength(1);
  });

  it('a budget already spent does not START a send: the live event is queued', async () => {
    // Below the flush floor nothing new begins — the same rule the flush loop
    // follows, which is also what keeps "older go first" true: a starved run
    // queues the live event instead of jumping it over unflushed entries.
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: claudeStop,
      deadlineMs: 100,
    });
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(0);
    expect(queueJsonEntries('ci')).toHaveLength(1);
  });

  it('the queue is capped: an offline machine cannot grow an unbounded plaintext spool', () => {
    for (let i = 0; i < 105; i++) enqueueNotification('ci', OWNER, `n${i}`);
    const entries = queueJsonEntries('ci');
    expect(entries.length).toBeLessThanOrEqual(100);
    const oldest = JSON.parse(
      readFileSync(join(notifyQueueDir('ci'), entries[0] as string), 'utf8'),
    ) as { body: string };
    expect(oldest.body).toBe('n5'); // the five OLDEST were the ones dropped
  });

  it('a temporarily unreadable entry is NOT disposable: a failed read deletes nothing', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    enqueueNotification('ci', OWNER, 'real notification behind an EACCES');
    const dir = notifyQueueDir('ci');
    const name = readdirSync(dir).find((n) => n.endsWith('.json')) as string;
    chmodSync(join(dir, name), 0o000);
    try {
      // Any queue touch runs the prune that used to classify EACCES as
      // "nothing recoverable to send" and delete the entry.
      enqueueNotification('ci', OWNER, 'queue touch');
      expect(readdirSync(dir)).toContain(name);
    } finally {
      chmodSync(join(dir, name), 0o600);
    }
    const entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { body: string };
    expect(entry.body).toBe('real notification behind an EACCES');
  });

  it('genuinely corrupt content is still disposable', () => {
    const dir = notifyQueueDir('ci');
    enqueueNotification('ci', OWNER, 'make the dir'); // also creates dir
    const corruptName = '01ARZ3NDEKTSV4RRFFQ69G5FAX.json';
    writeFileSync(join(dir, corruptName), 'not an entry at all', { mode: 0o600 });
    enqueueNotification('ci', OWNER, 'queue touch');
    expect(readdirSync(dir)).not.toContain(corruptName);
  });

  it('a stranded plaintext .tmp from a failed rename is swept once provably abandoned', () => {
    const dir = notifyQueueDir('ci');
    enqueueNotification('ci', OWNER, 'make the dir');
    const stale = join(dir, '01ARZ3NDEKTSV4RRFFQ69G5FAX.json.99999.tmp');
    const fresh = join(dir, '01ARZ3NDEKTSV4RRFFQ69G5FAY.json.99999.tmp');
    writeFileSync(stale, 'orphaned plaintext', { mode: 0o600 });
    writeFileSync(fresh, 'mid-write right now', { mode: 0o600 });
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    enqueueNotification('ci', OWNER, 'queue touch');
    expect(existsSync(stale)).toBe(false); // abandoned: swept
    expect(existsSync(fresh)).toBe(true); // possibly a live write: kept
  });
});

describe('transport before ratchet (the real deliver path, protocol mocked)', () => {
  it('a refused socket costs ZERO ratchet advances — and still queues, exit 0', async () => {
    // The bricking order was encrypt-then-connect: every failed attempt
    // durably advanced the sender chain, libsignal caps the receiver's
    // forward jump at 25,000, and hasSession() blocks rebootstrap — enough
    // failed hook invocations made the peer permanently unreachable.
    h.connect = async () => {
      throw new CliError(EXIT.NETWORK, 'websocket refused');
    };
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    expect(h.encryptCalls).toBe(0);
    expect(h.sentFrames).toHaveLength(0);
    expect(queueJsonEntries('ci')).toHaveLength(1);
  });

  it('a live socket encrypts exactly once and sends the caller-minted msgId', async () => {
    h.connect = async () => {};
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    expect(h.encryptCalls).toBe(1);
    expect(h.sentFrames).toHaveLength(1);
    const frame = h.sentFrames[0] as { type: string; msgId: string; to: string };
    expect(frame.type).toBe('send');
    expect(frame.to).toBe(OWNER);
    expect(frame.msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(queueJsonEntries('ci')).toHaveLength(0);
  });
});

describe('the no-leak rule and the payload boundary', () => {
  it('a malformed payload exits 0 and its content never reaches stderr', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const { calls, fn } = recordingDeliver();
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: () => 'sk-live-THIS-IS-A-SECRET {truncated payload',
    });
    expect(code).toBe(EXIT.OK);
    expect(calls).toHaveLength(0);
    expect(written.join('')).not.toContain('sk-live-THIS-IS-A-SECRET');
    expect(written.join('')).toContain('not valid JSON');
  });

  it('an ignored event never echoes the host-supplied event name, on any stream', async () => {
    const errWritten: string[] = [];
    const outWritten: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      errWritten.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      outWritten.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const { fn } = recordingDeliver();
    const jsonReport = new Reporter({ json: true, plain: true });
    await runNotify(['--hook', 'claude', '--account', 'ci'], jsonReport, {
      deliver: fn,
      readStdin: stdinOf({
        hook_event_name: 'EVIL\u001b]0;pwned\u0007NAME sk-live-SECRET',
        cwd: '/w/p',
      }),
    });
    const everything = errWritten.join('') + outWritten.join('');
    // hook_event_name is host/payload-supplied: neither the human stderr line
    // nor the --json `reason` field may carry it.
    expect(everything).not.toContain('EVIL');
    expect(everything).not.toContain('sk-live-SECRET');
    expect(everything).not.toContain('\u001b');
  });

  it('--json records carry no recipient id, on success or on queue', async () => {
    const outWritten: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      outWritten.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const jsonReport = new Reporter({ json: true, plain: true });
    const { fn } = recordingDeliver();
    await runNotify(['--hook', 'claude', '--account', 'ci', '--to', OTHER], jsonReport, {
      deliver: fn,
      readStdin: claudeStop,
    });
    const failing: DeliverFn = async () => {
      throw new CliError(EXIT.NETWORK, 'down');
    };
    await runNotify(['--hook', 'claude', '--account', 'ci', '--to', OTHER], jsonReport, {
      deliver: failing,
      readStdin: claudeStop,
    });
    const records = outWritten
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.map((r) => r.action)).toEqual(['notified', 'queued']);
    for (const record of records) {
      expect('to' in record).toBe(false);
      expect(JSON.stringify(record)).not.toContain(OTHER);
    }
  });

  it('a server-authored failure detail is sanitized and bounded at the print site', async () => {
    // api.ts embeds the server's error code and detail VERBATIM in the
    // CliError message; this print site is where a newline (a forged log
    // line), a terminal escape, or a megabyte must be stopped.
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const failing: DeliverFn = async () => {
      throw new CliError(
        EXIT.NETWORK,
        `POST /v1/x failed: 500 evil: \u001b]0;pwned\u0007\nerror: FORGED-SECOND-LINE ${'x'.repeat(2000)}`,
      );
    };
    const code = await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: failing,
      readStdin: claudeStop,
    });
    expect(code).toBe(EXIT.OK);
    const err = written.join('');
    expect(err).toContain('send failed');
    expect(err).not.toContain('\u001b'); // no terminal escapes
    expect(err).not.toMatch(/\nerror: FORGED-SECOND-LINE/); // no forged log line
    expect(err.length).toBeLessThan(800); // bounded, not the server's megabyte
  });

  it('a long body is bounded to the CHAT cap — head kept, chars counted, bytes still backstopped', async () => {
    const { calls, fn } = recordingDeliver();
    // Agent prose: the outcome leads, the trailing detail is what the chat
    // does without. (The old shape here — 6000 x's with the verdict on the
    // LAST line — was a build log's, and build logs are `run`'s lane with
    // its own tail bound; hook bodies are an agent's message.)
    const long = `Shipped: both fixes landed. ${'detail '.repeat(1000)}`;
    await runNotify(['--hook', 'claude', '--account', 'ci'], report, {
      deliver: fn,
      readStdin: stdinOf({ hook_event_name: 'Stop', cwd: '/w/p', last_assistant_message: long }),
    });
    const body = calls[0]?.body ?? '';
    const [title, ...rest] = body.split('\n');
    expect(title).toBe('p: agent finished');
    const afterTitle = rest.join('\n');
    expect(afterTitle.startsWith('Shipped: both fixes landed.')).toBe(true);
    expect(afterTitle.endsWith('…')).toBe(true);
    expect(afterTitle.length).toBeLessThanOrEqual(HOOK_CHAT_CAP);
    // The byte bound is still in the funnel behind the chat cap: a capped
    // body can never reach it (280 UTF-16 units < 2KiB in every encoding of
    // them), so no omission marker can appear — and boundBodyTail's own
    // suite below keeps the marker rule proven for its direct callers.
    expect(afterTitle).not.toMatch(/\[…\d+ earlier byte\(s\) omitted\]/);
    expect(Buffer.byteLength(afterTitle, 'utf8')).toBeLessThanOrEqual(NOTIFY_MAX_BODY_BYTES);
  });
});

describe('boundBodyTail — THE truncation rule (one owner, idempotent)', () => {
  const droppedOf = (bounded: string): number =>
    Number(/^\[…(\d+) earlier byte\(s\) omitted\]\n/.exec(bounded)?.[1]);

  it('total output — marker included — never exceeds the cap, and the marker is true', () => {
    const text = `${'a'.repeat(9000)}\nconclusion line`;
    const out = boundBodyTail(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(NOTIFY_MAX_BODY_BYTES);
    expect(out.endsWith('conclusion line')).toBe(true);
    const kept = out.slice(out.indexOf('\n') + 1);
    expect(droppedOf(out) + Buffer.byteLength(kept, 'utf8')).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('is idempotent: re-applying to bounded output changes nothing, for every shape', () => {
    const shapes = [
      'short, untouched',
      'a'.repeat(9000), // plain overflow
      `${'☃'.repeat(3000)}end`, // multibyte at the cut seam
      '�'.repeat(3000), // text that legitimately IS replacement characters
      `${'b'.repeat(5000)}\n\n\n`, // trailing newlines stripped first
    ];
    for (const text of shapes) {
      const once = boundBodyTail(text);
      expect(boundBodyTail(once)).toBe(once); // a second caller cannot corrupt the marker
      expect(Buffer.byteLength(once, 'utf8')).toBeLessThanOrEqual(NOTIFY_MAX_BODY_BYTES);
    }
  });

  it('a cut mid-codepoint lands on the next boundary — no U+FFFD artifact, real "�" kept', () => {
    const snowman = boundBodyTail(`${'☃'.repeat(3000)}end`); // '☃' is 3 bytes
    expect(snowman).not.toContain('�');
    const literal = boundBodyTail(`x${'�'.repeat(1000)}`); // '�' IS U+FFFD, legitimately
    expect(literal.slice(literal.indexOf('\n') + 1)).toMatch(/^�+$/);
  });
});

describe('readHookStdin — bounded in time and size', () => {
  it('a writer that never closes the pipe cannot hang the hook', async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const promise = readHookStdin(stream as unknown as typeof process.stdin);
      stream.write('{"hook_event_name":"Stop"}');
      await vi.advanceTimersByTimeAsync(3_100);
      const text = await promise;
      expect(text).toBe('{"hook_event_name":"Stop"}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a well-behaved host is read whole, promptly', async () => {
    const stream = new PassThrough();
    const promise = readHookStdin(stream as unknown as typeof process.stdin);
    stream.end('{"a":1}');
    expect(await promise).toBe('{"a":1}');
  });

  it('stdin is bounded in size: past the cap the rest is not read', async () => {
    const stream = new PassThrough();
    const promise = readHookStdin(stream as unknown as typeof process.stdin);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 6; i++) stream.write(chunk);
    const text = await promise;
    expect(text.length).toBeGreaterThan(4 * 1024 * 1024); // read up to just past the cap
    expect(text.length).toBeLessThan(6 * 1024 * 1024); // but not everything the writer had
  });
});

describe('setup errors are loud (and still never 2)', () => {
  const codeOf = async (argv: string[], deps = {}): Promise<number> => {
    try {
      await runNotify(argv, report, deps);
      return -1;
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      return (err as CliError).exitCode;
    }
  };

  it('an unknown --hook value refuses with USAGE and does not echo the value', async () => {
    try {
      await runNotify(['--hook', 'sk-secret-value', '--account', 'ci'], report, {});
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.USAGE);
      expect((err as CliError).exitCode).not.toBe(2);
      expect((err as CliError).message).not.toContain('sk-secret-value');
    }
  });

  it('--hook and --account are required', async () => {
    expect(await codeOf(['--account', 'ci'])).toBe(EXIT.USAGE);
    expect(await codeOf(['--hook', 'claude'])).toBe(EXIT.USAGE);
  });

  it('an unpaired integration with no --to has no recipient and says how to fix it', async () => {
    seedAccount('unpaired');
    expect(
      await codeOf(['--hook', 'claude', '--account', 'unpaired'], {
        readStdin: stdinOf({ hook_event_name: 'Stop', cwd: '/w', last_assistant_message: 'x' }),
      }),
    ).toBe(EXIT.USAGE);
  });

  it('--to overrides the paired owner', async () => {
    const { calls, fn } = recordingDeliver();
    await runNotify(['--hook', 'claude', '--account', 'ci', '--to', OTHER], report, {
      deliver: fn,
      readStdin: stdinOf({ hook_event_name: 'Stop', cwd: '/w', last_assistant_message: 'x' }),
    });
    expect(calls[0]?.to).toBe(OTHER);
  });
});
