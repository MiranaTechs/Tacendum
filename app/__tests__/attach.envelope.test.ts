import { encodeEnvelope, parseEnvelope, previewFor } from '../src/envelope';

/**
 * The two new envelope kinds, at their bounds. Every field a peer controls is
 * bounded here, because the schema is the only thing between a hostile
 * envelope and the renderer.
 */

describe('file envelopes', () => {
  const base = {
    tcm: 'file' as const,
    att: 'blob-1',
    key: 'a2V5',
    name: 'notes.pdf',
    size: 1234,
    mime: 'application/pdf',
  };

  it('round-trips', () => {
    const parsed = parseEnvelope(encodeEnvelope(base));
    expect(parsed).toMatchObject({ tcm: 'file', name: 'notes.pdf', size: 1234 });
  });

  it('previews as Document — never the filename', () => {
    // The chat list preview is visible on a lock screen banner path; a
    // sender-controlled filename is not.
    expect(previewFor(encodeEnvelope(base))).toBe('Document');
  });

  it('bounds every sender-controlled field', () => {
    expect(parseEnvelope(JSON.stringify({ ...base, name: 'x'.repeat(201) }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, name: '' }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, size: 0 }))).toBeNull();
    expect(
      parseEnvelope(JSON.stringify({ ...base, size: 10 * 1024 * 1024 + 1 })),
    ).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, size: 3.5 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, mime: 'y'.repeat(121) }))).toBeNull();
    // The pointer's own fields are peer-controlled too.
    expect(parseEnvelope(JSON.stringify({ ...base, att: 'a'.repeat(201) }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, key: 'k'.repeat(101) }))).toBeNull();
  });
});

describe('location envelopes', () => {
  const base = { tcm: 'loc' as const, lat: 37.33182, lng: -122.03118 };

  it('round-trips and previews as Location', () => {
    expect(parseEnvelope(encodeEnvelope(base))).toMatchObject(base);
    expect(previewFor(encodeEnvelope(base))).toBe('Location');
  });

  it('refuses coordinates off the planet', () => {
    expect(parseEnvelope(JSON.stringify({ ...base, lat: 90.1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, lat: -90.1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, lng: 180.1 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ ...base, lng: -181 }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ tcm: 'loc', lat: 1 }))).toBeNull();
  });
});

describe('a filename is peer-controlled text', () => {
  it('the SCHEMA accepts a spoofed name — the renderer is what must sanitise', () => {
    // Documented on purpose: bidi overrides are legal in a filename and the
    // schema does not reject them (rejecting would drop a legitimate
    // right-to-left name). The defence is at the draw, in safeFileName —
    // ChatThread.attach.test.tsx asserts the rendered string.
    const spoofed = {
      tcm: 'file' as const,
      att: 'a',
      key: 'k',
      name: 'invoice\u202Egnp.exe',
      size: 10,
      mime: 'application/octet-stream',
    };
    expect(parseEnvelope(encodeEnvelope(spoofed))).toMatchObject({ tcm: 'file' });
    // …and no preview ever carries it.
    expect(previewFor(encodeEnvelope(spoofed))).toBe('Document');
  });
});
