import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, sessionTokenDigest, type DataLayer } from '../src/db/data.js';
import { makeMemoryDb } from './helpers.js';

/**
 * THE TICKET ROLE, AT THE REAL DATA LAYER.
 *
 * The role is the entire reason a one-shot `send` no longer competes for the
 * account's single routing row, and it survives from the mint to `$connect`
 * only by being written to the ticket row and read back off it. Everything
 * upstream of that — the handler, the arbitration, the CLI — is exercised
 * against the in-memory DataLayer in `test/helpers.ts`, which is a `Map`: it
 * stores whatever object it is handed and returns it verbatim, so it CANNOT
 * catch a real layer that forgets to persist the attribute or reads the wrong
 * name back. Sabotaging `data.ts` to hard-code 'listen' left the whole
 * handler suite green, which is what this file exists for.
 *
 * The failure that would ship: every ticket resolves to 'listen', every
 * `tacendum send` and `tacendum sync` is back in the competition for the row,
 * and the outage the role removes returns in full — with every test still
 * passing.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';
let db: DataLayer;
let available = false;

beforeAll(async () => {
  const client = makeDynamoClient();
  db = makeDataLayer(makeDocClient(client));
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.sessions);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is down');
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('the role round-trips through a real ticket row', () => {
  const ticketValue = (): string => `role-it-${randomBytes(16).toString('base64url')}`;

  for (const role of ['listen', 'send'] as const) {
    gated(`a '${role}' ticket is spent as '${role}'`, async () => {
      const ticket = ticketValue();
      const nowSec = Math.floor(Date.now() / 1000);
      await db.putWsTicket({ ticket, userId: '01ROLEUSER', expiresAt: nowSec + 60, role });

      expect(await db.consumeWsTicket(ticket, nowSec)).toEqual({
        userId: '01ROLEUSER',
        role,
      });
    });
  }
});

/**
 * /#3 — a ticket minted before revocation must NOT work after it.
 *
 * The ticket is bound to the SESSION that minted it (`ticketSessionDigest`).
 * Consumption must refuse a ticket whose bound session has been revoked or
 * expired: otherwise an attacker pre-mints a ticket, the victim signs that
 * session out, and the attacker still spends the ticket within its 60s life —
 * connecting as the victim, draining the queue, claiming the routing row.
 */
describe('#3 — ticket consumption is gated on the bound session (real store)', () => {
  async function mintBoundTicket(
    layer: DataLayer,
    userId: string,
    token: string,
    nowSec: number,
  ): Promise<string> {
    await layer.createSession({ token, userId, createdAt: nowSec, expiresAt: nowSec + 86_400 });
    const ticket = `bind-it-${randomBytes(16).toString('base64url')}`;
    await layer.putWsTicket({
      ticket,
      userId,
      expiresAt: nowSec + 60,
      role: 'listen',
      sessionDigest: sessionTokenDigest(token),
    });
    return ticket;
  }

  gated('refuses a ticket whose bound session was revoked', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = `sess-tok-${randomBytes(16).toString('base64url')}`;
    const ticket = await mintBoundTicket(db, '01BINDUSER', token, nowSec);
    // The victim signs that session out.
    await db.deleteSession(token);
    // The pre-minted ticket must now be worthless.
    expect(await db.consumeWsTicket(ticket, nowSec)).toBeUndefined();
  });

  gated('still consumes a ticket whose bound session is live (control)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = `sess-live-${randomBytes(16).toString('base64url')}`;
    const ticket = await mintBoundTicket(db, '01LIVEUSER', token, nowSec);
    expect(await db.consumeWsTicket(ticket, nowSec)).toMatchObject({
      userId: '01LIVEUSER',
      role: 'listen',
    });
  });
});

describe('#3 — the same gate on the memory twin (always runs)', () => {
  it('refuses a bound ticket after its session is revoked, and consumes a live one', async () => {
    const twin = makeMemoryDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = 'twin-session-token';
    await twin.createSession({ token, userId: 'u-twin', createdAt: nowSec, expiresAt: nowSec + 3600 });
    const digest = sessionTokenDigest(token);

    await twin.putWsTicket({ ticket: 'live', userId: 'u-twin', expiresAt: nowSec + 60, role: 'listen', sessionDigest: digest });
    await twin.putWsTicket({ ticket: 'doomed', userId: 'u-twin', expiresAt: nowSec + 60, role: 'listen', sessionDigest: digest });

    // Live session: consumes.
    expect(await twin.consumeWsTicket('live', nowSec)).toMatchObject({ userId: 'u-twin', role: 'listen' });
    // Revoke, then the second ticket is worthless.
    await twin.deleteSession(token);
    expect(await twin.consumeWsTicket('doomed', nowSec)).toBeUndefined();
  });

  it('a legacy ticket with no bound session is unchanged (pre-F3)', async () => {
    const twin = makeMemoryDb();
    const nowSec = Math.floor(Date.now() / 1000);
    await twin.putWsTicket({ ticket: 'legacy', userId: 'u-legacy', expiresAt: nowSec + 60, role: 'send' });
    expect(await twin.consumeWsTicket('legacy', nowSec)).toEqual({ userId: 'u-legacy', role: 'send' });
  });
});

/**
 * The two ends of the round trip, asserted on the SDK commands themselves, so
 * the property holds without DynamoDB Local running — the round-trip test above
 * skips when it is down, and a skipped test is not a gate.
 */
describe('the ticket row carries the role in both directions', () => {
  function stubbedLayer(reply: unknown) {
    const commands: object[] = [];
    const send = async (command: object): Promise<unknown> => {
      commands.push(command);
      return reply;
    };
    return { commands, db: makeDataLayer({ send } as unknown as DynamoDBDocumentClient) };
  }

  it('writes the role onto the row it puts', async () => {
    const { commands, db: layer } = stubbedLayer({});

    await layer.putWsTicket({ ticket: 'tkt', userId: 'u1', expiresAt: 99, role: 'send' });

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect((commands[0] as PutCommand).input.Item).toMatchObject({
      ticketUserId: 'u1',
      ticketRole: 'send',
    });
  });

  it("reads the role back off the row it spends", async () => {
    const { commands, db: layer } = stubbedLayer({
      Attributes: { ticketUserId: 'u1', ticketRole: 'send', expiresAt: 99 },
    });

    expect(await layer.consumeWsTicket('tkt', 1)).toEqual({ userId: 'u1', role: 'send' });
    expect(commands[0]).toBeInstanceOf(DeleteCommand);
  });

  it('reads a row with no role at all as listen', async () => {
    // A ticket minted by the deploy before roles existed, still inside its
    // sixty seconds. 'listen' is what that ticket meant, and it is what keeps
    // the connect it authorises behaving exactly as it did — refusing it, or
    // silently making it send-only, breaks live sockets for one deploy-minute
    // over a field whose absence is unambiguous.
    const { db: layer } = stubbedLayer({ Attributes: { ticketUserId: 'u1', expiresAt: 99 } });

    expect(await layer.consumeWsTicket('tkt', 1)).toEqual({ userId: 'u1', role: 'listen' });
  });
});
