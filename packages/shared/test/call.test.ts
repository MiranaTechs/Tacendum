import { describe, expect, it } from 'vitest';
import {
  CALL_END_REASONS,
  CALL_TCMS,
  CallEndReason,
  CallEnvelope,
  CALLKIT_REPORT_DEADLINE_MS,
  CALL_CONNECT_TIMEOUT_MS,
  CALL_RECONNECT_TIMEOUT_MS,
  CALL_RING_TIMEOUT_MS,
  ICE_BATCH_WINDOW_MS,
  MAX_ICE_CANDIDATES_PER_CALL,
  MAX_ICE_CANDIDATES_PER_ENVELOPE,
  MAX_SDP_LENGTH,
  OFFER_EXP_SKEW_MS,
  OFFER_MAX_SERVER_AGE_MS,
  OFFER_TTL_MS,
  RINGING_ACK_GRACE_MS,
  isCallTcm,
  parseCallEnvelope,
} from '../src/call.js';

/**
 * The call envelopes are the whole wire contract for
 * calling, shared by the app, the CLI, and the tests. They ride the same
 * ratchet as a photo, so anything that would not fit a frame, or that a peer
 * could use to make us ring forever, is rejected here rather than downstream.
 */

const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n';

describe('call envelope schemas', () => {
  it('round-trips every envelope kind', () => {
    const envelopes: CallEnvelope[] = [
      { tcm: 'call.offer', cid: CID, sdp: SDP, vid: true, exp: 1_700_000_000_000 },
      { tcm: 'call.answer', cid: CID, sdp: SDP, vid: false },
      { tcm: 'call.ice', cid: CID, c: [{ cand: 'candidate:1 1 udp', mid: '0', idx: 0 }] },
      { tcm: 'call.end', cid: CID, r: 'hangup' },
      { tcm: 'call.ringing', cid: CID },
      { tcm: 'call.media', cid: CID, a: true, v: false },
      { tcm: 'call.media', cid: CID, a: true, v: true, k: 'screen' },
      { tcm: 'call.restart', cid: CID, sdp: SDP },
    ];
    for (const envelope of envelopes) {
      expect(parseCallEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    }
  });

  it('requires cid to be a ULID on every kind', () => {
    for (const tcm of CALL_TCMS) {
      const body = JSON.stringify({ tcm, cid: 'not-a-ulid', sdp: SDP, vid: true, exp: 1, r: 'hangup', a: true, v: true, c: [{ cand: 'x', mid: '0', idx: 0 }] });
      expect(parseCallEnvelope(body)).toBeNull();
    }
  });

  it('rejects an unknown tcm and a non-envelope body', () => {
    expect(parseCallEnvelope(JSON.stringify({ tcm: 'call.future', cid: CID }))).toBeNull();
    expect(parseCallEnvelope('hello there')).toBeNull();
    expect(parseCallEnvelope('{"tcm":')).toBeNull();
  });

  it('caps the SDP so a call envelope cannot exceed the frame budget', () => {
    const huge = 'v='.padEnd(MAX_SDP_LENGTH + 1, 'x');
    expect(
      parseCallEnvelope(JSON.stringify({ tcm: 'call.offer', cid: CID, sdp: huge, vid: true, exp: 1 })),
    ).toBeNull();
  });

  it('bounds an ICE batch to 1..10 candidates', () => {
    const batch = (n: number) =>
      JSON.stringify({
        tcm: 'call.ice',
        cid: CID,
        c: Array.from({ length: n }, (_, i) => ({ cand: `candidate:${i}`, mid: '0', idx: 0 })),
      });
    expect(parseCallEnvelope(batch(0))).toBeNull();
    expect(parseCallEnvelope(batch(1))).not.toBeNull();
    expect(parseCallEnvelope(batch(MAX_ICE_CANDIDATES_PER_ENVELOPE))).not.toBeNull();
    expect(parseCallEnvelope(batch(MAX_ICE_CANDIDATES_PER_ENVELOPE + 1))).toBeNull();
  });

  it('closes the end-reason enum', () => {
    expect([...CALL_END_REASONS].sort()).toEqual(
      [
        'blocked', 'busy', 'cancelled', 'decline', 'expired', 'failed_ice',
        'failed_media', 'glare_lost', 'hangup', 'timeout', 'unsupported',
      ].sort(),
    );
    for (const r of CALL_END_REASONS) {
      expect(CallEndReason.safeParse(r).success).toBe(true);
    }
    expect(CallEndReason.safeParse('made_up').success).toBe(false);
    expect(parseCallEnvelope(JSON.stringify({ tcm: 'call.end', cid: CID, r: 'made_up' }))).toBeNull();
  });

  it('requires an absolute expiry on an offer but not on an answer', () => {
    expect(parseCallEnvelope(JSON.stringify({ tcm: 'call.offer', cid: CID, sdp: SDP, vid: true }))).toBeNull();
    expect(parseCallEnvelope(JSON.stringify({ tcm: 'call.answer', cid: CID, sdp: SDP, vid: true }))).not.toBeNull();
  });

  it('reserves a track kind for screen sharing without accepting anything else', () => {
    const media = (k: string) => JSON.stringify({ tcm: 'call.media', cid: CID, a: true, v: true, k });
    expect(parseCallEnvelope(media('cam'))).not.toBeNull();
    expect(parseCallEnvelope(media('screen'))).not.toBeNull();
    expect(parseCallEnvelope(media('microphone'))).toBeNull();
  });
});

describe('isCallTcm', () => {
  it('recognises every call tcm and nothing else', () => {
    for (const tcm of CALL_TCMS) expect(isCallTcm(tcm)).toBe(true);
    for (const tcm of ['image', 'react', 'profile', 'reply', 'call', 'call.future']) {
      expect(isCallTcm(tcm)).toBe(false);
    }
  });
});

describe('timer constants (§6.4)', () => {
  it('match the specified values', () => {
    expect(OFFER_TTL_MS).toBe(60_000);
    expect(CALL_RING_TIMEOUT_MS).toBe(60_000);
    expect(CALL_CONNECT_TIMEOUT_MS).toBe(45_000);
    expect(CALL_RECONNECT_TIMEOUT_MS).toBe(30_000);
    expect(ICE_BATCH_WINDOW_MS).toBe(150);
    expect(CALLKIT_REPORT_DEADLINE_MS).toBe(5_000);
    expect(RINGING_ACK_GRACE_MS).toBe(8_000);
    expect(OFFER_EXP_SKEW_MS).toBe(30_000);
    expect(OFFER_MAX_SERVER_AGE_MS).toBe(90_000);
    expect(MAX_ICE_CANDIDATES_PER_CALL).toBe(40);
  });

  it('keeps a worst-case offer inside the frame budget after encryption', () => {
    // base64 inflates by 4/3; the frame cap is 30 000 b64 chars (§5.5).
    const worstCasePlaintext = MAX_SDP_LENGTH + 120; // + envelope JSON overhead
    expect(Math.ceil((worstCasePlaintext * 4) / 3)).toBeLessThan(30_000);
  });
});
