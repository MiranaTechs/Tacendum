import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'tacendum-mcp-'));
process.env.TACENDUM_HOME = home;

const { saveProfile } = await import('../src/profile.js');
const { MessageLog, REDACT_AFTER_MS } = await import('../src/msglog.js');
const { stateDir } = await import('../src/config.js');
const { McpServer, runMcpServer, BODY_CAP_BYTES, RESPONSE_CAP_BYTES, LIMIT_MAX, ACK_MAX } =
  await import('../src/mcp.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const USER_ID = '01AGENTAGENTAGENTAGENTAGEN';
const PEER_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PEER_B = '01BXBBXBBXBBXBBXBBXBBXBBXB';
/** Distinctive on purpose: the tests assert these strings NEVER appear in a
 * frame, so they must be unmistakable if they ever do. */
const IDENTITY_KEY = 'IDKEYMARKERBASE64SECRET==';
const AUTH_TOKEN = 'tok-SECRET-DO-NOT-EMIT';

let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HXXXXXXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER_A,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

function makeAccount(name: string): InstanceType<typeof MessageLog> {
  saveProfile({
    name,
    identityKey: IDENTITY_KEY,
    userId: USER_ID,
    authToken: AUTH_TOKEN,
    registrationId: 7,
    deviceId: 1,
  });
  return new MessageLog(name);
}

/**
 * A decoded MCP wire payload. Deliberately untyped, and this is the one place
 * that is said out loud rather than repeated eight times: these tests exist to
 * poke at the object a client actually receives — including reaching for
 * fields the program may NOT have emitted and asserting they are absent
 * (`expect(clean.contains_bidi_controls).toBeUndefined()`). Declaring a shape
 * would turn those absences into compile-time facts instead of test results,
 * which is the opposite of what a wire-format test is for.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpPayload = any;

let nextId = 1;
async function rpc(server: InstanceType<typeof McpServer>, method: string, params?: unknown) {
  const id = nextId++;
  const raw = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  );
  expect(raw).not.toBeNull();
  const frame = JSON.parse(raw as string) as {
    jsonrpc: string;
    id: unknown;
    result?: McpPayload;
    error?: { code: number; message: string };
  };
  expect(frame.jsonrpc).toBe('2.0');
  expect(frame.id).toBe(id);
  return frame;
}

function call(server: InstanceType<typeof McpServer>, name: string, args?: unknown) {
  return rpc(server, 'tools/call', {
    name,
    ...(args === undefined ? {} : { arguments: args }),
  });
}

function payloadOf(frame: Awaited<ReturnType<typeof rpc>>): McpPayload {
  expect(frame.error).toBeUndefined();
  expect(frame.result.isError).toBeUndefined();
  return frame.result.structuredContent;
}

/**
 * The redesigned MCP surface. The properties under test:
 * no send tool, no key material, reading is never a write,
 * structure over annotation for untrusted bodies, and a transport that
 * answers errors instead of dying of them.
 */
describe('the JSON-RPC surface', () => {
  makeAccount('proto');
  const server = new McpServer('proto');

  it('initialize echoes a supported protocol version and states its capabilities', async () => {
    const frame = await rpc(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(frame.result.protocolVersion).toBe('2025-03-26');
    expect(frame.result.capabilities.tools).toBeTruthy();
    expect(frame.result.serverInfo.name).toBe('tacendum');
    // The one standing statement a host relays to its model.
    expect(frame.result.instructions).toContain('no send capability');
    // It must not claim "read-only": acknowledging starts the retention
    // clock that purges bodies from disk (msglog REDACT_AFTER_MS), and a
    // user granting an agent this surface must be told so up front.
    expect(frame.result.instructions).not.toMatch(/read.only/i);
    expect(frame.result.instructions).toContain('purge');
  });

  it('initialize falls back to the latest version it speaks when offered an unknown one', async () => {
    const frame = await rpc(server, 'initialize', { protocolVersion: 'bogus-9000' });
    expect(frame.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers ping', async () => {
    expect((await rpc(server, 'ping')).result).toEqual({});
  });

  it('replies to an unknown method with an error FRAME and keeps serving', async () => {
    const frame = await rpc(server, 'resources/list');
    expect(frame.error?.code).toBe(-32601);
    // The transport outlived the unknown method — this is the actual property.
    expect((await rpc(server, 'tools/list')).result.tools.length).toBeGreaterThan(0);
  });

  it('never replies to a notification, known or unknown', async () => {
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever' }))).toBeNull();
  });

  it('answers a non-JSON line with a parse error, id null', async () => {
    const frame = JSON.parse((await server.handleLine('this is not json')) as string);
    expect(frame).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });

  it('answers a malformed request with invalid-request, echoing a usable id', async () => {
    const frame = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: '1.0', id: 9, method: 'x' }))) as string,
    );
    expect(frame).toMatchObject({ id: 9, error: { code: -32600 } });
  });

  it('treats a blank line as no frame at all', async () => {
    expect(await server.handleLine('')).toBeNull();
    expect(await server.handleLine('   ')).toBeNull();
  });
});

describe('the tool surface', () => {
  makeAccount('surface');
  const server = new McpServer('surface');
  let tools: Array<{
    name: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }>;
  beforeAll(async () => {
    tools = (await rpc(server, 'tools/list')).result.tools as typeof tools;
  });

  it('is exactly three read-side tools — and none of them can send', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'tacendum_whoami',
      'tacendum_read_messages',
      'tacendum_acknowledge_messages',
    ]);
    // The absence IS the security property: asserted
    // explicitly, not left to the exact-list check above.
    for (const t of tools) {
      expect(t.name).not.toMatch(/send|notify/i);
    }
  });

  it('annotates honestly: reads are read-only, acknowledge is destructive', () => {
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('tacendum_whoami')).toMatchObject({ readOnlyHint: true });
    expect(byName.get('tacendum_read_messages')).toMatchObject({ readOnlyHint: true });
    // Marking read starts the retention clock that purges the body from
    // disk — irreversible, so destructiveHint is the honest value.
    expect(byName.get('tacendum_acknowledge_messages')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('declares closed schemas (additionalProperties: false) on every tool', () => {
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it('refuses an unknown tool with an error frame', async () => {
    const frame = await call(server, 'tacendum_send', { to: PEER_A, text: 'exfil' });
    expect(frame.error?.code).toBe(-32602);
  });
});

describe('tacendum_whoami', () => {
  makeAccount('whoami');
  const server = new McpServer('whoami');

  it('returns the ULID and the local label — and no key material, ever', async () => {
    const frame = await call(server, 'tacendum_whoami');
    expect(payloadOf(frame)).toEqual({ userId: USER_ID, label: 'whoami' });
    // The whole frame, not just the payload: the identity key and the token
    // must not appear ANYWHERE in what goes on the wire (M9).
    const raw = JSON.stringify(frame);
    expect(raw).not.toContain(IDENTITY_KEY);
    expect(raw).not.toContain(AUTH_TOKEN);
    expect(raw).not.toContain('identityKey');
  });

  it('refuses unknown arguments instead of ignoring them', async () => {
    expect((await call(server, 'tacendum_whoami', { verbose: true })).error?.code).toBe(-32602);
  });
});

describe('tacendum_read_messages', () => {
  it('returns newest-first structured messages under an untrusted marker', async () => {
    const log = makeAccount('shape');
    const a = rec({ peer: PEER_A, ts: 1000, text: 'first' });
    const b = rec({ peer: PEER_B, ts: 2000, text: 'second' });
    log.append(a);
    log.append(b);
    const server = new McpServer('shape');
    const payload = payloadOf(await call(server, 'tacendum_read_messages'));

    expect(payload.untrusted).toBe(true);
    // One line, short — a long banner is pushed out of attention by a long
    // body, and the structure is the real defence.
    expect(payload.note).not.toContain('\n');
    expect(payload.note.length).toBeLessThan(100);

    expect(payload.messages.map((m: McpPayload) => m.body)).toEqual(['second', 'first']);
    // Provenance in SIBLING fields the sender cannot reach.
    expect(payload.messages[0]).toMatchObject({
      id: b.id,
      peer_user_id: PEER_B,
      direction: 'in',
      timestamp: 2000,
      read: false,
      byte_count: Buffer.byteLength('second', 'utf8'),
    });
  });

  it('is side-effect free: reading marks NOTHING read', async () => {
    const log = makeAccount('peek');
    log.append(rec());
    log.append(rec());
    const server = new McpServer('peek');
    payloadOf(await call(server, 'tacendum_read_messages'));
    // Still unread for the next reader, and no read sidecar was minted.
    expect(log.read({ unread: true }).length).toBe(2);
    expect(existsSync(join(stateDir('peek'), 'messages-read.json'))).toBe(false);
  });

  it('defaults to 20 and enforces the hard max of 100', async () => {
    const log = makeAccount('paging');
    for (let i = 0; i < 25; i++) log.append(rec());
    const server = new McpServer('paging');
    expect(payloadOf(await call(server, 'tacendum_read_messages')).messages.length).toBe(20);
    expect(
      payloadOf(await call(server, 'tacendum_read_messages', { limit: 5 })).messages.length,
    ).toBe(5);
    // Refused, not clamped: a silently shrunk page becomes a caller that
    // believes it saw everything.
    expect((await call(server, 'tacendum_read_messages', { limit: LIMIT_MAX + 1 })).error?.code).toBe(-32602);
    expect((await call(server, 'tacendum_read_messages', { limit: 0 })).error?.code).toBe(-32602);
    expect((await call(server, 'tacendum_read_messages', { limit: 2.5 })).error?.code).toBe(-32602);
  });

  it('filters by peer — ULID only, never a local nickname', async () => {
    const log = makeAccount('peerfilter');
    log.append(rec({ peer: PEER_A }));
    log.append(rec({ peer: PEER_B }));
    const server = new McpServer('peerfilter');
    const payload = payloadOf(await call(server, 'tacendum_read_messages', { peer: PEER_B }));
    expect(payload.messages.length).toBe(1);
    expect(payload.messages[0].peer_user_id).toBe(PEER_B);
    // A name would resolve via the peer's ENTIRE on-disk profile (token
    // included) — the id path reads nothing, so it is the only path here.
    const refused = await call(server, 'tacendum_read_messages', { peer: 'alice' });
    expect(refused.error?.code).toBe(-32602);
    expect(refused.error?.message).toContain('nicknames are not accepted');
  });

  it('honours unread_only and refuses unknown arguments', async () => {
    const log = makeAccount('unread');
    const r1 = rec();
    log.append(r1);
    log.append(rec());
    log.markRead([r1.id]);
    const server = new McpServer('unread');
    expect(
      payloadOf(await call(server, 'tacendum_read_messages', { unread_only: true })).messages.length,
    ).toBe(1);
    // The args.ts rule, agent edition: a typo'd argument name must refuse,
    // not silently return everything while the caller believes it filtered.
    expect((await call(server, 'tacendum_read_messages', { unread: true })).error?.code).toBe(-32602);
  });

  it('caps one body at 8 KiB with an out-of-band flag, never an in-band marker', async () => {
    const log = makeAccount('bodycap');
    const big = 'A'.repeat(20_000);
    log.append(rec({ text: big }));
    const server = new McpServer('bodycap');
    const [m] = payloadOf(await call(server, 'tacendum_read_messages')).messages;
    expect(Buffer.byteLength(m.body, 'utf8')).toBe(BODY_CAP_BYTES);
    expect(m.truncated).toBe(true);
    // byte_count carries the FULL size, so truncation is measurable.
    expect(m.byte_count).toBe(20_000);
    // The delivered body is a pure prefix: nothing was injected into the
    // string a sender controls.
    expect(m.body).toBe(big.slice(0, BODY_CAP_BYTES));
  });

  it('never splits a multi-byte character at the cap', async () => {
    const log = makeAccount('utf8cap');
    log.append(rec({ text: '€'.repeat(3000) })); // 9000 bytes of 3-byte chars
    const server = new McpServer('utf8cap');
    const [m] = payloadOf(await call(server, 'tacendum_read_messages')).messages;
    expect(Buffer.byteLength(m.body, 'utf8')).toBeLessThanOrEqual(BODY_CAP_BYTES);
    expect(m.body).not.toContain('�');
    expect(m.truncated).toBe(true);
  });

  it('caps the response total at 64 KiB while keeping every message\'s provenance', async () => {
    const log = makeAccount('totalcap');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = rec({ text: 'B'.repeat(BODY_CAP_BYTES) });
      ids.push(r.id);
      log.append(r);
    }
    const server = new McpServer('totalcap');
    const payload = payloadOf(await call(server, 'tacendum_read_messages', { limit: 10 }));
    expect(payload.messages.length).toBe(10);
    const total = payload.messages.reduce(
      (sum: number, m: McpPayload) => sum + Buffer.byteLength(m.body, 'utf8'),
      0,
    );
    expect(total).toBeLessThanOrEqual(RESPONSE_CAP_BYTES);
    // The overflow messages lose their BODY, never their provenance: the
    // caller is told they exist and can page for them.
    const starved = payload.messages.filter((m: McpPayload) => m.body === '');
    expect(starved.length).toBeGreaterThan(0);
    for (const m of starved) {
      expect(m.truncated).toBe(true);
      expect(ids).toContain(m.id);
    }
  });

  it('strips C0/C1 controls exactly as render.ts does for terminals', async () => {
    const log = makeAccount('controls');
    log.append(rec({ text: 'bad\u001b[2K\rgood' }));
    const server = new McpServer('controls');
    const [m] = payloadOf(await call(server, 'tacendum_read_messages')).messages;
    expect(m.body).toBe('bad[2Kgood');
  });

  it('flags bidi controls instead of rewriting the text', async () => {
    const log = makeAccount('bidi');
    log.append(rec({ text: 'abc\u202Exyz' }));
    log.append(rec({ text: 'plain' }));
    const server = new McpServer('bidi');
    const payload = payloadOf(await call(server, 'tacendum_read_messages'));
    const flagged = payload.messages.find((m: McpPayload) => m.body.includes('abc'));
    expect(flagged.contains_bidi_controls).toBe(true);
    // Told, not altered: the text still carries the RLO character.
    expect(flagged.body).toContain('\u202E');
    const clean = payload.messages.find((m: McpPayload) => m.body === 'plain');
    expect(clean.contains_bidi_controls).toBeUndefined();
  });

  it('rejects invalid UTF-8 (a lone surrogate) by withholding the body, flagged', async () => {
    const log = makeAccount('surrogate');
    log.append(rec({ text: 'x\uD800y' }));
    const server = new McpServer('surrogate');
    const [m] = payloadOf(await call(server, 'tacendum_read_messages')).messages;
    expect(m.invalid_utf8).toBe(true);
    expect(m.body).toBe('');
  });

  it('reports a retention-redacted record as metadata, not as an empty message', async () => {
    const log = makeAccount('redacted');
    const r = rec({ text: 'the door code is 4211' });
    log.append(r);
    log.markRead([r.id], Date.now() - REDACT_AFTER_MS - 1000);
    log.applyRetention();
    const server = new McpServer('redacted');
    const [m] = payloadOf(await call(server, 'tacendum_read_messages')).messages;
    expect(m.redacted).toBe(true);
    expect(m.body).toBe('');
    expect(m.byte_count).toBe(Buffer.byteLength('the door code is 4211', 'utf8'));
  });
});

describe('tacendum_acknowledge_messages', () => {
  it('marks the given ids read — the explicit write that reading never is', async () => {
    const log = makeAccount('ack');
    const r1 = rec();
    const r2 = rec();
    log.append(r1);
    log.append(r2);
    const server = new McpServer('ack');
    const payload = payloadOf(await call(server, 'tacendum_acknowledge_messages', { ids: [r1.id] }));
    expect(payload).toEqual({ acknowledged: 1 });
    // Persisted: a fresh instance (another process, in real life) sees it.
    const again = new MessageLog('ack');
    expect(again.read({ unread: true }).map((r) => r.id)).toEqual([r2.id]);
  });

  it('ignores ids that are not in the log, so the sidecar cannot be grown without bound', async () => {
    const log = makeAccount('ackbogus');
    const r1 = rec();
    log.append(r1);
    const server = new McpServer('ackbogus');
    const bogus = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const payload = payloadOf(
      await call(server, 'tacendum_acknowledge_messages', { ids: [bogus, r1.id] }),
    );
    expect(payload).toEqual({ acknowledged: 1 });
    const sidecar = readFileSync(join(stateDir('ackbogus'), 'messages-read.json'), 'utf8');
    expect(sidecar).toContain(r1.id);
    expect(sidecar).not.toContain(bogus);
  });

  it('caps a call at 100 ids and refuses malformed ones', async () => {
    makeAccount('acklimits');
    const server = new McpServer('acklimits');
    const many = Array.from({ length: ACK_MAX + 1 }, () => '01HXXXXXXXXXXXXXXXXXX00001');
    expect((await call(server, 'tacendum_acknowledge_messages', { ids: many })).error?.code).toBe(-32602);
    expect(
      (await call(server, 'tacendum_acknowledge_messages', { ids: ['../../etc/passwd'] })).error?.code,
    ).toBe(-32602);
    expect((await call(server, 'tacendum_acknowledge_messages', { ids: 'notanarray' })).error?.code).toBe(-32602);
    expect((await call(server, 'tacendum_acknowledge_messages', {})).error?.code).toBe(-32602);
  });

  it('runs the retention pass — the one write path MCP-only accounts have', async () => {
    const log = makeAccount('ackretain');
    const old = rec({ text: 'purge me' });
    log.append(old);
    // Consumed >24h ago: due for redaction on the next pass, whoever runs it.
    log.markRead([old.id], Date.now() - REDACT_AFTER_MS - 1000);
    const fresh = rec();
    log.append(fresh);
    const server = new McpServer('ackretain');
    payloadOf(await call(server, 'tacendum_acknowledge_messages', { ids: [fresh.id] }));
    const purged = log.read().find((r) => r.id === old.id);
    expect(purged?.red).toBe(true);
    expect(readFileSync(log.path, 'utf8')).not.toContain('purge me');
  });
});

describe('startup refusals (before any frame exists)', () => {
  it('refuses an account with no profile', () => {
    // The message no longer quotes the name (a misconfigured variable
    // puts a secret in this argument); it names the condition instead.
    expect(() => new McpServer('never-registered')).toThrow(/no such account/);
  });

  it('refuses a missing --account with usage, not a hang on stdio', async () => {
    await expect(runMcpServer(undefined)).rejects.toThrow(/usage: tacendum mcp --account/);
  });

  it('refuses a spool that has gone group/world readable', () => {
    const log = makeAccount('loosespool');
    log.append(rec());
    chmodSync(log.path, 0o644);
    expect(() => new McpServer('loosespool')).toThrow(/refusing to use the message log/);
    chmodSync(log.path, 0o600);
    expect(() => new McpServer('loosespool')).not.toThrow();
  });

  it('refuses a state directory that has gone group/world accessible', () => {
    const log = makeAccount('loosedir');
    log.append(rec());
    chmodSync(stateDir('loosedir'), 0o755);
    expect(() => new McpServer('loosedir')).toThrow(/chmod 700/);
    chmodSync(stateDir('loosedir'), 0o700);
  });
});

/**
 * The transport itself, over REAL stdio: stdout must contain well-formed
 * JSON-RPC frames and NOTHING else — one stray print corrupts the stream and
 * the host silently disconnects, which is the hazard this whole file is
 * built around.
 */
describe('a full session over real stdio', () => {
  it('emits only well-formed JSON-RPC frames on stdout and exits 0 at EOF', async () => {
    const log = makeAccount('stdio');
    log.append(rec({ text: 'hello over stdio' }));

    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', 'mcp', '--account', 'stdio'],
      { cwd: repoRoot, env: { ...process.env, TACENDUM_HOME: home } },
    );

    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tacendum_read_messages', arguments: {} } }),
      'garbage that is not a frame',
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tacendum_whoami' } }),
    ];
    child.stdin.write(`${lines.join('\n')}\n`);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    expect(code, `stderr was:\n${stderr}`).toBe(0);

    const frames = stdout.split('\n').filter((l) => l !== '');
    // Five requests that deserve an answer (4 with ids + the garbage line's
    // parse error) — and NOT ONE line more.
    expect(frames.length).toBe(5);
    const parsed = frames.map((l) => JSON.parse(l) as McpPayload);
    for (const f of parsed) {
      expect(f.jsonrpc).toBe('2.0');
      expect('id' in f).toBe(true);
      expect('result' in f || 'error' in f).toBe(true);
    }
    expect(parsed.map((f) => f.id)).toEqual([1, 2, 3, null, 4]);

    // The seeded message actually travelled, structured and marked untrusted.
    const read = parsed.find((f) => f.id === 3);
    expect(read.result.structuredContent.untrusted).toBe(true);
    expect(read.result.structuredContent.messages[0].body).toBe('hello over stdio');

    // And no key material rode along on any frame (M9).
    expect(stdout).not.toContain(IDENTITY_KEY);
    expect(stdout).not.toContain(AUTH_TOKEN);
  });
});
