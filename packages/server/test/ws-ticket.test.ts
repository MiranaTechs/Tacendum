/**
 * WebSocket tickets: the properties that make it safe for the
 * value in a socket URL to be logged.
 *
 * The point of the change is that a URL is written down by everything that
 * forwards it. What used to go there was a thirty-day bearer good on every
 * authenticated route; what goes there now must be worth nothing by the time
 * anyone reads it.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { WS_TICKET_TTL_SECONDS, WsTicketResponse } from '@tacendum/shared';
import { wsTicketHandler } from '../src/handlers/ws-ticket.js';
import { wsConnectHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

const USER = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const OTHER = '01KYDBSSDJSPC9J0E5N2AWMJ6Z';

let deps: WsDeps & TestDeps;
beforeEach(() => {
  // $connect schedules a drain and may schedule a wake; nothing here is about
  // either, so both are no-ops rather than fixtures with opinions. Typed as the
  // real `WsDeps` — it was previously an ad-hoc intersection missing `sender`
  // and `schedulePush`, which vitest never noticed (it transpiles without
  // checking) and `tsc --noEmit` rejected.
  deps = {
    ...makeTestDeps(makeMemoryDb()),
    scheduleDrain: async () => {},
    schedulePush: async () => {},
    sender: { post: async () => true },
  };
});

async function mint(userId = USER): Promise<string> {
  const res = await wsTicketHandler(
    { method: 'POST', path: '/v1/ws-ticket', headers: {}, body: '' },
    deps,
    { userId },
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ ticket: string }>(res.body).ticket;
}

const connect = (query: Record<string, string>, connectionId = 'c1') =>
  wsConnectHandler({ routeKey: '$connect', connectionId, queryStringParameters: query }, deps);

describe('a ticket is spendable exactly once', () => {
  it('the second use of a ticket is refused', async () => {
    const ticket = await mint();

    const first = await connect({ ticket }, 'c1');
    expect(first.statusCode).toBe(200);
    expect(first.userId).toBe(USER);

    // The replay. This is the assertion the whole design turns on: a
    // read-then-delete implementation passes the line above and fails here.
    //
    // It says nothing about API Gateway, which this test cannot reach. That is
    // fine here for a reason rather than by omission: WebSocket authorizers do
    // not cache at all — `AuthorizerResultTtlInSeconds` is documented as
    // HTTP-API-only — so there is no cached decision for a replay to hit, and
    // single-use rests on exactly the conditional delete this exercises.
    const second = await connect({ ticket }, 'c2');
    expect(second.statusCode).toBe(401);
  });

  it('two concurrent connects on one ticket produce exactly one success', async () => {
    const ticket = await mint();

    const [a, b] = await Promise.all([connect({ ticket }, 'cA'), connect({ ticket }, 'cB')]);

    // Sequential single-use is easy; this is the case a read-then-delete gets
    // wrong, because both callers pass the read before either deletes.
    const wins = [a, b].filter(r => r.statusCode === 200);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.userId).toBe(USER);
  });

  it('a ticket resolves to the user it was minted for, and no other', async () => {
    const mine = await mint(USER);
    const theirs = await mint(OTHER);

    expect((await connect({ ticket: mine }, 'c1')).userId).toBe(USER);
    expect((await connect({ ticket: theirs }, 'c2')).userId).toBe(OTHER);
  });
});

describe('a ticket stops working', () => {
  it('is refused once expired, on the clock', async () => {
    const ticket = await mint();

    // Checked in code rather than left to DynamoDB's TTL sweep, which lags by
    // up to 48 hours — an expired row is routinely still readable.
    deps.advanceMs((WS_TICKET_TTL_SECONDS + 1) * 1000);

    expect((await connect({ ticket })).statusCode).toBe(401);
  });

  it('refuses a value that was never a ticket', async () => {
    expect((await connect({ ticket: 'not-a-ticket' })).statusCode).toBe(401);
  });
});

describe('the two credentials are not interchangeable', () => {
  it('a bearer token presented as a ticket is refused', async () => {
    // If a session token were accepted in the ticket slot, the old path would
    // still work under a new name and nothing would have been fixed.
    const token = deps.newAuthToken();
    await deps.db.createSession({
      token,
      userId: USER,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });

    expect((await connect({ ticket: token })).statusCode).toBe(401);
    // …and the same value on the DELETED transitional token path is refused
    // too: the thirty-day bearer no longer opens a socket from anywhere
    // in the URL, under either parameter name.
    expect((await connect({ token }, 'c2')).statusCode).toBe(401);
  });
});

describe('the minted ticket survives its own DTO', () => {
  /*
   * THE GAP THAT LET A DEAD FEATURE LOOK ALIVE.
   *
   * Tickets are minted with `randomBytes(32).toString('base64url')` and were
   * validated against a STANDARD-base64 regex, which rejects `-` and `_`. 73.5%
   * of real tickets therefore failed the client's own `WsTicketResponse.parse`,
   * and both clients caught that and dialled with the thirty-day bearer — the
   * exact defect the ticket exists to remove, restored silently and most of the
   * time.
   *
   * Nothing caught it: the server tests build tickets through a test double,
   * and the round trip through the DTO only happens client-side. A live run
   * against a real server logged `ws_ticket_issued` and looked like proof,
   * which it was not — it showed the mint succeeding, not the socket using it.
   */
  it('accepts every ticket the real generator produces', () => {
    // Enough samples that a 73.5%-per-ticket failure cannot pass by luck.
    for (let i = 0; i < 200; i++) {
      const ticket = randomBytes(32).toString('base64url');
      expect(() => WsTicketResponse.parse({ ticket, expiresAt: 1 })).not.toThrow();
    }
  });

  it('still rejects a value that is not base64url at all', () => {
    // The schema has to stay a constraint, or the test above passes vacuously
    // against `z.string()`.
    expect(() => WsTicketResponse.parse({ ticket: 'has spaces', expiresAt: 1 })).toThrow();
    expect(() => WsTicketResponse.parse({ ticket: 'a/b+c=', expiresAt: 1 })).toThrow();
  });
});

describe('presenting a ticket is final', () => {
  it('an empty ?ticket= is refused — and so is the bearer riding alongside it', async () => {
    // Truthiness once made `?ticket=&token=<valid>` connect on the token
    // path. That branch is deleted outright now so BOTH shapes of this
    // dial — empty ticket with a bearer, and the bearer alone — are refused:
    // there is no scheme left to fall through to.
    const token = deps.newAuthToken();
    await deps.db.createSession({
      token,
      userId: USER,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });

    expect((await connect({ ticket: '', token })).statusCode).toBe(401);
    expect((await connect({ token }, 'c2')).statusCode).toBe(401);
  });

  it('a spent ticket does not fall through to a valid token', async () => {
    const token = deps.newAuthToken();
    await deps.db.createSession({
      token,
      userId: USER,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const ticket = await mint();

    expect((await connect({ ticket, token }, 'c1')).statusCode).toBe(200);
    // The replay carries a perfectly good bearer. The token branch it used to
    // fall through to is deleted so this now guards against the branch
    // ever coming BACK: a replayed URL must stay worthless no matter what
    // else it carries.
    expect((await connect({ ticket, token }, 'c2')).statusCode).toBe(401);
  });
});

describe('the ticket lifetime is the one the constant states', () => {
  it('is dead exactly at expiresAt, not for the rest of that second', async () => {
    const ticket = await mint();

    // `expiresAt < now` kept it valid through the whole of its expiry second,
    // making the real lifetime up to 61s. Harmless, but the boundary should
    // mean what WS_TICKET_TTL_SECONDS says.
    deps.advanceMs(WS_TICKET_TTL_SECONDS * 1000);

    expect((await connect({ ticket })).statusCode).toBe(401);
  });

  it('is still alive one second before that', async () => {
    const ticket = await mint();
    deps.advanceMs((WS_TICKET_TTL_SECONDS - 1) * 1000);
    expect((await connect({ ticket })).statusCode).toBe(200);
  });
});

/**
 * THE ROLE, and why a client is allowed to declare it.
 *
 * The connections table holds one routing row per account, so a long-lived
 * `listen` and a one-shot `send` used to compete for it — and the one-shot
 * always won badly: it took the row, pushed its frame, disconnected, and its
 * conditional delete removed the only row the account had, leaving a healthy
 * listener socket that nothing pointed at.
 *
 * The role removes the competition instead of arbitrating it, and it needs no
 * authorization mechanism to do so. Both roles belong to the same
 * already-authenticated user: a client that lies and claims 'listen' recreates
 * exactly the behaviour every client had before roles existed, and one that
 * lies and claims 'send' only stops receiving its own routed messages. Neither
 * reaches another account. What DOES matter is that the value is decided on
 * this authenticated HTTPS request and then held by the server — the tests
 * below are about that, not about trust.
 */
describe('the ticket carries a role', () => {
  async function mintWithBody(body: string, userId = USER) {
    return wsTicketHandler({ method: 'POST', path: '/v1/ws-ticket', headers: {}, body }, deps, {
      userId,
    });
  }

  async function ticketFrom(body: string): Promise<string> {
    const res = await mintWithBody(body);
    expect(res.statusCode).toBe(200);
    return parseBody<{ ticket: string }>(res.body).ticket;
  }

  it('a body-less mint means listen, so a client built before roles is unchanged', async () => {
    // Every shipped client POSTs this route with no body at all. `parseJson`
    // answers 400 to `JSON.parse('')`, so using it here would refuse a ticket
    // to the iOS app on somebody's phone — which updates when its owner
    // decides to, not when we deploy.
    const ticket = await mint();
    await deps.db.putConnection({
      userId: USER,
      connectionId: 'incumbent',
      connectedAt: deps.now(),
    });

    // Arbitrated as a listener: it probed the incumbent, found it live, and was
    // refused. A 200 here would mean the default had become 'send'.
    expect((await connect({ ticket }, 'c-default')).statusCode).toBe(503);
  });

  it("a 'send' ticket never touches the routing row", async () => {
    const ticket = await ticketFrom(JSON.stringify({ role: 'send' }));
    await deps.db.putConnection({
      userId: USER,
      connectionId: 'incumbent',
      connectedAt: deps.now(),
    });

    expect((await connect({ ticket }, 'c-oneshot')).statusCode).toBe(200);
    expect((await deps.db.getConnection(USER))?.connectionId).toBe('incumbent');
  });

  it('refuses a role it does not recognise instead of quietly demoting it', async () => {
    // A client that believes it asked for a send-only socket and silently got a
    // listening one would displace its own account's listener on every send —
    // invisibly. Wrong at develop time beats wrong at incident time.
    expect((await mintWithBody(JSON.stringify({ role: 'sendd' }))).statusCode).toBe(400);
    expect((await mintWithBody(JSON.stringify({ role: 7 }))).statusCode).toBe(400);
    expect((await mintWithBody('{not json')).statusCode).toBe(400);
  });

  it('logs the role and still never logs the ticket value', async () => {
    const res = await mintWithBody(JSON.stringify({ role: 'send' }));
    const { ticket } = parseBody<{ ticket: string }>(res.body);
    // Routing metadata, not a credential — and the only way to see whether the
    // one-shot clients have actually stopped competing for the row after this
    // ships.
    expect(deps.logs).toContainEqual({ event: 'ws_ticket_issued', fields: { role: 'send' } });
    // The VALUE, not the word: it is a credential for the sixty seconds it
    // lives, and log hygiene makes no exception for short-lived ones.
    expect(JSON.stringify(deps.logs)).not.toContain(ticket);
  });
});
