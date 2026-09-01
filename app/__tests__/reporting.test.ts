/**
 * Abuse reporting, client side.
 *
 * This module is the only place in the app that can put readable message text
 * on the wire. Everything else sends ciphertext the relay cannot open. So the
 * tests worth writing are not "does it POST" — they are the four properties
 * that keep it from becoming a quiet transcript upload:
 *
 *  1. a report with no chosen messages sends NO excerpt field at all;
 *  2. nothing is ever attached that the caller did not pass;
 *  3. timestamps are coarsened before they leave, so a report cannot be
 *     lined up against the relay's own delivery record;
 *  4. no message id or ciphertext travels, ever.
 */
import * as api from '../src/api';
import { coarsenTimestamp, report, MAX_REPORT_EXCERPTS } from '../src/reporting';

jest.mock('../src/reauth', () => ({
  currentToken: jest.fn(async () => 'token-1'),
}));

const reauth = jest.requireMock('../src/reauth') as {
  currentToken: jest.Mock;
};

let sent: Parameters<typeof api.apiCreateReport>[1] | null;

beforeEach(() => {
  sent = null;
  reauth.currentToken.mockResolvedValue('token-1');
  jest.spyOn(api, 'apiCreateReport').mockImplementation(async (_token, body) => {
    sent = body;
    return { reportId: 'report-9' };
  });
});

afterEach(() => jest.restoreAllMocks());

describe('report()', () => {
  it('sends account and reason, and NO excerpt field, by default', async () => {
    const id = await report('peer-1', { reason: 'harassment' });

    expect(id).toBe('report-9');
    expect(sent).toEqual({
      reportedUserId: 'peer-1',
      reason: 'harassment',
    });
    // Not an empty array — absent. A row with no excerpts should be visibly
    // a row with no excerpts, on the wire and in storage.
    expect(sent).not.toHaveProperty('excerpts');
  });

  it('sends an empty excerpt list as no excerpts at all', async () => {
    await report('peer-1', { reason: 'spam', excerpts: [] });

    expect(sent).not.toHaveProperty('excerpts');
  });

  it('sends exactly the messages the caller chose', async () => {
    await report('peer-1', {
      reason: 'harassment',
      excerpts: [
        { body: 'first', direction: 'in', sentAt: 3_600_000 },
        { body: 'second', direction: 'out', sentAt: 7_200_000 },
      ],
    });

    expect(sent!.excerpts).toEqual([
      { body: 'first', direction: 'in', sentAt: 3_600_000 },
      { body: 'second', direction: 'out', sentAt: 7_200_000 },
    ]);
  });

  it('coarsens timestamps to the hour before they leave the device', async () => {
    // 01:47:23.456 must arrive as 01:00:00.000. Precision here would let the
    // report be correlated with the relay's delivery record for the same
    // message — the linkage the architecture exists to prevent.
    const precise = 3_600_000 + 47 * 60_000 + 23_456;

    await report('peer-1', {
      reason: 'other',
      excerpts: [{ body: 'x', direction: 'in', sentAt: precise }],
    });

    expect(sent!.excerpts![0]!.sentAt).toBe(3_600_000);
    expect(sent!.excerpts![0]!.sentAt).not.toBe(precise);
  });

  it('truncates to the server cap rather than sending a refusable request', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      body: `m${i}`,
      direction: 'in' as const,
      sentAt: 3_600_000,
    }));

    await report('peer-1', { reason: 'spam', excerpts: many });

    expect(sent!.excerpts).toHaveLength(MAX_REPORT_EXCERPTS);
  });

  it('puts no message id or ciphertext on the wire', async () => {
    await report('peer-1', {
      reason: 'harassment',
      excerpts: [
        // A caller passing extra fields must not smuggle them through.
        {
          body: 'hi',
          direction: 'in',
          sentAt: 3_600_000,
          msgId: '01SMUGGLED',
          payload: 'CIPHERTEXT',
        } as never,
      ],
    });

    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('01SMUGGLED');
    expect(serialized).not.toContain('CIPHERTEXT');
    expect(serialized).not.toContain('msgId');
  });

  it('refuses to send without a session', async () => {
    reauth.currentToken.mockResolvedValue(null);

    await expect(report('peer-1', { reason: 'spam' })).rejects.toThrow();
    // Nothing left the device — which is what the failure copy promises.
    expect(sent).toBeNull();
  });

  it('propagates a failure instead of swallowing it', async () => {
    // Unlike the About-screen links, a dropped report must be surfaced: a
    // person who believes a report landed when it did not is worse off than
    // one told to try again.
    jest.spyOn(api, 'apiCreateReport').mockRejectedValue(new Error('429'));

    await expect(report('peer-1', { reason: 'spam' })).rejects.toThrow('429');
  });
});

describe('coarsenTimestamp', () => {
  it('floors to the hour', () => {
    expect(coarsenTimestamp(3_600_000)).toBe(3_600_000);
    expect(coarsenTimestamp(3_600_000 + 59 * 60_000 + 59_999)).toBe(3_600_000);
    expect(coarsenTimestamp(7_199_999)).toBe(3_600_000);
    expect(coarsenTimestamp(7_200_000)).toBe(7_200_000);
  });

  it('never rounds up — a coarsened stamp cannot claim a later hour', () => {
    for (const ms of [1, 59_999, 3_599_999, 86_399_999]) {
      expect(coarsenTimestamp(ms)).toBeLessThanOrEqual(ms);
    }
  });
});
