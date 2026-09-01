import {
  encodeEnvelope,
  parseEnvelope,
  previewFor,
  VOICE_MAX_SECONDS,
} from '../src/envelope';

/**
 * The voice envelope at its bounds. `dur` is the interesting field: it is
 * peer-supplied, it sizes a UI element, and the defect was that a
 * peer can claim one second and supply five minutes of audio — so the schema
 * bounds what can be CLAIMED, and playback trusts only the decoded duration.
 */

const base = {
  tcm: 'voice' as const,
  att: 'blob-1',
  key: 'a2V5',
  dur: 12,
};

it('round-trips', () => {
  expect(parseEnvelope(encodeEnvelope(base))).toMatchObject({
    tcm: 'voice',
    dur: 12,
  });
});

it('previews as a fixed string — never the duration, never the pointer', () => {
  // The preview reaches a lock-screen banner path. Nothing peer-controlled
  // may ride there.
  const preview = previewFor(encodeEnvelope(base));
  expect(preview).toBe('Voice message');
  expect(preview).not.toContain('12');
  expect(preview).not.toContain('blob-1');
});

it('bounds every peer-controlled field', () => {
  expect(parseEnvelope(JSON.stringify({ ...base, dur: 0 }))).toBeNull();
  expect(
    parseEnvelope(JSON.stringify({ ...base, dur: VOICE_MAX_SECONDS + 1 })),
  ).toBeNull();
  expect(parseEnvelope(JSON.stringify({ ...base, dur: 4.5 }))).toBeNull();
  expect(parseEnvelope(JSON.stringify({ ...base, dur: -3 }))).toBeNull();
  expect(parseEnvelope(JSON.stringify({ ...base, att: 'a'.repeat(201) }))).toBeNull();
  expect(parseEnvelope(JSON.stringify({ ...base, key: 'k'.repeat(101) }))).toBeNull();
  expect(parseEnvelope(JSON.stringify({ ...base, att: '' }))).toBeNull();
});

it('an unknown future field is stripped, not rejected — VN5 peaks stay compatible', () => {
  // The plan's forward-compatibility claim, asserted rather than assumed: a
  // build that predates waveform peaks must render a peaks-bearing envelope
  // as an ordinary voice note.
  const withPeaks = JSON.stringify({ ...base, pk: 'AAECAwQ=' });
  const parsed = parseEnvelope(withPeaks);
  expect(parsed).toMatchObject({ tcm: 'voice', dur: 12 });
  expect((parsed as Record<string, unknown>).pk).toBeUndefined();
});
