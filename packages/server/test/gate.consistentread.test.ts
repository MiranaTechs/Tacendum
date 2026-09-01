import { describe, expect, it } from 'vitest';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeDataLayer } from '../src/db/data.js';
import { TABLES } from '../src/db/tables.js';

/**
 * `getConnection` must be a STRONGLY CONSISTENT read, and this asserts the SDK
 * input rather than an observable behaviour — deliberately, because nothing in
 * this repository can observe the difference.
 *
 * WHY IT CANNOT BE OBSERVED. The in-memory DataLayer in `test/helpers.ts` is a
 * pair of `Map`s: every read sees every prior write, so a handler test cannot
 * distinguish a consistent read from an eventually consistent one no matter
 * what it does. `dynamodb-local`, which the `*.ddb.integration.test.ts` files
 * run against, is a single process with no replicas and answers both read modes
 * identically — so the integration tests cannot see it either. Real DynamoDB
 * can, and only under contention, and only sometimes; a behavioural test there
 * would be a coin flip dressed as a gate.
 *
 * So the property is asserted where it is actually decided: the parameter on
 * the command. This is the same class of test as "the presigned URL carries the
 * signed Content-Length" — a claim about the request we make, checked against
 * the request we make.
 *
 * WHAT THE PARAMETER PREVENTS. This was the ONE read in `db/data.ts` served at
 * the default consistency while eleven others passed `ConsistentRead: true`,
 * and every $connect recovery path is built out of it:
 *
 *  - the ownership re-read in `wsConnectHandler` reads back a row this same
 *    handler wrote microseconds earlier, which is precisely the interval an
 *    eventually consistent read is permitted not to show. A stale answer there
 *    either refuses a connect that nothing displaced, or — the direction that
 *    matters — tells a connect that WAS displaced that it still owns the route,
 *    which is the live-socket-with-no-row outage the re-read exists to prevent;
 *  - `acquireConnectionRow`'s re-read after a refused claim exists to tell "we
 *    lost" from "our own write's response was lost". A stale read answers the
 *    question with the state from before the write that raised it;
 *  - the send path's re-read after a failed post exists to notice a reconnect
 *    that happened during the post. A stale read misses exactly the reconnect
 *    it is looking for.
 */
describe('gate.consistentread — getConnection is not served stale', () => {
  function recordingLayer() {
    const commands: object[] = [];
    const send = async (command: object): Promise<unknown> => {
      commands.push(command);
      return {};
    };
    return { commands, db: makeDataLayer({ send } as unknown as DynamoDBDocumentClient) };
  }

  it('reads the connection row with ConsistentRead', async () => {
    const { commands, db } = recordingLayer();

    await db.getConnection('01KYDBSSDJSPC9J0E5N2AWMJ5Y');

    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input).toEqual({
      TableName: TABLES.connections,
      Key: { userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y' },
      ConsistentRead: true,
    });
  });
});
