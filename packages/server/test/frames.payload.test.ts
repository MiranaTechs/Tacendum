import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_B64_LENGTH, SendFrame, TypingFrame } from '@tacendum/shared';

/**
 * Payload-cap boundaries. The cap exists for API Gateway's WebSocket
 * transport: frames top out at 32 KB, so a full JSON send/msg envelope —
 * payload plus every other field — must fit one 32768-byte frame. All lengths
 * here are multiples of 4, i.e. valid unpadded base64, so only the length rule
 * can reject them.
 */

const frame = (payload: string): unknown => ({
  type: 'send',
  to: '0000000000000000000RECPT02',
  msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  msgType: 'ciphertext',
  payload,
});

describe('payload cap (API Gateway 32 KB WebSocket frame budget)', () => {
  it('pins the cap at 30000 base64 chars so a schema-max envelope fits one 32 KiB frame', () => {
    expect(MAX_PAYLOAD_B64_LENGTH).toBe(30_000);
  });

  it('a schema-max msg envelope actually fits one 32 KiB frame', () => {
    // The server->client msg frame is the largest envelope (from + ts on top
    // of the send fields); prove the budget arithmetic, not just the constant.
    const msg = {
      type: 'msg',
      from: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
      payload: 'A'.repeat(MAX_PAYLOAD_B64_LENGTH),
      ts: 9_999_999_999_999,
    };
    expect(Buffer.byteLength(JSON.stringify(msg), 'utf8')).toBeLessThanOrEqual(32_768);
  });

  it('accepts a valid base64 payload just under the cap (29996)', () => {
    expect(SendFrame.safeParse(frame('A'.repeat(29_996))).success).toBe(true);
  });

  it('accepts a valid base64 payload exactly at the cap (30000)', () => {
    expect(SendFrame.safeParse(frame('A'.repeat(30_000))).success).toBe(true);
  });

  it('rejects a valid base64 payload just over the cap (30004)', () => {
    const res = SendFrame.safeParse(frame('A'.repeat(30_004)));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message === 'payload too large')).toBe(true);
    }
  });
});

/**
 * `to` shape hardening.
 * Before any bound, `to` was `z.string.min(1)` — an unbounded second
 * plaintext channel beside the payload: ~30 KB of arbitrary text could
 * transit the relay inside a frame refused only after parse and quota. A
 * length cap closed the channel; the intended endpoint was always `to:
 * Ulid` — exact SHAPE, not just length — and these tests pin it: a 26-char
 * non-ULID string must refuse at parse. The refusal only moved earlier: a
 * well-formed unknown ULID still spends a quota token before drawing its
 * 404, so the existence oracle stays priced exactly as before.
 */
describe('to-field shape (ULID, not just 26 chars)', () => {
  const withTo = (to: string): unknown => ({
    type: 'send',
    to,
    msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    msgType: 'ciphertext',
    payload: 'QUJD',
  });

  it('accepts a 26-char ULID', () => {
    expect(SendFrame.safeParse(withTo('01ARZ3NDEKTSV4RRFFQ69G5FAV')).success).toBe(true);
  });

  it('rejects 26 chars outside the Crockford alphabet — length alone no longer passes', () => {
    // 'I' is excluded from Crockford base32; before the flip this passed the
    // pure length cap. This is THE shape assertion.
    expect(SendFrame.safeParse(withTo('I'.repeat(26))).success).toBe(false);
  });

  it('rejects 26 lowercase chars — ULIDs are uppercase on the wire', () => {
    expect(SendFrame.safeParse(withTo('a'.repeat(26))).success).toBe(false);
  });

  it("rejects the old test fixtures' prose currency ('user-recipient')", () => {
    expect(SendFrame.safeParse(withTo('user-recipient')).success).toBe(false);
  });

  it('rejects 27 chars — one past ULID length', () => {
    expect(SendFrame.safeParse(withTo('A'.repeat(27))).success).toBe(false);
  });

  it('rejects a payload-sized (30000-char) to-field', () => {
    expect(SendFrame.safeParse(withTo('X'.repeat(30_000))).success).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(SendFrame.safeParse(withTo('')).success).toBe(false);
  });

  it('shapes TypingFrame.to identically', () => {
    const typing = (to: string): unknown => ({ type: 'typing', to, msgType: 'ciphertext', payload: 'QUJD' });
    expect(TypingFrame.safeParse(typing('01ARZ3NDEKTSV4RRFFQ69G5FAV')).success).toBe(true);
    expect(TypingFrame.safeParse(typing('I'.repeat(26))).success).toBe(false);
    expect(TypingFrame.safeParse(typing('X'.repeat(30_000))).success).toBe(false);
  });
});
