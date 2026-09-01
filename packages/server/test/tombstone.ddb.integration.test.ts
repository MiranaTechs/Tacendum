import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';

/**
 * The tombstone-survives-deletion property against REAL DynamoDB. The memory db mirrors it with a side-set, which cannot prove
 * the thing that matters here: that the conditional delete inside
 * deleteUser's TransactWriteItems refuses to remove a tombstoned claim row,
 * and that the cancellation-retry still removes the user row. Runs against
 * DynamoDB Local; skips when it is down unless TACENDUM_REQUIRE_DDB=1.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: DataLayer;
let available = false;

/** Distinct identities per run so reruns never collide. */
const RUN = `${Date.now()}`;

beforeAll(async () => {
  const client = makeDynamoClient();
  db = makeDataLayer(makeDocClient(client));
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('tombstoned claims survive deleteUser (DynamoDB conditional)', () => {
  gated('the revoke/self-delete race cannot erase a tombstone', async () => {
    const key = `tomb-race-key-${RUN}`;
    const userId = `01TMBRACE${RUN.slice(-17).padStart(17, '0')}`;
    const created = await db.getOrCreateUserByIdentityKey(key, userId, Date.now(), 'integration');
    expect(created.kind).toBe('ok');

    // The owner's revoke lands first...
    await db.tombstoneIdentityKey(key);
    // ...then the thief's racing self-delete runs the FULL claim-bag delete.
    await db.deleteUser(userId, { identityKeyPub: key });

    // The user row is gone (the cancellation-retry path did its half)...
    expect(await db.getUserById(userId)).toBeUndefined();
    // ...and the key still answers "tombstoned", forever.
    const again = await db.getOrCreateUserByIdentityKey(key, `01TMBFRESH${RUN.slice(-16).padStart(16, '0')}`, Date.now());
    expect(again.kind).toBe('tombstoned');
  });

  gated('an untombstoned delete still removes both rows (unchanged behavior)', async () => {
    const key = `tomb-clean-key-${RUN}`;
    const userId = `01TMBCLEAN${RUN.slice(-16).padStart(16, '0')}`;
    const created = await db.getOrCreateUserByIdentityKey(key, userId, Date.now());
    expect(created.kind).toBe('ok');

    await db.deleteUser(userId, { identityKeyPub: key });

    expect(await db.getUserById(userId)).toBeUndefined();
    const again = await db.getOrCreateUserByIdentityKey(key, `01TMBNEW${RUN.slice(-18).padStart(18, '0')}`, Date.now());
    expect(again.kind).toBe('ok');
    expect(again.kind === 'ok' && again.created).toBe(true);
  });
});
