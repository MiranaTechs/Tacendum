import {
  ID_LENGTH,
  URI_SHAPED,
  extractId,
  fold,
  idAttempt,
  idProblem,
  idsInPastedText,
  shareIdMessage,
} from '../src/peerId';

/**
 * An account id is passed between two people by hand — read aloud, retyped,
 * pasted inside a sentence. Accepting one that is wrong addresses a different
 * account, so the tolerances here are the product's only defence against a
 * transcription mistake becoming a chat with a stranger.
 */

const ID = '01HZX8K3QW9YB2N4M5PRTVJ7CD';

describe('fold', () => {
  it('maps the characters Crockford base32 leaves out because humans confuse them', () => {
    expect(fold('oil')).toBe('011');
    expect(fold('O')).toBe('0');
    expect(fold('I')).toBe('1');
    expect(fold('L')).toBe('1');
  });

  it('uppercases and leaves a canonical id untouched', () => {
    expect(fold(ID.toLowerCase())).toBe(ID);
  });
});

describe('extractId', () => {
  it('accepts a bare id', () => {
    expect(extractId(ID)).toBe(ID);
    expect(ID).toHaveLength(ID_LENGTH);
  });

  it('accepts an id pasted inside a sentence', () => {
    expect(extractId(`My Tacendum ID is ${ID} — add me!`)).toBe(ID);
  });

  it('accepts an id broken into readable groups', () => {
    expect(extractId('01HZ X8K3 QW9Y B2N4 M5PR TVJ7 CD')).toBe(ID);
    expect(extractId('01hz-x8k3-qw9y-b2n4-m5pr-tvj7-cd')).toBe(ID);
  });

  it('folds a mistranscribed O or l back to a canonical id', () => {
    const typed = ID.replace('0', 'O').replace('1', 'l');
    expect(extractId(typed)).toBe(ID);
  });

  it('rejects an id one character short', () => {
    expect(extractId(ID.slice(0, 25))).toBeNull();
  });

  it('rejects an id containing U rather than guessing V', () => {
    expect(extractId(`${ID.slice(0, 25)}U`)).toBeNull();
  });

  it('rejects text with no id in it', () => {
    expect(extractId('')).toBeNull();
    expect(extractId('hello there')).toBeNull();
  });
});

describe('idProblem', () => {
  it('says nothing is wrong with a canonical id', () => {
    expect(idProblem(ID)).toBeNull();
    expect(idProblem('01HZ X8K3 QW9Y B2N4 M5PR TVJ7 CD')).toBeNull();
  });

  it('names U before anything else, because it is the ambiguous one', () => {
    expect(idProblem(`${ID.slice(0, 25)}U`)).toBe('u');
    expect(idProblem('U')).toBe('u');
  });

  it('reports a length that is short or long', () => {
    expect(idProblem(ID.slice(0, 25))).toBe('short');
    expect(idProblem(`${ID}7`)).toBe('long');
  });

  it('reports an unusable character rather than pretending it was never typed', () => {
    expect(idProblem('01HZX8K3QW9YB2N4M5PRTVJ7C!')).toBe('chars');
    expect(idProblem('01HZX8K3QW9YB2N4M5PRTVJ7C@')).toBe('chars');
  });

  it('treats nothing typed as short, not as a mystery', () => {
    expect(idProblem('')).toBe('short');
  });
});

/**
 * The share text is the one place the id leaves the app as words, and the
 * field report was that it arrived unusable: "My Tacendum ID is <26
 * characters>. Add me…" made the recipient hand-edit the id out of a
 * sentence on a phone. The id now travels on a line of its own, so a
 * long-press selects exactly the id and nothing else — and the whole message
 * round-trips through the paste path below to exactly one id.
 */
describe('shareIdMessage', () => {
  const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

  it('puts the id ALONE on the second of three lines', () => {
    const lines = shareIdMessage(ID).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(ID);
    expect(lines[0]).toBe('My Tacendum ID:');
    expect(lines[2]).toBe('Add me in Tacendum → Start a chat.');
  });

  it('is the same text on every surface — the id is the only variable', () => {
    expect(shareIdMessage(OTHER).replace(OTHER, ID)).toBe(shareIdMessage(ID));
  });

  it('carries no scheme, no link and no URL-ified id (pinned guardrail)', () => {
    const message = shareIdMessage(ID);
    // Nothing in the message is "scheme:something" — a colon is only ever
    // followed by a line break, never by a payload.
    expect(message).not.toMatch(/:\S/);
    expect(message).not.toMatch(/\/\//);
    for (const token of message.split(/\s+/)) {
      if (token.includes(ID)) expect(URI_SHAPED.test(token)).toBe(false);
    }
  });

  it('round-trips through the paste reader to exactly one id', () => {
    expect(idsInPastedText(shareIdMessage(ID))).toEqual({
      ids: [ID],
      inUriOnly: false,
    });
  });
});

/**
 * Reading ids out of whatever a person pasted. Every rule mirrors the QR
 * import path in `qr.ts`: one id fills the field, more than one is a refusal
 * rather than a guess, and an id that only appears inside a URI is somebody
 * else's payload — a link slug or a Wi-Fi password — not an address.
 */
describe('idsInPastedText', () => {
  const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

  it('finds the one id in a message', () => {
    expect(idsInPastedText(`My Tacendum ID:\n${ID}\nAdd me in Tacendum → Start a chat.`)).toEqual({
      ids: [ID],
      inUriOnly: false,
    });
    expect(idsInPastedText(`my id is ${ID.toLowerCase()}, add me!`).ids).toEqual([ID]);
  });

  it('folds and strips the id the way extractId does', () => {
    const typed = ID.replace('0', 'O').replace('1', 'l');
    expect(idsInPastedText(`ID: ${typed}.`).ids).toEqual([ID]);
    expect(idsInPastedText('01hz-x8k3-qw9y-b2n4-m5pr-tvj7-cd').ids).toEqual([ID]);
  });

  it('accepts an id spaced into readable groups', () => {
    expect(idsInPastedText('01HZ X8K3 QW9Y B2N4 M5PR TVJ7 CD').ids).toEqual([ID]);
    expect(idsInPastedText(' 01HZ X8K3 QW9Y B2N4\nM5PR TVJ7 CD ').ids).toEqual([ID]);
  });

  it('returns every distinct id, once each, so the caller can refuse to guess', () => {
    const out = idsInPastedText(`${ID} or ${OTHER}? Also ${ID} again.`);
    expect(out.ids).toEqual([ID, OTHER]);
    expect(out.inUriOnly).toBe(false);
  });

  it('drops an id that only lives inside a URI, and says so', () => {
    for (const text of [
      `https://example.com/${ID}`,
      `see https://example.com/${ID} please`,
      `tacendum:${ID}`,
      `otpauth://totp/x?secret=${ID}`,
      `WIFI:S:h;T:WPA;P:${ID};;`,
    ]) {
      expect(idsInPastedText(text)).toEqual({ ids: [], inUriOnly: true });
    }
  });

  it('keeps a bare id that sits beside a link', () => {
    expect(idsInPastedText(`https://example.com/${OTHER} ${ID}`)).toEqual({
      ids: [ID],
      inUriOnly: false,
    });
  });

  it('finds nothing in prose, and does not call that a URI', () => {
    expect(idsInPastedText('My Tacendum ID: see you soon')).toEqual({
      ids: [],
      inUriOnly: false,
    });
    expect(idsInPastedText('')).toEqual({ ids: [], inUriOnly: false });
    expect(idsInPastedText(ID.slice(0, 25))).toEqual({ ids: [], inUriOnly: false });
  });
});

/**
 * The part of a typed field that IS the id attempt. Running `idProblem` on a
 * whole sentence reported "never contains the letter U" — pointing at the
 * word Tacendum — when the id itself was merely a character short.
 */
describe('idAttempt', () => {
  it('is the whole field when the field is one token or a spaced id', () => {
    expect(idAttempt(ID)).toBe(ID);
    expect(idAttempt('01HZ X8K3 QW9Y B2N4 M5PR TVJ7 C')).toBe(
      '01HZ X8K3 QW9Y B2N4 M5PR TVJ7 C',
    );
    expect(idAttempt('')).toBe('');
  });

  it('is the whole field when the pieces together are id-sized — a split id is not prose', () => {
    const halves = '01HZX8K3QW9YB2N4 M5PRTVJ7C';
    expect(idAttempt(halves)).toBe(halves);
    expect(idProblem(idAttempt(halves))).toBe('short');
  });

  it('is the one id-sized token when prose surrounds it', () => {
    const short = ID.slice(0, 25);
    expect(idAttempt(`MY TACENDUM 1D 1S ${short}`)).toBe(short);
    expect(idProblem(idAttempt(`MY TACENDUM 1D 1S ${short}`))).toBe('short');
  });
});

describe('URI_SHAPED', () => {
  it('is a scheme then a colon — the qr.ts definition, now shared', () => {
    expect(URI_SHAPED.test('https://x')).toBe(true);
    expect(URI_SHAPED.test('WIFI:S:h')).toBe(true);
    expect(URI_SHAPED.test('tacendum:abc')).toBe(true);
    expect(URI_SHAPED.test(ID)).toBe(false);
    expect(URI_SHAPED.test('01HZ:X8K3')).toBe(false);
  });
});
