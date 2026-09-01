import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `tacendum_ask_owner` — the MCP tool that parks on a phone answer
 *. Every dial goes through the `deliver` seam
 * faked, exactly as the suite fakes it, so what runs REAL here is
 * everything around the dial: the pre-refusals, the SHARED admission
 * (bucket + idempotency journal + fsync'd audit line), the mcp-asks claim
 * journal on real files under its real lock, the park loop through the io
 * seam, and attend's step-over against the journal file attend actually
 * reads. Red-first mutations for this file are recorded in the change
 * note; the named ones:
 *
 *  - register the ask tool on the default server  -> the absence test red
 *  - drop the attend step-over classification     -> the no-turn test red
 *  - skip the burn on answer (state stays asking) -> the double-reply test red
 *  - give ask its own quota bucket                -> the shared-budget test red
 *  - write the ask row AFTER the dial             -> the journal-first test red
 *  - drop the transportEnded wiring               -> the EOF test red (hangs)
 *
 * MOVING CLOCK THROUGHOUT (the frozen-clock ruling): the park's clock is the
 * io seam's `now`, advanced INSIDE the fake `sleep` — time moves the way it
 * moves in production, only faster. No test pins Date.now() beside a timer.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcp-ask-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://ask.test';
process.env.TACENDUM_WS = 'ws://ask.test';

const { saveProfile } = await import('../src/profile.js');
const { clientDir, stateDir } = await import('../src/config.js');
const { McpServer, runMcpTransport } = await import('../src/mcp.js');
const { NOTIFY_OWNER_PER_HOUR, admitNotify, markDelivered } = await import('../src/mcp-notify.js');
const {
  ASK_DRAIN_EVERY_MS,
  ASK_TTL_DEFAULT_MS,
  ASK_TTL_MAX_MS,
  ASK_TTL_MIN_MS,
  McpAskServer,
  McpNotifyAskServer,
  readMcpAskStepOver,
} = await import('../src/mcp-ask.js');
const { MessageLog } = await import('../src/msglog.js');
const { attendOnce, saveAttendConfig } = await import('../src/attend.js');

const OWNER_ID = '01XWNERXWNERXWNERXWNERXWNE';
const TOKEN = 'tok-ask-e2e-SECRET-VALUE';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const rid = (): string => `01HQXWASK00000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function seedAccount(name: string, opts: { paired: boolean } = { paired: true }): void {
  saveProfile({
    name,
    identityKey: 'IDKEYASK==',
    userId: '01AGENTAGENTAGENTAGENTAGEN',
    authToken: TOKEN,
    registrationId: 1,
    deviceId: 1,
    ...(opts.paired ? { accountClass: 'integration' as const, ownerUserId: OWNER_ID } : {}),
  });
}

interface AskRowView {
  q?: string;
  bytes?: number;
  msgId: string;
  state: string;
  askedAt: number;
  deadline: number;
  answerId?: string;
}

function asksOf(account: string): AskRowView[] {
  const p = join(stateDir(account), 'mcp-asks.json');
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, 'utf8')) as { rows: AskRowView[] }).rows;
}

function auditLines(account: string): Array<Record<string, unknown>> {
  const p = join(stateDir(account), 'mcp-audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

function bucketOf(account: string): { windowStart: number; sends: number } | null {
  const p = join(stateDir(account), 'mcp-notify-bucket.json');
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf8')) as { windowStart: number; sends: number })
    : null;
}

function appendReply(account: string, ref: string, text: string, ts = Date.now()): string {
  const id = rid();
  new MessageLog(account).append({
    id,
    dir: 'in',
    peer: OWNER_ID,
    ts,
    tcm: 'reply',
    text,
    read: false,
    ref,
  });
  return id;
}

/** The moving clock: `now` is a closure, `sleep` advances it. `gated: true`
 * parks each sleep on an explicit `tick()`, for tests that interleave other
 * work (attendOnce) with a live park deterministically. */
function harness(opts: { gated?: boolean } = {}) {
  let t = Date.now();
  const state = {
    sleeps: 0,
    drains: 0,
    gates: [] as Array<() => void>,
    onSleep: undefined as ((n: number) => void) | undefined,
  };
  return {
    state,
    now: (): number => t,
    /** Advance the clock WITHOUT a sleep — for boundary tests that need the
     * park to wake (EOF/backstop) at a time its own sleeps never reach. */
    jump: (ms: number): void => {
      t += ms;
    },
    tick: (): void => {
      const g = state.gates.splice(0);
      for (const res of g) res();
    },
    io: {
      now: (): number => t,
      sleep: (ms: number): Promise<void> => {
        t += ms;
        state.sleeps += 1;
        state.onSleep?.(state.sleeps);
        if (opts.gated === true) {
          return new Promise<void>(res => {
            state.gates.push(res);
          });
        }
        return Promise.resolve();
      },
      drain: async (): Promise<void> => {
        state.drains += 1;
      },
    },
  };
}

type Harness = ReturnType<typeof harness>;

class FakeAskServer extends McpAskServer {
  deliveries: Array<{ owner: string; body: string; msgId: string }> = [];
  /** Journal-first proof: was the ask row DURABLE (state asking) when the
   * dial happened? Captured at the seam, like the auditLinesAtDial. */
  askingAtDial: boolean[] = [];
  behavior: 'ok' | 'fail' = 'ok';
  constructor(
    private readonly acct: string,
    h: Harness,
  ) {
    super(acct, h.io);
  }
  protected override async deliver(owner: string, body: string, msgId: string): Promise<void> {
    this.askingAtDial.push(asksOf(this.acct).some(r => r.msgId === msgId && r.state === 'asking'));
    this.deliveries.push({ owner, body, msgId });
    if (this.behavior === 'fail') throw new Error('dial failed (test)');
  }
  /** The ToolRun seam, for the backstop test: `onDeadline` is what the real
   * transport fires when ASK_PARK_DEADLINE_MS expires (mcp.ts), and firing
   * it here is the only way to test that path without a real 61-minute
   * timer. */
  askTool(): { onDeadline?: () => void; run: (args: Record<string, unknown>) => unknown } {
    const tool = this.toolRun('tacendum_ask_owner');
    if (tool === null) throw new Error('ask tool missing');
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
    instructions?: string;
    tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
  };
  error?: { code: number; message: string };
}

async function call(
  server: InstanceType<typeof McpServer>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Frame> {
  const out = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  );
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

async function poll(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

// The transport rebinds the console; restore after any harness test.
const realConsole = { log: console.log, info: console.info, warn: console.warn };
afterEach(() => {
  console.log = realConsole.log;
  console.info = realConsole.info;
  console.warn = realConsole.warn;
});

describe('the tool surface per launch mode (independent, additive opt-ins)', () => {
  it('--ask-owner alone: the three read tools + tacendum_ask_owner, NO notify tool, honest instructions', async () => {
    seedAccount('surf-ask');
    const server = new FakeAskServer('surf-ask', harness());
    const list = await rpc(server, 1, 'tools/list');
    expect(list.result?.tools?.map(t => t.name)).toEqual([
      'tacendum_whoami',
      'tacendum_read_messages',
      'tacendum_acknowledge_messages',
      'tacendum_ask_owner',
    ]);
    const ask = list.result?.tools?.[3];
    expect(ask?.annotations?.readOnlyHint).toBe(false);
    expect(ask?.annotations?.openWorldHint).toBe(true);
    const init = await rpc(server, 2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    expect(instructions).toContain('tacendum_ask_owner');
    // The parked-transport limitation is stated, not hidden.
    expect(instructions).toContain('answers no other request');
    expect(instructions).not.toContain('no send capability');
    expect(instructions).not.toContain('tacendum_notify_owner');
    // A notify-shaped call on an ask-only launch is an UNKNOWN tool.
    const notify = await call(server, 3, 'tacendum_notify_owner', { body: 'x' });
    expect(notify.error?.message).toContain('unknown tool');
  });

  it('--ask-owner --notify-owner: exactly the five tools, both named in the instructions', async () => {
    seedAccount('surf-both');
    const server = new McpNotifyAskServer('surf-both');
    const list = await rpc(server, 1, 'tools/list');
    expect(list.result?.tools?.map(t => t.name)).toEqual([
      'tacendum_whoami',
      'tacendum_read_messages',
      'tacendum_acknowledge_messages',
      'tacendum_notify_owner',
      'tacendum_ask_owner',
    ]);
    const init = await rpc(server, 2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const instructions = (init.result as { instructions?: string }).instructions ?? '';
    expect(instructions).toContain('tacendum_notify_owner');
    expect(instructions).toContain('tacendum_ask_owner');
  });

  it('the DEFAULT launch does not know the ask tool: absent from tools/list, unknown to the executor', async () => {
    seedAccount('surf-default');
    const server = new McpServer('surf-default');
    const list = await rpc(server, 1, 'tools/list');
    for (const t of list.result?.tools ?? []) {
      expect(t.name).not.toContain('ask');
    }
    const ask = await call(server, 2, 'tacendum_ask_owner', { question: 'x' });
    expect(ask.error?.message).toContain('unknown tool');
  });
});

describe('ask pre-refusals, each before any dial, each leaving the transport alive', () => {
  it('an unpaired account is refused naming `tacendum pair`, with no dial, no audit, no journal', async () => {
    seedAccount('ask-unpaired', { paired: false });
    const server = new FakeAskServer('ask-unpaired', harness());
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'ok to ship?' });
    expect(errText(frame)).toContain('tacendum pair');
    expect(server.deliveries).toEqual([]);
    expect(auditLines('ask-unpaired')).toEqual([]);
    expect(asksOf('ask-unpaired')).toEqual([]);
    const who = await call(server, 2, 'tacendum_whoami');
    expect(who.result?.isError).toBeUndefined();
  });

  it('an over-cap question is refused NAMING the cap — never truncated, never dialled', async () => {
    seedAccount('ask-cap');
    const server = new FakeAskServer('ask-cap', harness());
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'x'.repeat(281) });
    const text = errText(frame);
    expect(text).toContain('281');
    expect(text).toContain('280');
    expect(text).toContain('never truncated');
    expect(server.deliveries).toEqual([]);
    expect(auditLines('ask-cap')).toEqual([]);
  });

  it('argument-shape violations are protocol errors (-32602), not tool errors', async () => {
    seedAccount('ask-shape');
    const server = new FakeAskServer('ask-shape', harness());
    for (const args of [
      {},
      { question: 42 },
      { question: '' },
      { question: 'ok?', extra: true },
      { question: 'ok?', ttl_seconds: 'soon' },
      { question: 'ok?', ttl_seconds: Number.NaN },
      // A control character in the key: written as the ESCAPE, never as a raw
      // NUL byte, or grep classifies this whole file as binary and skips it.
      { question: 'ok?', idempotency_key: 'a\u0000b' },
      { question: '\uD800 lone surrogate' },
    ]) {
      const out = await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'tacendum_ask_owner', arguments: args },
        }),
      );
      const frame = JSON.parse(out as string) as Frame;
      expect(frame.error?.code, JSON.stringify(args)).toBe(-32602);
    }
    expect(server.deliveries).toEqual([]);
  });

  it('an unwritable audit sink refuses the ask: no dial, no ask row (M11 fail-closed, inherited whole)', async () => {
    seedAccount('ask-audit-closed');
    const dir = stateDir('ask-audit-closed');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const audit = join(dir, 'mcp-audit.jsonl');
    writeFileSync(audit, '', { mode: 0o600 });
    chmodSync(audit, 0o000);
    try {
      const server = new FakeAskServer('ask-audit-closed', harness());
      const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'x' });
      expect(errText(frame)).toContain('audit');
      expect(server.deliveries).toEqual([]);
      expect(asksOf('ask-audit-closed')).toEqual([]);
      expect(bucketOf('ask-audit-closed')).toBeNull();
    } finally {
      chmodSync(audit, 0o600);
    }
  });
});

describe('the park: reply, TTL, EOF — all on the moving clock', () => {
  it('park → reply → answered, the text byte-exact through the funnel, the id burned, the audit told', async () => {
    seedAccount('park-answer');
    const h = harness();
    const server = new FakeAskServer('park-answer', h);
    const answer = 'Sí — ✅ ship the ██ build, dañado or not';
    h.state.onSleep = n => {
      if (n === 2) {
        appendReply('park-answer', server.deliveries[0]?.msgId as string, answer, h.now());
      }
    };
    const frame = await call(server, 1, 'tacendum_ask_owner', {
      question: 'ship the build?',
      idempotency_key: 'ship-1',
    });
    expect(frame.result?.isError, JSON.stringify(frame)).toBeUndefined();
    const sc = frame.result?.structuredContent as Record<string, unknown>;
    expect(sc.answered).toBe(true);
    expect(sc.text).toBe(answer); // byte-exact: nothing stripped, nothing cut
    expect(sc.byte_count).toBe(Buffer.byteLength(answer, 'utf8'));
    expect(sc.msgId).toBe(server.deliveries[0]?.msgId);
    // Journal-first held: the ask row was durable when the dial happened.
    expect(server.askingAtDial).toEqual([true]);
    // The journal: answered, the answer row claimed, the question PURGED.
    const rows = asksOf('park-answer');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'answered', msgId: sc.msgId, answerId: sc.answer_id });
    expect(rows[0]?.q).toBeUndefined();
    expect(rows[0]?.bytes).toBe(Buffer.byteLength('ship the build?', 'utf8'));
    // The audit trail: the 'ask' admission line, then 'ask_answered' — byte
    // counts and ids only, never the question or the answer.
    const lines = auditLines('park-answer');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'ask', recipient: 'owner', owner: OWNER_ID });
    expect(lines[1]).toMatchObject({ kind: 'ask_answered', msgId: sc.msgId, answer_id: sc.answer_id });
    const raw = readFileSync(join(stateDir('park-answer'), 'mcp-audit.jsonl'), 'utf8');
    expect(raw).not.toContain('ship the build');
    expect(raw).not.toContain('dañado');
  });

  it('park → TTL lapse on a MOVING clock: {answered:false, lapsed:true}, the id burned, the drain cadence honoured', async () => {
    seedAccount('park-lapse');
    const h = harness();
    const server = new FakeAskServer('park-lapse', h);
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'anyone there?', ttl_seconds: 60 });
    expect(frame.result?.isError).toBeUndefined();
    const sc = frame.result?.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ answered: false, lapsed: true });
    expect(String(sc.note)).toContain('ordinary message');
    // 60 s of fake time at the 1 s poll: the clock MOVED there.
    expect(h.state.sleeps).toBe(60);
    // The serverless drain arm ran on its cadence through the io seam.
    expect(h.state.drains).toBe(Math.floor((60_000 - 1) / ASK_DRAIN_EVERY_MS));
    const rows = asksOf('park-lapse');
    expect(rows[0]).toMatchObject({ state: 'lapsed' });
    expect(rows[0]?.q).toBeUndefined();
    const lines = auditLines('park-lapse');
    expect(lines[1]).toMatchObject({ kind: 'ask_lapsed', msgId: sc.msgId });
  });

  it('the TTL clamps to the spine bounds: floor 30 s, ceiling 1 h, default 10 m — by park arithmetic', async () => {
    seedAccount('park-clamp');
    for (const [args, ms] of [
      [{ ttl_seconds: 1 }, ASK_TTL_MIN_MS],
      [{ ttl_seconds: 999_999 }, ASK_TTL_MAX_MS],
      [{}, ASK_TTL_DEFAULT_MS],
    ] as Array<[Record<string, unknown>, number]>) {
      const h = harness();
      const server = new FakeAskServer('park-clamp', h);
      const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'clamp?', ...args });
      expect(frame.result?.structuredContent).toMatchObject({ lapsed: true });
      expect(h.state.sleeps, JSON.stringify(args)).toBe(ms / 1000);
    }
  });

  it('EOF mid-park drains clean: the park resolves abandoned, the frame is written, the process exits the loop', async () => {
    seedAccount('park-eof');
    const h = harness({ gated: true });
    const server = new FakeAskServer('park-eof', h);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let raw = '';
    stdout.on('data', (d: Buffer | string) => {
      raw += d.toString();
    });
    const done = runMcpTransport(server, stdin, stdout);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tacendum_ask_owner', arguments: { question: 'still there?' } } })}\n`,
    );
    await poll(() => server.deliveries.length === 1);
    stdin.end(); // the host hangs up while the ask is parked
    await done; // the drain rule: this settles — the mutation target
    const frames = raw
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Frame);
    expect(frames.map(f => f.id)).toEqual([1]);
    const sc = frames[0]?.result?.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ answered: false, abandoned: true });
    // The result the host never reads still says it: the question STAYS SENT.
    expect(String(sc.note)).toContain('already delivered');
    expect(asksOf('park-eof')[0]).toMatchObject({ state: 'abandoned' });
    expect(auditLines('park-eof')[1]).toMatchObject({ kind: 'ask_abandoned' });
  });

  it('a settled idempotency_key answers duplicate:true with the state — never re-asked, never re-parked', async () => {
    seedAccount('park-dup');
    const h = harness();
    const server = new FakeAskServer('park-dup', h);
    h.state.onSleep = n => {
      if (n === 1) appendReply('park-dup', server.deliveries[0]?.msgId as string, 'yes', h.now());
    };
    const first = await call(server, 1, 'tacendum_ask_owner', { question: 'go?', idempotency_key: 'go-1' });
    expect(first.result?.structuredContent).toMatchObject({ answered: true });
    const replay = await call(server, 2, 'tacendum_ask_owner', { question: 'go?', idempotency_key: 'go-1' });
    expect(replay.result?.isError).toBeUndefined();
    expect(replay.result?.structuredContent).toMatchObject({
      duplicate: true,
      msgId: first.result?.structuredContent?.msgId,
      state: 'answered',
    });
    expect(server.deliveries).toHaveLength(1); // ONE dial for one logical question
    expect(auditLines('park-dup').filter(l => l.kind === 'ask')).toHaveLength(1);
  });

  it('ONE quota bucket for owner-directed sends: notify admissions and asks spend the same tokens', async () => {
    seedAccount('park-quota');
    const h = harness();
    const server = new FakeAskServer('park-quota', h);
    h.state.onSleep = n => {
      if (n === 1) appendReply('park-quota', server.deliveries.at(-1)?.msgId as string, 'ok', h.now());
    };
    const first = await call(server, 1, 'tacendum_ask_owner', { question: 'one?' });
    expect(first.result?.structuredContent).toMatchObject({ answered: true });
    // The ask landed in the NOTIFY bucket — same file, same window.
    expect(bucketOf('park-quota')?.sends).toBe(1);
    // Fill the rest of the shared window through the notify admission path…
    for (let i = 1; i < NOTIFY_OWNER_PER_HOUR; i += 1) {
      const a = admitNotify('park-quota', { owner: OWNER_ID, byteCount: 1, now: h.now() });
      expect(a.kind).toBe('admitted');
    }
    // …and the NEXT ask is refused naming the shared budget.
    const refused = await call(server, 2, 'tacendum_ask_owner', { question: 'one more?' });
    const text = errText(refused);
    expect(text).toContain(`${NOTIFY_OWNER_PER_HOUR}/hour`);
    expect(text).toContain('shared with');
    expect(text).toContain('tacendum_notify_owner');
    expect(server.deliveries).toHaveLength(1);
  });

  it('a failed dial leaves the row asking and a keyed retry re-arms the SAME msgId — mint once, reuse across retries', async () => {
    seedAccount('park-retry');
    const h = harness();
    const server = new FakeAskServer('park-retry', h);
    server.behavior = 'fail';
    const failed = await call(server, 1, 'tacendum_ask_owner', { question: 'again?', idempotency_key: 'r1' });
    expect(failed.result?.isError).toBe(true);
    const minted = server.deliveries[0]?.msgId as string;
    expect(asksOf('park-retry')[0]).toMatchObject({ msgId: minted, state: 'asking' });
    server.behavior = 'ok';
    h.state.onSleep = n => {
      if (n === 1) appendReply('park-retry', minted, 'yes', h.now());
    };
    const retried = await call(server, 2, 'tacendum_ask_owner', { question: 'again?', idempotency_key: 'r1' });
    expect(retried.result?.structuredContent).toMatchObject({ answered: true, msgId: minted });
  });
});

describe('attend steps over a parked ask (a recorded hazard, closed)', () => {
  const attendHarness = () => {
    const replies: string[] = [];
    const turns: { argv: string[]; cwd: string; prompt: string }[] = [];
    return {
      replies,
      turns,
      io: {
        sendReply: async (b: string): Promise<void> => void replies.push(b),
        runTurn: async (
          argv: string[],
          cwd: string,
          prompt: string,
        ): Promise<{ stdout: string; code: number }> => {
          turns.push({ argv, cwd, prompt });
          return { stdout: 'done: ran', code: 0 };
        },
      },
    };
  };

  function seedBot(): void {
    rmSync(join(home, 'bot'), { recursive: true, force: true });
    rmSync(join(home, 'state', 'bot'), { recursive: true, force: true });
    saveProfile({
      name: 'bot',
      identityKey: 'AAAA',
      userId: '01HQXW0000000000000000TEST',
      deviceId: 1,
      authToken: 'tok',
      registrationId: 1,
      accountClass: 'integration',
      ownerUserId: OWNER_ID,
    });
    saveAttendConfig('bot', {
      host: 'claude',
      bin: '/opt/agent',
      workdir: '/w',
      caps: [],
      ownSession: OWN_SESSION,
      turnsPerHour: 10,
    });
  }

  const cursorOf = (): { lastId?: string } | null => {
    const p = join(home, 'state', 'bot', 'attend-cursor.json');
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { lastId?: string }) : null;
  };

  it('a LIVE park: the answer is no trigger and the cursor holds; the claim flips it to a covered, stepped-over row', async () => {
    seedBot();
    const a = attendHarness();
    const h = harness({ gated: true });
    const server = new FakeAskServer('bot', h);

    // Park a real ask on the real journal.
    const pending = call(server, 1, 'tacendum_ask_owner', { question: 'merge the release?' });
    await poll(() => server.deliveries.length === 1);
    const msgId = server.deliveries[0]?.msgId as string;

    // The owner's answer arrives in the spool (a daemon spooled it).
    const answerId = appendReply('bot', msgId, 'approve');

    // WHILE PARKED: no turn, no reply, and the CURSOR FILE does not move —
    // the pinned halves of the step-over ("not a trigger" AND "not
    // skipped-past"). Mutation target: drop the step-over -> this runs a
    // turn whose prompt is the word "approve".
    expect(await attendOnce('bot', a.io)).toBe('mcp-parked');
    expect(a.turns).toHaveLength(0);
    expect(a.replies).toHaveLength(0);
    expect(cursorOf()).toBeNull();

    // The park claims the answer.
    h.tick();
    const frame = await pending;
    expect(frame.result?.structuredContent).toMatchObject({ answered: true, text: 'approve' });
    expect(readMcpAskStepOver('bot', Date.now()).claimedIds.has(answerId)).toBe(true);

    // AFTER THE CLAIM: the row is covered — stepped over exactly as an
    // approval-spent row is, cursor past it, nothing sent, and a RESTARTED
    // attend (a fresh pass IS the restart: every read is from disk) never
    // triggers on it either.
    expect(await attendOnce('bot', a.io)).toBe('stepped');
    expect(a.turns).toHaveLength(0);
    expect(a.replies).toHaveLength(0);
    expect(cursorOf()?.lastId).toBe(answerId);
    expect(await attendOnce('bot', a.io)).toBe('idle');
  });

  it('double-reply: the second reply to a settled ask is an ORDINARY message (the id is burned)', async () => {
    seedBot();
    const a = attendHarness();
    const h = harness();
    const server = new FakeAskServer('bot', h);
    h.state.onSleep = n => {
      if (n === 1) appendReply('bot', server.deliveries[0]?.msgId as string, 'yes', h.now());
    };
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'proceed?' });
    expect(frame.result?.structuredContent).toMatchObject({ answered: true });
    const msgId = server.deliveries[0]?.msgId as string;

    // First pass: step over the claimed answer.
    expect(await attendOnce('bot', a.io)).toBe('stepped');

    // The owner replies AGAIN to the same (settled) question.
    const second = appendReply('bot', msgId, 'also do the docs');
    expect(readMcpAskStepOver('bot', Date.now()).pendingRefs.size).toBe(0);

    // The second reply is ordinary: it routes like any reply whose ref
    // resolves to a sess-less ledger row — the honest 'ended' answer, a
    // consumed row, an advanced cursor. NOT a park hold, NOT a step-over.
    const outcome = await attendOnce('bot', a.io);
    expect(outcome).not.toBe('mcp-parked');
    expect(outcome).not.toBe('stepped');
    expect(a.replies.length + a.turns.length).toBeGreaterThan(0);
    expect(cursorOf()?.lastId).toBe(second);
  });

  it('fail-open: a missing, corrupt, or DEADLINE-PAST journal leaves attend exactly as it was before', async () => {
    const journalPath = join(home, 'state', 'bot', 'mcp-asks.json');
    const runShape = async (
      prepare: (msgId: string) => void,
    ): Promise<{ outcome: string; turns: number; replies: number; cursor: string | undefined }> => {
      seedBot();
      const a = attendHarness();
      // The seam's exact spool shape: an MCP out-row (no sess) + a reply.
      const msgId = rid();
      new MessageLog('bot').append({
        id: msgId,
        dir: 'out',
        peer: OWNER_ID,
        ts: Date.now(),
        tcm: '',
        text: '',
        read: true,
      });
      appendReply('bot', msgId, 'approve');
      prepare(msgId);
      const outcome = await attendOnce('bot', a.io);
      return {
        outcome,
        turns: a.turns.length,
        replies: a.replies.length,
        cursor: cursorOf()?.lastId,
      };
    };

    // The baseline IS prior behaviour: no journal file at all.
    const baseline = await runShape(() => undefined);
    expect(baseline.outcome).not.toBe('mcp-parked');

    // A corrupt journal must behave IDENTICALLY (fail-open, empty sets)…
    const corrupt = await runShape(() => writeFileSync(journalPath, '{nonsense', { mode: 0o600 }));
    expect(corrupt.outcome).toBe(baseline.outcome);
    expect(corrupt.turns).toBe(baseline.turns);
    expect(corrupt.replies).toBe(baseline.replies);

    // …and so must a journal whose park DIED (deadline in the past): the
    // pending claim expires with the ask, so a crashed MCP process can hold
    // attend no longer than the ask's own TTL.
    const stale = await runShape(msgId =>
      writeFileSync(
        journalPath,
        JSON.stringify({
          rows: [{ q: '?', msgId, state: 'asking', askedAt: Date.now() - 700_000, deadline: Date.now() - 100_000 }],
        }),
        { mode: 0o600 },
      ),
    );
    expect(stale.outcome).toBe(baseline.outcome);
    expect(stale.turns).toBe(baseline.turns);
    expect(stale.replies).toBe(baseline.replies);
  });
});

describe('adversarial replies: one reply, ONE consumer, at every boundary', () => {
  const attendIo = () => {
    const replies: string[] = [];
    const turns: string[] = [];
    return {
      replies,
      turns,
      io: {
        sendReply: async (b: string): Promise<void> => void replies.push(b),
        runTurn: async (
          _argv: string[],
          _cwd: string,
          prompt: string,
        ): Promise<{ stdout: string; code: number }> => {
          turns.push(prompt);
          return { stdout: 'done: ran', code: 0 };
        },
      },
    };
  };

  function seedAttending(name: string): void {
    seedAccount(name);
    saveAttendConfig(name, {
      host: 'claude',
      bin: '/opt/agent',
      workdir: '/w',
      caps: [],
      ownSession: OWN_SESSION,
      turnsPerHour: 10,
    });
  }

  const cursorAt = (name: string): string | undefined => {
    const p = join(home, 'state', name, 'attend-cursor.json');
    return existsSync(p)
      ? (JSON.parse(readFileSync(p, 'utf8')) as { lastId?: string }).lastId
      : undefined;
  };

  it('F1: a reply found EXACTLY at the deadline tick lapses unclaimed — journal, audit, host, and attend tell ONE story', async () => {
    seedAttending('rev-f1');
    const h = harness();
    const server = new FakeAskServer('rev-f1', h);
    let replyId = '';
    h.state.onSleep = n => {
      if (n === 60) {
        // The owner's reply lands in the spool at t = askedAt + TTL, the
        // exact tick the sweep lapses the row. Pre-fix, the park claimed it
        // anyway: host told answered, journal lapsed and unclaimed, audit
        // said ask_answered, and attend consumed the same reply AGAIN —
        // three records, three stories. Mutation target: return shapeAnswer
        // without checking the claim landed -> every assertion below red.
        replyId = appendReply('rev-f1', server.deliveries[0]?.msgId as string, 'approve', h.now());
      }
    };
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'merge?', ttl_seconds: 60 });
    expect(frame.result?.isError).toBeUndefined();
    const sc = frame.result?.structuredContent as Record<string, unknown>;

    // The reply WAS found at the boundary (no further sleeps ran)…
    expect(h.state.sleeps).toBe(60);
    // …and the HOST is told lapsed, never answered: the claim did not land.
    expect(sc).toMatchObject({ answered: false, lapsed: true });
    expect(sc.text).toBeUndefined();

    // The journal agrees: lapsed, UNCLAIMED, the question purged.
    const rows = asksOf('rev-f1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'lapsed' });
    expect(rows[0]?.answerId).toBeUndefined();
    expect(rows[0]?.q).toBeUndefined();

    // The audit agrees: admission, then ask_lapsed — NEVER ask_answered.
    const lines = auditLines('rev-f1');
    expect(lines.map(l => l.kind)).toEqual(['ask', 'ask_lapsed']);

    // attend's view agrees: nothing pending (settled), nothing claimed.
    const view = readMcpAskStepOver('rev-f1', Date.now());
    expect(view.pendingRefs.size).toBe(0);
    expect(view.claimedIds.size).toBe(0);

    // And the reply's ONE consumer is attend, ONCE: the ordinary route (the
    // sess-less ledger row's honest 'ended' answer), cursor advanced, and a
    // second pass finds nothing left.
    const a = attendIo();
    const outcome = await attendOnce('rev-f1', a.io);
    expect(outcome).not.toBe('mcp-parked');
    expect(outcome).not.toBe('stepped');
    expect(a.replies).toHaveLength(1);
    expect(cursorAt('rev-f1')).toBe(replyId);
    expect(await attendOnce('rev-f1', a.io)).toBe('idle');
  });

  it("F1 (EOF variant): an EOF landing at/past the deadline lapses the row — no ask_abandoned line for a settlement that never happened", async () => {
    seedAccount('rev-f1-eof');
    const h = harness({ gated: true });
    const server = new FakeAskServer('rev-f1-eof', h);
    const pending = call(server, 1, 'tacendum_ask_owner', { question: 'still there?', ttl_seconds: 60 });
    await poll(() => h.state.gates.length === 1); // parked at its first sleep
    // The host hangs up while the machine sleeps PAST the TTL: the EOF arm
    // wakes with now >= deadline, and the sweep inside its own mutateAsks
    // settles the row to lapsed before the abandoned write can land.
    h.jump(120_000);
    server.transportEnded();
    const frame = await pending;
    const sc = frame.result?.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ answered: false, abandoned: true });
    // The journal says lapsed — and the audit does NOT claim an abandonment
    // that never landed (mutation target: audit unconditionally -> red).
    expect(asksOf('rev-f1-eof')[0]).toMatchObject({ state: 'lapsed' });
    expect(auditLines('rev-f1-eof').map(l => l.kind)).toEqual(['ask']);
  });

  it("F2: a NON-owner row ref'ing the ask's msgId is never the answer — the park waits for the owner's words", async () => {
    seedAccount('rev-f2');
    const h = harness({ gated: true });
    const server = new FakeAskServer('rev-f2', h);
    let settled = false;
    const pending = call(server, 1, 'tacendum_ask_owner', { question: 'approve?' }).then(f => {
      settled = true;
      return f;
    });
    await poll(() => h.state.gates.length === 1);
    const msgId = server.deliveries[0]?.msgId as string;

    // A third party (a crew peer, an attacker with spool access) refs the
    // ask's msgId. attend's trigger boundary is peer === owner; the park's
    // claim now holds the same line (mutation target: drop the peer clause
    // from findReply -> the park claims this row and answers 'i said yes').
    const malloryId = rid();
    new MessageLog('rev-f2').append({
      id: malloryId,
      dir: 'in',
      peer: '01MALLORYMALLORYMALLORYMAL',
      ts: h.now(),
      tcm: 'reply',
      text: 'i said yes',
      read: false,
      ref: msgId,
    });
    h.tick(); // one full poll pass over the spool with only mallory's row
    await poll(() => h.state.gates.length === 1);
    expect(settled).toBe(false); // still parked: the row did NOT answer it
    expect(asksOf('rev-f2')[0]).toMatchObject({ state: 'asking' });

    // The owner's real reply claims it — and ONLY it.
    const ownerReplyId = appendReply('rev-f2', msgId, 'yes, merge', h.now());
    h.tick();
    const frame = await pending;
    const sc = frame.result?.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ answered: true, text: 'yes, merge', answer_id: ownerReplyId });
    expect(asksOf('rev-f2')[0]).toMatchObject({ state: 'answered', answerId: ownerReplyId });
    const claimed = readMcpAskStepOver('rev-f2', Date.now()).claimedIds;
    expect(claimed.has(ownerReplyId)).toBe(true);
    expect(claimed.has(malloryId)).toBe(false); // mallory's row stays ordinary mail
  });

  it("F3a: a DEAD park's key answers duplicate with state 'lapsed' once the deadline passed — never a live 'asking'", async () => {
    seedAccount('rev-f3a');
    // A predecessor process: admitted, delivered, then crashed mid-park.
    // Its row sits `asking` with a deadline nothing has swept.
    const now = Date.now();
    const admit = admitNotify('rev-f3a', {
      owner: OWNER_ID,
      byteCount: 5,
      key: 'dead-park-1',
      now: now - 700_000,
    });
    expect(admit.kind).toBe('admitted');
    const deadMsgId = (admit as { msgId: string }).msgId;
    markDelivered('rev-f3a', 'dead-park-1');
    mkdirSync(join(home, 'state', 'rev-f3a'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'state', 'rev-f3a', 'mcp-asks.json'),
      JSON.stringify({
        rows: [
          { q: '?', msgId: deadMsgId, state: 'asking', askedAt: now - 700_000, deadline: now - 100_000 },
        ],
      }),
      { mode: 0o600 },
    );
    // The retry under the same key: duplicate, no re-dial — and the state it
    // reports applies the deadline every other reader applies (mutation
    // target: report the row verbatim -> state 'asking' for a dead park).
    const h = harness();
    const server = new FakeAskServer('rev-f3a', h);
    const frame = await call(server, 1, 'tacendum_ask_owner', {
      question: '?',
      idempotency_key: 'dead-park-1',
    });
    expect(frame.result?.structuredContent).toMatchObject({
      duplicate: true,
      msgId: deadMsgId,
      state: 'lapsed',
    });
    expect(server.deliveries).toEqual([]);
  });

  it('F4: a fired transport backstop stands the park down WITHOUT claiming — the waiting reply keeps its ordinary life', async () => {
    seedAccount('rev-f4');
    const h = harness({ gated: true });
    const server = new FakeAskServer('rev-f4', h);
    const tool = server.askTool();
    const pending = Promise.resolve(tool.run({ question: 'ship?' })) as Promise<Record<string, unknown>>;
    await poll(() => h.state.gates.length === 1);
    const msgId = server.deliveries[0]?.msgId as string;

    // The owner's reply IS in the spool when the backstop fires — the exact
    // hazard the ASK_PARK_DEADLINE_MS note records: the transport already
    // answered the host with a deadline error and abandoned the FIFO slot,
    // so a claim now would consume the reply into a void. The onDeadline
    // hook is what the real withDeadline timer calls (mcp.ts); firing it
    // here is that path minus the 61-minute wait (mutation target: drop the
    // backstop check from the park -> this hangs at the gate, red).
    appendReply('rev-f4', msgId, 'yes — ship it', h.now());
    tool.onDeadline?.();
    const out = await pending;
    expect(out).toMatchObject({ answered: false, abandoned: true });

    // Not claimed: the row settled abandoned, the reply stays unconsumed.
    expect(asksOf('rev-f4')[0]).toMatchObject({ state: 'abandoned' });
    expect(asksOf('rev-f4')[0]?.answerId).toBeUndefined();
    expect(auditLines('rev-f4').map(l => l.kind)).toEqual(['ask', 'ask_abandoned']);
    expect(readMcpAskStepOver('rev-f4', Date.now()).claimedIds.size).toBe(0);
  });
});

describe('the Art. 50 marker on the ask dial (the remediation’s F7)', () => {
  // The ask lane's red-first pair, mirroring mcp-notify.test.ts's: restore
  // an unmarked deliver at mcp-ask.ts's dial and the attested test goes
  // red; wrap without the attestation and the un-attested test goes red.
  // The asks JOURNAL keeps the RAW question either way — the row is the
  // claim's truth and the reply routes by msgId, never by body bytes.
  const attest = (account: string): void => {
    writeFileSync(
      join(clientDir(account), 'attend.json'),
      JSON.stringify({ markerMinAppBuild: 11 }),
    );
  };

  it('attested: the question dials as the marked msg envelope; the journal keeps the raw words', async () => {
    seedAccount('ask-marker-on');
    attest('ask-marker-on');
    const h = harness();
    const server = new FakeAskServer('ask-marker-on', h);
    h.state.onSleep = n => {
      if (n === 2) {
        appendReply('ask-marker-on', server.deliveries[0]?.msgId as string, 'yes', h.now());
      }
    };
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'ship the build?' });
    expect(frame.result?.isError, JSON.stringify(frame)).toBeUndefined();
    expect(server.deliveries).toHaveLength(1);
    const body = server.deliveries[0]?.body as string;
    expect(body.startsWith('{"tcm":"msg"')).toBe(true);
    expect(JSON.parse(body)).toEqual({ tcm: 'msg', text: 'ship the build?', ai: true });
    // The journal row and its byte accounting judged the RAW question.
    expect(asksOf('ask-marker-on')[0]?.bytes).toBe(Buffer.byteLength('ship the build?', 'utf8'));
  });

  it('un-attested: the question dials byte-bare — exactly what dialled yesterday', async () => {
    seedAccount('ask-marker-off');
    const h = harness();
    const server = new FakeAskServer('ask-marker-off', h);
    h.state.onSleep = n => {
      if (n === 2) {
        appendReply('ask-marker-off', server.deliveries[0]?.msgId as string, 'yes', h.now());
      }
    };
    const frame = await call(server, 1, 'tacendum_ask_owner', { question: 'ship the build?' });
    expect(frame.result?.isError, JSON.stringify(frame)).toBeUndefined();
    expect(server.deliveries[0]?.body).toBe('ship the build?');
  });
});
