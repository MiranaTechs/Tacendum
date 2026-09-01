import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '../src/msglog.js';

/**
 * THE CLI'S SILENCE FLOOR for the x.approval wire pair.
 *
 * The CLI deliberately gets NO `renderBody` case for these kinds in this
 * phase: the shipped answer channel is an ordinary reply, and an `x.*`
 * carrier must never reach the spool the parked pass polls — if one did, an
 * approval request would become a PROMPT and "approve" would start a turn.
 * What this gate pins is therefore an absence, at the two seams where it
 * would first stop being true:
 *
 *  - `maySpool(renderBody(body))` is false for both kinds — the spool seam;
 *  - `triggers(row)` is false for a spooled-shape row carrying either body —
 *    the attend seam, pinned separately because a future spool change must
 *    not silently make these rows prompts.
 *
 * The fixture is `packages/shared/approvalvectors.json`, parsed
 * byte-identically by the shared suite, the app suite and this one — three
 * clients agreeing on committed bytes, not on prose.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-approval-wire-silence-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://approval-wire-silence.test';
process.env.TACENDUM_WS = 'ws://approval-wire-silence.test';

const { maySpool, renderBody } = await import('../src/render.js');
const { APPROVAL_TTL_MAX_MS, APPROVAL_TTL_MIN_MS, triggers } = await import('../src/attend.js');
const { MAX_BODY_BYTES } = await import('../src/send.js');
const {
  APPROVAL_TTL_MAX_SEC,
  APPROVAL_TTL_MIN_SEC,
  ApprovalAnswerEnvelope,
  ApprovalRequestEnvelope,
  MAX_APPROVAL_PAYLOAD_BYTES,
} = await import('@tacendum/shared');

interface VectorCase {
  name: string;
  kind: string;
  valid: boolean;
  note: string;
  body: string;
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../shared/approvalvectors.json', import.meta.url)),
    'utf8',
  ),
) as { cases: VectorCase[] };

const vector = (name: string): VectorCase => {
  const found = vectors.cases.find(c => c.name === name);
  if (!found) throw new Error(`approvalvectors.json is missing the '${name}' case`);
  return found;
};

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** The worst legal spool row a bug could write: conversational shape, the
 * declared kind renderBody read, the RAW fixture bytes as text. */
const spooledShapeRow = (body: string): MessageRecord => ({
  id: '01HQXA00000000000000000001',
  dir: 'in',
  peer: OWNER,
  ts: 1_700_000_000_000,
  tcm: renderBody(body).tcm,
  text: body,
  read: false,
});

describe('the fixture agreement — this suite parses the same committed bytes', () => {
  // The precondition that makes the silence pins below mean something: the
  // bodies being silenced are REAL, valid envelopes of the shared schema —
  // not typos that would be silent regardless. This is also the leg the
  // three-suite non-vacuity check trips: break the fixture's q and this
  // fails here, beside the shared and app suites, on the same bytes.
  it('the request case is a valid ApprovalRequestEnvelope', () => {
    const parsed = ApprovalRequestEnvelope.safeParse(JSON.parse(vector('request').body));
    expect(parsed.success).toBe(true);
  });

  it('the answer case is a valid ApprovalAnswerEnvelope', () => {
    const parsed = ApprovalAnswerEnvelope.safeParse(JSON.parse(vector('answer').body));
    expect(parsed.success).toBe(true);
  });

  it('every case parses (or refuses) exactly as its valid flag claims', () => {
    for (const c of vectors.cases) {
      const schema = c.kind === 'x.approval' ? ApprovalRequestEnvelope : ApprovalAnswerEnvelope;
      expect(schema.safeParse(JSON.parse(c.body)).success, `${c.name}: ${c.note}`).toBe(c.valid);
    }
  });
});

describe('the spool seam — an x.approval* body never spools', () => {
  it('x.approval renders as a silent carrier and maySpool refuses it', () => {
    const rendered = renderBody(vector('request').body);
    expect(rendered.carrier).toBe(true);
    expect(rendered.text).toBe('');
    expect(rendered.tcm).toBe('x.approval');
    expect(maySpool(rendered)).toBe(false);
  });

  it('x.approval.answer renders as a silent carrier and maySpool refuses it', () => {
    const rendered = renderBody(vector('answer').body);
    expect(rendered.carrier).toBe(true);
    expect(rendered.text).toBe('');
    expect(rendered.tcm).toBe('x.approval.answer');
    expect(maySpool(rendered)).toBe(false);
  });

  it('the invalid fixture cases are just as silent — the prefix routes BEFORE parsing', () => {
    // A carrier decided after parsing is a carrier that turns noisy the day
    // the shape changes; these two cases fail the schema and must render
    // nothing all the same.
    for (const name of ['request-overcap', 'request-wrong-tag']) {
      const rendered = renderBody(vector(name).body);
      expect(rendered.carrier).toBe(true);
      expect(rendered.text).toBe('');
      expect(maySpool(rendered)).toBe(false);
    }
  });
});

describe('the attend seam — a spooled-shape row carrying the fixture is never a prompt', () => {
  it('x.approval does not trigger', () => {
    expect(triggers(spooledShapeRow(vector('request').body), OWNER)).toBe(false);
  });

  it('x.approval.answer does not trigger', () => {
    expect(triggers(spooledShapeRow(vector('answer').body), OWNER)).toBe(false);
  });

  it('the same rows DO trigger once their kind is conversational — the pin is the kind, not the row', () => {
    // Falsifiability control: if this row shape were untriggerable for some
    // other reason (wrong peer, empty text), the two assertions above would
    // pass vacuously. Only the tcm separates silence from a started turn.
    const asPlain = { ...spooledShapeRow(vector('request').body), tcm: '' };
    expect(triggers(asPlain, OWNER)).toBe(true);
  });
});

describe('the constants are mirrors, not re-mints', () => {
  it('MAX_APPROVAL_PAYLOAD_BYTES is C11’s reuse of MAX_BODY_BYTES (send.ts)', () => {
    expect(MAX_APPROVAL_PAYLOAD_BYTES).toBe(MAX_BODY_BYTES);
  });

  it('the wire TTL bounds are attend.ts’s ms clamp, in seconds', () => {
    // The shared file states the mirror in a comment; this is the assertion
    // that makes drift visible — if attend's clamp moves, this fails until
    // the wire bounds move in the same commit.
    expect(APPROVAL_TTL_MIN_SEC * 1000).toBe(APPROVAL_TTL_MIN_MS);
    expect(APPROVAL_TTL_MAX_SEC * 1000).toBe(APPROVAL_TTL_MAX_MS);
  });
});
