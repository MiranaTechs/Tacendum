import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * A REDACTION APPLIED TO A SERIALIZED DOCUMENT IS NOT A REDACTION — IT IS A
 * CORRUPTION THAT SOMETIMES ALSO REDACTS.
 *
 * `gate.structured-credential.test.ts` closed the disclosure: `Reporter.emit`
 * put its record through the credential chokepoint so a server answering with
 * the bearer as its `userId` could not print it. The fix was applied to the
 * OUTPUT OF `JSON.stringify` — and that is a second defect wearing the first
 * one's clothes.
 *
 * WHAT IT COSTS. The chokepoint replaces every eight-character run of a
 * registered credential, wherever it occurs. In a serialized document those
 * runs occur in places that are not string values:
 *
 *   - inside a NUMBER. A token beginning `12345678` and a server timestamp of
 *     `1234567890123` share that run, so `{"ts":1234567890123}` came out as
 *     `{"ts":[credential withheld]90123}` — which no JSON parser accepts.
 *   - across a DELIMITER. `","` and `":"` are ordinary characters to a
 *     substring search; a needle that spans one takes the punctuation with it.
 *
 * Both halves are server-chosen. A hostile server mints the token AND sends
 * the timestamps, so it can make `listen --json`, `gcall` and `calllog`
 * unparseable at will — a denial of the one output shape a script consumes,
 * produced by the code that exists to protect it.
 *
 * THE FIX IS STRUCTURAL, NOT A LONGER ESCAPE LIST: redact the VALUES and then
 * serialize, so the document is valid BY CONSTRUCTION and a marker can never
 * land anywhere but inside a string. This file pins that property from three
 * directions — the boundary itself, the real binary, and the MCP transport,
 * which was writing to stdout outside the boundary altogether.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-valueredact-'));
process.env.TACENDUM_HOME = home;

const { Reporter } = await import('../src/output.js');
const { forgetCredentials, guardCredential } = await import('../src/render.js');
const { saveProfile } = await import('../src/profile.js');
const { McpServer } = await import('../src/mcp.js');
const { MessageLog } = await import('../src/msglog.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

/**
 * A 43-character token in the shape the server mints (`randomBytes(32)` as
 * base64url) whose first eight characters are DIGITS. Nothing about it is
 * malformed; a base64url alphabet contains digits, and a server that wants
 * this collision simply keeps minting until it gets one — or picks it.
 */
const NUMERIC_TOKEN = '12345678Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9r';

/** The colliding server value: a millisecond timestamp opening with the same
 * eight digits. `1234567890123` is 2009-02-13, and any `ts` a server chooses
 * can be made to open with any eight digits it likes. */
const COLLIDING_MS = 1234567890123;

/** Capture one Reporter write without a terminal. */
function captured(fn: (write: (chunk: string) => boolean) => void): string {
  let out = '';
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — narrowing the overload set is the point of the stub.
  process.stdout.write = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  try {
    fn(process.stdout.write as unknown as (chunk: string) => boolean);
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe('the structured boundary redacts values, not the document', () => {
  afterEach(() => forgetCredentials());

  it('emits VALID JSON when a credential run collides with a number', () => {
    guardCredential(NUMERIC_TOKEN);
    const report = new Reporter({ json: true, plain: true });
    // The `listen --json` row shape: a server-chosen timestamp beside a
    // server-chosen body, printed by `Reporter.line` -> `emit`.
    const out = captured(() =>
      report.line(
        { ts: COLLIDING_MS, from: '01ARZ3NDEKTSV4RRFFQ69G5FAV', body: 'hello' },
        'unused under --json',
      ),
    );
    // THE ASSERTION THAT FAILED: the line a consumer parses.
    const parsed = JSON.parse(out) as { ts: unknown; body: unknown };
    // …AND IT IS STILL THE SAME FACT. The number is a number, unaltered: a
    // redaction that ate a digit would be a corruption too, just a quieter one.
    expect(parsed.ts).toBe(COLLIDING_MS);
    expect(parsed.body).toBe('hello');
    // …and the credential is still gone from string positions.
    expect(out).not.toContain(NUMERIC_TOKEN);
  });

  it('redacts a credential that IS a string value, leaving the document valid', () => {
    guardCredential(NUMERIC_TOKEN);
    const report = new Reporter({ json: true, plain: true });
    const out = captured(() => report.emit({ userId: NUMERIC_TOKEN, ok: true }, 'x'));
    const parsed = JSON.parse(out) as { userId: string; ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.userId).not.toContain(NUMERIC_TOKEN.slice(0, 8));
    expect(parsed.userId).toMatch(/withheld|\[--\]/);
  });

  it('never lets a marker straddle a delimiter', () => {
    // A needle whose only eight-character windows — `aaaa","b` and `aaa","bb`
    // — exist ONLY in the serialized form, spanning the `","` between two
    // fields. Neither value contains one, so a values-first pass finds nothing
    // and the document is untouched; a document-first pass replaces the run
    // WITH ITS PUNCTUATION and the object never closes.
    guardCredential('aaaa","bb');
    const report = new Reporter({ json: true, plain: true });
    const out = captured(() => report.emit({ a: 'aaaa', b: 'bb' }, 'x'));
    expect(JSON.parse(out)).toEqual({ a: 'aaaa', b: 'bb' });
  });

  it('walks nested arrays and objects, not just the top level', () => {
    guardCredential(NUMERIC_TOKEN);
    const report = new Reporter({ json: true, plain: true });
    const out = captured(() =>
      report.emit({ rows: [{ ts: COLLIDING_MS, tok: NUMERIC_TOKEN }] }, 'x'),
    );
    const parsed = JSON.parse(out) as { rows: { ts: number; tok: string }[] };
    expect(parsed.rows[0]?.ts).toBe(COLLIDING_MS);
    expect(parsed.rows[0]?.tok).not.toContain(NUMERIC_TOKEN.slice(0, 8));
  });

  it('protects the printers whose HUMAN form is the same JSON document', () => {
    // `calllog` and `gcall` pass `JSON.stringify(record)` on BOTH arms — the
    // gate parses their output with `json.load` whether or not `--json` was
    // passed — so a fix that only covered the `--json` arm would leave the
    // shape those two actually run in broken.
    guardCredential(NUMERIC_TOKEN);
    const report = new Reporter({ json: false, plain: true });
    const out = captured(() => report.emitRecord({ live: true, se: COLLIDING_MS }));
    expect(JSON.parse(out)).toEqual({ live: true, se: COLLIDING_MS });
  });
});

/**
 * THE SAME PROPERTY THROUGH THE REAL BINARY, on the command whose output an
 * e2e gate parses as JSON without asking for `--json`: `tacendum gcall`. The
 * token comes off disk (`loadProfile` registers it at the chokepoint) and the
 * colliding number comes out of the session dump, so nothing here is staged
 * inside the process under test.
 */
describe('through the real binary', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const account = 'valueredact';

  function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
        cwd: repoRoot,
        env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
      });
      child.stdin.end();
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('gcall prints parseable JSON when the stored token collides with a number', async () => {
    const dir = join(home, account);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({
        name: account,
        identityKey: 'IDKEYMARKERBASE64==',
        userId: '01VALUEREDACT00000000000A',
        authToken: NUMERIC_TOKEN,
        registrationId: 7,
        deviceId: 1,
      }),
      { mode: 0o600 },
    );
    // The dump a live small-group session leaves — the WHOLE shape
    // `snapshot()` writes, since `readGroupCallState` validates it now
    // (gate.gc3-state-shape.test.ts). `se` is a server-influenced counter and a
    // number, and it is printed inside the one document the gate parses.
    writeFileSync(
      join(dir, 'gcall-state.json'),
      JSON.stringify({
        live: true,
        sid: '01SESSION0000000000000000',
        starterId: '01VALUEREDACT00000000000A',
        selfId: '01VALUEREDACT00000000000A',
        roster: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        announced: [],
        se: COLLIDING_MS,
        video: false,
        phase: 'active',
        legs: [],
        heldOffers: [],
        callKit: null,
        connected: false,
        endedReason: null,
      }),
    );

    const r = await runCli(['gcall', account]);
    expect(r.code, `gcall stderr was:\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as { live: boolean; se: number };
    expect(parsed.live).toBe(true);
    expect(parsed.se).toBe(COLLIDING_MS);
    expect(`${r.stdout}${r.stderr}`).not.toContain(NUMERIC_TOKEN);
  }, 120_000);
});

/**
 * MCP WRITES TO STDOUT OUTSIDE THE REPORTER ENTIRELY.
 *
 * `runMcpServer` owns its own stream — stdout IS the JSON-RPC transport — so
 * every serialization in mcp.ts stood outside the credential chokepoint that
 * output.ts installed. Under the same `userId === authToken` response the
 * `gate.structured-credential` gate reproduces, `tacendum_whoami` returned the
 * bearer TWICE in one frame: once inside `content[0].text` and once as
 * `structuredContent.userId`.
 */
describe('the MCP transport is inside the boundary too', () => {
  afterEach(() => forgetCredentials());

  it('tacendum_whoami emits no run of the bearer, in either half of the frame', async () => {
    // The hostile-but-well-formed response `AuthResponse` permits: the same
    // 43-character value as both `userId` and `authToken`.
    const COLLIDED = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt';
    const name = 'mcpcollide';
    saveProfile({
      name,
      identityKey: 'IDKEYMARKERBASE64==',
      userId: COLLIDED,
      authToken: COLLIDED,
      registrationId: 7,
      deviceId: 1,
    });
    new MessageLog(name); // the spool the server validates at construction

    const server = new McpServer(name);
    const raw = await server.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tacendum_whoami', arguments: {} },
      }),
    );
    expect(raw).not.toBeNull();
    const line = raw as string;

    // NOT VACUOUS: the frame is still a frame, and the tool still answered.
    const frame = JSON.parse(line) as {
      result: { content: { type: string; text: string }[]; structuredContent: unknown };
    };
    expect(frame.result.structuredContent).toBeTruthy();
    // The nested document a host reads as text must still parse.
    const nested = JSON.parse(frame.result.content[0]!.text) as { label: string };
    expect(nested.label).toBe(name);

    // THE ASSERTION. Eight characters is the chokepoint's own disclosure floor
    // and below the ten V8 quotes; a leak that arrives cut in half is a leak.
    for (let i = 0; i + 8 <= COLLIDED.length; i++) {
      expect(line, `an 8-character run of the bearer (offset ${i}) reached stdout`).not.toContain(
        COLLIDED.slice(i, i + 8),
      );
    }
  });
});
