import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `tacendum_notify_owner`. Every test that reaches the wire does so through a FAKE dial stood
 * in at the `deliver` seam — a live server is out of a unit suite's reach —
 * so what is proven LIVE here is everything BEFORE the dial (pairing and cap
 * refusals, the durable bucket, the idempotency journal, the fsync'd audit
 * line, all on real files under a real file lock) plus the frame discipline
 * around it; the dial itself is `sendEncrypted`, whose wire behaviour is
 * e2e.sh's to prove. Red-first mutations for this file, the named ones:
 *
 *  - register the notify tool unconditionally  -> the default-surface test red
 *  - drop the journal lookup in admitNotify    -> the duplicate test red
 *  - read the bucket without the lock          -> e2e's parallel check red
 *  - skip the audit append                     -> the audit-before-dial test red
 *  - swallow the audit error                   -> the unwritable-audit test red
 *
 * MOVING CLOCK THROUGHOUT (the frozen-clock ruling): no test here pins
 * Date.now() beside an advancing timer — window and TTL arithmetic is driven
 * through admitNotify's `now` PARAMETER, and the deadline test runs on real
 * timers with a real 50 ms budget.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcp-notify-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { clientDir, stateDir } = await import('../src/config.js');
const { McpServer } = await import('../src/mcp.js');
const {
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  McpNotifyServer,
  NOTIFY_OWNER_PER_HOUR,
  admitNotify,
  markDelivered,
} = await import('../src/mcp-notify.js');
const { runMcpTransport } = await import('../src/mcp.js');

const OWNER_ID = '01XWNERXWNERXWNERXWNERXWNE';
const TOKEN = 'tok-notify-e2e-SECRET-VALUE';

function seedAccount(name: string, opts: { paired: boolean } = { paired: true }): void {
  saveProfile({
    name,
    identityKey: 'IDKEYNOTIFY==',
    userId: '01AGENTAGENTAGENTAGENTAGEN',
    authToken: TOKEN,
    registrationId: 1,
    deviceId: 1,
    ...(opts.paired ? { accountClass: 'integration' as const, ownerUserId: OWNER_ID } : {}),
  });
}

/** The dial seam, faked (see the header). `behavior` is per-instance so a
 * test can flip it between calls — the retry-reuse test does. */
class FakeDialServer extends McpNotifyServer {
  deliveries: Array<{ owner: string; body: string; msgId: string }> = [];
  behavior: 'ok' | 'fail' | 'fail-with-url' | 'hang' = 'ok';
  auditLinesAtDial: number[] = [];
  constructor(private readonly acct: string) {
    super(acct);
  }
  protected override async deliver(owner: string, body: string, msgId: string): Promise<void> {
    // Observed AT THE DIAL: how many audit lines are already durable. The
    // audit-before-network property is this number being > 0 on every dial.
    const audit = join(stateDir(this.acct), 'mcp-audit.jsonl');
    this.auditLinesAtDial.push(
      existsSync(audit) ? readFileSync(audit, 'utf8').split('\n').filter(l => l !== '').length : 0,
    );
    this.deliveries.push({ owner, body, msgId });
    if (this.behavior === 'fail') throw new Error('dial failed (test)');
    if (this.behavior === 'fail-with-url') {
      // The shape wsclient's failures can take: the ws URL carries the
      // bearer. The frame this becomes must come out redacted.
      throw new Error(`connect failed: wss://example.test/ws?token=${TOKEN}`);
    }
    if (this.behavior === 'hang') await new Promise<void>(() => undefined);
  }
}

/** Shrinks the per-call deadline to test scale; real timers still. */
type ToolRun = import('../src/mcp.js').ToolRun;
class ShortDeadlineServer extends FakeDialServer {
  protected override toolRun(name: string): ToolRun | null {
    const tool = super.toolRun(name);
    if (name === 'tacendum_notify_owner' && tool !== null) {
      return { ...tool, deadlineMs: 50 };
    }
    return tool;
  }
}

interface Frame {
  jsonrpc: string;
  id: number | null;
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

async function call(
  server: InstanceType<typeof McpServer>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Frame> {
  const line = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const out = await server.handleLine(line);
  if (out === null) throw new Error('expected a frame');
  return JSON.parse(out) as Frame;
}

async function rpc(
  server: InstanceType<typeof McpServer>,
  id: number,
  method: string,
  params?: unknown,
): Promise<Frame> {
  const out = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  );
  if (out === null) throw new Error('expected a frame');
  return JSON.parse(out) as Frame;
}

function errText(frame: Frame): string {
  expect(frame.result?.isError, JSON.stringify(frame)).toBe(true);
  return frame.result?.content?.[0]?.text ?? '';
}

function bucketOf(account: string): { windowStart: number; sends: number } | null {
  const p = join(stateDir(account), 'mcp-notify-bucket.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { windowStart: number; sends: number }) : null;
}

function auditLines(account: string): Array<Record<string, unknown>> {
  const p = join(stateDir(account), 'mcp-audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

// The transport rebinds the console; restore after any harness test.
const realConsole = { log: console.log, info: console.info, warn: console.warn };
afterEach(() => {
  console.log = realConsole.log;
  console.info = realConsole.info;
  console.warn = realConsole.warn;
});

describe('the tool surface per launch mode', () => {
  it('the default server advertises exactly the three read tools and claims no send, honestly', async () => {
    seedAccount('surface-default');
    const server = new McpServer('surface-default');
    const list = await rpc(server, 1, 'tools/list');
    const tools = (list.result as unknown as { tools: Array<{ name: string }> }).tools;
    expect(tools.map(t => t.name)).toEqual([
      'tacendum_whoami',
      'tacendum_read_messages',
      'tacendum_acknowledge_messages',
    ]);
    const init = await rpc(server, 2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const instructions = (init.result as unknown as { instructions: string }).instructions;
    expect(instructions).toContain('no send capability');
    // The executor matches the advertisement: the notify name is UNKNOWN here.
    const notify = await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tacendum_notify_owner', arguments: { body: 'x' } },
      }),
    );
    expect((JSON.parse(notify as string) as Frame).error?.message).toContain('unknown tool');
  });

  it('the opt-in server advertises the three plus tacendum_notify_owner and nothing else, and says so', async () => {
    seedAccount('surface-notify');
    const server = new FakeDialServer('surface-notify');
    const list = await rpc(server, 1, 'tools/list');
    const tools = (list.result as unknown as { tools: Array<{ name: string; annotations: Record<string, unknown> }> })
      .tools;
    expect(tools.map(t => t.name)).toEqual([
      'tacendum_whoami',
      'tacendum_read_messages',
      'tacendum_acknowledge_messages',
      'tacendum_notify_owner',
    ]);
    const notify = tools[3];
    expect(notify?.annotations.readOnlyHint).toBe(false);
    expect(notify?.annotations.openWorldHint).toBe(true);
    const init = await rpc(server, 2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const instructions = (init.result as unknown as { instructions: string }).instructions;
    expect(instructions).toContain('tacendum_notify_owner');
    expect(instructions).not.toContain('no send capability');
  });

  it('initialize RECORDS the client capabilities (bookkeeping for ask_owner v2), and changes nothing else', async () => {
    seedAccount('surface-caps');
    class Peek extends McpNotifyServer {
      caps(): Record<string, unknown> | null {
        return this.clientCapabilities;
      }
    }
    const server = new Peek('surface-caps');
    expect(server.caps()).toBeNull();
    await rpc(server, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {}, roots: {} },
    });
    expect(server.caps()).toEqual({ elicitation: {}, roots: {} });
  });
});

describe('local pre-refusals, each before any dial, each leaving the transport alive', () => {
  it('an unpaired account is refused naming `tacendum pair`, with no dial and no state written', async () => {
    seedAccount('refuse-unpaired', { paired: false });
    const server = new FakeDialServer('refuse-unpaired');
    const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'hello' });
    expect(errText(frame)).toContain('tacendum pair');
    expect(server.deliveries).toEqual([]);
    expect(bucketOf('refuse-unpaired')).toBeNull();
    expect(auditLines('refuse-unpaired')).toEqual([]);
    // The transport outlives the refusal.
    const who = await call(server, 2, 'tacendum_whoami');
    expect(who.result?.isError).toBeUndefined();
  });

  it('an over-cap body is refused NAMING the cap — never truncated, never dialled', async () => {
    seedAccount('refuse-cap');
    const server = new FakeDialServer('refuse-cap');
    const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'x'.repeat(281) });
    const text = errText(frame);
    expect(text).toContain('281');
    expect(text).toContain('280');
    expect(text).toContain('never truncated');
    expect(server.deliveries).toEqual([]);
    expect(auditLines('refuse-cap')).toEqual([]);
    const who = await call(server, 2, 'tacendum_whoami');
    expect(who.result?.isError).toBeUndefined();
  });

  it('an exhausted quota is refused with a retry-after, and the refusal takes nothing', async () => {
    seedAccount('refuse-quota');
    const server = new FakeDialServer('refuse-quota');
    for (let i = 0; i < NOTIFY_OWNER_PER_HOUR; i += 1) {
      const ok = await call(server, i + 1, 'tacendum_notify_owner', { body: `n${i}` });
      expect(ok.result?.isError, JSON.stringify(ok)).toBeUndefined();
    }
    const frame = await call(server, 99, 'tacendum_notify_owner', { body: 'one more' });
    const text = errText(frame);
    expect(text).toContain(`${NOTIFY_OWNER_PER_HOUR}/hour`);
    expect(text).toMatch(/retry after \d+s/);
    expect(text).toContain('do not re-issue');
    expect(server.deliveries).toHaveLength(NOTIFY_OWNER_PER_HOUR);
    expect(bucketOf('refuse-quota')?.sends).toBe(NOTIFY_OWNER_PER_HOUR);
    expect(auditLines('refuse-quota')).toHaveLength(NOTIFY_OWNER_PER_HOUR);
  });

  it('the quota survives a "restart": a second server instance on the same account is still refused', async () => {
    seedAccount('refuse-quota-restart');
    const first = new FakeDialServer('refuse-quota-restart');
    for (let i = 0; i < NOTIFY_OWNER_PER_HOUR; i += 1) {
      await call(first, i + 1, 'tacendum_notify_owner', { body: `n${i}` });
    }
    const second = new FakeDialServer('refuse-quota-restart');
    const frame = await call(second, 1, 'tacendum_notify_owner', { body: 'after restart' });
    expect(errText(frame)).toContain('do not re-issue');
    expect(second.deliveries).toEqual([]);
  });

  it('argument-shape violations are protocol errors (-32602), not tool errors', async () => {
    seedAccount('refuse-shape');
    const server = new FakeDialServer('refuse-shape');
    for (const args of [
      {},
      { body: 42 },
      { body: '' },
      { body: 'ok', extra: true },
      { body: 'ok', idempotency_key: 'k'.repeat(129) },
      // A control character in the key: written as the ESCAPE, never as a raw
      // NUL byte, or grep classifies this whole file as binary and skips it.
      { body: 'ok', idempotency_key: 'a\u0000b' },
      { body: '\uD800 lone surrogate' },
    ]) {
      const out = await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'tacendum_notify_owner', arguments: args },
        }),
      );
      const frame = JSON.parse(out as string) as Frame;
      expect(frame.error?.code, JSON.stringify(args)).toBe(-32602);
    }
    expect(server.deliveries).toEqual([]);
  });
});

describe('the send path: audit before the network, journal-first idempotency, the ledger row', () => {
  it('every dial happens with its audit line already durable, and the line carries no body', async () => {
    seedAccount('send-audit');
    const server = new FakeDialServer('send-audit');
    const frame = await call(server, 1, 'tacendum_notify_owner', {
      body: 'the plaintext that must not land in the audit',
      idempotency_key: 'audit-1',
    });
    expect(frame.result?.isError).toBeUndefined();
    expect(server.auditLinesAtDial).toEqual([1]); // durable BEFORE the dial
    const lines = auditLines('send-audit');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      recipient: 'owner',
      owner: OWNER_ID,
      byte_count: Buffer.byteLength('the plaintext that must not land in the audit', 'utf8'),
      idempotency_key: 'audit-1',
    });
    expect(JSON.stringify(lines[0])).not.toContain('plaintext that must not');
  });

  it('an unwritable audit sink refuses the send: no dial, no quota take, no journal entry (M11 shape)', async () => {
    seedAccount('send-audit-closed');
    const dir = stateDir('send-audit-closed');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const audit = join(dir, 'mcp-audit.jsonl');
    writeFileSync(audit, '', { mode: 0o600 });
    chmodSync(audit, 0o000);
    try {
      const server = new FakeDialServer('send-audit-closed');
      const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'x', idempotency_key: 'k1' });
      expect(errText(frame)).toContain('audit');
      expect(server.deliveries).toEqual([]);
      expect(bucketOf('send-audit-closed')).toBeNull();
      const journal = join(dir, 'mcp-idempotency.json');
      expect(existsSync(journal)).toBe(false);
      // Fail closed is not fail dead: writable again, the same call sends.
      chmodSync(audit, 0o600);
      const retry = await call(server, 2, 'tacendum_notify_owner', { body: 'x', idempotency_key: 'k1' });
      expect(retry.result?.isError).toBeUndefined();
      expect(server.deliveries).toHaveLength(1);
    } finally {
      chmodSync(audit, 0o600);
    }
  });

  it('a replayed key is ONE send, ONE audit line: the second call answers duplicate:true with the original msgId', async () => {
    seedAccount('send-dup');
    const server = new FakeDialServer('send-dup');
    const first = await call(server, 1, 'tacendum_notify_owner', { body: 'ping', idempotency_key: 'dup-1' });
    const msgId = first.result?.structuredContent?.msgId as string;
    expect(msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const second = await call(server, 2, 'tacendum_notify_owner', { body: 'ping', idempotency_key: 'dup-1' });
    expect(second.result?.isError).toBeUndefined();
    expect(second.result?.structuredContent).toMatchObject({ duplicate: true, msgId });
    expect(String(second.result?.structuredContent?.note)).toContain('do not re-issue');
    expect(server.deliveries).toHaveLength(1);
    expect(auditLines('send-dup')).toHaveLength(1);
    expect(bucketOf('send-dup')?.sends).toBe(1); // no quota take on replay
  });

  it('a key whose dial FAILED reuses its msgId on retry — mint once, reuse across retries', async () => {
    seedAccount('send-retry');
    const server = new FakeDialServer('send-retry');
    server.behavior = 'fail';
    const failed = await call(server, 1, 'tacendum_notify_owner', { body: 'ping', idempotency_key: 'retry-1' });
    expect(failed.result?.isError).toBe(true);
    expect(server.deliveries).toHaveLength(1);
    const minted = server.deliveries[0]?.msgId as string;
    server.behavior = 'ok';
    const retried = await call(server, 2, 'tacendum_notify_owner', { body: 'ping', idempotency_key: 'retry-1' });
    expect(retried.result?.isError).toBeUndefined();
    expect(retried.result?.structuredContent).toMatchObject({ delivered: true, msgId: minted });
    // Both ATTEMPTS were audited and budgeted — the accepted cost the module
    // states: dedupe collapses the message, never the spend.
    expect(auditLines('send-retry')).toHaveLength(2);
    expect(bucketOf('send-retry')?.sends).toBe(2);
  });

  it('a delivered notify appends the outbound ledger row (hook writer shape) and returns the msgId', async () => {
    seedAccount('send-row');
    const server = new FakeDialServer('send-row');
    const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'row me' });
    const msgId = frame.result?.structuredContent?.msgId as string;
    expect(frame.result?.structuredContent).toMatchObject({ delivered: true, owner: OWNER_ID });
    const { MessageLog } = await import('../src/msglog.js');
    const rows = new MessageLog('send-row').read({ dir: 'out' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: msgId, peer: OWNER_ID, text: '', read: true });
  });

  it('a dial error that embeds the ws URL leaves the frame with the bearer REDACTED (the chokepoint holds)', async () => {
    seedAccount('send-redact');
    const server = new FakeDialServer('send-redact');
    server.behavior = 'fail-with-url';
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'tacendum_notify_owner', arguments: { body: 'x' } },
    });
    const out = await server.handleLine(line);
    expect(out).not.toContain(TOKEN);
    const frame = JSON.parse(out as string) as Frame;
    expect(frame.result?.isError).toBe(true);
    expect(frame.result?.content?.[0]?.text).toContain('connect failed');
  });
});

describe('the durable window and journal arithmetic (moving clock: `now` is a parameter, never a pin)', () => {
  it('the window expires by ARITHMETIC: exhausted at T, refused at T+59m, admitted at T+60m', () => {
    seedAccount('win-roll');
    const t0 = Date.now();
    for (let i = 0; i < NOTIFY_OWNER_PER_HOUR; i += 1) {
      const a = admitNotify('win-roll', { owner: OWNER_ID, byteCount: 1, now: t0 + i });
      expect(a.kind).toBe('admitted');
    }
    const refused = admitNotify('win-roll', { owner: OWNER_ID, byteCount: 1, now: t0 + 59 * 60 * 1000 });
    expect(refused.kind).toBe('quota');
    if (refused.kind === 'quota') {
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);
    }
    const admitted = admitNotify('win-roll', { owner: OWNER_ID, byteCount: 1, now: t0 + 60 * 60 * 1000 });
    expect(admitted.kind).toBe('admitted');
  });

  it('idempotency entries age out on the TTL: a delivered key replays fresh after it', () => {
    seedAccount('ttl-age');
    const t0 = Date.now();
    const first = admitNotify('ttl-age', { owner: OWNER_ID, byteCount: 1, key: 'aged', now: t0 });
    expect(first.kind).toBe('admitted');
    markDelivered('ttl-age', 'aged');
    const replayed = admitNotify('ttl-age', { owner: OWNER_ID, byteCount: 1, key: 'aged', now: t0 + 1000 });
    expect(replayed.kind).toBe('duplicate');
    const aged = admitNotify('ttl-age', {
      owner: OWNER_ID,
      byteCount: 1,
      key: 'aged',
      now: t0 + IDEMPOTENCY_TTL_MS + 1000,
    });
    expect(aged.kind).toBe('admitted');
    if (first.kind === 'admitted' && aged.kind === 'admitted') {
      expect(aged.msgId).not.toBe(first.msgId); // a NEW logical send, honestly
    }
  });

  it('the journal is count-capped, oldest dropped first, and the file never exceeds the cap', () => {
    seedAccount('cap-count');
    const t0 = Date.now();
    // Spread across windows so the quota admits all of them; well inside TTL.
    const nowFor = (i: number): number => t0 + Math.floor(i / NOTIFY_OWNER_PER_HOUR) * 60 * 60 * 1000 + (i % NOTIFY_OWNER_PER_HOUR);
    const total = IDEMPOTENCY_MAX_ENTRIES + 5;
    for (let i = 0; i < total; i += 1) {
      const a = admitNotify('cap-count', { owner: OWNER_ID, byteCount: 1, key: `k${i}`, now: nowFor(i) });
      expect(a.kind, `admit ${i}`).toBe('admitted');
      markDelivered('cap-count', `k${i}`);
    }
    const journal = JSON.parse(
      readFileSync(join(stateDir('cap-count'), 'mcp-idempotency.json'), 'utf8'),
    ) as { entries: Array<{ key: string }> };
    expect(journal.entries.length).toBeLessThanOrEqual(IDEMPOTENCY_MAX_ENTRIES);
    // The OLDEST keys fell out: k0 replays as a fresh admission…
    const oldest = admitNotify('cap-count', { owner: OWNER_ID, byteCount: 1, key: 'k0', now: nowFor(total) });
    expect(oldest.kind).toBe('admitted');
    // …while the newest is still a duplicate.
    const newest = admitNotify('cap-count', {
      owner: OWNER_ID,
      byteCount: 1,
      key: `k${total - 1}`,
      now: nowFor(total),
    });
    expect(newest.kind).toBe('duplicate');
  });
});

describe('ordering under a parked send', () => {
  it('a notify that blows its deadline answers isError IN ORDER, and the whoami behind it still answers', async () => {
    seedAccount('order-deadline');
    const server = new ShortDeadlineServer('order-deadline');
    server.behavior = 'hang';
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let raw = '';
    stdout.on('data', (d: Buffer | string) => {
      raw += d.toString();
    });
    const done = runMcpTransport(server, stdin, stdout);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tacendum_notify_owner', arguments: { body: 'park me' } } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tacendum_whoami', arguments: {} } })}\n`,
    );
    stdin.end();
    await done;
    const frames = raw
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Frame);
    expect(frames.map(f => f.id)).toEqual([1, 2]);
    expect(frames[0]?.result?.isError).toBe(true);
    expect(frames[0]?.result?.content?.[0]?.text).toContain('deadline');
    expect(frames[1]?.result?.structuredContent).toMatchObject({ label: 'order-deadline' });
  });
});

describe('the Art. 50 marker on the notify dial (the remediation’s F7)', () => {
  // The lane's own red-first pair: restore an unmarked deliver at
  // mcp-notify.ts's dial and the attested test goes red; wrap without the
  // attestation and the un-attested test goes red. The attestation is
  // attend.json's ONE field, read by the same `markerAttested` every sender
  // lane consults — written here directly because attend is not enabled for
  // an MCP-only account and the funnel must not require it to be.
  const attest = (account: string): void => {
    writeFileSync(
      join(clientDir(account), 'attend.json'),
      JSON.stringify({ markerMinAppBuild: 11 }),
    );
  };

  it('attested: the delivered body is the marked msg envelope, words inside', async () => {
    seedAccount('marker-on');
    attest('marker-on');
    const server = new FakeDialServer('marker-on');
    const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'the build is green' });
    expect(frame.result?.isError, JSON.stringify(frame)).toBeUndefined();
    expect(server.deliveries).toHaveLength(1);
    const body = server.deliveries[0]?.body as string;
    expect(body.startsWith('{"tcm":"msg"')).toBe(true);
    expect(JSON.parse(body)).toEqual({ tcm: 'msg', text: 'the build is green', ai: true });
    // The cap judged the WORDS, not the wrapper: byte_count is the raw body's.
    expect(frame.result?.structuredContent).toMatchObject({
      byte_count: Buffer.byteLength('the build is green', 'utf8'),
    });
  });

  it('un-attested: the delivered body is byte-bare — exactly what left yesterday', async () => {
    seedAccount('marker-off');
    const server = new FakeDialServer('marker-off');
    const frame = await call(server, 1, 'tacendum_notify_owner', { body: 'the build is green' });
    expect(frame.result?.isError, JSON.stringify(frame)).toBeUndefined();
    expect(server.deliveries[0]?.body).toBe('the build is green');
  });
});
