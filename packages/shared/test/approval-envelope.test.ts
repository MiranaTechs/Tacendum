/**
 * The x.approval wire pair. Two rules this file exists to hold down:
 *
 * 1. **The fixture is the agreement.** `packages/shared/approvalvectors.json`
 *    is parsed byte-identically by this suite, the app's
 *    `envelope.approval.test.ts` and the CLI's
 *    `gate.approval-wire-silence.test.ts` — three clients agreeing on
 *    committed bytes, not on prose (the `authvectors.json` pattern).
 *
 * 2. **A verb is a bounded string, never an enum.** A future verb must cost
 *    the answer, never the frame — an enum would refuse the whole envelope at
 *    the parser, and on a one-way ratchet that loss is permanent (the `rd`
 *    lesson). The consumer-side complement, documented here and enforced in
 *    attend.ts: an unknown verb NEVER reads as approve.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TCMS,
  APPROVAL_TTL_MAX_SEC,
  APPROVAL_TTL_MIN_SEC,
  ApprovalAnswerEnvelope,
  ApprovalRequestEnvelope,
  MAX_APPROVAL_PAYLOAD_BYTES,
  isApprovalTcm,
} from '../src/approval-envelope.js';
import * as barrel from '../src/index.js';

const Q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';

interface VectorCase {
  name: string;
  kind: string;
  valid: boolean;
  note: string;
  body: string;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../approvalvectors.json', import.meta.url)), 'utf8'),
) as { cases: VectorCase[] };

const vector = (name: string): VectorCase => {
  const found = vectors.cases.find(c => c.name === name);
  if (!found) throw new Error(`approvalvectors.json is missing the '${name}' case`);
  return found;
};

const schemaFor = (kind: string) =>
  kind === 'x.approval' ? ApprovalRequestEnvelope : ApprovalAnswerEnvelope;

const request = (over: Record<string, unknown> = {}) => ({
  tcm: 'x.approval',
  q: Q,
  k: 'exec',
  p: 'npm test\ncwd: /Users/op/tacendum',
  x: 600,
  s: 's-7c2e',
  a: ['approve', 'deny'],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  tcm: 'x.approval.answer',
  q: Q,
  v: 'approve',
  s: 's-7c2e',
  n: 32,
  ...over,
});

describe('the committed fixture — the cross-client agreement artifact', () => {
  it('every case parses (or refuses) exactly as its valid flag claims', () => {
    for (const c of vectors.cases) {
      const parsed = schemaFor(c.kind).safeParse(JSON.parse(c.body));
      expect(parsed.success, `${c.name}: ${c.note}`).toBe(c.valid);
    }
  });

  it('the request case is a REAL producer shape — commandPayload’s newline + cwd line', () => {
    const parsed = ApprovalRequestEnvelope.parse(JSON.parse(vector('request').body));
    // `${command}\ncwd: ${cwd}` (codex-appserver.ts commandPayload): the one
    // shipped producer emits exactly this framing, so the fixture must too —
    // a fixture with a toy payload proves agreement on nothing.
    expect(parsed.p).toContain('\ncwd: ');
    expect(parsed.k).toBe('exec');
    expect(parsed.a).toEqual(['approve', 'deny']);
    expect(parsed.x).toBe(600); // the CLI's default TTL, in seconds
  });

  it('the answer echoes the request’s q — the only routing key', () => {
    const req = ApprovalRequestEnvelope.parse(JSON.parse(vector('request').body));
    const ans = ApprovalAnswerEnvelope.parse(JSON.parse(vector('answer').body));
    expect(ans.q).toBe(req.q);
    expect(ans.s).toBe(req.s);
  });

  it('the answer’s n is the request payload’s byte length — the bug detector, kept honest', () => {
    // n is a BUG DETECTOR, not a security control: a mismatch means a client
    // transformed what it swore it rendered verbatim. The fixture must model
    // the honest case, or the detector is calibrated against a lie.
    const req = ApprovalRequestEnvelope.parse(JSON.parse(vector('request').body));
    const ans = ApprovalAnswerEnvelope.parse(JSON.parse(vector('answer').body));
    expect(ans.n).toBe(Buffer.byteLength(req.p, 'utf8'));
  });

  it('the over-cap case is over by exactly one — the boundary, not a landslide', () => {
    const raw = JSON.parse(vector('request-overcap').body) as { p: string };
    expect(raw.p.length).toBe(MAX_APPROVAL_PAYLOAD_BYTES + 1);
  });

  it('the wrong-tag case carries a RAW host session id — the exact rule-4 shape s exists to refuse', () => {
    const raw = JSON.parse(vector('request-wrong-tag').body) as { s: string };
    expect(raw.s).toMatch(/^[0-9a-f-]{36}$/); // a UUID, the thing that must never ride
    expect(ApprovalRequestEnvelope.safeParse(JSON.parse(vector('request-wrong-tag').body)).success).toBe(
      false,
    );
  });

  it('an unknown verb parses on BOTH sides — and is preserved verbatim, never coerced', () => {
    // Accepted by schema: a verb is a bounded string. The consumer rule the
    // fixture note documents — unknown NEVER reads as approve — is enforced
    // where verbs are applied (attend.ts fails closed; the app renders only
    // verbs it recognises). Here we pin that nothing in the parse pipeline
    // could turn 'escalate' into an approval.
    const req = ApprovalRequestEnvelope.parse(JSON.parse(vector('request-unknown-verb').body));
    expect(req.a).toEqual(['approve', 'deny', 'escalate']);
    const ans = ApprovalAnswerEnvelope.parse(JSON.parse(vector('answer-unknown-verb').body));
    expect(ans.v).toBe('escalate');
    expect(ans.v).not.toBe('approve');
  });
});

describe('the request schema', () => {
  it('accepts the canonical shape and strips unknown keys — nothing rides unchecked', () => {
    const parsed = ApprovalRequestEnvelope.parse(request({ extra: 'field', from: Q }));
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed).not.toHaveProperty('from');
  });

  it('has NO d, NO r, NO hash, NO absolute timestamp — dropped by design, pinned by key set', () => {
    // d: cwd is folded into the verbatim payload by the one producer —
    // splitting it out would make two renderings of one authorized thing.
    // r: no producer exists, so no field exists.
    // hash: the binding is q + the append-once journal.
    // timestamps: nothing on the wire is a clock; the CLI's clock decides.
    const parsed = ApprovalRequestEnvelope.parse(request({ n: 2 }));
    expect(Object.keys(parsed).sort()).toEqual(['a', 'k', 'n', 'p', 'q', 's', 'tcm', 'x']);
  });

  it('q must be a ULID — the single-use binding is shape-checked', () => {
    expect(ApprovalRequestEnvelope.safeParse(request({ q: 'not-a-ulid' })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ q: undefined })).success).toBe(false);
  });

  it('k degrades to other rather than costing the frame — the kind is worth losing, the request is not', () => {
    expect(ApprovalRequestEnvelope.parse(request({ k: 'network' })).k).toBe('other');
    expect(ApprovalRequestEnvelope.parse(request({ k: undefined })).k).toBe('other');
    expect(ApprovalRequestEnvelope.parse(request({ k: 42 })).k).toBe('other');
    expect(ApprovalRequestEnvelope.parse(request({ k: 'file' })).k).toBe('file');
  });

  it('p is bounded: at the cap passes, one over refuses, empty refuses', () => {
    expect(
      ApprovalRequestEnvelope.safeParse(request({ p: 'x'.repeat(MAX_APPROVAL_PAYLOAD_BYTES) }))
        .success,
    ).toBe(true);
    expect(
      ApprovalRequestEnvelope.safeParse(request({ p: 'x'.repeat(MAX_APPROVAL_PAYLOAD_BYTES + 1) }))
        .success,
    ).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ p: '' })).success).toBe(false);
  });

  it('x is clamped to the attend mirror: below the floor or above the ceiling refuses', () => {
    expect(ApprovalRequestEnvelope.safeParse(request({ x: APPROVAL_TTL_MIN_SEC })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ x: APPROVAL_TTL_MIN_SEC - 1 })).success).toBe(
      false,
    );
    expect(ApprovalRequestEnvelope.safeParse(request({ x: APPROVAL_TTL_MAX_SEC })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ x: APPROVAL_TTL_MAX_SEC + 1 })).success).toBe(
      false,
    );
    expect(ApprovalRequestEnvelope.safeParse(request({ x: 600.5 })).success).toBe(false);
  });

  it('s is optional, and only ever the tag shape — never a raw session id', () => {
    expect(ApprovalRequestEnvelope.safeParse(request({ s: undefined })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ s: 's-ffff' })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ s: 's-FFFF' })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ s: 's-fff' })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ s: 's-fffff' })).success).toBe(false);
  });

  it('a is a bounded verb array: never empty, never more than eight, each verb 1..16 chars', () => {
    expect(ApprovalRequestEnvelope.safeParse(request({ a: [] })).success).toBe(false);
    expect(
      ApprovalRequestEnvelope.safeParse(request({ a: Array.from({ length: 9 }, () => 'deny') }))
        .success,
    ).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ a: [''] })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ a: ['x'.repeat(17)] })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ a: ['x'.repeat(16)] })).success).toBe(true);
  });

  it('n (outstanding count) is optional and bounded 1..64 — a later optional field', () => {
    expect(ApprovalRequestEnvelope.safeParse(request()).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ n: 1 })).success).toBe(true);
    expect(ApprovalRequestEnvelope.safeParse(request({ n: 0 })).success).toBe(false);
    expect(ApprovalRequestEnvelope.safeParse(request({ n: 65 })).success).toBe(false);
  });
});

describe('the answer schema', () => {
  it('v is a bounded string, NOT an enum — a future verb costs the answer, never the frame', () => {
    expect(ApprovalAnswerEnvelope.safeParse(answer({ v: 'edit' })).success).toBe(true);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ v: 'anything-future' })).success).toBe(true);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ v: '' })).success).toBe(false);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ v: 'x'.repeat(17) })).success).toBe(false);
  });

  it('p and m are optional members, bounded now so their bytes are agreed before a producer exists', () => {
    expect(ApprovalAnswerEnvelope.safeParse(answer()).success).toBe(true);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ p: 'echo ok' })).success).toBe(true);
    expect(
      ApprovalAnswerEnvelope.safeParse(answer({ p: 'x'.repeat(MAX_APPROVAL_PAYLOAD_BYTES + 1) }))
        .success,
    ).toBe(false);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ m: 'ask before deploying' })).success).toBe(true);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ m: 'x'.repeat(2_001) })).success).toBe(false);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ m: '' })).success).toBe(false);
  });

  it('n is required and bounded — the bug detector cannot be omitted or absurd', () => {
    expect(ApprovalAnswerEnvelope.safeParse({ ...answer(), n: undefined }).success).toBe(false);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ n: 0 })).success).toBe(true);
    expect(ApprovalAnswerEnvelope.safeParse(answer({ n: -1 })).success).toBe(false);
    expect(
      ApprovalAnswerEnvelope.safeParse(answer({ n: MAX_APPROVAL_PAYLOAD_BYTES + 1 })).success,
    ).toBe(false);
  });

  it('q must echo as a ULID and unknown keys are stripped', () => {
    expect(ApprovalAnswerEnvelope.safeParse(answer({ q: 'nope' })).success).toBe(false);
    const parsed = ApprovalAnswerEnvelope.parse(answer({ decision: 'approve', by: Q }));
    expect(parsed).not.toHaveProperty('decision');
    expect(parsed).not.toHaveProperty('by');
  });
});

describe('constants and registration', () => {
  it('the payload cap is C11’s number — 16 KiB, MAX_BODY_BYTES’s value', () => {
    // The CLI-side suite (gate.approval-wire-silence) pins this against the
    // real send.ts constant; here the number itself is pinned so a shared-only
    // change cannot drift it quietly.
    expect(MAX_APPROVAL_PAYLOAD_BYTES).toBe(16 * 1024);
  });

  it('the TTL bounds are attend.ts’s clamp in seconds', () => {
    // APPROVAL_TTL_MIN_MS = 30_000, APPROVAL_TTL_MAX_MS = 3_600_000 — the
    // CLI-side suite asserts the *1000 mirror against the real constants.
    expect(APPROVAL_TTL_MIN_SEC).toBe(30);
    expect(APPROVAL_TTL_MAX_SEC).toBe(3_600);
  });

  it('names both kinds, and both live under the reserved x. namespace', () => {
    expect([...APPROVAL_TCMS].sort()).toEqual(['x.approval', 'x.approval.answer'].sort());
    expect(APPROVAL_TCMS.every(isApprovalTcm)).toBe(true);
    expect(APPROVAL_TCMS.every(tcm => tcm.startsWith('x.'))).toBe(true);
    expect(isApprovalTcm('x.typing')).toBe(false);
    expect(isApprovalTcm('reply')).toBe(false);
  });

  it('the barrel re-exports the same bindings — the app imports through index.ts', () => {
    // The standing precedent: a new shared module is unreachable from the
    // app without the re-export line; this is what pins that line in place.
    expect(barrel.ApprovalRequestEnvelope).toBe(ApprovalRequestEnvelope);
    expect(barrel.ApprovalAnswerEnvelope).toBe(ApprovalAnswerEnvelope);
    expect(barrel.MAX_APPROVAL_PAYLOAD_BYTES).toBe(MAX_APPROVAL_PAYLOAD_BYTES);
  });
});
