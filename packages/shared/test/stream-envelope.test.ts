/**
 * The x.edit stream envelope. Three rules this file
 * exists to hold down:
 *
 * 1. **A snapshot, never a delta.** `text` is the FULL replacement for the
 *    anchor's body, so any one frame is idempotent, any lost frame is healed
 *    wholly by the next, and the cap is checkable on each frame alone —
 *    the Q1 reasoning, pinned here by the refusal tests on `text`.
 *
 * 2. **The body must not itself be an envelope.** A `text` beginning with
 *    `{"tcm":` would read as structure everywhere the app re-parses stored
 *    bodies (envelope.ts's sentinel routing) — a peer could smuggle a carrier
 *    into a rendered bubble. Refused at the schema, exactly as the app's
 *    `bodyText` refuses it for durable edits.
 *
 * 3. **The composed bytes start with the sentinel.** `parseEnvelope` routes on
 *    the LITERAL prefix `{"tcm":` before parsing anything, so a composer that
 *    let another key serialize first would produce frames every shipped build
 *    reads as ordinary text. `composeStreamEdit` writes `tcm` first, and the
 *    prefix is pinned on the bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_STREAM_EDIT_TEXT_CHARS,
  STREAM_TCMS,
  StreamEditEnvelope,
  composeStreamEdit,
  isStreamTcm,
} from '../src/stream-envelope.js';
import * as barrel from '../src/index.js';

const REF = '01J8MEAPPR0VAQ4X2C6TKN9RFV';

const edit = (over: Record<string, unknown> = {}) => ({
  tcm: 'x.edit',
  ref: REF,
  seq: 3,
  text: 'The answer so far, as one whole snapshot.',
  ...over,
});

describe('the stream edit schema', () => {
  it('accepts the canonical shape and strips unknown keys — nothing rides unchecked', () => {
    const parsed = StreamEditEnvelope.parse(edit({ extra: 'field', room: REF }));
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed).not.toHaveProperty('room');
    expect(parsed.seq).toBe(3);
  });

  it('has NO room field — v1 is 1:1 only, rooms deferred by name, pinned by key set', () => {
    // Rooms are deferred by name. A room field nothing produces is a
    // promise nothing keeps (the approval-envelope `r` precedent) — when rooms
    // stream, they get their own decision, not a stowaway key.
    const parsed = StreamEditEnvelope.parse(edit());
    expect(Object.keys(parsed).sort()).toEqual(['ref', 'seq', 'tcm', 'text']);
  });

  it('ref is required and non-empty — an overlay with no anchor overlays nothing', () => {
    expect(StreamEditEnvelope.safeParse(edit({ ref: undefined })).success).toBe(false);
    expect(StreamEditEnvelope.safeParse(edit({ ref: '' })).success).toBe(false);
  });

  it('seq is a required non-negative integer: -1 refuses, 1.5 refuses, 0 passes', () => {
    expect(StreamEditEnvelope.safeParse(edit({ seq: -1 })).success).toBe(false);
    expect(StreamEditEnvelope.safeParse(edit({ seq: 1.5 })).success).toBe(false);
    expect(StreamEditEnvelope.safeParse(edit({ seq: 0 })).success).toBe(true);
    expect(StreamEditEnvelope.safeParse(edit({ seq: undefined })).success).toBe(false);
  });

  it('text is bounded: at the cap passes, one over refuses, empty refuses', () => {
    expect(
      StreamEditEnvelope.safeParse(edit({ text: 'x'.repeat(MAX_STREAM_EDIT_TEXT_CHARS) })).success,
    ).toBe(true);
    expect(
      StreamEditEnvelope.safeParse(edit({ text: 'x'.repeat(MAX_STREAM_EDIT_TEXT_CHARS + 1) }))
        .success,
    ).toBe(false);
    expect(StreamEditEnvelope.safeParse(edit({ text: '' })).success).toBe(false);
  });

  it('text beginning with the envelope sentinel refuses — no nested envelope rides a snapshot', () => {
    expect(
      StreamEditEnvelope.safeParse(edit({ text: '{"tcm":"edit","ref":"x","text":"gone"}' })).success,
    ).toBe(false);
    // Only the LEADING sentinel is refused: prose that quotes the format
    // mid-sentence still streams (the app bodyText rule, kept identical).
    expect(
      StreamEditEnvelope.safeParse(edit({ text: 'the wire marks structure with {"tcm": first' }))
        .success,
    ).toBe(true);
  });
});

describe('composeStreamEdit', () => {
  it('round-trips byte-stable: compose → parse → compose is the identical string', () => {
    const bytes = composeStreamEdit({ ref: REF, seq: 7, text: 'snapshot seven' });
    const reparsed = StreamEditEnvelope.parse(JSON.parse(bytes));
    expect(composeStreamEdit(reparsed)).toBe(bytes);
  });

  it('the composed bytes begin with the tcm-first sentinel — the literal prefix the parser routes on', () => {
    const bytes = composeStreamEdit({ ref: REF, seq: 0, text: 'first chunk' });
    expect(bytes.startsWith('{"tcm":"x.edit"')).toBe(true);
  });

  it('refuses to compose a malformed frame — a bad frame of our own making must be loud', () => {
    expect(() => composeStreamEdit({ ref: REF, seq: -1, text: 'x' })).toThrow(
      /refusing to compose/,
    );
    expect(() => composeStreamEdit({ ref: '', seq: 0, text: 'x' })).toThrow(/refusing to compose/);
    expect(() => composeStreamEdit({ ref: REF, seq: 0, text: '{"tcm":"del","ref":"x"}' })).toThrow(
      /refusing to compose/,
    );
  });

  it('strips unknown keys at compose — a stray property never rides the wire', () => {
    const bytes = composeStreamEdit({
      ref: REF,
      seq: 1,
      text: 'clean',
      room: REF,
    } as never);
    expect(bytes).not.toContain('room');
  });
});

describe('constants and registration', () => {
  it('the snapshot cap is 8 KiB of UTF-16 code units', () => {
    expect(MAX_STREAM_EDIT_TEXT_CHARS).toBe(8_192);
  });

  it('names the one kind, under the reserved x. namespace', () => {
    expect([...STREAM_TCMS]).toEqual(['x.edit']);
    expect(STREAM_TCMS.every(isStreamTcm)).toBe(true);
    expect(STREAM_TCMS.every(tcm => tcm.startsWith('x.'))).toBe(true);
    expect(isStreamTcm('edit')).toBe(false);
    expect(isStreamTcm('x.typing')).toBe(false);
  });

  it('the barrel re-exports the same bindings — the app imports through index.ts', () => {
    // The standing precedent: a new shared module is unreachable from the
    // app without the re-export line; this is what pins that line in place.
    expect(barrel.StreamEditEnvelope).toBe(StreamEditEnvelope);
    expect(barrel.composeStreamEdit).toBe(composeStreamEdit);
    expect(barrel.MAX_STREAM_EDIT_TEXT_CHARS).toBe(MAX_STREAM_EDIT_TEXT_CHARS);
  });
});
