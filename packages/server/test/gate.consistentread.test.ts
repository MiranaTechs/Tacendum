import { describe, expect, it } from 'vitest';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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

  /**
   * `getPushToken` was eventually consistent: a wake scheduled milliseconds
   * after `DELETE /v1/push-token` at sign-out could read the deleted row back
   * and ring a device that no longer holds the account — which, per the CallKit
   * contract, then has to report a placeholder call for it. Same class of
   * assertion as above: the property is decided on the command, so it is
   * checked on the command. */
  it('reads the push-token row with ConsistentRead', async () => {
    const { commands, db } = recordingLayer();

    await db.getPushToken('01KYDBSSDJSPC9J0E5N2AWMJ5Y');

    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input).toEqual({
      TableName: TABLES.pushTokens,
      Key: { userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y' },
      ConsistentRead: true,
    });
  });
});

/**
 * Two more reads decided on the command, for the same reason as above.
 *
 * `getSession` backs every HTTP bearer validation. Served at the default
 * consistency, a token revoked by DELETE /v1/session, /v1/sessions/others,
 * DELETE /v1/account or a superseding sign-in could still resolve from a
 * stale replica for a sub-second window after the revoke answered 200 —
 * while the WebSocket path (`getSessionByDigest`) already read consistently.
 *
 * `purgeQueuedMessages` is the account-deletion sweep of a partition of
 * ciphertext. Its sibling `purgeConsentEdges` reads consistently and says
 * why in its own comment; a stale page here could miss a row written moments
 * before the delete, and that ciphertext (with its sender/recipient/ts
 * metadata) would then live to its 30-day TTL — an unstated exception to the
 * deletion enumeration. */
describe('gate.consistentread — session validation and the deletion purge are not served stale', () => {
  function recordingLayer() {
    const commands: object[] = [];
    const send = async (command: object): Promise<unknown> => {
      commands.push(command);
      return {};
    };
    return { commands, db: makeDataLayer({ send } as unknown as DynamoDBDocumentClient) };
  }

  it('reads the session row with ConsistentRead', async () => {
    const { commands, db } = recordingLayer();

    await db.getSession('a-bearer-token-under-test');

    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(GetCommand);
    expect((command as GetCommand).input).toMatchObject({
      TableName: TABLES.sessions,
      ConsistentRead: true,
    });
  });

  it('pages the queued-message purge with ConsistentRead', async () => {
    const { commands, db } = recordingLayer();

    await db.purgeQueuedMessages('01KYDBSSDJSPC9J0E5N2AWMJ5Y');

    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect((command as QueryCommand).input).toMatchObject({
      TableName: TABLES.messages,
      KeyConditionExpression: 'recipientId = :r',
      ExpressionAttributeValues: { ':r': '01KYDBSSDJSPC9J0E5N2AWMJ5Y' },
      ConsistentRead: true,
    });
  });
});
