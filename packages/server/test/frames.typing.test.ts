import { describe, expect, it } from 'vitest';
import { ClientFrame, ServerFrame, TypingFrame } from '@tacendum/shared';

/**
 * The typing frame is the one relay-only frame on the wire: no msgId (nothing
 * to ack), no urgent (nothing to wake), no notify (nothing to suppress). These
 * tests pin that absence, the payload discipline it shares with `send`, and
 * that both directions ride the existing discriminated unions.
 */

const clientFrame = (over: Record<string, unknown> = {}): unknown => ({
  type: 'typing',
  to: '0000000000000000000RECPT02',
  msgType: 'ciphertext',
  payload: 'QUJD',
  ...over,
});

describe('typing wire frames', () => {
  it('client typing frame parses via the ClientFrame union', () => {
    const res = ClientFrame.safeParse(clientFrame());
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.type).toBe('typing');
  });

  it('carries no msgId, no urgent, no notify — nothing to ack, wake, or defer', () => {
    expect(Object.keys(TypingFrame.shape).sort()).toEqual([
      'msgType',
      'payload',
      'to',
      'type',
    ]);
  });

  it('payload must be base64, exactly like send', () => {
    expect(TypingFrame.safeParse(clientFrame({ payload: 'not base64!!' })).success).toBe(false);
  });

  it('payload over the transport cap is refused', () => {
    expect(TypingFrame.safeParse(clientFrame({ payload: 'A'.repeat(30_004) })).success).toBe(false);
  });

  it('relayed typing frame parses via the ServerFrame union', () => {
    const res = ServerFrame.safeParse({
      type: 'typing',
      from: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
      payload: 'QUJD',
      ts: 1,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.type).toBe('typing');
  });

  it('a schema-max relayed typing envelope fits one 32 KiB API Gateway frame', () => {
    const msg = {
      type: 'typing',
      from: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
      payload: 'A'.repeat(30_000),
      ts: 9_999_999_999_999,
    };
    expect(Buffer.byteLength(JSON.stringify(msg), 'utf8')).toBeLessThanOrEqual(32_768);
  });
});
