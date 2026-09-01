import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CONNECTION_ROW_TTL_SECONDS,
  connectionExpiresAt,
  makeDataLayer,
  type ConnectionRecord,
} from '../src/db/data.js';
import { TABLES } from '../src/db/tables.js';

/**
 * THE CONNECTION-TTL BACKSTOP, AT THE WIRE — the same class of test as
 * `push.wakeclaim.datalayer`: claims about the request we make, checked
 * against the request we make, because nothing else in this repository can
 * observe them. The gate suite runs on the memory twin, which stamps
 * `expiresAt` independently — so deleting the stamp from the REAL
 * `makeDataLayer` would leave every gate green while production wrote rows
 * DynamoDB's reaper can never see. This file is where that mutant dies.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. EVERY CONNECTION WRITE — the raw put and the conditional claim — stamps
 *     `expiresAt`, the connections table's configured TTL attribute
 *     (infra/test/tacendum-stack.test.ts pins the table half). A row written
 *     without it is an immortal ghost no disconnect ever displaces.
 *
 *  2. NO CALLER CAN SET THE BOUND. `expiresAt` on the incoming record is
 *     discarded — the store's spread wins — so no code path can smuggle a
 *     nearer (or farther) deletion time past the arbitration this table
 *     backs.
 *
 *  3. THE BOUND IS CLAMPED TO THE STORE'S OWN CLOCK. `connectedAt` is caller
 *     data: a stale timestamp, a reused record, or a seconds-for-millis slip
 *     must not produce a row that is born TTL-eligible while its socket
 *     lives. The bound runs from at least the moment of the write — the
 *     moment the socket provably exists — and a FUTURE `connectedAt` only
 *     lengthens it, the direction that can never unroute a live socket.
 */
describe('the connection-row TTL backstop, on the wire', () => {
  const NOW_MS = 1_700_000_000_000;

  function recordingLayer(now: number = NOW_MS) {
    const commands: { name: string; input: Record<string, unknown> }[] = [];
    const send = async (command: object): Promise<unknown> => {
      commands.push({
        name: command.constructor.name,
        input: (command as { input: Record<string, unknown> }).input,
      });
      return {};
    };
    return {
      commands,
      db: makeDataLayer(
        { send } as unknown as DynamoDBDocumentClient,
        undefined,
        { nowMs: () => now },
      ),
    };
  }

  const rec = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
    userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
    connectionId: 'conn-wire',
    connectedAt: NOW_MS,
    ...over,
  });

  it('putConnection stamps expiresAt = connectedAt/1000 + the 2 h 15 m bound', async () => {
    const { commands, db } = recordingLayer();
    await db.putConnection(rec());

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('PutCommand');
    expect(commands[0]?.input).toMatchObject({
      TableName: TABLES.connections,
      Item: {
        userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
        connectionId: 'conn-wire',
        expiresAt: Math.floor(NOW_MS / 1000) + CONNECTION_ROW_TTL_SECONDS,
      },
    });
    // Pinned as a value so the slack cannot silently shrink under API
    // Gateway's 2 h connection hard cap.
    expect(CONNECTION_ROW_TTL_SECONDS).toBe(2 * 60 * 60 + 15 * 60);
  });

  it('claimConnection stamps the same bound, inside the same conditional write', async () => {
    const { commands, db } = recordingLayer();
    expect(await db.claimConnection(rec(), 'conn-old')).toBe(true);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('PutCommand');
    const input = commands[0]!.input as {
      Item: { expiresAt?: number };
      ConditionExpression?: string;
    };
    expect(input.Item.expiresAt).toBe(connectionExpiresAt(NOW_MS));
    // Still the CLAIM: stamping the TTL must not have cost the arbitration.
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(userId) OR connectionId = :expected',
    );
  });

  it('a caller-supplied expiresAt is DISCARDED, on both write paths', async () => {
    const { commands, db } = recordingLayer();
    const smuggled = { ...rec(), expiresAt: 1 } as ConnectionRecord;
    await db.putConnection(smuggled);
    await db.claimConnection(smuggled, undefined);

    for (const command of commands) {
      expect((command.input as { Item: { expiresAt?: number } }).Item.expiresAt).toBe(
        connectionExpiresAt(NOW_MS),
      );
    }
  });

  it('a stale connectedAt cannot shorten the bound: the clamp runs from the write', async () => {
    const { commands, db } = recordingLayer();
    // Three hours stale — a reused record, a clock jump, or connectedAt
    // accidentally already in seconds. Unclamped, the row would be born past
    // its own TTL: eligible for deletion while its socket is live.
    await db.putConnection(rec({ connectedAt: NOW_MS - 3 * 3600 * 1000 }));
    await db.claimConnection(rec({ connectedAt: 1_700_000_000 }), undefined);

    for (const command of commands) {
      expect((command.input as { Item: { expiresAt?: number } }).Item.expiresAt).toBe(
        Math.floor(NOW_MS / 1000) + CONNECTION_ROW_TTL_SECONDS,
      );
    }
  });

  it('a future connectedAt lengthens the bound — the direction that never unroutes', async () => {
    const { commands, db } = recordingLayer();
    await db.putConnection(rec({ connectedAt: NOW_MS + 60_000 }));

    expect((commands[0]!.input as { Item: { expiresAt?: number } }).Item.expiresAt).toBe(
      connectionExpiresAt(NOW_MS + 60_000),
    );
  });
});
