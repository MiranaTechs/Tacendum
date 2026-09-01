/**
 * THE 503 REDIAL, driven through the real `WsClient.connect()`.
 *
 * `$connect` refuses a LISTENING dial that does not end up owning the account's
 * single routing row: another live connection holds it, or the transport would
 * not say whether it does. A 200 there would hand this client a healthy socket
 * that silently receives nothing, and the server can never promote it
 * afterwards — a row-less connectionId is deliberately stored nowhere.
 *
 * WHY THE CLIENT SIDE OF THIS EXISTS AT ALL. A previous round deleted the 503
 * from the server on the stated grounds that "No client performs [the redial]",
 * having checked this package and not `app/src/ws.ts`. The app is the primary
 * client and does redial: a non-200 refuses the upgrade, RN reports 1006 with
 * no `open`, one auth check returns 'blip', and it backs off and dials again
 * with a fresh ticket. So the refusal is right and it was this CLI that was
 * missing — `dial` classified any handshake error that was not 401/403 as
 * EXIT.NETWORK and `listen`/`send` exited on it, with no second dial and no
 * fresh ticket.
 *
 * The two hosts refuse differently, which is why both are exercised:
 *  - AWS: the upgrade is refused and `ws` emits `error` with "Unexpected server
 *    response: 503".
 *  - Local adapter: the upgrade has already completed by the time `$connect`
 *    answers, so it arrives as close code 1013 ("Try Again Later").
 *
 * EVERY REDIAL MUST MINT A FRESH TICKET. Tickets are single-use; replaying a
 * spent one is a 401, which would turn a transient refusal into what looks like
 * dead credentials. That is asserted on the URLs the production code dialled,
 * not on a restatement of the rule.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * How each successive dial behaves. The fake socket shifts one entry per
 * construction; when the script runs out, the socket opens normally.
 */
type DialOutcome = { kind: 'open' } | { kind: 'close'; code: number } | { kind: 'error'; message: string };

const { dialled, script } = vi.hoisted(() => ({
  dialled: [] as string[],
  script: [] as DialOutcome[],
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(url: string) {
      dialled.push(url);
      const outcome: DialOutcome = script.shift() ?? { kind: 'open' };
      setTimeout(() => {
        if (outcome.kind === 'open') {
          for (const h of this.handlers.open ?? []) h();
          return;
        }
        if (outcome.kind === 'close') {
          for (const h of this.handlers.close ?? []) h(outcome.code);
          return;
        }
        for (const h of this.handlers.error ?? []) h(new Error(outcome.message));
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    send() {}
  }
  return { default: FakeWebSocket };
});

/*
 * Stood up at MODULE TOP LEVEL, before `../src/api.js` is imported: `config.ts`
 * snapshots TACENDUM_API at module evaluation, and a top-level `await import`
 * evaluates during collection, before any hook runs. Setting it in `beforeAll`
 * is too late and every request goes to the real api.tacendum.com.
 */
let ticketSeq = 0;
const mintedBodies: string[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += String(chunk);
  });
  req.on('end', () => {
    mintedBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ticket: `tkt-${++ticketSeq}`, expiresAt: 1 }));
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const previousApi = process.env.TACENDUM_API;
const previousWs = process.env.TACENDUM_WS;
process.env.TACENDUM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.TACENDUM_WS = 'ws://127.0.0.1:1';

const { WsClient } = await import('../src/wsclient.js');
const { CliError, EXIT } = await import('../src/exit.js');

afterAll(async () => {
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
  if (previousWs === undefined) delete process.env.TACENDUM_WS;
  else process.env.TACENDUM_WS = previousWs;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  dialled.length = 0;
  script.length = 0;
  mintedBodies.length = 0;
  ticketSeq = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a refused handshake is redialled, bounded, with a fresh ticket', () => {
  it('recovers when the local adapter closes 1013 and the next dial gets the row', async () => {
    script.push({ kind: 'close', code: 1013 });

    await new WsClient().connect('bearer-value');

    expect(dialled).toHaveLength(2);
    // A REPLAYED ticket would be a 401 — the transient refusal turned into what
    // looks like dead credentials. Each dial mints its own.
    expect(dialled[0]).toContain('ticket=tkt-1');
    expect(dialled[1]).toContain('ticket=tkt-2');
  });

  it('recovers when AWS refuses the upgrade with 503', async () => {
    script.push({ kind: 'error', message: 'Unexpected server response: 503' });

    await new WsClient().connect('bearer-value');

    expect(dialled).toHaveLength(2);
    expect(dialled[1]).toContain('ticket=tkt-2');
  });

  it('gives up after a bounded number of redials rather than spinning', async () => {
    // `listen` is run from cron and from Claude Code hooks. An unbounded retry
    // there is a process that never exits and never says why; the refusal is
    // not congestion that clears on its own, it means somebody else holds the
    // row.
    for (let i = 0; i < 10; i++) script.push({ kind: 'close', code: 1013 });

    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && err.exitCode === EXIT.NETWORK,
    );
    // One initial dial plus REFUSAL_REDIAL_DELAYS_MS.length redials, and no more.
    expect(dialled).toHaveLength(3);
  });

  it('does not redial an ordinary transport failure', async () => {
    // The budget is for a refusal the server asked us to retry, not for a
    // network that is down — that already has the caller's own retry, and
    // burning three ticket mints against a dead host helps nobody.
    script.push({ kind: 'error', message: 'connect ECONNREFUSED 127.0.0.1:1' });

    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && err.exitCode === EXIT.NETWORK,
    );
    expect(dialled).toHaveLength(1);
  });

  it('does not redial a credential rejection', async () => {
    // 4001 and 401/403 are the auth path, which has its own single reauth. A
    // dead session must not be dialled three more times before it is renewed.
    script.push({ kind: 'close', code: 4001 });

    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && err.exitCode === EXIT.AUTH,
    );
    expect(dialled).toHaveLength(1);
  });
});

describe('an answered upgrade carries its status, and a probe dials exactly once', () => {
  it('propagates the HTTP status of ANY answered refusal, not only the 503 the redial matches', async () => {
    // `doctor` classifies on this field: an HTTP answer — whatever the number
    // — means the socket host spoke, which is the reachability fact its probe
    // reports. Before this, only 503 was carried, and only for the redial's
    // benefit; every other answered refusal reached doctor status-less and
    // was called "unreachable".
    script.push({ kind: 'error', message: 'Unexpected server response: 500' });
    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CliError && err.exitCode === EXIT.NETWORK && err.status === 500,
    );
    // And a 500 is not a refusal to arbitrate over: one dial, no redial.
    expect(dialled).toHaveLength(1);
  });

  it('does not read a port number as a status', async () => {
    // The loose match this replaces (`/\b503\b/`) read any 503 in the message
    // as HTTP 503 — including "connect ECONNREFUSED 127.0.0.1:503", where it
    // names a PORT. A host refusing TCP became "the incumbent holds the row",
    // had the redial budget spent on it, and under doctor's status
    // classification would count as the server having answered. ECONNREFUSED
    // is the network speaking, not the server.
    script.push({ kind: 'error', message: 'connect ECONNREFUSED 127.0.0.1:503' });
    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CliError && err.exitCode === EXIT.NETWORK && err.status === undefined,
    );
    expect(dialled).toHaveLength(1);
  });

  it('a 401-answered upgrade stays AUTH, now with its status attached', async () => {
    script.push({ kind: 'error', message: 'Unexpected server response: 401' });
    await expect(new WsClient().connect('bearer-value')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CliError && err.exitCode === EXIT.AUTH && err.status === 401,
    );
  });

  it('dialOnce spends no redial budget on a refusal — a probe observes, it does not arbitrate', async () => {
    // connect()'s redial is an arbitration for the account's routing row,
    // which a probe against a healthy incumbent loses three times by design.
    // On production, doctor's 5s deadline expired inside that budget and the
    // time spent losing was reported as "no websocket handshake within
    // 5000ms". One dial is the whole observation.
    script.push({ kind: 'error', message: 'Unexpected server response: 503' });
    script.push({ kind: 'error', message: 'Unexpected server response: 503' });
    await expect(new WsClient().dialOnce('bearer-value')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CliError && err.exitCode === EXIT.NETWORK && err.status === 503,
    );
    expect(dialled).toHaveLength(1);
  });
});

describe('the role the caller asked for reaches the mint', () => {
  it("a one-shot mints a 'send' ticket, so it never competes for the routing row", async () => {
    await new WsClient().connect('bearer-value', 'send');
    expect(mintedBodies).toEqual([JSON.stringify({ role: 'send' })]);
  });

  it("a listener mints a 'listen' ticket, which is also the default", async () => {
    await new WsClient().connect('bearer-value', 'listen');
    await new WsClient().connect('bearer-value');
    expect(mintedBodies).toEqual([
      JSON.stringify({ role: 'listen' }),
      JSON.stringify({ role: 'listen' }),
    ]);
  });

  it('every redial re-declares the same role', async () => {
    // A redial that silently fell back to 'listen' would put a one-shot back
    // into the competition for the row on exactly the dial that follows a
    // refusal — the moment the account is already contended.
    script.push({ kind: 'close', code: 1013 });
    await new WsClient().connect('bearer-value', 'send');
    expect(mintedBodies).toEqual([
      JSON.stringify({ role: 'send' }),
      JSON.stringify({ role: 'send' }),
    ]);
  });
});
