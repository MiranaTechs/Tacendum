import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_TOUCH_TIMEOUT_MS,
  activityRecord,
  activityTombstone,
  deleteHumanActivity,
  touchHumanActivity,
} from '../src/activity.js';
import { makeDataLayer, type UserRecord } from '../src/db/data.js';
import { TABLES } from '../src/db/tables.js';
import { activityActorRef } from '../src/opaque-ref.js';
import { makeMemoryDb } from './helpers.js';

/** The salted actor id every write is keyed under: the data layer hashes what it is handed, and what it is
 * handed is now the opaque ref in the ACTIVITY key domain
 * (domain separation), never the raw userId. */
const SALT = 'activity-test-salt';

describe('activityRecord', () => {
  it('stores only a hash, UTC hour bucket, and 35-day TTL', () => {
    const now = Date.parse('2026-07-29T18:47:23.000Z');
    const record = activityRecord('01USERIDENTIFIER00000000000', now);
    expect(record).toEqual({
      actorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      activityDay: '2026-07-29',
      activityHourActor: expect.stringMatching(/^2026-07-29T18#[a-f0-9]{64}$/),
      expiresAt: Math.floor(now / 1000) + 35 * 24 * 3600,
    });
    expect(JSON.stringify(record)).not.toContain('01USERIDENTIFIER00000000000');
  });

  it('is stable within an hour and advances at the next UTC hour', () => {
    const a = activityRecord('user-a', Date.parse('2026-07-29T23:01:00Z'));
    const b = activityRecord('user-a', Date.parse('2026-07-29T23:59:59Z'));
    const c = activityRecord('user-a', Date.parse('2026-07-30T00:00:00Z'));
    expect(a.activityHourActor).toBe(b.activityHourActor);
    expect(c.activityHourActor).not.toBe(a.activityHourActor);
    expect(c.activityDay).toBe('2026-07-30');
  });

  it('erases activity into a short-lived, GSI-excluded deletion tombstone', () => {
    const now = Date.parse('2026-07-29T18:47:23.000Z');
    const tombstone = activityTombstone('01USERIDENTIFIER00000000000', now);
    expect(tombstone).toEqual({
      actorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: Math.floor(now / 1000) + 5 * 60,
    });
    expect(JSON.stringify(tombstone)).not.toContain('01USERIDENTIFIER00000000000');
  });
});

describe('touchHumanActivity', () => {
  const human: UserRecord = {
    userId: 'human-user',
    createdAt: Date.parse('2026-07-01T00:00:00Z'),
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches activity under the SALTED actor id with the shared caller signal', async () => {
    const db = makeMemoryDb();
    const touchActivity = vi.spyOn(db, 'touchActivity').mockResolvedValue();
    const log = vi.fn();
    const controller = new AbortController();
    const now = Date.parse('2026-07-29T18:47:23.000Z');

    await touchHumanActivity(human, { db, log, now: () => now, userRefSalt: SALT }, controller.signal);

    expect(touchActivity).toHaveBeenCalledOnce();
    expect(touchActivity).toHaveBeenCalledWith(activityActorRef(human.userId, SALT), now, controller.signal);
    // The raw userId never reaches the activity write path.
    expect(JSON.stringify(touchActivity.mock.calls)).not.toContain(human.userId);
    expect(log).not.toHaveBeenCalled();
  });

  it('skips the write and counts it when no salt is available (fail-open telemetry)', async () => {
    // Same posture as the turn handler when its config is absent: the ref is
    // never computed unsalted, so the row is never written unsalted — the
    // touch is skipped and the skip is a countable log event, because a
    // deployment losing its activity metrics should be findable.
    const db = makeMemoryDb();
    const touchActivity = vi.spyOn(db, 'touchActivity').mockResolvedValue();
    const log = vi.fn();

    await touchHumanActivity(human, {
      db,
      log,
      now: () => Date.parse('2026-07-29T18:47:23.000Z'),
    });

    expect(touchActivity).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('activity_touch_skipped_unsalted');
  });

  it('skips missing and integration accounts', async () => {
    const db = makeMemoryDb();
    const touchActivity = vi.spyOn(db, 'touchActivity').mockResolvedValue();
    const log = vi.fn();
    const deps = { db, log, now: () => Date.parse('2026-07-29T18:47:23.000Z'), userRefSalt: SALT };

    await touchHumanActivity(undefined, deps);
    await touchHumanActivity({ ...human, accountClass: 'integration' }, deps);

    expect(touchActivity).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('catches a write failure and logs no account identifier', async () => {
    const db = makeMemoryDb();
    vi.spyOn(db, 'touchActivity').mockRejectedValue(new Error('unavailable'));
    const log = vi.fn();

    await expect(
      touchHumanActivity(human, {
        db,
        log,
        now: () => Date.parse('2026-07-29T18:47:23.000Z'),
        userRefSalt: SALT,
      }),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('activity_touch_failed');
    expect(JSON.stringify(log.mock.calls)).not.toContain(human.userId);
  });

  it('aborts a never-settling owned write after 500 milliseconds and logs once', async () => {
    vi.useFakeTimers();
    const db = makeMemoryDb();
    let passedSignal: AbortSignal | undefined;
    vi.spyOn(db, 'touchActivity').mockImplementation((_userId, _nowMs, signal) => {
      passedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const log = vi.fn();

    const result = touchHumanActivity(human, {
      db,
      log,
      now: () => Date.parse('2026-07-29T18:47:23.000Z'),
      userRefSalt: SALT,
    });
    await vi.advanceTimersByTimeAsync(ACTIVITY_TOUCH_TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();

    expect(passedSignal?.aborted).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('activity_touch_failed');
  });
});

describe('deleteHumanActivity', () => {
  it('deletes under the SAME salted actor id the touch wrote', async () => {
    const db = makeMemoryDb();
    const deleteActivity = vi.spyOn(db, 'deleteActivity').mockResolvedValue();
    const log = vi.fn();
    const now = Date.parse('2026-07-29T18:47:23.000Z');

    await deleteHumanActivity('human-user', { db, log, now: () => now, userRefSalt: SALT });

    expect(deleteActivity).toHaveBeenCalledOnce();
    expect(deleteActivity).toHaveBeenCalledWith(activityActorRef('human-user', SALT), now);
    expect(JSON.stringify(deleteActivity.mock.calls)).not.toContain('human-user');
    expect(log).not.toHaveBeenCalled();
  });

  it('skips the tombstone and counts it when no salt is available', async () => {
    // Without the salt the rows cannot be ADDRESSED (they are keyed by the
    // salted id), so the skip loses nothing that was written salted — and a
    // salted row left behind by a salt outage still dies on the 35-day TTL.
    const db = makeMemoryDb();
    const deleteActivity = vi.spyOn(db, 'deleteActivity').mockResolvedValue();
    const log = vi.fn();

    await deleteHumanActivity('human-user', {
      db,
      log,
      now: () => Date.parse('2026-07-29T18:47:23.000Z'),
    });

    expect(deleteActivity).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('activity_delete_skipped_unsalted');
  });
});

describe('DynamoDB activity boundary', () => {
  it('uses a condition that cannot overwrite a live deletion tombstone', async () => {
    const actorHash = '093286bd176c8ec942bc4bcdbf25bb23895ba17e8a4947944d84322ead6528c3';
    const calls: unknown[][] = [];
    const doc = {
      send: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    const db = makeDataLayer(doc);
    const now = Date.parse('2026-07-29T18:47:23.000Z');
    const controller = new AbortController();

    await db.touchActivity('human-user', now, controller.signal);

    const [command, options] = calls[0]!;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input).toEqual({
      TableName: TABLES.activity,
      Key: { actorHash },
      UpdateExpression:
        'SET activityDay = :day, activityHourActor = :hour, expiresAt = :expires',
      ConditionExpression:
        'attribute_not_exists(actorHash) OR expiresAt <= :now OR activityHourActor < :hour',
      ExpressionAttributeValues: {
        ':day': '2026-07-29',
        ':hour': `2026-07-29T18#${actorHash}`,
        ':expires': Math.floor(now / 1000) + 35 * 24 * 3600,
        ':now': Math.floor(now / 1000),
      },
    });
    expect(options).toEqual({ abortSignal: controller.signal });
  });

  it('treats a same-hour conditional failure as success', async () => {
    const doc = {
      send: () => Promise.reject({ name: 'ConditionalCheckFailedException' }),
    } as unknown as DynamoDBDocumentClient;

    await expect(
      makeDataLayer(doc).touchActivity('human-user', Date.parse('2026-07-29T18:47:23.000Z')),
    ).resolves.toBeUndefined();
  });

  it('deletes activity by removing both GSI keys and keeping a five-minute tombstone', async () => {
    const actorHash = '093286bd176c8ec942bc4bcdbf25bb23895ba17e8a4947944d84322ead6528c3';
    const calls: unknown[][] = [];
    const doc = {
      send: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    const db = makeDataLayer(doc);
    const now = Date.parse('2026-07-29T18:47:23.000Z');

    await db.deleteActivity('human-user', now);

    const [command] = calls[0]!;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect((command as UpdateCommand).input).toEqual({
      TableName: TABLES.activity,
      Key: { actorHash },
      UpdateExpression:
        'SET expiresAt = :expires REMOVE activityDay, activityHourActor',
      ExpressionAttributeValues: {
        ':expires': Math.floor(now / 1000) + 5 * 60,
      },
    });
  });

  it('passes the caller abort signal through user lookup', async () => {
    const calls: unknown[][] = [];
    const doc = {
      send: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    const db = makeDataLayer(doc);
    const controller = new AbortController();

    await db.getUserById('human-user', controller.signal);

    expect(calls[0]![0]).toBeInstanceOf(GetCommand);
    expect(calls[0]![1]).toEqual({ abortSignal: controller.signal });
  });
});
