import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const home = mkdtempSync(join(tmpdir(), 'tacendum-doctor-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://doctor.test';
// Pin the credential backend to the 0600 file: the identity and credential
// checks consult keychain.ts now, and without this the suite would spawn the
// REAL `security`/`secret-tool` on the machine running it. Keychain-flavoured
// doctor behaviour is tested where the PATH shims live (keychain.test.ts).
process.env.TACENDUM_CREDENTIAL_STORE = 'file';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { saveProfile } = await import('../src/profile.js');
const { clientDir } = await import('../src/config.js');
const { runDoctor, CLOCK_SKEW_TOLERANCE_MS } = await import('../src/doctor.js');
const { CliError, EXIT } = await import('../src/exit.js');
type CheckResult = import('../src/doctor.js').CheckResult;
type DoctorIo = import('../src/doctor.js').DoctorIo;

const NAME = 'doc';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

// A registered client: identity on disk, profile with a token. Held as a
// value so the attend tests below can pair and un-pair the account and put
// back EXACTLY this record afterwards.
const stores = new FileStores(NAME);
const upload = await generateAndStoreKeys(stores);
const DOC_PROFILE = {
  name: NAME,
  identityKey: upload.identityKey,
  userId: USER_ID,
  authToken: 'tok-live',
  registrationId: upload.registrationId,
  deviceId: 1,
};
saveProfile(DOC_PROFILE);

interface IoOptions {
  health?: number | 'down';
  skewMs?: number;
  noDate?: boolean;
  me?: number | 'down';
  meUserId?: string;
  dial?: 'ok' | 'auth' | 'down' | 'refused' | 'answered';
}

function io(opts: IoOptions = {}): DoctorIo {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      if (opts.health === 'down') throw new Error('fetch failed');
      const headers = new Headers();
      if (!opts.noDate) headers.set('date', new Date(Date.now() + (opts.skewMs ?? 0)).toUTCString());
      return new Response('{"ok":true}', { status: opts.health ?? 200, headers });
    }
    if (url.endsWith('/v1/me')) {
      if (opts.me === 'down') throw new Error('fetch failed');
      const status = opts.me ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify({ userId: opts.meUserId ?? USER_ID }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    dialWs: async () => {
      if (opts.dial === 'auth') throw new CliError(EXIT.AUTH, 'websocket handshake failed: 403');
      if (opts.dial === 'down') throw new CliError(EXIT.NETWORK, 'ECONNREFUSED');
      // The exact shape wsclient.ts rejects with when the upgrade was
      // ANSWERED: EXIT.NETWORK, and the HTTP status carried as a field —
      // 503 is $connect sparing a live incumbent (ws_connect_incumbent_spared).
      if (opts.dial === 'refused') {
        throw new CliError(
          EXIT.NETWORK,
          'websocket handshake failed: Unexpected server response: 503',
          undefined,
          undefined,
          503,
        );
      }
      if (opts.dial === 'answered') {
        throw new CliError(
          EXIT.NETWORK,
          'websocket handshake failed: Unexpected server response: 500',
          undefined,
          undefined,
          500,
        );
      }
    },
    now: () => Date.now(),
  };
}

function byCheck(results: CheckResult[], check: string): CheckResult {
  const found = results.find(r => r.check === check);
  if (!found) throw new Error(`no ${check} check in results`);
  return found;
}

/**
 * the design plan Each test isolates ONE cause and asserts that exactly its
 * check fails, with the remedy that names the fix — "every integration
 * failure so far has been one of five things; say which" is the spec.
 */
describe('doctor', () => {
  it('passes a healthy client on every check, in a stable order', async () => {
    const results = await runDoctor(NAME, io());
    // `attend` sits between the local-state checks and the network ones:
    // it reads files and asks the service manager, so it stays contiguous
    // with home/identity/credential rather than splitting the network pair.
    expect(results.map(r => r.check)).toEqual([
      'home',
      'identity',
      'credential',
      'attend',
      'api',
      'clock',
      'session',
      'ws',
    ]);
    expect(results.every(r => r.ok)).toBe(true);
    // No PASS carries a remedy — a remedy on a passing line is noise that
    // trains people to skim.
    expect(results.every(r => r.remedy === undefined)).toBe(true);
  });

  it('names a dead session and points at automatic renewal, all else green', async () => {
    const results = await runDoctor(NAME, io({ me: 401 }));
    const session = byCheck(results, 'session');
    expect(session.ok).toBe(false);
    expect(session.detail).toContain('expired or revoked');
    expect(session.remedy).toContain('renews it automatically');
    expect(results.filter(r => !r.ok).map(r => r.check)).toEqual(['session']);
  });

  it('a 404 from /health is REACHABILITY, not a failure — the check answers its own question', async () => {
    // Production ran for a day with session and websocket passing while the
    // api check cried wolf, because this deployment predates the /health
    // route. A diagnostic that lies teaches operators to ignore it.
    const out = await runDoctor(NAME, io({ health: 404 }));
    const api = out.find(r => r.check === 'api');
    expect(api?.ok).toBe(true);
    expect(api?.detail).toContain('reachable');
    // And a genuinely dead network still FAILS, loudly.
    const dead = await runDoctor(NAME, io({ health: 'down' }));
    expect(dead.find(r => r.check === 'api')?.ok).toBe(false);
  });

  it('refuses to call a mismatched userId healthy', async () => {
    const results = await runDoctor(NAME, io({ meUserId: '01BOBBOBBOBBOBBOBBOBBOBBOB' }));
    const session = byCheck(results, 'session');
    expect(session.ok).toBe(false);
    expect(session.detail).toContain('01BOBBOBBOBBOBBOBBOBBOBBOB');
  });

  it('fails the clock check beyond tolerance and passes it within', async () => {
    const skewed = await runDoctor(NAME, io({ skewMs: CLOCK_SKEW_TOLERANCE_MS * 4 }));
    const clock = byCheck(skewed, 'clock');
    expect(clock.ok).toBe(false);
    expect(clock.detail).toMatch(/behind|ahead/);
    expect(clock.remedy).toContain('NTP');
    // Within tolerance is a PASS — the tolerance is the contract, not zero.
    const fine = await runDoctor(NAME, io({ skewMs: 5000 }));
    expect(byCheck(fine, 'clock').ok).toBe(true);
  });

  it('reports an unreachable API once, and marks its dependents unverifiable', async () => {
    const results = await runDoctor(NAME, io({ health: 'down', dial: 'ok' }));
    expect(byCheck(results, 'api').ok).toBe(false);
    // Dependent checks FAIL as "could not check" rather than guessing PASS:
    // a red machine must not be able to produce a green report.
    expect(byCheck(results, 'clock').ok).toBe(false);
    expect(byCheck(results, 'clock').detail).toContain('unreachable');
    expect(byCheck(results, 'session').ok).toBe(false);
    expect(byCheck(results, 'session').detail).toContain('could not be checked');
    // The socket is a different host and stays independently checkable.
    expect(byCheck(results, 'ws').ok).toBe(true);
  });

  it('treats an auth-refused websocket as REACHABLE — the token is the session check\'s finding', async () => {
    const results = await runDoctor(NAME, io({ dial: 'auth' }));
    const ws = byCheck(results, 'ws');
    expect(ws.ok).toBe(true);
    expect(ws.detail).toContain('refused the token');
    // …while a dead socket is its own failure with its own remedy.
    const down = await runDoctor(NAME, io({ dial: 'down' }));
    expect(byCheck(down, 'ws').ok).toBe(false);
    expect(byCheck(down, 'ws').remedy).toContain('TACENDUM_WS');
  });

  it('reads the incumbent-spared 503 as REACHABLE, and names who holds the socket', async () => {
    // Reproduced in production: the listen unit held the account's
    // one live connection, $connect probed it, found it live, spared it, and
    // answered 503 — the server speaking, correctly. Doctor reported "the
    // network is broken" and sent the operator hunting a firewall that does
    // not exist. Same defect class the api check already shed: the
    // check's question is reachability, and an ANSWER settles it.
    const results = await runDoctor(NAME, io({ dial: 'refused' }));
    const ws = byCheck(results, 'ws');
    expect(ws.ok).toBe(true);
    expect(ws.detail).toContain('another live connection');
    expect(ws.detail).toContain('listen service');
    // The healthy machine with its listener running is ALL GREEN.
    expect(results.every(r => r.ok)).toBe(true);
  });

  it('any HTTP-statused answer proves reachability; only a status-less failure is the network', async () => {
    // The classification reads CliError.status — a field wsclient attaches to
    // every answered upgrade — never the message prose.
    const answered = await runDoctor(NAME, io({ dial: 'answered' }));
    const ws = byCheck(answered, 'ws');
    expect(ws.ok).toBe(true);
    expect(ws.detail).toContain('HTTP 500');
    // The opposite direction still detects: a transport failure carries no
    // status and FAILS loudly. A probe that passes no matter what is not a
    // probe.
    const down = await runDoctor(NAME, io({ dial: 'down' }));
    expect(byCheck(down, 'ws').ok).toBe(false);
  });

  it('a 5xx from /health is the service unwell — a different urgency than a missing route', async () => {
    // Every non-2xx used to be narrated as "this deployment has no health
    // route", which for a 503 told the operator the only news was a missing
    // route while the service behind an existing one was answering errors.
    const unwell = await runDoctor(NAME, io({ health: 503 }));
    const api = byCheck(unwell, 'api');
    expect(api.ok).toBe(true);
    expect(api.detail).toContain('unwell');
    expect(api.detail).not.toContain('no health route');
    // A 429 is its own fact: the probe itself was throttled.
    const throttled = await runDoctor(NAME, io({ health: 429 }));
    expect(byCheck(throttled, 'api').detail).toContain('rate limited');
    expect(byCheck(throttled, 'api').detail).not.toContain('no health route');
    // And the 404 keeps its original, still-true explanation.
    const noRoute = await runDoctor(NAME, io({ health: 404 }));
    expect(byCheck(noRoute, 'api').detail).toContain('no health route');
  });

  it('flags a store readable beyond its owner, with the chmod remedy', async () => {
    chmodSync(clientDir(NAME), 0o755);
    try {
      const results = await runDoctor(NAME, io());
      const homeCheck = byCheck(results, 'home');
      expect(homeCheck.ok).toBe(false);
      expect(homeCheck.remedy).toContain('chmod 700');
    } finally {
      chmodSync(clientDir(NAME), 0o700);
    }
  });

  it('tells an unregistered client to register — and how registering is safe', async () => {
    const results = await runDoctor('never-registered', io());
    const identity = byCheck(results, 'identity');
    expect(identity.ok).toBe(false);
    // The NAME IS NOT ECHOED for an account this machine does not have — a
    // misconfigured variable (`tacendum doctor "$SECRET"`) reached this very
    // remedy, and stderr goes to hook and CI logs. The advice itself
    // survives with a placeholder; harness.canary.test.ts holds the property.
    expect(identity.remedy).toContain('tacendum register <name>');
    expect(identity.remedy).not.toContain('never-registered');
    const session = byCheck(results, 'session');
    expect(session.ok).toBe(false);
    // Missing store must not crash the run: the network checks still report.
    expect(byCheck(results, 'api').ok).toBe(true);
  });
});

/**
 * The attend check: doctor calls `attendState` — attend.ts's one
 * reader — and re-derives nothing. FAIL is reserved for a broken answerer
 * the operator asked for; "never asked" stays green, because main.ts turns
 * any FAIL into a non-zero exit and doctor is what provisioning gates on.
 */
describe('doctor: the attend check', () => {
  const attendJson = join(clientDir(NAME), 'attend.json');
  const CFG = {
    host: 'claude' as const,
    bin: process.execPath, // an executable file, wherever this suite runs
    workdir: home, // a real directory
    caps: ['--permission-mode', 'plan'],
    ownSession: 'ffffffff-9999-4999-8999-999999999999',
    turnsPerHour: 5,
  };
  const enable = (over: Record<string, unknown> = {}): void =>
    writeFileSync(attendJson, JSON.stringify({ ...CFG, ...over }));
  const pair = (): void => saveProfile({ ...DOC_PROFILE, ownerUserId: USER_ID });
  const restore = (): void => {
    rmSync(attendJson, { force: true });
    saveProfile(DOC_PROFILE);
  };

  it('not enabled is a PASS — a fleet that never wanted attend stays green', async () => {
    const attend = byCheck(await runDoctor(NAME, io()), 'attend');
    expect(attend.ok).toBe(true);
    expect(attend.detail).toContain('not enabled');
  });

  it('an unparseable config FAILS — corrupt is not "disabled", and only attend goes red', async () => {
    // Before attendState existed, this state read as disabled EVERYWHERE:
    // loadAttendConfig swallows the parse error and answers the same null
    // the deliberate empty file produces. The one check that can say so is
    // this one.
    writeFileSync(attendJson, '{"host": "claude", "bin": ');
    try {
      const results = await runDoctor(NAME, io());
      const attend = byCheck(results, 'attend');
      expect(attend.ok).toBe(false);
      expect(attend.detail).toContain('does not load');
      // <name>, never the account — the remedy lands in CI logs.
      expect(attend.remedy).toContain('tacendum attend enable <name>');
      expect(attend.remedy).not.toContain(NAME);
      expect(results.filter(r => !r.ok).map(r => r.check)).toEqual(['attend']);
    } finally {
      restore();
    }
  });

  it('a deliberately disabled attend is a PASS — the empty file is the chosen off state', async () => {
    writeFileSync(attendJson, '');
    try {
      const attend = byCheck(await runDoctor(NAME, io()), 'attend');
      expect(attend.ok).toBe(true);
      expect(attend.detail).toContain('disabled');
    } finally {
      restore();
    }
  });

  it('enabled but broken FAILS with each fault named: unpaired, and a binary that moved', async () => {
    // The profile carries no ownerUserId (unpaired) and the bin is gone —
    // the exact state an nvm bump leaves behind, which today surfaces only
    // at turn time as an exit-127 report to the operator's phone.
    enable({ bin: '/nonexistent/agent-binary' });
    try {
      const attend = byCheck(await runDoctor(NAME, io()), 'attend');
      expect(attend.ok).toBe(false);
      expect(attend.detail).toContain('no pairing');
      expect(attend.detail).toContain('exit-127');
      expect(attend.remedy).toContain('<name>');
      expect(attend.remedy).not.toContain(NAME);
    } finally {
      restore();
    }
  });

  it('enabled and healthy is a PASS carrying the budget and the approval counts', async () => {
    enable();
    pair();
    try {
      const attend = byCheck(await runDoctor(NAME, io()), 'attend');
      expect(attend.ok).toBe(true);
      expect(attend.detail).toContain('0 of 5 turns');
      // The approval journal joins the summary as COUNTS —
      // an account that never saw an approval reads all-zero, honestly.
      expect(attend.detail).toContain('0 pending / 0 settled');
      expect(attend.detail).toContain('0 over-cap refusals');
    } finally {
      restore();
    }
  });

  it('an approval still pending past its own deadline FAILS — the sweep that would lapse it is not running', async () => {
    enable();
    pair();
    const approvalsPath = join(home, 'state', NAME, 'attend-approvals.json');
    mkdirSync(join(home, 'state', NAME), { recursive: true });
    // The row is journal DATA; the clock is doctor's own `io.now`, and it
    // MOVES across the deadline (the frozen-clock ruling): the same row is
    // healthy before its TTL and a finding after.
    const asked = Date.now();
    writeFileSync(
      approvalsPath,
      JSON.stringify({
        overCapRefusals: 1,
        rows: [{
          id: 'r1', requestId: 'q1', host: 'claude', payload: 'SECRET-CMD',
          askedAt: asked, ttlMs: 60_000, state: 'pending', msgId: 'm1',
        }],
      }),
    );
    let t = asked + 30_000; // inside the TTL: a wait, not a fault
    const moving = { ...io(), now: () => t };
    try {
      const waiting = byCheck(await runDoctor(NAME, moving), 'attend');
      expect(waiting.ok, 'inside its TTL a pending approval is healthy').toBe(true);
      expect(waiting.detail).toContain('1 pending / 0 settled');

      t = asked + 90_000; // past the TTL and the poll grace: the finding
      const stale = byCheck(await runDoctor(NAME, moving), 'attend');
      expect(stale.ok).toBe(false);
      expect(stale.detail).toContain('pending past its own deadline');
      expect(stale.detail).toContain('the answerer is not running');
      expect(stale.detail, 'a journalled payload never rides a doctor line')
        .not.toContain('SECRET-CMD');
      expect(stale.remedy).toContain('tacendum attend');
      expect(stale.remedy).not.toContain(NAME); // <name>, never the account
    } finally {
      rmSync(approvalsPath, { force: true });
      restore();
    }
  });

  it('a unit installed but NOT running FAILS — supervision that is not supervising', async () => {
    enable();
    pair();
    const unitDir = mkdtempSync(join(tmpdir(), 'doctor-attend-units-'));
    // The unit file exists; the manager says the label is not loaded. That
    // is a dead answerer wearing an installed uniform — the state launchd
    // will never explain, so doctor must.
    const attendUnit = {
      unitDir,
      platform: 'darwin' as const,
      exec: (): string => {
        throw new Error('Could not find service');
      },
    };
    writeFileSync(
      join(unitDir, `com.miranatechnologies.tacendum.attend.${NAME}.plist`),
      '<plist/>',
    );
    try {
      const attend = byCheck(await runDoctor(NAME, { ...io(), attendUnit }), 'attend');
      expect(attend.ok).toBe(false);
      expect(attend.detail).toContain('NOT running');
      // …and a unit the manager reports alive is the healthy PASS again.
      const running = {
        ...attendUnit,
        exec: (): string => 'state = running\npid = 4242',
      };
      const green = byCheck(await runDoctor(NAME, { ...io(), attendUnit: running }), 'attend');
      expect(green.ok).toBe(true);
      expect(green.detail).toContain('unit running');
    } finally {
      restore();
      rmSync(unitDir, { recursive: true, force: true });
    }
  });
});
