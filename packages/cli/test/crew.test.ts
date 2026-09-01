import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `tacendum crew adopt` against a scripted server (crew-chat spec, Task B).
 *
 * The contract under test is the TRANSLATION layer: the server's deliberate
 * ambiguities (204 for adopted-or-already, one code for three refusals) must
 * survive into the CLI's output, and its one retryable outcome must actually
 * be retried. The route itself is proven server-side (handlers/crew.ts).
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-crew-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_WS = 'ws://crew.test';

interface Scripted {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
let script: Scripted[] = [];
const seen: { path: string; auth: string | undefined; body: unknown }[] = [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += String(d)));
  req.on('end', () => {
    seen.push({
      path: req.url ?? '',
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const next = script.shift() ?? { status: 500, body: { error: { code: 'unscripted', detail: 'x' } } };
    res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
    res.end(next.body === undefined ? '' : JSON.stringify(next.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.TACENDUM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { cmdCrewAdopt } = await import('../src/crew.js');
const { saveProfile } = await import('../src/profile.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');

const OWNER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEMBER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRY';

function report(): { r: InstanceType<typeof Reporter> } {
  return { r: new Reporter({ json: false, plain: true }) };
}

function refusal(status: number, code: string, headers?: Record<string, string>): Scripted {
  return { status, body: { error: { code, detail: 'server prose the CLI must not need' } }, headers };
}

beforeEach(() => {
  script = [];
  seen.length = 0;
  saveProfile({
    name: 'owner',
    identityKey: 'AAAA',
    userId: OWNER_ID,
    deviceId: 1,
    authToken: 'tok-owner',
    registrationId: 1,
  });
});
afterEach(() => {
  rmSync(join(home, 'owner'), { recursive: true, force: true });
  rmSync(join(home, 'bot'), { recursive: true, force: true });
});
afterAll(() => server.close());

describe('local refusals — before any network', () => {
  it('an integration account cannot adopt (the fixable mistake is named)', async () => {
    saveProfile({
      name: 'bot',
      identityKey: 'AAAA',
      userId: MEMBER_ID,
      deviceId: 1,
      authToken: 'tok-bot',
      registrationId: 1,
      accountClass: 'integration',
    });
    await expect(cmdCrewAdopt('bot', OWNER_ID, report().r)).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
    });
    expect(seen).toHaveLength(0);
  });

  it('a malformed member id is refused WITHOUT echoing the value', async () => {
    const secret = 'hunter2-the-misconfigured-var';
    const err = await cmdCrewAdopt('owner', secret, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect((err as CliError).message).not.toContain(secret);
    expect(seen).toHaveLength(0);
  });

  it('self-adoption is refused, case-insensitively', async () => {
    await expect(
      cmdCrewAdopt('owner', OWNER_ID.toLowerCase(), report().r),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(seen).toHaveLength(0);
  });
});

describe('the wire call', () => {
  it('POSTs the normalized member under the owner bearer; 204 reads as adopted', async () => {
    script.push({ status: 204 });
    const out: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => (out.push(String(chunk)), true)) as never);
    try {
      await cmdCrewAdopt('owner', MEMBER_ID.toLowerCase(), report().r);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: '/v1/crew/adopt',
      auth: 'Bearer tok-owner',
      body: { member: MEMBER_ID },
    });
    expect(out.join('')).toContain('adopted');
  });

  it('crew_contended is retried (it is contention, not refusal) and succeeds', async () => {
    script.push(refusal(503, 'crew_contended', { 'retry-after': '1' }), { status: 204 });
    await cmdCrewAdopt('owner', MEMBER_ID, report().r);
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('the 204 is RECORDED locally — the machine_peers pattern (ruling)', async () => {
    // The adopt answer is the one moment this owner's CLI learns, from the
    // server itself, that MEMBER is a machine it paired — the exact knowledge
    // the app records in machine_peers. The record is what lets the owner's
    // later roster writes carry `class: 'integration'`.
    const { FileStores } = await import('../src/stores.js');
    script.push({ status: 204 });
    await cmdCrewAdopt('owner', MEMBER_ID, report().r);
    expect(Object.keys(new FileStores('owner').loadMachinePeers())).toContain(MEMBER_ID);
  });

  it('a REFUSED adopt records nothing — only the server’s positive answer teaches', async () => {
    const { FileStores } = await import('../src/stores.js');
    const before = Object.keys(new FileStores('owner').loadMachinePeers()).length;
    script.push(refusal(403, 'not_integration_owner'));
    await cmdCrewAdopt('owner', '01BX5ZZKBKACTAV9WEVGEMMVRZ', report().r).catch(() => {});
    expect(Object.keys(new FileStores('owner').loadMachinePeers())).toHaveLength(before);
  });

  it('persistent contention gives up after three attempts with an honest message', async () => {
    script.push(
      refusal(503, 'crew_contended', { 'retry-after': '1' }),
      refusal(503, 'crew_contended', { 'retry-after': '1' }),
      refusal(503, 'crew_contended', { 'retry-after': '1' }),
    );
    const err = await cmdCrewAdopt('owner', MEMBER_ID, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    expect(err?.message).toContain('contended');
    expect(seen).toHaveLength(3);
  }, 15_000);

  it('the collapsed refusal stays collapsed: one message, exit REFUSED, naming the pairing remedy', async () => {
    script.push(refusal(403, 'not_integration_owner'));
    const err = await cmdCrewAdopt('owner', MEMBER_ID, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    // 10, not 1: a permanent policy answer, and a script that retries what
    // it read as a transient error is the mistake exit 10 exists to prevent.
    expect(err?.exitCode).toBe(EXIT.REFUSED);
    expect(err?.message).toContain('tacendum pair');
    // The server's prose is not forwarded; the CLI speaks for itself.
    expect(err?.message).not.toContain('server prose');
  });

  it('a hostile unmapped error cannot forge output: code and detail are sanitized where they enter', async () => {
    // An earlier review: status 418, a canary code, and a detail carrying a
    // newline + fake error line reached stderr and --json raw. The seal is
    // at api.ts's detail construction — the one place server error text
    // enters a CliError — so every caller inherits it.
    script.push({
      status: 418,
      body: {
        error: {
          code: 'SERVER_CODE_CANARY_' + 'X'.repeat(64),
          detail: 'SERVER_DETAIL\nerror: FORGED_SECOND_LINE\u001b[31m',
        },
      },
    });
    const err = await cmdCrewAdopt('owner', MEMBER_ID, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    expect(err).toBeInstanceOf(CliError);
    // No newline survives into the message; no escape either. The code is
    // bounded, so the canary's tail is gone.
    expect(err?.message).not.toContain('\n');
    expect(err?.message).not.toContain('\u001b');
    // The forged text may remain INLINE — sanitizing is de-fanging, not
    // censorship — but it can never open a line of its own.
    expect(err?.message).not.toMatch(/^error: FORGED_SECOND_LINE/m);
    expect(err?.message).not.toContain('X'.repeat(64));
    // The PROPERTY stays exact for matching callers.
    expect(err?.code).toBe('SERVER_CODE_CANARY_' + 'X'.repeat(64));
  });

  it('cap_reached names the cap and the remedy', async () => {
    script.push(refusal(409, 'cap_reached'));
    const err = await cmdCrewAdopt('owner', MEMBER_ID, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    expect(err?.message).toMatch(/max 8/);
    expect(err?.message).toContain('revoke');
  });

  it('an unmapped server error passes through untranslated', async () => {
    script.push(refusal(418, 'novel_code'));
    const err = await cmdCrewAdopt('owner', MEMBER_ID, report().r).then(
      () => null,
      (e: unknown) => e as CliError,
    );
    expect(err?.code).toBe('novel_code');
  });
});

describe('crew voice honors the global CLI contract (an earlier review)', () => {
  const mainPath = new URL('../src/main.ts', import.meta.url).pathname;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', mainPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, TACENDUM_HOME: home },
    });

  it('--json emits ONE JSON object, like every other command', () => {
    const out = run('crew', 'voice', '--json');
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; text: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toContain('outcome first');
  }, 30_000);

  it('a stray extra argument is refused, not silently ignored', () => {
    const out = run('crew', 'voice', 'ARG_CANARY');
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBe(2); // the never-2 contract holds even here
    expect(`${out.stdout}${out.stderr}`).not.toContain('ARG_CANARY');
  }, 30_000);
});
