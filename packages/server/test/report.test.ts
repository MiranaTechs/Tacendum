/**
 * Abuse reports.
 *
 * App Store guideline 1.2 requires a reporting mechanism a human can act on.
 * End-to-end encryption answers "why can't you filter server-side"; it does
 * not answer "how do I report someone" — the argument does not
 * substitute for the feature.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING. This endpoint is the one place in the
 * system where plaintext can leave a device, so the interesting assertions
 * are not "does it write a row" but the four properties that keep it from
 * becoming something else:
 *
 * - the reporter is the SESSION, never the body (else it is a way to file
 * reports as other people);
 * - excerpts are absent unless the user picked them, and bounded when they
 * did (else "report" quietly becomes "upload this conversation");
 * - the log never names either party (else the reporting relationship sits
 * in CloudWatch for ninety days, and the point of a report is that the
 * reported party never learns of it);
 * - the row carries no message id (else the reports table can be joined to
 * the envelope the relay already forwarded — the exact sender/recipient
 * linkage the architecture exists to prevent).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createReportHandler } from '../src/handlers/report.js';
import type { ReportRecord } from '../src/db/data.js';
import type { AuthContext } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, jsonPost, type TestDeps } from './helpers.js';

describe('POST /v1/reports', () => {
  let deps: TestDeps;
  let auth: AuthContext;
  let written: ReportRecord[];

  beforeEach(() => {
    deps = makeTestDeps(makeMemoryDb());
    auth = { userId: 'reporter-1' };
    // The DataLayer has no `getReport` and must not grow one, so tests
    // observe writes the same way the deletion-ordering tests do.
    written = [];
    const put = deps.db.putReport.bind(deps.db);
    deps.db.putReport = async (rec) => {
      written.push(rec);
      return put(rec);
    };
  });

  const body = (over: Record<string, unknown> = {}) =>
    jsonPost({ reportedUserId: 'target-1', reason: 'harassment', ...over });

  it('files a report with no message content at all', async () => {
    const res = await createReportHandler(body(), deps, auth);

    expect(res.statusCode).toBe(201);
    expect(written).toHaveLength(1);
    // The DEFAULT report. Account plus category is complete and actionable,
    // and nothing about it required the user to surrender message text.
    expect(written[0]).toMatchObject({
      reporterId: 'reporter-1',
      reportedUserId: 'target-1',
      reason: 'harassment',
    });
    expect(written[0]!.excerpts).toBeUndefined();
  });

  it('takes the reporter from the session, never the body', async () => {
    // Filing as someone else would be a harassment primitive wearing the
    // service's name, so the field is not merely ignored — it must be
    // impossible to influence.
    const res = await createReportHandler(
      body({ reporterId: 'someone-else' }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(201);
    expect(written[0]!.reporterId).toBe('reporter-1');
  });

  it('stores only the excerpts the reporter chose', async () => {
    const res = await createReportHandler(
      body({
        excerpts: [{ body: 'a threat', direction: 'in', sentAt: 1_700_000_000_000 }],
      }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(201);
    expect(written[0]!.excerpts).toEqual([
      { body: 'a threat', direction: 'in', sentAt: 1_700_000_000_000 },
    ]);
  });

  it('refuses more than five excerpts', async () => {
    // The cap is the feature. Unbounded, this is a transcript upload with a
    // different name and a different consent conversation attached.
    const six = Array.from({ length: 6 }, (_, i) => ({
      body: `m${i}`,
      direction: 'in' as const,
      sentAt: 1,
    }));

    const res = await createReportHandler(body({ excerpts: six }), deps, auth);

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('refuses an excerpt longer than the cap', async () => {
    const res = await createReportHandler(
      body({
        excerpts: [{ body: 'x'.repeat(2001), direction: 'in', sentAt: 1 }],
      }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('refuses an unknown reason rather than storing free text', async () => {
    const res = await createReportHandler(
      body({ reason: 'because I said so' }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('refuses a self-report', async () => {
    const res = await createReportHandler(
      body({ reportedUserId: 'reporter-1' }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('accepts a report about an id it cannot verify', async () => {
    // Deliberate. Checking the account exists would answer "is this id real?"
    // for anyone who asks — an enumeration oracle on the one table that has
    // no index precisely so it cannot be walked. One dead row that expires
    // on its own is the cheaper mistake.
    const res = await createReportHandler(
      body({ reportedUserId: 'never-existed' }),
      deps,
      auth,
    );

    expect(res.statusCode).toBe(201);
  });

  it('logs the report id and neither party', async () => {
    await createReportHandler(body(), deps, auth);

    const line = deps.logs.find((l) => l.event === 'report_created');
    expect(line).toBeDefined();
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('reporter-1');
    expect(serialized).not.toContain('target-1');
    expect(serialized).not.toContain('harassment');
  });

  it('never logs an excerpt', async () => {
    await createReportHandler(
      body({ excerpts: [{ body: 'SECRETTEXT', direction: 'in', sentAt: 1 }] }),
      deps,
      auth,
    );

    expect(JSON.stringify(deps.logs)).not.toContain('SECRETTEXT');
  });

  it('stores no message id — the report cannot be joined to the relay', async () => {
    await createReportHandler(
      body({
        // A client that tried to smuggle one gets it dropped by the schema.
        excerpts: [{ body: 'hi', direction: 'in', sentAt: 1, msgId: '01ABC' }],
      }),
      deps,
      auth,
    );

    expect(JSON.stringify(written)).not.toContain('01ABC');
    expect(JSON.stringify(written)).not.toContain('msgId');
  });

  it('sets a bounded expiry', async () => {
    // Longer than other retentions — pattern evidence is what makes a repeat
    // offender visible — but bounded, unlike the attachment access logs that
    // had to go back and fix.
    await createReportHandler(body(), deps, auth);

    const rec = written[0]!;
    const days = (rec.expiresAt - Math.floor(rec.createdAt / 1000)) / 86400;
    expect(days).toBe(180);
  });

  it('rate limits a reporter after five', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await createReportHandler(body(), deps, auth);
      expect(res.statusCode).toBe(201);
    }

    const sixth = await createReportHandler(body(), deps, auth);
    expect(sixth.statusCode).toBe(429);
    expect(written).toHaveLength(5);
  });
});
