import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeDataLayer, WAKE_CLAIM_PREFIX } from '../src/db/data.js';
import { TABLES } from '../src/db/tables.js';

/**
 * THE RING CLAIM, AT THE WIRE — the same class of test as
 * `gate.consistentread`: a claim about the request we make, checked against
 * the request we make, because nothing in this repository can observe the
 * difference behaviourally. The memory twin is a `Map` (every read sees every
 * prior write) and DynamoDB Local answers both read consistencies
 * identically; real DynamoDB can tell them apart, sometimes, under
 * contention. So the properties are asserted where they are decided.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. IT TOUCHES THE PUSH TOKENS TABLE AND NO OTHER. The push worker's role
 *     holds GetItem + UpdateItem there, holds no write on the messages table,
 *     and deliberately holds NO rate-bucket grant at all — all three pinned
 *     in `infra/test/tacendum-security.test.ts`. A claim built on either of
 *     the other two would pass every test in this repository (neither the
 *     twin nor DynamoDB Local enforces IAM) and AccessDeny in production,
 *     failing CLOSED into the missed ring this whole path exists to prevent.
 *
 *  2. THE READ IS STRONGLY CONSISTENT. The claim is written seconds before a
 *     redelivery can arrive; an eventually consistent read is exactly the
 *     read that misses it, which is a guard that quietly does nothing.
 *
 *  3. IT WRITES `expiresAt`, which is that table's configured TTL attribute.
 *     A claim under any other attribute name never reaps, and this row is
 *     written once per ring for the life of the deployment.
 *
 * And the reason the file exists at all: BOTH CALLS SWALLOW. The worker's
 * outer catch returns 'failed' and skips the ring, so a throw escaping either
 * of these converts a store blip into a missed call.
 */
describe('the wake claim, on the wire', () => {
  function recordingLayer(send: (command: object) => Promise<unknown>) {
    const commands: { name: string; input: Record<string, unknown> }[] = [];
    const recording = async (command: object): Promise<unknown> => {
      commands.push({
        name: command.constructor.name,
        input: (command as { input: Record<string, unknown> }).input,
      });
      return send(command);
    };
    return {
      commands,
      db: makeDataLayer({ send: recording } as unknown as DynamoDBDocumentClient),
    };
  }

  const ok = async (): Promise<unknown> => ({});
  const denied = async (): Promise<never> => {
    throw Object.assign(new Error('is not authorized to perform'), {
      name: 'AccessDeniedException',
    });
  };

  it('reads the claim consistently, from the push tokens table', async () => {
    const { commands, db } = recordingLayer(ok);

    expect(await db.wakeAlreadyRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y')).toBe(false);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('GetCommand');
    expect(commands[0]?.input).toMatchObject({
      TableName: TABLES.pushTokens,
      Key: { userId: `${WAKE_CLAIM_PREFIX}01KYDBSSDJSPC9J0E5N2AWMJ5Y` },
      ConsistentRead: true,
    });
  });

  it('answers true only for a row that says it rang', async () => {
    const claimed = recordingLayer(async () => ({ Item: { rang: true } }));
    expect(await claimed.db.wakeAlreadyRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y')).toBe(true);

    // AND FALSE FOR A ROW THAT MERELY EXISTS. "The row is there" and "the row
    // says it rang" are different claims, and only the second one may suppress
    // a ring. The first draft of this test asserted the `true` case alone —
    // its name said "only" and nothing held the word up, so `Boolean(res.Item)`
    // passed all 687 tests in this package.
    //
    // Nothing writes a flagless claim row today (`markWakeRang` is the sole
    // writer and always sets `rang`), so the blast radius is currently nil.
    // What is pinned here is the direction the read must fail in when that
    // stops being true — a partial write, a hand-repaired row, a second writer
    // — because every one of those resolves to RINGING only while this reads
    // the flag rather than the row.
    const flagless = recordingLayer(async () => ({ Item: {} }));
    expect(await flagless.db.wakeAlreadyRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y')).toBe(false);

    const denied = recordingLayer(async () => ({ Item: { rang: false } }));
    expect(await denied.db.wakeAlreadyRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y')).toBe(false);
  });

  it('writes the claim under the table\'s own TTL attribute', async () => {
    const { commands, db } = recordingLayer(ok);

    await db.markWakeRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y', 1_800_000_000);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('UpdateCommand');
    expect(commands[0]?.input).toMatchObject({
      TableName: TABLES.pushTokens,
      Key: { userId: `${WAKE_CLAIM_PREFIX}01KYDBSSDJSPC9J0E5N2AWMJ5Y` },
      ExpressionAttributeValues: { ':t': true, ':e': 1_800_000_000 },
    });
    // The row carries the claim and its TTL and NOTHING else — no userId, no
    // sender, no token. It is a random ULID with a boolean beside it.
    expect(commands[0]?.input.UpdateExpression).toBe('SET rang = :t, expiresAt = :e');
  });

  it('fails toward RINGING when the store refuses the read', async () => {
    const { db } = recordingLayer(denied);
    await expect(db.wakeAlreadyRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y')).resolves.toBe(false);
  });

  it('fails toward RINGING when the store refuses the write', async () => {
    const { db } = recordingLayer(denied);
    await expect(db.markWakeRang('01KYDBSSDJSPC9J0E5N2AWMJ5Y', 1_800_000_000)).resolves
      .toBeUndefined();
  });
});
