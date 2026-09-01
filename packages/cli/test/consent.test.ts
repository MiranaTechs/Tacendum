import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `tacendum consent grant|revoke|list` against a scripted server (* unit coverage the remediation added — the surface previously rode only
 * the e2e's happy path).
 *
 * What is pinned: the caller-side refusals fire BEFORE any credential or
 * network is touched (integration-class caller, malformed id — value never
 * echoed — self-consent); the api client sends exactly the
 * documented requests; the grant/revoke round-trip maintains the CLIENT'S
 * OWN local record (the machine_peers pattern) so `consent list` can show
 * a human what to revoke; and `list` is LOCAL ONLY — no request leaves,
 * because the server refuses consent enumeration to everyone and
 * the CLI must not ask.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-consent-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_WS = 'ws://consent.test';

interface Scripted {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
let script: Scripted[] = [];
let seen: { method: string | undefined; path: string; auth: string | undefined; body: unknown }[] =
  [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += String(d)));
  req.on('end', () => {
    seen.push({
      method: req.method,
      path: req.url ?? '',
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const next = script.shift() ?? { status: 204 };
    res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
    res.end(next.body === undefined ? '' : JSON.stringify(next.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.TACENDUM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { cmdConsent, cmdConsentList } = await import('../src/consent.js');
const { saveProfile } = await import('../src/profile.js');
const { FileStores } = await import('../src/stores.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');

const HUMAN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OWNER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const AGENT_ID = '01HQXW0000000000000000TEST';

const lines: string[] = [];
function report(): InstanceType<typeof Reporter> {
  const r = new Reporter({ json: false, plain: true });
  const orig = r.emit.bind(r);
  r.emit = (data, text) => {
    lines.push(text);
    return orig(data, text);
  };
  return r;
}

beforeEach(() => {
  rmSync(join(home, 'alice'), { recursive: true, force: true });
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  script = [];
  seen = [];
  lines.length = 0;
  saveProfile({
    name: 'alice', identityKey: 'AAAA', userId: HUMAN_ID,
    deviceId: 1, authToken: 'tok-alice', registrationId: 1,
  });
  saveProfile({
    name: 'bot', identityKey: 'BBBB', userId: AGENT_ID,
    deviceId: 1, authToken: 'tok-bot', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER_ID,
  });
});

afterAll(() => {
  server.close();
});

describe('caller-side refusals — before any credential or network', () => {
  it('an integration-class caller is refused with the fixable mistake named', async () => {
    let err: unknown;
    try {
      await cmdConsent('grant', 'bot', AGENT_ID, report());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect(String((err as CliError).message)).toContain('HUMAN account');
    expect(seen).toHaveLength(0);
  });

  it('a malformed agent id is refused and the value is NOT echoed', async () => {
    let err: unknown;
    try {
      await cmdConsent('grant', 'alice', 'hunter2-the-secret', report());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect(String((err as CliError).message)).not.toContain('hunter2-the-secret');
    expect(seen).toHaveLength(0);
  });

  it('self-consent is refused client-side', async () => {
    await expect(cmdConsent('grant', 'alice', HUMAN_ID, report())).rejects.toThrowError(CliError);
    expect(seen).toHaveLength(0);
  });
});

describe('grant/revoke — the api client and the local record', () => {
  it('grant POSTs {agent} to /v1/consent with the bearer, reports the uniform-answer honesty, and records the grant locally', async () => {
    script = [{ status: 204 }];
    await cmdConsent('grant', 'alice', AGENT_ID, report());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/v1/consent',
      body: { agent: AGENT_ID },
    });
    expect(seen[0]!.auth).toContain('tok-alice');
    expect(lines[0]).toContain('consent recorded');
    expect(lines[0]).toContain('answers the same for any id');
    const grants = new FileStores('alice').loadConsentGrants();
    expect(Object.keys(grants)).toEqual([AGENT_ID]);
  });

  it('a re-grant keeps the ORIGINAL local grant date (idempotent memory of an idempotent act)', async () => {
    script = [{ status: 204 }, { status: 204 }];
    await cmdConsent('grant', 'alice', AGENT_ID, report());
    const first = new FileStores('alice').loadConsentGrants()[AGENT_ID];
    await cmdConsent('grant', 'alice', AGENT_ID, report());
    expect(new FileStores('alice').loadConsentGrants()[AGENT_ID]).toBe(first);
  });

  it('revoke DELETEs /v1/consent/{agent}, states the drain residue honestly, and clears the local record', async () => {
    script = [{ status: 204 }, { status: 204 }];
    await cmdConsent('grant', 'alice', AGENT_ID, report());
    await cmdConsent('revoke', 'alice', AGENT_ID, report());
    expect(seen[1]).toMatchObject({ method: 'DELETE', path: `/v1/consent/${AGENT_ID}` });
    expect(lines[1]).toContain('consent revoked');
    // Honesty about the residue: already-queued frames drain to their TTL.
    expect(lines[1]).toContain('already queued');
    expect(new FileStores('alice').loadConsentGrants()).toEqual({});
  });

  it('a refused grant (the quota 429) records NOTHING locally', async () => {
    script = [
      {
        status: 429,
        body: { error: { code: 'rate_limited', detail: 'slow down' } },
        headers: { 'retry-after': '60' },
      },
    ];
    await expect(cmdConsent('grant', 'alice', AGENT_ID, report())).rejects.toThrow();
    expect(new FileStores('alice').loadConsentGrants()).toEqual({});
  });
});

describe('consent list — the client’s own memory, local only', () => {
  it('prints the recorded grants, says whose record it is, and sends NOTHING to the server', async () => {
    script = [{ status: 204 }];
    await cmdConsent('grant', 'alice', AGENT_ID, report());
    const requestsBefore = seen.length;
    cmdConsentList('alice', report());
    expect(seen).toHaveLength(requestsBefore); // no network at all
    const out = lines[lines.length - 1]!;
    expect(out).toContain(AGENT_ID);
    expect(out).toContain("this client's own record");
    expect(out).toContain('server keeps no readable list');
  });

  it('an empty record is stated as such, still without a request', async () => {
    cmdConsentList('alice', report());
    expect(seen).toHaveLength(0);
    expect(lines[0]).toContain('no consent grants recorded');
  });

  it('a corrupt record file costs the list, never the command', async () => {
    const stores = new FileStores('alice');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(stores.root, 'consent-grants.json'), '{not json');
    cmdConsentList('alice', report());
    expect(lines[0]).toContain('no consent grants recorded');
  });
});
